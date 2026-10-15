import { createInterface } from 'node:readline';

// Собственный synthetic Node-процесс. Это НЕ запись или имитация совместимости настоящего CLI.
const scenario = process.argv[2];
if (scenario === 'early-exit') process.exit(7);
if (scenario === 'hang') { for (;;) { /* Намеренно блокирует event loop собственного double. */ } }
if (scenario === 'ignore-term') process.on('SIGTERM', () => {});
if (['ui-invalidate', 'ui-without-instances', 'ui-invalid'].includes(scenario)) process.stdout.write(JSON.stringify({
  type: 'system', subtype: 'ui_invalidate', event: scenario === 'ui-invalid' ? 'SECRET-event' : 'ui.render',
  uuid: '00000000-0000-4000-8000-000000000001', session_id: '00000000-0000-4000-8000-000000000002',
  ...(scenario === 'ui-without-instances' ? {} : { instances: [{ surface: 'SECRET-surface', component: 'SECRET-component', instance_id: 'SECRET-instance' }] }),
}) + '\n');
if (scenario === 'mode-status' || scenario === 'active-status') process.stdout.write(JSON.stringify({
  type: 'system', subtype: 'status', status: scenario === 'mode-status' ? null : 'requesting', permissionMode: 'dontAsk',
  uuid: '00000000-0000-4000-8000-000000000001', session_id: '00000000-0000-4000-8000-000000000002',
}) + '\n');
const lines = createInterface({ input: process.stdin });
let requests = 0;
function reply(requestId, response) {
  process.stdout.write(JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: requestId, response,
    pending_permission_requests: [], pending_user_dialog_requests: [],
  } }) + '\n');
}
lines.on('line', line => {
  const request = JSON.parse(line);
  const kind = requests++ === 0 ? 'initialize' : requests === 2 ? 'get_settings' : 'invalid';
  const id = kind === 'initialize' ? 'p2b-policy-init' : 'p2b-policy-read';
  if (request.type !== 'control_request' || request.request?.subtype !== kind || request.request_id !== id) process.exit(96);
  if (scenario === 'ignore-term') return;
  if (kind === 'initialize') {
    if (scenario === 'invalid-json') { process.stdout.write('SECRET-not-json\n'); return; }
    if (scenario === 'system-other') {
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'SECRET-subtype', detail: 'SECRET-value' }) + '\n'); return;
    }
    reply(id, { commands: [], agents: [], output_style: 'normal', available_output_styles: [], models: [],
      account: { secret: 'SECRET-synthetic-account' } });
  } else if (scenario === 'reject') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: {
      subtype: 'error', request_id: id, error: 'get_settings is not available on this connection SECRET-synthetic-error',
    } }) + '\n');
  } else {
    process.stderr.write('SECRET-synthetic-stderr');
    reply(id, { effective: { env: { SECRET: 'SECRET-synthetic-value' } }, sources: [], errors: [] });
  }
});
lines.on('close', () => {
  if (scenario === 'ignore-term') setInterval(() => {}, 1000);
  else {
    if (scenario === 'late-model') process.stdout.write(JSON.stringify({ type: 'assistant', content: 'SECRET-late-model' }) + '\n');
    process.exitCode = requests === 2 ? 0 : 97;
  }
});
