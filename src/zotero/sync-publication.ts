import * as z from 'zod/mini';
import {
  MAX_PART_BYTES, MAX_PARTS, MAX_SNAPSHOT_BYTES, md5Digest, readFirstSyncRecord, snapshotSize, syncHeader, zoteroKey,
  type SyncHeader, type SyncPart,
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

export async function readPublishedHead(path: string): Promise<{ snapshot: SyncHeader; keys: string[] }> {
  // The beta used the same attachment for the entire snapshot. Its first record preserves ownership on upgrade.
  const legacy = syncHeader.safeParse(await readFirstSyncRecord(path, MAX_MANIFEST_BYTES));
  if (legacy.success) return { snapshot: legacy.data, keys: [] };
  const manifest = await readSyncManifest(path);
  return { snapshot: manifest.snapshot, keys: manifest.parts.map((part) => part.key) };
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
