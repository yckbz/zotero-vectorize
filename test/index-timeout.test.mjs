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

// Paper 10 with PDF 20 is in the personal library, and paper 11 with PDF 21 is in a group library. Like
// Zotero's PDF worker, the fixture runs one job at a time, so a job that never finishes blocks every job
// queued after it, and it exposes whether a job is running or queued the way Zotero does. `delayJob(id)`
// may return a promise that holds the job for that attachment.
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
  const paper = (id, title, attachmentID, libraryID) => ({
    id, key: `PAPER${id}`, libraryID, itemType: 'journalArticle',
    isRegularItem: () => true,
    getField: (field) => field === 'title' ? title : '',
    getAttachments: () => [attachmentID],
  });
  const attachment = (id, key, parentItemID, libraryID) => ({
    id, key, libraryID, parentItemID,
    isRegularItem: () => false,
    isPDFAttachment: () => true,
    getFilePathAsync: async () => pdf,
    attachmentHash: `${key}-hash`,
    attachmentModificationTime: 1000,
  });
  const items = new Map([paper(10, 'Stuck paper', 20, 1), attachment(20, 'STUCK', 10, 1),
    paper(11, 'Readable paper', 21, 2), attachment(21, 'READABLE', 11, 2)].map((item) => [item.id, item]));
  const makeWorker = () => ({ processing: false, pending: [] });
  const fixture = {
    items,
    requested: new Map(),
    completed: new Map(),
    embedded: [],
    errors: [],
    /** How many library scans listed the personal library. */
    scans: 0,
    worker: makeWorker(),
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
      fixture.worker = makeWorker();
      return fixture.open();
    },
    vectorizedPassages: async (itemID) =>
      (await service.store.getChunksForItem(itemID)).filter((chunk) => chunk.vector).length,
    workerFree: () => waitFor(() => service.indexer.stalledRead === null, 'the PDF worker was not released'),
  };
  const count = (map, id) => map.set(id, (map.get(id) ?? 0) + 1);
  const processQueue = async (worker) => {
    if (worker.processing) return;
    worker.processing = true;
    try {
      while (worker.pending.length) {
        const entry = worker.pending.shift();
        try {
          entry.resolve(await entry.run());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      worker.processing = false;
    }
  };
  const schedule = (run) => {
    const worker = fixture.worker;
    let resolve;
    let reject;
    const job = new Promise((res, rej) => { resolve = res; reject = rej; });
    worker.pending.push({ run, resolve, reject });
    void processQueue(worker);
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
    Libraries: { getAll: () => [{ libraryID: 1, libraryType: 'user' }, { libraryID: 2, libraryType: 'group' }] },
    Items: {
      getAll: async (libraryID) => {
        if (libraryID === 1) fixture.scans++;
        return [...items.values()].filter((item) => item.libraryID === libraryID);
      },
      getAsync: async (id) => items.get(id),
    },
    Notifier: { registerObserver: () => 'test-index', unregisterObserver: () => {} },
    PDFWorker: {
      get _processingQueue() { return exposeQueue ? fixture.worker.processing : undefined; },
      get _queue() { return exposeQueue ? fixture.worker.pending : undefined; },
      getFullText: (id, maxPages) => {
        count(fixture.requested, id);
        return schedule(async () => {
          const custom = await delayJob(id, maxPages);
          count(fixture.completed, id);
          return custom && typeof custom === 'object' && 'text' in custom
            ? custom
            : { text: 'Readable passage about phonon transport in layered crystals.', extractedPages: 1, totalPages: 1 };
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

test('A read that fails after timing out is not kept and keeps its timeout strike', async (t) => {
  // The first two extractions of PDF 20 outlast the timeout and then fail.
  let calls = 0;
  const fixture = await createFixture(t, (id) => id === 20 && ++calls <= 2 &&
    wait(100).then(() => { throw new Error('temporary read failure'); }));
  const service = await fixture.open();
  await service.startIndexing();
  assert.equal((await service.store.getReadTimeout(20)).strikes, 1);
  await fixture.workerFree();
  // A late failure does not prove the PDF is healthy, so the strike survives.
  assert.equal((await service.store.getReadTimeout(20)).strikes, 1);

  // On the second scan, PDF 20 is deferred behind healthy PDF 21, times out and fails late again -> strike 2.
  await service.startIndexing();
  assert.equal(await fixture.vectorizedPassages(11), 1);
  assert.equal((await service.store.getReadTimeout(20)).strikes, 2);
  await fixture.workerFree();
  assert.equal((await service.store.getReadTimeout(20)).strikes, 2);

  // A third incremental scan skips PDF 20 without calling the worker again.
  await service.startIndexing();
  assert.equal(fixture.requested.get(20), 2);
  assert.match(service.getIndexProgress().lastError, /Skipped STUCK because its text extraction timed out twice/);

  // Explicit forced retry reads PDF 20 again, succeeds, and clears the strike.
  await service.indexItems([10], true);
  assert.equal(fixture.requested.get(20), 3);
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(await service.store.getReadTimeout(20), null);
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

test('A rebuild requested during a single-item run runs after it instead of being dropped', async (t) => {
  let busy = null;
  const fixture = await createFixture(t, (id) => id === 21 && busy);
  const service = await fixture.open();
  await service.startIndexing();
  assert.deepEqual([fixture.requested.get(20), fixture.requested.get(21)], [1, 1]);

  let finishItemRun;
  busy = new Promise((resolve) => { finishItemRun = resolve; });
  const itemRun = service.indexItems([11], true);
  await waitFor(() => fixture.requested.get(21) === 2, 'the item run did not start');

  // The rebuild waits for the item run, and the caller's promise settles once the rebuild itself is done.
  let rebuilt = false;
  const rebuild = service.startIndexing(true).then(() => { rebuilt = true; });
  // A second request while the rebuild is queued joins it rather than adding another scan.
  const incremental = service.startIndexing(false);
  await wait(30);
  assert.equal(rebuilt, false);
  busy = null;
  finishItemRun();
  await Promise.all([itemRun, rebuild, incremental]);
  assert.deepEqual([fixture.requested.get(20), fixture.requested.get(21)], [2, 3]);
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(service.indexer.activeRun, null);
});

test('A manual scan during an automatic scan that leaves out a library runs after it', async (t) => {
  let busy = null;
  const fixture = await createFixture(t, (id) => id === 21 && busy);
  const service = await fixture.open();
  // A device that receives a shared index does not index its personal library automatically.
  service.indexSync.shouldAutoIndex = (libraryID) => libraryID !== 1;

  let finish;
  busy = new Promise((resolve) => { finish = resolve; });
  const automaticScan = service.indexer.startLibraryScan(false, true);
  await waitFor(() => fixture.requested.get(21) === 1, 'the automatic scan did not start');
  const manual = service.startIndexing();
  busy = null;
  finish();
  await Promise.all([automaticScan, manual]);
  assert.equal(fixture.scans, 2);
  assert.equal(fixture.requested.get(20), 1);
  assert.equal(await fixture.vectorizedPassages(10), 1);
  assert.equal(fixture.requested.get(21), 1);
});

test('A manual scan during an automatic scan of every library joins it', async (t) => {
  let busy = null;
  const fixture = await createFixture(t, (id) => id === 21 && busy);
  const service = await fixture.open();
  let finish;
  busy = new Promise((resolve) => { finish = resolve; });
  const automaticScan = service.indexer.startLibraryScan(false, true);
  await waitFor(() => fixture.requested.get(21) === 1, 'the automatic scan did not start');
  const manual = service.startIndexing();
  busy = null;
  finish();
  await Promise.all([automaticScan, manual]);
  assert.equal(fixture.scans, 1);
  assert.deepEqual([fixture.requested.get(20), fixture.requested.get(21)], [1, 1]);
});

test('A PDF that waits behind a Zotero job and then hangs after starting still gets recorded and deferred', async (t) => {
  let started = 0;
  const releases = [];
  t.after(() => { for (const release of releases) release(); });
  const fixture = await createFixture(t, (id) => {
    if (id !== 20) return null;
    started++;
    return new Promise((resolve) => { releases.push(resolve); });
  });

  // Round 1: Zotero's own job finishes shortly after the scan starts, then PDF 20 begins extracting and hangs.
  let service = await fixture.open();
  fixture.occupy(wait(15));
  await service.startIndexing();
  assert.equal(started, 1);
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.deepEqual(await service.store.getReadTimeout(20), { fileHash: 'STUCK-hash', mtime: 1000, strikes: 1 });
  assert.equal(await service.store.getReadTimeout(21), null);

  // Round 2: after restart (even with another brief Zotero job), PDF 20 is deferred so healthy PDF 21 is indexed first.
  service = await fixture.restart();
  fixture.occupy(wait(15));
  await service.startIndexing();
  assert.equal(await fixture.vectorizedPassages(11), 1);
  assert.equal(started, 2);
  assert.equal((await service.store.getReadTimeout(20)).strikes, 2);

  // Round 3: after two strikes, PDF 20 is skipped without touching the worker.
  service = await fixture.restart();
  await service.startIndexing();
  assert.equal(started, 2);
  assert.match(service.getIndexProgress().lastError, /Skipped STUCK because its text extraction timed out twice/);
});

test('A healthy PDF waiting behind a long Zotero job still gets its own full extraction timeout', async (t) => {
  const fixture = await createFixture(t, (id) => id === 20 && wait(30).then(() => undefined));
  const service = await fixture.open();
  // 35ms waiting for Zotero + 30ms extracting exceeds the 50ms timeout if combined, but each phase stays within 50ms.
  fixture.occupy(wait(35));
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(await service.store.getReadTimeout(20), null);
  assert.equal(await fixture.vectorizedPassages(10), 1);
  assert.equal(await fixture.vectorizedPassages(11), 1);
});

test('Blank-page binary search gives each worker call its own idle wait and timeout attribution', async (t) => {
  let calls = 0;
  let releaseHang;
  t.after(() => releaseHang?.());
  let mode = 'hang-second';
  const fixture = await createFixture(t, (id, maxPages) => {
    if (id !== 20) return null;
    calls++;
    if (calls === 1) {
      // Three leading blank pages so extractPdfPages triggers binary search for first non-blank page.
      if (mode === 'occupy-before-second') fixture.occupy(new Promise(() => {}));
      return { text: 'Passage after leading blank pages about electron transport.', extractedPages: 4, totalPages: 4 };
    }
    if (mode === 'hang-second') {
      return new Promise((resolve) => { releaseHang = () => resolve({ text: '', extractedPages: maxPages ?? 1, totalPages: 4 }); });
    }
    return { text: maxPages >= 4 ? 'Passage after leading blank pages about electron transport.' : '', extractedPages: maxPages ?? 1, totalPages: 4 };
  });
  let service = await fixture.open();

  // First call waited behind a brief Zotero job, second binary-search call ran on an idle worker and hung -> strike 1.
  fixture.occupy(wait(15));
  await service.startIndexing();
  assert.equal(calls, 2);
  assert.equal((await service.store.getReadTimeout(20)).strikes, 1);

  // Reverse: first call succeeds on idle worker, then Zotero occupies worker indefinitely before the second call -> no strike.
  service = await fixture.restart();
  await service.store.clearReadTimeout(20);
  calls = 0;
  mode = 'occupy-before-second';
  await service.startIndexing();
  assert.equal(calls, 1);
  assert.equal(await service.store.getReadTimeout(20), null);
  assert.match(service.getIndexProgress().lastError, /busy with other PDF tasks/);
});

test('A synchronous error listing libraries does not wedge later library scans', async (t) => {
  const fixture = await createFixture(t, () => null);
  const service = await fixture.open();
  const originalGetAll = Zotero.Libraries.getAll;
  Zotero.Libraries.getAll = () => { throw new Error('libraries unavailable'); };
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'error');
  assert.equal(service.indexer.activeRun, null);

  Zotero.Libraries.getAll = originalGetAll;
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(await fixture.vectorizedPassages(10), 1);
  assert.equal(await fixture.vectorizedPassages(11), 1);
});

test('Bookkeeping metadata cleans up on item delete, profile delete, and reconcile without firing write observers', async (t) => {
  const fixture = await createFixture(t, () => null);
  const service = await fixture.open();
  await service.startIndexing();

  // Local timeout and rebuild-start bookkeeping do not spuriously notify write observers.
  let writeNotifications = 0;
  const unsub = service.store.subscribeWrites(() => { writeNotifications++; });
  await service.store.markRebuildStarted(20);
  await service.store.recordReadTimeout(20, { fileHash: 'STUCK-hash', mtime: 1000 });
  await service.store.clearReadTimeout(20, { fileHash: 'OTHER-hash', mtime: 1000 });
  assert.equal((await service.store.getReadTimeout(20)).strikes, 1, 'mismatched signature must not clear timeout');
  assert.equal(writeNotifications, 0);
  unsub();

  // Removing a parent item clears child rebuild_progress and read_timeout keys from store_meta.
  await service.store.removeItem(10);
  assert.equal(await service.store.getRebuildFrom(20), null);
  assert.equal(await service.store.getReadTimeout(20), null);

  // Deleting a profile removes its rebuild_progress entries while preserving other profiles.
  const activeProfile = service.store.activeProfile;
  const otherProfile = { id: 'other-profile', engine: 'openai', model: 'other', dimensions: 2, provenance: 'verified' };
  await service.store.markRebuildStarted(21);
  await service.store.activateProfile(otherProfile);
  await service.store.markRebuildStarted(21);
  await service.store.activateProfile(activeProfile, otherProfile.id);
  assert.equal(await service.store.getRebuildFrom(21), -1);
  await service.store.deleteProfile(activeProfile.id);
  assert.equal(await service.store.getRebuildFrom(21), null);
  await service.store.activateProfile(otherProfile);
  assert.equal(await service.store.getRebuildFrom(21), null);

  // An orphaned read_timeout for a deleted attachment without attachment_state is cleaned up by reconcileLibrary.
  await service.store.recordReadTimeout(999, { fileHash: 'GONE', mtime: 1 });
  assert.equal((await service.store.getReadTimeout(999)).strikes, 1);
  await service.startIndexing();
  assert.equal(await service.store.getReadTimeout(999), null);
});

test('Worker preemption between idle check and submission never charges a timeout strike to a healthy PDF', async (t) => {
  const fixture = await createFixture(t, () => null);
  let service = await fixture.open();

  // Case 1: Zotero preempts the worker in the microtask right after waitForPdfWorkerIdle sees idle, two restarts in a row.
  for (let session = 0; session < 2; session++) {
    let preempted = false;
    let releaseFront;
    const origWait = service.indexer.waitForPdfWorkerIdle.bind(service.indexer);
    service.indexer.waitForPdfWorkerIdle = async (...args) => {
      // Deterministically release the initial Zotero job once waitForPdfWorkerIdle is actively waiting.
      if (releaseFront) {
        const release = releaseFront;
        releaseFront = undefined;
        setTimeout(release, 5);
      }
      const result = await origWait(...args);
      if (result === 'ready' && !preempted) {
        preempted = true;
        // Grab the worker before requestFullText resumes from await waitForPdfWorkerIdle.
        fixture.occupy(new Promise(() => {}));
      }
      return result;
    };
    fixture.occupy(new Promise((resolve) => { releaseFront = resolve; }));
    await service.startIndexing();
    assert.equal(preempted, true);
    assert.equal(fixture.requested.get(20), undefined);
    assert.equal(await service.store.getReadTimeout(20), null);
    assert.match(service.getIndexProgress().lastError, /busy with other PDF tasks/);
    service = await fixture.restart();
  }

  // Case 2: Worker is preempted synchronously at getFullText submission so target PDF stays in _queue without running.
  const origGetFullText = Zotero.PDFWorker.getFullText;
  let preemptedAtSubmit = false;
  Zotero.PDFWorker.getFullText = (id, maxPages, isPriority) => {
    if (id === 20 && !preemptedAtSubmit) {
      preemptedAtSubmit = true;
      fixture.occupy(new Promise(() => {}));
    }
    return origGetFullText(id, maxPages, isPriority);
  };
  await service.startIndexing();
  Zotero.PDFWorker.getFullText = origGetFullText;
  assert.equal(preemptedAtSubmit, true);
  assert.equal(fixture.completed.get(20), undefined);
  assert.equal(await service.store.getReadTimeout(20), null);
  assert.match(service.getIndexProgress().lastError, /busy with other PDF tasks/);

  // Third restart with an idle worker: the healthy PDF was never charged a strike and indexes cleanly.
  service = await fixture.restart();
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(await fixture.vectorizedPassages(10), 1);
  assert.equal(await fixture.vectorizedPassages(11), 1);
});

test('PDF indexing, busy-worker waits, and cancellation work without a global AbortController', async (t) => {
  const originalAbortController = globalThis.AbortController;
  delete globalThis.AbortController;
  t.after(() => { globalThis.AbortController = originalAbortController; });
  assert.equal(typeof globalThis.AbortController, 'undefined');

  const fixture = await createFixture(t, () => null);
  let service = await fixture.open();

  // 1. Busy-worker timeout path works without global AbortController and does not record a strike.
  fixture.occupy(new Promise(() => {}));
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.equal(await service.store.getReadTimeout(20), null);
  assert.match(service.getIndexProgress().lastError, /busy with other PDF tasks/);
  assert.equal(fixture.errors.length, 0);

  // 2. Cancelling while waiting on a busy worker aborts cleanly without global AbortController.
  service = await fixture.restart();
  service.indexer.readTimeoutMs = 500;
  fixture.occupy(new Promise(() => {}));
  const scan = service.startIndexing();
  await wait(20);
  await service.indexer.cancel();
  await scan;
  assert.equal(service.getIndexProgress().phase, 'idle');
  assert.equal(await service.store.getReadTimeout(20), null);
  assert.equal(fixture.errors.length, 0);

  // 3. Normal PDF extraction and passage vectorization succeed in a sandbox without global AbortController.
  service = await fixture.restart();
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(await fixture.vectorizedPassages(10), 1);
  assert.equal(await fixture.vectorizedPassages(11), 1);
  assert.equal(fixture.errors.length, 0);
});

test('Cancelling while an in-flight PDF stays stuck protects subsequent scans even without queue inspection or AbortController', async (t) => {
  const originalAbortController = globalThis.AbortController;
  delete globalThis.AbortController;
  t.after(() => { globalThis.AbortController = originalAbortController; });

  let release;
  const forever = new Promise((resolve) => { release = resolve; });
  t.after(() => release?.());
  const fixture = await createFixture(t, (id) => id === 20 && forever, { exposeQueue: false });
  const service = await fixture.open();
  service.indexer.readTimeoutMs = 80;

  // Cancel while PDF 20 is stuck in-flight; returns promptly without recording a strike.
  const scan1 = service.startIndexing();
  await waitFor(() => fixture.requested.get(20) === 1, 'PDF 20 did not start');
  const t0 = Date.now();
  await service.indexer.cancel();
  await scan1;
  assert.ok(Date.now() - t0 < 50, 'cancel() should return promptly even when readTimeoutMs is longer');
  assert.equal(await service.store.getReadTimeout(20), null);

  // Subsequent scan sees pendingCancelledReads, avoids submitting behind the stuck job, and records no strikes.
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'incomplete');
  assert.match(service.getIndexProgress().lastError, /busy with other PDF tasks/);
  assert.equal(fixture.requested.get(20), 1);
  assert.equal(fixture.requested.get(21), undefined);
  assert.equal(await service.store.getReadTimeout(20), null);
  assert.equal(await service.store.getReadTimeout(21), null);
  assert.equal(fixture.errors.length, 0);
});

test('Cancelling, clearing, or shutting down during an in-flight PDF read returns promptly without recording timeout strikes', async (t) => {
  let release;
  let hold = new Promise((resolve) => { release = resolve; });
  t.after(() => release?.());
  let calls = 0;
  const fixture = await createFixture(t, (id, maxPages) => {
    if (id !== 20) return null;
    calls++;
    if (calls === 1) {
      // Return leading blank pages if released so we can verify a cancelled read never starts binary search.
      return hold.then(() => ({
        text: 'Passage after leading blank pages about phonon transport.',
        extractedPages: 4,
        totalPages: 4,
      }));
    }
    return { text: maxPages >= 4 ? 'Passage after leading blank pages about phonon transport.' : '', extractedPages: maxPages ?? 1, totalPages: 4 };
  });

  // 1. clearIndex() during an in-flight stuck PDF finishes promptly instead of waiting for readTimeoutMs.
  let service = await fixture.open();
  service.indexer.readTimeoutMs = 600;
  const scan1 = service.startIndexing();
  await waitFor(() => fixture.requested.get(20) === 1, 'PDF 20 read did not start');
  const clearStart = Date.now();
  await service.clearIndex();
  const clearElapsed = Date.now() - clearStart;
  await scan1;
  assert.ok(clearElapsed < 250, `clearIndex() blocked for ${clearElapsed}ms instead of aborting promptly`);
  assert.equal(await service.store.getReadTimeout(20), null);
  assert.equal(service.indexer.stalledRead, null);
  assert.equal(fixture.errors.length, 0);

  // When the cancelled PDF job later finishes, it does not start follow-up binary-search calls or leave stale state.
  release();
  await wait(30);
  assert.equal(calls, 1, 'cancelled extraction must not issue follow-up blank-page binary-search calls');
  assert.equal(await service.store.getReadTimeout(20), null);

  // 2. shutdown() during an in-flight stuck PDF finishes promptly and never persists a timeout strike.
  hold = new Promise((resolve) => { release = resolve; });
  calls = 0;
  service = await fixture.restart();
  service.indexer.readTimeoutMs = 600;
  const dbPath = service.store.getDbPath();
  const scan2 = service.startIndexing();
  await waitFor(() => fixture.requested.get(20) === 2, 'second PDF 20 read did not start');
  const shutdownStart = Date.now();
  await service.shutdown();
  const shutdownElapsed = Date.now() - shutdownStart;
  await scan2;
  assert.ok(shutdownElapsed < 250, `shutdown() blocked for ${shutdownElapsed}ms instead of aborting promptly`);
  assert.equal(fixture.errors.length, 0);
  release();

  // Reopen the same store and verify zero strikes were persisted during shutdown.
  hold = Promise.resolve();
  service = await fixture.open();
  assert.equal(await service.store.getReadTimeout(20), null);
  assert.equal(service.store.getDbPath(), dbPath);
});

test('A scan started right after cancelling an in-flight PDF waits for the worker cleanly, even without queue inspection', async (t) => {
  for (const exposeQueue of [true, false]) {
    let release;
    let delay = new Promise((resolve) => { release = resolve; });
    t.after(() => release?.());
    const fixture = await createFixture(t, (id) => id === 20 && delay, { exposeQueue });
    const service = await fixture.open();
    service.indexer.readTimeoutMs = 400;

    // Cancel while PDF 20 is mid-extraction (e.g. model switch / maintenance), then release 25ms later.
    const scan1 = service.startIndexing();
    await waitFor(() => fixture.requested.get(20) === 1, 'PDF 20 did not start');
    const cancelStart = Date.now();
    await service.indexer.cancel();
    await scan1;
    assert.ok(Date.now() - cancelStart < 200, 'cancel() should not block for readTimeoutMs');
    assert.equal(service.indexer.stalledRead, null);

    // Immediately start a fresh scan before the cancelled worker job finishes; release it 25ms later.
    delay = null;
    setTimeout(() => release(), 25);
    await service.startIndexing();
    assert.equal(service.getIndexProgress().phase, 'completed', `exposeQueue=${exposeQueue}: new scan should complete cleanly`);
    assert.equal(await service.store.getReadTimeout(20), null);
    assert.equal(await fixture.vectorizedPassages(10), 1);
    assert.equal(await fixture.vectorizedPassages(11), 1);
    assert.equal(fixture.errors.length, 0);
  }
});

test('Cancelling while getAttachmentSignature is slow returns promptly without logging an error', async (t) => {
  let releaseStat;
  const fixture = await createFixture(t, () => null);
  const att20 = fixture.items.get(20);
  const origGetFilePath = att20.getFilePathAsync;
  att20.getFilePathAsync = () => new Promise((resolve) => { releaseStat = () => resolve(origGetFilePath()); });
  t.after(() => releaseStat?.());

  const service = await fixture.open();
  service.indexer.readTimeoutMs = 600;
  const scan = service.startIndexing();
  await waitFor(() => Boolean(releaseStat), 'getAttachmentSignature did not start');
  const t0 = Date.now();
  await service.indexer.cancel();
  const elapsed = Date.now() - t0;
  await scan;
  assert.ok(elapsed < 250, `cancel() during getAttachmentSignature blocked for ${elapsed}ms`);
  assert.equal(service.getIndexProgress().phase, 'idle');
  assert.equal(fixture.errors.length, 0);

  // Restore and verify subsequent scan succeeds cleanly.
  att20.getFilePathAsync = origGetFilePath;
  releaseStat();
  await service.startIndexing();
  assert.equal(service.getIndexProgress().phase, 'completed');
  assert.equal(await fixture.vectorizedPassages(10), 1);
  assert.equal(await fixture.vectorizedPassages(11), 1);
});
