import type { EngineType, HfMirrorMode, PluginConfig, SearchMode, UiLanguage } from '../../types/vectorize.ts';
import type { EmbeddingProfileStats } from '../embedding-profile.ts';
import { embeddingSettings } from '../embedding-profile.ts';
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

async function pickPath(title: string, mode: 'folder' | 'open' | 'save'): Promise<string | null> {
  const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
  const picker = new FilePicker();
  picker.init(window, title, mode === 'folder' ? picker.modeGetFolder : mode === 'open' ? picker.modeOpen : picker.modeSave);
  if (mode !== 'folder') picker.appendFilter('SQLite', '*.sqlite');
  if (mode === 'save') {
    picker.defaultString = 'zotero-vectorize-index.sqlite';
    picker.defaultExtension = 'sqlite';
  }
  const result = await picker.show();
  return (result === picker.returnOK || result === picker.returnReplace) && picker.file ? String(picker.file) : null;
}

function choose<T extends string>(parent: HTMLElement, title: string, options: Array<[T, string]>,
  cancel: string, details?: string): Promise<T | null> {
  const doc = parent.ownerDocument;
  const dialog = el(doc, 'dialog', { className: 'zv-pref-dialog', 'aria-label': title });
  dialog.appendChild(el(doc, 'h2', { className: 'zv-pref-h2' }, [title]));
  if (details) dialog.appendChild(el(doc, 'p', { className: 'zv-hint' }, [details]));
  const actions = el(doc, 'div', { className: 'zv-btn-row' });
  for (const [value, label] of options) {
    const button = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [label]);
    button.addEventListener('click', () => dialog.close(value));
    actions.appendChild(button);
  }
  const cancelButton = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [cancel]);
  cancelButton.addEventListener('click', () => dialog.close());
  actions.appendChild(cancelButton);
  dialog.appendChild(actions);
  parent.appendChild(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const selected = options.find(([value]) => value === dialog.returnValue);
      dialog.remove();
      resolve(selected?.[0] ?? null);
    }, { once: true });
    dialog.showModal();
  });
}

class VectorizePreferencesController {
  private container: HTMLElement | null = null;
  private initialized = false;
  private unsubProgress: (() => void) | null = null;
  private unsubWrites: (() => void) | null = null;
  private unsubSync: (() => void) | null = null;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private statsSeq = 0;
  private progressFrame: number | null = null;
  private feedbackMessage = '';
  private feedbackKind: 'info' | 'ok' | 'err' = 'info';
  private busyAction = false;
  private engineDraft: PluginConfig | null = null;
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
    const svc = getService();
    if (svc?.indexSync) this.updateSharedIndex(svc);
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
    this.unsubWrites?.();
    this.unsubWrites = null;
    this.unsubSync?.();
    this.unsubSync = null;
    this.cancelScheduledStats();
    if (this.progressFrame !== null) {
      window.cancelAnimationFrame(this.progressFrame);
      this.progressFrame = null;
    }
    this.statsSeq++;
    this.initialized = false;
    this.container = null;
    this.engineDraft = null;
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
    const pct = p.stage === 'metadata' && p.totalItems > 0 ? Math.min(100, Math.round((p.processedItems / p.totalItems) * 100)) : 0;
    bar.classList.toggle('is-indeterminate', active && p.stage === 'fulltext' && p.phase !== 'paused');
    bar.style.width = `${active ? Math.max(4, pct) : p.phase === 'completed' ? 100 : 0}%`;

    if (p.phase === 'indexing' || p.phase === 'scanning') {
      text.textContent = p.stage
        ? s.prefIndexStage(p.message, p.processedItems, p.totalItems, p.processedAttachments, p.embeddedChunks)
        : p.message;
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
    this.unsubWrites = svc.store.subscribeWrites(() => {
      if (this.statsTimer !== null) return;
      this.statsTimer = setTimeout(() => {
        this.statsTimer = null;
        void this.refreshStatsAndStatus();
      }, 1000);
    });
    this.unsubProgress = svc.subscribeProgress((progress) => {
      if (this.progressFrame === null) {
        this.progressFrame = window.requestAnimationFrame(() => {
          this.progressFrame = null;
          this.updateProgressDom(svc.getIndexProgress());
        });
      }
      if (progress.phase === 'completed' || progress.phase === 'incomplete' || progress.phase === 'error') {
        this.cancelScheduledStats();
        void this.refreshStatsAndStatus();
      }
    });
  }

  private cancelScheduledStats(): void {
    if (this.statsTimer !== null) {
      clearTimeout(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private updateSharedIndex(svc: VectorizeService): void {
    const card = document.getElementById('zv-shared-index');
    if (!card) return;
    const stats = svc.indexSync.getSharedStats();
    card.hidden = !stats;
    if (!stats) return;

    const config = svc.getConfig();
    const s = getStrings(config);
    const { phase } = svc.indexSync.getStatus();
    const fields = {
      'zv-shared-items': `${stats.vectorizedItems} / ${stats.indexedItems}`,
      'zv-shared-chunks': `${stats.vectorizedChunks} / ${stats.indexedChunks}`,
      'zv-shared-model': stats.modelFingerprint,
      'zv-shared-published': new Date(stats.publishedAt).toLocaleString(resolveUiLocale(config)),
      'zv-shared-index-cache': phase === 'ready' ? '' : phase === 'working' ? s.prefSharedChecking : s.prefSharedCached,
    };
    for (const [id, value] of Object.entries(fields)) {
      const node = document.getElementById(id);
      if (!node) continue;
      node.textContent = value;
      if (id === 'zv-shared-model' || id === 'zv-shared-published') node.title = value;
    }
  }

  private async refreshStatsAndStatus(): Promise<void> {
    const svc = getService();
    if (!svc || !this.container) return;
    const seq = ++this.statsSeq;
    let stats, status, profiles: EmbeddingProfileStats[] = [];
    try {
      status = await svc.getEngineStatus();
      stats = await svc.getStats(status);
      if (document.getElementById('zv-model-indexes')) profiles = await svc.listEmbeddingProfiles();
    } catch (error) {
      const notice = document.getElementById('zv-index-read-error');
      if (seq === this.statsSeq && notice) {
        const detail = error instanceof Error ? error.message : String(error);
        notice.textContent = getStrings(svc.getConfig()).prefIndexReadError(detail);
      }
      return;
    }
    if (seq !== this.statsSeq) return;
    const setTxt = (id: string, val: string) => {
      const node = document.getElementById(id);
      if (node) node.textContent = val;
    };
    setTxt('zv-index-read-error', '');
    setTxt('zv-stat-items', `${stats.vectorizedItems} / ${stats.indexedItems}`);
    setTxt('zv-stat-chunks', `${stats.vectorizedChunks} / ${stats.indexedChunks}`);
    setTxt('zv-stat-db', formatBytes(stats.dbSizeBytes));
    setTxt('zv-stat-fp', status.modelFingerprint || '—');
    const s = getStrings(svc.getConfig());
    this.renderProfiles(svc, profiles, stats.indexedItems, stats.indexedChunks);
    const unfinished = stats.pendingAttachments + stats.failedAttachments;
    setTxt('zv-stat-attachment-issues', unfinished || stats.missingAttachments || stats.noTextAttachments
      ? s.indexAttachmentIssues(unfinished, stats.missingAttachments, stats.noTextAttachments)
      : '');
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
      if (!this.container || !await choose(this.container, s.clearIndex, [['clear', s.clearIndex]], s.prefCancel, s.prefClearAllHint)) return;
      await svc.clearIndex();
      this.setFeedback(s.prefMsgCleared, 'ok');
      await this.refreshStatsAndStatus();
    });

    this.container.appendChild(el(doc, 'section', { id: 'zv-shared-index', className: 'zv-pref-card', hidden: true }, [
      el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefSharedIndexTitle]),
      el(doc, 'div', { className: 'zv-stat-grid' }, [
        statCard(s.prefSharedItems, 'zv-shared-items', '—'),
        statCard(s.prefSharedChunks, 'zv-shared-chunks', '—'),
        statCard(s.prefActiveModel, 'zv-shared-model', '—'),
        statCard(s.prefSharedPublishedAt, 'zv-shared-published', '—'),
      ]),
      el(doc, 'div', { id: 'zv-shared-index-cache', className: 'zv-progress-text', role: 'status' }),
    ]));

    this.container.appendChild(
      el(doc, 'div', { className: 'zv-pref-card' }, [
        el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefStatusCardTitle]),
        el(doc, 'div', { id: 'zv-index-read-error', className: 'zv-pref-feedback is-err', role: 'status' }),
        el(doc, 'div', { className: 'zv-stat-grid' }, [
          statCard(s.prefItemVectorRatio, 'zv-stat-items', '—'),
          statCard(s.prefChunkVectorRatio, 'zv-stat-chunks', '—'),
          statCard(s.prefDbSize, 'zv-stat-db', '—'),
          statCard(s.prefActiveModel, 'zv-stat-fp', '—'),
        ]),
        el(doc, 'div', { id: 'zv-stat-attachment-issues', className: 'zv-progress-text' }),
        el(doc, 'div', { className: 'zv-progress-track' }, [
          el(doc, 'div', { id: 'zv-pref-progress-fill', className: 'zv-progress-fill' }),
        ]),
        el(doc, 'div', { id: 'zv-pref-progress-text', className: 'zv-progress-text' }),
        el(doc, 'div', { className: 'zv-btn-row' }, [btnIndex, btnPause, btnRebuild, btnClear]),
      ])
    );

    // 2. Engine Selection & Config Card
    const draft = this.engineDraft ??= { ...cfg };
    const engineSelect = el(doc, 'select', { className: 'zv-input' }, [
      el(doc, 'option', { value: 'local-onnx', selected: draft.engine === 'local-onnx' }, [s.prefEngineLocal]),
      el(doc, 'option', { value: 'ollama', selected: draft.engine === 'ollama' }, [s.prefEngineOllama]),
      el(doc, 'option', { value: 'openai', selected: draft.engine === 'openai' }, [s.prefEngineOpenai]),
    ]) as HTMLSelectElement;
    engineSelect.value = draft.engine;

    engineSelect.addEventListener('change', () => {
      draft.engine = engineSelect.value as EngineType;
      void this.renderAll();
    });

    const engineBody = el(doc, 'div', { className: 'zv-engine-body' });

    if (draft.engine === 'local-onnx') {
      const presets = MODEL_PRESETS.filter((p) => p.engine === 'local-onnx');
      const presetSelect = el(
        doc,
        'select',
        { className: 'zv-input' },
        presets.map((p) =>
          el(doc, 'option', { value: p.id, selected: draft.localModelId === p.id }, [p.label])
        )
      ) as HTMLSelectElement;
      presetSelect.value = draft.localModelId;
      presetSelect.addEventListener('change', () => {
        draft.localModelId = presetSelect.value;
        void this.renderAll();
      });

      const selectedPreset = presets.find((p) => p.id === draft.localModelId);
      const locale = resolveUiLocale(cfg);
      const presetDesc = el(doc, 'div', { className: 'zv-hint' }, [
        selectedPreset
          ? (locale === 'en-US' ? selectedPreset.descriptionEn : selectedPreset.descriptionZh)
          : '',
      ]);

      const mirrorSelect = el(doc, 'select', { className: 'zv-input' }, [
        el(doc, 'option', { value: 'huggingface' }, [
          'HuggingFace Official (huggingface.co)',
        ]),
        el(doc, 'option', { value: 'hf-mirror' }, [
          'HF-Mirror (hf-mirror.com · 国内加速)',
        ]),
      ]) as HTMLSelectElement;
      mirrorSelect.value = cfg.localMirror;
      mirrorSelect.addEventListener('change', () => {
        mirrorSelect.value = svc.updateConfig({ localMirror: mirrorSelect.value as HfMirrorMode }).localMirror;
      });

      const dirInput = el(doc, 'input', {
        type: 'text',
        className: 'zv-input',
        value: draft.localModelDir,
        placeholder: `${svc.store.getStoreDir()}/models/...`,
      }) as HTMLInputElement;
      dirInput.addEventListener('change', () => {
        draft.localModelDir = dirInput.value.trim();
      });

      const browseDirBtn = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [
        s.prefLocalBrowseDir,
      ]);
      browseDirBtn.addEventListener('click', async () => {
        const dir = await pickPath(s.prefLocalCustomDir, 'folder');
        if (dir) {
          dirInput.value = dir;
          draft.localModelDir = dir;
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
          }, { ...draft, localMirror: svc.getConfig().localMirror });
          this.downloadProgressText = '';
          this.setFeedback(s.prefMsgModelReady(draft.localModelId), 'ok');
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

      const testBtn = this.buildTestConnBtn(doc, svc, s, draft);

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
    } else if (draft.engine === 'ollama') {
      const urlInput = el(doc, 'input', {
        type: 'text',
        className: 'zv-input',
        value: draft.ollamaUrl,
      }) as HTMLInputElement;
      urlInput.addEventListener('change', () => {
        draft.ollamaUrl = urlInput.value.trim();
      });

      const modelInput = el(doc, 'input', {
        type: 'text',
        className: 'zv-input',
        value: draft.ollamaModel,
        list: 'zv-ollama-models-list',
      }) as HTMLInputElement;
      modelInput.addEventListener('change', () => {
        draft.ollamaModel = modelInput.value.trim();
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
          const models = await svc.detectOllamaModels(draft);
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

      const testBtn = this.buildTestConnBtn(doc, svc, s, draft);

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
        value: draft.openaiBaseUrl,
      }) as HTMLInputElement;
      baseInput.addEventListener('change', () => {
        draft.openaiBaseUrl = baseInput.value.trim();
      });

      const keyInput = el(doc, 'input', {
        type: 'password',
        className: 'zv-input',
        value: draft.openaiApiKey,
        placeholder: 'sk-...',
      }) as HTMLInputElement;
      keyInput.addEventListener('change', () => {
        draft.openaiApiKey = keyInput.value.trim();
      });

      const modelInput = el(doc, 'input', {
        type: 'text',
        className: 'zv-input',
        value: draft.openaiModel,
        list: 'zv-openai-models-list',
      }) as HTMLInputElement;
      modelInput.addEventListener('change', () => {
        draft.openaiModel = modelInput.value.trim();
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
        max: 8192,
        value: draft.openaiDimensions,
      }) as HTMLInputElement;
      dimInput.addEventListener('change', () => {
        draft.openaiDimensions = Math.max(0, Number(dimInput.value) || 0);
      });

      const batchInput = this.numberInput(doc, draft.openaiBatchSize, 0, 256, (value) => {
        draft.openaiBatchSize = value;
      });
      const testBtn = this.buildTestConnBtn(doc, svc, s, draft);

      engineBody.appendChild(this.fieldRow(doc, s.prefOpenaiBaseUrl, baseInput));
      engineBody.appendChild(this.fieldRow(doc, s.prefOpenaiApiKey, keyInput));
      engineBody.appendChild(this.fieldRow(doc, s.prefOpenaiModel, el(doc, 'div', {}, [modelInput, datalist])));
      engineBody.appendChild(this.fieldRow(doc, s.prefOpenaiDimensions, dimInput));
      engineBody.appendChild(this.fieldRow(doc, s.prefOpenaiBatchSize, batchInput));
      engineBody.appendChild(el(doc, 'div', { className: 'zv-btn-row' }, [testBtn]));
    }

    const apply = el(doc, 'button', { type: 'button', className: 'zv-btn zv-btn-primary' }, [s.prefApplyModel]);
    apply.addEventListener('click', async () => {
      if (this.busyAction || !this.container) return;
      const target = { ...draft };
      this.busyAction = true;
      apply.disabled = true;
      try {
        let discard = false;
        const active = (await svc.listEmbeddingProfiles()).find((profile) => profile.active);
        if (active && (active.items || active.chunks) && embeddingSettings(target) !== embeddingSettings(svc.getConfig())) {
          const choice = await choose(this.container, s.prefApplyModel,
            [['keep', s.prefKeepModel], ['discard', s.prefDiscardModel]], s.prefCancel, s.prefSwitchModelHint(active.model));
          if (!choice) return;
          discard = choice === 'discard';
        }
        await svc.applyEmbeddingConfig(target, discard);
        this.engineDraft = null;
        this.setFeedback(s.prefModelApplied, 'ok');
        this.renderAll();
      } catch (error) {
        this.setFeedback(error instanceof Error ? error.message : String(error), 'err');
      } finally {
        this.busyAction = false;
        apply.disabled = false;
      }
    });
    this.container.appendChild(
      el(doc, 'div', { className: 'zv-pref-card' }, [
        el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefEngineSectionTitle]),
        this.fieldRow(doc, s.prefEngineLabel, engineSelect),
        engineBody,
        el(doc, 'div', { className: 'zv-btn-row' }, [apply]),
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
        this.checkboxRow(doc, s.prefNormalizeNotation, cfg.normalizeNotation, (value) =>
          svc.updateConfig({ normalizeNotation: value })
        ),
        popoverChk,
        clearJumpChk,
      ])
    );

    const importButton = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [s.prefIndexImport]);
    const exportButton = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [s.prefIndexExport]);
    importButton.addEventListener('click', () => void this.transferIndex(svc, true));
    exportButton.addEventListener('click', () => void this.transferIndex(svc, false));
    this.container.appendChild(el(doc, 'div', { className: 'zv-pref-card' }, [
      el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefIndexManager]),
      el(doc, 'div', { className: 'zv-hint' }, [s.prefIndexManagerHint]),
      el(doc, 'div', { id: 'zv-model-indexes' }),
      el(doc, 'div', { className: 'zv-btn-row' }, [importButton, exportButton]),
    ]));

    this.unsubSync?.();
    if (svc.indexSync) {
      const sync = svc.indexSync;
      const state = el(doc, 'p', { className: 'zv-hint', role: 'status' });
      const button = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [s.prefIndexSyncNow]) as HTMLButtonElement;
      const role = el(doc, 'select', { 'aria-label': s.prefIndexSyncTitle },
        Object.entries(s.prefIndexSyncRole).map(([value, label]) => el(doc, 'option', { value }, [label]))) as HTMLSelectElement;
      const size = el(doc, 'select', { 'aria-label': s.prefIndexSyncPartSize },
        sync.partSizesMiB.map((value) => el(doc, 'option', { value: String(value) }, [value + ' MiB']))) as HTMLSelectElement;
      size.disabled = sync.partSizesMiB.length === 1;
      const advanced = el(doc, 'details', { className: 'zv-sync-advanced' }, [
        el(doc, 'summary', {}, [s.prefIndexSyncAdvanced]),
        this.fieldRow(doc, s.prefIndexSyncPartSize, size),
      ]);
      const update = () => {
        const status = sync.getStatus();
        role.value = status.role;
        size.value = String(sync.getPartSizeMiB());
        advanced.hidden = status.role !== 'publish';
        if (advanced.hidden) advanced.open = false;
        button.disabled = status.role === 'off' || status.phase === 'working';
        state.textContent = status.role === 'receive' && status.phase === 'ready'
          ? s.prefSharedReady : s.prefIndexSyncState[status.phase];
        this.updateSharedIndex(svc);
      };
      role.addEventListener('change', () => {
        const value = role.value;
        if (value !== 'off' && value !== 'publish' && value !== 'receive') return;
        try {
          sync.setRole(value);
          update();
        } catch {
          update();
          state.textContent = s.prefIndexSyncState.error;
        }
      });
      size.addEventListener('change', () => {
        sync.setPartSizeMiB(Number(size.value));
        update();
      });
      button.addEventListener('click', () => void sync.syncNow());
      this.unsubSync = sync.subscribe(update);
      update();
      this.container.appendChild(el(doc, 'div', { className: 'zv-pref-card' }, [
        el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefIndexSyncTitle]),
        el(doc, 'p', { className: 'zv-hint' }, [s.prefIndexSyncHint]),
        el(doc, 'div', { className: 'zv-btn-row' }, [role, button]),
        advanced,
        state,
      ]));
    }

    const mcp = Zotero.VectorizeMcp;
    if (mcp) {
      const toggle = el(doc, 'input', { type: 'checkbox' }) as HTMLInputElement;
      const copy = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [s.prefMcpCopy]) as HTMLButtonElement;
      const status = el(doc, 'div', { className: 'zv-hint', role: 'status' });
      const update = () => {
        const state = mcp.getState();
        toggle.checked = state.running;
        copy.disabled = !state.running;
        status.textContent = state.failed ? s.prefMcpStartError : state.running ? mcp.url : '';
      };
      toggle.addEventListener('change', async () => {
        toggle.disabled = true;
        copy.disabled = true;
        await mcp.setEnabled(toggle.checked);
        toggle.disabled = false;
        update();
      });
      copy.addEventListener('click', () => {
        try {
          mcp.copyCodexConfig();
          status.textContent = s.prefMcpCopied;
        } catch {
          status.textContent = s.prefMcpCopyError;
        }
      });
      update();
      this.container.appendChild(el(doc, 'div', { className: 'zv-pref-card' }, [
        el(doc, 'h2', { className: 'zv-pref-h2' }, [s.prefMcpTitle]),
        el(doc, 'p', { className: 'zv-hint' }, [s.prefMcpHint]),
        el(doc, 'label', { className: 'zv-check-row' }, [toggle, el(doc, 'span', {}, [s.prefMcpEnable])]),
        el(doc, 'div', { className: 'zv-btn-row' }, [copy]),
        status,
      ]));
    }

    this.updateProgressDom(svc.getIndexProgress());
    void this.refreshStatsAndStatus();
  }

  private profileLabel(profile: EmbeddingProfileStats): string {
    return [profile.engine, profile.model, profile.dimensions ? `${profile.dimensions}d` : '', profile.id.slice(-6)]
      .filter(Boolean).join(' · ');
  }

  private renderProfiles(svc: VectorizeService, profiles: EmbeddingProfileStats[], items: number, chunks: number): void {
    const target = document.getElementById('zv-model-indexes');
    if (!target) return;
    const s = getStrings(svc.getConfig());
    target.replaceChildren();
    if (!profiles.length) target.appendChild(el(document, 'p', { className: 'zv-hint' }, [s.prefNoModelIndexes]));
    for (const profile of profiles) {
      const title = this.profileLabel(profile);
      const label = profile.active ? s.prefActiveIndex : profile.provenance === 'legacy' ? s.prefLegacyIndex : s.prefSavedIndex;
      const actions = el(document, 'div', { className: 'zv-btn-row' });
      const remove = el(document, 'button', { type: 'button', className: 'zv-btn zv-btn-danger' }, [s.prefDeleteModelIndex]);
      remove.disabled = !(profile.items || profile.chunks);
      remove.addEventListener('click', () => void this.manageProfile(svc, profile, false));
      actions.appendChild(remove);
      if (profile.provenance === 'legacy' && profiles.some((current) =>
        current.active && current.engine === profile.engine && current.model === profile.model)) {
        const reuse = el(document, 'button', { type: 'button', className: 'zv-btn' }, [s.prefReuseLegacy]);
        reuse.addEventListener('click', () => void this.manageProfile(svc, profile, true));
        actions.appendChild(reuse);
      }
      target.appendChild(el(document, 'div', { className: 'zv-model-index' }, [
        el(document, 'div', {}, [
          el(document, 'strong', {}, [title]),
          el(document, 'div', { className: 'zv-hint' }, [`${label} · ${s.prefModelCoverage(profile.items, items, profile.chunks, chunks)}`]),
        ]),
        actions,
      ]));
    }
  }

  private async manageProfile(svc: VectorizeService, profile: EmbeddingProfileStats, reuse: boolean): Promise<void> {
    if (this.busyAction || !this.container) return;
    this.busyAction = true;
    const s = getStrings(svc.getConfig());
    const title = reuse ? s.prefReuseLegacy : s.prefDeleteModelIndex;
    try {
      if (!await choose(this.container, title, [['confirm', title]], s.prefCancel,
        reuse ? s.prefReuseLegacyHint : s.prefDeleteModelHint(profile.model))) return;
      if (reuse) await svc.reuseLegacyIndex(profile.id);
      else await svc.deleteEmbeddingProfile(profile.id);
      this.setFeedback(s.prefIndexChanged, 'ok');
      await this.refreshStatsAndStatus();
    } catch (error) {
      this.setFeedback(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      this.busyAction = false;
    }
  }

  private async transferIndex(svc: VectorizeService, importing: boolean): Promise<void> {
    if (this.busyAction || !this.container) return;
    this.busyAction = true;
    const s = getStrings(svc.getConfig());
    const title = importing ? s.prefIndexImport : s.prefIndexExport;
    try {
      const format = await choose(this.container, title, [['json', s.prefIndexFormatJson], ['sqlite', s.prefIndexFormatNative]], s.prefCancel);
      if (!format) return;
      if (format === 'json') {
        let profileID: string | undefined;
        if (!importing) {
          const profiles = (await svc.listEmbeddingProfiles()).filter((profile) => profile.items || profile.chunks)
            .sort((a, b) => Number(b.active) - Number(a.active));
          if (!profiles.length) throw new Error(s.prefNoModelIndexes);
          profileID = profiles.length === 1 ? profiles[0].id :
            (await choose(this.container, s.prefSelectExportModel,
              profiles.map((profile) => [profile.id, this.profileLabel(profile)]), s.prefCancel)) ?? undefined;
          if (!profileID) return;
        }
        const folder = await pickPath(title, 'folder');
        if (!folder) return;
        this.setFeedback(s.prefMsgWorking);
        if (importing) {
          const result = await svc.importCompatJsonFromFolder(folder);
          this.setFeedback(s.prefMsgImported(result.importedItems, result.importedChunks, result.skippedItems, result.skippedChunks), 'ok');
        } else {
          const result = await svc.exportCompatJsonToFolder(folder, profileID);
          this.setFeedback(s.prefMsgExported(result.items, result.chunks, folder), 'ok');
        }
      } else {
        const path = await pickPath(title, importing ? 'open' : 'save');
        if (!path) return;
        if (importing && !await choose(this.container, title,
          [['restore', s.prefRestoreNative]], s.prefCancel, s.prefRestoreNativeHint)) return;
        this.setFeedback(s.prefMsgWorking);
        if (importing) await svc.restoreNativeIndex(path);
        else await svc.exportNativeIndex(path);
        this.setFeedback(importing ? s.prefNativeRestored : s.prefNativeExported, 'ok');
      }
      await this.refreshStatsAndStatus();
    } catch (error) {
      this.setFeedback(error instanceof Error ? error.message : String(error), 'err');
    } finally {
      this.busyAction = false;
    }
  }

  private buildTestConnBtn(doc: Document, svc: VectorizeService, s: ReturnType<typeof getStrings>, draft: PluginConfig) {
    const btn = el(doc, 'button', { type: 'button', className: 'zv-btn' }, [s.prefTestConnection]);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await svc.testConnection({ ...draft });
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
