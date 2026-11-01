import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
const require = createRequire(import.meta.url);

it('P5: настоящий renderer/preload — клавиатура, согласие, Stop, retry, история и недоверенный текст', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vs-p5-ui-'));
  try {
    await build({ configFile: false, root: resolve('src/renderer'), base: './', logLevel: 'silent', esbuild: { jsx: 'automatic' },
      build: { outDir: join(root, 'renderer'), emptyOutDir: true } });
    await bundle({ entryPoints: ['src/preload/index.ts'], outfile: join(root, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await bundle({ entryPoints: ['tests/helpers/p5-ui-electron.ts'], outfile: join(root, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    const result = await exec(require('electron') as string, [join(root, 'main.cjs'), root], { timeout: 40_000, maxBuffer: 512 * 1024 });
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { ok: boolean; effects: number; events: number };
    expect(report.ok).toBe(true); expect(report.effects).toBe(4); expect(report.events).toBeGreaterThan(400);
  } finally { await rm(root, { recursive: true, force: true }); }
});
