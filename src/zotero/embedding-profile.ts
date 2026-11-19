import { fnv1a64, parseModelFingerprint } from '../core/hash.ts';
import type { EmbeddingProvider } from '../engines/provider.ts';
import type { PluginConfig } from '../types/vectorize.ts';

export interface EmbeddingProfile {
  id: string;
  engine: string;
  model: string;
  dimensions: number;
  provenance: 'verified' | 'legacy';
}

export interface EmbeddingProfileStats extends EmbeddingProfile {
  active: boolean;
  items: number;
  chunks: number;
}

export function legacyProfile(fingerprint: string): EmbeddingProfile {
  const { engine, model, dim } = parseModelFingerprint(fingerprint);
  return { id: 'legacy-' + fnv1a64(fingerprint), engine, model, dimensions: dim, provenance: 'legacy' };
}

export function embeddingSettings(config: PluginConfig): string {
  const endpoint = (url: string) => url.trim().replace(/\/+$/, '');
  switch (config.engine) {
    case 'local-onnx':
      return JSON.stringify([config.engine, config.localModelId, config.localModelDir, config.localMaxSeqLength]);
    case 'ollama':
      return JSON.stringify([config.engine, config.ollamaModel, endpoint(config.ollamaUrl)]);
    case 'openai':
      return JSON.stringify([config.engine, config.openaiModel,
        endpoint(config.openaiBaseUrl).replace(/\/embeddings$/, ''), config.openaiDimensions]);
  }
}

export async function resolveEmbeddingProfile(
  config: PluginConfig, provider: EmbeddingProvider, dimensions = 0
): Promise<EmbeddingProfile | null> {
  const revision = await provider.getModelRevision?.();
  if (config.engine === 'local-onnx' && !revision) return null;
  // A local model may move directories without changing the actual embedding space.
  const settings = config.engine === 'local-onnx'
    ? JSON.stringify([config.engine, config.localModelId, config.localMaxSeqLength])
    : embeddingSettings(config);
  return {
    id: 'model-' + fnv1a64(JSON.stringify([1, settings, revision ?? ''])),
    engine: provider.engine,
    model: provider.model,
    dimensions,
    provenance: 'verified',
  };
}
