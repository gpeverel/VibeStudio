// Управляемый двойник CLI для тестов 0C. Это СИНТЕТИКА: он не доказывает поведение настоящего Claude.
// Сценарий читается из файла FAKE_CLAUDE_SCENARIO; запись argv/stdin/env — в scenario.record.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const scenario = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCENARIO, 'utf8'));
const argv = process.argv.slice(2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (stream, data) => new Promise(resolve => stream.write(data, resolve));

function record(extra) {
  if (!scenario.record) return;
  appendFileSync(scenario.record, `${JSON.stringify({ argv, cwd: process.cwd(), env: process.env, ...extra })}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (argv.includes('--version')) {
  record({ probe: 'version' });
  if (scenario.version === undefined) process.exit(1);
  process.stdout.write(`${scenario.version}\n`);
  process.exit(0);
}
if (argv.includes('--help')) {
  record({ probe: 'help' });
  process.stdout.write(scenario.help ?? '');
  process.exit(scenario.helpExit ?? 0);
}
if (argv.includes('auth') && argv.includes('status')) {
  record({ probe: 'auth' });
  process.stdout.write(`${JSON.stringify(scenario.auth ?? { loggedIn: false })}\n`);
  process.exit(scenario.authExit ?? (scenario.auth?.loggedIn ? 0 : 1));
}

const stdin = await readStdin();
record({ probe: 'run', stdin });

for (const step of scenario.steps ?? []) {
  if (step.sleep !== undefined) await sleep(step.sleep);
  else if (step.out !== undefined || step.err !== undefined) {
    const stream = step.out !== undefined ? process.stdout : process.stderr;
    const data = Buffer.from(step.out ?? step.err, step.base64 ? 'base64' : 'utf8');
    const size = step.fragment ?? data.length;
    for (let i = 0; i < data.length; i += Math.max(1, size)) {
      await write(stream, data.subarray(i, i + Math.max(1, size)));
      if (step.fragment) await sleep(1);
    }
  } else if (step.repeat !== undefined) {
    // Много данных без чтения со стороны потребителя: проверка лимитов памяти.
    const line = Buffer.from(step.repeat.line);
    for (let i = 0; i < step.repeat.count; i++) await write(process.stdout, line);
  } else if (step.ignoreSigterm) process.on('SIGTERM', () => {});
  else if (step.spawnChild) {
    // Дочерний процесс принадлежит тому же запуску; его pid пишется в файл для проверки уборки.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync(step.spawnChild, String(child.pid));
  } else if (step.hang) { setInterval(() => {}, 1000); await new Promise(() => {}); }
  else if (step.exit !== undefined) process.exit(step.exit);
}
process.exit(scenario.exit ?? 0);
