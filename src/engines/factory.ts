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

    const provider = this.createProvider(config);
    await this.activateProvider(config, provider);
    return provider;
  }

  async activateProvider(config: PluginConfig, provider: EmbeddingProvider): Promise<void> {
    const previous = this.activeProvider;
    this.activeProvider = provider;
    this.activeSignature = this.signatureFor(config);
    await previous?.dispose().catch(() => {});
  }

  createProvider(config: PluginConfig): EmbeddingProvider {
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
        maxSeqLength: config.localMaxSeqLength,
        dataDir: this.dataDir,
        workerScriptUrl: this.workerScriptUrl,
      });
    }

    return provider;
  }

  async dispose(): Promise<void> {
    const provider = this.activeProvider;
    this.activeProvider = null;
    this.activeSignature = '';
    await provider?.dispose().catch(() => {});
  }
}
