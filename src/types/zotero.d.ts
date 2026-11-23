import type { McpController } from '../zotero/mcp/controller.ts';

declare global {
  const Zotero: ZoteroNamespace;
  const Services: ServicesNamespace;
  const IOUtils: IOUtilsNamespace;
  const PathUtils: PathUtilsNamespace;
  const ChromeUtils: ChromeUtilsNamespace;
  const Components: ComponentsNamespace;
  const Localization: new (resourceIds: string[], sync?: boolean) => LocalizationInstance;

  interface Document {
    createXULElement?(tagName: string): any;
  }

  const APP_STARTUP: number;
  const APP_SHUTDOWN: number;
  const ADDON_ENABLE: number;
  const ADDON_DISABLE: number;
  const ADDON_INSTALL: number;
  const ADDON_UNINSTALL: number;
  const ADDON_UPGRADE: number;
  const ADDON_DOWNGRADE: number;
  const MAIN_WINDOW_LOAD: number;
  const MAIN_WINDOW_UNLOAD: number;
}

export interface LocalizationInstance {
  formatValue(id: string, args?: Record<string, string | number>): Promise<string>;
}

export interface ChromeUtilsNamespace {
  importESModule<T = Record<string, any>>(uri: string): T;
  base64URLEncode(source: BufferSource, options: { pad: boolean }): string;
  base64URLDecode(value: string, options: { padding: 'require' }): ArrayBuffer;
}

export interface ComponentsNamespace {
  classes: Record<string, { createInstance(iface: unknown): any; getService(iface: unknown): any }>;
  interfaces: Record<string, unknown> & { nsIAsyncInputStream: { readonly WAIT_CLOSURE_ONLY: number } };
  utils: {
    cloneInto<T>(obj: T, targetScope: any, options?: Record<string, any>): T;
  };
}

export interface ServicesNamespace {
  io: { newURI(uri: string): unknown };
  appShell: { hiddenDOMWindow: Window & typeof globalThis };
  tm: { mainThread: unknown };
  wm: {
    getMostRecentWindow(type: string): any;
    getEnumerator(type: string): Iterable<any>;
  };
  prefs: {
    getBoolPref(name: string, defaultValue?: boolean): boolean;
    setBoolPref(name: string, value: boolean): void;
  };
  appinfo: {
    OS: string;
    version: string;
    platformVersion: string;
  };
  scriptloader: {
    loadSubScript(url: string, targetObj?: any): void;
  };
}

export interface IOUtilsNamespace {
  read(path: string, options?: { offset?: number; maxBytes?: number }): Promise<Uint8Array<ArrayBuffer>>;
  readUTF8(path: string): Promise<string>;
  readJSON(path: string): Promise<any>;
  write(path: string, data: Uint8Array, options?: Record<string, any>): Promise<number>;
  writeUTF8(path: string, data: string, options?: Record<string, any>): Promise<number>;
  exists(path: string): Promise<boolean>;
  makeDirectory(path: string, options?: { ignoreExisting?: boolean; createAncestors?: boolean }): Promise<void>;
  remove(path: string, options?: { ignoreAbsent?: boolean; recursive?: boolean }): Promise<void>;
  move(source: string, dest: string, options?: { noOverwrite?: boolean }): Promise<void>;
  copy(source: string, dest: string, options?: { noOverwrite?: boolean }): Promise<void>;
  stat(path: string): Promise<{ size: number; lastModified: number; type: string }>;
  setModificationTime(path: string, modificationTime: number): Promise<number>;
  getChildren(path: string): Promise<string[]>;
}

export interface PathUtilsNamespace {
  join(...parts: string[]): string;
  parent(path: string): string;
  filename(path: string): string;
}

export interface ZoteroDBConnectionInstance {
  path: string;
  closed: boolean;
  queryAsync<T = Record<string, any>>(
    sql: string,
    params?: any[] | Record<string, any> | string | number,
    options?: { debug?: boolean; debugParams?: boolean; noParseParams?: boolean; noCache?: boolean }
  ): Promise<T[]>;
  valueQueryAsync<T = any>(
    sql: string,
    params?: any[] | Record<string, any> | string | number,
    options?: { debug?: boolean; debugParams?: boolean; noParseParams?: boolean }
  ): Promise<T>;
  rowQueryAsync<T = Record<string, any>>(
    sql: string,
    params?: any[] | Record<string, any> | string | number,
    options?: { debug?: boolean; debugParams?: boolean; noParseParams?: boolean }
  ): Promise<T | false>;
  executeTransaction(fn: () => Promise<void>): Promise<void>;
  tableExists(name: string, db?: string): Promise<boolean>;
  closeDatabase(waitForShutdown?: boolean): Promise<void>;
}

export interface ZoteroItem {
  id: number;
  key: string;
  libraryID: number;
  itemType: string;
  deleted: boolean;
  isFeedItem?: boolean;
  parentID?: number | false;
  parentItemID?: number | false;
  parentItem?: ZoteroItem | null;
  attachmentContentType?: string;
  attachmentLinkMode?: number;
  attachmentHash?: Promise<string | null> | string | null;
  attachmentModificationTime?: Promise<number> | number;
  attachmentSyncedHash?: string | null;
  attachmentSyncState?: number;
  dateModified: string;
  isRegularItem(): boolean;
  isAttachment(): boolean;
  isPDFAttachment(): boolean;
  isStoredFileAttachment?(): boolean;
  addTag?(tag: string): void;
  setField?(field: string, value: string): void;
  saveTx?(): Promise<number | false>;
  getField(field: string, unformatted?: boolean, includeBaseMapped?: boolean): string;
  getCreators(): Array<{ firstName?: string; lastName?: string; name?: string; creatorTypeID?: number }>;
  getTags(): Array<{ tag: string; type?: number }>;
  getAttachments(includeTrashed?: boolean): number[];
  getCollections(): number[];
  attachmentFilename?: string;
  getFilePathAsync(): Promise<string | false>;
  getDisplayTitle(includeDeleted?: boolean): string;
}

export interface ZoteroReaderInstance {
  itemID: number;
  tabID?: string;
  _initPromise?: Promise<void>;
  navigate(location: Record<string, any>, options?: Record<string, any>): Promise<void> | void;
  focus(): Promise<void>;
}

export interface ZoteroNamespace {
  VectorizeMcp?: McpController;
  version: string;
  platformMajorVersion?: number;
  isMac?: boolean;
  isWin?: boolean;
  isLinux?: boolean;
  debug(msg: any): void;
  logError(err: any): void;
  warn(msg: any): void;
  DataDirectory: {
    dir: string;
    getDatabase(name: string): string;
  };
  Utilities: { randomString?(length: number): string; Internal: { md5Async(path: string): Promise<string> } };
  Users?: { getCurrentUserID(): number | null };
  DBConnection: new (dbNameOrPath: string) => ZoteroDBConnectionInstance;
  Prefs: {
    get(pref: string, global?: boolean): any;
    set(pref: string, value: any, global?: boolean): void;
    clear(pref: string, global?: boolean): void;
    registerObserver(pref: string, handler: (value: any) => void, global?: boolean): symbol;
    unregisterObserver(symbol: symbol): void;
  };
  Libraries: {
    userLibraryID: number;
    getAll(): Array<{ libraryID: number; name: string; libraryType: string }>;
  };
  Collections: {
    getByLibrary(libraryID: number, recursive?: boolean): ZoteroCollection[];
  };
  Item?: new (itemType: string) => ZoteroItem;
  Items: {
    get(ids: number): ZoteroItem | false;
    get(ids: number[]): ZoteroItem[];
    getAsync(ids: number | number[]): Promise<any>;
    getAll(libraryID: number, onlyTopLevel?: boolean, includeDeleted?: boolean): Promise<ZoteroItem[]>;
    getIDs(libraryID: number, onlyTopLevel?: boolean, includeDeleted?: boolean): Promise<number[]>;
    getByLibraryAndKey(libraryID: number, key: string): ZoteroItem | false;
    getByLibraryAndKeyAsync(libraryID: number, key: string): Promise<ZoteroItem | false>;
    erase(ids: number[]): Promise<void>;
  };
  Attachments: {
    LINK_MODE_LINKED_FILE: number;
    getStorageDirectory(item: ZoteroItem): { path: string };
    importFromFile?(options: {
      file: string;
      libraryID: number;
      parentItemID?: number;
      title: string;
      contentType: string;
    }): Promise<ZoteroItem>;
  };
  Sync?: {
    Runner: {
      readonly enabled: boolean;
      readonly syncInProgress: boolean;
      delayIndefinite(): () => void;
      sync(options: { libraries: number[]; background: boolean; onError?: (error: unknown) => void }): Promise<unknown>;
      downloadFile(item: ZoteroItem): Promise<unknown>;
      getStorageController(mode: 'webdav'): {
        _init(): Promise<void>;
        _getItemURI(item: ZoteroItem): object;
        _getItemPropertyURI(item: ZoteroItem): object;
      };
    };
    Storage: {
      Local: {
        readonly SYNC_STATE_IN_SYNC: number;
        readonly SYNC_STATE_IN_CONFLICT: number;
        getModeForLibrary(libraryID: number): string;
        updateSyncStates(items: ZoteroItem[], state: 'to_upload' | 'force_upload'): Promise<void>;
      };
    };
  };
  Fulltext: {
    fulltextCacheFile: string;
    getPages(itemID: number): Promise<{ indexedPages: number; total: number } | false>;
  };
  PDFWorker: {
    getFullText(itemID: number, maxPages?: number | null, isPriority?: boolean, password?: string): Promise<{
      text: string;
      extractedPages: number;
      totalPages: number;
    }>;
  };
  Reader: {
    _readers?: ZoteroReaderInstance[];
    open(itemID: number, location?: Record<string, any>, options?: Record<string, any>): Promise<ZoteroReaderInstance | undefined>;
  };
  Notifier: {
    registerObserver(
      observer: { notify: (event: string, type: string, ids: Array<number | string>, extraData: Record<string, any>) => void },
      types: string[],
      id?: string
    ): string;
    unregisterObserver(id: string): void;
  };
  PreferencePanes: {
    register(options: {
      pluginID: string;
      src: string;
      id?: string;
      label?: string;
      image?: string;
      scripts?: string[];
      stylesheets?: string[];
      helpURL?: string;
    }): Promise<string>;
    unregister(id: string): void;
  };
  MenuManager?: {
    registerMenu(options: {
      menuID: string;
      pluginID: string;
      target: string;
      menus: Array<Record<string, any>>;
    }): string | false | void;
    unregisterMenu(menuID: string): void;
  };
  ItemPaneManager?: {
    registerSection(options: {
      paneID: string;
      pluginID: string;
      header: {
        l10nID: string;
        l10nArgs?: string;
        icon: string;
        darkIcon?: string;
      };
      sidenav: {
        l10nID: string;
        l10nArgs?: string;
        icon: string;
        darkIcon?: string;
        orderable?: boolean;
      };
      onInit?: (args: { paneID: string; doc: Document; body: HTMLElement; refresh?: () => Promise<void> | void }) => void;
      onDestroy?: (args: { paneID: string; doc: Document; body: HTMLElement }) => void;
      onItemChange?: (args: {
        paneID: string;
        doc: Document;
        body: HTMLElement;
        item: ZoteroItem;
        tabType: string;
        editable: boolean;
        setEnabled: (enabled: boolean) => void;
      }) => boolean | void;
      onRender?: (args: { doc: Document; body: HTMLElement; item: ZoteroItem; editable: boolean }) => void;
      onAsyncRender?: (args: { doc: Document; body: HTMLElement; item: ZoteroItem }) => Promise<void>;
      onToggle?: (args: { paneID: string; doc: Document; body: HTMLElement; item: ZoteroItem }) => void;
    }): string | false;
    unregisterSection(paneID: string): boolean;
  };
  HTTP: {
    request(
      method: string,
      url: string | object,
      options?: {
        headers?: Record<string, string>;
        body?: string;
        timeout?: number;
        responseType?: string;
        successCodes?: number[] | false;
        noCache?: boolean;
        requestObserver?: (request: XMLHttpRequest) => void;
      }
    ): Promise<{ status: number; responseText: string; response: any; getResponseHeader(name: string): string | null }>;
  };
  File: {
    pathToFile(path: string): object;
    createDirectoryIfMissingAsync(path: string): Promise<void>;
    getContentsAsync(path: string): Promise<string>;
    getContentsFromURL?(url: string): string;
    getResourceAsync?(url: string): Promise<string>;
    putContentsAsync(path: string, contents: string): Promise<void>;
  };
  ItemTypes: {
    getName(id: number): string;
    getLocalizedString(itemType: string): string;
  };
  getMainWindow(): any;
  getMainWindows(): any[];
  getActiveZoteroPane(): any;
  locale?: string;
}

export interface ZoteroCollection {
  name: string;
  getChildCollections(asIDs?: false): ZoteroCollection[] | false;
  getChildItems(asIDs: true, includeDeleted?: boolean): number[] | false;
}
