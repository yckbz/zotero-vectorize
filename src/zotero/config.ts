import type { EngineType, HfMirrorMode, PluginConfig, SearchMode, UiLanguage } from '../types/vectorize.ts';
import { DEFAULT_PDF_CHUNK_OVERLAP, DEFAULT_PDF_CHUNK_SIZE } from '../core/chunker.ts';

export const PLUGIN_ID = 'zotero-vectorize@yckbz.org';
export const PREF_BRANCH = 'extensions.zotero-vectorize.';

export const DEFAULT_CONFIG: PluginConfig = {
  engine: 'local-onnx',
  localModelId: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  localModelDir: '',
  localMirror: 'huggingface',
  localMaxSeqLength: 512,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'bge-m3',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  openaiModel: 'text-embedding-3-small',
  openaiDimensions: 0,
  openaiBatchSize: 0,
  chunkSize: DEFAULT_PDF_CHUNK_SIZE,
  chunkOverlap: DEFAULT_PDF_CHUNK_OVERLAP,
  maxPdfPages: 64,
  autoIndexOnStartup: true,
  autoIndexOnChange: true,
  defaultSearchMode: 'hybrid',
  hybridSemanticWeight: 0.85,
  normalizeNotation: false,
  maxResults: 12,
  enableTopSearchPopover: true,
  popoverMinChars: 2,
  commandPaletteShortcut: 'Mod+K',
  clearQuickSearchOnJump: false,
  uiLanguage: 'auto',
};

function getPrefRaw(key: keyof PluginConfig): unknown {
  if (typeof Zotero === 'undefined' || !Zotero?.Prefs) {
    return DEFAULT_CONFIG[key];
  }
  try {
    const val = Zotero.Prefs.get(PREF_BRANCH + key, true);
    return val === undefined ? DEFAULT_CONFIG[key] : val;
  } catch {
    return DEFAULT_CONFIG[key];
  }
}

function setPrefRaw(key: keyof PluginConfig, value: unknown): void {
  if (typeof Zotero === 'undefined' || !Zotero?.Prefs) return;
  try {
    if (key === 'hybridSemanticWeight') {
      Zotero.Prefs.set(PREF_BRANCH + key, String(value), true);
      return;
    }
    if (typeof DEFAULT_CONFIG[key] === 'number') {
      Zotero.Prefs.set(PREF_BRANCH + key, Math.round(Number(value) || 0), true);
      return;
    }
    if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      Zotero.Prefs.set(PREF_BRANCH + key, Boolean(value), true);
      return;
    }
    Zotero.Prefs.set(PREF_BRANCH + key, String(value ?? ''), true);
  } catch (e) {
    Zotero.logError(e);
  }
}

function readNumberPref(key: keyof PluginConfig, fallback: number, min: number, max: number): number {
  const raw = getPrefRaw(key);
  if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') {
    return fallback;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

export function readPluginConfig(): PluginConfig {
  const engineRaw = String(getPrefRaw('engine') || DEFAULT_CONFIG.engine);
  const engine: EngineType =
    engineRaw === 'ollama' || engineRaw === 'openai' || engineRaw === 'local-onnx'
      ? engineRaw
      : 'local-onnx';

  const mirrorRaw = String(getPrefRaw('localMirror') || DEFAULT_CONFIG.localMirror);
  const localMirror: HfMirrorMode = mirrorRaw === 'hf-mirror' ? 'hf-mirror' : 'huggingface';

  const modeRaw = String(getPrefRaw('defaultSearchMode') || DEFAULT_CONFIG.defaultSearchMode);
  const defaultSearchMode: SearchMode =
    modeRaw === 'metadata' || modeRaw === 'fulltext' || modeRaw === 'hybrid'
      ? modeRaw
      : 'hybrid';

  const langRaw = String(getPrefRaw('uiLanguage') || DEFAULT_CONFIG.uiLanguage);
  const uiLanguage: UiLanguage =
    langRaw === 'zh-CN' || langRaw === 'en-US' || langRaw === 'auto' ? langRaw : 'auto';

  const weightRaw = getPrefRaw('hybridSemanticWeight');
  const weightNum =
    weightRaw === '' || weightRaw === null || weightRaw === undefined || typeof weightRaw === 'boolean'
      ? NaN
      : Number(weightRaw);
  const hybridSemanticWeight = Number.isFinite(weightNum)
    ? Math.max(0, Math.min(1, weightNum))
    : DEFAULT_CONFIG.hybridSemanticWeight;

  return {
    engine,
    localModelId: String(getPrefRaw('localModelId') || DEFAULT_CONFIG.localModelId),
    localModelDir: String(getPrefRaw('localModelDir') || ''),
    localMirror,
    localMaxSeqLength: readNumberPref('localMaxSeqLength', DEFAULT_CONFIG.localMaxSeqLength, 64, 512),
    ollamaUrl: String(getPrefRaw('ollamaUrl') || DEFAULT_CONFIG.ollamaUrl),
    ollamaModel: String(getPrefRaw('ollamaModel') || DEFAULT_CONFIG.ollamaModel),
    openaiBaseUrl: String(getPrefRaw('openaiBaseUrl') || DEFAULT_CONFIG.openaiBaseUrl),
    openaiApiKey: String(getPrefRaw('openaiApiKey') || ''),
    openaiModel: String(getPrefRaw('openaiModel') || DEFAULT_CONFIG.openaiModel),
    openaiDimensions: readNumberPref('openaiDimensions', DEFAULT_CONFIG.openaiDimensions, 0, 8192),
    openaiBatchSize: readNumberPref('openaiBatchSize', DEFAULT_CONFIG.openaiBatchSize, 0, 256),
    chunkSize: readNumberPref('chunkSize', DEFAULT_CONFIG.chunkSize, 180, 2000),
    chunkOverlap: readNumberPref('chunkOverlap', DEFAULT_CONFIG.chunkOverlap, 0, 600),
    maxPdfPages: readNumberPref('maxPdfPages', DEFAULT_CONFIG.maxPdfPages, 0, 1000),
    autoIndexOnStartup: Boolean(getPrefRaw('autoIndexOnStartup')),
    autoIndexOnChange: Boolean(getPrefRaw('autoIndexOnChange')),
    defaultSearchMode,
    hybridSemanticWeight,
    normalizeNotation: Boolean(getPrefRaw('normalizeNotation')),
    maxResults: readNumberPref('maxResults', DEFAULT_CONFIG.maxResults, 3, 40),
    enableTopSearchPopover: Boolean(getPrefRaw('enableTopSearchPopover')),
    popoverMinChars: readNumberPref('popoverMinChars', DEFAULT_CONFIG.popoverMinChars, 1, 10),
    commandPaletteShortcut: String(getPrefRaw('commandPaletteShortcut') || 'Mod+K'),
    clearQuickSearchOnJump: Boolean(getPrefRaw('clearQuickSearchOnJump')),
    uiLanguage,
  };
}

export function writePluginConfig(partial: Partial<PluginConfig>): PluginConfig {
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) {
      setPrefRaw(k as keyof PluginConfig, v);
    }
  }
  return readPluginConfig();
}

export function resolveUiLocale(config?: PluginConfig): 'zh-CN' | 'en-US' {
  const cfg = config ?? readPluginConfig();
  if (cfg.uiLanguage === 'zh-CN') return 'zh-CN';
  if (cfg.uiLanguage === 'en-US') return 'en-US';
  const zLocale =
    (typeof Zotero !== 'undefined' && Zotero?.locale) ||
    (typeof navigator !== 'undefined' ? navigator.language : '') ||
    'en-US';
  return zLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function observeConfigChanges(handler: (config: PluginConfig) => void): () => void {
  if (typeof Zotero === 'undefined' || !Zotero?.Prefs?.registerObserver) {
    return () => {};
  }
  const keys = Object.keys(DEFAULT_CONFIG) as Array<keyof PluginConfig>;
  const symbols: symbol[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      handler(readPluginConfig());
    }, 80);
  };

  for (const key of keys) {
    try {
      const sym = Zotero.Prefs.registerObserver(PREF_BRANCH + key, trigger, true);
      symbols.push(sym);
    } catch {
      // Ignore individual observer registration failure
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const sym of symbols) {
      try {
        Zotero.Prefs.unregisterObserver(sym);
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}
