import type { VectorizeService } from '../service.ts';
import { PLUGIN_ID } from '../config.ts';
import { isIndexableRegularItem } from '../extractor.ts';
import { getStrings } from '../i18n.ts';
import { selectItemInLibrary } from '../navigation.ts';
import { el } from './render-utils.ts';

export function registerSimilarPapersSection(rootURI: string, service: VectorizeService): (() => void) | null {
  if (typeof Zotero === 'undefined' || !Zotero.ItemPaneManager?.registerSection) {
    return null;
  }

  const activeRefreshers = new Map<HTMLElement, () => Promise<void> | void>();
  let debounceRefresh: ReturnType<typeof setTimeout> | null = null;
  const unsubUpdates = service.subscribeIndexUpdates(() => {
    if (debounceRefresh) clearTimeout(debounceRefresh);
    debounceRefresh = setTimeout(() => {
      debounceRefresh = null;
      for (const refresh of activeRefreshers.values()) {
        try {
          void refresh();
        } catch {
          // Ignore refresh failure on closed section
        }
      }
    }, 250);
  });

  try {
    const paneID = Zotero.ItemPaneManager.registerSection({
      paneID: 'zotero-vectorize-similar-section',
      pluginID: PLUGIN_ID,
      header: {
        l10nID: 'zotero-vectorize-item-pane-header',
        l10nArgs: '{}',
        icon: `${rootURI}chrome/skin/default/icon-16.svg`,
      },
      sidenav: {
        l10nID: 'zotero-vectorize-item-pane-sidenav',
        l10nArgs: '{}',
        icon: `${rootURI}chrome/skin/default/icon-16.svg`,
      },
      onInit: ({ body, refresh }: any) => {
        if (body && typeof refresh === 'function') {
          activeRefreshers.set(body, refresh);
        }
      },
      onDestroy: ({ body }: any) => {
        if (body) {
          activeRefreshers.delete(body);
        }
      },
      onItemChange: ({ item, setEnabled }) => {
        try {
          const enabled = isIndexableRegularItem(item);
          setEnabled(enabled);
          return enabled;
        } catch {
          setEnabled(false);
          return false;
        }
      },
      onRender: ({ doc, body, item }) => {
        if (!body) return;
        body.textContent = '';
        if (!isIndexableRegularItem(item)) return;

        const s = getStrings(service.getConfig());
        const box = el(doc, 'div', { className: 'zv-item-pane-box' });
        let similar: ReturnType<VectorizeService['findSimilarItems']> = [];
        try {
          similar = service.findSimilarItems(item.id, 5);
        } catch (err) {
          Zotero.logError(err);
          similar = [];
        }

        if (similar.length === 0) {
          box.appendChild(
            el(doc, 'div', { style: 'font-size:11.5px;color:var(--zv-ink-muted,#888);padding:4px 0;' }, [
              s.similarPapersEmpty,
            ])
          );
        } else {
          for (const entry of similar) {
            const pct = Math.max(1, Math.min(99, Math.round(entry.score * 100)));
            const card = el(
              doc,
              'div',
              {
                className: 'zv-similar-card',
                title: entry.item.abstractNote ? entry.item.abstractNote.slice(0, 220) : entry.item.title,
              },
              [
                el(doc, 'div', { className: 'zv-similar-title' }, [entry.item.title || entry.item.itemKey]),
                el(doc, 'div', { className: 'zv-similar-meta' }, [
                  el(doc, 'span', {}, [[entry.item.creators, entry.item.year].filter(Boolean).join(' · ')]),
                  el(doc, 'span', {}, [`${pct}%`]),
                ]),
              ]
            );
            card.addEventListener('click', () => {
              void selectItemInLibrary(entry.item.itemID, true);
            });
            box.appendChild(card);
          }
        }
        body.appendChild(box);
      },
    });

    if (!paneID) {
      unsubUpdates();
      return null;
    }
    return () => {
      if (debounceRefresh) clearTimeout(debounceRefresh);
      unsubUpdates();
      activeRefreshers.clear();
      try {
        Zotero.ItemPaneManager?.unregisterSection(paneID);
      } catch {
        // Ignore cleanup errors
      }
    };
  } catch (e) {
    unsubUpdates();
    Zotero.logError(e);
    return null;
  }
}
