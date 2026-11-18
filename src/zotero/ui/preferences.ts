import type { EngineType, HfMirrorMode, SearchMode, UiLanguage } from '../../types/vectorize.ts';
import type { VectorizeService } from '../service.ts';
import { MODEL_PRESETS } from '../../engines/provider.ts';
import { resolveUiLocale } from '../config.ts';
import { getStrings } from '../i18n.ts';
import { el } from './render-utils.ts';

function getService(): VectorizeService | null {
  return (Zotero as any).Vectorize ?? null;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function pickFolder(win: any, title: string): Promise<string | null> {
  try {
    const mod = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
    if (mod?.FilePicker) {
      const fp = new mod.FilePicker();
      fp.init(win, title, fp.modeGetFolder);
      const rv = await fp.show();
      if (rv === fp.returnOK && fp.file) return String(fp.file);
      return null;
    }
  } catch {
    // Fallback to nsIFilePicker
  }
  try {
    const Ci = (Components as any).interfaces;
    const Cc = (Components as any).classes;
    const fp = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
    fp.init(win?.browsingContext || win, title, Ci.nsIFilePicker.modeGetFolder);
    return await new Promise((resolve) => {
      fp.open((res: number) => {
        resolve(res === Ci.nsIFilePicker.returnOK && fp.file ? String(fp.file.path) : null);
      });
    });
  } catch {
    return null;
  }
}

class VectorizePreferencesController {
  private container: HTMLElement | null = null;
  private initialized = false;
  private unsubProgress: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private statsSeq = 0;
  private progressFrame: number | null = null;
  private feedbackMessage = '';
  private feedbackKind: 'info' | 'ok' | 'err' = 'info';
  private busyAction = false;
  private downloadProgressText = '';

  onLoad(vboxEl?: Element): void {
    const doc = document;
    if (vboxEl && !this.initialized) {
      vboxEl.addEventListener('showing', () => this.onShowing());
      vboxEl.addEventListener('unload', () => this.onUnload());
    }
    const shell = doc.getElementById('zv-pref-shell');
    if (!shell) return;
    if (this.initialized && this.container === shell) return;
    this.container = shell;
    this.initialized = true;

    const svc = getService();
    if (svc && !this.unsubProgress) {
      this.subscribeToProgress(svc);
    }

    void this.renderAll();
  }

  onShowing(): void {
    if (!this.initialized) {
      this.onLoad(document.getElementById('zv-prefpane') || undefined);
      return;
    }
    void this.refreshStatsAndStatus();
  }

  onUnload(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.unsubProgress) {
      this.unsubProgress();
      this.unsubProgress = null;
    }
    if (this.progressFrame !== null) {
      window.cancelAnimationFrame(this.progressFrame);
      this.progressFrame = null;
    }
    this.statsSeq++;
    this.initialized = false;
    this.container = null;
  }

  private setFeedback(msg: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
    this.feedbackMessage = msg;
    this.feedbackKind = kind;
    const banner = document.getElementById('zv-pref-feedback');
    if (banner) {
      banner.textContent = msg;
      banner.className = `zv-pref-feedback is-${kind}`;
      banner.style.display = msg ? 'block' : 'none';
    }
  }

  private updateProgressDom(p: ReturnType<VectorizeService['getIndexProgress']>): void {
    const bar = document.getElementById('zv-pref-progress-fill') as HTMLElement | null;
    const text = document.getElementById('zv-pref-progress-text');
    const pauseBtn = document.getElementById('zv-btn-pause-resume') as HTMLButtonElement | null;
    const indexBtn = document.getElementById('zv-btn-index') as HTMLButtonElement | null;
    const rebuildBtn = document.getElementById('zv-btn-rebuild') as HTMLButtonElement | null;
    if (!bar || !text) return;

    const svc = getService();
    const s = getStrings(svc?.getConfig());

    const active = p.phase === 'indexing' || p.phase === 'scanning' || p.phase === 'paused';
    const pct = p.totalItems > 0 ? Math.min(100, Math.round((p.processedItems / p.totalItems) * 100)) : 0;
    bar.style.width = `${active ? Math.max(4, pct) : p.phase === 'completed' ? 100 : 0}%`;

    if (p.phase === 'indexing' || p.phase === 'scanning') {
      text.textContent = `${p.message} (${p.processedItems}/${p.totalItems}) ${p.currentTitle ? '· ' + p.currentTitle : ''}`;
    } else if (p.phase === 'paused') {
      text.textContent = `${p.message} (${p.processedItems}/${p.totalItems})`;
    } else if (p.phase === 'error') {
      text.textContent = p.lastError || p.message;
    } else {
      text.textContent = p.message || '';
    }

    if (pauseBtn) {
      pauseBtn.disabled = !active;
      pauseBtn.textContent = p.phase === 'paused' ? s.resumeIndex : s.pauseIndex;
    }
    if (indexBtn) indexBtn.disabled = active;
    if (rebuildBtn) rebuildBtn.disabled = active;
  }

  private subscribeToProgress(svc: VectorizeService): void {
    this.unsubProgress = svc.subscribeProgress((progress) => {
      if (this.progressFrame === null) {
        this.progressFrame = window.requestAnimationFrame(() => {
          this.progressFrame = null;
          this.updateProgressDom(svc.getIndexProgress());
        });
      }
      if (progress.phase === 'completed' || progress.phase === 'error') void this.refreshStatsAndStatus();
    });
  }

  private async refreshStatsAndStatus(): Promise<void> {
    const svc = getService();
    if (!svc || !this.container) return;
    const seq = ++this.statsSeq;
    let stats, status;
    try {
      [stats, status] = await Promise.all([svc.getStats(), svc.getEngineStatus()]);
    } catch (error) {
      if (seq === this.statsSeq) this.setFeedback(String(error), 'err');
      return;
    }
    if (seq !== this.statsSeq) return;
    const setTxt = (id: string, val: string) => {
      const node = document.getElementById(id);
      if (node) node.textContent = val;
    };
    setTxt('zv-stat-items', `${stats.vectorizedItems} / ${stats.indexedItems}`);
    setTxt('zv-stat-chunks', `${stats.vectorizedChunks} / ${stats.indexedChunks}`);
    setTxt('zv-stat-db', formatBytes(stats.dbSizeBytes));
    setTxt('zv-stat-fp', stats.modelFingerprint || status.modelFingerprint || '—');
    const pill = document.getElementById('zv-pref-engine-pill');
    if (pill) {
      pill.textContent = status.statusMessage;
      pill.className = `zv-pref-pill ${status.neuralAvailable ? 'is-ok' : 'is-warn'}`;
    }
  }

  private renderAll(): void {
    if (!this.container) return;
    const doc = document;
    const svc = getService();
    if (!svc) {
      this.container.textContent = getStrings().prefMsgInitializing;
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          const service = getService();
          if (this.container) {
            if (service && !this.unsubProgress) this.subscribeToProgress(service);
            void this.renderAll();
          }
        }, 250);
      }
      return;
    }

    const cfg = svc.getConfig();
    const s = getStrings(cfg);
    // Preserve Zotero's injected heading if already prepended inside .main-section
    const existingH1 = this.container.querySelector('h1');
    this.container.textContent = '';
    if (existingH1) {
      this.container.appendChild(existingH1);
    }

    // 0. Top privacy & status hero strip
    this.container.appendChild(
      el(doc, 'div', { className: 'zv-pref-hero' }, [
        el(doc, 'div', {}, [
          el(doc, 'div', { className: 'zv-pref-hero-sub' }, [s.brandSubtitle]),
          el(doc, 'div', { className: 'zv-pref-privacy' }, [s.prefPrivacyBadge]),
        ]),
        el(
          doc,
          'span',
          {
            id: 'zv-pref-engine-pill',
            className: 'zv-pref-pill',
          },
          []
        ),
      ])
    );

    const feedbackBox = el(doc, 'div', {
      id: 'zv-pref-feedback',
      className: `zv-pref-feedback is-${this.feedbackKind}`,
      style: this.feedbackMessage ? 'display:block' : 'display:none',
    }, [this.feedbackMessage]);
    this.container.appendChild(feedbackBox);

    // 1. Index Status & Controls Card
    const statCard = (label: string, id: string, val: string) =>
      el(doc, 'div', { className: 'zv-stat-tile' }, [
        el(doc, 'div', { className: 'zv-stat-value', id }, [val]),
        el(doc, 'div', { className: 'zv-stat-label' }, [label]),
      ]);

    const btnIndex = el(doc, 'button', { type: 'button', id: 'zv-btn-index', className: 'zv-btn zv-btn-primary' }, [
      s.buildIndexNow,
    ]);
    btnIndex.addEventListener('click', () => {
      void svc.startIndexing(false);
    });

    const btnPause = el(
      doc,
      'button',
      { type: 'button', id: 'zv-btn-pause-resume', className: 'zv-btn' },
      [s.pauseIndex]
    );
    btnPause.addEventListener('click', () => {
      const p = svc.getIndexProgress();
      if (p.phase === 'paused') svc.indexer.resume();
      else svc.indexer.pause();
    });

    const btnRebuild = el(doc, 'button', { type: 'button', id: 'zv-btn-rebuild', className: 'zv-btn' }, [s.rebuildIndex]);
    btnRebuild.addEventListener('click', () => {
      void svc.startIndexing(true);
    });

    const btnClear = el(doc, 'button', { type: 'button', className: 'zv-btn zv-btn-danger' }, [
      s.clearIndex,
    ]);
    btnClear.addEventListener('click', async () => {
      await svc.clearIndex();
      this.setFeedback(s.prefMsgCleared, 'ok');
      await this.refreshStatsAndStatus();
    });

    this.container.appendChild(
      el(doc, 'div', { className: 'zv-pref-card' }, [
        el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefStatusCardTitle]),
        el(doc, 'div', { className: 'zv-stat-grid' }, [
          statCard(s.prefItemVectorRatio, 'zv-stat-items', '—'),
          statCard(s.prefChunkVectorRatio, 'zv-stat-chunks', '—'),
          statCard(s.prefDbSize, 'zv-stat-db', '—'),
          statCard(s.prefActiveModel, 'zv-stat-fp', '—'),
        ]),
        el(doc, 'div', { className: 'zv-progress-track' }, [
          el(doc, 'div', { id: 'zv-pref-progress-fill', className: 'zv-progress-fill' }),
        ]),
        el(doc, 'div', { id: 'zv-pref-progress-text', className: 'zv-progress-text' }),
        el(doc, 'div', { className: 'zv-btn-row' }, [btnIndex, btnPause, btnRebuild, btnClear]),
      ])
    );

    // 2. Engine Selection & Config Card
    const engineSelect = el(doc, 'select', { className: 'zv-input' }, [
      el(doc, 'option', { value: 'local-onnx', selected: cfg.engine === 'local-onnx' }, [s.prefEngineLocal]),
      el(doc, 'option', { value: 'ollama', selected: cfg.engine === 'ollama' }, [s.prefEngineOllama]),
      el(doc, 'option', { value: 'openai', selected: cfg.engine === 'openai' }, [s.prefEngineOpenai]),
    ]) as HTMLSelectElement;
    engineSelect.value = cfg.engine;

    engineSelect.addEventListener('change', () => {
      svc.updateConfig({ engine: engineSelect.value as EngineType });
      void this.renderAll();
    });

    const engineBody = el(doc, 'div', { className: 'zv-engine-body' });

    if (cfg.engine === 'local-onnx') {
      const presets = MODEL_PRESETS.filter((p) => p.engine === 'local-onnx');
      const presetSelect = el(
        doc,
        'select',
        { className: 'zv-input' },
        presets.map((p) =>
          el(doc, 'option', { value: p.id, selected: cfg.localModelId === p.id }, [p.label])
        )
      ) as HTMLSelectElement;
      presetSelect.value = cfg.localModelId;
      presetSelect.addEventListener('change', () => {
        svc.updateConfig({ localModelId: presetSelect.value });
        void this.renderAll();
      });

      const selectedPreset = presets.find((p) => p.id === cfg.localModelId);
      const locale = resolveUiLocale(cfg);
      const presetDesc = el(doc, 'div', { className: 'zv-hint' }, [
        selectedPreset
          ? (locale === 'en-US' ? selectedPreset.descriptionEn : selectedPreset.descriptionZh)
          : '',
      ]);

      const mirrorSelect = el(doc, 'select', { className: 'zv-input' }, [
        el(doc, 'option', { value: 'huggingface', selected: cfg.localMirror === 'huggingface' }, [
          'HuggingFace Official (huggingface.co)',
        ]),
        el(doc, 'option', { value: 'hf-mirror', selected: cfg.localMirror === 'hf-mirror' }, [
          'HF-Mirror (hf-mirror.com · 国内加速)',
        ]),
      ]) as HTMLSelectElement;
      mirrorSelect.value = cfg.localMirror;
      mirrorSelect.addEventListener('change', () => {
        svc.updateConfig({ localMirror: mirrorSelect.value as HfMirrorMode });
      });

      const dirInput = el(doc, 'input', {
        type: 'text',
        className: 'zv-input',
        value: cfg.localModelDir,
        placeholder: `${svc.store.getStoreDir()}/models/...`,
      }) as HTMLInputElement;
      dirInput.addEventListener('change', () => {
        svc.updateConfig({ localModelDir: dirInput.value.trim() });
        void this.refreshStatsAndStatus();
      });

      const browseDirBtn = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [
        s.prefLocalBrowseDir,
      ]);
      browseDirBtn.addEventListener('click', async () => {
        const dir = await pickFolder(window, s.prefLocalCustomDir);
        if (dir) {
          dirInput.value = dir;
          svc.updateConfig({ localModelDir: dir });
          await this.refreshStatsAndStatus();
        }
      });

      const dlBtn = el(doc, 'button', { type: 'button', className: 'zv-btn zv-btn-primary' }, [
        this.downloadProgressText || s.prefDownloadModel,
      ]);
      dlBtn.addEventListener('click', async () => {
        if (this.busyAction) return;
        this.busyAction = true;
        dlBtn.disabled = true;
        try {
          await svc.downloadLocalModel((p) => {
            this.downloadProgressText = `${p.file} · ${p.percent}%`;
            dlBtn.textContent = this.downloadProgressText;
          });
          this.downloadProgressText = '';
          this.setFeedback(s.prefMsgModelReady(svc.getConfig().localModelId), 'ok');
          await this.refreshStatsAndStatus();
        } catch (err: any) {
          this.downloadProgressText = '';
          this.setFeedback(err?.message || String(err), 'err');
        } finally {
          this.busyAction = false;
          dlBtn.disabled = false;
          dlBtn.textContent = s.prefDownloadModel;
        }
      });

      const testBtn = this.buildTestConnBtn(doc, svc, s);

      engineBody.appendChild(this.fieldRow(doc, s.prefLocalModelPreset, presetSelect));
      if (selectedPreset) engineBody.appendChild(presetDesc);
      engineBody.appendChild(this.fieldRow(doc, s.prefLocalMirror, mirrorSelect));
      engineBody.appendChild(
        this.fieldRow(
          doc,
          s.prefLocalCustomDir,
          el(doc, 'div', { className: 'zv-inline-row' }, [dirInput, browseDirBtn])
        )
      );
      engineBody.appendChild(el(doc, 'div', { className: 'zv-btn-row' }, [dlBtn, testBtn]));
    } else if (cfg.engine === 'ollama') {
      const urlInput = el(doc, 'input', {
        type: 'text',
        className: 'zv-input',
        value: cfg.ollamaUrl,
      }) as HTMLInputElement;
      urlInput.addEventListener('change', () => {
        svc.updateConfig({ ollamaUrl: urlInput.value.trim() });
      });

      const modelInput = el(doc, 'input', {
        type: 'text',
        className: 'zv-input',
        value: cfg.ollamaModel,
        list: 'zv-ollama-models-list',
      }) as HTMLInputElement;
      modelInput.addEventListener('change', () => {
        svc.updateConfig({ ollamaModel: modelInput.value.trim() });
        void this.refreshStatsAndStatus();
      });

      const datalist = el(
        doc,
        'datalist',
        { id: 'zv-ollama-models-list' },
        MODEL_PRESETS.filter((p) => p.engine === 'ollama').map((p) =>
          el(doc, 'option', { value: p.id }, [p.label])
        )
      );

      const detectBtn = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [
        s.prefOllamaRefresh,
      ]);
      detectBtn.addEventListener('click', async () => {
        try {
          const models = await svc.detectOllamaModels();
          datalist.textContent = '';
          for (const m of models) {
            datalist.appendChild(el(doc, 'option', { value: m }, [m]));
          }
          this.setFeedback(
            models.length > 0 ? s.prefMsgOllamaModels(models.join(', ')) : s.prefMsgOllamaEmpty,
            'ok'
          );
        } catch (err: any) {
          this.setFeedback(err?.message || String(err), 'err');
        }
      });

      const testBtn = this.buildTestConnBtn(doc, svc, s);

      engineBody.appendChild(this.fieldRow(doc, s.prefOllamaUrl, urlInput));
      engineBody.appendChild(
        this.fieldRow(
          doc,
          s.prefOllamaModel,
          el(doc, 'div', { className: 'zv-inline-row' }, [modelInput, datalist, detectBtn])
        )
      );
      engineBody.appendChild(el(doc, 'div', { className: 'zv-btn-row' }, [testBtn]));
    } else {
      const baseInput = el(doc, 'input', {
        type: 'text',
        className: 'zv-input',
        value: cfg.openaiBaseUrl,
      }) as HTMLInputElement;
      baseInput.addEventListener('change', () => {
        svc.updateConfig({ openaiBaseUrl: baseInput.value.trim() });
      });

      const keyInput = el(doc, 'input', {
        type: 'password',
        className: 'zv-input',
        value: cfg.openaiApiKey,
        placeholder: 'sk-...',
      }) as HTMLInputElement;
      keyInput.addEventListener('change', () => {
        svc.updateConfig({ openaiApiKey: keyInput.value.trim() });
        void this.refreshStatsAndStatus();
      });

      const modelInput = el(doc, 'input', {
        type: 'text',
        className: 'zv-input',
        value: cfg.openaiModel,
        list: 'zv-openai-models-list',
      }) as HTMLInputElement;
      modelInput.addEventListener('change', () => {
        svc.updateConfig({ openaiModel: modelInput.value.trim() });
        void this.refreshStatsAndStatus();
      });

      const datalist = el(
        doc,
        'datalist',
        { id: 'zv-openai-models-list' },
        MODEL_PRESETS.filter((p) => p.engine === 'openai').map((p) =>
          el(doc, 'option', { value: p.id }, [p.label])
        )
      );

      const dimInput = el(doc, 'input', {
        type: 'number',
        className: 'zv-input',
        min: 0,
        max: 4096,
        value: cfg.openaiDimensions,
      }) as HTMLInputElement;
      dimInput.addEventListener('change', () => {
        svc.updateConfig({ openaiDimensions: Math.max(0, Number(dimInput.value) || 0) });
      });

      const testBtn = this.buildTestConnBtn(doc, svc, s);

      engineBody.appendChild(this.fieldRow(doc, s.prefOpenaiBaseUrl, baseInput));
      engineBody.appendChild(this.fieldRow(doc, s.prefOpenaiApiKey, keyInput));
      engineBody.appendChild(this.fieldRow(doc, s.prefOpenaiModel, el(doc, 'div', {}, [modelInput, datalist])));
      engineBody.appendChild(this.fieldRow(doc, s.prefOpenaiDimensions, dimInput));
      engineBody.appendChild(el(doc, 'div', { className: 'zv-btn-row' }, [testBtn]));
    }

    this.container.appendChild(
      el(doc, 'div', { className: 'zv-pref-card' }, [
        el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefEngineSectionTitle]),
        this.fieldRow(doc, s.prefEngineLabel, engineSelect),
        engineBody,
      ])
    );

    // 3. Chunking & Auto-indexing Card
    const chunkSizeInput = this.numberInput(doc, cfg.chunkSize, 180, 2000, (v) =>
      svc.updateConfig({ chunkSize: v })
    );
    const chunkOverlapInput = this.numberInput(doc, cfg.chunkOverlap, 0, 600, (v) =>
      svc.updateConfig({ chunkOverlap: v })
    );
    const maxPagesInput = this.numberInput(doc, cfg.maxPdfPages, 0, 1000, (v) =>
      svc.updateConfig({ maxPdfPages: v })
    );
    const autoStartupChk = this.checkboxRow(doc, s.prefAutoStartup, cfg.autoIndexOnStartup, (v) =>
      svc.updateConfig({ autoIndexOnStartup: v })
    );
    const autoChangeChk = this.checkboxRow(doc, s.prefAutoChange, cfg.autoIndexOnChange, (v) =>
      svc.updateConfig({ autoIndexOnChange: v })
    );

    this.container.appendChild(
      el(doc, 'div', { className: 'zv-pref-card' }, [
        el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefIndexingSectionTitle]),
        el(doc, 'div', { className: 'zv-grid-3' }, [
          this.fieldRow(doc, s.prefChunkSize, chunkSizeInput),
          this.fieldRow(doc, s.prefChunkOverlap, chunkOverlapInput),
          this.fieldRow(doc, s.prefMaxPdfPages, maxPagesInput),
        ]),
        autoStartupChk,
        autoChangeChk,
      ])
    );

    // 4. Search UX & Language Card
    const defaultModeSel = el(doc, 'select', { className: 'zv-input' }, [
      el(doc, 'option', { value: 'hybrid', selected: cfg.defaultSearchMode === 'hybrid' }, [s.modeHybrid]),
      el(doc, 'option', { value: 'metadata', selected: cfg.defaultSearchMode === 'metadata' }, [s.modeMetadata]),
      el(doc, 'option', { value: 'fulltext', selected: cfg.defaultSearchMode === 'fulltext' }, [s.modeFulltext]),
    ]) as HTMLSelectElement;
    defaultModeSel.value = cfg.defaultSearchMode;
    defaultModeSel.addEventListener('change', () => {
      svc.updateConfig({ defaultSearchMode: defaultModeSel.value as SearchMode });
    });

    const langSel = el(doc, 'select', { className: 'zv-input' }, [
      el(doc, 'option', { value: 'auto', selected: cfg.uiLanguage === 'auto' }, ['Auto']),
      el(doc, 'option', { value: 'zh-CN', selected: cfg.uiLanguage === 'zh-CN' }, ['简体中文']),
      el(doc, 'option', { value: 'en-US', selected: cfg.uiLanguage === 'en-US' }, ['English']),
    ]) as HTMLSelectElement;
    langSel.value = cfg.uiLanguage;
    langSel.addEventListener('change', () => {
      svc.updateConfig({ uiLanguage: langSel.value as UiLanguage });
      void this.renderAll();
    });

    const weightInput = el(doc, 'input', {
      type: 'range',
      min: 0,
      max: 1,
      step: 0.04,
      value: cfg.hybridSemanticWeight,
      style: 'width:100%;accent-color:#D97757;',
    }) as HTMLInputElement;
    const weightVal = el(doc, 'span', { className: 'zv-hint', style: 'min-width:36px;text-align:right;' }, [
      cfg.hybridSemanticWeight.toFixed(2),
    ]);
    weightInput.addEventListener('input', () => {
      const val = Number(weightInput.value);
      weightVal.textContent = val.toFixed(2);
      svc.updateConfig({ hybridSemanticWeight: val });
    });

    const popoverChk = this.checkboxRow(doc, s.prefEnablePopover, cfg.enableTopSearchPopover, (v) =>
      svc.updateConfig({ enableTopSearchPopover: v })
    );
    const clearJumpChk = this.checkboxRow(doc, s.prefClearOnJump, cfg.clearQuickSearchOnJump, (v) =>
      svc.updateConfig({ clearQuickSearchOnJump: v })
    );

    this.container.appendChild(
      el(doc, 'div', { className: 'zv-pref-card' }, [
        el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefUiSectionTitle]),
        el(doc, 'div', { className: 'zv-grid-2' }, [
          this.fieldRow(doc, s.prefDefaultMode, defaultModeSel),
          this.fieldRow(doc, s.prefLanguage, langSel),
        ]),
        this.fieldRow(
          doc,
          s.prefSemanticWeight,
          el(doc, 'div', { className: 'zv-inline-row' }, [weightInput, weightVal])
        ),
        popoverChk,
        clearJumpChk,
      ])
    );

    // 5. JSON Import / Export Card (standard 3-file vector JSON format)
    const exportBtn = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [s.prefExportJson]) as HTMLButtonElement;
    exportBtn.addEventListener('click', async () => {
      if (this.busyAction) return;
      const dir = await pickFolder(window, s.prefExportJson);
      if (!dir) return;
      this.busyAction = true;
      exportBtn.disabled = true;
      this.setFeedback(s.prefMsgWorking, 'info');
      try {
        const res = await svc.exportCompatJsonToFolder(dir);
        this.setFeedback(s.prefMsgExported(res.items, res.chunks, dir), 'ok');
      } catch (err: any) {
        this.setFeedback(err?.message || String(err), 'err');
      } finally {
        this.busyAction = false;
        exportBtn.disabled = false;
      }
    });

    const importBtn = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [s.prefImportJson]) as HTMLButtonElement;
    importBtn.addEventListener('click', async () => {
      if (this.busyAction) return;
      const dir = await pickFolder(window, s.prefImportJson);
      if (!dir) return;
      this.busyAction = true;
      importBtn.disabled = true;
      this.setFeedback(s.prefMsgWorking, 'info');
      try {
        const res = await svc.importCompatJsonFromFolder(dir);
        this.setFeedback(
          s.prefMsgImported(res.importedItems, res.importedChunks, res.skippedItems, res.skippedChunks),
          'ok'
        );
        await this.refreshStatsAndStatus();
      } catch (err: any) {
        this.setFeedback(err?.message || String(err), 'err');
      } finally {
        this.busyAction = false;
        importBtn.disabled = false;
      }
    });

    this.container.appendChild(
      el(doc, 'div', { className: 'zv-pref-card' }, [
        el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefCompatSectionTitle]),
        el(doc, 'div', { className: 'zv-hint' }, [s.prefCompatHint]),
        el(doc, 'div', { className: 'zv-btn-row' }, [importBtn, exportBtn]),
      ])
    );

    this.updateProgressDom(svc.getIndexProgress());
    void this.refreshStatsAndStatus();
  }

  private buildTestConnBtn(doc: Document, svc: VectorizeService, s: ReturnType<typeof getStrings>) {
    const btn = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [s.prefTestConnection]);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await svc.testConnection();
        this.setFeedback(res.message, res.ok ? 'ok' : 'err');
        await this.refreshStatsAndStatus();
      } catch (err: any) {
        this.setFeedback(err?.message || String(err), 'err');
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }

  private fieldRow(doc: Document, label: string, control: HTMLElement): HTMLElement {
    return el(doc, 'div', { className: 'zv-field' }, [
      el(doc, 'label', { className: 'zv-label' }, [label]),
      control,
    ]);
  }

  private numberInput(
    doc: Document,
    initial: number,
    min: number,
    max: number,
    onChange: (val: number) => void
  ): HTMLInputElement {
    const input = el(doc, 'input', {
      type: 'number',
      className: 'zv-input',
      min,
      max,
      value: initial,
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const n = Math.max(min, Math.min(max, Number(input.value) || min));
      input.value = String(n);
      onChange(n);
    });
    return input;
  }

  private checkboxRow(
    doc: Document,
    label: string,
    checked: boolean,
    onChange: (val: boolean) => void
  ): HTMLElement {
    const chk = el(doc, 'input', { type: 'checkbox', checked }) as HTMLInputElement;
    chk.checked = checked;
    chk.addEventListener('change', () => onChange(chk.checked));
    return el(doc, 'label', { className: 'zv-check-row' }, [chk, el(doc, 'span', {}, [label])]);
  }
}

const controller = new VectorizePreferencesController();
(globalThis as any).ZoteroVectorizePrefs = controller;
if (typeof window !== 'undefined') {
  (window as any).ZoteroVectorizePrefs = controller;
}

// Auto-mount if fragment already exists when script executes
queueMicrotask(() => {
  const vbox = document.getElementById('zv-prefpane');
  if (vbox) {
    controller.onLoad(vbox);
  }
});
