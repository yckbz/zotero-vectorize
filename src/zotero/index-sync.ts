import { buildModelFingerprint, fnv1a64 } from '../core/hash.ts';
import type { EmbeddingProvider } from '../engines/provider.ts';
import type { EngineType, IndexProgress, PluginConfig } from '../types/vectorize.ts';
import type { ZoteroItem } from '../types/zotero.d.ts';
import { PREF_BRANCH } from './config.ts';
import { embeddingSettings, resolveEmbeddingProfile } from './embedding-profile.ts';
import { extractItemMetadata, isIndexableRegularItem } from './extractor.ts';
import {
  cloudEndpointDigest, packVector, readSyncHeader, readSyncSnapshot, snapshotSize, syncSearchConfig, writeSyncSnapshot,
  type ReceivedSnapshot, type SyncHeader, type SyncRecord,
} from './sync-snapshot.ts';
import type { VectorStore } from './vector-store.ts';

const TITLE = 'Zotero Vectorize Shared Index';
const FILENAME = 'zotero-vectorize.zvindex';
const ROLE = PREF_BRANCH + 'syncRole';
const PUBLISHER = PREF_BRANCH + 'syncPublisher';
const BINDING = PREF_BRANCH + 'syncAttachment';
export type SyncRole = 'off' | 'publish' | 'receive';
type SyncPhase = 'off' | 'waiting' | 'working' | 'ready' | 'webdav' | 'model' | 'cloud' | 'conflict' | 'error';
const DEVICE_MODEL_SETTINGS = {
  'local-onnx': ['localModelDir', 'localMirror'],
  ollama: ['ollamaUrl'],
  openai: ['openaiBaseUrl', 'openaiModel', 'openaiDimensions', 'openaiApiKey'],
} as const satisfies Record<EngineType, readonly (keyof PluginConfig)[]>;

type SnapshotModel = { engine: 'openai'; model: string; endpointDigest: string } |
  { engine: 'local-onnx' | 'ollama'; model: string; revision: string };

interface Context {
  account: number;
  libraryID: number;
}

interface IndexSyncDeps {
  store: VectorStore;
  getConfig(): PluginConfig;
  getProgress(): IndexProgress;
  createProvider(config: PluginConfig): EmbeddingProvider;
  onUpdate(): void;
  onLocalAvailable(): void;
}

class SyncIssue extends Error {
  constructor(readonly phase: 'webdav' | 'model' | 'cloud' | 'conflict') { super(phase); }
}

function publicationSettings(config: PluginConfig): string {
  return JSON.stringify([embeddingSettings(config), config.localMaxSeqLength, config.chunkSize, config.chunkOverlap,
    config.maxPdfPages, config.defaultSearchMode, config.hybridSemanticWeight, config.normalizeNotation, config.maxResults]);
}

export class IndexSync {
  private role: SyncRole = 'off';
  private phase: SyncPhase = 'off';
  private observer: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private refreshAfterRun = false;
  private teardown = 0;
  private disposed = false;
  private needsReconcile = false;
  private received: (ReceivedSnapshot & { provider: EmbeddingProvider; digest: string }) | null = null;
  private waitingForFirstSnapshot = false;
  private libraryRevision = 0;
  private deviceConfig: PluginConfig | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: IndexSyncDeps) {}

  get active() {
    return this.role === 'receive' && this.received?.manifest.account === Zotero.Users?.getCurrentUserID()
      ? this.received : null;
  }

  getStatus() {
    const manifest = this.active?.manifest;
    return { role: this.role, phase: this.phase, lastReceived: manifest?.generation, model: manifest?.model };
  }

  getSharedStats() {
    const shared = this.active;
    if (!shared) return null;
    const items = shared.index.getAllItems();
    const chunks = shared.index.getAllChunks();
    const { engine, model, dimensions, generation } = shared.manifest;
    return {
      indexedItems: items.length,
      vectorizedItems: items.reduce((count, item) => count + Number(item.vector !== null), 0),
      indexedChunks: chunks.length,
      vectorizedChunks: chunks.reduce((count, chunk) => count + Number(chunk.vector !== null), 0),
      modelFingerprint: buildModelFingerprint(engine, model, dimensions),
      publishedAt: generation,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private setPhase(phase: SyncPhase): void {
    this.phase = phase;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A preferences window cannot stop synchronization. */ }
    }
  }

  shouldAutoIndex(libraryID: number): boolean {
    return this.role !== 'receive' || libraryID !== Zotero.Libraries.userLibraryID ||
      (!this.active && !this.waitingForFirstSnapshot);
  }

  start(): void {
    if (this.disposed) return;
    const value = Zotero.Prefs.get(ROLE, true);
    this.configure(value === 'publish' || value === 'receive' ? value : 'off');
  }

  setRole(role: SyncRole): void {
    if (this.disposed || role === this.role) return;
    Zotero.Prefs.set(ROLE, role, true);
    this.configure(role);
  }

  private configure(role: SyncRole): void {
    const wasReceiving = this.role === 'receive';
    this.teardown++;
    this.stopObservers();
    this.role = role;
    this.clearReceived();
    this.needsReconcile = false;
    this.deviceConfig = this.deps.getConfig();
    this.waitingForFirstSnapshot = role === 'receive';
    this.setPhase(role === 'off' ? 'off' : 'waiting');
    if (wasReceiving && role !== 'receive') this.deps.onLocalAvailable();
    if (role === 'off') return;
    this.observer = Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => {
        if (type === 'sync' && event === 'finish') this.schedule(300);
        if (this.role === 'receive' && (type === 'item' || type === 'item-tag')) {
          this.invalidate(event, type, ids);
        }
      },
    }, ['sync', 'item', 'item-tag'], 'zotero-vectorize-shared-index');
    if (role === 'publish') this.unsubscribe = this.deps.store.subscribeWrites(() => this.onConfigChanged());
    this.schedule(0);
  }

  onConfigChanged(): void {
    if (this.role === 'publish') this.schedule(15_000);
    if (this.role === 'receive') {
      const config = this.deps.getConfig();
      const previous = this.deviceConfig;
      this.deviceConfig = config;
      const engine = this.active?.manifest.engine;
      const keys = engine ? DEVICE_MODEL_SETTINGS[engine] : Object.values(DEVICE_MODEL_SETTINGS).flat();
      if (keys.some((key) => previous?.[key] !== config[key])) {
        this.teardown++;
        this.clearReceived();
        this.waitingForFirstSnapshot = true;
      }
      this.needsReconcile = true;
      this.schedule(0);
    }
  }

  private releaseLocalIndexing(): void {
    if (this.waitingForFirstSnapshot && !this.active) this.deps.onLocalAvailable();
    this.waitingForFirstSnapshot = false;
  }

  private invalidate(event: string, type: string, ids: Array<number | string>): void {
    const received = this.active;
    if (type === 'item' && !['add', 'modify', 'delete', 'trash'].includes(event)) return;
    this.libraryRevision++;
    this.needsReconcile = true;
    if (!received) return;
    const idsToCheck = new Set(ids.map((id) => Number(type === 'item-tag' ? String(id).split('-')[0] : id)));
    let changed = false;
    const affected = received.index.getAllItems().filter((item) => idsToCheck.has(item.itemID));
    for (const item of affected) {
      const live = Zotero.Items.get(item.itemID);
      if (!live || live.deleted || live.key !== item.itemKey || event === 'trash' || event === 'delete') {
        received.index.removeItem(item.itemID);
        changed = true;
      } else {
        const { canonicalText: _text, dateModified: _date, ...metadata } = extractItemMetadata(live);
        if (metadata.metadataHash !== item.metadataHash) {
          received.index.upsertItem({ ...item, ...metadata, vector: null, modelFingerprint: '', dim: 0 });
          changed = true;
        }
      }
    }
    const chunkParents = new Set(received.index.getAllChunks().filter((chunk) => idsToCheck.has(chunk.attachmentID))
      .map((chunk) => chunk.itemID));
    for (const id of chunkParents) {
      received.index.replaceItemChunks(id, received.index.getItemChunks(id).filter((chunk) => !idsToCheck.has(chunk.attachmentID)));
      changed = true;
    }
    // Resolve keys again after item and file sync have finished.
    if (changed) {
      this.deps.onUpdate();
      this.notifyStatus();
    }
  }

  private schedule(delay: number): void {
    if (this.disposed || this.role === 'off') return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(false);
    }, delay);
  }

  syncNow(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    return this.run(true);
  }

  private run(manual: boolean): Promise<void> {
    if (this.disposed || this.role === 'off') return Promise.resolve();
    if (this.running) {
      this.refreshAfterRun = true;
      return this.running;
    }
    const epoch = this.teardown;
    const role = this.role;
    const run = this.reconcile(role, epoch, manual).catch((error: unknown) => {
      if (!this.current(epoch)) return;
      if (!this.active) this.releaseLocalIndexing();
      this.setPhase(error instanceof SyncIssue ? error.phase : 'error');
    }).finally(() => {
      this.running = null;
      if (this.refreshAfterRun) {
        this.refreshAfterRun = false;
        this.schedule(300);
      }
    });
    this.running = run;
    return run;
  }

  private async reconcile(role: SyncRole, epoch: number, manual: boolean): Promise<void> {
    const account = Zotero.Users?.getCurrentUserID();
    const libraryID = Zotero.Libraries.userLibraryID;
    if (!account || !libraryID) throw new SyncIssue('webdav');
    const context = { account, libraryID };
    this.setPhase('working');

    if (role === 'receive' && !this.active) {
      const cache = this.cachePath(account);
      if (await IOUtils.exists(cache)) {
        try {
          await this.accept(cache, context, epoch, false);
        } catch {
          // A stale or damaged cache is independent of the local index.
        }
      }
    }

    if (!this.current(epoch, context)) return;
    const sync = Zotero.Sync;
    if (!sync?.Runner.enabled || sync.Storage.Local.getModeForLibrary(libraryID) !== 'webdav' ||
        !Zotero.Prefs.get('sync.storage.enabled') || !Zotero.Prefs.get('sync.storage.verified')) {
      throw new SyncIssue('webdav');
    }
    if (sync.Runner.syncInProgress) {
      this.setPhase('waiting');
      return;
    }
    if (role === 'receive' && (manual || (!this.active && this.waitingForFirstSnapshot))) {
      await this.runNativeSync(context);
    }
    if (!this.current(epoch, context)) return;
    if (role === 'publish') {
      await this.publish(context, epoch, manual);
    } else {
      await this.receive(context, epoch);
    }
  }

  private current(epoch: number, context?: Context): boolean {
    return !this.disposed && this.teardown === epoch && (!context ||
      (Zotero.Users?.getCurrentUserID() === context.account && Zotero.Libraries.userLibraryID === context.libraryID));
  }

  private cachePath(account: number): string {
    return PathUtils.join(this.deps.store.getStoreDir(), 'shared-index-' + account + '.zvindex');
  }

  private async attachment(libraryID: number): Promise<ZoteroItem | undefined> {
    const matches = (await Zotero.Items.getAll(libraryID, true, false)).filter((item) =>
      !item.deleted && item.libraryID === libraryID && !item.parentItemID && item.isStoredFileAttachment?.() &&
      item.getField('title') === TITLE && item.attachmentFilename === FILENAME);
    if (matches.length > 1) throw new SyncIssue('conflict');
    return matches[0];
  }

  private pathFor(item: ZoteroItem): string {
    return PathUtils.join(Zotero.Attachments.getStorageDirectory(item).path, FILENAME);
  }

  private async runNativeSync({ libraryID }: Context): Promise<void> {
    let failed = false;
    await Zotero.Sync!.Runner.sync({ libraries: [libraryID], background: true, onError: () => { failed = true; } });
    if (failed) throw new SyncIssue('webdav');
  }

  private async publish(context: Context, epoch: number, manual: boolean): Promise<void> {
    const sync = Zotero.Sync!;
    const progress = this.deps.getProgress();
    if (['scanning', 'indexing', 'paused'].includes(progress.phase)) {
      this.schedule(15_000);
      this.setPhase('waiting');
      return;
    }
    const config = this.deps.getConfig();
    const settings = publicationSettings(config);
    const profile = this.deps.store.activeProfile;
    if (!profile) throw new SyncIssue('model');
    const provider = this.deps.createProvider(config);
    let model: SnapshotModel;
    try {
      if ((await resolveEmbeddingProfile(config, provider))?.id !== profile.id) throw new SyncIssue('model');
      if (config.engine === 'openai') {
        const endpointDigest = await cloudEndpointDigest(config.openaiBaseUrl);
        if (!endpointDigest || !config.openaiApiKey.trim()) throw new SyncIssue('cloud');
        model = { engine: config.engine, model: provider.model, endpointDigest };
      } else {
        const revision = await provider.getModelRevision?.();
        if (!revision) throw new SyncIssue('model');
        model = { engine: config.engine, model: provider.model, revision };
      }
    } finally {
      void provider.dispose().catch(() => {});
    }

    let item = await this.attachment(context.libraryID);
    if (!this.current(epoch, context)) return;
    const binding = Zotero.Prefs.get(BINDING, true);
    if (!item && !binding) {
      // Establish the native library state before the first publication.
      await this.runNativeSync(context);
      if (!this.current(epoch, context)) return;
      item = await this.attachment(context.libraryID);
    }
    const publisher = Zotero.Prefs.get(PUBLISHER, true) || Zotero.Utilities.randomString?.(24);
    if (!publisher) throw new SyncIssue('webdav');
    let previous: SyncHeader | undefined;
    if (item) {
      if (binding !== context.account + ':' + item.key ||
          item.attachmentSyncState === sync.Storage.Local.SYNC_STATE_IN_CONFLICT) throw new SyncIssue('conflict');
      previous = await readSyncHeader(this.pathFor(item));
      if (previous.publisher !== publisher || previous.account !== context.account) throw new SyncIssue('conflict');
    } else if (binding) {
      throw new SyncIssue('conflict');
    }

    const layout = `1:${config.chunkSize}:${config.chunkOverlap}:${config.maxPdfPages}`;
    const source = await this.deps.store.readCommitted(async () => ({
      ...await this.deps.store.loadAll(profile.id, context.libraryID),
      attachments: await this.deps.store.getShareableAttachments(context.libraryID, layout),
      updated: await this.deps.store.getMeta('last_indexed_at'),
    }));
    const previousDimensions = previous?.engine === model.engine && previous.model === model.model &&
      (previous.engine === 'openai' ? model.engine === 'openai' && previous.endpointDigest === model.endpointDigest
        : model.engine !== 'openai' && previous.revision === model.revision) ? previous.dimensions : 0;
    const dimensions = profile.dimensions || source.items.find((entry) => entry.vector)?.dim ||
      source.chunks.find((entry) => entry.vector)?.dim ||
      previousDimensions;
    if (!dimensions) {
      this.setPhase('waiting');
      return;
    }
    const manifest: SyncHeader = {
      type: 'zotero-vectorize-index', version: 1, account: context.account, publisher,
      generation: Math.max(Date.now(), (previous?.generation ?? 0) + 1),
      ...model, dimensions,
      maxSeqLength: config.localMaxSeqLength, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap,
      maxPdfPages: config.maxPdfPages, defaultSearchMode: config.defaultSearchMode,
      hybridSemanticWeight: config.hybridSemanticWeight, normalizeNotation: config.normalizeNotation,
      maxResults: config.maxResults,
    };
    const localItems = await Zotero.Items.getAll(context.libraryID, false, false);
    const byId = new Map(localItems.map((entry) => [entry.id, entry]));
    const valid = source.items.filter((entry) => {
      const live = byId.get(entry.itemID);
      return isIndexableRegularItem(live) && live.key === entry.itemKey;
    });
    const parents = new Map(valid.map((entry) => [entry.itemID, entry.itemKey]));
    const pdfs = new Map(source.attachments.flatMap((entry) => {
      const live = byId.get(entry.attachmentID);
      const parentKey = parents.get(entry.parentItemID);
      return live?.isPDFAttachment() && !live.deleted && live.key === entry.attachmentKey &&
        live.parentItemID === entry.parentItemID && parentKey && /^[a-f0-9]{32}$/.test(entry.fileHash)
        ? [[entry.attachmentID, { ...entry, parentKey }] as const] : [];
    }));
    const stamp = fnv1a64(JSON.stringify([source.updated, { ...manifest, generation: 0 },
      valid.map((entry) => [entry.itemKey, extractItemMetadata(byId.get(entry.itemID)!).metadataHash]),
      [...pdfs.values()].map((pdf) => [pdf.attachmentKey, pdf.parentKey, pdf.fileHash]), source.chunks.length]));
    const stampPref = PREF_BRANCH + 'syncPublishedStamp';
    if (item && Zotero.Prefs.get(stampPref, true) === stamp) {
      if (manual && item.attachmentSyncState !== sync.Storage.Local.SYNC_STATE_IN_SYNC) await this.runNativeSync(context);
      if (this.current(epoch, context)) {
        this.setPhase(item.attachmentSyncState === sync.Storage.Local.SYNC_STATE_IN_SYNC ? 'ready' : 'waiting');
      }
      return;
    }
    if ((!previous || valid.length > 0) && !valid.some((entry) => entry.vector) &&
        !source.chunks.some((chunk) => chunk.vector && pdfs.has(chunk.attachmentID))) {
      this.setPhase('waiting');
      return;
    }

    async function* records(): AsyncGenerator<SyncRecord> {
      for (const entry of valid) {
        const liveHash = extractItemMetadata(byId.get(entry.itemID)!).metadataHash;
        yield ['item', entry.itemKey, liveHash, packVector(liveHash === entry.metadataHash ? entry.vector : null)];
      }
      for (const pdf of pdfs.values()) yield ['pdf', pdf.attachmentKey, pdf.parentKey, pdf.fileHash];
      for (const chunk of source.chunks) {
        const pdf = pdfs.get(chunk.attachmentID);
        if (!pdf || pdf.attachmentKey !== chunk.attachmentKey || pdf.parentItemID !== chunk.itemID ||
            (config.maxPdfPages && chunk.pageIndex >= config.maxPdfPages)) continue;
        yield ['chunk', chunk.attachmentKey, chunk.chunkIndex, chunk.pageIndex, chunk.pageLabel,
          chunk.charStart, chunk.charEnd, chunk.text, packVector(chunk.vector)];
      }
    }
    const stageDir = PathUtils.join(this.deps.store.getStoreDir(), 'publish-' + manifest.generation);
    const stage = PathUtils.join(stageDir, FILENAME);
    await IOUtils.makeDirectory(stageDir);
    try {
      await writeSyncSnapshot(stage, manifest, records());
      if (!this.current(epoch, context)) return;
      if (this.deps.store.activeProfile?.id !== profile.id || publicationSettings(this.deps.getConfig()) !== settings) {
        this.setPhase('waiting');
        this.schedule(300);
        return;
      }
      if (sync.Runner.syncInProgress) {
        this.setPhase('waiting');
        return;
      }
      if (item) {
        const dest = this.pathFor(item);
        // Stage on the destination volume, then replace only the managed file.
        const temp = PathUtils.join(PathUtils.parent(PathUtils.parent(dest)), '.' + item.key + '-' + manifest.generation + '.pending');
        try {
          await IOUtils.copy(stage, temp);
          if (!this.current(epoch, context)) return;
          if (sync.Runner.syncInProgress) {
            this.setPhase('waiting');
            return;
          }
          const release = sync.Runner.delayIndefinite();
          try {
            await IOUtils.move(temp, dest);
            await sync.Storage.Local.updateSyncStates([item], 'to_upload');
          } finally {
            release();
          }
        } finally {
          await IOUtils.remove(temp, { ignoreAbsent: true });
        }
      } else {
        if (!Zotero.Attachments.importFromFile) throw new SyncIssue('webdav');
        Zotero.Prefs.set(PUBLISHER, publisher, true);
        item = await Zotero.Attachments.importFromFile({
          file: stage, libraryID: context.libraryID, title: TITLE, contentType: 'application/octet-stream',
        });
        Zotero.Prefs.set(BINDING, context.account + ':' + item.key, true);
      }
      Zotero.Prefs.set(stampPref, stamp, true);
      if (this.current(epoch, context)) await this.runNativeSync(context);
      if (this.current(epoch, context)) {
        this.setPhase(item.attachmentSyncState === sync.Storage.Local.SYNC_STATE_IN_SYNC ? 'ready' : 'waiting');
      }
    } finally {
      await IOUtils.remove(stageDir, { recursive: true, ignoreAbsent: true });
    }

  }

  private async receive(context: Context, epoch: number): Promise<void> {
    const item = await this.attachment(context.libraryID);
    if (!this.current(epoch, context)) return;
    if (!item) {
      this.releaseLocalIndexing();
      this.setPhase('waiting');
      return;
    }
    const sync = Zotero.Sync!;
    if (item.attachmentSyncState === sync.Storage.Local.SYNC_STATE_IN_CONFLICT) throw new SyncIssue('conflict');
    const dest = this.pathFor(item);
    // The native runner checks remote attachment metadata before downloading.
    const result = await sync.Runner.downloadFile(item);
    if (!this.current(epoch, context)) return;
    if (result === false || !await IOUtils.exists(dest)) throw new SyncIssue('webdav');
    if (this.active && item.attachmentSyncedHash === this.active.digest && !this.needsReconcile) {
      this.setPhase('ready');
      return;
    }
    await snapshotSize(dest);
    const stage = PathUtils.join(this.deps.store.getStoreDir(), 'receive-' + context.account + '.pending');
    try {
      await IOUtils.copy(dest, stage);
      const digest = await Zotero.Utilities.Internal.md5Async(stage);
      if (item.attachmentSyncedHash && digest !== item.attachmentSyncedHash) throw new Error('Shared index checksum changed');
      if (this.active?.digest !== digest || this.needsReconcile) {
        await this.accept(stage, context, epoch, true, digest);
      }
      if (this.current(epoch, context)) {
        this.setPhase(this.active?.digest === digest && !this.needsReconcile ? 'ready' : 'waiting');
      }
    } finally {
      await IOUtils.remove(stage, { ignoreAbsent: true });
    }
  }

  private async accept(path: string, context: Context, epoch: number, commit: boolean, digest?: string): Promise<void> {
    const libraryRevision = this.libraryRevision;
    const manifest = await readSyncHeader(path);
    if (manifest.account !== context.account) throw new Error('Shared index account changed');
    const previous = this.active?.manifest;
    if (previous && (previous.publisher !== manifest.publisher || previous.generation > manifest.generation ||
        (previous.generation === manifest.generation && !!digest && this.active?.digest !== digest))) {
      throw new SyncIssue('conflict');
    }
    const config = syncSearchConfig(manifest, this.deps.getConfig());
    if (manifest.engine === 'openai' && (!config.openaiApiKey.trim() || config.openaiModel.trim() !== manifest.model ||
        (config.openaiDimensions !== 0 && config.openaiDimensions !== manifest.dimensions) ||
        await cloudEndpointDigest(config.openaiBaseUrl) !== manifest.endpointDigest)) {
      throw new SyncIssue('cloud');
    }
    if (!this.current(epoch, context)) return;
    const provider = this.deps.createProvider(config);
    let adopted = false;
    try {
      if (manifest.engine === 'openai') {
        const vector = await provider.embedQuery('semantic search health check').catch(() => null);
        if (vector?.length !== manifest.dimensions) throw new SyncIssue('cloud');
      } else {
        if (await provider.getModelRevision?.() !== manifest.revision) throw new SyncIssue('model');
        const status = await provider.testConnection();
        if (!status.ok || status.dimensions !== manifest.dimensions) throw new SyncIssue('model');
      }
      const received = await readSyncSnapshot(path, context.account, context.libraryID);
      const hash = digest ?? await Zotero.Utilities.Internal.md5Async(path);
      if (!this.current(epoch, context) || !hash) return;
      if (libraryRevision !== this.libraryRevision) {
        this.schedule(500);
        return;
      }
      if (commit) await IOUtils.move(path, this.cachePath(context.account));
      if (!this.current(epoch, context)) return;
      if (libraryRevision !== this.libraryRevision) {
        this.schedule(500);
        return;
      }
      adopted = true;
      this.needsReconcile = false;
      this.setReceived({ ...received, provider, digest: hash });
      this.releaseLocalIndexing();
    } finally {
      if (!adopted) void provider.dispose().catch(() => {});
    }
  }

  private clearReceived(): void {
    if (this.received) this.setReceived(null);
  }

  private setReceived(received: IndexSync['received']): void {
    const previous = this.received;
    this.received = received;
    void previous?.provider.dispose().catch(() => {});
    this.deps.onUpdate();
    this.notifyStatus();
  }

  private stopObservers(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.observer !== null) Zotero.Notifier.unregisterObserver(this.observer);
    this.observer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  dispose(): void {
    this.disposed = true;
    this.teardown++;
    this.stopObservers();
    this.clearReceived();
    this.listeners.clear();
  }
}
