import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';
import { readStatic, parseTLV } from '../server/lib/vietqr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
const DAY = '2026-10-24';

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
    return async (method, url, body, headers = {}) => {
      const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json', ...headers }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
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
  await o('POST', '/api/staff', { name: 'Quân', role: 'manager', team_id: await team('Phục vụ'), pin: '730194' });
  const H = mk(); await H('POST', '/api/login', { pin: '4821' });
  const N = mk(); await N('POST', '/api/login', { pin: '5932' });
  const menu = (await H('GET', '/api/menu')).data;
  const M = (n) => menu.items.find((i) => i.name === n);
  const order = async (table, list) => {
    const s = (await H('POST', '/api/pos/sessions', { tables: [table] })).data.id;
    for (const [n, qty] of list) await H('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M(n).id, qty, option_ids: M(n).options.length ? [M(n).options[0].id] : [] });
    await H('POST', `/api/pos/sessions/${s}/send`);
    for (const i of (await H('GET', `/api/pos/sessions/${s}`)).data.items) await H('POST', `/api/pos/items/${i.id}/served`);
    return s;
  };
  const key = (await o('GET', '/api/bank/settings')).data.api_key;
  let n = 0;
  const sepay = (amount, content, extra = {}) => fetch(`${base}/api/bank/sepay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Apikey ${key}` },
    body: JSON.stringify({ id: extra.id ?? 9000 + (++n), gateway: 'Techcombank', transactionDate: '2026-10-24 18:30:00', accountNumber: '19031234567', code: null, content, transferType: extra.out ? 'out' : 'in', transferAmount: amount, referenceCode: `FT${n}` }) })
    .then(async (r) => ({ status: r.status, data: await r.json() }));
  return { db, app, o, H, N, M, order, sepay, key, base, setNow: (ms) => { now = ms; }, getNow: () => now };
}
const noti = (db, like) => db.prepare('SELECT n.title, n.body, s.name FROM notifications n JOIN staff s ON s.id = n.staff_id WHERE n.title LIKE ? ORDER BY n.id DESC').all(like);

test('CK tự động: ngân hàng báo tiền về → bill tự đóng, bàn trống; CK thiếu thì chưa đóng; CK dư = tip; chống trùng; sai khoá bị chặn', async (t) => {
  const { db, o, H, order, sepay, base } = await setup(t);
  const A = await order(10, [['Combo 2', 2], ['Trà đào', 1]]);
  const b = (await H('GET', `/api/pos/sessions/${A}/bill`)).data;
  assert.equal(b.total, 2 * 79000 + 25000);
  assert.equal(parseTLV(b.qr).find((x) => x.id === '54').value, String(b.total));
  assert.equal(readStatic(b.qr).valid, true);

  // Sai khoá → 401; chưa bật → bỏ qua
  assert.equal((await fetch(`${base}/api/bank/sepay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Apikey sai' }, body: '{}' })).status, 401);
  assert.equal((await sepay(b.total, `CLT${b.bill_no}`)).data.skipped !== undefined, true);
  await o('POST', '/api/bank/settings', { enabled: true });

  // Khách CK thiếu → bill chưa đóng, QR còn lại đúng phần thiếu
  await sepay(100000, `MBVCB.123.CLT${b.bill_no} chuyen tien`, { id: 1 });
  let bb = (await H('GET', `/api/pos/sessions/${A}/bill`)).data;
  assert.equal(bb.status, 'open');
  assert.equal(bb.bank_received, 100000);
  assert.equal(parseTLV(bb.qr).find((x) => x.id === '54').value, String(b.total - 100000));
  assert.ok(noti(db, 'Bàn % mới nhận 100.000đ, còn thiếu%').some((x) => x.name === 'Hậu'));
  // SePay gửi lại cùng id → không cộng 2 lần
  assert.equal((await sepay(100000, `CLT${b.bill_no}`, { id: 1 })).data.duplicate, true);
  // Phần còn lại + dư 20.000 → tự đóng, dư thành tip
  await sepay(b.total - 100000 + 20000, `clt ${b.bill_no}`, { id: 2 });
  bb = (await H('GET', `/api/pos/sessions/${A}/bill`)).data;
  assert.equal(bb.status, 'closed');
  assert.equal(bb.closed_auto, true);
  assert.equal(bb.tip_transfer, 20000);
  assert.equal(bb.reconcile_status, 'matched');
  assert.equal((await H('POST', '/api/pos/sessions', { tables: [10] })).status, 200, 'bàn 10 phải trống lại');
  assert.ok(noti(db, 'Bàn % đã nhận CK%').length);

  // Phục vụ bấm "chờ tiền về" trước, tiền về sau → tự khớp
  const B = await order(11, [['Combo 1', 1]]);
  const b2 = (await H('GET', `/api/pos/sessions/${B}/bill`)).data;
  await H('POST', `/api/pos/sessions/${B}/pay`, { method: 'transfer' });
  assert.equal((await H('GET', `/api/pos/sessions/${B}/bill`)).data.reconcile_status, 'pending');
  await sepay(b2.total, `CLT${b2.bill_no}`);
  assert.equal((await H('GET', `/api/pos/sessions/${B}/bill`)).data.reconcile_status, 'matched');

  // Khách tự gõ số TK, mất mã → "tiền chưa khớp", thu ngân ghép tay
  const C = await order(12, [['Steak Âu', 1]]);
  const b3 = (await H('GET', `/api/pos/sessions/${C}/bill`)).data;
  const r = await sepay(b3.total, 'NGUYEN VAN A chuyen khoan');
  assert.equal(db.prepare('SELECT status FROM bank_txns WHERE id = ?').get(r.data.id).status, 'unmatched');
  const N2 = (await setupCashier(base, db));
  assert.equal((await N2('POST', `/api/bank/txns/${r.data.id}/assign`, { bill_no: b3.bill_no })).status, 200);
  assert.equal((await H('GET', `/api/pos/sessions/${C}/bill`)).data.status, 'closed');

  // Tiền ra (trả nhà cung cấp) → lưu chờ gán công nợ, không đụng bill
  const out = await sepay(2500000, 'Thanh toan NCC bo tuoi', { out: true });
  assert.equal(db.prepare('SELECT status, direction FROM bank_txns WHERE id = ?').get(out.data.id).status, 'unassigned');
});

async function setupCashier(base) {
  let cookie = '';
  const c = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  await c('POST', '/api/login', { pin: '5932' });
  return c;
}

test('tiền mặt: phục vụ giữ tiền → giao thu ngân (lệch ghi tên), tip không lấy thối, két đầu/cuối ngày, hoàn tiền, chốt ngày + báo bất thường', async (t) => {
  const { db, app, o, H, N, M, order, sepay, setNow, getNow } = await setup(t);
  await o('POST', '/api/bank/settings', { enabled: true });
  // Bill tiền mặt: khách đưa 300k, không lấy thối → tip
  const A = await order(20, [['Combo 3', 2], ['Coca', 1]]);
  const tA = (await H('GET', `/api/pos/sessions/${A}/bill`)).data.total; // 193.000
  assert.equal((await H('POST', `/api/pos/sessions/${A}/pay`, { method: 'cash', cash_given: 100000 })).status, 400);
  let r = await H('POST', `/api/pos/sessions/${A}/pay`, { method: 'cash', cash_given: 200000, keep_change: true });
  assert.equal(r.data.tip, 200000 - tA);
  assert.equal(r.data.hand_over, 200000);
  // Phục vụ thấy mình đang giữ tiền; không giao thì không chấm ra ca được
  assert.equal((await H('GET', '/api/payments/my-cash')).data.amount, 200000);
  assert.equal(app.ctx.cashHeldBy((await H('GET', '/api/me')).data.id), 200000);
  // Bill 2: tiền mặt thối bình thường
  const B = await order(21, [['Combo 1', 1]]);
  const tB = (await H('GET', `/api/pos/sessions/${B}/bill`)).data.total;
  r = await H('POST', `/api/pos/sessions/${B}/pay`, { method: 'cash', cash_given: 100000 });
  assert.equal(r.data.change, 100000 - tB);
  // Thu ngân nhận bill A đủ; bill B đếm thiếu 10k → báo chủ quán tên Hậu
  let d = (await N('GET', `/api/payments?date=${DAY}`)).data;
  assert.equal(d.summary.cash_held, 200000 + tB);
  assert.equal((await N('POST', '/api/payments/handover', { ids: [A] })).data.diff, 0);
  r = await N('POST', '/api/payments/handover', { ids: [B], counted: tB - 10000, note: 'thiếu 1 tờ 10k' });
  assert.equal(r.data.diff, -10000);
  assert.ok(noti(db, 'Giao tiền THIẾU 10.000đ: Hậu%').some((x) => x.name === 'Chủ quán'));
  assert.equal((await N('POST', '/api/payments/handover', { ids: [B] })).status, 400, 'không nhận 2 lần');
  assert.equal((await H('GET', '/api/payments/my-cash')).data.amount, 0);

  // Bill CK chưa thấy tiền + khách báo thiếu món → hoàn tiền mặt (quản lý duyệt)
  const C = await order(22, [['Combo 2', 2]]);
  await H('POST', `/api/pos/sessions/${C}/pay`, { method: 'transfer' });
  const c2 = (await H('GET', `/api/pos/sessions/${C}`)).data.items[0];
  assert.equal((await H('POST', `/api/pos/sessions/${C}/refund`, { items: [{ id: c2.id, qty: 1 }], reason: 'Món lỗi' })).status, 403);
  r = await H('POST', `/api/pos/sessions/${C}/refund`, { items: [{ id: c2.id, qty: 1 }], reason: 'Món lỗi', approver_pin: '730194' });
  assert.equal(r.data.amount, 79000);
  // 30 phút chưa thấy tiền về → báo quản lý
  setNow(getNow() + 31 * 60_000);
  assert.equal(app.ctx.payTick(), 1);
  assert.equal(app.ctx.payTick(), 0);
  assert.ok(noti(db, 'Bill %: 30′ chưa thấy tiền CK%').length);
  // Bill tiền mặt mà có CK về → thu ngân / quản lý xem
  const bA = (await H('GET', `/api/pos/sessions/${A}/bill`)).data;
  const rv = await sepay(50000, `CLT${bA.bill_no}`);
  assert.equal(db.prepare('SELECT status FROM bank_txns WHERE id = ?').get(rv.data.id).status, 'review');

  // Chốt ngày: thiếu két đầu ngày, còn CK chưa xác nhận, còn tiền chưa khớp → chặn
  const close = () => N('POST', '/api/payments/close-day', { date: DAY });
  assert.match((await close()).data.error, /chưa xác nhận|chưa khớp|két/);
  await N('POST', '/api/payments/reconcile', { ids: [C], status: 'missing', note: 'Không có trong sao kê' });
  assert.equal((await N('POST', `/api/bank/txns/${rv.data.id}/resolve`, { action: 'tip' })).status, 403, 'thu ngân không tự quyết khoản lạ');
  assert.equal((await o('POST', `/api/bank/txns/${rv.data.id}/resolve`, { action: 'tip' })).status, 200);
  assert.match((await close()).data.error, /két đầu ngày/);
  await N('POST', '/api/payments/drawer', { date: DAY, opening: '2.000.000' });
  assert.match((await close()).data.error, /đếm trong két/);
  d = (await N('GET', `/api/payments?date=${DAY}`)).data;
  // Két phải có = đầu ngày + tiền nhận từ phục vụ − hoàn
  assert.equal(d.summary.drawer_expected, 2000000 + 200000 + tB - 10000 - 79000);
  await N('POST', '/api/payments/drawer', { date: DAY, counted: d.summary.drawer_expected - 5000 });
  r = await close();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  d = (await N('GET', `/api/payments?date=${DAY}`)).data;
  assert.equal(d.summary.drawer_diff, -5000);
  assert.equal(d.summary.tip_cash, 200000 - tA);
  assert.equal(d.summary.tip_transfer, 50000);
  assert.equal(d.summary.net, tA + tB + 158000 - 79000);
  const texts = d.anomalies.map((a) => a.text).join('\n');
  for (const k of ['Giao tiền thiếu 10.000đ: Hậu', 'Két thiếu 5.000đ', 'Hoàn tiền mặt: 1 lần', 'CK chưa thấy tiền 158.000đ']) assert.ok(texts.includes(k), `${k}\n${texts}`);
  const last = noti(db, 'Đã chốt doanh thu%')[0];
  assert.match(last.body, /Tip quỹ chung/);
  assert.match(last.body, /Bất thường/);
  // Đã chốt: không nhận tiền / sửa két nữa
  assert.equal((await N('POST', '/api/payments/drawer', { date: DAY, counted: 1 })).status, 400);
  void M;
});
