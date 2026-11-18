import type {
  EngineHealthStatus,
  IndexProgress,
  PluginConfig,
  SearchMode,
  SearchResponse,
  StoreStats,
} from '../types/vectorize.ts';
import type { ZoteroItem } from '../types/zotero.d.ts';
import type { DownloadProgressInfo } from '../engines/local-onnx.ts';
import { LocalOnnxProvider } from '../engines/local-onnx.ts';
import { OllamaEmbeddingProvider } from '../engines/ollama.ts';
import { ProviderManager } from '../engines/factory.ts';
import { VectorSearchIndex } from '../core/search-engine.ts';
import { rotateBackups } from '../core/compat-json.ts';
import { observeConfigChanges, readPluginConfig, writePluginConfig } from './config.ts';
import { VectorStore } from './vector-store.ts';
import { BackgroundIndexer } from './indexer.ts';

export class VectorizeService {
  readonly store: VectorStore;
  readonly searchIndex = new VectorSearchIndex();
  readonly providerManager: ProviderManager;
  readonly indexer: BackgroundIndexer;
  private config: PluginConfig;
  private stopConfigObserver: (() => void) | null = null;
  private queryVectorCache = new Map<string, { fp: string; vec: Float32Array }>();
  private indexUpdateListeners = new Set<() => void>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(options: { rootURI: string; dataDir: string }) {
    this.config = readPluginConfig();
    this.store = new VectorStore(options.dataDir);
    this.providerManager = new ProviderManager({
      dataDir: options.dataDir,
      workerScriptUrl: `${options.rootURI}workers/onnx-worker.js`,
    });
    this.indexer = new BackgroundIndexer({
      getConfig: () => this.getConfig(),
      getProvider: () => this.getProvider(),
      store: this.store,
      searchIndex: this.searchIndex,
      onItemIndexed: () => this.notifyIndexUpdated(),
    });
  }

  subscribeIndexUpdates(cb: () => void): () => void {
    this.indexUpdateListeners.add(cb);
    return () => {
      this.indexUpdateListeners.delete(cb);
    };
  }

  private notifyIndexUpdated(): void {
    for (const cb of this.indexUpdateListeners) {
      try {
        cb();
      } catch {
        // Ignore UI refresh errors
      }
    }
  }

  getConfig(): PluginConfig {
    return this.config;
  }

  updateConfig(partial: Partial<PluginConfig>): PluginConfig {
    this.config = writePluginConfig(partial);
    this.queryVectorCache.clear();
    return this.config;
  }

  async getProvider() {
    return this.providerManager.getProvider(this.config);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await this.store.open();
      await this.store.loadIntoSearchIndex(this.searchIndex);

      this.stopConfigObserver = observeConfigChanges((next) => {
        this.config = next;
        this.queryVectorCache.clear();
      });

      this.indexer.startNotifier();
      this.indexer.scheduleStartupScan(3500);
      this.initialized = true;
      this.notifyIndexUpdated();
    })();

    return this.initPromise;
  }

  async shutdown(): Promise<void> {
    if (this.stopConfigObserver) {
      this.stopConfigObserver();
      this.stopConfigObserver = null;
    }
    await this.indexer.dispose();
    await this.providerManager.dispose();
    await this.store.close();
    this.searchIndex.clear();
    this.queryVectorCache.clear();
    this.initialized = false;
    this.initPromise = null;
  }

  async getEngineStatus(): Promise<EngineHealthStatus> {
    const provider = await this.getProvider();
    return provider.getStatus();
  }

  async testConnection(): Promise<{ ok: boolean; dimensions: number; message: string }> {
    const provider = await this.getProvider();
    return provider.testConnection();
  }

  async detectOllamaModels(): Promise<string[]> {
    const provider = new OllamaEmbeddingProvider({
      baseUrl: this.config.ollamaUrl,
      model: this.config.ollamaModel,
    });
    return provider.listModels();
  }

  async downloadLocalModel(onProgress?: (p: DownloadProgressInfo) => void): Promise<void> {
    const provider = await this.getProvider();
    if (!(provider instanceof LocalOnnxProvider)) {
      throw new Error('Active engine is not Local ONNX');
    }
    await provider.downloadModelAndRuntime(onProgress);
    if (provider === await this.getProvider()) this.indexer.requestModelBackfill(provider);
  }

  private async embedQueryCached(query: string, config: PluginConfig, signal?: AbortSignal): Promise<{
    vec: Float32Array | null;
    fp: string;
    engineLabel: string;
    errorNote?: string;
  }> {
    const provider = await this.providerManager.getProvider(config);
    signal?.throwIfAborted();
    const status = await provider.getStatus();
    signal?.throwIfAborted();
    const engineLabel = status.statusMessage || `${provider.engine} · ${provider.model}`;

    if (!status.neuralAvailable) {
      return {
        vec: null,
        fp: provider.getModelFingerprint(),
        engineLabel,
      };
    }

    const cacheKey = `${provider.engine}:${provider.model}:${query}`;
    const cached = this.queryVectorCache.get(cacheKey);
    if (cached) {
      return { vec: cached.vec, fp: cached.fp, engineLabel };
    }

    try {
      const vec = await provider.embedQuery(query);
      const fp = provider.getModelFingerprint(vec.length);
      if (config === this.config && !signal?.aborted) {
        if (this.queryVectorCache.size >= 64) {
          const firstKey = this.queryVectorCache.keys().next().value;
          if (firstKey !== undefined) this.queryVectorCache.delete(firstKey);
        }
        this.queryVectorCache.set(cacheKey, { fp, vec });
      }
      return { vec, fp, engineLabel };
    } catch (err: any) {
      return {
        vec: null,
        fp: provider.getModelFingerprint(),
        engineLabel,
        errorNote: err?.message || String(err),
      };
    }
  }

  async search(
    query: string,
    options?: {
      mode?: SearchMode;
      filterItemIDs?: Set<number> | null;
      topK?: number;
      signal?: AbortSignal;
    }
  ): Promise<SearchResponse> {
    await this.init();
    const signal = options?.signal;
    signal?.throwIfAborted();
    const clean = (query || '').trim();
    const config = this.config;
    const mode = options?.mode ?? config.defaultSearchMode;
    const topK = options?.topK ?? config.maxResults;
    const { vec, fp, engineLabel, errorNote } = clean && config.hybridSemanticWeight > 0 && this.searchIndex.hasVectors(mode)
      ? await this.embedQueryCached(clean, config, signal)
      : { vec: null, fp: '', engineLabel: 'Lexical', errorNote: undefined };
    const response = await this.searchIndex.searchAsync({
      query: clean,
      queryVector: vec,
      activeModelFingerprint: fp,
      engineLabel,
      mode,
      topK,
      hybridAlpha: config.hybridSemanticWeight,
      normalizeNotation: config.normalizeNotation,
      filterItemIDs: options?.filterItemIDs,
    }, signal);

    if (errorNote && !response.diagnostics.mismatchWarning) {
      response.diagnostics.mismatchWarning = errorNote;
    }
    return response;
  }

  findSimilarItems(itemID: number, topK = 5) {
    return this.searchIndex.findSimilarItems(itemID, { topK, normalizeNotation: this.config.normalizeNotation });
  }

  getIndexProgress(): IndexProgress {
    return this.indexer.getProgress();
  }

  subscribeProgress(cb: (p: IndexProgress) => void): () => void {
    return this.indexer.subscribeProgress(cb);
  }

  async startIndexing(forceRebuild = false): Promise<void> {
    await this.init();
    return this.indexer.startLibraryScan(forceRebuild);
  }

  async indexItems(itemIDs: number[], force = true): Promise<void> {
    await this.init();
    return this.indexer.indexItemOrAttachmentIds(itemIDs, force);
  }

  async clearIndex(): Promise<void> {
    await this.init();
    await this.indexer.cancel();
    await this.store.clearAll();
    this.searchIndex.clear();
    this.queryVectorCache.clear();
    this.notifyIndexUpdated();
  }

  async getStats(activeModel?: Pick<EngineHealthStatus, 'modelFingerprint' | 'dimensions'>): Promise<StoreStats> {
    await this.init();
    return this.store.getStats(activeModel);
  }

  async exportCompatJsonToFolder(folderPath: string): Promise<{ items: number; chunks: number; files: string[] }> {
    await this.init();
    const status = await this.getEngineStatus();
    const stats = await this.store.getStats();
    const bundle = await this.store.exportCompatBundle({
      engine: status.engine,
      model: status.model,
      modelFingerprint: stats.modelFingerprint || status.modelFingerprint,
      dimension: stats.dimensions || status.dimensions,
    });

    await IOUtils.makeDirectory(folderPath, { ignoreExisting: true, createAncestors: true });
    const io = {
      exists: (p: string) => IOUtils.exists(p),
      copy: (s: string, d: string) => IOUtils.copy(s, d),
      remove: (p: string) => IOUtils.remove(p, { ignoreAbsent: true }),
    };

    const metaPath = PathUtils.join(folderPath, 'metadata_vectors.json');
    const fullPath = PathUtils.join(folderPath, 'fulltext_vectors.json');
    const storeMetaPath = PathUtils.join(folderPath, 'vector_store_metadata.json');

    await rotateBackups(io, metaPath, 2);
    await rotateBackups(io, fullPath, 2);
    await rotateBackups(io, storeMetaPath, 2);

    await IOUtils.writeUTF8(metaPath, JSON.stringify(bundle.metadataVectors, null, 2));
    await IOUtils.writeUTF8(fullPath, JSON.stringify(bundle.fulltextVectors, null, 2));
    await IOUtils.writeUTF8(storeMetaPath, JSON.stringify(bundle.storeMetadata, null, 2));

    return {
      items: bundle.metadataVectors.length,
      chunks: bundle.fulltextVectors.length,
      files: [metaPath, fullPath, storeMetaPath],
    };
  }

  async importCompatJsonFromFolder(folderPath: string): Promise<{
    importedItems: number;
    importedChunks: number;
    skippedItems: number;
    skippedChunks: number;
    warnings: string[];
  }> {
    await this.init();
    const metaPath = PathUtils.join(folderPath, 'metadata_vectors.json');
    const fullPath = PathUtils.join(folderPath, 'fulltext_vectors.json');
    const primaryStoreMetaPath = PathUtils.join(folderPath, 'vector_store_metadata.json');
    const legacyStoreMetaPath = PathUtils.join(folderPath, 'store_metadata.json');

    const metadataJson = (await IOUtils.exists(metaPath)) ? await IOUtils.readJSON(metaPath) : [];
    const fulltextJson = (await IOUtils.exists(fullPath)) ? await IOUtils.readJSON(fullPath) : [];
    const storeMetaJson = (await IOUtils.exists(primaryStoreMetaPath))
      ? await IOUtils.readJSON(primaryStoreMetaPath)
      : (await IOUtils.exists(legacyStoreMetaPath))
      ? await IOUtils.readJSON(legacyStoreMetaPath)
      : {};

    // Pre-build O(1) lookup maps across all non-feed libraries
    const byKey = new Map<
      string,
      {
        itemID: number;
        itemKey: string;
        libraryID: number;
        attachmentsByKey: Map<string, number>;
        attachmentsById: Map<number, string>;
      }
    >();
    const byItemId = new Map<
      number,
      {
        itemID: number;
        itemKey: string;
        libraryID: number;
        attachmentsByKey: Map<string, number>;
        attachmentsById: Map<number, string>;
      }
    >();
    const libs = Zotero.Libraries.getAll();
    for (const lib of libs) {
      if (lib.libraryType === 'feed') continue;
      const items = await Zotero.Items.getAll(lib.libraryID, false, false);
      const parentsById = new Map<number, ZoteroItem>();
      for (const it of items) {
        if (!it.deleted && it.isRegularItem?.()) {
          parentsById.set(it.id, it);
          const entry = {
            itemID: it.id,
            itemKey: it.key,
            libraryID: it.libraryID,
            attachmentsByKey: new Map<string, number>(),
            attachmentsById: new Map<number, string>(),
          };
          byKey.set(it.key, entry);
          byItemId.set(it.id, entry);
        }
      }
      for (const it of items) {
        if (!it.deleted && it.isAttachment?.() && typeof it.parentItemID === 'number') {
          const p = parentsById.get(it.parentItemID);
          if (p) {
            const parentEntry = byKey.get(p.key);
            if (parentEntry) {
              parentEntry.attachmentsByKey.set(it.key, it.id);
              parentEntry.attachmentsById.set(it.id, it.key);
            }
          }
        }
      }
    }

    const parsed = await this.store.importCompatBundle(
      { metadataJson, fulltextJson, storeMetaJson },
      (itemKey, fallbackID) => {
        const hit = itemKey ? byKey.get(itemKey) : fallbackID ? byItemId.get(fallbackID) : undefined;
        return hit ? { itemID: hit.itemID, libraryID: hit.libraryID, itemKey: hit.itemKey } : null;
      },
      (attKey, parentID, fallbackAttID) => {
        const parent = byItemId.get(parentID);
        if (!parent) return 0;
        if (attKey && parent.attachmentsByKey.has(attKey)) {
          return { attachmentID: parent.attachmentsByKey.get(attKey)!, attachmentKey: attKey };
        }
        if (fallbackAttID && parent.attachmentsById.has(fallbackAttID)) {
          return {
            attachmentID: fallbackAttID,
            attachmentKey: parent.attachmentsById.get(fallbackAttID),
          };
        }
        return 0;
      }
    );

    await this.store.loadIntoSearchIndex(this.searchIndex);
    this.notifyIndexUpdated();

    return {
      importedItems: parsed.items.length,
      importedChunks: parsed.chunks.length,
      skippedItems: parsed.skippedItems,
      skippedChunks: parsed.skippedChunks,
      warnings: parsed.warnings,
    };
  }
}
