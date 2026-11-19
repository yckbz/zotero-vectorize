import type { EngineHealthStatus, HfMirrorMode } from '../types/vectorize.ts';
import { buildModelFingerprint } from '../core/hash.ts';
import { type EmbeddingProvider, findPreset, formatTextForModel } from './provider.ts';

export const ORT_JS_FILENAME = 'ort.bundle.min.mjs';
export const ORT_JS_CANDIDATES = [
  'ort.bundle.min.mjs',
  'ort.all.bundle.min.mjs',
  'ort.wasm.min.mjs',
  'ort.min.mjs',
] as const;
export const ORT_WASM_FILENAME = 'ort-wasm-simd-threaded.wasm';
export const ORT_WASM_CANDIDATES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd.wasm',
  'ort-wasm.wasm',
] as const;

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
    move: (s, d) => IOUtils.move(s, d),
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
  private readonly mirror: HfMirrorMode;
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
  private detectedDim: number;
  private modelRevision?: Promise<string | null>;
  private lastError = '';
  private nextReqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(options: {
    modelId?: string;
    customModelDir?: string;
    mirror?: HfMirrorMode;
    maxSeqLength?: number;
    dataDir: string;
    workerScriptUrl: string;
    fs?: LocalFileSystem;
    workerFactory?: WorkerFactoryFn;
    fetchFn?: typeof fetch;
  }) {
    this.model = (options.modelId || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2').trim();
    this.customModelDir = (options.customModelDir || '').trim();
    this.mirror = options.mirror ?? 'huggingface';
    this.dataDir = options.dataDir;
    this.workerScriptUrl = options.workerScriptUrl;
    this.fs = options.fs ?? createZoteroFileSystem();
    this.workerFactory =
      options.workerFactory ??
      (async (url) => {
        if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          let code = '';
          try {
            if (typeof Zotero !== 'undefined' && typeof Zotero.File?.getResourceAsync === 'function') {
              code = await Zotero.File.getResourceAsync(url);
            }
          } catch {
            code = '';
          }
          if (!code) {
            try {
              if (typeof Zotero !== 'undefined' && typeof Zotero.File?.getContentsFromURL === 'function') {
                code = Zotero.File.getContentsFromURL(url);
              }
            } catch {
              code = '';
            }
          }
          if (!code && typeof this.fetchFn === 'function') {
            try {
              const res = await this.fetchFn(url);
              if (res.ok) code = await res.text();
            } catch {
              code = '';
            }
          }
          if (code) {
            const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            try {
              const worker = new Worker(blobUrl);
              return {
                postMessage: worker.postMessage.bind(worker),
                addEventListener: worker.addEventListener.bind(worker),
                removeEventListener: worker.removeEventListener.bind(worker),
                terminate() {
                  try {
                    worker.terminate();
                  } finally {
                    URL.revokeObjectURL(blobUrl);
                  }
                },
              };
            } catch (error) {
              URL.revokeObjectURL(blobUrl);
              throw error;
            }
          }
        }
        if (typeof ChromeWorker !== 'undefined') {
          try {
            return new ChromeWorker(url);
          } catch {
            return new Worker(url);
          }
        }
        return new Worker(url);
      });
    this.fetchFn =
      options.fetchFn ??
      (typeof fetch === 'function'
        ? fetch.bind(globalThis)
        : (() => Promise.reject(new Error('fetch is not available in this runtime'))));

    const preset = findPreset('local-onnx', this.model);
    this.detectedDim = preset?.dimensions ?? 384;
    this.maxSeqLength = options.maxSeqLength || preset?.maxSeqLength || 512;
  }

  getModelFingerprint(dim?: number): string {
    return buildModelFingerprint(this.engine, this.model, dim ?? this.detectedDim);
  }

  async getModelRevision(): Promise<string | null> {
    this.modelRevision ??= (async () => {
      const assets = await this.resolveExistingAssets();
      if (!assets) return null;
      const hashes = await Promise.all([
        Zotero.Utilities.Internal.md5Async(assets.modelPath),
        Zotero.Utilities.Internal.md5Async(assets.tokenizerPath),
      ]);
      if (hashes.some((hash) => !hash)) throw new Error('Could not identify local model files');
      return hashes.join(':');
    })();
    const revision = await this.modelRevision;
    if (!revision) this.modelRevision = undefined;
    return revision;
  }

  getRuntimeDir(): string {
    return this.fs.join(this.dataDir, 'zotero-vectorize', 'runtime');
  }

  getModelDir(): string {
    if (this.customModelDir) return this.customModelDir;
    return this.fs.join(this.dataDir, 'zotero-vectorize', 'models', getModelSlug(this.model));
  }

  private async resolveExistingAssets(): Promise<{
    ortMjsPath: string;
    wasmPath: string;
    modelPath: string;
    tokenizerPath: string;
    configPath: string | null;
  } | null> {
    const runtimeDir = this.getRuntimeDir();
    const modelDir = this.getModelDir();

    let ortMjsPath = '';
    for (const c of ORT_JS_CANDIDATES) {
      const p = this.fs.join(runtimeDir, c);
      if (await this.fs.exists(p)) {
        ortMjsPath = p;
        break;
      }
    }

    let wasmPath = '';
    for (const c of ORT_WASM_CANDIDATES) {
      const p = this.fs.join(runtimeDir, c);
      if (await this.fs.exists(p)) {
        wasmPath = p;
        break;
      }
    }

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
      const p = this.fs.join(modelDir, ...parts);
      if (await this.fs.exists(p)) {
        modelPath = p;
        break;
      }
    }

    const tokenizerPath = this.fs.join(modelDir, 'tokenizer.json');
    const hasTokenizer = await this.fs.exists(tokenizerPath);

    if (!ortMjsPath || !wasmPath || !modelPath || !hasTokenizer) {
      return null;
    }

    const configCandidate = this.fs.join(modelDir, 'config.json');
    const configPath = (await this.fs.exists(configCandidate)) ? configCandidate : null;

    return { ortMjsPath, wasmPath, modelPath, tokenizerPath, configPath };
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

        const [ortModuleCode, wasmBytes, modelBytes, tokenizerJson] = await Promise.all([
          this.fs.readUTF8(assets.ortMjsPath),
          this.fs.readBytes(assets.wasmPath),
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

        const wasmCopy = wasmBytes.slice().buffer;
        const modelCopy = modelBytes.slice().buffer;

        const res = await this.sendToWorker(
          slot,
          'init',
          {
            ortModuleCode,
            wasmBinary: wasmCopy,
            modelBinary: modelCopy,
            tokenizerJson,
            poolingMode,
            maxSeqLength: this.maxSeqLength,
          },
          [wasmCopy, modelCopy]
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

  private async downloadFileWithFallback(
    urls: string[],
    destPath: string,
    step: number,
    totalSteps: number,
    label: string,
    onProgress?: (p: DownloadProgressInfo) => void
  ): Promise<void> {
    let lastErr: Error | null = null;
    for (const url of urls) {
      try {
        const res = await this.fetchFn(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} downloading ${url}`);
        }
        const totalBytes = Number(res.headers.get('content-length') || 0);
        const tmpPath = `${destPath}.part`;
        await this.fs.remove(tmpPath);

        let bytes: Uint8Array;
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let loadedBytes = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              loadedBytes += value.byteLength;
              const fileRatio = totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 0.5;
              const percent = Math.round((((step - 1) + fileRatio) / totalSteps) * 100);
              onProgress?.({
                file: label,
                step,
                totalSteps,
                loadedBytes,
                totalBytes,
                percent,
              });
            }
          }
          bytes = new Uint8Array(loadedBytes);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        } else {
          const buf = new Uint8Array(await res.arrayBuffer());
          bytes = buf;
          onProgress?.({
            file: label,
            step,
            totalSteps,
            loadedBytes: buf.byteLength,
            totalBytes: buf.byteLength,
            percent: Math.round((step / totalSteps) * 100),
          });
        }

        if (bytes.byteLength === 0) {
          throw new Error(`Empty response from ${url}`);
        }

        await this.fs.writeBytes(tmpPath, bytes);
        await this.fs.remove(destPath);
        await this.fs.move(tmpPath, destPath);
        return;
      } catch (e: any) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastErr ?? new Error(`Failed to download ${label}`);
  }

  async downloadModelAndRuntime(onProgress?: (p: DownloadProgressInfo) => void): Promise<void> {
    if (this.disposed) throw new Error('ONNX provider was closed');
    const runtimeDir = this.getRuntimeDir();
    const modelDir = this.getModelDir();
    await this.fs.makeDir(runtimeDir);
    await this.fs.makeDir(modelDir);

    const ortBases = [
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist',
      'https://registry.npmmirror.com/onnxruntime-web/1.20.1/files/dist',
      'https://unpkg.com/onnxruntime-web@1.20.1/dist',
    ];
    const hfRoot = this.mirror === 'hf-mirror' ? 'https://hf-mirror.com' : 'https://huggingface.co';
    const hfFallback = this.mirror === 'hf-mirror' ? 'https://huggingface.co' : 'https://hf-mirror.com';

    const preset = findPreset('local-onnx', this.model);
    const onnxRelPath = preset?.onnxFile || 'onnx/model_quantized.onnx';

    const tasks: Array<{ dest: string; label: string; urls: string[]; optional?: boolean }> = [];

    let hasOrtJs = false;
    for (const c of ORT_JS_CANDIDATES) {
      if (await this.fs.exists(this.fs.join(runtimeDir, c))) {
        hasOrtJs = true;
        break;
      }
    }
    const ortJsDest = this.fs.join(runtimeDir, ORT_JS_FILENAME);
    if (!hasOrtJs) {
      tasks.push({
        dest: ortJsDest,
        label: 'ONNX Runtime JS',
        urls: ortBases.map((b) => `${b}/${ORT_JS_FILENAME}`),
      });
    }

    let hasOrtWasm = false;
    for (const c of ORT_WASM_CANDIDATES) {
      if (await this.fs.exists(this.fs.join(runtimeDir, c))) {
        hasOrtWasm = true;
        break;
      }
    }
    const ortWasmDest = this.fs.join(runtimeDir, ORT_WASM_FILENAME);
    if (!hasOrtWasm) {
      tasks.push({
        dest: ortWasmDest,
        label: 'ONNX Runtime WASM',
        urls: ortBases.map((b) => `${b}/${ORT_WASM_FILENAME}`),
      });
    }

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
        ],
      });
    }

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      try {
        await this.downloadFileWithFallback(task.urls, task.dest, i + 1, tasks.length, task.label, onProgress);
      } catch (e) {
        if (!task.optional) throw e;
      }
    }

    if (tasks.length > 0 && !this.disposed) {
      this.modelRevision = undefined;
      this.resetWorkers(new Error('ONNX model is being reinitialized'));
    }
    const ok = await this.ensureInitialized();
    if (!ok) {
      throw new Error(this.lastError || 'Failed to initialize downloaded ONNX model');
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
    this.resetWorkers(new Error('ONNX provider was closed'));
  }
}
