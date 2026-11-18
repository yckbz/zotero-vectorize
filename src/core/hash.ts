import type { EngineType } from '../types/vectorize.ts';

/**
 * Deterministic 64-bit FNV-1a hex digest (synchronous, zero runtime dependency).
 */
export function fnv1a64(input: string): string {
  let h1 = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask64 = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 ^= BigInt(code & 0xff);
    h1 = (h1 * prime) & mask64;
    if (code > 0xff) {
      h1 ^= BigInt((code >> 8) & 0xff);
      h1 = (h1 * prime) & mask64;
    }
  }
  return h1.toString(16).padStart(16, '0');
}

export function buildModelFingerprint(engine: EngineType | string, model: string, dim = 0): string {
  const cleanEngine = String(engine || 'local-onnx').trim();
  const cleanModel = String(model || 'default').trim();
  return dim > 0 ? `${cleanEngine}:${cleanModel}:${dim}` : `${cleanEngine}:${cleanModel}`;
}

export function parseModelFingerprint(fp: string): { engine: string; model: string; dim: number } {
  if (!fp) return { engine: '', model: '', dim: 0 };
  const parts = fp.split(':');
  if (parts.length >= 3) {
    const dim = Number(parts[parts.length - 1]) || 0;
    const engine = parts[0];
    const model = parts.slice(1, -1).join(':');
    return { engine, model, dim };
  }
  if (parts.length === 2) {
    return { engine: parts[0], model: parts[1], dim: 0 };
  }
  return { engine: '', model: fp, dim: 0 };
}

export function hashMetadataFields(fields: {
  title: string;
  creators: string;
  year: string;
  publicationTitle: string;
  doi: string;
  tags: string[];
  abstractNote: string;
}): string {
  const normalized = [
    fields.title.trim(),
    fields.creators.trim(),
    fields.year.trim(),
    fields.publicationTitle.trim(),
    fields.doi.trim(),
    [...fields.tags].sort().join('\u001f'),
    fields.abstractNote.trim(),
  ].join('\u001e');
  return fnv1a64(normalized);
}
