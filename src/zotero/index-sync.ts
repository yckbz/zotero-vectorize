import { buildModelFingerprint } from '../core/hash.ts';
import type { EmbeddingProvider } from '../engines/provider.ts';
import type { EngineType, IndexProgress, PluginConfig } from '../types/vectorize.ts';
import type { ZoteroItem } from '../types/zotero.d.ts';
import { PREF_BRANCH } from './config.ts';
import { embeddingSettings, resolveEmbeddingProfile } from './embedding-profile.ts';
import { extractItemMetadata, isIndexableRegularItem } from './extractor.ts';
import {
  cloudEndpointDigest, LEGACY_MAX_BYTES, MIB, packVector, partFilename, prepareSyncParts, readFirstSyncRecord, readSyncSnapshot,
  SHARD_FILENAME, snapshotSize, syncHeader, syncSearchConfig,
  type RangePart, type ReceivedSnapshot, type SyncHeader, type SyncRecord,
} from './sync-snapshot.ts';
import {
  acceptedPublication, fileDigest, matchesUnconfirmedManifest, MAX_MANIFEST_BYTES, openWebDavProbe,
  readCachedManifest, readPublishedHead, readSyncDraft,
  readSyncManifest, SyncProtocolVersionError, verifyPart, writeManifestFile,
  type AcceptedPublication, type LegacySyncDraft, type LegacySyncManifest, type SyncDraft, type SyncManifest,
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
const ACCEPTED = PREF_BRANCH + 'syncAccepted.';
export type SyncRole = 'off' | 'publish' | 'receive';
export type SyncPhase = 'off' | 'waiting' | 'working' | 'ready' | 'webdav' | 'model' | 'cloud' | 'conflict' |
  'upgradePublisher' | 'upgradeReceiver' | 'error';
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
  isWaitingForOllama(): boolean;
  createProvider(config: PluginConfig): EmbeddingProvider;
  onUpdate(): void;
  onLocalAvailable(): void;
}

type RemoteFileProbe = (item: ZoteroItem, digest: string) => Promise<boolean>;
type PublicationFile = { item: ZoteroItem; bytes: number; digest: string; content?: string };
type PublishedHead = Awaited<ReturnType<typeof readPublishedHead>>;
type Draft = SyncDraft | LegacySyncDraft;
type PublishedManifest = SyncManifest | LegacySyncManifest;

class SyncIssue extends Error {
  constructor(readonly phase: Exclude<SyncPhase, 'off' | 'working' | 'ready' | 'error'>) { super(phase); }
}

function publicationSettings(config: PluginConfig): string {
  return JSON.stringify([embeddingSettings(config), config.localMaxSeqLength, config.chunkSize, config.chunkOverlap,
    config.maxPdfPages, config.defaultSearchMode, config.hybridSemanticWeight, config.normalizeNotation, config.maxResults]);
}

export class IndexSync {
  readonly partSizesMiB: readonly number[] = typeof __ZV_TEST_SYNC_PART_BYTES__ === 'number'
    ? [__ZV_TEST_SYNC_PART_BYTES__ / MIB] : [8, 16, 32, 64, 128, 256];
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
  private received: (ReceivedSnapshot & { provider: EmbeddingProvider; digest: string; currentProtocol: boolean }) | null = null;
  private waitingForFirstSnapshot = false;
  private libraryRevision = 0;
  private storeRevision = 0;
  private checkedSource: { token: string; digest: string } | null = null;
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
    return this.partSizesMiB.includes(value) ? value : this.partSizesMiB.length === 1 ? this.partSizesMiB[0] : 32;
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
    this.checkedSource = null;
    this.needsReconcile = false;
    this.deviceConfig = this.deps.getConfig();
    this.waitingForFirstSnapshot = role === 'receive';
    this.setPhase(role === 'off' ? 'off' : 'waiting');
    if (wasReceiving && role !== 'receive') this.deps.onLocalAvailable();
    if (role === 'off') return;
    this.observer = Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => {
        if (type === 'sync' && event === 'finish') this.schedule(300);
        if (type === 'item' || type === 'item-tag') {
          if (this.role === 'receive') this.invalidate(event, type, ids);
          if (this.role === 'publish' && this.affectsPublication(event, type, ids)) {
            this.libraryRevision++;
            this.schedule(15_000);
          }
        }
      },
    }, ['sync', 'item', 'item-tag'], 'zotero-vectorize-shared-index');
    if (role === 'publish') {
      this.unsubscribe = this.deps.store.subscribeWrites(() => {
        this.storeRevision++;
        this.onConfigChanged();
      });
    }
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

  onOllamaAvailable(): void {
    if (this.role === 'receive' && (!this.active || this.phase === 'model')) this.schedule(0);
  }

  private releaseLocalIndexing(): void {
    if (this.waitingForFirstSnapshot && !this.active) this.deps.onLocalAvailable();
    this.waitingForFirstSnapshot = false;
  }

  private affectsPublication(event: string, type: string, ids: Array<number | string>): boolean {
    if (type === 'item' && !['add', 'modify', 'delete', 'trash'].includes(event)) return false;
    return ids.some((id) => {
      const item = Zotero.Items.get(Number(type === 'item-tag' ? String(id).split('-')[0] : id));
      if (!item) return type === 'item' && ['delete', 'trash'].includes(event);
      return item.libraryID === Zotero.Libraries.userLibraryID &&
        (item.isPDFAttachment() || item.isRegularItem?.() === true);
    });
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

  private async publish(context: Context, epoch: number, manual: boolean, generationFloor = 0): Promise<void> {
    const sync = Zotero.Sync!;
    const dir = PathUtils.join(this.deps.store.getStoreDir(), 'publish-' + context.account);
    const draftPath = PathUtils.join(dir, 'draft.json');
    const draft = await IOUtils.exists(draftPath) ? await readSyncDraft(draftPath) : undefined;
    const item = await this.attachment(context.libraryID);
    if (!this.current(epoch, context)) return;
    const binding = Zotero.Prefs.get(BINDING, true);
    const publisher = Zotero.Prefs.get(PUBLISHER, true) || Zotero.Utilities.randomString?.(24);
    if (!publisher) throw new SyncIssue('webdav');
    let head: PublishedHead | undefined;
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
          (currentGeneration !== draft.snapshot.generation &&
            (currentGeneration !== (draft.previous?.generation ?? null) || head?.digest !== draft.previous?.digest))) {
        throw new SyncIssue('conflict');
      }
      const candidate = head?.snapshot.generation === draft.snapshot.generation ? head : undefined;
      if (candidate && !this.matchesDraft(candidate, draft)) throw new SyncIssue('conflict');
      if (draft.version === 2 || !await this.canResumeShards(context, draft, candidate)) {
        if (await this.recoverDraft(context, epoch, dir, draft, item, head, candidate)) {
          await this.publish(context, epoch, manual, Math.max(generationFloor, draft.snapshot.generation));
        }
        return;
      }
      if (await this.finishPublication(context, epoch, dir, draft, candidate?.version === 3 ? candidate : undefined)) {
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
    if (!profile) throw new SyncIssue(this.deps.isWaitingForOllama() ? 'waiting' : 'model');
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
    const sameModel = previous?.engine === model.engine && previous.model === model.model &&
      (previous.engine !== 'local-onnx' || previous.maxSeqLength === config.localMaxSeqLength) &&
      (previous.engine !== 'openai' || !config.openaiDimensions || previous.dimensions === config.openaiDimensions) &&
      (previous.engine === 'openai' ? model.engine === 'openai' && previous.endpointDigest === model.endpointDigest
        : model.engine !== 'openai' && previous.revision === model.revision);
    const store = this.deps.store;
    const profileId = profile.id;
    const maxPartBytes = this.partBytes();
    const previousParts = head?.version === 3 ? head.parts : [];
    const reuse: (RangePart & { key?: string })[] = [];
    for (const part of previousParts) {
      const file = await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, part.key);
      if (!this.current(epoch, context)) return;
      if (this.isStoredPart(file, context.libraryID, SHARD_FILENAME)) {
        this.isSynced(file, part.digest);
        reuse.push(part);
      } else {
        reuse.push({ ...part, key: undefined });
      }
    }
    const libraryRevision = this.libraryRevision;
    const token = JSON.stringify([context.account, this.storeRevision, libraryRevision, settings, profileId, model, maxPartBytes]);
    if (!manual && item && head?.version === 3 && reuse.every((part) => part.key) &&
        this.checkedSource?.digest === head.digest && this.checkedSource.token === token) {
      await this.checkPublishedFiles(context, epoch, item, head, manual);
      return;
    }

    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(dir);
    let prepared = false;
    try {
      const localItems = await Zotero.Items.getAll(context.libraryID, false, false);
      const byId = new Map(localItems.map((entry) => [entry.id, entry]));
      const result = await store.readCommitted(async () => {
        const dimensions = await store.sharedDimensions(profileId) || profile.dimensions ||
          (sameModel ? previous.dimensions : 0);
        if (!dimensions) return;
        const snapshot = syncHeader.parse({
          type: 'zotero-vectorize-index', version: 1, account: context.account, publisher,
          generation: Math.max(Date.now(), (previous?.generation ?? 0) + 1, generationFloor + 1),
          ...model, dimensions,
          maxSeqLength: config.localMaxSeqLength, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap,
          maxPdfPages: config.maxPdfPages, defaultSearchMode: config.defaultSearchMode,
          hybridSemanticWeight: config.hybridSemanticWeight, normalizeNotation: config.normalizeNotation,
          maxResults: config.maxResults,
        });
        const layout = `1:${config.chunkSize}:${config.chunkOverlap}:${config.maxPdfPages}`;
        const pdfs = new Map<number, Awaited<ReturnType<VectorStore['getShareableAttachments']>>>();
        for (const pdf of await store.getShareableAttachments(context.libraryID, layout)) {
          const live = byId.get(pdf.attachmentID);
          if (!live?.isPDFAttachment() || live.deleted || live.key !== pdf.attachmentKey ||
              live.parentItemID !== pdf.parentItemID || !/^[a-f0-9]{32}$/.test(pdf.fileHash)) continue;
          const entries = pdfs.get(pdf.parentItemID) ?? [];
          entries.push(pdf);
          pdfs.set(pdf.parentItemID, entries);
        }
        let hasVector = false;
        async function* records(sync: IndexSync): AsyncGenerator<SyncRecord> {
          for await (const entry of store.sharedItems(profileId, context.libraryID, dimensions)) {
            if (!sync.current(epoch, context)) throw new SyncIssue('waiting');
            const live = byId.get(entry.id);
            if (!isIndexableRegularItem(live) || live.key !== entry.key) continue;
            const hash = extractItemMetadata(live).metadataHash;
            const vector = hash === entry.metadataHash ? entry.vector : null;
            hasVector ||= vector !== null;
            yield ['item', entry.key, hash, packVector(vector)];
            const attachments = pdfs.get(entry.id) ?? [];
            attachments.sort((a, b) => a.attachmentKey < b.attachmentKey ? -1 : a.attachmentKey > b.attachmentKey ? 1 : 0);
            for (const pdf of attachments) {
              yield ['pdf', pdf.attachmentKey, entry.key, pdf.fileHash];
              for await (const chunk of store.sharedPassages(profileId, dimensions, pdf, config.maxPdfPages)) {
                if (!sync.current(epoch, context)) throw new SyncIssue('waiting');
                hasVector ||= chunk.vector !== null;
                yield ['chunk', pdf.attachmentKey, chunk.index, chunk.pageIndex, chunk.pageLabel,
                  chunk.charStart, chunk.charEnd, chunk.text, packVector(chunk.vector)];
              }
            }
          }
        }
        const parts = await prepareSyncParts(dir, records(this), maxPartBytes, reuse);
        if (!hasVector && !(sameModel && previous.dimensions === dimensions)) return;
        return { snapshot, parts };
      });
      if (!this.current(epoch, context)) return;
      if (!result) {
        this.setPhase('waiting');
        return;
      }
      if (libraryRevision !== this.libraryRevision || this.deps.store.activeProfile?.id !== profileId ||
          publicationSettings(this.deps.getConfig()) !== settings ||
          this.partBytes() !== maxPartBytes) {
        this.setPhase('waiting');
        this.schedule(300);
        return;
      }
      const { snapshot, parts } = result;
      if (item && head?.version === 3 && head.partBytes === maxPartBytes &&
          JSON.stringify({ ...head.snapshot, generation: 0 }) === JSON.stringify({ ...snapshot, generation: 0 }) &&
          parts.length === previousParts.length && parts.every((part, i) =>
            part.key === previousParts[i].key && part.end === previousParts[i].end)) {
        this.checkedSource = { token, digest: head.digest };
        await this.checkPublishedFiles(context, epoch, item, head, manual);
        return;
      }
      if (!item) {
        if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
        await this.runNativeSync(context);
        if (!this.current(epoch, context)) return;
        if (await this.attachment(context.libraryID)) throw new SyncIssue('conflict');
      } else if (await fileDigest(this.pathFor(item)) !== head?.digest) {
        throw new SyncIssue('conflict');
      }
      if (!this.current(epoch, context)) return;
      const base = head ? {
        generation: head.snapshot.generation, digest: head.digest,
        parts: head.parts.map((part) => ({ key: part.key, content: 'content' in part ? part.content : undefined })),
      } : null;
      const pending: SyncDraft = { version: 3, snapshot, partBytes: maxPartBytes, parts, previous: base };
      Zotero.Prefs.set(PUBLISHER, publisher, true);
      await writeManifestFile(draftPath, pending);
      prepared = true;
      const digest = await this.finishPublication(context, epoch, dir, pending);
      if (digest) {
        this.checkedSource = { token, digest };
        this.setPhase('ready');
      }
    } finally {
      if (!prepared) await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    }
  }

  private shardTitle(publisher: string, content: string): string {
    return `${PART_TITLE} ${publisher} ${content}`;
  }

  private legacyPartTitle(publisher: string, generation: number, index: number): string {
    return `${PART_TITLE} ${publisher} ${generation} ${index + 1}`;
  }

  private isStoredPart(item: ZoteroItem | false | undefined, libraryID: number, filename: string): item is ZoteroItem {
    return !!item && !item.deleted && item.libraryID === libraryID && !item.parentItemID &&
      !!item.isStoredFileAttachment?.() && item.attachmentFilename === filename;
  }

  private isPart(item: ZoteroItem | false, libraryID: number, title: string, filename: string): item is ZoteroItem {
    return this.isStoredPart(item, libraryID, filename) && item.getField('title') === title;
  }

  private async checkPublishedFiles(
    context: Context, epoch: number, item: ZoteroItem, head: SyncManifest & { digest: string }, manual: boolean,
  ): Promise<void> {
    const sync = Zotero.Sync!;
    if (manual && item.attachmentSyncState !== sync.Storage.Local.SYNC_STATE_IN_SYNC) await this.runNativeSync(context);
    if (!this.current(epoch, context)) return;
    if (await fileDigest(this.pathFor(item)) !== head.digest) throw new SyncIssue('conflict');
    if (!this.isSynced(item, head.digest)) throw new SyncIssue('waiting');
    const probe = await this.remoteProbe();
    if (!await probe(item, head.digest)) throw new SyncIssue('webdav');
    const files: PublicationFile[] = [];
    for (const part of head.parts) {
      if (!this.current(epoch, context)) return;
      const file = await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, part.key);
      if (!this.isStoredPart(file, context.libraryID, SHARD_FILENAME)) {
        this.checkedSource = null;
        this.schedule(300);
        throw new SyncIssue('waiting');
      }
      files.push({ ...part, item: file });
    }
    if (await this.ensureRemoteParts(context, epoch, probe, files)) this.setPhase('ready');
  }

  private isSynced(item: ZoteroItem, digest: string): boolean {
    const { SYNC_STATE_IN_SYNC, SYNC_STATE_IN_CONFLICT } = Zotero.Sync!.Storage.Local;
    if (item.attachmentSyncState === SYNC_STATE_IN_CONFLICT) throw new SyncIssue('conflict');
    return item.attachmentSyncState === SYNC_STATE_IN_SYNC && item.attachmentSyncedHash === digest;
  }

  private async inspectRemoteFile() {
    const probe = await openWebDavProbe().catch(() => { throw new SyncIssue('webdav'); });
    return (item: ZoteroItem, digest: string) => probe(item, digest).catch(() => { throw new SyncIssue('webdav'); });
  }

  private async remoteProbe(): Promise<RemoteFileProbe> {
    const inspect = await this.inspectRemoteFile();
    return async (item, digest) => {
      const state = await inspect(item, digest);
      if (state === 'conflict' || state === 'unconfirmed') throw new SyncIssue('conflict');
      return state === 'present';
    };
  }

  private async ensureRemoteParts(
    context: Context, epoch: number, probe: RemoteFileProbe, files: readonly PublicationFile[],
  ): Promise<boolean> {
    const missing: PublicationFile[] = [];
    for (let offset = 0; offset < files.length; offset += 4) {
      if (!this.current(epoch, context)) return false;
      const batch = files.slice(offset, offset + 4);
      for (const file of batch) this.isSynced(file.item, file.digest);
      const present = await Promise.all(batch.map((file) => probe(file.item, file.digest)));
      missing.push(...batch.filter((_file, i) => !present[i]));
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

  private matchesDraft(head: PublishedHead, draft: Draft): boolean {
    if (head.version !== draft.version || JSON.stringify(head.snapshot) !== JSON.stringify(draft.snapshot) ||
        head.parts.length !== draft.parts.length) return false;
    if (!draft.parts.every((part, i) => head.parts[i].bytes === part.bytes && head.parts[i].digest === part.digest)) return false;
    if (draft.version !== 3 || head.version !== 3) return true;
    return head.partBytes === draft.partBytes && draft.parts.every((part, i) => {
      const current = head.parts[i];
      return part.content === current.content && part.end === current.end && (!part.key || part.key === current.key);
    });
  }

  private async canResumeShards(context: Context, draft: SyncDraft, candidate: PublishedHead | undefined): Promise<boolean> {
    for (const part of candidate?.version === 3 ? candidate.parts : draft.parts) {
      if (!part.key) continue;
      const file = await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, part.key);
      if (!this.isStoredPart(file, context.libraryID, SHARD_FILENAME)) return false;
      this.isSynced(file, part.digest);
    }
    return true;
  }

  private async recoverDraft(
    context: Context, epoch: number, dir: string, draft: Draft, carrier: ZoteroItem | undefined,
    head: PublishedHead | undefined, candidate: PublishedHead | undefined,
  ): Promise<boolean> {
    if (!this.current(epoch, context)) return false;
    const probe = await this.remoteProbe();
    if (carrier && candidate) {
      const inspect = await this.inspectRemoteFile();
      const state = await inspect(carrier, candidate.digest);
      if (!this.current(epoch, context)) return false;
      const legacyPending = draft.version === 2 && candidate.version === 2 && state !== 'present';
      if (legacyPending && state === 'conflict' &&
          (!draft.previous || await inspect(carrier, draft.previous.digest) !== 'present')) throw new SyncIssue('conflict');
      if (state === 'present' || (legacyPending && await this.legacyPartsAvailable(context, epoch, candidate, probe))) {
        await this.confirmDraftCarrier(context, epoch, carrier, candidate, async () => {
          const currentState = await inspect(carrier, candidate.digest);
          if (currentState === 'present') return;
          if (legacyPending) {
            if (currentState === 'missing') return;
            if (currentState === 'conflict' && draft.previous &&
                await inspect(carrier, draft.previous.digest) === 'present') return;
            if (currentState === 'unconfirmed' && await matchesUnconfirmedManifest(carrier, dir, this.pathFor(carrier))) return;
          }
          throw new SyncIssue('conflict');
        });
        if (!await this.retirePrevious(context, epoch, carrier, candidate.digest, probe, candidate.parts,
          draft.snapshot.publisher, draft.previous)) return false;
        await IOUtils.remove(dir, { recursive: true });
        return this.current(epoch, context);
      }
      // A broken uncommitted candidate must not be published. Recover the last confirmed carrier.
      if (!draft.previous || await inspect(carrier, draft.previous.digest) !== 'present') {
        throw new SyncIssue(state === 'missing' ? 'webdav' : 'conflict');
      }
      const sync = Zotero.Sync!;
      if (sync.Runner.syncInProgress || !this.current(epoch, context)) throw new SyncIssue('waiting');
      const release = sync.Runner.delayIndefinite();
      try {
        if (await fileDigest(this.pathFor(carrier)) !== candidate.digest) throw new SyncIssue('conflict');
        if (!this.current(epoch, context)) return false;
        // Zotero can skip a download on equal timestamps even when the staged bytes differ.
        await IOUtils.setModificationTime(this.pathFor(carrier), 1);
        if (!this.current(epoch, context)) return false;
        if (await sync.Runner.downloadFile(carrier) === false) throw new SyncIssue('webdav');
        if (!this.current(epoch, context)) return false;
        head = await readPublishedHead(this.pathFor(carrier));
        if (head.digest !== draft.previous.digest || head.snapshot.account !== context.account ||
            head.snapshot.publisher !== draft.snapshot.publisher) throw new SyncIssue('conflict');
      } finally {
        release();
      }
    }

    if (!this.current(epoch, context)) return false;
    const referenced = new Set(head?.parts.map((part) => part.key));
    const pending = new Map(draft.parts.flatMap((part, i) => {
      if ('content' in part) {
        return part.key ? [] : [[this.shardTitle(draft.snapshot.publisher, part.content), { filename: SHARD_FILENAME, part }] as const];
      }
      return [[this.legacyPartTitle(draft.snapshot.publisher, draft.snapshot.generation, i),
        { filename: partFilename(i), part }] as const];
    }));
    const abandoned: number[] = [];
    if (pending.size) {
      for (const file of await Zotero.Items.getAll(context.libraryID, true, false)) {
        const owned = pending.get(file.getField('title'));
        if (!owned || referenced.has(file.key) || !this.isStoredPart(file, context.libraryID, owned.filename) ||
            file.attachmentSyncState === Zotero.Sync!.Storage.Local.SYNC_STATE_IN_CONFLICT) continue;
        if (await verifyPart(this.pathFor(file), owned.part).then(() => true, () => false)) abandoned.push(file.id);
      }
    }
    if (carrier && head) {
      if (!this.isSynced(carrier, head.digest)) {
        const digest = head.digest;
        await this.confirmDraftCarrier(context, epoch, carrier, head, async () => {
          if (!await probe(carrier, digest)) throw new SyncIssue('webdav');
        });
      }
      if (!await this.retireAttachments(context, epoch, probe, abandoned, abandoned.length > 0,
        { item: carrier, digest: head.digest })) return false;
    } else if (abandoned.length) {
      if (Zotero.Sync!.Runner.syncInProgress) throw new SyncIssue('waiting');
      if (!this.current(epoch, context)) return false;
      await this.runNativeSync(context);
      if (!this.current(epoch, context)) return false;
      if (await this.attachment(context.libraryID)) {
        this.schedule(300);
        throw new SyncIssue('waiting');
      }
      if (!await this.retireAttachments(context, epoch, probe, abandoned, true)) return false;
    }
    if (!this.current(epoch, context)) return false;
    // Keep the draft until its unreferenced attachments have been reconciled.
    await IOUtils.remove(dir, { recursive: true });
    return this.current(epoch, context);
  }

  private async legacyPartsAvailable(
    context: Context, epoch: number, head: LegacySyncManifest, probe: RemoteFileProbe,
  ): Promise<boolean> {
    // The carrier may already be queued to upload. Check each prerequisite before running native sync.
    for (const [i, part] of head.parts.entries()) {
      if (!this.current(epoch, context)) return false;
      const file = await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, part.key);
      if (!this.isPart(file, context.libraryID, this.legacyPartTitle(head.snapshot.publisher, head.snapshot.generation, i),
        partFilename(i))) return false;
      this.isSynced(file, part.digest);
      if (!await probe(file, part.digest)) return false;
    }
    return this.current(epoch, context);
  }

  private async confirmDraftCarrier(
    context: Context, epoch: number, carrier: ZoteroItem, head: PublishedHead, verifyRemote: () => Promise<void>,
  ): Promise<void> {
    const sync = Zotero.Sync!;
    if (!this.current(epoch, context)) return;
    if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
    const release = sync.Runner.delayIndefinite();
    try {
      await verifyRemote();
      if (await fileDigest(this.pathFor(carrier)) !== head.digest) throw new SyncIssue('conflict');
      if (!this.current(epoch, context)) return;
      if (!this.isSynced(carrier, head.digest)) await sync.Storage.Local.updateSyncStates([carrier], 'to_upload');
      if (!this.current(epoch, context)) return;
      Zotero.Prefs.set(BINDING, context.account + ':' + carrier.key, true);
    } finally {
      release();
    }
    if (!this.current(epoch, context)) return;
    if (!this.isSynced(carrier, head.digest)) await this.runNativeSync(context);
  }

  private async finishPublication(
    context: Context, epoch: number, dir: string, draft: SyncDraft, candidate?: SyncManifest,
  ): Promise<string | false> {
    if (!this.current(epoch, context)) return false;
    const sync = Zotero.Sync!;
    const { SYNC_STATE_IN_CONFLICT } = sync.Storage.Local;
    const { snapshot, parts, previous, partBytes } = draft;
    const { publisher } = snapshot;
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

    const titles = new Set(candidate ? [] : parts.filter((part) => !part.key).map((part) => this.shardTitle(publisher, part.content)));
    const byTitle = new Map<string, ZoteroItem[]>();
    if (titles.size) {
      for (const item of await Zotero.Items.getAll(context.libraryID, true, false)) {
        if (!this.isStoredPart(item, context.libraryID, SHARD_FILENAME)) continue;
        const title = item.getField('title');
        if (!titles.has(title)) continue;
        const entries = byTitle.get(title) ?? [];
        entries.push(item);
        byTitle.set(title, entries);
      }
    }
    const attachments: ZoteroItem[] = [];
    for (const [i, part] of parts.entries()) {
      if (!this.current(epoch, context)) return false;
      const title = this.shardTitle(publisher, part.content);
      const key = candidate?.parts[i].key ?? part.key;
      let item = key ? await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, key) : undefined;
      if (key && !this.isStoredPart(item, context.libraryID, SHARD_FILENAME)) {
        this.schedule(300);
        throw new SyncIssue('waiting');
      }
      if (!key) {
        for (const file of byTitle.get(title) ?? []) {
          if (file.attachmentSyncState !== SYNC_STATE_IN_CONFLICT &&
              await verifyPart(this.pathFor(file), part).then(() => true, () => false)) {
            item = file;
            break;
          }
        }
      }
      if (!item) {
        const path = PathUtils.join(dir, part.content, SHARD_FILENAME);
        await verifyPart(path, part);
        if (!this.current(epoch, context)) return false;
        item = await importFile(path, title);
      }
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
      type: 'zotero-vectorize-index-manifest', version: 3, snapshot, partBytes,
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

    if (!await this.retirePrevious(context, epoch, carrier, digest, probe, manifest.parts, publisher, previous)) return false;
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    return this.current(epoch, context) && digest;
  }

  private async retirePrevious(
    context: Context, epoch: number, carrier: ZoteroItem, digest: string, probe: RemoteFileProbe,
    current: readonly PublishedManifest['parts'][number][], publisher: string, previous: SyncDraft['previous'],
  ): Promise<boolean> {
    const referenced = new Set(current.map((part) => part.key));
    const retired: number[] = [];
    let needsRetirementSync = false;
    for (const [i, { key, content }] of (previous?.parts ?? []).entries()) {
      if (referenced.has(key)) continue;
      needsRetirementSync = true;
      const item = await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, key);
      const title = content ? this.shardTitle(publisher, content) : this.legacyPartTitle(publisher, previous!.generation, i);
      if (this.isPart(item, context.libraryID, title, content ? SHARD_FILENAME : partFilename(i))) {
        retired.push(item.id);
      }
    }
    return this.retireAttachments(context, epoch, probe, retired, needsRetirementSync, { item: carrier, digest });
  }

  private async retireAttachments(
    context: Context, epoch: number, probe: RemoteFileProbe, retired: number[], needsRetirementSync: boolean,
    anchor?: { item: ZoteroItem; digest: string },
  ): Promise<boolean> {
    if (!this.current(epoch, context)) return false;
    const sync = Zotero.Sync!;
    if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
    const releaseRetirement = sync.Runner.delayIndefinite();
    try {
      // Resolving the retired attachments may have overlapped with another Zotero sync.
      if (anchor) {
        const { item, digest } = anchor;
        if (await fileDigest(this.pathFor(item)) !== digest) throw new SyncIssue('conflict');
        if (!this.isSynced(item, digest)) throw new SyncIssue('waiting');
        if (!await probe(item, digest)) throw new SyncIssue('webdav');
      } else if (await this.attachment(context.libraryID)) {
        throw new SyncIssue('conflict');
      }
      if (!this.current(epoch, context)) return false;
      if (retired.length) await Zotero.Items.erase(retired);
    } finally {
      releaseRetirement();
    }
    if (!this.current(epoch, context)) return false;
    if (needsRetirementSync) {
      if (sync.Runner.syncInProgress) throw new SyncIssue('waiting');
      await this.runNativeSync(context);
    }
    return this.current(epoch, context);
  }

  private cacheParts(dir: string, digest: string): string {
    return PathUtils.join(dir, 'parts-' + digest);
  }

  private cachedPart(dir: string, part: SyncManifest['parts'][number]): string {
    return PathUtils.join(dir, 'shards', part.key + '-' + part.content + '.zvpart');
  }

  private async restoreCache(context: Context, epoch: number): Promise<void> {
    const dir = this.cacheDir(context.account);
    const path = PathUtils.join(dir, 'current.zvmanifest');
    if (await IOUtils.exists(path)) {
      const manifest = await readCachedManifest(path);
      const digest = await fileDigest(path);
      const previous = this.checkPublication(manifest.snapshot, context, digest);
      if (!this.current(epoch, context)) return;
      // Seed the durable identity for existing installations before reading potentially missing parts.
      if (!previous) this.rememberPublication(manifest.snapshot, digest);
      const parts = this.cacheParts(dir, digest);
      const paths = manifest.version === 3
        ? manifest.parts.map((part) => this.cachedPart(dir, part))
        : manifest.parts.map((_part, i) => PathUtils.join(parts, partFilename(i)));
      for (const [i, file] of paths.entries()) {
        if (!this.current(epoch, context)) return;
        await verifyPart(file, manifest.parts[i]);
      }
      await this.accept(manifest.snapshot, paths, context, epoch, digest, async () => {
        this.rememberPublication(manifest.snapshot, digest);
      }, manifest.version === 3 ? manifest.parts : undefined);
    } else {
      // Preserve the last locally accepted snapshot through the beta protocol upgrade.
      const previous = dir + '.zvindex';
      if (!await IOUtils.exists(previous)) return;
      const manifest = syncHeader.parse(await readFirstSyncRecord(previous));
      const digest = await fileDigest(previous);
      this.checkPublication(manifest, context, digest);
      await this.accept(manifest, [previous], context, epoch, digest, async () => {
        this.rememberPublication(manifest, digest);
      }, undefined, LEGACY_MAX_BYTES);
    }
  }

  private async pruneParts(dir: string, keep: ReadonlySet<string>, retireLegacy: boolean): Promise<void> {
    for (const path of await IOUtils.getChildren(PathUtils.join(dir, 'shards'))) {
      if (/^[A-Z0-9]{8}-[a-f0-9]{64}\.zvpart(?:\.pending)?$/.test(PathUtils.filename(path)) && !keep.has(path)) {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
    if (!retireLegacy) return;
    for (const path of await IOUtils.getChildren(dir)) {
      if (/^parts-[a-f0-9]{32}$/.test(PathUtils.filename(path))) {
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
    if (this.active?.currentProtocol && item.attachmentSyncedHash === this.active.digest && !this.needsReconcile) {
      this.setPhase('ready');
      return;
    }
    await snapshotSize(dest, MAX_MANIFEST_BYTES);
    const dir = this.cacheDir(context.account);
    await IOUtils.makeDirectory(PathUtils.join(dir, 'shards'), { ignoreExisting: true, createAncestors: true });
    const stage = PathUtils.join(dir, 'receive.pending');
    const cache = PathUtils.join(dir, 'current.zvmanifest');
    let observedDigest: string | undefined;
    try {
      await IOUtils.copy(dest, stage);
      const digest = await fileDigest(stage);
      if (item.attachmentSyncedHash && digest !== item.attachmentSyncedHash) throw new Error('Shared index checksum changed');
      const manifest = await readSyncManifest(stage);
      this.checkPublication(manifest.snapshot, context, digest);
      observedDigest = digest;
      const paths = manifest.parts.map((part) => this.cachedPart(dir, part));
      const accepted = await readCachedManifest(cache).catch(() => null);
      const keep = new Set(paths);
      if (accepted?.version === 3) {
        for (const part of accepted.parts) keep.add(this.cachedPart(dir, part));
      }
      if (accepted || (!this.active && !await IOUtils.exists(cache))) await this.pruneParts(dir, keep, false);
      for (const [i, part] of manifest.parts.entries()) {
        if (!this.current(epoch, context)) return;
        const path = paths[i];
        const verified = await verifyPart(path, part).then(() => true, () => false);
        if (!verified) {
          const file = await Zotero.Items.getByLibraryAndKeyAsync(context.libraryID, part.key);
          if (!file || file.deleted) throw new SyncIssue('waiting');
          if (!this.isStoredPart(file, context.libraryID, SHARD_FILENAME) ||
              file.attachmentSyncState === sync.Storage.Local.SYNC_STATE_IN_CONFLICT) throw new SyncIssue('conflict');
          const source = this.pathFor(file);
          if (!await verifyPart(source, part).then(() => true, () => false)) {
            if (await sync.Runner.downloadFile(file) === false) throw new SyncIssue('webdav');
            if (!this.current(epoch, context)) return;
            if (!await IOUtils.exists(source)) throw new SyncIssue('waiting');
          }
          const pending = path + '.pending';
          try {
            if (await snapshotSize(source, part.bytes) !== part.bytes) throw new Error('Invalid shared index part size');
            await IOUtils.copy(source, pending);
            await verifyPart(pending, part);
            if (!this.current(epoch, context)) return;
            await IOUtils.move(pending, path);
          } finally {
            await IOUtils.remove(pending, { ignoreAbsent: true });
          }
        }
      }
      await this.accept(manifest.snapshot, paths, context, epoch, digest, async () => {
        if (await fileDigest(dest) !== digest) {
          this.schedule(300);
          throw new SyncIssue('waiting');
        }
        if (!this.current(epoch, context)) return;
        await IOUtils.move(stage, cache);
        this.rememberPublication(manifest.snapshot, digest);
      }, manifest.parts);
      if (this.current(epoch, context)) {
        const ready = this.active?.digest === digest && !this.needsReconcile;
        if (ready) {
          await this.pruneParts(dir, new Set(paths), true);
          await IOUtils.remove(dir + '.zvindex', { ignoreAbsent: true });
        }
        if (this.current(epoch, context)) this.setPhase(ready ? 'ready' : 'waiting');
      }
    } catch (error) {
      if (error instanceof SyncProtocolVersionError) {
        throw new SyncIssue(error.version < 3 ? 'upgradePublisher' : 'upgradeReceiver');
      }
      // The publisher can retire a part while we are reading a superseded manifest.
      if (observedDigest && error instanceof SyncIssue && ['waiting', 'webdav'].includes(error.phase) &&
          this.current(epoch, context)) {
        const latest = await sync.Runner.downloadFile(item).then((result) =>
          result === false ? undefined : fileDigest(dest)).catch(() => undefined);
        if (latest && latest !== observedDigest && this.current(epoch, context)) {
          this.setPhase('waiting');
          this.schedule(300);
          return;
        }
      }
      throw error;
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
    commit?: () => Promise<void>, ranges?: readonly RangePart[], maxPartBytes?: number,
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
      const received = await readSyncSnapshot(paths, manifest, context.libraryID, ranges, maxPartBytes);
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
      this.setReceived({ ...received, provider, digest, currentProtocol: ranges !== undefined });
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
