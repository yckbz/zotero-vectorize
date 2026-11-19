import type { ChunkHitInfo, SearchHit } from '../types/vectorize.ts';

async function resolveBestPdfAttachmentId(
  parentItemID: number,
  preferredAttachmentID?: number,
  preferredAttachmentKey?: string
): Promise<number | null> {
  if (preferredAttachmentID && preferredAttachmentID > 0) {
    try {
      const att = await Zotero.Items.getAsync(preferredAttachmentID);
      if (att && !att.deleted && att.isPDFAttachment()) {
        return att.id;
      }
    } catch {
      // Fallback to parent lookup
    }
  }

  try {
    const parent = await Zotero.Items.getAsync(parentItemID);
    if (!parent || parent.deleted) return null;
    const attIDs = parent.getAttachments?.() ?? [];
    if (attIDs.length === 0) return null;

    let firstPdfId: number | null = null;
    for (const id of attIDs) {
      const att = await Zotero.Items.getAsync(id);
      if (!att || att.deleted || !att.isPDFAttachment()) continue;
      if (preferredAttachmentKey && att.key === preferredAttachmentKey) {
        return att.id;
      }
      if (firstPdfId === null) {
        firstPdfId = att.id;
      }
    }
    return firstPdfId;
  } catch {
    return null;
  }
}

export async function selectItemInLibrary(itemID: number, switchToLibraryTab = false): Promise<boolean> {
  try {
    const win = Zotero.getMainWindow?.() ?? Zotero.getActiveZoteroPane?.()?.window;
    if (switchToLibraryTab && win?.Zotero_Tabs?.select) {
      const tabs = win.Zotero_Tabs;
      if (tabs._tabs && Array.isArray(tabs._tabs)) {
        const libTab = tabs._tabs.find((t: any) => t.type === 'library');
        if (libTab?.id) {
          tabs.select(libTab.id);
        }
      } else if (typeof tabs.selectedType === 'string' && tabs.selectedType !== 'library') {
        tabs.select('zotero-pane');
      }
    }
    const pane = win?.ZoteroPane ?? Zotero.getActiveZoteroPane?.();
    if (pane?.selectItem) {
      try {
        await pane.selectItem(itemID, { noTabSwitch: !switchToLibraryTab });
      } catch {
        await pane.selectItem(itemID);
      }
      return true;
    }
  } catch (e) {
    Zotero.logError(e);
  }
  return false;
}

export async function jumpToSearchHit(
  hit: SearchHit,
  chunk?: ChunkHitInfo | null,
  options?: {
    openPdfIfNoChunk?: boolean;
    clearQuickSearch?: boolean;
    win?: any;
  }
): Promise<void> {
  if (options?.clearQuickSearch && options?.win) {
    try {
      const qs = options.win.document?.getElementById('zotero-tb-search');
      if (qs) {
        if (qs.searchTextbox) qs.searchTextbox.value = '';
        else qs.value = '';
      }
      if (typeof options.win.ZoteroPane?.search === 'function') {
        void options.win.ZoteroPane.search();
      }
    } catch {
      // Ignore quick search clear failure
    }
  }

  const targetChunk = chunk ?? hit.bestChunk ?? null;

  if (targetChunk) {
    let attID: number | null;
    if (targetChunk.sourceFileHash) {
      attID = null;
      try {
        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(hit.libraryID, targetChunk.attachmentKey);
        if (attachment && !attachment.deleted && attachment.isPDFAttachment() && attachment.parentItemID === hit.itemID) {
          const runner = Zotero.Sync?.Runner;
          if (!await attachment.getFilePathAsync() && attachment.isStoredFileAttachment?.() && !runner?.syncInProgress) {
            await runner?.downloadFile(attachment);
          }
          if (await attachment.attachmentHash === targetChunk.sourceFileHash && !attachment.deleted &&
              attachment.parentItemID === hit.itemID) attID = attachment.id;
        }
      } catch {
        // The library entry remains available when the synced file cannot be opened safely.
      }
      if (attID === null) {
        await selectItemInLibrary(hit.itemID, false);
        return;
      }
    } else {
      attID = await resolveBestPdfAttachmentId(hit.itemID, targetChunk.attachmentID, targetChunk.attachmentKey);
    }
    if (attID) {
      // Keep library selection synced silently before opening reader (noTabSwitch prevents focus/tab stealing)
      await selectItemInLibrary(hit.itemID, false);
      const pageIndex = Math.max(0, Math.floor(targetChunk.pageIndex || 0));
      const reader = await Zotero.Reader.open(attID, { pageIndex });
      if (reader) {
        try {
          if (reader._initPromise) {
            await reader._initPromise;
          }
          await reader.navigate({ pageIndex });
          await reader.focus();
        } catch {
          // Reader already initiated navigation during open()
        }
      }
      return;
    }
  }

  if (options?.openPdfIfNoChunk) {
    const attID = await resolveBestPdfAttachmentId(hit.itemID);
    if (attID) {
      await selectItemInLibrary(hit.itemID, false);
      await Zotero.Reader.open(attID);
      return;
    }
  }

  await selectItemInLibrary(hit.itemID, true);
}

export async function getItemPdfAttachmentId(itemID: number): Promise<number | null> {
  return resolveBestPdfAttachmentId(itemID);
}
