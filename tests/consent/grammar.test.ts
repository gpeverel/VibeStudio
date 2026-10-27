import { describe, expect, it } from 'vitest';
import { classifyCommand, executionEnvironmentIssue, parseScriptBody } from '../../src/adapters/project-command-snapshot/script-grammar.ts';

describe('P4: закрытая грамматика не выдаёт неизвестный вход за установленный', () => {
  it('находит именованный дочерний script и обычные файловые входы цепочки', () => {
    expect(parseScriptBody('node scripts/first.js && npm run child; bash scripts/check.sh')).toEqual({
      ok: true,
      segments: [
        { kind: 'node', command: 'node', files: ['scripts/first.js'] },
        { kind: 'npm_script', command: 'npm', script: 'child', forwarded: [] },
        { kind: 'shell', command: 'bash', file: 'scripts/check.sh' },
      ],
    });
  });

  it.each([
    'node first.js | node second.js', 'node first.js > result.txt', 'node $(echo script.js)',
    'node `echo script.js`', 'node first.js &', 'node first.js &&', 'node first.js\nnode second.js',
    'node "${SCRIPT}"', 'node scripts/*.js', 'NODE_OPTIONS=--require=hook.js node first.js',
    'PATH=./malicious node first.js', 'BASH_ENV=hook.sh bash first.sh',
  ])('отклоняет неподдержанное тело: %s', body => {
    expect(parseScriptBody(body)).toMatchObject({ ok: false, reason: 'unsupported_command' });
  });

  it.each(['env node first.js', 'npx vitest', 'cross-env MODE=test node first.js', 'source scripts/other.sh'])(
    'сохраняет неизвестную зависимость для обёртки: %s', body => {
      expect(parseScriptBody(body)).toMatchObject({ ok: false, reason: 'unknown_dependency' });
    },
  );

  it.each([
    ['git', 'push'], ['npm', 'publish'], ['npm', 'unpublish'], ['rm', '-rf', './data'],
    ['bash', '-c', 'node first.js'], ['node', '-e', 'process.exit(0)'], ['node', '--require', 'hook.js', 'first.js'],
  ])('не прячет опасную либо неизвестную команду за назначением теста: %j', (...tokens) => {
    expect(classifyCommand(tokens)).toMatchObject({ ok: false, reason: 'unsupported_command' });
  });

  it.each(['--require=./hook.cjs', '-r ./hook.cjs', '"--require" ./hook.cjs', '--import=./hook.mjs'])(
    'не пропускает загрузку файла через NODE_OPTIONS=%s', value => {
      expect(executionEnvironmentIssue({ NODE_OPTIONS: value })).toBe('env_name:NODE_OPTIONS');
    },
  );

  it('диагностика env не раскрывает значение секрета', () => {
    expect(executionEnvironmentIssue({ BASH_ENV: '/private/P4_SECRET_VALUE.sh' })).toBe('env_name:BASH_ENV');
  });
});
