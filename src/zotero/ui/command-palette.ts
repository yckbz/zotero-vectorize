import type {
  ChunkHitInfo,
  EngineHealthStatus,
  IndexProgress,
  SearchHit,
  SearchMode,
  SearchResponse,
  StoreStats,
} from '../../types/vectorize.ts';
import type { VectorizeService } from '../service.ts';
import { getStrings } from '../i18n.ts';
import { jumpToSearchHit, selectItemInLibrary } from '../navigation.ts';
import {
  el,
  getActiveCollectionItemIDs,
  openPluginPreferences,
  renderHighlightedText,
} from './render-utils.ts';

function matchesShortcut(event: KeyboardEvent, spec: string): boolean {
  const parts = (spec || 'Mod+K')
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return false;
  const targetKey = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const isMac = typeof Zotero !== 'undefined' ? Boolean(Zotero.isMac) : false;

  const expectMeta = mods.has('meta') || mods.has('cmd') || (mods.has('mod') && isMac);
  const expectCtrl = mods.has('ctrl') || (mods.has('mod') && !isMac);
  const expectShift = mods.has('shift');
  const expectAlt = mods.has('alt');

  if (event.metaKey !== expectMeta) return false;
  if (event.ctrlKey !== expectCtrl) return false;
  if (event.shiftKey !== expectShift) return false;
  if (event.altKey !== expectAlt) return false;
  if (event.key.toLowerCase() === targetKey) return true;
  if (targetKey.length === 1 && /^[a-z]$/.test(targetKey) && event.code === `Key${targetKey.toUpperCase()}`) {
    return true;
  }
  return false;
}

export class CommandPalette {
  private readonly win: any;
  private readonly service: VectorizeService;

  private backdrop: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private footerDiagEl: HTMLElement | null = null;
  private modeGroupEl: HTMLElement | null = null;
  private scopeBtnEl: HTMLElement | null = null;

  private isOpen = false;
  private query = '';
  private currentMode: SearchMode;
  private scopeCollectionOnly = false;
  private selectedIndex = 0;
  private lastResponse: SearchResponse | null = null;
  private searchError = '';
  private lastStatus: EngineHealthStatus | null = null;
  private lastStats: StoreStats | null = null;
  private lastProgress: IndexProgress | null = null;
  private unsubProgress: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private searchAbort: AbortController | null = null;
  private keyListenerCleanup: (() => void) | null = null;

  constructor(options: { win: any; service: VectorizeService }) {
    this.win = options.win;
    this.service = options.service;
    this.currentMode = this.service.getConfig().defaultSearchMode;
  }

  attachShortcut(): void {
    const onKeyDown = (event: KeyboardEvent) => {
      const spec = this.service.getConfig().commandPaletteShortcut || 'Mod+K';
      if (matchesShortcut(event, spec)) {
        event.preventDefault();
        event.stopPropagation();
        if (this.isOpen) {
          this.close();
        } else {
          void this.open();
        }
        return;
      }
      if (this.isOpen && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    };

    this.win.addEventListener('keydown', onKeyDown, true);
    this.keyListenerCleanup = () => {
      this.win.removeEventListener('keydown', onKeyDown, true);
    };
  }

  async open(initialQuery = ''): Promise<void> {
    if (this.isOpen) {
      if (initialQuery && this.inputEl) {
        this.inputEl.value = initialQuery;
        this.query = initialQuery;
        void this.runSearch(initialQuery);
      }
      this.inputEl?.focus();
      return;
    }

    this.isOpen = true;
    this.query = initialQuery;
    this.lastResponse = null;
    this.searchError = '';
    this.currentMode = this.service.getConfig().defaultSearchMode;
    this.selectedIndex = 0;
    this.buildDom();
    this.inputEl?.focus();
    this.inputEl?.select();

    this.unsubProgress = this.service.subscribeProgress((p) => {
      this.lastProgress = p;
      if (!this.query.trim()) {
        this.renderBody();
      }
    });

    if (this.query.trim()) void this.runSearch(this.query);
    const input = this.inputEl;
    const [status, stats] = await Promise.all([
      this.service.getEngineStatus(),
      this.service.getStats(),
    ]);
    if (this.inputEl !== input) return;
    if (!this.lastResponse) this.lastStatus = status;
    this.lastStats = stats;

    if (!this.query.trim()) this.renderBody();
  }

  close(): void {
    this.isOpen = false;
    this.searchAbort?.abort();
    this.searchAbort = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.unsubProgress) {
      this.unsubProgress();
      this.unsubProgress = null;
    }
    this.backdrop?.remove();
    this.backdrop = null;
    this.inputEl = null;
    this.bodyEl = null;
    this.footerDiagEl = null;
    this.modeGroupEl = null;
    this.scopeBtnEl = null;
  }

  private buildDom(): void {
    const doc = this.win.document;
    doc.getElementById('zv-palette-backdrop')?.remove();

    const cfg = this.service.getConfig();
    const s = getStrings(cfg);

    const backdrop = el(doc, 'div', { id: 'zv-palette-backdrop' });
    backdrop.addEventListener('mousedown', (ev) => {
      if (ev.target === backdrop) {
        this.close();
      }
    });

    const input = el(doc, 'input', {
      type: 'text',
      className: 'zv-palette-input',
      placeholder: s.palettePlaceholder,
      value: this.query,
    }) as HTMLInputElement;
    input.value = this.query;

    let isComposing = false;
    input.addEventListener('compositionstart', () => {
      isComposing = true;
      this.searchAbort?.abort();
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    });
    input.addEventListener('compositionend', () => {
      isComposing = false;
      this.query = input.value;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      if (!this.query.trim()) {
        this.lastResponse = null;
        this.renderBody();
        return;
      }
      void this.runSearch(this.query);
    });

    input.addEventListener('input', (ev) => {
      if (isComposing || (ev as InputEvent)?.isComposing) return;
      this.searchAbort?.abort();
      this.query = input.value;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      if (!this.query.trim()) {
        this.lastResponse = null;
        this.renderBody();
        return;
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.runSearch(this.query);
      }, 110);
    });

    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (isComposing || event.isComposing || event.keyCode === 229) {
        return;
      }
      const hits = this.query.trim() === this.lastResponse?.diagnostics.query
        ? this.lastResponse.hits : [];
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (hits.length > 0) {
          this.selectedIndex = (this.selectedIndex + 1) % hits.length;
          this.updateSelectionDom();
        }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (hits.length > 0) {
          this.selectedIndex = (this.selectedIndex - 1 + hits.length) % hits.length;
          this.updateSelectionDom();
        }
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const order: SearchMode[] = ['hybrid', 'metadata', 'fulltext'];
        this.currentMode = order[(order.indexOf(this.currentMode) + 1) % order.length];
        this.renderControls();
        if (this.query.trim()) void this.runSearch(this.query);
        return;
      }
      if (event.key === 'Enter') {
        if (hits[this.selectedIndex]) {
          event.preventDefault();
          void this.activateHit(hits[this.selectedIndex], hits[this.selectedIndex].bestChunk);
        }
      }
    });

    const inputRow = el(doc, 'div', { className: 'zv-palette-input-row' }, [
      el(doc, 'span', { className: 'zv-palette-search-icon' }, ['✦']),
      input,
      el(doc, 'span', { className: 'zv-kbd' }, ['ESC']),
    ]);

    const modeGroup = el(doc, 'div', { className: 'zv-segmented' });
    const scopeBtn = el(doc, 'button', { type: 'button', className: 'zv-scope-btn' });
    scopeBtn.addEventListener('click', () => {
      this.scopeCollectionOnly = !this.scopeCollectionOnly;
      this.renderControls();
      if (this.query.trim()) void this.runSearch(this.query);
    });

    const indexBtn = el(
      doc,
      'button',
      { type: 'button', className: 'zv-icon-btn' },
      [s.buildIndexNow]
    );
    indexBtn.addEventListener('click', () => {
      void this.service.startIndexing(false);
    });

    const settingsBtn = el(
      doc,
      'button',
      { type: 'button', className: 'zv-icon-btn' },
      [`⚙ ${s.openSettings}`]
    );
    settingsBtn.addEventListener('click', () => {
      this.close();
      openPluginPreferences(this.win);
    });

    const toolbar = el(doc, 'div', { className: 'zv-header' }, [
      el(doc, 'div', { className: 'zv-controls' }, [modeGroup, scopeBtn]),
      el(doc, 'div', { className: 'zv-controls' }, [indexBtn, settingsBtn]),
    ]);

    const bodyEl = el(doc, 'div', { className: 'zv-list' });
    const footerDiagEl = el(doc, 'span', { className: 'zv-diag' });
    const footer = el(doc, 'div', { className: 'zv-footer' }, [
      el(doc, 'span', {}, [s.footerNavigateHint]),
      footerDiagEl,
    ]);

    const dialog = el(doc, 'div', { className: 'zv-palette-dialog' }, [
      inputRow,
      toolbar,
      bodyEl,
      footer,
    ]);

    backdrop.appendChild(dialog);
    doc.documentElement.appendChild(backdrop);

    this.backdrop = backdrop;
    this.inputEl = input;
    this.bodyEl = bodyEl;
    this.footerDiagEl = footerDiagEl;
    this.modeGroupEl = modeGroup;
    this.scopeBtnEl = scopeBtn;

    this.renderControls();
  }

  private renderControls(): void {
    if (!this.modeGroupEl || !this.scopeBtnEl) return;
    const doc = this.win.document;
    const s = getStrings(this.service.getConfig());

    this.modeGroupEl.textContent = '';
    const modes: Array<[SearchMode, string]> = [
      ['hybrid', s.modeHybrid],
      ['metadata', s.modeMetadata],
      ['fulltext', s.modeFulltext],
    ];
    for (const [m, label] of modes) {
      const btn = el(
        doc,
        'button',
        {
          type: 'button',
          className: `zv-seg-btn ${this.currentMode === m ? 'is-active' : ''}`,
        },
        [label]
      );
      btn.addEventListener('click', () => {
        this.currentMode = m;
        this.renderControls();
        if (this.query.trim()) void this.runSearch(this.query);
      });
      this.modeGroupEl.appendChild(btn);
    }

    this.scopeBtnEl.className = `zv-scope-btn ${this.scopeCollectionOnly ? 'is-active' : ''}`;
    this.scopeBtnEl.textContent = this.scopeCollectionOnly ? s.scopeCollection : s.scopeAll;
  }

  private async runSearch(query: string): Promise<void> {
    this.searchAbort?.abort();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    const clean = query.trim();
    if (!clean) {
      this.lastResponse = null;
      this.renderBody();
      return;
    }
    this.lastResponse = null;
    this.searchError = '';
    this.renderBody();
    let controller: AbortController | undefined;
    try {
      const activeController: AbortController = new this.win.AbortController();
      controller = this.searchAbort = activeController;
      const { signal } = activeController;
      const filterIDs = this.scopeCollectionOnly ? await getActiveCollectionItemIDs(this.win) : null;
      if (signal.aborted) return;
      const [status, response] = await Promise.all([
        this.service.getEngineStatus(),
        this.service.search(clean, { mode: this.currentMode, filterItemIDs: filterIDs, signal }),
      ]);
      if (signal.aborted || !this.isOpen || this.query.trim() !== clean) return;
      this.lastStatus = status;
      this.lastResponse = response;
      this.selectedIndex = 0;
      this.renderBody();
    } catch (error) {
      if (!this.isOpen || this.query.trim() !== clean || controller?.signal.aborted) return;
      this.searchError = error instanceof Error ? error.message : String(error);
      this.renderBody();
      Zotero.logError(error);
    }
  }

  private updateSelectionDom(): void {
    if (!this.bodyEl) return;
    const cards = this.bodyEl.querySelectorAll('.zv-card');
    for (const node of cards) {
      const idx = Number((node as HTMLElement).getAttribute('data-hit-index'));
      if (idx === this.selectedIndex) {
        node.classList.add('is-selected');
        (node as HTMLElement).scrollIntoView({ block: 'nearest' });
      } else {
        node.classList.remove('is-selected');
      }
    }
  }

  private async activateHit(hit: SearchHit, chunk?: ChunkHitInfo | null): Promise<void> {
    if (this.query.trim() !== this.lastResponse?.diagnostics.query) return;
    this.close();
    await jumpToSearchHit(hit, chunk, {
      openPdfIfNoChunk: true,
      win: this.win,
    });
  }

  private renderBody(): void {
    if (!this.bodyEl) return;
    const doc = this.win.document;
    const s = getStrings(this.service.getConfig());
    this.bodyEl.textContent = '';

    if (!this.query.trim()) {
      const stats = this.lastStats;
      const status = this.lastStatus;
      const prog = this.lastProgress;

      const summaryText = stats
        ? `${stats.indexedItems} ${s.prefItemsIndexed} · ${stats.indexedChunks} ${s.prefChunksIndexed} · ${status?.statusMessage || ''}`
        : status?.statusMessage || '';

      const progressLine =
        prog && (prog.phase === 'indexing' || prog.phase === 'scanning')
          ? `${prog.message} (${prog.processedItems}/${prog.totalItems})`
          : '';

      const samples = ['注意力机制稀疏化', 'causal inference counterfactual', '模型压缩量化'];
      const chipRow = el(doc, 'div', {
        style: 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:6px;',
      });
      for (const sample of samples) {
        const chip = el(doc, 'button', { type: 'button', className: 'zv-extra-page-btn' }, [sample]);
        chip.addEventListener('click', () => {
          if (this.inputEl) this.inputEl.value = sample;
          this.query = sample;
          void this.runSearch(sample);
          this.inputEl?.focus();
        });
        chipRow.appendChild(chip);
      }

      this.bodyEl.appendChild(
        el(doc, 'div', { className: 'zv-empty' }, [
          el(doc, 'div', { className: 'zv-empty-title' }, [s.paletteTitle]),
          el(doc, 'div', { className: 'zv-empty-desc' }, [s.paletteEmptyHint]),
          summaryText ? el(doc, 'div', { className: 'zv-diag' }, [summaryText]) : null,
          progressLine ? el(doc, 'div', { className: 'zv-badge zv-badge-cross' }, [progressLine]) : null,
          chipRow,
        ])
      );
      if (this.footerDiagEl) this.footerDiagEl.textContent = summaryText;
      return;
    }

    const resp = this.lastResponse;
    if (!resp) {
      if (this.footerDiagEl) this.footerDiagEl.textContent = '';
      this.bodyEl.appendChild(el(doc, 'div', { className: 'zv-empty', role: 'status' }, [
        el(doc, 'div', { className: 'zv-empty-title' }, [this.searchError ? s.searchFailed : s.searching]),
        this.searchError ? el(doc, 'div', { className: 'zv-empty-desc' }, [this.searchError]) : null,
      ]));
      return;
    }
    if (this.footerDiagEl) {
      const engine = resp.diagnostics.vectorSearchUsed ? resp.diagnostics.engineLabel : s.lexicalFallbackTag;
      this.footerDiagEl.textContent = `${resp.diagnostics.durationMs}ms · ${engine}`;
    }
    if (resp.diagnostics.mismatchWarning) {
      this.bodyEl.appendChild(el(doc, 'div', { className: 'zv-banner', role: 'status' }, [
        resp.diagnostics.mismatchWarning,
      ]));
    }

    if (resp.hits.length === 0) {
      this.bodyEl.appendChild(
        el(doc, 'div', { className: 'zv-empty' }, [
          el(doc, 'div', { className: 'zv-empty-title' }, [s.noResultsTitle]),
          el(doc, 'div', { className: 'zv-empty-desc' }, [s.noResultsDesc]),
        ])
      );
      return;
    }

    for (let idx = 0; idx < resp.hits.length; idx++) {
      const hit = resp.hits[idx];
      const card = el(doc, 'div', {
        className: `zv-card ${idx === this.selectedIndex ? 'is-selected' : ''}`,
        'data-hit-index': idx,
      });

      const badges: HTMLElement[] = [];
      if (hit.crossLingualMatched) {
        badges.push(el(doc, 'span', { className: 'zv-badge zv-badge-cross' }, [s.crossLingualBadge]));
      }
      badges.push(
        el(doc, 'span', { className: 'zv-badge zv-badge-score' }, [
          s.matchScore(Math.max(1, Math.round(hit.score * 100))),
        ])
      );

      card.appendChild(
        el(doc, 'div', { className: 'zv-card-top' }, [
          el(doc, 'div', { className: 'zv-card-title' }, [hit.title || hit.itemKey]),
          el(doc, 'div', { className: 'zv-card-badges' }, badges),
        ])
      );

      const metaLine = [hit.creators, hit.year, hit.publicationTitle].filter(Boolean).join(' · ');
      if (metaLine) {
        card.appendChild(el(doc, 'div', { className: 'zv-card-meta' }, [metaLine]));
      }

      const chunksToShow: ChunkHitInfo[] = [];
      if (hit.bestChunk) chunksToShow.push(hit.bestChunk);
      for (const extra of hit.extraHits.slice(0, 2)) {
        chunksToShow.push(extra);
      }

      for (const ch of chunksToShow) {
        const pagePill = el(
          doc,
          'button',
          { type: 'button', className: 'zv-page-pill' },
          [`${s.pageLabel(ch.pageLabel)} ↗`]
        );
        pagePill.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void this.activateHit(hit, ch);
        });

        const snippetEl = el(doc, 'div', { className: 'zv-snippet-text' });
        snippetEl.appendChild(renderHighlightedText(doc, ch.snippet, ch.highlightRanges));

        const box = el(doc, 'div', { className: 'zv-snippet-box' }, [
          el(doc, 'div', { className: 'zv-snippet-head' }, [
            pagePill,
            el(doc, 'span', {}, [ch.attachmentTitle || 'PDF']),
          ]),
          snippetEl,
        ]);
        box.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void this.activateHit(hit, ch);
        });
        card.appendChild(box);
      }

      const libBtn = el(doc, 'button', { type: 'button', className: 'zv-mini-action' }, [s.selectInLibrary]);
      libBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.close();
        void selectItemInLibrary(hit.itemID, true);
      });

      const openBtn = el(
        doc,
        'button',
        { type: 'button', className: 'zv-mini-action is-primary' },
        [hit.bestChunk ? `${s.jumpToPdf} (${s.pageLabel(hit.bestChunk.pageLabel)})` : s.jumpToPdf]
      );
      openBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.activateHit(hit, hit.bestChunk);
      });

      card.appendChild(el(doc, 'div', { className: 'zv-card-actions' }, [libBtn, openBtn]));

      card.addEventListener('click', () => {
        void this.activateHit(hit, hit.bestChunk);
      });
      card.addEventListener('mouseenter', () => {
        this.selectedIndex = idx;
        this.updateSelectionDom();
      });

      this.bodyEl.appendChild(card);
    }
  }

  destroy(): void {
    this.close();
    if (this.keyListenerCleanup) {
      this.keyListenerCleanup();
      this.keyListenerCleanup = null;
    }
  }
}
