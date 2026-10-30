import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { recordMove } from '../server/lib/stock.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('NXT: lệch xếp theo tiền; khoá sổ tháng chặn ghi phát sinh ngày cũ, lưu bảng tháng; mở khoá lại ghi được', async (t) => {
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
  const today = (await o('GET', '/api/me')).data.today;
  const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); const yest = d.toISOString().slice(0, 10);
  const add = (name, price) => Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES (?, 'g', 'kg', 1000, ?)").run(name, price).lastInsertRowid);
  const bo = add('Thăn bò', 400000), hanh = add('Hành lá', 30000);
  const main = db.prepare("SELECT id FROM stores WHERE kind = 'main' ORDER BY id LIMIT 1").get().id;
  const at = Date.now();
  for (const [id, q] of [[bo, 5000], [hanh, 5000]]) recordMove(db, { at, date: yest, type: 'receive', ingredientId: id, toStore: main, qty: q, cost: 0, ref: 'nhap-le' });
  recordMove(db, { at, date: yest, type: 'waste', ingredientId: hanh, fromStore: main, qty: 1000, cost: 30000, ref: 'count:1', note: 'Lệch định lượng: x' });
  recordMove(db, { at, date: yest, type: 'waste', ingredientId: bo, fromStore: main, qty: 500, cost: 200000, ref: 'count:1', note: 'Lệch định lượng: x' });
  const n = (await o('GET', `/api/stock/nxt?from=${yest}&to=${yest}`)).data;
  assert.deepEqual(n.top.map((x) => x.name), ['Thăn bò', 'Hành lá']);
  assert.equal(n.lech_thieu, -230000);

  assert.equal((await o('PUT', '/api/stock/lock', { until: today })).status, 400, 'không khoá hôm nay');
  assert.equal((await o('PUT', '/api/stock/lock', { until: yest })).status, 200);
  assert.equal((await o('GET', `/api/stock/nxt?from=${yest}&to=${yest}`)).data.lock_until, yest);
  assert.throws(() => recordMove(db, { at, date: yest, type: 'adjust', ingredientId: bo, toStore: main, qty: 1, ref: 'x' }), /khoá/);
  recordMove(db, { at, date: today, type: 'adjust', ingredientId: bo, toStore: main, qty: 1, ref: 'x' }); // hôm nay vẫn ghi được
  assert.equal((await o('GET', '/api/stock/month-close')).data.length, 1);
  // Mở khoá → ghi lại được ngày cũ
  assert.equal((await o('PUT', '/api/stock/lock', { until: null })).status, 200);
  recordMove(db, { at, date: yest, type: 'adjust', ingredientId: bo, toStore: main, qty: 1, ref: 'x' });
});
