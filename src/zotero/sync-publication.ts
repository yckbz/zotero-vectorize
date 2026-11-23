import * as z from 'zod/mini';
import type { ZoteroItem } from '../types/zotero.d.ts';
import {
  contentDigest, LEGACY_MAX_BYTES, MAX_PART_BYTES, MAX_PARTS, MAX_SNAPSHOT_BYTES, md5Digest, rangeKey, readFirstSyncRecord, sha256,
  snapshotSize, syncHeader, zoteroKey, type SyncPart,
} from './sync-snapshot.ts';

export const MAX_MANIFEST_BYTES = 256 * 1024;
export const CURRENT_SYNC_VERSION = 4;
const partFields = {
  bytes: z.number().check(z.int(), z.gte(1), z.lte(MAX_PART_BYTES)),
  digest: md5Digest,
};
const parts = <T extends z.ZodMiniType>(schema: T) => z.array(schema).check(z.maxLength(MAX_PARTS));
const legacyManifestSchema = z.strictObject({
  type: z.literal('zotero-vectorize-index-manifest'),
  version: z.literal(2),
  snapshot: syncHeader,
  parts: parts(z.strictObject({ ...partFields, key: zoteroKey })),
});
const rangeFields = { ...partFields, end: z.nullable(rangeKey), content: contentDigest };
const maximum = z.number().check(z.int(), z.gte(1), z.lte(MAX_PART_BYTES));
const rangeManifestFields = {
  type: z.literal('zotero-vectorize-index-manifest'),
  snapshot: syncHeader,
  partBytes: maximum,
  parts: parts(z.strictObject({ ...rangeFields, key: zoteroKey })),
};
const v3ManifestSchema = z.strictObject({
  ...rangeManifestFields,
  version: z.literal(3),
});
const manifestSchema = z.strictObject({
  ...rangeManifestFields,
  version: z.literal(4),
});
const rangeDraftFields = {
  snapshot: syncHeader,
  partBytes: maximum,
  parts: parts(z.strictObject({ ...rangeFields, key: z.optional(zoteroKey) })),
  previous: z.nullable(z.strictObject({
    generation: z.number().check(z.int(), z.gte(1)),
    digest: md5Digest,
    parts: parts(z.strictObject({ key: zoteroKey, content: z.optional(contentDigest) })),
  })),
};
const v3DraftSchema = z.strictObject({
  ...rangeDraftFields,
  version: z.literal(3),
});
const draftSchema = z.strictObject({
  ...rangeDraftFields,
  version: z.literal(4),
});
const legacyDraftSchema = z.strictObject({
  snapshot: syncHeader,
  stamp: z.string().check(z.regex(/^[a-f0-9]{16}$/)),
  parts: parts(z.strictObject(partFields)).check(z.minLength(1)),
  previous: z.nullable(z.strictObject({
    generation: z.number().check(z.int(), z.gte(1)),
    digest: md5Digest,
    keys: z.array(zoteroKey).check(z.maxLength(MAX_PARTS)),
  })),
});

export type SyncManifest = z.infer<typeof manifestSchema>;
export type V3SyncManifest = z.infer<typeof v3ManifestSchema>;
export type LegacySyncManifest = z.infer<typeof legacyManifestSchema>;
export type SyncDraft = z.infer<typeof draftSchema>;
export type V3SyncDraft = z.infer<typeof v3DraftSchema>;
export type LegacySyncDraft = Omit<z.infer<typeof legacyDraftSchema>, 'previous' | 'stamp'> &
  { version: 2; previous: SyncDraft['previous'] };

export class SyncProtocolVersionError extends Error {
  constructor(readonly version: number) { super('Unsupported shared index protocol version'); }
}

export const acceptedPublication = z.strictObject({
  publisher: z.string().check(z.regex(/^[a-zA-Z0-9]{24}$/)),
  generation: z.number().check(z.int(), z.gte(1), z.lte(Number.MAX_SAFE_INTEGER)),
  digest: md5Digest,
});

export type AcceptedPublication = z.infer<typeof acceptedPublication>;

function validateParts(parts: readonly (SyncPart & { key?: string; end?: string | null; content?: string })[], max: number): void {
  if (parts.reduce((size, part) => size + part.bytes, 0) > MAX_SNAPSHOT_BYTES) {
    throw new Error('Shared index exceeds the file size limit');
  }
  let last = '';
  const keys = new Set<string>();
  const contents = new Set<string>();
  for (const [i, part] of parts.entries()) {
    if (part.key && keys.has(part.key)) throw new Error('Duplicate shared index attachment');
    if (part.key) keys.add(part.key);
    if (part.bytes > max) throw new Error('Shared index part exceeds the configured limit');
    if (part.end === undefined) continue;
    if ((part.end === null) !== (i === parts.length - 1) || (part.end !== null && part.end <= last)) {
      throw new Error('Invalid shared index range boundaries');
    }
    last = part.end ?? last;
    if (contents.has(part.content!)) throw new Error('Duplicate shared index content');
    contents.add(part.content!);
  }
}

async function readManifestJSON(path: string): Promise<unknown> {
  const bytes = await snapshotSize(path, MAX_MANIFEST_BYTES);
  const data = await IOUtils.read(path, { maxBytes: bytes + 1 });
  if (data.length !== bytes) throw new Error('Shared index manifest changed during read');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}

export async function readSyncManifest(path: string): Promise<SyncManifest> {
  const value = await readManifestJSON(path);
  if (typeof value === 'object' && value !== null && 'type' in value &&
      value.type === 'zotero-vectorize-index-manifest' && 'version' in value &&
      typeof value.version === 'number' && Number.isSafeInteger(value.version)) {
    if (value.version === 2) legacyManifest(value);
    if (value.version === 3) v3Manifest(value);
    if (value.version >= 2 && value.version !== CURRENT_SYNC_VERSION) throw new SyncProtocolVersionError(value.version);
  }
  const manifest = manifestSchema.parse(value);
  validateParts(manifest.parts, manifest.partBytes);
  return manifest;
}

export async function readCachedManifest(path: string): Promise<SyncManifest | V3SyncManifest | LegacySyncManifest> {
  const value = await readManifestJSON(path);
  const latest = manifestSchema.safeParse(value);
  if (latest.success) {
    validateParts(latest.data.parts, latest.data.partBytes);
    return latest.data;
  }
  const v3 = v3ManifestSchema.safeParse(value);
  if (v3.success) {
    validateParts(v3.data.parts, v3.data.partBytes);
    return v3.data;
  }
  return legacyManifest(value);
}

function v3Manifest(value: unknown): V3SyncManifest {
  const previous = v3ManifestSchema.parse(value);
  validateParts(previous.parts, previous.partBytes);
  return previous;
}

function legacyManifest(value: unknown): LegacySyncManifest {
  const legacy = legacyManifestSchema.parse(value);
  if (!legacy.parts.length) throw new Error('Empty legacy shared index');
  validateParts(legacy.parts, MAX_PART_BYTES);
  return legacy;
}

function validateRangeDraft<T extends SyncDraft | V3SyncDraft>(draft: T): T {
  validateParts(draft.parts, draft.partBytes);
  if (draft.previous && draft.previous.generation >= draft.snapshot.generation) {
    throw new Error('Invalid pending shared index generation');
  }
  const base = new Map(draft.previous?.parts.map((part) => [part.key, part.content]));
  if (draft.parts.some((part) => part.key && base.get(part.key) !== part.content)) {
    throw new Error('Invalid reused shared index part');
  }
  return draft;
}

export async function readSyncDraft(path: string): Promise<SyncDraft | V3SyncDraft | LegacySyncDraft> {
  const value = await readManifestJSON(path);
  if (typeof value === 'object' && value !== null && !('version' in value)) {
    const { snapshot, parts, previous } = legacyDraftSchema.parse(value);
    validateParts(parts, MAX_PART_BYTES);
    if (previous && (previous.generation >= snapshot.generation || new Set(previous.keys).size !== previous.keys.length)) {
      throw new Error('Invalid legacy shared index draft');
    }
    return { version: 2, snapshot, parts, previous: previous && {
      generation: previous.generation, digest: previous.digest, parts: previous.keys.map((key) => ({ key })),
    } };
  }
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 3) {
    return validateRangeDraft(v3DraftSchema.parse(value));
  }
  return validateRangeDraft(draftSchema.parse(value));
}

export async function readPublishedHead(
  path: string,
) {
  await snapshotSize(path, LEGACY_MAX_BYTES);
  const digest = await fileDigest(path);
  // The beta used the same attachment for the entire snapshot. Its first record preserves ownership on upgrade.
  const legacy = syncHeader.safeParse(await readFirstSyncRecord(path, MAX_MANIFEST_BYTES));
  const head = legacy.success ? { version: 1 as const, snapshot: legacy.data, parts: [] as const } : await readCachedManifest(path);
  if (await fileDigest(path) !== digest) throw new Error('Shared index changed while reading its publication');
  return { ...head, digest };
}

export async function writeManifestFile(path: string, data: SyncManifest | SyncDraft): Promise<void> {
  const canonical = 'type' in data ? manifestSchema.parse(data) : draftSchema.parse(data);
  validateParts(canonical.parts, canonical.partBytes);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical) + '\n');
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Shared index manifest is too large');
  const pending = path + '.pending';
  await IOUtils.write(pending, bytes);
  await IOUtils.move(pending, path);
}

export async function fileDigest(path: string): Promise<string> {
  return md5Digest.parse(await Zotero.Utilities.Internal.md5Async(path));
}

export async function verifyPart(path: string, expected: SyncPart & { content?: string }): Promise<void> {
  if (await snapshotSize(path, expected.bytes) !== expected.bytes) throw new Error('Shared index part size changed');
  if (!expected.content) {
    if (await fileDigest(path) !== expected.digest) throw new Error('Shared index part checksum changed');
    return;
  }
  const bytes = await IOUtils.read(path, { maxBytes: expected.bytes + 1 });
  if (bytes.length !== expected.bytes || await sha256(bytes) !== expected.content) {
    throw new Error('Shared index part content changed');
  }
}

type RemoteFileState = 'present' | 'missing' | 'unconfirmed' | 'conflict';

// Without a .prop file, only the archived bytes can identify an interrupted upload.
export async function matchesUnconfirmedManifest(item: ZoteroItem, dir: string, expectedPath: string): Promise<boolean> {
  const expectedSize = await snapshotSize(expectedPath, MAX_MANIFEST_BYTES);
  const expected = await IOUtils.read(expectedPath, { maxBytes: expectedSize + 1 });
  const controller = Zotero.Sync!.Runner.getStorageController('webdav');
  await controller._init();
  const limit = MAX_MANIFEST_BYTES * 2;
  let oversized = false;
  const result = await Zotero.HTTP.request('GET', controller._getItemURI(item), {
    noCache: true, successCodes: [200, 404], responseType: 'arraybuffer',
    requestObserver: (request) => {
      request.addEventListener('progress', ({ loaded }) => {
        if (loaded <= limit) return;
        oversized = true;
        request.abort();
      });
    },
  }).catch((error: unknown) => {
    if (!oversized) throw error;
  });
  if (result?.status !== 200 || !result.response?.byteLength || result.response.byteLength > limit) return false;

  const path = PathUtils.join(dir, 'check-remote-manifest.zip');
  try {
    await IOUtils.write(path, new Uint8Array(result.response));
    const zip = Components.classes['@mozilla.org/libjar/zip-reader;1'].createInstance(Components.interfaces.nsIZipReader);
    zip.open(Zotero.File.pathToFile(path));
    try {
      const entries = zip.findEntries(null);
      if (!entries.hasMore()) return false;
      const name = entries.getNext();
      if (entries.hasMore() || name !== item.attachmentFilename || zip.getEntry(name).realSize !== expectedSize) return false;
      const reader = Components.classes['@mozilla.org/binaryinputstream;1'].createInstance(Components.interfaces.nsIBinaryInputStream);
      reader.setInputStream(zip.getInputStream(name));
      try {
        const actual: number[] = reader.readByteArray(expectedSize);
        return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
      } finally {
        reader.close();
      }
    } finally {
      zip.close();
    }
  } finally {
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
}

export async function openWebDavProbe() {
  const controller = Zotero.Sync!.Runner.getStorageController('webdav');
  await controller._init();
  const options = { noCache: true, successCodes: [200, 404] };
  return async (item: ZoteroItem, digest: string): Promise<RemoteFileState> => {
    const prop = await Zotero.HTTP.request('GET', controller._getItemPropertyURI(item), {
      ...options,
      responseType: 'document',
      requestObserver: (request) => request.overrideMimeType('text/xml'),
    });
    if (prop.status === 404) {
      // A ZIP without its hash metadata may be in the middle of a native WebDAV upload.
      const zip = await Zotero.HTTP.request('HEAD', controller._getItemURI(item), options);
      return zip.status === 404 ? 'missing' : 'unconfirmed';
    }
    const doc: Document | null = prop.response;
    const root = doc?.documentElement;
    const hashes = root?.getElementsByTagName('hash');
    const times = root?.getElementsByTagName('mtime');
    if (root?.localName !== 'properties' || hashes?.length !== 1 || hashes[0].textContent !== digest ||
        times?.length !== 1 || !/^\d{1,13}$/.test(times[0].textContent ?? '')) return 'conflict';
    const zip = await Zotero.HTTP.request('HEAD', controller._getItemURI(item), options);
    return zip.status === 404 || zip.getResponseHeader('Content-Length') === '0' ? 'missing' : 'present';
  };
}
