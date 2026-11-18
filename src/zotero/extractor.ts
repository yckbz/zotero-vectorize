import type { ExtractedItemMetadata, PdfPageText } from '../types/vectorize.ts';
import type { ZoteroItem } from '../types/zotero.d.ts';
import { composeMetadataText, splitPdfPagesFromFulltext } from '../core/chunker.ts';
import { hashMetadataFields } from '../core/hash.ts';

function safeField(item: ZoteroItem, field: string): string {
  try {
    return String(item.getField(field, false, true) || '').trim();
  } catch {
    try {
      return String(item.getField(field) || '').trim();
    } catch {
      return '';
    }
  }
}

export function formatCreators(item: ZoteroItem): string {
  try {
    const creators = item.getCreators?.() ?? [];
    const names: string[] = [];
    for (const c of creators) {
      if (c.name) {
        names.push(c.name.trim());
      } else {
        const joined = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
        if (joined) names.push(joined);
      }
    }
    return names.join(', ');
  } catch {
    return '';
  }
}

export function extractYear(item: ZoteroItem): string {
  const rawYear = safeField(item, 'year');
  if (/^\d{4}$/.test(rawYear)) return rawYear;
  const dateStr = safeField(item, 'date');
  const m = dateStr.match(/\b(1[6-9]\d{2}|20\d{2})\b/);
  if (m) return m[1];
  return rawYear.slice(0, 4);
}

export function isIndexableRegularItem(item: ZoteroItem | null | false | undefined): item is ZoteroItem {
  if (!item || item.deleted) return false;
  if (item.isFeedItem) return false;
  if (typeof item.isRegularItem === 'function' && !item.isRegularItem()) return false;
  return true;
}

export function extractItemMetadata(item: ZoteroItem): ExtractedItemMetadata {
  const title = safeField(item, 'title') || (item.getDisplayTitle ? item.getDisplayTitle() : '') || '';
  const creators = formatCreators(item);
  const year = extractYear(item);
  const publicationTitle =
    safeField(item, 'publicationTitle') ||
    safeField(item, 'proceedingsTitle') ||
    safeField(item, 'bookTitle') ||
    safeField(item, 'university') ||
    safeField(item, 'websiteTitle') ||
    safeField(item, 'repository') ||
    '';
  const doi = safeField(item, 'DOI');
  const url = safeField(item, 'url');
  const abstractNote = safeField(item, 'abstractNote');
  let tags: string[] = [];
  try {
    tags = (item.getTags?.() ?? []).map((t) => String(t.tag || '').trim()).filter(Boolean);
  } catch {
    tags = [];
  }

  const base = {
    itemID: item.id,
    itemKey: item.key,
    libraryID: item.libraryID || 1,
    itemType: item.itemType || 'document',
    title,
    creators,
    year,
    publicationTitle,
    doi,
    url,
    tags,
    abstractNote,
    dateModified: String(item.dateModified || ''),
  };

  const canonicalText = composeMetadataText(base);
  const metadataHash = hashMetadataFields({
    title,
    creators,
    year,
    publicationTitle,
    doi,
    tags,
    abstractNote,
  });

  return {
    ...base,
    canonicalText,
    metadataHash,
  };
}

export interface PdfExtractionResult {
  pages: PdfPageText[];
  fileHash: string;
  mtime: number;
  status: 'indexed' | 'no_text' | 'missing' | 'error';
  errorMessage?: string;
}

export async function getAttachmentSignature(
  attachment: ZoteroItem
): Promise<{ filePath: string | null; fileHash: string; mtime: number }> {
  let filePath: string | null = null;
  try {
    const resolved = await attachment.getFilePathAsync();
    if (resolved && (await IOUtils.exists(resolved))) {
      filePath = resolved;
    }
  } catch {
    filePath = null;
  }

  let fileHash = '';
  let mtime = 0;

  try {
    const h = await attachment.attachmentHash;
    if (h) fileHash = String(h);
  } catch {
    fileHash = '';
  }

  try {
    const mt = await attachment.attachmentModificationTime;
    if (typeof mt === 'number' && Number.isFinite(mt)) mtime = mt;
  } catch {
    mtime = 0;
  }

  if (filePath && (!fileHash || !mtime)) {
    try {
      const st = await IOUtils.stat(filePath);
      if (!mtime && st.lastModified) mtime = st.lastModified;
      if (!fileHash) fileHash = `${st.size}:${st.lastModified}`;
    } catch {
      // Ignore stat error
    }
  }

  return { filePath, fileHash, mtime };
}

export async function extractPdfPages(
  attachment: ZoteroItem,
  maxPdfPages: number,
  signature: Awaited<ReturnType<typeof getAttachmentSignature>>
): Promise<PdfExtractionResult> {
  if (!attachment || attachment.deleted || !attachment.isPDFAttachment()) {
    return { pages: [], fileHash: '', mtime: 0, status: 'missing' };
  }

  const { filePath, fileHash, mtime } = signature;
  if (!filePath) {
    return { pages: [], fileHash, mtime, status: 'missing' };
  }

  let rawText = '';
  let firstPageIndex = 0;
  try {
    const res = await Zotero.PDFWorker.getFullText(
      attachment.id,
      maxPdfPages > 0 ? maxPdfPages : null,
      false
    );
    rawText = res?.text || '';
    // Zotero trims the joined result, which removes the separators at blank page edges.
    const delimitedPages = 1 + (rawText.match(/\f/g)?.length ?? 0);
    if (rawText.trim() && res.extractedPages > delimitedPages) {
      let upper = res.extractedPages - delimitedPages;
      while (firstPageIndex < upper) {
        const middle = Math.floor((firstPageIndex + upper) / 2);
        const prefix = await Zotero.PDFWorker.getFullText(attachment.id, middle + 1, false);
        if (prefix.text.trim()) upper = middle;
        else firstPageIndex = middle + 1;
      }
    }
  } catch (err: any) {
    return {
      pages: [],
      fileHash,
      mtime,
      status: 'error',
      errorMessage: err?.message || String(err),
    };
  }

  let pages = splitPdfPagesFromFulltext(rawText, firstPageIndex);
  if (maxPdfPages > 0) {
    pages = pages.filter((p) => p.pageIndex < maxPdfPages);
  }

  const totalTextLen = pages.reduce((acc, p) => acc + p.text.length, 0);
  if (pages.length === 0 || totalTextLen < 20) {
    return {
      pages: [],
      fileHash,
      mtime,
      status: 'no_text',
    };
  }

  return {
    pages,
    fileHash,
    mtime,
    status: 'indexed',
  };
}
