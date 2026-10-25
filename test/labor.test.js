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
const at = (d, hm) => clock.toEpoch(d, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));

test('năng suất nhân sự: lương/doanh thu theo giờ, giờ thừa người, cần nhắc (trễ, không thao tác), chỉ quản lý xem, báo cáo thứ Hai; chấm công ngoài wifi bị chặn + báo', async (t) => {
  let now = at('2026-10-24', '23:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const teams = (await o('GET', '/api/teams')).data;
  const pv = teams.find((x) => x.name === 'Phục vụ').id;
  const ids = [];
  for (let k = 0; k < 6; k++) ids.push((await o('POST', '/api/staff', { name: `PV${k + 1}`, team_id: pv, pin: String(736300 + k), pay_type: 'hour', pay_rate: 25000 })).data.id);
  // 2 ngày: 6 phục vụ làm 14:00–22:00; chiều 14–17h vắng (1 bàn), tối 18–21h đông (8 bàn)
  const days = ['2026-10-23', '2026-10-24'];
  const addAtt = db.prepare('INSERT INTO attendance (staff_id, date, clock_in, clock_out, late_minutes) VALUES (?, ?, ?, ?, ?)');
  for (const d of days) {
    ids.forEach((id, k) => addAtt.run(id, d, at(d, k === 0 ? '14:20' : '14:00'), at(d, '22:00'), k === 0 ? 20 : 0));
    const addS = db.prepare("INSERT INTO table_sessions (status, guests, opened_at, opened_by, closed_at, closed_date, paid_total) VALUES ('closed', 2, ?, ?, ?, ?, ?)");
    const addT = db.prepare('INSERT INTO session_tables (session_id, table_number) VALUES (?, ?)');
    const s1 = Number(addS.run(at(d, '15:00'), ids[1], at(d, '16:00'), d, 150000).lastInsertRowid); addT.run(s1, 1);
    for (let k = 0; k < 8; k++) { const s = Number(addS.run(at(d, '18:00'), ids[1 + (k % 4)], at(d, '21:00'), d, 900000).lastInsertRowid); addT.run(s, 10 + k); }
  }
  // PV1 trễ thêm 1 lần nữa → 3 lần; PV6 không thao tác gì cả (chỉ chấm công)
  addAtt.run(ids[0], '2026-10-22', at('2026-10-22', '17:15'), at('2026-10-22', '22:00'), 15);
  const N = mk();
  await N('POST', '/api/login', { pin: '736301' });
  await N('POST', '/api/me/pin', { current_pin: '736301', new_pin: '918301' });
  assert.equal((await N('GET', '/api/reports/labor?from=2026-10-22&to=2026-10-24')).status, 403);

  const x = (await o('GET', '/api/reports/labor?from=2026-10-22&to=2026-10-24')).data;
  assert.equal(x.summary.revenue, 2 * (150000 + 8 * 900000));
  // Lương theo giờ thật: 5 người × 8h + PV1 7h40 / ngày × 2 ngày + 4h45 ngày 22
  const hours = 2 * (5 * 8 + 7 + 40 / 60) + 4.75;
  assert.ok(Math.abs(x.summary.labor_cost - Math.round(hours * 25000)) < 2000, `${x.summary.labor_cost}`);
  // 14h–17h: 6 người, ≤1 bàn → thừa người; 18h–20h đông → không
  const overHours = x.over.map((h) => h.hour);
  assert.ok(overHours.includes(15) && overHours.includes(16), JSON.stringify(x.over));
  assert.ok(!overHours.includes(19));
  assert.ok(x.save_total > 0);
  const h19 = x.by_hour.find((h) => h.hour === 19);
  assert.equal(h19.tables, Math.round((8 * 2 / 3) * 10) / 10); // TB trên 3 ngày có người làm (22 chỉ có PV1)
  // Cần nhắc
  const p1 = x.people.find((p) => p.name === 'PV1');
  assert.match(p1.flags.join(' '), /trễ 3 lần \(55′\)/);
  const p6 = x.people.find((p) => p.name === 'PV6');
  assert.ok(p6.idle_blocks >= 2, JSON.stringify(p6));
  assert.equal(p6.bills, 0);
  const p2 = x.people.find((p) => p.name === 'PV2');
  assert.ok(p2.rev_per_hour > 0);
  // Excel
  const xl = await fetch(`${base}/api/reports/labor.xlsx?from=2026-10-22&to=2026-10-24`, { headers: { cookie: '' } });
  assert.equal(xl.status, 401);

  // Báo cáo thứ Hai 08:00 (26/10/2026 là thứ Hai), 1 lần
  now = at('2026-10-26', '07:59');
  assert.equal(app.ctx.laborWeeklyTick(), null);
  now = at('2026-10-26', '08:00');
  assert.ok(app.ctx.laborWeeklyTick());
  assert.equal(app.ctx.laborWeeklyTick(), null);
  const n = db.prepare("SELECT title, body FROM notifications WHERE title LIKE 'Năng suất tuần%' LIMIT 1").get();
  assert.match(n.title, /lương .*% doanh thu/);
  assert.match(n.body, /Giờ thừa người: .*15h/);
  assert.match(n.body, /Cần nhắc: .*PV1/);

  // Chấm công ngoài wifi quán: lấy IP đang dùng làm wifi quán; IP khác bị chặn + báo quản lý
  const net = (await o('GET', '/api/attendance/network')).data;
  assert.ok(net.ip);
  await o('PUT', '/api/settings', { clock_ip_prefixes: '10.99.99.' });
  const r = await N('POST', '/api/attendance/clock-in');
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Chỉ chấm công được khi đang ở quán/);
  await N('POST', '/api/attendance/clock-in');
  assert.equal([...new Set(db.prepare("SELECT title FROM notifications WHERE title LIKE '%chấm công khi không ở quán'").all().map((x0) => x0.title))].length, 1);
  // Máy cầu in ở quán gọi lên → IP của nó thành wifi quán (IP động tự theo)
  const tok = db.prepare("SELECT value FROM settings WHERE key = 'print_token'").get().value;
  assert.equal((await fetch(`${base}/api/print/jobs`, { headers: { 'x-print-token': tok } })).status, 200);
  assert.equal((await N('GET', '/api/attendance/network')).data.allowed, true);
  // Cầu in im quá 15 phút → không còn tính là wifi quán
  now += 16 * 60_000;
  assert.equal((await N('GET', '/api/attendance/network')).data.allowed, false);
  // GPS: đúng vị trí quán (trong 150m) thì chấm được, xa thì không
  await o('PUT', '/api/settings', { shop_lat: '10.776900', shop_lng: '106.700900' });
  const far = await N('POST', '/api/attendance/clock-in', { lat: 10.79, lng: 106.70, acc: 20 });
  assert.equal(far.status, 403);
  assert.match(far.data.error, /cách quán khoảng 1\.\dkm/);
  assert.match((await N('POST', '/api/attendance/clock-in', {})).data.error, /Chưa lấy được vị trí/);
  const ok = await N('POST', '/api/attendance/clock-in', { lat: 10.7775, lng: 106.7012, acc: 15 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(db.prepare('SELECT source FROM attendance ORDER BY id DESC LIMIT 1').get().source, /^GPS cách quán \d+m/);
  assert.equal((await N('POST', '/api/attendance/clock-out', { lat: 10.7769, lng: 106.7009, acc: 10 })).status, 200);
  await o('PUT', '/api/settings', { clock_ip_prefixes: net.ip, shop_lat: '', shop_lng: '' });
  assert.equal((await N('GET', '/api/attendance/network')).data.allowed, true);
});
