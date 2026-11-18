import type { EngineHealthStatus } from '../types/vectorize.ts';
import { buildModelFingerprint } from '../core/hash.ts';
import { isFiniteVector, l2Normalize } from '../core/math.ts';
import {
  type EmbeddingProvider,
  type HttpRequestFn,
  defaultHttpRequest,
  findPreset,
  formatTextForModel,
} from './provider.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAICompatProvider implements EmbeddingProvider {
  readonly engine = 'openai' as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestedDimensions: number;
  private readonly http: HttpRequestFn;
  private detectedDim: number;

  constructor(options: {
    baseUrl?: string;
    apiKey: string;
    model?: string;
    dimensions?: number;
    http?: HttpRequestFn;
  }) {
    this.baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = (options.apiKey || '').trim();
    this.model = (options.model || 'text-embedding-3-small').trim();
    this.requestedDimensions = Number(options.dimensions || 0) || 0;
    this.http = options.http ?? defaultHttpRequest;
    this.detectedDim =
      this.requestedDimensions > 0
        ? this.requestedDimensions
        : (findPreset('openai', this.model)?.dimensions ?? 0);
  }

  getModelFingerprint(dim?: number): string {
    return buildModelFingerprint(this.engine, this.model, dim ?? this.detectedDim);
  }

  private async requestWithRetry(inputs: string[]): Promise<Float32Array[]> {
    if (!this.apiKey) {
      throw new Error('OpenAI-compatible API key is not configured.');
    }
    const endpoint = this.baseUrl.endsWith('/embeddings')
      ? this.baseUrl
      : `${this.baseUrl}/embeddings`;

    const payload: Record<string, any> = {
      model: this.model,
      input: inputs.length === 1 ? inputs[0] : inputs,
    };
    if (this.requestedDimensions > 0 && this.model.includes('text-embedding-3')) {
      payload.dimensions = this.requestedDimensions;
    }

    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await this.http('POST', endpoint, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          timeoutMs: 45000,
        });

        if (res.status >= 200 && res.status < 300) {
          const data: any[] = Array.isArray(res.json?.data) ? res.json.data : [];
          // OpenAI spec allows unsorted data entries indexed by `.index`
          const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          if (sorted.length !== inputs.length) {
            throw new Error(`API returned ${sorted.length} vectors for ${inputs.length} inputs`);
          }
          return sorted.map((entry) => {
            if (!Array.isArray(entry?.embedding) || !isFiniteVector(entry.embedding)) {
              throw new Error('API returned invalid embedding array');
            }
            const norm = l2Normalize(entry.embedding);
            this.detectedDim = norm.length;
            return norm;
          });
        }

        const errMsg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
        const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
        if (retryable && attempt < maxAttempts - 1) {
          await sleep(400 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`Embedding API error (${res.status}): ${errMsg}`);
      } catch (e: any) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < maxAttempts - 1 && /abort|timeout|network|429|503/i.test(lastError.message)) {
          await sleep(400 * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error('Embedding API request failed');
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const formatted = formatTextForModel(text, 'query', this.model);
    const [vec] = await this.requestWithRetry([formatted]);
    return vec;
  }

  async embedPassages(texts: string[], onProgress?: (completed: number) => void): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const formatted = texts.map((t) => formatTextForModel(t, 'passage', this.model));
    const batchSize = 24;
    const out: Float32Array[] = [];
    for (let i = 0; i < formatted.length; i += batchSize) {
      const slice = formatted.slice(i, i + batchSize);
      out.push(...(await this.requestWithRetry(slice)));
      onProgress?.(out.length);
    }
    return out;
  }

  async testConnection(): Promise<{ ok: boolean; dimensions: number; message: string }> {
    try {
      const vec = await this.embedQuery('semantic search connection check');
      return {
        ok: true,
        dimensions: vec.length,
        message: `Connected (${this.model}, ${vec.length}d)`,
      };
    } catch (e: any) {
      return {
        ok: false,
        dimensions: 0,
        message: e?.message || String(e),
      };
    }
  }

  async getStatus(): Promise<EngineHealthStatus> {
    const hasKey = Boolean(this.apiKey);
    return {
      engine: this.engine,
      model: this.model,
      modelFingerprint: this.getModelFingerprint(),
      ready: hasKey,
      neuralAvailable: hasKey,
      dimensions: this.detectedDim,
      needsSetup: !hasKey,
      statusMessage: hasKey ? `API · ${this.model}` : 'API Key required',
    };
  }

  async dispose(): Promise<void> {
    // Stateless HTTP provider
  }
}
