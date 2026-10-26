import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Quyền chi tiết từng người: tắt riêng 1 việc (xem công nợ) vẫn nhập hàng được; bật riêng cho người thấp hơn; mặc định giữ nguyên', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const O = mk(); await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tid = (n) => db.prepare('SELECT id FROM teams WHERE name = ?').get(n).id;
  const mkStaff = async (name, role, team, pin) => (await O('POST', '/api/staff', { name, role, team_id: tid(team), pin })).data.id;
  const phong = await mkStaff('Gia Phong', 'staff', 'Thu ngân', '581302');
  const bep = await mkStaff('Bếp A', 'staff', 'Bếp steak', '692413');
  db.exec('UPDATE staff SET must_change_pin = 0');
  const login = async (pin) => { const c = mk(); await c('POST', '/api/login', { pin }); return c; };
  const P = await login('581302');
  const B = await login('692413');

  // Mặc định: thu ngân xem được công nợ
  assert.equal((await P('GET', '/api/suppliers/debts')).status, 200);
  let v = (await O('GET', `/api/permissions/acts?staff_id=${phong}`)).data;
  const act = (k) => v.groups.flatMap((g) => g.acts).find((a) => a.key === k);
  assert.equal(act('mh.congno').on, true);
  assert.equal(act('mh.congno').custom, false);

  // Tắt riêng "xem công nợ" + "trả NCC" cho Gia Phong: không xem được nữa, vẫn xem / nhập bill được
  v = (await O('PUT', '/api/permissions/acts', { staff_id: phong, overrides: { 'mh.congno': false, 'mh.tra': false } })).data;
  assert.equal(act('mh.congno').on, false);
  assert.equal(act('mh.congno').custom, true);
  assert.equal((await P('GET', '/api/suppliers/debts')).status, 403);
  assert.equal((await P('GET', '/api/purchases')).status, 200);
  const me = (await P('GET', '/api/me')).data;
  assert.equal(me.acts['mh.congno'], false);
  assert.ok(!me.pages.includes('/mua-hang#congno'));
  assert.ok(me.pages.includes('/mua-hang'));

  // Nhân viên bếp mặc định không xem Nhập–Xuất–Tồn; chủ quán bật riêng → xem được
  assert.equal((await B('GET', '/api/stock/nxt')).status, 403);
  await O('PUT', '/api/permissions/acts', { staff_id: bep, overrides: { 'kho.nxt': true } });
  assert.equal((await B('GET', '/api/stock/nxt')).status, 200);
  assert.ok((await B('GET', '/api/me')).data.pages.includes('/kho'));

  // Về mặc định
  await O('PUT', '/api/permissions/acts', { staff_id: phong, reset: true });
  assert.equal((await P('GET', '/api/suppliers/debts')).status, 200);
  // Nhân viên không sửa được quyền
  assert.equal((await P('PUT', '/api/permissions/acts', { staff_id: phong, overrides: { 'kho.nxt': true } })).status, 403);
});
