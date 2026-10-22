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
});
