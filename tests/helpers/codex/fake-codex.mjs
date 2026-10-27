// СИНТЕТИЧЕСКИЙ двойник. Не вызывает установленную Codex CLI, сеть или авторизацию.
import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const argv = process.argv.slice(3);
let probe = 'run';
if (argv.includes('--version')) probe = 'version';
else if (argv.includes('--help')) {
  probe = argv.includes('resume') ? 'resumeHelp' : argv.includes('exec') ? 'execHelp' : argv.includes('login') ? 'loginHelp' : 'help';
} else if (argv.includes('login') && argv.includes('status')) probe = 'auth';
const record = { probe, argv, cwd: process.cwd(), env: process.env };
const defaults = {
  version: { stdout: 'codex-cli 0.163.0\n' },
  help: { stdout: 'Usage: codex [OPTIONS]\nCommands:\n  exec\n  login\nOptions:\n  --config <key=value>\n  --sandbox <SANDBOX_MODE>\n  --ask-for-approval <APPROVAL_POLICY>\n  --ignore-user-config\n  --ignore-rules\n' },
  execHelp: { stdout: 'Usage: codex exec [OPTIONS] [PROMPT]\nCommands:\n  resume\nOptions:\n  --json\n  --sandbox <SANDBOX_MODE>\n  --config <key=value>\n  --ephemeral\n  --model <MODEL>\n  --ignore-user-config\n  --ignore-rules\n  - Read prompt from stdin\n' },
  resumeHelp: { stdout: 'Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\nOptions:\n  --json\n  --config <key=value>\n  --model <MODEL>\n  - Read prompt from stdin\n' },
  loginHelp: { stdout: 'Usage: codex login [OPTIONS]\nCommands:\n  status\n' },
  auth: { stderr: 'Logged in using ChatGPT\n' },
};
if (probe !== 'run') {
  appendFileSync(scenario.recordFile, JSON.stringify(record) + '\n');
  const response = scenario.probes?.[probe] ?? defaults[probe];
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exitCode = response.exit ?? 0;
} else {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdin += chunk;
  appendFileSync(scenario.recordFile, JSON.stringify({ ...record, stdin }) + '\n');
  for (const step of scenario.steps ?? []) {
    if ('out' in step) {
      const bytes = Buffer.from(step.out);
      const size = step.fragment ?? Math.max(1, bytes.length);
      for (let i = 0; i < bytes.length; i += size) process.stdout.write(bytes.subarray(i, i + size));
    } else if ('err' in step) process.stderr.write(step.err);
    else if ('sleep' in step) await new Promise(resolve => setTimeout(resolve, step.sleep));
    else if ('ignoreSigterm' in step) process.on('SIGTERM', () => {});
    else if ('hang' in step) await new Promise(() => { setInterval(() => {}, 1_000); });
    else if ('exit' in step) process.exit(step.exit);
  }
  process.exitCode = scenario.exit ?? 0;
}
