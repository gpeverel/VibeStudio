import { mkdtempSync, writeFileSync, linkSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSingleLinkTree } from './launcher.ts';

describe('native preflight aliases', () => {
  it('rejects regular files with an alias outside the scanned root', () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-inode-test-'));
    const external = `${root}-control`;
    try {
      writeFileSync(join(root, 'file'), 'control');
      expect(() => assertSingleLinkTree(root)).not.toThrow();
      linkSync(join(root, 'file'), external);
      expect(() => assertSingleLinkTree(root)).toThrow('Alias or special file rejected');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(external, { force: true }); }
  });
  it('rejects symlinks rather than inspecting the foreign target', () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-symlink-test-'));
    try {
      symlinkSync('/nonexistent-foreign-target', join(root, 'alias'));
      expect(() => assertSingleLinkTree(root)).toThrow('Alias or special file rejected');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
