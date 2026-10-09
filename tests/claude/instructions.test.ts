import { describe, expect, it } from 'vitest';
import { buildAgentInstructions } from '../../src/core/agent-instructions.ts';

const first = buildAgentInstructions({ resume: false });
const next = buildAgentInstructions({ resume: true });

describe('0C инструкции первого запуска и resume (SPEC §12)', () => {
  it('две ветви непусты, различаются и детерминированы', () => {
    expect(first.length).toBeGreaterThan(50);
    expect(next.length).toBeGreaterThan(50);
    expect(first).not.toBe(next);
    expect(buildAgentInstructions({ resume: false })).toBe(first);
    expect(buildAgentInstructions({ resume: true })).toBe(next);
  });

  it('resume говорит о продолжении диалога, первый запуск — нет', () => {
    expect(next).toMatch(/продолжени/i);
    expect(first).not.toMatch(/продолжени/i);
  });

  it('обе ветви требуют русского языка пользовательского текста', () => {
    for (const text of [first, next]) {
      expect(text).toContain('РУССКОМ');
      expect(text).toContain('Технические идентификаторы');
    }
  });

  it('нет исследовательской разметки, нераскрытых выражений и плейсхолдеров', () => {
    const forbidden = ['⟦', '⟧', '⟨', '⟩', '${', '{{', '}}', '`$', '_0x', 'undefined', 'null', '[object', 'TODO', 'FIXME', '<%'];
    for (const text of [first, next]) {
      for (const marker of forbidden) expect(text, marker).not.toContain(marker);
      expect(text).not.toMatch(/\b(?:su|ep|\$te)\(/);
    }
  });

  it('нет обещаний несуществующих механизмов: harness, маркеры, откат, восстановление, sandbox, интерактивные вопросы', () => {
    const forbidden = [
      /harness/i, /\[\[/, /vibeforge/i, /marker/i, /маркер/i, /sandbox|песочниц/i, /автоматическ/i, /откат/i, /восстановлен/i,
      /AskUserQuestion/, /TaskCreate|TodoWrite|update_plan/, /MCP/, /worktree|ветк[ауе] /i, /reconnect|соединени/i,
    ];
    for (const text of [first, next]) for (const pattern of forbidden) expect(text, String(pattern)).not.toMatch(pattern);
  });

  it('вопросы пользователю задаются текстом, ответ приходит следующим ходом', () => {
    for (const text of [first, next]) expect(text).toMatch(/вопрос\w* текстом/);
  });

  it('инструкция не называет инструменты шире read-only профиля', () => {
    for (const text of [first, next]) {
      for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch']) expect(text).not.toContain(tool);
    }
  });

  it('сборщик не принимает и не вставляет пользовательский текст (нет двойного оборачивания prompt)', () => {
    expect(buildAgentInstructions.length).toBe(1);
    const spoof = buildAgentInstructions({ resume: false, prompt: 'ПОЛЬЗОВАТЕЛЬСКИЙ-ТЕКСТ' } as unknown as { resume: boolean });
    expect(spoof).toBe(first);
  });
});
