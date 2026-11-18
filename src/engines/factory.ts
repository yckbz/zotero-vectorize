import type { PluginConfig } from '../types/vectorize.ts';
import type { EmbeddingProvider } from './provider.ts';
import { LocalOnnxProvider } from './local-onnx.ts';
import { OllamaEmbeddingProvider } from './ollama.ts';
import { OpenAICompatProvider } from './openai.ts';

export class ProviderManager {
  private activeProvider: EmbeddingProvider | null = null;
  private activeSignature = '';
  private readonly dataDir: string;
  private readonly workerScriptUrl: string;

  constructor(options: { dataDir: string; workerScriptUrl: string }) {
    this.dataDir = options.dataDir;
    this.workerScriptUrl = options.workerScriptUrl;
  }

  private signatureFor(config: PluginConfig): string {
    return JSON.stringify([
      config.engine,
      config.localModelId,
      config.localModelDir,
      config.localMirror,
      config.localMaxSeqLength,
      config.ollamaUrl,
      config.ollamaModel,
      config.openaiBaseUrl,
      config.openaiApiKey,
      config.openaiModel,
      config.openaiDimensions,
      config.openaiBatchSize,
    ]);
  }

  async getProvider(config: PluginConfig): Promise<EmbeddingProvider> {
    const sig = this.signatureFor(config);
    if (this.activeProvider && this.activeSignature === sig) {
      return this.activeProvider;
    }

    const previousProvider = this.activeProvider;
    let provider: EmbeddingProvider;
    if (config.engine === 'ollama') {
      provider = new OllamaEmbeddingProvider({
        baseUrl: config.ollamaUrl,
        model: config.ollamaModel,
      });
    } else if (config.engine === 'openai') {
      provider = new OpenAICompatProvider({
        baseUrl: config.openaiBaseUrl,
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
        dimensions: config.openaiDimensions,
        batchSize: config.openaiBatchSize,
      });
    } else {
      provider = new LocalOnnxProvider({
        modelId: config.localModelId,
        customModelDir: config.localModelDir,
        mirror: config.localMirror,
        maxSeqLength: config.localMaxSeqLength,
        dataDir: this.dataDir,
        workerScriptUrl: this.workerScriptUrl,
      });
    }

    this.activeProvider = provider;
    this.activeSignature = sig;
    await previousProvider?.dispose().catch(() => {});
    return provider;
  }

  async dispose(): Promise<void> {
    const provider = this.activeProvider;
    this.activeProvider = null;
    this.activeSignature = '';
    await provider?.dispose().catch(() => {});
  }
}
