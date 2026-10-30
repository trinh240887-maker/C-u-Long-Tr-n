import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMG = `data:image/jpeg;base64,${Buffer.alloc(3000, 9).toString('base64')}`;

test('duyệt bill: phí ship chia vào giá vốn theo giá trị, chiết khấu trừ lại; dòng ship lỡ gắn mã kho bị bỏ khỏi kho', async (t) => {
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
  const store = db.prepare("SELECT id FROM stores WHERE kind = 'main' ORDER BY id LIMIT 1").get().id;
  const ing = (name, price) => Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES (?, 'gói', 'gói', 1, ?)").run(name, price).lastInsertRowid);
  const tui = ing('Túi tiền', 88500), xa = ing('Xá xíu', 100000), ship = ing('phi ship', 60000);
  const bill = async (lines, total) => (await o('POST', '/api/purchases', { store_id: store, supplier_name: 'Minh Thành Food', signer_name: 'Ngân', total, photos: [IMG], goods_photos: [IMG], lines })).data;
  // Bill 1: túi tiền 20 × 88.500 + ship 60.000 (dòng ship lỡ gắn mã "phi ship")
  const b1 = await bill([{ ingredient_id: tui, qty: 20, price: 88500 }, { ingredient_id: ship, qty: 1, price: 60000 }], 1830000);
  assert.ok(b1.id, JSON.stringify(b1));
  assert.equal((await o('POST', `/api/purchases/${b1.id}/approve`)).status, 200);
  assert.equal(db.prepare('SELECT price FROM ingredients WHERE id = ?').get(tui).price, 91500, '88.500 + 3.000 ship');
  assert.equal(db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(ship).q, 0, 'phí ship không nằm trong kho');
  const l1 = db.prepare('SELECT * FROM purchase_bill_lines WHERE bill_id = ? AND ingredient_id = ?').get(b1.id, tui);
  assert.equal(l1.extra_cost, 60000);
  // Bill 2: 2 món chia theo giá trị (1.000.000 + 500.000), ship 30.000, chiết khấu 15.000 → thêm 15.000: 10.000 / 5.000
  const b2 = await bill([{ ingredient_id: tui, qty: 10, price: 100000 }, { ingredient_id: xa, qty: 5, price: 100000 }, { name: 'Phí vận chuyển', qty: 1, price: 30000, kind: 'ship' }, { name: 'Chiết khấu', qty: 1, price: 15000, kind: 'discount' }], 1515000);
  assert.equal((await o('POST', `/api/purchases/${b2.id}/approve`)).status, 200);
  assert.equal(db.prepare('SELECT price FROM ingredients WHERE id = ?').get(tui).price, 101000);
  assert.equal(db.prepare('SELECT price FROM ingredients WHERE id = ?').get(xa).price, 101000);
  assert.equal(db.prepare('SELECT lines_total FROM purchase_bills WHERE id = ?').get(b2.id).lines_total, 1515000, 'chiết khấu trừ vào cộng dòng');
  // Dòng chưa quy đổi (bill ghi 2 thùng × 600.000) + ship 40.000 → duyệt rồi mới quy đổi 1 thùng = 12 gói → giá vốn (1.200.000 + 40.000) / 24
  const mi = ing('Mì trứng', 50000);
  const b3 = await bill([{ ingredient_id: mi, qty: 2, unit: 'thùng', price: 600000, unconv: true }, { name: 'Tiền xe', qty: 1, price: 40000 }], 1240000);
  assert.equal((await o('POST', `/api/purchases/${b3.id}/approve`)).status, 200);
  assert.equal(db.prepare('SELECT price FROM ingredients WHERE id = ?').get(mi).price, 50000, 'chưa quy đổi: giữ giá cũ');
  const ln = db.prepare('SELECT id, extra_cost FROM purchase_bill_lines WHERE bill_id = ? AND ingredient_id = ?').get(b3.id, mi);
  assert.equal(ln.extra_cost, 40000);
  const cv = await o('POST', `/api/purchases/lines/${ln.id}/convert`, { factor: 12 });
  assert.equal(cv.status, 200, JSON.stringify(cv.data));
  assert.equal(db.prepare('SELECT price FROM ingredients WHERE id = ?').get(mi).price, Math.round(1240000 / 24));
});
