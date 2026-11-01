import { app, dialog } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const root = process.env.VIBESTUDIO_E2E_ROOT;
if (!root || !isAbsolute(root)) throw new Error('Нужен абсолютный путь временного стенда.');
const profile = join(root, 'profile');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.setAppLogsPath(join(root, 'logs'));

const record = (kind, detail) => {
  appendFileSync(join(root, 'runtime-errors.jsonl'),
    JSON.stringify({ kind, detail: String(detail) }) + '\n');
};
let quitting = false;
app.on('before-quit', () => { quitting = true; });
process.on('uncaughtExceptionMonitor', error => record('main', error.stack ?? error));
process.on('unhandledRejection', error => {
  record('unhandledRejection', error);
  app.exit(1);
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, path, error) => {
    record('preload', `${path}: ${error.stack ?? error}`);
  });
  contents.on('render-process-gone', (_event, details) => {
    if (!quitting || details.reason !== 'clean-exit') {
      record('renderer', JSON.stringify(details));
    }
  });
});
dialog.showOpenDialog = async () => ({
  canceled: false, filePaths: [join(root, 'project')],
});
dialog.showErrorBox = (title, content) => record('startup', `${title}: ${content}`);

app.once('vibestudio:e2e:start', () => {
  void import('../../out/main/index.js').catch(error => {
    record('startup', error.stack ?? error);
    app.exit(1);
  });
});
