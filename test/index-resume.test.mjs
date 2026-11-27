import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importTs } from './_helper.mjs';

import { SqliteConnection } from './_sqlite.mjs';

test('Indexing discovers the gateway batch limit and resumes PDF batches across failure and shutdown', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zv-resume-'));
  const indexDir = path.join(dataDir, 'zotero-vectorize');
  const dbPath = path.join(indexDir, 'vectorize.sqlite');
  const pdf = path.join(dataDir, 'test.pdf');
  await fs.mkdir(indexDir);
  await fs.writeFile(pdf, 'test fixture');
  let service;
  t.after(async () => {
    await service?.shutdown();
    delete globalThis.PathUtils;
    delete globalThis.IOUtils;
    delete globalThis.Zotero;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const prefs = new Map([
    ['engine', 'openai'],
    ['openaiBaseUrl', 'https://example.invalid/v1'],
    ['openaiModel', 'fixture-compatible-model'],
    ['openaiApiKey', 'test-key'],
    ['autoIndexOnStartup', false],
  ]);
  const paper = {
    id: 10, key: 'PAPER', libraryID: 1, itemType: 'journalArticle',
    isRegularItem: () => true,
    getField: (field) => field === 'title' ? 'Fixture article' : '',
    getAttachments: () => [20, 21],
  };
  const attachment = {
    id: 20, key: 'ATT', libraryID: 1, parentItemID: paper.id,
    isRegularItem: () => false,
    isPDFAttachment: () => true,
    getFilePathAsync: async () => pdf,
    attachmentHash: 'fixture-hash',
    attachmentModificationTime: 1000,
  };
  const missing = {
    ...attachment, id: 21, key: 'MISSING',
    getFilePathAsync: async () => null,
    attachmentHash: null,
    attachmentModificationTime: null,
  };
  const items = new Map([paper, attachment, missing].map((item) => [item.id, item]));
  const pages = Array.from({ length: 43 }, (_, i) => `Passage ${i + 1} discusses a test of the indexing pipeline.`);
  let extractionCalls = 0;
  let rejectSecondBatch = true;
  let rejectQueries = false;
  let rejectPassages = false;
  let failExtraction = false;
  const requests = [];
  const probes = [];
  globalThis.PathUtils = { join: path.join };
  globalThis.IOUtils = {
    makeDirectory: (p) => fs.mkdir(p, { recursive: true }),
    exists: (p) => fs.access(p).then(() => true, () => false),
    stat: (p) => fs.stat(p),
  };
  globalThis.Zotero = {
    DBConnection: SqliteConnection,
    Prefs: {
      get: (key) => prefs.get(key.replace('extensions.zotero-vectorize.', '')),
      registerObserver: () => 1,
      unregisterObserver: () => {},
    },
    Libraries: { getAll: () => [{ libraryID: 1, libraryType: 'user' }] },
    Items: { getAll: async () => [...items.values()], getAsync: async (id) => items.get(id) },
    Notifier: { registerObserver: () => 'test-index', unregisterObserver: () => {} },
    PDFWorker: {
      getFullText: async () => {
        extractionCalls++;
        if (failExtraction) throw new Error('PDF read refused by fixture');
        return { text: pages.join('\f'), extractedPages: pages.length, totalPages: pages.length };
      },
    },
    HTTP: {
      request: async (_method, _url, { body }) => {
        const { input } = JSON.parse(body);
        const batch = Array.isArray(input) ? input : [input];
        const isProbe = batch[0] === 'Passage embedding check 1';
        if (isProbe) probes.push(batch.length);
        else requests.push(batch);
        if (batch.length > 20) {
          assert.ok(isProbe);
          return {
            status: 400,
            responseText: JSON.stringify({ error: { message: 'batch size is invalid, it should not be larger than 20.' } }),
          };
        }
        if (rejectQueries && batch[0] === 'pipeline outage query') {
          return { status: 400, responseText: JSON.stringify({ error: { message: 'query refused by fixture' } }) };
        }
        const rejected = (rejectSecondBatch && batch[0] === pages[20]) || (rejectPassages && !isProbe && pages.includes(batch[0]));
        const payload = rejected
          ? { error: { message: 'second batch refused by fixture' } }
          : { data: batch.map((_, index) => ({ index, embedding: [1, 0] })) };
        return { status: rejected ? 400 : 200, responseText: JSON.stringify(payload) };
      },
    },
    locale: 'zh-CN',
    logError: (error) => { throw error; },
  };

  const v1 = new DatabaseSync(dbPath);
  v1.exec(`
    CREATE TABLE attachment_state (
      attachment_id INTEGER PRIMARY KEY, attachment_key TEXT NOT NULL,
      parent_item_id INTEGER NOT NULL, file_hash TEXT NOT NULL, mtime INTEGER NOT NULL,
      status TEXT NOT NULL, chunk_count INTEGER NOT NULL, model_fingerprint TEXT NOT NULL,
      error_message TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO attachment_state VALUES (21, 'MISSING', 10, '', 0, 'missing', 0, '', '', 1);
  `);
  v1.close();

  const { VectorizeService } = await importTs('src/zotero/service.ts');
  const open = async () => {
    service = new VectorizeService({ rootURI: 'file:///test/', dataDir });
    await service.init();
  };
  await open();
  assert.equal(await service.store.getMeta('schema_version'), '3');
  assert.equal((await service.store.getAttachmentState(21)).chunkingKey, '');

  const reader = new DatabaseSync(dbPath, { readOnly: true });
  const countVectors = reader.prepare('SELECT count(vector) AS count FROM passage_embeddings');
  const observations = [];
  const unsubscribeWrites = service.store.subscribeWrites(() => {
    observations.push([service.getIndexProgress().phase, countVectors.get().count]);
  });
  try {
    await service.startIndexing();
  } finally {
    unsubscribeWrites();
    reader.close();
  }
  assert.ok(observations.some(([phase, count]) => phase === 'indexing' && count === 20));
  assert.deepEqual(probes, [24, 20]);
  assert.deepEqual(requests.map((batch) => batch.length), [1, 20, 20]);
  assert.equal(extractionCalls, 1);
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.match(service.getIndexProgress().message, /索引未完成.*second batch refused/);
  assert.equal((await service.store.getAttachmentState(20)).status, 'error');
  const before = await service.store.getChunksForItem(10);
  assert.equal(before.length, 43);
  assert.equal(before.filter((chunk) => chunk.vector).length, 20);
  const metadata = service.searchIndex.getItemById(10);
  let coverage = await service.getStats(await service.getEngineStatus());
  assert.deepEqual([coverage.vectorizedChunks, coverage.failedAttachments, coverage.missingAttachments], [20, 1, 1]);

  // A failed query embedding is an engine error, not an index mismatch that calls for a rebuild.
  rejectQueries = true;
  const outage = await service.search('pipeline outage query', { mode: 'fulltext' });
  rejectQueries = false;
  assert.equal(outage.diagnostics.mismatchWarning, undefined);
  assert.match(outage.diagnostics.engineError, /query refused by fixture/);
  assert.equal(outage.diagnostics.vectorSearchUsed, false);
  assert.ok(outage.hits.length > 0);

  await service.shutdown();
  rejectSecondBatch = false;
  requests.length = 0;
  await open();
  assert.equal(service.searchIndex.getAllChunks().filter((chunk) => chunk.vector).length, 20);
  await service.startIndexing();
  assert.deepEqual(probes, [24, 20, 24, 20]);
  assert.deepEqual(requests.flat(), pages.slice(20));
  assert.deepEqual(requests.map((batch) => batch.length), [20, 3]);
  assert.equal(extractionCalls, 1);
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal((await service.store.getAttachmentState(20)).status, 'indexed');
  const after = await service.store.getChunksForItem(10);
  assert.deepEqual(after.slice(0, 20), before.slice(0, 20));
  assert.deepEqual(service.searchIndex.getItemById(10), metadata);
  coverage = await service.getStats(await service.getEngineStatus());
  assert.deepEqual([coverage.vectorizedChunks, coverage.failedAttachments, coverage.missingAttachments], [43, 0, 1]);

  await service.shutdown();
  requests.length = 0;
  await open();
  await service.startIndexing();
  assert.deepEqual(probes, [24, 20, 24, 20]);
  assert.equal(requests.length, 0);
  assert.equal(extractionCalls, 1);
  assert.equal(service.getIndexProgress().embeddedChunks, 0);

  // Checkpoint reuse when an older extraction lacks its layout signature.
  await service.shutdown();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    UPDATE attachment_state SET chunking_key = '' WHERE attachment_id = 20;
    UPDATE attachment_embeddings SET status = 'error' WHERE attachment_id = 20;
    DELETE FROM passage_embeddings WHERE chunk_id IN (SELECT chunk_id FROM fulltext_chunks WHERE chunk_index >= 20);
  `);
  legacy.close();
  await open();
  await service.startIndexing();
  assert.equal(extractionCalls, 2);
  assert.deepEqual(requests.flat(), pages.slice(20));
  assert.deepEqual((await service.store.getChunksForItem(10)).slice(0, 20), before.slice(0, 20));
  assert.equal((await service.getStats({ modelFingerprint: 'openai:other-model:2', dimensions: 2 })).vectorizedChunks, 0);

  const vectorCount = async () => (await service.store.getChunksForItem(10)).filter((chunk) => chunk.vector).length;
  const passageRequests = () => requests.flat().filter((text) => pages.includes(text));

  // A rebuild during an embedding outage keeps every stored vector, and resumes once the service is back.
  rejectPassages = true;
  await service.startIndexing(true);
  rejectPassages = false;
  assert.equal(extractionCalls, 3);
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.equal(await vectorCount(), 43);
  assert.equal(service.searchIndex.getItemChunks(10).filter((chunk) => chunk.vector).length, 43);
  await service.shutdown();
  requests.length = 0;
  await open();
  await service.startIndexing();
  assert.deepEqual(passageRequests(), pages);
  assert.equal(extractionCalls, 3);
  assert.equal((await service.store.getAttachmentState(20)).status, 'indexed');

  // A rebuild that fails after its first batch resumes with the passages it had not re-embedded.
  rejectSecondBatch = true;
  requests.length = 0;
  await service.startIndexing(true);
  rejectSecondBatch = false;
  // The fixture refuses the second batch (passages 21-40), so only the first 20 are re-embedded.
  assert.deepEqual(passageRequests(), pages.slice(0, 40));
  assert.equal((await service.store.getAttachmentState(20)).status, 'error');
  assert.equal(await vectorCount(), 43);
  await service.shutdown();
  requests.length = 0;
  await open();
  await service.startIndexing();
  assert.deepEqual(passageRequests(), pages.slice(20));
  assert.equal(extractionCalls, 4);
  assert.equal((await service.store.getAttachmentState(20)).status, 'indexed');

  // A cancelled rebuild over incomplete old coverage re-embeds exactly the passages it had not reached.
  await service.shutdown();
  const partial = new DatabaseSync(dbPath);
  partial.exec('DELETE FROM passage_embeddings WHERE chunk_id IN (SELECT chunk_id FROM fulltext_chunks WHERE chunk_index >= 30)');
  partial.close();
  await open();
  let cancellation;
  const unsubscribe = service.subscribeProgress((progress) => {
    if (progress.embeddedChunks === 20 && !cancellation) cancellation = service.indexer.cancel();
  });
  requests.length = 0;
  await service.startIndexing(true);
  await cancellation;
  unsubscribe();
  assert.deepEqual(passageRequests(), pages.slice(0, 20));
  assert.equal((await service.store.getAttachmentState(20)).status, 'pending');
  assert.equal(await vectorCount(), 30);
  await service.shutdown();
  requests.length = 0;
  await open();
  await service.startIndexing();
  assert.deepEqual(passageRequests(), pages.slice(20));
  assert.equal(extractionCalls, 5);
  assert.equal(await vectorCount(), 43);
  assert.equal((await service.store.getAttachmentState(20)).status, 'indexed');

  // A rebuild that cannot read the PDF again keeps the old passages, and the next scan finishes it.
  failExtraction = true;
  requests.length = 0;
  await service.startIndexing(true);
  failExtraction = false;
  assert.equal(extractionCalls, 6);
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.deepEqual(passageRequests(), []);
  assert.equal(await vectorCount(), 43);
  requests.length = 0;
  await service.startIndexing();
  assert.equal(extractionCalls, 7);
  assert.deepEqual(passageRequests(), pages);
  assert.equal(service.getIndexProgress().phase, 'completed');

  await service.shutdown();
  requests.length = 0;
  await open();
  await service.startIndexing();
  assert.equal(requests.length, 0);
});
