const XHTML_NS = 'http://www.w3.org/1999/xhtml';

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs?: Record<string, string | number | boolean | undefined | null>,
  children?: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(XHTML_NS, tag) as unknown as HTMLElementTagNameMap[K];
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'className') {
        node.setAttribute('class', String(v));
      } else if (v === true) {
        node.setAttribute(k, '');
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  if (children) {
    for (const child of children) {
      if (child === null || child === undefined) continue;
      if (typeof child === 'string') {
        node.appendChild(doc.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
  }
  return node;
}

export function renderHighlightedText(
  doc: Document,
  text: string,
  ranges: Array<[number, number]>
): DocumentFragment {
  const frag = doc.createDocumentFragment();
  if (!text) return frag;
  if (!ranges || ranges.length === 0) {
    frag.appendChild(doc.createTextNode(text));
    return frag;
  }

  let cursor = 0;
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(cursor, Math.min(text.length, rawStart));
    const end = Math.max(start, Math.min(text.length, rawEnd));
    if (start > cursor) {
      frag.appendChild(doc.createTextNode(text.slice(cursor, start)));
    }
    if (end > start) {
      const mark = el(doc, 'mark', { className: 'zv-mark' }, [text.slice(start, end)]);
      frag.appendChild(mark);
    }
    cursor = end;
  }
  if (cursor < text.length) {
    frag.appendChild(doc.createTextNode(text.slice(cursor)));
  }
  return frag;
}

export async function getActiveCollectionItemIDs(win: any): Promise<Set<number> | null> {
  try {
    const pane = win?.ZoteroPane ?? Zotero.getActiveZoteroPane?.();
    if (!pane) return null;

    const cols = pane.getSelectedCollections?.();
    const col = Array.isArray(cols) ? cols[0] : pane.getSelectedCollection?.();
    if (col && typeof col.getChildItems === 'function') {
      const items = await col.getChildItems(true, false);
      const set = new Set<number>();
      for (const item of items || []) {
        const id = typeof item === 'number' ? item : item?.id;
        if (typeof id === 'number' && id > 0) set.add(id);
      }
      return set;
    }

    const searches = pane.getSelectedSavedSearches?.();
    const search = Array.isArray(searches) ? searches[0] : pane.getSelectedSavedSearch?.();
    if (search && typeof search.search === 'function') {
      const ids = await search.search();
      return new Set<number>((ids || []).map(Number));
    }
  } catch {
    // Fallback to full library
  }
  return null;
}

export function openPluginPreferences(win: any): void {
  const paneID = 'zotero-vectorize-prefpane';
  try {
    if (typeof (Zotero as any).Utilities?.Internal?.openPreferences === 'function') {
      (Zotero as any).Utilities.Internal.openPreferences(paneID);
      return;
    }
    const existing = Services.wm.getMostRecentWindow('zotero:pref');
    if (existing) {
      existing.focus();
      existing.Zotero_Preferences?.navigateToPane?.(paneID);
      return;
    }
    const pane = win?.ZoteroPane ?? Zotero.getActiveZoteroPane?.();
    if (typeof pane?.openPreferences === 'function') {
      pane.openPreferences(paneID);
      return;
    }
    const targetWin = win || Zotero.getMainWindow();
    if (targetWin?.openDialog) {
      targetWin.openDialog(
        'chrome://zotero/content/preferences/preferences.xhtml',
        'zotero-prefs',
        'chrome,titlebar,toolbar,centerscreen,dialog=no',
        { pane: paneID }
      );
    }
  } catch (e) {
    Zotero.logError(e);
  }
}

export function formatModShortcutLabel(): string {
  const isMac = typeof Zotero !== 'undefined' ? Boolean(Zotero.isMac) : true;
  return isMac ? '⌘K' : 'Ctrl+K';
}
