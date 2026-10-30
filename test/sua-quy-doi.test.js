import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMG = `data:image/jpeg;base64,${Buffer.alloc(3000, 9).toString('base64')}`;

test('quy đổi đã nhớ (1 thùng = 24 chai) sửa được lúc nhập (lần này 22 chai) → app nhớ số mới', async (t) => {
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
  app.ctx.setSetting('anthropic_api_key', 'sk-test');
  const ing = Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES ('Nước tương', 'chai', 'chai', 1, 15000)").run().lastInsertRowid);
  db.prepare("INSERT INTO unit_aliases (ingredient_id, bill_unit, factor) VALUES (?, 'thùng', 24)").run(ing);
  app.ctx.readBill = async () => ({ supplier_name: 'Tạp hoá Hiền', signer_name: '', total: 660000, note: '', lines: [{ ingredient_id: ing, name: 'Nước tương', unit: 'thùng', qty: 2, price: 330000, amount: 660000 }] });
  const rd = await o('POST', '/api/purchases/read-bill', { photos: [IMG] });
  assert.equal(rd.status, 200, JSON.stringify(rd.data));
  assert.deepEqual([rd.data.lines[0].factor, rd.data.lines[0].qty], [24, 48]);
  // Lần này thùng 22 chai: người nhập sửa → gửi conversions → app nhớ 22
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
  const sv = await o('POST', '/api/purchases', { pre_bill: true, store_id: store, supplier_name: 'Tạp hoá Hiền', new_supplier: true, signer_name: 'Chủ', photos: [IMG],
    lines: [{ ingredient_id: ing, qty: 44, price: 15000 }], conversions: [{ ingredient_id: ing, bill_unit: 'Thùng', factor: 22 }] });
  assert.equal(sv.status, 200, JSON.stringify(sv.data));
  assert.equal(db.prepare("SELECT factor FROM unit_aliases WHERE ingredient_id = ? AND bill_unit = 'thùng'").get(ing).factor, 22);
  const rd2 = await o('POST', '/api/purchases/read-bill', { photos: [IMG] });
  assert.deepEqual([rd2.data.lines[0].factor, rd2.data.lines[0].qty], [22, 44]);
});
