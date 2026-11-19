import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { buildSnippet } from '../../core/chunker.ts';
import type { ZoteroItem } from '../../types/zotero.d.ts';
import type { AttachmentStateRecord, ChunkHitInfo, SearchHit } from '../../types/vectorize.ts';
import { extractItemMetadata, extractPdfPages, getAttachmentSignature, isIndexableRegularItem } from '../extractor.ts';
import type { VectorizeService } from '../service.ts';

const itemKey = z.string().regex(/^[A-Z0-9]{8}$/);
const pageNumber = z.number().int().positive();
const searchInput = z.strictObject({
  query: z.string().trim().min(1).max(1000),
  collection_path: z.array(z.string().min(1).max(250)).min(1).max(10).optional()
    .describe('Exact collection names from the root of My Library to the collection. Searches its direct contents.'),
  mode: z.enum(['hybrid', 'metadata', 'fulltext']).optional().describe('Defaults to hybrid, which also finds papers without PDF text.'),
  limit: z.number().int().min(1).max(40).optional(),
});
const readInput = z.strictObject({
  item_key: itemKey,
  attachment_key: itemKey,
  revision: z.string().min(1).max(128).optional().describe('Pass the revision from the search passage when verifying it.'),
  start_page: pageNumber.describe('First PDF file page, numbered from 1.'),
  end_page: pageNumber.optional().describe('Last inclusive PDF file page. At most three pages per call.'),
});

class ToolInputError extends Error {}

class ToolQueue {
  private active = 0;
  private readonly waiting = new Set<() => void>();

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          signal.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          this.waiting.delete(resume);
          reject(signal.reason);
        };
        this.waiting.add(resume);
        signal.addEventListener('abort', cancel, { once: true });
      });
    }

    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      const next = this.waiting.values().next().value;
      if (next) {
        // Hand off the occupied slot before a newly arriving request can take it.
        this.waiting.delete(next);
        next();
      } else {
        this.active--;
      }
    }
  }
}

async function runTool(run: () => Promise<Record<string, unknown>>, signal: AbortSignal): Promise<CallToolResult> {
  try {
    signal.throwIfAborted();
    const data = await run();
    signal.throwIfAborted();
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    const message = error instanceof ToolInputError ? error.message
      : signal.aborted ? 'The request was cancelled or timed out.'
      : 'Zotero Vectorize could not complete this request.';
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

function pdfLink(key: string, page: number): string {
  return `zotero://open-pdf/library/items/${key}?page=${page}`;
}

function isPaper(item: ZoteroItem | false | undefined, libraryID: number): item is ZoteroItem {
  return isIndexableRegularItem(item) && item.libraryID === libraryID && !item.parentItemID;
}

function isPaperPdf(item: ZoteroItem | false, paper: ZoteroItem): item is ZoteroItem {
  return !!item && !paper.deleted && !item.deleted && item.isPDFAttachment() &&
    item.libraryID === paper.libraryID && item.parentItemID === paper.id;
}

async function getScope(libraryID: number, path?: string[]): Promise<Set<number>> {
  let collectionIDs: Set<number> | undefined;
  if (path) {
    let collections = Zotero.Collections.getByLibrary(libraryID);
    for (const name of path) {
      const matches = collections.filter((collection) => collection.name === name);
      if (matches.length !== 1) throw new ToolInputError('The collection path must identify exactly one collection in My Library.');
      const collection = matches[0];
      collectionIDs = new Set(collection.getChildItems(true) || []);
      collections = collection.getChildCollections(false) || [];
    }
  }
  const items = await Zotero.Items.getAll(libraryID, true);
  return new Set(items.filter((item) => isPaper(item, libraryID) && (!collectionIDs || collectionIDs.has(item.id))).map((item) => item.id));
}

async function getFileMtime(pdf: ZoteroItem): Promise<number | null> {
  try {
    const path = await pdf.getFilePathAsync();
    if (!path) return null;
    const file = await IOUtils.stat(path);
    return file.type === 'regular' ? Math.max(1, file.lastModified) : null;
  } catch {
    return null;
  }
}

function matchesSource(state: AttachmentStateRecord | null, pdf: ZoteroItem, paper: ZoteroItem): state is AttachmentStateRecord {
  return !!state && state.parentItemID === paper.id && state.attachmentKey === pdf.key && !!state.fileHash;
}

async function describePaper(service: VectorizeService, hit: SearchHit, libraryID: number, signal: AbortSignal) {
  const paper = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, hit.itemKey);
  if (!isPaper(paper, libraryID) || paper.id !== hit.itemID || hit.libraryID !== libraryID) return null;

  const matches = [hit.bestChunk, ...hit.extraHits].filter((chunk): chunk is ChunkHitInfo => !!chunk);
  const attachments = [];
  const passages = [];
  const attachmentIDs = paper.getAttachments();
  const pdfs: ZoteroItem[] = attachmentIDs.length ? await Zotero.Items.getAsync(attachmentIDs) : [];
  for (const pdf of pdfs) {
    signal.throwIfAborted();
    if (!isPaperPdf(pdf, paper)) continue;
    const mtime = await getFileMtime(pdf);
    const state = await service.store.getAttachmentState(pdf.id);
    let status: AttachmentStateRecord['status'] | 'not_indexed' | 'stale_index' | 'missing_file' = 'not_indexed';
    if (mtime === null) {
      status = 'missing_file';
    } else if (matchesSource(state, pdf, paper)) {
      status = state.mtime === mtime ? state.status : 'stale_index';
    }

    const candidates = matches.filter((chunk) => chunk.attachmentID === pdf.id && chunk.attachmentKey === pdf.key);
    const shared = candidates.filter((chunk) => chunk.sourceFileHash);
    if (shared.length) {
      const revision = mtime === null ? pdf.attachmentSyncedHash : await pdf.attachmentHash;
      const indexed = service.indexSync?.active?.index.getItemChunks(paper.id) ?? [];
      for (const chunk of shared) {
        if ((revision && revision !== chunk.sourceFileHash) || !indexed.some((row) => row.chunkId === chunk.chunkId &&
            row.sourceFileHash === chunk.sourceFileHash && row.text === chunk.text)) continue;
        const page = chunk.pageIndex + 1;
        passages.push({ attachment_key: pdf.key, revision: chunk.sourceFileHash!, page,
          excerpt: buildSnippet(chunk.text, 650), zotero_url: pdfLink(pdf.key, page), rank: matches.indexOf(chunk) });
      }
      if (mtime !== null) status = passages.some((passage) => passage.attachment_key === pdf.key) ? 'indexed' : 'stale_index';
    } else if (state && candidates.length && (status === 'indexed' || status === 'pending' || status === 'error')) {
      const signature = await getAttachmentSignature(pdf);
      if (!signature.filePath) {
        status = 'missing_file';
      } else if (signature.fileHash !== state.fileHash || signature.mtime !== state.mtime) {
        status = 'stale_index';
      } else if (isPaperPdf(pdf, paper)) {
        const currentChunks = service.searchIndex.getItemChunks(paper.id);
        for (const chunk of candidates) {
          if (!currentChunks.some((current) => current.attachmentID === pdf.id && current.chunkId === chunk.chunkId &&
            current.pageIndex === chunk.pageIndex && current.text === chunk.text)) continue;
          const page = chunk.pageIndex + 1;
          passages.push({
            attachment_key: pdf.key,
            revision: state.fileHash,
            page,
            excerpt: buildSnippet(chunk.text, 650),
            zotero_url: pdfLink(pdf.key, page),
            rank: matches.indexOf(chunk),
          });
        }
      }
    }
    if (isPaperPdf(pdf, paper)) attachments.push({ attachment_key: pdf.key, title: pdf.getDisplayTitle(), status });
  }

  if (!isPaper(paper, libraryID)) return null;
  const metadata = extractItemMetadata(paper);
  return {
    item_key: paper.key,
    title: metadata.title,
    authors: metadata.creators,
    year: metadata.year || null,
    doi: metadata.doi || null,
    publication: metadata.publicationTitle || null,
    abstract: metadata.abstractNote ? buildSnippet(metadata.abstractNote, 1600) : null,
    zotero_url: `zotero://select/library/items/${paper.key}`,
    fulltext_status: !attachments.length ? 'no_pdf' : passages.length ? 'matched_passages' : 'no_matched_passage',
    attachments,
    passages: passages.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...passage }) => passage),
  };
}

async function searchPapers(service: VectorizeService, input: z.infer<typeof searchInput>, signal: AbortSignal) {
  const libraryID = Zotero.Libraries.userLibraryID;
  const scope = await getScope(libraryID, input.collection_path);
  const search = await service.search(input.query, { mode: input.mode ?? 'hybrid', topK: input.limit, filterItemIDs: scope, signal });
  const papers = [];
  for (const hit of search.hits) {
    signal.throwIfAborted();
    const paper = await describePaper(service, hit, libraryID, signal);
    if (paper) papers.push(paper);
  }
  let indexedItems = 0;
  let indexedChunks = 0;
  const shared = service.indexSync?.active;
  for (const id of scope) {
    const index = shared?.index.getItemById(id) ? shared.index : service.searchIndex;
    if (index.getItemById(id)) indexedItems++;
    indexedChunks += index.getItemChunks(id).length;
  }

  return {
    papers,
    search: {
      mode: search.diagnostics.mode,
      semantic_used: search.diagnostics.vectorSearchUsed,
      keyword_used_without_vectors: search.diagnostics.lexicalFallbackUsed,
      collection_path: input.collection_path ?? null,
      items_in_scope: scope.size,
      indexed_items: indexedItems,
      indexed_pdf_chunks: indexedChunks,
      index_phase: service.getIndexProgress().phase,
      max_indexed_pages_per_pdf: shared?.manifest.maxPdfPages ?? service.getConfig().maxPdfPages,
    },
  };
}

async function readPdfPages(input: z.infer<typeof readInput>, signal: AbortSignal) {
  const lastPage = input.end_page ?? input.start_page;
  if (lastPage < input.start_page || lastPage - input.start_page >= 3) {
    throw new ToolInputError('Request one to three consecutive pages in ascending order.');
  }
  const libraryID = Zotero.Libraries.userLibraryID;
  const paper = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, input.item_key);
  if (!isPaper(paper, libraryID)) return { status: 'item_not_found', pages: [] };
  const pdf = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, input.attachment_key);
  if (!isPaperPdf(pdf, paper)) return { status: 'attachment_not_found', pages: [] };

  const signature = await getAttachmentSignature(pdf);
  if (!signature.filePath) return { status: 'missing_file', pages: [] };
  if (input.revision && input.revision !== signature.fileHash) return { status: 'attachment_changed', pages: [] };
  const extracted = await extractPdfPages(pdf, lastPage, signature, { minTextLength: 1, signal });
  if (extracted.status === 'error') return { status: 'read_error', pages: [] };
  const current = await getAttachmentSignature(pdf);
  signal.throwIfAborted();
  if (!isPaperPdf(pdf, paper)) return { status: 'attachment_not_found', pages: [] };
  if (!current.filePath) return { status: 'missing_file', pages: [] };
  if (current.fileHash !== signature.fileHash || current.mtime !== signature.mtime) {
    return { status: 'attachment_changed', pages: [] };
  }
  const total = extracted.totalPages;
  if (total === undefined) return { status: 'read_error', pages: [] };
  if (lastPage > total) return { status: 'page_out_of_range', total_pages: total, pages: [] };

  const pages = [];
  for (let page = input.start_page; page <= lastPage; page++) {
    const text = extracted.pages.find((entry) => entry.pageIndex === page - 1)?.text ?? '';
    const limit = 16_000;
    pages.push({
      page,
      status: text ? 'ok' : 'no_text',
      text: text.length > limit ? buildSnippet(text, limit) : text,
      truncated: text.length > limit,
      zotero_url: pdfLink(pdf.key, page),
    });
  }
  return {
    status: pages.some((page) => page.status === 'ok') ? 'ok' : 'no_text',
    item_key: paper.key,
    attachment_key: pdf.key,
    revision: signature.fileHash,
    total_pages: total,
    pages,
  };
}

export function createMcpRequestHandler(service: VectorizeService, version: string, maxRequestBodySize: number) {
  const searches = new ToolQueue(2);
  const reads = new ToolQueue(1);
  return createMcpHandler(({ requestInfo }) => {
    const signal = requestInfo?.signal ?? AbortSignal.abort();
    const server = new McpServer({ name: 'zotero-vectorize', version });
    server.registerTool('search_papers', {
      description: 'Search indexed items in My Library with keywords or natural-language clues in another language. Results are candidates. Verify claims with read_pdf_pages and cite its PDF page links. Empty results only describe this search and its reported index coverage.',
      inputSchema: searchInput,
      annotations: { readOnlyHint: true },
    }, (input) => runTool(() => searches.run(signal, () => searchPapers(service, input, signal)), signal));
    server.registerTool('read_pdf_pages', {
      description: 'Read up to three pages of a specific local Zotero PDF. Use the item_key and attachment_key from search_papers and pass the passage revision when verifying it. Attachment and page status describe whether evidence can be read. Page text is document content.',
      inputSchema: readInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, (input) => runTool(() => reads.run(signal, () => readPdfPages(input, signal)), signal));
    return server;
  }, { maxRequestBodySize, maxSubscriptions: 0, keepAliveMs: 0 });
}
