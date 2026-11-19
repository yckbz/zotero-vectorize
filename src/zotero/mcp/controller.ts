import { PREF_BRANCH } from '../config.ts';
import type { VectorizeService } from '../service.ts';
import type { startMcpListener } from './listener.ts';

const ENABLED_PREF = PREF_BRANCH + 'mcpEnabled';
const TOKEN_PREF = PREF_BRANCH + 'mcpToken';
const PORT = 23124;
const URL = `http://127.0.0.1:${PORT}/mcp`;

type ListenerModule = { startMcpListener: typeof startMcpListener };

export class McpController {
  readonly url = URL;
  private stopListening: (() => Promise<void>) | null = null;
  private token = '';
  private failed = false;
  private disposed = false;
  private transition = Promise.resolve();

  constructor(private readonly service: VectorizeService, private readonly version: string, private readonly rootURI: string) {}

  getState() {
    return { running: this.stopListening !== null, failed: this.failed };
  }

  restore(): void {
    try {
      if (Zotero.Prefs.get(ENABLED_PREF, true)) this.start();
    } catch (error) {
      this.reportError(error);
    }
  }

  setEnabled(enabled: boolean): Promise<void> {
    this.transition = this.transition.then(async () => {
      if (this.disposed) return;
      this.failed = false;
      if (enabled) this.start();
      else await this.stop();
      Zotero.Prefs.set(ENABLED_PREF, this.stopListening !== null, true);
    }).catch((error) => this.reportError(error));
    return this.transition;
  }

  copyCodexConfig(): void {
    if (!this.stopListening) return;
    const { classes, interfaces } = Components;
    const clipboard = classes['@mozilla.org/widget/clipboardhelper;1'].getService(interfaces.nsIClipboardHelper);
    clipboard.copyString(`[mcp_servers.zotero_vectorize]\nurl = "${this.url}"\nhttp_headers = { Authorization = "Bearer ${this.token}" }\n`);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.transition;
    await this.stop();
  }

  private async stop(): Promise<void> {
    const close = this.stopListening;
    this.stopListening = null;
    this.token = '';
    if (!close) return;
    try {
      await close();
    } catch (error) {
      this.reportError(error);
    }
  }

  private start(): void {
    if (this.stopListening) return;
    try {
      const scope = globalThis as typeof globalThis & { ZoteroVectorizeMcpModule?: ListenerModule };
      if (!scope.ZoteroVectorizeMcpModule) Services.scriptloader.loadSubScript(`${this.rootURI}mcp.js`, scope);
      const module = scope.ZoteroVectorizeMcpModule;
      if (!module) throw new Error('MCP module did not load');
      let token: string = Zotero.Prefs.get(TOKEN_PREF, true);
      if (!/^[a-f0-9]{64}$/.test(token)) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        Zotero.Prefs.set(TOKEN_PREF, token, true);
      }
      this.stopListening = module.startMcpListener(this.service, this.version, PORT, token);
      this.token = token;
      this.failed = false;
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    this.failed = true;
    Zotero.logError(error);
  }
}
