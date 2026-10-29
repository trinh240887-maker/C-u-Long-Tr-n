import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('thu ngân bấm Hết món / Bán lại; phục vụ đang trong ca nhận thông báo; phục vụ thường không bấm được', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const teams = (await o('GET', '/api/teams')).data;
  const tid = (n) => teams.find((x) => x.name === n).id;
  await o('POST', '/api/staff', { name: 'Ngân', role: 'staff', team_id: tid('Thu ngân'), pin: '7361' });
  const pvId = (await o('POST', '/api/staff', { name: 'Phúc', role: 'staff', team_id: tid('Phục vụ'), pin: '7362' })).data.id;
  const login = async (pin, np) => { const c = mk(); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
  const tn = await login('7361', '8361');
  const pv = await login('7362', '8362');
  db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at) VALUES (?, ?, ?, ?, 600, 1380, 0)').run('g1', pvId, tid('Phục vụ'), app.ctx.today());
  const item = db.prepare('SELECT id, name FROM menu_items WHERE active = 1 LIMIT 1').get();
  assert.equal((await pv('PATCH', `/api/menu/items/${item.id}`, { sold_out: true })).status, 403);
  const r = await tn('PATCH', `/api/menu/items/${item.id}`, { sold_out: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT sold_out FROM menu_items WHERE id = ?').get(item.id).sold_out, 1);
  assert.ok(db.prepare('SELECT 1 FROM notifications WHERE staff_id = ? AND title LIKE ?').get(pvId, '%Hết món%'));
  assert.equal((await tn('PATCH', `/api/menu/items/${item.id}`, { price: 1 })).status, 403); // không sửa giá
  assert.equal((await tn('PATCH', `/api/menu/items/${item.id}`, { sold_out: false })).status, 200);
  assert.ok(db.prepare('SELECT 1 FROM notifications WHERE staff_id = ? AND title LIKE ?').get(pvId, '%Bán lại%'));
  assert.ok((await tn('GET', '/api/me')).data.pages.includes('/thuc-don'));
});
