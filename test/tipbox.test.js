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
const at = (hm, d = D) => clock.toEpoch(d, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));

test('thùng tip: tip CK + tip TM ra khỏi két, chốt ngày tự ghi sổ, đếm thùng, chia theo giờ công, phiếu chi; đối soát số dư tài khoản', async (t) => {
  let now = at('10:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tb-')), zaloTransport: { send: async () => {} } });
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
  const menu = (await o('GET', '/api/menu')).data;
  const coca = menu.items.find((x) => x.name === 'Coca');
  const bill = async (table, qty) => {
    const sid = (await o('POST', '/api/pos/sessions', { tables: [table], guests: 2 })).data.id;
    assert.equal((await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: coca.id, qty })).status, 200);
    await o('POST', `/api/pos/sessions/${sid}/send`);
    return { sid, total: coca.price * qty };
  };
  // Bill 1: khách CK + tip CK 20.000đ (không nối ngân hàng)
  const b1 = await bill(1, 4);
  const p1 = await o('POST', `/api/pos/sessions/${b1.sid}/pay`, { method: 'transfer', tip_transfer: '20.000', confirm_unserved: true });
  assert.equal(p1.status, 200, p1.data?.error);
  // Tip CK lớn bất thường → chặn
  const b2 = await bill(2, 1);
  assert.equal((await o('POST', `/api/pos/sessions/${b2.sid}/pay`, { method: 'transfer', tip_transfer: 900000, confirm_unserved: true })).status, 400);
  await o('POST', `/api/pos/sessions/${b2.sid}/pay`, { method: 'transfer', confirm_unserved: true });
  // Bill 3: tiền mặt, khách không lấy thối 15.000đ
  const b3 = await bill(3, 1);
  await o('POST', `/api/pos/sessions/${b3.sid}/pay`, { method: 'cash', cash_given: b3.total + 15000, keep_change: true, confirm_unserved: true });
  await o('POST', '/api/payments/drawer', { date: D, opening: 1000000 });
  let d = (await o('GET', `/api/payments?date=${D}`)).data;
  assert.equal(d.summary.tip_box_ck, 20000);
  assert.equal(d.summary.tip_box_cash, 15000);
  // Két phải có: tiền mặt bill 3 (+15k tip vào két) − 35k bỏ thùng tip (15k TM + 20k lấy ra thay tip CK)
  assert.equal(d.summary.drawer_expected, 1000000 + b3.total + 15000 - 35000);

  // Đối soát số dư tài khoản như tờ giấy: sáng 9.796.826 + CK vào − chi = phải có; thật dư 920đ
  const ckIn = b1.total + 20000 + b2.total;
  let bk = await o('POST', '/api/payments/bank-balance', { date: D, opening: '9.796.826', closing: 9796826 + ckIn + 920 });
  assert.equal(bk.data.bank.ck_in, ckIn);
  assert.equal(bk.data.bank.diff, 920);
  d = (await o('GET', `/api/payments?date=${D}`)).data;
  assert.ok(d.anomalies.some((a) => a.level === 'warn' && /Số dư tài khoản lệch \+920đ.*phí \/ lãi/.test(a.text)), JSON.stringify(d.anomalies));
  bk = await o('POST', '/api/payments/bank-balance', { date: D, other_in: 920, note: 'Lãi không kỳ hạn' });
  assert.equal(bk.data.bank.diff, 0);

  // Chốt ngày → sổ thùng tip có 35.000đ
  await o('POST', '/api/payments/reconcile', { ids: [b1.sid, b2.sid], status: 'confirmed' });
  d = (await o('GET', `/api/payments?date=${D}`)).data;
  await o('POST', '/api/payments/drawer', { date: D, counted: d.summary.drawer_expected, keep_float: 900000 });
  await o('POST', '/api/payments/drawer-photo', { date: D, data: `data:image/jpeg;base64,${Buffer.alloc(3000, 7).toString('base64')}` });
  const c = await o('POST', '/api/payments/close-day', { date: D });
  assert.equal(c.status, 200, c.data?.error);
  let box = (await o('GET', '/api/tip-box')).data;
  assert.equal(box.balance, 35000);
  // Đếm thùng thiếu 5.000đ
  const cnt = await o('POST', '/api/tip-box/count', { counted: 30000 });
  assert.equal(cnt.data.diff, -5000);
  assert.equal((await o('GET', '/api/tip-box')).data.balance, 35000, 'đếm không đổi sổ');

  // Cuối tháng chia theo giờ công
  const teams = (await o('GET', '/api/teams')).data;
  const mk = async (name, pin) => (await o('POST', '/api/staff', { name, role: 'staff', team_id: teams.find((x) => x.name === 'Phục vụ').id, pin, pay_type: 'hour', pay_rate: 25000 })).data.id;
  const a = await mk('Hậu', '736601');
  const b = await mk('Vy', '736602');
  const ins = db.prepare('INSERT INTO attendance (staff_id, date, clock_in, clock_out, late_minutes) VALUES (?, ?, ?, ?, 0)');
  ins.run(a, D, at('10:00'), at('18:00'));
  ins.run(b, D, at('14:00'), at('18:00'));
  const sg = (await o('GET', `/api/tip-box/suggest?from=2026-10-01&to=2026-10-31`)).data;
  assert.deepEqual(sg.lines.map((l) => [l.name, l.hours, l.amount]), [['Hậu', 8, 24000], ['Vy', 4, 11000]]);
  assert.equal((await o('POST', '/api/tip-box/payout', { lines: [{ staff_id: a, amount: 40000 }] })).status, 400, 'chia quá số trong thùng');
  const pay = await o('POST', '/api/tip-box/payout', { from: '2026-10-01', to: '2026-10-31', lines: sg.lines });
  assert.equal(pay.status, 200, pay.data?.error);
  assert.equal(pay.data.balance, 0);
  box = (await o('GET', '/api/tip-box')).data;
  assert.equal(box.last_payout.lines.length, 2);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE staff_id = ? AND title LIKE 'Tip kỳ 01/10%24.000đ'").get(a));

  // Chủ quán mở lại sổ ngày → xoá phần tip tự ghi của ngày đó
  assert.equal((await o('POST', '/api/daybook/reopen', { date: D, reason: 'Sửa bill' })).status, 200);
  assert.equal((await o('GET', '/api/tip-box')).data.balance, -35000);
});
