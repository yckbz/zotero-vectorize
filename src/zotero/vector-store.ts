import type {
  AttachmentStateRecord,
  EngineHealthStatus,
  IndexedChunkRecord,
  IndexedItemRecord,
  StoreStats,
} from '../types/vectorize.ts';
import type { ZoteroDBConnectionInstance } from '../types/zotero.d.ts';
import { bytesToFloat32, float32ToBytes, isFiniteVector } from '../core/math.ts';
import { type CompatItemResolver, parseVectorStoreJson, serializeVectorStoreJson } from '../core/compat-json.ts';
import { buildModelFingerprint } from '../core/hash.ts';
import { legacyProfile, type EmbeddingProfile, type EmbeddingProfileStats } from './embedding-profile.ts';
import { VectorSearchIndex } from '../core/search-engine.ts';

const SCHEMA_VERSION = '3';
const COMPACT_LAYOUT_VERSION = '1';
const MIN_RECLAIM_BYTES = 16 * 1024 * 1024;
const APPLICATION_ID = 0x5a564958;
const ITEM_COLUMNS = [
  'item_id', 'item_key', 'library_id', 'item_type', 'title', 'creators', 'year', 'publication_title',
  'doi', 'url', 'tags_json', 'abstract_note', 'metadata_hash', 'updated_at',
];
const CHUNK_COLUMNS = [
  'chunk_id', 'item_id', 'item_key', 'attachment_id', 'attachment_key', 'attachment_title', 'chunk_index',
  'page_index', 'page_label', 'char_start', 'char_end', 'text', 'snippet', 'updated_at',
];
const ATTACHMENT_COLUMNS = [
  'attachment_id', 'attachment_key', 'parent_item_id', 'file_hash', 'mtime', 'status', 'chunk_count',
  'error_message', 'updated_at', 'chunking_key',
];
const SNAPSHOT_COLUMNS = {
  store_meta: ['key', 'value'],
  embedding_profiles: ['id', 'engine', 'model', 'dim', 'provenance'],
  item_vectors: ITEM_COLUMNS,
  fulltext_chunks: CHUNK_COLUMNS,
  attachment_state: ATTACHMENT_COLUMNS,
  metadata_embeddings: ['profile_id', 'item_id', 'vector'],
  passage_embeddings: ['profile_id', 'chunk_id', 'vector'],
  attachment_embeddings: ['profile_id', 'attachment_id', 'status', 'error_message'],
};

async function upsert(conn: ZoteroDBConnectionInstance, table: string, columns: string[], key: string[], values: unknown[]) {
  const assignments = columns.filter((column) => !key.includes(column)).map((column) => `${column} = excluded.${column}`);
  await conn.queryAsync(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${assignments.join(', ')}`,
    values, { noParseParams: true, debugParams: false }
  );
}

export class VectorStore {
  private readonly storeDir: string;
  private readonly dbPath: string;
  private readonly staged: boolean;
  private db: ZoteroDBConnectionInstance | null = null;
  private openPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly writeListeners = new Set<() => void>();
  private closed = false;
  private profile: EmbeddingProfile | null = null;

  get activeProfile(): EmbeddingProfile | null { return this.profile; }

  constructor(dataDir: string, stagedDb?: string) {
    this.storeDir = stagedDb ? PathUtils.parent(stagedDb) : PathUtils.join(dataDir, 'zotero-vectorize');
    this.dbPath = stagedDb ?? PathUtils.join(this.storeDir, 'vectorize.sqlite');
    this.staged = Boolean(stagedDb);
  }

  getStoreDir(): string {
    return this.storeDir;
  }

  getDbPath(): string {
    return this.dbPath;
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn).then((result) => {
      for (const listener of this.writeListeners) {
        try {
          listener();
        } catch {
          // A UI observer cannot fail a committed write.
        }
      }
      return result;
    });
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  subscribeWrites(listener: () => void): () => void {
    this.writeListeners.add(listener);
    return () => { this.writeListeners.delete(listener); };
  }

  async open(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    if (this.db && !this.db.closed) return;

    this.openPromise = (async () => {
      this.closed = false;
      await IOUtils.makeDirectory(this.storeDir, { ignoreExisting: true, createAncestors: true });
      const conn = new Zotero.DBConnection(this.dbPath);
      this.db = conn;

      await conn.queryAsync('PRAGMA journal_mode = WAL');
      await conn.queryAsync('PRAGMA synchronous = NORMAL');
      await conn.queryAsync('PRAGMA temp_store = MEMORY');
      await conn.queryAsync('PRAGMA foreign_keys = ON');
      await conn.queryAsync('PRAGMA trusted_schema = OFF');

      let needsCompaction = false;
      await conn.executeTransaction(async () => {
        await conn.queryAsync(`CREATE TABLE IF NOT EXISTS store_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
        const version = await conn.valueQueryAsync<string>("SELECT value FROM store_meta WHERE key = 'schema_version'");
        if (version && !['1', '2', SCHEMA_VERSION].includes(version)) {
          throw new Error('Unsupported Zotero Vectorize index schema: ' + version);
        }
        const layout = await conn.valueQueryAsync<string>("SELECT value FROM store_meta WHERE key = 'compact_layout'");
        needsCompaction = Boolean(version && layout !== COMPACT_LAYOUT_VERSION);
        if (!version) await this.recordCompactLayout(conn);
        await conn.queryAsync(`CREATE TABLE IF NOT EXISTS item_vectors (
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
            updated_at INTEGER NOT NULL
          )
        `);
        await conn.queryAsync(`CREATE INDEX IF NOT EXISTS idx_item_vectors_key ON item_vectors(item_key)
        `);
        await conn.queryAsync(`CREATE TABLE IF NOT EXISTS fulltext_chunks (
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
            updated_at INTEGER NOT NULL
          )
        `);
        await conn.queryAsync(`CREATE INDEX IF NOT EXISTS idx_chunks_item ON fulltext_chunks(item_id)
        `);
        await conn.queryAsync(`CREATE INDEX IF NOT EXISTS idx_chunks_attachment_order
          ON fulltext_chunks(attachment_id, chunk_index, chunk_id)`);
        await conn.queryAsync('DROP INDEX IF EXISTS idx_chunks_attachment');
        await conn.queryAsync(`CREATE TABLE IF NOT EXISTS attachment_state (
            attachment_id INTEGER PRIMARY KEY,
            attachment_key TEXT NOT NULL,
            parent_item_id INTEGER NOT NULL,
            file_hash TEXT NOT NULL DEFAULT '',
            mtime INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'indexed',
            chunk_count INTEGER NOT NULL DEFAULT 0,
            error_message TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            chunking_key TEXT NOT NULL DEFAULT ''
          )
        `);
        const attachmentColumns = await conn.queryAsync<{ name: string }>('PRAGMA table_info(attachment_state)');
        if (!attachmentColumns.some((column) => column.name === 'chunking_key')) {
          await conn.queryAsync("ALTER TABLE attachment_state ADD COLUMN chunking_key TEXT NOT NULL DEFAULT ''");
        }
        await this.createEmbeddingTables(conn);
        await this.migrateVectors(conn);
        await this.requireIndexColumns(conn, 'main');
        await conn.queryAsync(`PRAGMA application_id = ${APPLICATION_ID}`);
        await conn.queryAsync(
          `INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)`,
          ['schema_version', SCHEMA_VERSION]
        );
        await conn.queryAsync(
          `INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, ?)`,
          ['created_at', new Date().toISOString()]
        );
      });
      if (!this.staged && needsCompaction) await this.maintainStorage(conn, true);
    })().catch(async (error) => {
      const conn = this.db;
      this.db = null;
      await conn?.closeDatabase(true).catch(() => {});
      throw error;
    }).finally(() => {
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

  private async createEmbeddingTables(conn: ZoteroDBConnectionInstance): Promise<void> {
    await conn.queryAsync(`CREATE TABLE IF NOT EXISTS embedding_profiles (
        id TEXT PRIMARY KEY, engine TEXT NOT NULL, model TEXT NOT NULL,
        dim INTEGER NOT NULL CHECK (dim >= 0), provenance TEXT NOT NULL CHECK (provenance IN ('verified', 'legacy'))
      )
    `);
    await conn.queryAsync(`CREATE TABLE IF NOT EXISTS metadata_embeddings (
        profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES item_vectors(item_id) ON DELETE CASCADE,
        vector BLOB NOT NULL, PRIMARY KEY (profile_id, item_id)
      )
    `);
    await conn.queryAsync(`CREATE TABLE IF NOT EXISTS passage_embeddings (
        profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES fulltext_chunks(chunk_id) ON DELETE CASCADE,
        vector BLOB NOT NULL, PRIMARY KEY (profile_id, chunk_id)
      )
    `);
    await conn.queryAsync(`CREATE TABLE IF NOT EXISTS attachment_embeddings (
        profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,
        attachment_id INTEGER NOT NULL REFERENCES attachment_state(attachment_id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('indexed', 'pending', 'error')), error_message TEXT NOT NULL,
        PRIMARY KEY (profile_id, attachment_id)
      )
    `);
    await conn.queryAsync('CREATE INDEX IF NOT EXISTS idx_metadata_item ON metadata_embeddings(item_id)');
    await conn.queryAsync('CREATE INDEX IF NOT EXISTS idx_passage_chunk ON passage_embeddings(chunk_id)');
    await conn.queryAsync('CREATE INDEX IF NOT EXISTS idx_embedding_attachment ON attachment_embeddings(attachment_id)');
  }

  private async migrateVectors(conn: ZoteroDBConnectionInstance): Promise<void> {
    for (const [source, target, key] of [
      ['item_vectors', 'metadata_embeddings', 'item_id'],
      ['fulltext_chunks', 'passage_embeddings', 'chunk_id'],
    ]) {
      const columns = await conn.queryAsync<{ name: string }>(`PRAGMA table_info(${source})`);
      const legacyColumns = ['vector', 'dim', 'model_fingerprint'];
      const legacyCount = legacyColumns.filter((name) => columns.some((column) => column.name === name)).length;
      if (legacyCount === 0) continue;
      if (legacyCount !== legacyColumns.length) throw new Error(`Incomplete legacy vector columns in ${source}`);
      const groups = await conn.queryAsync<{ model_fingerprint: string; dim: number }>(
        `SELECT DISTINCT model_fingerprint, dim FROM ${source}
         WHERE vector IS NOT NULL AND dim > 0 AND length(vector) = dim * 4`
      );
      for (const group of groups) {
        const fingerprint = group.model_fingerprint;
        const label = fingerprint || 'imported:unknown';
        const profile = legacyProfile(label + (label.endsWith(':' + group.dim) ? '' : ':' + group.dim));
        await this.ensureProfile(conn, { ...profile, dimensions: group.dim });
        await conn.queryAsync(
          `INSERT INTO ${target} (profile_id, ${key}, vector)
           SELECT ?, ${key}, vector FROM ${source}
           WHERE model_fingerprint = ? AND dim = ? AND length(vector) = dim * 4`,
          [profile.id, fingerprint, group.dim]
        );
      }
      for (const column of legacyColumns) {
        await conn.queryAsync(`ALTER TABLE ${source} DROP COLUMN ${column}`);
      }
    }
    const attachmentColumns = await conn.queryAsync<{ name: string }>('PRAGMA table_info(attachment_state)');
    if (attachmentColumns.some((column) => column.name === 'model_fingerprint')) {
      await conn.queryAsync("UPDATE attachment_state SET status = 'indexed', error_message = '' WHERE chunk_count > 0 AND status IN ('pending', 'error')");
      await conn.queryAsync('ALTER TABLE attachment_state DROP COLUMN model_fingerprint');
    }
  }

  private async requireIndexColumns(conn: ZoteroDBConnectionInstance, schema: 'main' | 'snapshot'): Promise<void> {
    for (const [table, required] of Object.entries(SNAPSHOT_COLUMNS)) {
      const columns = await conn.queryAsync<{ name: string }>(`PRAGMA ${schema}.table_info(${table})`);
      const missing = required.filter((name) => !columns.some((column) => column.name === name));
      if (missing.length) throw new Error(`Invalid Zotero Vectorize index schema. ${table} is missing ${missing.join(', ')}.`);
    }
  }

  private async ensureProfile(conn: ZoteroDBConnectionInstance, profile: EmbeddingProfile): Promise<void> {
    await conn.queryAsync(
      'INSERT OR IGNORE INTO embedding_profiles (id, engine, model, dim, provenance) VALUES (?, ?, ?, ?, ?)',
      [profile.id, profile.engine, profile.model, profile.dimensions, profile.provenance]
    );
    if (profile.dimensions > 0) {
      await conn.queryAsync('UPDATE embedding_profiles SET dim = ? WHERE id = ? AND dim = 0', [profile.dimensions, profile.id]);
      const dim = await conn.valueQueryAsync<number>('SELECT dim FROM embedding_profiles WHERE id = ?', [profile.id]);
      if (dim !== profile.dimensions) throw new Error('Embedding model dimensions changed');
    }
  }

  async activateProfile(profile: EmbeddingProfile | null, discardId?: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      await conn.executeTransaction(async () => {
        if (profile) await this.ensureProfile(conn, profile);
        if (discardId && discardId !== profile?.id) {
          await conn.queryAsync('DELETE FROM embedding_profiles WHERE id = ?', [discardId]);
        }
      });
      this.profile = profile;
      if (discardId && discardId !== profile?.id) await this.maintainStorage(conn);
    });
  }

  async listProfiles(): Promise<EmbeddingProfileStats[]> {
    const conn = await this.ensureConn();
    const rows = await conn.queryAsync<{
      id: string; engine: string; model: string; dim: number;
      provenance: EmbeddingProfile['provenance']; items: number; chunks: number;
    }>(`SELECT p.*, (SELECT COUNT(*) FROM metadata_embeddings WHERE profile_id = p.id) AS items,
        (SELECT COUNT(*) FROM passage_embeddings WHERE profile_id = p.id) AS chunks
      FROM embedding_profiles p ORDER BY p.engine, p.model, p.id
    `);
    return rows.filter((row) => row.items || row.chunks || row.id === this.profile?.id).map((row) => ({
      id: row.id, engine: row.engine, model: row.model, dimensions: row.dim,
      provenance: row.provenance, items: row.items, chunks: row.chunks, active: row.id === this.profile?.id,
    }));
  }

  async deleteProfile(id: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      await conn.executeTransaction(async () => {
        await conn.queryAsync('DELETE FROM embedding_profiles WHERE id = ?', [id]);
        if (id === this.profile?.id) {
          await this.ensureProfile(conn, { ...this.profile, dimensions: 0 });
        }
      });
      await this.maintainStorage(conn);
    });
  }

  async reuseLegacyProfile(id: string, activeID: string, dimensions: number): Promise<void> {
    const active = this.profile;
    if (!active || active.id !== activeID) throw new Error('The active model changed');
    await this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      await conn.executeTransaction(async () => {
        const legacy = await conn.rowQueryAsync<{ engine: string; model: string; dim: number; provenance: string }>(
          'SELECT engine, model, dim, provenance FROM embedding_profiles WHERE id = ?', [id]
        );
        if (!legacy || legacy.provenance !== 'legacy' || legacy.engine !== active.engine ||
            legacy.model !== active.model || legacy.dim !== dimensions) {
          throw new Error('The legacy index does not match the active model name, engine and dimensions');
        }
        await this.ensureProfile(conn, { ...active, dimensions });
        for (const table of ['metadata_embeddings', 'passage_embeddings']) {
          // Move the existing rows. On a key conflict the active vector wins,
          // and deleting the legacy profile removes the remaining duplicates.
          await conn.queryAsync(`UPDATE OR IGNORE ${table} SET profile_id = ? WHERE profile_id = ?`, [active.id, id]);
        }
        await conn.queryAsync('DELETE FROM embedding_profiles WHERE id = ?', [id]);
        await this.touch(conn);
      });
      await this.maintainStorage(conn);
    });
  }

  private async recordCompactLayout(conn: ZoteroDBConnectionInstance): Promise<void> {
    await conn.queryAsync('INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)',
      ['compact_layout', COMPACT_LAYOUT_VERSION]);
  }

  private async maintainStorage(conn: ZoteroDBConnectionInstance, repackLayout = false): Promise<void> {
    try {
      const freePages = await conn.valueQueryAsync<number>('PRAGMA freelist_count');
      const pageSize = await conn.valueQueryAsync<number>('PRAGMA page_size');
      const pages = await conn.valueQueryAsync<number>('PRAGMA page_count');
      if (repackLayout || (freePages * pageSize >= MIN_RECLAIM_BYTES && freePages * 4 >= pages)) {
        // Bulk imports and upgrades can leave partially filled pages as well as a freelist.
        // Pack both in a SQLite transaction and truncate the resulting WAL.
        await conn.queryAsync('PRAGMA wal_checkpoint(TRUNCATE)');
        await conn.queryAsync('VACUUM', [], { noCache: true });
        await this.recordCompactLayout(conn);
      }
      await conn.queryAsync('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      // A failed compaction does not undo the already committed index changes.
      Zotero.logError(error);
    }
  }

  private async touch(conn: ZoteroDBConnectionInstance): Promise<void> {
    await conn.queryAsync('INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)',
      ['last_indexed_at', String(Date.now())]);
  }

  private async saveVector(
    conn: ZoteroDBConnectionInstance, profile: EmbeddingProfile | null, table: 'metadata_embeddings' | 'passage_embeddings',
    key: 'item_id' | 'chunk_id', id: number | string, vector: Float32Array | null
  ): Promise<void> {
    if (!profile || !vector) return;
    if (!vector.length || !isFiniteVector(vector)) throw new Error('Invalid embedding vector');
    if (profile.dimensions && vector.length !== profile.dimensions) throw new Error('Embedding model dimensions changed');
    await upsert(conn, table, ['profile_id', key, 'vector'], ['profile_id', key],
      [profile.id, id, float32ToBytes(vector)]);
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

  async loadAll(profileId = this.profile?.id ?? '', libraryID?: number): Promise<{ items: IndexedItemRecord[]; chunks: IndexedChunkRecord[] }> {
    const conn = await this.ensureConn();
    const itemRows = await conn.queryAsync<Record<string, any>>(
      `SELECT i.*, e.vector, p.dim, p.engine, p.model FROM item_vectors i
       LEFT JOIN metadata_embeddings e ON e.item_id = i.item_id AND e.profile_id = ?
       LEFT JOIN embedding_profiles p ON p.id = e.profile_id
       ${libraryID === undefined ? '' : 'WHERE i.library_id = ?'}`,
      libraryID === undefined ? [profileId] : [profileId, libraryID]
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
        modelFingerprint: vector ? buildModelFingerprint(row.engine, row.model, dim) : '',
        updatedAt: Number(row.updated_at) || 0,
      });
    }

    return { items, chunks: await this.readChunks(conn, profileId, undefined, libraryID) };
  }

  private async readChunks(conn: ZoteroDBConnectionInstance, profileId: string, itemID?: number, libraryID?: number): Promise<IndexedChunkRecord[]> {
    const chunkRows = await conn.queryAsync<Record<string, any>>(
      `SELECT c.*, e.vector, p.dim, p.engine, p.model FROM fulltext_chunks c
       LEFT JOIN passage_embeddings e ON e.chunk_id = c.chunk_id AND e.profile_id = ?
       LEFT JOIN embedding_profiles p ON p.id = e.profile_id
       ${itemID !== undefined ? 'WHERE c.item_id = ?' : libraryID !== undefined
         ? 'WHERE c.item_id IN (SELECT item_id FROM item_vectors WHERE library_id = ?)' : ''}
       ORDER BY c.attachment_id, c.chunk_index`,
      itemID === undefined && libraryID === undefined ? [profileId] : [profileId, itemID ?? libraryID]
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
        modelFingerprint: vector ? buildModelFingerprint(row.engine, row.model, dim) : '',
        updatedAt: Number(row.updated_at) || 0,
      });
    }

    return chunks;
  }

  async loadIntoSearchIndex(index: VectorSearchIndex): Promise<{ items: number; chunks: number }> {
    const { items, chunks } = await this.loadAll();
    index.loadAll(items, chunks);
    return { items: items.length, chunks: chunks.length };
  }

  async getItemSyncInfo(itemID: number): Promise<{ metadataHash: string; modelFingerprint: string; hasVector: boolean } | null> {
    const conn = await this.ensureConn();
    const row = await conn.rowQueryAsync<Record<string, any>>(
      `SELECT i.metadata_hash, p.engine, p.model, p.dim FROM item_vectors i
       LEFT JOIN metadata_embeddings e ON e.item_id = i.item_id AND e.profile_id = ?
       LEFT JOIN embedding_profiles p ON p.id = e.profile_id WHERE i.item_id = ?`,
      [this.profile?.id ?? '', itemID]
    );
    if (!row) return null;
    return {
      metadataHash: String(row.metadata_hash || ''),
      modelFingerprint: row.dim ? buildModelFingerprint(row.engine, row.model, Number(row.dim)) : '',
      hasVector: Number(row.dim) > 0,
    };
  }

  async getAttachmentState(attachmentID: number): Promise<AttachmentStateRecord | null> {
    const conn = await this.ensureConn();
    const row = await conn.rowQueryAsync<Record<string, any>>(
      `SELECT a.*, e.status AS embedding_status, e.error_message AS embedding_error, p.engine, p.model, p.dim
       FROM attachment_state a
       LEFT JOIN attachment_embeddings e ON e.attachment_id = a.attachment_id AND e.profile_id = ?
       LEFT JOIN embedding_profiles p ON p.id = e.profile_id WHERE a.attachment_id = ?`,
      [this.profile?.id ?? '', attachmentID]
    );
    if (!row) return null;
    return {
      attachmentID: Number(row.attachment_id),
      attachmentKey: String(row.attachment_key || ''),
      parentItemID: Number(row.parent_item_id),
      fileHash: String(row.file_hash || ''),
      mtime: Number(row.mtime) || 0,
      chunkingKey: String(row.chunking_key || ''),
      status: (row.embedding_status || row.status) as AttachmentStateRecord['status'],
      chunkCount: Number(row.chunk_count) || 0,
      modelFingerprint: row.dim ? buildModelFingerprint(row.engine, row.model, Number(row.dim)) : '',
      errorMessage: row.embedding_error || row.error_message || undefined,
      updatedAt: Number(row.updated_at) || 0,
    };
  }

  async upsertItems(records: IndexedItemRecord[]): Promise<void> {
    if (!records.length) return;
    const profile = this.profile;
    await this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      await conn.executeTransaction(async () => {
        const dim = records.find((row) => row.vector)?.vector?.length;
        if (profile && dim) await this.ensureProfile(conn, { ...profile, dimensions: dim });
        for (const record of records) await this.writeItem(conn, record, profile && dim ? { ...profile, dimensions: dim } : profile);
        await this.touch(conn);
      });
    });
  }

  private async writeItem(conn: ZoteroDBConnectionInstance, record: IndexedItemRecord, profile: EmbeddingProfile | null): Promise<void> {
    const existing = await conn.rowQueryAsync<{ metadata_hash: string; item_key: string; library_id: number }>(
      'SELECT metadata_hash, item_key, library_id FROM item_vectors WHERE item_id = ?', [record.itemID]
    );
    if (existing && (existing.metadata_hash !== record.metadataHash ||
        existing.item_key !== record.itemKey || existing.library_id !== record.libraryID)) {
      await conn.queryAsync('DELETE FROM metadata_embeddings WHERE item_id = ?', [record.itemID]);
    }
    await upsert(conn, 'item_vectors', ITEM_COLUMNS, ['item_id'], [
      record.itemID, record.itemKey, record.libraryID, record.itemType, record.title,
      record.creators, record.year, record.publicationTitle, record.doi, record.url,
      JSON.stringify(record.tags), record.abstractNote, record.metadataHash, record.updatedAt,
    ]);
    await this.saveVector(conn, profile, 'metadata_embeddings', 'item_id', record.itemID, record.vector);
  }

  private async writeChunk(conn: ZoteroDBConnectionInstance, chunk: IndexedChunkRecord, profile: EmbeddingProfile | null): Promise<void> {
    await upsert(conn, 'fulltext_chunks', CHUNK_COLUMNS, ['chunk_id'], [
      chunk.chunkId, chunk.itemID, chunk.itemKey, chunk.attachmentID, chunk.attachmentKey,
      chunk.attachmentTitle, chunk.chunkIndex, chunk.pageIndex, chunk.pageLabel, chunk.charStart,
      chunk.charEnd, chunk.text, chunk.snippet, chunk.updatedAt,
    ]);
    await this.saveVector(conn, profile, 'passage_embeddings', 'chunk_id', chunk.chunkId, chunk.vector);
  }

  async saveAttachmentChunksAndState(
    chunks: IndexedChunkRecord[],
    state: AttachmentStateRecord,
    mode: 'replace' | 'checkpoint',
    force = false
  ): Promise<number[] | null> {
    const profile = this.profile;
    return this.enqueueWrite(async () => {
      const conn = await this.ensureConn();
      const { attachmentID, parentItemID } = state;
      const previousParents = new Set<number>();
      let written = false;
      await conn.executeTransaction(async () => {
        if (mode === 'checkpoint') {
          const current = await this.getAttachmentState(attachmentID);
          if (!current || current.parentItemID !== parentItemID || current.attachmentKey !== state.attachmentKey ||
              current.fileHash !== state.fileHash || current.mtime !== state.mtime ||
              current.chunkingKey !== state.chunkingKey) return;
        } else {
          const old = await conn.queryAsync<{ chunk_id: string; item_id: number; text: string }>(
            `SELECT chunk_id, item_id, text FROM fulltext_chunks WHERE attachment_id = ?
             OR (item_id = ? AND attachment_key = ?)`, [attachmentID, parentItemID, state.attachmentKey]
          );
          const next = new Map(chunks.map((chunk) => [chunk.chunkId, chunk.text]));
          for (const row of old) {
            if (row.item_id !== parentItemID) previousParents.add(row.item_id);
            if (next.get(row.chunk_id) !== row.text || row.item_id !== parentItemID) {
              await conn.queryAsync('DELETE FROM fulltext_chunks WHERE chunk_id = ?', [row.chunk_id]);
            } else if (force && profile) {
              await conn.queryAsync('DELETE FROM passage_embeddings WHERE profile_id = ? AND chunk_id = ?', [profile.id, row.chunk_id]);
            }
          }
          await conn.queryAsync('DELETE FROM attachment_embeddings WHERE attachment_id = ?', [attachmentID]);
          await upsert(conn, 'attachment_state', ATTACHMENT_COLUMNS, ['attachment_id'], [
            attachmentID, state.attachmentKey, parentItemID, state.fileHash, state.mtime,
            state.status === 'pending' ? 'indexed' : state.status, state.chunkCount, state.errorMessage || '',
            state.updatedAt, state.chunkingKey,
          ]);
        }

        const dim = chunks.find((chunk) => chunk.vector)?.vector?.length;
        if (profile && dim) await this.ensureProfile(conn, { ...profile, dimensions: dim });
        const target = profile && dim ? { ...profile, dimensions: dim } : profile;
        for (const chunk of chunks) {
          if (mode === 'replace') await this.writeChunk(conn, chunk, target);
          else await this.saveVector(conn, target, 'passage_embeddings', 'chunk_id', chunk.chunkId, chunk.vector);
        }
        if (profile && state.chunkCount > 0 && ['indexed', 'pending', 'error'].includes(state.status)) {
          await upsert(conn, 'attachment_embeddings', SNAPSHOT_COLUMNS.attachment_embeddings,
            ['profile_id', 'attachment_id'], [profile.id, attachmentID, state.status, state.errorMessage || '']);
        }
        await this.touch(conn);
        written = true;
      });
      return written ? [...previousParents] : null;
    });
  }

  async getChunksForItem(itemID: number): Promise<IndexedChunkRecord[]> {
    return this.readChunks(await this.ensureConn(), this.profile?.id ?? '', itemID);
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

  async getStoredAttachmentIDs(): Promise<number[]> {
    const conn = await this.ensureConn();
    const rows = await conn.queryAsync<{ attachment_id: number }>('SELECT attachment_id FROM attachment_state');
    return rows.map((row) => Number(row.attachment_id));
  }

  async getShareableAttachments(libraryID: number, chunkingKey: string): Promise<Array<{
    attachmentID: number; attachmentKey: string; parentItemID: number; fileHash: string;
  }>> {
    const conn = await this.ensureConn();
    const rows = await conn.queryAsync(`SELECT a.attachment_id, a.attachment_key, a.parent_item_id, a.file_hash
      FROM attachment_state a JOIN item_vectors i ON i.item_id = a.parent_item_id
      WHERE i.library_id = ? AND a.chunking_key = ? AND a.status = 'indexed' AND a.chunk_count > 0`,
    [libraryID, chunkingKey]);
    return rows.map((row) => ({ attachmentID: Number(row.attachment_id), attachmentKey: String(row.attachment_key),
      parentItemID: Number(row.parent_item_id), fileHash: String(row.file_hash) }));
  }

  async sharedDimensions(profileId: string): Promise<number> {
    const conn = await this.ensureConn();
    return Number(await conn.valueQueryAsync('SELECT dim FROM embedding_profiles WHERE id = ?', [profileId])) || 0;
  }

  async *sharedItems(profileId: string, libraryID: number, dimensions: number) {
    const conn = await this.ensureConn();
    let key = '';
    let id = 0;
    for (;;) {
      const rows = await conn.queryAsync<{
        item_key: string; item_id: number; metadata_hash: string; vector: unknown;
      }>(`SELECT i.item_key, i.item_id, i.metadata_hash, e.vector FROM item_vectors i
        LEFT JOIN metadata_embeddings e ON e.item_id = i.item_id AND e.profile_id = ?
        WHERE i.library_id = ? AND (i.item_key, i.item_id) > (?, ?)
        ORDER BY i.item_key, i.item_id LIMIT 128`, [profileId, libraryID, key, id]);
      for (const row of rows) {
        key = row.item_key;
        id = row.item_id;
        yield { id, key, metadataHash: row.metadata_hash, vector: this.decodeVectorBlob(row.vector, dimensions) };
      }
      if (rows.length < 128) return;
    }
  }

  async *sharedPassages(profileId: string, dimensions: number, attachment: {
    attachmentID: number; attachmentKey: string; parentItemID: number;
  }, maxPdfPages: number) {
    const conn = await this.ensureConn();
    let index = -1;
    let id = '';
    for (;;) {
      const rows = await conn.queryAsync<{
        chunk_id: string; chunk_index: number; page_index: number; page_label: string;
        char_start: number; char_end: number; text: string; vector: unknown;
      }>(`SELECT c.chunk_id, c.chunk_index, c.page_index, c.page_label, c.char_start, c.char_end, c.text, e.vector
        FROM fulltext_chunks c LEFT JOIN passage_embeddings e ON e.chunk_id = c.chunk_id AND e.profile_id = ?
        WHERE c.attachment_id = ? AND c.attachment_key = ? AND c.item_id = ?
          AND (c.chunk_index, c.chunk_id) > (?, ?) AND (? = 0 OR c.page_index < ?)
        ORDER BY c.chunk_index, c.chunk_id LIMIT 128`,
      [profileId, attachment.attachmentID, attachment.attachmentKey, attachment.parentItemID, index, id, maxPdfPages, maxPdfPages]);
      for (const row of rows) {
        index = row.chunk_index;
        id = row.chunk_id;
        yield { index, pageIndex: row.page_index, pageLabel: row.page_label || String(row.page_index + 1),
          charStart: row.char_start, charEnd: row.char_end, text: row.text,
          vector: this.decodeVectorBlob(row.vector, dimensions) };
      }
      if (rows.length < 128) return;
    }
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
        await conn.queryAsync('DELETE FROM embedding_profiles');
        if (this.profile) await this.ensureProfile(conn, { ...this.profile, dimensions: 0 });
        await conn.queryAsync('DELETE FROM item_vectors');
        await conn.queryAsync('DELETE FROM fulltext_chunks');
        await conn.queryAsync('DELETE FROM attachment_state');
        await conn.queryAsync('DELETE FROM store_meta WHERE key != ?', ['created_at']);
        await conn.queryAsync(
          'INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)',
          ['schema_version', SCHEMA_VERSION]
        );
      });
      await this.maintainStorage(conn, true);
    });
  }

  async getStats(activeModel?: Pick<EngineHealthStatus, 'modelFingerprint' | 'dimensions'>): Promise<StoreStats> {
    const conn = await this.ensureConn();
    const profile = this.profile;
    const active = profile && await conn.rowQueryAsync<{ engine: string; model: string; dim: number }>(
      'SELECT engine, model, dim FROM embedding_profiles WHERE id = ?', [profile.id]
    );
    const id = profile?.id ?? '';
    const dimensions = active ? active.dim : 0;
    const modelFingerprint = active ? buildModelFingerprint(active.engine, active.model, active.dim) : '';
    const useVectors = !activeModel || (active ? (activeModel.dimensions > 0
      ? modelFingerprint === activeModel.modelFingerprint
      : buildModelFingerprint(active.engine, active.model) === activeModel.modelFingerprint) : false);
    const count = async (table: string, profileID?: string): Promise<number> => Number(await conn.valueQueryAsync(
      'SELECT COUNT(*) FROM ' + table + (profileID === undefined ? '' : ' WHERE profile_id = ?'),
      profileID === undefined ? [] : [profileID]
    ));
    const attachments = await conn.rowQueryAsync<Record<string, number>>(
      `SELECT COUNT(*) AS total,
          SUM(COALESCE(e.status, a.status) = 'error') AS failed,
          SUM(e.status = 'pending' OR (e.status IS NULL AND ? != '' AND a.status = 'indexed')) AS pending,
          SUM(a.status = 'missing') AS missing, SUM(a.status = 'no_text') AS no_text
       FROM attachment_state a LEFT JOIN attachment_embeddings e ON e.attachment_id = a.attachment_id AND e.profile_id = ?`,
      [id, id]
    );
    let dbSizeBytes = 0;
    for (const path of [this.dbPath, this.dbPath + '-wal']) {
      if (await IOUtils.exists(path)) {
        dbSizeBytes += await IOUtils.stat(path).then((result) => result.size, () => 0);
      }
    }
    return {
      indexedItems: await count('item_vectors'),
      vectorizedItems: useVectors ? await count('metadata_embeddings', id) : 0,
      indexedChunks: await count('fulltext_chunks'),
      vectorizedChunks: useVectors ? await count('passage_embeddings', id) : 0,
      indexedAttachments: Number(attachments && attachments.total) || 0,
      failedAttachments: Number(attachments && attachments.failed) || 0,
      pendingAttachments: Number(attachments && attachments.pending) || 0,
      missingAttachments: Number(attachments && attachments.missing) || 0,
      noTextAttachments: Number(attachments && attachments.no_text) || 0,
      modelFingerprint, dimensions, dbSizeBytes,
      lastIndexedAt: Number(await this.getMeta('last_indexed_at')) || 0,
    };
  }

  async readCommitted<T>(read: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(read);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async verifySnapshotPath(path: string): Promise<void> {
    const reserved = [this.dbPath, this.dbPath + '-wal', this.dbPath + '-shm', this.dbPath + '-journal'];
    if (reserved.some((candidate) => candidate.toLowerCase() === path.toLowerCase())) {
      throw new Error('Select a file outside the active index');
    }
    const stat = await IOUtils.stat(path).catch(() => null);
    if (stat && stat.type !== 'regular') throw new Error('Select a regular SQLite file');
  }

  async exportSnapshot(path: string): Promise<void> {
    await this.verifySnapshotPath(path);
    const temp = path + '.tmp-' + Math.random().toString(36).slice(2);
    try {
      await this.readCommitted(async () => {
        const conn = await this.ensureConn();
        await conn.queryAsync('VACUUM INTO ?', [temp]);
      });
      await IOUtils.move(temp, path);
    } finally {
      await IOUtils.remove(temp, { ignoreAbsent: true });
    }
  }

  async restoreSnapshot(
    path: string,
    validateSources: (
      items: Array<{ item_id: number; item_key: string; library_id: number }>,
      attachments: Array<{ attachment_id: number; attachment_key: string; parent_item_id: number }>
    ) => void
  ): Promise<void> {
    await this.verifySnapshotPath(path);
    await this.ensureConn();
    const temp = PathUtils.join(this.storeDir, 'restore-' + Math.random().toString(36).slice(2) + '.sqlite');
    try {
      const wal = await IOUtils.stat(path + '-wal').catch(() => null);
      const journal = await IOUtils.stat(path + '-journal').catch(() => null);
      if (wal?.size || journal?.size) throw new Error('Close Zotero before copying or importing its index database');
      await IOUtils.copy(path, temp);
      await this.migrateImportedDatabase(temp);
      await this.enqueueWrite(async () => {
        const conn = await this.ensureConn();
        await conn.queryAsync('ATTACH DATABASE ? AS snapshot', [temp], { noCache: true });
        try {
          const id = await conn.valueQueryAsync<number>('PRAGMA snapshot.application_id');
          const version = await conn.valueQueryAsync<string>("SELECT value FROM snapshot.store_meta WHERE key = 'schema_version'");
          if (id !== APPLICATION_ID || version !== SCHEMA_VERSION ||
              await conn.valueQueryAsync('PRAGMA snapshot.integrity_check(1)') !== 'ok' ||
              (await conn.queryAsync('PRAGMA snapshot.foreign_key_check')).length) {
            throw new Error('Invalid or unsupported Zotero Vectorize snapshot');
          }
          const schema = await conn.queryAsync<{ name: string; type: string }>(
            "SELECT name, type FROM snapshot.sqlite_schema WHERE type IN ('table', 'view', 'trigger')"
          );
          if (schema.length !== Object.keys(SNAPSHOT_COLUMNS).length ||
              schema.some(({ name, type }) => type !== 'table' || !Object.hasOwn(SNAPSHOT_COLUMNS, name))) {
            throw new Error('Unexpected snapshot tables');
          }
          await this.requireIndexColumns(conn, 'snapshot');
          validateSources(
            await conn.queryAsync('SELECT item_id, item_key, library_id FROM snapshot.item_vectors'),
            await conn.queryAsync(`SELECT attachment_id, attachment_key, parent_item_id FROM snapshot.attachment_state
              UNION SELECT attachment_id, attachment_key, item_id FROM snapshot.fulltext_chunks WHERE attachment_id > 0
            `)
          );
          for (const table of ['metadata_embeddings', 'passage_embeddings']) {
            if (await conn.valueQueryAsync(`SELECT EXISTS(SELECT 1 FROM snapshot.${table} e JOIN snapshot.embedding_profiles p ON p.id = e.profile_id
                WHERE p.dim <= 0 OR typeof(e.vector) != 'blob' OR length(e.vector) != p.dim * 4)
            `)) throw new Error('Invalid vector dimensions in snapshot');
          }
          await conn.executeTransaction(async () => {
            const tables = Object.entries(SNAPSHOT_COLUMNS);
            for (const [name] of [...tables].reverse()) await conn.queryAsync('DELETE FROM ' + name);
            for (const [name, columns] of tables) {
              const fields = columns.join(', ');
              await conn.queryAsync(`INSERT INTO ${name} (${fields}) SELECT ${fields} FROM snapshot.${name}`);
            }
            if (this.profile) await this.ensureProfile(conn, { ...this.profile, dimensions: 0 });
          });
        } finally {
          await conn.queryAsync('DETACH DATABASE snapshot', [], { noCache: true });
        }
        await this.maintainStorage(conn, true);
      });
    } finally {
      for (const file of [temp, temp + '-wal', temp + '-shm', temp + '-journal']) {
        await IOUtils.remove(file, { ignoreAbsent: true }).catch((error: unknown) => Zotero.logError(error));
      }
    }
  }

  private async migrateImportedDatabase(path: string): Promise<void> {
    const conn = new Zotero.DBConnection(path);
    let legacy = false;
    try {
      await conn.queryAsync('PRAGMA trusted_schema = OFF');
      const schema = await conn.queryAsync<{ name: string; type: string }>(
        "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view', 'trigger')"
      );
      if (!schema.some(({ name, type }) => name === 'store_meta' && type === 'table')) {
        throw new Error('This file is not a Zotero Vectorize index');
      }
      const version = await conn.valueQueryAsync<string>("SELECT value FROM store_meta WHERE key = 'schema_version'");
      if (version === SCHEMA_VERSION) return;
      const tables = ['store_meta', 'item_vectors', 'fulltext_chunks', 'attachment_state'];
      if ((version !== '1' && version !== '2') || schema.length !== tables.length ||
          schema.some(({ name, type }) => type !== 'table' || !tables.includes(name)) ||
          await conn.valueQueryAsync('PRAGMA integrity_check(1)') !== 'ok') {
        throw new Error('Invalid or unsupported Zotero Vectorize index');
      }
      for (const table of ['item_vectors', 'fulltext_chunks']) {
        const columns = await conn.queryAsync<{ name: string }>(`PRAGMA table_info(${table})`);
        if (!['vector', 'dim', 'model_fingerprint'].every((name) => columns.some((entry) => entry.name === name))) {
          throw new Error('Invalid legacy index schema');
        }
      }
      legacy = true;
    } finally {
      await conn.closeDatabase(true);
    }
    if (legacy) {
      const staged = new VectorStore(this.storeDir, path);
      try {
        await staged.open();
      } finally {
        await staged.close();
      }
    }
  }

  async exportCompatBundle(profile: EmbeddingProfileStats) {
    const { items, chunks } = await this.loadAll(profile.id);
    return serializeVectorStoreJson({
      items, chunks, engine: profile.engine, model: profile.model, dimension: profile.dimensions,
      modelFingerprint: buildModelFingerprint(profile.engine, profile.model, profile.dimensions),
      profileID: profile.provenance === 'verified' ? profile.id : undefined,
      createdAt: (await this.getMeta('created_at')) || undefined,
    });
  }

  async importCompatBundle(
    input: { metadataJson?: any; fulltextJson?: any; storeMetaJson?: any },
    resolveItemIDByKey: CompatItemResolver,
    resolveAttachmentIDByKey?: (
      attachmentKey: string,
      parentItemID: number,
      fallbackAttachmentID?: number
    ) => number | { attachmentID: number; attachmentKey?: string }
  ) {
    const parsed = parseVectorStoreJson(input, resolveItemIDByKey, resolveAttachmentIDByKey);
    const active = this.profile;
    const claimedID = input.storeMetaJson?.embedding_profile_id;
    const compatible = active && parsed.engine === active.engine && parsed.model === active.model;
    const profile = compatible && claimedID === active.id
      ? { ...active, dimensions: parsed.dimension }
      : { ...legacyProfile(parsed.modelFingerprint), engine: parsed.engine, model: parsed.model, dimensions: parsed.dimension };
    let importedItems = 0;
    let importedChunks = 0;
    if (parsed.items.length || parsed.chunks.length) {
      await this.enqueueWrite(async () => {
        const conn = await this.ensureConn();
        await conn.executeTransaction(async () => {
          await this.ensureProfile(conn, profile);
          for (const item of parsed.items) {
            const current = await conn.rowQueryAsync<{ metadata_hash: string }>(
              'SELECT metadata_hash FROM item_vectors WHERE item_id = ?', [item.itemID]);
            if (!current) {
              await this.writeItem(conn, item, profile);
              importedItems++;
            } else if (current.metadata_hash === item.metadataHash) {
              await this.saveVector(conn, profile, 'metadata_embeddings', 'item_id', item.itemID, item.vector);
              importedItems++;
            } else {
              parsed.skippedItems++;
            }
          }
          for (const chunk of parsed.chunks) {
            const current = await conn.rowQueryAsync<{ chunk_id: string }>(
              `SELECT chunk_id FROM fulltext_chunks WHERE item_id = ? AND attachment_id = ?
               AND page_index = ? AND chunk_index = ? AND text = ?`,
              [chunk.itemID, chunk.attachmentID, chunk.pageIndex, chunk.chunkIndex, chunk.text]
            );
            if (current) {
              await this.saveVector(conn, profile, 'passage_embeddings', 'chunk_id', current.chunk_id, chunk.vector);
              importedChunks++;
            } else if (!await conn.valueQueryAsync('SELECT EXISTS(SELECT 1 FROM attachment_state WHERE attachment_id = ?)',
              [chunk.attachmentID])) {
              const chunkId = `${chunk.attachmentID}:${chunk.attachmentKey}#${chunk.chunkIndex}`;
              const collision = await conn.valueQueryAsync('SELECT EXISTS(SELECT 1 FROM fulltext_chunks WHERE chunk_id = ?)', [chunkId]);
              if (collision) {
                parsed.skippedChunks++;
                continue;
              }
              await this.writeChunk(conn, { ...chunk, chunkId }, profile);
              importedChunks++;
            } else {
              parsed.skippedChunks++;
            }
          }
          await this.touch(conn);
        });
      });
    }
    return { ...parsed, importedItems, importedChunks };
  }
}
