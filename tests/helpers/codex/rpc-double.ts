import type { ProcessResult } from '../../../src/core/ports/process-runner.ts';
import type { InteractiveProcessRun, InteractiveProcessRunner } from '../../../src/adapters/process-runner/interactive.ts';
import { BoundedQueue } from '../../../src/adapters/process-runner/queue.ts';
import { cleanCompletion, deferred, processResult } from './process-double.ts';
import type { JsonObject } from '../../../src/adapters/codex/rpc.ts';

export const RPC_THREAD = '019a0000-0000-7000-8000-000000000091';
export function rpcConfig(cwd: string): JsonObject {
  return { config: { approval_policy: 'never', model_provider: 'openai', default_permissions: 'vibestudio-read-v1', web_search: 'disabled', notify: [],
    features: { shell_tool: true, hooks: false, apps: false, plugins: false, multi_agent: false, multi_agent_v2: false,
      view_image: false, image_generation: false, goals: false, retain_client_developer_messages: true, remote_plugin: false, tool_suggest: false, memories: false },
    include_apps_instructions: false, include_collaboration_mode_instructions: false, developer_instructions: '', project_doc_max_bytes: 0,
    skills: { include_instructions: false, bundled: { enabled: false } }, cloud: { skills: { enabled: false } },
    projects: { [cwd]: { trust_level: 'untrusted' } }, permissions: { 'vibestudio-read-v1': {
      filesystem: { ':root': 'deny', ':minimal': 'read', ':workspace_roots': { '.': 'read' } }, network: { enabled: false } } }, mcp_servers: {} } };
}
export function rpcDouble(options: {
  config?: JsonObject; hang?: boolean; stallAt?: string; mutate?: (message: JsonObject) => JsonObject;
  completion?: ProcessResult; stopError?: boolean; errorAt?: string;
} = {}) {
  const calls: JsonObject[] = []; const requests: Parameters<InteractiveProcessRunner['start']>[0][] = [];
  const runner: InteractiveProcessRunner = { start(request) {
    requests.push(request);
    const stdout = new BoundedQueue<Uint8Array>(4_194_304, value => value.byteLength);
    const stderr = new BoundedQueue<Uint8Array>(65_536, value => value.byteLength);
    const done = deferred<ProcessResult>(); let closed = false;
    const put = (value: JsonObject): void => { stdout.push(Buffer.from(JSON.stringify(options.mutate?.(value) ?? value) + '\n')); };
    const close = (): void => { if (!closed) { closed = true; stdout.finish(); stderr.finish(); done.resolve(options.completion ?? processResult()); } };
    const turn = (status: string): void => put({ method: 'turn/completed', params: { threadId: RPC_THREAD, turn: { id: 'turn-own', status } } });
    const run: InteractiveProcessRun = { stdout, stderr, done: done.promise, closeInput: close,
      interrupt: async () => { close(); if (options.stopError) throw new Error('SECRET'); },
      kill: async () => { close(); if (options.stopError) throw new Error('SECRET'); },
      send: async text => {
        const call = JSON.parse(text) as JsonObject; calls.push(call); const method = call.method;
        if (method === 'initialized' || method === options.stallAt) return;
        if (method === options.errorAt) { put({ id: call.id, error: { code: -32000, message: 'SECRET' } }); return; }
        let result: JsonObject = {};
        if (method === 'config/read') result = options.config ?? rpcConfig(request.cwd);
        if (method === 'thread/start' || method === 'thread/resume') result = { thread: { id: RPC_THREAD, cwd: request.cwd }, cwd: request.cwd,
          approvalPolicy: 'never', activePermissionProfile: { id: 'vibestudio-read-v1' }, sandbox: { type: 'readOnly', networkAccess: false },
          runtimeWorkspaceRoots: [request.cwd], instructionSources: [] };
        if (method === 'turn/start') result = { turn: { id: 'turn-own' } };
        put({ id: call.id, result });
        if (method === 'turn/start') {
          put({ method: 'turn/started', params: { threadId: RPC_THREAD, turn: { id: 'turn-own' } } });
          put({ method: 'item/agentMessage/delta', params: { threadId: RPC_THREAD, turnId: 'turn-own', itemId: 'message', delta: 'Ответ' } });
          if (!options.hang) {
            put({ method: 'item/completed', params: { threadId: RPC_THREAD, turnId: 'turn-own', item: { type: 'agentMessage', id: 'message', text: 'Ответ', phase: 'final_answer' } } });
            turn('completed');
          }
        }
        if (method === 'turn/interrupt') turn('interrupted');
      } };
    return run;
  } };
  return { runner, calls, requests, cleanCompletion };
}
