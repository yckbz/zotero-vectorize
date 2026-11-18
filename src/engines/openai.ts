import type { EngineHealthStatus } from '../types/vectorize.ts';
import { buildModelFingerprint } from '../core/hash.ts';
import { isFiniteVector, l2Normalize } from '../core/math.ts';
import {
  type EmbeddingProvider,
  type HttpRequestFn,
  defaultHttpRequest,
  findPreset,
  formatTextForModel,
  type HttpJsonResponse,
} from './provider.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EmbeddingApiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Embedding API error (${status}): ${detail}`);
  }
}

function isBatchSizeError(error: unknown): error is EmbeddingApiError {
  return error instanceof EmbeddingApiError && (error.status === 400 || error.status === 422) &&
    /\bbatch[ _-](?:size|limit)\b|\btoo many (?:inputs|texts|items)\b|\bmax(?:imum)? (?:number of )?(?:inputs|texts|items)\b|\b(?:list|array) should have at most \d+ items\b/i
      .test(error.detail);
}

export class OpenAICompatProvider implements EmbeddingProvider {
  readonly engine = 'openai' as const;
  readonly model: string;
  private readonly batchCeiling: number;
  private readonly autoBatchSize: boolean;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestedDimensions: number;
  private readonly supportsDimensions: boolean;
  private readonly http: HttpRequestFn;
  private detectedDim: number;
  private responseDim = 0;
  private batchProbe?: Promise<number>;

  constructor(options: {
    baseUrl?: string;
    apiKey: string;
    model?: string;
    dimensions?: number;
    batchSize?: number;
    http?: HttpRequestFn;
  }) {
    this.baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = (options.apiKey || '').trim();
    this.model = (options.model || 'text-embedding-3-small').trim();
    const model = this.model.toLowerCase();
    const modelLimit = /^qwen3\.7-text-embedding(?:-flash)?$/.test(model)
      ? 20
      : /^text-embedding-v[34]$/.test(model) ? 10 : undefined;
    const configuredLimit = Math.floor(options.batchSize ?? 0);
    this.autoBatchSize = configuredLimit <= 0;
    const limit = this.autoBatchSize ? 24 : configuredLimit;
    this.batchCeiling = Math.min(limit, modelLimit ?? limit);
    this.requestedDimensions = Number(options.dimensions || 0) || 0;
    this.supportsDimensions = modelLimit !== undefined || model.includes('text-embedding-3');
    this.http = options.http ?? defaultHttpRequest;
    this.detectedDim =
      this.requestedDimensions > 0 && this.supportsDimensions
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
    if (this.requestedDimensions > 0 && this.supportsDimensions) {
      payload.dimensions = this.requestedDimensions;
    }

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: HttpJsonResponse;
      try {
        res = await this.http('POST', endpoint, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          timeoutMs: 45000,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === maxAttempts - 1 || !/abort|timeout|network/i.test(message)) throw error;
        await sleep(400 * Math.pow(2, attempt));
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        const data: any[] = Array.isArray(res.json?.data) ? res.json.data : [];
        if (data.length !== inputs.length) {
          throw new Error(`API returned ${data.length} vectors for ${inputs.length} inputs`);
        }
        const sorted = [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
        const vectors = sorted.map((entry, index) => {
          if ((entry?.index ?? (inputs.length === 1 ? 0 : undefined)) !== index) {
            throw new Error('API returned invalid embedding indices');
          }
          if (!Array.isArray(entry?.embedding) || !isFiniteVector(entry.embedding)) {
            throw new Error('API returned invalid embedding array');
          }
          return l2Normalize(entry.embedding);
        });
        const dim = vectors[0].length;
        const requestedDim = this.supportsDimensions ? this.requestedDimensions : 0;
        const expectedDim = this.responseDim || requestedDim;
        if (vectors.some((vector) => vector.length !== dim) || (expectedDim > 0 && dim !== expectedDim)) {
          throw new Error('API returned inconsistent embedding dimensions');
        }
        this.responseDim = dim;
        this.detectedDim = dim;
        return vectors;
      }

      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (retryable && attempt < maxAttempts - 1) {
        await sleep(400 * Math.pow(2, attempt));
        continue;
      }
      const errMsg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
      throw new EmbeddingApiError(res.status, String(errMsg));
    }
    throw new Error('Embedding API request failed');
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const formatted = formatTextForModel(text, 'query', this.model);
    const [vec] = await this.requestWithRetry([formatted]);
    return vec;
  }

  getPassageBatchSize(): Promise<number> {
    if (!this.autoBatchSize) return Promise.resolve(this.batchCeiling);
    this.batchProbe ??= this.detectBatchSize().catch((error) => {
      this.batchProbe = undefined;
      throw error;
    });
    return this.batchProbe;
  }

  private async probeBatchSize(size: number): Promise<void> {
    const inputs = Array.from({ length: size }, (_, index) =>
      formatTextForModel(`Passage embedding check ${index + 1}`, 'passage', this.model)
    );
    await this.requestWithRetry(inputs);
  }

  private async detectBatchSize(): Promise<number> {
    let accepted = 0;
    let upper = this.batchCeiling;
    let size = upper;
    while (accepted < upper) {
      try {
        await this.probeBatchSize(size);
        accepted = size;
      } catch (error) {
        if (!isBatchSizeError(error) || size === 1) throw error;
        upper = size - 1;
        const advertisedLimit = Number(error.detail.match(
          /(?:at most|no more than|not (?:be )?(?:larger|greater) than|(?:max(?:imum)? )?batch (?:size|limit)(?: is| of|:)?|<=)\s*(\d+)/i
        )?.[1]);
        if (advertisedLimit >= Math.max(1, accepted) && advertisedLimit <= upper) {
          upper = advertisedLimit;
          size = advertisedLimit;
          continue;
        }
      }
      size = Math.floor((accepted + upper + 1) / 2);
    }
    return accepted;
  }

  async embedPassages(texts: string[], onProgress?: (completed: number) => void): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const formatted = texts.map((t) => formatTextForModel(t, 'passage', this.model));
    const batchSize = texts.length === 1 ? 1 : await this.getPassageBatchSize();
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
      const hasPriorProbe = Boolean(this.batchProbe);
      const batchSize = await this.getPassageBatchSize();
      if (!this.autoBatchSize || hasPriorProbe) await this.probeBatchSize(batchSize);
      return {
        ok: true,
        dimensions: this.responseDim,
        message: `Connected (${this.model}, ${this.responseDim}d, ${batchSize} inputs per batch)`,
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
