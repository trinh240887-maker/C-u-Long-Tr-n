import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('quy đổi: "Không cần quy đổi" lưu ghi chú + nhớ; các dòng khác cùng hàng cùng đơn vị tự quy đổi luôn', async (t) => {
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
  const ing = Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES ('Đường cát', 'kg', 'kg', 1, 20000)").run().lastInsertRowid);
  const bill = (qty) => {
    const b = Number(db.prepare("INSERT INTO purchase_bills (supplier_name, date, total, status, received_at) VALUES ('Tạp hoá Hiền', ?, 0, 'waiting', ?)").run(app.ctx.today(), Date.now()).lastInsertRowid);
    return Number(db.prepare("INSERT INTO purchase_bill_lines (bill_id, ingredient_id, name, qty, unit, price, amount, bill_unit) VALUES (?, ?, 'Đường cát', ?, 'cây', 238500, ?, 'cây')").run(b, ing, qty, qty * 238500).lastInsertRowid);
  };
  const l1 = bill(4), l2 = bill(2);
  assert.equal((await o('GET', '/api/purchases/unconverted')).data.length, 2);
  const r = await o('POST', `/api/purchases/lines/${l1}/convert`, { factor: 1, keep: true, note: '1 cây = 1 bịch 1kg' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.more, 1);
  assert.equal((await o('GET', '/api/purchases/unconverted')).data.length, 0);
  assert.equal(db.prepare('SELECT bill_unit FROM purchase_bill_lines WHERE id = ?').get(l2).bill_unit, null);
  const al = (await o('GET', '/api/stock/unit-aliases')).data.find((x) => x.ingredient_id === ing);
  assert.deepEqual([al.bill_unit, al.factor, al.keep, al.note], ['cây', 1, 1, '1 cây = 1 bịch 1kg']);
  // Nguyên liệu tính theo bao / chai: ghi "không cần quy đổi" + ghi chú, bỏ được
  const gao = Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES ('Gạo xốp 25kg', 'bao', 'bao', 1, 500000)").run().lastInsertRowid);
  assert.equal((await o('POST', `/api/stock/ingredients/${gao}/conv-ok`, { ok: true, note: 'Dùng nguyên bao' })).status, 200);
  const g = (await o('GET', '/api/stock/meta')).data.ingredients.find((x) => x.id === gao);
  assert.deepEqual([g.conv_ok, g.conv_note], [1, 'Dùng nguyên bao']);
  await o('POST', `/api/stock/ingredients/${gao}/conv-ok`, { ok: false });
  // "Dùng cho": nguyên liệu nằm trong định lượng món nào
  const item = db.prepare('SELECT id, name FROM menu_items WHERE active = 1 LIMIT 1').get();
  db.prepare('INSERT INTO menu_recipes (item_id, ingredient_id, qty) VALUES (?, ?, 0.1)').run(item.id, gao);
  assert.deepEqual((await o('GET', '/api/stock/meta')).data.ingredients.find((x) => x.id === gao).used_for, [item.name]);
  assert.deepEqual((await o('GET', '/api/stock/overview')).data.items.find((x) => x.id === gao)?.used_for, [item.name]);
  assert.equal(db.prepare('SELECT conv_ok FROM ingredients WHERE id = ?').get(gao).conv_ok, 0);
});
