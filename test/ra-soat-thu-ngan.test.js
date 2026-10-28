// Rà soát 28/10: thu ngân, chốt ngày, trả kho khi tách / huỷ / hoàn, báo cáo KM bill
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
const DAY = '2026-10-24';
const NEXT = '2026-10-25';

async function setup(t) {
  let now = at(DAY, '18:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const team = (n) => o('GET', '/api/teams').then((r) => r.data.find((x) => x.name === n).id);
  await o('POST', '/api/staff', { name: 'Hậu', team_id: await team('Phục vụ'), pin: '4821' });
  await o('POST', '/api/staff', { name: 'Ngân', team_id: await team('Thu ngân'), pin: '5932' });
  await o('POST', '/api/staff', { name: 'Tùng', role: 'shift_lead', team_id: await team('Phục vụ'), pin: '6043' });
  const H = mk(); await H('POST', '/api/login', { pin: '4821' });
  const N = mk(); await N('POST', '/api/login', { pin: '5932' });
  const T = mk(); await T('POST', '/api/login', { pin: '6043' });
  const menu = (await H('GET', '/api/menu')).data;
  const M = (n) => menu.items.find((i) => i.name === n);
  const add = async (s, n, qty) => (await H('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M(n).id, qty, option_ids: M(n).options.length ? [M(n).options[0].id] : [] })).data;
  const order = async (table, list, { serve = true } = {}) => {
    const s = (await H('POST', '/api/pos/sessions', { tables: [table] })).data.id;
    for (const [n, qty] of list) await add(s, n, qty);
    await H('POST', `/api/pos/sessions/${s}/send`);
    if (serve) for (const i of (await H('GET', `/api/pos/sessions/${s}`)).data.items) await H('POST', `/api/pos/items/${i.id}/served`);
    return s;
  };
  const key = (await o('GET', '/api/bank/settings')).data.api_key;
  let n = 0;
  const sepay = (amount, content) => fetch(`${base}/api/bank/sepay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Apikey ${key}` },
    body: JSON.stringify({ id: 7000 + (++n), gateway: 'Techcombank', transactionDate: '2026-10-24 18:30:00', accountNumber: '19031234567', code: null, content, transferType: 'in', transferAmount: amount, referenceCode: `FT${n}` }) })
    .then(async (r) => ({ status: r.status, data: await r.json() }));
  const bill = async (s) => (await o('GET', `/api/pos/sessions/${s}/bill`)).data;
  return { db, app, o, H, N, T, M, add, order, sepay, bill, setNow: (ms) => { now = ms; }, getNow: () => now };
}
const noti = (db, like) => db.prepare('SELECT n.title, n.body FROM notifications n WHERE n.title LIKE ? ORDER BY n.id DESC').all(like);

test('chốt ngày: còn bàn đang mở thì chặn (chủ quán force được); tiền sau chốt (trả bill, hoàn, nhận tiền giữ) ghi sang ngày kế tiếp', async (t) => {
  const { db, o, N, order, bill } = await setup(t);
  const A = await order(10, [['Combo 2', 1]]);
  assert.equal((await N('POST', `/api/pos/sessions/${A}/pay`, { method: 'cash', cash_given: 100000 })).status, 200);
  const B = await order(11, [['Combo 1', 1]]);
  let r = await N('POST', '/api/payments/close-day', { date: DAY });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Còn 1 bàn đang mở/);
  // Chủ quán vẫn chốt (force) → qua bước kiểm bàn, dừng ở bước kế (két)
  r = await o('POST', '/api/payments/close-day', { date: DAY, force: true });
  assert.doesNotMatch(r.data.error, /bàn đang mở/);
  assert.match(r.data.error, /két/);
  // Giả lập ngày đã chốt lúc 23:45, bàn B trả 00:30 (vẫn ngày kinh doanh 24/10)
  db.prepare("INSERT INTO day_closings (date, totals, confirmed_at) VALUES (?, '{}', 0)").run(DAY);
  assert.equal((await N('POST', `/api/pos/sessions/${B}/pay`, { method: 'cash', cash_given: 200000 })).status, 200);
  assert.equal(db.prepare('SELECT closed_date FROM table_sessions WHERE id = ?').get(B).closed_date, NEXT);
  assert.ok(noti(db, `Bill % thanh toán % sau khi đã chốt ngày 24/10`).length);
  assert.equal((await N('GET', `/api/payments?date=${NEXT}`)).data.bills.length, 1);
  assert.equal((await N('GET', `/api/payments?date=${DAY}`)).data.bills.length, 1, 'sổ ngày đã chốt không đổi');
  // Hoàn tiền bill của ngày đã chốt → ghi ngày kế tiếp
  const it = (await o('GET', `/api/pos/sessions/${A}`)).data.items[0];
  assert.equal((await o('POST', `/api/pos/sessions/${A}/refund`, { items: [{ id: it.id, qty: 1 }], reason: 'Món lỗi' })).status, 200);
  assert.equal(db.prepare('SELECT date FROM refunds').get().date, NEXT);
  // Tiền phục vụ đang giữ không bị kẹt "Ngày này đã chốt"
  db.prepare("UPDATE table_sessions SET cash_status = 'held' WHERE id = ?").run(B);
  r = await N('POST', '/api/payments/handover', { ids: [B] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT date FROM cash_handovers').get().date, NEXT);
  assert.equal((await bill(B)).cash_status, 'received');
});

test('CK đã về một phần rồi trả tiền mặt: chỉ thu phần còn lại; CK đủ thì không thu tiền mặt; CK đủ nhưng còn món chưa gửi bếp thì không tự đóng', async (t) => {
  const { db, o, N, add, order, sepay, bill } = await setup(t);
  await o('POST', '/api/bank/settings', { enabled: true });
  const A = await order(20, [['Combo 2', 2]]);
  const b = await bill(A);
  await sepay(100000, `CLT${b.bill_no}`);
  const r = await N('POST', `/api/pos/sessions/${A}/pay`, { method: 'cash', cash_given: 100000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const x = await bill(A);
  assert.equal(x.pay_method, 'mixed');
  assert.equal(x.cash_amount, b.total - 100000);
  assert.equal(x.transfer_amount, 100000);
  assert.equal(x.reconcile_status, 'matched');
  assert.equal(r.data.change, 100000 - (b.total - 100000));
  // Phần tiền mặt (TM + CK) vượt phần còn lại → chặn
  const B = await order(21, [['Combo 2', 1]]);
  const bB = await bill(B);
  await sepay(50000, `CLT${bB.bill_no}`);
  assert.match((await N('POST', `/api/pos/sessions/${B}/pay`, { method: 'mixed', cash_amount: bB.total - 10000 })).data.error, /tối đa/);
  // CK về đủ → bill tự đóng; còn món chưa gửi bếp → không tự đóng, báo
  const C = await order(22, [['Combo 1', 1]]);
  await add(C, 'Coca', 1);
  const bC = await bill(C);
  await sepay(bC.total, `CLT${bC.bill_no}`);
  assert.equal((await bill(C)).status, 'open');
  assert.ok(noti(db, `Bàn % đã nhận đủ CK % còn 1 món chưa gửi bếp`).length);
  assert.equal((await N('POST', `/api/pos/sessions/${C}/pay`, { method: 'cash' })).status, 400, 'còn món chưa gửi');
  db.prepare("DELETE FROM order_items WHERE session_id = ? AND status = 'new'").run(C);
  const p = await N('POST', `/api/pos/sessions/${C}/pay`, { method: 'cash', cash_given: 50000 });
  assert.equal(p.status, 409);
  assert.match(p.data.error, /chọn Chuyển khoản/);
});

test('gộp bàn chuyển tiền CK đã về sang bàn đích; hoàn tiền trùng món không hoàn quá; trưởng ca ngoài tổ Thu ngân không tự xác nhận CK chưa về', async (t) => {
  const { db, o, N, T, order, sepay, bill } = await setup(t);
  await o('POST', '/api/bank/settings', { enabled: true });
  const A = await order(30, [['Combo 1', 1]]);
  const B = await order(31, [['Combo 2', 1]]);
  const bA = await bill(A);
  await sepay(30000, `CLT${bA.bill_no}`);
  assert.equal((await o('POST', `/api/pos/sessions/${B}/merge`, { from_session_id: A })).status, 200);
  assert.equal((await bill(B)).bank_received, 30000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bank_txns WHERE session_id = ?").get(A).n, 0);
  // Trả CK, chưa thấy tiền về: trưởng ca (không thuộc Thu ngân) không xác nhận được, thu ngân được
  assert.equal((await N('POST', `/api/pos/sessions/${B}/pay`, { method: 'transfer' })).status, 200);
  assert.equal((await T('POST', '/api/payments/reconcile', { ids: [B], status: 'confirmed' })).status, 403);
  assert.equal((await T('POST', '/api/payments/reconcile', { ids: [B], status: 'missing' })).status, 200);
  assert.equal((await N('POST', '/api/payments/reconcile', { ids: [B], status: 'confirmed' })).status, 200);
  // Hoàn tiền: cùng 1 món gửi 2 dòng → cộng dồn, không vượt số lượng
  const it = (await o('GET', `/api/pos/sessions/${B}`)).data.items.find((i) => i.qty === 1 && i.status !== 'cancelled');
  const r = await o('POST', `/api/pos/sessions/${B}/refund`, { items: [{ id: it.id, qty: 1 }, { id: it.id, qty: 1 }], reason: 'x' });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refunds').get().n, 0);
});

test('trả kho: tách 1 phần món rồi huỷ từng dòng trả đúng phần; huỷ cả bàn trong 2′ trả kho, quá 2′ không; hoàn món chưa ra trong 2′ trả kho', async (t) => {
  const { db, o, M, setNow, getNow } = await setup(t);
  const meta = (await o('GET', '/api/stock/meta')).data;
  const S = Object.fromEntries(meta.stores.map((s) => [s.name, s.id]));
  const bia = (await o('POST', '/api/stock/ingredients', { name: 'Heineken', unit: 'lon', home_store_id: S['Kho Bar'], purchase_unit: 'thùng', purchase_factor: 24, price: 480000, freshness: 'dry' })).data.id;
  const Hk = M('Heineken lùn');
  await o('PATCH', `/api/menu/items/${Hk.id}`, { recipe: [{ ingredient_id: bia, qty: 1 }] });
  await o('POST', '/api/stock/receive', { store_id: S['Kho Bar'], lines: [{ ingredient_id: bia, qty: 1 }] });
  const stock = () => Math.round(db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(bia).q * 1000) / 1000;
  const open = async (table, qty) => {
    const s = (await o('POST', '/api/pos/sessions', { tables: [table] })).data.id;
    await o('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: Hk.id, qty });
    await o('POST', `/api/pos/sessions/${s}/send`);
    return s;
  };
  assert.equal(stock(), 24);
  // Tách 1 trong 3 lon sang bàn trống
  const A = await open(40, 3);
  assert.equal(stock(), 21);
  const item = (await o('GET', `/api/pos/sessions/${A}`)).data.items[0];
  const sp = await o('POST', `/api/pos/sessions/${A}/split`, { table: 41, items: [{ id: item.id, qty: 1 }] });
  assert.equal(sp.status, 200, JSON.stringify(sp.data));
  const moved = (await o('GET', `/api/pos/sessions/${sp.data.session_id}`)).data.items[0];
  await o('POST', `/api/pos/items/${item.id}/cancel`, { reason: 'Khách đổi ý' });
  assert.equal(stock(), 23, 'huỷ dòng gốc (2 lon) chỉ trả 2');
  await o('POST', `/api/pos/items/${moved.id}/cancel`, { reason: 'Khách đổi ý' });
  assert.equal(stock(), 24, 'huỷ dòng tách (1 lon) trả 1');
  // Huỷ cả bàn trong 2′ → trả kho
  const B = await open(42, 2);
  assert.equal(stock(), 22);
  assert.equal((await o('POST', `/api/pos/sessions/${B}/cancel`, { reason: 'Khách về' })).status, 200);
  assert.equal(stock(), 24);
  // Quá 2′ → coi như đã làm
  const C = await open(43, 2);
  setNow(getNow() + 3 * 60_000);
  await o('POST', `/api/pos/sessions/${C}/cancel`, { reason: 'Khách về' });
  assert.equal(stock(), 22);
  // Hoàn tiền món chưa ra, trong 2′ → trả kho đúng phần hoàn (2 lần hoàn 1 lon)
  const D = await open(44, 3);
  assert.equal(stock(), 19);
  assert.equal((await o('POST', `/api/pos/sessions/${D}/pay`, { method: 'transfer', confirm_unserved: true })).status, 200);
  const di = (await o('GET', `/api/pos/sessions/${D}`)).data.items[0];
  assert.equal((await o('POST', `/api/pos/sessions/${D}/refund`, { items: [{ id: di.id, qty: 1 }], reason: 'Khách về sớm' })).status, 200);
  assert.equal(stock(), 20);
  assert.equal((await o('POST', `/api/pos/sessions/${D}/refund`, { items: [{ id: di.id, qty: 1 }], reason: 'Khách về sớm' })).status, 200);
  assert.equal(stock(), 21);
});

test('báo cáo: KM giảm bill có trong mục khuyến mãi; giá trị huỷ bàn tính theo ngày kinh doanh (mốc 5h)', async (t) => {
  const { o, N, H, order, setNow } = await setup(t);
  await o('POST', '/api/promotions', { name: 'Giảm bill 10%', type: 'bill_percent', value: 10, min_bill: 100000, start_date: DAY, end_date: DAY });
  const A = await order(50, [['Combo 2', 2]]);
  assert.equal((await N('POST', `/api/pos/sessions/${A}/pay`, { method: 'cash' })).status, 200);
  // Bàn huỷ lúc 01:00 sáng 25/10 = ngày kinh doanh 24/10
  const B = await order(51, [['Combo 1', 1]], { serve: false });
  setNow(at(NEXT, '01:00'));
  assert.equal((await o('POST', `/api/pos/sessions/${B}/cancel`, { reason: 'Khách bỏ về' })).status, 200);
  const r = (await o('GET', `/api/reports/sales?from=${DAY}&to=${DAY}`)).data;
  assert.ok(r.promos.some((p) => p.name === 'Giảm bill 10%' && p.amount > 0), JSON.stringify(r.promos));
  assert.ok(r.summary.lost_value > 0, 'huỷ lúc 1h sáng vào ngày 24/10');
  const r2 = (await o('GET', `/api/reports/sales?from=${NEXT}&to=${NEXT}`)).data;
  assert.equal(r2.summary.lost_value, 0);
  assert.ok(H);
});

test('màn Phiếu bếp: nhân viên xem được tình trạng cầu in rút gọn', async (t) => {
  const { H } = await setup(t);
  assert.equal((await H('GET', '/api/print/status')).status, 403);
  const r = await H('GET', '/api/print/online');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data), ['bridge_online']);
  assert.equal(r.data.bridge_online, false);
});
