import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import { after, before, test } from 'node:test';
import { createServer } from '../server/lib/api.ts';
import type { Village } from '../server/lib/app.ts';
import { makeVillage } from './helpers.ts';

let village: Village;
let server: http.Server;
let base: string;
const H = { 'content-type': 'application/json', 'x-village-client': '1' };

before(async () => {
  ({ village } = makeVillage());
  server = createServer(village);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => {
  server.close();
  village.close();
});

test('health and state load with zero integrations', async () => {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.residents.length, 8, 'five active residents and three planned ones');
  assert.ok(state.residents.every((r: any) => r.status !== 'connected'), 'no resident may claim a connection without checks');
  assert.ok(state.residents.every((r: any) => (r.planned ? r.status === 'disconnected' : r.status === 'untested')), 'planned residents have nothing to check');
  assert.equal(state.echo.autonomy, 'supervised');
  assert.deepEqual(state.echo.levels.map((l: any) => [l.id, l.available]), [['supervised', true], ['assisted', false], ['autonomous', false]]);
  assert.deepEqual(state.registry.errors, []);
});

test('state-changing requests need the village header and a same-origin Origin', async () => {
  const noHeader = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) });
  assert.equal(noHeader.status, 403);
  const crossOrigin = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: JSON.stringify({ title: 'x' }) });
  assert.equal(crossOrigin.status, 403);
  const sameOrigin = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { ...H, origin: base }, body: JSON.stringify({ title: 'Same origin task' }) });
  assert.equal(sameOrigin.status, 201);
});

test('tasks over the API: create, validate, cancel', async () => {
  const bad = await fetch(`${base}/api/tasks`, { method: 'POST', headers: H, body: JSON.stringify({ title: '' }) });
  assert.equal(bad.status, 400);
  const badJson = await fetch(`${base}/api/tasks`, { method: 'POST', headers: H, body: '{nope' });
  assert.equal(badJson.status, 400);
  const created = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Write DESIGN.md for mdlinks', assignee: 'claude' }) })).json();
  assert.equal(created.task.status, 'ready');
  assert.match(created.task.waitingReason, /not checked yet/);
  const cancelled = await (await fetch(`${base}/api/tasks/${created.task.id}/cancel`, { method: 'POST', headers: H })).json();
  assert.equal(cancelled.task.status, 'cancelled');
  const again = await fetch(`${base}/api/tasks/${created.task.id}/cancel`, { method: 'POST', headers: H });
  assert.equal(again.status, 409);
  assert.equal((await fetch(`${base}/api/tasks/t_nope/cancel`, { method: 'POST', headers: H })).status, 404);
});

test('Echo autonomy over the API: Assisted and Autonomous are refused', async () => {
  const put = (level: string) => fetch(`${base}/api/settings/echo-autonomy`, { method: 'PUT', headers: H, body: JSON.stringify({ level }) });
  assert.equal((await put('assisted')).status, 409);
  assert.equal((await put('autonomous')).status, 409);
  assert.equal((await put('supervised')).status, 200);
});

test('approvals over the API', async () => {
  const a = village.approvals.request({ kind: 'test', summary: 'Approve me', risk: 'write' });
  const list = await (await fetch(`${base}/api/approvals`)).json();
  assert.ok(list.approvals.some((x: any) => x.id === a.id));
  const bad = await fetch(`${base}/api/approvals/${a.id}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'maybe' }) });
  assert.equal(bad.status, 400);
  const ok = await (await fetch(`${base}/api/approvals/${a.id}`, { method: 'POST', headers: H, body: JSON.stringify({ decision: 'deny', reason: 'test' }) })).json();
  assert.equal(ok.approval.status, 'denied');
});

test('event stream replays history and delivers new events live', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events/stream?after=0`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader();
  let text = '';
  const readUntil = async (pred: (t: string) => boolean) => {
    const deadline = Date.now() + 5000;
    while (!pred(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  };
  await readUntil((t) => t.includes('village.started'));
  assert.ok(text.includes('village.started'), 'history replayed');
  await fetch(`${base}/api/tasks`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Live event check' }) });
  await readUntil((t) => t.includes('Live event check'));
  assert.ok(text.includes('Live event check'), 'new event delivered live');
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'events arrive in order');
  ctrl.abort();
});

test('the web app is served; TypeScript is served as JavaScript; no path traversal', async () => {
  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const ts = await fetch(`${base}/src/village/state.ts`);
  assert.equal(ts.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const js = await ts.text();
  assert.ok(!/:\s*ResidentLike\[\]/.test(js), 'type annotations are stripped');
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2f..%2f.env']) {
    const r = await fetch(`${base}${p}`);
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('village layout: lamp rotations are validated, saved to the layout file, and resettable', async () => {
  assert.deepEqual((await (await fetch(`${base}/api/layout`)).json()).lamps, {});
  const put = (id: string, body: unknown, headers: Record<string, string> = H) => fetch(`${base}/api/layout/lamps/${encodeURIComponent(id)}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  assert.equal((await put('road:library:left', { rotation: 90 }, { 'content-type': 'application/json' })).status, 403, 'needs the village header');
  assert.equal((await put('road:library:left', { rotation: 90 }, { ...H, origin: 'https://evil.example' })).status, 403, 'refuses other websites');
  assert.equal((await put('../../etc', { rotation: 90 })).status, 400);
  assert.equal((await put('road:library:left', { rotation: 'north' })).status, 400);
  assert.equal((await put('road:library:left', { rotation: -30 })).status, 200);
  const saved = await (await fetch(`${base}/api/layout`)).json();
  assert.deepEqual(saved.lamps, { 'road:library:left': { rotation: 330 } });
  const file = JSON.parse(fs.readFileSync(village.config.layoutFile, 'utf8'));
  assert.deepEqual(file.lamps, saved.lamps, 'written to the layout file (the test uses a temp file, never the repo)');
  assert.equal((await put('road:library:left', { rotation: null })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/layout`)).json()).lamps, {});
});
