import test from 'node:test';
import assert from 'node:assert/strict';
import { importTs } from './_helper.mjs';

const tokenizerMod = await importTs('src/core/tokenizer.ts');

test('WordPiece tokenizer handles English subwords, CJK splitting, padding, and truncation', () => {
  const tok = tokenizerMod.loadTokenizerFromJson({
    normalizer: { type: 'BertNormalizer', lowercase: true, strip_accents: true, handle_chinese_chars: true },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      vocab: {
        '[PAD]': 0,
        '[UNK]': 1,
        '[CLS]': 2,
        '[SEP]': 3,
        hello: 4,
        world: 5,
        '##s': 6,
        注: 7,
        意: 8,
        café: 9,
        cafe: 10,
      },
    },
  });

  const ids = tok.encodeSingle('Worlds Café 注意', 16);
  // [CLS]=2, world=5, ##s=6, cafe=10, 注=7, 意=8, [SEP]=3
  assert.deepEqual(ids, [2, 5, 6, 10, 7, 8, 3]);

  const batch = tok.encodeBatch(['hello', 'hello worlds'], 5);
  assert.equal(batch.batchSize, 2);
  assert.equal(batch.seqLength, 5); // [CLS], hello, world, ##s, [SEP]
  assert.deepEqual(Array.from(batch.inputIds), [2n, 4n, 3n, 0n, 0n, 2n, 4n, 5n, 6n, 3n]);
  assert.deepEqual(Array.from(batch.attentionMask), [1n, 1n, 1n, 0n, 0n, 1n, 1n, 1n, 1n, 1n]);

  const truncated = tok.encodeSingle('hello worlds', 4);
  assert.deepEqual(truncated, [2, 4, 5, 3]);
});

test('Unigram SentencePiece tokenizer handles Metaspace Viterbi DP and <unk> collapse', () => {
  const tok = tokenizerMod.loadTokenizerFromJson({
    normalizer: { type: 'NFKC' },
    pre_tokenizer: { type: 'Metaspace', add_prefix_space: true },
    post_processor: {
      special_tokens: {
        '<s>': { ids: [0] },
        '</s>': { ids: [2] },
      },
    },
    model: {
      type: 'Unigram',
      unk_id: 3,
      vocab: [
        ['<s>', 0],
        ['<pad>', 0],
        ['</s>', 0],
        ['<unk>', -100],
        ['▁', -5],
        ['▁query', -1.2],
        [':', -2.0],
        ['▁注意', -1.0],
        ['力', -2.5],
        ['注', -6.0],
        ['意', -6.0],
      ],
    },
  });

  const ids = tok.encodeSingle('query: 注意力 xyz', 32);
  // <s>=0, ▁query=5, :=6, ▁注意=7, 力=8, ▁=4, <unk>=3 (collapsed xyz), </s>=2
  assert.deepEqual(ids, [0, 5, 6, 7, 8, 4, 3, 2]);
});

test('BPE ByteLevel tokenizer merges frequent pairs accurately', () => {
  const tok = tokenizerMod.loadTokenizerFromJson({
    pre_tokenizer: { type: 'ByteLevel' },
    model: {
      type: 'BPE',
      unk_token: '<unk>',
      vocab: {
        '<s>': 0,
        '<pad>': 1,
        '</s>': 2,
        '<unk>': 3,
        a: 4,
        b: 5,
        c: 6,
        ab: 7,
        abc: 8,
      },
      merges: ['a b', 'ab c'],
    },
  });

  const ids = tok.encodeSingle('abc', 16);
  assert.deepEqual(ids, [0, 8, 2]);
});

test('Tokenizer handles empty input cleanly', () => {
  const tok = tokenizerMod.loadTokenizerFromJson({
    model: {
      type: 'WordPiece',
      vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3 },
    },
  });
  assert.deepEqual(tok.encodeSingle('   '), [2, 3]);
});
