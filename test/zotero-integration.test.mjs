import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importTs } from './_helper.mjs';

test('VectorStore, BackgroundIndexer, and VectorizeService incremental lifecycle + Zotero Sqlite invariants', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zv-int-'));

  // Minimal in-memory Zotero sandbox mimicking DBConnection, Items, PDFWorker, Notifier, Prefs, IOUtils
  const tables = {
    store_meta: new Map(),
    item_vectors: new Map(),
    fulltext_chunks: new Map(),
    attachment_state: new Map(),
  };

  class StrictMockDBConnection {
    constructor(dbPath) {
      this.path = dbPath;
      this.closed = false;
    }
    async executeTransaction(fn) {
      await fn();
    }
    async tableExists() {
      return true;
    }
    async closeDatabase() {
      this.closed = true;
    }
    _validateParams(sql, params) {
      if (!Array.isArray(params) || params.length === 0) return;
      // Enforce Gecko Sqlite.sys.mjs rule: params[0] must NEVER be a non-null object (e.g. Uint8Array!)
      if (typeof params[0] === 'object' && params[0] !== null) {
        throw new Error(`Sqlite.sys.mjs object-param trap triggered! params[0]=${params[0].constructor?.name} SQL=${sql}`);
      }
      for (let i = 0; i < params.length; i++) {
        if (params[i] === undefined) throw new Error(`Undefined SQL param at index ${i}`);
        if (params[i] instanceof Uint8Array && params[i].byteLength === 0) {
          throw new Error(`Empty Uint8Array(0) BLOB disallowed in Gecko bindBlobByIndex at param ${i}: ${sql}`);
        }
      }
    }
    async queryAsync(sql, params = []) {
      this._validateParams(sql, params);
      const s = sql.trim().replace(/\s+/g, ' ');
      if (s.startsWith('PRAGMA') || s.startsWith('CREATE ')) return [];
      if (s.startsWith('INSERT OR IGNORE INTO store_meta')) {
        if (!tables.store_meta.has(params[0])) tables.store_meta.set(params[0], params[1]);
        return [];
      }
      if (s.startsWith('INSERT OR REPLACE INTO store_meta')) {
        tables.store_meta.set(params[0], params[1]);
        return [];
      }
      if (s.startsWith('INSERT OR REPLACE INTO item_vectors')) {
        tables.item_vectors.set(params[0], {
          item_id: params[0], item_key: params[1], library_id: params[2], item_type: params[3],
          title: params[4], creators: params[5], year: params[6], publication_title: params[7],
          doi: params[8], url: params[9], tags_json: params[10], abstract_note: params[11],
          metadata_hash: params[12], vector: params[13] ? new Uint8Array(params[13]) : null, dim: params[14],
          model_fingerprint: params[15], updated_at: params[16],
        });
        return [];
      }
      if (s.startsWith('INSERT OR REPLACE INTO fulltext_chunks')) {
        tables.fulltext_chunks.set(params[0], {
          chunk_id: params[0], item_id: params[1], item_key: params[2], attachment_id: params[3],
          attachment_key: params[4], attachment_title: params[5], chunk_index: params[6],
          page_index: params[7], page_label: params[8], char_start: params[9], char_end: params[10],
          text: params[11], snippet: params[12], vector: params[13] ? new Uint8Array(params[13]) : null, dim: params[14],
          model_fingerprint: params[15], updated_at: params[16],
        });
        return [];
      }
      if (s.startsWith('INSERT OR REPLACE INTO attachment_state')) {
        tables.attachment_state.set(params[0], {
          attachment_id: params[0], attachment_key: params[1], parent_item_id: params[2],
          file_hash: params[3], mtime: params[4], status: params[5], chunk_count: params[6],
          model_fingerprint: params[7], error_message: params[8], updated_at: params[9],
          chunking_key: params[10],
        });
        return [];
      }
      if (s.startsWith('SELECT') && s.includes('FROM item_vectors') && !s.includes('COUNT(*)')) {
        return Array.from(tables.item_vectors.values());
      }
      if (s === 'SELECT attachment_id FROM attachment_state') {
        return Array.from(tables.attachment_state.values());
      }
      if (s === 'SELECT DISTINCT item_id FROM fulltext_chunks WHERE attachment_id = ? AND item_id != ?') {
        const ids = new Set(Array.from(tables.fulltext_chunks.values())
          .filter((row) => row.attachment_id === params[0] && row.item_id !== params[1])
          .map((row) => row.item_id));
        return Array.from(ids, (item_id) => ({ item_id }));
      }
      if (s.startsWith('SELECT') && s.includes('FROM fulltext_chunks') && s.includes('WHERE item_id = ?')) {
        return Array.from(tables.fulltext_chunks.values()).filter((r) => r.item_id === params[0]);
      }
      if (s.startsWith('SELECT') && s.includes('FROM fulltext_chunks')) {
        return Array.from(tables.fulltext_chunks.values());
      }
      if (s.startsWith('DELETE FROM item_vectors WHERE item_id = ?')) {
        tables.item_vectors.delete(params[0]);
        return [];
      }
      if (s.startsWith('DELETE FROM fulltext_chunks WHERE item_id = ? AND attachment_key = ?')) {
        for (const [k, v] of tables.fulltext_chunks) {
          if (v.item_id === params[0] && v.attachment_key === params[1]) tables.fulltext_chunks.delete(k);
        }
        return [];
      }
      if (s.startsWith('DELETE FROM fulltext_chunks WHERE item_id = ?')) {
        for (const [k, v] of tables.fulltext_chunks) {
          if (v.item_id === params[0]) tables.fulltext_chunks.delete(k);
        }
        return [];
      }
      if (s.startsWith('DELETE FROM fulltext_chunks WHERE attachment_id = ?')) {
        for (const [k, v] of tables.fulltext_chunks) {
          if (v.attachment_id === params[0]) tables.fulltext_chunks.delete(k);
        }
        return [];
      }
      if (s.startsWith('DELETE FROM attachment_state WHERE parent_item_id = ?')) {
        for (const [k, v] of tables.attachment_state) {
          if (v.parent_item_id === params[0]) tables.attachment_state.delete(k);
        }
        return [];
      }
      if (s.startsWith('DELETE FROM attachment_state WHERE attachment_id = ?')) {
        tables.attachment_state.delete(params[0]);
        return [];
      }
      if (s === 'DELETE FROM item_vectors') { tables.item_vectors.clear(); return []; }
      if (s === 'DELETE FROM fulltext_chunks') { tables.fulltext_chunks.clear(); return []; }
      if (s === 'DELETE FROM attachment_state') { tables.attachment_state.clear(); return []; }
      if (s.startsWith('DELETE FROM store_meta')) { return []; }
      return [];
    }
    async rowQueryAsync(sql, params = []) {
      this._validateParams(sql, params);
      const s = sql.trim().replace(/\s+/g, ' ');
      if (s.includes('FROM item_vectors WHERE item_id = ?')) {
        return tables.item_vectors.get(params[0]) ?? false;
      }
      if (s.includes('FROM attachment_state WHERE attachment_id = ?')) {
        return tables.attachment_state.get(params[0]) ?? false;
      }
      if (s.includes('FROM item_vectors') && s.includes('COUNT(*)')) {
        const list = Array.from(tables.item_vectors.values());
        return {
          total: list.length,
          vec_count: list.filter((x) => x.dim > 0).length,
          max_dim: list.reduce((m, x) => Math.max(m, x.dim), 0),
        };
      }
      if (s.includes('FROM fulltext_chunks') && s.includes('COUNT(*)')) {
        const list = Array.from(tables.fulltext_chunks.values());
        return {
          total: list.length,
          vec_count: list.filter((x) => x.dim > 0).length,
          max_dim: list.reduce((m, x) => Math.max(m, x.dim), 0),
        };
      }
      if (s.includes('ORDER BY updated_at DESC LIMIT 1')) {
        const list = Array.from(tables.item_vectors.values()).filter((x) => x.dim > 0);
        return list[0] ? { model_fingerprint: list[0].model_fingerprint } : false;
      }
      return false;
    }
    async valueQueryAsync(sql, params = []) {
      this._validateParams(sql, params);
      const s = sql.trim().replace(/\s+/g, ' ');
      if (s.includes('FROM store_meta')) return tables.store_meta.get(params[0]) ?? false;
      if (s.includes('FROM attachment_state WHERE attachment_id')) {
        return tables.attachment_state.get(params[0])?.parent_item_id ?? false;
      }
      if (s.includes('FROM attachment_state')) return tables.attachment_state.size;
      return 0;
    }
  }

  // Create dummy PDF file on disk for stat/exists
  const pdfFile = path.join(tmpDir, 'paper.pdf');
  await fs.writeFile(pdfFile, '%PDF-1.4 dummy');

  const prefsMap = new Map([
    ['extensions.zotero-vectorize.engine', 'local-onnx'],
    ['extensions.zotero-vectorize.autoIndexOnStartup', false],
    ['extensions.zotero-vectorize.autoIndexOnChange', true],
  ]);
  let notifierCallback = null;
  let pdfExtractCalls = 0;

  let paperTitle = 'Attention Is All You Need';
  let paperMtime = 1000;
  let paperHash = 'hash-v1';

  const itemsMap = new Map([
    [
      10,
      {
        id: 10,
        key: 'PAPER10',
        libraryID: 1,
        itemType: 'journalArticle',
        deleted: false,
        dateModified: '2024-01-01',
        isRegularItem: () => true,
        isAttachment: () => false,
        isPDFAttachment: () => false,
        getField: (f) => {
          if (f === 'title') return paperTitle;
          if (f === 'date') return '2017';
          if (f === 'abstractNote') return 'The dominant sequence transduction models rely on self-attention.';
          return '';
        },
        getCreators: () => [{ firstName: 'Ashish', lastName: 'Vaswani' }],
        getTags: () => [{ tag: 'transformer' }],
        getAttachments: () => [20],
        getDisplayTitle: () => paperTitle,
      },
    ],
    [
      20,
      {
        id: 20,
        key: 'ATT20',
        libraryID: 1,
        itemType: 'attachment',
        deleted: false,
        parentItemID: 10,
        dateModified: '2024-01-01',
        isRegularItem: () => false,
        isAttachment: () => true,
        isPDFAttachment: () => true,
        get attachmentHash() { return Promise.resolve(paperHash); },
        get attachmentModificationTime() { return Promise.resolve(paperMtime); },
        getFilePathAsync: async () => pdfFile,
        getDisplayTitle: () => 'Attention.pdf',
      },
    ],
  ]);

  globalThis.PathUtils = {
    join: (...p) => path.join(...p),
    parent: (p) => path.dirname(p),
    filename: (p) => path.basename(p),
  };
  globalThis.IOUtils = {
    exists: async (p) => fs.access(p).then(() => true, () => false),
    makeDirectory: async (p) => { await fs.mkdir(p, { recursive: true }); },
    stat: async (p) => {
      const s = await fs.stat(p);
      return { size: s.size, lastModified: s.mtimeMs, type: 'regular' };
    },
    read: async (p) => new Uint8Array(await fs.readFile(p)),
    readUTF8: async (p) => fs.readFile(p, 'utf8'),
    readJSON: async (p) => JSON.parse(await fs.readFile(p, 'utf8')),
    writeUTF8: async (p, d) => { await fs.writeFile(p, d, 'utf8'); return d.length; },
    copy: async (s, d) => fs.copyFile(s, d),
    remove: async (p) => fs.rm(p, { force: true }),
  };
  globalThis.Zotero = {
    DataDirectory: { dir: tmpDir },
    DBConnection: StrictMockDBConnection,
    Prefs: {
      get: (k) => prefsMap.get(k),
      set: (k, v) => prefsMap.set(k, v),
      registerObserver: () => Symbol('obs'),
      unregisterObserver: () => {},
    },
    Libraries: {
      getAll: () => [{ libraryID: 1, name: 'My Library', libraryType: 'user' }],
    },
    Items: {
      getAll: async () => Array.from(itemsMap.values()),
      getAsync: async (id) => itemsMap.get(id) ?? false,
    },
    PDFWorker: {
      getFullText: async () => {
        pdfExtractCalls++;
        return {
          text: [
            'Page 1 introduction about sequence modeling.',
            '', // blank page 2
            'Page 3 explains scaled dot-product attention and multi-head projections in detail.',
          ].join('\f'),
          extractedPages: 3,
          totalPages: 3,
        };
      },
    },
    Notifier: {
      registerObserver: (obs) => {
        notifierCallback = obs.notify;
        return 'notif-1';
      },
      unregisterObserver: () => { notifierCallback = null; },
    },
    debug: () => {},
    logError: (e) => { throw e; },
    warn: () => {},
    locale: 'zh-CN',
  };

  try {
    const { VectorizeService } = await importTs('src/zotero/service.ts');
    const svc = new VectorizeService({ rootURI: 'file:///plugin/', dataDir: tmpDir });
    await svc.init();

    // 1. Initial background scan (no ONNX installed -> extracts text for keyword search)
    await svc.startIndexing(false);
    assert.equal(pdfExtractCalls, 1);

    const stats1 = await svc.getStats();
    assert.equal(stats1.indexedItems, 1);
    assert.equal(stats1.indexedChunks, 2);

    const getProvider = svc.providerManager.getProvider;
    let searchProviderCalls = 0;
    svc.providerManager.getProvider = async (...args) => {
      searchProviderCalls++;
      return getProvider.apply(svc.providerManager, args);
    };
    const searchRes = await svc.search('multi-head projections', { mode: 'hybrid' });
    assert.equal(searchProviderCalls, 0);
    svc.providerManager.getProvider = getProvider;
    assert.equal(searchRes.hits.length, 1);
    assert.equal(searchRes.hits[0].itemID, 10);
    assert.equal(searchRes.hits[0].bestChunk?.pageIndex, 2); // Page 3 (0-based 2)!

    // 2. Re-running scan without changes MUST skip PDF extraction cleanly
    await svc.startIndexing(false);
    assert.equal(pdfExtractCalls, 1);

    // 3. Modifying metadata title re-indexes metadata without re-extracting unchanged PDF
    paperTitle = 'Attention Is All You Need (Revised)';
    await svc.indexItems([10], false);
    assert.equal(pdfExtractCalls, 1);
    assert.equal(svc.searchIndex.getItemById(10)?.title, 'Attention Is All You Need (Revised)');

    // 4. Modifying PDF mtime triggers re-extraction
    paperMtime = 2000;
    paperHash = 'hash-v2';
    await svc.indexItems([10], false);
    assert.equal(pdfExtractCalls, 2);

    // 5. Export & import JSON compat roundtrip (verifies vector_store_metadata.json!)
    const exportDir = path.join(tmpDir, 'export');
    const exp = await svc.exportCompatJsonToFolder(exportDir);
    assert.equal(exp.files.length, 3);
    assert.ok(exp.files.some((p) => p.endsWith('vector_store_metadata.json')), 'Expected vector_store_metadata.json');

    // 5b. Pending debounce IDs queued while activeRun is busy MUST drain and index after completion
    paperTitle = 'Attention Updated During Scan';
    const scanPromise = svc.startIndexing(false);
    await svc.indexer.indexItemOrAttachmentIds([10], false);
    await scanPromise;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(svc.searchIndex.getItemById(10)?.title, 'Attention Updated During Scan');

    // 5c. Config preserves explicit 0 for chunkOverlap/maxPdfPages and ignores invalid numbers
    const cfgMod = await importTs('src/zotero/config.ts');
    const defaults = cfgMod.readPluginConfig();
    assert.deepEqual([defaults.chunkSize, defaults.chunkOverlap, defaults.maxPdfPages], [1024, 128, 64]);
    prefsMap.set('extensions.zotero-vectorize.chunkOverlap', 0);
    prefsMap.set('extensions.zotero-vectorize.maxPdfPages', 'invalid');
    const parsedCfg = cfgMod.readPluginConfig();
    assert.equal(parsedCfg.chunkOverlap, 0);
    assert.equal(parsedCfg.maxPdfPages, 64);

    // 5d. getActiveCollectionItemIDs uses modern getSelectedCollections / getSelectedSavedSearches
    const renderUtils = await importTs('src/zotero/ui/render-utils.ts');
    const colIds = await renderUtils.getActiveCollectionItemIDs({
      ZoteroPane: {
        getSelectedCollections: () => [{ getChildItems: async (asIds, incTrashed) => {
          assert.equal(asIds, true);
          assert.equal(incTrashed, false);
          return [10];
        } }],
        getSelectedSavedSearches: () => [],
      },
    });
    assert.deepEqual(Array.from(colIds), [10]);

    const searchIds = await renderUtils.getActiveCollectionItemIDs({
      ZoteroPane: {
        getSelectedCollections: () => [],
        getSelectedSavedSearches: () => [{ search: async () => [10, 99] }],
      },
    });
    assert.deepEqual(Array.from(searchIds), [10, 99]);

    // 5e. Imported JSON vectors & hash alignment MUST NOT be wiped by background lexical-only indexing
    const compatImportDir = path.join(tmpDir, 'compat-import');
    await fs.mkdir(compatImportDir, { recursive: true });
    await fs.writeFile(
      path.join(compatImportDir, 'metadata_vectors.json'),
      JSON.stringify([
        {
          zotero_item_key: 'PAPER10',
          title: paperTitle,
          abstractNote: 'The dominant sequence transduction models rely on self-attention.',
          embedding: [0.8, 0.6, 0, 0],
        },
      ])
    );
    await fs.writeFile(
      path.join(compatImportDir, 'fulltext_vectors.json'),
      JSON.stringify([
        {
          chunk_id: 'ATT20#2',
          item_key: 'PAPER10',
          attachment_key: 'ATT20',
          page_index: 2,
          text: 'Page 3 explains scaled dot-product attention and multi-head projections in detail.',
          embedding: [0.6, 0.8, 0, 0],
        },
      ])
    );
    await fs.writeFile(
      path.join(compatImportDir, 'vector_store_metadata.json'),
      JSON.stringify({
        schema_version: '1.0',
        engine: 'local-onnx',
        model: 'Xenova/multilingual-e5-small',
        model_fingerprint: 'local-onnx:Xenova/multilingual-e5-small:4',
        dimension: 4,
      })
    );
    const imp = await svc.importCompatJsonFromFolder(compatImportDir);
    assert.equal(imp.importedItems, 1);
    assert.equal(imp.importedChunks, 1);

    // Clear attachment_state as happens on fresh JSON import before any local scan, then run incremental scan in lexical-only mode
    tables.attachment_state.clear();
    await svc.indexer.indexItemOrAttachmentIds([10], false);
    const statsAfter = await svc.getStats();
    assert.equal(statsAfter.vectorizedItems, 1);
    assert.equal(statsAfter.vectorizedChunks, 1);
    assert.equal(statsAfter.dimensions, 4);
    assert.equal(svc.searchIndex.getItemById(10)?.dim, 4);

    // Also verify hashMetadataFields matches extractItemMetadata when full metadata fields are provided
    const extractor = await importTs('src/zotero/extractor.ts');
    const compatJson = await importTs('src/core/compat-json.ts');
    const expectedMeta = extractor.extractItemMetadata(itemsMap.get(10));
    const parsedAligned = compatJson.parseVectorStoreJson(
      {
        metadataJson: [
          {
            zotero_item_key: 'PAPER10',
            title: expectedMeta.title,
            creators: expectedMeta.creators,
            year: expectedMeta.year,
            publication_title: expectedMeta.publicationTitle,
            doi: expectedMeta.doi,
            tags: expectedMeta.tags,
            abstract_note: expectedMeta.abstractNote,
            embedding: [0.8, 0.6, 0, 0],
          },
        ],
        fulltextJson: [],
        storeMetaJson: { dimension: 4 },
      },
      () => ({ itemID: 10, libraryID: 1 })
    );
    assert.equal(parsedAligned.items[0]?.metadataHash, expectedMeta.metadataHash);

    // 5f. Nested data-format.md import via VectorizeService (itemID/attachmentID without key in fulltext_vectors.json)
    const nestedDir = path.join(tmpDir, 'compat-nested');
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(
      path.join(nestedDir, 'metadata_vectors.json'),
      JSON.stringify([
        {
          itemID: 10,
          key: 'PAPER10',
          metadata: {
            title: paperTitle,
            abstractNote: 'The dominant sequence transduction models rely on self-attention.',
            authors: [{ name: 'Ashish Vaswani', type: 'author' }],
            tags: ['transformer'],
            date: '2017-06-12',
          },
          itemType: 'journalArticle',
          vector: [0.8, 0.6, 0, 0],
          vector_dimension: 4,
          model: 'paraphrase-multilingual-MiniLM-L12-v2',
        },
      ])
    );
    await fs.writeFile(
      path.join(nestedDir, 'fulltext_vectors.json'),
      JSON.stringify([
        {
          itemID: 10,
          attachmentID: 20,
          title: paperTitle,
          pdf_file: 'Attention.pdf',
          chunks: [
            {
              chunk_id: '10_0',
              text: 'Nested chunk on page 3 explaining scaled dot-product attention.',
              vector: [0.6, 0.8, 0, 0],
              page: 3,
            },
          ],
        },
      ])
    );
    await fs.writeFile(
      path.join(nestedDir, 'vector_store_metadata.json'),
      JSON.stringify({
        embedding_model: 'paraphrase-multilingual-MiniLM-L12-v2',
        embedding_dimension: 4,
      })
    );
    await svc.clearIndex();
    const impNested = await svc.importCompatJsonFromFolder(nestedDir);
    assert.equal(impNested.importedItems, 1);
    assert.equal(impNested.importedChunks, 1);
    assert.equal(svc.searchIndex.getItemById(10)?.year, '2017');
    const nestedChunks = await svc.store.getChunksForItem(10);
    assert.equal(nestedChunks[0]?.attachmentID, 20);
    assert.equal(nestedChunks[0]?.attachmentKey, 'ATT20');
    assert.equal(nestedChunks[0]?.pageIndex, 2);

    const originalGetFullText = Zotero.PDFWorker.getFullText;
    const trimmedPages = ['', '', 'DFT identifies the reaction mechanism in a charged interface.', ''];
    try {
      Zotero.PDFWorker.getFullText = async (_id, count) => {
        const pages = trimmedPages.slice(0, count ?? trimmedPages.length);
        return { text: pages.join('\f').trim(), extractedPages: pages.length, totalPages: trimmedPages.length };
      };
      const signature = await extractor.getAttachmentSignature(itemsMap.get(20));
      const pdf = await extractor.extractPdfPages(itemsMap.get(20), 0, signature);
      assert.equal(pdf.pages[0].pageIndex, 2);
      assert.equal(pdf.pages[0].pageLabel, '3');
    } finally {
      Zotero.PDFWorker.getFullText = originalGetFullText;
    }

    // A pending Zotero PDF worker read must release the active scan without replacing the old chunks.
    const originalLogError = Zotero.logError;
    const originalSetTimeout = globalThis.setTimeout;
    let extractionStarted = false;
    try {
      Zotero.PDFWorker.getFullText = () => {
        extractionStarted = true;
        return new Promise(() => {});
      };
      Zotero.logError = () => {};
      globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 120_000 ? 10 : ms, ...args);
      await svc.startIndexing(true);
      assert.equal(extractionStarted, true);
      assert.equal(svc.getIndexProgress().phase, 'error');
      assert.match(svc.getIndexProgress().lastError, /抽取 PDF 正文.*120 秒/);
      assert.equal(svc.searchIndex.getChunkCount(), 1);
    } finally {
      Zotero.PDFWorker.getFullText = originalGetFullText;
      Zotero.logError = originalLogError;
      globalThis.setTimeout = originalSetTimeout;
    }

    // Fresh Ollama providers do not know the dimension of a tagged model until inference.
    let embeddingCalls = 0;
    svc.providerManager.getProvider = async () => ({
      engine: 'ollama',
      model: 'nomic-embed-text:latest',
      getPassageBatchSize: () => 16,
      getModelFingerprint: () => 'ollama:nomic-embed-text:latest',
      getStatus: async () => ({ neuralAvailable: true, dimensions: 0 }),
      embedPassages: async (texts, onProgress) => {
        embeddingCalls++;
        onProgress?.(texts.length);
        return texts.map(() => new Float32Array([1, 0]));
      },
    });
    const phases = [];
    const stopProgress = svc.subscribeProgress((p) => phases.push(p.message));
    await svc.startIndexing(true);
    stopProgress();
    assert.ok(phases.includes('正在向量化 PDF 分块 0/2'));
    assert.ok(phases.includes('正在向量化 PDF 分块 2/2'));
    assert.equal(embeddingCalls, 2);
    await svc.startIndexing(false);
    assert.equal(embeddingCalls, 2);
    assert.equal(svc.searchIndex.getItemById(10)?.modelFingerprint, 'ollama:nomic-embed-text:latest:2');

    // A foreign item key must never resolve through a colliding numeric ID.
    const collisionDir = path.join(tmpDir, 'compat-collision');
    await fs.mkdir(collisionDir);
    await fs.writeFile(path.join(collisionDir, 'metadata_vectors.json'), JSON.stringify([
      { itemID: 10, key: 'PAPER10', title: paperTitle, vector: [1, 0] },
      { itemID: 10, key: 'FOREIGN10', title: 'Foreign record', vector: [1, 0] },
    ]));
    await fs.writeFile(path.join(collisionDir, 'fulltext_vectors.json'), JSON.stringify([
      { itemID: 10, item_key: 'FOREIGN10', text: 'Foreign passage', vector: [1, 0] },
    ]));
    const collision = await svc.importCompatJsonFromFolder(collisionDir);
    assert.equal(collision.importedItems, 1);
    assert.equal(collision.importedChunks, 0);
    assert.equal(svc.searchIndex.getItemById(10)?.title, paperTitle);
    assert.equal(svc.searchIndex.getChunkCount(), 2);

    // Unchanged file signature and model must not hide an attachment move.
    const formerParent = itemsMap.get(10);
    itemsMap.set(30, { ...formerParent, id: 30, key: 'PAPER30' });
    formerParent.getAttachments = () => [];
    itemsMap.get(20).parentItemID = 30;
    await svc.indexItems([20], false);
    assert.equal((await svc.store.getAttachmentState(20))?.parentItemID, 30);
    assert.equal((await svc.store.getChunksForItem(10)).length, 0);
    assert.equal((await svc.store.getChunksForItem(30)).length, 2);
    assert.deepEqual(svc.searchIndex.getAllChunks().map((c) => c.itemID), [30, 30]);

    // A library scan reconciles both tables and memory when deletion events were missed.
    itemsMap.get(20).deleted = true;
    itemsMap.get(30).getAttachments = () => [];
    await svc.startIndexing(false);
    assert.equal(await svc.store.getAttachmentState(20), null);
    assert.equal(svc.searchIndex.getChunkCount(), 0);
    assert.equal((await svc.store.getChunksForItem(30)).length, 0);
    itemsMap.delete(30);
    await svc.startIndexing(false);
    assert.equal(svc.searchIndex.getItemById(30), undefined);
    assert.equal(tables.item_vectors.has(30), false);

    svc.updateConfig({ hybridSemanticWeight: 0 });
    svc.providerManager.getProvider = async () => { throw new Error('Lexical search called the embedding provider'); };
    const lexicalResult = await svc.search('attention');
    assert.equal(lexicalResult.hits[0].itemID, 10);
    assert.equal(lexicalResult.diagnostics.vectorSearchUsed, false);

    // 6. Notifier delete cleans store and in-memory index
    assert.ok(notifierCallback);
    notifierCallback('delete', 'item', [10], {});
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(svc.searchIndex.getItemCount(), 0);
    assert.equal(svc.searchIndex.getChunkCount(), 0);

    await svc.shutdown();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete globalThis.Zotero;
    delete globalThis.IOUtils;
    delete globalThis.PathUtils;
  }
});

test('Preferences refreshes persisted coverage during a scan and flushes the final count', async (t) => {
  let onWrite;
  let onProgress;
  let vectorizedChunks = 0;
  let reads = 0;
  const coverage = { textContent: '' };
  globalThis.document = {
    getElementById: (id) => id === 'zv-stat-chunks' ? coverage : null,
  };
  globalThis.window = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  const service = {
    store: { subscribeWrites: (listener) => {
      onWrite = listener;
      return () => { onWrite = undefined; };
    } },
    subscribeProgress: (listener) => {
      onProgress = listener;
      return () => { onProgress = undefined; };
    },
    getConfig: () => ({ uiLanguage: 'en-US' }),
    getEngineStatus: async () => ({ modelFingerprint: 'test:model:2' }),
    getStats: async () => {
      reads++;
      return { vectorizedChunks, indexedChunks: 43 };
    },
  };
  globalThis.Zotero = { Vectorize: service };
  t.after(() => {
    globalThis.ZoteroVectorizePrefs?.onUnload();
    delete globalThis.ZoteroVectorizePrefs;
    delete globalThis.Zotero;
    delete globalThis.document;
    delete globalThis.window;
  });
  await importTs('src/zotero/ui/preferences.ts');
  const controller = globalThis.ZoteroVectorizePrefs;
  controller.container = {};
  controller.subscribeToProgress(service);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  vectorizedChunks = 20;
  onWrite();
  onWrite();
  onProgress({ phase: 'indexing' });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(coverage.textContent, '20 / 43');
  assert.equal(reads, 1);

  vectorizedChunks = 43;
  onWrite();
  onProgress({ phase: 'completed' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(coverage.textContent, '43 / 43');
  t.mock.timers.tick(1000);
  assert.equal(reads, 2);
});

test('registerSimilarPapersSection renders .zv-item-pane-box and .zv-similar-card and uses valid FTL attributes', async () => {
  const ftlEn = await fs.readFile(path.resolve('addon/locale/en-US/zotero-vectorize.ftl'), 'utf8');
  const ftlZh = await fs.readFile(path.resolve('addon/locale/zh-CN/zotero-vectorize.ftl'), 'utf8');
  for (const ftl of [ftlEn, ftlZh]) {
    assert.match(ftl, /zotero-vectorize-item-pane-header\s*=\s*\r?\n\s+\.label\s*=/);
    assert.match(ftl, /zotero-vectorize-item-pane-sidenav\s*=\s*\r?\n\s+\.tooltiptext\s*=/);
  }

  class MockNode {
    constructor(tag) {
      this.tag = tag;
      this.attrs = {};
      this.children = [];
      this.listeners = new Map();
      this._text = '';
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    get className() { return this.attrs.class || ''; }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() {
      return this._text + this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join('');
    }
    findAll(cls) {
      const res = [];
      for (const c of this.children) {
        if (c.nodeType === 3) continue;
        if (String(c.attrs.class || '').split(/\s+/).includes(cls)) res.push(c);
        res.push(...c.findAll(cls));
      }
      return res;
    }
  }
  const mockDoc = {
    createElementNS: (_ns, tag) => new MockNode(tag),
    createTextNode: (data) => ({ nodeType: 3, data }),
  };

  let registeredOpts = null;
  let unregisteredId = null;
  let selectedTargetId = null;
  globalThis.Zotero = {
    locale: 'en-US',
    logError: (e) => { throw e; },
    getMainWindow: () => ({
      ZoteroPane: {
        selectItem: async (id) => { selectedTargetId = id; },
      },
    }),
    ItemPaneManager: {
      registerSection: (opts) => { registeredOpts = opts; return 'sec-1'; },
      unregisterSection: (id) => { unregisteredId = id; return true; },
    },
  };

  let updateCb = null;
  const mockService = {
    getConfig: () => ({ uiLanguage: 'en-US' }),
    subscribeIndexUpdates: (cb) => { updateCb = cb; return () => { updateCb = null; }; },
    findSimilarItems: (itemID) =>
      itemID === 101
        ? [{ item: { itemID: 202, itemKey: 'K202', title: 'Related Transformer', creators: 'Devlin', year: '2018', abstractNote: 'BERT' }, score: 0.87 }]
        : [],
  };

  try {
    const { registerSimilarPapersSection } = await importTs('src/zotero/ui/item-pane-section.ts');
    const unregister = registerSimilarPapersSection('jar:file:///x.xpi!/', mockService);
    assert.ok(unregister);
    assert.equal(registeredOpts.header.l10nID, 'zotero-vectorize-item-pane-header');
    assert.equal(registeredOpts.sidenav.l10nID, 'zotero-vectorize-item-pane-sidenav');

    const body = new MockNode('div');
    let refreshCount = 0;
    const regularItem = { id: 101, deleted: false, isRegularItem: () => true };
    const refresh = () => {
      refreshCount++;
      registeredOpts.onRender({ doc: mockDoc, body, item: regularItem });
    };
    registeredOpts.onInit({ body, refresh });

    let enabledState = null;
    const ok = registeredOpts.onItemChange({ item: regularItem, setEnabled: (v) => { enabledState = v; } });
    assert.equal(ok, true);
    assert.equal(enabledState, true);

    registeredOpts.onRender({ doc: mockDoc, body, item: regularItem });
    const boxes = body.findAll('zv-item-pane-box');
    const cards = body.findAll('zv-similar-card');
    assert.equal(boxes.length, 1);
    assert.equal(cards.length, 1);
    assert.match(cards[0].textContent, /Related Transformer/);
    assert.match(cards[0].textContent, /87%/);

    cards[0].listeners.get('click')?.();
    assert.equal(selectedTargetId, 202);

    // Triggering index update calls refresh()
    updateCb?.();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(refreshCount, 1);

    // Non-regular item disables section
    const okAtt = registeredOpts.onItemChange({ item: { id: 102, deleted: false, isRegularItem: () => false }, setEnabled: (v) => { enabledState = v; } });
    assert.equal(okAtt, false);
    assert.equal(enabledState, false);

    unregister();
    assert.equal(unregisteredId, 'sec-1');
  } finally {
    delete globalThis.Zotero;
  }
});
