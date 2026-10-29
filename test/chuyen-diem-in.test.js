import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('chuyển nhiều món sang 1 điểm in (tách xiên nướng ra máy riêng)', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const o = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const st = (await o('POST', '/api/kitchen-stations', { name: 'Xiên nướng' })).data.id ?? db.prepare("SELECT id FROM kitchen_stations WHERE name = 'Xiên nướng'").get().id;
  const ids = db.prepare('SELECT id FROM menu_items WHERE active = 1 LIMIT 3').all().map((x) => x.id);
  const r = await o('POST', '/api/menu/items/station', { station_id: st, item_ids: ids });
  assert.equal(r.status, 200); assert.equal(r.data.changed, 3);
  assert.ok(ids.every((id) => db.prepare('SELECT station_id FROM menu_items WHERE id = ?').get(id).station_id === st));
  assert.equal((await o('POST', '/api/menu/items/station', { station_id: st, item_ids: [] })).status, 400);
});
