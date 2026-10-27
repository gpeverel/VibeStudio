import { describe, expectTypeOf, it } from 'vitest';
import type { createCodexAdapter } from '../../src/adapters/codex/index.ts';
import type { CodexCapabilities, CodexRunRequest } from '../../src/adapters/codex/contracts.ts';
import type { AgentAdapter, AgentCapabilities, AgentDetection, AgentRun, AgentRunRequest } from '../../src/core/ports/agent.ts';

// Проверяются tsc через npm run typecheck. Vitest сам по себе типы не проверяет;
// ни createCodexAdapter, ни CLI в этих проверках не вызываются.
type CodexPort = ReturnType<typeof createCodexAdapter>;

describe('Общий порт: совместимость Claude и отдельный контракт Codex', () => {
  it('параметры по умолчанию сохраняют прежний Claude-запрос и capabilities', () => {
    expectTypeOf<AgentAdapter>().toEqualTypeOf<AgentAdapter<AgentRunRequest, AgentCapabilities>>();
    expectTypeOf<Parameters<AgentAdapter['start']>[0]>().toEqualTypeOf<AgentRunRequest>();
    expectTypeOf<AgentDetection['capabilities']>().toEqualTypeOf<AgentCapabilities>();
    expectTypeOf<AgentRunRequest['agentSessionId']>().toEqualTypeOf<string>();
  });

  it('Codex связывает собственные запрос/capabilities с неизменным AgentRun', () => {
    expectTypeOf<CodexPort>().toEqualTypeOf<AgentAdapter<CodexRunRequest, CodexCapabilities>>();
    expectTypeOf<Awaited<ReturnType<CodexPort['detect']>>>().toEqualTypeOf<AgentDetection<CodexCapabilities>>();
    expectTypeOf<Awaited<ReturnType<CodexPort['start']>>>().toEqualTypeOf<AgentRun>();
  });

  it('Claude-запрос не подходит start Codex, resume требует ссылку именно Codex', () => {
    expectTypeOf<AgentRunRequest>().not.toExtend<Parameters<CodexPort['start']>[0]>();
    expectTypeOf<Extract<CodexRunRequest, { resume: true }>['thread']>().toEqualTypeOf<{
      readonly adapter: 'codex'; readonly threadId: string;
    }>();
    expectTypeOf<Extract<CodexRunRequest, { resume: false }>['thread']>().toEqualTypeOf<undefined>();
  });
});
