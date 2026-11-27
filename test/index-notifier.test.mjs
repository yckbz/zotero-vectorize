import test from 'node:test';
import assert from 'node:assert/strict';
import { importTs } from './_helper.mjs';

test('Deleted and trashed items leave the index even when change indexing is off', async (t) => {
  let observer;
  globalThis.Zotero = {
    Notifier: {
      registerObserver: (value) => { observer = value; return 'test-notifier'; },
      unregisterObserver: () => {},
    },
    logError: (error) => { throw error; },
  };
  t.after(() => { delete globalThis.Zotero; });

  const { BackgroundIndexer } = await importTs('src/zotero/indexer.ts');
  const { VectorSearchIndex } = await importTs('src/core/search-engine.ts');
  const searchIndex = new VectorSearchIndex();
  const record = (itemID) => ({
    itemID, itemKey: `K${itemID}`, libraryID: 1, itemType: 'journalArticle', title: `Paper ${itemID}`,
    creators: '', year: '', publicationTitle: '', doi: '', url: '', tags: [], abstractNote: '', metadataHash: '',
    vector: null, dim: 0, modelFingerprint: '', updatedAt: 0,
  });
  searchIndex.loadAll([record(1), record(2), record(3)], []);
  const removed = [];
  const store = {
    removeItem: async (id) => { removed.push(id); },
    removeAttachment: async () => null,
    getChunksForItem: async () => [],
  };
  const indexer = new BackgroundIndexer({
    getConfig: () => ({ autoIndexOnChange: false }),
    getProvider: async () => { throw new Error('no indexing expected'); },
    store,
    searchIndex,
  });
  indexer.startNotifier();

  observer.notify('trash', 'item', [1]);
  observer.notify('delete', 'item', ['2']);
  observer.notify('modify', 'item', [3]);
  await indexer.dispose();

  assert.deepEqual(removed, [1, 2]);
  assert.deepEqual(searchIndex.getAllItems().map((item) => item.itemID), [3]);
});
