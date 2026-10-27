import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { addDays } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Khu cố định: đặt khu → ca từ hôm nay chuyển sang khu đó; ca mới (mọi cách tạo) tự vào khu; bỏ cố định thì không ép', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const [za, zb] = db.prepare('SELECT id FROM zones ORDER BY id').all().map((z) => z.id);
  const id = (await O('POST', '/api/staff', { name: 'Thương', team_id: pv, pin: '4821' })).data.id;
  const today = app.ctx.today();
  const ins = (d, zone) => db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g-${d}`, id, pv, d, zone);
  ins(addDays(today, -1), zb); ins(today, zb); ins(addDays(today, 2), null);
  assert.equal((await O('PATCH', `/api/staff/${id}`, { home_zone_id: za })).status, 200);
  const z = (d) => db.prepare('SELECT zone_id FROM assignments WHERE staff_id = ? AND date = ?').get(id, d).zone_id;
  assert.equal(z(addDays(today, -1)), zb); // ngày cũ giữ nguyên
  assert.equal(z(today), za);
  assert.equal(z(addDays(today, 2)), za);
  ins(addDays(today, 5), zb); // ca mới tạo ở khu khác → tự về khu cố định
  assert.equal(z(addDays(today, 5)), za);
  assert.equal((await O('GET', '/api/staff')).data.find((x) => x.id === id).home_zone_id, za);
  await O('PATCH', `/api/staff/${id}`, { home_zone_id: null });
  ins(addDays(today, 6), zb);
  assert.equal(z(addDays(today, 6)), zb);
});

test('Lịch Ca full cố định / Part-time: đưa vào (work_type full + khu), chuyển về part-time bỏ khu', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const za = db.prepare('SELECT id FROM zones ORDER BY id').get().id;
  const id = (await O('POST', '/api/staff', { name: 'Ý', team_id: pv, pin: '4822' })).data.id;
  const get = async () => (await O('GET', '/api/staff')).data.find((x) => x.id === id);
  assert.equal((await O('PATCH', `/api/staff/${id}`, { work_type: 'full', home_zone_id: za })).status, 200);
  let s = await get();
  assert.equal(s.work_type, 'full'); assert.equal(s.home_zone_id, za); assert.equal(s.name, 'Ý');
  await O('PATCH', `/api/staff/${id}`, { work_type: 'part', home_zone_id: null });
  s = await get();
  assert.equal(s.work_type, 'part'); assert.equal(s.home_zone_id, null);
  const { isFixedStaff } = await import('../public/views/availability.js').catch(() => ({}));
  if (isFixedStaff) { assert.equal(isFixedStaff({ work_type: 'gay', home_zone_id: 1 }), true); assert.equal(isFixedStaff({ work_type: 'full' }), false); assert.equal(isFixedStaff({ work_type: 'gay' }), false); }
});

test('Đổi bộ phận từ bảng tuần: gửi team_id + position_id null không lỗi khi vị trí thuộc bộ phận cũ', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const id = (await O('POST', '/api/staff', { name: 'Trâm Anh', pin: '4823' })).data.id;
  const r = await O('PATCH', `/api/staff/${id}`, { team_id: pv, position_id: null });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await O('GET', '/api/staff')).data.find((x) => x.id === id).team_id, pv);
});

test('Phục vụ: ca 14–23 → Full ca, giờ khác → Ca gãy (gán theo ca đang xếp)', async () => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const mk = (name) => db.prepare("INSERT INTO staff (name, role, team_id, active, work_type, created_at) VALUES (?, 'staff', ?, 1, '', 0)").run(name, pv).lastInsertRowid;
  const a = mk('A'), b = mk('B'), c = mk('C');
  const today = app.ctx.today();
  const ins = (sid, d, s, e, g) => db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)').run(g || `g${sid}-${d}-${s}`, sid, pv, d, s, e);
  for (let i = 0; i < 3; i++) { ins(a, addDays(today, i), 840, 1380); ins(b, addDays(today, i), 1080, 1380); }
  ins(c, today, 600, 840, 'gc'); ins(c, today, 1020, 1380, 'gc');
  assert.equal(app.ctx.pvWorkTypeSync(), 3);
  const wt = (id) => db.prepare('SELECT work_type FROM staff WHERE id = ?').get(id).work_type;
  assert.equal(wt(a), 'full'); assert.equal(wt(b), 'gay'); assert.equal(wt(c), 'gay');
  app.close();
});
