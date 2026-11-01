// Дочерний процесс: настоящая SQLite, две записи, на второй процесс убивает себя SIGKILL до или после COMMIT.
// Запуск: node --experimental-transform-types store-crash-child.ts <db> <before_commit|after_commit>
import { openSqliteStorage, type StoreFaultPoint } from '../../src/adapters/store/index.ts';
import { baseWrite, event, operation, turn } from '../store/records.ts';

const [dbPath, killAt] = process.argv.slice(2);
if (!dbPath || (killAt !== 'before_commit' && killAt !== 'after_commit')) throw new Error('Нужны путь к БД и точка отказа.');

let transactions = 0;
const storage = openSqliteStorage(dbPath, {
  faultInjector: (point: StoreFaultPoint) => {
    if (point === 'before_commit') transactions++;
    // Первая запись (создание операции) проходит, убивается вторая.
    if (transactions === 2 && point === killAt) process.kill(process.pid, 'SIGKILL');
  },
});
const { store } = storage;
store.beginOperation(operation('op-1', { turnId: 't1' }), baseWrite({
  leases: [{ workspaceId: 'workspace-session-1', operationId: 'op-1', state: 'held' }],
  turns: [turn('t1', 1, 'op-1')], events: [event('e1')],
}));
store.commit({
  turns: [turn('t1', 1, 'op-1', { status: 'running' })],
  events: [event('e2'), event('e3')],
});
storage.close();
