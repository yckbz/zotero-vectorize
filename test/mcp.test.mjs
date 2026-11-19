import test from 'node:test';
import assert from 'node:assert/strict';
import { importTs } from './_helper.mjs';

const { createMcpRequestHandler } = await importTs('src/zotero/mcp/tools.ts');
const { McpController } = await importTs('src/zotero/mcp/controller.ts');
const { startMcpListener } = await importTs('src/zotero/mcp/listener.ts');

function fixture() {
  const paper = {
    id: 1, key: 'PAPER234', libraryID: 1, deleted: false,
    isRegularItem: () => true,
    getField: (name) => ({ title: 'Hydrogen transport', DOI: '10.1000/test' })[name] ?? '',
    getAttachments: () => [10],
  };
  const metadataOnly = {
    ...paper, id: 2, key: 'NOPDF234',
    getField: () => 'Article without a PDF',
    getAttachments: () => [],
  };
  const unindexed = { ...metadataOnly, id: 3, key: 'UNIDX234' };
  const groupPaper = { ...paper, id: 4, libraryID: 6 };
  const pdf = {
    id: 10, key: 'ATTACH23', libraryID: 1, parentItemID: 1,
    isPDFAttachment: () => true,
    getDisplayTitle: () => 'Full text',
    getFilePathAsync: async () => '/pdf',
    attachmentHash: 'revision-1', attachmentModificationTime: 100,
  };
  const chunk = {
    chunkId: 'ATTACH23#0', attachmentID: 10, attachmentKey: pdf.key,
    pageIndex: 1, text: 'Hydrogen bonds enable proton transport in the interfacial water layer.',
  };
  const hit = (item, bestChunk) => ({
    itemID: item.id, itemKey: item.key, libraryID: item.libraryID, bestChunk, extraHits: [],
  });
  const items = [paper, metadataOnly, unindexed, groupPaper, pdf];
  const source = { parentItemID: 1, attachmentKey: pdf.key, fileHash: 'revision-1', mtime: 100, status: 'indexed' };
  const nested = { name: 'Child', getChildCollections: () => [], getChildItems: () => [1, 2] };
  const root = { name: 'Parent', getChildCollections: () => [nested], getChildItems: () => [] };
  const prefix = ['', chunk.text, '', 'Evidence on an unindexed appendix page.'];
  globalThis.IOUtils = {
    exists: async () => true,
    stat: async () => ({ type: 'regular', lastModified: 100 }),
  };
  globalThis.Zotero = {
    Libraries: { userLibraryID: 1 },
    Collections: { getByLibrary: () => [root] },
    Items: {
      getAll: async () => items.filter((item) => item.libraryID === 1),
      getAsync: async (ids) => ids.map((id) => items.find((item) => item.id === id)),
      getByLibraryAndKeyAsync: async (lib, key) => items.find((item) => item.key === key && item.libraryID === lib) ?? false,
    },
    PDFWorker: {
      getFullText: async (_id, count) => {
        const pages = prefix.slice(0, count);
        return { text: pages.join('\f').trim(), extractedPages: pages.length, totalPages: prefix.length };
      },
    },
  };
  const service = {
    search: async (_query, { mode, filterItemIDs }) => {
      const hits = [hit(paper, chunk), hit(metadataOnly), hit(groupPaper, chunk)];
      return {
        hits: hits.filter((entry) => filterItemIDs.has(entry.itemID)),
        diagnostics: { mode, vectorSearchUsed: true, lexicalFallbackUsed: false },
      };
    },
    searchIndex: {
      getItemById: (id) => [1, 2].includes(id),
      getItemChunks: (id) => id === 1 ? [chunk] : [],
    },
    store: { getAttachmentState: async () => source },
    getIndexProgress: () => ({ phase: 'incomplete' }),
    getConfig: () => ({ maxPdfPages: 2 }),
  };
  return { service, paper, pdf, prefix, source };
}

function client(handler) {
  let id = 0;
  async function rpc(method, params, modern = false, signal) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': modern ? '2026-07-28' : '2025-11-25',
    };
    if (modern) {
      headers['Mcp-Method'] = method;
      if (method === 'tools/call') headers['Mcp-Name'] = params.name;
      params = { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } };
    }
    const requestID = ++id;
    const response = await handler.fetch(new Request('http://127.0.0.1:23124/mcp', {
      method: 'POST', headers, signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: requestID, method, params }),
    }));
    assert.equal(response.status, 200);
    if (response.headers.get('Content-Type').startsWith('text/event-stream')) {
      const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: '));
      const reply = events.map((line) => JSON.parse(line.slice(6))).find((event) => event.id === requestID);
      return reply.result;
    }
    return (await response.json()).result;
  }
  return { rpc, call: (name, args, modern, signal) => rpc('tools/call', { name, arguments: args }, modern, signal) };
}

test('MCP discovers both read-only tools and returns scoped evidence plus metadata-only papers', async (t) => {
  const { service, source } = fixture();
  const handler = createMcpRequestHandler(service, '1.0.2', 32_768);
  t.after(() => handler.close());
  const api = client(handler);

  const initial = await api.rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' },
  });
  assert.equal(initial.serverInfo.name, 'zotero-vectorize');
  for (const modern of [false, true]) {
    const { tools } = await api.rpc('tools/list', {}, modern);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['read_pdf_pages', 'search_papers']);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
  }

  const { structuredContent: whole } = await api.call('search_papers', { query: '界面水' }, true);
  assert.deepEqual(whole.papers.map((item) => item.item_key), ['PAPER234', 'NOPDF234']);
  assert.equal(whole.papers[1].fulltext_status, 'no_pdf');
  assert.deepEqual(whole.papers[1].passages, []);
  assert.equal(whole.search.items_in_scope, 3);
  assert.equal(whole.search.indexed_items, 2);
  assert.equal(whole.search.index_phase, 'incomplete');
  assert.equal(whole.papers[0].doi, '10.1000/test');
  const [passage] = whole.papers[0].passages;
  assert.equal(passage.page, 2);
  assert.equal(passage.attachment_key, 'ATTACH23');
  assert.equal(passage.zotero_url, 'zotero://open-pdf/library/items/ATTACH23?page=2');

  const { structuredContent: scoped } = await api.call('search_papers', { query: '界面水', collection_path: ['Parent', 'Child'] });
  assert.equal(scoped.search.items_in_scope, 2);
  const badScope = await api.call('search_papers', { query: 'probe', collection_path: ['Missing'] });
  assert.equal(badScope.isError, true);

  source.status = 'error';
  const partial = await api.call('search_papers', { query: 'hydrogen' });
  assert.equal(partial.structuredContent.papers[0].attachments[0].status, 'error');
  assert.equal(partial.structuredContent.papers[0].passages[0].page, 2);
});

test('MCP reads original pages, preserves empty pages, and rejects stale or unrelated attachments', async (t) => {
  const { service, paper, pdf, prefix } = fixture();
  const handler = createMcpRequestHandler(service, '1.0.2', 32_768);
  t.after(() => handler.close());
  const api = client(handler);
  const args = { item_key: paper.key, attachment_key: pdf.key, start_page: 1 };

  const read = await api.call('read_pdf_pages', { ...args, revision: 'revision-1', end_page: 3 }, true);
  assert.equal(read.structuredContent.total_pages, 4);
  assert.deepEqual(read.structuredContent.pages.map((page) => [page.page, page.status]), [[1, 'no_text'], [2, 'ok'], [3, 'no_text']]);
  assert.equal(read.structuredContent.pages[1].text, prefix[1]);
  const appendix = await api.call('read_pdf_pages', { ...args, start_page: 4 });
  assert.equal(appendix.structuredContent.pages[0].text, prefix[3]);
  const beyondFile = await api.call('read_pdf_pages', { ...args, start_page: 5 });
  assert.equal(beyondFile.structuredContent.status, 'page_out_of_range');

  pdf.attachmentHash = 'revision-2';
  const changed = await api.call('read_pdf_pages', { ...args, revision: 'revision-1' });
  assert.equal(changed.structuredContent.status, 'attachment_changed');
  const stale = await api.call('search_papers', { query: 'hydrogen' });
  assert.equal(stale.structuredContent.papers[0].attachments[0].status, 'stale_index');
  assert.deepEqual(stale.structuredContent.papers[0].passages, []);
  pdf.getFilePathAsync = async () => false;
  const missing = await api.call('read_pdf_pages', args);
  assert.equal(missing.structuredContent.status, 'missing_file');

  pdf.parentItemID = 2;
  const moved = await api.call('read_pdf_pages', args);
  assert.equal(moved.structuredContent.status, 'attachment_not_found');
  const invalidRange = await api.call('read_pdf_pages', { ...args, end_page: 4 });
  assert.equal(invalidRange.isError, true);
});

test('MCP searches wait in order, skip a cancelled request and advance after a failed search', { timeout: 5000 }, async (t) => {
  const { service } = fixture();
  const handler = createMcpRequestHandler(service, '1.0.2', 32_768);
  t.after(() => handler.close());
  const api = client(handler);
  const originalSearch = service.search;
  const started = [];
  const gates = new Map();
  service.search = async (query, options) => {
    started.push(query);
    await new Promise((resolve, reject) => gates.set(query, { resolve, reject }));
    return originalSearch(query, options);
  };
  const controller = new AbortController();
  const call = (query, signal) => api.call('search_papers', { query }, true, signal);
  const nextTurn = () => new Promise(setImmediate);

  const first = call('first');
  const second = call('second');
  await nextTurn();
  assert.deepEqual(started, ['first', 'second']);

  const cancelled = call('cancelled', controller.signal).catch((error) => error);
  const fourth = call('fourth');
  const fifth = call('fifth');
  const sixth = call('sixth');
  await nextTurn();
  assert.deepEqual(started, ['first', 'second']);
  controller.abort();
  const cancelledResult = await cancelled;
  assert.ok(cancelledResult instanceof Error || cancelledResult?.isError);

  gates.get('second').reject(new Error('search failed'));
  assert.equal((await second).isError, true);
  await nextTurn();
  assert.deepEqual(started, ['first', 'second', 'fourth']);

  gates.get('fourth').resolve();
  assert.ok((await fourth).structuredContent);
  await nextTurn();
  assert.deepEqual(started, ['first', 'second', 'fourth', 'fifth']);

  gates.get('first').resolve();
  assert.ok((await first).structuredContent);
  await nextTurn();
  assert.deepEqual(started, ['first', 'second', 'fourth', 'fifth', 'sixth']);

  gates.get('fifth').resolve();
  gates.get('sixth').resolve();
  assert.ok((await fifth).structuredContent);
  assert.ok((await sixth).structuredContent);
});

test('A second PDF read waits for the first while search continues independently', { timeout: 5000 }, async (t) => {
  const { service, paper, pdf } = fixture();
  const handler = createMcpRequestHandler(service, '1.0.2', 32_768);
  t.after(() => handler.close());
  const api = client(handler);
  const originalRead = Zotero.PDFWorker.getFullText;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const calls = [];
  Zotero.PDFWorker.getFullText = async (...args) => {
    calls.push(args[1]);
    started();
    await pending;
    return originalRead(...args);
  };
  const args = { item_key: paper.key, attachment_key: pdf.key, start_page: 2 };
  const first = api.call('read_pdf_pages', args);
  await reading;
  let secondFinished = false;
  const second = api.call('read_pdf_pages', { ...args, start_page: 4 }).finally(() => { secondFinished = true; });
  try {
    const search = await api.call('search_papers', { query: 'hydrogen' });
    assert.equal(search.structuredContent.papers[0].item_key, paper.key);
    assert.deepEqual(calls, [2]);
    assert.equal(secondFinished, false);
  } finally {
    release();
  }
  assert.equal((await first).structuredContent.pages[0].page, 2);
  assert.equal((await second).structuredContent.pages[0].page, 4);
});

test('Closing the HTTP socket aborts the tool and clears the disconnect watcher', { timeout: 5000 }, async (t) => {
  const globals = { Services: globalThis.Services, Components: globalThis.Components, ChromeUtils: globalThis.ChromeUtils };
  const { service } = fixture();
  let handle;
  class HttpServer {
    registerPathHandler(_path, callback) { handle = callback; }
    start() {}
    stop(callback) { callback(); }
  }
  const mainThread = {};
  globalThis.Services = { appShell: { hiddenDOMWindow: globalThis }, tm: { mainThread } };
  globalThis.Components = { interfaces: { nsIAsyncInputStream: { WAIT_CLOSURE_ONLY: 1 } } };
  globalThis.ChromeUtils = { importESModule: (uri) => uri.endsWith('httpd.sys.mjs')
    ? { HttpServer }
    : { NetUtil: { readInputStreamToString: (stream) => stream.body } },
  };
  let started;
  const searchStarted = new Promise((resolve) => { started = resolve; });
  service.search = async (_query, { signal }) => {
    started(signal);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  };

  const stop = startMcpListener(service, '1.0.2', 23124, 'fixture-token');
  t.after(async () => {
    try {
      await stop();
    } finally {
      Object.assign(globalThis, globals);
    }
  });
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'search_papers', arguments: { query: 'hydrogen' } },
  });
  const headers = new Headers({
    Host: '127.0.0.1:23124', Authorization: 'Bearer fixture-token',
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-11-25',
  });
  const statusLines = [];
  let watcher;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  handle({
    method: 'POST', httpVersion: '1.1',
    hasHeader: (name) => headers.has(name), getHeader: (name) => headers.get(name),
    bodyInputStream: { body, available: () => body.length },
  }, {
    _connection: { input: { asyncWait: (callback, flags, _count, target) => {
      if (callback) {
        assert.equal(flags, 1);
        assert.equal(target, mainThread);
      }
      watcher = callback;
    } } },
    processAsync() {},
    setStatusLine: (_version, status) => statusLines.push(status),
    finish,
  });
  const signal = await searchStarted;
  watcher.onInputStreamReady();
  await finished;
  assert.equal(signal.aborted, true);
  assert.equal(watcher, null);
  assert.deepEqual(statusLines, []);
});

test('MCP is lazy by default and waits for the port to close before reopening', async (t) => {
  const originalZotero = globalThis.Zotero;
  const originalServices = globalThis.Services;
  t.after(() => {
    globalThis.Zotero = originalZotero;
    globalThis.Services = originalServices;
    delete globalThis.ZoteroVectorizeMcpModule;
  });

  const prefs = new Map();
  const events = [];
  let closeStarted;
  const closing = new Promise((resolve) => { closeStarted = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  globalThis.Zotero = {
    Prefs: { get: (key) => prefs.get(key), set: (key, value) => prefs.set(key, value) },
    logError: (error) => { throw error; },
  };
  globalThis.Services = { scriptloader: { loadSubScript: (_uri, scope) => {
    events.push('load');
    scope.ZoteroVectorizeMcpModule = { startMcpListener: (_service, _version, _port, token) => {
      assert.match(token, /^[a-f0-9]{64}$/);
      events.push('start');
      return async () => {
        events.push('close');
        closeStarted();
        await released;
        events.push('released');
      };
    } };
  } } };
  const mcp = new McpController({}, '1.0.2', 'file:///zotero-vectorize/');
  mcp.restore();
  assert.deepEqual(events, []);
  await mcp.setEnabled(true);
  const disable = mcp.setEnabled(false);
  const enable = mcp.setEnabled(true);
  await closing;
  try {
    assert.deepEqual(events, ['load', 'start', 'close']);
  } finally {
    release();
  }
  await Promise.all([disable, enable]);
  assert.deepEqual(events, ['load', 'start', 'close', 'released', 'start']);
  assert.equal(mcp.getState().running, true);
  await mcp.dispose();
  assert.equal(mcp.getState().running, false);
});
