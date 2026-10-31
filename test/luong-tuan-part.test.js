import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });

test('lương part-time theo tuần: giờ chấm công × lương giờ, thu ngân bấm đã trả → phiếu chi, nhân viên chỉ thấy của mình; full-time không có', async (t) => {
  let now = clock.toEpoch('2026-11-08', 21 * 60); // CN 08/11 21:00
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const s = res.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const teams = (await o('GET', '/api/teams')).data;
  const pv = teams.find((x) => x.name === 'Phục vụ').id, tn = teams.find((x) => x.name === 'Thu ngân').id;
  const zone = db.prepare('SELECT id FROM zones ORDER BY id LIMIT 1').get()?.id ?? Number(db.prepare("INSERT INTO zones (name) VALUES ('Khu A')").run().lastInsertRowid);
  const mai = (await o('POST', '/api/staff', { name: 'Mai Part', team_id: pv, pin: '4821', pay_type: 'hour', pay_rate: 25000 })).data.id;
  const lan = (await o('POST', '/api/staff', { name: 'Lan Full', team_id: pv, pin: '5932', pay_type: 'hour', pay_rate: 25000 })).data.id;
  db.prepare('UPDATE staff SET pay_type = ?, pay_rate = ? WHERE id IN (?, ?)').run('hour', 25000, mai, lan);
  db.prepare("UPDATE staff SET work_type = 'part' WHERE id = ?").run(mai); db.prepare("UPDATE staff SET work_type = 'full', home_zone_id = ? WHERE id = ?").run(zone, lan);
  await o('POST', '/api/staff', { name: 'Thu ngân A', team_id: tn, pin: '6043' });
  // Mai làm 3 tối 18–23 (5 giờ) trong tuần 02/11–08/11
  for (const d of ['2026-11-03', '2026-11-05', '2026-11-07']) for (const id of [mai, lan]) db.prepare('INSERT INTO attendance (staff_id, date, clock_in, clock_out) VALUES (?, ?, ?, ?)').run(id, d, clock.toEpoch(d, 18 * 60), clock.toEpoch(d, 23 * 60));
  let w = (await o('GET', '/api/payroll/week?week=2026-11-02')).data;
  assert.equal(w.week_start, '2026-11-02');
  const m = w.people.find((x) => x.staff_id === mai);
  assert.ok(m, JSON.stringify(w.people));
  assert.ok(!w.people.some((x) => x.staff_id === lan), 'full-time không tính lương tuần');
  assert.equal(m.minutes, 900); assert.equal(m.pay, 375000);
  const T = mk(); await T('POST', '/api/login', { pin: '6043' });
  w = (await T('POST', '/api/payroll/week/pay', { week: '2026-11-02', staff_id: mai, method: 'cash' })).data;
  assert.ok(w.people.find((x) => x.staff_id === mai).paid);
  assert.equal(db.prepare("SELECT amount FROM expenses WHERE category LIKE 'Lương%'").get().amount, 375000);
  assert.equal((await T('POST', '/api/payroll/week/pay', { week: '2026-11-02', staff_id: mai, method: 'cash' })).status, 409, 'không trả 2 lần');
  const M = mk(); await M('POST', '/api/login', { pin: '4821' });
  const mine = (await M('GET', '/api/payroll/week?week=2026-11-02')).data;
  assert.equal(mine.people.length, 1); assert.equal(mine.total, undefined);
  assert.equal((await M('POST', '/api/payroll/week/pay', { week: '2026-11-02', staff_id: mai, method: 'cash' })).status, 403);
  // Ngày trả do chủ chọn
  assert.equal((await o('PUT', '/api/settings', { part_pay_day: 'mon' })).status, 200);
  assert.equal((await o('GET', '/api/payroll/week?week=2026-11-02')).data.pay_date, '2026-11-09');
});
