import type { VectorizeService } from '../service.ts';
import { createMcpRequestHandler } from './tools.ts';

const PATH = '/mcp';
const MAX_BODY_BYTES = 32_768;
const REQUEST_TIMEOUT_MS = 45_000;

interface GeckoRequest {
  method: string;
  httpVersion: string;
  bodyInputStream: { available(): number };
  hasHeader(name: string): boolean;
  getHeader(name: string): string;
}

interface GeckoResponse {
  setStatusLine(version: string, status: number, reason: string): void;
  setHeader(name: string, value: string, merge: boolean): void;
  processAsync(): void;
  finish(): void;
  bodyOutputStream: unknown;
}

interface GeckoHttpServer {
  registerPathHandler(path: string, handler: (request: GeckoRequest, response: GeckoResponse) => void): void;
  start(port: number): void;
  stop(callback: () => void): void;
}

function sendStatus(request: GeckoRequest, response: GeckoResponse, status: number, reason: string): void {
  response.setStatusLine(request.httpVersion, status, reason);
  response.setHeader('Cache-Control', 'no-store', false);
}

export function startMcpListener(service: VectorizeService, version: string, port: number, token: string): () => Promise<void> {
  // Zotero's bootstrap sandbox does not import the Fetch constructors.
  const platform = Services.appShell.hiddenDOMWindow;
  Object.assign(globalThis, {
    Request: platform.Request,
    Response: platform.Response,
    Headers: platform.Headers,
    AbortController: platform.AbortController,
    AbortSignal: platform.AbortSignal,
    ReadableStream: platform.ReadableStream,
  });
  const { HttpServer } = ChromeUtils.importESModule<{ HttpServer: new () => GeckoHttpServer }>(
    'chrome://remote/content/server/httpd.sys.mjs'
  );
  const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
  const server = new HttpServer();
  const host = `127.0.0.1:${port}`;
  const url = `http://${host}${PATH}`;
  const active = new Set<AbortController>();
  const lifetime = new AbortController();
  const handler = createMcpRequestHandler(service, version, MAX_BODY_BYTES);

  server.registerPathHandler(PATH, (request, response) => {
    if (lifetime.signal.aborted) {
      sendStatus(request, response, 503, 'Service Unavailable');
      return;
    }
    if (!request.hasHeader('Host') || request.getHeader('Host') !== host || request.hasHeader('Origin')) {
      sendStatus(request, response, 403, 'Forbidden');
      return;
    }
    if (!request.hasHeader('Authorization') || request.getHeader('Authorization') !== `Bearer ${token}`) {
      sendStatus(request, response, 401, 'Unauthorized');
      response.setHeader('WWW-Authenticate', 'Bearer', false);
      return;
    }
    if (request.method !== 'POST') {
      sendStatus(request, response, 405, 'Method Not Allowed');
      response.setHeader('Allow', 'POST', false);
      return;
    }
    if (request.bodyInputStream.available() > MAX_BODY_BYTES) {
      sendStatus(request, response, 413, 'Content Too Large');
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    response.processAsync();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    void (async () => {
      try {
        const headers = new Headers();
        for (const name of ['Accept', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name']) {
          if (request.hasHeader(name)) headers.set(name, request.getHeader(name));
        }
        const length = request.bodyInputStream.available();
        const body = length ? NetUtil.readInputStreamToString(request.bodyInputStream, length, { charset: 'UTF-8' }) : '';
        let reply: Response;
        try {
          const parsedBody: unknown = JSON.parse(body);
          const exchange = new Request(url, { method: 'POST', headers, signal: controller.signal });
          reply = await handler.fetch(exchange, { parsedBody });
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          reply = Response.json({
            jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON request.' },
          }, { status: 400 });
        }
        const content = await reply.text();
        controller.signal.throwIfAborted();
        sendStatus(request, response, reply.status, reply.statusText);
        const contentType = reply.headers.get('Content-Type');
        if (contentType) response.setHeader('Content-Type', contentType, false);
        if (content) {
          const { classes, interfaces } = Components;
          const stream = classes['@mozilla.org/intl/converter-output-stream;1']
            .createInstance(interfaces.nsIConverterOutputStream);
          stream.init(response.bodyOutputStream, 'UTF-8', 0, 0);
          stream.writeString(content);
        }
      } catch {
        if (controller.signal.aborted) {
          sendStatus(request, response, lifetime.signal.aborted ? 503 : 504, lifetime.signal.aborted ? 'Service Unavailable' : 'Gateway Timeout');
        } else {
          sendStatus(request, response, 500, 'Internal Server Error');
        }
      } finally {
        clearTimeout(timer);
        active.delete(controller);
        response.finish();
      }
    })().catch(() => {
      // A closed client socket must not escape into the Zotero plugin lifecycle.
    });
  });

  server.start(port);
  return () => {
    lifetime.abort();
    for (const controller of active) controller.abort();
    void handler.close().catch(() => {});
    return new Promise((resolve) => server.stop(resolve));
  };
}
