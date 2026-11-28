import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importTs } from './_helper.mjs';
import { SqliteConnection } from './_sqlite.mjs';

test('plugin lifecycle keeps one MCP owner and finishes shutdown before starting again', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zv-bootstrap-'));
  const prefRegistration = Promise.withResolvers();
  const allowPrefRegistration = Promise.withResolvers();
  const allowStoreOpen = Promise.withResolvers();
  const token = 'a'.repeat(64);
  const prefs = new Map([
    ['extensions.zotero-vectorize.mcpEnabled', true],
    ['extensions.zotero-vectorize.mcpToken', token],
    ['extensions.zotero-vectorize.autoIndexOnStartup', false],
  ]);
  const menuIds = new Set();
  const observers = new Set();
  const prefObservers = new Set();
  const errors = [];
  let resources = null;
  let registrations = 0;
  let listening = false;
  let starts = 0;
  let failWindowEnumeration = false;

  const originalGlobals = new Set(Reflect.ownKeys(globalThis));
  globalThis.PathUtils = { join: path.join };
  globalThis.IOUtils = {
    exists: async () => false,
    makeDirectory: async (dir) => {
      await allowStoreOpen.promise;
      await fs.mkdir(dir, { recursive: true });
    },
  };
  globalThis.Components = {
    classes: {
      '@mozilla.org/network/protocol;1?name=resource': {
        getService: () => ({ setSubstitution: (_name, value) => { resources = value; } }),
      },
    },
    interfaces: { nsIResProtocolHandler: {} },
  };
  globalThis.Services = { io: { newURI: (uri) => uri }, appShell: { hiddenDOMWindow: globalThis } };
  globalThis.Zotero = {
    DataDirectory: { dir: dataDir },
    DBConnection: SqliteConnection,
    Prefs: {
      get: (key) => prefs.get(key),
      set: (key, value) => prefs.set(key, value),
      registerObserver: (key) => { prefObservers.add(key); return key; },
      unregisterObserver: (key) => prefObservers.delete(key),
    },
    PreferencePanes: {
      register: async ({ id }) => {
        registrations++;
        prefRegistration.resolve();
        await allowPrefRegistration.promise;
        return id;
      },
      unregister: () => {},
    },
    MenuManager: {
      registerMenu: ({ menuID }) => { menuIds.add(menuID); return menuID; },
      unregisterMenu: (id) => menuIds.delete(id),
    },
    Notifier: {
      registerObserver: () => { const id = Symbol(); observers.add(id); return id; },
      unregisterObserver: (id) => observers.delete(id),
    },
    getMainWindows: () => {
      if (failWindowEnumeration) throw new Error('fixture window enumeration failed');
      return [];
    },
    logError: (error) => errors.push(error),
  };
  globalThis.ZoteroVectorizeMcpModule = {
    startMcpListener: (_service, _version, _port, listenerToken) => {
      assert.equal(listening, false, 'MCP listener already owns the port');
      assert.equal(listenerToken, token);
      listening = true;
      starts++;
      return async () => { listening = false; };
    },
  };

  await importTs('src/zotero/bootstrap.ts');
  const { startup, shutdown, Zotero } = globalThis;
  const data = { id: 'zotero-vectorize@yckbz.org', version: '1.0.3', rootURI: 'file:///fixture/' };
  const initialServices = new Set();
  t.after(async () => {
    allowPrefRegistration.resolve();
    allowStoreOpen.resolve();
    await Promise.allSettled([...initialServices, Zotero.Vectorize].filter(Boolean).map((svc) => svc.init()));
    await shutdown(data, 2);
    for (const svc of initialServices) await svc.shutdown();
    for (const key of Reflect.ownKeys(globalThis)) {
      if (!originalGlobals.has(key)) delete globalThis[key];
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const firstStart = startup(data, 1);
  await prefRegistration.promise;
  const service = Zotero.Vectorize;
  const mcp = Zotero.VectorizeMcp;
  initialServices.add(service);
  const repeatedStart = startup(data, 1);
  allowPrefRegistration.resolve();
  await Promise.all([firstStart, repeatedStart]);
  initialServices.add(Zotero.Vectorize);
  await startup(data, 1);
  assert.equal(Zotero.Vectorize, service);
  assert.equal(service.version, data.version);
  assert.equal(Zotero.VectorizeMcp, mcp);
  assert.equal(registrations, 1);
  assert.equal(starts, 1);
  assert.equal(mcp.getState().running, true);

  await mcp.setEnabled(false);
  assert.equal(listening, false);
  await mcp.setEnabled(true);
  assert.equal(listening, true);

  const stopping = shutdown(data, 2);
  const restart = startup(data, 1);
  await new Promise(setImmediate);
  assert.equal(listening, false);
  assert.equal(registrations, 1, 'new registration must wait for the old store');
  assert.equal(resources, 'file:///fixture/workers/');
  allowStoreOpen.resolve();
  await Promise.all([stopping, restart]);
  await Zotero.Vectorize.init();
  assert.notEqual(Zotero.Vectorize, service);
  assert.notEqual(Zotero.VectorizeMcp, mcp);
  assert.equal(registrations, 2);
  assert.equal(starts, 3);
  assert.equal(observers.size, 1);
  assert.equal(menuIds.size, 2);
  assert.deepEqual(errors, []);

  await Promise.all([shutdown(data, 2), shutdown(data, 2)]);
  assert.equal(listening, false);
  assert.equal(resources, null);
  assert.equal(observers.size, 0);
  assert.equal(prefObservers.size, 0);
  assert.equal(menuIds.size, 0);

  failWindowEnumeration = true;
  await assert.rejects(startup(data, 1), /fixture window enumeration failed/);
  assert.equal(Zotero.Vectorize, undefined);
  assert.equal(Zotero.VectorizeMcp, undefined);
  assert.equal(listening, false);
  assert.equal(resources, null);
  assert.equal(observers.size, 0);
  failWindowEnumeration = false;
  await startup(data, 1);
  assert.equal(listening, true);
});
