import type {
  AttachmentStateRecord,
  IndexedChunkRecord,
  IndexedItemRecord,
  StoreStats,
} from '../types/vectorize.ts';
import type { ZoteroDBConnectionInstance } from '../types/zotero.d.ts';
import { bytesToFloat32, float32ToBytes, isFiniteVector } from '../core/math.ts';
import { parseVectorStoreJson, serializeVectorStoreJson } from '../core/compat-json.ts';
import { VectorSearchIndex } from '../core/search-engine.ts';

const SCHEMA_VERSION = '1';

export class VectorStore {
  private readonly storeDir: string;
  private readonly dbPath: string;
  private db: ZoteroDBConnectionInstance | null = null;
  private openPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(dataDir: string) {
    this.storeDir = PathUtils.join(dataDir, 'zotero-vectorize');
    this.dbPath = PathUtils.join(this.storeDir, 'vectorize.sqlite');
  }

  getStoreDir(): string {
    return this.storeDir;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async open(): Promise<void> {
    if (this.db && !this.db.closed) return;
    if (this.openPromise) return this.openPromise;

    this.openPromise = (async () => {
      this.closed = false;
      await IOUtils.makeDirectory(this.storeDir, { ignoreExisting: true, createAncestors: true });
      const conn = new Zotero.DBConnection(this.dbPath);
      this.db = conn;

      await conn.queryAsync('PRAGMA journal_mode = WAL');
      await conn.queryAsync('PRAGMA synchronous = NORMAL');
      await conn.queryAsync('PRAGMA temp_store = MEMORY');

      await conn.executeTransaction(async () => {
        await conn.queryAsync(`
          CREATE TABLE IF NOT EXISTS store_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
        await conn.queryAsync(`
          CREATE TABLE IF NOT EXISTS item_vectors (
            item_id INTEGER PRIMARY KEY,
            item_key TEXT NOT NULL,
            library_id INTEGER NOT NULL DEFAULT 1,
            item_type TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            creators TEXT NOT NULL DEFAULT '',
            year TEXT NOT NULL DEFAULT '',
            publication_title TEXT NOT NULL DEFAULT '',
            doi TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL DEFAULT '',
            tags_json TEXT NOT NULL DEFAULT '[]',
            abstract_note TEXT NOT NULL DEFAULT '',
            metadata_hash TEXT NOT NULL DEFAULT '',
            vector BLOB,
            dim INTEGER NOT NULL DEFAULT 0,
            model_fingerprint TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
          )
        `);
        await conn.queryAsync(`
          CREATE INDEX IF NOT EXISTS idx_item_vectors_key ON item_vectors(item_key)
        `);
        await conn.queryAsync(`
          CREATE TABLE IF NOT EXISTS fulltext_chunks (
            chunk_id TEXT PRIMARY KEY,
            item_id INTEGER NOT NULL,
            item_key TEXT NOT NULL,
            attachment_id INTEGER NOT NULL,
            attachment_key TEXT NOT NULL,
            attachment_title TEXT NOT NULL DEFAULT '',
            chunk_index INTEGER NOT NULL,
            page_index INTEGER NOT NULL,
            page_label TEXT NOT NULL DEFAULT '',
            char_start INTEGER NOT NULL DEFAULT 0,
            char_end INTEGER NOT NULL DEFAULT 0,
            text TEXT NOT NULL,
            snippet TEXT NOT NULL,
            vector BLOB,
            dim INTEGER NOT NULL DEFAULT 0,
            model_fingerprint TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
          )
        `);
        await conn.queryAsync(`
          CREATE INDEX IF NOT EXISTS idx_chunks_item ON fulltext_chunks(item_id)
        `);
        await conn.queryAsync(`
          CREATE INDEX IF NOT EXISTS idx_chunks_attachment ON fulltext_chunks(attachment_id)
        `);
        await conn.queryAsync(`
          CREATE TABLE IF NOT EXISTS attachment_state (
            attachment_id INTEGER PRIMARY KEY,
            attachment_key TEXT NOT NULL,
            parent_item_id INTEGER NOT NULL,
            file_hash TEXT NOT NULL DEFAULT '',
            mtime INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'indexed',
            chunk_count INTEGER NOT NULL DEFAULT 0,
            model_fingerprint TEXT NOT NULL DEFAULT '',
            error_message TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
          )
        `);
        await conn.queryAsync(
          `INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)`,
          ['schema_version', SCHEMA_VERSION]
        );
        await conn.queryAsync(
          `INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)`,
          ['created_at', new Date().toISOString()]
        );
      });
    })().finally(() => {
      this.openPromise = null;
    });

    return this.openPromise;
  }

  private async ensureConn(): Promise<ZoteroDBConnectionInstance> {
    if (this.closed) {
      throw new Error('VectorStore is closed');
    }
    await this.open();
    if (!this.db) {
      throw new Error('VectorStore database handle unavailable');
    }
    return this.db;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain.catch(() => {});
    if (this.db && !this.db.closed) {
      await this.db.closeDatabase(true);
    }
    this.db = null;
  }

  async getMeta(key: string): Promise<string | null> {
    const conn = await this.ensureConn();
    const val = await conn.valueQueryAsync<string | false>(
      'SELECT value FROM store_meta WHERE key = ?',
      [key]
    );
    return val === false || val === undefined || val === null ? null : String(val);
  }

  async setMetaBatch(entries: Record<string, string>): Promise<void> {
    return this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      await conn.executeTransaction(async () => {
        for (const [k, v] of Object.entries(entries)) {
          await conn.queryAsync(
            'INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)',
            [String(k), String(v)]
          );
        }
      });
    });
  }

  private decodeVectorBlob(blob: unknown, dim: number): Float32Array | null {
    if (!dim || dim <= 0 || !blob) return null;
    try {
      const vec = bytesToFloat32(blob as Uint8Array | ArrayBuffer | number[]);
      if (vec.length !== dim || !isFiniteVector(vec)) return null;
      return vec;
    } catch {
      return null;
    }
  }

  private encodeVectorBlob(vec: Float32Array | null): { blob: Uint8Array | null; dim: number } {
    if (!vec || vec.length === 0 || !isFiniteVector(vec)) {
      return { blob: null, dim: 0 };
    }
    return { blob: float32ToBytes(vec), dim: vec.length };
  }

  async loadAll(): Promise<{ items: IndexedItemRecord[]; chunks: IndexedChunkRecord[] }> {
    const conn = await this.ensureConn();
    const itemRows = await conn.queryAsync<Record<string, any>>(
      `SELECT item_id, item_key, library_id, item_type, title, creators, year,
              publication_title, doi, url, tags_json, abstract_note, metadata_hash,
              vector, dim, model_fingerprint, updated_at
       FROM item_vectors`
    );

    const items: IndexedItemRecord[] = [];
    for (const row of itemRows) {
      let tags: string[] = [];
      try {
        const parsed = JSON.parse(String(row.tags_json || '[]'));
        if (Array.isArray(parsed)) tags = parsed.map(String);
      } catch {
        tags = [];
      }
      const dim = Number(row.dim) || 0;
      const vector = this.decodeVectorBlob(row.vector, dim);
      items.push({
        itemID: Number(row.item_id),
        itemKey: String(row.item_key || ''),
        libraryID: Number(row.library_id) || 1,
        itemType: String(row.item_type || ''),
        title: String(row.title || ''),
        creators: String(row.creators || ''),
        year: String(row.year || ''),
        publicationTitle: String(row.publication_title || ''),
        doi: String(row.doi || ''),
        url: String(row.url || ''),
        tags,
        abstractNote: String(row.abstract_note || ''),
        metadataHash: String(row.metadata_hash || ''),
        vector,
        dim: vector ? vector.length : 0,
        modelFingerprint: String(row.model_fingerprint || ''),
        updatedAt: Number(row.updated_at) || 0,
      });
    }

    const chunkRows = await conn.queryAsync<Record<string, any>>(
      `SELECT chunk_id, item_id, item_key, attachment_id, attachment_key, attachment_title,
              chunk_index, page_index, page_label, char_start, char_end, text, snippet,
              vector, dim, model_fingerprint, updated_at
       FROM fulltext_chunks`
    );

    const chunks: IndexedChunkRecord[] = [];
    for (const row of chunkRows) {
      const dim = Number(row.dim) || 0;
      const vector = this.decodeVectorBlob(row.vector, dim);
      chunks.push({
        chunkId: String(row.chunk_id),
        itemID: Number(row.item_id),
        itemKey: String(row.item_key || ''),
        attachmentID: Number(row.attachment_id) || 0,
        attachmentKey: String(row.attachment_key || ''),
        attachmentTitle: String(row.attachment_title || ''),
        chunkIndex: Number(row.chunk_index) || 0,
        pageIndex: Number(row.page_index) || 0,
        pageLabel: String(row.page_label || String((Number(row.page_index) || 0) + 1)),
        charStart: Number(row.char_start) || 0,
        charEnd: Number(row.char_end) || 0,
        text: String(row.text || ''),
        snippet: String(row.snippet || ''),
        vector,
        dim: vector ? vector.length : 0,
        modelFingerprint: String(row.model_fingerprint || ''),
        updatedAt: Number(row.updated_at) || 0,
      });
    }

    return { items, chunks };
  }

  async loadIntoSearchIndex(index: VectorSearchIndex): Promise<{ items: number; chunks: number }> {
    const { items, chunks } = await this.loadAll();
    index.loadAll(items, chunks);
    return { items: items.length, chunks: chunks.length };
  }

  async getItemSyncInfo(itemID: number): Promise<{ metadataHash: string; modelFingerprint: string; hasVector: boolean } | null> {
    const conn = await this.ensureConn();
    const row = await conn.rowQueryAsync<Record<string, any>>(
      'SELECT metadata_hash, model_fingerprint, dim FROM item_vectors WHERE item_id = ?',
      [itemID]
    );
    if (!row) return null;
    return {
      metadataHash: String(row.metadata_hash || ''),
      modelFingerprint: String(row.model_fingerprint || ''),
      hasVector: Number(row.dim) > 0,
    };
  }

  async getAttachmentState(attachmentID: number): Promise<AttachmentStateRecord | null> {
    const conn = await this.ensureConn();
    const row = await conn.rowQueryAsync<Record<string, any>>(
      `SELECT attachment_id, attachment_key, parent_item_id, file_hash, mtime, status,
              chunk_count, model_fingerprint, error_message, updated_at
       FROM attachment_state WHERE attachment_id = ?`,
      [attachmentID]
    );
    if (!row) return null;
    return {
      attachmentID: Number(row.attachment_id),
      attachmentKey: String(row.attachment_key || ''),
      parentItemID: Number(row.parent_item_id),
      fileHash: String(row.file_hash || ''),
      mtime: Number(row.mtime) || 0,
      status: (row.status || 'indexed') as AttachmentStateRecord['status'],
      chunkCount: Number(row.chunk_count) || 0,
      modelFingerprint: String(row.model_fingerprint || ''),
      errorMessage: row.error_message ? String(row.error_message) : undefined,
      updatedAt: Number(row.updated_at) || 0,
    };
  }

  async upsertItem(record: IndexedItemRecord): Promise<void> {
    return this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      const { blob, dim } = this.encodeVectorBlob(record.vector);
      await conn.executeTransaction(async () => {
        await conn.queryAsync(
          `INSERT OR REPLACE INTO item_vectors (
            item_id, item_key, library_id, item_type, title, creators, year,
            publication_title, doi, url, tags_json, abstract_note, metadata_hash,
            vector, dim, model_fingerprint, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.itemID,
            record.itemKey,
            record.libraryID,
            record.itemType,
            record.title,
            record.creators,
            record.year,
            record.publicationTitle,
            record.doi,
            record.url,
            JSON.stringify(record.tags ?? []),
            record.abstractNote,
            record.metadataHash,
            blob,
            dim,
            record.modelFingerprint,
            record.updatedAt || Date.now(),
          ],
          { debugParams: false, noParseParams: true }
        );
        await conn.queryAsync(
          'INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)',
          ['last_indexed_at', String(Date.now())]
        );
      });
    });
  }

  async replaceAttachmentChunksAndState(
    attachmentID: number,
    parentItemID: number,
    chunks: IndexedChunkRecord[],
    state: AttachmentStateRecord
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      await conn.executeTransaction(async () => {
        await conn.queryAsync('DELETE FROM fulltext_chunks WHERE attachment_id = ?', [attachmentID]);
        // Also purge legacy imported chunks under attachment_id = 0 for same attachmentKey if re-indexed natively
        if (state.attachmentKey) {
          await conn.queryAsync(
            'DELETE FROM fulltext_chunks WHERE item_id = ? AND attachment_key = ?',
            [parentItemID, state.attachmentKey]
          );
        }
        for (const chunk of chunks) {
          const { blob, dim } = this.encodeVectorBlob(chunk.vector);
          await conn.queryAsync(
            `INSERT OR REPLACE INTO fulltext_chunks (
              chunk_id, item_id, item_key, attachment_id, attachment_key, attachment_title,
              chunk_index, page_index, page_label, char_start, char_end, text, snippet,
              vector, dim, model_fingerprint, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              chunk.chunkId,
              chunk.itemID,
              chunk.itemKey,
              chunk.attachmentID,
              chunk.attachmentKey,
              chunk.attachmentTitle,
              chunk.chunkIndex,
              chunk.pageIndex,
              chunk.pageLabel,
              chunk.charStart,
              chunk.charEnd,
              chunk.text,
              chunk.snippet,
              blob,
              dim,
              chunk.modelFingerprint,
              chunk.updatedAt || Date.now(),
            ],
            { debugParams: false, noParseParams: true }
          );
        }
        await conn.queryAsync(
          `INSERT OR REPLACE INTO attachment_state (
            attachment_id, attachment_key, parent_item_id, file_hash, mtime, status,
            chunk_count, model_fingerprint, error_message, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            state.attachmentID,
            state.attachmentKey,
            state.parentItemID,
            state.fileHash,
            state.mtime,
            state.status,
            state.chunkCount,
            state.modelFingerprint,
            state.errorMessage || '',
            state.updatedAt || Date.now(),
          ]
        );
        await conn.queryAsync(
          'INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)',
          ['last_indexed_at', String(Date.now())]
        );
      });
    });
  }

  async getChunksForItem(itemID: number): Promise<IndexedChunkRecord[]> {
    const conn = await this.ensureConn();
    const rows = await conn.queryAsync<Record<string, any>>(
      `SELECT chunk_id, item_id, item_key, attachment_id, attachment_key, attachment_title,
              chunk_index, page_index, page_label, char_start, char_end, text, snippet,
              vector, dim, model_fingerprint, updated_at
       FROM fulltext_chunks WHERE item_id = ?`,
      [itemID]
    );
    return rows.map((row) => {
      const dim = Number(row.dim) || 0;
      const vector = this.decodeVectorBlob(row.vector, dim);
      return {
        chunkId: String(row.chunk_id),
        itemID: Number(row.item_id),
        itemKey: String(row.item_key || ''),
        attachmentID: Number(row.attachment_id) || 0,
        attachmentKey: String(row.attachment_key || ''),
        attachmentTitle: String(row.attachment_title || ''),
        chunkIndex: Number(row.chunk_index) || 0,
        pageIndex: Number(row.page_index) || 0,
        pageLabel: String(row.page_label || String((Number(row.page_index) || 0) + 1)),
        charStart: Number(row.char_start) || 0,
        charEnd: Number(row.char_end) || 0,
        text: String(row.text || ''),
        snippet: String(row.snippet || ''),
        vector,
        dim: vector ? vector.length : 0,
        modelFingerprint: String(row.model_fingerprint || ''),
        updatedAt: Number(row.updated_at) || 0,
      };
    });
  }

  async removeItem(itemID: number): Promise<void> {
    return this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      await conn.executeTransaction(async () => {
        await conn.queryAsync('DELETE FROM item_vectors WHERE item_id = ?', [itemID]);
        await conn.queryAsync('DELETE FROM fulltext_chunks WHERE item_id = ?', [itemID]);
        await conn.queryAsync('DELETE FROM attachment_state WHERE parent_item_id = ?', [itemID]);
      });
    });
  }

  async removeAttachment(attachmentID: number): Promise<number | null> {
    return this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      const parentId = await conn.valueQueryAsync<number | false>(
        'SELECT parent_item_id FROM attachment_state WHERE attachment_id = ?',
        [attachmentID]
      );
      await conn.executeTransaction(async () => {
        await conn.queryAsync('DELETE FROM fulltext_chunks WHERE attachment_id = ?', [attachmentID]);
        await conn.queryAsync('DELETE FROM attachment_state WHERE attachment_id = ?', [attachmentID]);
      });
      return parentId === false || parentId === null ? null : Number(parentId);
    });
  }

  async clearAll(): Promise<void> {
    return this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      await conn.executeTransaction(async () => {
        await conn.queryAsync('DELETE FROM item_vectors');
        await conn.queryAsync('DELETE FROM fulltext_chunks');
        await conn.queryAsync('DELETE FROM attachment_state');
        await conn.queryAsync('DELETE FROM store_meta WHERE key != ?', ['created_at']);
        await conn.queryAsync(
          'INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)',
          ['schema_version', SCHEMA_VERSION]
        );
      });
    });
  }

  async getStats(): Promise<StoreStats> {
    const conn = await this.ensureConn();
    const itemSummary = await conn.rowQueryAsync<Record<string, any>>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN dim > 0 THEN 1 ELSE 0 END) AS vec_count,
              MAX(dim) AS max_dim
       FROM item_vectors`
    );
    const chunkSummary = await conn.rowQueryAsync<Record<string, any>>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN dim > 0 THEN 1 ELSE 0 END) AS vec_count,
              MAX(dim) AS max_dim
       FROM fulltext_chunks`
    );
    const attCount = await conn.valueQueryAsync<number>('SELECT COUNT(*) FROM attachment_state');
    const fpRow = await conn.rowQueryAsync<Record<string, any>>(
      `SELECT model_fingerprint FROM item_vectors WHERE dim > 0 AND model_fingerprint != ''
       ORDER BY updated_at DESC LIMIT 1`
    );
    const chunkFpRow = !fpRow
      ? await conn.rowQueryAsync<Record<string, any>>(
          `SELECT model_fingerprint FROM fulltext_chunks WHERE dim > 0 AND model_fingerprint != ''
           ORDER BY updated_at DESC LIMIT 1`
        )
      : null;

    const lastIndexedAtStr = await this.getMeta('last_indexed_at');
    let dbSizeBytes = 0;
    try {
      const st = await IOUtils.stat(this.dbPath);
      dbSizeBytes = st.size || 0;
      const walPath = `${this.dbPath}-wal`;
      if (await IOUtils.exists(walPath)) {
        const walSt = await IOUtils.stat(walPath);
        dbSizeBytes += walSt.size || 0;
      }
    } catch {
      dbSizeBytes = 0;
    }

    const itemDim = Number(itemSummary ? itemSummary.max_dim : 0) || 0;
    const chunkDim = Number(chunkSummary ? chunkSummary.max_dim : 0) || 0;

    const fpItem = fpRow ? fpRow.model_fingerprint : '';
    const fpChunk = chunkFpRow ? chunkFpRow.model_fingerprint : '';

    return {
      indexedItems: Number(itemSummary ? itemSummary.total : 0) || 0,
      vectorizedItems: Number(itemSummary ? itemSummary.vec_count : 0) || 0,
      indexedChunks: Number(chunkSummary ? chunkSummary.total : 0) || 0,
      vectorizedChunks: Number(chunkSummary ? chunkSummary.vec_count : 0) || 0,
      indexedAttachments: Number(attCount) || 0,
      modelFingerprint: String(fpItem || fpChunk || ''),
      dimensions: itemDim || chunkDim || 0,
      dbSizeBytes,
      lastIndexedAt: Number(lastIndexedAtStr) || 0,
    };
  }

  async exportCompatBundle(params: {
    engine: string;
    model: string;
    modelFingerprint: string;
    dimension: number;
  }) {
    const { items, chunks } = await this.loadAll();
    const createdAt = (await this.getMeta('created_at')) || undefined;
    return serializeVectorStoreJson({
      items,
      chunks,
      engine: params.engine,
      model: params.model,
      modelFingerprint: params.modelFingerprint,
      dimension: params.dimension,
      createdAt,
    });
  }

  async importCompatBundle(
    input: { metadataJson?: any; fulltextJson?: any; storeMetaJson?: any },
    resolveItemIDByKey: (
      itemKey: string,
      fallbackID?: number
    ) => { itemID: number; libraryID: number; itemKey?: string } | null,
    resolveAttachmentIDByKey?: (
      attachmentKey: string,
      parentItemID: number,
      fallbackAttachmentID?: number
    ) => number | { attachmentID: number; attachmentKey?: string }
  ) {
    const parsed = parseVectorStoreJson(input, resolveItemIDByKey, resolveAttachmentIDByKey);
    await this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      await conn.executeTransaction(async () => {
        for (const item of parsed.items) {
          const { blob, dim } = this.encodeVectorBlob(item.vector);
          await conn.queryAsync(
            `INSERT OR REPLACE INTO item_vectors (
              item_id, item_key, library_id, item_type, title, creators, year,
              publication_title, doi, url, tags_json, abstract_note, metadata_hash,
              vector, dim, model_fingerprint, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              item.itemID,
              item.itemKey,
              item.libraryID,
              item.itemType,
              item.title,
              item.creators,
              item.year,
              item.publicationTitle,
              item.doi,
              item.url,
              JSON.stringify(item.tags ?? []),
              item.abstractNote,
              item.metadataHash,
              blob,
              dim,
              item.modelFingerprint,
              item.updatedAt || Date.now(),
            ],
            { debugParams: false, noParseParams: true }
          );
        }

        const grouped = new Map<number, IndexedChunkRecord[]>();
        for (const c of parsed.chunks) {
          const list = grouped.get(c.itemID) ?? [];
          list.push(c);
          grouped.set(c.itemID, list);
        }
        for (const [parentID, list] of grouped.entries()) {
          await conn.queryAsync('DELETE FROM fulltext_chunks WHERE item_id = ?', [parentID]);
          for (const chunk of list) {
            const { blob, dim } = this.encodeVectorBlob(chunk.vector);
            await conn.queryAsync(
              `INSERT OR REPLACE INTO fulltext_chunks (
                chunk_id, item_id, item_key, attachment_id, attachment_key, attachment_title,
                chunk_index, page_index, page_label, char_start, char_end, text, snippet,
                vector, dim, model_fingerprint, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                chunk.chunkId,
                chunk.itemID,
                chunk.itemKey,
                chunk.attachmentID,
                chunk.attachmentKey,
                chunk.attachmentTitle,
                chunk.chunkIndex,
                chunk.pageIndex,
                chunk.pageLabel,
                chunk.charStart,
                chunk.charEnd,
                chunk.text,
                chunk.snippet,
                blob,
                dim,
                chunk.modelFingerprint,
                chunk.updatedAt || Date.now(),
              ],
              { debugParams: false, noParseParams: true }
            );
          }
        }

        await conn.queryAsync(
          'INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)',
          ['last_indexed_at', String(Date.now())]
        );
      });
    });
    return parsed;
  }
}
