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

export const SYNC_CONTAINER_ITEM_TYPE = 'document';
export const SYNC_CONTAINER_TITLE = 'Zotero Vectorize Shared Index';
export const SYNC_CONTAINER_EXTRA_MARKER = 'Zotero-Vectorize-Sync: container-v1';
export const SYNC_CONTAINER_ABSTRACT =
  'Managed automatically by Zotero Vectorize to store WebDAV-synced semantic search index files as attachments. You may move this item into any collection, but please do not delete it. / 由 Zotero Vectorize 插件自动维护，用于通过 WebDAV 同步语义搜索向量分片。可移入任意分类整理，请勿删除。';

export function isSyncContainerItem(
  item: ZoteroItem | null | false | undefined,
  includeDeleted = false,
): item is ZoteroItem {
  if (!item || (!includeDeleted && item.deleted)) return false;
  if (item.isFeedItem) return false;
  if (typeof item.isRegularItem === 'function' && !item.isRegularItem()) return false;
  const extra = safeField(item, 'extra');
  if (!extra) return false;
  return extra.split(/\r?\n/).some((line) => line.trim() === SYNC_CONTAINER_EXTRA_MARKER);
}

export function isIndexableRegularItem(item: ZoteroItem | null | false | undefined): item is ZoteroItem {
  if (!item || item.deleted) return false;
  if (item.isFeedItem) return false;
  if (typeof item.isRegularItem === 'function' && !item.isRegularItem()) return false;
  if (isSyncContainerItem(item)) return false;
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
  totalPages?: number;
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

/**
 * Whether Zotero's PDF worker already has a job running or queued. Zotero runs PDF jobs one at a time, so a
 * new job then waits behind it. Null when this Zotero version does not expose its queue.
 */
export function isPdfWorkerBusy(): boolean | null {
  const worker = Zotero.PDFWorker;
  if (typeof worker._processingQueue !== 'boolean' || !Array.isArray(worker._queue)) return null;
  return worker._processingQueue || worker._queue.length > 0;
}

export async function extractPdfPages(
  attachment: ZoteroItem,
  maxPdfPages: number,
  signature: Awaited<ReturnType<typeof getAttachmentSignature>>,
  options?: {
    minTextLength?: number;
    signal?: AbortSignal;
    /** Runs each Zotero PDF worker request; callers may wait for an idle worker or enforce per-call timeouts. */
    requestFullText?: (maxPages: number | null) => Promise<{
      text: string;
      extractedPages: number;
      totalPages?: number;
    }>;
  }
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
  let totalPages: number | undefined;
  try {
    options?.signal?.throwIfAborted();
    const getFullText = (maxPages: number | null) => options?.requestFullText
      ? options.requestFullText(maxPages)
      : Zotero.PDFWorker.getFullText(attachment.id, maxPages, false);
    const res = await getFullText(maxPdfPages > 0 ? maxPdfPages : null);
    rawText = res?.text || '';
    totalPages = res?.totalPages;
    // Zotero trims the joined result, which removes the separators at blank page edges.
    const delimitedPages = 1 + (rawText.match(/\f/g)?.length ?? 0);
    if (rawText.trim() && res.extractedPages > delimitedPages) {
      let upper = res.extractedPages - delimitedPages;
      while (firstPageIndex < upper) {
        options?.signal?.throwIfAborted();
        const middle = Math.floor((firstPageIndex + upper) / 2);
        const prefix = await getFullText(middle + 1);
        if (prefix.text.trim()) upper = middle;
        else firstPageIndex = middle + 1;
      }
    }
  } catch (err: any) {
    options?.signal?.throwIfAborted();
    return {
      pages: [],
      fileHash,
      mtime,
      status: 'error',
      errorMessage: err?.message || String(err),
    };
  }
  options?.signal?.throwIfAborted();

  let pages = splitPdfPagesFromFulltext(rawText, firstPageIndex);
  if (maxPdfPages > 0) {
    pages = pages.filter((p) => p.pageIndex < maxPdfPages);
  }

  const totalTextLen = pages.reduce((acc, p) => acc + p.text.length, 0);
  if (pages.length === 0 || totalTextLen < (options?.minTextLength ?? 20)) {
    return {
      pages: [],
      totalPages,
      fileHash,
      mtime,
      status: 'no_text',
    };
  }

  return {
    pages,
    totalPages,
    fileHash,
    mtime,
    status: 'indexed',
  };
}
