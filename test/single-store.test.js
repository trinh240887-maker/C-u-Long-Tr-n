import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('chạy 1 kho: nhập vào Kho tổng, bán trừ Kho tổng theo định lượng, xuất kho chỉ trừ hàng không định lượng, cân kiểm so Kho tổng', async (t) => {
  const db = openDb(':memory:');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('single_store', '1')").run();
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ss-')), zaloTransport: { send: async () => {} } });
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
  const S = Object.fromEntries((await o('GET', '/api/stock/meta')).data.stores.map((s) => [s.name, s.id]));
  const main = db.prepare("SELECT id FROM stores WHERE kind = 'main'").get().id;
  const bap = (await o('POST', '/api/stock/ingredients', { name: 'Bắp bò', unit: 'g', home_store_id: S['Kho Lẩu'], purchase_unit: 'kg', purchase_factor: 1000, price: 260000, freshness: 'fresh' })).data.id;
  const gas = (await o('POST', '/api/stock/ingredients', { name: 'Gas mini', unit: 'lon', home_store_id: S['Kho Lẩu'], purchase_unit: 'lon', purchase_factor: 1, price: 12000, freshness: 'dry' })).data.id;
  const menu = (await o('GET', '/api/menu')).data;
  const set1 = menu.items.find((x) => x.name.startsWith('Set 1'));
  await o('PATCH', `/api/menu/items/${set1.id}`, { recipe: [{ ingredient_id: bap, qty: 200 }] });
  const at = (store, ing) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE store_id = ? AND ingredient_id = ?').get(store, ing).q;
  // Khu Lẩu nhận hàng → vào Kho tổng
  assert.equal((await o('POST', '/api/stock/receive', { store_id: S['Kho Lẩu'], lines: [{ ingredient_id: bap, qty: 10 }, { ingredient_id: gas, qty: 24 }] })).status, 200);
  assert.equal(at(main, bap), 10000);
  assert.equal(at(S['Kho Lẩu'], bap), 0);
  // Bán 5 set × 200g → Kho tổng còn 9kg
  const sid = (await o('POST', '/api/pos/sessions', { tables: [1], guests: 10, override_size: true })).data.id;
  await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: set1.id, qty: 5, option_ids: set1.options.length ? [set1.options[0].id] : [] });
  await o('POST', `/api/pos/sessions/${sid}/send`);
  assert.equal(Math.round(at(main, bap)), 9000);
  // Lĩnh hàng: 6 lon gas (không định lượng → trừ ngay), 2kg bò (có định lượng → không trừ thêm)
  const tr = (await o('POST', '/api/stock/transfers', { to_store_id: S['Kho Lẩu'], lines: [{ ingredient_id: gas, qty: 6 }, { ingredient_id: bap, qty: 2000 }] })).data.id;
  assert.equal((await o('POST', `/api/stock/transfers/${tr}/send`, {})).status, 200);
  assert.equal(at(main, gas), 18);
  assert.equal(Math.round(at(main, bap)), 9000);
  assert.equal(db.prepare("SELECT note FROM stock_moves WHERE type = 'consume' AND ingredient_id = ?").get(gas).note, 'Xuất dùng cho Kho Lẩu');
  assert.equal((await o('POST', `/api/stock/transfers/${tr}/receive`, {})).status, 200);
  assert.equal(at(S['Kho Lẩu'], gas), 0);
  // Cân kiểm ở khu Lẩu: so với Kho tổng, thiếu 300g = lệch định lượng
  assert.equal((await o('POST', '/api/stock/count', { store_id: S['Kho Lẩu'], lines: [{ ingredient_id: bap, actual: 8700 }] })).status, 200);
  assert.equal(Math.round(at(main, bap)), 8700);
  assert.match(db.prepare("SELECT note FROM stock_moves WHERE type = 'waste' AND ingredient_id = ? ORDER BY id DESC").get(bap).note, /Lệch định lượng/);
  // Báo cáo Nhập – Xuất – Tồn chung: bò ở Đồ tươi, gas ở Đồ bình thường
  const x = (await o('GET', '/api/stock/nxt')).data;
  const row = (g, id) => x.groups.find((k) => k.key === g).rows.find((r) => r.id === id);
  const b = row('tuoi', bap);
  assert.deepEqual([b.dau, b.nhap, b.ban, b.xuat, b.lech, b.so, b.cuoi], [0, 10000, 1000, 0, -300, 9000, 8700]);
  assert.equal(b.lech_pct, -30);
  assert.ok(b.over);
  assert.ok(b.lech_tien < 0);
  const g = row('thuong', gas);
  assert.deepEqual([g.nhap, g.xuat, g.cuoi], [24, 6, 18]);
  assert.equal((await o('GET', `/api/stock/nxt/${bap}`)).data.filter((m) => m.kind === 'ban').length, 1);
  const xl = await fetch(base + '/api/stock/nxt.xlsx', { headers: { cookie } });
  assert.equal(xl.status, 200);
});
