import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';
import { makeXlsx } from '../server/lib/xlsx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (d, hm) => clock.toEpoch(d, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));

test('báo cáo doanh thu: tổng quan, so kỳ trước, theo ngày / giờ / khu / món, khuyến mãi, hoàn tiền, xuất Excel; nhân viên không xem được', async (t) => {
  let now = at('2026-10-23', '11:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => {
    let cookie;
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      return { status: res.status, type, disp: res.headers.get('content-disposition'), data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
  };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const teams = (await o('GET', '/api/teams')).data;
  await o('POST', '/api/staff', { name: 'Hậu', team_id: teams.find((x) => x.name === 'Phục vụ').id, pin: '4821' });
  await o('POST', '/api/staff', { name: 'Quân', role: 'manager', team_id: teams.find((x) => x.name === 'Phục vụ').id, pin: '730194' });
  const H = mk();
  await H('POST', '/api/login', { pin: '4821' });
  await H('POST', '/api/me/pin', { current_pin: '4821', new_pin: '918273' });
  const menu = (await o('GET', '/api/menu')).data;
  const M = (n) => menu.items.find((i) => i.name === n);
  const cat = (id) => menu.items.filter((i) => i.category_id === id && !i.options.length);
  const drinks = cat(menu.categories.find((c) => c.name === 'Trà trái cây').id);
  const order = async (table, list) => {
    const s = (await o('POST', '/api/pos/sessions', { tables: [table] })).data.id;
    for (const [it, qty] of list) await o('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: it.id, qty, option_ids: it.options.length ? [it.options[0].id] : [] });
    await o('POST', `/api/pos/sessions/${s}/send`);
    return s;
  };
  // Khuyến mãi mua 1 tặng 1 trà
  await o('POST', '/api/promotions', { name: 'Mua 1 tặng 1 trà', type: 'bogo', buy_qty: 1, get_qty: 1, scope: 'categories', category_ids: [drinks[0].category_id], start_date: '2026-10-01', end_date: '2026-10-31' });

  // Kỳ trước (22/10): 1 bill
  now = at('2026-10-22', '19:00');
  const p1 = await order(5, [[M('Combo 2'), 1]]);
  now += 3600_000;
  await o('POST', `/api/pos/sessions/${p1}/pay`, { method: 'cash', confirm_unserved: true });
  const prevTotal = db.prepare('SELECT paid_total FROM table_sessions WHERE id = ?').get(p1).paid_total;

  // Kỳ này (23/10): bàn 3 (khu A) CK 2 combo + 2 trà (1 tặng); bàn 90 (khu C) tiền mặt 1 combo, khách đưa dư làm tip
  now = at('2026-10-23', '18:10');
  const a = await order(3, [[M('Combo 2'), 2], [drinks[0], 2]]);
  now = at('2026-10-23', '19:20');
  const b = await order(90, [[M('Combo 2'), 1]]);
  now = at('2026-10-23', '20:00');
  const billA = (await o('GET', `/api/pos/sessions/${a}/bill`)).data;
  assert.ok(billA.discount >= drinks[0].price, 'có giảm giá trà tặng');
  assert.equal((await o('POST', `/api/pos/sessions/${a}/pay`, { method: 'transfer', confirm_unserved: true })).status, 200);
  const billB = (await o('GET', `/api/pos/sessions/${b}/bill`)).data;
  assert.equal((await o('POST', `/api/pos/sessions/${b}/pay`, { method: 'cash', cash_given: billB.total + 20000, keep_change: true, confirm_unserved: true })).status, 200);
  // Hoàn 1 combo bàn B
  const itemB = (await o('GET', `/api/pos/sessions/${b}`)).data.items[0];
  const rf = await o('POST', `/api/pos/sessions/${b}/refund`, { items: [{ id: itemB.id, qty: 1 }], reason: 'Món lỗi', approver_pin: '730194' });
  assert.equal(rf.status, 200, JSON.stringify(rf.data));
  // 1 bàn bỏ về sau khi gửi bếp
  const c = await order(10, [[M('Combo 2'), 1]]);
  await o('POST', `/api/pos/sessions/${c}/cancel`, { reason: 'Khách bỏ về' });

  // Nhân viên không xem
  assert.equal((await H('GET', '/api/reports/sales?from=2026-10-23&to=2026-10-23')).status, 403);
  const r = (await o('GET', '/api/reports/sales?from=2026-10-23&to=2026-10-23')).data;
  const s = r.summary;
  assert.equal(s.bills, 2);
  assert.equal(s.revenue, billA.total + billB.total);
  assert.equal(s.refunds, rf.data.amount);
  assert.equal(s.net, billA.total + billB.total - rf.data.amount);
  assert.equal(s.discount, billA.discount + billB.discount);
  assert.equal(s.gross, billA.subtotal + billB.subtotal);
  assert.equal(s.transfer, billA.total);
  assert.equal(s.cash, billB.total);
  assert.equal(s.tip, 20000);
  assert.ok(s.lost_value > 0, 'món đã làm bị huỷ');
  // So kỳ trước = 22/10
  assert.equal(r.prev_from, '2026-10-22');
  assert.equal(r.prev.revenue, prevTotal);
  // Theo giờ khách vào: 18h và 19h
  assert.deepEqual(r.by_hour.map((h) => h.hour), [18, 19]);
  // Theo khu
  const zones = Object.fromEntries(r.by_zone.map((z) => [z.name, z.revenue]));
  assert.equal(Object.values(zones).reduce((x, y) => x + y, 0), s.revenue);
  assert.equal(r.by_zone.length, 2);
  // Món: combo 3 phần bán − 1 hoàn = 2; trà 2 phần, tiền sau giảm = 1 ly
  const combo = r.items.find((i) => i.name === 'Combo 2');
  assert.equal(combo.qty, 2);
  const tra = r.items.find((i) => i.name === drinks[0].name);
  assert.equal(tra.qty, 2);
  assert.equal(tra.net, drinks[0].price);
  assert.ok(r.not_sold.length > 10, 'có món không bán');
  assert.equal(r.promos[0].name, 'Mua 1 tặng 1 trà');
  // Nhiều ngày: by_day đủ ngày
  const w = (await o('GET', '/api/reports/sales?from=2026-10-17&to=2026-10-23')).data;
  assert.equal(w.by_day.length, 7);
  assert.equal(w.by_day.find((d) => d.date === '2026-10-22').revenue, prevTotal);
  assert.equal((await o('GET', '/api/reports/sales?from=2026-10-23&to=2026-10-01')).status, 400);

  // Excel
  const x = await o('GET', '/api/reports/sales.xlsx?from=2026-10-23&to=2026-10-23');
  assert.equal(x.status, 200);
  assert.match(x.type, /spreadsheetml/);
  assert.match(x.disp, /bao-cao-doanh-thu_2026-10-23_2026-10-23\.xlsx/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-'));
  fs.writeFileSync(path.join(dir, 'a.xlsx'), x.data);
  const list = execFileSync('unzip', ['-l', path.join(dir, 'a.xlsx')]).toString();
  assert.match(list, /xl\/worksheets\/sheet10\.xml/);
  const sheet1 = execFileSync('unzip', ['-p', path.join(dir, 'a.xlsx'), 'xl/worksheets/sheet1.xml']).toString();
  assert.match(sheet1, /Doanh thu thực/);
  assert.match(sheet1, new RegExp(`<v>${s.net}</v>`));
});

test('xlsx: ký tự đặc biệt, tên sheet, số / chữ', () => {
  const buf = makeXlsx([{ name: 'A/B:C*?', rows: [['Tên', 'Số'], ['<Bò & "gầu">', 1234567], ['', null]] }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const s = buf.toString('utf8');
  assert.match(s, /&lt;Bò &amp; &quot;gầu&quot;&gt;/);
  assert.match(s, /<v>1234567<\/v>/);
  assert.match(s, /name="A B C  "/);
});
