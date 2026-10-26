import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { readBill } from '../server/lib/bill-reader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMG = `data:image/jpeg;base64,${Buffer.alloc(900, 7).toString('base64')}`;

test('đọc bill: gửi đúng khuôn Claude API (ảnh base64, json_schema, fallbacks), xử lý lỗi tiền / mã sai, lọc id lạ', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  let sent;
  const reply = { stop_reason: 'end_turn', usage: { input_tokens: 3000, output_tokens: 400 }, content: [{ type: 'text', text: JSON.stringify({ supplier_name: 'Sạp thịt Kim Thanh Ngọc', signer_name: 'Phát', total: 2150000, note: '', lines: [{ ingredient_id: 1, name: 'Thăn', unit: 'kg', qty: 5, price: 280000 }, { ingredient_id: 999, name: 'Gân', unit: 'kg', qty: 2.5, price: 300000 }] }) }] };
  const fetchImpl = async (url, opts) => { sent = { url, opts, body: JSON.parse(opts.body) }; return { status: 200, json: async () => reply }; };
  const out = await readBill([IMG], [{ id: 1, name: 'Thăn bò tươi', unit: 'g', purchase_unit: 'kg' }], { fetchImpl });
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.opts.headers['x-api-key'], 'sk-test');
  assert.equal(sent.opts.headers['anthropic-version'], '2026-10-21');
  assert.equal(sent.opts.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(sent.body.model, 'claude-opus-5-5');
  assert.equal(sent.body.fallbacks, 'default');
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.deepEqual(sent.body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMG.split(',')[1] } });
  assert.match(sent.body.messages[0].content[1].text, /1: Thăn bò tươi \(kg\)/);
  assert.deepEqual(out.lines.map((l) => [l.ingredient_id, l.qty, l.price]), [[1, 5, 280000], [null, 2.5, 300000]]);
  await assert.rejects(readBill([IMG], [], { fetchImpl: async () => ({ status: 401, json: async () => ({}) }) }), /Mã Claude sai/);
  await assert.rejects(readBill([IMG], [], { fetchImpl: async () => ({ status: 400, json: async () => ({ error: { message: 'Your credit balance is too low' } }) }) }), /hết tiền/);
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(readBill([IMG], []), /Chưa cài/);
});

test('đọc bill qua app: nhân viên bấm Đọc bill → khớp NCC + hàng kho, báo đơn vị lệch, giới hạn số lần / ngày', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'br-')), zaloTransport: { send: async () => {} } });
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
  assert.equal((await o('GET', '/api/purchases')).data.bill_reader, false);
  db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, active) VALUES ('Thăn bò tươi', 'g', 'kg', 1000, 1)").run();
  const g = db.prepare("SELECT id, name, unit, purchase_unit FROM ingredients WHERE name = 'Thăn bò tươi'").get();
  db.prepare("INSERT INTO suppliers (name) VALUES ('Sạp thịt Kim Thanh Ngọc')").run();
  app.ctx.readBill = async (photos, ings) => {
    assert.equal(photos.length, 1); assert.ok(ings.length > 0);
    return { supplier_name: 'SẠP THỊT KIM THANH NGỌC', signer_name: 'Phát', total: 500000, note: 'dòng 2 mờ', lines: [{ ingredient_id: g.id, name: 'thăn', unit: 'thùng', qty: 2, price: 250000 }, { ingredient_id: null, name: 'Đá cây', unit: 'cây', qty: 1, price: 0 }] };
  };
  const r = await o('POST', '/api/purchases/read-bill', { photos: [IMG] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.supplier_id);
  assert.equal(r.data.lines[0].name, g.name);
  assert.equal(r.data.lines[0].unit_mismatch, (g.purchase_unit || g.unit) !== 'thùng');
  assert.equal(r.data.lines[1].ingredient_id, null);
  assert.equal(r.data.note, 'dòng 2 mờ');
  // Quy đổi: bill ghi "két", kho tính chai / mua theo thùng 12 chai → hỏi 1 két = ? chai, nhập 1 lần, lần sau tự đổi
  db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, active) VALUES ('Nước suối 500 ml', 'chai', 'thùng', 12, 1)").run();
  const ns = db.prepare("SELECT id FROM ingredients WHERE name = 'Nước suối 500 ml'").get().id;
  app.ctx.readBill = async () => ({ supplier_name: 'Swire Coca-Cola', total: 1361120, lines: [{ ingredient_id: ns, name: 'Dasani 500', unit: 'Két', qty: 20, price: 68056 }, { ingredient_id: ns, name: 'Dasani lẻ', unit: 'chai', qty: 24, price: 2900 }] });
  let rb = (await o('POST', '/api/purchases/read-bill', { photos: [IMG] })).data;
  assert.equal(rb.lines[0].need_factor, true);
  assert.equal(rb.lines[0].bill_unit, 'Két');
  assert.deepEqual([rb.lines[1].qty, rb.lines[1].price, rb.lines[1].need_factor], [2, 34800, false]); // bill ghi chai → đổi ra thùng
  const st = (await o('GET', '/api/stock/meta')).data.stores.find((x) => x.kind === 'main').id;
  const sv = await o('POST', '/api/purchases', { store_id: st, supplier_name: 'Swire Coca-Cola', signer_name: 'Phát', photos: [IMG], lines: [{ ingredient_id: ns, qty: 40, price: 34028 }], conversions: [{ ingredient_id: ns, bill_unit: 'Két', factor: 24 }] });
  assert.equal(sv.status, 200, JSON.stringify(sv.data));
  // Huỷ bill nhập sai → trừ lại hàng đã cộng vào kho
  const { stockQty } = await import('../server/lib/stock.js');
  const before = stockQty(db, st, ns);
  const sv2 = (await o('POST', '/api/purchases', { store_id: st, supplier_name: 'Tạp hoá Hiền', signer_name: 'Phát', photos: [IMG], lines: [{ ingredient_id: ns, qty: 2, price: 34028 }] })).data;
  assert.ok(stockQty(db, st, ns) > before);
  assert.equal((await o('POST', `/api/purchases/${sv2.id}/void`, {})).status, 400); // cần lý do
  assert.equal((await o('POST', `/api/purchases/${sv2.id}/void`, { reason: 'Nhập sai giá' })).data.status, 'void');
  assert.equal(stockQty(db, st, ns), before);
  rb = (await o('POST', '/api/purchases/read-bill', { photos: [IMG] })).data;
  assert.deepEqual([rb.lines[0].need_factor, rb.lines[0].factor, rb.lines[0].qty, rb.lines[0].price], [false, 24, 40, 34028]); // 20 két × 24 = 480 chai = 40 thùng
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('bill_reader_daily_max', '1')").run();
  assert.equal((await o('POST', '/api/purchases/read-bill', { photos: [IMG] })).status, 429);
  assert.equal((await o('POST', '/api/purchases/read-bill', { photos: [] })).status, 400);
});

test('mã Claude / token Zalo Bot: chủ quán dán trong app, chỉ hiện 4 ký tự cuối, quản lý không đổi được', async (t) => {
  delete process.env.ANTHROPIC_API_KEY;
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const r = await o('PUT', '/api/settings', { anthropic_api_key: 'sk-ant-abc123WXYZ' });
  assert.equal(r.status, 200);
  assert.equal(r.data.anthropic_api_key, '••••WXYZ');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get().value, 'sk-ant-abc123WXYZ');
  assert.equal((await o('GET', '/api/purchases')).data.bill_reader, true);
  // Gửi lại chuỗi đã che → giữ nguyên mã cũ
  await o('PUT', '/api/settings', { anthropic_api_key: '••••WXYZ' });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get().value, 'sk-ant-abc123WXYZ');
  const team = (await o('GET', '/api/teams')).data[0].id;
  await o('POST', '/api/staff', { name: 'QL', role: 'manager', team_id: team, pin: '736511' });
  const m = mk();
  await m('POST', '/api/login', { pin: '736511' });
  await m('POST', '/api/me/pin', { current_pin: '736511', new_pin: '836512' });
  assert.equal((await m('PUT', '/api/settings', { zalo_bot_token: 'abc' })).status, 403);
});
