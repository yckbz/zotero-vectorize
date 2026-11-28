import test from 'node:test';
import assert from 'node:assert/strict';
import { importTs } from './_helper.mjs';

function fakeDocument() {
  const makeNode = (tag) => {
    const node = {
      tag,
      attributes: {},
      children: [],
      listeners: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      get textContent() {
        return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join('');
      },
    };
    return node;
  };
  return {
    createElementNS: (_ns, tag) => makeNode(tag),
    createTextNode: (text) => text,
    getElementById: () => null,
  };
}

function findAll(node, tag, found = []) {
  if (node && typeof node === 'object') {
    if (node.tag === tag) found.push(node);
    for (const child of node.children) findAll(child, tag, found);
  }
  return found;
}

test('Preferences footer shows the running version and opens project links in the system browser', async (t) => {
  const launched = [];
  const logged = [];
  globalThis.document = fakeDocument();
  globalThis.window = {};
  globalThis.Zotero = {
    launchURL: (url) => {
      launched.push(url);
      if (url.endsWith('/issues/new')) throw new Error('no browser');
    },
    logError: (error) => logged.push(error),
  };
  t.after(() => {
    delete globalThis.ZoteroVectorizePrefs;
    delete globalThis.Zotero;
    delete globalThis.document;
    delete globalThis.window;
  });
  await importTs('src/zotero/ui/preferences.ts');
  const { getStrings } = await importTs('src/zotero/i18n.ts');
  const controller = globalThis.ZoteroVectorizePrefs;
  const strings = getStrings({ uiLanguage: 'en-US' });

  const footer = controller.buildFooter(globalThis.document, { version: '1.0.3-beta.5' }, strings);
  assert.match(footer.textContent, /^Zotero Vectorize v1\.0\.3-beta\.5 · GitHub · Report an issue/);
  assert.match(footer.textContent, /Open a GitHub issue/);

  const [repo, issue] = findAll(footer, 'a');
  assert.equal(repo.attributes.href, 'https://github.com/yckbz/zotero-vectorize');
  assert.equal(issue.attributes.href, 'https://github.com/yckbz/zotero-vectorize/issues/new');

  let prevented = 0;
  repo.listeners.click({ preventDefault: () => prevented++ });
  // A failure to open the browser is logged instead of escaping the click handler.
  issue.listeners.click({ preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  assert.deepEqual(launched, [repo.attributes.href, issue.attributes.href]);
  assert.equal(logged.length, 1);

  const unknown = controller.buildFooter(globalThis.document, { version: '' }, getStrings({ uiLanguage: 'zh-CN' }));
  assert.match(unknown.textContent, /^Zotero Vectorize · GitHub · 反馈问题/);
});
