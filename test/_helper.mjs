import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_TEST_BUILD = path.join(os.tmpdir(), `zotero-vectorize-test-${process.pid}`);

export async function importTs(relPath) {
  const absEntry = path.join(ROOT, relPath);
  const outName = relPath.replace(/[^a-zA-Z0-9._-]+/g, '_') + '.mjs';
  const outFile = path.join(TMP_TEST_BUILD, outName);
  await fs.mkdir(TMP_TEST_BUILD, { recursive: true });
  await esbuild.build({
    entryPoints: [absEntry],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outFile).href);
}
