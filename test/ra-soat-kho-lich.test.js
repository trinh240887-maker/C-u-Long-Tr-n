// Rà soát 28/10: Sapo bỏ nhập / nhập lại, Nhập–Xuất–Tồn, kiểm kho rau củ, phạm vi xếp ca theo bộ phận, tin Zalo riêng
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeXlsx } from '../server/lib/xlsx.js';
import { addDays, weekStart } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function boot(t, opts = {}) {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} }, ...opts });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const O = mk();
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await O('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const login = async (pin, np) => { const c = mk(); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
  return { db, app, O, login };
}

test('Sapo: bỏ nhập → nhập lại → bỏ lại không thổi phồng tồn; hao hụt + NXT không tính phần đã huỷ', async (t) => {
  const { db, app, O } = await boot(t);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('single_store', '1')").run();
  const store = db.prepare("SELECT id FROM stores WHERE kind = 'main' LIMIT 1").get().id;
  const ing = Number(db.prepare("INSERT INTO ingredients (name, unit) VALUES ('Bò test', 'g')").run().lastInsertRowid);
  db.prepare('INSERT INTO stock_lots (store_id, ingredient_id, qty, received_at) VALUES (?, ?, 5000, 0)').run(store, ing);
  const item = Number(db.prepare("INSERT INTO menu_items (name, price) VALUES ('Steak test', 99000)").run().lastInsertRowid);
  db.prepare('INSERT INTO menu_recipes (item_id, ingredient_id, qty) VALUES (?, ?, 100)').run(item, ing);
  const today = app.ctx.today();
  // Kiểm kho trước: còn 3950 (bán 1000 + hụt 50)
  assert.equal((await O('POST', '/api/stock/count', { store_id: store, lines: [{ ingredient_id: ing, actual: 3950 }] })).status, 200);
  const serial = (Date.parse(`${today}T00:00:00Z`) / 86_400_000) + 25569 + 20 / 24;
  const data = makeXlsx([{ name: 'S', rows: [['Stt', 'Mã hóa đơn', 'Trạng thái đơn hàng', 'Thời gian thanh toán', 'Mã mặt hàng', 'Tên mặt hàng, combo', 'Số lượng', 'Tiền hàng'],
    [1, 'H1', 'Đã thanh toán', serial, 'ST', 'Steak test', 10, 990000]] }]).toString('base64');
  const left = () => db.prepare('SELECT SUM(qty) AS q FROM stock_lots WHERE ingredient_id = ?').get(ing).q;
  const imp = async () => assert.equal((await O('POST', '/api/sapo/import', { data, dates: [today] })).status, 200);
  const undo = async () => assert.equal((await O('POST', '/api/sapo/undo', { date: today })).status, 200);
  await imp(); assert.equal(left(), 3950);
  await undo(); assert.equal(left(), 3950);
  await imp(); assert.equal(left(), 3950, 'nhập lại: chỉ bù phần của lần nhập này');
  await undo(); assert.equal(left(), 3950, 'bỏ lần 2: không trả lại dòng đã bỏ');
  const loss0 = (await O('GET', `/api/stock/loss?from=${today}&to=${today}`)).data.rows.find((x) => x.ingredient_id === ing);
  assert.equal(loss0.loss, 1050, 'đã bỏ nhập: phần bù không còn trừ vào hụt');
  await imp(); assert.equal(left(), 3950);
  const loss = (await O('GET', `/api/stock/loss?from=${today}&to=${today}`)).data.rows.find((x) => x.ingredient_id === ing);
  assert.equal(loss.std, 1000); assert.equal(loss.loss, 50);
  // NXT: bù Sapo không vào cột Nhập / Huỷ, Lệch = hụt thật
  const row = (await O('GET', `/api/stock/nxt?from=${today}&to=${today}`)).data.groups.flatMap((g) => g.rows).find((x) => x.id === ing);
  assert.equal(row.nhap, 0); assert.equal(row.huy, 0); assert.equal(row.ban, 1000); assert.equal(row.lech, -50);
  assert.equal(row.cuoi, 3950); assert.equal(row.dau, 5000);
});

test('Kiểm kho: rau củ nhận đúng tên; "nhập" tính từ lần kiểm đầu ngày, trừ bill huỷ', async (t) => {
  const { db, app, O } = await boot(t);
  const veg = app.ctx.isVegName;
  for (const n of ['Rau muống', 'Bí đỏ', 'Hành lá', 'Cà chua', 'Me chua', 'Ớt sừng', 'Nấm kim châm']) assert.equal(veg(n), true, n);
  for (const n of ['Bò bít tết', 'Giăm bông', 'Men bia', 'Melon', 'Mentos', 'Sốt cà chua', 'Hành phi', 'Tỏi phi', 'Ớt bột']) assert.equal(veg(n), false, n);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('single_store', '1')").run();
  const store = db.prepare("SELECT id FROM stores WHERE kind = 'main' LIMIT 1").get().id;
  const ing = Number(db.prepare("INSERT INTO ingredients (name, unit) VALUES ('Rau muống', 'g')").run().lastInsertRowid);
  const now = app.ctx.now(), today = app.ctx.today(), D = 86_400_000;
  const mv = (at, date, qty, ref) => db.prepare("INSERT INTO stock_moves (at, date, type, ingredient_id, to_store, qty, cost, ref) VALUES (?, ?, 'receive', ?, ?, ?, 0, ?)").run(at, date, ing, store, qty, ref);
  mv(now - 3 * D, addDays(today, -3), 500, 'r0'); // trước lần kiểm: không tính
  const c = Number(db.prepare('INSERT INTO stock_counts (store_id, date, at) VALUES (?, ?, ?)').run(store, addDays(today, -2), now - 2 * D).lastInsertRowid);
  db.prepare('INSERT INTO stock_count_lines (count_id, ingredient_id, expected, actual) VALUES (?, ?, 0, 2000)').run(c, ing);
  mv(now - D, addDays(today, -1), 3000, 'r1'); // hôm qua, sau lần kiểm: tính
  mv(now - 1000, today, 10000, 'bill:9');
  mv(now - 500, today, -10000, 'void-bill:9'); // bill huỷ: trừ ra
  const l = (await O('GET', `/api/stock/count-sheet?store=${store}`)).data.lines.find((x) => x.ingredient_id === ing);
  assert.equal(l.veg, true); assert.equal(l.day_open, 2000); assert.equal(l.day_in, 3000);
});

test('Xếp ca theo bộ phận: không xếp / báo hộ người bộ phận khác; duyệt bộ phận = tuần đã duyệt với người bộ phận đó', async (t) => {
  const { db, app, O, login } = await boot(t);
  const teams = (await O('GET', '/api/teams')).data;
  const bep = teams.find((x) => x.name === 'Bếp steak').id, pv = teams.find((x) => x.name === 'Phục vụ').id;
  db.prepare('UPDATE teams SET min_staff = 2 WHERE id = ?').run(pv);
  const mkS = async (name, role, team, pin) => (await O('POST', '/api/staff', { name, role, team_id: team, pin })).data.id;
  await mkS('Quản lý bếp', 'manager', bep, '736511');
  const pvId = await mkS('Nga', 'staff', pv, '7366');
  const bepId = await mkS('Tâm', 'staff', bep, '7367');
  const freeId = await mkS('Lan', 'staff', null, '7368');
  const ql = await login('736511', '836512');
  const ws = weekStart(addDays(app.ctx.today(), 14));
  const shift = (staff_id, team_id, date = ws) => ({ staff_id, date, team_id, label: 'Ca', segments: [{ start: '17:00', end: '22:00' }] });
  // Gắn bộ phận mình lên ca người bộ phận khác → vẫn chặn
  assert.equal((await ql('POST', '/api/shifts', shift(pvId, bep))).status, 403);
  assert.equal((await ql('POST', '/api/shifts', shift(bepId, bep))).status, 200);
  assert.equal((await ql('POST', '/api/shifts', shift(freeId, null))).status, 200);
  // Báo hộ lịch rảnh: chỉ người bộ phận mình
  assert.equal((await ql('GET', `/api/availability/me?week=${ws}&staff=${pvId}`)).status, 403);
  assert.equal((await ql('POST', '/api/availability/me', { week: ws, staff_id: pvId, picks: { [ws]: ['08:00-12:00'] } })).status, 403);
  assert.equal((await ql('GET', `/api/availability/me?week=${ws}&staff=${bepId}`)).status, 200);
  // Không cảnh báo thiếu người bộ phận khác (quản lý bếp không thấy ca phục vụ)
  const sc = (await ql('GET', `/api/schedule?week=${ws}`)).data;
  assert.equal(sc.warnings.filter((w) => w.team_id === pv).length, 0);
  assert.ok((await O('GET', `/api/schedule?week=${ws}`)).data.warnings.some((w) => w.team_id === pv));
  // Duyệt lịch bộ phận: chỉ báo người bộ phận mình (không báo người chưa có bộ phận)
  const told = [];
  const notify0 = app.ctx.notify;
  app.ctx.notify = (ids, msg) => { told.push(...[].concat(ids)); return notify0(ids, msg); };
  assert.equal((await ql('POST', '/api/schedule/publish', { week: ws })).status, 200);
  app.ctx.notify = notify0;
  assert.ok(told.includes(bepId)); assert.ok(!told.includes(freeId)); assert.ok(!told.includes(pvId));
  assert.ok((await ql('GET', `/api/schedule?week=${ws}`)).data.published_at > 0);
  // Người bộ phận đã duyệt gửi lại lịch rảnh → không tự viết lại ca; bộ phận chưa duyệt vẫn tự tạo ca
  const n = (id) => db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE staff_id = ? AND note = 'Theo lịch rảnh'").get(id).n;
  assert.equal((await O('POST', '/api/availability/me', { week: ws, staff_id: bepId, picks: { [addDays(ws, 1)]: ['08:00-12:00'] } })).status, 200);
  assert.equal(n(bepId), 0);
  assert.equal((await O('POST', '/api/availability/me', { week: ws, staff_id: pvId, picks: { [addDays(ws, 1)]: ['08:00-12:00'] } })).status, 200);
  assert.equal(n(pvId), 1);
});

test('Zalo: tin nhắn riêng với bot không thành đơn nhà cung cấp', async (t) => {
  const sent = [];
  let inbox = [];
  const zaloBot = { ready: () => true, send: async (chat, text) => { sent.push({ chat, text }); }, sendPhoto: async () => {}, call: async () => ({}), chats: async () => [], updates: async () => { const x = inbox; inbox = []; return x; } };
  const { db, app, O } = await boot(t, { zaloBot });
  app.ctx.saveStaffGroups([{ id: 'g', name: 'Nhân viên', teams: [] }]);
  const ncc = (await O('POST', '/api/stock/suppliers', { name: 'Sạp thịt Kim Thanh Ngọc', phone: '0949336552' })).data.id;
  await O('POST', '/api/stock/ingredients', { name: 'Thăn bò', unit: 'g', freshness: 'fresh', supplier_id: ncc, purchase_unit: 'kg', purchase_factor: 1000, price: 300000 });
  inbox = [{ id: 'p1', date: Date.now(), chat: { id: 'uKim', type: 'PRIVATE', name: 'Kim Thanh Ngọc' }, from: { id: 'uKim', name: 'Kim Thanh Ngọc' }, text: '@bot thăn bò 10kg' }];
  await app.ctx.zaloBotPoll();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n, 0);
  assert.ok(!app.ctx.supplierGroupOf('uKim'));
  assert.ok(!sent.some((x) => x.chat === 'uKim'));
});
