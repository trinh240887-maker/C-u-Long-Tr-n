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

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const D = '2026-10-23';
const IMG = `data:image/jpeg;base64,${Buffer.alloc(3000, 9).toString('base64')}`;

test('hoá đơn mua: khu nhận + chụp bill + ký nhận → thu ngân (khác người) duyệt / trả lại → công nợ NCC → trả NCC (duyệt nếu lớn) → tạm ứng đi chợ → két trừ tiền chi', async (t) => {
  let now = clock.toEpoch(D, 9 * 60);
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pb-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => {
    let cookie;
    const c = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      return { status: res.status, type, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    return c;
  };
  const login = async (pin, np) => { const c = mk(); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
  const o = await login(DEFAULT_OWNER_PIN, '582914');
  const teams = (await o('GET', '/api/teams')).data;
  const tid = (n) => teams.find((x) => x.name === n).id;
  await o('POST', '/api/staff', { name: 'Tài', role: 'staff', team_id: tid('Lẩu'), pin: '736251' });
  await o('POST', '/api/staff', { name: 'Ngân', role: 'staff', team_id: tid('Thu ngân'), pin: '736252' });
  await o('POST', '/api/staff', { name: 'Mai', role: 'staff', team_id: tid('Bar'), pin: '736253' });
  const tai = await login('736251', '918271');
  const ngan = await login('736252', '918272');
  const mai = await login('736253', '918273');
  const meta = (await o('GET', '/api/stock/meta')).data;
  const lau = meta.stores.find((s) => s.name === 'Kho Lẩu');
  const bar = meta.stores.find((s) => s.name === 'Kho Bar') || meta.stores.find((s) => s.team_id === tid('Bar'));
  const ncc = (await o('POST', '/api/stock/suppliers', { name: 'Sạp thịt Kim Thanh Ngọc', phone: '0949336552' })).data.id;
  const bo = (await o('POST', '/api/stock/ingredients', { name: 'Bò bắp', unit: 'g', freshness: 'fresh', home_store_id: lau.id, purchase_unit: 'kg', purchase_factor: 1000, price: 260000, min_stock: 1000, shelf_days: 2 })).data.id;
  const gau = (await o('POST', '/api/stock/ingredients', { name: 'Gầu bò', unit: 'g', freshness: 'fresh', home_store_id: lau.id, purchase_unit: 'kg', purchase_factor: 1000, price: 240000, min_stock: 1000, shelf_days: 2 })).data.id;
  const stockOf = (ing, store) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ? AND store_id = ?').get(ing, store).q;
  const note = (re) => [...new Set(db.prepare('SELECT title FROM notifications ORDER BY id').all().map((x) => x.title))].filter((x) => re.test(x));

  // Khu Lẩu nhận hàng lẻ, ghi nợ: thiếu ảnh / thiếu tên ký → chặn; khu Bar không nhận hộ khu Lẩu
  const body = { store_id: lau.id, supplier_id: ncc, signer_name: 'Lê Thanh Phát', total: 4_000_000, lines: [{ ingredient_id: bo, qty: 10, price: 280000 }, { ingredient_id: gau, qty: 5, price: 240000 }] };
  assert.equal((await tai('POST', '/api/purchases', { ...body, photos: [] })).status, 400);
  assert.equal((await tai('POST', '/api/purchases', { ...body, signer_name: '', photos: [IMG] })).status, 400);
  assert.equal((await mai('POST', '/api/purchases', { ...body, photos: [IMG] })).status, 403);
  // Nhân viên khu không được trả tiền mặt tại chỗ
  assert.equal((await tai('POST', '/api/purchases', { ...body, photos: [IMG], paid_method: 'cash' })).status, 403);
  const r1 = await tai('POST', '/api/purchases', { ...body, photos: [IMG], goods_photos: [IMG, IMG] });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const b1 = r1.data;
  assert.equal(b1.status, 'received');
  assert.equal(b1.photos.length, 1);
  assert.equal(b1.goods_photos.length, 2); // ảnh hàng thực nhận lưu riêng với ảnh bill
  // Hàng vào kho ngay; cảnh báo: giá bò tăng 7.7% (dưới 10% → không báo), tổng bill khác cộng dòng (4.000.000 vs 4.000.000 = khớp)
  assert.equal(stockOf(bo, lau.id), 10_000);
  assert.equal(b1.lines_total, 10 * 280000 + 5 * 240000);
  assert.deepEqual(b1.flags, []);
  assert.equal(note(/^Hoá đơn mua chờ duyệt: Sạp thịt/).length, 1);
  // Chưa duyệt → chưa tính nợ, chưa được trả
  assert.equal((await ngan('GET', '/api/suppliers/debts')).data.suppliers.find((s) => s.id === ncc).debt, 0);
  assert.equal((await ngan('POST', `/api/suppliers/${ncc}/pay`, { amount: 1_000_000, method: 'cash' })).status, 400);
  // Người nhận không tự duyệt; nhân viên khu không duyệt được
  assert.equal((await tai('POST', `/api/purchases/${b1.id}/approve`)).status, 403);
  // Thu ngân trả lại (ảnh mờ) → khu sửa, gửi lại → duyệt
  assert.equal((await ngan('POST', `/api/purchases/${b1.id}/return`, { reason: '' })).status, 400);
  assert.equal((await ngan('POST', `/api/purchases/${b1.id}/return`, { reason: 'Ảnh mờ, chụp lại' })).data.status, 'returned');
  assert.equal(note(/bị trả lại$/).length, 1);
  const fixed = await tai('PATCH', `/api/purchases/${b1.id}`, { photos: [IMG], total: 4_000_000 });
  assert.equal(fixed.data.status, 'received');
  assert.equal(fixed.data.photos.length, 2);
  assert.equal((await ngan('POST', `/api/purchases/${b1.id}/approve`)).data.status, 'approved');
  let debts = (await ngan('GET', '/api/suppliers/debts')).data;
  assert.equal(debts.suppliers.find((s) => s.id === ncc).debt, 4_000_000);
  // Ảnh bill xem được
  const ph = await ngan('GET', `/api/purchases/photo/${fixed.data.photos[0]}`);
  assert.equal(ph.status, 200);

  // Bill 2: giá tăng bất thường + tổng bill khác cộng dòng → cảnh báo
  now += 3600_000;
  const b2 = (await tai('POST', '/api/purchases', { store_id: lau.id, supplier_id: ncc, signer_name: 'Phát', photos: [IMG], total: 2_000_000, lines: [{ ingredient_id: gau, qty: 5, price: 300000 }] })).data;
  assert.equal(b2.flags.length, 2, JSON.stringify(b2.flags));
  assert.match(b2.flags.join(' | '), /giá tăng 25%/);
  assert.match(b2.flags.join(' | '), /khác cộng các dòng/);
  await ngan('POST', `/api/purchases/${b2.id}/approve`);

  // Trả NCC: trả quá nợ bị chặn; ≤ 5 triệu thu ngân trả luôn; > 5 triệu chờ chủ duyệt
  assert.equal((await ngan('POST', `/api/suppliers/${ncc}/pay`, { amount: 7_000_000, method: 'cash' })).status, 400);
  const p1 = (await ngan('POST', `/api/suppliers/${ncc}/pay`, { amount: 500_000, method: 'cash', note: 'Trả bớt' })).data;
  assert.equal(p1.status, 'done');
  assert.equal(p1.debt, 5_500_000);
  const p2 = (await ngan('POST', `/api/suppliers/${ncc}/pay`, { amount: 5_500_000, method: 'transfer' })).data;
  assert.equal(p2.status, 'pending');
  assert.equal(note(/^Duyệt chi NCC: Sạp thịt/).length, 1);
  assert.equal((await ngan('POST', `/api/supplier-payments/${p2.id}/approve`)).status, 403);
  assert.equal((await o('POST', `/api/supplier-payments/${p2.id}/approve`)).status, 200);
  debts = (await ngan('GET', '/api/suppliers/debts')).data;
  assert.equal(debts.suppliers.find((s) => s.id === ncc).debt, 0);

  // Bảng công nợ tháng
  const st = (await ngan('GET', `/api/suppliers/${ncc}/statement?from=2026-10-01&to=2026-10-31`)).data;
  assert.equal(st.opening, 0);
  assert.equal(st.bought, 6_000_000);
  assert.equal(st.paid, 6_000_000);
  assert.equal(st.closing, 0);
  assert.equal(st.rows.length, 4);
  const xl = await ngan('GET', `/api/suppliers/${ncc}/statement.xlsx?from=2026-10-01&to=2026-10-31`);
  assert.equal(xl.status, 200);
  assert.match(xl.type, /spreadsheetml/);

  // Tạm ứng đi chợ: thu ngân ứng 1 triệu cho Tài → Tài mua rau (không có trong kho) 700k → hoàn ứng 250k (thiếu 50k) → báo chủ
  const adv = (await ngan('POST', '/api/advances', { staff_id: (await tai('GET', '/api/me')).data.id, amount: 1_000_000, note: 'Đi chợ rau' })).data.id;
  const b3 = (await tai('POST', '/api/purchases', { store_id: lau.id, supplier_name: 'Vựa rau Bé Thùy', signer_name: 'Tài', photos: [IMG], advance_id: adv, lines: [{ name: 'Cải thìa', qty: 25, unit: 'kg', price: 28000 }] })).data;
  assert.equal(b3.total, 700_000);
  assert.equal(b3.paid_method, 'advance');
  assert.equal((await tai('POST', `/api/advances/${adv}/settle`, { returned: 300_000 })).status, 403);
  const s1 = (await ngan('POST', `/api/advances/${adv}/settle`, { returned: 250_000 })).data;
  assert.equal(s1.diff, -50_000);
  assert.equal(note(/^Hoàn ứng THIẾU 50\.000đ: Tài/).length, 1);

  // Két cuối ngày trừ tiền chi: trả NCC TM 500k + tạm ứng 1tr − hoàn ứng 250k = 1.250.000
  await ngan('POST', '/api/payments/drawer', { opening: 2_000_000 });
  const day = (await ngan('GET', `/api/payments?date=${D}`)).data;
  assert.equal(day.summary.cash_out, 1_250_000);
  assert.equal(day.summary.drawer_expected, 2_000_000 - 1_250_000);

  // Tiền ra ngân hàng (SePay) gán vào NCC
  db.prepare("INSERT INTO bank_txns (provider, ext_id, direction, amount, content, date, received_at, status) VALUES ('sepay', 'o1', 'out', 300000, 'CK tra Kim Thanh Ngoc', ?, ?, 'unassigned')").run(D, now);
  const b4 = (await tai('POST', '/api/purchases', { store_id: lau.id, supplier_id: ncc, signer_name: 'Phát', photos: [IMG], total: 300_000, lines: [{ ingredient_id: bo, qty: 1, price: 300000 }] })).data;
  await ngan('POST', `/api/purchases/${b4.id}/approve`);
  const txn = (await ngan('GET', '/api/suppliers/debts')).data.out_txns[0];
  assert.equal((await ngan('POST', `/api/suppliers/${ncc}/pay`, { amount: 250_000, method: 'transfer', bank_txn_id: txn.id })).status, 400);
  assert.equal((await ngan('POST', `/api/suppliers/${ncc}/pay`, { amount: 300_000, method: 'transfer', bank_txn_id: txn.id })).data.status, 'done');
  assert.equal(db.prepare('SELECT status FROM bank_txns WHERE id = ?').get(txn.id).status, 'supplier');
  // Nơi bán ghi tay + ghi nợ → tự tạo NCC, vào công nợ (không bị sót)
  const b5 = (await tai('POST', '/api/purchases', { store_id: lau.id, supplier_name: 'Gas Đức Thắng Tài', signer_name: 'Tài', photos: [IMG], total: 3_720_000, lines: [{ name: 'Bò dầu khí (bình gas)', qty: 2, unit: 'bình', price: 1_860_000 }] })).data;
  await ngan('POST', `/api/purchases/${b5.id}/approve`);
  const gas = (await ngan('GET', '/api/suppliers/debts')).data.suppliers.find((x) => x.name === 'Gas Đức Thắng Tài');
  assert.equal(gas.debt, 3_720_000);
  // Lần sau ghi tên khác hoa/thường vẫn vào đúng NCC đó
  const b6 = (await tai('POST', '/api/purchases', { store_id: lau.id, supplier_name: 'gas đức thắng  tài', signer_name: 'Tài', photos: [IMG], total: 1_000_000 })).data;
  assert.equal(b6.supplier_id, gas.id);
  // Danh sách bill: thu ngân thấy hết, nhân viên khu chỉ thấy bill mình nhận
  assert.equal((await ngan('GET', '/api/purchases')).data.bills.length, 6);
  assert.equal((await mai('GET', '/api/purchases')).data.bills.length, 0);
  assert.equal(app.ctx.purchaseDay(D).bills.n, 6);
});
