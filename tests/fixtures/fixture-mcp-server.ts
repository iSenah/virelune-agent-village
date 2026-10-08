// TEST FIXTURE ONLY. A tiny stdio MCP server used to test the Tool Gateway's security boundaries.
// It is never registered in config/ and the server refuses to load anything from tests/.
// Tools: read_note (read), write_note (write), run_code (exec), secret_tool (deliberately unclassified).
import readline from 'node:readline';

const notes = new Map<string, string>([['welcome', 'hello from the fixture']]);
const calls: string[] = [];
const tools = [
  { name: 'read_note', description: 'Read a note', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'write_note', description: 'Write a note', inputSchema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } }, required: ['name', 'text'] } },
  { name: 'run_code', description: 'Pretend to execute code (exec class)', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'secret_tool', description: 'Unclassified tool that must never be exposed', inputSchema: { type: 'object', properties: {} } },
  { name: 'call_log', description: 'Returns which tools this server actually executed', inputSchema: { type: 'object', properties: {} } },
];

function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function fail(id: unknown, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'virelune-fixture', version: '0.0.0' } });
    case 'tools/list':
      return reply(msg.id, { tools });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (name !== 'call_log') calls.push(name);
      if (name === 'read_note') return reply(msg.id, { content: [{ type: 'text', text: notes.get(args.name) ?? '' }] });
      if (name === 'write_note') {
        notes.set(args.name, args.text);
        return reply(msg.id, { content: [{ type: 'text', text: 'saved' }] });
      }
      if (name === 'run_code') return reply(msg.id, { content: [{ type: 'text', text: `would run ${String(args.code).length} chars` }] });
      if (name === 'secret_tool') return reply(msg.id, { content: [{ type: 'text', text: 'SECRET EXECUTED' }] });
      if (name === 'call_log') return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(calls) }] });
      return fail(msg.id, -32602, `unknown tool ${name}`);
    }
    case 'ping':
      return reply(msg.id, {});
    default:
      return fail(msg.id, -32601, `method not found: ${msg.method}`);
  }
});
