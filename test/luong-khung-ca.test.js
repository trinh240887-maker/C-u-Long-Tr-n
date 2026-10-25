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

test('lương trong khung ca: vào sớm không tính, về sớm trừ + báo, tăng ca chỉ tính khi chủ duyệt; không phụ cấp đêm', async (t) => {
  let now = at('2026-10-26', '13:20');
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
  add.run('g1', id, pv, '2026-10-26'); add.run('g2', id, pv, '2026-10-27');
  const L = mk();
  await L('POST', '/api/login', { pin: '4821' });

  // Ngày 1: vào 13:20 (sớm 40′), ra 22:30 (về sớm 30′) → tính 14:00–22:30 = 8,5 giờ
  assert.equal((await L('POST', '/api/attendance/clock-in')).status, 200);
  now = at('2026-10-26', '22:30');
  assert.equal((await L('POST', '/api/attendance/clock-out')).status, 200);
  assert.ok(sent.some((x) => /Lan về sớm 30 phút/.test(x.title)));
  // Ngày 2: vào 14:00, ra 23:40 (ở lại 40′) → chờ chủ duyệt, chưa tính
  now = at('2026-10-27', '14:00');
  await L('POST', '/api/attendance/clock-in');
  now = at('2026-10-27', '23:40');
  await L('POST', '/api/attendance/clock-out');
  assert.ok(!sent.some((x) => /ở lại|tăng ca/.test(x.title))); // ở lại cho xong việc: không báo ai
  const rows = (await o('GET', '/api/attendance?from=2026-10-26&to=2026-10-27')).data;
  const d2 = rows.find((r) => r.date === '2026-10-27');
  assert.equal(d2.ot_minutes, 40);
  assert.equal(d2.ot_status, '');
  assert.equal(d2.paid_minutes, 540);
  const pay = async () => (await o('GET', '/api/timesheet?month=2026-10')).data.rows.find((r) => r.staff_id === id);
  let p = await pay();
  assert.equal(p.minutes, 510 + 540);
  assert.equal(p.pay, Math.round((1050 / 60) * 30000)); // không phụ cấp đêm
  // Chủ quán muốn tính thì tự bấm "Tính thêm" (không báo nhân viên)
  assert.equal((await L('POST', `/api/attendance/${d2.id}/overtime`, { approve: true })).status, 403);
  assert.equal((await o('POST', `/api/attendance/${d2.id}/overtime`, { approve: true })).status, 200);
  p = await pay();
  assert.equal(p.minutes, 1090);
});
