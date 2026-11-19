import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importTs } from './_helper.mjs';
import { SqliteConnection } from './_sqlite.mjs';

async function setup(t, engine) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zv-profiles-'));
  const prefs = new Map([
    ['extensions.zotero-vectorize.engine', engine],
    ['extensions.zotero-vectorize.openaiApiKey', 'fixture'],
    ['extensions.zotero-vectorize.openaiModel', 'same-model'],
    ['extensions.zotero-vectorize.openaiBaseUrl', 'https://a.invalid/v1'],
    ['extensions.zotero-vectorize.autoIndexOnStartup', false],
    ['extensions.zotero-vectorize.autoIndexOnChange', false],
  ]);
  const target = path.join(root, 'fixture.pdf');
  await fs.writeFile(target, 'synthetic attachment');
  const items = new Map();
  for (const [id, marker] of [[1, 'alpha'], [2, 'beta']]) {
    items.set(id, {
      id, key: 'PAPER' + id, libraryID: 1, itemType: 'journalArticle',
      isRegularItem: () => true, getField(field) { return field === 'title' ? this.title : ''; },
      title: 'Title ' + marker, getAttachments: () => [100 + id],
    });
    items.set(100 + id, {
      id: 100 + id, key: 'ATT' + id, libraryID: 1, parentItemID: id,
      isRegularItem: () => false, isPDFAttachment: () => true,
      getFilePathAsync: async () => target, attachmentModificationTime: 345,
      attachmentHash: 'fixture-' + marker,
    });
  }
  const events = [];
  globalThis.PathUtils = { join: path.join, parent: path.dirname };
  globalThis.IOUtils = {
    makeDirectory: (file) => fs.mkdir(file, { recursive: true }),
    exists: (file) => fs.access(file).then(() => true, () => false),
    stat: async (file) => { const stat = await fs.stat(file); return { size: stat.size, type: stat.isFile() ? 'regular' : 'directory' }; },
    copy: fs.copyFile, move: fs.rename, remove: (file) => fs.rm(file, { force: true }),
    readJSON: async (file) => JSON.parse(await fs.readFile(file, 'utf8')),
    writeUTF8: (file, data) => fs.writeFile(file, data),
  };
  globalThis.Zotero = {
    DBConnection: SqliteConnection,
    Prefs: {
      get: (key) => prefs.get(key),
      set: (key, value) => prefs.set(key, value),
      registerObserver: () => 1,
      unregisterObserver: () => {},
    },
    Items: { getAll: async () => [...items.values()], getAsync: async (id) => items.get(id) },
    Libraries: { getAll: () => [{ libraryID: 1, libraryType: 'user' }] },
    Notifier: { registerObserver: () => 1, unregisterObserver: () => {} },
    PDFWorker: {
      getFullText: async (id) => {
        events.push({ pdf: id });
        const pages = Array.from({ length: 9 }, (_, index) => `Indexed PDF ${id}, page ${index + 1} has a distinct passage.`);
        return { text: pages.join('\f'), extractedPages: pages.length, totalPages: pages.length };
      },
    },
    locale: 'en-US', logError() {},
  };

  const { VectorizeService } = await importTs('src/zotero/service.ts');
  const svc = new VectorizeService({ rootURI: 'file:///fixture/', dataDir: root });
  let intercept;
  svc.providerManager.createProvider = (config) => {
    const model = config.engine === 'local-onnx' ? config.localModelId : config.openaiModel;
    const origin = config.openaiBaseUrl;
    const vector = () => new Float32Array(origin === 'https://a.invalid/v1' ? [1, 0] : [0, 1]);
    return {
      engine: config.engine, model,
      getModelRevision: async () => engine === 'local-onnx' ? 'fixture-model-bytes' : null,
      getModelFingerprint: (dim = 2) => `${engine}:${model}:${dim}`,
      getPassageBatchSize: () => 16,
      getStatus: async () => ({ engine, model, modelFingerprint: `${engine}:${model}:2`, dimensions: 2, neuralAvailable: true }),
      testConnection: async () => ({ ok: true, dimensions: 2 }),
      embedQuery: async () => vector(),
      embedMetadata: engine === 'local-onnx' ? async (texts) => {
        events.push({ origin, metadata: texts });
        return texts.map(vector);
      } : undefined,
      embedPassages: async (texts) => {
        events.push({ origin, texts });
        await intercept?.(origin, texts);
        return texts.map(vector);
      },
      dispose: async () => {},
    };
  };
  t.after(async () => {
    await svc.shutdown();
    delete globalThis.PathUtils;
    delete globalThis.IOUtils;
    delete globalThis.Zotero;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { svc, root, items, events, setIntercept: (fn) => { intercept = fn; } };
}

test('Retained indexes isolate same-name API endpoints, resume by model and restore a native snapshot', async (t) => {
  const { svc, events, items, root, setIntercept } = await setup(t, 'openai');
  await svc.startIndexing();
  const configA = svc.getConfig();
  const configB = { ...configA, openaiBaseUrl: 'https://b.invalid/v1' };
  const a = (await svc.listEmbeddingProfiles()).find((profile) => profile.active);
  assert.deepEqual([a.items, a.chunks], [2, 18]);

  setIntercept((origin, texts) => {
    if (origin === configB.openaiBaseUrl && texts[0].startsWith('Indexed PDF 102')) throw new Error('fixture second attachment failure');
  });
  await svc.applyEmbeddingConfig(configB, false);
  await svc.startIndexing();
  assert.equal(svc.getIndexProgress().phase, 'incomplete');
  const b = (await svc.listEmbeddingProfiles()).find((profile) => profile.active);
  assert.notEqual(a.id, b.id);
  assert.deepEqual([b.items, b.chunks], [2, 9]);
  assert.ok(svc.searchIndex.getAllChunks().filter((row) => row.vector).every((row) => row.vector[1] === 1));
  const transferred = path.join(root, 'export');
  const exported = await svc.exportCompatJsonToFolder(transferred, b.id);
  const json = await IOUtils.readJSON(path.join(transferred, 'fulltext_vectors.json'));
  assert.equal(exported.chunks, 9);
  assert.ok(json.every((row) => row.embedding[1] === 1));

  items.get(2).title = 'Changed metadata beta';
  events.length = 0;
  await svc.applyEmbeddingConfig(configA, false);
  await svc.startIndexing();
  assert.deepEqual(events, [{ origin: configA.openaiBaseUrl, texts: ['Title: Changed metadata beta'] }]);
  assert.equal(svc.searchIndex.getAllChunks().filter((row) => row.vector).length, 18);
  const savedB = (await svc.listEmbeddingProfiles()).find((profile) => profile.id === b.id);
  assert.deepEqual([savedB.items, savedB.chunks], [1, 9]);

  const snapshot = path.join(root, 'snapshot.sqlite');
  await svc.exportNativeIndex(snapshot);
  const dbBefore = new DatabaseSync(snapshot, { readOnly: true });
  const original = dbBefore.prepare('SELECT vector FROM passage_embeddings ORDER BY profile_id, chunk_id').all();
  dbBefore.close();
  await svc.deleteEmbeddingProfile(b.id);
  assert.equal((await svc.listEmbeddingProfiles()).some((profile) => profile.id === b.id), false);
  await svc.restoreNativeIndex(snapshot);
  await svc.startIndexing();
  const reader = new DatabaseSync(svc.store.getDbPath(), { readOnly: true });
  assert.deepEqual(reader.prepare('SELECT vector FROM passage_embeddings ORDER BY profile_id, chunk_id').all(), original);
  assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM fulltext_chunks').get().count, 18);
  reader.close();

  const invalid = path.join(root, 'invalid.sqlite');
  await fs.writeFile(invalid, 'not an index');
  await assert.rejects(svc.restoreNativeIndex(invalid));
  assert.equal((await svc.getStats()).vectorizedChunks, 18);

  setIntercept(undefined);
  await svc.applyEmbeddingConfig(configB, true);
  await svc.startIndexing();
  assert.equal((await svc.listEmbeddingProfiles()).some((profile) => profile.id === a.id), false);
  assert.equal((await svc.getStats()).vectorizedChunks, 18);
  assert.equal(events.some((entry) => entry.pdf), false);

  await svc.deleteEmbeddingProfile(b.id);
  assert.deepEqual([(await svc.getStats()).vectorizedChunks, svc.searchIndex.getChunkCount()], [0, 18]);
});

test('Local full scans commit metadata before full-text inference and keep PDF inputs per attachment', async (t) => {
  const { svc, events, setIntercept } = await setup(t, 'local-onnx');
  const metadataWhenFulltextStarts = [];
  setIntercept((_origin, texts) => {
    if (texts[0]?.startsWith('Indexed PDF')) {
      metadataWhenFulltextStarts.push(svc.searchIndex.getAllItems().filter((row) => row.vector).length);
    }
  });
  await svc.startIndexing();
  const requests = events.filter((entry) => entry.texts).map((entry) => entry.texts);
  assert.deepEqual(events.find((entry) => entry.metadata)?.metadata, ['Title: Title alpha', 'Title: Title beta']);
  assert.deepEqual(requests.map((texts) => texts.length), [9, 9]);
  assert.ok(requests[0].every((text) => text.startsWith('Indexed PDF 101')));
  assert.ok(requests[1].every((text) => text.startsWith('Indexed PDF 102')));
  assert.deepEqual(metadataWhenFulltextStarts, [2, 2]);
  assert.equal((await svc.getStats()).vectorizedChunks, 18);
});

test('An old SQLite index keeps its vectors inactive until the matching model is confirmed', async (t) => {
  const { svc, root, events } = await setup(t, 'openai');
  await svc.startIndexing();
  const oldPath = path.join(root, 'release-index.sqlite');
  await svc.exportNativeIndex(oldPath);
  const old = new DatabaseSync(oldPath);
  old.exec(`
    PRAGMA application_id = 0;
    UPDATE store_meta SET value = '2' WHERE key = 'schema_version';
    ALTER TABLE item_vectors ADD COLUMN vector BLOB;
    ALTER TABLE item_vectors ADD COLUMN dim INTEGER DEFAULT 2;
    ALTER TABLE item_vectors ADD COLUMN model_fingerprint TEXT DEFAULT 'openai:same-model:2';
    UPDATE item_vectors SET vector = (SELECT vector FROM metadata_embeddings e WHERE e.item_id = item_vectors.item_id);
    ALTER TABLE fulltext_chunks ADD COLUMN vector BLOB;
    ALTER TABLE fulltext_chunks ADD COLUMN dim INTEGER DEFAULT 2;
    ALTER TABLE fulltext_chunks ADD COLUMN model_fingerprint TEXT DEFAULT 'openai:same-model:2';
    UPDATE fulltext_chunks SET vector = (SELECT vector FROM passage_embeddings e WHERE e.chunk_id = fulltext_chunks.chunk_id);
    ALTER TABLE attachment_state ADD COLUMN model_fingerprint TEXT DEFAULT 'openai:same-model:2';
    DROP TABLE metadata_embeddings;
    DROP TABLE passage_embeddings;
    DROP TABLE attachment_embeddings;
    DROP TABLE embedding_profiles;
  `);
  old.close();

  await svc.restoreNativeIndex(oldPath);
  const archived = (await svc.listEmbeddingProfiles()).find((profile) => profile.provenance === 'legacy');
  assert.deepEqual([archived.items, archived.chunks, archived.active], [2, 18, false]);
  assert.equal((await svc.getStats()).vectorizedChunks, 0);
  assert.equal(svc.searchIndex.getChunkCount(), 18);
  assert.ok(svc.searchIndex.getAllChunks().every((row) => !row.vector));

  events.length = 0;
  await svc.reuseLegacyIndex(archived.id);
  await svc.startIndexing();
  assert.deepEqual(events, []);
  assert.deepEqual((await svc.listEmbeddingProfiles()).map((profile) => [profile.items, profile.chunks, profile.active]), [[2, 18, true]]);

  const unchanged = new DatabaseSync(oldPath, { readOnly: true });
  assert.equal(unchanged.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get().value, '2');
  unchanged.close();
});

test('Opening an unpacked index and restoring a bloated snapshot reclaim pages without changing vectors', async (t) => {
  const { svc, root } = await setup(t, 'openai');
  await svc.startIndexing();
  const snapshot = path.join(root, 'bloated.sqlite');
  await svc.exportNativeIndex(snapshot);
  const expectedSize = (await fs.stat(snapshot)).size;
  const activePath = svc.store.getDbPath();
  await svc.shutdown();

  function addFreePages(file) {
    const db = new DatabaseSync(file);
    db.exec(`
      DELETE FROM store_meta WHERE key = 'compact_layout';
      CREATE TABLE unused_space (payload BLOB);
      INSERT INTO unused_space VALUES (zeroblob(1048576));
      DROP TABLE unused_space;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    db.close();
  }
  function vectors(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      return [
        db.prepare('SELECT * FROM metadata_embeddings ORDER BY item_id').all(),
        db.prepare('SELECT * FROM passage_embeddings ORDER BY chunk_id').all(),
      ];
    } finally {
      db.close();
    }
  }
  addFreePages(snapshot);
  addFreePages(activePath);
  const originalSize = (await fs.stat(snapshot)).size;
  assert.ok(originalSize > expectedSize * 4);
  assert.ok((await fs.stat(activePath)).size > expectedSize * 4);
  const expectedVectors = vectors(snapshot);

  const { VectorStore } = await importTs('src/zotero/vector-store.ts');
  const store = new VectorStore(root);
  const imported = new VectorStore(path.join(root, 'import-run'));
  try {
    await store.open();
    assert.ok((await fs.stat(activePath)).size < expectedSize + 32768);
    assert.deepEqual(vectors(activePath), expectedVectors);

    await imported.restoreSnapshot(snapshot, (items) => assert.equal(items.length, 2));
    assert.ok((await fs.stat(imported.getDbPath())).size < expectedSize + 32768);
    assert.deepEqual(vectors(imported.getDbPath()), expectedVectors);
    assert.equal((await fs.stat(snapshot)).size, originalSize);
  } finally {
    await store.close();
    await imported.close();
  }
});
