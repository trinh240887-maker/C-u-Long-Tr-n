import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMG = `data:image/jpeg;base64,${Buffer.alloc(3000, 9).toString('base64')}`;

test('NCC tên gần giống: bill mới khớp NCC cũ; công nợ báo "có thể cùng NCC"; chủ gộp → chuyển hết bill, tắt NCC kia', async (t) => {
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
  const A = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('Vựa rau củ quả - Khoai bí Trung Thủy')").run().lastInsertRowid);
  const store = db.prepare("SELECT id FROM stores WHERE kind = 'area' LIMIT 1").get()?.id || db.prepare('SELECT id FROM stores LIMIT 1').get().id;
  const ing = Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES ('Bí đỏ', 'kg', 'kg', 1, 10000)").run().lastInsertRowid);
  // Bill ghi tên hơi khác → hỏi lại "Có phải NCC …?" (409 similar_supplier); chọn đúng → vào NCC A; chọn NCC mới → tạo mới
  const body = { pre_bill: true, store_id: store, supplier_name: 'Rau củ quả - Khoai bí Trung Thủy', signer_name: 'Chủ', photos: [IMG], lines: [{ ingredient_id: ing, qty: 2, price: 10000 }] };
  const ask = await o('POST', '/api/purchases', body);
  assert.equal(ask.status, 409); assert.equal(ask.data.code, 'similar_supplier'); assert.equal(ask.data.similar.id, A);
  const r = await o('POST', '/api/purchases', { ...body, supplier_id: A, supplier_name: undefined });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT supplier_id FROM purchase_bills WHERE id = ?').get(r.data.id).supplier_id, A);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM suppliers WHERE name LIKE '%Trung Thủy%'").get().n, 1);
  // Trùng y tên (khác hoa thường / dấu) → không hỏi
  assert.equal((await o('POST', '/api/purchases', { ...body, supplier_name: 'VỰA RAU CỦ QUẢ - KHOAI BÍ TRUNG THỦY', lines: [{ ingredient_id: ing, qty: 5, price: 10000 }] })).status, 200);
  const nw = await o('POST', '/api/purchases', { ...body, new_supplier: true, lines: [{ ingredient_id: ing, qty: 7, price: 10000 }] });
  assert.equal(nw.status, 200);
  assert.notEqual(db.prepare('SELECT supplier_id FROM purchase_bills WHERE id = ?').get(nw.data.id).supplier_id, A);
  db.prepare("UPDATE suppliers SET active = 0 WHERE name = 'Rau củ quả - Khoai bí Trung Thủy'").run();
  // Tên khác hẳn → NCC mới
  assert.ok(!app.ctx.findSupplier('Tạp hoá Hiền'));
  // Dữ liệu cũ đã lỡ tách 2 NCC → công nợ báo, chủ gộp
  const B = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('Rau cu qua Khoai bi Trung Thuy')").run().lastInsertRowid);
  const bB = Number(db.prepare("INSERT INTO purchase_bills (supplier_id, supplier_name, date, total, status, received_at) VALUES (?, 'Rau cu qua Khoai bi Trung Thuy', ?, 4488000, 'approved', ?)").run(B, app.ctx.today(), Date.now()).lastInsertRowid);
  const d = (await o('GET', '/api/suppliers/debts')).data;
  const list = Array.isArray(d) ? d : d.suppliers;
  assert.ok(list.find((x) => x.id === B).similar.some((x) => x.id === A));
  const m = await o('POST', `/api/suppliers/${B}/merge`, { into: A });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(db.prepare('SELECT supplier_id FROM purchase_bills WHERE id = ?').get(bB).supplier_id, A);
  assert.equal(db.prepare('SELECT active FROM suppliers WHERE id = ?').get(B).active, 0);
});
