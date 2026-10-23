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

test('khuyến mãi: mua 1 tặng 1 theo ngày, tự hết hạn, báo nhân viên, phiếu bếp không ghi tặng, happy hour, giảm bill', async (t) => {
  let now = at('2026-10-21', '20:00');
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
  const pvTeam = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Phục vụ').id;
  const bepTeam = (await o('GET', '/api/teams')).data.find((x) => x.name.startsWith('Bếp')).id;
  await o('POST', '/api/staff', { name: 'Hậu', team_id: pvTeam, pin: '4821' });
  await o('POST', '/api/staff', { name: 'Phát', team_id: bepTeam, pin: '6143' });
  const H = mk();
  await H('POST', '/api/login', { pin: '4821' });
  const menu = (await H('GET', '/api/menu')).data;
  const M = (n) => menu.items.find((i) => i.name === n);
  const cat = (n) => menu.categories.find((c) => c.name === n).id;

  // Nhân viên không tạo được
  assert.equal((await H('POST', '/api/promotions', { name: 'x', type: 'bogo', start_date: '2026-10-22', end_date: '2026-10-31' })).status, 403);
  assert.equal((await o('POST', '/api/promotions', { name: 'x', type: 'bogo', scope: 'all', start_date: '2026-10-31', end_date: '2026-10-22' })).status, 400);

  // Chủ quán tạo "Mua 1 tặng 1 trà trái cây" 22/10–31/10 → mọi nhân viên nhận báo
  const c = await o('POST', '/api/promotions', { name: 'Mua 1 tặng 1 trà', type: 'bogo', buy_qty: 1, get_qty: 1, scope: 'categories', category_ids: [cat('Trà trái cây')], start_date: '2026-10-22', end_date: '2026-10-31', note: 'Mời khách khi order nước' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.notified, 3);
  const noti = (name) => db.prepare('SELECT n.title, n.body FROM notifications n JOIN staff s ON s.id = n.staff_id WHERE s.name = ? ORDER BY n.id DESC').all(name);
  assert.match(noti('Phát')[0].title, /Khuyến mãi mới: Mua 1 tặng 1 trà/);
  assert.match(noti('Phát')[0].body, /Mua 1 tặng 1 · nhóm Trà trái cây · 22\/10–31\/10\. Mời khách/);
  let list = (await H('GET', '/api/promotions')).data.items;
  assert.equal(list[0].status, 'upcoming');

  // Hôm nay (21/10) chưa tới ngày → không giảm
  let s = (await H('POST', '/api/pos/sessions', { tables: [5] })).data.id;
  await H('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M('Trà đào').id, qty: 2 });
  assert.equal((await H('GET', `/api/pos/sessions/${s}`)).data.discount, 0);
  await H('POST', `/api/pos/sessions/${s}/cancel`, {});

  // Sáng 22/10: 7h chưa báo, 9h báo "Hôm nay bắt đầu", không báo lặp
  now = at('2026-10-22', '07:00');
  assert.equal(app.ctx.promoTick(), 0);
  now = at('2026-10-22', '09:00');
  assert.equal(app.ctx.promoTick(), 1);
  assert.equal(app.ctx.promoTick(), 0);
  assert.match(noti('Hậu')[0].title, /Hôm nay bắt đầu khuyến mãi/);

  // 18:00 gọi 2 Trà đào + 1 Trà tắc (20k) + 1 Trà đào cam xả (29k) → 4 ly: 29k,25k | 25k,20k → tặng 25k + 20k
  now = at('2026-10-22', '18:00');
  assert.equal((await H('GET', '/api/menu')).data.promo.tags[M('Trà đào').id], 'Mua 1 tặng 1');
  s = (await H('POST', '/api/pos/sessions', { tables: [5] })).data.id;
  const a = (await H('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M('Trà đào').id, qty: 2 })).data.id;
  await H('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M('Trà tắc xí muội').id });
  await H('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M('Trà đào cam xả').id });
  await H('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M('Combo 2').id, option_ids: [M('Combo 2').options[0].id] });
  let v = (await H('GET', `/api/pos/sessions/${s}`)).data;
  assert.equal(v.subtotal, 50000 + 20000 + 29000 + 79000);
  assert.equal(v.discount, 45000);
  assert.equal(v.total, v.subtotal - 45000);
  assert.equal(v.items.find((i) => i.id === a).promos[0].free_qty, 1);
  assert.equal(v.items.find((i) => i.name === 'Combo 2').discount, 0);

  // Phiếu bếp: chỉ tổng số phần phải làm, không chữ "tặng" (chủ quán chốt)
  await H('POST', `/api/pos/sessions/${s}/send`);
  const tk = db.prepare("SELECT lines FROM kitchen_tickets k JOIN kitchen_stations st ON st.id = k.station_id WHERE st.name = 'Pha chế' ORDER BY k.id DESC").get();
  assert.ok(!/tặng|TẶNG|KM|khuyến/i.test(tk.lines), tk.lines);
  assert.equal(JSON.parse(tk.lines).find((l) => l.name === 'Trà đào').qty, 2);

  // Khách huỷ Trà đào cam xả → còn 3 ly (25,25,20) → tặng 1 ly 25k, app tự tính lại
  now += 60_000;
  const cx = v.items.find((i) => i.name === 'Trà đào cam xả').id;
  await H('POST', `/api/pos/items/${cx}/cancel`, { reason: 'Khách đổi ý' });
  v = (await H('GET', `/api/pos/sessions/${s}`)).data;
  assert.equal(v.discount, 25000);

  // Happy hour: Steak giảm 30% 14:00–17:00 → món gọi 15:00 được giảm, món gọi 18:00 thì không
  await o('POST', '/api/promotions', { name: 'Happy hour steak', type: 'percent', value: 30, scope: 'categories', category_ids: [cat('Steak')], start_date: '2026-10-22', end_date: '2026-10-31', time_from: '14:00', time_to: '17:00' });
  now = at('2026-10-23', '15:00');
  const s2 = (await H('POST', '/api/pos/sessions', { tables: [6] })).data.id;
  await H('POST', `/api/pos/sessions/${s2}/items`, { menu_item_id: M('Steak Âu').id, option_ids: [M('Steak Âu').options[0].id] });
  now = at('2026-10-23', '18:00');
  await H('POST', `/api/pos/sessions/${s2}/items`, { menu_item_id: M('Combo 1').id, option_ids: [M('Combo 1').options[0].id] });
  v = (await H('GET', `/api/pos/sessions/${s2}`)).data;
  assert.equal(v.discount, Math.ceil((69000 * 0.3) / 1000) * 1000); // 20.700 → làm tròn 21.000

  // Giảm 10% bill từ 300k, không chồng lên món đã KM
  await o('POST', '/api/promotions', { name: 'Bill 300k giảm 10%', type: 'bill_percent', value: 10, min_bill: 300000, start_date: '2026-10-23', end_date: '2026-10-23' });
  await H('POST', `/api/pos/sessions/${s2}/items`, { menu_item_id: M('Combo 3').id, option_ids: [M('Combo 3').options[0].id], qty: 3 });
  v = (await H('GET', `/api/pos/sessions/${s2}`)).data;
  const plain = v.items.filter((i) => !i.discount).reduce((n, i) => n + i.total, 0);
  assert.equal(v.bill_promos[0].amount, Math.ceil((plain * 0.1) / 1000) * 1000);

  // Hết hạn 1/11 → không còn giảm, trạng thái "đã hết"
  now = at('2026-11-01', '18:00');
  const s3 = (await H('POST', '/api/pos/sessions', { tables: [7] })).data.id;
  await H('POST', `/api/pos/sessions/${s3}/items`, { menu_item_id: M('Trà đào').id, qty: 2 });
  assert.equal((await H('GET', `/api/pos/sessions/${s3}`)).data.discount, 0);
  list = (await H('GET', '/api/promotions')).data.items;
  assert.ok(list.every((p) => p.status === 'ended'));
  assert.deepEqual((await H('GET', '/api/menu')).data.promo.tags, {});
});

test('khuyến mãi: mua 1 tặng 1 cùng món, mua lẩu tặng bò (món B) chỉ trừ đúng số phần được tặng', async () => {
  const { applyPromos } = await import('../server/lib/promo.js');
  const { makeClock } = await import('../server/lib/time.js');
  const clock = makeClock({ offset: '+07:00' });
  const at = clock.toEpoch('2026-10-23', 19 * 60);
  const base = { active: true, start_date: '2026-10-18', end_date: '2026-10-27', days: '1234567', time_from: null, time_to: null, item_ids: [], gift_item_ids: [] };
  const bogo = { ...base, id: 1, name: 'Mua 1 tặng 1 steak', type: 'bogo', buy_qty: 1, get_qty: 1, pair: 'same', scope: 'categories', category_ids: [1] };
  const gift = { ...base, id: 2, name: 'Lẩu tặng bò', type: 'gift', buy_qty: 1, get_qty: 1, scope: 'categories', category_ids: [2], gift_item_ids: [30, 31] };
  const it = (id, menu, cat, price, qty) => ({ id, menu_item_id: menu, category_id: cat, unit_price: price, qty, created_at: at });
  // 2 Combo 3 + 1 Steak Âu: chỉ Combo 3 được tặng 1 (cùng món), Steak Âu không ghép với Combo 3
  let r = applyPromos([it(1, 10, 1, 139000, 2), it(2, 11, 1, 79000, 1)], [bogo], { clock, openedAt: at });
  assert.equal(r.item_discount, 139000);
  // Steak Âu mới 1 phần → nhắc gọi thêm 1 phần Steak Âu để được tặng; Combo 3 đủ cặp → không nhắc
  assert.deepEqual(r.hints.map((h) => [h.menu_item_id, h.need]), [[11, 1]]);
  // Kiểu cũ (tặng món rẻ nhất trong nhóm): Steak Âu được tặng
  r = applyPromos([it(1, 10, 1, 139000, 1), it(2, 11, 1, 79000, 1)], [{ ...bogo, pair: 'cheapest' }], { clock, openedAt: at });
  assert.equal(r.item_discount, 79000);
  // 2 set lẩu + 3 phần bò tặng: chỉ trừ 2 phần (đắt nhất trước), còn 1 phần tính tiền; gifts báo còn 0
  r = applyPromos([it(1, 20, 2, 150000, 2), it(2, 30, 3, 69000, 2), it(3, 31, 3, 79000, 1)], [gift], { clock, openedAt: at });
  assert.equal(r.item_discount, 79000 + 69000);
  assert.deepEqual(r.gifts.map((g) => [g.allow, g.left]), [[2, 0]]);
  // Chưa gọi bò tặng → còn được tặng 2
  r = applyPromos([it(1, 20, 2, 150000, 2)], [gift], { clock, openedAt: at });
  assert.equal(r.gifts[0].left, 2);
  // Hết hạn (28/10) → không tặng
  const late = clock.toEpoch('2026-10-28', 19 * 60);
  r = applyPromos([{ ...it(1, 20, 2, 150000, 1), created_at: late }, { ...it(2, 30, 3, 69000, 1), created_at: late }], [gift], { clock, openedAt: late });
  assert.equal(r.item_discount, 0);
});
