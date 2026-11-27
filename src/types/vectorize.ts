export type EngineType = 'local-onnx' | 'ollama' | 'openai';
export type SearchMode = 'hybrid' | 'metadata' | 'fulltext';
export type UiLanguage = 'auto' | 'zh-CN' | 'en-US';
export type HfMirrorMode = 'huggingface' | 'hf-mirror';

export interface PluginConfig {
  engine: EngineType;
  // Local ONNX / WASM
  localModelId: string;
  localModelDir: string;
  localMirror: HfMirrorMode;
  localMaxSeqLength: number;
  // Ollama
  ollamaUrl: string;
  ollamaModel: string;
  // OpenAI-compatible
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiDimensions: number;
  openaiBatchSize: number;
  // Indexing & chunking
  chunkSize: number;
  chunkOverlap: number;
  maxPdfPages: number;
  autoIndexOnStartup: boolean;
  autoIndexOnChange: boolean;
  // Search & UI
  defaultSearchMode: SearchMode;
  hybridSemanticWeight: number;
  normalizeNotation: boolean;
  maxResults: number;
  enableTopSearchPopover: boolean;
  popoverMinChars: number;
  commandPaletteShortcut: string;
  clearQuickSearchOnJump: boolean;
  uiLanguage: UiLanguage;
}

export interface ModelPreset {
  id: string;
  engine: EngineType;
  label: string;
  descriptionZh: string;
  descriptionEn: string;
  dimensions: number;
  crossLingual: boolean;
  sizeLabel?: string;
  queryPrefix?: string;
  passagePrefix?: string;
  onnxFile?: string;
  poolingMode?: 'mean' | 'cls';
  maxSeqLength?: number;
}

export interface ExtractedItemMetadata {
  itemID: number;
  itemKey: string;
  libraryID: number;
  itemType: string;
  title: string;
  creators: string;
  year: string;
  publicationTitle: string;
  doi: string;
  url: string;
  tags: string[];
  abstractNote: string;
  dateModified: string;
  canonicalText: string;
  metadataHash: string;
}

export interface PdfPageText {
  pageIndex: number; // 0-based
  pageLabel: string; // 1-based display string
  text: string;
}

export interface DocumentChunk {
  chunkId: string;
  itemID: number;
  itemKey: string;
  attachmentID: number;
  attachmentKey: string;
  attachmentTitle: string;
  chunkIndex: number;
  pageIndex: number;
  pageLabel: string;
  charStart: number;
  charEnd: number;
  text: string;
  snippet: string;
}

export interface IndexedItemRecord {
  itemID: number;
  itemKey: string;
  libraryID: number;
  itemType: string;
  title: string;
  creators: string;
  year: string;
  publicationTitle: string;
  doi: string;
  url: string;
  tags: string[];
  abstractNote: string;
  metadataHash: string;
  vector: Float32Array | null;
  dim: number;
  modelFingerprint: string;
  updatedAt: number;
}

export interface IndexedChunkRecord {
  chunkId: string;
  itemID: number;
  itemKey: string;
  attachmentID: number;
  attachmentKey: string;
  attachmentTitle: string;
  chunkIndex: number;
  pageIndex: number;
  pageLabel: string;
  charStart: number;
  charEnd: number;
  text: string;
  snippet: string;
  vector: Float32Array | null;
  dim: number;
  modelFingerprint: string;
  updatedAt: number;
  sourceFileHash?: string;
}

export interface AttachmentStateRecord {
  attachmentID: number;
  attachmentKey: string;
  parentItemID: number;
  fileHash: string;
  mtime: number;
  chunkingKey: string;
  status: 'indexed' | 'no_text' | 'missing' | 'pending' | 'error';
  chunkCount: number;
  modelFingerprint: string;
  errorMessage?: string;
  updatedAt: number;
}

export interface ChunkHitInfo {
  chunkId: string;
  attachmentID: number;
  attachmentKey: string;
  attachmentTitle: string;
  pageIndex: number;
  pageLabel: string;
  snippet: string;
  text: string;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  highlightRanges: Array<[number, number]>;
  sourceFileHash?: string;
}

export interface SearchHit {
  itemID: number;
  itemKey: string;
  libraryID: number;
  title: string;
  creators: string;
  year: string;
  publicationTitle: string;
  itemType: string;
  tags: string[];
  abstractNote: string;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  matchKind: SearchMode;
  crossLingualMatched: boolean;
  bestChunk?: ChunkHitInfo;
  extraHits: ChunkHitInfo[];
  extraHitsCount: number;
}

export interface SearchDiagnostics {
  query: string;
  mode: SearchMode;
  durationMs: number;
  vectorSearchUsed: boolean;
  lexicalFallbackUsed: boolean;
  mismatchWarning?: string;
  /** The embedding service failed for this query; the stored index itself is intact. */
  engineError?: string;
  engineLabel: string;
  totalIndexedItems: number;
  totalIndexedChunks: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  diagnostics: SearchDiagnostics;
}

export interface EngineHealthStatus {
  engine: EngineType;
  model: string;
  modelFingerprint: string;
  ready: boolean;
  neuralAvailable: boolean;
  dimensions: number;
  needsSetup: boolean;
  statusMessage: string;
  error?: string;
}

export interface IndexProgress {
  phase: 'idle' | 'scanning' | 'indexing' | 'paused' | 'completed' | 'incomplete' | 'error';
  stage?: 'metadata' | 'fulltext';
  totalItems: number;
  processedItems: number;
  totalAttachments: number;
  processedAttachments: number;
  embeddedChunks: number;
  skippedUnchanged: number;
  failedCount: number;
  currentTitle: string;
  message: string;
  lastError?: string;
}

export interface StoreStats {
  indexedItems: number;
  vectorizedItems: number;
  indexedChunks: number;
  vectorizedChunks: number;
  indexedAttachments: number;
  failedAttachments: number;
  pendingAttachments: number;
  missingAttachments: number;
  noTextAttachments: number;
  modelFingerprint: string;
  dimensions: number;
  dbSizeBytes: number;
  lastIndexedAt: number;
}

// Standard 3-file vector store JSON layout (metadata_vectors.json, fulltext_vectors.json, vector_store_metadata.json)
export interface CompatMetadataVectorEntry {
  item_key: string;
  item_id?: number;
  library_id?: number;
  item_type?: string;
  title: string;
  creators?: string;
  year?: string;
  publication_title?: string;
  doi?: string;
  url?: string;
  tags?: string[];
  abstract?: string;
  text: string;
  metadata_hash?: string;
  embedding: number[];
  updated_at?: string;
}

export interface CompatFulltextChunkEntry {
  library_id?: number;
  chunk_id: string;
  item_key: string;
  attachment_key?: string;
  attachment_title?: string;
  chunk_index: number;
  page_index: number;
  page?: number;
  char_start?: number;
  char_end?: number;
  text: string;
  snippet?: string;
  embedding: number[];
}

export interface CompatStoreMetadata {
  schema_version: string;
  source: string;
  engine: EngineType | string;
  model: string;
  model_fingerprint: string;
  embedding_profile_id?: string;
  dimension: number;
  item_count: number;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}
