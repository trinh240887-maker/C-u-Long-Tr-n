import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMG = `data:image/jpeg;base64,${Buffer.alloc(1200, 7).toString('base64')}`;

test('Đặt hàng qua nhóm Zalo NCC: @bot ghi đơn chờ nhận → nhận hàng → bot báo thiếu / đủ vào đúng nhóm', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const sent = [];
  let inbox = [];
  const zaloBot = { ready: () => true, send: async (chat, text) => { sent.push({ chat, text }); }, sendPhoto: async () => {}, call: async () => ({}), chats: async () => [], updates: async () => { const x = inbox; inbox = []; return x; } };
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} }, zaloBot });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const { ctx } = app;
  ctx.saveStaffGroups([{ id: 'g', name: 'Nhân viên', teams: [] }]);
  const meta = (await O('GET', '/api/stock/meta')).data;
  const lau = meta.stores.find((s) => s.name === 'Kho Lẩu') || meta.stores[0];
  const ncc = (await O('POST', '/api/stock/suppliers', { name: 'Sạp thịt Kim Thanh Ngọc', phone: '0949336552' })).data.id;
  const than = (await O('POST', '/api/stock/ingredients', { name: 'Thăn bò', unit: 'g', freshness: 'fresh', home_store_id: lau.id, supplier_id: ncc, purchase_unit: 'kg', purchase_factor: 1000, price: 300000 })).data.id;
  const bap = (await O('POST', '/api/stock/ingredients', { name: 'Bắp hoa', unit: 'g', freshness: 'fresh', home_store_id: lau.id, supplier_id: ncc, purchase_unit: 'kg', purchase_factor: 1000, price: 245000 })).data.id;

  inbox = [{ id: 'm1', date: Date.now(), chat: { id: 's1', type: 'GROUP', name: 'CLT - Sạp thịt Kim Thanh Ngọc' }, from: { id: 'uOwner', name: 'Chủ' }, text: '@bot thăn bò 10kg, bắp hoa 5kg, sả 2 bó' }];
  await ctx.zaloBotPoll();
  const r1 = sent.at(-1);
  assert.equal(r1.chat, 's1');
  assert.match(r1.text, /Đơn #\d+ · Sạp thịt Kim Thanh Ngọc/);
  assert.match(r1.text, /Thăn bò: 10 kg/);
  assert.match(r1.text, /Chưa có trong kho.*sả/);
  assert.match(r1.text, /CHƯA nhận/);
  const po = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC').get();
  assert.equal(po.status, 'approved');
  assert.equal(po.zalo_chat, 's1');
  assert.equal(db.prepare('SELECT qty FROM po_lines WHERE po_id = ? AND ingredient_id = ?').get(po.id, bap).qty, 5);

  // Nhận theo đơn: bắp hoa thiếu 1kg → bot báo vào nhóm s1
  const rec = await O('POST', '/api/purchases', { po_id: po.id, signer_name: 'Phát', total: 10 * 300000 + 4 * 245000, photos: [IMG], lines: [{ ingredient_id: than, qty: 10, price: 300000 }, { ingredient_id: bap, qty: 4, price: 245000 }] });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  await new Promise((r) => setTimeout(r, 50));
  const r2 = sent.at(-1);
  assert.equal(r2.chat, 's1');
  assert.match(r2.text, /Đơn #\d+ · Sạp thịt Kim Thanh Ngọc đã nhận/);
  assert.match(r2.text, /✓ Thăn bò: đủ 10 kg/);
  assert.match(r2.text, /Bắp hoa: THIẾU 1 kg \(đặt 5, nhận 4\)/);
  // Tin thường trong nhóm NCC (không phải đơn) → bot im lặng
  const n = sent.length;
  inbox = [{ id: 'm2', date: Date.now(), chat: { id: 's1', type: 'GROUP', name: 'CLT - Sạp thịt Kim Thanh Ngọc' }, from: { id: 'uOwner', name: 'Chủ' }, text: '@bot cảm ơn' }];
  await ctx.zaloBotPoll();
  assert.equal(sent.length, n);
  assert.equal((await O('GET', '/api/zalo-bot/supplier-groups')).data.groups[0].supplier_id, ncc);
});
