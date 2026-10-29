import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('duyệt NV mới qua bot: chỉ cần quyền "Duyệt nhân viên mới" (không cần "Thêm nhân viên"); báo chủ ai thêm + tổng người bộ phận; màn Quản lý hiện', async (t) => {
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
  const bep = teams.find((x) => /bếp/i.test(x.name)) || teams[0];
  const ownerId = db.prepare("SELECT id FROM staff WHERE role = 'owner'").get().id;
  // Phát: quản lý, chủ quán tick "Duyệt nhân viên mới", BỎ tick "Thêm nhân viên" (đúng tình huống lỗi)
  const phat = (await o('POST', '/api/staff', { name: 'Phát', role: 'manager', team_id: bep.id, pin: '736101' })).data.id;
  // Trưởng ca được tick riêng quyền duyệt
  const tc = (await o('POST', '/api/staff', { name: 'Tâm', role: 'shift_lead', team_id: bep.id, pin: '736102' })).data.id;
  app.ctx.setSetting('perm_user', JSON.stringify({ [phat]: { 'ranh.nvmoi': true, 'nv.them': false }, [tc]: { 'ranh.nvmoi': true } }));
  const login = async (pin, np) => { const c = mk(); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
  const P = await login('736101', '836101');
  const T = await login('736102', '836102');
  const req = (name) => Number(db.prepare("INSERT INTO staff_requests (at, name, phone, team_id, raw) VALUES (?, ?, '0917083505', ?, 'nv mới')").run(Date.now(), name, bep.id).lastInsertRowid);
  const before = db.prepare('SELECT COUNT(*) AS n FROM staff WHERE active = 1 AND team_id = ?').get(bep.id).n;

  const q1 = req('Đặng Giang');
  assert.equal((await P('GET', '/api/staff-requests')).status, 200);
  const r = await P('POST', `/api/staff-requests/${q1}/approve`, { name: 'Đặng Giang', phone: '0917083505', team_id: bep.id, role: 'staff', pay_type: 'hour', pay_rate: 30000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.pin, /^\d{6}$/);
  const giang = db.prepare('SELECT * FROM staff WHERE id = ?').get(r.data.id);
  assert.equal(giang.created_by, phat);
  assert.equal(giang.pay_rate, 30000); // quản lý thật đặt lương được
  assert.equal(db.prepare('SELECT status FROM staff_requests WHERE id = ?').get(q1).status, 'approved');
  const note = db.prepare('SELECT title, body FROM notifications WHERE staff_id = ? ORDER BY id DESC').get(ownerId);
  assert.match(note.title, /Phát vừa thêm Đặng Giang/);
  assert.match(note.body, new RegExp(`${bep.name} giờ có ${before + 1} người`));
  // Nhân viên mới đăng nhập được bằng PIN
  const G = mk(); const gl = await G('POST', '/api/login', { phone: '0917083505', pin: r.data.pin }); assert.equal(gl.status, 200, JSON.stringify(gl.data));

  // Trưởng ca: chỉ tạo Nhân viên / Tổ trưởng, không đặt lương
  const q2 = req('Lan');
  assert.equal((await T('POST', `/api/staff-requests/${q2}/approve`, { name: 'Lan', team_id: bep.id, role: 'shift_lead' })).status, 403);
  const r2 = await T('POST', `/api/staff-requests/${q2}/approve`, { name: 'Lan', team_id: bep.id, role: 'staff', pay_rate: 99999 });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.equal(db.prepare('SELECT pay_rate FROM staff WHERE id = ?').get(r2.data.id).pay_rate, 0);

  // Màn Quản lý của chủ: thấy ai thêm ai
  const d = (await o('GET', '/api/dashboard')).data;
  assert.deepEqual(d.new_staff.map((s) => [s.name, s.by_name]), [['Lan', 'Tâm'], ['Đặng Giang', 'Phát']]);
  assert.equal((await P('GET', '/api/dashboard')).data.new_staff.length, 0); // chỉ chủ xem

  // Người không được tick vẫn bị chặn
  const pv = (await o('POST', '/api/staff', { name: 'Phúc', role: 'staff', team_id: bep.id, pin: '7363' })).data.id;
  const V = await login('7363', '8363');
  assert.equal((await V('POST', `/api/staff-requests/${req('X')}/approve`, { name: 'X', role: 'staff' })).status, 403);
  assert.ok(pv);
});
