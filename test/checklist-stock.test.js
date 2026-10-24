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

test('checklist cân tồn: nối kho, tự kiểm kho theo định lượng, báo lệch, sửa số thì huỷ lần cũ + báo, nhân viên không thấy số sổ', async (t) => {
  let now = clock.toEpoch(D, 10 * 60);
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie;
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  const o = client();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const meta = (await o('GET', '/api/stock/meta')).data;
  const S = Object.fromEntries(meta.stores.map((s) => [s.name, s.id]));
  const teams = (await o('GET', '/api/teams')).data;
  const lauTeam = teams.find((x) => x.name === 'Lẩu');
  const bap = (await o('POST', '/api/stock/ingredients', { name: 'Bắp bò', unit: 'g', home_store_id: S['Kho Lẩu'], purchase_unit: 'kg', purchase_factor: 1000, price: 260000, min_stock: 1000, freshness: 'fresh', shelf_days: 3 })).data.id;
  const menu = (await o('GET', '/api/menu')).data;
  const set1 = menu.items.find((x) => x.name.startsWith('Set 1'));
  await o('PATCH', `/api/menu/items/${set1.id}`, { recipe: [{ ingredient_id: bap, qty: 200 }] });
  const stock = () => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(bap).q;
  const note = (re) => db.prepare('SELECT title, body FROM notifications ORDER BY id').all().filter((x) => re.test(x.title));
  // Đầu ca 10kg (nhận hàng), bán 5 set × 200g → sổ còn 9kg
  assert.equal((await o('POST', '/api/stock/receive', { store_id: S['Kho Lẩu'], lines: [{ ingredient_id: bap, qty: 10 }] })).status, 200);
  const sid = (await o('POST', '/api/pos/sessions', { tables: [1], guests: 10, override_size: true })).data.id;
  assert.equal((await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: set1.id, qty: 5, option_ids: set1.options.length ? [set1.options[0].id] : [] })).status, 200);
  await o('POST', `/api/pos/sessions/${sid}/send`);
  assert.equal(Math.round(stock()), 9000);

  // Đơn vị không đổi được → báo lỗi khi lưu
  const bad = await o('POST', '/api/checklist-templates', { title: 'Đóng ca Lẩu', team_id: lauTeam.id, phase: 'close', items: [{ text: 'Bò còn', kind: 'number', unit: 'lon', ingredient_id: bap }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /không đổi được/);
  const tpl = (await o('POST', '/api/checklist-templates', { title: 'Đóng ca Lẩu', team_id: lauTeam.id, phase: 'close', items: [{ text: 'Bắp bò còn cuối ca', kind: 'number', unit: 'kg', ingredient_id: bap }] })).data.id;
  const it = (await o('GET', '/api/checklist-templates')).data.find((x) => x.id === tpl).items[0];
  assert.equal(it.ingredient_name, 'Bắp bò');
  assert.equal(it.store_id, S['Kho Lẩu']);

  // Nhân viên tổ Lẩu cân 8,6kg → lệch thiếu 400g (4,4%) > 3% → báo chủ quán, nhân viên không thấy số sổ
  const st = (await o('POST', '/api/staff', { name: 'Tài', role: 'staff', team_id: lauTeam.id, pin: '736501', pay_type: 'hour', pay_rate: 25000 })).data.id;
  const w = client();
  await w('POST', '/api/login', { pin: '736501' });
  await w('POST', '/api/me/pin', { current_pin: '736501', new_pin: '836501' });
  await o('POST', '/api/shifts', { staff_id: st, date: D, team_id: lauTeam.id, label: 'Ca', segments: [{ start: '16:00', end: '23:00' }] });
  now = clock.toEpoch(D, 22 * 60);
  const day = (await w('GET', `/api/checklists?date=${D}`)).data;
  const run = (day.runs || day).find((x) => x.template_id === tpl);
  assert.ok(run, 'nhân viên tổ Lẩu thấy checklist');
  const e1 = await w('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: it.id, value: '8,6' });
  assert.equal(e1.status, 200, e1.data?.error);
  assert.equal(e1.data.count.text, 'Đã ghi tồn, app đã tự kiểm kho');
  assert.equal(e1.data.count.expected, undefined);
  assert.equal(Math.round(stock()), 8600);
  const lech = note(/^Lệch Bắp bò THIẾU 400 g \(4\.4%\) ≈ 2 phần/);
  assert.equal(lech.length, 1, JSON.stringify(note(/Lệch/)));
  assert.match(lech[0].body, /Tài cân 8,6 kg, sổ phải còn 9 kg/);
  assert.match(db.prepare("SELECT note FROM stock_moves WHERE type = 'waste' AND ingredient_id = ?").get(bap).note, /Lệch định lượng/);

  // Nhân viên sửa số 8,6 → 9 → huỷ lần kiểm cũ, kiểm lại (khớp), báo quản lý việc sửa số
  const e2 = await w('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: it.id, value: '9' });
  assert.equal(e2.status, 200);
  assert.equal(Math.round(stock()), 9000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'waste' AND ingredient_id = ?").get(bap).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_counts').get().n, 1);
  assert.equal(note(/^Tài sửa số cân "Bắp bò còn cuối ca"/).length, 1);
  // Chủ quán xem đủ số sổ / cân / lệch
  const e3 = await o('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: it.id, value: '8.9' });
  assert.equal(e3.data.count.text, 'Sổ 9 kg · cân 8,9 kg · thiếu 100 g (1.1%)');
  assert.equal(e3.data.count.over, false);
  // Bỏ tick → trả kho như chưa kiểm
  await o('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: it.id, done: false });
  assert.equal(Math.round(stock()), 9000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_counts').get().n, 0);
  void st;

  // Topping đếm theo bịch + viên lẻ: Bò viên 50 viên/bịch, bán 3 phần × 4 viên
  const bv = (await o('POST', '/api/stock/ingredients', { name: 'Bò viên', unit: 'viên', home_store_id: S['Kho Lẩu'], purchase_unit: 'bịch', purchase_factor: 50, price: 90000, min_stock: 50, freshness: 'dry' })).data.id;
  const bvItem = menu.items.find((x) => x.name.startsWith('Bò viên'));
  await o('PATCH', `/api/menu/items/${bvItem.id}`, { recipe: [{ ingredient_id: bv, qty: 4 }] });
  await o('POST', '/api/stock/receive', { store_id: S['Kho Lẩu'], lines: [{ ingredient_id: bv, qty: 4 }] });
  await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: bvItem.id, qty: 3 });
  await o('POST', `/api/pos/sessions/${sid}/send`);
  const tpl2 = (await o('POST', '/api/checklist-templates', { title: 'Đóng ca Topping', team_id: lauTeam.id, phase: 'close', items: [{ text: 'Bò viên còn', kind: 'number', unit: 'bịch', ingredient_id: bv }] })).data.id;
  const it2 = (await o('GET', '/api/checklist-templates')).data.find((x) => x.id === tpl2).items[0];
  assert.equal(it2.pack_mode, true);
  const run2 = ((await o('GET', `/api/checklists?date=${D}`)).data.runs || []).find((x) => x.template_id === tpl2);
  // Sổ: 200 − 12 = 188 viên = 3 bịch + 38 lẻ; đếm 3 bịch + 30 lẻ → thiếu 8 viên (4,3%) ≈ 2 phần
  const p0 = await w('POST', '/api/checklists/entry', { run_id: run2.run_id, item_id: it2.id, value: '3', loose: '30' });
  assert.equal(p0.status, 200, p0.data?.error);
  assert.equal(note(/^Lệch Bò viên THIẾU 8 viên \(4\.3%\) ≈ 2 phần/).length, 1);
  await w('POST', '/api/checklists/entry', { run_id: run2.run_id, item_id: it2.id, done: false });
  const p1 = await o('POST', '/api/checklists/entry', { run_id: run2.run_id, item_id: it2.id, value: '3', loose: '30' });
  assert.equal(p1.status, 200, p1.data?.error);
  assert.equal(db.prepare('SELECT value FROM checklist_entries WHERE item_id = ?').get(it2.id).value, '3 bịch + 30 viên');
  assert.equal(Math.round(db.prepare('SELECT SUM(qty) AS q FROM stock_lots WHERE ingredient_id = ?').get(bv).q), 180);
  assert.equal(p1.data.count.text, 'Sổ 188 viên (3 bịch + 38 lẻ) · cân 180 viên (3 bịch + 30 lẻ) · thiếu 8 viên (4.3%)');
  // Cân chung 2 loại thịt: sổ 9kg bắp + 4kg gù = 13kg; cân chung 12kg → chia theo tỉ lệ, lệch tính cả nhóm 1kg
  const gu = (await o('POST', '/api/stock/ingredients', { name: 'Gù bò', unit: 'g', home_store_id: S['Kho Lẩu'], purchase_unit: 'kg', purchase_factor: 1000, price: 240000, freshness: 'fresh' })).data.id;
  await o('POST', '/api/stock/receive', { store_id: S['Kho Lẩu'], lines: [{ ingredient_id: gu, qty: 4 }] });
  const tpl3 = (await o('POST', '/api/checklist-templates', { title: 'Cân thịt tươi', team_id: lauTeam.id, phase: 'close', items: [{ text: 'Thịt tươi còn', kind: 'number', unit: 'kg', ingredient_id: bap, extra_ingredient_ids: [gu] }] })).data.id;
  const it3 = (await o('GET', '/api/checklist-templates')).data.find((x) => x.id === tpl3).items[0];
  assert.deepEqual(it3.group_names, ['Bắp bò', 'Gù bò']);
  const run3 = ((await o('GET', `/api/checklists?date=${D}`)).data.runs || []).find((x) => x.template_id === tpl3);
  const g3 = await w('POST', '/api/checklists/entry', { run_id: run3.run_id, item_id: it3.id, value: '12' });
  assert.equal(g3.status, 200, g3.data?.error);
  const q = (id) => Math.round(db.prepare('SELECT SUM(qty) AS q FROM stock_lots WHERE ingredient_id = ?').get(id).q);
  assert.equal(q(bap) + q(gu), 12000);
  assert.ok(note(/^Lệch Thịt tươi \(Bắp bò, Gù bò\) THIẾU 1 kg/).length, JSON.stringify(note(/Lệch/).map((x) => x.title)));
  // Thiếu cả 2 ô → báo lỗi
  assert.equal((await o('POST', '/api/checklists/entry', { run_id: run2.run_id, item_id: it2.id, value: '', loose: '' })).status, 400);
});

test('thịt tươi: nhận hàng chia từng loại theo giá riêng, bán trừ theo giá vốn bình quân cả nhóm', async () => {
  const { openDb } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const db = openDb(':memory:');
  const app = createApp({ db, now: () => Date.now(), publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tt-')), zaloTransport: { send: async () => {} } });
  const st = db.prepare("SELECT id FROM stores WHERE name = 'Kho Lẩu'").get().id;
  const add = (name, price) => Number(db.prepare("INSERT INTO ingredients (name, unit, home_store_id, purchase_unit, purchase_factor, price, cost_group) VALUES (?, 'g', ?, 'kg', 1000, ?, 'Thịt tươi')").run(name, st, price).lastInsertRowid);
  const than = add('Thăn', 280000);
  const gu = add('Gù', 240000);
  // Nhận 22kg thăn + 3,35kg gù → bình quân (22×280 + 3,35×240) / 25,35 ≈ 274,7 đ/g
  app.ctx.stockReceive(db.prepare("SELECT * FROM staff WHERE role = 'owner'").get(), { storeId: st, lines: [{ ingredient_id: than, qty: 22 }, { ingredient_id: gu, qty: 3.35 }] });
  app.ctx.broadcast('stock');
  const avg = db.prepare('SELECT avg_cost FROM ingredients WHERE id = ?').get(gu).avg_cost;
  assert.ok(Math.abs(avg - (22 * 280 + 3.35 * 240) / 25.35) < 0.01, String(avg));
  const { costOf } = await import('../server/lib/stock.js');
  assert.equal(costOf(db.prepare('SELECT * FROM ingredients WHERE id = ?').get(gu), 100), Math.round(100 * avg));
  app.close();
});
