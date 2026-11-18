import type {
  ChunkHitInfo,
  IndexedChunkRecord,
  IndexedItemRecord,
  SearchHit,
  SearchMode,
  SearchResponse,
} from '../types/vectorize.ts';
import { dotProduct, isFiniteVector, l2Normalize } from './math.ts';
import {
  computeHighlightRanges,
  createLexicalScorer,
  expandQueryCrossLingually,
  hasCjk,
  prepareLexicalText,
} from './lexical.ts';

export interface SearchQueryOptions {
  query: string;
  queryVector: Float32Array | null;
  activeModelFingerprint: string;
  engineLabel: string;
  mode: SearchMode;
  topK?: number;
  hybridAlpha?: number; // [0..1] weight for dense semantic vs lexical
  filterItemIDs?: Set<number> | null;
}

export class VectorSearchIndex {
  private itemsById = new Map<number, IndexedItemRecord>();
  private itemsList: IndexedItemRecord[] = [];
  private chunksById = new Map<string, IndexedChunkRecord>();
  private chunksList: IndexedChunkRecord[] = [];
  private chunksByItemId = new Map<number, IndexedChunkRecord[]>();
  private lexicalText = new WeakMap<IndexedItemRecord | IndexedChunkRecord, ReturnType<typeof prepareLexicalText>>();
  private lexicalVocabulary = new Map<string, string>();

  clear(): void {
    this.itemsById.clear();
    this.itemsList = [];
    this.chunksById.clear();
    this.chunksList = [];
    this.chunksByItemId.clear();
    this.lexicalText = new WeakMap();
    this.lexicalVocabulary.clear();
  }

  loadAll(items: IndexedItemRecord[], chunks: IndexedChunkRecord[]): void {
    this.clear();
    for (const item of items) {
      const normalized = item.vector && isFiniteVector(item.vector) ? l2Normalize(item.vector) : null;
      const rec: IndexedItemRecord = {
        ...item,
        vector: normalized,
        dim: normalized ? normalized.length : 0,
      };
      this.itemsById.set(rec.itemID, rec);
      this.itemsList.push(rec);
    }
    for (const chunk of chunks) {
      const normalized = chunk.vector && isFiniteVector(chunk.vector) ? l2Normalize(chunk.vector) : null;
      const rec: IndexedChunkRecord = {
        ...chunk,
        vector: normalized,
        dim: normalized ? normalized.length : 0,
      };
      this.chunksById.set(rec.chunkId, rec);
      this.chunksList.push(rec);
      const list = this.chunksByItemId.get(rec.itemID) ?? [];
      list.push(rec);
      this.chunksByItemId.set(rec.itemID, list);
    }
  }

  upsertItem(item: IndexedItemRecord): void {
    const normalized = item.vector && isFiniteVector(item.vector) ? l2Normalize(item.vector) : null;
    const rec: IndexedItemRecord = {
      ...item,
      vector: normalized,
      dim: normalized ? normalized.length : 0,
    };
    const existed = this.itemsById.has(rec.itemID);
    this.itemsById.set(rec.itemID, rec);
    if (!existed) {
      this.itemsList.push(rec);
    } else {
      const idx = this.itemsList.findIndex((x) => x.itemID === rec.itemID);
      if (idx !== -1) this.itemsList[idx] = rec;
    }
  }

  replaceItemChunks(itemID: number, chunks: IndexedChunkRecord[]): void {
    // Remove previous chunks for itemID
    const prev = this.chunksByItemId.get(itemID) ?? [];
    if (prev.length > 0) {
      const prevIds = new Set(prev.map((c) => c.chunkId));
      for (const cid of prevIds) {
        this.chunksById.delete(cid);
      }
      this.chunksList = this.chunksList.filter((c) => !prevIds.has(c.chunkId));
    }

    const nextList: IndexedChunkRecord[] = [];
    for (const chunk of chunks) {
      const normalized = chunk.vector && isFiniteVector(chunk.vector) ? l2Normalize(chunk.vector) : null;
      const rec: IndexedChunkRecord = {
        ...chunk,
        vector: normalized,
        dim: normalized ? normalized.length : 0,
      };
      this.chunksById.set(rec.chunkId, rec);
      this.chunksList.push(rec);
      nextList.push(rec);
    }
    this.chunksByItemId.set(itemID, nextList);
  }

  removeItem(itemID: number): void {
    if (this.itemsById.delete(itemID)) {
      this.itemsList = this.itemsList.filter((x) => x.itemID !== itemID);
    }
    this.replaceItemChunks(itemID, []);
    this.chunksByItemId.delete(itemID);
  }

  getItemCount(): number {
    return this.itemsList.length;
  }

  getChunkCount(): number {
    return this.chunksList.length;
  }

  hasVectors(mode: SearchMode): boolean {
    return (mode !== 'fulltext' && this.itemsList.some((item) => item.vector !== null)) ||
      (mode !== 'metadata' && this.chunksList.some((chunk) => chunk.vector !== null));
  }

  getAllItems(): IndexedItemRecord[] {
    return [...this.itemsList];
  }

  getAllChunks(): IndexedChunkRecord[] {
    return [...this.chunksList];
  }

  getItemById(itemID: number): IndexedItemRecord | undefined {
    return this.itemsById.get(itemID);
  }

  private checkVectorCompatibility(
    queryVector: Float32Array | null,
    activeModelFingerprint: string,
    items: IndexedItemRecord[],
    chunks: IndexedChunkRecord[]
  ): { usableQueryVector: Float32Array | null; mismatchWarning?: string } {
    if (!queryVector || queryVector.length === 0 || !isFiniteVector(queryVector)) {
      return { usableQueryVector: null };
    }
    const normalizedQuery = l2Normalize(queryVector);
    const qDim = normalizedQuery.length;

    let sameDimCount = 0;
    let diffDimCount = 0;
    let sameFpCount = 0;
    const storedModels = new Set<string>();

    for (const item of items) {
      if (!item.vector || item.dim === 0) continue;
      if (item.modelFingerprint) storedModels.add(item.modelFingerprint);
      if (item.dim === qDim) {
        sameDimCount++;
        if (!activeModelFingerprint || !item.modelFingerprint || item.modelFingerprint === activeModelFingerprint) {
          sameFpCount++;
        }
      } else {
        diffDimCount++;
      }
    }

    for (const chunk of chunks) {
      if (!chunk.vector || chunk.dim === 0) continue;
      if (chunk.modelFingerprint) storedModels.add(chunk.modelFingerprint);
      if (chunk.dim === qDim) {
        sameDimCount++;
        if (!activeModelFingerprint || !chunk.modelFingerprint || chunk.modelFingerprint === activeModelFingerprint) {
          sameFpCount++;
        }
      } else {
        diffDimCount++;
      }
    }

    if (sameDimCount === 0 && diffDimCount > 0) {
      const existing = Array.from(storedModels)[0] || `${diffDimCount} vectors`;
      return {
        usableQueryVector: null,
        mismatchWarning: `Index vectors (${existing}) do not match current engine (${activeModelFingerprint || qDim + 'd'}). Using lexical search — rebuild index to enable neural matching.`,
      };
    }

    if (sameDimCount > 0 && sameFpCount === 0 && activeModelFingerprint && storedModels.size > 0) {
      const existing = Array.from(storedModels)[0];
      return {
        usableQueryVector: null,
        mismatchWarning: `Index was built with "${existing}", current engine is "${activeModelFingerprint}". Rebuild index to align embedding space.`,
      };
    }

    return { usableQueryVector: normalizedQuery };
  }

  search(options: SearchQueryOptions): SearchResponse {
    const work = this.scoreSearch(options, this.itemsById, this.itemsList, this.chunksList);
    let step = work.next();
    while (!step.done) step = work.next();
    return step.value;
  }

  async searchAsync(options: SearchQueryOptions, signal?: AbortSignal): Promise<SearchResponse> {
    signal?.throwIfAborted();
    // Indexing can replace records while scoring yields to Zotero's event loop.
    const work = this.scoreSearch(options, new Map(this.itemsById), this.itemsList.slice(), this.chunksList.slice());
    let deadline = Date.now() + 8;
    let step = work.next();
    while (!step.done) {
      if (Date.now() >= deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
        deadline = Date.now() + 8;
      }
      step = work.next();
    }
    return step.value;
  }

  private *scoreSearch(
    options: SearchQueryOptions,
    itemsById: ReadonlyMap<number, IndexedItemRecord>,
    items: IndexedItemRecord[],
    chunks: IndexedChunkRecord[]
  ): Generator<void, SearchResponse> {
    const startMs = Date.now();
    const query = (options.query || '').trim();
    const topK = Math.max(1, Math.min(50, options.topK ?? 12));
    const alpha = Math.max(0, Math.min(1, options.hybridAlpha ?? 0.85));

    if (!query) {
      return {
        hits: [],
        diagnostics: {
          query: '',
          mode: options.mode,
          durationMs: 0,
          vectorSearchUsed: false,
          lexicalFallbackUsed: false,
          engineLabel: options.engineLabel,
          totalIndexedItems: items.length,
          totalIndexedChunks: chunks.length,
        },
      };
    }

    const { usableQueryVector, mismatchWarning } = this.checkVectorCompatibility(
      alpha === 0 ? null : options.queryVector,
      options.activeModelFingerprint,
      options.mode === 'fulltext' ? [] : items,
      options.mode === 'metadata' ? [] : chunks
    );
    const scoreLexical = createLexicalScorer(query);
    const queryIsCjk = hasCjk(query);
    let processed = 0;

    let vectorSearchUsed = false;
    let lexicalFallbackUsed = false;

    // 1. Score Metadata Items (when mode is 'metadata' or 'hybrid')
    const metaScores = new Map<
      number,
      { semantic: number; lexical: number; crossLingual: boolean; compatibleVector: boolean }
    >();

    if (options.mode === 'metadata' || options.mode === 'hybrid') {
      for (const item of items) {
        if (++processed % 32 === 0) yield;
        if (options.filterItemIDs && !options.filterItemIDs.has(item.itemID)) continue;

        let sem = 0;
        let compatibleVector = false;
        if (
          usableQueryVector &&
          item.vector &&
          item.dim === usableQueryVector.length &&
          (!options.activeModelFingerprint ||
            !item.modelFingerprint ||
            item.modelFingerprint === options.activeModelFingerprint)
        ) {
          sem = Math.max(0, Math.min(1, dotProduct(usableQueryVector, item.vector)));
          compatibleVector = true;
          vectorSearchUsed = true;
        }

        let lexicalText = this.lexicalText.get(item);
        if (!lexicalText) {
          lexicalText = prepareLexicalText({
            title: item.title,
            meta: `${item.creators} ${item.year} ${item.publicationTitle} ${item.tags.join(' ')}`,
            body: item.abstractNote,
          }, this.lexicalVocabulary);
          this.lexicalText.set(item, lexicalText);
        }
        const lex = scoreLexical(lexicalText);

        const titleHasCjk = hasCjk(lexicalText.titleLower);
        const neuralCrossLingual = compatibleVector && sem >= 0.38 && queryIsCjk !== titleHasCjk;

        metaScores.set(item.itemID, {
          semantic: sem,
          lexical: lex.score,
          crossLingual: lex.crossLingualHit || neuralCrossLingual,
          compatibleVector,
        });
      }
    }

    // 2. Score Fulltext Chunks (when mode is 'fulltext' or 'hybrid')
    const chunksByParent = new Map<number, Array<ChunkHitInfo & { compatibleVector: boolean }>>();
    if (options.mode === 'fulltext' || options.mode === 'hybrid') {
      for (const chunk of chunks) {
        if (++processed % 32 === 0) yield;
        if (options.filterItemIDs && !options.filterItemIDs.has(chunk.itemID)) continue;

        let sem = 0;
        let compatibleVector = false;
        if (
          usableQueryVector &&
          chunk.vector &&
          chunk.dim === usableQueryVector.length &&
          (!options.activeModelFingerprint ||
            !chunk.modelFingerprint ||
            chunk.modelFingerprint === options.activeModelFingerprint)
        ) {
          sem = Math.max(0, Math.min(1, dotProduct(usableQueryVector, chunk.vector)));
          compatibleVector = true;
          vectorSearchUsed = true;
        }

        let lexicalText = this.lexicalText.get(chunk);
        if (!lexicalText) {
          lexicalText = prepareLexicalText({ body: chunk.text }, this.lexicalVocabulary);
          this.lexicalText.set(chunk, lexicalText);
        }
        const lex = scoreLexical(lexicalText);

        const combinedChunkScore = compatibleVector
          ? alpha * sem + (1 - alpha) * lex.score
          : lex.score;

        if (!compatibleVector && lex.score > 0) {
          lexicalFallbackUsed = true;
        }

        // Prune clearly irrelevant chunks early
        if (combinedChunkScore < 0.04 && sem < 0.12 && lex.score <= 0) {
          continue;
        }

        const list = chunksByParent.get(chunk.itemID) ?? [];
        list.push({
          chunkId: chunk.chunkId,
          attachmentID: chunk.attachmentID,
          attachmentKey: chunk.attachmentKey,
          attachmentTitle: chunk.attachmentTitle,
          pageIndex: chunk.pageIndex,
          pageLabel: chunk.pageLabel,
          snippet: chunk.snippet,
          text: chunk.text,
          score: combinedChunkScore,
          semanticScore: sem,
          lexicalScore: lex.score,
          compatibleVector,
          highlightRanges: [],
        });
        chunksByParent.set(chunk.itemID, list);
      }
    }

    if (!vectorSearchUsed && (metaScores.size > 0 || chunksByParent.size > 0)) {
      lexicalFallbackUsed = true;
    }

    // 3. Calibrate semantic range when dense vectors are used so E5/BGE/OpenAI scale cleanly with lexical
    let rawMin = Infinity;
    let rawMax = -Infinity;
    let rawCount = 0;
    for (const m of metaScores.values()) {
      if (m.compatibleVector) {
        if (m.semantic < rawMin) rawMin = m.semantic;
        if (m.semantic > rawMax) rawMax = m.semantic;
        rawCount++;
      }
    }
    for (const list of chunksByParent.values()) {
      let strongest = 0;
      for (const chunk of list) strongest = Math.max(strongest, chunk.semanticScore);
      if (strongest > 0) {
        if (strongest < rawMin) rawMin = strongest;
        if (strongest > rawMax) rawMax = strongest;
        rawCount++;
      }
    }
    const minSem = rawCount > 1 ? rawMin : 0;
    const maxSem = rawCount > 0 ? rawMax : 1;
    const semSpan = Math.max(0.08, maxSem - minSem);
    const stretchSemantic = (raw: number): number => {
      if (raw <= 0) return 0;
      const rel = Math.max(0, Math.min(1, (raw - minSem) / semSpan));
      return 0.55 * raw + 0.45 * rel;
    };
    for (const list of chunksByParent.values()) {
      if (++processed % 32 === 0) yield;
      for (const chunk of list) {
        if (chunk.compatibleVector) {
          chunk.score = alpha * stretchSemantic(chunk.semanticScore) + (1 - alpha) * chunk.lexicalScore;
        }
      }
      list.sort((a, b) => b.score - a.score);
    }

    // 4. Assemble candidate SearchHits per item
    const candidateItemIds = new Set<number>();
    for (const id of metaScores.keys()) candidateItemIds.add(id);
    for (const id of chunksByParent.keys()) candidateItemIds.add(id);

    const hits: SearchHit[] = [];

    for (const itemID of candidateItemIds) {
      if (++processed % 32 === 0) yield;
      const item = itemsById.get(itemID);
      if (!item) continue;

      const meta = metaScores.get(itemID);
      const chunkList = chunksByParent.get(itemID) ?? [];
      const bestChunk = chunkList[0];

      let finalScore = 0;
      let semanticScore = 0;
      let lexicalScore = 0;
      let crossLingualMatched = meta?.crossLingual ?? false;

      if (options.mode === 'metadata') {
        if (!meta) continue;
        semanticScore = meta.semantic;
        lexicalScore = meta.lexical;
        finalScore = meta.compatibleVector
          ? alpha * stretchSemantic(meta.semantic) + (1 - alpha) * meta.lexical
          : meta.lexical;
      } else if (options.mode === 'fulltext') {
        if (!bestChunk) continue;
        semanticScore = bestChunk.semanticScore;
        lexicalScore = bestChunk.lexicalScore;
        finalScore = bestChunk.score;
        if (queryIsCjk !== hasCjk(bestChunk.text) && (bestChunk.semanticScore >= 0.38 || bestChunk.lexicalScore > 0)) {
          crossLingualMatched = true;
        }
      } else {
        // Hybrid: combine metadata signal + fulltext best chunk signal
        const metaSem = meta?.semantic ?? 0;
        const metaLex = meta?.lexical ?? 0;
        const metaTotal = meta?.compatibleVector
          ? alpha * stretchSemantic(metaSem) + (1 - alpha) * metaLex
          : metaLex;

        const chunkSem = bestChunk?.semanticScore ?? 0;
        const chunkLex = bestChunk?.lexicalScore ?? 0;
        const chunkTotal = bestChunk?.score ?? 0;

        semanticScore = Math.max(metaSem, chunkSem);
        lexicalScore = Math.max(metaLex, chunkLex);

        const strongest = Math.max(metaTotal, chunkTotal);
        const corroboration = Math.min(metaTotal, chunkTotal);
        finalScore = 0.65 * strongest + 0.35 * corroboration;

        if (
          bestChunk &&
          queryIsCjk !== hasCjk(bestChunk.text) &&
          (bestChunk.semanticScore >= 0.38 || bestChunk.lexicalScore > 0)
        ) {
          crossLingualMatched = true;
        }
      }

      // If running in lexical-only fallback mode (or pure lexical weight alpha === 0), drop zero-score records
      if ((!vectorSearchUsed || alpha === 0) && lexicalScore <= 0) {
        continue;
      }
      // Even in vector mode, filter obviously irrelevant tail if lexical is 0 and cosine is noise
      if (vectorSearchUsed && finalScore <= 0.05 && lexicalScore <= 0 && semanticScore < 0.15) {
        continue;
      }

      hits.push({
        itemID: item.itemID,
        itemKey: item.itemKey,
        libraryID: item.libraryID,
        title: item.title,
        creators: item.creators,
        year: item.year,
        publicationTitle: item.publicationTitle,
        itemType: item.itemType,
        tags: item.tags,
        abstractNote: item.abstractNote,
        score: Math.min(1, Math.max(0, finalScore)),
        semanticScore,
        lexicalScore,
        matchKind: options.mode,
        crossLingualMatched,
        bestChunk,
        extraHits: chunkList.slice(1, 4),
        extraHitsCount: Math.max(0, chunkList.length - 1),
      });
    }

    hits.sort((a, b) => b.score - a.score || b.semanticScore - a.semanticScore || b.lexicalScore - a.lexicalScore);

    const topHits = hits.slice(0, topK);
    for (const h of topHits) {
      if (h.bestChunk) {
        h.bestChunk.highlightRanges = computeHighlightRanges(h.bestChunk.snippet, query);
      }
      for (const extra of h.extraHits) {
        extra.highlightRanges = computeHighlightRanges(extra.snippet, query);
      }
    }

    return {
      hits: topHits,
      diagnostics: {
        query,
        mode: options.mode,
        durationMs: Math.max(0, Date.now() - startMs),
        vectorSearchUsed,
        lexicalFallbackUsed,
        mismatchWarning,
        engineLabel: options.engineLabel,
        totalIndexedItems: items.length,
        totalIndexedChunks: chunks.length,
      },
    };
  }

  findSimilarItems(
    itemID: number,
    options?: { topK?: number; filterItemIDs?: Set<number> | null }
  ): Array<{ item: IndexedItemRecord; score: number }> {
    const source = this.itemsById.get(itemID);
    if (!source) return [];
    const topK = Math.max(1, Math.min(20, options?.topK ?? 5));
    const scored: Array<{ item: IndexedItemRecord; score: number }> = [];

    if (source.vector && source.dim > 0) {
      for (const candidate of this.itemsList) {
        if (candidate.itemID === itemID) continue;
        if (options?.filterItemIDs && !options.filterItemIDs.has(candidate.itemID)) continue;
        if (!candidate.vector || candidate.dim !== source.dim) continue;
        if (source.modelFingerprint && candidate.modelFingerprint && source.modelFingerprint !== candidate.modelFingerprint) {
          continue;
        }
        const sim = Math.max(0, Math.min(1, dotProduct(source.vector, candidate.vector)));
        if (sim > 0.2) {
          scored.push({ item: candidate, score: sim });
        }
      }
    } else if (source.title) {
      const exp = expandQueryCrossLingually(`${source.title} ${source.tags.join(' ')}`);
      const scoreLexical = createLexicalScorer(source.title, exp);
      for (const candidate of this.itemsList) {
        if (candidate.itemID === itemID) continue;
        if (options?.filterItemIDs && !options.filterItemIDs.has(candidate.itemID)) continue;
        const lex = scoreLexical(prepareLexicalText({
          title: candidate.title,
          meta: `${candidate.creators} ${candidate.tags.join(' ')}`,
          body: candidate.abstractNote,
        }));
        if (lex.score > 0.12) {
          scored.push({ item: candidate, score: lex.score });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
