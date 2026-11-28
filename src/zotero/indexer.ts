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
import {
  extractItemMetadata, extractPdfPages, getAttachmentSignature, isIndexableRegularItem, isPdfWorkerBusy,
  requestPdfFullText, type PdfExtractionResult,
} from './extractor.ts';
import { getStrings } from './i18n.ts';
import { REBUILD_FROM_EXTRACTION, type VectorStore } from './vector-store.ts';

const ATTACHMENT_READ_TIMEOUT_MS = 120_000;
/** Runs in a row a PDF version must time out in before scans skip it. */
const READ_TIMEOUT_SKIP_STRIKES = 2;

class AttachmentReadTimeout extends Error {}
/** Zotero's PDF worker runs one job at a time, and an earlier timed-out job still holds it. */
class PdfWorkerBusy extends AttachmentReadTimeout {}
/** Waiting for Zotero's worker timed out before our PDF started. */
class PdfWorkerQueuedTimeout extends AttachmentReadTimeout {}
/** Internal sentinel used to wake up an in-flight read immediately when the indexer cancels. */
class ReadCancelled extends Error {}

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
  /**
   * During a full rebuild, the first passage index not yet re-embedded. Stored vectors stay searchable
   * until a new vector replaces them. Null outside a rebuild.
   */
  rebuildFrom: number | null;
}

function needsEmbedding(work: PreparedAttachment, chunk: IndexedChunkRecord): boolean {
  return !chunk.vector || (work.rebuildFrom !== null && chunk.chunkIndex >= work.rebuildFrom);
}

export interface IndexerDeps {
  getConfig: () => PluginConfig;
  getProvider: () => Promise<EmbeddingProvider>;
  store: VectorStore;
  searchIndex: VectorSearchIndex;
  shouldAutoIndex?: (libraryID: number) => boolean;
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
  /** Explicitly requested items queued during a busy run, mapped to whether the request was forced. */
  private pendingExplicitIds = new Map<number, boolean>();
  private activeRun: Promise<void> | null = null;
  /**
   * Set while activeRun is a library scan, to tell which later scan requests it already covers. An automatic
   * scan leaves out libraries that should not be indexed automatically, such as a personal library that
   * receives a shared index, and records when it did.
   */
  private activeLibraryScan: { force: boolean; automatic: boolean; excludedLibrary: boolean } | null = null;
  /** A library scan requested while another run was active. It runs next instead of being dropped. */
  private queuedLibraryScan: { force: boolean; automatic: boolean; done: Promise<void>; resolve: () => void } | null = null;
  private activeLibraryVectorProvider: EmbeddingProvider | null = null;
  private pendingModelBackfill: EmbeddingProvider | null = null;
  private paused = false;
  private cancelled = false;
  private disposed = false;
  private suspended = false;
  private deleteWrites = Promise.resolve();
  private queuedDeletes = new Set<number>();
  /** How long one attachment check or PDF text extraction may take before the scan skips that file. */
  readTimeoutMs = ATTACHMENT_READ_TIMEOUT_MS;
  /** A PDF read that timed out and has not finished in Zotero's serial PDF worker yet. */
  private stalledRead: Promise<void> | null = null;
  /** PDF worker jobs whose foreground wait was cancelled while Zotero's serial worker was still running them. */
  private pendingCancelledReads = new Set<Promise<void>>();
  /** Callbacks woken immediately when cancel() is called so in-flight waits do not block shutdown or maintenance. */
  private cancelWaiters = new Set<() => void>();
  /** Text Zotero extracted after the scan gave up on it, kept for the next scan of the same file version. */
  private lateReads = new Map<number, { fileHash: string; mtime: number; maxPdfPages: number; result: PdfExtractionResult }>();
  /** Changes when the index is cleared, so text from a read started before that is not kept. */
  private lateReadGeneration = 0;

  /** Drops text kept from timed-out reads, including reads that finish later. */
  forgetLateReads(): void {
    this.lateReadGeneration++;
    this.lateReads.clear();
  }

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
      if (this.pendingDebounceIds.size || this.pendingExplicitIds.size) this.scheduleDebouncedFlush();
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

  private onCancel(callback: () => void): () => void {
    if (this.cancelled || this.disposed) {
      callback();
      return () => {};
    }
    this.cancelWaiters.add(callback);
    return () => {
      this.cancelWaiters.delete(callback);
    };
  }

  private notifyCancelWaiters(): void {
    if (!this.cancelWaiters.size) return;
    const waiters = [...this.cancelWaiters];
    this.cancelWaiters.clear();
    for (const wake of waiters) {
      try {
        wake();
      } catch {
        // Ignore individual waiter errors during cancellation
      }
    }
  }

  private sleepOrCancel(ms: number): Promise<void> {
    if (this.cancelled || this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const done = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        unsubscribe?.();
        unsubscribe = undefined;
        resolve();
      };
      timer = setTimeout(done, ms);
      unsubscribe = this.onCancel(done);
    });
  }

  private async waitForAttachmentRead<T>(read: Promise<T>, errorMessage: string, timeoutMs: number): Promise<T> {
    if (this.cancelled || this.disposed) {
      void read.catch(() => {});
      throw new ReadCancelled();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeCancel: (() => void) | undefined;
    const race = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AttachmentReadTimeout(errorMessage)), timeoutMs);
      unsubscribeCancel = this.onCancel(() => reject(new ReadCancelled()));
    });
    try {
      return await Promise.race([read, race]);
    } catch (error) {
      void read.catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      unsubscribeCancel?.();
    }
  }

  private trackCancelledWorkerRead(read: Promise<PdfExtractionResult>): void {
    const pending: Promise<void> = read.then(() => undefined, () => undefined).finally(() => {
      this.pendingCancelledReads.delete(pending);
    });
    this.pendingCancelledReads.add(pending);
  }

  private isPdfWorkerCurrentlyBusy(): boolean {
    return isPdfWorkerBusy() === true || this.pendingCancelledReads.size > 0;
  }

  private async waitIfPaused(): Promise<boolean> {
    while (this.paused && !this.cancelled && !this.disposed) {
      await this.sleepOrCancel(250);
    }
    return !this.cancelled && !this.disposed;
  }

  startNotifier(): void {
    if (this.notifierID || typeof Zotero === 'undefined' || !Zotero?.Notifier) return;
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids) => {
          if (this.disposed) return;
          // Removals keep search from returning deleted or trashed items, so they do not depend on auto-indexing.
          if (type === 'item' && (event === 'delete' || event === 'trash')) {
            this.queueDeletes(ids);
            return;
          }
          if (!this.deps.getConfig().autoIndexOnChange) return;

          if (type === 'item') {
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

  scheduleStartupScan(delayMs = 3500, backfillProvider?: EmbeddingProvider): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.disposed) return;
      const cfg = this.deps.getConfig();
      if (cfg.autoIndexOnStartup) {
        if (backfillProvider) this.requestModelBackfill(backfillProvider);
        else void this.startLibraryScan(false, true);
      }
    }, delayMs);
  }

  private scheduleDebouncedFlush(delayMs = 1800): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.disposed || this.suspended) return;
      if (this.pendingExplicitIds.size) {
        // Forced requests run on their own so a queued "Vectorize Selected Items" keeps its force flag.
        const forced = [...this.pendingExplicitIds].filter(([, force]) => force).map(([id]) => id);
        const explicit = forced.length ? forced : [...this.pendingExplicitIds.keys()];
        for (const id of explicit) this.pendingExplicitIds.delete(id);
        void this.indexItemOrAttachmentIds(explicit, forced.length > 0).finally(() => {
          if (!this.disposed && !this.activeRun && (this.pendingExplicitIds.size || this.pendingDebounceIds.size)) {
            this.scheduleDebouncedFlush(80);
          }
        });
        return;
      }
      if (this.pendingDebounceIds.size === 0) return;
      const batch = Array.from(this.pendingDebounceIds);
      this.pendingDebounceIds.clear();
      void this.indexItemOrAttachmentIds(batch, false, true);
    }, delayMs);
  }

  private schedulePendingDrainAfterRun(): void {
    this.activeLibraryVectorProvider = null;
    const pendingModelBackfill = this.pendingModelBackfill;
    this.pendingModelBackfill = null;
    if (this.disposed || this.cancelled) return;
    const queued = this.queuedLibraryScan;
    if (queued) {
      // The queued scan also embeds whatever a pending model backfill would, and drains queued items after it.
      this.queuedLibraryScan = null;
      void this.startLibraryScan(queued.force, queued.automatic).finally(queued.resolve);
      return;
    }
    if (pendingModelBackfill && (this.progress.phase === 'completed' || this.progress.phase === 'incomplete')) {
      void this.startLibraryScan(false, true);
      return;
    }
    if (this.pendingDebounceIds.size > 0 || this.pendingExplicitIds.size > 0) {
      this.scheduleDebouncedFlush(80);
    }
  }

  requestModelBackfill(provider: EmbeddingProvider): void {
    if (this.disposed || this.cancelled || this.activeLibraryVectorProvider === provider) return;
    if (this.activeRun) {
      this.pendingModelBackfill = provider;
    } else if (this.deps.getConfig().autoIndexOnStartup || this.deps.searchIndex.getItemCount() > 0) {
      void this.startLibraryScan(false, true);
    }
  }

  private async handleDeletes(ids: Array<number | string>): Promise<void> {
    let changed = false;
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!Number.isFinite(id) || id <= 0) continue;
      this.pendingDebounceIds.delete(id);
      this.pendingExplicitIds.delete(id);
      this.lateReads.delete(id);
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
    const queued = this.queuedLibraryScan;
    this.queuedLibraryScan = null;
    queued?.resolve();
    this.notifyCancelWaiters();
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
    this.forgetLateReads();
  }

  async startLibraryScan(forceRebuild = false, automatic = false): Promise<void> {
    if (this.disposed || this.cancelled || this.suspended) return;
    if (this.activeRun) {
      // A running library scan already covers an incremental request. A rebuild asked for during an
      // incremental scan, or any library scan asked for during a single-item run, runs next instead.
      const active = this.activeLibraryScan;
      if (active && (active.force || !forceRebuild) && (!active.automatic || automatic ||
          (!active.excludedLibrary && !this.excludesAnyLibrary()))) {
        return this.activeRun;
      }
      return this.queueLibraryScan(forceRebuild, automatic);
    }
    this.cancelled = false;
    this.paused = false;
    this.activeLibraryScan = { force: forceRebuild, automatic, excludedLibrary: false };

    const run = (async () => {
      try {
        await Promise.resolve();
        if (this.cancelled || this.disposed) return;
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
        await this.processItemIds(Array.from(regularIds), forceRebuild, true, automatic);
      } catch (err: any) {
        Zotero.logError(err);
        const error = err?.message || String(err);
        // Attachments the rebuild had started resume on the next scan. The rest still have their old vectors.
        const note = forceRebuild ? ` ${getStrings(this.deps.getConfig()).indexRebuildStoppedNote}` : '';
        this.emit({ phase: 'error', message: error + note, lastError: error });
      } finally {
        this.activeRun = null;
        this.activeLibraryScan = null;
        this.schedulePendingDrainAfterRun();
      }
    })();

    this.activeRun = run;
    return run;
  }

  /** Whether automatic indexing currently leaves out a library that a manual scan would index. */
  private excludesAnyLibrary(): boolean {
    const shouldAutoIndex = this.deps.shouldAutoIndex;
    if (!shouldAutoIndex) return false;
    try {
      return Zotero.Libraries.getAll().some((lib) => lib.libraryType !== 'feed' && !shouldAutoIndex(lib.libraryID));
    } catch {
      return true;
    }
  }

  private queueLibraryScan(force: boolean, automatic: boolean): Promise<void> {
    const queued = this.queuedLibraryScan;
    if (queued) {
      queued.force ||= force;
      queued.automatic &&= automatic;
      return queued.done;
    }
    let resolve!: () => void;
    const done = new Promise<void>((settle) => { resolve = settle; });
    this.queuedLibraryScan = { force, automatic, done, resolve };
    return done;
  }

  async indexItemOrAttachmentIds(rawIds: number[], forceRebuild = false, automatic = false): Promise<void> {
    const resolvedRegularIds = new Set<number>();
    for (const id of rawIds) {
      try {
        const item = await Zotero.Items.getAsync(id);
        if (!item || item.deleted) continue;
        if (automatic && this.deps.shouldAutoIndex?.(item.libraryID) === false) continue;
        if (isIndexableRegularItem(item)) {
          resolvedRegularIds.add(item.id);
        } else if (item.isAttachment?.() && typeof item.parentItemID === 'number' && item.parentItemID > 0) {
          const parent = await Zotero.Items.getAsync(item.parentItemID).catch(() => null);
          if (isIndexableRegularItem(parent) && (!automatic || this.deps.shouldAutoIndex?.(parent.libraryID) !== false)) {
            resolvedRegularIds.add(parent.id);
          }
        }
      } catch {
        // Ignore deleted/missing item
      }
    }
    if (resolvedRegularIds.size === 0) return;

    if (this.disposed) return;
    if (this.activeRun || this.suspended || this.cancelled) {
      for (const id of resolvedRegularIds) {
        if (automatic) this.pendingDebounceIds.add(id);
        else this.pendingExplicitIds.set(id, forceRebuild || this.pendingExplicitIds.get(id) === true);
      }
      return;
    }

    this.cancelled = false;
    this.paused = false;
    const run = (async () => {
      try {
        await Promise.resolve();
        if (this.cancelled || this.disposed) return;
        await this.processItemIds(Array.from(resolvedRegularIds), forceRebuild, false, automatic);
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

  private async waitForPdfWorkerIdle(
    budget: { remaining: number }, pollMs: number, isStillValid: () => boolean
  ): Promise<'ready' | 'cancelled' | 'busy_timeout'> {
    while (this.isPdfWorkerCurrentlyBusy()) {
      if (this.cancelled || this.disposed || !isStillValid()) return 'cancelled';
      if (this.paused) {
        if (!(await this.waitIfPaused()) || !isStillValid()) return 'cancelled';
        continue;
      }
      if (budget.remaining <= 0) return 'busy_timeout';
      const step = Math.min(pollMs, budget.remaining);
      const startedAt = Date.now();
      await this.sleepOrCancel(step);
      budget.remaining -= Math.max(step, Date.now() - startedAt);
    }
    return this.cancelled || this.disposed || !isStillValid() ? 'cancelled' : 'ready';
  }

  private watchStalledRead(
    attachmentID: number, signature: { fileHash: string; mtime: number }, maxPdfPages: number, read: Promise<PdfExtractionResult>
  ): void {
    const generation = this.lateReadGeneration;
    const stalled: Promise<void> = read.then((result) => result, () => null).then(async (result) => {
      if (this.stalledRead === stalled) this.stalledRead = null;
      // Only a successful late read proves the file is merely slow rather than stuck. A read that times out
      // and then errors keeps its timeout strike so repeated failures still reach the skip threshold.
      if (this.disposed || !result || result.status === 'error' || generation !== this.lateReadGeneration) return;
      // Zotero finished the job after the scan moved on, so the file is slow rather than stuck. Keep the
      // text for the next scan of this file version instead of extracting it again or skipping it.
      // Nothing is indexed here: the user's next scan decides when and what to index.
      this.lateReads.set(attachmentID, { ...signature, maxPdfPages, result });
      if (this.suspended) return;
      try {
        await this.deps.store.clearReadTimeout(attachmentID, signature);
      } catch (error) {
        if (!this.disposed) Zotero.logError(error);
      }
    });
    this.stalledRead = stalled;
  }

  private isCurrent(work: PreparedAttachment): boolean {
    return !work.item.deleted && !work.attachment.deleted && work.attachment.parentItemID === work.item.id;
  }

  private async prepareAttachment(
    item: ZoteroItem, att: ZoteroItem, provider: EmbeddingProvider, canEmbed: boolean,
    force: boolean, cfg: PluginConfig,
    recordFailure: (message: string) => void,
    recordText: (count: number) => void,
    rebuildIds: ReadonlySet<number> | null,
    externalWorkerBusy: { current: boolean }
  ): Promise<PreparedAttachment | null> {
    if (this.cancelled || this.disposed) return null;
    const { store, searchIndex } = this.deps;
    const strings = getStrings(cfg);
    const title = att.getDisplayTitle?.() || att.key;
    // Recorded before the PDF is read again, so a rebuild that fails or stops before it saves new
    // passages for this attachment is resumed by a later scan instead of being treated as done.
    if (force && store.activeProfile) await store.markRebuildStarted(att.id);
    let sig: Awaited<ReturnType<typeof getAttachmentSignature>>;
    try {
      sig = await this.waitForAttachmentRead(
        getAttachmentSignature(att),
        strings.indexReadTimeout(strings.indexCheckingFile, title, this.readTimeoutMs / 1000),
        this.readTimeoutMs
      );
    } catch (error) {
      if (error instanceof ReadCancelled) return null;
      throw error;
    }
    const previous = await store.getAttachmentState(att.id);
    const chunkingKey = `1:${cfg.chunkSize}:${cfg.chunkOverlap}:${cfg.maxPdfPages}`;
    const sameSource = previous !== null && previous.parentItemID === item.id && previous.attachmentKey === att.key &&
      previous.fileHash === sig.fileHash && previous.mtime === sig.mtime;
    const sameLayout = !force && sameSource && previous.chunkingKey === chunkingKey;
    const model = provider.getModelFingerprint();
    const hasDimension = model !== buildModelFingerprint(provider.engine, provider.model);
    // A failed or cancelled rebuild resumes from its saved position instead of treating old vectors as rebuilt.
    const savedRebuild = force || (rebuildIds !== null && !rebuildIds.has(att.id)) ? null : await store.getRebuildFrom(att.id);
    if (sameLayout && savedRebuild === null && (previous.status === 'no_text' || previous.status === 'missing' ||
        (previous.status === 'indexed' && (!canEmbed || fingerprintMatches(previous.modelFingerprint, model, hasDimension))))) {
      this.emit({ skippedUnchanged: this.progress.skippedUnchanged + 1 });
      return null;
    }

    const existing = searchIndex.getItemChunks(item.id).some((chunk) => chunk.attachmentID === att.id)
      ? (await store.getChunksForItem(item.id)).filter((chunk) => chunk.attachmentID === att.id && chunk.attachmentKey === att.key)
      : [];
    const reuseLayout = sameLayout && savedRebuild !== REBUILD_FROM_EXTRACTION && existing.length > 0 &&
      existing.length === previous.chunkCount;
    // Re-extracted passages may be numbered differently, so a resumed rebuild then starts over.
    const rebuildFrom = force && store.activeProfile ? 0 : savedRebuild === null ? null : reuseLayout ? savedRebuild : 0;
    const state: AttachmentStateRecord = {
      attachmentID: att.id, attachmentKey: att.key, parentItemID: item.id, fileHash: sig.fileHash,
      mtime: sig.mtime, chunkingKey, status: 'indexed', chunkCount: 0, modelFingerprint: '', updatedAt: Date.now(),
    };
    const work: PreparedAttachment = { item, attachment: att, state, remaining: 0, rebuildFrom };
    let chunks = existing;
    if (!reuseLayout) {
      const timedOut = await store.getReadTimeout(att.id);
      const late = this.lateReads.get(att.id);
      this.lateReads.delete(att.id);
      let extracted: PdfExtractionResult;
      if (late && late.fileHash === sig.fileHash && late.mtime === sig.mtime && late.maxPdfPages === cfg.maxPdfPages) {
        extracted = late.result;
      } else {
        // A file version that timed out in several runs would stall every scan, so later scans skip it until
        // it changes or the user indexes the item explicitly. One timeout alone can be a busy PDF worker.
        if (timedOut && !force && timedOut.fileHash === sig.fileHash && timedOut.mtime === sig.mtime &&
            timedOut.strikes >= READ_TIMEOUT_SKIP_STRIKES) {
          recordFailure(strings.indexReadTimeoutSkipped(title));
          return null;
        }
        // Abandoning a timed-out read does not free Zotero's serial PDF worker. Starting another read
        // would only queue behind it and wrongly record a healthy file as timed out.
        if (sig.filePath) {
          if (this.stalledRead) throw new PdfWorkerBusy(strings.indexPdfWorkerBusy(title));
          if (externalWorkerBusy.current) {
            if (this.isPdfWorkerCurrentlyBusy()) throw new PdfWorkerBusy(strings.indexPdfWorkerBusy(title));
            externalWorkerBusy.current = false;
          }
        }
        if (this.cancelled || this.disposed || !this.isCurrent(work)) return null;
        const timeoutMessage = strings.indexReadTimeout(strings.indexReadingPdf, title, this.readTimeoutMs / 1000);
        // Zotero's bootstrap sandbox omits DOM globals like AbortController when MCP is off,
        // so keep read-cancellation state in plain JS instead of depending on global AbortController.
        let readAborted = false;
        let readAbortReason: unknown;
        const abortRead = (reason?: unknown): void => {
          if (readAborted) return;
          readAborted = true;
          readAbortReason = reason ?? new Error('Aborted');
        };
        const readSignal = {
          get aborted() { return readAborted; },
          throwIfAborted() {
            if (readAborted) throw readAbortReason;
          },
        };
        let busyTimeoutError: PdfWorkerQueuedTimeout | null = null;
        let abandonedToStalledRead = false;
        let workerCallInFlight = false;
        let activeTimer: ReturnType<typeof setTimeout> | undefined;
        let rejectForeground!: (error: Error) => void;
        const foregroundTimeout = new Promise<never>((_, reject) => { rejectForeground = reject; });
        const clearActiveTimer = () => {
          if (activeTimer !== undefined) {
            clearTimeout(activeTimer);
            activeTimer = undefined;
          }
        };
        const startWorkerTimeout = (error: AttachmentReadTimeout) => {
          clearActiveTimer();
          activeTimer = setTimeout(() => {
            activeTimer = undefined;
            abandonedToStalledRead = true;
            rejectForeground(error);
          }, this.readTimeoutMs);
        };
        const unsubscribeCancel = this.onCancel(() => {
          if (abandonedToStalledRead) return;
          clearActiveTimer();
          const cancelled = new ReadCancelled();
          abortRead(cancelled);
          rejectForeground(cancelled);
        });
        // Wait for Zotero's serial PDF worker to finish its own jobs before submitting ours, then give
        // our extraction its own full timeout. That way a file that starts after queuing and hangs is
        // still blamed and deferred, while a healthy file never loses its timeout budget to Zotero's queue.
        const read = extractPdfPages(att, cfg.maxPdfPages, sig, {
          signal: readSignal,
          requestFullText: async (maxPages) => {
            if (abandonedToStalledRead) {
              if (this.disposed) {
                abortRead();
                readSignal.throwIfAborted();
              }
              return Zotero.PDFWorker.getFullText(att.id, maxPages, false);
            }
            // Re-check in a loop with a shared wait budget so a Zotero task grabbing the worker in the
            // microtask after waitForPdfWorkerIdle resolves cannot push our submission into pure queuing.
            const waitBudget = { remaining: this.readTimeoutMs };
            const pollMs = Math.min(50, Math.max(5, Math.floor(this.readTimeoutMs / 10)));
            while (this.isPdfWorkerCurrentlyBusy()) {
              const waitResult = await this.waitForPdfWorkerIdle(
                waitBudget,
                pollMs,
                () => !readSignal.aborted && this.isCurrent(work)
              );
              if (waitResult === 'cancelled') {
                abortRead();
                readSignal.throwIfAborted();
              }
              if (waitResult === 'busy_timeout') {
                externalWorkerBusy.current = true;
                busyTimeoutError = new PdfWorkerQueuedTimeout(`${timeoutMessage} ${strings.indexPdfQueuedNote}`);
                abortRead(busyTimeoutError);
                throw busyTimeoutError;
              }
            }
            if (readSignal.aborted || this.cancelled || this.disposed || !this.isCurrent(work)) {
              abortRead();
              readSignal.throwIfAborted();
            }
            workerCallInFlight = true;
            try {
              startWorkerTimeout(new PdfWorkerQueuedTimeout(`${timeoutMessage} ${strings.indexPdfQueuedNote}`));
              return await requestPdfFullText(att.id, maxPages, () => {
                if (!readSignal.aborted && !abandonedToStalledRead) {
                  startWorkerTimeout(new AttachmentReadTimeout(`${timeoutMessage} ${strings.indexPdfTimeoutNote}`));
                }
              });
            } finally {
              workerCallInFlight = false;
              clearActiveTimer();
            }
          },
        });
        try {
          extracted = await Promise.race([read, foregroundTimeout]);
        } catch (error) {
          clearActiveTimer();
          unsubscribeCancel();
          if (busyTimeoutError) throw busyTimeoutError;
          if (error instanceof ReadCancelled || readSignal.aborted) {
            if (workerCallInFlight) {
              this.trackCancelledWorkerRead(read);
            } else {
              void read.catch(() => {});
            }
            return null;
          }
          if (!(error instanceof AttachmentReadTimeout)) throw error;
          // Watch before the write is queued, so a late result always clears the record after it is made.
          this.watchStalledRead(att.id, sig, cfg.maxPdfPages, read);
          if (!(error instanceof PdfWorkerQueuedTimeout) && !this.cancelled && !this.disposed) {
            await store.recordReadTimeout(att.id, sig);
          }
          if (this.cancelled || this.disposed) return null;
          throw error;
        } finally {
          clearActiveTimer();
          unsubscribeCancel();
        }
      }
      if (timedOut) await store.clearReadTimeout(att.id);
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
    work.remaining = canEmbed ? chunks.filter((chunk) => needsEmbedding(work, chunk)).length : 0;
    if (work.remaining) state.status = 'pending';
    // Without an embedding engine the rebuild position is kept, so vectors are rebuilt once it is available.
    // Attachments with no extractable passages have nothing left to re-embed and clear rebuild state immediately.
    const rebuildUpdate = rebuildFrom === null ? undefined : (!chunks.length || (canEmbed && !work.remaining)) ? null : rebuildFrom;
    if (!reuseLayout) {
      const parents = await store.saveAttachmentChunksAndState(chunks, state, 'replace', rebuildUpdate);
      await store.readCommitted(async () => {
        for (const id of new Set([...(parents ?? []), item.id])) {
          searchIndex.replaceItemChunks(id, await store.getChunksForItem(id));
        }
      });
      recordText(chunks.length);
      this.deps.onItemIndexed?.();
    } else if (canEmbed) {
      if (await store.saveAttachmentChunksAndState([], state, 'checkpoint', rebuildUpdate) === null) return null;
    }
    return work.remaining ? work : null;
  }

  private async processItemIds(itemIds: number[], force: boolean, libraryScan = false, automatic = false): Promise<void> {
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
    const allowed = (item: ZoteroItem): boolean => {
      if (!automatic || this.deps.shouldAutoIndex?.(item.libraryID) !== false) return true;
      if (libraryScan && this.activeLibraryScan) this.activeLibraryScan.excludedLibrary = true;
      return false;
    };
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
    const rebuildIds = force ? null : await store.getRebuildProgressAttachmentIDs();
    const externalWorkerBusy = { current: false };

    const prepare = async (item: ZoteroItem, att: ZoteroItem): Promise<PreparedAttachment | null> => {
      this.emit({ totalAttachments: this.progress.totalAttachments + 1 });
      try {
        return await this.prepareAttachment(item, att, provider, canEmbed, force, cfg, recordFailure,
          (count) => { savedChunks += count; }, rebuildIds, externalWorkerBusy);
      } catch (error) {
        // A timed-out or blocked read skips only this attachment. Other attachments still get their
        // vectors, and their PDFs are read once Zotero's PDF worker is free again.
        recordFailure(error instanceof Error ? error.message : String(error));
        if (!(error instanceof AttachmentReadTimeout)) Zotero.logError(error);
        return null;
      } finally {
        this.emit({ processedAttachments: this.progress.processedAttachments + 1 });
      }
    };
    const preparePdfs = async function* (this: BackgroundIndexer) {
      // Attachments whose extraction timed out before go last, so they cannot hold up the rest of the library.
      const timedOutIds = await store.getReadTimeoutAttachmentIDs();
      const deferred: Array<[ZoteroItem, ZoteroItem]> = [];
      for (const itemID of itemIds) {
        if (!(await this.waitIfPaused())) return;
        const item = await Zotero.Items.getAsync(itemID).catch(() => null);
        if (!isIndexableRegularItem(item) || !allowed(item)) continue;
        for (const attachmentID of item.getAttachments?.(false) ?? []) {
          if (!(await this.waitIfPaused())) return;
          const att = await Zotero.Items.getAsync(attachmentID).catch(() => null);
          if (!att || att.deleted || !att.isPDFAttachment()) continue;
          if (timedOutIds.has(att.id)) {
            deferred.push([item, att]);
            continue;
          }
          const work = await prepare(item, att);
          if (work) yield work;
        }
        await yieldToEventLoop(0);
      }
      for (const [item, att] of deferred) {
        if (!(await this.waitIfPaused())) return;
        if (!isIndexableRegularItem(item) || !allowed(item) || att.deleted || att.parentItemID !== item.id) continue;
        const work = await prepare(item, att);
        if (work) yield work;
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
      const inputs = batch.filter(({ item, value }) => allowed(item) && value.canonicalText);
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
        if (item.deleted || !allowed(item) || extractItemMetadata(item).metadataHash !== value.metadataHash) continue;
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
        if (isIndexableRegularItem(item) && allowed(item)) {
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
        const current = batch.splice(0).filter(({ work }) => allowed(work.item) && this.isCurrent(work) && !failed.has(work.attachment.id));
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
          // Each attachment's passages are embedded in index order, so committed rows extend the rebuilt prefix.
          const rebuildFrom = work.rebuildFrom === null ? null
            : Math.max(work.rebuildFrom, ...rows.map((row) => row.chunkIndex + 1));
          const committed = await store.saveAttachmentChunksAndState(rows, {
            ...work.state, status: complete ? 'indexed' : 'pending', updatedAt: Date.now(),
          }, 'checkpoint', complete || rebuildFrom === null ? null : rebuildFrom);
          if (committed === null) continue;
          work.rebuildFrom = rebuildFrom;
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
          .filter((chunk) => chunk.attachmentID === work.attachment.id && needsEmbedding(work, chunk))
          .sort((a, b) => a.chunkIndex - b.chunkIndex);
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
