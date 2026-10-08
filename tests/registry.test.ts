import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../server/lib/config.ts';
import { grantFor, loadRegistries, parseResident, parseToolServer } from '../server/lib/registry.ts';
import { tmpDir } from './helpers.ts';

const base = {
  id: 'tester',
  displayName: 'Tester',
  role: 'Test resident',
  capabilities: ['testing'],
  runtime: 'codex-app-server',
  provider: 'chatgpt-plan',
  building: 'engineering-forge',
  appearance: { lineage: 'codex', color: '#e8890c' },
  requires: ['codex'],
  permissions: 'restricted',
};

test('the shipped registries load with no errors', () => {
  const reg = loadRegistries(path.join(PROJECT_ROOT, 'config'));
  assert.deepEqual(reg.errors, []);
  assert.equal(reg.residents.size, 9);
  assert.deepEqual([...reg.residents.values()].filter((r) => r.focus).map((r) => r.id).sort(), ['claude', 'codex', 'echo']);
  for (const id of ['aura', 'codex-unreal', 'claude-unreal', 'codex-blender', 'claude-blender', 'scribe']) assert.equal(reg.residents.get(id)?.focus, false, `${id} must not be a focus resident`);
});

test('shipped tool servers expose nothing until their tools are classified', () => {
  const reg = loadRegistries(path.join(PROJECT_ROOT, 'config'));
  for (const t of reg.tools.values()) assert.deepEqual(t.risk, {}, `${t.id} should start with no classified tools`);
});

test('resident manifests reject unknown fields, wildcards and exec under allow', () => {
  assert.ok(parseResident({ ...base, extra: 1 }).errors.some((e) => e.includes('unknown field')));
  assert.ok(parseResident({ ...base, tools: [{ server: 'x', allow: ['*'], ask: [] }] }).errors.some((e) => e.includes('wildcard')));
  assert.ok(parseResident({ ...base, tools: [{ server: 'x', allow: ['risk:exec'], ask: [] }] }).errors.some((e) => e.includes('never "allow"')));
  assert.ok(parseResident({ ...base, tools: [{ server: 'x', allow: ['risk:root'], ask: [] }] }).errors.some((e) => e.includes('risk class')));
  assert.ok(parseResident({ ...base, id: 'Bad ID' }).errors.some((e) => e.includes('id')));
  assert.equal(parseResident(base).errors.length, 0);
});

test('tool servers must be stdio MCP with a command', () => {
  assert.ok(parseToolServer({ id: 'x1', displayName: 'X', kind: 'mcp', transport: 'http', command: 'x', risk: {} }).errors.some((e) => e.includes('stdio')));
  assert.ok(parseToolServer({ id: 'x1', displayName: 'X', kind: 'mcp', transport: 'stdio', risk: {} }).errors.some((e) => e.includes('command')));
  assert.ok(parseToolServer({ id: 'x1', displayName: 'X', kind: 'mcp', transport: 'stdio', command: 'x', risk: { a: 'admin' } }).errors.some((e) => e.includes('read, write or exec')));
});

test('cross-registry references are checked; broken residents are not loaded', () => {
  const dir = tmpDir();
  fs.cpSync(path.join(PROJECT_ROOT, 'config'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'residents', 'ghost.json'), JSON.stringify({ ...base, id: 'ghost', runtime: 'no-such-runtime' }));
  fs.writeFileSync(path.join(dir, 'residents', 'sneaky.json'), JSON.stringify({ ...base, id: 'sneaky', tools: [{ server: 'blender-lab', allow: ['execute_code'], ask: [] }] }));
  fs.writeFileSync(path.join(dir, 'residents', 'broken.json'), '{ not json');
  const reg = loadRegistries(dir);
  assert.equal(reg.residents.has('ghost'), false);
  assert.equal(reg.residents.has('sneaky'), false);
  assert.equal(reg.errors.length, 3);
  assert.ok(reg.errors.some((e) => e.message.includes('runtime "no-such-runtime" is not registered')));
  assert.ok(reg.errors.some((e) => e.message.includes('not classified')));
  assert.ok(reg.errors.some((e) => e.message.includes('invalid JSON')));
});

test('grantFor: default deny, exec always asks, unclassified never exposed', () => {
  const server = parseToolServer({ id: 'fx', displayName: 'FX', kind: 'mcp', transport: 'stdio', command: 'x', risk: { r: 'read', w: 'write', x: 'exec' } }).value!;
  const resident = parseResident({ ...base, tools: [{ server: 'fx', allow: ['risk:read', 'x'], ask: ['risk:write'] }] }).value;
  // naming an exec tool under allow is rejected at load time by loadRegistries; grantFor still forces ask
  assert.ok(resident);
  assert.equal(grantFor(resident!, server, 'r'), 'allow');
  assert.equal(grantFor(resident!, server, 'w'), 'ask');
  assert.equal(grantFor(resident!, server, 'x'), 'ask');
  assert.equal(grantFor(resident!, server, 'secret'), 'deny');
  const none = parseResident(base).value!;
  assert.equal(grantFor(none, server, 'r'), 'deny');
});
