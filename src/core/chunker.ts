import type { DocumentChunk, ExtractedItemMetadata, PdfPageText } from '../types/vectorize.ts';

export const DEFAULT_PDF_CHUNK_SIZE = 1024;
export const DEFAULT_PDF_CHUNK_OVERLAP = 128;

export interface ChunkingOptions {
  itemID: number;
  itemKey: string;
  attachmentID: number;
  attachmentKey: string;
  attachmentTitle: string;
  chunkSize?: number;
  chunkOverlap?: number;
  minChunkSize?: number;
}

/**
 * Normalize raw extracted PDF text while preserving paragraph breaks.
 */
export function normalizePdfPageText(raw: string): string {
  if (!raw) return '';
  let text = raw
    .replace(/\r\n?/g, '\n')
    // Common PDF ligatures
    .replace(/\uFB00/g, 'ff')
    .replace(/\uFB01/g, 'fi')
    .replace(/\uFB02/g, 'fl')
    .replace(/\uFB03/g, 'ffi')
    .replace(/\uFB04/g, 'ffl')
    // Remove zero-width & soft-hyphen control chars
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
    // Join hyphenated English line wraps: "atten-\ntion" -> "attention"
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
    // Collapse multiple spaces/tabs inside lines
    .replace(/[ \t\u00A0]+/g, ' ');

  // Normalize excessive blank lines -> double newline paragraph separator
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/**
 * Split Zotero `PDFWorker.getFullText` output on `\f` (form feed).
 * IMPORTANT: Preserves exact 0-based `pageIndex` even when intermediate pages are blank/scanned.
 */
export function splitPdfPagesFromFulltext(rawText: string, firstPageIndex = 0): PdfPageText[] {
  if (!rawText) return [];
  const rawPages = rawText.split('\f');
  const pages: PdfPageText[] = [];
  for (let i = 0; i < rawPages.length; i++) {
    const cleaned = normalizePdfPageText(rawPages[i]);
    if (!cleaned) continue;
    const pageIndex = firstPageIndex + i;
    pages.push({
      pageIndex,
      pageLabel: String(pageIndex + 1),
      text: cleaned,
    });
  }
  return pages;
}

/**
 * Split a long block into sentence-level or soft segments respecting both EN & CJK punctuation.
 */
function splitParagraphToSegments(paragraph: string, maxSegmentLen: number): string[] {
  const clean = paragraph.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxSegmentLen) return [clean];

  const segments: string[] = [];
  // Split after English/CJK sentence terminators
  const rawSentences = clean.split(/(?<=[.!?。！？；;])\s*/);
  let buffer = '';

  for (const sentence of rawSentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length > maxSegmentLen) {
      if (buffer) {
        segments.push(buffer);
        buffer = '';
      }
      // Hard-split oversized sentence at whitespace or safe codepoint boundaries
      let cursor = 0;
      while (cursor < s.length) {
        let end = Math.min(cursor + maxSegmentLen, s.length);
        if (end < s.length) {
          // Prefer breaking on whitespace in the latter 40% of the window
          const spaceIdx = s.lastIndexOf(' ', end);
          if (spaceIdx > cursor + Math.floor(maxSegmentLen * 0.5)) {
            end = spaceIdx;
          } else {
            // Avoid splitting UTF-16 surrogate pair
            const code = s.charCodeAt(end - 1);
            if (code >= 0xd800 && code <= 0xdbff && end < s.length) {
              end--;
            }
          }
        }
        const piece = s.slice(cursor, end).trim();
        if (piece) segments.push(piece);
        cursor = end;
        while (cursor < s.length && s[cursor] === ' ') cursor++;
      }
      continue;
    }

    const sep = buffer ? ' ' : '';
    if (buffer.length + sep.length + s.length <= maxSegmentLen) {
      buffer += sep + s;
    } else {
      if (buffer) segments.push(buffer);
      buffer = s;
    }
  }
  if (buffer) segments.push(buffer);
  return segments;
}

function isNoiseChunk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 25) return true;
  // Pure numbers / punctuation (e.g., standalone page headers/numbers)
  const alphaNumCount = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
  if (alphaNumCount < 12) return true;
  if (/^\d+$/.test(trimmed)) return true;
  return false;
}

export function buildSnippet(text: string, maxChars = 280): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  // Try to cut cleanly at space or CJK punctuation near maxChars
  let cut = maxChars;
  const punct = Math.max(
    clean.lastIndexOf(' ', maxChars),
    clean.lastIndexOf('。', maxChars),
    clean.lastIndexOf('，', maxChars),
    clean.lastIndexOf('.', maxChars)
  );
  if (punct > Math.floor(maxChars * 0.65)) {
    cut = punct + (clean[punct] === ' ' ? 0 : 1);
  }
  return clean.slice(0, cut).trim() + '…';
}

/**
 * Chunk extracted PDF pages into paragraph-aware overlapping chunks with exact `pageIndex`.
 */
export function chunkDocumentPages(pages: PdfPageText[], options: ChunkingOptions): DocumentChunk[] {
  const chunkSize = Math.max(180, options.chunkSize ?? DEFAULT_PDF_CHUNK_SIZE);
  const chunkOverlap = Math.max(0, Math.min(Math.floor(chunkSize * 0.5), options.chunkOverlap ?? DEFAULT_PDF_CHUNK_OVERLAP));
  const minChunkSize = Math.max(25, options.minChunkSize ?? 60);

  const chunks: DocumentChunk[] = [];
  let globalOffset = 0;

  for (const page of pages) {
    const paragraphs = page.text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    const units: string[] = [];
    for (const para of paragraphs) {
      units.push(...splitParagraphToSegments(para, chunkOverlap > 0 ? chunkSize - chunkOverlap - 1 : chunkSize));
    }

    let currentParts: string[] = [];
    let currentLen = 0;
    let chunkStart = globalOffset;
    let overlapPrefix = '';

    const flushChunk = (force = false) => {
      const text = currentParts.join(' ').replace(/\s{2,}/g, ' ').trim();
      if (!text) return;
      if (!force && text.length < minChunkSize) return;
      if (isNoiseChunk(text)) return;

      const chunkIndex = chunks.length;
      chunks.push({
        chunkId: `${options.attachmentKey}#${chunkIndex}`,
        itemID: options.itemID,
        itemKey: options.itemKey,
        attachmentID: options.attachmentID,
        attachmentKey: options.attachmentKey,
        attachmentTitle: options.attachmentTitle,
        chunkIndex,
        pageIndex: page.pageIndex,
        pageLabel: page.pageLabel,
        charStart: chunkStart,
        charEnd: chunkStart + text.length,
        text,
        snippet: buildSnippet(text),
      });
    };

    for (let u = 0; u < units.length; u++) {
      const unit = units[u];
      const addedLen = (currentParts.length > 0 ? 1 : 0) + unit.length;

      if (currentParts.length > 0 && currentLen + addedLen > chunkSize) {
        flushChunk(true);

        overlapPrefix = '';
        if (chunkOverlap > 0) {
          const previous = currentParts.join(' ');
          let start = Math.max(0, previous.length - chunkOverlap);
          const firstCode = previous.charCodeAt(start);
          if (firstCode >= 0xdc00 && firstCode <= 0xdfff) start++;
          if (start > 0 && /[a-z0-9]/i.test(previous[start - 1]) && /[a-z0-9]/i.test(previous[start])) {
            const boundary = previous.indexOf(' ', start);
            if (boundary !== -1) start = boundary + 1;
          }
          overlapPrefix = previous.slice(start).trimStart();
        }
        currentParts = overlapPrefix ? [overlapPrefix] : [];
        currentLen = overlapPrefix.length;
        chunkStart = globalOffset - (overlapPrefix ? overlapPrefix.length + 1 : 0);
      }

      currentParts.push(unit);
      currentLen += (currentParts.length > 1 ? 1 : 0) + unit.length;
      globalOffset += unit.length + 1;
    }

    // Flush remaining text on page (merge short tail if possible or emit if meaningful)
    if (currentParts.length > 0) {
      const tailText = currentParts.join(' ').replace(/\s{2,}/g, ' ').trim();
      const newTail = overlapPrefix ? tailText.slice(overlapPrefix.length + 1) : tailText;
      if (!isNoiseChunk(tailText)) {
        if (
          newTail.length < minChunkSize &&
          chunks.length > 0 &&
          chunks[chunks.length - 1].pageIndex === page.pageIndex &&
          chunks[chunks.length - 1].text.length + newTail.length + 1 <= chunkSize
        ) {
          const prev = chunks[chunks.length - 1];
          prev.text = `${prev.text} ${newTail}`.trim();
          prev.charEnd += newTail.length + 1;
          prev.snippet = buildSnippet(prev.text);
        } else {
          flushChunk(true);
        }
      }
    }
  }

  return chunks;
}

export function composeMetadataText(
  meta: Omit<ExtractedItemMetadata, 'canonicalText' | 'metadataHash'>
): string {
  const parts: string[] = [];
  if (meta.title) parts.push(`Title: ${meta.title}`);
  if (meta.creators) parts.push(`Authors: ${meta.creators}`);
  if (meta.year) parts.push(`Year: ${meta.year}`);
  if (meta.publicationTitle) parts.push(`Venue: ${meta.publicationTitle}`);
  if (meta.tags.length > 0) parts.push(`Tags: ${meta.tags.join(', ')}`);
  if (meta.abstractNote) parts.push(`Abstract: ${meta.abstractNote}`);
  if (meta.doi) parts.push(`DOI: ${meta.doi}`);
  return parts.join('\n').trim();
}
