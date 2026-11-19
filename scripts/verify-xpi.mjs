import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const XPI_PATH = path.join(ROOT, 'dist', 'zotero-vectorize.xpi');

const REQUIRED_FILES = [
  'manifest.json',
  'bootstrap.js',
  'mcp.js',
  'prefs.js',
  'licenses/core.txt',
  'licenses/server.txt',
  'licenses/zod.txt',
  'licenses/onnxruntime.txt',
  'licenses/onnxruntime-third-party.txt',
  'chrome/content/preferences.xhtml',
  'chrome/content/preferences.js',
  'chrome/content/preferences.css',
  'chrome/skin/default/icon.svg',
  'chrome/skin/default/icon-16.svg',
  'locale/en-US/zotero-vectorize.ftl',
  'locale/zh-CN/zotero-vectorize.ftl',
  'workers/onnx-worker.mjs',
  'workers/ort.bundle.min.mjs',
  'workers/ort-wasm-simd-threaded.wasm',
];

async function main() {
  const stat = await fs.stat(XPI_PATH);
  assert.ok(stat.size > 10_000, `XPI unexpectedly small: ${stat.size} bytes`);

  const pyInspect = `
import json, sys, zipfile
xpi_path = sys.argv[1]
with zipfile.ZipFile(xpi_path, 'r') as zf:
    names = zf.namelist()
    manifest = json.loads(zf.read('manifest.json').decode('utf-8'))
    bootstrap = zf.read('bootstrap.js').decode('utf-8')
    prefs = zf.read('chrome/content/preferences.js').decode('utf-8')
    worker = zf.read('workers/onnx-worker.mjs').decode('utf-8')
    xhtml = zf.read('chrome/content/preferences.xhtml').decode('utf-8')
    ftl_en = zf.read('locale/en-US/zotero-vectorize.ftl').decode('utf-8')
    ftl_zh = zf.read('locale/zh-CN/zotero-vectorize.ftl').decode('utf-8')
    print(json.dumps({
        'names': names,
        'manifest': manifest,
        'bootstrapSize': len(bootstrap),
        'prefsSize': len(prefs),
        'workerSize': len(worker),
        'xhtml': xhtml,
        'ftlEn': ftl_en,
        'ftlZh': ftl_zh,
    }))
`;
  const raw = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', pyInspect, XPI_PATH],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const info = JSON.parse(raw);

  // 1. Check archive paths (no leading ./, no .ts leaks, all required entries present)
  for (const name of info.names) {
    assert.ok(!name.startsWith('./'), `Bad relative entry prefix: ${name}`);
    assert.ok(!name.endsWith('.ts'), `TypeScript source leaked into XPI: ${name}`);
    assert.ok(!name.includes('node_modules'), `node_modules leaked into XPI: ${name}`);
  }
  for (const req of REQUIRED_FILES) {
    assert.ok(info.names.includes(req), `Missing required entry in XPI: ${req}`);
  }

  // 2. Check manifest.json satisfies modern Zotero requirements
  const m = info.manifest;
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(m.version, pkg.version, 'Package and XPI versions must match');
  assert.equal(m.manifest_version, 2);
  assert.ok(m.applications?.zotero?.id, 'Missing applications.zotero.id');
  assert.ok(m.applications?.zotero?.update_url, 'Missing applications.zotero.update_url');
  assert.ok(m.applications?.zotero?.strict_min_version, 'Missing strict_min_version');
  assert.ok(m.applications?.zotero?.strict_max_version, 'Missing strict_max_version');

  // 3. Parse-check bundled JS files and verify bootstrap lifecycle exports
  const buildDir = path.join(ROOT, 'build');
  for (const rel of ['bootstrap.js', 'mcp.js', 'chrome/content/preferences.js']) {
    const code = await fs.readFile(path.join(buildDir, rel), 'utf8');
    new vm.Script(code, { filename: rel });
  }
  for (const rel of ['workers/onnx-worker.mjs', 'workers/ort.bundle.min.mjs']) {
    execFileSync(process.execPath, ['--check', path.join(buildDir, rel)]);
  }

  // Execute bootstrap.js in a minimal sandbox to verify lifecycle symbols are defined on globalThis
  const bootstrapCode = await fs.readFile(path.join(buildDir, 'bootstrap.js'), 'utf8');
  const sandbox = {
    globalThis: null,
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(bootstrapCode, sandbox);
  for (const fnName of ['install', 'uninstall', 'startup', 'shutdown', 'onMainWindowLoad', 'onMainWindowUnload']) {
    assert.equal(typeof sandbox[fnName], 'function', `bootstrap.js missing global ${fnName}()`);
  }

  // Verify XHTML well-formedness basics
  assert.ok(info.xhtml.includes('id="zv-prefpane"'));
  assert.ok(info.xhtml.includes('class="main-section'));

  // Verify Fluent FTL entries use .label / .tooltiptext attributes so DOM overlays do not wipe section children
  for (const [lang, ftl] of [['en-US', info.ftlEn], ['zh-CN', info.ftlZh]]) {
    assert.match(ftl, /zotero-vectorize-item-pane-header\s*=\s*\r?\n\s+\.label\s*=/, `${lang} item-pane-header must use .label`);
    assert.match(ftl, /zotero-vectorize-item-pane-sidenav\s*=\s*\r?\n\s+\.tooltiptext\s*=/, `${lang} item-pane-sidenav must use .tooltiptext`);
    for (const menuKey of ['palette', 'index-all', 'settings', 'index-selected']) {
      assert.match(ftl, new RegExp(`zotero-vectorize-menu-${menuKey}\\s*=\\s*\\r?\\n\\s+\\.label\\s*=`), `${lang} menu-${menuKey} must use .label`);
    }
  }

  console.log(`Verified XPI (${info.names.length} files, ${(stat.size / 1024).toFixed(1)} KB): OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
