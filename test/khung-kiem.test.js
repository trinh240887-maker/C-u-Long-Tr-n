import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('kiểm kho 4 khung: tự xếp khung, chọn người kiểm từng khung, đầu ngày + nhập − còn = dùng', async (t) => {
  const db = openDb(':memory:');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('single_store', '1')").run();
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kk-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const S = Object.fromEntries((await o('GET', '/api/stock/meta')).data.stores.map((s) => [s.name, s.id]));
  const main = db.prepare("SELECT id FROM stores WHERE kind = 'main'").get().id;
  const rau = (await o('POST', '/api/stock/ingredients', { name: 'Rau muống', unit: 'g', home_store_id: S['Kho Bếp steak'], purchase_unit: 'kg', purchase_factor: 1000, price: 20000, freshness: 'fresh' })).data.id;
  const bo = (await o('POST', '/api/stock/ingredients', { name: 'Bò thái', unit: 'g', home_store_id: S['Kho Lẩu'], purchase_unit: 'kg', purchase_factor: 1000, price: 250000, freshness: 'fresh' })).data.id;
  const gas = (await o('POST', '/api/stock/ingredients', { name: 'Gas mini', unit: 'lon', purchase_unit: 'lon', purchase_factor: 1, price: 12000, freshness: 'dry' })).data.id;
  const meta = (await o('GET', '/api/stock/meta')).data;
  const grp = (id) => meta.ingredients.find((i) => i.id === id).group_eff;
  assert.equal(grp(rau), 'bep'); assert.equal(grp(bo), 'topping'); assert.equal(grp(gas), 'tieuhao');
  // Nhân viên thường, được chọn kiểm khung Bếp
  const team = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Phục vụ').id;
  const nvId = (await o('POST', '/api/staff', { name: 'Hà', role: 'staff', team_id: team, pin: '7365' })).data.id;
  const nv = mk(); await nv('POST', '/api/login', { pin: '7365' }); await nv('POST', '/api/me/pin', { current_pin: '7365', new_pin: '8365' });
  assert.equal((await nv('POST', '/api/stock/count', { store_id: main, lines: [{ ingredient_id: rau, actual: 1 }] })).status, 403);
  assert.equal((await o('PUT', '/api/stock/count-groups/staff', { group: 'bep', staff_ids: [nvId] })).status, 200);
  assert.deepEqual((await nv('GET', '/api/stock/meta')).data.my_groups, ['bep']);
  // Nhập 10kg rau hôm nay → đếm còn 3000g: sheet có nhập; kiểm khung Bếp được, khung Topping thì không
  await o('POST', '/api/stock/receive', { store_id: main, lines: [{ ingredient_id: rau, qty: 10 }] });
  const sheet = (await nv('GET', `/api/stock/count-sheet?store=${main}`)).data;
  const l = sheet.lines.find((x) => x.ingredient_id === rau);
  assert.equal(l.group, 'bep'); assert.equal(l.veg, true); assert.equal(l.day_in, 10000); assert.equal(l.day_open, null);
  assert.equal((await nv('POST', '/api/stock/count', { store_id: main, lines: [{ ingredient_id: bo, actual: 1 }] })).status, 403);
  assert.equal((await nv('POST', '/api/stock/count', { store_id: main, lines: [{ ingredient_id: rau, actual: 3000 }] })).status, 200);
  // Chủ đổi khung của gas
  assert.equal((await o('PUT', `/api/stock/ingredients/${gas}/kind`, { count_group: 'bep' })).status, 200);
  assert.equal((await o('GET', '/api/stock/meta')).data.ingredients.find((i) => i.id === gas).group_eff, 'bep');
});
