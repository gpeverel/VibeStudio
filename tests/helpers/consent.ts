import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

/** Собственные файлы для проверки идентичности. Ни один script или executable не запускается. */
export class ConsentStand {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-p4-consent-')));
  readonly projectRoot = join(this.root, 'project');

  constructor() { mkdirSync(this.projectRoot); }

  path(name: string): string { return join(this.projectRoot, name); }

  file(name: string, content: string): string {
    const target = this.path(name);
    const within = relative(this.projectRoot, target);
    if (within === '..' || within.startsWith('../')) throw new Error('Файл стенда должен принадлежать проекту');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  }

  executable(name: string, content = 'synthetic executable identity, never executed\n'): string {
    const target = this.file(name, content);
    chmodSync(target, 0o755);
    return target;
  }

  scripts(scripts: Record<string, string>): string {
    return this.file('package.json', JSON.stringify({ name: 'p4-own-fixture', private: true, scripts }));
  }

  replaceKeepingTimes(name: string, content: string): void {
    const target = this.path(name);
    const before = statSync(target);
    this.file(name, content);
    utimesSync(target, before.atime, before.mtime);
  }

  cleanup(): void { rmSync(this.root, { recursive: true, force: true }); }
}
