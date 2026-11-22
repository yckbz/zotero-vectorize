import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importTs } from './_helper.mjs';
import { SqliteConnection } from './_sqlite.mjs';

const PREFIX = 'extensions.zotero-vectorize.';
const MODEL_REVISION = 'a'.repeat(32) + ':' + 'b'.repeat(32);
const SHARED_FILE = 'zotero-vectorize.zvindex';
const TITLE = 'Zotero Vectorize Shared Index';
const digest = (data) => createHash('md5').update(data).digest('hex');
const pdfBytes = Buffer.from('unchanged synthetic PDF');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zv-native-sync-'));
  const { VectorizeService } = await importTs('src/zotero/service.ts');
  const { jumpToSearchHit } = await importTs('src/zotero/navigation.ts');
  const { OpenAICompatProvider } = await importTs('src/engines/openai.ts');
  const { OllamaEmbeddingProvider } = await importTs('src/engines/ollama.ts');
  const remote = new Map();
  let nextKey = 0;
  const allocateKey = () => 'PART' + String(++nextKey).padStart(4, '0');
  const transport = {
    remote, offline: false, errors: 0, uploads: 0, downloads: 0, syncs: 0,
    partUploads: [], partDownloads: [], erased: [], missingMetadata: new Set(), missingFiles: new Set(),
    missingProps: new Set(), remoteHashes: new Map(), probes: [], forcedUploads: [],
    get manifest() {
      const head = remote.get('INDEX001');
      return head ? JSON.parse(String(head.bytes)) : null;
    },
    set manifest(data) {
      remote.set('INDEX001', { title: TITLE, filename: SHARED_FILE, bytes: Buffer.from(JSON.stringify(data) + '\n') });
    },
    get bytes() {
      const manifest = this.manifest;
      if (!manifest) return null;
      const parts = Buffer.concat(manifest.parts.map(({ key }) => remote.get(key).bytes));
      const count = String(parts).split('\n').length - 1;
      return Buffer.concat([Buffer.from(JSON.stringify(manifest.snapshot) + '\n'), parts,
        Buffer.from(JSON.stringify(['end', count]) + '\n')]);
    },
    set bytes(bytes) {
      const [header, ...lines] = String(bytes).trimEnd().split('\n');
      const snapshot = JSON.parse(header);
      if (JSON.parse(lines.at(-1))[0] === 'end') lines.pop();
      const payload = Buffer.from(lines.join('\n') + '\n');
      const content = createHash('sha256').update(payload).digest('hex');
      const key = allocateKey();
      remote.set(key, { title: `${TITLE} Part ${snapshot.publisher} ${content}`,
        filename: 'zotero-vectorize-shard.zvpart', bytes: payload });
      this.manifest = { type: 'zotero-vectorize-index-manifest', version: 3, snapshot, partBytes: 32 * 1024 * 1024,
        parts: [{ key, bytes: payload.length, digest: digest(payload), content, end: null }] };
    },
  };
  const live = new Set();
  t.after(async () => {
    for (const service of live) await service.shutdown();
    delete globalThis.Zotero;
    delete globalThis.IOUtils;
    delete globalThis.PathUtils;
    delete globalThis.ChromeUtils;
    delete globalThis.Components;
    await fs.rm(root, { recursive: true, force: true });
  });
  globalThis.PathUtils = { join: path.join, parent: path.dirname, filename: path.basename };
  globalThis.ChromeUtils = {
    base64URLEncode: (bytes) => Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_'),
    base64URLDecode: (text) => {
      if (!/^(?:[\w-]{4})*(?:[\w-]{2}==|[\w-]{3}=)?$/.test(text)) throw new Error('Invalid Base64URL');
      return new Uint8Array(Buffer.from(text, 'base64url')).buffer;
    },
  };
  // Model the ZIP APIs with the fixture's raw single-entry attachment.
  globalThis.Components = {
    interfaces: {},
    classes: {
      '@mozilla.org/libjar/zip-reader;1': {
        createInstance: () => {
          let contents;
          return {
            open: (file) => { contents = readFileSync(file); },
            findEntries: () => {
              let unread = true;
              return { hasMore: () => unread, getNext: () => { unread = false; return SHARED_FILE; } };
            },
            getEntry: () => ({ realSize: contents.length }),
            getInputStream: () => contents,
            close() {},
          };
        },
      },
      '@mozilla.org/binaryinputstream;1': {
        createInstance: () => {
          let input;
          return {
            setInputStream: (stream) => { input = stream; },
            readByteArray: (length) => Array.from(input.subarray(0, length)),
            close() {},
          };
        },
      },
    },
  };
  globalThis.IOUtils = {
    makeDirectory: (file) => fs.mkdir(file, { recursive: true }),
    stat: async (file) => {
      const stat = await fs.lstat(file);
      return { type: stat.isFile() ? 'regular' : 'other', size: stat.size, lastModified: stat.mtimeMs };
    },
    exists: (file) => fs.access(file).then(() => true, () => false),
    read: async (file, options = {}) => {
      if (!options.maxBytes) return fs.readFile(file);
      const handle = await fs.open(file);
      try {
        const buffer = Buffer.alloc(options.maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, options.offset);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    write: (file, bytes, options) => fs.writeFile(file, bytes, {
      flag: options?.mode === 'append' ? 'a' : options?.mode === 'create' ? 'wx' : 'w',
    }),
    copy: fs.copyFile,
    move: fs.rename,
    setModificationTime: (file, modified) => fs.utimes(file, modified / 1000, modified / 1000),
    remove: (file, options) => fs.rm(file, { force: Boolean(options?.ignoreAbsent), recursive: Boolean(options?.recursive) }),
    getChildren: async (dir) => (await fs.readdir(dir)).map((file) => path.join(dir, file)),
  };

  async function createDevice(name, shift, role, localEngine = 'local-onnx') {
    const dir = path.join(root, name);
    const storage = (key) => path.join(dir, 'storage', key);
    const pdfFile = path.join(storage('ATTACH01'), 'paper.pdf');
    const prefs = new Map([
      [PREFIX + 'engine', localEngine],
      [PREFIX + 'openaiApiKey', 'local-secret'],
      [PREFIX + 'localMaxSeqLength', shift ? 128 : 256],
      [PREFIX + 'chunkSize', shift ? 700 : 512],
      [PREFIX + 'maxPdfPages', shift ? 20 : 9],
      [PREFIX + 'syncRole', role],
      [PREFIX + 'autoIndexOnStartup', false],
      [PREFIX + 'autoIndexOnChange', false],
      ['sync.storage.enabled', true],
      ['sync.storage.verified', true],
    ]);
    const flags = { pdfAvailable: shift === 0, revision: MODEL_REVISION, account: 101, failSharedQuery: false };
    const events = { calls: [], opened: [], lastModelSetup: null, cloudRequests: [] };
    const items = new Map();
    const makePaper = (id, key, libraryID, title, attachments = []) => ({
      id, key, libraryID, itemType: 'journalArticle',
      getDisplayTitle: () => title,
      getField: (field) => field === 'title' ? title : '',
      isRegularItem: () => true, isAttachment: () => false, isPDFAttachment: () => false,
      getAttachments: () => attachments,
    });
    items.set(1 + shift, makePaper(1 + shift, 'PAPER001', 1, 'Shared paper about hydrogen diffusion', [2 + shift]));
    items.set(3 + shift, makePaper(3 + shift, 'GRP00001', 2, 'Private group spectra'));
    items.set(2 + shift, {
      id: 2 + shift, key: 'ATTACH01', libraryID: 1, parentItemID: 1 + shift,
      getDisplayTitle: () => 'Paper PDF',
      getField: (field) => field === 'title' ? 'Paper PDF' : '',
      isRegularItem: () => false, isAttachment: () => true, isPDFAttachment: () => true,
      isStoredFileAttachment: () => true,
      getFilePathAsync: async () => flags.pdfAvailable ? pdfFile : false,
      get attachmentHash() {
        return flags.pdfAvailable ? fs.readFile(pdfFile).then(digest) : undefined;
      },
      get attachmentModificationTime() { return flags.pdfAvailable ? 321 + shift : undefined; },
    });
    await fs.mkdir(storage('ATTACH01'), { recursive: true });
    if (flags.pdfAvailable) await fs.writeFile(pdfFile, pdfBytes);

    const observers = new Map();
    let nextItemId = 4 + shift;
    const makeAttachment = (key, attachmentFilename, title) => ({
      id: nextItemId++, key, libraryID: 1, itemType: 'attachment', attachmentFilename,
      attachmentSyncState: 0,
      isRegularItem: () => false, isAttachment: () => true, isPDFAttachment: () => false, isStoredFileAttachment: () => true,
      getField: (field) => field === 'title' ? title : '',
    });
    const carrier = makeAttachment('INDEX001', SHARED_FILE, TITLE);
    const eraseQueue = new Set();
    const attachmentPath = (item) => path.join(storage(item.key), item.attachmentFilename);
    async function downloadFile(item) {
      if (transport.beforeDownload) await transport.beforeDownload(item);
      if (transport.downloadUnavailable) return false;
      if (transport.offline) throw new Error('offline');
      if (item.key === 'ATTACH01') {
        await fs.writeFile(pdfFile, pdfBytes);
        flags.pdfAvailable = true;
      } else if (remote.has(item.key) && !transport.missingFiles.has(item.key)) {
        const file = remote.get(item.key);
        if (item === carrier) transport.downloads++;
        else transport.partDownloads.push(item.key);
        await fs.mkdir(storage(item.key), { recursive: true });
        await fs.writeFile(attachmentPath(item), file.bytes);
        item.attachmentSyncedHash = digest(file.bytes);
        item.attachmentSyncState = 2;
      }
    }
    const zotero = {
      DBConnection: SqliteConnection,
      Users: { getCurrentUserID: () => flags.account },
      Prefs: { get: (key) => prefs.get(key), set: (key, value) => prefs.set(key, value),
        registerObserver: () => Symbol(), unregisterObserver() {} },
      Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1, libraryType: 'user' }, { libraryID: 2, libraryType: 'group' }] },
      Items: {
        get: (id) => items.get(id),
        getAsync: async (id) => items.get(id),
        getAll: async (libraryID) => [...items.values()].filter((item) => item.libraryID === libraryID && !item.deleted),
        getByLibraryAndKeyAsync: async (libraryID, key) => [...items.values()].find((item) => item.libraryID === libraryID && item.key === key),
        erase: async (ids) => {
          for (const id of ids) {
            const item = items.get(id);
            eraseQueue.add(item.key);
            items.delete(id);
            await fs.rm(storage(item.key), { recursive: true, force: true });
          }
        },
      },
      Attachments: {
        getStorageDirectory: (item) => ({ path: storage(item.key) }),
        importFromFile: async ({ file, libraryID, title }) => {
          assert.equal(libraryID, 1);
          const filename = path.basename(file);
          const item = filename === SHARED_FILE ? carrier : makeAttachment(allocateKey(), filename, title);
          await fs.mkdir(storage(item.key), { recursive: true });
          await fs.copyFile(file, attachmentPath(item));
          items.set(item.id, item);
          await transport.afterImport?.(item);
          return item;
        },
      },
      HTTP: {
        request: async (method, { key, kind }, options) => {
          assert.equal(options.noCache, true);
          assert.deepEqual(options.successCodes, [200, 404]);
          assert.equal(method, kind === 'prop' || options.responseType === 'arraybuffer' ? 'GET' : 'HEAD');
          transport.probes.push([method, key]);
          await transport.beforeProbe?.(method, key);
          if (transport.offline) throw new Error('offline');
          const file = remote.get(key);
          const missing = kind === 'prop' ? transport.missingProps : transport.missingFiles;
          if (!file || missing.has(key)) return { status: 404 };
          if (options.responseType === 'arraybuffer') return { status: 200, response: new Uint8Array(file.bytes).buffer };
          if (kind === 'zip') return { status: 200, getResponseHeader: () => String(file.bytes.length) };
          const fields = { hash: transport.remoteHashes.get(key) ?? digest(file.bytes), mtime: '1234567890' };
          const root = { localName: 'properties', getElementsByTagName: (name) => [{ textContent: fields[name] }] };
          return { status: 200, response: { documentElement: root } };
        },
      },
      File: { pathToFile: (file) => file },
      Notifier: {
        registerObserver: (obs, _types, id) => { observers.set(id, obs); return id; },
        unregisterObserver: (id) => observers.delete(id),
      },
      Sync: {
        Runner: {
          enabled: true, syncInProgress: false, delayIndefinite: () => () => {},
          getStorageController: () => ({
            _init: async () => {},
            _getItemURI: ({ key }) => ({ key, kind: 'zip' }),
            _getItemPropertyURI: ({ key }) => ({ key, kind: 'prop' }),
          }),
          async sync({ libraries, onError }) {
            assert.deepEqual(libraries, [1]);
            transport.syncs++;
            if (transport.offline) {
              transport.errors++;
              onError(new Error('offline'));
            } else if (!shift) {
              for (const item of items.values()) {
                if (![0, 3].includes(item.attachmentSyncState)) continue;
                try {
                  await transport.beforeUpload?.(item);
                } catch (error) {
                  onError(error);
                  return;
                }
                const bytes = await fs.readFile(attachmentPath(item));
                remote.set(item.key, { title: item.getField('title'), filename: item.attachmentFilename, bytes });
                transport.missingFiles.delete(item.key);
                transport.missingProps.delete(item.key);
                transport.remoteHashes.delete(item.key);
                item.attachmentSyncedHash = digest(bytes);
                item.attachmentSyncState = 2;
                if (item === carrier) transport.uploads++;
                else transport.partUploads.push(item.key);
              }
              for (const key of eraseQueue) {
                try {
                  await transport.beforeErase?.(key);
                } catch (error) {
                  onError(error);
                  return;
                }
                remote.delete(key);
                eraseQueue.delete(key);
                transport.erased.push(key);
              }
            } else {
              for (const [key, file] of remote) {
                if (transport.missingMetadata.has(key) || [...items.values()].some((item) => item.key === key)) continue;
                const item = key === carrier.key ? carrier : makeAttachment(key, file.filename, file.title);
                items.set(item.id, item);
              }
            }
          },
          downloadFile,
        },
        Storage: { Local: {
          SYNC_STATE_IN_SYNC: 2, SYNC_STATE_IN_CONFLICT: 5,
          getModeForLibrary: () => 'webdav',
          async updateSyncStates(moved, state) {
            for (const item of moved) {
              item.attachmentSyncState = state === 'force_upload' ? 3 : 0;
              if (state === 'force_upload') transport.forcedUploads.push(item.key);
            }
          },
        } },
      },
      PDFWorker: { getFullText: async () => {
        events.calls.push('extract');
        return { text: 'Hydrogen motion in nanotubes.\fDiffusion selectivity and confinement.', extractedPages: 2, totalPages: 2 };
      } },
      Utilities: { randomString: () => 'P'.repeat(24), Internal: { md5Async: async (file) => digest(await fs.readFile(file)) } },
      Reader: { open: async (id, location) => { events.opened.push({ id, ...location }); } },
      logError() {},
      locale: 'en-US',
    };
    async function start() {
      globalThis.Zotero = zotero;
      const service = new VectorizeService({ dataDir: dir, rootURI: 'file:///sync-test/' });
      if (flags.partBytes) service.indexSync.partBytes = () => flags.partBytes;
      live.add(service);
      const createProvider = service.providerManager.createProvider.bind(service.providerManager);
      service.providerManager.createProvider = (config) => {
        const { engine } = config;
        if (engine === 'local-onnx' && flags.useLocalOnnx) return createProvider(config);
        if (engine === 'ollama' && flags.ollamaHttp) {
          return new OllamaEmbeddingProvider({ baseUrl: config.ollamaUrl, model: config.ollamaModel, http: flags.ollamaHttp });
        }
        if (engine === 'openai' && flags.useCloudHttp) {
          return new OpenAICompatProvider({
            baseUrl: config.openaiBaseUrl, apiKey: config.openaiApiKey,
            model: config.openaiModel, dimensions: config.openaiDimensions, batchSize: config.openaiBatchSize,
            async http(method, url, request) {
              const body = JSON.parse(request.body);
              events.cloudRequests.push({ method, url, authorization: request.headers.Authorization, ...body });
              const inputs = Array.isArray(body.input) ? body.input : [body.input];
              return { status: 200, text: '', json: { data: inputs.map((_, index) => ({ index,
                embedding: Array.from({ length: flags.cloudDimensions ?? 2 }, (_, i) => i === 0 ? 1 : 0),
              })) } };
            },
          });
        }
        const model = engine === 'local-onnx' ? config.localModelId : engine === 'ollama' ? config.ollamaModel : config.openaiModel;
        const fp = `${engine}:${model}:2`;
        const vector = () => new Float32Array([1, 0]);
        return {
          engine, model,
          getModelRevision: async () => {
            flags.onReadRevision?.();
            return engine === 'openai' ? null : flags.revision;
          },
          getModelFingerprint: () => fp, getPassageBatchSize: () => 16,
          getStatus: async () => ({ modelFingerprint: fp, dimensions: 2,
            statusMessage: model, neuralAvailable: true }),
          testConnection: async () => {
            events.lastModelSetup = config;
            return { ok: true, dimensions: 2 };
          },
          embedQuery: async () => {
            if (shift && engine === 'local-onnx' && flags.failSharedQuery) throw new Error('embedding endpoint unavailable');
            return vector();
          },
          embedPassages: async (texts) => {
            events.calls.push('embed');
            return texts.map(vector);
          },
          dispose: async () => {},
        };
      };
      flags.beforeInit?.(service);
      await service.init();
      return service;
    }

    const shutdown = async (service) => {
      await service.shutdown();
      live.delete(service);
    };
    return { dir, start, shutdown, prefs, zotero, items, events, flags, pdfFile, carrier, observers, makePaper };
  }
  return { createDevice, transport, jumpToSearchHit };
}

test('shared coverage follows the accepted version through updates, outages, and role changes', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  await publisher.shutdown(source);

  const receiver = await createDevice('subscriber', 100, 'receive');
  const destination = await receiver.start();
  const changes = [];
  destination.indexSync.subscribe(() => changes.push(destination.indexSync.getSharedStats()));
  await destination.indexSync.syncNow();
  const first = destination.indexSync.getSharedStats();
  assert.deepEqual(first, { indexedItems: 1, vectorizedItems: 1, indexedChunks: 2, vectorizedChunks: 2,
    modelFingerprint: 'local-onnx:Xenova/paraphrase-multilingual-MiniLM-L12-v2:2', publishedAt: first.publishedAt });

  const [manifest, ...records] = String(transport.bytes).trimEnd().split('\n').map(JSON.parse);
  const [item, pdf, chunk] = records;
  assert.deepEqual([item[0], pdf[0], chunk[0]], ['item', 'pdf', 'chunk']);
  item[2] = '0'.repeat(16); // Receiver has a different version of this item's metadata.
  manifest.generation++;
  transport.bytes = Buffer.from([manifest, item, pdf, chunk, ['end', 3]].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const localRows = await destination.store.loadAll();
  await destination.indexSync.syncNow();
  const second = { ...first, publishedAt: manifest.generation, vectorizedItems: 0, indexedChunks: 1, vectorizedChunks: 1 };
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.deepEqual(changes.at(-1), second);

  receiver.zotero.Sync.Runner.syncInProgress = true;
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'waiting');
  assert.deepEqual(changes.at(-1), second);
  receiver.zotero.Sync.Runner.syncInProgress = false;

  transport.downloadUnavailable = true;
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'webdav');
  assert.deepEqual(changes.at(-1), second);
  assert.deepEqual(await destination.store.loadAll(), localRows);

  await destination.clearIndex();
  assert.deepEqual(destination.indexSync.getSharedStats(), second);
  receiver.items.get(101).deleted = true;
  for (const { notify } of receiver.observers.values()) notify('trash', 'item', [101]);
  assert.deepEqual(changes.at(-1), { ...second, indexedItems: 0, indexedChunks: 0, vectorizedChunks: 0 });
  destination.indexSync.setRole('off');
  assert.equal(destination.indexSync.getStatus().phase, 'off');
  assert.equal(changes.at(-1), null);
});

test('Zotero publishes a manifest and private-library indexes stay local while a fresh profile searches the shared index', async (t) => {
  const { createDevice, transport, jumpToSearchHit } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'off');
  let source = await publisher.start();
  await source.startIndexing();
  assert.equal(transport.syncs, 0);
  source.indexSync.setRole('publish');
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.equal(transport.uploads, 1);
  assert.match(String(transport.bytes), /PAPER001/);
  assert.doesNotMatch(String(transport.bytes), /GRP00001|Private group spectra|local-secret/);
  await source.indexSync.syncNow();
  assert.equal(transport.uploads, 1);
  source.updateConfig({ hybridSemanticWeight: 0.25 });
  publisher.flags.onReadRevision = () => {
    publisher.flags.onReadRevision = undefined;
    source.updateConfig({ enableTopSearchPopover: false });
  };
  await source.indexSync.syncNow();
  assert.equal(transport.uploads, 2);
  assert.deepEqual(transport.partUploads, transport.manifest.parts.map((part) => part.key));
  assert.deepEqual(transport.erased, []);
  assert.equal(publisher.items.get(4), publisher.carrier);
  await publisher.shutdown(source);

  const subscriber = await createDevice('subscriber', 100, 'receive', 'openai');
  const destination = await subscriber.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.equal(destination.getConfig().engine, 'openai');
  assert.equal(destination.getConfig().chunkSize, 700);
  assert.equal(destination.getSearchConfig().engine, 'local-onnx');
  assert.equal(destination.getSearchConfig().chunkSize, 512);
  assert.equal(destination.getSearchConfig().maxPdfPages, 9);
  assert.equal(destination.getSearchConfig().hybridSemanticWeight, 0.25);
  assert.equal(subscriber.events.lastModelSetup.localMaxSeqLength, 256);

  await destination.indexer.startLibraryScan(false, true);
  assert.deepEqual(subscriber.events.calls, ['embed'], 'Only the local group needs document embeddings');
  assert.equal(destination.searchIndex.getItemById(101), undefined);
  assert.ok(destination.searchIndex.getItemById(103)?.vector);
  const result = await destination.search('diffusion', { mode: 'fulltext', filterItemIDs: new Set([101]) });
  const hit = result.hits[0];
  assert.equal(hit.itemID, 101);
  assert.equal(hit.bestChunk.attachmentID, 102);
  assert.equal(hit.bestChunk.pageIndex, 1);
  assert.equal(result.diagnostics.vectorSearchUsed, true);
  assert.equal(subscriber.flags.pdfAvailable, false);
  await jumpToSearchHit(hit);
  assert.deepEqual(subscriber.events.opened, [{ id: 102, pageIndex: 1 }]);
  await fs.writeFile(subscriber.pdfFile, 'replaced PDF');
  await jumpToSearchHit(hit);
  assert.equal(subscriber.events.opened.length, 1, 'The shared page target must not open a different file');

  subscriber.items.get(101).deleted = true;
  for (const { notify } of subscriber.observers.values()) notify('trash', 'item', [101]);
  assert.equal((await destination.search('diffusion', { mode: 'fulltext' })).hits.length, 0);
});

test('receiving a shorter shared PDF index preserves searches for local pages', async (t) => {
  const { createDevice, transport } = await setup(t);
  const query = 'spectrochemical calibration';
  const pages = Array.from({ length: 12 }, (_, index) => index === 9
    ? 'The spectrochemical calibration is described in this measurement protocol.'
    : 'Hydrogen motion and diffusion selectivity in confined nanotubes.');
  const preparePdf = async (device) => {
    device.flags.pdfAvailable = true;
    await fs.writeFile(device.pdfFile, pdfBytes);
    device.prefs.set(PREFIX + 'hybridSemanticWeight', '0');
    device.zotero.PDFWorker.getFullText = async (_id, limit) => {
      const extracted = pages.slice(0, limit ?? pages.length);
      return { text: extracted.join('\f'), extractedPages: extracted.length, totalPages: pages.length };
    };
  };
  const publisher = await createDevice('publisher', 0, 'publish');
  publisher.prefs.set(PREFIX + 'defaultSearchMode', 'fulltext');
  await preparePdf(publisher);
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  await publisher.shutdown(source);

  const receiver = await createDevice('subscriber', 100, 'off', 'openai');
  receiver.prefs.set(PREFIX + 'defaultSearchMode', 'metadata');
  await preparePdf(receiver);
  const destination = await receiver.start();
  await destination.startIndexing();
  const assertLocalPage = async (mode) => {
    const { hits, diagnostics } = await destination.search(query, { mode, filterItemIDs: new Set([101]) });
    assert.deepEqual(hits.map(({ itemID, bestChunk }) => [itemID, bestChunk.pageIndex]), [[101, 9]]);
    assert.equal(hits[0].bestChunk.sourceFileHash, undefined);
    assert.equal(diagnostics.totalIndexedChunks, 12);
  };
  await assertLocalPage('fulltext');

  const localRows = await destination.store.loadAll();
  const publication = transport.bytes;
  destination.indexSync.setRole('receive');
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.equal(destination.indexSync.getSharedStats().indexedChunks, 9);
  assert.equal((await destination.getSearchCoverage()).indexedChunks, 12);
  assert.deepEqual(await destination.store.loadAll(), localRows);
  await assertLocalPage('fulltext');
  await assertLocalPage('hybrid');
  await assertLocalPage(undefined);

  await destination.indexItems([101], true);
  transport.offline = true;
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'webdav');
  await assertLocalPage('fulltext');
  assert.deepEqual(transport.bytes, publication);
  assert.equal(transport.uploads, 1);
});

test('shared passage selection checks the page, text and vector and reports the chosen coverage', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  publisher.prefs.set(PREFIX + 'defaultSearchMode', 'metadata');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  await publisher.shutdown(source);

  const receiver = await createDevice('subscriber', 100, 'off', 'openai');
  receiver.flags.pdfAvailable = true;
  await fs.writeFile(receiver.pdfFile, pdfBytes);
  const destination = await receiver.start();
  await destination.startIndexing();
  destination.indexSync.setRole('receive');
  await destination.indexSync.syncNow();
  const [manifest, item, pdf, firstChunk, secondChunk] = String(transport.bytes).trimEnd().split('\n').map(JSON.parse);
  const options = { mode: 'fulltext', filterItemIDs: new Set([101]) };
  const assertSearch = async (isShared) => {
    const { hits } = await destination.search('diffusion', options);
    assert.deepEqual(hits.map((hit) => hit.itemID), [101]);
    assert.equal(hits[0].bestChunk.pageIndex, 1);
    assert.equal(Boolean(hits[0].bestChunk.sourceFileHash), isShared);
    assert.deepEqual(await destination.getSearchCoverage(), { indexedItems: 2, indexedChunks: 2 });
  };
  await assertSearch(true);

  const replacePublication = async (chunks) => {
    manifest.generation++;
    const records = [item, pdf, ...chunks];
    transport.bytes = Buffer.from([manifest, ...records, ['end', records.length]].map((row) => JSON.stringify(row)).join('\n') + '\n');
    await destination.indexSync.syncNow();
    assert.equal(destination.indexSync.getStatus().phase, 'ready');
  };

  const wrongPage = [...secondChunk];
  wrongPage[3] = firstChunk[3];
  await replacePublication([firstChunk, wrongPage]);
  await assertSearch(false);

  const differentText = [...secondChunk];
  differentText[7] = 'A shorter passage on the same PDF page.';
  await replacePublication([firstChunk, differentText]);
  await assertSearch(false);

  const noVector = [...secondChunk];
  noVector[8] = null;
  await replacePublication([firstChunk, noVector]);
  await assertSearch(false);

  await replacePublication([]);
  assert.equal(destination.indexSync.getSharedStats().indexedChunks, 0);
  await assertSearch(false);
  const metadata = await destination.search('diffusion', { ...options, mode: 'metadata' });
  assert.equal(metadata.diagnostics.engineLabel, manifest.model);

  await replacePublication([firstChunk, secondChunk]);
  await assertSearch(true);
});

test('offline sync, corrupted publications, account changes and model drift preserve the local index', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  assert.ok(transport.bytes);
  await publisher.shutdown(source);

  const subscriber = await createDevice('subscriber', 100, 'off', 'openai');
  let service = await subscriber.start();
  await service.startIndexing();
  assert.ok(service.searchIndex.getItemById(101)?.vector);
  const localProfile = service.store.activeProfile.id;
  const localRows = await service.store.loadAll();
  service.indexSync.setRole('receive');
  await service.indexSync.syncNow();
  const generation = service.indexSync.active.manifest.generation;
  const valid = transport.manifest;
  const corrupted = String(transport.bytes).trimEnd().split('\n');
  const header = JSON.parse(corrupted[0]);
  header.generation++;
  corrupted[0] = JSON.stringify(header);
  const invalid = JSON.parse(corrupted[1]);
  invalid[3] = 'AAAAAAAA'; // Invalid vector length with otherwise correct file checksums.
  corrupted[1] = JSON.stringify(invalid);
  transport.bytes = Buffer.from(corrupted.join('\n') + '\n');
  await service.indexSync.syncNow();
  assert.equal(service.indexSync.getStatus().phase, 'error');
  assert.equal(service.indexSync.active.manifest.generation, generation);
  assert.deepEqual(await service.store.loadAll(), localRows);
  assert.equal(service.store.activeProfile.id, localProfile);

  transport.offline = true;
  await service.indexSync.syncNow();
  assert.equal(service.indexSync.getStatus().phase, 'webdav');
  assert.equal(service.indexSync.active.manifest.generation, generation);
  assert.equal((await service.search('diffusion')).hits[0].itemID, 101);
  transport.offline = false;
  let entered;
  let release;
  const downloadStarted = new Promise((resolve) => { entered = resolve; });
  transport.beforeDownload = () => new Promise((resolve) => { release = resolve; entered(); });
  const stalledSync = service.indexSync.syncNow();
  await downloadStarted;
  try {
    assert.ok((await service.search('diffusion')).hits.some((hit) => hit.itemID === 101));
    const calls = subscriber.events.calls.length;
    await service.indexItems([101]);
    assert.equal(subscriber.events.calls.length, calls + 1, 'Manual indexing stays available during a blocked file sync');
  } finally {
    release();
    await stalledSync;
    transport.beforeDownload = undefined;
    transport.offline = true;
  }
  subscriber.flags.failSharedQuery = true;
  assert.ok((await service.search('diffusion', { mode: 'metadata' })).hits.find((hit) => hit.itemID === 101));
  await subscriber.shutdown(service);

  service = await subscriber.start();
  await service.indexSync.syncNow();
  assert.equal(service.indexSync.active.manifest.generation, generation);
  subscriber.flags.account = 900;
  assert.equal(service.indexSync.active, null);
  subscriber.flags.account = 101;
  await subscriber.shutdown(service);

  subscriber.flags.revision = 'f'.repeat(32) + ':' + 'b'.repeat(32);
  transport.offline = false;
  transport.manifest = valid;
  service = await subscriber.start();
  await service.indexSync.syncNow();
  assert.equal(service.indexSync.getStatus().phase, 'model');
  assert.equal(service.indexSync.active, null);
  assert.deepEqual((await service.store.loadAll()).items.map(({ updatedAt, ...item }) => item),
    localRows.items.map(({ updatedAt, ...item }) => item));
  assert.ok((await service.search('group')).hits.some((hit) => hit.libraryID === 2));
  service.indexSync.setRole('off');
  assert.equal(service.getConfig().openaiApiKey, 'local-secret');
});

test('a ready Ollama profile loads once and keeps the startup scan delay', async (t) => {
  const { createDevice } = await setup(t);
  const device = await createDevice('device', 0, 'off', 'ollama');
  device.flags.revision = 'a'.repeat(64);
  device.prefs.set(PREFIX + 'autoIndexOnStartup', true);
  const loads = [];
  let scan;
  let reads = 0;
  device.flags.onReadRevision = () => { reads++; };
  device.flags.beforeInit = (service) => {
    const loadAll = service.store.loadAll.bind(service.store);
    t.mock.method(service.store, 'loadAll', (id) => {
      loads.push(id ?? service.store.activeProfile?.id);
      return loadAll(id);
    });
    scan = t.mock.method(service.indexer, 'startLibraryScan', async () => {});
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const service = await device.start();
  assert.ok(service.store.activeProfile);
  assert.deepEqual(loads, [service.store.activeProfile.id]);
  assert.equal(reads, 1);
  assert.equal(service.pendingOllama, null);
  assert.equal((await service.getEngineStatus()).neuralAvailable, true);
  t.mock.timers.tick(3499);
  assert.equal(scan.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(scan.mock.callCount(), 1);
});

test('Ollama recovery during startup preserves the remaining scan delay', async (t) => {
  const { createDevice } = await setup(t);
  const device = await createDevice('device', 0, 'off', 'ollama');
  device.prefs.set(PREFIX + 'autoIndexOnStartup', true);
  const reply = Promise.withResolvers();
  device.flags.ollamaHttp = async () => reply.promise;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const service = await device.start();
  const scan = t.mock.method(service.indexer, 'startLibraryScan', async () => {});
  assert.equal(service.store.activeProfile, null);
  t.mock.timers.tick(500);
  reply.resolve({ status: 200, json: { models: [{ name: 'bge-m3:latest', digest: 'a'.repeat(64) }] } });
  await service.pendingOllama.probe;
  assert.ok(service.store.activeProfile);
  t.mock.timers.tick(2999);
  assert.equal(scan.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(scan.mock.callCount(), 1);
});

test('late Ollama startup reuses SQLite vectors and resumes WebDAV publication in the same session',
  { timeout: 5000 }, async (t) => {
  const { createDevice, transport } = await setup(t);
  const device = await createDevice('publisher', 0, 'off', 'ollama');
  const digest = 'a'.repeat(64);
  device.prefs.set(PREFIX + 'ollamaModel', 'test-embedding');
  let online = true;
  let offlineProbe;
  let tags = 0;
  let documentEmbeddings = 0;
  device.flags.ollamaHttp = async (method, url, request) => {
    assert.doesNotMatch(url, /\/api\/embeddings$/);
    if (method === 'GET') tags++;
    if (!online) {
      await offlineProbe?.promise;
      throw new Error('Ollama is offline');
    }
    if (method === 'GET') return { status: 200, json: { models: [{ name: 'test-embedding:latest', digest }] } };
    const { input } = JSON.parse(request.body);
    const inputs = Array.isArray(input) ? input : [input];
    documentEmbeddings += inputs.filter((text) => text !== 'hydrogen' && text !== 'semantic search health check').length;
    return { status: 200, json: { embeddings: inputs.map(() => [1, 0]) } };
  };

  let service = await device.start();
  await service.startIndexing();
  const saved = (await service.listEmbeddingProfiles()).find(({ active }) => active);
  assert.ok(saved.items && saved.chunks);
  const seenEmbeddings = documentEmbeddings;
  service.indexSync.setRole('publish');
  await service.indexSync.syncNow();
  assert.equal(service.indexSync.getStatus().phase, 'ready');
  const previousManifest = transport.manifest;
  await device.shutdown(service);

  online = false;
  offlineProbe = Promise.withResolvers();
  service = await device.start();
  const status = await service.getEngineStatus();
  assert.equal(status.neuralAvailable, false);
  assert.match(status.statusMessage, /Waiting for Ollama/);
  assert.equal(service.store.activeProfile, null);
  assert.deepEqual(await service.listEmbeddingProfiles(), [{ ...saved, active: false }]);
  const offline = await service.search('hydrogen');
  assert.ok(offline.hits.length);
  assert.equal(offline.diagnostics.vectorSearchUsed, false);
  assert.equal(service.pendingOllama.retryDelayMs, 5000);
  offlineProbe.resolve();
  await service.pendingOllama.probe;
  const offlineTags = tags;
  const retryTimer = service.pendingOllama.timer;
  await service.search('hydrogen');
  await service.search('hydrogen diffusion');
  assert.equal(tags, offlineTags);
  assert.equal(service.pendingOllama.timer, retryTimer);
  await service.indexSync.syncNow();
  assert.equal(service.indexSync.getStatus().phase, 'waiting');
  assert.deepEqual(transport.manifest, previousManifest);

  online = true;
  const beforeRecovery = tags;
  const [connection] = await Promise.all([
    service.testConnection({ ...service.getConfig() }), service.startIndexing(),
  ]);
  assert.equal(tags - beforeRecovery, 1);
  const search = await service.search('hydrogen');
  assert.equal(search.diagnostics.vectorSearchUsed, true);
  assert.equal(connection.ok, true);
  assert.equal((await service.getEngineStatus()).neuralAvailable, true);
  assert.deepEqual(await service.listEmbeddingProfiles(), [saved]);
  assert.equal(documentEmbeddings, seenEmbeddings);

  service.updateConfig({ hybridSemanticWeight: 0.25 });
  await service.indexSync.syncNow();
  assert.equal(service.indexSync.getStatus().phase, 'ready');
  assert.equal(transport.manifest.snapshot.revision, digest);
  assert.ok(transport.manifest.snapshot.generation > previousManifest.snapshot.generation);
});

test('shared tag notifications update paper metadata and retain PDF chunks until the attachment is removed', async (t) => {
  const { createDevice } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'off');
  publisher.items.get(1).getTags = () => [{ tag: 'transport' }];
  const source = await publisher.start();
  await source.startIndexing();
  source.indexSync.setRole('publish');
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  const paper = receiver.items.get(101);
  paper.getTags = () => [{ tag: 'transport' }];
  const service = await receiver.start();
  await service.indexSync.syncNow();
  const { index } = service.indexSync.active;
  const { notify } = receiver.observers.get('zotero-vectorize-shared-index');
  const chunks = index.getItemChunks(101);
  assert.ok(chunks.length);
  assert.ok(index.getItemById(101).vector);

  const initialRevision = service.indexSync.libraryRevision;
  notify('remove', 'item-tag', ['102-8']);
  assert.deepEqual(index.getItemChunks(101), chunks);
  assert.equal(service.indexSync.libraryRevision, initialRevision);
  paper.getTags = () => [];
  notify('remove', 'item-tag', ['101-7']);
  notify('delete', 'item-tag', ['101-7']);
  assert.deepEqual(index.getItemById(101).tags, []);
  assert.equal(index.getItemById(101).vector, null);
  assert.deepEqual(index.getItemChunks(101), chunks);

  receiver.items.delete(102);
  notify('delete', 'item', [102]);
  assert.ok(index.getItemById(101));
  assert.deepEqual(index.getItemChunks(101), []);
});

test('a receiver can search an independent shared index during local Ollama verification', async (t) => {
  const { createDevice } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'off');
  const source = await publisher.start();
  await source.startIndexing();
  source.indexSync.setRole('publish');
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'off', 'ollama');
  const revision = Promise.withResolvers();
  let requests = 0;
  receiver.flags.ollamaHttp = async () => { requests++; return revision.promise; };
  const destination = await receiver.start();
  destination.indexSync.setRole('receive');
  await destination.indexSync.syncNow();
  const original = destination.indexSync.active;
  assert.equal(original.manifest.engine, 'local-onnx');
  assert.ok((await destination.search('hydrogen')).diagnostics.vectorSearchUsed);
  assert.equal(requests, 1);

  const schedule = t.mock.method(destination.indexSync, 'schedule');
  revision.resolve({ status: 200, json: { models: [{ name: 'bge-m3:latest', digest: 'a'.repeat(64) }] } });
  await destination.pendingOllama.probe;
  assert.equal(destination.store.activeProfile.engine, 'ollama');
  assert.equal(destination.indexSync.active, original);
  assert.equal(schedule.mock.callCount(), 0);
});

test('a queued Ollama activation cannot overwrite a model switched under index maintenance', async (t) => {
  const { createDevice } = await setup(t);
  const device = await createDevice('device', 0, 'off', 'ollama');
  device.flags.revision = null;
  const service = await device.start();
  await service.pendingOllama.probe;

  const probeStarted = Promise.withResolvers();
  const revision = Promise.withResolvers();
  (await service.getProvider()).getModelRevision = () => {
    probeStarted.resolve();
    return revision.promise;
  };
  const verification = service.verifyPendingOllama();
  await probeStarted.promise;

  const unblock = Promise.withResolvers();
  const waiting = service.withIndexMaintenance(() => unblock.promise);
  const queue = service.maintenance;
  const switching = service.applyEmbeddingConfig({ ...service.getConfig(), engine: 'openai' }, false);
  await new Promise(setImmediate);
  assert.notEqual(service.maintenance, queue);
  const queuedSwitch = service.maintenance;

  revision.resolve('b'.repeat(64));
  await new Promise(setImmediate);
  assert.notEqual(service.maintenance, queuedSwitch);
  unblock.resolve();
  await Promise.all([waiting, switching, verification]);

  assert.equal(service.store.activeProfile.engine, 'openai');
  assert.ok((await service.listEmbeddingProfiles()).every(({ engine }) => engine === 'openai'));
});

for (const shared of [false, true]) {
  test(`Ollama recovery keeps ${shared ? 'shared ONNX' : 'local lexical'} search available while a PDF read drains`,
    { timeout: 5000 }, async (t) => {
    const { createDevice } = await setup(t);
    if (shared) {
      const publisher = await createDevice('publisher', 0, 'off');
      const source = await publisher.start();
      await source.startIndexing();
      source.indexSync.setRole('publish');
      await source.indexSync.syncNow();
      assert.equal(source.indexSync.getStatus().phase, 'ready');
      await publisher.shutdown(source);
    }

    const device = await createDevice('device', shared ? 100 : 0, 'off', 'ollama');
    let online = false;
    device.flags.ollamaHttp = async (method) => {
      assert.equal(method, 'GET');
      if (!online) throw new Error('Ollama is offline');
      return { status: 200, json: { models: [{ name: 'bge-m3:latest', digest: 'a'.repeat(64) }] } };
    };
    const service = await device.start();
    await service.pendingOllama.probe;
    if (shared) {
      service.indexSync.setRole('receive');
      await service.indexSync.syncNow();
      assert.equal(service.indexSync.active.manifest.engine, 'local-onnx');
      // The receiving device still indexes its private group library.
      device.items.get(103).getAttachments = () => [200];
      device.items.set(200, {
        ...device.items.get(102), id: 200, parentItemID: 103, libraryID: 2, key: 'GROUPPDF',
        getFilePathAsync: async () => device.pdfFile, attachmentHash: digest(pdfBytes),
        attachmentModificationTime: 789,
      });
      await fs.writeFile(device.pdfFile, pdfBytes);
    } else {
      await service.startIndexing();
      await fs.writeFile(device.pdfFile, Buffer.from('Updated fixture PDF'));
    }

    const reading = Promise.withResolvers();
    const extracted = Promise.withResolvers();
    t.mock.method(device.zotero.PDFWorker, 'getFullText', async (id) => {
      assert.equal(id, shared ? 200 : 2);
      reading.resolve();
      return extracted.promise;
    });
    const draining = Promise.withResolvers();
    const suspend = service.indexer.withWritesSuspended.bind(service.indexer);
    t.mock.method(service.indexer, 'withWritesSuspended', (operation) => {
      draining.resolve();
      return suspend(operation);
    });
    const loading = Promise.withResolvers();
    const loaded = Promise.withResolvers();
    const loadAll = service.store.loadAll.bind(service.store);
    t.mock.method(service.store, 'loadAll', async (profileId) => {
      loading.resolve();
      await loaded.promise;
      return loadAll(profileId);
    });

    const scan = service.indexer.startLibraryScan(false, true);
    let recovery;
    let searchDuringCommit;
    let timer;
    const finishPdf = () => extracted.resolve({
      text: 'Hydrogen diffusion in a fixture PDF.', extractedPages: 1, totalPages: 1,
    });
    try {
      await reading.promise;
      online = true;
      recovery = service.verifyPendingOllama();
      await draining.promise;

      const [search, status] = await Promise.race([
        Promise.all([service.search('hydrogen'), service.getEngineStatus()]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Reads are waiting for the PDF extraction')), 2000);
        }),
      ]);
      assert.ok(search.hits.length);
      assert.equal(search.diagnostics.vectorSearchUsed, shared);
      assert.equal(status.neuralAvailable, false);
      assert.equal(service.store.activeProfile, null);

      finishPdf();
      await loading.promise;
      let returned = false;
      searchDuringCommit = service.search('hydrogen').then((response) => {
        returned = true;
        return response;
      });
      await new Promise(setImmediate);
      assert.equal(returned, false, 'Search must wait for the actual Profile change');
    } finally {
      clearTimeout(timer);
      finishPdf();
      loaded.resolve();
      await Promise.all([scan, recovery, searchDuringCommit]);
    }
    assert.equal(service.store.activeProfile.engine, 'ollama');
  });
}

test('Ollama readiness retries automatically without starting a scan when startup indexing is off', async (t) => {
  const { createDevice } = await setup(t);
  const device = await createDevice('device', 0, 'off', 'ollama');
  device.flags.revision = null;
  let probes = 0;
  device.flags.onReadRevision = () => { probes++; };

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = await device.start();
  await service.pendingOllama.probe;
  assert.equal(probes, 1);
  await new Promise(setImmediate);
  const firstRetry = service.pendingOllama.timer;
  assert.ok(firstRetry);
  await service.testConnection();
  assert.equal(probes, 2);
  assert.equal(service.pendingOllama.timer, firstRetry);
  t.mock.timers.tick(4999);
  assert.equal(probes, 2);
  t.mock.timers.tick(1);
  await service.pendingOllama.probe;
  assert.equal(probes, 3);
  assert.equal(service.store.activeProfile, null);

  device.flags.revision = 'a'.repeat(64);
  t.mock.timers.tick(9999);
  assert.equal(probes, 3);
  t.mock.timers.tick(1);
  await service.pendingOllama.probe;
  t.mock.timers.tick(1);
  assert.equal(probes, 4);
  assert.equal(service.store.activeProfile.engine, 'ollama');
  assert.equal(service.getIndexProgress().phase, 'idle');
  t.mock.timers.tick(60_000);
  assert.equal(probes, 4);
});

async function testLocalDownload(t, draftDownload, switchModel = false) {
  const { createDevice } = await setup(t);
  const device = await createDevice('device', 0, 'off');
  device.flags.useLocalOnnx = true;
  const { Services, Worker } = globalThis;
  t.after(() => { globalThis.Services = Services; globalThis.Worker = Worker; });
  globalThis.IOUtils.readUTF8 = (file) => fs.readFile(file, 'utf8');
  globalThis.Worker = class {
    addEventListener(type, callback) {
      if (type === 'message') this.reply = callback;
    }
    postMessage({ id, type, payload }) {
      const result = type === 'init' ? { dimensions: 2 } :
        { vectors: payload.texts.map(() => new Float32Array([1, 0])) };
      queueMicrotask(() => this.reply({ data: { id, ok: true, result } }));
    }
    terminate() {}
  };

  const urls = [];
  const activeRequest = Promise.withResolvers();
  let stall = false;
  const fetchModelAsset = async (url, { signal }) => {
    urls.push(new URL(url));
    if (!stall || new URL(url).pathname.endsWith('/tokenizer.json')) return new Response('{}');
    activeRequest.resolve(signal);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  globalThis.Services = { appShell: { hiddenDOMWindow: { fetch: fetchModelAsset, AbortController, crypto } } };

  const service = await device.start();
  if (!draftDownload && !switchModel) {
    const activation = t.mock.method(service.store, 'activateProfile', async () => {
      throw new Error('fixture Profile commit failed');
    });
    await assert.rejects(service.downloadLocalModel(), /Profile commit failed/);
    activation.mock.restore();
    assert.equal(service.store.activeProfile, null);
    assert.deepEqual(await fs.readdir((await service.getProvider()).getModelDir()), []);
    urls.length = 0;
  }
  await service.downloadLocalModel(undefined, { ...service.getConfig(), localMirror: 'hf-mirror' });
  const provider = await service.getProvider();
  assert.equal(urls.length, 3);
  assert.ok(urls.every(({ hostname }) => hostname === 'hf-mirror.com'));
  assert.equal(service.store.activeProfile.engine, 'local-onnx');
  const profileID = service.store.activeProfile.id;
  service.updateConfig({ localMirror: 'hf-mirror' });
  assert.equal(device.prefs.get(PREFIX + 'localMirror'), 'hf-mirror');
  assert.equal(await service.getProvider(), provider);
  assert.equal(service.store.activeProfile.id, profileID);
  await service.startIndexing();

  const modelDir = draftDownload ? path.join(device.dir, 'draft-model') : provider.getModelDir();
  const draft = draftDownload ? { ...service.getConfig(), localModelDir: modelDir } : undefined;
  const asset = draftDownload ? 'tokenizer.json' : 'config.json';
  if (draftDownload) await fs.mkdir(modelDir);
  else await fs.rm(path.join(modelDir, asset));
  await fs.writeFile(path.join(modelDir, asset + '.part'), 'stale');
  stall = true;
  const pending = service.downloadLocalModel(undefined, draft);
  const interrupted = assert.rejects(pending, { name: 'AbortError' });
  const signal = await activeRequest.promise;
  assert.equal((await service.getEngineStatus()).ready, true);
  assert.ok((await service.search('hydrogen')).hits.length);
  assert.ok((await service.getStats()).indexedItems);
  assert.equal((await service.listEmbeddingProfiles()).find(({ active }) => active).id, profileID);
  if (draftDownload) assert.equal(await IOUtils.exists(path.join(modelDir, 'tokenizer.json')), false);
  if (switchModel) {
    await assert.rejects(service.applyEmbeddingConfig({
      ...service.getConfig(), localModelDir: path.join(device.dir, 'missing'),
    }, false), /model files missing/);
    assert.equal(signal.aborted, false);
    await service.applyEmbeddingConfig({ ...service.getConfig(), engine: 'openai' }, false);
    assert.equal(service.store.activeProfile.engine, 'openai');
  } else await device.shutdown(service);
  await interrupted;
  assert.equal(signal.aborted, true);
  assert.equal(urls.length, draftDownload ? 5 : 4);
  assert.deepEqual((await fs.readdir(modelDir)).sort(), draftDownload ? [] : ['model_quantized.onnx', 'tokenizer.json']);
}

test('an active model download uses the requested mirror and is canceled at shutdown',
  { timeout: 5000 }, (t) => testLocalDownload(t, false));
test('a draft model download leaves the active engine usable and is canceled at shutdown',
  { timeout: 5000 }, (t) => testLocalDownload(t, true));
test('a successful engine switch cancels an active download and a failed switch keeps it running',
  { timeout: 5000 }, (t) => testLocalDownload(t, false, true));

test('an Ollama digest change disables shared neural results without affecting a local engine', async (t) => {
  const { createDevice } = await setup(t);
  const digest = 'sha256:' + 'd'.repeat(64);
  const publisher = await createDevice('publisher', 0, 'publish', 'ollama');
  publisher.flags.revision = digest;
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  await publisher.shutdown(source);

  const subscriber = await createDevice('subscriber', 100, 'off', 'openai');
  subscriber.flags.revision = digest;
  const service = await subscriber.start();
  await service.startIndexing();
  service.indexSync.setRole('receive');
  await service.indexSync.syncNow();
  assert.equal(service.indexSync.getStatus().phase, 'ready');
  assert.ok((await service.search('diffusion', { mode: 'fulltext' })).hits[0]?.bestChunk?.sourceFileHash);
  subscriber.flags.revision = 'sha256:' + 'e'.repeat(64);
  assert.deepEqual((await service.search('diffusion', { mode: 'fulltext' })).hits, []);
  const local = await service.search('diffusion', { mode: 'metadata' });
  assert.ok(local.hits.some((hit) => hit.itemID === 101));
  assert.equal(local.diagnostics.vectorSearchUsed, true);
});

test('cloud sharing matches the configured endpoint, model and actual dimensions with device-local keys', async (t) => {
  const { createDevice, transport } = await setup(t);
  const apiUrl = 'https://embeddings.invalid/v1';
  const model = 'text-embedding-3-small';
  const publisher = await createDevice('publisher', 0, 'publish', 'openai');
  publisher.flags.useCloudHttp = true;
  publisher.prefs.set(PREFIX + 'openaiBaseUrl', apiUrl);
  publisher.prefs.set(PREFIX + 'openaiApiKey', 'publisher-fixture-key');
  publisher.prefs.set(PREFIX + 'openaiModel', model);
  publisher.prefs.set(PREFIX + 'openaiDimensions', 2);
  publisher.prefs.set(PREFIX + 'openaiBatchSize', 1);
  const source = await publisher.start();
  await source.startIndexing();
  const requestsBeforePublish = publisher.events.cloudRequests.length;
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.equal(publisher.events.cloudRequests.length, requestsBeforePublish);
  const payload = String(transport.bytes);
  const manifest = JSON.parse(payload.split('\n')[0]);
  assert.equal(manifest.engine, 'openai');
  assert.equal(manifest.model, model);
  assert.equal(manifest.dimensions, 2);
  assert.match(manifest.endpointDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(payload, /publisher-fixture-key|embeddings\.invalid|openaiApiKey/);
  await publisher.shutdown(source);

  for (const [name, overrides, actualDimensions, requests] of [
    ['missing-key', { openaiApiKey: '' }, 2, 0],
    ['other-endpoint', { openaiBaseUrl: 'https://other.invalid/v1' }, 2, 0],
    ['other-model', { openaiModel: 'text-embedding-3-large' }, 2, 0],
    ['configured-dimension-mismatch', { openaiDimensions: 3 }, 2, 0],
    ['actual-dimension-mismatch', {}, 3, 1],
  ]) {
    const receiver = await createDevice(name, 100, 'receive');
    receiver.flags.useCloudHttp = true;
    receiver.flags.cloudDimensions = actualDimensions;
    for (const [key, value] of Object.entries({ openaiBaseUrl: apiUrl, openaiModel: model,
      openaiApiKey: 'receiver-fixture-key', ...overrides })) receiver.prefs.set(PREFIX + key, value);
    const destination = await receiver.start();
    await destination.indexSync.syncNow();
    assert.equal(destination.indexSync.getStatus().phase, 'cloud', name);
    assert.equal(destination.indexSync.active, null);
    assert.equal(receiver.events.cloudRequests.length, requests, name);
    await receiver.shutdown(destination);
  }

  const receiver = await createDevice('subscriber', 100, 'receive');
  receiver.flags.useCloudHttp = true;
  receiver.prefs.set(PREFIX + 'openaiApiKey', '');
  const destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'cloud');
  await destination.applyEmbeddingConfig({ ...destination.getConfig(), engine: 'openai', openaiModel: model,
    openaiBaseUrl: 'https://EMBEDDINGS.invalid:443/v1/embeddings/', openaiDimensions: 0,
    openaiApiKey: 'receiver-fixture-key', openaiBatchSize: 1 }, false);
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.equal(destination.searchIndex.getItemById(101), undefined, 'Applying the API settings must not index My Library again');
  const result = await destination.search('diffusion', { mode: 'fulltext', filterItemIDs: new Set([101]) });
  assert.ok(result.hits[0]?.bestChunk?.sourceFileHash);
  assert.equal(result.diagnostics.vectorSearchUsed, true);
  assert.ok(receiver.events.cloudRequests.every((request) => request.authorization === 'Bearer receiver-fixture-key' &&
    new URL(request.url).href === apiUrl + '/embeddings'));
  assert.ok(receiver.events.cloudRequests.some((request) => request.input === 'diffusion'));
  assert.ok(receiver.events.cloudRequests.every((request) => !JSON.stringify(request.input).includes('finement')));
});

test('a part size change publishes a new generation and the preference persists on restart', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'off');
  let source = await publisher.start();
  await source.startIndexing();
  assert.equal(source.indexSync.getPartSizeMiB(), 32);
  source.indexSync.setPartSizeMiB(64);
  assert.equal(source.indexSync.getPartSizeMiB(), 32);
  source.indexSync.setRole('publish');
  source.indexSync.setPartSizeMiB(512);
  assert.equal(source.indexSync.getPartSizeMiB(), 32);
  await source.indexSync.syncNow();
  const first = transport.manifest;
  source.indexSync.setPartSizeMiB(8);
  publisher.flags.partBytes = 256;
  source.indexSync.partBytes = () => publisher.flags.partBytes;
  transport.beforeErase = () => { throw new Error('Interrupted remote retirement'); };
  await source.indexSync.syncNow();
  assert.ok(transport.manifest.snapshot.generation > first.snapshot.generation);
  assert.equal(source.indexSync.getStatus().phase, 'webdav');
  assert.deepEqual(transport.erased, []);
  assert.equal(transport.uploads, 2);
  await publisher.shutdown(source);

  source = await publisher.start();
  transport.beforeErase = undefined;
  assert.equal(source.indexSync.getPartSizeMiB(), 8);
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.deepEqual(transport.erased, first.parts.map((part) => part.key));
  assert.equal(transport.uploads, 2);
});

test('single-document changes transfer only changed shards and an offline receiver can skip generations', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  publisher.flags.partBytes = 512;
  publisher.zotero.PDFWorker.getFullText = async () => {
    const pages = Array.from({ length: 7 }, (_, page) => 'Hydrogen diffusion on page ' + page + ' ' + '纳米管'.repeat(24));
    return { text: pages.join('\f'), extractedPages: pages.length, totalPages: pages.length };
  };
  let source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const first = transport.manifest;
  assert.ok(first.parts.length >= 4);
  const sharedItems = source.store.sharedItems.bind(source.store);
  let scans = 0;
  source.store.sharedItems = (...args) => {
    scans++;
    return sharedItems(...args);
  };
  await source.indexSync.run(false);
  assert.equal(scans, 0, 'An automatic check of an identical source should avoid scanning vector rows');
  await source.indexItems([3]);
  await source.indexSync.run(false);
  assert.equal(scans, 1, 'A committed write should invalidate the local scan result');
  assert.deepEqual(transport.manifest, first, 'A private group write must leave the shared head unchanged');
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  let destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  const originalCoverage = destination.indexSync.getSharedStats();
  await receiver.shutdown(destination);

  source = await publisher.start();
  publisher.items.set(700, publisher.makePaper(700, 'ZZZNEW01', 1, 'New metadata-only paper'));
  await source.indexItems([700]);
  transport.partUploads.length = 0;
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  const second = transport.manifest;
  const unchanged = second.parts.filter((part) => first.parts.some((old) => old.key === part.key));
  assert.ok(unchanged.length >= first.parts.length - 1);
  const added = second.parts.filter((part) => !unchanged.includes(part));
  assert.equal(added.length, 1);
  assert.deepEqual(transport.partUploads, added.map((part) => part.key));
  assert.ok(unchanged.every(({ key }) => transport.remote.has(key) && !transport.erased.includes(key)));
  source.updateConfig({ hybridSemanticWeight: 0.35 });
  await source.indexSync.syncNow();
  const third = transport.manifest;
  assert.ok(third.snapshot.generation > second.snapshot.generation);
  assert.deepEqual(third.parts, second.parts);
  assert.deepEqual(transport.partUploads, added.map((part) => part.key));
  await publisher.shutdown(source);

  receiver.items.set(800, receiver.makePaper(800, 'ZZZNEW01', 1, 'New metadata-only paper'));
  transport.partDownloads.length = 0;
  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.equal(destination.indexSync.active.manifest.generation, third.snapshot.generation);
  assert.deepEqual(transport.partDownloads, added.map((part) => part.key));
  assert.equal(destination.indexSync.active.index.getItemById(800).itemKey, 'ZZZNEW01');
  assert.equal(destination.indexSync.getSharedStats().vectorizedChunks, originalCoverage.vectorizedChunks);
  await receiver.shutdown(destination);

  source = await publisher.start();
  publisher.items.get(700).deleted = true;
  publisher.items.get(1).deleted = true;
  await source.indexSync.syncNow();
  const empty = transport.manifest;
  assert.deepEqual(empty.parts, []);
  assert.ok(third.parts.every(({ key }) => transport.erased.includes(key) && !transport.remote.has(key)));
  await publisher.shutdown(source);
  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active.manifest.generation, empty.snapshot.generation);
  assert.equal(destination.indexSync.getSharedStats().indexedItems, 0);
  assert.deepEqual(transport.partDownloads, added.map((part) => part.key));
});

test('receiver follows a newer manifest when an in-flight generation loses a retired shard', { timeout: 4000 }, async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  let source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const first = transport.manifest;
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  let destination = await receiver.start();
  await destination.indexSync.syncNow();
  await receiver.shutdown(destination);

  source = await publisher.start();
  let middle;
  for (const [id, key] of [[700, 'ZZZNEW01'], [701, 'ZZZNEW02']]) {
    publisher.items.set(id, publisher.makePaper(id, key, 1, 'New paper ' + key));
    await source.indexItems([id]);
    await source.indexSync.syncNow();
    if (id === 700) middle = transport.manifest;
  }
  const newest = transport.manifest;
  await publisher.shutdown(source);
  const [{ key: retired }] = middle.parts;
  assert.ok(!transport.remote.has(retired));
  transport.manifest = middle;
  receiver.items.set(800, receiver.makePaper(800, 'ZZZNEW01', 1, 'New paper ZZZNEW01'));
  receiver.items.set(801, receiver.makePaper(801, 'ZZZNEW02', 1, 'New paper ZZZNEW02'));
  destination = await receiver.start();
  let headChecks = 0;
  transport.beforeDownload = (item) => {
    if (item === receiver.carrier && ++headChecks === 2) transport.manifest = newest;
  };
  const finished = new Promise((resolve) => {
    const unsubscribe = destination.indexSync.subscribe(() => {
      if (destination.indexSync.getStatus().phase === 'ready' &&
          destination.indexSync.active?.manifest.generation === newest.snapshot.generation) {
        unsubscribe();
        resolve();
      }
    });
  });
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'waiting');
  assert.equal(destination.indexSync.active.manifest.generation, first.snapshot.generation);
  await finished;
  assert.ok(!transport.partDownloads.includes(retired));
  assert.equal(destination.indexSync.active.index.getItemById(801).itemKey, 'ZZZNEW02');
});

test('publishing resumes the same generation after interrupted import, part upload, and manifest upload', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'off');
  publisher.flags.partBytes = 256;
  let source = await publisher.start();
  await source.startIndexing();
  source.indexSync.setRole('publish');
  transport.afterImport = () => { throw new Error('Interrupted after importing an attachment'); };
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'error');
  assert.equal(transport.manifest, null);
  const firstPart = [...publisher.items.values()].find((item) => item.attachmentFilename?.endsWith('.zvpart'));
  assert.ok(firstPart);
  await publisher.shutdown(source);

  source = await publisher.start();
  transport.afterImport = undefined;
  transport.beforeUpload = (item) => {
    if (item.key !== firstPart.key) throw new Error('Interrupted upload');
  };
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'webdav');
  assert.deepEqual(transport.partUploads, [firstPart.key]);
  assert.equal(transport.manifest, null);
  const partKeys = [...publisher.items.values()].filter((item) => item.attachmentFilename?.endsWith('.zvpart'))
    .map((item) => item.key);
  assert.ok(partKeys.length >= 2);
  await publisher.shutdown(source);

  source = await publisher.start();
  transport.beforeUpload = undefined;
  transport.afterImport = (item) => {
    if (item === publisher.carrier) throw new Error('Interrupted after importing the manifest');
  };
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'error');
  assert.deepEqual(transport.partUploads, partKeys);
  assert.equal(transport.manifest, null);
  await publisher.shutdown(source);

  source = await publisher.start();
  transport.afterImport = undefined;
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.deepEqual(transport.partUploads, partKeys);
  assert.deepEqual(transport.manifest.parts.map((part) => part.key), partKeys);
  assert.equal(transport.uploads, 1);
  assert.equal(publisher.prefs.get(PREFIX + 'syncAttachment'), '101:INDEX001');
});

test('a missing or corrupted part keeps the old generation searchable across restarts', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'off');
  publisher.zotero.PDFWorker.getFullText = async () => {
    const pages = Array.from({ length: 7 }, (_, page) =>
      `Page ${page + 1} describes diffusion in carbon nanotubes. ` + '纳米管'.repeat(24));
    return { text: pages.join('\f'), extractedPages: pages.length, totalPages: pages.length };
  };
  let source = await publisher.start();
  await source.startIndexing();
  source.indexSync.setRole('publish');
  await source.indexSync.syncNow();
  const first = transport.manifest;
  const original = transport.bytes;
  assert.equal(first.parts.length, 1);
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  let destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active?.manifest.generation, first.snapshot.generation);
  const search = async () => {
    const { hits, diagnostics: { durationMs: _duration, ...diagnostics } } =
      await destination.search('diffusion', { mode: 'fulltext', filterItemIDs: new Set([101]) });
    return { hits, diagnostics };
  };
  const originalSearch = await search();
  assert.equal(originalSearch.diagnostics.vectorSearchUsed, true);
  await receiver.shutdown(destination);

  publisher.flags.partBytes = 512;
  source = await publisher.start();
  transport.beforeUpload = (item) => {
    if (item === publisher.carrier) throw new Error('Manifest upload interrupted');
  };
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'webdav');
  assert.deepEqual(transport.manifest, first);
  assert.deepEqual(transport.erased, []);
  await publisher.shutdown(source);
  source = await publisher.start();
  transport.beforeUpload = undefined;
  await source.indexSync.syncNow();
  const second = transport.manifest;
  const [firstKey, middleKey, ...laterKeys] = second.parts.map((part) => part.key);
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.ok(laterKeys.length > 0);
  assert.deepEqual(transport.erased, [first.parts[0].key]);
  assert.ok(second.parts.every((part) => part.bytes <= 512));
  assert.deepEqual(String(transport.bytes).split('\n').slice(1), String(original).split('\n').slice(1));
  await publisher.shutdown(source);

  transport.partDownloads.length = 0;
  transport.missingMetadata.add(middleKey);
  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'waiting');
  assert.equal(destination.indexSync.active?.manifest.generation, first.snapshot.generation);
  assert.deepEqual(transport.partDownloads, [firstKey]);
  assert.deepEqual(await search(), originalSearch);
  await receiver.shutdown(destination);

  transport.offline = true;
  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active?.manifest.generation, first.snapshot.generation);
  assert.deepEqual(await search(), originalSearch);
  transport.offline = false;
  transport.missingMetadata.clear();
  transport.missingFiles.add(middleKey);
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'waiting');
  assert.equal(destination.indexSync.active?.manifest.generation, first.snapshot.generation);
  assert.deepEqual(transport.partDownloads, [firstKey]);
  transport.missingFiles.clear();
  const middle = transport.remote.get(middleKey);
  const valid = middle.bytes;
  middle.bytes = Buffer.from(valid);
  middle.bytes[0] ^= 1;
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'error');
  assert.equal(destination.indexSync.active?.manifest.generation, first.snapshot.generation);
  assert.deepEqual(await search(), originalSearch);

  middle.bytes = valid;
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.equal(destination.indexSync.active?.manifest.generation, second.snapshot.generation);
  assert.deepEqual(transport.partDownloads, [firstKey, middleKey, middleKey, ...laterKeys]);
  assert.deepEqual(await search(), originalSearch);
  await receiver.shutdown(destination);

  transport.offline = true;
  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active?.manifest.generation, second.snapshot.generation);
  assert.deepEqual(await search(), originalSearch);
});

test('invalid manifests and conflicting generations are rejected before downloading parts', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const original = transport.manifest;
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  const destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  const before = transport.partDownloads.length;
  const [part] = original.parts;
  for (const [manifest, phase] of [
    [{ ...original, parts: [part, part] }, 'error'],
    [{ ...original, parts: Array.from({ length: 5 }, (_, i) =>
      ({ ...part, key: 'SYNTH00' + i, bytes: 256 * 1024 * 1024 })) }, 'error'],
    [{ ...original, parts: [{ ...part, key: 'UNSEEN01' }] }, 'conflict'],
    [{ ...original, snapshot: { ...original.snapshot, generation: original.snapshot.generation - 1 } }, 'conflict'],
    [{ ...original, snapshot: { ...original.snapshot, publisher: 'X'.repeat(24) } }, 'conflict'],
  ]) {
    transport.manifest = manifest;
    await destination.indexSync.syncNow();
    assert.equal(destination.indexSync.getStatus().phase, phase);
    assert.equal(transport.partDownloads.length, before);
    assert.equal(destination.indexSync.active.manifest.generation, original.snapshot.generation);
  }
});

test('an unreadable cache manifest cannot cause data loss during an incomplete update', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  let source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const first = transport.manifest;
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  let destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active.manifest.generation, first.snapshot.generation);
  const cachedHead = path.join(destination.store.getStoreDir(), 'shared-index-101', 'current.zvmanifest');
  await receiver.shutdown(destination);

  source = await publisher.start();
  publisher.items.set(700, publisher.makePaper(700, 'ZZZNEW01', 1, 'New metadata-only paper'));
  await source.indexItems([700]);
  await source.indexSync.syncNow();
  const [newPart] = transport.manifest.parts;
  assert.ok(first.parts.every((part) => part.key !== newPart.key));
  await publisher.shutdown(source);

  transport.offline = true;
  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active.manifest.generation, first.snapshot.generation);
  transport.offline = false;
  transport.missingMetadata.add(newPart.key);
  const read = IOUtils.read;
  IOUtils.read = async (file, options) => {
    if (file === cachedHead) throw new Error('Temporary failure reading the accepted manifest');
    return read(file, options);
  };
  try {
    await destination.indexSync.syncNow();
    assert.equal(destination.indexSync.getStatus().phase, 'waiting');
    assert.equal(destination.indexSync.active.manifest.generation, first.snapshot.generation);
  } finally {
    IOUtils.read = read;
  }
  await receiver.shutdown(destination);

  transport.offline = true;
  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active?.manifest.generation, first.snapshot.generation);
  assert.equal((await destination.search('diffusion')).hits[0]?.itemID, 101);
});

test('a beta publisher upgrades its bound attachment while a beta receiver can still open its accepted cache offline', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  let source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const original = transport.manifest;
  const legacy = transport.bytes;
  await publisher.shutdown(source);

  const carrier = transport.remote.get('INDEX001');
  carrier.bytes = legacy;
  original.parts.forEach(({ key }) => transport.remote.delete(key));
  await fs.writeFile(path.join(publisher.dir, 'storage', 'INDEX001', SHARED_FILE), legacy);
  publisher.carrier.attachmentSyncedHash = digest(legacy);

  const receiver = await createDevice('receiver', 100, 'receive');
  transport.offline = true;
  const cache = path.join(receiver.dir, 'zotero-vectorize', 'shared-index-101.zvindex');
  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.writeFile(cache, legacy);
  let destination = await receiver.start();
  destination.indexSync.setPartSizeMiB(64);
  assert.equal(destination.indexSync.getPartSizeMiB(), 32);
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active?.manifest.generation, original.snapshot.generation);
  assert.equal((await destination.search('diffusion')).hits[0]?.itemID, 101);
  await receiver.shutdown(destination);

  transport.offline = false;
  publisher.flags.partBytes = 256;
  source = await publisher.start();
  transport.beforeUpload = (item) => {
    if (item !== publisher.carrier) assert.deepEqual(transport.remote.get('INDEX001').bytes, legacy);
  };
  await source.indexSync.syncNow();
  transport.beforeUpload = undefined;
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.equal(publisher.items.get(4), publisher.carrier);
  assert.ok(transport.manifest.parts.length > 1);
  assert.ok(transport.manifest.snapshot.generation > original.snapshot.generation);
  await publisher.shutdown(source);

  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.equal(destination.indexSync.active?.manifest.generation, transport.manifest.snapshot.generation);
  await assert.rejects(fs.stat(cache), { code: 'ENOENT' });
});

async function seedV2Head(publisher, transport) {
  const { snapshot, parts: [{ key }] } = transport.manifest;
  const legacyBytes = transport.bytes;
  const filename = 'zotero-vectorize-part-1.zvpart';
  const title = `${TITLE} Part ${snapshot.publisher} ${snapshot.generation} 1`;
  transport.remote.set(key, { title, filename, bytes: legacyBytes });
  const attachment = await publisher.zotero.Items.getByLibraryAndKeyAsync(1, key);
  attachment.attachmentFilename = filename;
  attachment.getField = (field) => field === 'title' ? title : '';
  await fs.writeFile(path.join(publisher.dir, 'storage', key, filename), legacyBytes);
  transport.manifest = {
    type: 'zotero-vectorize-index-manifest', version: 2, snapshot,
    parts: [{ key, bytes: legacyBytes.length, digest: digest(legacyBytes) }],
  };
  const head = transport.remote.get('INDEX001').bytes;
  publisher.carrier.attachmentSyncedHash = digest(head);
  await fs.writeFile(path.join(publisher.dir, 'storage', 'INDEX001', SHARED_FILE), head);
  return { snapshot, key, filename, legacyBytes, head };
}

test('v2 ownership and offline cache survive a coordinated cutover and the old part retires after commit', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  let source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const { snapshot, key, filename, legacyBytes, head } = await seedV2Head(publisher, transport);
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  const cache = path.join(receiver.dir, 'zotero-vectorize', 'shared-index-101');
  const cachedParts = path.join(cache, 'parts-' + digest(head));
  await fs.mkdir(cachedParts, { recursive: true });
  await fs.writeFile(path.join(cache, 'current.zvmanifest'), head);
  await fs.writeFile(path.join(cachedParts, filename), legacyBytes);
  transport.offline = true;
  let destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active?.manifest.generation, snapshot.generation);
  assert.equal((await destination.search('diffusion')).hits[0]?.itemID, 101);
  transport.offline = false;
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'upgradePublisher');
  assert.equal(destination.indexSync.active.manifest.generation, snapshot.generation);
  assert.deepEqual(transport.partDownloads, []);
  await receiver.shutdown(destination);

  source = await publisher.start();
  transport.beforeErase = () => assert.equal(transport.manifest.version, 3);
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.equal(transport.manifest.version, 3);
  assert.deepEqual(transport.erased, [key]);
  assert.equal(publisher.items.get(4), publisher.carrier);
  await publisher.shutdown(source);

  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.equal(destination.indexSync.active.manifest.generation, transport.manifest.snapshot.generation);
  await assert.rejects(fs.stat(cachedParts), { code: 'ENOENT' });
});

test('a fresh receiver distinguishes old and new sync formats from malformed manifests', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const latest = transport.manifest;
  await seedV2Head(publisher, transport);
  const legacy = transport.manifest;
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  const destination = await receiver.start();
  for (const [manifest, phase] of [
    [legacy, 'upgradePublisher'],
    [{ ...latest, version: 4 }, 'upgradeReceiver'],
    [{ ...legacy, parts: [] }, 'error'],
  ]) {
    transport.manifest = manifest;
    await destination.indexSync.syncNow();
    assert.equal(destination.indexSync.getStatus().phase, phase);
    assert.equal(destination.indexSync.active, null);
    assert.deepEqual(transport.partDownloads, []);
  }
});

test('a v2 draft is reconciled before publishing v3 across interruption stages', async (t) => {
  for (const step of [
    'first draft', 'parts uploaded', 'carrier pending', 'carrier ZIP without metadata', 'carrier confirmed', 'carrier with lost part',
  ]) {
    await t.test(step, async (branch) => {
      const { createDevice, transport } = await setup(branch);
      const publisher = await createDevice('publisher', 0, 'publish');
      let source = await publisher.start();
      await source.startIndexing();
      await source.indexSync.syncNow();
      const { snapshot, key, filename, legacyBytes, head } = await seedV2Head(publisher, transport);
      const first = step === 'first draft';
      const base = transport.manifest;
      if (first) {
        await publisher.zotero.Items.erase([publisher.carrier.id]);
        const attachment = await publisher.zotero.Items.getByLibraryAndKeyAsync(1, key);
        await publisher.zotero.Items.erase([attachment.id]);
        publisher.prefs.delete(PREFIX + 'syncAttachment');
        await publisher.zotero.Sync.Runner.sync({ libraries: [1] });
        publisher.carrier.attachmentSyncState = 0;
        delete publisher.carrier.attachmentSyncedHash;
      }
      const draftDir = path.join(source.store.getStoreDir(), 'publish-101');
      const next = { ...snapshot, generation: snapshot.generation + 1 };
      const payload = Buffer.from(JSON.stringify(next) + String(legacyBytes).slice(String(legacyBytes).indexOf('\n')));
      const part = { bytes: payload.length, digest: digest(payload) };
      await fs.mkdir(draftDir, { recursive: true });
      const stagedPart = path.join(draftDir, filename);
      await fs.writeFile(stagedPart, payload);
      const partItem = await publisher.zotero.Attachments.importFromFile({
        file: stagedPart, libraryID: 1, title: `${TITLE} Part ${next.publisher} ${next.generation} 1`,
      });
      await publisher.zotero.Sync.Runner.sync({ libraries: [1] });
      const staged = { ...base, snapshot: next, parts: [{ ...part, key: partItem.key }] };
      const carrierPath = path.join(publisher.dir, 'storage', 'INDEX001', SHARED_FILE);
      if (step.startsWith('carrier')) {
        await fs.writeFile(carrierPath, JSON.stringify(staged) + '\n');
        publisher.carrier.attachmentSyncState = 0;
        if (step === 'carrier ZIP without metadata' || step === 'carrier confirmed') {
          await publisher.zotero.Sync.Runner.sync({ libraries: [1] });
        }
        if (step === 'carrier ZIP without metadata') {
          transport.missingProps.add(publisher.carrier.key);
          publisher.carrier.attachmentSyncState = 0;
          publisher.carrier.attachmentSyncedHash = digest(head);
        }
        if (step === 'carrier with lost part') {
          publisher.items.delete(partItem.id);
          transport.remote.delete(partItem.key);
        }
      }
      const draftPath = path.join(draftDir, 'draft.json');
      await fs.writeFile(draftPath, JSON.stringify({
        snapshot: next, stamp: '1'.repeat(16), parts: [part],
        previous: first ? null : { generation: snapshot.generation, digest: digest(head), keys: [key] },
      }));
      await publisher.shutdown(source);

      const uploads = [];
      transport.beforeUpload = async (item) => {
        if (item !== publisher.carrier) return;
        const current = JSON.parse(await fs.readFile(carrierPath, 'utf8'));
        uploads.push(current.version);
        if (current.version === 2) assert.ok(transport.remote.has(partItem.key));
      };
      source = await publisher.start();
      if (step === 'carrier pending') {
        transport.remoteHashes.set(publisher.carrier.key, 'f'.repeat(32));
        await source.indexSync.syncNow();
        assert.equal(source.indexSync.getStatus().phase, 'conflict');
        assert.deepEqual(transport.manifest, base);
        assert.deepEqual(uploads, []);
        assert.ok((await fs.stat(draftPath)).isFile());
        transport.remoteHashes.clear();
      }
      if (step === 'carrier ZIP without metadata') {
        const foreign = { ...staged, snapshot: { ...staged.snapshot, publisher: 'F'.repeat(24) } };
        transport.manifest = foreign;
        await source.indexSync.syncNow();
        assert.equal(source.indexSync.getStatus().phase, 'conflict');
        assert.deepEqual(transport.manifest, foreign);
        assert.deepEqual(uploads, []);
        assert.ok((await fs.stat(draftPath)).isFile());
        transport.manifest = staged;
      }
      await source.indexSync.syncNow();
      assert.equal(source.indexSync.getStatus().phase, 'ready');
      assert.equal(transport.manifest.version, 3);
      assert.ok(transport.manifest.snapshot.generation > next.generation);
      assert.deepEqual(uploads, ['carrier pending', 'carrier ZIP without metadata'].includes(step) ? [2, 3] : [3]);
      assert.ok(!transport.remote.has(partItem.key));
      assert.ok(!transport.remote.has(key));
      await assert.rejects(fs.stat(draftPath), { code: 'ENOENT' });
    });
  }
});

test('published shard renames preserve reuse and one check replaces a missing attachment', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  publisher.flags.partBytes = 256;
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const base = transport.manifest;
  const [lost, ...healthy] = base.parts;
  assert.ok(healthy.length);
  const renamed = await publisher.zotero.Items.getByLibraryAndKeyAsync(1, healthy[0].key);
  renamed.getField = (field) => field === 'title' ? 'Renamed shard' : '';
  transport.remote.get(renamed.key).title = 'Renamed shard';
  await source.indexSync.run(false);
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.deepEqual(transport.manifest, base);

  const removed = await publisher.zotero.Items.getByLibraryAndKeyAsync(1, lost.key);
  await publisher.zotero.Items.erase([removed.id]);
  await publisher.zotero.Sync.Runner.sync({ libraries: [1] });
  transport.partUploads.length = 0;
  await source.indexSync.syncNow();
  const next = transport.manifest;
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.ok(next.snapshot.generation > base.snapshot.generation);
  const [{ key, ...range }] = next.parts;
  assert.notEqual(key, lost.key);
  assert.deepEqual({ ...range, key: lost.key }, lost);
  assert.deepEqual(next.parts.slice(1), healthy);
  assert.deepEqual(transport.partUploads, [key]);
  const moved = await publisher.zotero.Items.getByLibraryAndKeyAsync(1, key);
  moved.parentItemID = 1;
  transport.partUploads.length = 0;
  await source.indexSync.run(false);
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.ok(transport.manifest.snapshot.generation > next.snapshot.generation);
  assert.deepEqual(transport.partUploads, [transport.manifest.parts[0].key]);
  assert.notEqual(transport.manifest.parts[0].key, key);
  assert.ok(transport.remote.has(key), 'The user-managed attachment must not be deleted');
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  const destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.equal((await destination.search('diffusion')).hits[0]?.itemID, 101);
});

test('a lost reuse key in a v3 draft is repaired against the confirmed head', async (t) => {
  for (const confirmed of [false, true]) {
    await t.test(confirmed ? 'carrier confirmed' : 'carrier only staged locally', async (branch) => {
      const { createDevice, transport } = await setup(branch);
      const publisher = await createDevice('publisher', 0, 'publish');
      publisher.flags.partBytes = 256;
      let source = await publisher.start();
      await source.startIndexing();
      await source.indexSync.syncNow();
      const previous = transport.manifest;
      const [missing] = previous.parts;
      const draftDir = path.join(source.store.getStoreDir(), 'publish-101');
      publisher.items.set(700, publisher.makePaper(700, 'ZZZNEW01', 1, 'Another document'));
      await source.indexItems([700]);
      transport.beforeUpload = (item) => {
        if (item === publisher.carrier) throw new Error('Interrupted carrier upload');
      };
      await source.indexSync.syncNow();
      assert.equal(source.indexSync.getStatus().phase, 'webdav');
      assert.deepEqual(transport.manifest, previous);
      const draft = JSON.parse(await fs.readFile(path.join(draftDir, 'draft.json'), 'utf8'));
      assert.ok(draft.parts.some((part) => part.key === missing.key));
      const locallyStaged = JSON.parse(await fs.readFile(path.join(publisher.dir, 'storage', 'INDEX001', SHARED_FILE), 'utf8'));
      if (confirmed) {
        transport.beforeUpload = undefined;
        await publisher.zotero.Sync.Runner.sync({ libraries: [1] });
        assert.deepEqual(transport.manifest, locallyStaged);
      }
      await publisher.shutdown(source);

      const lost = await publisher.zotero.Items.getByLibraryAndKeyAsync(1, missing.key);
      publisher.items.delete(lost.id);
      transport.remote.delete(lost.key);
      transport.beforeUpload = async (item) => {
        if (item === publisher.carrier) {
          const next = JSON.parse(await fs.readFile(path.join(publisher.dir, 'storage', 'INDEX001', SHARED_FILE), 'utf8'));
          assert.ok(next.snapshot.generation > locallyStaged.snapshot.generation);
          assert.ok(next.parts.every(({ key }) => key !== missing.key && transport.remote.has(key)));
        }
      };
      const downloads = transport.downloads;
      source = await publisher.start();
      await source.indexSync.syncNow();
      assert.equal(source.indexSync.getStatus().phase, 'ready');
      assert.equal(transport.downloads - downloads, confirmed ? 0 : 1);
      assert.ok(transport.manifest.snapshot.generation > locallyStaged.snapshot.generation);
      assert.ok(transport.manifest.parts.every(({ key }) => key !== missing.key && transport.remote.has(key)));
      await assert.rejects(fs.stat(draftDir), { code: 'ENOENT' });
    });
  }
});

test('a published generation repairs a missing ZIP and a fully missing part with the same keys', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  publisher.flags.partBytes = 256;
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  const manifest = transport.manifest;
  const [first, second] = manifest.parts.map((part) => part.key);
  const oldPayload = transport.bytes;
  transport.missingFiles.add(first);
  transport.missingFiles.add(second);
  transport.missingProps.add(second);
  transport.beforeUpload = () => { throw new Error('WebDAV refused repair'); };
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'webdav');
  assert.deepEqual(transport.manifest, manifest);
  assert.ok(transport.missingFiles.has(first));

  transport.beforeUpload = undefined;
  transport.forcedUploads.length = 0;
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.deepEqual(transport.forcedUploads, [first, second]);
  assert.deepEqual(transport.manifest, manifest);
  assert.deepEqual(transport.bytes, oldPayload);
  assert.equal(transport.uploads, 1);
  assert.deepEqual(transport.erased, []);
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  const destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.active?.manifest.generation, manifest.snapshot.generation);
  assert.equal((await destination.search('diffusion')).hits[0]?.itemID, 101);
});

test('an inconclusive remote check, conflicting hashes and modified local parts prohibit repair', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  publisher.flags.partBytes = 256;
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  const [first, second] = transport.manifest.parts.map((part) => part.key);
  transport.missingFiles.add(first);
  transport.beforeProbe = (method, key) => {
    if (method === 'HEAD' && key === first) throw new Error('Permission denied or server unavailable');
  };
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'webdav');
  assert.deepEqual(transport.forcedUploads, []);
  transport.beforeProbe = undefined;

  transport.remoteHashes.set(second, '0'.repeat(32));
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'conflict');
  assert.deepEqual(transport.forcedUploads, []);
  transport.remoteHashes.clear();

  transport.missingProps.add(second);
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'conflict');
  assert.deepEqual(transport.forcedUploads, []);
  transport.missingProps.clear();

  transport.remoteHashes.set('INDEX001', '0'.repeat(32));
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'conflict');
  assert.deepEqual(transport.forcedUploads, []);
  transport.remoteHashes.clear();

  const local = path.join(publisher.dir, 'storage', first, transport.remote.get(first).filename);
  const bytes = await fs.readFile(local);
  bytes[0] ^= 1;
  await fs.writeFile(local, bytes);
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'error');
  assert.deepEqual(transport.forcedUploads, []);
  assert.equal(transport.uploads, 1);
  assert.ok(transport.missingFiles.has(first));
});

test('if a missing part reappears during local verification, its remote digest is checked again before repair', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  const [part] = transport.manifest.parts;
  const read = IOUtils.read;
  const partPath = path.join(publisher.dir, 'storage', part.key, transport.remote.get(part.key).filename);
  for (const replacement of [part.digest, '0'.repeat(32)]) {
    transport.missingFiles.add(part.key);
    IOUtils.read = async (file, options) => {
      if (file === partPath) {
        transport.missingFiles.delete(part.key);
        transport.remoteHashes.set(part.key, replacement);
      }
      return read(file, options);
    };
    await source.indexSync.syncNow();
    assert.equal(source.indexSync.getStatus().phase, replacement === part.digest ? 'ready' : 'conflict');
    assert.deepEqual(transport.forcedUploads, []);
  }
  IOUtils.read = read;
});

test('a concurrent carrier update cannot be overwritten by a prepared generation', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  const originalPartCount = transport.partUploads.length;
  const current = transport.manifest;
  const sharedDimensions = source.store.sharedDimensions.bind(source.store);
  const changedHead = { ...current, snapshot: { ...current.snapshot, generation: current.snapshot.generation + 1 } };
  source.store.sharedDimensions = async (...args) => {
    const dimensions = await sharedDimensions(...args);
    transport.manifest = changedHead;
    const bytes = transport.remote.get(publisher.carrier.key).bytes;
    await fs.writeFile(path.join(publisher.dir, 'storage', publisher.carrier.key, SHARED_FILE), bytes);
    publisher.carrier.attachmentSyncedHash = digest(bytes);
    return dimensions;
  };
  source.updateConfig({ hybridSemanticWeight: 0.35 });
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'conflict');
  assert.deepEqual(transport.manifest, changedHead);
  assert.equal(transport.uploads, 1);
  assert.equal(transport.partUploads.length, originalPartCount);
  assert.deepEqual(transport.erased, []);
});

test('a conflicting remote carrier blocks a new publication before any parts are uploaded', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  const current = transport.manifest;
  const uploads = transport.partUploads.length;
  transport.remoteHashes.set(publisher.carrier.key, '0'.repeat(32));
  source.updateConfig({ hybridSemanticWeight: 0.35 });
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'conflict');
  assert.deepEqual(transport.manifest, current);
  assert.equal(transport.uploads, 1);
  assert.equal(transport.partUploads.length, uploads);
  assert.deepEqual(transport.erased, []);
});

test('a second publisher discovers the existing head before importing or uploading new parts', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const current = transport.manifest;
  const uploads = [...transport.partUploads];
  await publisher.shutdown(source);

  const second = await createDevice('second-publisher', 100, 'off');
  const contender = await second.start();
  await contender.startIndexing();
  contender.indexSync.setRole('publish');
  await contender.indexSync.syncNow();
  assert.equal(contender.indexSync.getStatus().phase, 'conflict');
  assert.deepEqual(transport.manifest, current);
  assert.deepEqual(transport.partUploads, uploads);
  assert.deepEqual(transport.erased, []);
  assert.equal(second.prefs.get(PREFIX + 'syncAttachment'), undefined);
});

test('retirement preserves shards referenced by a head synced during cleanup', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const base = transport.manifest;
  const [oldPart] = base.parts;
  let competing;
  const lookup = publisher.zotero.Items.getByLibraryAndKeyAsync;
  publisher.zotero.Items.getByLibraryAndKeyAsync = async (libraryID, key) => {
    const item = await lookup(libraryID, key);
    const head = transport.manifest;
    if (!competing && key === oldPart.key && head.snapshot.generation > base.snapshot.generation) {
      competing = { ...base, snapshot: { ...base.snapshot, generation: head.snapshot.generation + 1 } };
      transport.manifest = competing;
      const bytes = transport.remote.get(publisher.carrier.key).bytes;
      await fs.writeFile(path.join(publisher.dir, 'storage', publisher.carrier.key, SHARED_FILE), bytes);
      publisher.carrier.attachmentSyncedHash = digest(bytes);
    }
    return item;
  };
  publisher.items.set(700, publisher.makePaper(700, 'ZZZNEW01', 1, 'New metadata-only paper'));
  await source.indexItems([700]);
  await source.indexSync.syncNow();
  assert.ok(competing);
  assert.equal(source.indexSync.getStatus().phase, 'conflict');
  assert.deepEqual(transport.manifest, competing);
  assert.ok(transport.remote.has(oldPart.key));
  assert.deepEqual(transport.erased, []);
});

test('resuming a draft repairs a lost ZIP before exposing the manifest', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  publisher.flags.partBytes = 256;
  let source = await publisher.start();
  await source.startIndexing();
  transport.beforeUpload = (item) => {
    if (item === publisher.carrier) throw new Error('Interrupted manifest upload');
  };
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'webdav');
  assert.equal(transport.manifest, null);
  const parts = [...transport.partUploads];
  assert.ok(parts.length > 1);
  await publisher.shutdown(source);

  transport.missingFiles.add(parts[0]);
  transport.beforeUpload = (item) => {
    if (item === publisher.carrier) assert.equal(transport.missingFiles.has(parts[0]), false);
  };
  source = await publisher.start();
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.deepEqual(transport.forcedUploads, [parts[0]]);
  assert.deepEqual(transport.manifest.parts.map((part) => part.key), parts);
});

test('committed generation identity survives missing cache data and rejects stale or conflicting manifests', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  const source = await publisher.start();
  await source.startIndexing();
  await source.indexSync.syncNow();
  const older = transport.bytes;
  source.updateConfig({ hybridSemanticWeight: 0.35 });
  await source.indexSync.syncNow();
  const latest = transport.manifest;
  await publisher.shutdown(source);

  const receiver = await createDevice('receiver', 100, 'receive');
  let destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  const localRows = await destination.store.loadAll();
  const dir = path.join(destination.store.getStoreDir(), 'shared-index-101');
  const head = path.join(dir, 'current.zvmanifest');
  const hash = digest(await fs.readFile(head));
  await receiver.shutdown(destination);
  const accepted = PREFIX + 'syncAccepted.101';
  assert.deepEqual(JSON.parse(receiver.prefs.get(accepted)), {
    publisher: latest.snapshot.publisher, generation: latest.snapshot.generation, digest: hash,
  });
  receiver.prefs.delete(accepted); // An existing cache from before the independent identity was recorded.
  const [{ key, content }] = latest.parts;
  await fs.unlink(path.join(dir, 'shards', key + '-' + content + '.zvpart'));
  transport.bytes = older;
  destination = await receiver.start();
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'conflict');
  assert.equal(destination.indexSync.active, null);
  assert.equal(digest(await fs.readFile(head)), hash);
  assert.equal(JSON.parse(receiver.prefs.get(accepted)).generation, latest.snapshot.generation);
  await receiver.shutdown(destination);

  await fs.unlink(head);
  destination = await receiver.start();
  for (const manifest of [
    transport.manifest,
    { ...latest, parts: [{ ...latest.parts[0], key: 'ABCDEFGH' }] },
    { ...latest, snapshot: { ...latest.snapshot, publisher: 'X'.repeat(24), generation: latest.snapshot.generation + 1 } },
  ]) {
    transport.manifest = manifest;
    const downloads = transport.partDownloads.length;
    await destination.indexSync.syncNow();
    assert.equal(destination.indexSync.getStatus().phase, 'conflict');
    assert.equal(destination.indexSync.active, null);
    assert.equal(transport.partDownloads.length, downloads);
  }
  await receiver.shutdown(destination);

  const corruptHead = { ...latest, snapshot: { ...latest.snapshot, generation: latest.snapshot.generation + 10_000 } };
  await fs.writeFile(head, JSON.stringify(corruptHead));
  destination = await receiver.start();
  transport.manifest = latest;
  await destination.indexSync.syncNow();
  assert.equal(destination.indexSync.getStatus().phase, 'ready');
  assert.equal(destination.indexSync.active?.manifest.generation, latest.snapshot.generation);
  assert.equal(JSON.parse(receiver.prefs.get(accepted)).generation, latest.snapshot.generation);
  assert.deepEqual(await destination.store.loadAll(), localRows);
});

test('one check resumes an acknowledged draft and publishes the newly selected part size', async (t) => {
  const { createDevice, transport } = await setup(t);
  const publisher = await createDevice('publisher', 0, 'publish');
  let source = await publisher.start();
  await source.startIndexing();
  const directory = path.join(source.store.getStoreDir(), 'publish-101');
  const remove = IOUtils.remove;
  IOUtils.remove = async (file, options) => {
    if (file === directory && transport.uploads === 1) throw new Error('Interrupted before removing committed draft');
    return remove(file, options);
  };
  try {
    await source.indexSync.syncNow();
    assert.equal(source.indexSync.getStatus().phase, 'error');
  } finally {
    IOUtils.remove = remove;
  }
  const first = transport.manifest;
  await publisher.shutdown(source);

  source = await publisher.start();
  source.indexSync.setPartSizeMiB(64);
  await source.indexSync.syncNow();
  assert.equal(source.indexSync.getStatus().phase, 'ready');
  assert.equal(source.indexSync.getPartSizeMiB(), 64);
  assert.equal(transport.uploads, 2);
  assert.ok(transport.manifest.snapshot.generation > first.snapshot.generation);
  assert.deepEqual(transport.erased, []);
  assert.deepEqual(transport.manifest.parts, first.parts);
  await source.indexSync.syncNow();
  assert.equal(transport.uploads, 2);
});
