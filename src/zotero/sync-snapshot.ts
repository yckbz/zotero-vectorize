import * as z from 'zod/mini';
import { buildSnippet } from '../core/chunker.ts';
import { buildModelFingerprint } from '../core/hash.ts';
import { isFiniteVector } from '../core/math.ts';
import { VectorSearchIndex } from '../core/search-engine.ts';
import type { PluginConfig, IndexedItemRecord, IndexedChunkRecord } from '../types/vectorize.ts';
import type { ZoteroItem } from '../types/zotero.d.ts';
import { extractItemMetadata, isIndexableRegularItem } from './extractor.ts';

const BLOCK_SIZE = 256 * 1024;
const MAX_LINE = 64 * 1024;
export const MIB = 1024 * 1024;
export const MAX_PART_BYTES = 256 * MIB;
export const MAX_SNAPSHOT_BYTES = 1024 * MIB;
export const MAX_PARTS = 1024;
export const LEGACY_MAX_BYTES = 512 * MIB;
const int = (min: number, max: number) => z.number().check(z.int(), z.gte(min), z.lte(max));
const bounded = (min: number, max: number) => z.string().check(z.minLength(min), z.maxLength(max));
export const zoteroKey = z.string().check(z.regex(/^[A-Z0-9]{8}$/));
export const md5Digest = z.string().check(z.regex(/^[a-f0-9]{32}$/));
export const contentDigest = z.string().check(z.regex(/^[a-f0-9]{64}$/));
export const rangeKey = z.string().check(z.regex(/^[A-Z0-9]{8}(?:\/[A-Z0-9]{8}(?:\/(?:0\d{6}|1000000))?)?$/));
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
export const syncHeader = z.discriminatedUnion('engine', [
  z.strictObject({ ...headerFields, engine: z.enum(['local-onnx', 'ollama']), revision }),
  z.strictObject({ ...headerFields, engine: z.literal('openai'),
    model: bounded(1, 300).check(z.regex(/^[^\u0000-\u001f\u007f]+$/)),
    endpointDigest: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  }),
]);
const vector = z.nullable(bounded(4, 44_000));
const record = z.union([
  z.tuple([z.literal('item'), zoteroKey, hash, vector]),
  z.tuple([z.literal('pdf'), zoteroKey, zoteroKey, md5Digest]),
  z.tuple([z.literal('chunk'), zoteroKey, int(0, 1_000_000), int(0, 1_000_000), bounded(1, 32),
    int(0, Number.MAX_SAFE_INTEGER), int(0, Number.MAX_SAFE_INTEGER), bounded(1, 4000), vector]),
  z.tuple([z.literal('end'), int(0, 10_000_000)]),
]);

export type SyncHeader = z.infer<typeof syncHeader>;
export type SyncRecord = Exclude<z.infer<typeof record>, ['end', number]>;

export interface SyncPart {
  bytes: number;
  digest: string;
}

export interface RangePart extends SyncPart {
  end: string | null;
  content: string;
}

export const SHARD_FILENAME = 'zotero-vectorize-shard.zvpart';

// Legacy cache and retirement use the original numbered filenames.
export function partFilename(i: number): string {
  return `zotero-vectorize-part-${i + 1}.zvpart`;
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function recordKey(row: SyncRecord, attachmentParent?: string): string {
  if (row[0] === 'item') return row[1];
  if (row[0] === 'pdf') return row[2] + '/' + row[1];
  if (!attachmentParent) throw new Error('Invalid shared passage parent');
  return attachmentParent + '/' + row[1] + '/' + String(row[2]).padStart(7, '0');
}

export async function cloudEndpointDigest(baseUrl: string): Promise<string | null> {
  const input = baseUrl.trim();
  if (!/^https?:\/\//i.test(input) || /[?#]/.test(input)) return null;
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/embeddings$/, '');
  const bytes = new TextEncoder().encode(url.origin + path + '/embeddings');
  return sha256(bytes);
}

export function syncSearchConfig(settings: SyncHeader, local: PluginConfig): PluginConfig {
  return {
    ...local,
    engine: settings.engine,
    ...(settings.engine === 'local-onnx'
      ? { localModelId: settings.model, localMaxSeqLength: settings.maxSeqLength }
      : settings.engine === 'ollama' ? { ollamaModel: settings.model } : {}),
    chunkSize: settings.chunkSize, chunkOverlap: settings.chunkOverlap, maxPdfPages: settings.maxPdfPages,
    defaultSearchMode: settings.defaultSearchMode, hybridSemanticWeight: settings.hybridSemanticWeight,
    normalizeNotation: settings.normalizeNotation, maxResults: settings.maxResults,
  };
}

export function packVector(vec: Float32Array | null): string | null {
  if (!vec) return null;
  const bytes = new Uint8Array(vec.buffer as ArrayBuffer, vec.byteOffset, vec.byteLength);
  return ChromeUtils.base64URLEncode(bytes, { pad: true });
}

function unpackVector(input: string | null, dimensions: number, legacy: boolean): Float32Array | null {
  if (input === null) return null;
  const encoded = legacy ? input.replaceAll('+', '-').replaceAll('/', '_') : input;
  const raw = ChromeUtils.base64URLDecode(encoded, { padding: 'require' });
  if (raw.byteLength !== dimensions * 4) throw new Error('Invalid shared vector length');
  const vector = new Float32Array(raw);
  if (!isFiniteVector(vector)) throw new Error('Invalid shared vector values');
  return vector;
}

export async function snapshotSize(path: string, maxBytes: number): Promise<number> {
  const stat = await IOUtils.stat(path);
  if (stat.type !== 'regular' || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error('Invalid shared index file size');
  }
  return stat.size;
}

async function* lines(path: string, maxBytes: number, maxLine = MAX_LINE): AsyncGenerator<string> {
  const size = await snapshotSize(path, maxBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let rest = '';
  for (let offset = 0; offset < size; offset += BLOCK_SIZE) {
    const length = Math.min(BLOCK_SIZE, size - offset);
    const bytes = await IOUtils.read(path, { offset, maxBytes: length });
    if (bytes.length !== length) throw new Error('Incomplete shared index read');
    const entries = (rest + decoder.decode(bytes, { stream: true })).split('\n');
    rest = entries.pop()!;
    for (const entry of entries) {
      if (entry.length > maxLine) throw new Error('Shared index record is too large');
      yield entry;
    }
    if (rest.length > maxLine) throw new Error('Shared index record is too large');
  }
  if (rest + decoder.decode()) throw new Error('Incomplete shared index record');
}

export async function readFirstSyncRecord(path: string, maxLine?: number): Promise<unknown> {
  for await (const line of lines(path, LEGACY_MAX_BYTES, maxLine)) return JSON.parse(line);
  throw new Error('Shared index header is missing');
}

export async function prepareSyncParts(
  dir: string, records: AsyncIterable<SyncRecord>, maxPartBytes: number,
  previous: readonly (RangePart & { key?: string })[],
): Promise<(RangePart & { key?: string })[]> {
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes < 1 || maxPartBytes > MAX_PART_BYTES) {
    throw new Error('Invalid shared index part size');
  }
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(maxPartBytes);
  const parts: (RangePart & { key?: string })[] = [];
  const byContent = new Map(previous.filter((part) => part.key).map((part) => [part.content, part]));
  let used = 0;
  let total = 0;
  let range = 0;
  let last = '';
  let parent: string | undefined;
  let attachment: string | undefined;

  const finishPart = async (end: string | null) => {
    if (!used) {
      // Absorb an empty range without changing the adjacent file's contents.
      if (parts.length) parts[parts.length - 1].end = end;
      return;
    }
    if (parts.length >= MAX_PARTS) throw new Error('Shared index exceeds the part count limit');
    const data = buffer.subarray(0, used);
    const content = await sha256(data);
    const old = byContent.get(content);
    if (old && old.bytes === used) {
      parts.push({ ...old, end });
    } else {
      const stage = PathUtils.join(dir, content);
      await IOUtils.makeDirectory(stage, { ignoreExisting: true });
      const path = PathUtils.join(stage, SHARD_FILENAME);
      await IOUtils.write(path, data);
      const digest = md5Digest.parse(await Zotero.Utilities.Internal.md5Async(path));
      parts.push({ end, bytes: used, content, digest });
    }
    used = 0;
  };

  for await (const row of records) {
    if (row[0] === 'item') attachment = undefined;
    if (row[0] === 'pdf') {
      attachment = row[1];
      parent = row[2];
    }
    if (row[0] === 'chunk' && row[1] !== attachment) throw new Error('Invalid shared passage order');
    const key = recordKey(row, parent);
    if (key <= last) throw new Error('Shared index records are out of order');
    last = key;
    const line = JSON.stringify(record.parse(row));
    if (line.length > MAX_LINE) throw new Error('Shared index record is too large');
    const bytes = encoder.encode(line + '\n');
    if (bytes.length > maxPartBytes) throw new Error('Shared index record exceeds the part size');
    if (total + bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('Shared index exceeds the file size limit');
    let end = previous[range]?.end;
    while (end && key >= end) {
      await finishPart(end);
      end = previous[++range]?.end;
    }
    if (used + bytes.length > maxPartBytes) await finishPart(key);
    buffer.set(bytes, used);
    used += bytes.length;
    total += bytes.length;
  }
  await finishPart(null);
  return parts;
}

export interface ReceivedSnapshot {
  manifest: SyncHeader;
  index: VectorSearchIndex;
}

export async function readSyncSnapshot(
  paths: readonly string[], expected: SyncHeader, libraryID: number, ranges?: readonly RangePart[],
  maxPartBytes = MAX_PART_BYTES,
): Promise<ReceivedSnapshot> {
  let manifest: SyncHeader | undefined = ranges ? expected : undefined;
  let count = 0;
  let ended = false;
  const fingerprint = buildModelFingerprint(expected.engine, expected.model, expected.dimensions);
  const items = new Map<string, IndexedItemRecord | null>();
  const chunks: IndexedChunkRecord[] = [];
  const attachments = new Map<string, { item: ZoteroItem; sourceHash: string; itemKey: string } | null>();
  const seenChunks = new Set<string>();
  const parents = new Map<string, string>();
  let last = '';
  async function* records() {
    for (const [i, path] of paths.entries()) {
      const start = ranges?.[i - 1]?.end;
      const end = ranges?.[i].end;
      for await (const line of lines(path, maxPartBytes)) yield { line, start, end };
    }
  }
  for await (const { line, start, end } of records()) {
    const raw: unknown = JSON.parse(line);
    if (!manifest) {
      manifest = syncHeader.parse(raw);
      if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error('Shared index header does not match');
      continue;
    }
    if (ended) throw new Error('Unexpected data after the shared index footer');
    const row = record.parse(raw);
    if (row[0] === 'end') {
      if (ranges || row[1] !== count) throw new Error('Invalid shared index footer');
      ended = true;
      continue;
    }
    if (ranges) {
      const key = recordKey(row, parents.get(row[1]));
      if (key <= last || (start && key < start) || (end && key >= end)) throw new Error('Invalid shared index range');
      last = key;
    }
    count++;
    if (row[0] === 'item') {
      const [, itemKey, metadataHash, packed] = row;
      if (items.has(itemKey)) throw new Error('Duplicate shared item');
      const vec = unpackVector(packed, manifest.dimensions, !ranges);
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
      if (ranges) parents.set(attachmentKey, itemKey);
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
      const vector = unpackVector(packed, manifest.dimensions, !ranges);
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
  if (!manifest || (!ranges && !ended)) throw new Error('Shared index is incomplete');
  const index = new VectorSearchIndex();
  index.loadAll([...items.values()].filter((item): item is IndexedItemRecord => item !== null), chunks);
  return { manifest, index };
}
