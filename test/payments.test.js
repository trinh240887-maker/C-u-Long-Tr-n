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

test('thanh toán: CK đóng bill ngay, tiền mặt thối, kết hợp, nhắc món chưa ra, hoàn tiền mặt có quản lý duyệt, đối soát và chốt ngày', async (t) => {
  let now = at('2026-10-24', '18:00');
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
  await o('POST', '/api/staff', { name: 'Quân', role: 'manager', team_id: await team('Phục vụ'), pin: '730194' });
  const H = mk(); await H('POST', '/api/login', { pin: '4821' });
  const N = mk(); await N('POST', '/api/login', { pin: '5932' });
  const menu = (await H('GET', '/api/menu')).data;
  const M = (n) => menu.items.find((i) => i.name === n);
  const order = async (table, list) => {
    const s = (await H('POST', '/api/pos/sessions', { tables: [table] })).data.id;
    for (const [n, qty] of list) await H('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M(n).id, qty, option_ids: M(n).options.length ? [M(n).options[0].id] : [] });
    await H('POST', `/api/pos/sessions/${s}/send`);
    return s;
  };

  // 1. Chuyển khoản: QR có đúng số tiền + nội dung CLT<số bill>
  const A = await order(10, [['Combo 2', 2], ['Trà đào', 2]]);
  let b = (await H('GET', `/api/pos/sessions/${A}/bill`)).data;
  assert.equal(b.total, 2 * 79000 + 2 * 25000);
  const f = parseTLV(b.qr);
  assert.equal(f.find((x) => x.id === '54').value, String(b.total));
  assert.match(f.find((x) => x.id === '62').value, new RegExp(`CLT${b.bill_no}$`));
  assert.equal(readStatic(b.qr).valid, true);
  // Món chưa bấm "Đã ra" → nhắc trước khi đóng
  let r = await H('POST', `/api/pos/sessions/${A}/pay`, { method: 'transfer' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /chưa bấm "Đã ra"/);
  r = await H('POST', `/api/pos/sessions/${A}/pay`, { method: 'transfer', confirm_unserved: true, print: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Bàn trống ngay, nhân viên mở bàn mới được
  assert.equal((await H('POST', '/api/pos/sessions', { tables: [10] })).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM print_docs WHERE title LIKE 'Bill %'").get());

  // 2. Tiền mặt: khách đưa 500k, thối đúng; đưa thiếu bị chặn
  const B = await order(11, [['Combo 3', 1], ['Coca', 1]]);
  for (const i of (await H('GET', `/api/pos/sessions/${B}`)).data.items) await H('POST', `/api/pos/items/${i.id}/served`);
  b = (await H('GET', `/api/pos/sessions/${B}/bill`)).data;
  assert.equal((await H('POST', `/api/pos/sessions/${B}/pay`, { method: 'cash', cash_given: 1000 })).status, 400);
  r = await H('POST', `/api/pos/sessions/${B}/pay`, { method: 'cash', cash_given: '500.000' });
  assert.equal(r.data.change, 500000 - b.total);

  // 3. Kết hợp: 100k tiền mặt, còn lại CK
  const C = await order(12, [['Set 2 Mala Tứ Xuyên', 1]]);
  r = await H('POST', `/api/pos/sessions/${C}/pay`, { method: 'mixed', cash_amount: 100000, confirm_unserved: true });
  assert.equal(r.status, 200);
  b = (await H('GET', `/api/pos/sessions/${C}/bill`)).data;
  assert.equal(b.transfer_amount, b.total - 100000);
  assert.equal(parseTLV(b.qr).find((x) => x.id === '54').value, String(b.total - 100000));

  // 4. Khách CK xong báo thiếu 1 Combo 2 → hoàn tiền mặt. Phục vụ tự làm bị chặn, sai PIN bị chặn, quản lý nhập PIN được
  now += 5 * 60_000;
  const items = (await H('GET', `/api/pos/sessions/${A}`)).data.items;
  const c2 = items.find((i) => i.name === 'Combo 2');
  assert.equal((await H('POST', `/api/pos/sessions/${A}/refund`, { items: [{ id: c2.id, qty: 1 }], reason: 'Chưa ra món' })).status, 403);
  assert.equal((await H('POST', `/api/pos/sessions/${A}/refund`, { items: [{ id: c2.id, qty: 1 }], reason: 'Chưa ra món', approver_pin: '5932' })).status, 403);
  r = await H('POST', `/api/pos/sessions/${A}/refund`, { items: [{ id: c2.id, qty: 1 }], reason: 'Chưa ra món', approver_pin: '730194' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.amount, 79000);
  // Bếp nhận phiếu HUỶ (món chưa ra), in phiếu hoàn tiền, chủ quán nhận báo
  const k = db.prepare("SELECT * FROM kitchen_tickets WHERE kind = 'cancel' ORDER BY id DESC").get();
  assert.ok(k && JSON.parse(k.lines)[0].qty === 1);
  assert.ok(db.prepare("SELECT 1 FROM print_docs WHERE title LIKE 'Hoàn tiền%'").get());
  assert.ok(db.prepare("SELECT 1 FROM notifications n JOIN staff s ON s.id = n.staff_id WHERE s.role = 'owner' AND n.title LIKE 'Hoàn tiền 79.000đ%'").get());
  // Không hoàn quá số còn lại
  assert.equal((await H('POST', `/api/pos/sessions/${A}/refund`, { items: [{ id: c2.id, qty: 2 }], reason: 'x', approver_pin: '730194' })).status, 400);
  // Bill đã đóng không đổi dù sửa khuyến mãi / giá sau đó
  await o('PATCH', `/api/menu/items/${M('Combo 2').id}`, { price: 99000 });
  assert.equal((await H('GET', `/api/pos/sessions/${A}/bill`)).data.total, 2 * 79000 + 2 * 25000);

  // 5. Cuối ngày: phục vụ không xem được; thu ngân xem tổng, đối soát
  assert.equal((await H('GET', '/api/payments?date=2026-10-24')).status, 403);
  let d = (await N('GET', '/api/payments?date=2026-10-24')).data;
  assert.equal(d.summary.bills, 3);
  assert.equal(d.summary.refund_cash, 79000);
  const bC = (await H('GET', `/api/pos/sessions/${C}/bill`)).data;
  const bB = (await H('GET', `/api/pos/sessions/${B}/bill`)).data;
  assert.equal(d.summary.cash_in, bB.total + 100000);
  assert.equal(d.summary.cash_expected, bB.total + 100000 - 79000);
  assert.equal(d.summary.transfer_pending, 2 * 79000 + 2 * 25000 + bC.total - 100000);
  // Chưa đối soát hết thì chưa chốt được
  assert.equal((await N('POST', '/api/payments/close-day', { date: '2026-10-24' })).status, 400);
  // Bill C không thấy tiền trong sao kê → báo chủ quán tên người đóng bill
  await N('POST', '/api/payments/reconcile', { ids: [C], status: 'missing', note: 'Không thấy trong sao kê' });
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE title LIKE 'Chưa thấy tiền CK bill%' AND body LIKE '%Hậu%'").get());
  await N('POST', '/api/payments/reconcile', { ids: [A], status: 'confirmed' });
  r = await N('POST', '/api/payments/close-day', { date: '2026-10-24' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  d = (await N('GET', '/api/payments?date=2026-10-24')).data;
  assert.equal(d.closing.totals.net, d.summary.gross - 79000);
  assert.ok(db.prepare("SELECT 1 FROM notifications n JOIN staff s ON s.id = n.staff_id WHERE s.role = 'owner' AND n.title LIKE 'Đã chốt doanh thu%'").get());
  // Đã chốt thì không sửa đối soát được nữa
  assert.equal((await N('POST', '/api/payments/reconcile', { ids: [C], status: 'confirmed' })).status, 400);
});
