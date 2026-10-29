import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('order phải ở quán: ngoài quán bị chặn (mã need_location), báo GPS trong bán kính thì được; quản lý không bị chặn; tắt được; sơ đồ bàn có trạng thái đang làm', async (t) => {
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
  const pvTeam = teams.find((x) => x.name === 'Phục vụ').id;
  await o('POST', '/api/staff', { name: 'Phúc', role: 'staff', team_id: pvTeam, pin: '7401' });
  const P = mk(); await P('POST', '/api/login', { pin: '7401' }); await P('POST', '/api/me/pin', { current_pin: '7401', new_pin: '8401' });

  // Quán chưa cài GPS / wifi → không kiểm được, order bình thường
  const s1 = await P('POST', '/api/pos/sessions', { tables: [1] });
  assert.equal(s1.status, 200, JSON.stringify(s1.data));
  // Cài GPS quán
  assert.equal((await o('PUT', '/api/settings', { shop_lat: 10.0, shop_lng: 106.0, clock_radius_m: 150 })).status, 200);
  const blocked = await P('POST', '/api/pos/sessions', { tables: [2] });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'need_location');
  // Ở xa (cách ~5km) → vẫn chặn
  assert.equal((await P('POST', '/api/attendance/ping', { lat: 10.045, lng: 106.0, acc: 20 })).data.at_shop, false);
  assert.equal((await P('POST', '/api/pos/sessions', { tables: [2] })).status, 403);
  // Ở quán → được
  assert.equal((await P('POST', '/api/attendance/ping', { lat: 10.0005, lng: 106.0, acc: 20 })).data.at_shop, true);
  assert.equal((await P('POST', '/api/pos/sessions', { tables: [2] })).status, 200);
  // Chủ / quản lý không bị chặn
  assert.equal((await o('POST', '/api/pos/sessions', { tables: [3] })).status, 200);
  // Tắt kiểm tra
  await o('PUT', '/api/settings', { pos_need_at_shop: '0' });
  assert.equal(app.ctx.setting('pos_need_at_shop'), '0');

  // Sơ đồ bàn: người có ca trong khu → working theo chấm công
  const z = db.prepare('SELECT id FROM zones LIMIT 1').get();
  if (z) {
    const pid = db.prepare("SELECT id FROM staff WHERE name = 'Phúc'").get().id;
    const today = app.ctx.today();
    db.prepare("INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, zone_id, created_at) VALUES ('gz', ?, ?, ?, 0, 1439, ?, 0)").run(pid, pvTeam, today, z.id);
    let f = (await o('GET', '/api/floor')).data.zones.find((x) => x.id === z.id).on_now.find((x) => x.staff_id === pid);
    assert.equal(f.working, false);
    db.prepare('INSERT INTO attendance (staff_id, date, clock_in) VALUES (?, ?, ?)').run(pid, today, Date.now() - 60_000);
    f = (await o('GET', '/api/floor')).data.zones.find((x) => x.id === z.id).on_now.find((x) => x.staff_id === pid);
    assert.equal(f.working, true);
  }
});
