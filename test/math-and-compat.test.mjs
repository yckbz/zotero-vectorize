import test from 'node:test';
import assert from 'node:assert/strict';
import { importTs } from './_helper.mjs';

const math = await importTs('src/core/math.ts');
const compat = await importTs('src/core/compat-json.ts');

test('math utilities handle L2 normalization, bytes roundtrip, and pooling', () => {
  const norm = math.l2Normalize([3, 4]);
  assert.ok(Math.abs(norm[0] - 0.6) < 1e-5);
  assert.ok(Math.abs(norm[1] - 0.8) < 1e-5);
  assert.ok(Math.abs(math.cosineSimilarity([1, 2], [2, 4]) - 1) < 1e-5);
  assert.equal(math.cosineSimilarity([], []), 0);
  assert.equal(math.cosineSimilarity([NaN, 1], [1, 1]), 0);

  const bytes = math.float32ToBytes(norm);
  const restored = math.bytesToFloat32(bytes);
  assert.equal(restored.length, 2);
  assert.ok(Math.abs(restored[0] - 0.6) < 1e-5);

  // Also tolerate ArrayBuffer and number[] inputs
  assert.equal(math.bytesToFloat32(bytes.buffer).length, 2);
  assert.equal(math.bytesToFloat32(Array.from(bytes)).length, 2);
  assert.equal(math.bytesToFloat32(new Uint8Array([1, 2])).length, 0);

  // Masked mean pooling (2 tokens valid, 1 pad)
  const hidden = new Float32Array([1, 0, 3, 0, 100, 100]);
  const mask = new BigInt64Array([1n, 1n, 0n]);
  const pooled = math.meanPoolNormalized(hidden, mask, 3, 2, 0);
  assert.ok(Math.abs(pooled[0] - 1) < 1e-5);
  assert.ok(Math.abs(pooled[1]) < 1e-5);
});

test('compat-json roundtrips 3-file JSON and tolerates map & camelCase variants', () => {
  const items = [
    {
      itemID: 42,
      itemKey: 'KEY42',
      libraryID: 1,
      itemType: 'journalArticle',
      title: 'Attention Is All You Need',
      creators: 'Vaswani et al.',
      year: '2017',
      publicationTitle: 'NeurIPS',
      doi: '10.5555/3295222.3295349',
      url: '',
      tags: ['transformer'],
      abstractNote: 'We propose the Transformer.',
      metadataHash: 'abcd1234',
      vector: new Float32Array([0.6, 0.8]),
      dim: 2,
      modelFingerprint: 'local-onnx:e5:2',
      updatedAt: 1700000000000,
    },
  ];
  const chunks = [
    {
      chunkId: 'ATT1#0',
      itemID: 42,
      itemKey: 'KEY42',
      attachmentID: 99,
      attachmentKey: 'ATT1',
      attachmentTitle: 'paper.pdf',
      chunkIndex: 0,
      pageIndex: 2,
      pageLabel: '3',
      charStart: 0,
      charEnd: 30,
      text: 'Scaled dot-product attention computes weights.',
      snippet: 'Scaled dot-product attention computes weights.',
      vector: new Float32Array([0.8, 0.6]),
      dim: 2,
      modelFingerprint: 'local-onnx:e5:2',
      updatedAt: 1700000000000,
    },
  ];

  const exported = compat.serializeVectorStoreJson({
    items,
    chunks,
    engine: 'local-onnx',
    model: 'e5',
    modelFingerprint: 'local-onnx:e5:2',
    dimension: 2,
  });

  assert.equal(exported.storeMetadata.item_count, 1);
  assert.equal(exported.storeMetadata.chunk_count, 1);
  assert.equal(exported.fulltextVectors[0].page, 3);

  const imported = compat.parseVectorStoreJson(
    {
      metadataJson: { KEY42: { title: 'Attention', embedding: [3, 4], tags: ['nlp'] } },
      fulltextJson: exported.fulltextVectors,
      storeMetaJson: exported.storeMetadata,
    },
    (key) => (key === 'KEY42' ? { itemID: 42, libraryID: 1 } : null),
    (attKey) => (attKey === 'ATT1' ? 99 : 0)
  );

  assert.equal(imported.items.length, 1);
  assert.equal(imported.chunks.length, 1);
  assert.equal(imported.chunks[0].attachmentID, 99);
  assert.equal(imported.chunks[0].pageIndex, 2);
});

test('rotateBackups maintains .bak.1 and .bak.2 cleanly', async () => {
  const files = new Map([
    ['/dir/a.json', 'v3'],
    ['/dir/a.json.bak.1', 'v2'],
    ['/dir/a.json.bak.2', 'v1'],
  ]);
  const io = {
    exists: async (p) => files.has(p),
    copy: async (s, d) => { files.set(d, files.get(s)); },
    remove: async (p) => { files.delete(p); },
  };
  await compat.rotateBackups(io, '/dir/a.json', 2);
  assert.equal(files.get('/dir/a.json.bak.1'), 'v3');
  assert.equal(files.get('/dir/a.json.bak.2'), 'v2');
});

test('compat-json parses array-map fulltext, zotero_item_key, authors objects, and embedding_model object', () => {
  const imported = compat.parseVectorStoreJson(
    {
      metadataJson: {
        items: [
          {
            zotero_item_key: 'ZKEY1',
            title: 'Cross-Lingual Paper',
            authors: [{ firstName: 'Jane', lastName: 'Doe' }],
            abstract_note: 'Detailed abstract text.',
            embedding: [0, 3, 4],
          },
        ],
      },
      fulltextJson: {
        ZKEY1: [
          {
            chunk_id: 'ATT9#0',
            attachment_key: 'ATT9',
            filename: 'paper.pdf',
            chunk_index: 0,
            page: 4,
            text_content: 'Matched paragraph on page four.',
            embedding: [3, 0, 4],
          },
        ],
      },
      storeMetaJson: {
        embedding_model: { engine: 'ollama', model: 'bge-m3', dimension: 3 },
      },
    },
    (k) => (k === 'ZKEY1' ? { itemID: 7, libraryID: 1 } : null),
    (attKey) => (attKey === 'ATT9' ? 77 : 0)
  );

  assert.equal(imported.engine, 'ollama');
  assert.equal(imported.model, 'bge-m3');
  assert.equal(imported.dimension, 3);
  assert.equal(imported.items.length, 1);
  assert.equal(imported.items[0].creators, 'Jane Doe');
  assert.equal(imported.items[0].abstractNote, 'Detailed abstract text.');
  assert.equal(imported.chunks.length, 1);
  assert.equal(imported.chunks[0].attachmentID, 77);
  assert.equal(imported.chunks[0].pageIndex, 3);
  assert.equal(imported.chunks[0].text, 'Matched paragraph on page four.');
});

test('compat-json parses exact nested data-format.md layout (row.metadata, doc.chunks without key, embedding_dimension)', () => {
  const imported = compat.parseVectorStoreJson(
    {
      metadataJson: [
        {
          itemID: 1688,
          key: 'RZFISQTN',
          metadata: {
            title: 'Neural Scaling Laws for Cross-Lingual Retrieval',
            abstractNote: 'Nested abstract note from data-format.md.',
            publicationTitle: 'ACL Findings',
            authors: [
              { name: 'Alice Zhang', type: 'author' },
              { name: 'Bob Li', type: 'author' },
            ],
            tags: ['cross-lingual', 'retrieval'],
            date: '2024-06-15',
            dateModified: '2024-07-01T10:00:00Z',
            DOI: '10.1234/acl.2024',
            url: 'https://example.org/paper',
          },
          embedding_text: 'Title: Neural Scaling Laws...',
          itemType: 'conferencePaper',
          vector: [3, 4],
          vector_dimension: 2,
          model: 'paraphrase-multilingual-MiniLM-L12-v2',
        },
      ],
      fulltextJson: [
        {
          itemID: 1688,
          attachmentID: 1687,
          title: 'Neural Scaling Laws for Cross-Lingual Retrieval',
          itemType: 'journalArticle',
          total_pages: 9,
          pdf_file: 'scaling-laws.pdf',
          chunks: [
            {
              chunk_id: '1688_0',
              text: 'First chunk on page one.',
              vector: [0.6, 0.8],
              word_count: 5,
              page: 1,
            },
            {
              chunk_id: '1688_1',
              text: 'Second chunk on page five.',
              vector: [0.8, 0.6],
              word_count: 5,
              page: 5,
            },
          ],
        },
      ],
      storeMetaJson: {
        embedding_model: 'paraphrase-multilingual-MiniLM-L12-v2',
        embedding_dimension: 2,
      },
    },
    (itemKey, fallbackID) =>
      itemKey === 'RZFISQTN' || fallbackID === 1688
        ? { itemID: 1688, libraryID: 1, itemKey: 'RZFISQTN' }
        : null,
    (_attKey, parentID, fallbackAttID) =>
      parentID === 1688 && fallbackAttID === 1687
        ? { attachmentID: 1687, attachmentKey: 'ATT1687' }
        : 0
  );

  assert.equal(imported.model, 'paraphrase-multilingual-MiniLM-L12-v2');
  assert.equal(imported.dimension, 2);
  assert.equal(imported.items.length, 1);
  assert.equal(imported.items[0].itemID, 1688);
  assert.equal(imported.items[0].itemKey, 'RZFISQTN');
  assert.equal(imported.items[0].itemType, 'conferencePaper');
  assert.equal(imported.items[0].title, 'Neural Scaling Laws for Cross-Lingual Retrieval');
  assert.equal(imported.items[0].abstractNote, 'Nested abstract note from data-format.md.');
  assert.equal(imported.items[0].publicationTitle, 'ACL Findings');
  assert.equal(imported.items[0].creators, 'Alice Zhang, Bob Li');
  assert.deepEqual(imported.items[0].tags, ['cross-lingual', 'retrieval']);
  assert.equal(imported.items[0].year, '2024');
  assert.equal(imported.items[0].doi, '10.1234/acl.2024');
  assert.equal(imported.items[0].url, 'https://example.org/paper');

  assert.equal(imported.chunks.length, 2);
  assert.equal(imported.chunks[0].chunkId, '1688_0');
  assert.equal(imported.chunks[0].itemID, 1688);
  assert.equal(imported.chunks[0].itemKey, 'RZFISQTN');
  assert.equal(imported.chunks[0].attachmentID, 1687);
  assert.equal(imported.chunks[0].attachmentKey, 'ATT1687');
  assert.equal(imported.chunks[0].attachmentTitle, 'scaling-laws.pdf');
  assert.equal(imported.chunks[0].pageIndex, 0);
  assert.equal(imported.chunks[1].chunkId, '1688_1');
  assert.equal(imported.chunks[1].pageIndex, 4);
  assert.equal(imported.chunks[1].text, 'Second chunk on page five.');
});
