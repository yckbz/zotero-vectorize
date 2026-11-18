import type { ChunkHitInfo, EngineHealthStatus, SearchHit, SearchMode, SearchResponse } from '../../types/vectorize.ts';
import type { VectorizeService } from '../service.ts';
import { getStrings } from '../i18n.ts';
import { jumpToSearchHit, selectItemInLibrary } from '../navigation.ts';
import {
  el,
  formatModShortcutLabel,
  getActiveCollectionItemIDs,
  openPluginPreferences,
  renderHighlightedText,
} from './render-utils.ts';

export class TopSearchPopover {
  private readonly win: any;
  private readonly service: VectorizeService;
  private readonly onOpenPalette: (initialQuery: string) => void;

  private searchEl: any = null;
  private panel: any = null;
  private rootEl: HTMLElement | null = null;
  private isOpen = false;
  private currentMode: SearchMode;
  private scopeCollectionOnly = false;
  private selectedIndex = -1;
  private lastResponse: SearchResponse | null = null;
  private lastEngineStatus: EngineHealthStatus | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private searchAbort: AbortController | null = null;
  private cleanups: Array<() => void> = [];
  private downloadingModel = false;
  private downloadProgressText = '';
  private downloadErrorText = '';
  private isComposing = false;
  private dlButtonEl: HTMLElement | null = null;

  constructor(options: {
    win: any;
    service: VectorizeService;
    onOpenPalette: (initialQuery: string) => void;
  }) {
    this.win = options.win;
    this.service = options.service;
    this.onOpenPalette = options.onOpenPalette;
    this.currentMode = this.service.getConfig().defaultSearchMode;
  }

  attach(): void {
    const doc = this.win.document;
    this.searchEl = doc.getElementById('zotero-tb-search');
    if (!this.searchEl) return;

    this.ensurePanel(doc);

    const onCompositionStart = () => {
      this.isComposing = true;
      this.searchAbort?.abort();
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    };

    const onCompositionEnd = () => {
      this.isComposing = false;
      onInput();
    };

    const onInput = (ev?: Event) => {
      if (this.isComposing || (ev as InputEvent)?.isComposing) {
        return;
      }
      if (!this.service.getConfig().enableTopSearchPopover || this.searchEl?.hasAttribute('advanced-search-open')) {
        this.hide();
        return;
      }
      const q = this.getSearchValue();
      const minChars = this.service.getConfig().popoverMinChars;
      if (q.trim().length < minChars) {
        this.hide();
        return;
      }
      this.scheduleSearch();
    };

    const onCommand = () => {
      const q = this.getSearchValue();
      if (q.trim().length < this.service.getConfig().popoverMinChars) {
        this.hide();
      }
    };

    const onFocus = () => {
      if (!this.service.getConfig().enableTopSearchPopover || this.searchEl?.hasAttribute('advanced-search-open')) return;
      const q = this.getSearchValue();
      if (q.trim() === this.lastResponse?.diagnostics.query) {
        this.openPanel();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (this.isComposing || event.isComposing || event.keyCode === 229) {
        return;
      }
      if (!this.isOpen) {
        // Allow ArrowDown in search box when query >= minChars to re-open popover
        if (event.key === 'ArrowDown' && this.service.getConfig().enableTopSearchPopover) {
          const q = this.getSearchValue().trim();
          if (q.length >= this.service.getConfig().popoverMinChars) {
            event.preventDefault();
            event.stopPropagation();
            void this.runSearch(q);
          }
        }
        return;
      }

      const hits = this.getSearchValue().trim() === this.lastResponse?.diagnostics.query
        ? this.lastResponse.hits : [];
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.hide();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        if (hits.length > 0) {
          this.selectedIndex = this.selectedIndex < hits.length - 1 ? this.selectedIndex + 1 : 0;
          this.updateSelectionDom();
          this.scrollSelectedIntoView();
        }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        if (hits.length > 0) {
          this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : hits.length - 1;
          this.updateSelectionDom();
          this.scrollSelectedIntoView();
        }
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const order: SearchMode[] = ['hybrid', 'metadata', 'fulltext'];
        const nextIdx = (order.indexOf(this.currentMode) + 1) % order.length;
        this.currentMode = order[nextIdx];
        void this.runSearch(this.getSearchValue());
        return;
      }
      if (event.key === 'Enter') {
        if (this.selectedIndex >= 0 && hits[this.selectedIndex]) {
          event.preventDefault();
          event.stopPropagation();
          void this.activateHit(hits[this.selectedIndex], hits[this.selectedIndex].bestChunk);
        } else {
          // Let native Zotero Enter search proceed cleanly
          this.hide();
        }
      }
    };

    const onDocMouseDown = (event: MouseEvent) => {
      if (!this.isOpen) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest?.('#zotero-tb-search-dropmarker, #zotero-tb-search-advanced-button')) {
        this.hide();
        return;
      }
      if (this.panel?.contains(target) || this.searchEl?.contains(target)) {
        return;
      }
      this.hide();
    };

    const onWindowBlur = () => {
      this.hide();
    };

    const inputTarget = this.searchEl.searchTextbox?.inputField || this.searchEl.searchTextbox || this.searchEl;
    inputTarget.addEventListener('compositionstart', onCompositionStart, true);
    inputTarget.addEventListener('compositionend', onCompositionEnd, true);
    inputTarget.addEventListener('input', onInput, true);
    inputTarget.addEventListener('focus', onFocus, true);
    this.searchEl.searchTextbox?.addEventListener('command', onCommand, true);
    this.searchEl.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('mousedown', onDocMouseDown, true);
    this.win.addEventListener('blur', onWindowBlur);

    // Also close when user switches away from library tab
    const tabContainer = doc.getElementById('zotero-tab-toolbar') || doc.getElementById('tabpanels');
    const onTabSelect = () => this.hide();
    tabContainer?.addEventListener('select', onTabSelect);

    this.cleanups.push(() => {
      inputTarget.removeEventListener('compositionstart', onCompositionStart, true);
      inputTarget.removeEventListener('compositionend', onCompositionEnd, true);
      inputTarget.removeEventListener('input', onInput, true);
      inputTarget.removeEventListener('focus', onFocus, true);
      this.searchEl?.searchTextbox?.removeEventListener('command', onCommand, true);
      this.searchEl?.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('mousedown', onDocMouseDown, true);
      this.win.removeEventListener('blur', onWindowBlur);
      tabContainer?.removeEventListener('select', onTabSelect);
    });
  }

  private ensurePanel(doc: Document): void {
    const existing = doc.getElementById('zv-search-panel');
    if (existing) existing.remove();

    const panel = doc.createXULElement!('panel');
    panel.id = 'zv-search-panel';
    panel.setAttribute('noautofocus', 'true');
    panel.setAttribute('noautohide', 'true');
    panel.setAttribute('animate', 'false');
    panel.setAttribute('consumeoutsideclicks', 'false');

    const root = el(doc, 'div', { className: 'zv-popover' });
    // Prevent panel clicks from stealing focus away from search textbox unnecessarily
    root.addEventListener('mousedown', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target && !['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) {
        ev.preventDefault();
      }
    });

    panel.appendChild(root);
    const container =
      doc.documentElement.querySelector(':scope > popupset') ||
      doc.querySelector('popupset') ||
      doc.documentElement;
    container.appendChild(panel);

    this.panel = panel;
    this.rootEl = root;
  }

  private getSearchValue(): string {
    if (!this.searchEl) return '';
    return String(this.searchEl.searchTextbox?.value ?? this.searchEl.value ?? '');
  }

  private scheduleSearch(): void {
    this.searchAbort?.abort();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runSearch(this.getSearchValue());
    }, 130);
  }

  private async runSearch(query: string): Promise<void> {
    this.searchAbort?.abort();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    const clean = query.trim();
    if (clean.length < this.service.getConfig().popoverMinChars) {
      this.hide();
      return;
    }

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
      if (signal.aborted || this.getSearchValue().trim() !== clean) return;
      this.lastEngineStatus = status;
      this.lastResponse = response;
      this.selectedIndex = -1;
      this.render();
      this.openPanel();
    } catch (error) {
      if (!controller?.signal.aborted) Zotero.logError(error);
    }
  }

  private openPanel(): void {
    if (!this.panel || !this.searchEl) return;
    try {
      // Ensure searchEl is still visible (user is on library tab)
      const rect = this.searchEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      if (!this.isOpen || this.panel.state !== 'open') {
        this.panel.openPopup(this.searchEl, 'after_end', 0, 6, false, false);
      }
      this.isOpen = true;
    } catch (e) {
      Zotero.logError(e);
    }
  }

  hide(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.searchAbort?.abort();
    this.searchAbort = null;
    this.isOpen = false;
    this.isComposing = false;
    this.selectedIndex = -1;
    this.dlButtonEl = null;
    try {
      if (this.panel && this.panel.state !== 'closed') {
        this.panel.hidePopup();
      }
    } catch {
      // Ignore hide errors
    }
  }

  private updateSelectionDom(): void {
    if (!this.rootEl) return;
    const cards = this.rootEl.querySelectorAll('.zv-card');
    for (const node of cards) {
      const idx = Number((node as HTMLElement).getAttribute('data-hit-index'));
      if (idx === this.selectedIndex) {
        node.classList.add('is-selected');
      } else {
        node.classList.remove('is-selected');
      }
    }
    const footerHint = this.rootEl.querySelector('.zv-footer > span:first-child');
    if (footerHint) {
      const s = getStrings(this.service.getConfig());
      footerHint.textContent = this.selectedIndex >= 0 ? s.footerNavigateHint : s.footerIdleHint;
    }
  }

  private scrollSelectedIntoView(): void {
    if (!this.rootEl || this.selectedIndex < 0) return;
    const card = this.rootEl.querySelector(`[data-hit-index="${this.selectedIndex}"]`) as HTMLElement | null;
    card?.scrollIntoView({ block: 'nearest' });
  }

  private async activateHit(hit: SearchHit, chunk?: ChunkHitInfo | null, openPdfIfNoChunk = false): Promise<void> {
    if (this.getSearchValue().trim() !== this.lastResponse?.diagnostics.query) return;
    const clearQuickSearch = this.service.getConfig().clearQuickSearchOnJump;
    this.hide();
    await jumpToSearchHit(hit, chunk, {
      openPdfIfNoChunk,
      clearQuickSearch,
      win: this.win,
    });
  }

  private render(): void {
    if (!this.rootEl) return;
    const doc = this.win.document;
    const cfg = this.service.getConfig();
    const s = getStrings(cfg);
    const resp = this.lastResponse;
    const status = this.lastEngineStatus;

    this.rootEl.textContent = '';

    // 1. Header
    const statusBadge = el(
      doc,
      'span',
      { className: `zv-status-pill ${resp?.diagnostics.vectorSearchUsed ? 'is-neural' : ''}` },
      [
        resp?.diagnostics.vectorSearchUsed
          ? `${s.neuralReadyTag} · ${status?.model?.split('/').pop() || ''}`
          : s.lexicalFallbackTag,
      ]
    );

    const makeModeBtn = (mode: SearchMode, label: string) => {
      const btn = el(
        doc,
        'button',
        {
          type: 'button',
          className: `zv-seg-btn ${this.currentMode === mode ? 'is-active' : ''}`,
        },
        [label]
      );
      btn.addEventListener('click', () => {
        this.currentMode = mode;
        void this.runSearch(this.getSearchValue());
      });
      return btn;
    };

    const segmented = el(doc, 'div', { className: 'zv-segmented' }, [
      makeModeBtn('hybrid', s.modeHybrid),
      makeModeBtn('metadata', s.modeMetadata),
      makeModeBtn('fulltext', s.modeFulltext),
    ]);

    const scopeBtn = el(
      doc,
      'button',
      {
        type: 'button',
        className: `zv-scope-btn ${this.scopeCollectionOnly ? 'is-active' : ''}`,
      },
      [this.scopeCollectionOnly ? s.scopeCollection : s.scopeAll]
    );
    scopeBtn.addEventListener('click', () => {
      this.scopeCollectionOnly = !this.scopeCollectionOnly;
      void this.runSearch(this.getSearchValue());
    });

    const paletteBtn = el(
      doc,
      'button',
      { type: 'button', className: 'zv-icon-btn', title: s.openPalette },
      [formatModShortcutLabel()]
    );
    paletteBtn.addEventListener('click', () => {
      const q = this.getSearchValue();
      this.hide();
      this.onOpenPalette(q);
    });

    const settingsBtn = el(
      doc,
      'button',
      { type: 'button', className: 'zv-icon-btn', title: s.openSettings },
      ['⚙']
    );
    settingsBtn.addEventListener('click', () => {
      this.hide();
      openPluginPreferences(this.win);
    });

    const header = el(doc, 'div', { className: 'zv-header' }, [
      el(doc, 'div', { className: 'zv-brand' }, [
        el(doc, 'span', { className: 'zv-brand-dot' }),
        el(doc, 'span', { className: 'zv-brand-title' }, ['Vectorize']),
        statusBadge,
      ]),
      el(doc, 'div', { className: 'zv-controls' }, [segmented, scopeBtn, paletteBtn, settingsBtn]),
    ]);
    this.rootEl.appendChild(header);

    // 2. Setup / mismatch notice banner
    if (status?.needsSetup && status.engine === 'local-onnx') {
      const dlBtn = el(
        doc,
        'button',
        { type: 'button', className: 'zv-banner-btn' },
        [this.downloadingModel ? (this.downloadProgressText || 'Downloading…') : s.setupBannerCta]
      );
      this.dlButtonEl = dlBtn;
      dlBtn.addEventListener('click', async () => {
        if (this.downloadingModel) return;
        this.downloadingModel = true;
        this.downloadErrorText = '';
        this.downloadProgressText = '0%';
        dlBtn.textContent = '0%';
        let lastUiTick = 0;
        try {
          await this.service.downloadLocalModel((p) => {
            this.downloadProgressText = `${p.file} ${p.percent}%`;
            const now = Date.now();
            if (now - lastUiTick >= 100 || p.percent >= 100) {
              lastUiTick = now;
              if (this.dlButtonEl) {
                this.dlButtonEl.textContent = this.downloadProgressText;
              }
            }
          });
          this.downloadingModel = false;
          this.downloadProgressText = '';
          this.downloadErrorText = '';
          void this.runSearch(this.getSearchValue());
        } catch (err: any) {
          this.downloadingModel = false;
          this.downloadProgressText = '';
          this.downloadErrorText = err?.message || 'Download failed';
          this.render();
        }
      });

      this.rootEl.appendChild(
        el(doc, 'div', { className: 'zv-banner' }, [
          el(doc, 'span', {}, [this.downloadErrorText ? `${s.setupBannerHint} (${this.downloadErrorText})` : s.setupBannerHint]),
          dlBtn,
        ])
      );
    } else if (resp?.diagnostics.mismatchWarning) {
      const rebuildBtn = el(
        doc,
        'button',
        { type: 'button', className: 'zv-banner-btn' },
        [s.rebuildIndex]
      );
      rebuildBtn.addEventListener('click', () => {
        void this.service.startIndexing(true);
        this.hide();
      });
      this.rootEl.appendChild(
        el(doc, 'div', { className: 'zv-banner' }, [
          el(doc, 'span', {}, [resp.diagnostics.mismatchWarning]),
          rebuildBtn,
        ])
      );
    }

    // 3. Body list
    const listEl = el(doc, 'div', { className: 'zv-list' });
    const hits = resp?.hits ?? [];
    const totalIndexed = (resp?.diagnostics.totalIndexedItems ?? 0) + (resp?.diagnostics.totalIndexedChunks ?? 0);

    if (totalIndexed === 0) {
      const buildBtn = el(
        doc,
        'button',
        { type: 'button', className: 'zv-mini-action is-primary' },
        [s.buildIndexNow]
      );
      buildBtn.addEventListener('click', () => {
        void this.service.startIndexing(false);
        openPluginPreferences(this.win);
        this.hide();
      });
      listEl.appendChild(
        el(doc, 'div', { className: 'zv-empty' }, [
          el(doc, 'div', { className: 'zv-empty-title' }, [s.emptyIndexTitle]),
          el(doc, 'div', { className: 'zv-empty-desc' }, [s.emptyIndexDesc]),
          buildBtn,
        ])
      );
    } else if (hits.length === 0) {
      listEl.appendChild(
        el(doc, 'div', { className: 'zv-empty' }, [
          el(doc, 'div', { className: 'zv-empty-title' }, [s.noResultsTitle]),
          el(doc, 'div', { className: 'zv-empty-desc' }, [s.noResultsDesc]),
        ])
      );
    } else {
      for (let idx = 0; idx < hits.length; idx++) {
        const hit = hits[idx];
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

        if (hit.bestChunk) {
          const chunk = hit.bestChunk;
          const pagePill = el(
            doc,
            'button',
            { type: 'button', className: 'zv-page-pill', title: s.jumpToPdf },
            [`${s.pageLabel(chunk.pageLabel)} ↗`]
          );
          pagePill.addEventListener('click', (ev) => {
            ev.stopPropagation();
            void this.activateHit(hit, chunk);
          });

          const snippetEl = el(doc, 'div', { className: 'zv-snippet-text' });
          snippetEl.appendChild(renderHighlightedText(doc, chunk.snippet, chunk.highlightRanges));

          const boxChildren: Node[] = [
            el(doc, 'div', { className: 'zv-snippet-head' }, [
              pagePill,
              el(doc, 'span', {}, [chunk.attachmentTitle || 'PDF']),
            ]),
            snippetEl,
          ];

          if (hit.extraHits.length > 0) {
            const extraRow = el(doc, 'div', { className: 'zv-extra-pages' });
            for (const extra of hit.extraHits) {
              const pBtn = el(
                doc,
                'button',
                { type: 'button', className: 'zv-extra-page-btn' },
                [s.pageLabel(extra.pageLabel)]
              );
              pBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                void this.activateHit(hit, extra);
              });
              extraRow.appendChild(pBtn);
            }
            if (hit.extraHitsCount > hit.extraHits.length) {
              extraRow.appendChild(
                el(doc, 'span', { style: 'font-size:10.5px;color:var(--zv-ink-muted);' }, [
                  s.moreMatches(hit.extraHitsCount - hit.extraHits.length),
                ])
              );
            }
            boxChildren.push(extraRow);
          }

          card.appendChild(el(doc, 'div', { className: 'zv-snippet-box' }, boxChildren));
        }

        const libBtn = el(
          doc,
          'button',
          { type: 'button', className: 'zv-mini-action' },
          [s.selectInLibrary]
        );
        libBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.hide();
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
          void this.activateHit(hit, hit.bestChunk, true);
        });

        card.appendChild(el(doc, 'div', { className: 'zv-card-actions' }, [libBtn, openBtn]));

        card.addEventListener('click', () => {
          void this.activateHit(hit, hit.bestChunk);
        });
        card.addEventListener('mouseenter', () => {
          this.selectedIndex = idx;
          this.updateSelectionDom();
        });

        listEl.appendChild(card);
      }
    }
    this.rootEl.appendChild(listEl);

    // 4. Footer
    const diagText = resp
      ? `${resp.diagnostics.durationMs}ms · ${resp.diagnostics.totalIndexedItems} items · ${resp.diagnostics.totalIndexedChunks} chunks`
      : '';
    this.rootEl.appendChild(
      el(doc, 'div', { className: 'zv-footer' }, [
        el(doc, 'span', {}, [this.selectedIndex >= 0 ? s.footerNavigateHint : s.footerIdleHint]),
        el(doc, 'span', { className: 'zv-diag' }, [diagText]),
      ])
    );
  }

  destroy(): void {
    this.hide();
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {
        // Ignore cleanup
      }
    }
    this.cleanups = [];
    try {
      this.panel?.remove();
    } catch {
      // Ignore
    }
    this.panel = null;
    this.rootEl = null;
  }
}
