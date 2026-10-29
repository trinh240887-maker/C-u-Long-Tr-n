import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-10-29T05:00:00Z'); // 12:00 giờ VN

test('khung lương bộ phận × chức vụ: chỉ chủ sửa; NV theo khung tự lấy lương; lên tổ trưởng từ 28/10 → bảng lương tách 2 đoạn; quản lý chỉ thấy NV bộ phận mình', async (t) => {
  const db = openDb(':memory:', { now: NOW });
  const app = createApp({ db, now: () => NOW, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const teams = (await o('GET', '/api/teams')).data;
  const pv = teams.find((x) => x.name === 'Phục vụ').id;
  const bar = teams.find((x) => x.name === 'Bar').id;
  const mkStaff = async (name, role, team_id, pin, extra = {}) => { const r = await o('POST', '/api/staff', { name, role, team_id, pin, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.id; };
  const ngocAnh = await mkStaff('Ngọc Anh', 'staff', pv, '7381');
  const cu = await mkStaff('Cũ', 'staff', pv, '7382', { pay_rate: 21000 }); // chủ nhập tay → lương riêng
  const qlBar = await mkStaff('QL Bar', 'manager', bar, '738301');
  await mkStaff('Bar 1', 'staff', bar, '7384');

  // Chỉ chủ xem / sửa khung
  const Q = mk(); await Q('POST', '/api/login', { pin: '738301' }); await Q('POST', '/api/me/pin', { current_pin: '738301', new_pin: '838301' });
  assert.equal((await Q('GET', '/api/pay-scales')).status, 403);
  assert.equal((await Q('PUT', '/api/pay-scales', { items: [{ team_id: pv, role: 'staff', pay_type: 'hour', pay_rate: 99000 }] })).status, 403);
  const sv = await o('PUT', '/api/pay-scales', { from_month: '2026-10', items: [
    { team_id: pv, role: 'staff', pay_type: 'hour', pay_rate: 20000 },
    { team_id: pv, role: 'team_lead', pay_type: 'hour', pay_rate: 26000 },
  ] });
  assert.equal(sv.status, 200, JSON.stringify(sv.data));
  const ps = (await o('GET', '/api/pay-scales')).data;
  assert.equal(ps.teams.find((x) => x.id === pv).scales.staff.pay_rate, 20000);
  assert.equal(ps.teams.find((x) => x.id === pv).scales.staff.count, 1); // Ngọc Anh theo khung; "Cũ" lương riêng
  assert.deepEqual(ps.custom.map((x) => x.name), ['Cũ']);
  const list = (await o('GET', '/api/staff')).data;
  assert.equal(list.find((x) => x.id === ngocAnh).pay_rate, 20000);
  assert.equal(list.find((x) => x.id === ngocAnh).pay_custom, false);
  assert.equal(list.find((x) => x.id === cu).pay_rate, 21000);

  // Ngọc Anh lên tổ trưởng từ 28/10; chấm công 20/10 (5 giờ, NV) và 28/10 (5 giờ, tổ trưởng)
  const at = (d, h1, h2) => db.prepare('INSERT INTO attendance (staff_id, date, clock_in, clock_out) VALUES (?, ?, ?, ?)').run(ngocAnh, d, Date.parse(`${d}T${h1}:00+07:00`), Date.parse(`${d}T${h2}:00+07:00`));
  at('2026-10-20', '10:00', '15:00');
  at('2026-10-28', '10:00', '15:00');
  assert.equal((await o('PATCH', `/api/staff/${ngocAnh}`, { role: 'team_lead', role_from: '2026-11-02' })).status, 400); // không chọn ngày tương lai
  assert.equal((await o('PATCH', `/api/staff/${ngocAnh}`, { role: 'team_lead', role_from: '2026-10-28' })).status, 200);
  const ts = (await o('GET', '/api/timesheet?month=2026-10')).data;
  const row = ts.rows.find((x) => x.staff_id === ngocAnh);
  assert.equal(row.pay, 5 * 20000 + 5 * 26000);
  assert.deepEqual(row.segments.map((s) => [s.role, s.pay_rate, s.pay]), [['staff', 20000, 100000], ['team_lead', 26000, 130000]]);
  assert.equal((await o('GET', '/api/staff')).data.find((x) => x.id === ngocAnh).pay_rate, 26000);

  // Chủ chuyển "Cũ" về theo khung
  assert.equal((await o('POST', '/api/pay-scales/use', { ids: [cu], custom: false })).status, 200);
  assert.equal((await o('GET', '/api/staff')).data.find((x) => x.id === cu).pay_rate, 20000);

  // Quản lý Bar: màn Nhân viên (mine=1) chỉ thấy người Bar; danh sách chung không lộ lương bộ phận khác
  const mine = (await Q('GET', '/api/staff?mine=1')).data;
  assert.ok(mine.every((x) => x.team_id === bar || x.id === qlBar), JSON.stringify(mine.map((x) => x.name)));
  assert.ok(mine.some((x) => x.name === 'Bar 1'));
  const all = (await Q('GET', '/api/staff')).data;
  assert.equal(all.find((x) => x.id === ngocAnh).pay_rate, undefined);
  // Quản lý không đặt lương
  assert.equal((await Q('PATCH', `/api/staff/${mine.find((x) => x.name === 'Bar 1').id}`, { pay_rate: 30000 })).status, 403);
});
