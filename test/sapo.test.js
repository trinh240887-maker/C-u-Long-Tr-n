import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeXlsx } from '../server/lib/xlsx.js';
import { readXlsx } from '../server/lib/xlsx-read.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serial = (date, h, m) => (Date.parse(`${date}T00:00:00Z`) / 86_400_000) + 25569 + (h * 60 + m) / 1440;

test('Nhập bán hàng Sapo: đọc file mặt hàng, ghép món, trừ kho theo định lượng, không nhập trùng, bỏ nhập cộng lại kho', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  // Món + định lượng: "Bò test" 1 phần = 100 g thịt
  const store = db.prepare("SELECT id FROM stores WHERE kind = 'main' LIMIT 1").get().id;
  const ing = Number(db.prepare("INSERT INTO ingredients (name, unit, home_store_id) VALUES ('Thịt test', 'g', NULL)").run().lastInsertRowid);
  db.prepare('INSERT INTO stock_lots (store_id, ingredient_id, qty, received_at) VALUES (?, ?, 5000, 0)').run(store, ing);
  const item = Number(db.prepare("INSERT INTO menu_items (name, price) VALUES ('Bò test', 50000)").run().lastInsertRowid);
  db.prepare('INSERT INTO menu_recipes (item_id, ingredient_id, qty) VALUES (?, ?, 100)').run(item, ing);
  const rows = [['Thời gian xuất', '27/10/2026'], [], ['DOANH THU THEO DANH SÁCH MẶT HÀNG'],
    ['Stt', 'Mã hóa đơn', 'Trạng thái đơn hàng', 'Thời gian thanh toán', 'Mã mặt hàng', 'Tên mặt hàng, combo', 'Số lượng', 'Tiền hàng', 'Tổng tiền thanh toán  (1 + 2 + 3 - 4 + 5)'],
    [1, 'HD1', 'Đã thanh toán', serial('2026-10-26', 20, 0), 'BO-TEST', 'Bò test (100g)', 3, 150000, 165000],
    [2, 'HD1', 'Đã thanh toán', serial('2026-10-26', 20, 0), 'NK-X', 'Món lạ', 1, 15000, 165000],
    [3, 'HD2', 'Đã thanh toán', serial('2026-10-27', 1, 30), 'BO-TEST', 'Bò test (100g)', 2, 100000, 100000], // 1:30 sáng → ngày 26
    [4, 'HD3', 'Đã hủy', serial('2026-10-26', 21, 0), 'BO-TEST', 'Bò test (100g)', 9, 450000, 450000]];
  const buf = makeXlsx([{ name: 'Sheet1', rows }]);
  assert.equal(readXlsx(buf)[3][Object.keys(readXlsx(buf)[3])[5]], 'Tên mặt hàng, combo');
  const data = buf.toString('base64');
  const pv = await O('POST', '/api/sapo/preview', { data });
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.deepEqual(pv.data.dates.map((d) => [d.date, d.qty, d.invoices]), [['2026-10-26', 6, 2]]);
  const bo = pv.data.items.find((x) => x.code === 'BO-TEST');
  assert.equal(bo.menu_item_id, item); assert.equal(bo.qty, 5);
  assert.equal(pv.data.items.find((x) => x.code === 'NK-X').menu_item_id, null);
  const im = await O('POST', '/api/sapo/import', { data, dates: ['2026-10-26'], map: { 'NK-X': 0 } });
  assert.equal(im.status, 200, JSON.stringify(im.data));
  const left = () => db.prepare('SELECT SUM(qty) AS q FROM stock_lots WHERE ingredient_id = ?').get(ing).q;
  assert.equal(left(), 4500); // 5 phần × 100 g
  assert.equal(db.prepare("SELECT menu_item_id FROM sapo_map WHERE key = 'NK-X'").get().menu_item_id, 0);
  await O('POST', '/api/sapo/import', { data, dates: ['2026-10-26'] });
  assert.equal(left(), 4500, 'không trừ 2 lần');
  assert.equal((await O('POST', '/api/sapo/undo', { date: '2026-10-26' })).status, 200);
  assert.equal(left(), 5000);
  // File hoá đơn (không có cột món) → báo rõ
  const inv = makeXlsx([{ name: 'S', rows: [['Stt', 'Mã hóa đơn', 'Tổng tiền hàng']] }]).toString('base64');
  const bad = await O('POST', '/api/sapo/preview', { data: inv });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /MẶT HÀNG/);
});

test('Đọc bill: cộng dòng gấp nhiều lần tổng bill (thừa 3 số 0) → tự chia lại nếu khớp tổng', async () => {
  const { readBill } = await import('../server/lib/bill-reader.js');
  const out0 = { supplier_name: 'Tạp hoá Hiền', signer_name: '', total: 1_919_000, note: '', lines: [
    { ingredient_id: null, name: 'Đường cát', unit: 'kg', qty: 10, price: 24_000_000, amount: 0 },
    { ingredient_id: null, name: 'Muối', unit: 'kg', qty: 1000, price: 1_679_000, amount: 0 }] };
  const fake = async () => ({ status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out0) }] }) });
  const img = 'data:image/jpeg;base64,' + Buffer.alloc(800, 7).toString('base64');
  const out = await readBill([img], [], { fetchImpl: fake, apiKey: 'k' });
  assert.deepEqual(out.lines.map((l) => [l.qty, l.price]), [[10, 24_000], [1000, 1_679]]);
  assert.match(out.note, /chia lại/);
});

test('Hao hụt: kiểm kho TRƯỚC khi úp Sapo không trừ 2 lần; báo cáo hụt % so định mức 2%', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('single_store', '1')").run();
  const store = db.prepare("SELECT id FROM stores WHERE kind = 'main' LIMIT 1").get().id;
  const ing = Number(db.prepare("INSERT INTO ingredients (name, unit) VALUES ('Bò test', 'g')").run().lastInsertRowid);
  db.prepare('INSERT INTO stock_lots (store_id, ingredient_id, qty, received_at) VALUES (?, ?, 5000, 0)').run(store, ing);
  const item = Number(db.prepare("INSERT INTO menu_items (name, price) VALUES ('Steak test', 99000)").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO ingredients (name, unit) VALUES ('Sốt test', 'g')").run().lastInsertRowid);
  db.prepare('INSERT INTO menu_recipes (item_id, ingredient_id, qty) VALUES (?, ?, 100), (?, ?, 10)').run(item, ing, item, other);
  const today = app.ctx.today();
  // Bán 10 phần (1000 g) hôm nay, kiểm kho tối còn 3950 g (hụt 50 g = 5%) TRƯỚC khi úp Sapo
  assert.equal((await O('POST', '/api/stock/count', { store_id: store, lines: [{ ingredient_id: ing, actual: 3950 }] })).status, 200);
  const [y, m, d] = today.split('-');
  const serial = (Date.parse(`${today}T00:00:00Z`) / 86_400_000) + 25569 + 20 / 24;
  const rows = [['DOANH THU THEO DANH SÁCH MẶT HÀNG'], ['Stt', 'Mã hóa đơn', 'Trạng thái đơn hàng', 'Thời gian thanh toán', 'Mã mặt hàng', 'Tên mặt hàng, combo', 'Số lượng', 'Tiền hàng'],
    [1, 'H1', 'Đã thanh toán', serial, 'ST', 'Steak test', 10, 990000]];
  const data = makeXlsx([{ name: 'S', rows }]).toString('base64');
  assert.equal((await O('POST', '/api/sapo/import', { data, dates: [today] })).status, 200);
  const left = db.prepare('SELECT SUM(qty) AS q FROM stock_lots WHERE ingredient_id = ?').get(ing).q;
  assert.equal(left, 3950, 'tồn giữ đúng số đếm, không trừ thêm');
  const rep = (await O('GET', `/api/stock/loss?from=${today}&to=${today}`)).data;
  const r = rep.rows.find((x) => x.ingredient_id === ing);
  assert.equal(r.kind, 'material'); assert.equal(r.std, 1000); assert.equal(r.loss, 50); assert.equal(r.pct, 5); assert.equal(r.limit, 2); assert.equal(r.over, true);
  void y; void m; void d;
});
