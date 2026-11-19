import type {
  AttachmentStateRecord,
  IndexProgress,
  IndexedChunkRecord,
  IndexedItemRecord,
  PluginConfig,
} from '../types/vectorize.ts';
import type { ExtractedItemMetadata } from '../types/vectorize.ts';
import type { ZoteroItem } from '../types/zotero.d.ts';
import type { EmbeddingProvider } from '../engines/provider.ts';
import { chunkDocumentPages } from '../core/chunker.ts';
import { buildModelFingerprint } from '../core/hash.ts';
import { isFiniteVector } from '../core/math.ts';
import { VectorSearchIndex } from '../core/search-engine.ts';
import { extractItemMetadata, extractPdfPages, getAttachmentSignature, isIndexableRegularItem } from './extractor.ts';
import { getStrings } from './i18n.ts';
import type { VectorStore } from './vector-store.ts';

const ATTACHMENT_READ_TIMEOUT_MS = 120_000;

class AttachmentReadTimeout extends Error {}

async function waitForAttachmentRead<T>(read: Promise<T>, errorMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AttachmentReadTimeout(errorMessage)), ATTACHMENT_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function yieldToEventLoop(ms = 12): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fingerprintMatches(storedFp: string, targetFp: string, targetHasDim: boolean): boolean {
  if (!storedFp || !targetFp) return false;
  if (storedFp === targetFp) return true;
  return !targetHasDim && storedFp.startsWith(targetFp + ':') &&
    /^[1-9]\d*$/.test(storedFp.slice(targetFp.length + 1));
}

interface PreparedAttachment {
  item: ZoteroItem;
  attachment: ZoteroItem;
  state: AttachmentStateRecord;
  remaining: number;
}

export interface IndexerDeps {
  getConfig: () => PluginConfig;
  getProvider: () => Promise<EmbeddingProvider>;
  store: VectorStore;
  searchIndex: VectorSearchIndex;
  onItemIndexed?: () => void;
}

export class BackgroundIndexer {
  private readonly deps: IndexerDeps;
  private progress: IndexProgress = {
    phase: 'idle',
    totalItems: 0,
    processedItems: 0,
    totalAttachments: 0,
    processedAttachments: 0,
    embeddedChunks: 0,
    skippedUnchanged: 0,
    failedCount: 0,
    currentTitle: '',
    message: '',
  };
  private listeners = new Set<(p: IndexProgress) => void>();
  private notifierID: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDebounceIds = new Set<number>();
  private activeRun: Promise<void> | null = null;
  private activeLibraryVectorProvider: EmbeddingProvider | null = null;
  private pendingModelBackfill: EmbeddingProvider | null = null;
  private paused = false;
  private cancelled = false;
  private disposed = false;
  private suspended = false;
  private deleteWrites = Promise.resolve();
  private queuedDeletes = new Set<number>();

  async withWritesSuspended<T>(operation: () => Promise<T>): Promise<T> {
    this.suspended = true;
    try {
      await this.cancel();
      await this.deleteWrites;
      return await operation();
    } finally {
      this.suspended = false;
      if (this.queuedDeletes.size) {
        this.queueDeletes([...this.queuedDeletes]);
        this.queuedDeletes.clear();
      }
      if (this.pendingDebounceIds.size) this.scheduleDebouncedFlush();
    }
  }

  private queueDeletes(ids: Array<number | string>): void {
    if (this.suspended) {
      for (const id of ids) this.queuedDeletes.add(Number(id));
      return;
    }
    this.deleteWrites = this.deleteWrites.then(() => this.handleDeletes(ids));
  }

  constructor(deps: IndexerDeps) {
    this.deps = deps;
  }

  getProgress(): IndexProgress {
    return { ...this.progress };
  }

  subscribeProgress(cb: (p: IndexProgress) => void): () => void {
    this.listeners.add(cb);
    cb(this.getProgress());
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(patch: Partial<IndexProgress>): void {
    this.progress = { ...this.progress, ...patch };
    const snap = this.getProgress();
    for (const cb of this.listeners) {
      try {
        cb(snap);
      } catch {
        // Ignore UI callback error
      }
    }
  }

  private async waitIfPaused(): Promise<boolean> {
    while (this.paused && !this.cancelled && !this.disposed) {
      await yieldToEventLoop(250);
    }
    return !this.cancelled && !this.disposed;
  }

  startNotifier(): void {
    if (this.notifierID || typeof Zotero === 'undefined' || !Zotero?.Notifier) return;
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids) => {
          if (this.disposed) return;
          const cfg = this.deps.getConfig();
          if (!cfg.autoIndexOnChange) return;

          if (type === 'item') {
            if (event === 'delete' || event === 'trash') {
              this.queueDeletes(ids);
              return;
            }
            if (event === 'add' || event === 'modify') {
              for (const rawId of ids) {
                const id = Number(rawId);
                if (Number.isFinite(id) && id > 0) {
                  this.pendingDebounceIds.add(id);
                }
              }
              this.scheduleDebouncedFlush();
            }
          } else if (type === 'item-tag') {
            for (const raw of ids) {
              const itemId = Number(String(raw).split('-')[0]);
              if (Number.isFinite(itemId) && itemId > 0) {
                this.pendingDebounceIds.add(itemId);
              }
            }
            this.scheduleDebouncedFlush();
          }
        },
      },
      ['item', 'item-tag'],
      'zotero-vectorize-indexer'
    );
  }

  scheduleStartupScan(delayMs = 3500): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.disposed) return;
      const cfg = this.deps.getConfig();
      if (cfg.autoIndexOnStartup) {
        void this.startLibraryScan(false);
      }
    }, delayMs);
  }

  private scheduleDebouncedFlush(delayMs = 1800): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.disposed || this.suspended || this.pendingDebounceIds.size === 0) return;
      const batch = Array.from(this.pendingDebounceIds);
      this.pendingDebounceIds.clear();
      void this.indexItemOrAttachmentIds(batch, false);
    }, delayMs);
  }

  private schedulePendingDrainAfterRun(): void {
    this.activeLibraryVectorProvider = null;
    const pendingModelBackfill = this.pendingModelBackfill;
    this.pendingModelBackfill = null;
    if (this.disposed || this.cancelled) return;
    if (pendingModelBackfill && (this.progress.phase === 'completed' || this.progress.phase === 'incomplete')) {
      void this.startLibraryScan(false);
      return;
    }
    if (this.pendingDebounceIds.size > 0) {
      this.scheduleDebouncedFlush(80);
    }
  }

  requestModelBackfill(provider: EmbeddingProvider): void {
    if (this.disposed || this.cancelled || this.activeLibraryVectorProvider === provider) return;
    if (this.activeRun) {
      this.pendingModelBackfill = provider;
    } else if (this.deps.getConfig().autoIndexOnStartup || this.deps.searchIndex.getItemCount() > 0) {
      void this.startLibraryScan(false);
    }
  }

  private async handleDeletes(ids: Array<number | string>): Promise<void> {
    let changed = false;
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!Number.isFinite(id) || id <= 0) continue;
      this.pendingDebounceIds.delete(id);
      try {
        await this.deps.store.removeItem(id);
        this.deps.searchIndex.removeItem(id);
        const parentId = await this.deps.store.removeAttachment(id);
        if (parentId !== null) {
          const remainingChunks = await this.deps.store.getChunksForItem(parentId);
          this.deps.searchIndex.replaceItemChunks(parentId, remainingChunks);
        }
        changed = true;
      } catch (e) {
        Zotero.logError(e);
      }
    }
    if (changed) {
      this.deps.onItemIndexed?.();
    }
  }

  private async reconcileLibrary(regularIDs: Set<number>, pdfIDs: Set<number>): Promise<void> {
    const { searchIndex, store } = this.deps;
    const staleItems = new Set<number>();
    const staleAttachments = new Set<number>();
    const parentsToRefresh = new Set<number>();
    for (const item of searchIndex.getAllItems()) {
      if (!regularIDs.has(item.itemID)) staleItems.add(item.itemID);
    }
    for (const chunk of searchIndex.getAllChunks()) {
      if (!regularIDs.has(chunk.itemID)) {
        staleItems.add(chunk.itemID);
      } else if (chunk.attachmentID > 0 && !pdfIDs.has(chunk.attachmentID)) {
        staleAttachments.add(chunk.attachmentID);
        parentsToRefresh.add(chunk.itemID);
      }
    }
    for (const id of await store.getStoredAttachmentIDs()) {
      if (!pdfIDs.has(id)) staleAttachments.add(id);
    }
    for (const id of staleItems) {
      await store.removeItem(id);
      searchIndex.removeItem(id);
    }
    for (const id of staleAttachments) {
      const parentID = await store.removeAttachment(id);
      if (parentID !== null && regularIDs.has(parentID)) parentsToRefresh.add(parentID);
    }
    for (const id of parentsToRefresh) {
      searchIndex.replaceItemChunks(id, await store.getChunksForItem(id));
    }
    if (staleItems.size || staleAttachments.size) this.deps.onItemIndexed?.();
  }

  pause(): void {
    this.paused = true;
    if (this.progress.phase === 'indexing' || this.progress.phase === 'scanning') {
      this.emit({ phase: 'paused', message: 'Paused' });
    }
  }

  resume(): void {
    this.paused = false;
    if (this.progress.phase === 'paused') {
      this.emit({ phase: 'indexing', message: 'Resuming…' });
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.paused = false;
    this.pendingModelBackfill = null;
    if (this.activeRun) {
      await this.activeRun.catch(() => {});
    }
    this.cancelled = false;
    this.emit({ phase: 'idle', message: '' });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.notifierID && typeof Zotero !== 'undefined' && Zotero?.Notifier) {
      try {
        Zotero.Notifier.unregisterObserver(this.notifierID);
      } catch {
        // Ignore
      }
      this.notifierID = null;
    }
    await this.cancel();
    await this.deleteWrites;
  }

  async startLibraryScan(forceRebuild = false): Promise<void> {
    if (this.disposed || this.cancelled || this.suspended) return;
    if (this.activeRun) {
      return this.activeRun;
    }
    this.cancelled = false;
    this.paused = false;

    const run = (async () => {
      try {
        this.emit({
          phase: 'scanning',
          totalItems: 0,
          processedItems: 0,
          totalAttachments: 0,
          processedAttachments: 0,
          embeddedChunks: 0,
          skippedUnchanged: 0,
          failedCount: 0,
          currentTitle: '',
          message: 'Scanning Zotero library…',
          lastError: undefined,
        });

        const libs = Zotero.Libraries.getAll();
        const regularIds = new Set<number>();
        const pdfParents = new Map<number, number>();
        for (const lib of libs) {
          if (lib.libraryType === 'feed') continue;
          const items = await Zotero.Items.getAll(lib.libraryID, false, false);
          for (const item of items) {
            if (!item.deleted && item.isPDFAttachment?.() && item.parentItemID) {
              pdfParents.set(item.id, item.parentItemID);
            } else if (isIndexableRegularItem(item)) {
              regularIds.add(item.id);
            }
          }
          await yieldToEventLoop(5);
        }

        if (!this.cancelled && !this.disposed) {
          const pdfIDs = new Set<number>();
          for (const [id, parentID] of pdfParents) {
            if (regularIds.has(parentID)) pdfIDs.add(id);
          }
          await this.reconcileLibrary(regularIds, pdfIDs);
        }
        await this.processItemIds(Array.from(regularIds), forceRebuild, true);
      } catch (err: any) {
        Zotero.logError(err);
        this.emit({
          phase: 'error',
          message: err?.message || String(err),
          lastError: err?.message || String(err),
        });
      } finally {
        this.activeRun = null;
        this.schedulePendingDrainAfterRun();
      }
    })();

    this.activeRun = run;
    return run;
  }

  async indexItemOrAttachmentIds(rawIds: number[], forceRebuild = false): Promise<void> {
    const resolvedRegularIds = new Set<number>();
    for (const id of rawIds) {
      try {
        const item = await Zotero.Items.getAsync(id);
        if (!item || item.deleted) continue;
        if (isIndexableRegularItem(item)) {
          resolvedRegularIds.add(item.id);
        } else if (item.isAttachment?.() && typeof item.parentItemID === 'number' && item.parentItemID > 0) {
          resolvedRegularIds.add(item.parentItemID);
        }
      } catch {
        // Ignore deleted/missing item
      }
    }
    if (resolvedRegularIds.size === 0) return;

    if (this.disposed) return;
    if (this.activeRun || this.suspended || this.cancelled) {
      for (const id of resolvedRegularIds) {
        this.pendingDebounceIds.add(id);
      }
      return;
    }

    this.cancelled = false;
    this.paused = false;
    const run = (async () => {
      try {
        await this.processItemIds(Array.from(resolvedRegularIds), forceRebuild);
      } catch (err: any) {
        Zotero.logError(err);
        this.emit({
          phase: 'error',
          message: err?.message || String(err),
          lastError: err?.message || String(err),
        });
      } finally {
        this.activeRun = null;
        this.schedulePendingDrainAfterRun();
      }
    })();
    this.activeRun = run;
    return run;
  }

  private isCurrent(work: PreparedAttachment): boolean {
    return !work.item.deleted && !work.attachment.deleted && work.attachment.parentItemID === work.item.id;
  }

  private async prepareAttachment(
    item: ZoteroItem, att: ZoteroItem, provider: EmbeddingProvider, canEmbed: boolean,
    force: boolean, cfg: PluginConfig,
    recordFailure: (message: string) => void,
    recordText: (count: number) => void
  ): Promise<PreparedAttachment | null> {
    const { store, searchIndex } = this.deps;
    const strings = getStrings(cfg);
    const title = att.getDisplayTitle?.() || att.key;
    const sig = await waitForAttachmentRead(
      getAttachmentSignature(att),
      strings.indexReadTimeout(strings.indexCheckingFile, title, ATTACHMENT_READ_TIMEOUT_MS / 1000)
    );
    const previous = await store.getAttachmentState(att.id);
    const chunkingKey = `1:${cfg.chunkSize}:${cfg.chunkOverlap}:${cfg.maxPdfPages}`;
    const sameSource = previous !== null && previous.parentItemID === item.id && previous.attachmentKey === att.key &&
      previous.fileHash === sig.fileHash && previous.mtime === sig.mtime;
    const sameLayout = !force && sameSource && previous.chunkingKey === chunkingKey;
    const model = provider.getModelFingerprint();
    const hasDimension = model !== buildModelFingerprint(provider.engine, provider.model);
    if (sameLayout && (previous.status === 'no_text' || previous.status === 'missing' ||
        (previous.status === 'indexed' && (!canEmbed || fingerprintMatches(previous.modelFingerprint, model, hasDimension))))) {
      this.emit({ skippedUnchanged: this.progress.skippedUnchanged + 1 });
      return null;
    }

    const existing = searchIndex.getItemChunks(item.id).some((chunk) => chunk.attachmentID === att.id)
      ? (await store.getChunksForItem(item.id)).filter((chunk) => chunk.attachmentID === att.id && chunk.attachmentKey === att.key)
      : [];
    const reuseLayout = sameLayout && existing.length > 0 && existing.length === previous.chunkCount;
    const state: AttachmentStateRecord = {
      attachmentID: att.id, attachmentKey: att.key, parentItemID: item.id, fileHash: sig.fileHash,
      mtime: sig.mtime, chunkingKey, status: 'indexed', chunkCount: 0, modelFingerprint: '', updatedAt: Date.now(),
    };
    const work: PreparedAttachment = { item, attachment: att, state, remaining: 0 };
    let chunks = existing;
    if (!reuseLayout) {
      const extracted = await waitForAttachmentRead(
        extractPdfPages(att, cfg.maxPdfPages, sig),
        strings.indexReadTimeout(strings.indexReadingPdf, title, ATTACHMENT_READ_TIMEOUT_MS / 1000)
      );
      if (!(await this.waitIfPaused()) || !this.isCurrent(work)) return null;
      state.status = extracted.status;
      state.errorMessage = extracted.errorMessage;
      if (extracted.status === 'error') {
        recordFailure(extracted.errorMessage || strings.indexReadingPdf);
        if (previous?.chunkCount) return null;
      }

      const byId = new Map(existing.map((chunk) => [chunk.chunkIndex, chunk]));
      chunks = chunkDocumentPages(extracted.pages, {
        itemID: item.id, itemKey: item.key, attachmentID: att.id, attachmentKey: att.key,
        attachmentTitle: title, chunkSize: cfg.chunkSize, chunkOverlap: cfg.chunkOverlap,
      }).map((chunk) => {
        const stored = byId.get(chunk.chunkIndex);
        const match = stored?.text === chunk.text ? stored : undefined;
        const preserved = !force && match ? match : null;
        return { ...chunk, chunkId: match?.chunkId ?? `${att.id}:${chunk.chunkId}`,
          vector: preserved?.vector ?? null, dim: preserved?.dim ?? 0,
          modelFingerprint: preserved?.modelFingerprint ?? '', updatedAt: preserved?.updatedAt ?? state.updatedAt };
      });
      if (!chunks.length && state.status === 'indexed') state.status = 'no_text';
    }

    if (!(await this.waitIfPaused()) || !this.isCurrent(work)) return null;
    state.chunkCount = chunks.length;
    work.remaining = canEmbed ? chunks.filter((chunk) => !chunk.vector).length : 0;
    if (work.remaining) state.status = 'pending';
    if (!reuseLayout) {
      const parents = await store.saveAttachmentChunksAndState(chunks, state, 'replace', force);
      await store.readCommitted(async () => {
        for (const id of new Set([...(parents ?? []), item.id])) {
          searchIndex.replaceItemChunks(id, await store.getChunksForItem(id));
        }
      });
      recordText(chunks.length);
      this.deps.onItemIndexed?.();
    } else if (canEmbed) {
      if (await store.saveAttachmentChunksAndState([], state, 'checkpoint') === null) return null;
    }
    return work.remaining ? work : null;
  }

  private async processItemIds(itemIds: number[], force: boolean, libraryScan = false): Promise<void> {
    if (!(await this.waitIfPaused())) return;
    const cfg = this.deps.getConfig();
    const strings = getStrings(cfg);
    const provider = await this.deps.getProvider();
    const status = await provider.getStatus();
    const canEmbed = status.neuralAvailable && this.deps.store.activeProfile !== null;
    if (libraryScan && canEmbed) {
      this.activeLibraryVectorProvider = provider;
      if (this.pendingModelBackfill === provider) this.pendingModelBackfill = null;
    }
    this.emit({
      phase: 'indexing', stage: 'metadata', totalItems: itemIds.length, processedItems: 0, totalAttachments: 0,
      processedAttachments: 0, embeddedChunks: 0, skippedUnchanged: 0,
      failedCount: 0, currentTitle: '', lastError: undefined, message: strings.indexingMetadata,
    });

    const { store, searchIndex } = this.deps;
    let savedChunks = 0;
    const recordFailure = (message: string): void => {
      this.emit({ failedCount: this.progress.failedCount + 1, lastError: this.progress.lastError ?? message });
    };
    const validateVectors = (vectors: Float32Array[], count: number): void => {
      const dim = vectors[0]?.length;
      if (!dim || vectors.length !== count || vectors.some((vector) => vector.length !== dim || !isFiniteVector(vector))) {
        throw new Error('Embedding provider returned invalid or incompatible vectors');
      }
    };
    const ready: PreparedAttachment[] = [];
    let reader: Promise<void> | undefined;

    const preparePdfs = async function* (this: BackgroundIndexer) {
      for (const itemID of itemIds) {
        if (!(await this.waitIfPaused())) return;
        const item = await Zotero.Items.getAsync(itemID).catch(() => null);
        if (!isIndexableRegularItem(item)) continue;
        for (const attachmentID of item.getAttachments?.(false) ?? []) {
          if (!(await this.waitIfPaused())) return;
          const att = await Zotero.Items.getAsync(attachmentID).catch(() => null);
          if (!att || att.deleted || !att.isPDFAttachment()) continue;
          this.emit({ totalAttachments: this.progress.totalAttachments + 1 });
          let work;
          try {
            work = await this.prepareAttachment(item, att, provider, canEmbed, force, cfg, recordFailure,
              (count) => { savedChunks += count; });
          } catch (error) {
            if (error instanceof AttachmentReadTimeout) throw error;
            recordFailure(error instanceof Error ? error.message : String(error));
            Zotero.logError(error);
          } finally {
            this.emit({ processedAttachments: this.progress.processedAttachments + 1 });
          }
          if (work) yield work;
        }
        await yieldToEventLoop(0);
      }
    }.call(this);

    // Only one PDF read is in flight. Its text is persisted immediately and the
    // queue holds attachment checkpoints, not another copy of the text.
    let pdfDone = false;
    let pdfError: unknown;
    const prefetch = () => {
      if (reader || pdfDone || this.cancelled || this.disposed) return;
      reader = (async () => {
        while ((this.progress.stage === 'metadata' || ready.length < 2) && !pdfDone && !this.cancelled && !this.disposed) {
          const result = await preparePdfs.next();
          if (result.done) pdfDone = true;
          else ready.push(result.value);
        }
      })().catch((error: unknown) => {
        pdfDone = true;
        pdfError = error;
      }).finally(() => { reader = undefined; });
    };

    const metadataBatchSize = canEmbed && provider.embedMetadata ? await provider.getPassageBatchSize() : 1;
    const metadata: Array<{ item: ZoteroItem; value: ExtractedItemMetadata }> = [];
    const flushMetadata = async () => {
      if (!metadata.length || !(await this.waitIfPaused())) return;
      const batch = metadata.splice(0);
      const inputs = batch.filter(({ value }) => value.canonicalText);
      const embeddings = new Map<number, Float32Array>();
      if (canEmbed && inputs.length) {
        try {
          const texts = inputs.map(({ value }) => value.canonicalText);
          const vectors = provider.embedMetadata ? await provider.embedMetadata(texts) : await provider.embedPassages(texts);
          validateVectors(vectors, inputs.length);
          inputs.forEach(({ item }, index) => embeddings.set(item.id, vectors[index]));
        } catch (error) {
          recordFailure(error instanceof Error ? error.message : String(error));
        }
      }
      if (!(await this.waitIfPaused())) return;
      const records: IndexedItemRecord[] = [];
      for (const { item, value } of batch) {
        if (item.deleted || extractItemMetadata(item).metadataHash !== value.metadataHash) continue;
        const previous = searchIndex.getItemById(item.id);
        const vector = embeddings.get(item.id) ?? (previous?.metadataHash === value.metadataHash ? previous.vector : null);
        const { canonicalText: _text, dateModified: _modified, ...fields } = value;
        records.push({ ...fields, vector, dim: vector?.length ?? 0,
          modelFingerprint: vector ? buildModelFingerprint(provider.engine, provider.model, vector.length) : '',
          updatedAt: Date.now() });
      }
      await store.upsertItems(records.map((record) => embeddings.has(record.itemID) ? record : { ...record, vector: null }));
      for (const record of records) searchIndex.upsertItem(record);
      this.deps.onItemIndexed?.();
    };

    prefetch();
    try {
      let visited = 0;
      for (const itemID of itemIds) {
        if (!(await this.waitIfPaused())) break;
        const item = await Zotero.Items.getAsync(itemID).catch(() => null);
        if (isIndexableRegularItem(item)) {
          const value = extractItemMetadata(item);
          const existing = force ? null : await store.getItemSyncInfo(item.id);
          if (existing?.metadataHash === value.metadataHash && (!canEmbed || existing.hasVector || !value.canonicalText)) {
            this.emit({ skippedUnchanged: this.progress.skippedUnchanged + 1 });
          } else {
            metadata.push({ item, value });
          }
        }
        visited++;
        if (metadata.length >= metadataBatchSize || visited % 32 === 0) {
          await flushMetadata();
          this.emit({ processedItems: visited });
          await yieldToEventLoop(0);
        }
      }
      await flushMetadata();
      this.emit({ processedItems: visited });

      if (!this.cancelled && !this.disposed) {
        this.emit({ stage: 'fulltext', message: strings.indexingFulltext });
      }
      let limit: number | undefined;
      const batch: Array<{ work: PreparedAttachment; chunk: IndexedChunkRecord }> = [];
      const failed = new Set<number>();
      const flushPassages = async (): Promise<void> => {
        if (!batch.length || !(await this.waitIfPaused())) return;
        const current = batch.splice(0).filter(({ work }) => this.isCurrent(work) && !failed.has(work.attachment.id));
        if (!current.length) return;

        let vectors: Float32Array[];
        try {
          vectors = await provider.embedPassages(current.map(({ chunk }) => chunk.text));
          validateVectors(vectors, current.length);
        } catch (error) {
          if (this.cancelled || this.disposed) return;
          const message = error instanceof Error ? error.message : String(error);
          for (const work of new Set(current.map((entry) => entry.work))) {
            if (!this.isCurrent(work)) continue;
            failed.add(work.attachment.id);
            if (await store.saveAttachmentChunksAndState([], { ...work.state, status: 'error', errorMessage: message },
              'checkpoint') !== null) recordFailure(message);
          }
          return;
        }

        if (!(await this.waitIfPaused())) return;
        const checkpoints = new Map<PreparedAttachment, IndexedChunkRecord[]>();
        for (const [index, { work, chunk }] of current.entries()) {
          const vector = vectors[index];
          const list = checkpoints.get(work) ?? [];
          list.push({ ...chunk, vector, dim: vector.length,
            modelFingerprint: buildModelFingerprint(provider.engine, provider.model, vector.length), updatedAt: Date.now() });
          checkpoints.set(work, list);
        }
        for (const [work, rows] of checkpoints) {
          if (this.cancelled || this.disposed || !this.isCurrent(work)) continue;
          work.remaining -= rows.length;
          const complete = work.remaining === 0;
          const committed = await store.saveAttachmentChunksAndState(rows, {
            ...work.state, status: complete ? 'indexed' : 'pending', updatedAt: Date.now(),
          }, 'checkpoint');
          if (committed === null) continue;
          await store.readCommitted(async () => {
            const byID = new Map(rows.map((row) => [row.chunkId, row]));
            searchIndex.replaceItemChunks(work.item.id, searchIndex.getItemChunks(work.item.id)
              .map((chunk) => byID.get(chunk.chunkId) ?? chunk));
          });
          this.deps.onItemIndexed?.();
          this.emit({
            embeddedChunks: this.progress.embeddedChunks + rows.length,
            message: strings.indexEmbeddingPdf(work.state.chunkCount - work.remaining, work.state.chunkCount),
          });
        }
      };

      while (await this.waitIfPaused()) {
        if (!ready.length && !pdfDone) {
          prefetch();
          await reader;
        }
        const work = ready.shift();
        if (!work) break;
        prefetch();
        if (!this.isCurrent(work)) continue;
        const chunks = searchIndex.getItemChunks(work.item.id)
          .filter((chunk) => chunk.attachmentID === work.attachment.id && !chunk.vector);
        if (!chunks.length) continue;
        limit ??= await provider.getPassageBatchSize();
        for (const chunk of chunks) {
          if (failed.has(work.attachment.id) || this.cancelled || this.disposed) break;
          batch.push({ work, chunk });
          if (batch.length === limit) await flushPassages();
        }
        await flushPassages();
      }
      await flushPassages();
      if (pdfError) throw pdfError;
    } finally {
      await reader;
      await preparePdfs.return(undefined);
    }

    if (this.cancelled || this.disposed) {
      this.emit({ phase: 'idle', stage: undefined, currentTitle: '', message: 'Cancelled' });
    } else {
      this.emit({
        phase: this.progress.failedCount ? 'incomplete' : 'completed', stage: undefined, currentTitle: '',
        message: this.progress.failedCount
          ? strings.indexIncomplete(this.progress.processedItems, this.progress.failedCount, this.progress.lastError || '')
          : canEmbed ? strings.indexVectorDone(this.progress.processedItems, this.progress.embeddedChunks)
            : strings.indexTextDone(this.progress.processedItems, savedChunks),
      });
    }
  }
}
