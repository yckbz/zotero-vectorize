import { buildModelFingerprint, fnv1a64 } from '../core/hash.ts';
import type { EmbeddingProvider } from '../engines/provider.ts';
import type { EngineType, IndexProgress, PluginConfig } from '../types/vectorize.ts';
import type { ZoteroItem } from '../types/zotero.d.ts';
import { PREF_BRANCH } from './config.ts';
import { embeddingSettings, resolveEmbeddingProfile } from './embedding-profile.ts';
import { extractItemMetadata, isIndexableRegularItem } from './extractor.ts';
import {
  cloudEndpointDigest, LEGACY_MAX_BYTES, MIB, packVector, partFilename, readFirstSyncRecord, readSyncSnapshot,
  snapshotSize, syncHeader, syncSearchConfig, writeSyncParts,
  type ReceivedSnapshot, type SyncHeader, type SyncRecord,
} from './sync-snapshot.ts';
import {
  acceptedPublication, fileDigest, MAX_MANIFEST_BYTES, openWebDavProbe, readPublishedHead, readSyncDraft,
  readSyncManifest, verifyPart, writeManifestFile, type AcceptedPublication, type SyncDraft, type SyncManifest,
} from './sync-publication.ts';
import type { VectorStore } from './vector-store.ts';

declare const __ZV_TEST_SYNC_PART_BYTES__: number;
const TITLE = 'Zotero Vectorize Shared Index';
const FILENAME = 'zotero-vectorize.zvindex';
const PART_TITLE = TITLE + ' Part';
const ROLE = PREF_BRANCH + 'syncRole';
const PUBLISHER = PREF_BRANCH + 'syncPublisher';
const BINDING = PREF_BRANCH + 'syncAttachment';
const PART_SIZE = PREF_BRANCH + 'syncPartSizeMiB';
const STAMP = PREF_BRANCH + 'syncPublishedStamp';
const ACCEPTED = PREF_BRANCH + 'syncAccepted.';
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

type RemoteFileProbe = (item: ZoteroItem, digest: string) => Promise<boolean>;
type PublicationFile = { item: ZoteroItem; bytes: number; digest: string };

class SyncIssue extends Error {
  constructor(readonly phase: 'waiting' | 'webdav' | 'model' | 'cloud' | 'conflict') { super(phase); }
}

function publicationSettings(config: PluginConfig): string {
  return JSON.stringify([embeddingSettings(config), config.localMaxSeqLength, config.chunkSize, config.chunkOverlap,
    config.maxPdfPages, config.defaultSearchMode, config.hybridSemanticWeight, config.normalizeNotation, config.maxResults]);
}

export class IndexSync {
  readonly partSizesMiB: readonly number[] = typeof __ZV_TEST_SYNC_PART_BYTES__ === 'number'
    ? [__ZV_TEST_SYNC_PART_BYTES__ / MIB] : [64, 128, 256];
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

  getPartSizeMiB(): number {
    const value = Zotero.Prefs.get(PART_SIZE, true);
    return this.partSizesMiB.includes(value) ? value : this.partSizesMiB[this.partSizesMiB.length - 1];
  }

  setPartSizeMiB(value: number): void {
    if (this.disposed || this.role !== 'publish' || !this.partSizesMiB.includes(value) || value === this.getPartSizeMiB()) return;
    Zotero.Prefs.set(PART_SIZE, value, true);
    this.schedule(0);
  }

  private partBytes(): number {
    return this.getPartSizeMiB() * MIB;
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
      if (!(error instanceof SyncIssue)) Zotero.logError(error);
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
      try {
        await this.restoreCache(context, epoch);
      } catch {
        // A stale or damaged cache is independent of the local index.
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

  private cacheDir(account: number): string {
    return PathUtils.join(this.deps.store.getStoreDir(), 'shared-index-' + account);
  }

  private async attachment(libraryID: number): Promise<ZoteroItem | undefined> {
    const matches = (await Zotero.Items.getAll(libraryID, true, false)).filter((item) =>
      !item.deleted && item.libraryID === libraryID && !item.parentItemID && item.isStoredFileAttachment?.() &&
      item.getField('title') === TITLE && item.attachmentFilename === FILENAME);
    if (matches.length > 1) throw new SyncIssue('conflict');
    return matches[0];
  }

  private pathFor(item: ZoteroItem): string {
    return PathUtils.join(Zotero.Attachments.getStorageDirectory(item).path, item.attachmentFilename!);
  }

  private async runNativeSync({ libraryID }: Context): Promise<void> {
    let failed = false;
    await Zotero.Sync!.Runner.sync({ libraries: [libraryID], background: true, onError: () => { failed = true; } });
    if (failed) throw new SyncIssue('webdav');
  }

  private async publish(context: Context, epoch: number, manual: boolean): Promise<void> {
    const sync = Zotero.Sync!;
    const dir = PathUtils.join(this.deps.store.getStoreDir(), 'publish-' + context.account);
    const draftPath = PathUtils.join(dir, 'draft.json');
    const draft = await IOUtils.exists(draftPath) ? await readSyncDraft(draftPath) : undefined;
    const item = await this.attachment(context.libraryID);
    if (!this.current(epoch, context)) return;
    const binding = Zotero.Prefs.get(BINDING, true);
    const publisher = Zotero.Prefs.get(PUBLISHER, true) || Zotero.Utilities.randomString?.(24);
    if (!publisher) throw new SyncIssue('webdav');
    let head: Awaited<ReturnType<typeof readPublishedHead>> | undefined;
    if (item) {
      if ((binding ? binding !== context.account + ':' + item.key : !draft) ||
          item.attachmentSyncState === sync.Storage.Local.SYNC_STATE_IN_CONFLICT) throw new SyncIssue('conflict');
      head = await readPublishedHead(this.pathFor(item));
      if (head.snapshot.publisher !== publisher || head.snapshot.account !== context.account ||
          (!binding && draft?.snapshot.generation !== head.snapshot.generation)) throw new SyncIssue('conflict');
    } else if (binding) {
      throw new SyncIssue('conflict');
    }
    if (draft) {
      const currentGeneration = head?.snapshot.generation ?? null;
      if (draft.snapshot.account !== context.account || draft.snapshot.publisher !== publisher ||
          (currentGeneration !== (draft.previous?.generation ?? null) && currentGeneration !== draft.snapshot.generation)) {
        throw new SyncIssue('conflict');
      }
      if (await this.finishPublication(context, epoch, dir, draft)) {
        // A preference change that triggered this run still needs a fresh publication check.
        await this.publish(context, epoch, manual);
      }
      return;
    }

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

    if (!this.current(epoch, context)) return;
    const previous = head?.snapshot;
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
    const maxPartBytes = this.partBytes();
    const stamp = fnv1a64(JSON.stringify([2, maxPartBytes, source.updated, { ...manifest, generation: 0 },
      valid.map((entry) => [entry.itemKey, extractItemMetadata(byId.get(entry.itemID)!).metadataHash]),
      [...pdfs.values()].map((pdf) => [pdf.attachmentKey, pdf.parentKey, pdf.fileHash]), source.chunks.length]));
    if (item && head?.parts.length && Zotero.Prefs.get(STAMP, true) === stamp) {
      if (manual && item.attachmentSyncState !== sync.Storage.Local.SYNC_STATE_IN_SYNC) await this.runNativeSync(context);
      if (!this.current(epoch, context)) return;
      if (await fileDigest(this.pathFor(item)) !== head.digest) throw new SyncIssue('conflict');
      if (!this.isSynced(item, head.digest)) throw new SyncIssue('waiting');
      const probe = await this.remoteProbe();
      if (!await probe(item, head.digest)) throw new SyncIssue('webdav');
      const files: PublicationFile[] = [];
      for (const [i, part] of head.parts.entries()) {
        if (!this.current(epoch, context)) return;
        const file = await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, part.key);
        if (!this.isPart(file, context.libraryID, this.partTitle(publisher, head.snapshot.generation, i), i)) {
          throw new SyncIssue('conflict');
        }
        files.push({ ...part, item: file });
      }
      if (await this.ensureRemoteParts(context, epoch, probe, files)) this.setPhase('ready');
      return;
    }
    if ((!previous || valid.length > 0) && !valid.some((entry) => entry.vector) &&
        !source.chunks.some((chunk) => chunk.vector && pdfs.has(chunk.attachmentID))) {
      this.setPhase('waiting');
      return;
    }
    if (!this.current(epoch, context)) return;
    const basePublication = item && head
      ? { generation: head.snapshot.generation, digest: head.digest, keys: head.parts.map((part) => part.key) }
      : null;
    if (!this.current(epoch, context)) return;

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
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(dir);
    let prepared = false;
    try {
      const parts = await writeSyncParts(dir, manifest, records(), maxPartBytes);
      if (!this.current(epoch, context)) return;
      if (!item) {
        // Look for another publisher before importing any attachments for a first publication.
        if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
        await this.runNativeSync(context);
        if (!this.current(epoch, context)) return;
        if (await this.attachment(context.libraryID)) throw new SyncIssue('conflict');
      } else if (await fileDigest(this.pathFor(item)) !== basePublication?.digest) {
        throw new SyncIssue('conflict');
      }
      if (!this.current(epoch, context)) return;
      if (this.deps.store.activeProfile?.id !== profile.id || publicationSettings(this.deps.getConfig()) !== settings ||
          this.partBytes() !== maxPartBytes) {
        this.setPhase('waiting');
        this.schedule(300);
        return;
      }
      const pending = { snapshot: manifest, stamp, parts, previous: basePublication };
      Zotero.Prefs.set(PUBLISHER, publisher, true);
      await writeManifestFile(draftPath, pending);
      prepared = true;
      if (await this.finishPublication(context, epoch, dir, pending)) this.setPhase('ready');
    } finally {
      if (!prepared) await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    }
  }

  private partTitle(publisher: string, generation: number, index: number): string {
    return `${PART_TITLE} ${publisher} ${generation} ${index + 1}`;
  }

  private isPart(item: ZoteroItem | false, libraryID: number, title: string, index: number): item is ZoteroItem {
    return !!item && !item.deleted && item.libraryID === libraryID && !item.parentItemID &&
      !!item.isStoredFileAttachment?.() && item.attachmentFilename === partFilename(index) &&
      item.getField('title') === title;
  }

  private isSynced(item: ZoteroItem, digest: string): boolean {
    const { SYNC_STATE_IN_SYNC, SYNC_STATE_IN_CONFLICT } = Zotero.Sync!.Storage.Local;
    if (item.attachmentSyncState === SYNC_STATE_IN_CONFLICT) throw new SyncIssue('conflict');
    return item.attachmentSyncState === SYNC_STATE_IN_SYNC && item.attachmentSyncedHash === digest;
  }

  private async remoteProbe(): Promise<RemoteFileProbe> {
    const probe = await openWebDavProbe().catch(() => { throw new SyncIssue('webdav'); });
    return async (item, digest) => {
      const state = await probe(item, digest).catch(() => { throw new SyncIssue('webdav'); });
      if (state === 'conflict') throw new SyncIssue('conflict');
      return state === 'present';
    };
  }

  private async ensureRemoteParts(
    context: Context, epoch: number, probe: RemoteFileProbe, files: readonly PublicationFile[],
  ): Promise<boolean> {
    const missing: PublicationFile[] = [];
    for (const file of files) {
      if (!this.current(epoch, context)) return false;
      this.isSynced(file.item, file.digest); // Reject native attachment conflicts before considering a repair.
      if (!await probe(file.item, file.digest)) missing.push(file);
    }
    if (!this.current(epoch, context)) return false;
    if (!missing.length) return true;
    for (const file of missing) await verifyPart(this.pathFor(file.item), file);
    const repair: PublicationFile[] = [];
    for (const file of missing) {
      if (!this.current(epoch, context)) return false;
      if (!await probe(file.item, file.digest)) repair.push(file);
    }
    if (!this.current(epoch, context)) return false;
    if (!repair.length) return true;
    const sync = Zotero.Sync!;
    if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
    for (const file of repair) this.isSynced(file.item, file.digest);
    // A missing ZIP can still have a matching .prop. Upload the same verified bytes so Zotero cannot skip it.
    await sync.Storage.Local.updateSyncStates(repair.map((file) => file.item), 'force_upload');
    if (!this.current(epoch, context)) return false;
    await this.runNativeSync(context);
    for (const { item, digest } of repair) {
      if (!this.current(epoch, context)) return false;
      if (!this.isSynced(item, digest) || !await probe(item, digest)) throw new SyncIssue('webdav');
    }
    return this.current(epoch, context);
  }

  private async finishPublication(context: Context, epoch: number, dir: string, draft: SyncDraft): Promise<boolean> {
    if (!this.current(epoch, context)) return false;
    const sync = Zotero.Sync!;
    const { SYNC_STATE_IN_CONFLICT } = sync.Storage.Local;
    const { snapshot, parts, previous } = draft;
    const { publisher, generation } = snapshot;
    const probe = await this.remoteProbe();
    const baseCarrier = previous && await this.attachment(context.libraryID);
    // A draft can outlive changes to the carrier from another Zotero sync.
    if (baseCarrier && await fileDigest(this.pathFor(baseCarrier)) === previous.digest &&
        !await probe(baseCarrier, previous.digest)) throw new SyncIssue('webdav');
    const importFile = async (file: string, title: string) => {
      if (!Zotero.Attachments.importFromFile) throw new SyncIssue('webdav');
      return Zotero.Attachments.importFromFile({
        file, libraryID: context.libraryID, title, contentType: 'application/octet-stream',
      });
    };

    const titles = new Map(parts.map((_part, i) => [this.partTitle(publisher, generation, i), i]));
    const byIndex = new Map<number, ZoteroItem>();
    for (const item of await Zotero.Items.getAll(context.libraryID, true, false)) {
      if (!item.isStoredFileAttachment?.()) continue;
      const title = item.getField('title');
      const i = titles.get(title);
      if (i === undefined) continue;
      if (byIndex.has(i) || !this.isPart(item, context.libraryID, title, i)) throw new SyncIssue('conflict');
      byIndex.set(i, item);
    }
    const attachments: ZoteroItem[] = [];
    for (const [i, part] of parts.entries()) {
      if (!this.current(epoch, context)) return false;
      let item = byIndex.get(i);
      if (!item) item = await importFile(PathUtils.join(dir, partFilename(i)), this.partTitle(publisher, generation, i));
      if (!this.isSynced(item, part.digest)) await verifyPart(this.pathFor(item), part);
      attachments.push(item);
    }
    if (!this.current(epoch, context)) return false;
    if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
    if (attachments.some((item, i) => !this.isSynced(item, parts[i].digest))) {
      await this.runNativeSync(context);
      if (!this.current(epoch, context)) return false;
      if (attachments.some((item, i) => !this.isSynced(item, parts[i].digest))) throw new SyncIssue('waiting');
    }
    const manifest: SyncManifest = {
      type: 'zotero-vectorize-index-manifest', version: 2, snapshot,
      parts: parts.map((part, i) => ({ ...part, key: attachments[i].key })),
    };
    const stage = PathUtils.join(dir, FILENAME);
    await writeManifestFile(stage, manifest);
    const digest = await fileDigest(stage);
    let carrier = await this.attachment(context.libraryID);
    if (!this.current(epoch, context)) return false;
    if (!await this.ensureRemoteParts(context, epoch, probe, parts.map((part, i) => ({ ...part, item: attachments[i] })))) {
      return false;
    }
    if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
    const binding = Zotero.Prefs.get(BINDING, true);
    const release = sync.Runner.delayIndefinite();
    try {
      if (carrier) {
        const bound = context.account + ':' + carrier.key;
        if ((binding && binding !== bound) || carrier.attachmentSyncState === SYNC_STATE_IN_CONFLICT) {
          throw new SyncIssue('conflict');
        }
        const dest = this.pathFor(carrier);
        const existing = await fileDigest(dest);
        if (existing !== digest) {
          if (!binding || existing !== previous?.digest) throw new SyncIssue('conflict');
          if (!await probe(carrier, existing)) throw new SyncIssue('webdav');
          const pending = PathUtils.join(PathUtils.parent(PathUtils.parent(dest)), '.' + carrier.key + '.zvmanifest.pending');
          try {
            await IOUtils.copy(stage, pending);
            if (!this.current(epoch, context)) return false;
            await IOUtils.move(pending, dest);
          } finally {
            await IOUtils.remove(pending, { ignoreAbsent: true });
          }
        }
        if (!this.current(epoch, context)) return false;
        if (!this.isSynced(carrier, digest)) await sync.Storage.Local.updateSyncStates([carrier], 'to_upload');
      } else {
        if (binding || previous) throw new SyncIssue('conflict');
        carrier = await importFile(stage, TITLE);
      }
      Zotero.Prefs.set(BINDING, context.account + ':' + carrier.key, true);
    } finally {
      release();
    }
    if (!this.current(epoch, context)) return false;
    if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
    if (!this.isSynced(carrier, digest)) await this.runNativeSync(context);
    if (!this.current(epoch, context)) return false;
    if (!this.isSynced(carrier, digest)) throw new SyncIssue('waiting');
    if (!await probe(carrier, digest)) throw new SyncIssue('webdav');

    const retired: number[] = [];
    for (const [i, key] of (previous?.keys ?? []).entries()) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, key);
      if (previous && this.isPart(item, context.libraryID, this.partTitle(publisher, previous.generation, i), i)) {
        retired.push(item.id);
      }
    }
    if (!this.current(epoch, context)) return false;
    if (retired.length) await Zotero.Items.erase(retired);
    if (!this.current(epoch, context)) return false;
    if (previous?.keys.length) {
      if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
      await this.runNativeSync(context);
    }
    if (!this.current(epoch, context)) return false;
    Zotero.Prefs.set(STAMP, draft.stamp, true);
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    return this.current(epoch, context);
  }

  private cacheParts(dir: string, digest: string): string {
    return PathUtils.join(dir, 'parts-' + digest);
  }

  private async restoreCache(context: Context, epoch: number): Promise<void> {
    const dir = this.cacheDir(context.account);
    const path = PathUtils.join(dir, 'current.zvmanifest');
    if (await IOUtils.exists(path)) {
      const manifest = await readSyncManifest(path);
      const digest = await fileDigest(path);
      const previous = this.checkPublication(manifest.snapshot, context, digest);
      if (!this.current(epoch, context)) return;
      // Seed the durable identity for existing installations before reading potentially missing parts.
      if (!previous) this.rememberPublication(manifest.snapshot, digest);
      const parts = this.cacheParts(dir, digest);
      const paths = manifest.parts.map((_part, i) => PathUtils.join(parts, partFilename(i)));
      for (const [i, file] of paths.entries()) {
        if (!this.current(epoch, context)) return;
        await verifyPart(file, manifest.parts[i]);
      }
      await this.accept(manifest.snapshot, paths, context, epoch, digest, async () => {
        this.rememberPublication(manifest.snapshot, digest);
      });
    } else {
      // Preserve the last locally accepted snapshot through the beta protocol upgrade.
      const previous = dir + '.zvindex';
      if (!await IOUtils.exists(previous)) return;
      const manifest = syncHeader.parse(await readFirstSyncRecord(previous));
      const digest = await fileDigest(previous);
      this.checkPublication(manifest, context, digest);
      await this.accept(manifest, [previous], context, epoch, digest, async () => {
        this.rememberPublication(manifest, digest);
      }, LEGACY_MAX_BYTES);
    }
  }

  private async pruneParts(dir: string, keep: readonly string[]): Promise<void> {
    for (const path of await IOUtils.getChildren(dir)) {
      if (/^parts-[a-f0-9]{32}$/.test(PathUtils.filename(path)) && !keep.includes(path)) {
        await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
      }
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
    await snapshotSize(dest, MAX_MANIFEST_BYTES);
    const dir = this.cacheDir(context.account);
    await IOUtils.makeDirectory(dir);
    const stage = PathUtils.join(dir, 'receive.pending');
    const cache = PathUtils.join(dir, 'current.zvmanifest');
    try {
      await IOUtils.copy(dest, stage);
      const manifest = await readSyncManifest(stage);
      const digest = await fileDigest(stage);
      if (item.attachmentSyncedHash && digest !== item.attachmentSyncedHash) throw new Error('Shared index checksum changed');
      this.checkPublication(manifest.snapshot, context, digest);
      const parts = this.cacheParts(dir, digest);
      const accepted = await IOUtils.exists(cache) ? this.cacheParts(dir, await fileDigest(cache)) : null;
      await this.pruneParts(dir, accepted ? [parts, accepted] : [parts]);
      await IOUtils.makeDirectory(parts);
      const paths: string[] = [];
      for (const [i, part] of manifest.parts.entries()) {
        if (!this.current(epoch, context)) return;
        const path = PathUtils.join(parts, partFilename(i));
        const verified = await verifyPart(path, part).then(() => true, () => false);
        if (!verified) {
          const file = await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, part.key);
          if (!file || file.deleted) throw new SyncIssue('waiting');
          const { publisher, generation } = manifest.snapshot;
          if (!this.isPart(file, context.libraryID, this.partTitle(publisher, generation, i), i) ||
              file.attachmentSyncState === sync.Storage.Local.SYNC_STATE_IN_CONFLICT) throw new SyncIssue('conflict');
          if (await sync.Runner.downloadFile(file) === false) throw new SyncIssue('webdav');
          if (!this.current(epoch, context)) return;
          const source = this.pathFor(file);
          if (!await IOUtils.exists(source)) throw new SyncIssue('waiting');
          if (await snapshotSize(source, part.bytes) !== part.bytes) throw new Error('Invalid shared index part size');
          await IOUtils.copy(source, path);
          await verifyPart(path, part);
        }
        paths.push(path);
      }
      await this.accept(manifest.snapshot, paths, context, epoch, digest, async () => {
        await IOUtils.move(stage, cache);
        this.rememberPublication(manifest.snapshot, digest);
      });
      if (this.current(epoch, context)) {
        const ready = this.active?.digest === digest && !this.needsReconcile;
        if (ready) {
          await this.pruneParts(dir, [parts]);
          await IOUtils.remove(dir + '.zvindex', { ignoreAbsent: true });
        }
        if (this.current(epoch, context)) this.setPhase(ready ? 'ready' : 'waiting');
      }
    } finally {
      await IOUtils.remove(stage, { ignoreAbsent: true });
    }
  }

  private acceptedPublication(account: number): AcceptedPublication | null {
    const value: string | undefined = Zotero.Prefs.get(ACCEPTED + account, true);
    return value ? acceptedPublication.parse(JSON.parse(value)) : null;
  }

  private rememberPublication(manifest: SyncHeader, digest: string): void {
    const { account, publisher, generation } = manifest;
    const pref = ACCEPTED + account;
    const next = JSON.stringify({ publisher, generation, digest });
    if (Zotero.Prefs.get(pref, true) !== next) Zotero.Prefs.set(pref, next, true);
  }

  private checkPublication(manifest: SyncHeader, context: Context, digest: string): AcceptedPublication | null {
    if (manifest.account !== context.account) throw new Error('Shared index account changed');
    const previous = this.acceptedPublication(context.account);
    if (previous && (previous.publisher !== manifest.publisher || previous.generation > manifest.generation ||
        (previous.generation === manifest.generation && previous.digest !== digest))) {
      throw new SyncIssue('conflict');
    }
    return previous;
  }

  private async accept(
    manifest: SyncHeader, paths: readonly string[], context: Context, epoch: number, digest: string,
    commit?: () => Promise<void>, maxPartBytes?: number,
  ): Promise<void> {
    const libraryRevision = this.libraryRevision;
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
      const received = await readSyncSnapshot(paths, manifest, context.libraryID, maxPartBytes);
      if (!this.current(epoch, context)) return;
      if (libraryRevision !== this.libraryRevision) {
        this.schedule(500);
        return;
      }
      if (commit) await commit();
      if (!this.current(epoch, context)) return;
      if (libraryRevision !== this.libraryRevision) {
        this.schedule(500);
        return;
      }
      adopted = true;
      this.needsReconcile = false;
      this.setReceived({ ...received, provider, digest });
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
