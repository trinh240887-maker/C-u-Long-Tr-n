import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('chỉ người đang trong ca mới order (bật ở Cài đặt): chưa chấm công → chặn; đã chấm vào → được; quản lý không bị chặn', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  assert.equal(app.ctx.setting('pos_need_shift'), ''); // DB mới: tắt
  assert.equal((await o('PUT', '/api/settings', { pos_need_shift: '1' })).status, 200);
  assert.equal(app.ctx.setting('pos_need_shift'), '1');
  const team = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Phục vụ').id;
  const nvId = (await o('POST', '/api/staff', { name: 'Hà', role: 'staff', team_id: team, pin: '7365' })).data.id;
  const nv = mk(); await nv('POST', '/api/login', { pin: '7365' }); await nv('POST', '/api/me/pin', { current_pin: '7365', new_pin: '8365' });
  const blocked = await nv('POST', '/api/pos/sessions', { tables: [1], guests: 2, override_size: true });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error || '', /chưa chấm công/);
  assert.equal((await nv('GET', '/api/pos/sessions')).status !== 403, true); // xem vẫn được
  // Chủ quán không bị chặn
  assert.equal((await o('POST', '/api/pos/sessions', { tables: [2], guests: 2, override_size: true })).status, 200);
  // Đang trong ca → được
  db.prepare('INSERT INTO attendance (staff_id, date, clock_in) VALUES (?, ?, ?)').run(nvId, app.ctx.today(), Date.now());
  assert.equal((await nv('POST', '/api/pos/sessions', { tables: [3], guests: 2, override_size: true })).status, 200);
  // Tắt → ai cũng được
  db.prepare('UPDATE attendance SET clock_out = ? WHERE staff_id = ?').run(Date.now(), nvId);
  assert.equal((await nv('POST', '/api/pos/sessions', { tables: [4], guests: 2, override_size: true })).status, 403);
  await o('PUT', '/api/settings', { pos_need_shift: '0' });
  assert.equal((await nv('POST', '/api/pos/sessions', { tables: [4], guests: 2, override_size: true })).status, 200);
});
