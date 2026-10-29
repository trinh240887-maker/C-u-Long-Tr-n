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
const IMG = `data:image/jpeg;base64,${Buffer.alloc(3000, 9).toString('base64')}`;

test('bill NCC gửi trước: chủ quán áp bill (kho chưa cộng) → bếp nhận đủ: cộng kho + tự duyệt; nhận thiếu: chờ thu ngân duyệt', async (t) => {
  const clock = makeClock({ offset: '+07:00' });
  let now = clock.toEpoch('2026-10-28', 10 * 60);
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cn-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }; };
  const login = async (pin, np) => { const c = mk(); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
  const o = await login(DEFAULT_OWNER_PIN, '582914');
  const teams = (await o('GET', '/api/teams')).data;
  await o('POST', '/api/staff', { name: 'Tài', role: 'staff', team_id: teams.find((x) => x.name === 'Lẩu').id, pin: '736251' });
  const tai = await login('736251', '918271');
  const lau = (await o('GET', '/api/stock/meta')).data.stores.find((s) => s.name === 'Kho Lẩu');
  const bo = (await o('POST', '/api/stock/ingredients', { name: 'Bò bắp', unit: 'g', freshness: 'fresh', home_store_id: lau.id, purchase_unit: 'kg', purchase_factor: 1000, price: 260000 })).data.id;
  const qty = () => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(bo).q;
  const pre = { pre_bill: true, store_id: lau.id, supplier_name: 'Sạp bò A', signer_name: 'Chủ', photos: [IMG], lines: [{ ingredient_id: bo, qty: 10, price: 260000 }] };
  // Nhân viên không áp bill trước được
  assert.equal((await tai('POST', '/api/purchases', pre)).status, 403);
  // Trưởng ca mặc định cũng không; chủ quán tick riêng → được
  const sl = (await o('POST', '/api/staff', { name: 'Hà', role: 'shift_lead', team_id: teams.find((x) => x.name === 'Thu ngân').id, pin: '736259' })).data;
  const ha = await login('736259', '918279');
  assert.equal((await ha('POST', '/api/purchases', pre)).status, 403);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('perm_user', ?)").run(JSON.stringify({ [sl.id]: { 'mh.apbill': true } }));
  const bx = (await ha('POST', '/api/purchases', pre)).data;
  assert.equal(bx.status, 'waiting');
  assert.equal((await o('POST', `/api/purchases/${bx.id}/void`, { reason: 'thử' })).status, 200);
  const b1 = (await o('POST', '/api/purchases', pre)).data;
  assert.equal(b1.status, 'waiting');
  assert.equal(qty(), 0);
  let L = (await tai('GET', '/api/purchases')).data;
  assert.equal(L.arriving.length, 1);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE title LIKE 'Hàng sắp về%'").get());
  // Chưa có công nợ
  assert.equal((await o('GET', '/api/suppliers/debts')).data.total, 0);
  // Thiếu ảnh hàng → chặn
  assert.equal((await tai('POST', `/api/purchases/${b1.id}/arrive`, {})).status, 400);
  const r1 = await tai('POST', `/api/purchases/${b1.id}/arrive`, { goods_photos: [IMG] });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.status, 'approved');
  assert.equal(qty(), 10000);
  assert.equal((await o('GET', '/api/suppliers/debts')).data.total, 2_600_000);
  const ob = (await o('GET', '/api/suppliers/debts')).data.suppliers.flatMap((x) => x.open_bills || []).find((x) => x.id === b1.id);
  assert.ok(ob.photos.length >= 1 && ob.lines.length === 1); // phiếu còn nợ kèm ảnh bill + món
  assert.equal((await tai('POST', `/api/purchases/${b1.id}/arrive`, { goods_photos: [IMG] })).status, 400);
  // Lần 2: nhận thiếu 2 kg → chờ duyệt, có cờ
  const b2 = (await o('POST', '/api/purchases', pre)).data;
  const r2 = await tai('POST', `/api/purchases/${b2.id}/arrive`, { goods_photos: [IMG], lines: [{ id: b2.lines[0].id, qty: '8' }] });
  assert.equal(r2.data.status, 'received');
  assert.ok(r2.data.flags.some((f) => /Nhận thiếu: Bò bắp: bill 10 kg, nhận 8 kg/.test(f)));
  assert.equal(qty(), 18000);
  // Lần 3: huỷ bill chờ nhận → kho không bị trừ
  const b3 = (await o('POST', '/api/purchases', pre)).data;
  assert.equal((await o('POST', `/api/purchases/${b3.id}/void`, { reason: 'NCC không giao' })).status, 200);
  assert.equal(qty(), 18000);
  L = (await tai('GET', '/api/purchases')).data;
  assert.equal(L.arriving.length, 0);
  // Tắt riêng "Xem bill đã nhận" của Tài: danh sách bị chặn nhưng màn Nhập kho vẫn mở được qua /info (chủ quán 29/10)
  const taiId = db.prepare("SELECT id FROM staff WHERE name = 'Tài'").get().id;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('perm_user', ?)").run(JSON.stringify({ [taiId]: { 'mh.xem': false } }));
  assert.equal((await tai('GET', '/api/purchases')).status, 403);
  const info = await tai('GET', '/api/purchases/info');
  assert.equal(info.status, 200); assert.equal(info.data.limited, true);
  db.prepare("DELETE FROM settings WHERE key = 'perm_user'").run();
  // Nhắc: bill chờ nhận quá 1 ngày → báo 1 lần / ngày
  await o('POST', '/api/purchases', pre);
  const nRem = () => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE '⏳ Bill%'").get().n;
  app.ctx.arriveRemindTick();
  assert.equal(nRem(), 0);
  now += 25 * 3600e3;
  app.ctx.arriveRemindTick();
  const k = nRem();
  assert.ok(k > 0);
  now += 3600e3;
  app.ctx.arriveRemindTick();
  assert.equal(nRem(), k);
});
