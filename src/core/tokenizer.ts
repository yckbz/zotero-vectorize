export interface EncodedBatch {
  inputIds: BigInt64Array;
  attentionMask: BigInt64Array;
  tokenTypeIds: BigInt64Array;
  batchSize: number;
  seqLength: number;
}

interface TokenizerJson {
  normalizer?: any;
  pre_tokenizer?: any;
  post_processor?: any;
  added_tokens?: Array<{ id: number; content: string; special?: boolean }>;
  model: {
    type?: 'WordPiece' | 'Unigram' | 'BPE' | string;
    unk_token?: string;
    unk_id?: number;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
    vocab: Record<string, number> | Array<[string, number]>;
    merges?: Array<string | [string, string]>;
  };
}

const METASPACE = '\u2581';

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  return /\p{P}|\p{S}/u.test(ch);
}

function buildByteToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const map = new Map<number, string>();
  for (let i = 0; i < bs.length; i++) {
    map.set(bs[i], String.fromCharCode(cs[i]));
  }
  return map;
}

const BYTE_TO_UNICODE = buildByteToUnicode();

function flattenPipelineNodes(node: any): any[] {
  if (!node) return [];
  if (node.type === 'Sequence' && Array.isArray(node.normalizers)) {
    return node.normalizers.flatMap(flattenPipelineNodes);
  }
  if (node.type === 'Sequence' && Array.isArray(node.pretokenizers)) {
    return node.pretokenizers.flatMap(flattenPipelineNodes);
  }
  if (node.type === 'Sequence' && Array.isArray(node.processors)) {
    return node.processors.flatMap(flattenPipelineNodes);
  }
  return [node];
}

export class HuggingFaceTokenizer {
  private readonly modelType: 'WordPiece' | 'Unigram' | 'BPE';
  private readonly vocabMap = new Map<string, number>();
  private readonly unigramScores = new Map<string, number>();
  private readonly bpeRanks = new Map<string, number>();
  private readonly continuingPrefix: string;
  private readonly maxWordChars: number;
  private readonly unkToken: string;
  private readonly unkId: number;
  private readonly clsId: number;
  private readonly sepId: number;
  private readonly padId: number;
  private readonly normalizerNodes: any[];
  private readonly preTokenizerNodes: any[];
  private readonly hasMetaspace: boolean;
  private readonly metaspaceAddPrefix: boolean;
  private readonly hasByteLevel: boolean;
  private readonly handleChineseChars: boolean;
  private readonly lowercaseText: boolean;
  private readonly stripAccents: boolean;
  private readonly normalizeForm: 'NFC' | 'NFKC' | 'NFD' | null;

  constructor(json: TokenizerJson, options?: { lowercase?: boolean; stripAccents?: boolean }) {
    const model = json.model;
    if (!model || !model.vocab) {
      throw new Error('Invalid tokenizer.json: missing model.vocab');
    }

    const rawType = model.type;
    if (rawType === 'Unigram' || Array.isArray(model.vocab)) {
      this.modelType = 'Unigram';
    } else if (rawType === 'BPE' || Array.isArray(model.merges)) {
      this.modelType = 'BPE';
    } else {
      this.modelType = 'WordPiece';
    }

    if (Array.isArray(model.vocab)) {
      for (let i = 0; i < model.vocab.length; i++) {
        const [token, score] = model.vocab[i];
        this.vocabMap.set(token, i);
        this.unigramScores.set(token, Number.isFinite(score) ? score : -10);
      }
    } else {
      for (const [token, id] of Object.entries(model.vocab)) {
        this.vocabMap.set(token, id);
      }
    }

    if (Array.isArray(json.added_tokens)) {
      for (const tok of json.added_tokens) {
        if (tok && typeof tok.content === 'string' && typeof tok.id === 'number') {
          this.vocabMap.set(tok.content, tok.id);
        }
      }
    }

    if (Array.isArray(model.merges)) {
      for (let i = 0; i < model.merges.length; i++) {
        const m = model.merges[i];
        const key = Array.isArray(m) ? `${m[0]}\u0000${m[1]}` : m.replace(' ', '\u0000');
        this.bpeRanks.set(key, i);
      }
    }

    this.continuingPrefix = model.continuing_subword_prefix ?? '##';
    this.maxWordChars = model.max_input_chars_per_word ?? 100;

    this.normalizerNodes = flattenPipelineNodes(json.normalizer);
    this.preTokenizerNodes = flattenPipelineNodes(json.pre_tokenizer);

    // Infer normalization behavior
    let lowercase = options?.lowercase ?? false;
    let stripAccents = options?.stripAccents ?? false;
    let normForm: 'NFC' | 'NFKC' | 'NFD' | null = null;
    let handleChinese = false;
    for (const node of this.normalizerNodes) {
      if (node.type === 'Lowercase') lowercase = true;
      if (node.type === 'StripAccents') stripAccents = true;
      if (node.type === 'NFKC' || node.type === 'Precompiled') normForm = 'NFKC';
      if (node.type === 'NFC' && !normForm) normForm = 'NFC';
      if (node.type === 'NFD' && !normForm) normForm = 'NFD';
      if (node.type === 'BertNormalizer') {
        if (node.lowercase !== undefined) lowercase = Boolean(node.lowercase);
        if (node.strip_accents !== undefined && node.strip_accents !== null) {
          stripAccents = Boolean(node.strip_accents);
        } else if (lowercase) {
          stripAccents = true;
        }
        if (node.handle_chinese_chars !== undefined) {
          handleChinese = Boolean(node.handle_chinese_chars);
        }
      }
    }
    this.lowercaseText = lowercase;
    this.stripAccents = stripAccents;
    this.normalizeForm = normForm;

    let hasMetaspace = false;
    let metaspaceAddPrefix = true;
    let hasByteLevel = false;
    for (const node of this.preTokenizerNodes) {
      if (node.type === 'Metaspace') {
        hasMetaspace = true;
        if (node.add_prefix_space === false || node.prepend_scheme === 'never') {
          metaspaceAddPrefix = false;
        }
      }
      if (node.type === 'ByteLevel') {
        hasByteLevel = true;
      }
      if (node.type === 'BertPreTokenizer') {
        handleChinese = true;
      }
    }
    if (this.modelType === 'Unigram' && !hasMetaspace && !hasByteLevel && this.vocabMap.has(`${METASPACE}the`)) {
      hasMetaspace = true;
    }
    this.hasMetaspace = hasMetaspace;
    this.metaspaceAddPrefix = metaspaceAddPrefix;
    this.hasByteLevel = hasByteLevel;
    this.handleChineseChars = handleChinese || this.modelType === 'WordPiece';

    // Special token resolution
    this.unkToken =
      model.unk_token ??
      (this.vocabMap.has('<unk>') ? '<unk>' : this.vocabMap.has('[UNK]') ? '[UNK]' : '<unk>');
    this.unkId =
      typeof model.unk_id === 'number'
        ? model.unk_id
        : (this.vocabMap.get(this.unkToken) ?? 0);

    const postMeta = this.detectSpecialTokens(json.post_processor);
    this.clsId = postMeta.clsId;
    this.sepId = postMeta.sepId;
    this.padId =
      this.vocabMap.get('<pad>') ??
      this.vocabMap.get('[PAD]') ??
      1;
  }

  private detectSpecialTokens(postProcessor: any): { clsId: number; sepId: number } {
    if (postProcessor?.special_tokens) {
      const st = postProcessor.special_tokens;
      const clsEntry = st['[CLS]'] ?? st['<s>'];
      const sepEntry = st['[SEP]'] ?? st['</s>'];
      if (clsEntry?.ids?.length && sepEntry?.ids?.length) {
        return { clsId: clsEntry.ids[0], sepId: sepEntry.ids[0] };
      }
    }
    if (postProcessor?.cls && postProcessor?.sep) {
      return { clsId: postProcessor.cls[1], sepId: postProcessor.sep[1] };
    }
    const clsId = this.vocabMap.get('[CLS]') ?? this.vocabMap.get('<s>') ?? 0;
    const sepId = this.vocabMap.get('[SEP]') ?? this.vocabMap.get('</s>') ?? 2;
    return { clsId, sepId };
  }

  private normalize(text: string): string {
    let out = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/g, '');
    for (const node of this.normalizerNodes) {
      if (node.type === 'Replace' && node.pattern?.String !== undefined && typeof node.content === 'string') {
        out = out.split(node.pattern.String).join(node.content);
      } else if (node.type === 'Replace' && node.pattern?.Regex && typeof node.content === 'string') {
        try {
          out = out.replace(new RegExp(node.pattern.Regex, 'g'), node.content);
        } catch {
          // Ignore unsupported regex flavor
        }
      }
    }
    if (this.normalizeForm) {
      out = out.normalize(this.normalizeForm);
    }
    if (this.lowercaseText) {
      out = out.toLowerCase();
    }
    if (this.stripAccents) {
      out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
    }
    return out;
  }

  private preTokenizeWordPiece(text: string): string[] {
    let buffered = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (this.handleChineseChars && isCjkCodePoint(cp)) {
        buffered += ` ${ch} `;
      } else if (isPunctuation(ch)) {
        buffered += ` ${ch} `;
      } else {
        buffered += ch;
      }
    }
    return buffered.trim().split(/\s+/).filter(Boolean);
  }

  private tokenizeWordPieceWord(word: string): number[] {
    const chars = Array.from(word);
    if (chars.length > this.maxWordChars) {
      return [this.unkId];
    }
    const ids: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let matchedId: number | undefined;
      while (start < end) {
        let substr = chars.slice(start, end).join('');
        if (start > 0) {
          substr = this.continuingPrefix + substr;
        }
        const id = this.vocabMap.get(substr);
        if (id !== undefined) {
          matchedId = id;
          break;
        }
        end--;
      }
      if (matchedId === undefined) {
        return [this.unkId];
      }
      ids.push(matchedId);
      start = end;
    }
    return ids;
  }

  private tokenizeUnigramSegment(segment: string): number[] {
    const chars = Array.from(segment);
    const n = chars.length;
    if (n === 0) return [];

    // Viterbi DP over codepoints: bestScore[i] = max log-prob for prefix chars[0..i)
    const bestScore = new Float64Array(n + 1).fill(-Infinity);
    const prevIdx = new Int32Array(n + 1).fill(-1);
    const chosenId = new Int32Array(n + 1).fill(this.unkId);
    bestScore[0] = 0;

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(bestScore[i])) continue;
      let substr = '';
      const maxJ = Math.min(n, i + 32);
      let foundAny = false;
      for (let j = i; j < maxJ; j++) {
        substr += chars[j];
        const id = this.vocabMap.get(substr);
        if (id !== undefined) {
          foundAny = true;
          const pieceScore = this.unigramScores.get(substr) ?? -10;
          const candidate = bestScore[i] + pieceScore;
          if (candidate > bestScore[j + 1]) {
            bestScore[j + 1] = candidate;
            prevIdx[j + 1] = i;
            chosenId[j + 1] = id;
          }
        }
      }
      // Single unknown character fallback (penalized so valid subwords always win)
      if (!foundAny || bestScore[i + 1] === -Infinity) {
        const fallback = bestScore[i] - 50;
        if (fallback > bestScore[i + 1]) {
          bestScore[i + 1] = fallback;
          prevIdx[i + 1] = i;
          chosenId[i + 1] = this.unkId;
        }
      }
    }

    const out: number[] = [];
    let pos = n;
    while (pos > 0) {
      out.push(chosenId[pos]);
      pos = prevIdx[pos];
      if (pos < 0) break;
    }
    out.reverse();
    // Collapse consecutive <unk> inside one segment just like SentencePiece
    const collapsed: number[] = [];
    for (const id of out) {
      if (id === this.unkId && collapsed[collapsed.length - 1] === this.unkId) {
        continue;
      }
      collapsed.push(id);
    }
    return collapsed;
  }

  private tokenizeBpeToken(token: string): number[] {
    let symbols: string[];
    if (this.hasByteLevel) {
      const encoded = new TextEncoder().encode(token);
      symbols = Array.from(encoded, (b) => BYTE_TO_UNICODE.get(b) ?? '');
    } else {
      symbols = Array.from(token);
    }

    if (symbols.length === 0) return [];
    while (symbols.length > 1) {
      let bestPairIdx = -1;
      let bestRank = Infinity;
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.bpeRanks.get(`${symbols[i]}\u0000${symbols[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestPairIdx = i;
        }
      }
      if (bestPairIdx === -1) break;
      const merged = symbols[bestPairIdx] + symbols[bestPairIdx + 1];
      symbols.splice(bestPairIdx, 2, merged);
    }
    return symbols.map((s) => this.vocabMap.get(s) ?? this.unkId);
  }

  encodeSingle(text: string, maxLength = 512): number[] {
    const clean = this.normalize(text).trim();
    if (!clean) {
      return [this.clsId, this.sepId];
    }

    const contentIds: number[] = [];

    if (this.modelType === 'Unigram') {
      const whitespaceWords = clean.split(/\s+/).filter(Boolean);
      for (let i = 0; i < whitespaceWords.length; i++) {
        let seg = whitespaceWords[i];
        if (this.hasMetaspace && (i > 0 || this.metaspaceAddPrefix)) {
          seg = METASPACE + seg;
        }
        contentIds.push(...this.tokenizeUnigramSegment(seg));
        if (contentIds.length >= maxLength - 2) break;
      }
    } else if (this.modelType === 'BPE') {
      const pieces = this.hasByteLevel
        ? clean.match(/'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu) ?? [clean]
        : this.preTokenizeWordPiece(clean);
      for (const piece of pieces) {
        contentIds.push(...this.tokenizeBpeToken(piece));
        if (contentIds.length >= maxLength - 2) break;
      }
    } else {
      const words = this.preTokenizeWordPiece(clean);
      for (const w of words) {
        contentIds.push(...this.tokenizeWordPieceWord(w));
        if (contentIds.length >= maxLength - 2) break;
      }
    }

    const maxContent = Math.max(0, maxLength - 2);
    const truncated = contentIds.slice(0, maxContent);
    return [this.clsId, ...truncated, this.sepId];
  }

  encodeBatch(texts: string[], maxLength = 512): EncodedBatch {
    const sequences = texts.map((t) => this.encodeSingle(t, maxLength));
    const batchSize = sequences.length;
    const seqLength = Math.max(1, ...sequences.map((s) => s.length));

    const inputIds = new BigInt64Array(batchSize * seqLength);
    const attentionMask = new BigInt64Array(batchSize * seqLength);
    const tokenTypeIds = new BigInt64Array(batchSize * seqLength);

    inputIds.fill(BigInt(this.padId));

    for (let b = 0; b < batchSize; b++) {
      const seq = sequences[b];
      const offset = b * seqLength;
      for (let t = 0; t < seq.length; t++) {
        inputIds[offset + t] = BigInt(seq[t]);
        attentionMask[offset + t] = 1n;
      }
    }

    return {
      inputIds,
      attentionMask,
      tokenTypeIds,
      batchSize,
      seqLength,
    };
  }
}

export function loadTokenizerFromJson(jsonText: string | TokenizerJson, options?: { lowercase?: boolean; stripAccents?: boolean }): HuggingFaceTokenizer {
  const parsed = typeof jsonText === 'string' ? (JSON.parse(jsonText) as TokenizerJson) : jsonText;
  return new HuggingFaceTokenizer(parsed, options);
}
