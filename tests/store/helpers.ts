import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Собственный временный каталог теста: БД, резервные копии и журналы удаляются целиком. */
export class TempDir {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-p5-store-')));

  path(...parts: string[]): string { return join(this.root, ...parts); }

  dir(...parts: string[]): string {
    const target = this.path(...parts);
    mkdirSync(target, { recursive: true });
    return target;
  }

  cleanup(): void { rmSync(this.root, { recursive: true, force: true }); }
}
