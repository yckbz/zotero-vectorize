import type { EngineHealthStatus, EngineType, ModelPreset } from '../types/vectorize.ts';
import { buildModelFingerprint } from '../core/hash.ts';

const QWEN_RETRIEVAL_PREFIX = 'Instruct: Given a scientific literature search query, retrieve relevant academic documents that answer the query\nQuery: ';

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    engine: 'local-onnx',
    label: 'Multilingual MiniLM L12 (默认推荐 · 中英跨语言)',
    descriptionZh: '默认的轻量本地模型，适合日常中英检索（约 113MB q8，384 维）。',
    descriptionEn: 'Default lightweight local model for Chinese and English retrieval (~113MB q8, 384d).',
    dimensions: 384,
    crossLingual: true,
    sizeLabel: '~113 MB',
    onnxFile: 'onnx/model_quantized.onnx',
    poolingMode: 'mean',
    maxSeqLength: 256,
  },
  {
    id: 'onnx-community/gte-multilingual-base',
    engine: 'local-onnx',
    label: 'GTE Multilingual Base (高阶原生 · 长上下文 768 维)',
    descriptionZh: '高阶原生 ONNX 检索模型，支持长段落（512+ tokens）与跨语言精细语义匹配，精度稳健（约 325MB q8，768 维）。',
    descriptionEn: 'Stronger native ONNX retrieval model (~325MB q8, 768d, CLS pooling) suited for longer passages and cross-lingual recall.',
    dimensions: 768,
    crossLingual: true,
    sizeLabel: '~325 MB',
    onnxFile: 'onnx/model_quantized.onnx',
    poolingMode: 'cls',
    maxSeqLength: 512,
  },
  {
    id: 'Xenova/paraphrase-multilingual-mpnet-base-v2',
    engine: 'local-onnx',
    label: 'Multilingual MPNet Base v2 (高阶句向量 · 768 维)',
    descriptionZh: '同系列 768 维并行蒸馏模型，用于长句和摘要匹配（约 266MB q8）。',
    descriptionEn: 'Higher-capacity 768d parallel-distilled ONNX model (~266MB q8) for sentence and abstract semantics.',
    dimensions: 768,
    crossLingual: true,
    sizeLabel: '~266 MB',
    onnxFile: 'onnx/model_quantized.onnx',
    poolingMode: 'mean',
    maxSeqLength: 256,
  },
  {
    id: 'Xenova/multilingual-e5-small',
    engine: 'local-onnx',
    label: 'Multilingual E5 Small (轻量对比检索)',
    descriptionZh: '微软 E5 轻量模型（约 113MB q8，384 维），单语检索锐利，但中英混排库中容易偏好同语言候选。',
    descriptionEn: 'Compact E5 ONNX model (~113MB q8, 384d). Sharp monolingual retrieval; may favor same-language results in mixed libraries.',
    dimensions: 384,
    crossLingual: true,
    sizeLabel: '~113 MB',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    onnxFile: 'onnx/model_quantized.onnx',
    poolingMode: 'mean',
    maxSeqLength: 512,
  },
  {
    id: 'Xenova/bge-small-zh-v1.5',
    engine: 'local-onnx',
    label: 'BGE Small ZH v1.5 (中文特化 · 轻量)',
    descriptionZh: '中文学术概念理解极强，体积极小推理飞快（约 25MB q8）。',
    descriptionEn: 'Compact Chinese-specialized model (~25MB q8) with fast local inference.',
    dimensions: 512,
    crossLingual: false,
    sizeLabel: '~25 MB',
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    onnxFile: 'onnx/model_quantized.onnx',
    poolingMode: 'cls',
    maxSeqLength: 512,
  },
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    engine: 'local-onnx',
    label: 'All-MiniLM-L6-v2 (极速纯英文)',
    descriptionZh: '超轻量英文语义模型（约 23MB q8），适合纯英文库与快速索引。',
    descriptionEn: 'Ultra-fast English-only model (~23MB q8).',
    dimensions: 384,
    crossLingual: false,
    sizeLabel: '~23 MB',
    onnxFile: 'onnx/model_quantized.onnx',
    poolingMode: 'mean',
    maxSeqLength: 256,
  },
  {
    id: 'bge-m3',
    engine: 'ollama',
    label: 'bge-m3 (Ollama 多语言)',
    descriptionZh: '1024 维多语言检索模型，支持长段落（8192 tokens）。',
    descriptionEn: '1024d flagship multilingual model with 8192-token context.',
    dimensions: 1024,
    crossLingual: true,
  },
  {
    id: 'nomic-embed-text',
    engine: 'ollama',
    label: 'nomic-embed-text (Ollama 英文长文本)',
    descriptionZh: '768 维长上下文英文模型（8192 tokens），速度快。',
    descriptionEn: '768d fast long-context English embeddings.',
    dimensions: 768,
    crossLingual: false,
    queryPrefix: 'search_query: ',
    passagePrefix: 'search_document: ',
  },
  {
    id: 'qwen3-embedding',
    engine: 'ollama',
    label: 'qwen3-embedding (Ollama 中英跨语言)',
    descriptionZh: '使用学术检索指令编码查询。0.6B 版本适合中英混排的文献库。',
    descriptionEn: 'Uses an academic retrieval instruction for queries. The 0.6B variant suits mixed Chinese and English libraries.',
    dimensions: 1024,
    crossLingual: true,
    queryPrefix: QWEN_RETRIEVAL_PREFIX,
  },
  {
    id: 'text-embedding-3-small',
    engine: 'openai',
    label: 'text-embedding-3-small (OpenAI 标准)',
    descriptionZh: '性价比最高的云端多语言向量模型（1536 维）。',
    descriptionEn: 'Cost-effective 1536d multilingual API model.',
    dimensions: 1536,
    crossLingual: true,
  },
  {
    id: 'text-embedding-3-large',
    engine: 'openai',
    label: 'text-embedding-3-large (OpenAI 高精度)',
    descriptionZh: '3072 维高精度云端模型（支持自定义降维）。',
    descriptionEn: 'High-precision 3072d API model with optional dimension reduction.',
    dimensions: 3072,
    crossLingual: true,
  },
  {
    id: 'BAAI/bge-m3',
    engine: 'openai',
    label: 'BAAI/bge-m3 (SiliconFlow / 兼容端首选)',
    descriptionZh: '兼容 API 下极具性价比的中英跨语言 1024 维模型。',
    descriptionEn: '1024d cross-lingual model for OpenAI-compatible providers.',
    dimensions: 1024,
    crossLingual: true,
  },
];

export function findPreset(engine: EngineType, modelId: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.engine === engine && p.id === modelId);
}

export function formatTextForModel(text: string, role: 'query' | 'passage', modelId: string): string {
  const clean = (text || '').trim();
  if (!clean) return '';
  const low = modelId.toLowerCase();

  if (low.includes('e5-')) {
    const prefix = role === 'query' ? 'query: ' : 'passage: ';
    return clean.startsWith(prefix) ? clean : prefix + clean;
  }
  if (low.includes('nomic-embed')) {
    const prefix = role === 'query' ? 'search_query: ' : 'search_document: ';
    return clean.startsWith(prefix) ? clean : prefix + clean;
  }
  if (low.includes('qwen3-embedding')) {
    return role === 'query' && !clean.startsWith('Instruct:')
      ? QWEN_RETRIEVAL_PREFIX + clean
      : clean;
  }
  if (low.includes('bge-small-zh') || low.includes('bge-base-zh') || low.includes('bge-large-zh')) {
    if (role === 'query') {
      const prefix = '为这个句子生成表示以用于检索相关文章：';
      return clean.startsWith(prefix) ? clean : prefix + clean;
    }
    return clean;
  }
  if (low.includes('bge-small-en') || low.includes('bge-base-en') || low.includes('bge-large-en')) {
    if (role === 'query') {
      const prefix = 'Represent this sentence for searching relevant passages: ';
      return clean.startsWith(prefix) ? clean : prefix + clean;
    }
    return clean;
  }
  return clean;
}

export interface HttpJsonResponse {
  status: number;
  json: any;
  text: string;
}

export type HttpRequestFn = (
  method: 'GET' | 'POST',
  url: string,
  options?: {
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }
) => Promise<HttpJsonResponse>;

export async function defaultHttpRequest(
  method: 'GET' | 'POST',
  url: string,
  options: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}
): Promise<HttpJsonResponse> {
  if (typeof Zotero !== 'undefined' && Zotero?.HTTP?.request) {
    const res = await Zotero.HTTP.request(method, url, {
      headers: options.headers,
      body: options.body,
      timeout: options.timeoutMs ?? 30000,
      successCodes: false,
    });
    const text = res.responseText ?? '';
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  try {
    const res = await fetch(url, {
      method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export interface EmbeddingProvider {
  readonly engine: EngineType;
  readonly model: string;
  getPassageBatchSize(): number | Promise<number>;
  getModelFingerprint(dim?: number): string;
  getStatus(): Promise<EngineHealthStatus>;
  embedQuery(text: string): Promise<Float32Array>;
  embedPassages(texts: string[], onProgress?: (completed: number) => void): Promise<Float32Array[]>;
  testConnection(): Promise<{ ok: boolean; dimensions: number; message: string }>;
  dispose(): Promise<void>;
}

export function getEngineFingerprint(engine: EngineType, model: string, dim = 0): string {
  return buildModelFingerprint(engine, model, dim);
}
