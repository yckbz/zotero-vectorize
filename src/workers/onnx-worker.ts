import { loadTokenizerFromJson, type HuggingFaceTokenizer } from '../core/tokenizer.ts';
import { clsPoolNormalized, l2Normalize, meanPoolNormalized } from '../core/math.ts';

interface InitPayload {
  ortModuleCode: string;
  wasmBinary: ArrayBuffer;
  modelBinary: ArrayBuffer;
  tokenizerJson: string;
  poolingMode?: 'mean' | 'cls';
  maxSeqLength?: number;
}

interface EmbedPayload {
  texts: string[];
  maxSeqLength?: number;
  poolingMode?: 'mean' | 'cls';
}

interface WorkerRequest {
  id: number;
  type: 'init' | 'embed' | 'dispose';
  payload?: any;
}

let ortModule: any = null;
let session: any = null;
let tokenizer: HuggingFaceTokenizer | null = null;
let defaultPooling: 'mean' | 'cls' = 'mean';
let defaultMaxSeqLen = 512;
let hiddenDim = 0;

export async function handleWorkerMessage(msg: WorkerRequest): Promise<{ result: any; transfer?: Transferable[] }> {
  if (msg.type === 'dispose') {
    if (session && typeof session.release === 'function') {
      await session.release();
    }
    session = null;
    tokenizer = null;
    return { result: { ok: true } };
  }

  if (msg.type === 'init') {
    const p = msg.payload as InitPayload;
    if (!p || !p.ortModuleCode || !p.wasmBinary || !p.modelBinary || !p.tokenizerJson) {
      throw new Error('Missing ONNX worker initialization assets');
    }

    if (!ortModule) {
      const blob = new Blob([p.ortModuleCode], { type: 'text/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try {
        ortModule = await import(/* @vite-ignore */ blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }

    const ort = ortModule.default ?? ortModule;
    let wasmBlobUrl: string | null = null;
    if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      try {
        wasmBlobUrl = URL.createObjectURL(new Blob([p.wasmBinary], { type: 'application/wasm' }));
      } catch {
        wasmBlobUrl = null;
      }
    }
    if (ort.env?.wasm) {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      const canFetchBlobWasm = Boolean(
        wasmBlobUrl &&
        typeof fetch === 'function' &&
        (typeof importScripts === 'function' ||
          typeof window === 'object' ||
          (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function'))
      );
      if (canFetchBlobWasm) {
        // onnxruntime-web@1.20.1 omits locateFile whenever wasmBinary is set, causing
        // Emscripten to call `new URL("ort-wasm-simd-threaded.wasm", import.meta.url)`
        // which throws TypeError: Invalid URL when ORT is imported via a blob: URL.
        ort.env.wasm.wasmPaths = { wasm: wasmBlobUrl };
        delete ort.env.wasm.wasmBinary;
      } else {
        ort.env.wasm.wasmPaths = {};
        ort.env.wasm.wasmBinary = p.wasmBinary;
      }
    }

    if (session && typeof session.release === 'function') {
      await session.release();
    }

    try {
      session = await ort.InferenceSession.create(new Uint8Array(p.modelBinary), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    } finally {
      if (wasmBlobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        try {
          URL.revokeObjectURL(wasmBlobUrl);
        } catch {
          // Ignore
        }
      }
    }
    tokenizer = loadTokenizerFromJson(p.tokenizerJson);
    defaultPooling = p.poolingMode ?? 'mean';
    defaultMaxSeqLen = p.maxSeqLength ?? 512;

    // Warm probe to discover actual output dimension
    const probe = await runInference(['dimension check'], 16, defaultPooling);
    hiddenDim = probe[0]?.length ?? 0;

    return {
      result: {
        ok: true,
        dimensions: hiddenDim,
        inputNames: session.inputNames,
        outputNames: session.outputNames,
      },
    };
  }

  if (msg.type === 'embed') {
    const p = msg.payload as EmbedPayload;
    const vectors = await runInference(
      p.texts ?? [],
      p.maxSeqLength ?? defaultMaxSeqLen,
      p.poolingMode ?? defaultPooling
    );
    const buffers = vectors.map((v) => v.buffer);
    return {
      result: { vectors },
      transfer: buffers,
    };
  }

  throw new Error(`Unknown worker message type: ${String(msg.type)}`);
}

async function runInference(
  texts: string[],
  maxSeqLength: number,
  poolingMode: 'mean' | 'cls'
): Promise<Float32Array[]> {
  if (!session || !tokenizer || !ortModule) {
    throw new Error('ONNX session is not initialized');
  }
  if (texts.length === 0) return [];

  const ort = ortModule.default ?? ortModule;
  const encoded = tokenizer.encodeBatch(texts, maxSeqLength);
  const { batchSize, seqLength } = encoded;

  const feeds: Record<string, any> = {};
  const inputNames: string[] = Array.isArray(session.inputNames) ? session.inputNames : ['input_ids', 'attention_mask'];

  for (const name of inputNames) {
    if (name === 'input_ids') {
      feeds[name] = new ort.Tensor('int64', encoded.inputIds, [batchSize, seqLength]);
    } else if (name === 'attention_mask') {
      feeds[name] = new ort.Tensor('int64', encoded.attentionMask, [batchSize, seqLength]);
    } else if (name === 'token_type_ids') {
      feeds[name] = new ort.Tensor('int64', encoded.tokenTypeIds, [batchSize, seqLength]);
    }
  }

  const outputs = await session.run(feeds);
  const outTensor =
    outputs.sentence_embedding ??
    outputs.last_hidden_state ??
    outputs.token_embeddings ??
    outputs.pooler_output ??
    outputs[session.outputNames[0]];

  if (!outTensor || !outTensor.data || !outTensor.dims) {
    throw new Error('ONNX model did not return a valid embedding tensor');
  }

  const dims: number[] = outTensor.dims;
  const data = outTensor.data as Float32Array;
  const results: Float32Array[] = [];

  if (dims.length === 2) {
    // [batchSize, hiddenSize]
    const hiddenSize = dims[1];
    for (let b = 0; b < batchSize; b++) {
      const slice = data.subarray(b * hiddenSize, (b + 1) * hiddenSize);
      results.push(l2Normalize(slice));
    }
  } else if (dims.length === 3) {
    // [batchSize, seqLen, hiddenSize]
    const outSeqLen = dims[1];
    const hiddenSize = dims[2];
    for (let b = 0; b < batchSize; b++) {
      if (poolingMode === 'cls') {
        results.push(clsPoolNormalized(data, outSeqLen, hiddenSize, b));
      } else {
        results.push(meanPoolNormalized(data, encoded.attentionMask, outSeqLen, hiddenSize, b));
      }
    }
  } else {
    throw new Error(`Unsupported ONNX output tensor dims: ${JSON.stringify(dims)}`);
  }

  return results;
}

// Attach listener when running inside a Web Worker global scope
if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function' && typeof window === 'undefined') {
  self.addEventListener('message', async (event: MessageEvent) => {
    const req = event.data as WorkerRequest;
    if (!req || typeof req.id !== 'number') return;
    try {
      const { result, transfer } = await handleWorkerMessage(req);
      (self as any).postMessage({ id: req.id, ok: true, result }, transfer ?? []);
    } catch (err: any) {
      (self as any).postMessage({
        id: req.id,
        ok: false,
        error: err?.message || String(err),
      });
    }
  });
}
