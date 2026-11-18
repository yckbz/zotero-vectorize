import type {
  AttachmentStateRecord,
  IndexProgress,
  IndexedChunkRecord,
  IndexedItemRecord,
  PluginConfig,
} from '../types/vectorize.ts';
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
        notify: (event, type, ids, extraData) => {
          if (this.disposed) return;
          const cfg = this.deps.getConfig();
          if (!cfg.autoIndexOnChange) return;

          if (type === 'item') {
            if (event === 'delete' || event === 'trash') {
              void this.handleDeletes(ids, extraData);
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
      if (this.disposed || this.pendingDebounceIds.size === 0) return;
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

  private async handleDeletes(ids: Array<number | string>, _extraData: Record<string, any>): Promise<void> {
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
  }

  async startLibraryScan(forceRebuild = false): Promise<void> {
    if (this.disposed || this.cancelled) return;
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

    if (this.activeRun) {
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

  private async saveAttachmentChunks(chunks: IndexedChunkRecord[], state: AttachmentStateRecord): Promise<void> {
    const { searchIndex, store } = this.deps;
    const previousParents = await store.saveAttachmentChunksAndState(chunks, state, 'replace');
    for (const id of [...(previousParents ?? []), state.parentItemID]) {
      searchIndex.replaceItemChunks(id, await store.getChunksForItem(id));
    }
  }

  private async processItemIds(itemIds: number[], forceRebuild: boolean, libraryScan = false): Promise<void> {
    const cfg = this.deps.getConfig();
    const strings = getStrings(cfg);
    const provider = await this.deps.getProvider();
    const status = await provider.getStatus();
    const canEmbedNeural = status.neuralAvailable;
    if (libraryScan && canEmbedNeural) {
      this.activeLibraryVectorProvider = provider;
      if (this.pendingModelBackfill === provider) this.pendingModelBackfill = null;
    }
    const initialFp = provider.getModelFingerprint();
    const targetHasDim = status.dimensions > 0;
    const chunkingKey = `1:${cfg.chunkSize}:${cfg.chunkOverlap}:${cfg.maxPdfPages}`;

    const indexingMessage = canEmbedNeural
      ? `Indexing with ${provider.model}…`
      : 'Indexing text for lexical search (neural model pending)…';
    this.emit({
      phase: 'indexing',
      totalItems: itemIds.length,
      processedItems: 0,
      totalAttachments: 0,
      processedAttachments: 0,
      embeddedChunks: 0,
      skippedUnchanged: 0,
      failedCount: 0,
      message: indexingMessage,
      lastError: undefined,
    });

    let processedItems = 0;
    let totalAttachments = 0;
    let processedAttachments = 0;
    let embeddedChunks = 0;
    let savedChunks = 0;
    let skippedUnchanged = 0;
    let failedCount = 0;
    let passageBatchSize: Promise<number> | undefined;
    const recordFailure = (message: string): void => {
      failedCount++;
      this.emit({ failedCount, lastError: this.progress.lastError ?? message });
    };

    for (const itemID of itemIds) {
      if (!(await this.waitIfPaused())) break;

      let item: ZoteroItem | null = null;
      try {
        item = await Zotero.Items.getAsync(itemID);
      } catch {
        item = null;
      }
      if (!isIndexableRegularItem(item)) {
        processedItems++;
        this.emit({ processedItems });
        continue;
      }

      const meta = extractItemMetadata(item);
      this.emit({ currentTitle: meta.title || item.key, message: indexingMessage });

      // 1. Metadata incremental check
      try {
        const existing = forceRebuild ? null : await this.deps.store.getItemSyncInfo(item.id);
        const existingMem = !forceRebuild ? this.deps.searchIndex.getItemById(item.id) : undefined;
        const metaMatches =
          existing !== null &&
          existing.metadataHash === meta.metadataHash &&
          (!canEmbedNeural || (existing.hasVector && fingerprintMatches(existing.modelFingerprint, initialFp, targetHasDim)));

        if (metaMatches) {
          skippedUnchanged++;
        } else {
          let vector: Float32Array | null = null;
          let fp = '';
          let embedFailed = false;
          if (canEmbedNeural && meta.canonicalText) {
            try {
              const vecs = await provider.embedPassages([meta.canonicalText]);
              vector = vecs[0] ?? null;
              fp = vector ? buildModelFingerprint(provider.engine, provider.model, vector.length) : '';
            } catch (err: any) {
              embedFailed = true;
              recordFailure(err?.message || String(err));
            }
          }

          const hasPreservableVector =
            !forceRebuild &&
            existing !== null &&
            existing.hasVector &&
            Boolean(existingMem?.vector && existingMem.dim > 0);

          const preserveExistingVector =
            embedFailed && hasPreservableVector && existing!.metadataHash === meta.metadataHash;

          if (!preserveExistingVector && !item.deleted) {
            const reuseExistingVector = !vector && hasPreservableVector && (!canEmbedNeural || embedFailed);
            const recordVector = reuseExistingVector ? existingMem!.vector : vector;
            const recordDim = reuseExistingVector ? existingMem!.dim : vector ? vector.length : 0;
            const recordFp = reuseExistingVector ? existingMem!.modelFingerprint : fp;
            const recordHash = reuseExistingVector && existing ? existing.metadataHash : meta.metadataHash;

            const record: IndexedItemRecord = {
              itemID: meta.itemID,
              itemKey: meta.itemKey,
              libraryID: meta.libraryID,
              itemType: meta.itemType,
              title: meta.title,
              creators: meta.creators,
              year: meta.year,
              publicationTitle: meta.publicationTitle,
              doi: meta.doi,
              url: meta.url,
              tags: meta.tags,
              abstractNote: meta.abstractNote,
              metadataHash: recordHash,
              vector: recordVector,
              dim: recordDim,
              modelFingerprint: recordFp,
              updatedAt: Date.now(),
            };
            await this.deps.store.upsertItem(record);
            this.deps.searchIndex.upsertItem(record);
          }
        }
      } catch (err: any) {
        Zotero.logError(err);
        recordFailure(err?.message || String(err));
      }

      // 2. PDF Attachments incremental check
      const attIds = item.getAttachments?.(false) ?? [];
      const pdfAttachments: ZoteroItem[] = [];
      for (const attId of attIds) {
        try {
          const att = await Zotero.Items.getAsync(attId);
          if (att && !att.deleted && att.isPDFAttachment()) {
            pdfAttachments.push(att);
          }
        } catch {
          // Ignore broken attachment
        }
      }
      totalAttachments += pdfAttachments.length;
      this.emit({ totalAttachments });

      for (const att of pdfAttachments) {
        if (!(await this.waitIfPaused())) break;
        try {
          const attachmentTitle = att.getDisplayTitle?.() || att.key;
          this.emit({ message: strings.indexCheckingFile });
          const sig = await waitForAttachmentRead(
            getAttachmentSignature(att),
            strings.indexReadTimeout(strings.indexCheckingFile, attachmentTitle, ATTACHMENT_READ_TIMEOUT_MS / 1000)
          );
          const { store, searchIndex } = this.deps;
          const prevState = await store.getAttachmentState(att.id);
          const sameSource = prevState !== null &&
            prevState.parentItemID === item.id &&
            prevState.attachmentKey === att.key &&
            prevState.fileHash === sig.fileHash &&
            prevState.mtime === sig.mtime;
          const sameLayout = !forceRebuild && sameSource && prevState.chunkingKey === chunkingKey;
          const modelFp = provider.getModelFingerprint();
          const modelHasDim = targetHasDim || modelFp !== initialFp;
          const isCurrent = () => !item.deleted && !att.deleted && att.parentItemID === item.id;

          if (sameLayout && (prevState.status === 'no_text' || prevState.status === 'missing' ||
              (prevState.status === 'indexed' &&
                (!canEmbedNeural || fingerprintMatches(prevState.modelFingerprint, modelFp, modelHasDim))))) {
            skippedUnchanged++;
            processedAttachments++;
            this.emit({ skippedUnchanged, processedAttachments });
            continue;
          }

          const existing = !forceRebuild && (sameSource || (prevState === null && !canEmbedNeural))
            ? (await store.getChunksForItem(item.id)).filter((chunk) => chunk.attachmentID === att.id)
            : [];
          if (!canEmbedNeural && prevState === null && existing.some((chunk) => chunk.vector)) {
            skippedUnchanged++;
            processedAttachments++;
            this.emit({ skippedUnchanged, processedAttachments });
            continue;
          }

          const reuseLayout = sameLayout && existing.length > 0 && existing.length === prevState.chunkCount;
          const state: AttachmentStateRecord = {
            attachmentID: att.id,
            attachmentKey: att.key,
            parentItemID: item.id,
            fileHash: sig.fileHash,
            mtime: sig.mtime,
            chunkingKey,
            status: 'indexed',
            chunkCount: 0,
            modelFingerprint: '',
            updatedAt: Date.now(),
          };
          let chunks = existing;
          if (!reuseLayout) {
            this.emit({ message: strings.indexReadingPdf });
            const extracted = await waitForAttachmentRead(
              extractPdfPages(att, cfg.maxPdfPages, sig),
              strings.indexReadTimeout(strings.indexReadingPdf, attachmentTitle, ATTACHMENT_READ_TIMEOUT_MS / 1000)
            );
            if (!isCurrent() || this.cancelled || this.disposed) break;
            state.status = extracted.status;
            state.errorMessage = extracted.errorMessage;
            if (extracted.status === 'indexed') {
              const byId = new Map(existing.map((chunk) => [chunk.chunkId, chunk]));
              chunks = chunkDocumentPages(extracted.pages, {
                itemID: item.id,
                itemKey: item.key,
                attachmentID: att.id,
                attachmentKey: att.key,
                attachmentTitle,
                chunkSize: cfg.chunkSize,
                chunkOverlap: cfg.chunkOverlap,
              }).map((chunk) => {
                // After a layout change, reuse only vectors verified against the new chunk text.
                const stored = byId.get(chunk.chunkId);
                const match = stored?.text === chunk.text ? stored : undefined;
                return {
                  ...chunk,
                  vector: match?.vector ?? null,
                  dim: match?.dim ?? 0,
                  modelFingerprint: match?.modelFingerprint ?? '',
                  updatedAt: match?.updatedAt ?? state.updatedAt,
                };
              });
              if (!chunks.length) state.status = 'no_text';
            } else {
              if (extracted.status === 'error' && existing.length) {
                recordFailure(extracted.errorMessage || strings.indexReadingPdf);
                processedAttachments++;
                this.emit({ processedAttachments });
                continue;
              }
              chunks = [];
            }
          }

          state.chunkCount = chunks.length;
          if (!isCurrent()) continue;
          if (state.status !== 'indexed' || !canEmbedNeural) {
            if (!reuseLayout) {
              await this.saveAttachmentChunks(chunks, state);
              savedChunks += chunks.length;
            }
            if (state.status === 'error') recordFailure(state.errorMessage || strings.indexReadingPdf);
            processedAttachments++;
            this.emit({ processedAttachments });
            continue;
          }

          const matchingFingerprint = chunks.find((chunk) =>
            chunk.vector && fingerprintMatches(chunk.modelFingerprint, modelFp, modelHasDim)
          )?.modelFingerprint;
          state.modelFingerprint = matchingFingerprint || (modelHasDim ? modelFp : '');
          const needed = chunks.filter((chunk) =>
            !chunk.vector || chunk.modelFingerprint !== state.modelFingerprint
          );
          state.status = needed.length ? 'pending' : 'indexed';
          if (!reuseLayout) {
            await this.saveAttachmentChunks(chunks, state);
          } else {
            const written = await store.saveAttachmentChunksAndState([], state, 'checkpoint');
            if (written === null) continue;
          }
          savedChunks += chunks.length;

          try {
            let completed = chunks.length - needed.length;
            this.emit({ message: strings.indexEmbeddingPdf(completed, chunks.length) });
            for (let start = 0; start < needed.length;) {
              if (!(await this.waitIfPaused()) || !isCurrent()) break;
              let batch: IndexedChunkRecord[];
              let vectors: Float32Array[];
              try {
                const batchSize = await (passageBatchSize ??= Promise.resolve(provider.getPassageBatchSize()));
                if (!(await this.waitIfPaused()) || !isCurrent()) break;
                batch = needed.slice(start, start + batchSize);
                vectors = await provider.embedPassages(batch.map((chunk) => chunk.text));
                const dim = vectors[0]?.length;
                const fp = buildModelFingerprint(provider.engine, provider.model, dim);
                if (!dim || vectors.length !== batch.length ||
                    vectors.some((vector) => vector.length !== dim || !isFiniteVector(vector)) ||
                    (state.modelFingerprint && state.modelFingerprint !== fp)) {
                  throw new Error('Embedding provider returned invalid or incompatible PDF vectors');
                }
                state.modelFingerprint = fp;
              } catch (err: any) {
                if (isCurrent() && !this.cancelled && !this.disposed) {
                  state.status = 'error';
                  const message = err?.message || String(err);
                  state.errorMessage = message;
                  state.updatedAt = Date.now();
                  const written = await store.saveAttachmentChunksAndState([], state, 'checkpoint');
                  if (written !== null) recordFailure(message);
                }
                break;
              }
              if (!isCurrent()) break;
              state.status = start + batch.length === needed.length ? 'indexed' : 'pending';
              state.updatedAt = Date.now();
              const checkpoint = batch.map((chunk, index) => ({
                ...chunk,
                vector: vectors[index],
                dim: vectors[index].length,
                modelFingerprint: state.modelFingerprint,
                updatedAt: state.updatedAt,
              }));
              const written = await store.saveAttachmentChunksAndState(checkpoint, state, 'checkpoint');
              if (written === null) break;
              start += batch.length;
              completed += batch.length;
              embeddedChunks += batch.length;
              if (!this.paused && !this.cancelled) {
                this.emit({ embeddedChunks, message: strings.indexEmbeddingPdf(completed, chunks.length) });
              }
            }
          } finally {
            searchIndex.replaceItemChunks(item.id, await store.getChunksForItem(item.id));
          }
          processedAttachments++;
          this.emit({ embeddedChunks, processedAttachments });
        } catch (err: any) {
          recordFailure(err?.message || String(err));
          if (err instanceof AttachmentReadTimeout) {
            // A stalled Zotero PDF worker may block the shared queue.
            throw err;
          }
          processedAttachments++;
          Zotero.logError(err);
          this.emit({ processedAttachments });
        }
        await yieldToEventLoop(10);
      }

      processedItems++;
      this.emit({ processedItems, skippedUnchanged });
      this.deps.onItemIndexed?.();
      await yieldToEventLoop(12);
    }

    if (this.cancelled) {
      this.emit({ phase: 'idle', currentTitle: '', message: 'Cancelled' });
    } else {
      this.emit({
        phase: failedCount ? 'incomplete' : 'completed',
        currentTitle: '',
        message: failedCount
          ? strings.indexIncomplete(processedItems, failedCount, this.progress.lastError || '')
          : canEmbedNeural
            ? strings.indexVectorDone(processedItems, embeddedChunks)
            : strings.indexTextDone(processedItems, savedChunks),
      });
    }
  }
}
