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
const IMG = `data:image/jpeg;base64,${Buffer.alloc(3000, 9).toString('base64')}`;

test('nhập bill không cần quy đổi (dòng chưa quy đổi được cắm cờ) + sửa bill đổi hàng nhập sai tên → kho trừ hàng cũ, cộng hàng đúng', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const o = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const meta = (await o('GET', '/api/stock/meta')).data;
  const lau = meta.stores.find((s) => s.name === 'Kho Lẩu');
  const mk = async (name) => (await o('POST', '/api/stock/ingredients', { name, unit: 'g', freshness: 'fresh', home_store_id: lau.id, purchase_unit: 'kg', purchase_factor: 1000, price: 150000 })).data.id;
  const dui = await mk('Đùi bò tươi');
  const chang = await mk('Chẳng dừng');
  const pheo = await mk('Phèo non');
  const qty = (ing) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(ing).q;
  const r = await o('POST', '/api/purchases', { store_id: lau.id, supplier_name: 'Thịt heo dì sáu', signer_name: 'A', total: 900000, photos: [IMG], goods_photos: [IMG],
    lines: [{ ingredient_id: dui, qty: 3, price: 150000 }, { ingredient_id: pheo, qty: 3, price: 150000, unconv: true, unit: 'mẹt' }] });
  assert.equal(r.status, 200);
  assert.ok(r.data.flags.some((f) => /Phèo non: bill ghi 3 mẹt, chưa quy đổi/.test(f)));
  assert.equal(qty(dui), 3000);
  // Sửa: dòng "Đùi bò tươi" thật ra là "Chẳng dừng"
  const lines = r.data.lines.map((l) => ({ ingredient_id: l.ingredient_id === dui ? chang : l.ingredient_id, qty: l.qty, price: l.price }));
  assert.equal((await o('PATCH', `/api/purchases/${r.data.id}`, { total: 900000, lines })).status, 200);
  assert.equal(qty(dui), 0);
  assert.equal(qty(chang), 3000);
  assert.equal(qty(pheo), 3000);
  const b = (await o('GET', '/api/purchases')).data.bills.find((x) => x.id === r.data.id);
  assert.deepEqual(b.lines.map((l) => l.name).sort(), ['Chẳng dừng', 'Phèo non']);
  // Mua hàng → ⚖ Quy đổi: 1 mẹt = 2,5 kg → kho 7,5 kg, giá 60.000/kg, hết cờ, nhớ cho lần sau
  const un = (await o('GET', '/api/purchases/unconverted')).data;
  assert.equal(un.length, 1);
  assert.equal(un[0].bill_unit, 'mẹt');
  assert.equal((await o('POST', `/api/purchases/lines/${un[0].id}/convert`, { factor: '2,5' })).status, 200);
  assert.equal(qty(pheo), 7500);
  assert.equal((await o('GET', '/api/purchases/unconverted')).data.length, 0);
  const b2 = (await o('GET', '/api/purchases')).data.bills.find((x) => x.id === r.data.id);
  const ln = b2.lines.find((l) => l.ingredient_id === pheo);
  assert.deepEqual([ln.qty, ln.price, ln.unit], [7.5, 60000, 'kg']);
  assert.ok(!b2.flags.some((f) => /chưa quy đổi/.test(f)));
  assert.equal(db.prepare("SELECT factor FROM unit_aliases WHERE ingredient_id = ? AND bill_unit = 'mẹt'").get(pheo).factor, 2500);
});
