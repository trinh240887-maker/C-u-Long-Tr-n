import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('so sánh giá NCC: chỉ chủ xem; NCC rẻ nhất theo giá gần nhất; bỏ bill huỷ / chưa quy đổi; ước tính tiết kiệm', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const teams = (await o('GET', '/api/teams')).data;
  const cr = await o('POST', '/api/staff', { name: 'QL', role: 'manager', team_id: teams[0].id, pin: '737151' });
  assert.equal(cr.status, 200, JSON.stringify(cr.data));
  const ql = mk(); await ql('POST', '/api/login', { pin: '737151' }); await ql('POST', '/api/me/pin', { current_pin: '7371', new_pin: '8371' });
  assert.equal((await ql('GET', '/api/purchases/compare')).status, 403);

  const sup = (n) => Number(db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(n).lastInsertRowid);
  const A = sup('Rau Cô Ba'), B = sup('Rau Chợ Lớn');
  const ing = Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES ('Cải thảo', 'g', 'kg', 1000, 20000)").run().lastInsertRowid);
  const today = app.ctx.today();
  const bill = (s, name, price, qty, status = 'approved', billUnit = null) => {
    const id = Number(db.prepare('INSERT INTO purchase_bills (supplier_id, supplier_name, date, total, status, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(s, name, today, price * qty, status, Date.now()).lastInsertRowid);
    db.prepare('INSERT INTO purchase_bill_lines (bill_id, ingredient_id, name, qty, price, amount, bill_unit) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, ing, 'Cải thảo', qty, price, price * qty, billUnit);
  };
  bill(A, 'Rau Cô Ba', 22000, 10);
  bill(A, 'Rau Cô Ba', 24000, 10);          // lần gần nhất của A
  bill(B, 'Rau Chợ Lớn', 21000, 5);
  bill(B, 'Rau Chợ Lớn', 1000, 50, 'void'); // bill huỷ: bỏ
  bill(B, 'Rau Chợ Lớn', 500, 3, 'approved', 'mẹt'); // chưa quy đổi: bỏ

  const r = await o('GET', '/api/purchases/compare?days=30');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const it = r.data.items.find((x) => x.id === ing);
  assert.equal(it.unit, 'kg');
  assert.equal(it.suppliers.length, 2);
  assert.equal(it.best_name, 'Rau Chợ Lớn');
  const a = it.suppliers.find((s) => s.name === 'Rau Cô Ba');
  assert.deepEqual([a.last_price, a.min, a.max, a.avg, a.n, a.qty], [24000, 22000, 24000, 23000, 2, 10 + 10]);
  const b = it.suppliers.find((s) => s.name === 'Rau Chợ Lớn');
  assert.deepEqual([b.last_price, b.min, b.n], [21000, 21000, 1]);
  // Đã chi 460k + 105k = 565k; nếu mua 25kg giá 21k = 525k → tiết kiệm 40k
  assert.equal(it.save, 40000);
  assert.equal(it.spread, 14);
  assert.equal(r.data.total_save, 40000);
});
