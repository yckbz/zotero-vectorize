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
  prefCancel: string;
  prefApplyModel: string;
  prefKeepModel: string;
  prefDiscardModel: string;
  prefModelApplied: string;
  prefIndexManager: string;
  prefIndexManagerHint: string;
  prefNoModelIndexes: string;
  prefActiveIndex: string;
  prefLegacyIndex: string;
  prefSavedIndex: string;
  prefDeleteModelIndex: string;
  prefIndexChanged: string;
  prefReuseLegacy: string;
  prefReuseLegacyHint: string;
  prefIndexImport: string;
  prefIndexExport: string;
  prefIndexFormatJson: string;
  prefIndexFormatNative: string;
  prefSelectExportModel: string;
  prefRestoreNative: string;
  prefRestoreNativeHint: string;
  prefNativeRestored: string;
  prefNativeExported: string;
  prefClearAllHint: string;
  prefSwitchModelHint: (model: string) => string;
  prefDeleteModelHint: (model: string) => string;
  prefModelCoverage: (items: number, allItems: number, chunks: number, allChunks: number) => string;
  prefIndexStage: (stage: string, items: number, total: number, pdfs: number, chunks: number) => string;
  indexingMetadata: string;
  indexingFulltext: string;
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
  prefSharedIndexTitle: string;
  prefSharedItems: string;
  prefSharedChunks: string;
  prefSharedPublishedAt: string;
  prefSharedReady: string;
  prefSharedChecking: string;
  prefSharedCached: string;
  prefIndexReadError: (detail: string) => string;
  prefEngineSectionTitle: string;
  prefIndexingSectionTitle: string;
  prefUiSectionTitle: string;
  prefMcpTitle: string;
  prefMcpHint: string;
  prefMcpEnable: string;
  prefMcpCopy: string;
  prefMcpCopied: string;
  prefMcpStartError: string;
  prefMcpCopyError: string;
  prefIndexSyncTitle: string;
  prefIndexSyncHint: string;
  prefIndexSyncRole: { off: string; publish: string; receive: string };
  prefIndexSyncAdvanced: string;
  prefIndexSyncPartSize: string;
  prefIndexSyncState: Record<'off' | 'waiting' | 'working' | 'ready' | 'webdav' | 'model' | 'cloud' | 'conflict' | 'error', string>;
  prefIndexSyncNow: string;
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
  prefCancel: '取消',
  prefApplyModel: '应用模型设置',
  prefKeepModel: '保留旧模型索引',
  prefDiscardModel: '删除旧模型索引',
  prefModelApplied: '已应用模型设置，正在检查索引。',
  prefIndexManager: '向量索引管理',
  prefIndexManagerHint: '各模型共用题录和 PDF 切片。原生 SQLite 快照包含完整的插件索引。',
  prefNoModelIndexes: '暂无已保存的模型索引。',
  prefActiveIndex: '当前模型',
  prefLegacyIndex: '旧版或外部导入',
  prefSavedIndex: '已保留',
  prefDeleteModelIndex: '删除向量',
  prefIndexChanged: '索引已更新。',
  prefReuseLegacy: '用作当前模型索引',
  prefReuseLegacyHint: '仅在确认旧向量由相同模型文件、推理设置或相同 API 端点及模型版本生成时继续。已有的当前模型向量会保留。',
  prefIndexImport: '导入索引…',
  prefIndexExport: '导出索引…',
  prefIndexFormatJson: '三文件向量 JSON',
  prefIndexFormatNative: '原生 SQLite 向量库',
  prefSelectExportModel: '选择要导出的模型索引',
  prefRestoreNative: '恢复索引',
  prefRestoreNativeHint: '恢复将替换插件中的所有模型索引和全文缓存。',
  prefNativeRestored: '已恢复 SQLite 向量库，正在检查文献变更。',
  prefNativeExported: '已导出 SQLite 向量库。',
  prefClearAllHint: '这会删除本机索引中的全部模型向量和全文缓存。',
  prefSwitchModelHint: (model) => `是否保留 ${model} 的向量？`,
  prefDeleteModelHint: (model) => `删除 ${model} 的题录和全文向量。共享的题录与 PDF 切片会保留。`,
  prefModelCoverage: (i, ni, c, nc) => `题录 ${i}/${ni} · 全文 ${c}/${nc}`,
  prefIndexStage: (stage, i, n, p, c) => `${stage} · 已检查题录 ${i}/${n} · 已检查 PDF ${p} · 已向量化分块 ${c}`,
  indexingMetadata: '正在索引题录',
  indexingFulltext: '正在索引 PDF 全文',
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
  prefStatusCardTitle: '本机向量索引状态与控制',
  prefSharedIndexTitle: '共享索引 · 我的文库',
  prefSharedItems: '文献已向量化 / 已载入',
  prefSharedChunks: '分块已向量化 / 已载入',
  prefSharedPublishedAt: '快照发布时间',
  prefSharedReady: '共享索引已载入。',
  prefSharedChecking: '正在检查更新，继续使用当前已载入的版本。',
  prefSharedCached: '正在使用上次同步的版本。',
  prefIndexReadError: (detail) => `无法读取本机向量索引。请确认插件版本与索引匹配。 ${detail}`,
  prefEngineSectionTitle: 'Embedding 向量引擎',
  prefIndexingSectionTitle: '文档切片与自动后台索引',
  prefUiSectionTitle: '检索交互与外观',
  prefMcpTitle: 'Agent 接入（MCP）',
  prefMcpHint: '允许同一台电脑上的 Agent 只读检索「我的文库」和读取 PDF 指定页。连接时请保持 Zotero 运行。',
  prefMcpEnable: '启用本机 MCP',
  prefMcpCopy: '复制 Codex 配置',
  prefMcpCopied: '已复制 Codex 配置。',
  prefMcpStartError: '无法启动 MCP。请检查 Zotero 版本和本机端口占用。',
  prefMcpCopyError: '无法复制 Codex 配置。',
  prefIndexSyncTitle: '通过 Zotero 同步向量索引',
  prefIndexSyncHint: '使用「我的文库」已有的 WebDAV。只在一台设备选发布，其它设备选接收。索引附件含提取的 PDF 正文与模型参数，凭据保存在本机。',
  prefIndexSyncRole: { off: '关闭', publish: '发布本机索引', receive: '接收共享索引' },
  prefIndexSyncAdvanced: '高级设置',
  prefIndexSyncPartSize: '分片大小上限',
  prefIndexSyncState: {
    off: '使用本地索引。',
    waiting: '等待 Zotero 同步或主设备完成向量化。',
    working: '正在检查共享索引。',
    ready: '索引已同步。',
    webdav: 'Zotero WebDAV 当前不可用。仍可使用本机已有索引。',
    model: '需要已校验的同版本 ONNX 或 Ollama 模型。',
    cloud: '请核对两端的 Base URL、模型和输出维度，并在本机填写有效的 API Key。',
    conflict: '检测到多个发布者或附件冲突。请先在 Zotero 中检查共享索引附件。',
    error: '共享索引更新失败。仍可使用本机已有索引。',
  },
  prefIndexSyncNow: '立即检查同步',
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
  prefPrivacyBadge: '本地索引保存在独立的 vectorize.sqlite 中',
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
  prefCancel: 'Cancel',
  prefApplyModel: 'Apply Model Settings',
  prefKeepModel: 'Keep Previous Index',
  prefDiscardModel: 'Discard Previous Index',
  prefModelApplied: 'Model settings applied. Checking the index.',
  prefIndexManager: 'Vector Indexes',
  prefIndexManagerHint: 'Models share metadata and PDF passages. A SQLite snapshot contains the entire plugin index.',
  prefNoModelIndexes: 'No saved model indexes.',
  prefActiveIndex: 'Active',
  prefLegacyIndex: 'Legacy or imported',
  prefSavedIndex: 'Saved',
  prefDeleteModelIndex: 'Delete Vectors',
  prefIndexChanged: 'Index updated.',
  prefReuseLegacy: 'Reuse for Active Model',
  prefReuseLegacyHint: 'Continue only if the original model files and settings, or the API endpoint and model revision, match the active model. Existing active vectors will be kept.',
  prefIndexImport: 'Import Index…',
  prefIndexExport: 'Export Index…',
  prefIndexFormatJson: 'Three-File Vector JSON',
  prefIndexFormatNative: 'Native SQLite Index',
  prefSelectExportModel: 'Choose a Model Index to Export',
  prefRestoreNative: 'Restore Index',
  prefRestoreNativeHint: 'Restoring replaces all model indexes and cached passages in this plugin.',
  prefNativeRestored: 'SQLite index restored. Checking for library changes.',
  prefNativeExported: 'SQLite index exported.',
  prefClearAllHint: 'This deletes all model vectors and cached passages from this device’s local index.',
  prefSwitchModelHint: (model) => `Keep the saved vectors for ${model}?`,
  prefDeleteModelHint: (model) => `Delete the metadata and full-text vectors for ${model}. Shared metadata and PDF passages will be kept.`,
  prefModelCoverage: (i, ni, c, nc) => `Metadata ${i}/${ni} · Passages ${c}/${nc}`,
  prefIndexStage: (stage, i, n, p, c) => `${stage} · Checked metadata ${i}/${n} · PDFs checked ${p} · Passages embedded ${c}`,
  indexingMetadata: 'Indexing metadata',
  indexingFulltext: 'Indexing PDF full text',
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
  prefStatusCardTitle: 'Local Vector Index & Controls',
  prefSharedIndexTitle: 'Shared Index · My Library',
  prefSharedItems: 'Items with vectors / loaded',
  prefSharedChunks: 'Passages with vectors / loaded',
  prefSharedPublishedAt: 'Snapshot published',
  prefSharedReady: 'Shared index loaded.',
  prefSharedChecking: 'Checking for updates. The loaded version is still in use.',
  prefSharedCached: 'Using the last synced version.',
  prefIndexReadError: (detail) => `Unable to read the local vector index. Check that the plugin version matches the index. ${detail}`,
  prefEngineSectionTitle: 'Embedding Engine',
  prefIndexingSectionTitle: 'Chunking & Silent Background Indexing',
  prefUiSectionTitle: 'Search UX & Appearance',
  prefMcpTitle: 'Agent access (MCP)',
  prefMcpHint: 'Allow an agent on this computer to search My Library and read selected PDF pages. Keep Zotero running while connected.',
  prefMcpEnable: 'Enable local MCP',
  prefMcpCopy: 'Copy Codex configuration',
  prefMcpCopied: 'Codex configuration copied.',
  prefMcpStartError: 'MCP could not start. Check the Zotero version and whether the local port is in use.',
  prefMcpCopyError: 'Could not copy the Codex configuration.',
  prefIndexSyncTitle: 'Sync vector indexes through Zotero',
  prefIndexSyncHint: 'Uses the existing WebDAV setup for My Library. Choose one publisher and set other devices to receive. The index attachment contains extracted PDF text and model settings. Credentials stay on this device.',
  prefIndexSyncRole: { off: 'Off', publish: 'Publish this device’s index', receive: 'Receive the shared index' },
  prefIndexSyncAdvanced: 'Advanced settings',
  prefIndexSyncPartSize: 'Maximum part size',
  prefIndexSyncState: {
    off: 'Using the local index.',
    waiting: 'Waiting for Zotero sync or for the publisher to finish indexing.',
    working: 'Checking the shared index.',
    ready: 'Index synced.',
    webdav: 'Zotero WebDAV is unavailable. Existing indexes are still searchable.',
    model: 'A matching, verified ONNX or Ollama model is required.',
    cloud: 'Match the Base URL, model, and output dimensions across devices and enter a valid API key on this device.',
    conflict: 'Multiple publishers or an attachment conflict were detected. Check the shared index attachment in Zotero.',
    error: 'The shared index could not be updated. Existing indexes are still searchable.',
  },
  prefIndexSyncNow: 'Check sync now',
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
  prefPrivacyBadge: 'Local indexes are stored in a separate vectorize.sqlite file',
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
