import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { expect, it } from 'vitest';
const exec = promisify(execFile), require = createRequire(import.meta.url);

it('Electron: понятный отказ выбора → новый выбор → настоящая сессия и reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solo-project-ui-'));
  try {
    await build({ configFile: false, root: resolve('src/renderer'), base: './', logLevel: 'silent', esbuild: { jsx: 'automatic' },
      build: { outDir: join(root, 'renderer'), emptyOutDir: true } });
    await bundle({ entryPoints: ['src/preload/index.ts'], outfile: join(root, 'preload.cjs'), bundle: true,
      platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await bundle({ entryPoints: ['tests/helpers/solo-project-selection-electron.ts'], outfile: join(root, 'main.cjs'), bundle: true,
      platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent',
      plugins: [{ name: 'native-sqlite', setup(build) {
        build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true }));
      } }] });
    const result = await exec(require('electron') as string, [join(root, 'main.cjs'), root], { timeout: 25_000, maxBuffer: 512 * 1024 });
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({ ok: true, projects: 1, sessions: 1, modelCliRuns: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
