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

test('quên chấm ra: tự đóng theo lần cuối thấy ở quán (GPS / wifi) nếu sớm hơn giờ hết ca; không có dữ liệu thì đóng đúng giờ hết ca', async (t) => {
  let now = at('2026-10-26', '13:58');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const sent = [];
  app.ctx.notify = (ids, msg) => { sent.push(msg); };
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Phục vụ').id;
  const id = (await o('POST', '/api/staff', { name: 'Lan', team_id: pv, pin: '4821', pay_type: 'hour', pay_rate: 30000 })).data.id;
  const add = db.prepare("INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at) VALUES (?, ?, ?, ?, 840, 1380, 0)");
  add.run('g1', id, pv, '2026-10-26'); add.run('g2', id, pv, '2026-10-27'); add.run('g3', id, pv, '2026-10-28');
  const L = mk();
  await L('POST', '/api/login', { pin: '4821' });

  app.ctx.setSetting('shop_lat', '10.0123'); app.ctx.setSetting('shop_lng', '105.0812');
  const here0 = { lat: 10.0123, lng: 105.0812, acc: 10 };
  assert.equal((await L('POST', '/api/attendance/clock-in', here0)).status, 200);
  now = at('2026-10-26', '18:00');
  assert.equal((await L('POST', '/api/attendance/ping', here0)).data.at_shop, true);
  now = at('2026-10-26', '20:00');
  assert.equal((await L('POST', '/api/attendance/ping', here0)).data.at_shop, true);
  now = at('2026-10-26', '20:40');
  const far = await L('POST', '/api/attendance/ping', { lat: 10.03, lng: 105.09, acc: 10 });
  assert.equal(far.data.at_shop, false); // đã rời quán: không cập nhật
  now = at('2026-10-27', '02:00'); // quá giờ hết ca 23:00 + 2 tiếng
  app.ctx.autoCloseAttendance();
  const a1 = db.prepare('SELECT * FROM attendance WHERE staff_id = ? ORDER BY id DESC').get(id);
  assert.equal(a1.clock_out, at('2026-10-26', '20:00'));
  assert.match(a1.note, /theo lần cuối ở quán 20:00, GPS/);
  // Ngày 2: có mặt tới gần cuối ca (22:50) → đóng đúng 23:00
  now = at('2026-10-27', '14:00');
  assert.equal((await L('POST', '/api/attendance/clock-in', here0)).status, 200);
  now = at('2026-10-27', '22:50');
  await L('POST', '/api/attendance/ping', here0);
  now = at('2026-10-28', '02:00');
  app.ctx.autoCloseAttendance();
  const a2 = db.prepare('SELECT * FROM attendance WHERE staff_id = ? ORDER BY id DESC').get(id);
  assert.equal(a2.clock_out, at('2026-10-27', '23:00'));
});
