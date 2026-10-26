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

test('lỡ chấm ra: trong 10 phút đầu phải xác nhận; ra nhầm trước giờ hết ca → tự huỷ trong 30 phút', async (t) => {
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

  assert.equal((await L('POST', '/api/attendance/clock-in')).status, 200);
  now += 60_000;
  const r1 = await L('POST', '/api/attendance/clock-out');
  assert.equal(r1.status, 409); assert.match(r1.data.error, /vừa chấm vào/);
  assert.equal((await L('POST', '/api/attendance/clock-out', { confirm: true })).status, 200);
  now += 10 * 60_000;
  const me = (await L('GET', '/api/attendance/me')).data;
  assert.ok(me.undo_out && !me.open);
  const u = await L('POST', '/api/attendance/undo-out');
  assert.equal(u.status, 200); assert.ok(u.data.open);
  assert.ok(sent.some((x) => /huỷ chấm ra nhầm/.test(x.title)));
  // Hết ca 23:00 mới ra → không còn nút huỷ
  now = at('2026-10-26', '23:00');
  assert.equal((await L('POST', '/api/attendance/clock-out')).status, 200);
  now += 60_000;
  assert.equal((await L('GET', '/api/attendance/me')).data.undo_out, null);
  assert.equal((await L('POST', '/api/attendance/undo-out')).status, 409);
});
