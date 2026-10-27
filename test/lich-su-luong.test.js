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
const at = (d, h) => clock.toEpoch(d, h * 60);

test('lương đổi theo tháng: tháng 10 23k/giờ, đặt trước từ tháng 11 20k/giờ; tháng cũ giữ mức cũ', async (t) => {
  let now = at('2026-10-27', 10);
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const id = (await O('POST', '/api/staff', { name: 'Lan', team_id: pv, pin: '4821', pay_type: 'hour', pay_rate: 23000 })).data.id;
  const rec = (d) => db.prepare('INSERT INTO attendance (staff_id, date, clock_in, clock_out) VALUES (?, ?, ?, ?)').run(id, d, at(d, 14), at(d, 22));
  rec('2026-10-20'); rec('2026-11-05');
  // Đặt trước: từ tháng 11 còn 20k
  assert.equal((await O('PATCH', `/api/staff/${id}`, { pay_type: 'hour', pay_rate: 20000, pay_from: '2026-11' })).status, 200);
  const st = (await O('GET', '/api/staff')).data.find((x) => x.id === id);
  assert.equal(st.pay_rate, 23000); // tháng này vẫn 23k
  assert.deepEqual(st.pay_history.map((h) => [h.from_month, h.pay_rate]), [['2026-11', 20000]]);
  const oct = (await O('GET', '/api/timesheet?month=2026-10')).data.rows.find((r) => r.staff_id === id);
  const nov = (await O('GET', '/api/timesheet?month=2026-11')).data.rows.find((r) => r.staff_id === id);
  assert.equal(oct.pay_rate, 23000);
  assert.equal(oct.pay, 8 * 23000);
  assert.equal(nov.pay_rate, 20000);
  assert.equal(nov.pay, 8 * 20000);
  // Sang tháng 11: mức đang dùng tự là 20k khi sửa lần tới; tháng 10 vẫn 23k
  now = at('2026-11-02', 10);
  assert.equal((await O('GET', '/api/timesheet?month=2026-10')).data.rows.find((r) => r.staff_id === id).pay, 8 * 23000);
  assert.equal((await O('GET', '/api/staff')).data.find((x) => x.id === id).pay_rate, 20000);
});
