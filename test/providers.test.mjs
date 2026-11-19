import test from 'node:test';
import assert from 'node:assert/strict';
import { importTs } from './_helper.mjs';

const { OllamaEmbeddingProvider } = await importTs('src/engines/ollama.ts');
const { OpenAICompatProvider } = await importTs('src/engines/openai.ts');
const { LocalOnnxProvider } = await importTs('src/engines/local-onnx.ts');
const { formatTextForModel } = await importTs('src/engines/provider.ts');

test('formatTextForModel applies E5 / Nomic / BGE query & passage prefixes accurately', () => {
  assert.equal(formatTextForModel('attention', 'query', 'Xenova/multilingual-e5-small'), 'query: attention');
  assert.equal(formatTextForModel('paper text', 'passage', 'Xenova/multilingual-e5-small'), 'passage: paper text');
  assert.equal(formatTextForModel('hi', 'query', 'nomic-embed-text'), 'search_query: hi');
  assert.match(formatTextForModel('概念', 'query', 'Xenova/bge-small-zh-v1.5'), /^为这个句子生成表示/);
  assert.equal(formatTextForModel('概念', 'passage', 'Xenova/bge-small-zh-v1.5'), '概念');
});

test('Ollama sends the Qwen3 retrieval instruction on queries only', async () => {
  const inputs = [];
  const provider = new OllamaEmbeddingProvider({
    model: 'qwen3-embedding:0.6b',
    http: async (_method, _url, opts) => {
      inputs.push(JSON.parse(opts.body).input);
      return { status: 200, json: { embeddings: [[3, 4]] }, text: '' };
    },
  });
  await provider.embedQuery('烷烃扩散');
  await provider.embedQuery(inputs[0]);
  await provider.embedPassages(['烷烃扩散']);
  assert.match(inputs[0], /^Instruct: .+\nQuery: 烷烃扩散$/);
  assert.equal(inputs[1], inputs[0]);
  assert.equal(inputs[2], '烷烃扩散');
});

test('OllamaEmbeddingProvider handles /api/embed and falls back to legacy /api/embeddings on 404', async () => {
  const calls = [];
  const provider = new OllamaEmbeddingProvider({
    baseUrl: 'http://localhost:11434/',
    model: 'bge-m3',
    http: async (method, url, opts) => {
      calls.push({ method, url, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/api/embed')) {
        return { status: 404, json: null, text: 'not found' };
      }
      if (url.endsWith('/api/embeddings')) {
        return { status: 200, json: { embedding: [3, 4] }, text: '' };
      }
      return { status: 200, json: { models: [{ name: 'bge-m3:latest' }] }, text: '' };
    },
  });

  const models = await provider.listModels();
  assert.deepEqual(models, ['bge-m3:latest']);

  const qVec = await provider.embedQuery('hello');
  assert.equal(qVec.length, 2);
  assert.ok(Math.abs(qVec[0] - 0.6) < 1e-5);
  assert.equal(calls[1].url, 'http://localhost:11434/api/embed');
  assert.equal(calls[2].url, 'http://localhost:11434/api/embeddings');

  // Subsequent call uses legacy endpoint directly without extra 404
  const pVecs = await provider.embedPassages(['a', 'b']);
  assert.equal(pVecs.length, 2);
  assert.equal(calls[3].url, 'http://localhost:11434/api/embeddings');
});

test('OpenAICompatProvider sorts out-of-order index responses and retries on HTTP 429', async () => {
  let attempts = 0;
  const provider = new OpenAICompatProvider({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'text-embedding-3-small',
    dimensions: 2,
    batchSize: 2,
    http: async (_method, _url, opts) => {
      attempts++;
      const payload = JSON.parse(opts.body);
      assert.equal(payload.dimensions, 2);
      if (attempts === 1) {
        return { status: 429, json: { error: { message: 'rate limit' } }, text: '' };
      }
      return {
        status: 200,
        json: {
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        },
        text: '',
      };
    },
  });

  const vecs = await provider.embedPassages(['first', 'second']);
  assert.equal(attempts, 2);
  assert.equal(vecs[0][0], 1);
  assert.equal(vecs[1][1], 1);
});

test('OpenAICompatProvider fails cleanly when API key is missing', async () => {
  const provider = new OpenAICompatProvider({ apiKey: '' });
  const status = await provider.getStatus();
  assert.equal(status.needsSetup, true);
  await assert.rejects(() => provider.embedQuery('hello'), /API key/i);
});

test('OpenAI-compatible Qwen and Flash connection checks and embeddings use the model batch limit', async () => {
  for (const model of ['qwen3.7-text-embedding', 'qwen3.7-text-embedding-flash']) {
    for (const batchSize of [0, 24]) {
      const batches = [];
      const provider = new OpenAICompatProvider({
        model,
        apiKey: 'test-key',
        batchSize,
        http: async (_method, _url, opts) => {
          const input = JSON.parse(opts.body).input;
          const batch = Array.isArray(input) ? input : [input];
          batches.push(batch.length);
          assert.ok(batch.length <= 20);
          return {
            status: 200,
            json: { data: batch.map((_, index) => ({ index, embedding: [1, 0] })) },
            text: '',
          };
        },
      });
      const connection = await provider.testConnection();
      assert.equal(connection.ok, true);
      assert.match(connection.message, /20 inputs per batch/);
      assert.equal((await provider.embedPassages(Array(41).fill('passage'))).length, 41);
      assert.deepEqual(batches, [20, 20, 20, 1], `${model} with configured batch size ${batchSize}`);
    }
  }
});

test('OpenAI-compatible responses reject duplicate input indices and mixed dimensions', async () => {
  let data;
  const provider = new OpenAICompatProvider({
    apiKey: 'test-key',
    batchSize: 2,
    http: async () => ({ status: 200, json: { data }, text: '' }),
  });
  data = [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }];
  await assert.rejects(provider.embedPassages(['first', 'second']), /invalid embedding indices/);
  data = [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1, 0] }];
  await assert.rejects(provider.embedPassages(['first', 'second']), /inconsistent embedding dimensions/);
});

test('Automatic batch probing verifies a gateway hint and shares the tested size', async () => {
  const batches = [];
  const provider = new OpenAICompatProvider({
    model: 'unlisted-model',
    apiKey: 'test-key',
    http: async (_method, _url, opts) => {
      const input = JSON.parse(opts.body).input;
      const size = Array.isArray(input) ? input.length : 1;
      batches.push(size);
      if (size > 9) {
        return {
          status: 400,
          json: { error: { message: 'batch size is invalid, it should not be larger than 9.' } },
          text: '',
        };
      }
      return { status: 200, json: { data: Array.from({ length: size }, (_, index) => ({
        index, embedding: [1, 0],
      })) }, text: '' };
    },
  });
  assert.deepEqual(await Promise.all([provider.getPassageBatchSize(), provider.getPassageBatchSize()]), [9, 9]);
  assert.deepEqual(batches, [24, 9]);
  assert.equal((await provider.embedPassages(Array(20).fill('passage'))).length, 20);
  assert.deepEqual(batches, [24, 9, 9, 9, 2]);
});

test('Automatic batch probing finds a valid size when the server omits a numeric limit', async () => {
  const batches = [];
  const provider = new OpenAICompatProvider({
    model: 'unlisted-model',
    apiKey: 'test-key',
    http: async (_method, _url, opts) => {
      const input = JSON.parse(opts.body).input;
      const size = Array.isArray(input) ? input.length : 1;
      batches.push(size);
      if (size > 7) {
        return { status: 422, json: { error: { message: 'Too many inputs' } }, text: '' };
      }
      return { status: 200, json: { data: Array.from({ length: size }, (_, index) => ({
        index, embedding: [1, 0],
      })) }, text: '' };
    },
  });
  const result = await provider.testConnection();
  assert.equal(result.ok, true);
  assert.match(result.message, /7 inputs per batch/);
  assert.deepEqual(batches, [24, 12, 6, 9, 7, 8]);
});

test('Automatic batch probing surfaces authentication and unrelated validation errors', async () => {
  for (const [status, message] of [[401, 'Invalid API key'], [400, 'Model is unavailable']]) {
    let calls = 0;
    const provider = new OpenAICompatProvider({
      model: 'unlisted-model',
      apiKey: 'test-key',
      http: async () => {
        calls++;
        return { status, json: { error: { message } }, text: '' };
      },
    });
    const connection = await provider.testConnection();
    assert.equal(connection.ok, false);
    assert.ok(connection.message.includes(message));
    assert.equal(calls, 1);
  }
});

test('LocalOnnxProvider downloads assets with mirror fallback and drives worker protocol', async () => {
  const memFiles = new Map();
  const fsMock = {
    exists: async (p) => memFiles.has(p),
    readBytes: async (p) => memFiles.get(p),
    readUTF8: async (p) => new TextDecoder().decode(memFiles.get(p)),
    writeBytes: async (p, data) => { memFiles.set(p, new Uint8Array(data)); },
    writeUTF8: async (p, str) => { memFiles.set(p, new TextEncoder().encode(str)); },
    makeDir: async () => {},
    move: async (s, d) => { memFiles.set(d, memFiles.get(s)); memFiles.delete(s); },
    remove: async (p) => { memFiles.delete(p); },
    join: (...parts) => parts.join('/'),
  };

  class MockWorker {
    constructor() {
      this.listeners = new Map();
    }
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    }
    removeEventListener(type) {
      this.listeners.delete(type);
    }
    postMessage(msg) {
      const reply = this.listeners.get('message');
      setImmediate(() => {
        if (msg.type === 'init') {
          reply?.({ data: { id: msg.id, ok: true, result: { ok: true, dimensions: 3 } } });
        } else if (msg.type === 'embed') {
          const vectors = msg.payload.texts.map(() => new Float32Array([0.577, 0.577, 0.577]));
          reply?.({ data: { id: msg.id, ok: true, result: { vectors } } });
        } else if (msg.type === 'dispose') {
          reply?.({ data: { id: msg.id, ok: true, result: { ok: true } } });
        }
      });
    }
    terminate() {}
  }

  const fetchedUrls = [];
  const provider = new LocalOnnxProvider({
    modelId: 'Xenova/multilingual-e5-small',
    mirror: 'hf-mirror',
    dataDir: '/tmp/zdata',
    workerScriptUrl: 'file:///workers/onnx-worker.js',
    fs: fsMock,
    workerFactory: () => new MockWorker(),
    fetchFn: async (url) => {
      fetchedUrls.push(String(url));
      // Simulate primary jsdelivr failing so it falls back to npmmirror
      if (String(url).includes('cdn.jsdelivr.net')) {
        return { ok: false, status: 502, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '4' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      };
    },
  });

  const beforeStatus = await provider.getStatus();
  assert.equal(beforeStatus.needsSetup, true);

  await provider.downloadModelAndRuntime();
  assert.ok(fetchedUrls.some((u) => u.includes('hf-mirror.com')));
  assert.ok(fetchedUrls.some((u) => u.includes('registry.npmmirror.com')));
  assert.ok(fetchedUrls.some((u) => u.endsWith('/ort.bundle.min.mjs')));
  assert.ok(!fetchedUrls.some((u) => u.includes('ort.wasm.bundle.min.mjs')));
  assert.ok(fetchedUrls.some((u) => u.endsWith('/ort-wasm-simd-threaded.wasm')));

  const afterStatus = await provider.getStatus();
  assert.equal(afterStatus.ready, true);
  assert.equal(afterStatus.neuralAvailable, true);

  const vec = await provider.embedQuery('注意力机制');
  assert.equal(vec.length, 3);
  await provider.dispose();
});

test('Local ONNX passage workers keep input order and report completed batches', { timeout: 5000 }, async () => {
  const requests = [];
  const workers = [];
  const provider = new LocalOnnxProvider({
    modelId: 'Xenova/multilingual-e5-small',
    dataDir: '/tmp/zdata',
    workerScriptUrl: 'file:///workers/onnx-worker.js',
    fs: {
      join: (...parts) => parts.join('/'),
      exists: async () => true,
      readBytes: async () => new Uint8Array([1]),
      readUTF8: async () => '{}',
    },
    workerFactory: () => {
      const listeners = new Map();
      const worker = {
        addEventListener: (type, fn) => listeners.set(type, fn),
        terminated: false,
        terminate() { this.terminated = true; },
        crash: () => listeners.get('error')({ message: 'Test worker crashed' }),
        postMessage(msg) {
          const reply = (result) => listeners.get('message')({ data: { id: msg.id, ok: true, result } });
          if (msg.type === 'init') {
            reply({ dimensions: 1 });
            return;
          }
          requests.push({
            worker,
            texts: msg.payload.texts,
            finish: () => reply({ vectors: msg.payload.texts.map((text) => [Number(text.split(' ').at(-1))]) }),
          });
        },
      };
      workers.push(worker);
      return worker;
    },
  });
  const flush = () => new Promise(setImmediate);
  try {
    const query = provider.embedQuery('42');
    await flush();
    assert.equal(workers.length, 1);
    assert.deepEqual(requests[0].texts, ['query: 42']);
    requests.shift().finish();
    assert.equal((await query)[0], 42);

    const progress = [];
    const texts = Array.from({ length: 17 }, (_, i) => String(i));
    const embed = provider.embedPassages(texts, (count) => progress.push(count));
    await flush();
    assert.equal(workers.length, 2);
    assert.equal(requests.length, 2);
    const [first, second] = requests.splice(0);
    assert.notEqual(first.worker, second.worker);
    assert.deepEqual(first.texts, texts.slice(0, 8).map((text) => `passage: ${text}`));
    assert.deepEqual(second.texts, texts.slice(8, 16).map((text) => `passage: ${text}`));
    second.finish();
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].worker, second.worker);
    requests.shift().finish();
    first.finish();
    assert.deepEqual((await embed).map((v) => v[0]), texts.map(Number));
    assert.deepEqual(progress, [8, 9, 17]);

    const metadata = provider.embedMetadata(['18', '19']);
    await flush();
    assert.equal(requests.length, 2);
    const [firstItem, secondItem] = requests.splice(0);
    assert.notEqual(firstItem.worker, secondItem.worker);
    assert.deepEqual(firstItem.texts, ['passage: 18']);
    assert.deepEqual(secondItem.texts, ['passage: 19']);
    secondItem.finish();
    firstItem.finish();
    assert.deepEqual((await metadata).map((vector) => vector[0]), [18, 19]);

    const interrupted = provider.embedPassages(texts);
    const interruptedCheck = assert.rejects(interrupted, /Test worker crashed/);
    await flush();
    assert.equal(requests.length, 2);
    workers[1].crash();
    await interruptedCheck;
    assert.ok(workers.every((worker) => worker.terminated));
    requests.length = 0;

    const resumed = provider.embedPassages(['1']);
    await flush();
    assert.equal(workers.length, 3);
    requests.shift().finish();
    assert.equal((await resumed)[0][0], 1);
  } finally {
    await provider.dispose();
  }
  assert.ok(workers.every((worker) => worker.terminated));
});

test('LocalOnnxProvider skips model download when customModelDir already has onnx/model_quantized.onnx', async () => {
  const memFiles = new Map([
    ['/custom-model/tokenizer.json', new TextEncoder().encode('{}')],
    ['/custom-model/onnx/model_quantized.onnx', new Uint8Array([9, 9])],
    ['/tmp/zdata/zotero-vectorize/runtime/ort.bundle.min.mjs', new TextEncoder().encode('export default {}')],
    ['/tmp/zdata/zotero-vectorize/runtime/ort-wasm-simd-threaded.wasm', new Uint8Array([0])],
  ]);
  const fsMock = {
    exists: async (p) => memFiles.has(p),
    readBytes: async (p) => memFiles.get(p),
    readUTF8: async (p) => new TextDecoder().decode(memFiles.get(p)),
    writeBytes: async (p, data) => { memFiles.set(p, new Uint8Array(data)); },
    writeUTF8: async (p, str) => { memFiles.set(p, new TextEncoder().encode(str)); },
    makeDir: async () => {},
    move: async (s, d) => { memFiles.set(d, memFiles.get(s)); memFiles.delete(s); },
    remove: async (p) => { memFiles.delete(p); },
    join: (...parts) => parts.join('/'),
  };
  class MockWorker {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    removeEventListener(type) { this.listeners.delete(type); }
    postMessage(msg) {
      const reply = this.listeners.get('message');
      setImmediate(() => {
        if (msg.type === 'init') reply?.({ data: { id: msg.id, ok: true, result: { ok: true, dimensions: 384 } } });
        else if (msg.type === 'dispose') reply?.({ data: { id: msg.id, ok: true, result: { ok: true } } });
      });
    }
    terminate() {}
  }

  let fetchCount = 0;
  const provider = new LocalOnnxProvider({
    modelId: 'Xenova/multilingual-e5-small',
    customModelDir: '/custom-model',
    dataDir: '/tmp/zdata',
    workerScriptUrl: 'file:///workers/onnx-worker.js',
    fs: fsMock,
    workerFactory: () => new MockWorker(),
    fetchFn: async () => {
      fetchCount++;
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new Uint8Array([1]).buffer };
    },
  });

  assert.equal(await provider.hasInstalledAssets(), true);
  await provider.downloadModelAndRuntime();
  assert.equal(fetchCount, 0);
  await provider.dispose();
});

test('LocalOnnxProvider and DEFAULT_CONFIG default to Xenova/paraphrase-multilingual-MiniLM-L12-v2 and honor preset poolingMode', async () => {
  const { DEFAULT_CONFIG } = await importTs('src/zotero/config.ts');
  assert.equal(DEFAULT_CONFIG.localModelId, 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  assert.equal(DEFAULT_CONFIG.hybridSemanticWeight, 0.85);

  const initPayloads = [];
  for (const modelId of [undefined, 'onnx-community/gte-multilingual-base', 'Xenova/paraphrase-multilingual-mpnet-base-v2']) {
    const slug = (modelId || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2').replace('/', '--');
    const memFiles = new Map([
      [`/zdata/zotero-vectorize/models/${slug}/model_quantized.onnx`, new Uint8Array([1, 2])],
      [`/zdata/zotero-vectorize/models/${slug}/tokenizer.json`, new TextEncoder().encode('{}')],
      ['/zdata/zotero-vectorize/runtime/ort.bundle.min.mjs', new TextEncoder().encode('export default {}')],
      ['/zdata/zotero-vectorize/runtime/ort-wasm-simd-threaded.wasm', new Uint8Array([0])],
    ]);
    const fsMock = {
      exists: async (p) => memFiles.has(p),
      readBytes: async (p) => memFiles.get(p),
      readUTF8: async (p) => new TextDecoder().decode(memFiles.get(p)),
      writeBytes: async () => {},
      writeUTF8: async () => {},
      makeDir: async () => {},
      move: async () => {},
      remove: async () => {},
      join: (...parts) => parts.join('/'),
    };
    class CapturingWorker {
      constructor() { this.listeners = new Map(); }
      addEventListener(type, fn) { this.listeners.set(type, fn); }
      removeEventListener(type) { this.listeners.delete(type); }
      postMessage(msg) {
        const reply = this.listeners.get('message');
        if (msg.type === 'init') {
          initPayloads.push(msg.payload);
          setImmediate(() => reply?.({ data: { id: msg.id, ok: true, result: { ok: true, dimensions: 768 } } }));
        } else if (msg.type === 'embed') {
          const vectors = msg.payload.texts.map(() => new Float32Array([1, 0, 0]));
          setImmediate(() => reply?.({ data: { id: msg.id, ok: true, result: { vectors } } }));
        } else if (msg.type === 'dispose') {
          setImmediate(() => reply?.({ data: { id: msg.id, ok: true, result: { ok: true } } }));
        }
      }
      terminate() {}
    }

    const provider = new LocalOnnxProvider({
      modelId,
      dataDir: '/zdata',
      workerScriptUrl: 'file:///workers/onnx-worker.js',
      fs: fsMock,
      workerFactory: () => new CapturingWorker(),
    });
    assert.ok(provider.getModelDir().endsWith(slug));
    const vec = await provider.embedQuery('cross-lingual test');
    assert.equal(vec.length, 3);
    await provider.dispose();
  }

  assert.equal(initPayloads[0].poolingMode, 'mean');
  assert.equal(initPayloads[1].poolingMode, 'cls');
  assert.equal(initPayloads[2].poolingMode, 'mean');
});

test('onnx-worker handleWorkerMessage initializes Blob ORT module, runs mean-pooled inference, and transfers buffers', async () => {
  const { handleWorkerMessage } = await importTs('src/workers/onnx-worker.ts');
  const fakeOrtSource = `
    export const env = { wasm: {} };
    export class Tensor {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    }
    export const InferenceSession = {
      async create() {
        return {
          inputNames: ['input_ids', 'attention_mask'],
          outputNames: ['last_hidden_state'],
          async run(feeds) {
            const [batchSize, seqLen] = feeds.input_ids.dims;
            const hidden = 2;
            const out = new Float32Array(batchSize * seqLen * hidden);
            for (let b = 0; b < batchSize; b++) {
              for (let t = 0; t < seqLen; t++) {
                out[(b * seqLen + t) * hidden + 0] = 3;
                out[(b * seqLen + t) * hidden + 1] = 4;
              }
            }
            return { last_hidden_state: { data: out, dims: [batchSize, seqLen, hidden] } };
          },
          async release() {}
        };
      }
    };
  `;
  const tokenizerJson = JSON.stringify({
    model: {
      type: 'WordPiece',
      vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, hello: 4, world: 5 },
    },
  });

  // Node ESM loader supports data: URLs rather than blob: URLs; bridge createObjectURL in this unit test
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const origImportScripts = globalThis.importScripts;
  const blobPayloads = new Map();
  let lastCreatedWasmUrl = '';
  URL.createObjectURL = (blob) => {
    if (blob.type === 'text/javascript') {
      const patched = fakeOrtSource.replace(
        'async create() {',
        'async create() { globalThis.__zvCapturedWasmEnv = { ...env.wasm };'
      );
      const dataUrl = `data:text/javascript;base64,${Buffer.from(patched, 'utf8').toString('base64')}`;
      blobPayloads.set(dataUrl, blob);
      return dataUrl;
    }
    lastCreatedWasmUrl = origCreate(blob);
    return lastCreatedWasmUrl;
  };
  URL.revokeObjectURL = (u) => {
    if (!blobPayloads.delete(u)) origRevoke(u);
  };

  try {
    // In Web Worker context (importScripts defined), wasmPaths.wasm must be used and wasmBinary omitted
    globalThis.importScripts = () => {};
    const initRes = await handleWorkerMessage({
      id: 1,
      type: 'init',
      payload: {
        ortModuleCode: fakeOrtSource,
        wasmBinary: new Uint8Array([0, 97, 115, 109]).buffer,
        modelBinary: new Uint8Array([1, 2, 3, 4]).buffer,
        tokenizerJson,
        poolingMode: 'mean',
        maxSeqLength: 16,
      },
    });
    assert.equal(initRes.result.ok, true);
    assert.equal(initRes.result.dimensions, 2);
    assert.equal(globalThis.__zvCapturedWasmEnv?.wasmPaths?.wasm, lastCreatedWasmUrl);
    assert.equal(globalThis.__zvCapturedWasmEnv?.wasmBinary, undefined);

    const embRes = await handleWorkerMessage({
      id: 2,
      type: 'embed',
      payload: { texts: ['hello', 'world'], maxSeqLength: 16 },
    });
    assert.equal(embRes.result.vectors.length, 2);
    assert.equal(embRes.transfer.length, 2);
    assert.ok(Math.abs(embRes.result.vectors[0][0] - 0.6) < 1e-5);
    assert.ok(Math.abs(embRes.result.vectors[0][1] - 0.8) < 1e-5);

    const dispRes = await handleWorkerMessage({ id: 3, type: 'dispose' });
    assert.equal(dispRes.result.ok, true);
  } finally {
    delete globalThis.__zvCapturedWasmEnv;
    if (origImportScripts === undefined) delete globalThis.importScripts;
    else globalThis.importScripts = origImportScripts;
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

test('LocalOnnxProvider default workerFactory loads jar URL containing @ via Zotero.File.getResourceAsync and revokes Blob URL on dispose', async () => {
  const memFiles = new Map([
    ['/zdata/zotero-vectorize/runtime/ort.bundle.min.mjs', new TextEncoder().encode('export default {}')],
    ['/zdata/zotero-vectorize/runtime/ort-wasm-simd-threaded.wasm', new Uint8Array([0, 97, 115, 109])],
    ['/zdata/zotero-vectorize/models/Xenova--multilingual-e5-small/model_quantized.onnx', new Uint8Array([1, 2])],
    ['/zdata/zotero-vectorize/models/Xenova--multilingual-e5-small/tokenizer.json', new TextEncoder().encode('{}')],
  ]);
  const fsMock = {
    exists: async (p) => memFiles.has(p),
    readBytes: async (p) => memFiles.get(p),
    readUTF8: async (p) => new TextDecoder().decode(memFiles.get(p)),
    writeBytes: async (p, d) => { memFiles.set(p, new Uint8Array(d)); },
    writeUTF8: async (p, s) => { memFiles.set(p, new TextEncoder().encode(s)); },
    makeDir: async () => {},
    move: async (s, d) => { memFiles.set(d, memFiles.get(s)); memFiles.delete(s); },
    remove: async (p) => { memFiles.delete(p); },
    join: (...parts) => parts.join('/'),
  };

  const workerScriptUrl = 'jar:file:///tmp/extensions/zotero-vectorize@yckbz.org.xpi!/workers/onnx-worker.js';
  const origZotero = globalThis.Zotero;
  const origWorker = globalThis.Worker;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;

  const resourceCalls = [];
  const createdWorkerUrls = [];
  const revokedUrls = [];
  let suspendEmbedding;

  globalThis.Zotero = {
    File: {
      getResourceAsync: async (u) => {
        resourceCalls.push(u);
        return '/* worker bundle */';
      },
      getContentsFromURL: () => {
        throw new Error('XHR should not be needed when getResourceAsync succeeds');
      },
    },
  };
  URL.createObjectURL = () => 'blob:zotero-test/worker-1';
  URL.revokeObjectURL = (u) => { revokedUrls.push(u); };
  globalThis.Worker = class FakeWorker {
    constructor(url) {
      createdWorkerUrls.push(url);
      this.listeners = new Map();
    }
    addEventListener(t, fn) { this.listeners.set(t, fn); }
    removeEventListener(t) { this.listeners.delete(t); }
    postMessage(msg) {
      const reply = this.listeners.get('message');
      if (msg.type === 'embed' && suspendEmbedding) {
        suspendEmbedding();
        return;
      }
      setImmediate(() => {
        if (msg.type === 'init') reply?.({ data: { id: msg.id, ok: true, result: { ok: true, dimensions: 3 } } });
        else if (msg.type === 'embed') reply?.({ data: { id: msg.id, ok: true, result: { vectors: [new Float32Array([0.6, 0.8, 0])] } } });
        else if (msg.type === 'dispose') reply?.({ data: { id: msg.id, ok: true, result: { ok: true } } });
      });
    }
    terminate() {}
  };

  try {
    const provider = new LocalOnnxProvider({
      modelId: 'Xenova/multilingual-e5-small',
      dataDir: '/zdata',
      workerScriptUrl,
      fs: fsMock,
    });
    const res = await provider.testConnection();
    assert.equal(res.ok, true);
    assert.equal(res.dimensions, 3);
    assert.deepEqual(resourceCalls, [workerScriptUrl]);
    assert.deepEqual(createdWorkerUrls, ['blob:zotero-test/worker-1']);
    const started = new Promise((resolve) => { suspendEmbedding = resolve; });
    const interrupted = assert.rejects(provider.embedQuery('in flight'), /provider was closed/);
    await started;
    await provider.dispose();
    await interrupted;
    assert.deepEqual(revokedUrls, ['blob:zotero-test/worker-1']);
  } finally {
    if (origZotero === undefined) delete globalThis.Zotero;
    else globalThis.Zotero = origZotero;
    if (origWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = origWorker;
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});
