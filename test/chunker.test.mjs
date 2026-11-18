import test from 'node:test';
import assert from 'node:assert/strict';
import { importTs } from './_helper.mjs';

const chunker = await importTs('src/core/chunker.ts');

test('splitPdfPagesFromFulltext preserves exact 0-based pageIndex across blank pages', () => {
  const raw = [
    'Introduction to atten-\ntion mechanisms and \uFB01ltering.',
    '   \n\n  ', // Blank / scanned page index 1
    '', // Empty page index 2
    'Page four discusses sparse \uFB02ow and e\uFB03ciency in detail.',
  ].join('\f');

  const pages = chunker.splitPdfPagesFromFulltext(raw);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].pageIndex, 0);
  assert.equal(pages[0].pageLabel, '1');
  assert.match(pages[0].text, /attention mechanisms and filtering/);

  // Page 4 (0-based index 3) MUST remain pageIndex=3, never shifted to 1!
  assert.equal(pages[1].pageIndex, 3);
  assert.equal(pages[1].pageLabel, '4');
  assert.match(pages[1].text, /sparse flow and efficiency/);
});

test('chunkDocumentPages chunks paragraphs with overlap, exact pageIndex, and filters noise', () => {
  const pages = [
    { pageIndex: 0, pageLabel: '1', text: '12' }, // pure page number noise
    {
      pageIndex: 4,
      pageLabel: '5',
      text: [
        'Sparse attention reduces quadratic complexity in long-context transformers by restricting key-value interactions across distant sequence tokens.',
        'Experiments across multiple academic benchmarks confirm significant throughput gains without sacrificing reasoning accuracy on downstream evaluation tasks.',
        'Further ablation studies demonstrate that block-sparse routing preserves retrieval precision across 128k token windows.',
      ].join('\n\n'),
    },
  ];

  const chunks = chunker.chunkDocumentPages(pages, {
    itemID: 10,
    itemKey: 'ITEM10',
    attachmentID: 20,
    attachmentKey: 'ATT20',
    attachmentTitle: 'paper.pdf',
    chunkSize: 220,
    chunkOverlap: 60,
  });

  assert.ok(chunks.length >= 2, `Expected >= 2 chunks, got ${chunks.length}`);
  for (let i = 0; i < chunks.length; i++) {
    assert.equal(chunks[i].pageIndex, 4);
    assert.equal(chunks[i].pageLabel, '5');
    assert.equal(chunks[i].chunkId, `ATT20#${i}`);
    assert.ok(chunks[i].text.length >= 25);
    assert.ok(chunks[i].snippet.length > 0);
  }
});

test('chunkDocumentPages handles oversized sentences and surrogate pairs without splitting UTF-16 pairs', () => {
  const longText = '🧪'.repeat(20) + ' ' + 'word '.repeat(120);
  const chunks = chunker.chunkDocumentPages(
    [{ pageIndex: 0, pageLabel: '1', text: longText }],
    {
      itemID: 1,
      itemKey: 'K1',
      attachmentID: 2,
      attachmentKey: 'A2',
      attachmentTitle: 'emoji.pdf',
      chunkSize: 180,
      chunkOverlap: 30,
    }
  );
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    // Ensure no unpaired surrogate code units
    assert.equal(c.text, c.text.toWellFormed ? c.text.toWellFormed() : c.text);
  }
});

test('chunk size includes overlap and a short final paragraph', () => {
  const blocks = [
    'diffusion '.repeat(19).trim(),
    'conductivity '.repeat(13).trim(),
    'Final results remain reproducible.',
  ];
  const chunks = chunker.chunkDocumentPages(
    [{ pageIndex: 0, pageLabel: '1', text: blocks.join('\n\n') }],
    { itemID: 1, itemKey: 'K1', attachmentID: 2, attachmentKey: 'A2',
      attachmentTitle: 'bounds.pdf', chunkSize: 180, chunkOverlap: 40 }
  );
  const page = blocks.join(' ');
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.length <= 180);
    assert.equal(c.text, page.slice(c.charStart, c.charEnd));
  }
  assert.ok(chunks.some((c) => c.text.endsWith(blocks.at(-1))));
});

test('buildSnippet truncates cleanly with ellipsis', () => {
  const s = chunker.buildSnippet('Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda.', 30);
  assert.ok(s.endsWith('…'));
  assert.ok(s.length <= 32);
});
