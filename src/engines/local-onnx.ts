import type { EngineHealthStatus, HfMirrorMode } from '../types/vectorize.ts';
import { buildModelFingerprint } from '../core/hash.ts';
import { type EmbeddingProvider, findPreset, formatTextForModel } from './provider.ts';

export const ONNX_WORKER_RESOURCE = 'zotero-vectorize-workers';
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const BUFFERED_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

function downloadPlatform(): Pick<typeof globalThis, 'AbortController' | 'fetch' | 'crypto'> {
  // Zotero's bootstrap sandbox does not expose the DOM networking globals.
  return typeof Services === 'undefined' ? globalThis : Services.appShell.hiddenDOMWindow;
}

export function createModelDownloadController(): AbortController {
  const { AbortController } = downloadPlatform();
  return new AbortController();
}

export interface LocalFileSystem {
  exists(path: string): Promise<boolean>;
  readBytes(path: string): Promise<Uint8Array>;
  readUTF8(path: string): Promise<string>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  writeUTF8(path: string, content: string): Promise<void>;
  makeDir(path: string): Promise<void>;
  move(src: string, dest: string): Promise<void>;
  remove(path: string): Promise<void>;
  join(...parts: string[]): string;
}

export interface DownloadProgressInfo {
  file: string;
  step: number;
  totalSteps: number;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
}

export type WorkerFactoryFn = (scriptUrl: string) => WorkerLike | Promise<WorkerLike>;

export interface WorkerLike {
  postMessage(message: any, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error', listener: (ev: any) => void): void;
  removeEventListener(type: 'message' | 'error', listener: (ev: any) => void): void;
}

export function createZoteroFileSystem(): LocalFileSystem {
  return {
    exists: (p) => IOUtils.exists(p),
    readBytes: (p) => IOUtils.read(p),
    readUTF8: (p) => IOUtils.readUTF8(p),
    writeBytes: async (p, data) => {
      await IOUtils.write(p, data);
    },
    writeUTF8: async (p, content) => {
      await IOUtils.writeUTF8(p, content);
    },
    makeDir: async (p) => {
      await IOUtils.makeDirectory(p, { ignoreExisting: true, createAncestors: true });
    },
    move: (s, d) => IOUtils.move(s, d, { noOverwrite: true }),
    remove: (p) => IOUtils.remove(p, { ignoreAbsent: true }),
    join: (...parts) => PathUtils.join(...parts),
  };
}

export function getModelSlug(modelId: string): string {
  return modelId.replace(/[\\/:*?"<>|]+/g, '--');
}

interface WorkerSlot {
  worker: WorkerLike | null;
  initPromise: Promise<boolean> | null;
  initialized: boolean;
}

function createWorkerSlot(): WorkerSlot {
  return { worker: null, initPromise: null, initialized: false };
}

export class LocalOnnxProvider implements EmbeddingProvider {
  readonly engine = 'local-onnx' as const;
  readonly model: string;
  private readonly dataDir: string;
  private readonly customModelDir: string;
  private readonly maxSeqLength: number;
  private readonly workerScriptUrl: string;
  private readonly fs: LocalFileSystem;
  private readonly workerFactory: WorkerFactoryFn;
  private readonly fetchFn: typeof fetch;

  private readonly workers = [createWorkerSlot(), createWorkerSlot()] as const;
  private readonly workerBatchSize = 8;
  getPassageBatchSize(): number { return this.workerBatchSize * this.workers.length; }
  private generation = 0;
  private disposed = false;
  private downloadController?: AbortController;
  private readonly stagedAssets = new Map<string, string>();
  private detectedDim: number;
  private modelRevision?: Promise<string | null>;
  private lastError = '';
  private nextReqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(options: {
    modelId?: string;
    customModelDir?: string;
    maxSeqLength?: number;
    dataDir: string;
    workerScriptUrl: string;
    fs?: LocalFileSystem;
    workerFactory?: WorkerFactoryFn;
    fetchFn?: typeof fetch;
  }) {
    this.model = (options.modelId || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2').trim();
    this.customModelDir = (options.customModelDir || '').trim();
    this.dataDir = options.dataDir;
    this.workerScriptUrl = options.workerScriptUrl;
    this.fs = options.fs ?? createZoteroFileSystem();
    this.workerFactory = options.workerFactory ?? ((url) => new Worker(url, { type: 'module' }));
    const platform = downloadPlatform();
    this.fetchFn = options.fetchFn ?? platform.fetch.bind(platform);

    const preset = findPreset('local-onnx', this.model);
    this.detectedDim = preset?.dimensions ?? 384;
    this.maxSeqLength = options.maxSeqLength || preset?.maxSeqLength || 512;
  }

  getModelFingerprint(dim?: number): string {
    return buildModelFingerprint(this.engine, this.model, dim ?? this.detectedDim);
  }

  async getModelRevision(): Promise<string | null> {
    const request = this.modelRevision ??= (async () => {
      const assets = await this.resolveExistingAssets();
      if (!assets) return null;
      const hashes = await Promise.all([
        Zotero.Utilities.Internal.md5Async(assets.modelPath),
        Zotero.Utilities.Internal.md5Async(assets.tokenizerPath),
      ]);
      if (hashes.some((hash) => !hash)) throw new Error('Could not identify local model files');
      return hashes.join(':');
    })();
    let revision: string | null = null;
    try {
      revision = await request;
      return revision;
    } finally {
      if (!revision && this.modelRevision === request) this.modelRevision = undefined;
    }
  }

  getModelDir(): string {
    if (this.customModelDir) return this.customModelDir;
    return this.fs.join(this.dataDir, 'zotero-vectorize', 'models', getModelSlug(this.model));
  }

  private async resolveExistingAssets(): Promise<{
    modelPath: string;
    tokenizerPath: string;
    configPath: string | null;
  } | null> {
    const modelDir = this.getModelDir();

    const modelCandidates: string[][] = [
      ['model_quantized.onnx'],
      ['onnx', 'model_quantized.onnx'],
      ['model_int8.onnx'],
      ['onnx', 'model_int8.onnx'],
      ['model.onnx'],
      ['onnx', 'model.onnx'],
    ];
    let modelPath = '';
    for (const parts of modelCandidates) {
      const installed = this.fs.join(modelDir, ...parts);
      const p = this.stagedAssets.get(installed) ?? installed;
      if (await this.fs.exists(p)) {
        modelPath = p;
        break;
      }
    }

    const tokenizer = this.fs.join(modelDir, 'tokenizer.json');
    const tokenizerPath = this.stagedAssets.get(tokenizer) ?? tokenizer;
    const hasTokenizer = await this.fs.exists(tokenizerPath);

    if (!modelPath || !hasTokenizer) {
      return null;
    }

    const config = this.fs.join(modelDir, 'config.json');
    const configCandidate = this.stagedAssets.get(config) ?? config;
    const configPath = (await this.fs.exists(configCandidate)) ? configCandidate : null;

    return { modelPath, tokenizerPath, configPath };
  }

  async hasInstalledAssets(): Promise<boolean> {
    return (await this.resolveExistingAssets()) !== null;
  }

  private async ensureInitialized(slot = this.workers[0]): Promise<boolean> {
    if (this.disposed) return false;
    if (slot.initialized) return true;
    if (slot.initPromise) return slot.initPromise;
    const generation = this.generation;

    slot.initPromise = (async () => {
      try {
        const assets = await this.resolveExistingAssets();
        if (!assets || generation !== this.generation) return false;

        const [modelBytes, tokenizerJson] = await Promise.all([
          this.fs.readBytes(assets.modelPath),
          this.fs.readUTF8(assets.tokenizerPath),
        ]);

        const preset = findPreset('local-onnx', this.model);
        const lowModel = this.model.toLowerCase();
        let poolingMode: 'mean' | 'cls' = preset?.poolingMode ?? 'mean';
        if (
          !preset?.poolingMode &&
          (lowModel.includes('bge-') || lowModel.includes('gte-multilingual') || lowModel.includes('arctic-embed'))
        ) {
          poolingMode = 'cls';
        }
        if (assets.configPath && slot === this.workers[0]) {
          try {
            const cfg = JSON.parse(await this.fs.readUTF8(assets.configPath));
            if (generation === this.generation && typeof cfg.hidden_size === 'number' && cfg.hidden_size > 0) {
              this.detectedDim = cfg.hidden_size;
            }
          } catch {
            // Optional config.json
          }
        }

        if (generation !== this.generation) return false;
        const worker = await this.workerFactory(this.workerScriptUrl);
        if (generation !== this.generation) {
          worker.terminate();
          return false;
        }
        worker.addEventListener('message', (ev: any) => {
          if (slot.worker !== worker) return;
          const data = ev.data ?? ev;
          const entry = this.pending.get(data.id);
          if (!entry) return;
          this.pending.delete(data.id);
          if (data.ok) {
            entry.resolve(data.result);
          } else {
            entry.reject(new Error(data.error || 'ONNX worker error'));
          }
        });
        worker.addEventListener('error', (ev: any) => {
          if (slot.worker === worker) this.resetWorkers(new Error(ev?.message || 'ONNX worker crashed'));
        });

        slot.worker = worker;

        const modelCopy = modelBytes.slice().buffer;

        const res = await this.sendToWorker(
          slot,
          'init',
          {
            modelBinary: modelCopy,
            tokenizerJson,
            poolingMode,
            maxSeqLength: this.maxSeqLength,
          },
          [modelCopy]
        );

        if (generation !== this.generation) return false;
        if (slot === this.workers[0] && typeof res?.dimensions === 'number' && res.dimensions > 0) {
          this.detectedDim = res.dimensions;
        }
        slot.initialized = true;
        this.lastError = '';
        return true;
      } catch (error) {
        if (generation === this.generation) {
          this.resetWorkers(error instanceof Error ? error : new Error(String(error)));
        }
        return false;
      } finally {
        if (generation === this.generation) slot.initPromise = null;
      }
    })();

    return slot.initPromise;
  }

  private sendToWorker(slot: WorkerSlot, type: 'init' | 'embed', payload?: any, transfer?: Transferable[]): Promise<any> {
    const worker = slot.worker;
    if (!worker) {
      return Promise.reject(new Error('ONNX worker not started'));
    }
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (slot.worker === worker) this.resetWorkers(new Error(`ONNX worker request '${type}' timed out`));
      }, 120000);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        worker.postMessage({ id, type, payload }, transfer);
      } catch (error) {
        this.resetWorkers(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async fetchModelBytes(
    url: string, signal: AbortSignal, onProgress: (loaded: number, total: number) => void
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    const attempt = createModelDownloadController();
    const abort = () => attempt.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let completed = false;
    const resetTimeout = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => attempt.abort(new Error(`Timed out downloading ${url}`)), ms);
    };
    try {
      resetTimeout(DOWNLOAD_IDLE_TIMEOUT_MS);
      const res = await this.fetchFn(url, { signal: attempt.signal });
      attempt.signal.throwIfAborted();
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);

      let bytes: Uint8Array;
      if (res.body && typeof res.body.getReader === 'function') {
        const totalBytes = Number(res.headers.get('content-length') || 0);
        reader = res.body.getReader();
        resetTimeout(DOWNLOAD_IDLE_TIMEOUT_MS);
        const chunks: Uint8Array[] = [];
        let loadedBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          attempt.signal.throwIfAborted();
          if (done) break;
          if (!value?.byteLength) continue;
          resetTimeout(DOWNLOAD_IDLE_TIMEOUT_MS);
          chunks.push(value);
          loadedBytes += value.byteLength;
          onProgress(loadedBytes, totalBytes);
        }
        bytes = new Uint8Array(loadedBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      } else {
        resetTimeout(BUFFERED_DOWNLOAD_TIMEOUT_MS);
        bytes = new Uint8Array(await res.arrayBuffer());
        attempt.signal.throwIfAborted();
        onProgress(bytes.byteLength, bytes.byteLength);
      }
      completed = true;
      if (!bytes.byteLength) throw new Error(`Empty response from ${url}`);
      return bytes;
    } catch (error) {
      attempt.signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (!completed) {
        attempt.abort();
        if (reader) void reader.cancel().catch(() => {});
      }
      reader?.releaseLock();
    }
  }

  private async downloadFileWithFallback(
    urls: string[], stagedPath: string, signal: AbortSignal, onProgress: (loaded: number, total: number) => void
  ): Promise<void> {
    let bytes: Uint8Array | undefined;
    let lastError: unknown;
    for (const url of urls) {
      try {
        bytes = await this.fetchModelBytes(url, signal, onProgress);
        break;
      } catch (error) {
        signal.throwIfAborted();
        lastError = error;
      }
    }
    if (!bytes) throw lastError ?? new Error(`Failed to download ${stagedPath}`);

    try {
      signal.throwIfAborted();
      await this.fs.writeBytes(stagedPath, bytes);
      signal.throwIfAborted();
    } catch (error) {
      await this.fs.remove(stagedPath).catch(() => {});
      throw error;
    }
  }

  async prepareModelDownload(
    mirror: HfMirrorMode, onProgress?: (p: DownloadProgressInfo) => void, controller = createModelDownloadController()
  ): Promise<void> {
    if (this.disposed) throw new Error('ONNX provider was closed');
    if (this.downloadController || this.stagedAssets.size) throw new Error('A model download is already in progress');
    this.downloadController = controller;
    try {
      await this.stageModel(mirror, controller.signal, onProgress);
    } finally {
      this.downloadController = undefined;
    }
  }

  async commitModelDownload(signal: AbortSignal, activate?: () => Promise<void>): Promise<void> {
    const moved: string[] = [];
    try {
      for (const [installed, staged] of this.stagedAssets) {
        signal.throwIfAborted();
        await this.fs.move(staged, installed);
        moved.push(installed);
      }
      signal.throwIfAborted();
      await activate?.();
    } catch (error) {
      const rolledBack = await Promise.allSettled(moved.map((file) => this.fs.remove(file)));
      const failures = rolledBack.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError([error, ...failures], 'Could not roll back the model installation');
      throw error;
    }
    this.stagedAssets.clear();
  }

  private async stageModel(
    mirror: HfMirrorMode, signal: AbortSignal, onProgress?: (p: DownloadProgressInfo) => void
  ): Promise<void> {
    signal.throwIfAborted();
    const modelDir = this.getModelDir();
    await this.fs.makeDir(modelDir);

    const hfRoot = mirror === 'hf-mirror' ? 'https://hf-mirror.com' : 'https://huggingface.co';
    const hfFallback = mirror === 'hf-mirror' ? 'https://huggingface.co' : 'https://hf-mirror.com';

    const preset = findPreset('local-onnx', this.model);
    const onnxRelPath = preset?.onnxFile || 'onnx/model_quantized.onnx';

    const tasks: Array<{ dest: string; label: string; urls: string[]; optional?: boolean }> = [];

    const tokenizerDest = this.fs.join(modelDir, 'tokenizer.json');
    const hasTokenizer = await this.fs.exists(tokenizerDest);
    if (!hasTokenizer) {
      tasks.push({
        dest: tokenizerDest,
        label: 'Tokenizer (tokenizer.json)',
        urls: [
          `${hfRoot}/${this.model}/resolve/main/tokenizer.json`,
          `${hfFallback}/${this.model}/resolve/main/tokenizer.json`,
        ],
      });
    }

    const modelCandidates: string[][] = [
      ['model_quantized.onnx'],
      ['onnx', 'model_quantized.onnx'],
      ['model_int8.onnx'],
      ['onnx', 'model_int8.onnx'],
      ['model.onnx'],
      ['onnx', 'model.onnx'],
    ];
    let hasModelFile = false;
    for (const parts of modelCandidates) {
      if (await this.fs.exists(this.fs.join(modelDir, ...parts))) {
        hasModelFile = true;
        break;
      }
    }

    const configDest = this.fs.join(modelDir, 'config.json');
    const skipOptionalConfigForOfflineDir = Boolean(this.customModelDir && hasModelFile && hasTokenizer);
    if (!skipOptionalConfigForOfflineDir && !(await this.fs.exists(configDest))) {
      tasks.push({
        dest: configDest,
        label: 'Model Config (config.json)',
        urls: [
          `${hfRoot}/${this.model}/resolve/main/config.json`,
          `${hfFallback}/${this.model}/resolve/main/config.json`,
        ],
        optional: true,
      });
    }

    const modelDest = this.fs.join(modelDir, 'model_quantized.onnx');
    if (!hasModelFile) {
      tasks.push({
        dest: modelDest,
        label: `Model (${this.model})`,
        urls: [
          `${hfRoot}/${this.model}/resolve/main/${onnxRelPath}`,
          `${hfFallback}/${this.model}/resolve/main/${onnxRelPath}`,
          `${hfRoot}/${this.model}/resolve/main/onnx/model.onnx`,
          `${hfFallback}/${this.model}/resolve/main/onnx/model.onnx`,
        ],
      });
    }

    const suffix = tasks.length ? `.part-${downloadPlatform().crypto.randomUUID()}` : '';
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      signal.throwIfAborted();
      const staged = task.dest + suffix;
      try {
        await this.fs.remove(task.dest + '.part');
        await this.downloadFileWithFallback(task.urls, staged, signal, (loadedBytes, totalBytes) => {
          const ratio = totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 0.5;
          const percent = Math.round(((i + ratio) / tasks.length) * 100);
          onProgress?.({ file: task.label, step: i + 1, totalSteps: tasks.length, loadedBytes, totalBytes, percent });
        });
        this.stagedAssets.set(task.dest, staged);
      } catch (e) {
        signal.throwIfAborted();
        if (!task.optional) throw e;
      }
    }

    signal.throwIfAborted();
    if (tasks.length > 0) {
      this.modelRevision = undefined;
      this.resetWorkers(new Error('ONNX model is being reinitialized'));
    }
    const abortInitialization = () => this.resetWorkers(new Error('ONNX model verification was canceled'));
    signal.addEventListener('abort', abortInitialization, { once: true });
    try {
      const ok = await this.ensureInitialized();
      signal.throwIfAborted();
      if (!ok) throw new Error(this.lastError || 'Failed to initialize downloaded ONNX model');
    } finally {
      signal.removeEventListener('abort', abortInitialization);
    }
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const generation = this.generation;
    const ready = await this.ensureInitialized();
    if (!ready || generation !== this.generation) {
      throw new Error(this.lastError || 'Local ONNX model is not installed yet');
    }
    const formatted = formatTextForModel(text, 'query', this.model);
    const res = await this.sendToWorker(this.workers[0], 'embed', {
      texts: [formatted],
      maxSeqLength: this.maxSeqLength,
    });
    return res.vectors[0];
  }

  embedMetadata(texts: string[]): Promise<Float32Array[]> {
    // Preserve single-input inference for metadata. Quantized models can
    // produce different vectors when texts share a padded input tensor.
    return this.embedBatches(texts, 1);
  }

  embedPassages(texts: string[], onProgress?: (completed: number) => void): Promise<Float32Array[]> {
    return this.embedBatches(texts, this.workerBatchSize, onProgress);
  }

  private async embedBatches(texts: string[], batchSize: number, onProgress?: (completed: number) => void): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const slots = texts.length > batchSize ? this.workers : [this.workers[0]];
    const generation = this.generation;
    const out = new Array<Float32Array>(texts.length);
    let nextOffset = 0;
    let completed = 0;
    let failed = false;

    const run = async (slot: WorkerSlot): Promise<void> => {
      try {
        const ready = await this.ensureInitialized(slot);
        if (!ready || generation !== this.generation) {
          throw new Error(this.lastError || 'Local ONNX model is not installed yet');
        }
        while (!failed && nextOffset < texts.length) {
          const offset = nextOffset;
          nextOffset += batchSize;
          const batch = texts.slice(offset, offset + batchSize).map((text) => formatTextForModel(text, 'passage', this.model));
          const res = await this.sendToWorker(slot, 'embed', {
            texts: batch,
            maxSeqLength: this.maxSeqLength,
          });
          if (generation !== this.generation) {
            throw new Error(this.lastError || 'ONNX workers were reset');
          }
          if (failed) return;
          if (res.vectors.length !== batch.length) {
            throw new Error('ONNX worker returned an unexpected number of vectors');
          }
          for (const [index, vector] of res.vectors.entries()) {
            out[offset + index] = vector;
          }
          completed += batch.length;
          onProgress?.(completed);
          if (generation !== this.generation) {
            throw new Error(this.lastError || 'ONNX workers were reset');
          }
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    const results = await Promise.allSettled(slots.map(run));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    return out;
  }

  async testConnection(): Promise<{ ok: boolean; dimensions: number; message: string }> {
    const hasFiles = await this.hasInstalledAssets();
    if (!hasFiles) {
      return {
        ok: false,
        dimensions: 0,
        message: `Local ONNX model files missing in ${this.getModelDir()}. Click "Download Model" or choose a local model folder.`,
      };
    }
    const ok = await this.ensureInitialized();
    if (!ok) {
      return {
        ok: false,
        dimensions: 0,
        message: this.lastError || 'Failed to load local ONNX runtime',
      };
    }
    try {
      const vec = await this.embedQuery('semantic test');
      return {
        ok: true,
        dimensions: vec.length,
        message: `Local ONNX ready (${this.model}, ${vec.length}d)`,
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
    const hasFiles = await this.hasInstalledAssets();
    if (!hasFiles) {
      return {
        engine: this.engine,
        model: this.model,
        modelFingerprint: this.getModelFingerprint(),
        ready: false,
        neuralAvailable: false,
        dimensions: this.detectedDim,
        needsSetup: true,
        statusMessage: '本地 ONNX 模型待下载（已启用词法跨语言引擎）',
      };
    }
    return {
      engine: this.engine,
      model: this.model,
      modelFingerprint: this.getModelFingerprint(),
      ready: true,
      neuralAvailable: true,
      dimensions: this.detectedDim,
      needsSetup: false,
      statusMessage: `ONNX · ${this.model.split('/').pop()}`,
      error: this.lastError || undefined,
    };
  }

  private resetWorkers(error: Error): void {
    this.generation++;
    this.lastError = error.message;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    for (const slot of this.workers) {
      const worker = slot.worker;
      slot.worker = null;
      slot.initialized = false;
      slot.initPromise = null;
      try {
        worker?.terminate();
      } catch (terminationError) {
        if (typeof Zotero !== 'undefined') Zotero.logError(terminationError);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.downloadController?.abort();
    this.resetWorkers(new Error('ONNX provider was closed'));
    await Promise.allSettled([...this.stagedAssets.values()].map((path) => this.fs.remove(path)));
    this.stagedAssets.clear();
  }
}
