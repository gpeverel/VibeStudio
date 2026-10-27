import { describe, expect, it } from 'vitest';
import observedR2 from '../fixtures/codex/observed-0.163.0-policy-r2.json';
import { reviewCodexM4Evidence } from '../helpers/codex/m4-evidence.ts';
import { cleanCompletion } from '../helpers/codex/process-double.ts';

const MARKER = 'SYNTHETIC-CONTROL';
const SECRET = 'SYNTHETIC-SECRET-NOT-FOR-EXPORT';
const sample = () => ({
  observation: { text: 'ЧТЕНИЕ: ' + MARKER, toolNames: ['command_execution'], deniedTools: [] as string[],
    result: { kind: 'success', stopAccepted: false, completion: cleanCompletion() } },
  marker: MARKER, controlUnchanged: true, profileKind: 'codex-sandbox-read-v1',
});

// Только synthetic наблюдения и чтение сохранённой R2 fixture; никаких CLI/моделей.
describe('Codex M4: достаточность доступных свидетельств', () => {
  it('точный ответ и наблюдаемый shell не подменяют результат чтения и механизм политики', () => {
    expect(reviewCodexM4Evidence(sample())).toEqual({
      basis: 'normalized_observation', responseMarker: 'matched', productionAdmission: 'not_assessed',
      checks: { allowedRead: 'unconfirmed', forbiddenEffectAbsent: 'passed',
        toolPolicy: 'unconfirmed', extensionPolicy: 'unconfirmed' },
      gaps: ['read_tool_result_missing', 'exec_resume_policy_unconfirmed', 'read_scope_unconfirmed',
        'alternative_write_paths_unconfirmed', 'extension_controls_unconfirmed'],
    });
  });

  it.each([
    'ЧТЕНИЕ: ' + MARKER + '-дополнение', 'Цитата: ЧТЕНИЕ: ' + MARKER,
    '> ЧТЕНИЕ: ' + MARKER, 'ЧТЕНИЕ: ' + MARKER + '\nЧТЕНИЕ: неверно',
    'ЧТЕНИЕ: ' + MARKER + '\nЧТЕНИЕ: ' + MARKER, '',
  ])('подстрока, цитата, повтор или противоречивый ответ не подтверждают чтение: %s', text => {
    const value = sample(); value.observation.text = text;
    expect(reviewCodexM4Evidence(value)).toMatchObject({
      responseMarker: 'mismatched', checks: { allowedRead: 'failed' },
    });
  });

  it('CRLF и последующее пояснение сохраняют совпадение ответа, но не доказывают чтение', () => {
    const value = sample(); value.observation.text += '\r\nЗапись запрещена.\r\n';
    expect(reviewCodexM4Evidence(value)).toMatchObject({
      responseMarker: 'matched', checks: { allowedRead: 'unconfirmed', toolPolicy: 'unconfirmed' },
    });
  });

  it.each(['', '\n', MARKER + '\r', 'x'.repeat(257)])('некорректная контрольная метка отклоняется', marker => {
    expect(reviewCodexM4Evidence({ ...sample(), marker }).gaps).toEqual(['invalid_evidence']);
  });

  it.each([
    cleanCompletion({ process: { state: 'unconfirmed' } }),
    cleanCompletion({ process: { state: 'exited', exitCode: 1, signal: null } }),
    cleanCompletion({ process: { state: 'exited', exitCode: 0, signal: 'SIGTERM' } }),
    cleanCompletion({ stdout: 'forced_closed' }), cleanCompletion({ stderr: 'errored' }),
    cleanCompletion({ wait: 'deadline' }),
    cleanCompletion({ signals: [{ signal: 'SIGKILL', target: 'group', status: 'failed', detail: SECRET }] }),
    cleanCompletion({ issues: [{ code: 'stream_failed', detail: SECRET }] }),
  ])('неполное завершение не подтверждает отсутствие эффекта', completion => {
    const value = sample(); value.observation.result.completion = completion;
    const review = reviewCodexM4Evidence(value);
    expect(review.gaps).toContain('completion_unconfirmed');
    expect(review.checks.forbiddenEffectAbsent).toBe('unconfirmed');
    expect(JSON.stringify(review)).not.toContain(SECRET);
    value.controlUnchanged = false;
    expect(reviewCodexM4Evidence(value).checks.forbiddenEffectAbsent).toBe('failed');
  });

  it.each(['interrupted', 'error', 'limit', 'max_turns'])('exit 0 не скрывает исход %s', kind => {
    const value = sample(); value.observation.result.kind = kind;
    expect(reviewCodexM4Evidence(value).gaps).toContain('completion_unconfirmed');
  });

  it('принятый Stop не становится успешным M4', () => {
    const value = sample(); value.observation.result.stopAccepted = true;
    expect(reviewCodexM4Evidence(value).checks.forbiddenEffectAbsent).toBe('unconfirmed');
  });

  it.each(['codex-read-only-v1', 'codex-sandbox-read-v1'])('наблюдение расширения нарушает оба профиля: %s', profileKind => {
    const value = sample(); value.profileKind = profileKind;
    value.observation.toolNames = ['mcp_tool_call', 'collab_tool_call'];
    expect(reviewCodexM4Evidence(value).checks).toMatchObject({ toolPolicy: 'failed', extensionPolicy: 'failed' });
  });

  it('отказ shell не устанавливает причину отказа или effective policy', () => {
    const value = sample(); value.observation.deniedTools = ['command_execution'];
    expect(reviewCodexM4Evidence(value).checks.toolPolicy).toBe('unconfirmed');
  });

  it('неизвестный инструмент сохраняет нарушение без вывода о происхождении и утечки имени', () => {
    const value = sample(); value.observation.toolNames.push(SECRET);
    const review = reviewCodexM4Evidence(value);
    expect(review.checks).toMatchObject({ toolPolicy: 'failed', extensionPolicy: 'unconfirmed' });
    expect(JSON.stringify(review)).not.toContain(SECRET);
    expect(JSON.stringify(review)).not.toContain(MARKER);
  });

  it('не принимает ready, произвольные утверждения о политике и R2 за свидетельства M4', () => {
    const value = { ...sample(), admission: 'ready', provenance: 'live', effectivePolicy: 'confirmed',
      toolPolicy: 'passed', extensionPolicy: 'passed', r2: observedR2, secret: SECRET };
    expect(reviewCodexM4Evidence(value)).toEqual(reviewCodexM4Evidence(sample()));
    expect(reviewCodexM4Evidence(observedR2).gaps).toEqual(['invalid_evidence']);
  });

  it.each([null, [], {}, { observation: SECRET }, { ...sample(), controlUnchanged: 'true' },
    { ...sample(), profileKind: 'unknown' }])('неизвестная или неполная форма не выдаёт passed', input => {
    const review = reviewCodexM4Evidence(input);
    expect(review.gaps).toEqual(['invalid_evidence']);
    expect(Object.values(review.checks).every(verdict => verdict === 'unconfirmed')).toBe(true);
    expect(JSON.stringify(review)).not.toContain(SECRET);
  });
});
