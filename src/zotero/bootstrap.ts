import type { ZoteroItem } from '../types/zotero.d.ts';
import { PLUGIN_ID } from './config.ts';
import { ONNX_WORKER_RESOURCE } from '../engines/local-onnx.ts';
import { VectorizeService } from './service.ts';
import { McpController } from './mcp/controller.ts';
import { injectWindowStyles, removeWindowStyles } from './ui/styles.ts';
import { TopSearchPopover } from './ui/search-popover.ts';
import { CommandPalette } from './ui/command-palette.ts';
import { registerSimilarPapersSection } from './ui/item-pane-section.ts';
import { openPluginPreferences } from './ui/render-utils.ts';

interface WindowUiHandles {
  popover: TopSearchPopover;
  palette: CommandPalette;
  cleanupMenus: () => void;
}

let service: VectorizeService | null = null;
let pluginRootURI = '';
let registeredPrefPaneId: string | null = null;
let unregisterItemSection: (() => void) | null = null;
let unregisterWorkerResources: (() => void) | null = null;
const registeredMenuIds: string[] = [];
const windowHandles = new Map<any, WindowUiHandles>();

function insertWindowFtl(win: any): void {
  try {
    if (win?.MozXULElement?.insertFTLIfNeeded) {
      win.MozXULElement.insertFTLIfNeeded('zotero-vectorize.ftl');
      return;
    }
    const doc = win?.document;
    if (!doc) return;
    if (!doc.querySelector('link[href="zotero-vectorize.ftl"]')) {
      const link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
      link.setAttribute('rel', 'localization');
      link.setAttribute('href', 'zotero-vectorize.ftl');
      (doc.head || doc.documentElement).appendChild(link);
    }
  } catch (e) {
    Zotero.logError(e);
  }
}

function registerPluginMenus(): boolean {
  if (typeof Zotero === 'undefined' || !Zotero.MenuManager?.registerMenu) {
    return false;
  }
  try {
    const toolsId = Zotero.MenuManager.registerMenu({
      menuID: 'zotero-vectorize-tools-menu',
      pluginID: PLUGIN_ID,
      target: 'main/menubar/tools',
      menus: [
        { menuType: 'separator' },
        {
          menuType: 'menuitem',
          l10nID: 'zotero-vectorize-menu-palette',
          onCommand: () => {
            const win = Zotero.getMainWindow();
            const handle = win ? windowHandles.get(win) : undefined;
            void handle?.palette.open();
          },
        },
        {
          menuType: 'menuitem',
          l10nID: 'zotero-vectorize-menu-index-all',
          onCommand: () => {
            void service?.startIndexing(false);
          },
        },
        {
          menuType: 'menuitem',
          l10nID: 'zotero-vectorize-menu-settings',
          onCommand: () => {
            openPluginPreferences(Zotero.getMainWindow());
          },
        },
      ],
    });
    if (toolsId) registeredMenuIds.push(toolsId);

    const itemId = Zotero.MenuManager.registerMenu({
      menuID: 'zotero-vectorize-item-menu',
      pluginID: PLUGIN_ID,
      target: 'main/library/item',
      menus: [
        {
          menuType: 'menuitem',
          l10nID: 'zotero-vectorize-menu-index-selected',
          onCommand: () => {
            const pane = Zotero.getActiveZoteroPane();
            const selected: ZoteroItem[] = pane?.getSelectedItems?.() ?? [];
            const ids = selected.map((it) => it.id).filter((x) => typeof x === 'number' && x > 0);
            if (ids.length > 0) {
              void service?.indexItems(ids, true);
            }
          },
        },
      ],
    });
    if (itemId) registeredMenuIds.push(itemId);
    return true;
  } catch (e) {
    Zotero.logError(e);
    return false;
  }
}

function attachLegacyFallbackMenus(win: any): () => void {
  const doc = win.document;
  const created: Element[] = [];
  const isZh = (Zotero.locale || '').toLowerCase().startsWith('zh');

  const toolsPopup = doc.getElementById('menu_ToolsPopup');
  if (toolsPopup) {
    const sep = doc.createXULElement('menuseparator');
    const miPalette = doc.createXULElement('menuitem');
    miPalette.setAttribute('label', isZh ? 'Zotero Vectorize 语义搜索面板 (⌘K)' : 'Zotero Vectorize Command Palette');
    miPalette.addEventListener('command', () => {
      void windowHandles.get(win)?.palette.open();
    });
    const miPrefs = doc.createXULElement('menuitem');
    miPrefs.setAttribute('label', isZh ? 'Zotero Vectorize 设置与索引…' : 'Zotero Vectorize Settings…');
    miPrefs.addEventListener('command', () => openPluginPreferences(win));
    toolsPopup.append(sep, miPalette, miPrefs);
    created.push(sep, miPalette, miPrefs);
  }

  const itemPopup = doc.getElementById('zotero-itemmenu');
  if (itemPopup) {
    const miIndex = doc.createXULElement('menuitem');
    miIndex.setAttribute('label', isZh ? '立即向量化所选文献' : 'Vectorize Selected Items');
    miIndex.addEventListener('command', () => {
      const selected: ZoteroItem[] = win.ZoteroPane?.getSelectedItems?.() ?? [];
      const ids = selected.map((it) => it.id).filter((x) => typeof x === 'number' && x > 0);
      if (ids.length > 0) void service?.indexItems(ids, true);
    });
    itemPopup.append(miIndex);
    created.push(miIndex);
  }

  return () => {
    for (const el of created) {
      try {
        el.remove();
      } catch {
        // Ignore
      }
    }
  };
}

let usedMenuManager = false;

function attachWindow(win: any): void {
  if (!win || !service || windowHandles.has(win)) return;
  try {
    insertWindowFtl(win);
    injectWindowStyles(win);

    const palette = new CommandPalette({ win, service });
    palette.attachShortcut();

    const popover = new TopSearchPopover({
      win,
      service,
      onOpenPalette: (initialQuery) => {
        void palette.open(initialQuery);
      },
    });
    popover.attach();

    const cleanupMenus = usedMenuManager ? () => {} : attachLegacyFallbackMenus(win);
    windowHandles.set(win, { popover, palette, cleanupMenus });
  } catch (e) {
    Zotero.logError(e);
  }
}

function detachWindow(win: any): void {
  const handles = windowHandles.get(win);
  if (!handles) return;
  windowHandles.delete(win);
  try {
    handles.popover.destroy();
    handles.palette.destroy();
    handles.cleanupMenus();
    removeWindowStyles(win);
  } catch (e) {
    Zotero.logError(e);
  }
}

async function install(_data: any, _reason: number): Promise<void> {
  // No-op: defaults are loaded via prefs.js and DB initializes lazily in DataDirectory
}

async function uninstall(_data: any, _reason: number): Promise<void> {
  // Keep user's isolated vectorize.sqlite intact in case of upgrade/reinstall
}

async function startup(data: { id: string; version: string; rootURI: string }, _reason: number): Promise<void> {
  pluginRootURI = data.rootURI;
  const resources = Components.classes['@mozilla.org/network/protocol;1?name=resource']
    .getService(Components.interfaces.nsIResProtocolHandler);
  resources.setSubstitution(ONNX_WORKER_RESOURCE, Services.io.newURI(pluginRootURI + 'workers/'));
  unregisterWorkerResources = () => resources.setSubstitution(ONNX_WORKER_RESOURCE, null);
  const dataDir = Zotero.DataDirectory.dir;

  service = new VectorizeService({
    rootURI: pluginRootURI,
    dataDir,
  });
  (Zotero as any).Vectorize = service;
  Zotero.VectorizeMcp = new McpController(service, data.version, pluginRootURI);

  // Register native Preferences pane
  if (Zotero.PreferencePanes?.register) {
    try {
      registeredPrefPaneId = await Zotero.PreferencePanes.register({
        pluginID: PLUGIN_ID,
        id: 'zotero-vectorize-prefpane',
        src: `${pluginRootURI}chrome/content/preferences.xhtml`,
        scripts: [`${pluginRootURI}chrome/content/preferences.js`],
        stylesheets: [`${pluginRootURI}chrome/content/preferences.css`],
        label: 'Zotero Vectorize',
        image: `${pluginRootURI}chrome/skin/default/icon.svg`,
      });
    } catch (e) {
      Zotero.logError(e);
    }
  }

  // Register native Item Pane section
  unregisterItemSection = registerSimilarPapersSection(pluginRootURI, service);

  // Register menus (MenuManager with legacy XUL menu fallback)
  usedMenuManager = registerPluginMenus();

  // Initialize DB & search index asynchronously (does not block Zotero startup)
  void service.init().catch((e) => Zotero.logError(e));
  Zotero.VectorizeMcp.restore();

  // Attach to any already-open main windows (e.g., on dynamic plugin install/enable)
  const wins = Zotero.getMainWindows?.() ?? [];
  for (const win of wins) {
    if (win?.document?.readyState === 'complete') {
      attachWindow(win);
    } else if (win?.addEventListener) {
      win.addEventListener('load', () => attachWindow(win), { once: true });
    }
  }
}

async function shutdown(_data: any, _reason: number): Promise<void> {
  await Zotero.VectorizeMcp?.dispose();
  delete Zotero.VectorizeMcp;
  for (const win of Array.from(windowHandles.keys())) {
    detachWindow(win);
  }
  windowHandles.clear();

  for (const menuId of registeredMenuIds) {
    try {
      Zotero.MenuManager?.unregisterMenu(menuId);
    } catch {
      // Ignore
    }
  }
  registeredMenuIds.length = 0;

  if (unregisterItemSection) {
    unregisterItemSection();
    unregisterItemSection = null;
  }

  if (registeredPrefPaneId) {
    try {
      Zotero.PreferencePanes?.unregister(registeredPrefPaneId);
    } catch {
      // Ignore
    }
    registeredPrefPaneId = null;
  }

  if (service) {
    await service.shutdown();
    service = null;
  }
  unregisterWorkerResources?.();
  unregisterWorkerResources = null;
  if ((Zotero as any).Vectorize) {
    delete (Zotero as any).Vectorize;
  }
}

function onMainWindowLoad(data: { window: any }): void {
  attachWindow(data.window);
}

function onMainWindowUnload(data: { window: any }): void {
  detachWindow(data.window);
}

// Expose lifecycle hooks directly on bootstrap sandbox global scope
Object.assign(globalThis, {
  install,
  uninstall,
  startup,
  shutdown,
  onMainWindowLoad,
  onMainWindowUnload,
});
