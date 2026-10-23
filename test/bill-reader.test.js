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
  await assert.rejects(readBill([IMG], [], { fetchImpl: async () => ({ status: 401, json: async () => ({}) }) }), /ANTHROPIC_API_KEY sai/);
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
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('bill_reader_daily_max', '1')").run();
  assert.equal((await o('POST', '/api/purchases/read-bill', { photos: [IMG] })).status, 429);
  assert.equal((await o('POST', '/api/purchases/read-bill', { photos: [] })).status, 400);
});
