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

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly engine = 'ollama' as const;
  getPassageBatchSize(): number { return 16; }
  readonly model: string;
  private readonly baseUrl: string;
  private readonly http: HttpRequestFn;
  private detectedDim: number;
  private modelRevision?: Promise<string | null>;
  private useLegacyApi = false;

  constructor(options: {
    baseUrl?: string;
    model?: string;
    http?: HttpRequestFn;
  }) {
    this.baseUrl = (options.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    this.model = (options.model || 'bge-m3').trim();
    this.http = options.http ?? defaultHttpRequest;
    this.detectedDim = findPreset('ollama', this.model)?.dimensions ?? 0;
  }

  getModelFingerprint(dim?: number): string {
    return buildModelFingerprint(this.engine, this.model, dim ?? this.detectedDim);
  }

  private async getInstalledModels(): Promise<Array<{ name?: string; model?: string; digest?: string }>> {
    const res = await this.http('GET', `${this.baseUrl}/api/tags`, { timeoutMs: 6000 });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Ollama /api/tags failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }
    return Array.isArray(res.json?.models) ? res.json.models : [];
  }

  async listModels(): Promise<string[]> {
    return (await this.getInstalledModels()).map((model) => model.name || model.model || '').filter(Boolean);
  }

  getModelRevision(refresh = false): Promise<string | null> {
    if (refresh) this.modelRevision = undefined;
    this.modelRevision ??= this.getInstalledModels().then((models) => {
      const canonical = (name: string) => name.split('/').at(-1)?.includes(':') ? name : `${name}:latest`;
      return models.find((model) => canonical(model.name || model.model || '') === canonical(this.model))?.digest ?? null;
    }, () => null);
    return this.modelRevision;
  }

  private async embedWithModernApi(inputs: string[]): Promise<Float32Array[]> {
    const res = await this.http('POST', `${this.baseUrl}/api/embed`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: inputs.length === 1 ? inputs[0] : inputs,
      }),
      timeoutMs: 60000,
    });

    if (res.status === 404 || res.status === 405) {
      this.useLegacyApi = true;
      return this.embedWithLegacyApi(inputs);
    }

    if (res.status < 200 || res.status >= 300) {
      const errMsg = res.json?.error || res.text || `HTTP ${res.status}`;
      throw new Error(`Ollama embed error (${res.status}): ${errMsg}`);
    }

    const rawList: any[] = Array.isArray(res.json?.embeddings)
      ? res.json.embeddings
      : Array.isArray(res.json?.embedding)
      ? [res.json.embedding]
      : [];

    if (rawList.length !== inputs.length) {
      throw new Error(`Ollama returned ${rawList.length} embeddings for ${inputs.length} inputs`);
    }

    return rawList.map((arr) => {
      if (!Array.isArray(arr) || !isFiniteVector(arr)) {
        throw new Error('Ollama returned invalid embedding vector');
      }
      const norm = l2Normalize(arr);
      this.detectedDim = norm.length;
      return norm;
    });
  }

  private async embedWithLegacyApi(inputs: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const prompt of inputs) {
      const res = await this.http('POST', `${this.baseUrl}/api/embeddings`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt }),
        timeoutMs: 60000,
      });
      if (res.status < 200 || res.status >= 300) {
        const errMsg = res.json?.error || res.text || `HTTP ${res.status}`;
        throw new Error(`Ollama /api/embeddings error (${res.status}): ${errMsg}`);
      }
      const arr = res.json?.embedding;
      if (!Array.isArray(arr) || !isFiniteVector(arr)) {
        throw new Error('Ollama legacy API returned invalid embedding');
      }
      const norm = l2Normalize(arr);
      this.detectedDim = norm.length;
      results.push(norm);
    }
    return results;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const formatted = formatTextForModel(text, 'query', this.model);
    const out = await this.embedPassagesRaw([formatted]);
    return out[0];
  }

  async embedPassages(texts: string[], onProgress?: (completed: number) => void): Promise<Float32Array[]> {
    const formatted = texts.map((t) => formatTextForModel(t, 'passage', this.model));
    return this.embedPassagesRaw(formatted, onProgress);
  }

  private async embedPassagesRaw(inputs: string[], onProgress?: (completed: number) => void): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const batchSize = this.getPassageBatchSize();
    const out: Float32Array[] = [];
    for (let i = 0; i < inputs.length; i += batchSize) {
      const slice = inputs.slice(i, i + batchSize);
      const batch = this.useLegacyApi
        ? await this.embedWithLegacyApi(slice)
        : await this.embedWithModernApi(slice);
      out.push(...batch);
      onProgress?.(out.length);
    }
    return out;
  }

  async testConnection(): Promise<{ ok: boolean; dimensions: number; message: string }> {
    try {
      const vec = await this.embedQuery('semantic search health check');
      return {
        ok: true,
        dimensions: vec.length,
        message: `Ollama connected (${this.model}, ${vec.length}d)`,
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
    return {
      engine: this.engine,
      model: this.model,
      modelFingerprint: this.getModelFingerprint(),
      ready: true,
      neuralAvailable: true,
      dimensions: this.detectedDim,
      needsSetup: false,
      statusMessage: `Ollama · ${this.model}`,
    };
  }

  async dispose(): Promise<void> {
    // Stateless HTTP provider
  }
}
