import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importTs } from './_helper.mjs';

import { SqliteConnection } from './_sqlite.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, message) {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return;
    await wait(10);
  }
  assert.fail(message);
}

// Paper 10 has PDF 20 and paper 11 has PDF 21. Like Zotero's PDF worker, the fixture runs one job at a
// time, so a job that never finishes blocks every job queued after it, and it exposes whether a job is
// running or queued the way Zotero does. `delayJob(id)` may return a promise that holds the job for that
// attachment.
async function createFixture(t, delayJob, { exposeQueue = true } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zv-timeout-'));
  const pdf = path.join(dataDir, 'test.pdf');
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
    ['uiLanguage', 'en-US'],
  ]);
  const paper = (id, title, attachmentID) => ({
    id, key: `PAPER${id}`, libraryID: 1, itemType: 'journalArticle',
    isRegularItem: () => true,
    getField: (field) => field === 'title' ? title : '',
    getAttachments: () => [attachmentID],
  });
  const attachment = (id, key, parentItemID) => ({
    id, key, libraryID: 1, parentItemID,
    isRegularItem: () => false,
    isPDFAttachment: () => true,
    getFilePathAsync: async () => pdf,
    attachmentHash: `${key}-hash`,
    attachmentModificationTime: 1000,
  });
  const items = new Map([paper(10, 'Stuck paper', 20), attachment(20, 'STUCK', 10),
    paper(11, 'Readable paper', 21), attachment(21, 'READABLE', 11)].map((item) => [item.id, item]));
  const fixture = {
    requested: new Map(),
    completed: new Map(),
    embedded: [],
    errors: [],
    worker: { jobs: 0, queue: Promise.resolve() },
    // A job of Zotero's own, such as indexing new PDFs for its full-text search, that holds the worker.
    occupy: (hold) => schedule(() => hold),
    open: async () => {
      service = new VectorizeService({ rootURI: 'file:///test/', dataDir });
      await service.init();
      service.indexer.readTimeoutMs = 50;
      return service;
    },
    // Restarting Zotero starts a new PDF worker.
    restart: async () => {
      await service.shutdown();
      fixture.worker = { jobs: 0, queue: Promise.resolve() };
      return fixture.open();
    },
    vectorizedPassages: async (itemID) =>
      (await service.store.getChunksForItem(itemID)).filter((chunk) => chunk.vector).length,
    workerFree: () => waitFor(() => service.indexer.stalledRead === null, 'the PDF worker was not released'),
  };
  const count = (map, id) => map.set(id, (map.get(id) ?? 0) + 1);
  const schedule = (run) => {
    const worker = fixture.worker;
    worker.jobs++;
    const job = worker.queue.then(run).finally(() => { worker.jobs--; });
    worker.queue = job.catch(() => {});
    return job;
  };
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
      get _processingQueue() { return exposeQueue ? fixture.worker.jobs > 0 : undefined; },
      get _queue() { return exposeQueue ? [] : undefined; },
      getFullText: (id) => {
        count(fixture.requested, id);
        return schedule(async () => {
          await delayJob(id);
          count(fixture.completed, id);
          return { text: 'Readable passage about phonon transport in layered crystals.', extractedPages: 1, totalPages: 1 };
        });
      },
    },
    HTTP: {
      request: async (_method, _url, { body }) => {
        const { input } = JSON.parse(body);
        const batch = Array.isArray(input) ? input : [input];
        fixture.embedded.push(...batch);
        return { status: 200, responseText: JSON.stringify({ data: batch.map((_, index) => ({ index, embedding: [1, 0] })) }) };
      },
    },
    locale: 'en-US',
    logError: (error) => { fixture.errors.push(error); },
  };
  const { VectorizeService } = await importTs('src/zotero/service.ts');
  return fixture;
}

test('A stuck PDF never blocks the rest of the library and is skipped only after timing out twice', async (t) => {
  let release;
  let stuck = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const fixture = await createFixture(t, (id) => id === 20 && stuck);

  // The stuck PDF is skipped instead of stopping the scan. The PDF queued after it is not read while
  // the worker is held, and is not recorded as timed out.
  let service = await fixture.open();
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.match(service.getIndexProgress().lastError, /did not respond.*skipped\. Other PDFs are not extracted/);
  assert.deepEqual(await service.store.getReadTimeout(20), { fileHash: 'STUCK-hash', mtime: 1000, strikes: 1 });
  assert.equal(fixture.requested.get(21), undefined);
  assert.equal(await service.store.getReadTimeout(21), null);
  assert.ok(service.searchIndex.getItemById(11), 'metadata of the other paper is still indexed');

  // Another scan in the same session neither reads nor blames either PDF.
  await service.startIndexing();
  assert.deepEqual([fixture.requested.get(20), fixture.requested.get(21)], [1, undefined]);
  assert.match(service.getIndexProgress().lastError, /still busy with a PDF that timed out/);
  assert.equal((await service.store.getReadTimeout(20)).strikes, 1);

  // After a restart the PDF that timed out goes last, so the healthy PDF is read first.
  service = await fixture.restart();
  await service.startIndexing();
  assert.deepEqual([fixture.requested.get(20), fixture.completed.get(21)], [2, 1]);
  assert.equal(await fixture.vectorizedPassages(11), 1);
  assert.equal((await service.store.getReadTimeout(20)).strikes, 2);

  // Having timed out twice, the unchanged PDF is skipped without touching the worker.
  service = await fixture.restart();
  await service.startIndexing();
  assert.equal(fixture.requested.get(20), 2);
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.match(service.getIndexProgress().lastError, /Skipped STUCK because its text extraction timed out twice/);

  // Indexing the item explicitly retries the file and clears the record once extraction succeeds.
  stuck = Promise.resolve();
  await service.indexItems([10], true);
  assert.equal(fixture.completed.get(20), 1);
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(await service.store.getReadTimeout(20), null);
  assert.equal(await fixture.vectorizedPassages(10), 1);

  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.deepEqual([fixture.requested.get(20), fixture.requested.get(21)], [3, 1]);
  assert.equal(fixture.errors.length, 0);
});

test('Text Zotero extracts after a timeout is reused by the next scan instead of being read again', async (t) => {
  // Every extraction of the slow PDF takes three times the timeout.
  const fixture = await createFixture(t, (id) => id === 20 && wait(150));
  const service = await fixture.open();
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.equal((await service.store.getReadTimeout(20)).strikes, 1);

  await fixture.workerFree();
  assert.equal(await service.store.getReadTimeout(20), null);
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.deepEqual([fixture.requested.get(20), fixture.requested.get(21)], [1, 1]);
  assert.equal(await fixture.vectorizedPassages(10), 1);
  assert.equal(await fixture.vectorizedPassages(11), 1);
});

test('A read that fails after timing out is not kept, so the next attempt reads the PDF again', async (t) => {
  // The first extraction of PDF 20 outlasts the timeout and then fails. Later ones succeed at once.
  let calls = 0;
  const fixture = await createFixture(t, (id) => id === 20 && ++calls === 1 &&
    wait(150).then(() => { throw new Error('temporary read failure'); }));
  const service = await fixture.open();
  await service.startIndexing();
  assert.equal((await service.store.getReadTimeout(20)).strikes, 1);
  await fixture.workerFree();

  await service.indexItems([10], true);
  assert.equal(fixture.requested.get(20), 2);
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(await fixture.vectorizedPassages(10), 1);
});

test('A PDF that times out only while Zotero runs its own PDF jobs is never skipped', async (t) => {
  const fixture = await createFixture(t, () => null);
  let service = await fixture.open();
  // In two sessions in a row, a job of Zotero's own holds the worker until Zotero quits.
  for (let session = 0; session < 2; session++) {
    fixture.occupy(new Promise(() => {}));
    await service.startIndexing();
    assert.equal(service.getIndexProgress().phase, 'incomplete');
    assert.match(service.getIndexProgress().lastError, /did not respond.*busy with other PDF tasks/);
    assert.equal(await service.store.getReadTimeout(20), null);
    service = await fixture.restart();
  }
  assert.equal(fixture.completed.get(20), undefined);

  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(await fixture.vectorizedPassages(10), 1);
  assert.equal(await fixture.vectorizedPassages(11), 1);
});

test('When Zotero does not expose its PDF queue, every timeout counts toward skipping the file', async (t) => {
  const fixture = await createFixture(t, () => null, { exposeQueue: false });
  const service = await fixture.open();
  fixture.occupy(new Promise(() => {}));
  await service.startIndexing();
  assert.equal((await service.store.getReadTimeout(20)).strikes, 1);
});

test('A rebuild whose PDF reads time out is finished by the next incremental scan', async (t) => {
  let hold = null;
  const fixture = await createFixture(t, (id) => id === 20 && hold);
  const service = await fixture.open();
  await service.startIndexing();
  assert.deepEqual([fixture.requested.get(20), fixture.requested.get(21)], [1, 1]);

  // PDF 20 times out during the rebuild, and PDF 21 waits behind it.
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await service.startIndexing(true);
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.equal(fixture.requested.get(21), 1);
  hold = null;
  release();
  await fixture.workerFree();

  // The rebuild intent survives, so the next scan re-embeds both papers instead of reporting them unchanged.
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(service.getIndexProgress().embeddedChunks, 2);
  assert.deepEqual([fixture.requested.get(20), fixture.requested.get(21)], [2, 2]);
  assert.deepEqual([await service.store.getRebuildFrom(20), await service.store.getRebuildFrom(21)], [null, null]);

  await service.startIndexing();
  assert.equal(service.getIndexProgress().embeddedChunks, 0);
});

test('A late PDF result never starts indexing by itself, even after the index was cleared', async (t) => {
  let release;
  const stuck = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const fixture = await createFixture(t, (id) => id === 20 && stuck);
  const service = await fixture.open();

  // Only the stuck paper is requested. Its PDF times out, then the user clears the index.
  await service.indexItems([10], true);
  assert.equal((await service.store.getReadTimeout(20)).strikes, 1);
  await service.clearIndex();
  assert.deepEqual([service.searchIndex.getItemCount(), service.searchIndex.getChunkCount()], [0, 0]);

  release();
  await fixture.workerFree();
  await wait(50);
  assert.equal(service.indexer.activeRun, null);
  assert.deepEqual([service.searchIndex.getItemCount(), service.searchIndex.getChunkCount()], [0, 0]);
  assert.equal(fixture.requested.get(21), undefined);
  assert.ok(!fixture.embedded.some((text) => /Readable paper/.test(text)), 'an unrequested paper was sent for embedding');

  // The text that arrived after the index was cleared is not kept, so indexing the paper reads its PDF again.
  await service.indexItems([10], true);
  assert.equal(fixture.requested.get(20), 2);
  assert.equal(await fixture.vectorizedPassages(10), 1);
});

test('A forced retry requested while another run is busy keeps its force flag', async (t) => {
  let busy = null;
  const fixture = await createFixture(t, (id) => id === 21 && busy);
  const service = await fixture.open();
  // The PDF has timed out twice, so only a forced retry reads it again.
  await service.store.recordReadTimeout(20, { fileHash: 'STUCK-hash', mtime: 1000 });
  await service.store.recordReadTimeout(20, { fileHash: 'STUCK-hash', mtime: 1000 });
  assert.equal((await service.store.getReadTimeout(20)).strikes, 2);

  let finishBusyRun;
  busy = new Promise((resolve) => { finishBusyRun = resolve; });
  const busyRun = service.indexItems([11], true);
  await waitFor(() => fixture.requested.get(21) === 1, 'the busy run did not start');

  // "Vectorize Selected Items" on the timed-out paper is queued behind the busy run.
  await service.indexItems([10], true);
  assert.equal(fixture.requested.get(20), undefined);
  finishBusyRun();
  await busyRun;
  await waitFor(async () => fixture.completed.get(20) === 1 && await service.store.getReadTimeout(20) === null,
    'the queued forced retry ran as a normal scan and skipped the timed-out PDF');
  await waitFor(() => service.getIndexProgress().phase === 'completed', 'the forced retry did not finish');
  assert.equal(await fixture.vectorizedPassages(10), 1);
});
