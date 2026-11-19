import type {
  CompatFulltextChunkEntry,
  CompatMetadataVectorEntry,
  CompatStoreMetadata,
  IndexedChunkRecord,
  IndexedItemRecord,
} from '../types/vectorize.ts';
import { buildModelFingerprint, hashMetadataFields } from './hash.ts';
import { buildSnippet, composeMetadataText } from './chunker.ts';
import { isFiniteVector, l2Normalize } from './math.ts';

export const COMPAT_SCHEMA_VERSION = '1.0';

export interface SerializedCompatBundle {
  metadataVectors: CompatMetadataVectorEntry[];
  fulltextVectors: CompatFulltextChunkEntry[];
  storeMetadata: CompatStoreMetadata;
}

export interface ParsedCompatResult {
  items: IndexedItemRecord[];
  chunks: IndexedChunkRecord[];
  engine: string;
  model: string;
  modelFingerprint: string;
  dimension: number;
  skippedItems: number;
  skippedChunks: number;
  warnings: string[];
}

export function serializeVectorStoreJson(params: {
  items: IndexedItemRecord[];
  chunks: IndexedChunkRecord[];
  engine: string;
  model: string;
  modelFingerprint: string;
  profileID?: string;
  dimension: number;
  createdAt?: string;
}): SerializedCompatBundle {
  const nowIso = new Date().toISOString();
  const metadataVectors: CompatMetadataVectorEntry[] = [];

  for (const item of params.items) {
    if (!item.vector || item.vector.length === 0) continue;
    const text = composeMetadataText({
      itemID: item.itemID,
      itemKey: item.itemKey,
      libraryID: item.libraryID,
      itemType: item.itemType,
      title: item.title,
      creators: item.creators,
      year: item.year,
      publicationTitle: item.publicationTitle,
      doi: item.doi,
      url: item.url,
      tags: item.tags,
      abstractNote: item.abstractNote,
      dateModified: '',
    });
    metadataVectors.push({
      item_key: item.itemKey,
      item_id: item.itemID,
      library_id: item.libraryID,
      item_type: item.itemType,
      title: item.title,
      creators: item.creators,
      year: item.year,
      publication_title: item.publicationTitle,
      doi: item.doi,
      url: item.url,
      tags: item.tags,
      abstract: item.abstractNote,
      text,
      metadata_hash: item.metadataHash,
      embedding: Array.from(item.vector, (v) => Number(v.toFixed(6))),
      updated_at: new Date(item.updatedAt || Date.now()).toISOString(),
    });
  }

  const fulltextVectors: CompatFulltextChunkEntry[] = [];
  const libraryByItem = new Map(params.items.map((item) => [item.itemID, item.libraryID]));
  for (const chunk of params.chunks) {
    if (!chunk.vector || chunk.vector.length === 0) continue;
    fulltextVectors.push({
      library_id: libraryByItem.get(chunk.itemID),
      chunk_id: chunk.chunkId,
      item_key: chunk.itemKey,
      attachment_key: chunk.attachmentKey,
      attachment_title: chunk.attachmentTitle,
      chunk_index: chunk.chunkIndex,
      page_index: chunk.pageIndex,
      page: chunk.pageIndex + 1,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
      text: chunk.text,
      snippet: chunk.snippet,
      embedding: Array.from(chunk.vector, (v) => Number(v.toFixed(6))),
    });
  }

  const inferredDim =
    params.dimension ||
    metadataVectors[0]?.embedding.length ||
    fulltextVectors[0]?.embedding.length ||
    0;

  const storeMetadata: CompatStoreMetadata = {
    schema_version: COMPAT_SCHEMA_VERSION,
    source: 'zotero-vectorize',
    engine: params.engine,
    model: params.model,
    model_fingerprint: params.modelFingerprint || buildModelFingerprint(params.engine, params.model, inferredDim),
    embedding_profile_id: params.profileID,
    dimension: inferredDim,
    item_count: metadataVectors.length,
    chunk_count: fulltextVectors.length,
    created_at: params.createdAt || nowIso,
    updated_at: nowIso,
  };

  return { metadataVectors, fulltextVectors, storeMetadata };
}

function attachKeyIfMissing(obj: Record<string, any>, key: string): Record<string, any> {
  if (obj.item_key || obj.itemKey || obj.zotero_item_key || obj.parent_key || obj.key) {
    return obj;
  }
  return { item_key: key, ...obj };
}

function flattenFulltextParentEntry(entry: Record<string, any>): any[] {
  if (!Array.isArray(entry.chunks)) {
    return [entry];
  }
  const inherited: Record<string, any> = {};
  for (const field of [
    'itemID',
    'item_id',
    'library_id',
    'libraryID',
    'key',
    'item_key',
    'itemKey',
    'zotero_item_key',
    'parent_key',
    'library_id',
    'libraryID',
    'attachmentID',
    'attachment_id',
    'attachment_key',
    'attachmentKey',
    'attachment_title',
    'attachmentTitle',
    'pdf_file',
    'pdfFile',
    'filename',
    'title',
  ]) {
    if (entry[field] !== undefined && entry[field] !== null) {
      inherited[field] = entry[field];
    }
  }
  const out: any[] = [];
  for (let i = 0; i < entry.chunks.length; i++) {
    const chunk = entry.chunks[i];
    if (chunk && typeof chunk === 'object') {
      out.push({
        ...inherited,
        chunk_index: typeof chunk.chunk_index === 'number' ? chunk.chunk_index : i,
        ...chunk,
      });
    }
  }
  return out;
}

function normalizeArrayOrMapEntries(raw: any, flattenNestedChunks = false): any[] {
  if (!raw) return [];
  let entries: any[] = [];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === 'object') {
    if (Array.isArray(raw.items)) entries = raw.items;
    else if (Array.isArray(raw.vectors)) entries = raw.vectors;
    else if (Array.isArray(raw.chunks)) entries = raw.chunks;
    else if (Array.isArray(raw.records)) entries = raw.records;
    else {
      // Keyed dictionary map: { "ABC123": { title, embedding, ... } } or { "ABC123": [ chunk1, chunk2 ] }
      for (const [key, value] of Object.entries(raw)) {
        if (Array.isArray(value)) {
          for (const inner of value) {
            if (inner && typeof inner === 'object') {
              entries.push(attachKeyIfMissing(inner, key));
            }
          }
        } else if (value && typeof value === 'object') {
          entries.push(attachKeyIfMissing(value as Record<string, any>, key));
        }
      }
    }
  }

  if (!flattenNestedChunks) {
    return entries;
  }

  const out: any[] = [];
  for (const item of entries) {
    if (item && typeof item === 'object' && Array.isArray(item.chunks)) {
      out.push(...flattenFulltextParentEntry(item));
    } else {
      out.push(item);
    }
  }
  return out;
}

function formatCompatCreators(raw: unknown): string {
  if (!raw) return '';
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry === 'object') {
          const e = entry as Record<string, any>;
          if (e.name) return String(e.name).trim();
          return [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
        }
        return '';
      })
      .filter(Boolean)
      .join(', ');
  }
  return String(raw);
}

function extractNumericId(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

function extractCompatYear(row: Record<string, any>, meta: Record<string, any>): string {
  const directYear = String(row.year ?? meta.year ?? '').trim();
  if (/^\d{4}$/.test(directYear)) return directYear;
  const rawDate = String(row.date ?? meta.date ?? directYear).trim();
  if (!rawDate) return '';
  const m = rawDate.match(/\b(1[6-9]\d{2}|20\d{2})\b/);
  if (m) return m[1];
  return directYear ? directYear.slice(0, 4) : rawDate.slice(0, 4);
}

function extractCompatTags(rawTags: unknown): string[] {
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .map((t) => {
      if (typeof t === 'string') return t.trim();
      if (t && typeof t === 'object') return String((t as Record<string, any>).tag ?? (t as Record<string, any>).name ?? '').trim();
      return '';
    })
    .filter(Boolean);
}

function parseCompatPageIndex(row: Record<string, any>): number {
  const rawPageIndex = row.page_index ?? row.pageIndex;
  if (typeof rawPageIndex === 'number' && Number.isFinite(rawPageIndex)) {
    return Math.max(0, Math.floor(rawPageIndex));
  }
  if (typeof rawPageIndex === 'string' && /^\d+$/.test(rawPageIndex.trim())) {
    return Math.max(0, Number(rawPageIndex.trim()));
  }
  const rawPage = row.page;
  if (typeof rawPage === 'number' && Number.isFinite(rawPage)) {
    return Math.max(0, Math.floor(rawPage) - 1);
  }
  if (typeof rawPage === 'string' && /^\d+$/.test(rawPage.trim())) {
    return Math.max(0, Number(rawPage.trim()) - 1);
  }
  return 0;
}

function extractCompatItemKey(row: Record<string, any>): string {
  const direct = row.zotero_item_key || row.item_key || row.itemKey || row.parent_key || row.key;
  if (direct) return String(direct).trim();
  if (typeof row.item_id === 'string' && row.item_id.trim() && !/^\d+$/.test(row.item_id.trim())) {
    return row.item_id.trim();
  }
  return '';
}

/**
 * Parse standard 3-file vector store JSON files cleanly, tolerating nested data-format.md layouts,
 * flat arrays, keyed maps, and camelCase / snake_case field aliases.
 */
export type CompatItemResolver = (itemKey: string, fallbackID?: number, libraryID?: number) =>
  { itemID: number; libraryID: number; itemKey?: string; metadataHash?: string } | null;

export function parseVectorStoreJson(
  input: {
    metadataJson?: any;
    fulltextJson?: any;
    storeMetaJson?: any;
  },
  resolveItemIDByKey: CompatItemResolver,
  resolveAttachmentIDByKey?: (
    attachmentKey: string,
    parentItemID: number,
    fallbackAttachmentID?: number
  ) => number | { attachmentID: number; attachmentKey?: string }
): ParsedCompatResult {
  const warnings: string[] = [];
  const metaHeader = input.storeMetaJson && typeof input.storeMetaJson === 'object' ? input.storeMetaJson : {};
  const embMetaObj =
    metaHeader.embedding_model && typeof metaHeader.embedding_model === 'object'
      ? metaHeader.embedding_model
      : null;

  const rawItems = normalizeArrayOrMapEntries(input.metadataJson, false);
  const rawChunks = normalizeArrayOrMapEntries(input.fulltextJson, true);
  const firstItemModel = rawItems.find((r) => r && typeof r === 'object' && typeof r.model === 'string' && r.model)?.model;

  const engine = String(
    metaHeader.engine || metaHeader.provider || embMetaObj?.engine || embMetaObj?.provider || 'imported'
  );
  const model = String(
    metaHeader.model ||
      (typeof metaHeader.embedding_model === 'string' ? metaHeader.embedding_model : '') ||
      embMetaObj?.model ||
      embMetaObj?.name ||
      firstItemModel ||
      'zotero-vectorize'
  );
  let dimension =
    Number(
      metaHeader.dimension ||
        metaHeader.embedding_dimension ||
        metaHeader.vector_dimension ||
        metaHeader.dim ||
        metaHeader.dimensions ||
        embMetaObj?.dimension ||
        embMetaObj?.embedding_dimension ||
        embMetaObj?.vector_dimension ||
        embMetaObj?.dim ||
        0
    ) || 0;

  const items: IndexedItemRecord[] = [];
  let skippedItems = 0;

  for (const row of rawItems) {
    if (!row || typeof row !== 'object') {
      skippedItems++;
      continue;
    }
    const rawItemID = extractNumericId(row.itemID ?? row.item_id);
    const rawItemKey = extractCompatItemKey(row);
    const libraryID = extractNumericId(row.library_id ?? row.libraryID);
    const rawEmb = row.embedding || row.vector;
    if ((!rawItemKey && !rawItemID) || !Array.isArray(rawEmb) || rawEmb.length === 0 || !isFiniteVector(rawEmb)) {
      skippedItems++;
      continue;
    }
    if (dimension === 0) dimension = rawEmb.length;
    if (rawEmb.length !== dimension) {
      warnings.push(`Skipped metadata item ${rawItemKey || rawItemID}: dimension ${rawEmb.length} != ${dimension}`);
      skippedItems++;
      continue;
    }
    const resolved = resolveItemIDByKey(rawItemKey, rawItemID, libraryID);
    if (!resolved) {
      skippedItems++;
      continue;
    }

    const itemKey = rawItemKey || resolved.itemKey || String(resolved.itemID);
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const vec = l2Normalize(rawEmb);
    const title = String(row.title ?? meta.title ?? '');
    const creators = formatCompatCreators(row.creators ?? row.authors ?? meta.creators ?? meta.authors);
    const year = extractCompatYear(row, meta);
    const publicationTitle = String(
      row.publication_title ?? row.publicationTitle ?? meta.publication_title ?? meta.publicationTitle ?? ''
    );
    const doi = String(row.doi ?? row.DOI ?? meta.DOI ?? meta.doi ?? '');
    const url = String(row.url ?? meta.url ?? '');
    const abstractNote = String(
      row.abstract ?? row.abstractNote ?? row.abstract_note ?? meta.abstractNote ?? meta.abstract ?? meta.abstract_note ?? ''
    );
    const tags = extractCompatTags(row.tags ?? meta.tags);
    const modelFingerprint =
      String(metaHeader.model_fingerprint || '') || buildModelFingerprint(engine, model, dimension);
    const rawUpdated = row.updated_at ?? row.dateModified ?? meta.dateModified;
    const parsedUpdated = rawUpdated ? Date.parse(String(rawUpdated)) : NaN;

    const record: IndexedItemRecord = {
      itemID: resolved.itemID,
      itemKey,
      libraryID: resolved.libraryID,
      itemType: String(row.item_type || row.itemType || meta.itemType || meta.item_type || 'journalArticle'),
      title,
      creators,
      year,
      publicationTitle,
      doi,
      url,
      tags,
      abstractNote,
      metadataHash: String(
        row.metadata_hash ||
          row.metadataHash ||
          hashMetadataFields({
            title,
            creators,
            year,
            publicationTitle,
            doi,
            tags,
            abstractNote,
          })
      ),
      vector: vec,
      dim: vec.length,
      modelFingerprint,
      updatedAt: Number.isFinite(parsedUpdated) ? parsedUpdated : Date.now(),
    };
    if (resolved.metadataHash && resolved.metadataHash !== record.metadataHash) {
      skippedItems++;
      continue;
    }
    items.push(record);
  }

  const chunks: IndexedChunkRecord[] = [];
  let skippedChunks = 0;

  for (let idx = 0; idx < rawChunks.length; idx++) {
    const row = rawChunks[idx];
    if (!row || typeof row !== 'object') {
      skippedChunks++;
      continue;
    }
    const rawItemID = extractNumericId(row.itemID ?? row.item_id);
    const rawItemKey = extractCompatItemKey(row);
    const libraryID = extractNumericId(row.library_id ?? row.libraryID);
    const rawEmb = row.embedding || row.vector;
    const text = String(row.text || row.text_content || row.content || '').trim();
    if ((!rawItemKey && !rawItemID) || !text || !Array.isArray(rawEmb) || rawEmb.length === 0 || !isFiniteVector(rawEmb)) {
      skippedChunks++;
      continue;
    }
    if (dimension === 0) dimension = rawEmb.length;
    if (rawEmb.length !== dimension) {
      warnings.push(`Skipped chunk for ${rawItemKey || rawItemID}: dimension ${rawEmb.length} != ${dimension}`);
      skippedChunks++;
      continue;
    }

    const parentResolved = resolveItemIDByKey(rawItemKey, rawItemID, libraryID);
    if (!parentResolved) {
      skippedChunks++;
      continue;
    }

    const itemKey = rawItemKey || parentResolved.itemKey || String(parentResolved.itemID);
    const rawAttID = extractNumericId(row.attachmentID ?? row.attachment_id);
    const rawAttKey = String(row.attachment_key || row.attachmentKey || '').trim();
    const lookupAttKey = rawAttKey || (rawAttID ? '' : String(row.filename || row.pdf_file || row.pdfFile || ''));
    const attResolved = resolveAttachmentIDByKey
      ? resolveAttachmentIDByKey(lookupAttKey, parentResolved.itemID, rawAttID)
      : rawAttID ?? 0;
    const attachmentID = typeof attResolved === 'number' ? attResolved : attResolved.attachmentID;
    if (resolveAttachmentIDByKey && !attachmentID) {
      skippedChunks++;
      continue;
    }
    const resolvedAttKey =
      typeof attResolved === 'object' && attResolved?.attachmentKey ? attResolved.attachmentKey : '';
    const attachmentKey =
      resolvedAttKey || rawAttKey || String(row.filename || row.pdf_file || row.pdfFile || itemKey);

    const pageIndex = parseCompatPageIndex(row);
    const chunkIndex = typeof row.chunk_index === 'number' ? row.chunk_index : idx;
    const chunkId = String(row.chunk_id || row.chunkId || `${attachmentKey}#${chunkIndex}`);
    const vec = l2Normalize(rawEmb);
    const modelFingerprint =
      String(metaHeader.model_fingerprint || '') || buildModelFingerprint(engine, model, dimension);

    chunks.push({
      chunkId,
      itemID: parentResolved.itemID,
      itemKey,
      attachmentID,
      attachmentKey,
      attachmentTitle: String(
        row.attachment_title || row.attachmentTitle || row.pdf_file || row.pdfFile || row.filename || 'PDF'
      ),
      chunkIndex,
      pageIndex,
      pageLabel: String(pageIndex + 1),
      charStart: Number(row.char_start ?? 0) || 0,
      charEnd: Number(row.char_end ?? text.length) || text.length,
      text,
      snippet: String(row.snippet || buildSnippet(text)),
      vector: vec,
      dim: vec.length,
      modelFingerprint,
      updatedAt: Date.now(),
    });
  }

  const finalFp =
    String(metaHeader.model_fingerprint || '') || buildModelFingerprint(engine, model, dimension);

  return {
    items,
    chunks,
    engine,
    model,
    modelFingerprint: finalFp,
    dimension,
    skippedItems,
    skippedChunks,
    warnings,
  };
}

export interface FileBackupIO {
  exists(path: string): Promise<boolean>;
  copy(src: string, dest: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * Rolling backup retention (keeps latest .bak.1 and previous .bak.2).
 */
export async function rotateBackups(io: FileBackupIO, filePath: string, maxBackups = 2): Promise<void> {
  if (!(await io.exists(filePath)) || maxBackups <= 0) return;

  for (let i = maxBackups; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.bak.${i - 1}`;
    const dst = `${filePath}.bak.${i}`;
    if (await io.exists(src)) {
      if (await io.exists(dst)) {
        await io.remove(dst);
      }
      await io.copy(src, dst);
    }
  }
}
