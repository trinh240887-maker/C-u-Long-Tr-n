import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('nấu mẻ: trừ nguyên liệu sống theo sổ × số mẻ, cộng thành phẩm theo số cân thật + hạn dùng; huỷ trong ngày trả kho; kế hoạch 3 ngày + phút bếp', async (t) => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES ('Dầu đậu nành', 'ml', 'ml', 1, 59)").run();
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const o = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const tx = (await o('GET', '/api/preps')).data.preps.find((p) => p.name === 'Cốt Tứ Xuyên');
  const dauLine = tx.lines.find((l) => /Dầu đậu nành/.test(l.name));
  const dau = dauLine.ingredient_id;
  const main = db.prepare("SELECT id FROM stores WHERE kind = 'main' ORDER BY id LIMIT 1").get().id;
  db.prepare('INSERT INTO stock_lots (store_id, ingredient_id, qty, received_at) VALUES (?, ?, ?, ?)').run(main, dau, 10000, Date.now());
  const stockOf = (id) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(id).q;

  // Chưa gắn mã thành phẩm → báo
  let r = await o('POST', `/api/preps/${tx.id}/cook`, { batches: 1 });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'no_output');
  r = await o('PATCH', `/api/preps/${tx.id}/output`, { create: true, name: 'Cốt lẩu Tứ Xuyên' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const out = r.data.ingredient_id;

  // Nấu 2 mẻ, cân thật ra 9.600 g, 70 phút
  r = await o('POST', `/api/preps/${tx.id}/cook`, { batches: 2, out_qty: 9600, minutes: 70 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.expected, 10000);
  assert.equal(stockOf(out), 9600);
  assert.equal(stockOf(dau), 10000 - dauLine.qty * 2);
  assert.ok(r.data.skipped.length > 0, 'nguyên liệu chưa có mã kho được báo');
  const lot = db.prepare('SELECT expires_on FROM stock_lots WHERE ingredient_id = ?').get(out);
  assert.ok(lot.expires_on, 'có hạn dùng 5 ngày');
  // NXT: thành phẩm vào Nhập, dầu vào Xuất dùng
  const nxt = (await o('GET', '/api/stock/nxt')).data;
  const rows = nxt.groups.flatMap((g) => g.rows);
  assert.equal(rows.find((x) => x.id === out).nhap, 9600);
  assert.equal(rows.find((x) => x.id === dau).xuat, dauLine.qty * 2);

  // Huỷ mẻ trong ngày → trả kho
  const bid = r.data.id;
  assert.equal((await o('POST', `/api/preps/batches/${bid}/void`)).status, 200);
  assert.equal(stockOf(out), 0);
  assert.equal(stockOf(dau), 10000);

  // Kế hoạch: bán 2.000 g cốt / ngày (35 ngày qua) → 3 ngày (hạn 5) cần 6.000 g − tồn 1.000 → 1 mẻ 5.000 g
  const today = (await o('GET', '/api/me')).data.today || new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const day = (k) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - k); return d.toISOString().slice(0, 10); };
  for (let k = 1; k <= 21; k++) db.prepare("INSERT INTO sale_usage (date, ingredient_id, qty, ref) VALUES (?, ?, 2000, 'sale:x')").run(day(k), out);
  db.prepare('INSERT INTO stock_lots (store_id, ingredient_id, qty, received_at) VALUES (?, ?, ?, ?)').run(main, out, 1000, Date.now());
  const plan = (await o('GET', '/api/preps/plan')).data;
  const it = plan.items.find((x) => x.prep_id === tx.id);
  assert.ok(it, JSON.stringify(plan));
  assert.equal(it.batches, 1); assert.equal(it.station, 'Lẩu');
  assert.ok(it.plan_min >= 30 && plan.total_plan_min >= it.plan_min);
  // Sửa số mẻ + người làm
  const p2 = (await o('PUT', '/api/preps/plan', { prep_id: tx.id, batches: 2, station: 'Lẩu' })).data;
  assert.equal(p2.items.find((x) => x.prep_id === tx.id).batches, 2);
  // Lập lại không đè dòng sửa tay
  const p3 = (await o('POST', '/api/preps/plan/regen')).data;
  assert.equal(p3.items.find((x) => x.prep_id === tx.id).batches, 2);
  // Tick bước (lưu lại, ai tick)
  assert.equal((await o('POST', `/api/preps/plan/${it.id}/tick`, { step: 0 })).status, 200);
  assert.equal((await o('GET', '/api/preps/plan')).data.items.find((x) => x.id === it.id).ticks.length, 1);
  await o('POST', `/api/preps/plan/${it.id}/tick`, { step: 0, done: false });
  assert.equal((await o('GET', '/api/preps/plan')).data.items.find((x) => x.id === it.id).ticks.length, 0);
  // Nấu theo kế hoạch → ghi phút thật
  r = await o('POST', `/api/preps/${tx.id}/cook`, { batches: 1, minutes: 65, plan_id: it.id });
  assert.equal(r.status, 200);
  const p4 = (await o('GET', '/api/preps/plan')).data;
  const it4 = p4.items.find((x) => x.prep_id === tx.id);
  assert.equal(it4.done_batches, 1); assert.equal(it4.done_min, 65);
  assert.equal(p4.total_done_min, 65);
});
