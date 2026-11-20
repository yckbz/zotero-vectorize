import * as z from 'zod/mini';
import type { ZoteroItem } from '../types/zotero.d.ts';
import {
  LEGACY_MAX_BYTES, MAX_PART_BYTES, MAX_PARTS, MAX_SNAPSHOT_BYTES, md5Digest, readFirstSyncRecord,
  snapshotSize, syncHeader, zoteroKey, type SyncHeader, type SyncPart,
} from './sync-snapshot.ts';

export const MAX_MANIFEST_BYTES = 256 * 1024;
const partFields = {
  bytes: z.number().check(z.int(), z.gte(1), z.lte(MAX_PART_BYTES)),
  digest: md5Digest,
};
const parts = <T extends z.ZodMiniType>(schema: T) => z.array(schema).check(z.minLength(1), z.maxLength(MAX_PARTS));
const manifestSchema = z.strictObject({
  type: z.literal('zotero-vectorize-index-manifest'),
  version: z.literal(2),
  snapshot: syncHeader,
  parts: parts(z.strictObject({ ...partFields, key: zoteroKey })),
});
const draftSchema = z.strictObject({
  snapshot: syncHeader,
  stamp: z.string().check(z.regex(/^[a-f0-9]{16}$/)),
  parts: parts(z.strictObject(partFields)),
  previous: z.nullable(z.strictObject({
    generation: z.number().check(z.int(), z.gte(1)),
    digest: md5Digest,
    keys: z.array(zoteroKey).check(z.maxLength(MAX_PARTS)),
  })),
});

export type SyncManifest = z.infer<typeof manifestSchema>;
export type SyncDraft = z.infer<typeof draftSchema>;

export const acceptedPublication = z.strictObject({
  publisher: z.string().check(z.regex(/^[a-zA-Z0-9]{24}$/)),
  generation: z.number().check(z.int(), z.gte(1), z.lte(Number.MAX_SAFE_INTEGER)),
  digest: md5Digest,
});

export type AcceptedPublication = z.infer<typeof acceptedPublication>;

function validateTotal(parts: readonly SyncPart[]): void {
  if (parts.reduce((size, part) => size + part.bytes, 0) > MAX_SNAPSHOT_BYTES) {
    throw new Error('Shared index exceeds the file size limit');
  }
}

async function readManifestJSON(path: string): Promise<unknown> {
  const bytes = await snapshotSize(path, MAX_MANIFEST_BYTES);
  const data = await IOUtils.read(path, { maxBytes: bytes + 1 });
  if (data.length !== bytes) throw new Error('Shared index manifest changed during read');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}

export async function readSyncManifest(path: string): Promise<SyncManifest> {
  const manifest = manifestSchema.parse(await readManifestJSON(path));
  validateTotal(manifest.parts);
  if (new Set(manifest.parts.map((part) => part.key)).size !== manifest.parts.length) {
    throw new Error('Duplicate shared index part');
  }
  return manifest;
}

export async function readSyncDraft(path: string): Promise<SyncDraft> {
  const draft = draftSchema.parse(await readManifestJSON(path));
  validateTotal(draft.parts);
  if (draft.previous && draft.previous.generation >= draft.snapshot.generation) {
    throw new Error('Invalid pending shared index generation');
  }
  return draft;
}

export async function readPublishedHead(
  path: string,
): Promise<{ snapshot: SyncHeader; parts: SyncManifest['parts']; digest: string }> {
  await snapshotSize(path, LEGACY_MAX_BYTES);
  const digest = await fileDigest(path);
  // The beta used the same attachment for the entire snapshot. Its first record preserves ownership on upgrade.
  const legacy = syncHeader.safeParse(await readFirstSyncRecord(path, MAX_MANIFEST_BYTES));
  const head = legacy.success ? { snapshot: legacy.data, parts: [] } : await readSyncManifest(path);
  if (await fileDigest(path) !== digest) throw new Error('Shared index changed while reading its publication');
  return { ...head, digest };
}

export async function writeManifestFile(path: string, data: SyncManifest | SyncDraft): Promise<void> {
  const canonical = 'type' in data ? manifestSchema.parse(data) : draftSchema.parse(data);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical) + '\n');
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Shared index manifest is too large');
  const pending = path + '.pending';
  await IOUtils.write(pending, bytes);
  await IOUtils.move(pending, path);
}

export async function fileDigest(path: string): Promise<string> {
  return md5Digest.parse(await Zotero.Utilities.Internal.md5Async(path));
}

export async function verifyPart(path: string, expected: SyncPart): Promise<void> {
  if (await snapshotSize(path, expected.bytes) !== expected.bytes || await fileDigest(path) !== expected.digest) {
    throw new Error('Shared index part checksum changed');
  }
}

type RemoteFileState = 'present' | 'missing' | 'conflict';

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
      return zip.status === 404 ? 'missing' : 'conflict';
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
