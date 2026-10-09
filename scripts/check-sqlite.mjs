// Проба нативного better-sqlite3 на временной БД.
// Под Node:      node scripts/check-sqlite.mjs
// Под Electron:  ELECTRON_RUN_AS_NODE=1 electron scripts/check-sqlite.mjs
// Не принимает аргументов и не трогает ничего, кроме собственного временного каталога.
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'check-sqlite-'));
let db;
let exitCode = 0;
const report = {
  ok: false,
  runtime: process.versions.electron ? 'electron' : 'node',
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  abi: process.versions.modules,
};

try {
  const Database = require('better-sqlite3');
  db = new Database(join(dir, 'probe.db'));
  report.sqliteVersion = db.prepare('select sqlite_version() as v').get().v;
  db.pragma('journal_mode = WAL');
  db.exec('create table probe (id integer primary key, value text not null)');
  db.prepare('insert into probe (value) values (?)').run('ok');
  const row = db.prepare('select value from probe where id = 1').get();
  if (row?.value !== 'ok') throw new Error(`неверное значение при чтении: ${JSON.stringify(row)}`);
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  exitCode = 1;
} finally {
  try {
    db?.close();
  } catch {
    // закрытие после сбоя загрузки не важно
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify(report));
process.exit(exitCode);
