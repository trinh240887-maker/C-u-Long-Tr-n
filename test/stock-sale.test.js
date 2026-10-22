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

test('bán món tự trừ kho theo định lượng: chưa nhập kho thì không khoá; sắp hết báo; hết tự khoá (nêu nguyên liệu); huỷ sớm trả kho; kho tổng bù khu; nhập về tự mở; 22h tổng hợp 1 lần', async (t) => {
  let now = clock.toEpoch(D, 10 * 60);
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ss-')), zaloTransport: { send: async () => {} } });
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
  const meta = (await o('GET', '/api/stock/meta')).data;
  const S = Object.fromEntries(meta.stores.map((s) => [s.name, s.id]));
  const bia = (await o('POST', '/api/stock/ingredients', { name: 'Heineken', unit: 'lon', home_store_id: S['Kho Bar'], purchase_unit: 'thùng', purchase_factor: 24, price: 420000, min_stock: 24, freshness: 'dry' })).data.id;
  const menu = (await o('GET', '/api/menu')).data;
  const H = menu.items.find((x) => x.name === 'Heineken lùn');
  await o('PATCH', `/api/menu/items/${H.id}`, { recipe: [{ ingredient_id: bia, qty: 1 }] });
  const stock = () => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(bia).q;
  const item = async () => (await o('GET', '/api/menu')).data.items.find((x) => x.id === H.id);
  const note = (re) => [...new Set(db.prepare('SELECT title FROM notifications').all().map((x) => x.title))].filter((x) => re.test(x));
  // Chưa từng nhập kho → không theo dõi, không khoá
  assert.equal((await item()).left, null);
  const s = (await o('POST', '/api/pos/sessions', { tables: [1] })).data.id;
  assert.equal((await o('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: H.id, qty: 1 })).status, 200);
  await o('POST', `/api/pos/sessions/${s}/send`);
  assert.equal((await item()).sold_out, false);
  // Nhập 7 lon vào kho Bar
  await o('POST', '/api/stock/receive', { store_id: S['Kho Bar'], lines: [{ ingredient_id: bia, qty: 7 / 24 }] });
  assert.equal((await item()).left, 7);
  // Gọi 3 lon → còn 4 → báo sắp hết
  const s2 = (await o('POST', '/api/pos/sessions', { tables: [2] })).data.id;
  await o('POST', `/api/pos/sessions/${s2}/items`, { menu_item_id: H.id, qty: 3 });
  await o('POST', `/api/pos/sessions/${s2}/send`);
  assert.equal(Math.round(stock()), 4);
  assert.equal(note(/^Sắp hết: Heineken lùn: còn 4 phần/).length, 1);
  // Gọi 5 lon khi còn 4 → hỏi; bếp xác nhận thì cho gọi
  const g = await o('POST', `/api/pos/sessions/${s2}/items`, { menu_item_id: H.id, qty: 5 });
  assert.equal(g.status, 409);
  assert.match(g.data.error, /chỉ còn đủ 4 phần/);
  // Gọi 4 → gửi → hết → tự khoá, nêu nguyên liệu
  const add = await o('POST', `/api/pos/sessions/${s2}/items`, { menu_item_id: H.id, qty: 4 });
  await o('POST', `/api/pos/sessions/${s2}/send`);
  const it = await item();
  assert.equal(it.sold_out, true);
  assert.equal(it.auto_sold_out, true);
  assert.equal(note(/^HẾT MÓN \(app tự khoá\): Heineken lùn \(hết Heineken\)/).length, 1);
  assert.equal((await o('POST', `/api/pos/sessions/${s2}/items`, { menu_item_id: H.id, qty: 1 })).status, 400);
  // Huỷ trong 2 phút → trả 4 lon về kho → tự mở lại
  const line = (await o('GET', `/api/pos/sessions/${s2}`)).data.items.find((x) => x.id === add.data.id);
  assert.equal((await o('POST', `/api/pos/items/${line.id}/cancel`, { reason: 'Khách đổi ý' })).status, 200);
  assert.equal(Math.round(stock()), 4);
  assert.equal((await item()).sold_out, false);
  assert.equal(note(/^Có lại món: Heineken lùn \(4 phần\)/).length, 1);
  // Kho tổng bù khu: nhập 1 thùng vào kho tổng → món còn 4 + 24
  await o('POST', '/api/stock/receive', { store_id: S['Kho tổng'], lines: [{ ingredient_id: bia, qty: 1 }] });
  assert.equal((await item()).left, 28);
  const s3 = (await o('POST', '/api/pos/sessions', { tables: [3] })).data.id;
  await o('POST', `/api/pos/sessions/${s3}/items`, { menu_item_id: H.id, qty: 6 });
  await o('POST', `/api/pos/sessions/${s3}/send`);
  const bar = db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ? AND store_id = ?').get(bia, S['Kho Bar']).q;
  const main = db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ? AND store_id = ?').get(bia, S['Kho tổng']).q;
  assert.equal(Math.round(bar), 0);
  assert.equal(Math.round(main), 22);
  // Kiểm kho khu có định lượng: thiếu = lệch định lượng (không phải "dùng trong ngày")
  await o('POST', '/api/stock/receive', { store_id: S['Kho Bar'], lines: [{ ingredient_id: bia, qty: 10 / 24 }] });
  const c = (await o('POST', '/api/stock/count', { store_id: S['Kho Bar'], lines: [{ ingredient_id: bia, actual: 8 }] })).data;
  assert.match(db.prepare('SELECT note FROM stock_moves WHERE ref = ?').get(`count:${c.count_id}`).note, /Lệch định lượng/);
  // 22:00 tổng hợp hàng cần nhập, chỉ 1 lần / ngày
  now = clock.toEpoch(D, 21 * 60 + 59);
  assert.equal(app.ctx.purchaseReportTick(), null);
  now = clock.toEpoch(D, 22 * 60);
  const rep = app.ctx.purchaseReportTick();
  assert.ok(rep);
  assert.equal(app.ctx.purchaseReportTick(), null);
  assert.equal(note(/^Hàng cần nhập ngày mai/).length, 1);
  // Tắt tính năng → không trừ kho
  await o('PUT', '/api/settings', { sell_deducts_stock: false });
  const before = stock();
  const s4 = (await o('POST', '/api/pos/sessions', { tables: [4] })).data.id;
  await o('POST', `/api/pos/sessions/${s4}/items`, { menu_item_id: H.id, qty: 2 });
  await o('POST', `/api/pos/sessions/${s4}/send`);
  assert.equal(stock(), before);
});
