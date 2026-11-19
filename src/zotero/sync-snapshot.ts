import * as z from 'zod/mini';
import { buildSnippet } from '../core/chunker.ts';
import { buildModelFingerprint } from '../core/hash.ts';
import { bytesToFloat32, float32ToBytes, isFiniteVector } from '../core/math.ts';
import { VectorSearchIndex } from '../core/search-engine.ts';
import type { PluginConfig, IndexedItemRecord, IndexedChunkRecord } from '../types/vectorize.ts';
import type { ZoteroItem } from '../types/zotero.d.ts';
import { extractItemMetadata, isIndexableRegularItem } from './extractor.ts';

const BLOCK_SIZE = 256 * 1024;
const MAX_LINE = 64 * 1024;
export const MAX_SYNC_BYTES = 512 * 1024 * 1024;
const int = (min: number, max: number) => z.number().check(z.int(), z.gte(min), z.lte(max));
const bounded = (min: number, max: number) => z.string().check(z.minLength(min), z.maxLength(max));
const key = z.string().check(z.regex(/^[A-Z0-9]{8}$/));
const md5 = z.string().check(z.regex(/^[a-f0-9]{32}$/));
const hash = z.string().check(z.regex(/^[a-f0-9]{16}$/));
const revision = z.string().check(z.regex(/^(?:[a-f0-9]{32}:[a-f0-9]{32}|(?:sha256:)?[a-f0-9]{64})$/));
const model = z.string().check(z.regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,199}$/));
const headerFields = {
  type: z.literal('zotero-vectorize-index'), version: z.literal(1),
  account: int(1, Number.MAX_SAFE_INTEGER),
  publisher: z.string().check(z.regex(/^[a-zA-Z0-9]{24}$/)),
  generation: int(1, Number.MAX_SAFE_INTEGER),
  model, dimensions: int(1, 8192),
  maxSeqLength: int(64, 512), chunkSize: int(180, 2000), chunkOverlap: int(0, 600),
  maxPdfPages: int(0, 1000), defaultSearchMode: z.enum(['hybrid', 'metadata', 'fulltext']),
  hybridSemanticWeight: z.number().check(z.gte(0), z.lte(1)),
  normalizeNotation: z.boolean(), maxResults: int(3, 40),
};
const header = z.strictObject({
  ...headerFields, engine: z.enum(['local-onnx', 'ollama']), revision,
});
const vector = z.nullable(bounded(4, 44_000));
const record = z.union([
  z.tuple([z.literal('item'), key, hash, vector]),
  z.tuple([z.literal('pdf'), key, key, md5]),
  z.tuple([z.literal('chunk'), key, int(0, 1_000_000), int(0, 1_000_000), bounded(1, 32),
    int(0, Number.MAX_SAFE_INTEGER), int(0, Number.MAX_SAFE_INTEGER), bounded(1, 4000), vector]),
  z.tuple([z.literal('end'), int(0, 10_000_000)]),
]);

export type SyncHeader = z.infer<typeof header>;
export type SyncRecord = Exclude<z.infer<typeof record>, ['end', number]>;

export function syncSearchConfig(settings: SyncHeader, local: PluginConfig): PluginConfig {
  return {
    ...local,
    engine: settings.engine,
    ...(settings.engine === 'local-onnx'
      ? { localModelId: settings.model, localMaxSeqLength: settings.maxSeqLength }
      : { ollamaModel: settings.model }),
    chunkSize: settings.chunkSize, chunkOverlap: settings.chunkOverlap, maxPdfPages: settings.maxPdfPages,
    defaultSearchMode: settings.defaultSearchMode, hybridSemanticWeight: settings.hybridSemanticWeight,
    normalizeNotation: settings.normalizeNotation, maxResults: settings.maxResults,
  };
}

export function packVector(vec: Float32Array | null): string | null {
  if (!vec) return null;
  return btoa(String.fromCharCode(...float32ToBytes(vec)));
}

function unpackVector(input: string | null, dimensions: number): Float32Array | null {
  if (input === null) return null;
  const raw = atob(input);
  if (raw.length !== dimensions * 4) throw new Error('Invalid shared vector length');
  const vector = bytesToFloat32(Uint8Array.from(raw, (ch) => ch.charCodeAt(0)));
  if (!isFiniteVector(vector)) throw new Error('Invalid shared vector values');
  return vector;
}

export async function snapshotSize(path: string): Promise<number> {
  const stat = await IOUtils.stat(path);
  if (stat.type !== 'regular' || stat.size <= 0 || stat.size > MAX_SYNC_BYTES) {
    throw new Error('Invalid shared index file size');
  }
  return stat.size;
}

async function* lines(path: string): AsyncGenerator<string> {
  const size = await snapshotSize(path);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let rest = '';
  for (let offset = 0; offset < size; offset += BLOCK_SIZE) {
    const length = Math.min(BLOCK_SIZE, size - offset);
    const bytes = await IOUtils.read(path, { offset, maxBytes: length });
    if (bytes.length !== length) throw new Error('Incomplete shared index read');
    const entries = (rest + decoder.decode(bytes, { stream: true })).split('\n');
    rest = entries.pop()!;
    for (const entry of entries) {
      if (entry.length > MAX_LINE) throw new Error('Shared index record is too large');
      yield entry;
    }
    if (rest.length > MAX_LINE) throw new Error('Shared index record is too large');
  }
  if (rest + decoder.decode()) throw new Error('Incomplete shared index record');
}

export async function readSyncHeader(path: string): Promise<SyncHeader> {
  for await (const line of lines(path)) return header.parse(JSON.parse(line));
  throw new Error('Shared index header is missing');
}

export async function writeSyncSnapshot(path: string, manifest: SyncHeader, records: AsyncIterable<SyncRecord>): Promise<void> {
  let buffer = JSON.stringify(header.parse(manifest)) + '\n';
  let size = 0;
  let count = 0;
  const flush = async () => {
    const bytes = new TextEncoder().encode(buffer);
    if (size + bytes.length > MAX_SYNC_BYTES) throw new Error('Shared index exceeds the file size limit');
    await IOUtils.write(path, bytes, { mode: size ? 'append' : 'create' });
    size += bytes.length;
    buffer = '';
  };
  for await (const row of records) {
    buffer += JSON.stringify(record.parse(row)) + '\n';
    count++;
    if (buffer.length >= BLOCK_SIZE) await flush();
  }
  buffer += JSON.stringify(['end', count]) + '\n';
  await flush();
}

export interface ReceivedSnapshot {
  manifest: SyncHeader;
  index: VectorSearchIndex;
}

export async function readSyncSnapshot(path: string, account: number, libraryID: number): Promise<ReceivedSnapshot> {
  let manifest: SyncHeader | undefined;
  let count = 0;
  let ended = false;
  let fingerprint = '';
  const items = new Map<string, IndexedItemRecord | null>();
  const chunks: IndexedChunkRecord[] = [];
  const attachments = new Map<string, { item: ZoteroItem; sourceHash: string; itemKey: string } | null>();
  const seenChunks = new Set<string>();
  for await (const line of lines(path)) {
    const raw: unknown = JSON.parse(line);
    if (!manifest) {
      manifest = header.parse(raw);
      if (manifest.account !== account) throw new Error('Shared index belongs to another Zotero account');
      fingerprint = buildModelFingerprint(manifest.engine, manifest.model, manifest.dimensions);
      continue;
    }
    if (ended) throw new Error('Unexpected data after the shared index footer');
    const row = record.parse(raw);
    if (row[0] === 'end') {
      if (row[1] !== count) throw new Error('Shared index record count does not match');
      ended = true;
      continue;
    }
    count++;
    if (row[0] === 'item') {
      const [, itemKey, metadataHash, packed] = row;
      if (items.has(itemKey)) throw new Error('Duplicate shared item');
      const vec = unpackVector(packed, manifest.dimensions);
      const source = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
      if (!source || !isIndexableRegularItem(source)) {
        items.set(itemKey, null);
        continue;
      }
      const { canonicalText: _text, dateModified: _date, ...metadata } = extractItemMetadata(source);
      const vector = metadata.metadataHash === metadataHash ? vec : null;
      items.set(itemKey, {
        ...metadata, vector, dim: vector?.length ?? 0, modelFingerprint: vector ? fingerprint : '',
        updatedAt: manifest.generation,
      });
    } else if (row[0] === 'pdf') {
      const [, attachmentKey, itemKey, sourceHash] = row;
      if (!items.has(itemKey) || attachments.has(attachmentKey)) throw new Error('Invalid shared attachment reference');
      const parent = items.get(itemKey);
      const item = parent && await Zotero.Items.getByLibraryAndKeyAsync(libraryID, attachmentKey);
      if (!item || item.deleted || !item.isPDFAttachment() || item.parentItemID !== parent?.itemID) {
        attachments.set(attachmentKey, null);
        continue;
      }
      const path = await item.getFilePathAsync();
      const knownHash = path ? await item.attachmentHash : item.attachmentSyncedHash;
      attachments.set(attachmentKey, knownHash && knownHash !== sourceHash ? null : { item, sourceHash, itemKey });
    } else {
      const [, attachmentKey, chunkIndex, pageIndex, pageLabel, charStart, charEnd, text, packed] = row;
      const chunkId = 'shared:' + attachmentKey + ':' + chunkIndex;
      if (!attachments.has(attachmentKey) || seenChunks.has(chunkId) || charEnd < charStart ||
          (manifest.maxPdfPages > 0 && pageIndex >= manifest.maxPdfPages)) {
        throw new Error('Invalid shared passage reference');
      }
      seenChunks.add(chunkId);
      const vector = unpackVector(packed, manifest.dimensions);
      const attachment = attachments.get(attachmentKey);
      if (!attachment) continue;
      const parent = items.get(attachment.itemKey)!;
      chunks.push({
        chunkId, itemID: parent.itemID, itemKey: parent.itemKey, attachmentID: attachment.item.id,
        attachmentKey, attachmentTitle: attachment.item.getDisplayTitle(), chunkIndex, pageIndex,
        pageLabel, charStart, charEnd, text, snippet: buildSnippet(text),
        vector, dim: vector?.length ?? 0, modelFingerprint: vector ? fingerprint : '',
        updatedAt: manifest.generation, sourceFileHash: attachment.sourceHash,
      });
    }
  }
  if (!manifest || !ended) throw new Error('Shared index is incomplete');
  const index = new VectorSearchIndex();
  index.loadAll([...items.values()].filter((item): item is IndexedItemRecord => item !== null), chunks);
  return { manifest, index };
}
