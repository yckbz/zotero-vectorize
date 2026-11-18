const SCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉';
const SCRIPT_DIGIT = /[⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]/;
const WORD_PART = /[\p{Script=Latin}0-9⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]+/gu;
const LATIN_TOKEN = /[\p{Script=Latin}0-9⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]+(?:[._-][\p{Script=Latin}0-9⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]+)*/gu;
const LATIN_OR_DIGIT = /[\p{Script=Latin}0-9⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉_]/u;

export function shouldFoldDigits(query: string, enabled = false): boolean {
  // An explicitly typed superscript or subscript keeps its exact meaning.
  return enabled && /[0-9]/.test(query) && !SCRIPT_DIGIT.test(query);
}

function lexicalText(text: string, foldDigits: boolean): string {
  const input = foldDigits
    ? text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]/g, (digit) => String(SCRIPT_DIGITS.indexOf(digit) % 10))
    : text;
  return input.replace(WORD_PART, (token) => {
    // Short acronyms and letter/number identifiers retain their spelling.
    if (/^[A-Z]{2,4}$/.test(token) || (/\p{Script=Latin}/u.test(token) && /[0-9⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]/.test(token))) {
      return token;
    }
    const lower = token.toLowerCase();
    // Keep every search offset valid in the original snippet.
    return lower.length === token.length ? lower : token;
  });
}

const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are',
  'was', 'were', 'be', 'been', 'with', 'by', 'from', 'that', 'this', 'as', 'it',
  'its', 'we', 'our', 'can', 'using', 'via', 'based', 'towards', 'study',
]);

// Single-character grammatical particles ignored as standalone CJK tokens.
const ZH_STOPCHARS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '与', '及', '或', '就', '不', '人', '都', '一', '个', '也',
  '很', '到', '说', '要', '去', '你', '会', '着', '没', '之', '其', '该', '此', '所', '这', '那', '哪',
  '谁', '把', '被', '将', '从', '但', '而', '若', '则', '因', '由', '如', '何', '于', '为', '对', '中',
  '上', '下', '地', '得',
]);

// Generic Chinese query/abstract boilerplate bigrams that inflate unrelated same-language matches.
const ZH_FILLER_BIGRAMS = new Set([
  '基于', '通过', '如何', '什么', '怎样', '一种', '本文', '研究', '分析', '方法', '探讨', '构建',
  '应用', '影响', '特征', '阶段', '问题', '实践', '路径', '状况', '规律', '现状', '进行', '可以',
  '以及', '相关', '之间', '作用', '结果', '提出', '采用', '利用', '结合',
]);

function lightStemEn(word: string): string {
  if (word.length <= 4) return word;
  if (word.endsWith('ies') && word.length > 5) return word.slice(0, -3) + 'y';
  if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

export function tokenizeForLexical(text: string): string[] {
  return tokenize(lexicalText(text, false));
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];

  // Latin & alphanumeric tokens
  for (const w of text.match(LATIN_TOKEN) || []) {
    if ((w.length === 1 && !/[0-9⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]/.test(w)) || EN_STOPWORDS.has(w)) continue;
    tokens.push(w);
    if (!/^[a-z]+$/.test(w)) continue;
    const stemmed = lightStemEn(w);
    if (stemmed !== w && stemmed.length >= 3) {
      tokens.push(stemmed);
    }
  }

  // CJK tokens: standalone single chars (excluding grammatical particles) or 2-3 char grams without filler noise
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      if (!ZH_STOPCHARS.has(chars[0])) {
        tokens.push(chars[0]);
      }
      continue;
    }
    for (let i = 0; i < chars.length; i++) {
      if (i + 1 < chars.length) {
        const bg = chars[i] + chars[i + 1];
        const prevFiller = i > 0 && ZH_FILLER_BIGRAMS.has(chars[i - 1] + chars[i]);
        const nextFiller = i + 2 < chars.length && ZH_FILLER_BIGRAMS.has(chars[i + 1] + chars[i + 2]);
        const hasParticle = (chars[i] === '的' || chars[i + 1] === '的') && bg !== '目的';
        const bothStop = ZH_STOPCHARS.has(chars[i]) && ZH_STOPCHARS.has(chars[i + 1]);
        if (
          !hasParticle &&
          !bothStop &&
          !ZH_FILLER_BIGRAMS.has(bg) &&
          !(prevFiller && nextFiller) &&
          chars[i] !== '了' &&
          chars[i + 1] !== '了'
        ) {
          tokens.push(bg);
        }
      }
      if (i + 2 < chars.length && chars.length <= 48) {
        const tg = chars[i] + chars[i + 1] + chars[i + 2];
        const headFiller = ZH_FILLER_BIGRAMS.has(tg.slice(0, 2));
        const tailFiller = ZH_FILLER_BIGRAMS.has(tg.slice(1, 3));
        if (!tg.includes('的') && !tg.includes('了') && !headFiller && !tailFiller) {
          tokens.push(tg);
        }
      }
    }
  }

  return tokens;
}

/**
 * Bounded Levenshtein edit distance (for typo/fuzzy impression recall on Latin terms).
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 4;
  const dp = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }
  return dp[n];
}

export function prepareLexicalText(
  fields: { title?: string; meta?: string; body?: string },
  vocabulary?: Map<string, string>,
  foldDigits = false
) {
  const title = lexicalText(fields.title || '', foldDigits);
  const meta = lexicalText(fields.meta || '', foldDigits);
  const body = lexicalText(fields.body || '', foldDigits);
  const combined = `${title} ${meta} ${body}`;
  const collectTokens = (text: string) => {
    const tokens = Array.from(new Set(tokenize(text))).sort();
    if (vocabulary) {
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const shared = vocabulary.get(token);
        if (shared === undefined) vocabulary.set(token, token);
        else tokens[i] = shared;
      }
    }
    return tokens;
  };
  return {
    title,
    combined,
    docTokens: collectTokens(combined),
    titleTokens: collectTokens(title),
  };
}

function containsToken(tokens: string[], target: string): boolean {
  let left = 0;
  let right = tokens.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (tokens[middle] < target) left = middle + 1;
    else right = middle;
  }
  return tokens[left] === target;
}

function hasFuzzyMatch(tokens: string[], target: string, matches: Map<string, boolean>): boolean {
  const limit = target.length >= 7 ? 2 : 1;
  for (const token of tokens) {
    if (token.length < 5 || Math.abs(target.length - token.length) > limit) continue;
    let match = matches.get(token);
    if (match === undefined) {
      match = /^[a-z]+$/.test(token) && editDistance(target, token) <= limit;
      matches.set(token, match);
    }
    if (match) return true;
  }
  return false;
}

function* literalMatches(text: string, term: string): Generator<number> {
  if (!term) return;
  const checkLeft = LATIN_OR_DIGIT.test(term[0]);
  const checkRight = LATIN_OR_DIGIT.test(term[term.length - 1]);
  let start = text.indexOf(term);
  while (start >= 0) {
    const end = start + term.length;
    if ((!checkLeft || start === 0 || !LATIN_OR_DIGIT.test(text[start - 1])) &&
        (!checkRight || end === text.length || !LATIN_OR_DIGIT.test(text[end]))) {
      yield start;
    }
    start = text.indexOf(term, end);
  }
}

export function createLexicalScorer(query: string, foldDigits = false, extraTerms = '') {
  const phrase = lexicalText(query.trim(), foldDigits);
  const tokens = [...new Set(tokenize(`${phrase} ${lexicalText(extraTerms, foldDigits)}`))];
  const fuzzyMatches = new Map(tokens
    .filter((token) => token.length >= 5 && /^[a-z]+$/.test(token))
    .map((token) => [token, new Map<string, boolean>()]));
  const maxDenominator = Math.max(2.5, tokens.length * 1.15);

  return ({ title, combined, titleTokens, docTokens }: ReturnType<typeof prepareLexicalText>): number => {
    if (tokens.length === 0) return 0;
    let score = 0;
    if (phrase.length >= 2) {
      if (!literalMatches(title, phrase).next().done) score += 3.2;
      else if (!literalMatches(combined, phrase).next().done) score += 1.8;
    }

    for (const token of tokens) {
      if (token.length === 1 && hasCjk(token)) {
        if (title.includes(token)) score += 0.45;
        else if (combined.includes(token)) score += 0.25;
      } else if (containsToken(titleTokens, token)) {
        score += 1.6;
      } else if (containsToken(docTokens, token)) {
        score += 0.95;
      } else {
        const matches = fuzzyMatches.get(token);
        if (!matches) continue;
        if (hasFuzzyMatch(titleTokens, token, matches)) score += 0.9;
        else if (hasFuzzyMatch(docTokens, token, matches)) score += 0.5;
      }
    }

    return Math.min(1, score / maxDenominator);
  };
}

export function scoreLexicalText(
  query: string,
  fields: { title?: string; meta?: string; body?: string },
  normalizeNotation = false
): number {
  const foldDigits = shouldFoldDigits(query, normalizeNotation);
  return createLexicalScorer(query, foldDigits)(prepareLexicalText(fields, undefined, foldDigits));
}

/**
 * Compute highlight ranges in the original snippet.
 */
export function computeHighlightRanges(text: string, query: string, normalizeNotation = false): Array<[number, number]> {
  if (!text || !query) return [];
  const foldDigits = shouldFoldDigits(query, normalizeNotation);
  const source = lexicalText(text, foldDigits);
  const phrase = lexicalText(query.trim(), foldDigits);
  const terms = new Set([phrase, ...tokenize(phrase)]);

  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    if (term.length < 2) continue;
    let count = 0;
    for (const start of literalMatches(source, term)) {
      ranges.push([start, start + term.length]);
      if (++count === 4) break;
    }
  }

  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  // Merge overlapping ranges
  const merged: Array<[number, number]> = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = ranges[i];
    if (curr[0] <= prev[1]) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}
