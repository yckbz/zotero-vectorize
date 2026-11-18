export function isFiniteVector(vec: ArrayLike<number> | null | undefined): boolean {
  if (!vec || vec.length === 0) return false;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) return false;
  }
  return true;
}

export function l2Normalize(input: ArrayLike<number>): Float32Array {
  const out = new Float32Array(input.length);
  let sumSq = 0;
  for (let i = 0; i < input.length; i++) {
    const v = Number.isFinite(input[i]) ? input[i] : 0;
    out[i] = v;
    sumSq += v * v;
  }
  if (sumSq <= 1e-12) {
    return out;
  }
  const invNorm = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < out.length; i++) {
    out[i] *= invNorm;
  }
  return out;
}

export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    if (!Number.isFinite(va) || !Number.isFinite(vb)) {
      return 0;
    }
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 1e-12) return 0;
  return Math.max(-1, Math.min(1, dot / denom));
}

export function float32ToBytes(vec: Float32Array): Uint8Array {
  const copy = new Float32Array(vec.length);
  copy.set(vec);
  return new Uint8Array(copy.buffer);
}

export function bytesToFloat32(bytes: Uint8Array | ArrayBuffer | number[]): Float32Array {
  if (bytes instanceof ArrayBuffer) {
    const byteLen = bytes.byteLength - (bytes.byteLength % 4);
    return new Float32Array(bytes.slice(0, byteLen));
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const alignedLen = u8.byteLength - (u8.byteLength % 4);
  if (alignedLen === 0) return new Float32Array(0);
  const copy = new Uint8Array(alignedLen);
  copy.set(u8.subarray(0, alignedLen));
  return new Float32Array(copy.buffer);
}

/**
 * Masked mean pooling over token embeddings [seqLen, hiddenSize] + L2 normalization.
 */
export function meanPoolNormalized(
  hiddenStates: ArrayLike<number>,
  attentionMask: ArrayLike<number | bigint>,
  seqLen: number,
  hiddenSize: number,
  batchOffset = 0
): Float32Array {
  const pooled = new Float32Array(hiddenSize);
  let validTokens = 0;
  const baseTokenOffset = batchOffset * seqLen * hiddenSize;

  for (let t = 0; t < seqLen; t++) {
    const maskVal = Number(attentionMask[batchOffset * seqLen + t] ?? 0);
    if (maskVal <= 0) continue;
    validTokens += maskVal;
    const rowStart = baseTokenOffset + t * hiddenSize;
    for (let d = 0; d < hiddenSize; d++) {
      pooled[d] += hiddenStates[rowStart + d] * maskVal;
    }
  }

  if (validTokens > 0) {
    const inv = 1 / validTokens;
    for (let d = 0; d < hiddenSize; d++) {
      pooled[d] *= inv;
    }
  }
  return l2Normalize(pooled);
}

/**
 * CLS token pooling (first token embedding) + L2 normalization.
 */
export function clsPoolNormalized(
  hiddenStates: ArrayLike<number>,
  seqLen: number,
  hiddenSize: number,
  batchOffset = 0
): Float32Array {
  const start = batchOffset * seqLen * hiddenSize;
  const cls = new Float32Array(hiddenSize);
  for (let d = 0; d < hiddenSize; d++) {
    cls[d] = hiddenStates[start + d] ?? 0;
  }
  return l2Normalize(cls);
}
