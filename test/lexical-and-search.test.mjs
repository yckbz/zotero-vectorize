import test from 'node:test';
import assert from 'node:assert/strict';
import { importTs } from './_helper.mjs';

const lexical = await importTs('src/core/lexical.ts');
const searchEngine = await importTs('src/core/search-engine.ts');
const math = await importTs('src/core/math.ts');

test('cross-lingual concept bridge matches Chinese query to English paper and highlights terms', () => {
  const index = new searchEngine.VectorSearchIndex();
  index.loadAll(
    [
      {
        itemID: 1,
        itemKey: 'ATTN01',
        libraryID: 1,
        itemType: 'journalArticle',
        title: 'Sparse Attention Mechanisms for Long-Context Transformers',
        creators: 'Alice Zhang, Bob Smith',
        year: '2024',
        publicationTitle: 'NeurIPS',
        doi: '',
        url: '',
        tags: ['transformer', 'sparsity'],
        abstractNote: 'We investigate sparse self-attention over long context windows.',
        metadataHash: 'h1',
        vector: null,
        dim: 0,
        modelFingerprint: '',
        updatedAt: 1000,
      },
      {
        itemID: 2,
        itemKey: 'BIO02',
        libraryID: 1,
        itemType: 'journalArticle',
        title: 'CRISPR Gene Editing in Mammalian Cells',
        creators: 'Carol Lee',
        year: '2023',
        publicationTitle: 'Nature',
        doi: '',
        url: '',
        tags: [],
        abstractNote: 'Genome engineering study.',
        metadataHash: 'h2',
        vector: null,
        dim: 0,
        modelFingerprint: '',
        updatedAt: 1000,
      },
    ],
    [
      {
        chunkId: 'PDF1#intro',
        itemID: 1,
        itemKey: 'ATTN01',
        attachmentID: 101,
        attachmentKey: 'PDF1',
        attachmentTitle: 'Sparse Attention.pdf',
        chunkIndex: 0,
        pageIndex: 0,
        pageLabel: '1',
        charStart: 0,
        charEnd: 70,
        text: 'Page one discusses general neural architectures and overview.',
        snippet: 'Page one discusses general neural architectures and overview.',
        vector: null,
        dim: 0,
        modelFingerprint: '',
        updatedAt: 1000,
      },
      {
        chunkId: 'PDF1#0',
        itemID: 1,
        itemKey: 'ATTN01',
        attachmentID: 101,
        attachmentKey: 'PDF1',
        attachmentTitle: 'Sparse Attention.pdf',
        chunkIndex: 1,
        pageIndex: 6,
        pageLabel: '7',
        charStart: 70,
        charEnd: 190,
        text: 'Section 4: Our sparse attention kernel reduces KV cache latency for long context inference.',
        snippet: 'Section 4: Our sparse attention kernel reduces KV cache latency for long context inference.',
        vector: null,
        dim: 0,
        modelFingerprint: '',
        updatedAt: 1000,
      },
    ]
  );

  const res = index.search({
    query: '注意力机制稀疏化',
    queryVector: null,
    activeModelFingerprint: '',
    engineLabel: 'Lexical',
    mode: 'hybrid',
  });

  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].itemID, 1);
  assert.equal(res.hits[0].crossLingualMatched, true);
  assert.equal(res.hits[0].bestChunk?.pageIndex, 6);
  assert.ok(res.hits[0].bestChunk.highlightRanges.length > 0);
  assert.equal(res.diagnostics.lexicalFallbackUsed, true);
});

test('fuzzy edit-distance tolerates misspelled Latin terms', () => {
  const res = lexical.scoreLexicalText('attenion mechanims', {
    title: 'Attention Mechanisms in Neural Networks',
  });
  assert.ok(res.score > 0.2, `Expected typo-tolerant score > 0.2, got ${res.score}`);
});

test('VectorSearchIndex hybrid, metadata, fulltext, collection filtering, and mismatch detection', () => {
  const index = new searchEngine.VectorSearchIndex();
  const vecA = math.l2Normalize([1, 0, 0, 0]);
  const vecB = math.l2Normalize([0, 1, 0, 0]);

  index.loadAll(
    [
      {
        itemID: 1,
        itemKey: 'K1',
        libraryID: 1,
        itemType: 'article',
        title: 'Paper Alpha',
        creators: 'A',
        year: '2024',
        publicationTitle: '',
        doi: '',
        url: '',
        tags: [],
        abstractNote: 'First paper',
        metadataHash: 'm1',
        vector: vecA,
        dim: 4,
        modelFingerprint: 'local-onnx:e5:4',
        updatedAt: 1,
      },
      {
        itemID: 2,
        itemKey: 'K2',
        libraryID: 1,
        itemType: 'article',
        title: 'Paper Beta',
        creators: 'B',
        year: '2024',
        publicationTitle: '',
        doi: '',
        url: '',
        tags: [],
        abstractNote: 'Second paper',
        metadataHash: 'm2',
        vector: vecB,
        dim: 4,
        modelFingerprint: 'local-onnx:e5:4',
        updatedAt: 1,
      },
    ],
    [
      {
        chunkId: 'A2#0',
        itemID: 2,
        itemKey: 'K2',
        attachmentID: 20,
        attachmentKey: 'A2',
        attachmentTitle: 'beta.pdf',
        chunkIndex: 0,
        pageIndex: 11,
        pageLabel: '12',
        charStart: 0,
        charEnd: 40,
        text: 'Deep semantic passage inside Beta PDF',
        snippet: 'Deep semantic passage inside Beta PDF',
        vector: vecB,
        dim: 4,
        modelFingerprint: 'local-onnx:e5:4',
        updatedAt: 1,
      },
    ]
  );

  // Fulltext mode with vector aligned to B
  const fullRes = index.search({
    query: 'conceptual query',
    queryVector: vecB,
    activeModelFingerprint: 'local-onnx:e5:4',
    engineLabel: 'ONNX',
    mode: 'fulltext',
  });
  assert.equal(fullRes.hits.length, 1);
  assert.equal(fullRes.hits[0].itemID, 2);
  assert.equal(fullRes.hits[0].bestChunk?.pageIndex, 11);
  assert.equal(fullRes.diagnostics.vectorSearchUsed, true);

  // Collection filter restricts to itemID 1
  const filtered = index.search({
    query: 'paper',
    queryVector: vecB,
    activeModelFingerprint: 'local-onnx:e5:4',
    engineLabel: 'ONNX',
    mode: 'metadata',
    filterItemIDs: new Set([1]),
  });
  assert.equal(filtered.hits.length, 1);
  assert.equal(filtered.hits[0].itemID, 1);

  // Dimension mismatch warning triggers clean lexical fallback
  const mismatch = index.search({
    query: 'Alpha',
    queryVector: math.l2Normalize([1, 0, 0, 0, 0, 0, 0, 0]),
    activeModelFingerprint: 'ollama:bge-m3:8',
    engineLabel: 'Ollama',
    mode: 'hybrid',
  });
  assert.ok(mismatch.diagnostics.mismatchWarning);
  assert.equal(mismatch.diagnostics.vectorSearchUsed, false);
  assert.equal(mismatch.hits[0].itemID, 1);

  // findSimilarItems returns neighbor when vectors share alignment
  index.upsertItem({
    itemID: 3,
    itemKey: 'K3',
    libraryID: 1,
    itemType: 'article',
    title: 'Paper Alpha Companion',
    creators: 'A2',
    year: '2025',
    publicationTitle: '',
    doi: '',
    url: '',
    tags: [],
    abstractNote: '',
    metadataHash: 'm3',
    vector: math.l2Normalize([0.9, 0.1, 0, 0]),
    dim: 4,
    modelFingerprint: 'local-onnx:e5:4',
    updatedAt: 1,
  });
  const similar = index.findSimilarItems(1, { topK: 3 });
  assert.equal(similar.length, 1);
  assert.equal(similar[0].item.itemID, 3);
});

test('computeHighlightRanges merges overlapping ranges', () => {
  const text = 'Attention and self-attention mechanisms work well.';
  const ranges = lexical.computeHighlightRanges(text, 'self-attention attention');
  assert.ok(ranges.length >= 2);
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i][0] > ranges[i - 1][1], 'Overlapping ranges must be merged');
  }
});

test('expandQueryCrossLingually uses ASCII word boundaries and avoids false substring expansion', () => {
  const safe = lexical.expandQueryCrossLingually('world model storage protocol');
  assert.deepEqual(safe.bridgedPhrases, []);
  assert.equal(safe.hasCrossLingualExpansion, false);

  const real = lexical.expandQueryCrossLingually('RL with RAG and ODE solver');
  assert.ok(real.bridgedPhrases.includes('强化学习'));
  assert.ok(real.bridgedPhrases.includes('检索增强生成'));
  assert.ok(real.bridgedPhrases.includes('偏微分方程'));
});

test('The bilingual glossary distinguishes physical diffusion from diffusion models', () => {
  const imagePaper = { title: '去噪扩散模型用于图像生成' };
  assert.equal(lexical.scoreLexicalText('alkane diffusion in carbon nanotubes', imagePaper).score, 0);
  assert.ok(lexical.scoreLexicalText('denoising diffusion models', imagePaper).crossLingualHit);
});

test('VectorSearchIndex handles >70k items without spread stack overflow and supports alpha=0 pure lexical', () => {
  const index = new searchEngine.VectorSearchIndex();
  const items = [];
  const vecA = math.l2Normalize([1, 0]);
  const vecB = math.l2Normalize([0.5, 0.866]);
  for (let i = 1; i <= 75000; i++) {
    items.push({
      itemID: i,
      itemKey: `K${i}`,
      libraryID: 1,
      itemType: 'article',
      title: i === 42 ? 'Target Quantum Entanglement Study' : `Background Document ${i}`,
      creators: '',
      year: '2024',
      publicationTitle: '',
      doi: '',
      url: '',
      tags: [],
      abstractNote: '',
      metadataHash: `h${i}`,
      vector: i === 42 ? vecA : vecB,
      dim: 2,
      modelFingerprint: 'local-onnx:e5:2',
      updatedAt: 1,
    });
  }
  index.loadAll(items, []);

  const res = index.search({
    query: 'Quantum Entanglement',
    queryVector: vecA,
    activeModelFingerprint: 'local-onnx:e5:2',
    engineLabel: 'ONNX',
    mode: 'metadata',
    hybridAlpha: 0,
    topK: 5,
  });
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].itemID, 42);
  assert.equal(res.diagnostics.vectorSearchUsed, false);
});

test('Async search yields, supports cancellation, and uses a consistent index snapshot', async () => {
  const index = new searchEngine.VectorSearchIndex();
  const options = {
    query: 'attention',
    queryVector: null,
    activeModelFingerprint: '',
    engineLabel: 'Lexical',
    mode: 'metadata',
  };
  const items = Array.from({ length: 2048 }, (_, i) => ({
    itemID: i + 1,
    title: i === 0 ? 'attention' : 'a long unrelated English abstract '.repeat(100),
    tags: [],
    vector: null,
  }));
  index.loadAll(items, []);

  const controller = new AbortController();
  const cancel = setTimeout(() => controller.abort(), 0);
  await assert.rejects(index.searchAsync(options, controller.signal), { name: 'AbortError' });
  clearTimeout(cancel);

  const replace = setTimeout(() => index.upsertItem({ ...items[0], title: 'new title' }), 0);
  const response = await index.searchAsync(options);
  clearTimeout(replace);
  assert.equal(response.hits[0].title, 'attention');
  assert.equal(index.getItemById(1).title, 'new title');
  const latest = await index.searchAsync(options);
  assert.equal(latest.hits.length, 0);
});

test('A compatible zero-similarity fulltext vector keeps the configured lexical weight', () => {
  const index = new searchEngine.VectorSearchIndex();
  index.loadAll(
    [{ itemID: 1, title: 'Attention', tags: [], vector: null }],
    [{
      itemID: 1, chunkId: '1', text: 'attention', snippet: 'attention', vector: new Float32Array([-1, 0]),
      modelFingerprint: 'test:embedding:2',
    }]
  );
  const result = index.search({
    query: 'attention', queryVector: new Float32Array([1, 0]), activeModelFingerprint: 'test:embedding:2',
    engineLabel: 'Test', mode: 'fulltext', hybridAlpha: 0.85,
  });
  assert.equal(result.hits[0].semanticScore, 0);
  assert.ok(Math.abs(result.hits[0].score - result.hits[0].lexicalScore * 0.15) < 1e-9);
});

test('Hybrid search retains strong fulltext evidence when metadata is weak', () => {
  const index = new searchEngine.VectorSearchIndex();
  const query = 'interfacial hydrogen bond stability';
  index.loadAll([
    {itemID: 1, title: 'Surface notes', tags: [], vector: null},
    {itemID: 2, title: 'Hydrogen stability metrics', tags: [], vector: null},
  ], [
    {itemID: 1, chunkId: 'evidence', pageIndex: 5, text: query, snippet: query, vector: null},
  ]);
  const result = index.search({query, mode: 'hybrid', queryVector: null,
    activeModelFingerprint: '', engineLabel: 'Lexical'});
  assert.equal(result.hits[0].itemID, 1);
  assert.equal(result.hits[0].bestChunk?.pageIndex, 5);
  assert.ok(result.hits[0].score > result.hits[1].score);
});

test('Fulltext uses the calibrated score to choose the best passage and page', () => {
  const index = new searchEngine.VectorSearchIndex();
  const fingerprint = 'test:model:2';
  const chunk = (itemID, chunkId, pageIndex, text, cosine) => ({
    itemID, chunkId, pageIndex, text, snippet: text,
    vector: new Float32Array([cosine, Math.sqrt(1 - cosine * cosine)]),
    modelFingerprint: fingerprint,
  });
  index.loadAll([
    {itemID: 1, title: 'Main paper', tags: [], vector: null},
    {itemID: 2, title: 'Other paper', tags: [], vector: null},
  ], [
    chunk(1, 'semantic', 6, 'Molecular vibrations at a charged interface.', 0.8),
    chunk(1, 'keyword', 2, 'attention', 0.67),
    chunk(2, 'anchor', 0, 'General background', 0.4),
  ]);
  const result = index.search({query: 'attention', mode: 'fulltext', queryVector: new Float32Array([1, 0]),
    activeModelFingerprint: fingerprint, engineLabel: 'Test'});
  const hit = result.hits[0];
  assert.equal(hit.bestChunk.pageIndex, 6);
  assert.equal(hit.bestChunk.score, hit.score);
  assert.ok(hit.bestChunk.score > hit.extraHits[0].score);
});

test('tokenizeForLexical filters Chinese grammatical/filler noise without clipping domain terms or 1-char queries', () => {
  const tokens = lexical.tokenizeForLexical('如何通过研究分析在细胞下的线粒体自噬');
  assert.ok(!tokens.includes('的'));
  assert.ok(!tokens.includes('在'));
  assert.ok(!tokens.includes('下'));
  assert.ok(!tokens.includes('如何'));
  assert.ok(!tokens.includes('通过'));
  assert.ok(!tokens.includes('研究'));
  assert.ok(!tokens.includes('分析'));
  assert.ok(tokens.includes('细胞'));
  assert.ok(tokens.includes('线粒体'));
  assert.ok(tokens.includes('自噬'));

  // Compound scientific terms containing chars like 过 / 对 / 上 / 下 must stay intact
  const compound = lexical.tokenizeForLexical('长上下文过拟合与对抗训练');
  assert.ok(compound.includes('上下文'));
  assert.ok(compound.includes('过拟合'));
  assert.ok(compound.includes('对抗'));

  // Single-character CJK queries still match substrings directly, while filler-only ZH docs score 0 against unrelated topic
  const hit1 = lexical.scoreLexicalText('癌', { title: '早期肺癌免疫治疗进展' });
  assert.ok(hit1.score > 0);

  const unrelatedDecoy = lexical.scoreLexicalText('如何通过稀疏注意力降低长上下文的计算复杂度', {
    title: '基于深度学习的中国古典诗词情感分析与生成方法研究',
    body: '本文探讨在古典诗词中如何通过模型分析情感特征。',
  });
  assert.equal(unrelatedDecoy.score, 0);
});
