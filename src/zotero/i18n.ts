import type { PluginConfig } from '../types/vectorize.ts';
import { resolveUiLocale } from './config.ts';

export type LocaleStrings = {
  brandTitle: string;
  brandSubtitle: string;
  modeHybrid: string;
  modeMetadata: string;
  modeFulltext: string;
  scopeAll: string;
  scopeCollection: string;
  crossLingualBadge: string;
  lexicalFallbackTag: string;
  neuralReadyTag: string;
  pageLabel: (page: string) => string;
  moreMatches: (n: number) => string;
  matchScore: (pct: number) => string;
  noResultsTitle: string;
  noResultsDesc: string;
  searching: string;
  searchFailed: string;
  emptyIndexTitle: string;
  emptyIndexDesc: string;
  setupBannerCta: string;
  setupBannerHint: string;
  openSettings: string;
  openPalette: string;
  buildIndexNow: string;
  pauseIndex: string;
  resumeIndex: string;
  rebuildIndex: string;
  clearIndex: string;
  indexCheckingFile: string;
  indexReadingPdf: string;
  indexEmbeddingPdf: (completed: number, total: number) => string;
  indexReadTimeout: (stage: string, title: string, seconds: number) => string;
  indexTextDone: (items: number, chunks: number) => string;
  indexVectorDone: (items: number, chunks: number) => string;
  indexIncomplete: (items: number, failures: number, error: string) => string;
  indexAttachmentIssues: (unfinished: number, missing: number, noText: number) => string;
  palettePlaceholder: string;
  paletteTitle: string;
  paletteEmptyHint: string;
  footerNavigateHint: string;
  footerIdleHint: string;
  jumpToPdf: string;
  selectInLibrary: string;
  similarPapersHeader: string;
  similarPapersEmpty: string;
  similarPapersLoading: string;
  // Preferences
  prefStatusCardTitle: string;
  prefEngineSectionTitle: string;
  prefIndexingSectionTitle: string;
  prefCompatSectionTitle: string;
  prefUiSectionTitle: string;
  prefItemsIndexed: string;
  prefChunksIndexed: string;
  prefItemVectorRatio: string;
  prefChunkVectorRatio: string;
  prefDbSize: string;
  prefActiveModel: string;
  prefEngineLabel: string;
  prefEngineLocal: string;
  prefEngineOllama: string;
  prefEngineOpenai: string;
  prefLocalModelPreset: string;
  prefLocalCustomDir: string;
  prefLocalBrowseDir: string;
  prefLocalMirror: string;
  prefDownloadModel: string;
  prefTestConnection: string;
  prefOllamaUrl: string;
  prefOllamaModel: string;
  prefOllamaRefresh: string;
  prefOpenaiBaseUrl: string;
  prefOpenaiApiKey: string;
  prefOpenaiModel: string;
  prefOpenaiDimensions: string;
  prefOpenaiBatchSize: string;
  prefChunkSize: string;
  prefChunkOverlap: string;
  prefMaxPdfPages: string;
  prefAutoStartup: string;
  prefAutoChange: string;
  prefDefaultMode: string;
  prefEnablePopover: string;
  prefSemanticWeight: string;
  prefNormalizeNotation: string;
  prefClearOnJump: string;
  prefLanguage: string;
  prefExportJson: string;
  prefImportJson: string;
  prefCompatHint: string;
  prefPrivacyBadge: string;
  prefMsgCleared: string;
  prefMsgModelReady: (modelId: string) => string;
  prefMsgExported: (items: number, chunks: number, dir: string) => string;
  prefMsgImported: (items: number, chunks: number, skippedItems: number, skippedChunks: number) => string;
  prefMsgOllamaModels: (models: string) => string;
  prefMsgOllamaEmpty: string;
  prefMsgInitializing: string;
  prefMsgWorking: string;
};

const ZH_CN: LocaleStrings = {
  brandTitle: 'Zotero Vectorize',
  brandSubtitle: '语义与全文瞬时召回',
  modeHybrid: '混合',
  modeMetadata: '元数据',
  modeFulltext: '全文段落',
  scopeAll: '全部文献',
  scopeCollection: '当前分类',
  crossLingualBadge: '跨语言',
  lexicalFallbackTag: '词法降级',
  neuralReadyTag: '语义向量',
  pageLabel: (p) => `第 ${p} 页`,
  moreMatches: (n) => `+${n} 处命中`,
  matchScore: (pct) => `${pct}%`,
  noResultsTitle: '未找到高相关文献',
  noResultsDesc: '尝试切换「混合/全文」模式，或在设置中完成全库向量索引。',
  searching: '正在检索文献…',
  searchFailed: '检索失败',
  emptyIndexTitle: '尚未建立文献向量索引',
  emptyIndexDesc: '点击下方按钮在后台静默索引您的文献库与 PDF 全文，不修改 Zotero 原库。',
  setupBannerCta: '下载本地语义模型',
  setupBannerHint: '当前使用关键词检索。安装本地 ONNX 模型可启用跨语言语义检索。',
  openSettings: '插件设置',
  openPalette: '命令面板',
  buildIndexNow: '立即增量索引',
  pauseIndex: '暂停索引',
  resumeIndex: '继续索引',
  indexCheckingFile: '正在检查附件',
  indexReadingPdf: '正在抽取 PDF 正文',
  indexEmbeddingPdf: (completed, total) => `正在向量化 PDF 分块 ${completed}/${total}`,
  indexTextDone: (items, chunks) => `文本索引完成。本轮处理 ${items} 篇文献、保存 ${chunks} 个分块，未生成向量。`,
  indexVectorDone: (items, chunks) => `向量索引扫描完成。本轮处理 ${items} 篇文献、生成 ${chunks} 个正文向量。`,
  indexIncomplete: (items, failures, error) => `索引未完成。本轮检查 ${items} 篇文献，${failures} 项失败。首个错误：${error}`,
  indexAttachmentIssues: (unfinished, missing, noText) => `待完成附件 ${unfinished} · 缺失 PDF ${missing} · 无可提取文本 ${noText}`,
  indexReadTimeout: (stage, title, seconds) => `${stage}，${title} 在 ${seconds} 秒内未响应，本轮索引已停止。`,
  rebuildIndex: '全量重建索引',
  clearIndex: '清空向量库',
  palettePlaceholder: '输入中文概念、模糊印象或英文关键词，搜索标题、摘要与 PDF 原文段落…',
  paletteTitle: '语义检索命令面板',
  paletteEmptyHint: '支持跨语言搜索（如输入「注意力机制稀疏化」定位英文论文具体页码）',
  footerNavigateHint: '↑↓ 选择 · Enter 跳转 PDF 页码 · Tab 切换模式 · Esc 关闭',
  footerIdleHint: '↓ 选择语义候选 · Enter 原生检索 · ⌘K 命令面板 · Esc 关闭',
  jumpToPdf: '跳转到 PDF 页面',
  selectInLibrary: '在文献库中定位',
  similarPapersHeader: '语义相似文献',
  similarPapersEmpty: '暂无足够相似度高的文献或尚未完成索引',
  similarPapersLoading: '正在计算语义相似度…',
  prefStatusCardTitle: '向量索引状态与控制',
  prefEngineSectionTitle: 'Embedding 向量引擎',
  prefIndexingSectionTitle: '文档切片与自动后台索引',
  prefCompatSectionTitle: '标准向量 JSON 兼容导入与导出',
  prefUiSectionTitle: '检索交互与外观',
  prefItemsIndexed: '已索引文献',
  prefItemVectorRatio: '文献已向量化 / 已收录',
  prefChunkVectorRatio: '分块已向量化 / 已提取',
  prefChunksIndexed: '全文切片段落',
  prefDbSize: '独立索引体积',
  prefActiveModel: '当前模型签名',
  prefEngineLabel: '向量化引擎',
  prefEngineLocal: '内置本地 ONNX / WASM（推荐 · 离线可用）',
  prefEngineOllama: 'Ollama 本地服务（bge-m3 / qwen3-embedding 等）',
  prefEngineOpenai: 'OpenAI 兼容 API（OpenAI / SiliconFlow / 硅基流动等）',
  prefLocalModelPreset: '预设模型',
  prefLocalCustomDir: '本地模型目录（可选，留空自动下载）',
  prefLocalBrowseDir: '选择目录…',
  prefLocalMirror: '模型下载源',
  prefDownloadModel: '下载 / 校验本地模型',
  prefTestConnection: '测试引擎连通性',
  prefOllamaUrl: 'Ollama 服务地址',
  prefOllamaModel: 'Embedding 模型名',
  prefOllamaRefresh: '检测本地模型',
  prefOpenaiBaseUrl: 'API Base URL',
  prefOpenaiApiKey: 'API Key',
  prefOpenaiModel: '模型名称',
  prefOpenaiDimensions: '输出维度（0 表示模型默认）',
  prefOpenaiBatchSize: '每批输入条数（0 表示自动测试）',
  prefChunkSize: '段落切片长度（字符）',
  prefChunkOverlap: '切片重叠长度（字符）',
  prefMaxPdfPages: '单篇最大解析页数（0 为不限）',
  prefAutoStartup: '启动后后台自动补充索引',
  prefAutoChange: '新增或修改文献/PDF 后静默自动向量化',
  prefDefaultMode: '默认检索范围',
  prefEnablePopover: '在顶部检索框输入时自动弹出语义候选浮层',
  prefSemanticWeight: '语义向量权重（0 = 纯词法，1 = 纯向量）',
  prefNormalizeNotation: '允许普通数字匹配上下标数字',
  prefClearOnJump: '点击候选跳转到 PDF 后自动清空顶部检索框',
  prefLanguage: '界面语言',
  prefExportJson: '导出三文件向量 JSON…',
  prefImportJson: '导入三文件向量 JSON…',
  prefCompatHint: '导入/导出标准三文件向量 JSON 格式（metadata_vectors.json / fulltext_vectors.json / vector_store_metadata.json），所有索引与向量独立存储，绝不修改 zotero.sqlite。',
  prefPrivacyBadge: '独立存储：vectorize.sqlite · 原库零写入风险',
  prefMsgCleared: '向量索引已清空。',
  prefMsgModelReady: (m) => `本地 ONNX 模型已就绪：${m}`,
  prefMsgExported: (i, c, dir) => `已导出 ${i} 篇文献与 ${c} 个全文段落至 ${dir}`,
  prefMsgImported: (i, c, si, sc) => `已导入 ${i} 篇文献、${c} 个段落（跳过 ${si} 篇文献、${sc} 个段落）。`,
  prefMsgOllamaModels: (models) => `检测到 Ollama 模型：${models}`,
  prefMsgOllamaEmpty: 'Ollama 服务可连接，但未检测到可用模型。',
  prefMsgInitializing: 'Zotero Vectorize 服务正在初始化…',
  prefMsgWorking: '正在处理…',
};

const EN_US: LocaleStrings = {
  brandTitle: 'Zotero Vectorize',
  brandSubtitle: 'Semantic & Fulltext Recall',
  modeHybrid: 'Hybrid',
  modeMetadata: 'Metadata',
  modeFulltext: 'Fulltext',
  scopeAll: 'All Library',
  scopeCollection: 'Collection',
  crossLingualBadge: 'Cross-lingual',
  lexicalFallbackTag: 'Lexical',
  neuralReadyTag: 'Neural',
  pageLabel: (p) => `p.${p}`,
  moreMatches: (n) => `+${n} hits`,
  matchScore: (pct) => `${pct}%`,
  noResultsTitle: 'No strong matches found',
  noResultsDesc: 'Try switching to Hybrid/Fulltext or build your vector index in Settings.',
  searching: 'Searching the library…',
  searchFailed: 'Search failed',
  emptyIndexTitle: 'Vector index is empty',
  emptyIndexDesc: 'Start silent background indexing to vectorize metadata and PDF passages without touching zotero.sqlite.',
  setupBannerCta: 'Download Local ONNX Model',
  setupBannerHint: 'Keyword search is available. Install a local ONNX model for cross-language semantic search.',
  openSettings: 'Settings',
  openPalette: 'Command Palette',
  buildIndexNow: 'Index Missing / Changed',
  pauseIndex: 'Pause',
  resumeIndex: 'Resume',
  indexCheckingFile: 'Checking attachment',
  indexReadingPdf: 'Extracting PDF text',
  indexEmbeddingPdf: (completed, total) => `Embedding PDF passages ${completed}/${total}`,
  indexTextDone: (items, chunks) => `Text indexing completed. Processed ${items} items, saved ${chunks} passages, and generated no vectors in this scan.`,
  indexVectorDone: (items, chunks) => `Vector indexing scan completed. Processed ${items} items and generated ${chunks} passage vectors.`,
  indexIncomplete: (items, failures, error) => `Indexing incomplete. Checked ${items} items with ${failures} failures. First error: ${error}`,
  indexAttachmentIssues: (unfinished, missing, noText) => `${unfinished} unfinished attachments · ${missing} missing PDFs · ${noText} without extractable text`,
  indexReadTimeout: (stage, title, seconds) => `${stage}. ${title} did not respond within ${seconds} seconds. Indexing stopped.`,
  rebuildIndex: 'Rebuild All',
  clearIndex: 'Clear Index',
  palettePlaceholder: 'Describe a concept in Chinese or English, fuzzy title, or PDF passage…',
  paletteTitle: 'Semantic Search Command Palette',
  paletteEmptyHint: 'Cross-lingual & fuzzy recall enabled — jump directly to exact PDF pages',
  footerNavigateHint: '↑↓ Select · Enter Jump to PDF · Tab Mode · Esc Close',
  footerIdleHint: '↓ Select candidate · Enter Native search · ⌘K Palette · Esc Close',
  jumpToPdf: 'Jump to PDF Page',
  selectInLibrary: 'Show in Library',
  similarPapersHeader: 'Semantically Similar Papers',
  similarPapersEmpty: 'No similar papers indexed yet',
  similarPapersLoading: 'Computing semantic neighbors…',
  prefStatusCardTitle: 'Vector Index Status & Controls',
  prefEngineSectionTitle: 'Embedding Engine',
  prefIndexingSectionTitle: 'Chunking & Silent Background Indexing',
  prefCompatSectionTitle: 'Standard 3-File Vector JSON Import / Export',
  prefUiSectionTitle: 'Search UX & Appearance',
  prefItemsIndexed: 'Indexed Items',
  prefItemVectorRatio: 'Items with vectors / indexed',
  prefChunkVectorRatio: 'Passages with vectors / extracted',
  prefChunksIndexed: 'Fulltext Chunks',
  prefDbSize: 'Isolated Store Size',
  prefActiveModel: 'Model Fingerprint',
  prefEngineLabel: 'Embedding Provider',
  prefEngineLocal: 'Built-in Local ONNX / WASM (Recommended · Offline)',
  prefEngineOllama: 'Ollama Local Server (bge-m3 / qwen3-embedding)',
  prefEngineOpenai: 'OpenAI-Compatible API (OpenAI / SiliconFlow / etc.)',
  prefLocalModelPreset: 'Preset Model',
  prefLocalCustomDir: 'Custom Local Model Directory (optional)',
  prefLocalBrowseDir: 'Browse…',
  prefLocalMirror: 'Download Mirror',
  prefDownloadModel: 'Download / Verify Model',
  prefTestConnection: 'Test Connection',
  prefOllamaUrl: 'Ollama Base URL',
  prefOllamaModel: 'Embedding Model',
  prefOllamaRefresh: 'Detect Models',
  prefOpenaiBaseUrl: 'API Base URL',
  prefOpenaiApiKey: 'API Key',
  prefOpenaiModel: 'Model Name',
  prefOpenaiDimensions: 'Dimensions (0 = model default)',
  prefOpenaiBatchSize: 'Inputs per batch (0 = auto-test)',
  prefChunkSize: 'Chunk Size (chars)',
  prefChunkOverlap: 'Chunk Overlap (chars)',
  prefMaxPdfPages: 'Max PDF Pages per File (0 = unlimited)',
  prefAutoStartup: 'Incremental catch-up scan on Zotero startup',
  prefAutoChange: 'Silently vectorize added or modified items/PDFs',
  prefDefaultMode: 'Default Search Mode',
  prefEnablePopover: 'Auto-open semantic popover under top search bar',
  prefSemanticWeight: 'Semantic Weight (0 = lexical, 1 = dense vector)',
  prefNormalizeNotation: 'Match plain digits to superscript and subscript digits',
  prefClearOnJump: 'Clear top search bar after jumping to a PDF page',
  prefLanguage: 'UI Language',
  prefExportJson: 'Export 3-File Vector JSON…',
  prefImportJson: 'Import 3-File Vector JSON…',
  prefCompatHint: 'Exports and imports the standard 3-file vector JSON format (metadata_vectors.json, fulltext_vectors.json, vector_store_metadata.json). Isolated storage — never writes to zotero.sqlite.',
  prefPrivacyBadge: 'Isolated store: vectorize.sqlite · Zero risk to zotero.sqlite',
  prefMsgCleared: 'Vector index cleared.',
  prefMsgModelReady: (m) => `Local ONNX model ready: ${m}`,
  prefMsgExported: (i, c, dir) => `Exported ${i} items and ${c} chunks to ${dir}`,
  prefMsgImported: (i, c, si, sc) => `Imported ${i} items, ${c} chunks (skipped ${si} items, ${sc} chunks).`,
  prefMsgOllamaModels: (models) => `Detected Ollama models: ${models}`,
  prefMsgOllamaEmpty: 'Ollama reachable, 0 models found.',
  prefMsgInitializing: 'Zotero Vectorize service is initializing…',
  prefMsgWorking: 'Working…',
};

export function getStrings(config?: PluginConfig): LocaleStrings {
  return resolveUiLocale(config) === 'zh-CN' ? ZH_CN : EN_US;
}
