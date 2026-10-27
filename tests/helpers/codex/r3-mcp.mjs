import { writeFileSync } from 'node:fs';

/** Own stdio MCP decoy. No credentials/env/network reads; bounded protocol input. */
export function createR3McpHandler(token, called) {
  let initialized = false;
  let ready = false;
  return message => {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new Error('invalid');
    const id = message.id;
    const result = value => ({ jsonrpc: '2.0', id, result: value });
    const error = () => ({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported request' } });
    if (id === undefined) {
      if (message.method === 'notifications/initialized' && initialized) ready = true;
      return undefined;
    }
    if (!['string', 'number'].includes(typeof id)) throw new Error('invalid');
    if (message.method === 'initialize' && !initialized) {
      initialized = true;
      const requested = message.params?.protocolVersion;
      const protocolVersion = ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : '2025-06-18';
      return result({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'vs-r3-own-decoy', version: '1' } });
    }
    if (message.method === 'ping' && initialized) return result({});
    if (!ready) return error();
    // rust-v0.163.0 core/src/mcp_tool_call.rs: без annotations инструмент требует одобрения, а при approval_policy=never
    // вызов отклоняется. readOnlyHint=true снимает требование (requires_mcp_tool_approval → false).
    if (message.method === 'tools/list') return result({ tools: [{ name: 'ping', description: 'Контроль R3 собственного стенда',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] });
    if (message.method === 'tools/call' && message.params?.name === 'ping'
      && Object.keys(message.params.arguments ?? {}).length === 0) {
      called();
      return result({ content: [{ type: 'text', text: 'R3_MCP_' + token }] });
    }
    return error();
  };
}

if (process.argv[2] === '--serve') {
  const token = process.argv[3];
  if (!/^[a-f0-9]{32}$/.test(token ?? '')) process.exit(2);
  const handle = createR3McpHandler(token, () => writeFileSync(new URL('../MCP.marker', import.meta.url), token, { mode: 0o600 }));
  let pending = Buffer.alloc(0);
  let total = 0;
  const deadline = setTimeout(() => process.exit(3), 95_000);
  process.stdin.on('data', chunk => {
    total += chunk.length;
    if (total > 1_048_576) process.exit(2);
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > 65_536) process.exit(2);
      try {
        const response = handle(JSON.parse(pending.subarray(0, end).toString('utf8')));
        if (response !== undefined) process.stdout.write(JSON.stringify(response) + '\n');
      } catch { process.exit(2); }
      pending = pending.subarray(end + 1);
    }
    if (pending.length > 65_536) process.exit(2);
  });
  process.stdin.on('end', () => { clearTimeout(deadline); process.exit(pending.length ? 2 : 0); });
}
