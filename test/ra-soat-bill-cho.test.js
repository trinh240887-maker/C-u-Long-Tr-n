import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

// Rà soát 28/10: bill chờ nhận hàng + quy đổi + sửa bill
const here = path.dirname(fileURLToPath(import.meta.url));
const IMG = `data:image/jpeg;base64,${Buffer.alloc(3000, 9).toString('base64')}`;

async function setup(t) {
  const clock = makeClock({ offset: '+07:00' });
  const st = { now: clock.toEpoch('2026-10-28', 10 * 60) };
  const db = openDb(':memory:', { now: st.now });
  const app = createApp({ db, now: () => st.now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rs-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }; };
  const login = async (pin, np) => { const c = mk(); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
  const o = await login(DEFAULT_OWNER_PIN, '582914');
  const teams = (await o('GET', '/api/teams')).data;
  await o('POST', '/api/staff', { name: 'Tài', role: 'staff', team_id: teams.find((x) => x.name === 'Lẩu').id, pin: '736251' });
  const tai = await login('736251', '918271');
  const lau = (await o('GET', '/api/stock/meta')).data.stores.find((s) => s.name === 'Kho Lẩu');
  const ing = async (name, price = 100000) => (await o('POST', '/api/stock/ingredients', { name, unit: 'g', freshness: 'fresh', home_store_id: lau.id, purchase_unit: 'kg', purchase_factor: 1000, price })).data.id;
  const qty = (id) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(id).q;
  const pre = (lines, extra = {}) => o('POST', '/api/purchases', { pre_bill: true, store_id: lau.id, supplier_name: 'Sạp A', signer_name: 'Chủ', photos: [IMG], lines, ...extra });
  return { st, db, o, tai, teams, login, lau, ing, qty, pre };
}

test('bill chờ: quy đổi không đụng kho; sửa bill giữ id dòng + dấu chưa quy đổi; nhận hàng không gửi số vẫn được; giữ ngày áp bill', async (t) => {
  const { st, db, o, tai, ing, qty, pre } = await setup(t);
  const bo = await ing('Bò bắp', 260000);
  const pheo = await ing('Phèo non', 150000);
  const b = (await pre([{ ingredient_id: bo, qty: 10, price: 260000 }, { ingredient_id: pheo, qty: 3, price: 300000, unconv: true, unit: 'mẹt' }], { paid_method: 'transfer' })).data;
  assert.equal(b.status, 'waiting');
  assert.ok(b.flags.some((f) => /Phèo non: bill ghi 3 mẹt, chưa quy đổi/.test(f)));
  // Sửa bill chờ (chỉ đổi số bò): id dòng giữ nguyên, dòng phèo vẫn "chưa quy đổi"
  const e1 = await o('PATCH', `/api/purchases/${b.id}`, { total: b.total + 260000, lines: b.lines.map((l) => ({ id: l.id, ingredient_id: l.ingredient_id, qty: l.ingredient_id === bo ? 11 : l.qty, price: l.price })) });
  assert.equal(e1.status, 200);
  assert.deepEqual(e1.data.lines.map((l) => l.id), b.lines.map((l) => l.id));
  assert.equal(e1.data.lines.find((l) => l.ingredient_id === pheo).bill_unit, 'mẹt');
  assert.ok(e1.data.flags.some((f) => /chưa quy đổi/.test(f)));
  // 2 dòng cùng nguyên liệu → app tự gộp 1 dòng: cộng số lượng + thành tiền, đơn giá trung bình (chủ quán 29/10)
  const dup = await pre([{ ingredient_id: bo, qty: 5, price: 1000 }, { ingredient_id: bo, qty: 6, price: 2000 }]);
  assert.equal(dup.status, 200, JSON.stringify(dup.data));
  const dl = dup.data.lines.filter((l) => l.ingredient_id === bo);
  assert.equal(dl.length, 1);
  assert.deepEqual([dl[0].qty, dl[0].amount, dl[0].price], [11, 17000, 1545]);
  await o('POST', `/api/purchases/${dup.data.id}/void`, { reason: 'test' });
  // Quy đổi trên bill chờ: chỉ sửa dòng, kho chưa cộng, giá nguyên liệu chưa đổi
  const un = (await o('GET', '/api/purchases/unconverted')).data.find((x) => x.bill_id === b.id);
  assert.equal((await o('POST', `/api/purchases/lines/${un.id}/convert`, { factor: 2 })).status, 200);
  assert.equal(qty(pheo), 0);
  assert.equal(db.prepare('SELECT price FROM ingredients WHERE id = ?').get(pheo).price, 150000);
  let L = (await tai('GET', '/api/purchases')).data.arriving.find((x) => x.id === b.id);
  assert.ok(!L.flags.some((f) => /chưa quy đổi/.test(f)));
  assert.deepEqual([L.lines.find((l) => l.ingredient_id === pheo).qty, L.lines.find((l) => l.ingredient_id === pheo).price], [6, 150000]);
  // Hôm sau hàng về: gửi số "undefined" / id cũ → coi như đủ số bill
  st.now += 24 * 3600e3;
  const r = await tai('POST', `/api/purchases/${b.id}/arrive`, { goods_photos: [IMG], lines: [{ id: L.lines[0].id, qty: 'undefined' }, { id: 999999, qty: '1' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'approved');
  assert.equal(qty(bo), 11000);
  assert.equal(qty(pheo), 6000);
  // Ngày bill giữ ngày áp bill (CK đã ghi ngày đó), ngày hàng về ghi riêng
  assert.equal(r.data.date, '2026-10-28');
  assert.equal(r.data.received_date, '2026-10-29');
});

test('nhận hàng: gộp dòng trùng nguyên liệu (bill cũ); giá tăng / nhận thừa → chờ thu ngân; sửa bill giữ cờ "Nhận thiếu"; huỷ bill chờ báo đúng', async (t) => {
  const { db, o, tai, ing, qty, pre } = await setup(t);
  const bo = await ing('Bò bắp', 100000);
  // Bill cũ lỡ có 2 dòng cùng nguyên liệu (trước khi chặn) → nhận hàng vẫn được, kho cộng tổng
  const b1 = (await pre([{ ingredient_id: bo, qty: 2, price: 100000 }])).data;
  db.prepare('INSERT INTO purchase_bill_lines (bill_id, ingredient_id, name, qty, unit, price, amount) VALUES (?, ?, ?, 3, ?, 100000, 300000)').run(b1.id, bo, 'Bò bắp', 'kg');
  db.prepare('UPDATE purchase_bills SET total = 500000 WHERE id = ?').run(b1.id);
  const r1 = await tai('POST', `/api/purchases/${b1.id}/arrive`, { goods_photos: [IMG] });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.status, 'approved');
  assert.equal(qty(bo), 5000);
  // Giá tăng so với giá lúc nhận → không tự duyệt
  const b2 = (await pre([{ ingredient_id: bo, qty: 1, price: 150000 }])).data;
  const r2 = (await tai('POST', `/api/purchases/${b2.id}/arrive`, { goods_photos: [IMG] })).data;
  assert.equal(r2.status, 'received');
  assert.ok(r2.flags.some((f) => /giá tăng 50%/.test(f)), JSON.stringify(r2.flags));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE title LIKE 'Nhận hàng cần xem lại%'").get());
  // Nhận thừa → chờ thu ngân
  const b3 = (await pre([{ ingredient_id: bo, qty: 1, price: 150000 }])).data;
  const r3 = (await tai('POST', `/api/purchases/${b3.id}/arrive`, { goods_photos: [IMG], lines: [{ id: b3.lines[0].id, qty: '2' }] })).data;
  assert.equal(r3.status, 'received');
  assert.ok(r3.flags.some((f) => /^Nhận thừa: Bò bắp/.test(f)));
  // Nhận thiếu rồi thu ngân sửa tổng → cờ "Nhận thiếu" vẫn còn
  const b4 = (await pre([{ ingredient_id: bo, qty: 4, price: 150000 }])).data;
  const r4 = (await tai('POST', `/api/purchases/${b4.id}/arrive`, { goods_photos: [IMG], lines: [{ id: b4.lines[0].id, qty: '3' }] })).data;
  assert.equal(r4.status, 'received');
  const e4 = (await o('PATCH', `/api/purchases/${b4.id}`, { total: 450000, lines: r4.lines.map((l) => ({ id: l.id, ingredient_id: l.ingredient_id, qty: l.qty, price: l.price })) })).data;
  assert.ok(e4.flags.some((f) => /^Nhận thiếu: Bò bắp/.test(f)), JSON.stringify(e4.flags));
  assert.deepEqual(e4.lines.map((l) => l.id), r4.lines.map((l) => l.id));
  // Huỷ bill chờ: báo "kho chưa cộng", không ghi "đã trừ lại khỏi kho"
  const b5 = (await pre([{ ingredient_id: bo, qty: 1, price: 100000 }])).data;
  await o('POST', `/api/purchases/${b5.id}/void`, { reason: 'NCC không giao' });
  const n = db.prepare("SELECT body FROM notifications WHERE title LIKE 'Huỷ bill nhập%' ORDER BY id DESC").get();
  assert.ok(!n || /kho chưa cộng/.test(n.body));
});

test('sửa bill đã nhận: dấu chưa quy đổi theo đúng dòng; quy đổi bill cũ không ghi đè giá mới', async (t) => {
  const { st, db, o, ing, lau } = await setup(t);
  const pheo = await ing('Phèo non', 150000);
  const r = (await o('POST', '/api/purchases', { store_id: lau.id, supplier_name: 'Sạp B', signer_name: 'A', photos: [IMG], goods_photos: [IMG],
    lines: [{ ingredient_id: pheo, qty: 3, price: 300000, unconv: true, unit: 'mẹt' }] })).data;
  // Bill mới hơn cùng nguyên liệu, giá 160.000/kg
  st.now += 3600e3;
  await o('POST', '/api/purchases', { store_id: lau.id, supplier_name: 'Sạp B', signer_name: 'A', photos: [IMG], goods_photos: [IMG], lines: [{ ingredient_id: pheo, qty: 1, price: 160000 }] });
  // Sửa SL dòng chưa quy đổi (cùng nguyên liệu) → vẫn giữ dấu, cờ theo số mới
  const e = (await o('PATCH', `/api/purchases/${r.id}`, { total: 1200000, lines: [{ id: r.lines[0].id, ingredient_id: pheo, qty: 4, price: 300000 }] })).data;
  assert.equal(e.lines[0].id, r.lines[0].id);
  assert.equal(e.lines[0].bill_unit, 'mẹt');
  assert.ok(e.flags.some((f) => /Phèo non: bill ghi 4 mẹt, chưa quy đổi/.test(f)), JSON.stringify(e.flags));
  assert.equal(e.flags.filter((f) => /chưa quy đổi/.test(f)).length, 1);
  // Quy đổi bill cũ: cờ bỏ đúng (dù SL đã sửa), giá nguyên liệu giữ giá bill mới
  assert.equal((await o('POST', `/api/purchases/lines/${r.lines[0].id}/convert`, { factor: 2 })).status, 200);
  assert.equal(db.prepare('SELECT price FROM ingredients WHERE id = ?').get(pheo).price, 160000);
  const b = (await o('GET', '/api/purchases')).data.bills.find((x) => x.id === r.id);
  assert.ok(!b.flags.some((f) => /chưa quy đổi/.test(f)));
});

test('người áp bill trước (không nhận hàng khu đó) vẫn thấy bill chờ của mình', async (t) => {
  const { db, o, teams, login, lau, ing } = await setup(t);
  const bo = await ing('Bò bắp');
  const s = (await o('POST', '/api/staff', { name: 'Lan', role: 'staff', team_id: teams.find((x) => x.name === 'Bar').id, pin: '736255' })).data;
  const lan = await login('736255', '918275');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('perm_user', ?)").run(JSON.stringify({ [s.id]: { 'mh.apbill': true } }));
  const b = await lan('POST', '/api/purchases', { pre_bill: true, store_id: lau.id, supplier_name: 'Sạp A', signer_name: 'Lan', photos: [IMG], lines: [{ ingredient_id: bo, qty: 1, price: 100000 }] });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal((await lan('POST', `/api/purchases/${b.data.id}/arrive`, { goods_photos: [IMG] })).status, 403); // không nhận hàng khu Lẩu
  assert.ok((await lan('GET', '/api/purchases')).data.arriving.some((x) => x.id === b.data.id));
});
