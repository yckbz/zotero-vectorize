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
import type { EmbeddingProvider } from '../engines/provider.ts';
import { VectorSearchIndex } from '../core/search-engine.ts';
import { embeddingSettings, resolveEmbeddingProfile } from './embedding-profile.ts';
import { extractItemMetadata, isIndexableRegularItem } from './extractor.ts';
import { rotateBackups } from '../core/compat-json.ts';
import { observeConfigChanges, readPluginConfig, writePluginConfig } from './config.ts';
import { VectorStore } from './vector-store.ts';
import { BackgroundIndexer } from './indexer.ts';
import { IndexSync } from './index-sync.ts';
import { syncSearchConfig } from './sync-snapshot.ts';

const ENGINE_SETTINGS = [
  'engine', 'localModelId', 'localModelDir', 'localMirror', 'localMaxSeqLength', 'ollamaUrl', 'ollamaModel',
  'openaiBaseUrl', 'openaiApiKey', 'openaiModel', 'openaiDimensions', 'openaiBatchSize',
] as const satisfies readonly (keyof PluginConfig)[];

interface SearchOptions {
  mode?: SearchMode;
  filterItemIDs?: Set<number> | null;
  topK?: number;
  signal?: AbortSignal;
}

export class VectorizeService {
  readonly store: VectorStore;
  readonly searchIndex = new VectorSearchIndex();
  readonly providerManager: ProviderManager;
  readonly indexer: BackgroundIndexer;
  readonly indexSync: IndexSync;
  private config: PluginConfig;
  private stopConfigObserver: (() => void) | null = null;
  private queryVectorCache = new Map<string, { fp: string; vec: Float32Array }>();
  private indexUpdateListeners = new Set<() => void>();
  private initialized = false;
  private maintenance = Promise.resolve();
  private indexGeneration = 0;
  private initPromise: Promise<void> | null = null;

  constructor(options: { rootURI: string; dataDir: string }) {
    this.config = readPluginConfig();
    this.store = new VectorStore(options.dataDir);
    this.providerManager = new ProviderManager({
      dataDir: options.dataDir,
      workerScriptUrl: `${options.rootURI}workers/onnx-worker.js`,
    });
    this.indexSync = new IndexSync({
      store: this.store,
      getConfig: () => this.config,
      getProgress: () => this.indexer.getProgress(),
      createProvider: (config) => this.providerManager.createProvider(config),
      onUpdate: () => {
        this.indexGeneration++;
        this.notifyIndexUpdated();
      },
      onLocalAvailable: () => this.indexer.scheduleStartupScan(100),
    });
    this.indexer = new BackgroundIndexer({
      getConfig: () => this.getConfig(),
      getProvider: () => this.getProvider(),
      store: this.store,
      searchIndex: this.searchIndex,
      shouldAutoIndex: (libraryID) => this.indexSync.shouldAutoIndex(libraryID),
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

  getSearchConfig(): PluginConfig {
    const shared = this.indexSync.active;
    return shared ? syncSearchConfig(shared.manifest, this.config) : this.config;
  }

  updateConfig(partial: Partial<PluginConfig>): PluginConfig {
    const preferences = Object.fromEntries(Object.entries(partial).filter(([key]) =>
      !ENGINE_SETTINGS.some((engineKey) => engineKey === key)
    ));
    const next = writePluginConfig(preferences);
    const engine = Object.fromEntries(ENGINE_SETTINGS.map((key) => [key, this.config[key]]));
    this.config = { ...next, ...engine };
    this.queryVectorCache.clear();
    this.indexSync.onConfigChanged();
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
      const provider = await this.getProvider();
      const profile = await resolveEmbeddingProfile(this.config, provider);
      if (profile) await this.store.activateProfile(profile);
      await this.store.loadIntoSearchIndex(this.searchIndex);

      this.stopConfigObserver = observeConfigChanges((next) => {
        const engine = Object.fromEntries(ENGINE_SETTINGS.map((key) => [key, this.config[key]]));
        this.config = { ...next, ...engine };
        this.queryVectorCache.clear();
        this.indexSync.onConfigChanged();
      });

      this.indexer.startNotifier();
      try {
        this.indexSync.start();
      } catch {
        Zotero.debug?.('Zotero Vectorize could not start optional index sync');
      }
      if (!await this.hasLegacyIndexForActiveModel()) this.indexer.scheduleStartupScan(3500);
      this.initialized = true;
      this.notifyIndexUpdated();
    })();

    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.indexSync.dispose();
    if (this.stopConfigObserver) {
      this.stopConfigObserver();
      this.stopConfigObserver = null;
    }
    await this.maintenance;
    await this.indexer.dispose();
    await this.providerManager.dispose();
    await this.store.close();
    this.searchIndex.clear();
    this.queryVectorCache.clear();
    this.initialized = false;
    this.initPromise = null;
  }

  async getEngineStatus(): Promise<EngineHealthStatus> {
    await this.init();
    await this.maintenance;
    const provider = await this.getProvider();
    return provider.getStatus();
  }

  async getSearchEngineStatus(): Promise<EngineHealthStatus> {
    const shared = this.indexSync.active;
    if (shared) {
      try {
        const status = await shared.provider.getStatus();
        if (status.neuralAvailable) return status;
      } catch { /* The local engine still serves search when the shared provider is unavailable. */ }
    }
    return this.getEngineStatus();
  }

  async testConnection(draft?: PluginConfig): Promise<{ ok: boolean; dimensions: number; message: string }> {
    if (!draft) return (await this.getProvider()).testConnection();
    const provider = this.providerManager.createProvider(draft);
    try {
      return await provider.testConnection();
    } finally {
      await provider.dispose();
    }
  }

  async detectOllamaModels(draft = this.config): Promise<string[]> {
    const provider = new OllamaEmbeddingProvider({ baseUrl: draft.ollamaUrl, model: draft.ollamaModel });
    return provider.listModels();
  }

  async downloadLocalModel(onProgress?: (p: DownloadProgressInfo) => void, draft?: PluginConfig): Promise<void> {
    await this.init();
    const target = draft ?? this.config;
    if (draft && embeddingSettings(draft) !== embeddingSettings(this.config)) {
      const provider = this.providerManager.createProvider(draft);
      try {
        if (!(provider instanceof LocalOnnxProvider)) throw new Error('Active engine is not Local ONNX');
        await provider.downloadModelAndRuntime(onProgress);
      } finally {
        await provider.dispose();
      }
      return;
    }

    await this.withIndexMaintenance(async () => {
      const provider = await this.getProvider();
      if (!(provider instanceof LocalOnnxProvider)) throw new Error('Active engine is not Local ONNX');
      await provider.downloadModelAndRuntime(onProgress);
      const profile = await resolveEmbeddingProfile(target, provider, (await provider.getStatus()).dimensions);
      await this.store.activateProfile(profile);
      await this.reloadIndex();
    });
    this.indexer.requestModelBackfill(await this.getProvider());
    this.indexSync.onConfigChanged();
  }

  private withIndexMaintenance<T>(operation: () => Promise<T>, affectsActiveIndex = () => true): Promise<T> {
    const run = this.maintenance.then(() => {
      if (!affectsActiveIndex()) return operation();
      return this.indexer.withWritesSuspended(async () => {
        this.indexGeneration++;
        return operation();
      });
    });
    this.maintenance = run.then(() => undefined, () => undefined);
    return run;
  }

  private async reloadIndex(): Promise<void> {
    await this.store.loadIntoSearchIndex(this.searchIndex);
    this.queryVectorCache.clear();
    this.notifyIndexUpdated();
  }

  async applyEmbeddingConfig(draft: PluginConfig, discardPrevious: boolean): Promise<void> {
    await this.init();
    const changes = Object.fromEntries(ENGINE_SETTINGS.map((key) => [key, draft[key]])) as Partial<PluginConfig>;
    const provider = this.providerManager.createProvider(draft);
    try {
      const status = await provider.testConnection();
      if (!status.ok) throw new Error(status.message);
      const profile = await resolveEmbeddingProfile(draft, provider, status.dimensions);
      if (!profile) throw new Error('Could not identify the selected embedding model');
      await this.withIndexMaintenance(async () => {
        const previous = this.store.activeProfile?.id;
        const saved = writePluginConfig(changes);
        try {
          if (ENGINE_SETTINGS.some((key) => saved[key] !== draft[key])) throw new Error('Could not save embedding settings');
          await this.store.activateProfile(profile, discardPrevious ? previous : undefined);
        } catch (error) {
          writePluginConfig(this.config);
          throw error;
        }
        this.config = saved;
        await this.providerManager.dispose();
        await this.reloadIndex();
      });
    } finally {
      await provider.dispose();
    }
    this.indexSync.onConfigChanged();
    if (!await this.hasLegacyIndexForActiveModel()) void this.indexer.startLibraryScan(false, true);
  }

  async listEmbeddingProfiles() {
    await this.init();
    await this.maintenance;
    return this.store.listProfiles();
  }

  private async hasLegacyIndexForActiveModel(): Promise<boolean> {
    const profiles = await this.store.listProfiles();
    const active = profiles.find((entry) => entry.active);
    return Boolean(active && !active.items && !active.chunks && profiles.some((entry) =>
      entry.provenance === 'legacy' && entry.engine === active.engine && entry.model === active.model));
  }

  async reuseLegacyIndex(id: string): Promise<void> {
    await this.init();
    await this.withIndexMaintenance(async () => {
      const active = this.store.activeProfile;
      if (!active) throw new Error('Configure the embedding model before reusing its legacy index');
      const provider = await this.getProvider();
      const vector = await provider.embedQuery('semantic search health check');
      await this.store.reuseLegacyProfile(id, active.id, vector.length);
      await this.reloadIndex();
    });
    void this.startIndexing(false);
  }

  async deleteEmbeddingProfile(id: string): Promise<void> {
    await this.init();
    const active = () => this.store.activeProfile?.id === id;
    await this.withIndexMaintenance(async () => {
      await this.store.deleteProfile(id);
      if (active()) await this.reloadIndex();
    }, active);
  }

  private async embedQueryCached(query: string, config: PluginConfig, signal?: AbortSignal, sharedProvider?: EmbeddingProvider): Promise<{
    vec: Float32Array | null;
    fp: string;
    engineLabel: string;
    errorNote?: string;
  }> {
    const provider = sharedProvider ?? await this.providerManager.getProvider(config);
    signal?.throwIfAborted();
    const status = await provider.getStatus();
    signal?.throwIfAborted();
    const engineLabel = status.statusMessage || `${provider.engine} · ${provider.model}`;

    if (!status.neuralAvailable) {
      return {
        vec: null,
        fp: provider.getModelFingerprint(),
        engineLabel,
        ...(sharedProvider ? { errorNote: 'Shared embedding model is unavailable' } : {}),
      };
    }

    const cacheKey = `${provider.engine}:${provider.model}:${query}`;
    const cached = sharedProvider ? undefined : this.queryVectorCache.get(cacheKey);
    if (cached) {
      return { vec: cached.vec, fp: cached.fp, engineLabel };
    }

    try {
      const vec = await provider.embedQuery(query);
      const fp = provider.getModelFingerprint(vec.length);
      if (!sharedProvider && config === this.config && !signal?.aborted) {
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

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    await this.init();
    await this.maintenance;
    const generation = this.indexGeneration;
    options?.signal?.throwIfAborted();
    const clean = (query || '').trim();
    const shared = this.indexSync.active;
    let response: SearchResponse | undefined;
    if (shared) {
      const config = syncSearchConfig(shared.manifest, this.config);
      const scope = options?.filterItemIDs;
      const mode = options?.mode ?? config.defaultSearchMode;
      const sharedIDs = new Set(shared.index.getAllItems().filter((item) => {
        if (scope && !scope.has(item.itemID)) return false;
        const local = this.searchIndex.getItemById(item.itemID);
        if (!local) return true;
        if (mode !== 'fulltext' && local.vector && !item.vector) return false;
        if (mode === 'metadata') return true;
        const sharedPdfs = new Set(shared.index.getItemChunks(item.itemID).map((chunk) => chunk.attachmentID));
        return this.searchIndex.getItemChunks(item.itemID).every((chunk) => sharedPdfs.has(chunk.attachmentID));
      }).map((item) => item.itemID));
      if (sharedIDs.size) {
        const sharedOptions = { ...options, mode,
          topK: options?.topK ?? config.maxResults, filterItemIDs: sharedIDs };
        let remote: SearchResponse | undefined;
        try {
          if (shared.manifest.engine !== 'ollama' || !clean || config.hybridSemanticWeight === 0 || !shared.index.hasVectors(mode) ||
              (await shared.provider.getModelRevision?.(true)) === shared.manifest.revision) {
            remote = await this.searchIndexWithConfig(clean, sharedOptions, shared.index, config, shared.provider);
          }
        } catch {
          options?.signal?.throwIfAborted();
        }
        if (remote && !remote.diagnostics.mismatchWarning) {
          const localIDs = new Set(this.searchIndex.getAllItems().map((item) => item.itemID)
            .filter((id) => !sharedIDs.has(id) && (!scope || scope.has(id))));
          if (localIDs.size) {
            const local = await this.searchIndexWithConfig(clean, { ...sharedOptions, filterItemIDs: localIDs }, this.searchIndex, this.config);
            remote.hits = [...remote.hits, ...local.hits].sort((a, b) =>
              b.score - a.score || b.semanticScore - a.semanticScore || b.lexicalScore - a.lexicalScore).slice(0, sharedOptions.topK);
            remote.diagnostics.vectorSearchUsed ||= local.diagnostics.vectorSearchUsed;
            remote.diagnostics.lexicalFallbackUsed ||= local.diagnostics.lexicalFallbackUsed;
            remote.diagnostics.totalIndexedItems += localIDs.size;
            remote.diagnostics.totalIndexedChunks += this.searchIndex.getAllChunks().filter((chunk) => localIDs.has(chunk.itemID)).length;
          }
          response = remote;
        }
      }
    }
    response ??= await this.searchIndexWithConfig(clean, options, this.searchIndex, this.config);
    return generation === this.indexGeneration ? response : this.search(query, options);
  }

  private async searchIndexWithConfig(
    query: string, options: SearchOptions | undefined, index: VectorSearchIndex, config: PluginConfig, provider?: EmbeddingProvider
  ): Promise<SearchResponse> {
    const mode = options?.mode ?? config.defaultSearchMode;
    const { vec, fp, engineLabel, errorNote } = query && config.hybridSemanticWeight > 0 && index.hasVectors(mode)
      ? await this.embedQueryCached(query, config, options?.signal, provider)
      : { vec: null, fp: '', engineLabel: 'Lexical', errorNote: undefined };
    const response = await index.searchAsync({
      query,
      queryVector: vec,
      activeModelFingerprint: fp,
      engineLabel,
      mode,
      topK: options?.topK ?? config.maxResults,
      hybridAlpha: config.hybridSemanticWeight,
      normalizeNotation: config.normalizeNotation,
      filterItemIDs: options?.filterItemIDs,
    }, options?.signal);
    if (errorNote && !response.diagnostics.mismatchWarning) response.diagnostics.mismatchWarning = errorNote;
    return response;
  }

  findSimilarItems(itemID: number, topK = 5) {
    const shared = this.indexSync.active;
    const sharedItem = shared?.index.getItemById(itemID);
    if (shared && sharedItem && (sharedItem.vector || !this.searchIndex.getItemById(itemID)?.vector)) {
      return shared.index.findSimilarItems(itemID, { topK, normalizeNotation: shared.manifest.normalizeNotation });
    }
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
    await this.maintenance;
    return this.indexer.startLibraryScan(forceRebuild);
  }

  async indexItems(itemIDs: number[], force = true): Promise<void> {
    await this.init();
    await this.maintenance;
    return this.indexer.indexItemOrAttachmentIds(itemIDs, force);
  }

  async clearIndex(): Promise<void> {
    await this.init();
    await this.withIndexMaintenance(async () => {
      await this.store.clearAll();
      await this.reloadIndex();
    });
  }

  async getStats(activeModel?: Pick<EngineHealthStatus, 'modelFingerprint' | 'dimensions'>): Promise<StoreStats> {
    await this.init();
    await this.maintenance;
    return this.store.getStats(activeModel);
  }

  async getSearchCoverage(): Promise<Pick<StoreStats, 'indexedItems' | 'indexedChunks'>> {
    await this.init();
    const shared = this.indexSync.active?.index;
    return shared ? {
      indexedItems: shared.getItemCount() + this.searchIndex.getAllItems().filter((item) => !shared.getItemById(item.itemID)).length,
      indexedChunks: shared.getChunkCount() + this.searchIndex.getAllChunks().filter((chunk) => !shared.getItemById(chunk.itemID)).length,
    } : this.getStats();
  }

  async exportCompatJsonToFolder(folderPath: string, profileID?: string): Promise<{ items: number; chunks: number; files: string[] }> {
    await this.init();
    const bundle = await this.store.readCommitted(async () => {
      const profiles = await this.store.listProfiles();
      const profile = profiles.find((entry) => profileID ? entry.id === profileID : entry.active);
      if (!profile || !(profile.items || profile.chunks)) throw new Error('The selected model index has no vectors');
      return this.store.exportCompatBundle(profile);
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

    const [hasMetadata, hasFulltext] = await Promise.all([IOUtils.exists(metaPath), IOUtils.exists(fullPath)]);
    if (!hasMetadata && !hasFulltext) throw new Error('No vector JSON files were found in the selected folder');
    const metadataJson = hasMetadata ? await IOUtils.readJSON(metaPath) : [];
    const fulltextJson = hasFulltext ? await IOUtils.readJSON(fullPath) : [];
    const storeMetaJson = (await IOUtils.exists(primaryStoreMetaPath))
      ? await IOUtils.readJSON(primaryStoreMetaPath)
      : (await IOUtils.exists(legacyStoreMetaPath))
      ? await IOUtils.readJSON(legacyStoreMetaPath)
      : {};

    const libraryItems = await this.getLibraryItems();
    const byID = new Map(libraryItems.map((item) => [item.id, item]));
    const byKey = new Map<string, ZoteroItem[]>();
    for (const item of libraryItems) {
      if (!isIndexableRegularItem(item)) continue;
      const matches = byKey.get(item.key) ?? [];
      matches.push(item);
      byKey.set(item.key, matches);
    }
    const parsed = await this.withIndexMaintenance(async () => {
      const result = await this.store.importCompatBundle(
        { metadataJson, fulltextJson, storeMetaJson },
        (itemKey, id, libraryID) => {
          const candidates = itemKey ? (byKey.get(itemKey) ?? []) : [id ? byID.get(id) : undefined];
          const matches = candidates.filter((item): item is ZoteroItem =>
            isIndexableRegularItem(item) && (!libraryID || item.libraryID === libraryID)
          );
          if (matches.length !== 1) return null;
          const item = matches[0];
          return { itemID: item.id, libraryID: item.libraryID, itemKey: item.key, metadataHash: extractItemMetadata(item).metadataHash };
        },
        (key, parentID, id) => {
          const parent = byID.get(parentID);
          if (!parent) return 0;
          const attachments = (parent.getAttachments?.(false) ?? []).map((attachmentID) => byID.get(attachmentID))
            .filter((item): item is ZoteroItem => Boolean(item?.isPDFAttachment?.() && item.parentItemID === parentID));
          const match = key ? attachments.find((item) => item.key === key || item.attachmentFilename === key)
            : attachments.find((item) => item.id === id);
          const resolved = match ?? (!key && !id && attachments.length === 1 ? attachments[0] : undefined);
          return resolved ? { attachmentID: resolved.id, attachmentKey: resolved.key } : 0;
        }
      );
      await this.reloadIndex();
      return result;
    });

    return {
      importedItems: parsed.importedItems,
      importedChunks: parsed.importedChunks,
      skippedItems: parsed.skippedItems,
      skippedChunks: parsed.skippedChunks,
      warnings: parsed.warnings,
    };
  }

  private async getLibraryItems(): Promise<ZoteroItem[]> {
    const items: ZoteroItem[] = [];
    for (const library of Zotero.Libraries.getAll()) {
      if (library.libraryType !== 'feed') {
        items.push(...(await Zotero.Items.getAll(library.libraryID, false, false)).filter((item) => !item.deleted));
      }
    }
    return items;
  }

  async exportNativeIndex(path: string): Promise<void> {
    await this.init();
    await this.store.exportSnapshot(path);
  }

  async restoreNativeIndex(path: string): Promise<void> {
    await this.init();
    await this.withIndexMaintenance(async () => {
      const byID = new Map((await this.getLibraryItems()).map((item) => [item.id, item]));
      await this.store.restoreSnapshot(path, (items, attachments) => {
        let matches = 0;
        for (const row of items) {
          const item = byID.get(row.item_id);
          if (!item) continue;
          if (!isIndexableRegularItem(item) || item.key !== row.item_key || item.libraryID !== row.library_id) {
            throw new Error('Snapshot Zotero item IDs do not match this library');
          }
          matches++;
        }
        for (const row of attachments) {
          const item = byID.get(row.attachment_id);
          if (!item) continue;
          if (!item.isPDFAttachment() || item.key !== row.attachment_key || item.parentItemID !== row.parent_item_id) {
            throw new Error('Snapshot Zotero attachment IDs do not match this library');
          }
          matches++;
        }
        if ((items.length || attachments.length) && !matches) {
          throw new Error('Snapshot contains no items from this Zotero library');
        }
      });
      await this.reloadIndex();
    });
    if (!await this.hasLegacyIndexForActiveModel()) void this.startIndexing(false);
  }

}
