import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADDON_DIR = path.join(ROOT, 'addon');
const BUILD_DIR = path.join(ROOT, 'build');
const DIST_DIR = path.join(ROOT, 'dist');
const XPI_PATH = path.join(DIST_DIR, 'zotero-vectorize.xpi');

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const shouldPackage = args.has('--xpi');

  await fs.rm(BUILD_DIR, { recursive: true, force: true });
  await fs.mkdir(BUILD_DIR, { recursive: true });

  // 1. Copy static addon assets
  await copyDir(ADDON_DIR, BUILD_DIR);

  // 2. Bundle TS entry points for modern Zotero (Gecko 115–140+)
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/zotero/bootstrap.ts')],
    outfile: path.join(BUILD_DIR, 'bootstrap.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'firefox115',
    charset: 'utf8',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/zotero/ui/preferences.ts')],
    outfile: path.join(BUILD_DIR, 'chrome/content/preferences.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'firefox115',
    charset: 'utf8',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/workers/onnx-worker.ts')],
    outfile: path.join(BUILD_DIR, 'workers/onnx-worker.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'firefox115',
    plugins: [{
      name: 'packaged-onnx-runtime',
      setup(build) {
        build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({ path: './ort.bundle.min.mjs', external: true }));
      },
    }],
    charset: 'utf8',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });
  for (const file of ['ort.bundle.min.mjs', 'ort-wasm-simd-threaded.wasm']) {
    await fs.copyFile(path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', file), path.join(BUILD_DIR, 'workers', file));
  }

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/zotero/mcp/listener.ts')],
    outfile: path.join(BUILD_DIR, 'mcp.js'),
    bundle: true,
    format: 'iife',
    globalName: 'ZoteroVectorizeMcpModule',
    platform: 'browser',
    target: 'firefox115',
    charset: 'utf8',
    logLevel: 'info',
  });
  const licenses = path.join(BUILD_DIR, 'licenses');
  await fs.mkdir(licenses, { recursive: true });
  for (const dependency of ['@modelcontextprotocol/core', '@modelcontextprotocol/server', 'zod']) {
    const filename = dependency.split('/').pop();
    await fs.copyFile(path.join(ROOT, 'node_modules', dependency, 'LICENSE'), path.join(licenses, `${filename}.txt`));
  }

  if (shouldPackage) {
    await fs.mkdir(DIST_DIR, { recursive: true });
    await fs.rm(XPI_PATH, { force: true });

    const pyScript = `
import os, sys, zipfile
build_dir, out_xpi = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out_xpi, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for root, dirs, files in os.walk(build_dir):
        dirs.sort()
        for f in sorted(files):
            if f == '.DS_Store':
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, build_dir).replace(os.sep, '/')
            zf.write(full, rel)
`;
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', pyScript, BUILD_DIR, XPI_PATH], { stdio: 'inherit' });
    const stat = await fs.stat(XPI_PATH);
    console.log(`Packaged ${XPI_PATH} (${(stat.size / 1024).toFixed(1)} KB)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
