/** Requires a working SQLite binding in Electron. Does not rebuild or invoke real agent CLIs. */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build as bundle } from 'esbuild';
import { build } from 'vite';
const exec = promisify(execFile), require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'vs-p5-baseline-'));
try {
  await build({ configFile: false, root: resolve('src/renderer'), base: './', logLevel: 'silent', esbuild: { jsx: 'automatic' }, build: { outDir: join(root, 'renderer'), emptyOutDir: true } });
  await bundle({ entryPoints: ['src/preload/index.ts'], outfile: join(root, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  await bundle({ entryPoints: ['tests/helpers/p5-baseline-electron.ts'], outfile: join(root, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent',
    plugins: [{ name: 'native-sqlite', setup(build) { build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true })); } }] });
  const repetitions: unknown[] = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    const began = performance.now();
    const { stdout } = await exec(require('electron') as string, [join(root, 'main.cjs'), root, join(root, `run-${repetition}`)], { timeout: 35_000, maxBuffer: 1024 * 1024 });
    repetitions.push({ repetition: repetition + 1, externalElapsedMs: performance.now() - began, ...JSON.parse(stdout.trim().split('\n').at(-1)!) });
  }
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), repetitions }));
} finally { await rm(root, { recursive: true, force: true }); }
