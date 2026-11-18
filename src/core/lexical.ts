/**
 * Lexical + CJK Bigram + Fuzzy + Bilingual EN<->ZH Academic Concept Bridge.
 * Used both as zero-wait fallback before ONNX download and as hybrid reranker signal alongside dense vectors.
 */

const CONCEPT_PAIRS: Array<[string[], string[]]> = [
  // AI / ML / NLP
  [['attention', 'self-attention', 'multi-head attention'], ['注意力', '注意力机制', '自注意力', '多头注意力']],
  [['transformer', 'transformers'], ['变压器', '变换器', 'transformer']],
  [['sparse', 'sparsity', 'sparse attention'], ['稀疏', '稀疏化', '稀疏注意力']],
  [['long context', 'context window', 'long-context'], ['长上下文', '长文本', '上下文窗口', '长序列']],
  [['large language model', 'llm', 'llms', 'language model'], ['大语言模型', '大模型', '语言模型']],
  [['reinforcement learning', 'rl', 'rlhf', 'policy gradient'], ['强化学习', '人类反馈强化学习', '策略梯度', '对齐']],
  [['fine-tuning', 'finetuning', 'fine tuning', 'lora', 'adapter'], ['微调', '参数高效微调', '低秩自适应']],
  [['retrieval', 'rag', 'retrieval-augmented'], ['检索', '检索增强', '检索增强生成', '召回']],
  [['embedding', 'embeddings', 'representation', 'vector'], ['嵌入', '向量', '表征', '向量化', '语义表示']],
  [['contrastive learning', 'self-supervised'], ['对比学习', '自监督', '自监督学习']],
  [['knowledge distillation', 'distillation'], ['知识蒸馏', '蒸馏']],
  [['quantization', 'pruning', 'compression'], ['量化', '剪枝', '模型压缩']],
  [['diffusion model', 'diffusion models', 'denoising diffusion'], ['扩散模型', '去噪扩散']],
  [['graph neural network', 'gnn', 'knowledge graph'], ['图神经网络', '知识图谱']],
  [['multimodal', 'vision-language', 'vlm'], ['多模态', '视觉语言']],
  [['reasoning', 'chain-of-thought', 'cot'], ['推理', '思维链']],
  [['hallucination', 'factuality', 'grounding'], ['幻觉', '事实性', '真实性']],
  [['agent', 'agents', 'multi-agent', 'tool use'], ['智能体', '多智能体', '工具调用']],
  [['benchmark', 'evaluation', 'dataset'], ['基准', '评测', '评估', '数据集']],
  [['neural network', 'deep learning', 'backpropagation'], ['神经网络', '深度学习', '反向传播']],
  [['gradient descent', 'optimization', 'optimizer'], ['梯度下降', '优化', '优化器']],
  [['overfitting', 'generalization', 'regularization'], ['过拟合', '泛化', '正则化']],
  [['segmentation', 'object detection', 'classification'], ['分割', '目标检测', '分类']],
  [['clustering', 'dimensionality reduction', 'pca'], ['聚类', '降维']],
  [['anomaly detection', 'outlier'], ['异常检测', '离群点']],
  // Science / Math / Stats / Bio / Econ
  [['hydrogen bond network connectivity', 'hydrogen-bond network connectivity'], ['氢键连通性', '氢键网络连通性']],
  [['density functional theory', 'dft'], ['密度泛函理论']],
  [['causal inference', 'causality', 'counterfactual'], ['因果推断', '因果关系', '反事实']],
  [['bayesian', 'posterior', 'variational inference'], ['贝叶斯', '后验', '变分推断']],
  [['randomized controlled trial', 'rct', 'clinical trial'], ['随机对照试验', '临床试验']],
  [['meta-analysis', 'systematic review'], ['元分析', '荟萃分析', '系统综述']],
  [['gene expression', 'transcriptomics', 'single-cell', 'rna-seq'], ['基因表达', '转录组', '单细胞']],
  [['protein folding', 'protein structure', 'alphafold'], ['蛋白质折叠', '蛋白质结构']],
  [['crispr', 'gene editing'], ['基因编辑']],
  [['quantum', 'entanglement', 'qubit'], ['量子', '量子纠缠', '量子比特']],
  [['differential equation', 'pde', 'ode'], ['微分方程', '偏微分方程']],
  [['climate change', 'carbon emission', 'sustainability'], ['气候变化', '碳排放', '可持续']],
  [['monetary policy', 'inflation', 'macroeconomic'], ['货币政策', '通货膨胀', '宏观经济']],
  [['mechanism', 'architecture', 'framework', 'survey'], ['机制', '架构', '框架', '综述']],
  [['memory', 'kv cache', 'caching'], ['记忆', '缓存', '显存']],
  [['privacy', 'federated learning', 'differential privacy'], ['隐私', '联邦学习', '差分隐私']],
  [['latency', 'throughput', 'efficiency', 'inference'], ['延迟', '吞吐量', '高效', '推理']],
];

const EN_TO_ZH = new Map<string, string[]>();
const ZH_TO_EN = new Map<string, string[]>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const [enTerms, zhTerms] of CONCEPT_PAIRS) {
  for (const en of enTerms) {
    const key = en.toLowerCase();
    const list = EN_TO_ZH.get(key) ?? [];
    for (const zh of zhTerms) {
      if (!list.includes(zh)) list.push(zh);
    }
    EN_TO_ZH.set(key, list);
  }
  for (const zh of zhTerms) {
    const list = ZH_TO_EN.get(zh) ?? [];
    for (const en of enTerms) {
      const low = en.toLowerCase();
      if (!list.includes(low)) list.push(low);
    }
    ZH_TO_EN.set(zh, list);
  }
}

const EN_CONCEPT_MATCHERS: Array<{ term: string; regex: RegExp; targets: string[] }> = Array.from(
  EN_TO_ZH.entries()
).map(([term, targets]) => ({
  term,
  regex: new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:$|[^a-z0-9])`),
  targets,
}));

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
  return tokenizeLowerCase(text.toLowerCase());
}

function tokenizeLowerCase(lower: string): string[] {
  const tokens: string[] = [];

  // Latin & alphanumeric tokens
  const latinMatches = lower.match(/[a-z0-9][a-z0-9._-]{1,}/g) || [];
  for (const w of latinMatches) {
    if (EN_STOPWORDS.has(w)) continue;
    tokens.push(w);
    const stemmed = lightStemEn(w);
    if (stemmed !== w && stemmed.length >= 3) {
      tokens.push(stemmed);
    }
  }

  // CJK tokens: standalone single chars (excluding grammatical particles) or 2-3 char grams without filler noise
  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) || [];
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

export interface ExpandedQueryTerms {
  directTokens: string[];
  bridgedTokens: string[];
  bridgedPhrases: string[];
  hasCrossLingualExpansion: boolean;
}

export function expandQueryCrossLingually(query: string): ExpandedQueryTerms {
  const lower = query.toLowerCase().trim();
  const directTokens = Array.from(new Set(tokenizeForLexical(lower)));
  const bridgedPhrases: string[] = [];
  const bridgedSet = new Set<string>();

  // Match Chinese concept terms -> expand to English terms
  for (const [zhTerm, enTargets] of ZH_TO_EN.entries()) {
    if (lower.includes(zhTerm)) {
      for (const en of enTargets) {
        bridgedPhrases.push(en);
        for (const t of tokenizeForLexical(en)) {
          bridgedSet.add(t);
        }
      }
    }
  }

  // Match English concept terms -> expand to Chinese terms (word-boundary safe so "world" != "rl", "model" != "ode")
  for (const matcher of EN_CONCEPT_MATCHERS) {
    if (matcher.regex.test(lower)) {
      for (const zh of matcher.targets) {
        bridgedPhrases.push(zh);
        for (const t of tokenizeForLexical(zh)) {
          bridgedSet.add(t);
        }
      }
    }
  }

  const directSet = new Set(directTokens);
  const bridgedTokens = Array.from(bridgedSet).filter((t) => !directSet.has(t));

  return {
    directTokens,
    bridgedTokens,
    bridgedPhrases: Array.from(new Set(bridgedPhrases)),
    hasCrossLingualExpansion: bridgedTokens.length > 0,
  };
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
  vocabulary?: Map<string, string>
) {
  const titleLower = (fields.title || '').toLowerCase();
  const metaLower = (fields.meta || '').toLowerCase();
  const bodyLower = (fields.body || '').toLowerCase();
  const combined = `${titleLower} ${metaLower} ${bodyLower}`;
  const collectTokens = (text: string) => {
    const tokens = Array.from(new Set(tokenizeLowerCase(text))).sort();
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
    titleLower,
    combined,
    docTokens: collectTokens(combined),
    titleTokens: collectTokens(titleLower),
    isCjk: hasCjk(combined),
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
      match = /^[a-z0-9]+$/.test(token) && editDistance(target, token) <= limit;
      matches.set(token, match);
    }
    if (match) return true;
  }
  return false;
}

export function createLexicalScorer(query: string, exp = expandQueryCrossLingually(query)) {
  const qLower = query.toLowerCase().trim();
  const queryIsCjk = hasCjk(qLower);
  const fuzzyMatches = new Map(exp.directTokens
    .filter((token) => token.length >= 5 && /^[a-z0-9]+$/.test(token))
    .map((token) => [token, new Map<string, boolean>()]));
  const maxDenominator = Math.max(2.5, exp.directTokens.length * 1.15 + (exp.bridgedTokens.length > 0 ? 1.5 : 0));

  return (doc: ReturnType<typeof prepareLexicalText>): { score: number; crossLingualHit: boolean } => {
    if (exp.directTokens.length === 0 && exp.bridgedTokens.length === 0) {
      return { score: 0, crossLingualHit: false };
    }
    const { titleLower, combined, titleTokens, docTokens, isCjk } = doc;

    let rawScore = 0;
    let directHits = 0;
    let bridgedHits = 0;

    if (qLower.length >= 2 && titleLower.includes(qLower)) {
      rawScore += 3.2;
    } else if (qLower.length >= 2 && combined.includes(qLower)) {
      rawScore += 1.8;
    }

    for (const tok of exp.directTokens) {
      if (tok.length === 1) {
        if (titleLower.includes(tok)) {
          rawScore += 0.45;
          directHits++;
        } else if (combined.includes(tok)) {
          rawScore += 0.25;
          directHits++;
        }
        continue;
      }
      if (containsToken(titleTokens, tok)) {
        rawScore += 1.6;
        directHits++;
      } else if (containsToken(docTokens, tok)) {
        rawScore += 0.95;
        directHits++;
      } else {
        const matches = fuzzyMatches.get(tok);
        if (!matches) continue;
        if (hasFuzzyMatch(titleTokens, tok, matches)) {
          rawScore += 0.9;
          directHits++;
        } else if (hasFuzzyMatch(docTokens, tok, matches)) {
          rawScore += 0.5;
          directHits++;
        }
      }
    }

    for (const phrase of exp.bridgedPhrases) {
      if (titleLower.includes(phrase)) {
        rawScore += 2.2;
        bridgedHits++;
      } else if (combined.includes(phrase)) {
        rawScore += 1.35;
        bridgedHits++;
      }
    }

    for (const tok of exp.bridgedTokens) {
      if (containsToken(titleTokens, tok)) {
        rawScore += tok.length >= 2 ? 1.0 : 0.3;
        bridgedHits++;
      } else if (containsToken(docTokens, tok)) {
        rawScore += tok.length >= 2 ? 0.55 : 0.15;
        bridgedHits++;
      }
    }

    const normalized = Math.min(1, rawScore / maxDenominator);
    const crossLingualHit =
      bridgedHits > 0 && (queryIsCjk !== isCjk || directHits === 0);

    return { score: normalized, crossLingualHit };
  };
}

export function scoreLexicalText(
  query: string,
  fields: { title?: string; meta?: string; body?: string },
  expanded?: ExpandedQueryTerms
): { score: number; crossLingualHit: boolean } {
  return createLexicalScorer(query, expanded)(prepareLexicalText(fields));
}

/**
 * Compute highlight character ranges [start, end] inside a snippet for safe DOM rendering.
 */
export function computeHighlightRanges(text: string, query: string): Array<[number, number]> {
  if (!text || !query) return [];
  const lowerText = text.toLowerCase();
  const exp = expandQueryCrossLingually(query);
  const candidates = new Set<string>();

  const qClean = query.trim().toLowerCase();
  if (qClean.length >= 2) candidates.add(qClean);
  for (const t of exp.directTokens) {
    if (t.length >= 2) candidates.add(t);
  }
  for (const p of exp.bridgedPhrases) {
    if (p.length >= 2) candidates.add(p);
  }
  for (const t of exp.bridgedTokens) {
    if (t.length >= 3) candidates.add(t);
  }

  const ranges: Array<[number, number]> = [];
  for (const term of candidates) {
    const isAscii = /^[a-z0-9 ._+-]+$/.test(term);
    let idx = lowerText.indexOf(term);
    let count = 0;
    while (idx !== -1 && count < 4) {
      const end = idx + term.length;
      const boundaryOk =
        !isAscii ||
        ((idx === 0 || !/[a-z0-9]/.test(lowerText[idx - 1])) &&
          (end === lowerText.length || !/[a-z0-9]/.test(lowerText[end])));
      if (boundaryOk || term.length >= 5) {
        ranges.push([idx, end]);
        count++;
      }
      idx = lowerText.indexOf(term, end);
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
