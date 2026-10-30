import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('chuỗi bán thành phẩm: nồi lẩu bán → cốt + nước dùng cần nấu; sốt steak bình quân chia đều các sốt → cốt gia vị; bước có số cân', async (t) => {
  const db = openDb(':memory:');
  const ngan = Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES ('Ngăn nước lẩu Mala Tứ Xuyên', 'ngăn', 'ngăn', 1, 0)").run().lastInsertRowid);
  const steak = Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES ('Sốt steak bình quân 4 sốt', 'g', 'g', 1, 0)").run().lastInsertRowid);
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const o = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const preps = (await o('GET', '/api/preps')).data.preps;
  const by = (re) => preps.find((p) => re.test(p.name));
  assert.equal(by(/^Pha 1 nồi — Tứ Xuyên/).output_ingredient_id, ngan, 'pha 1 nồi Tứ Xuyên ↔ ngăn lẩu');
  assert.equal(by(/^Hoàng Kim — sốt pha/).output_ingredient_id, steak, 'sốt pha → sốt steak bình quân');
  const cot = by(/^Cốt Tứ Xuyên$/), heo = by(/Nước hầm xương heo/);
  const pha = by(/^Pha 1 nồi — Tứ Xuyên/);
  assert.equal(pha.lines.find((l) => /^Cốt Tứ Xuyên/.test(l.name)).ingredient_id, cot.output_ingredient_id);
  assert.equal(pha.lines.find((l) => /Nước dùng heo/.test(l.name)).ingredient_id, heo.output_ingredient_id);
  const trung = by(/^Pha 1 nồi — Trứng muối/);
  assert.equal(trung.lines.find((l) => /^Cốt K kim thang/.test(l.name)).ingredient_id, by(/^Cốt K kim thang/).output_ingredient_id, 'không gắn nhầm "Muối"');

  // Bán 10 nồi Tứ Xuyên / ngày, 500 g sốt steak / ngày (21 ngày qua)
  const today = (await o('GET', '/api/me')).data.today;
  const day = (k) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - k); return d.toISOString().slice(0, 10); };
  for (let k = 1; k <= 21; k++) {
    db.prepare("INSERT INTO sale_usage (date, ingredient_id, qty, ref) VALUES (?, ?, 10, 'sale:x')").run(day(k), ngan);
    db.prepare("INSERT INTO sale_usage (date, ingredient_id, qty, ref) VALUES (?, ?, 500, 'sale:y')").run(day(k), steak);
  }
  const plan = (await o('GET', '/api/preps/plan')).data;
  const it = (id) => plan.items.find((x) => x.prep_id === id);
  // Cốt: 3 ngày × 10 nồi × 125 g = 3.750 g → 1 mẻ 5 kg; nước dùng heo: 30 × 875 ml = 26.250 → 2 mẻ 15 kg
  assert.equal(it(cot.id)?.batches, 1, JSON.stringify(plan.items.map((x) => [x.name, x.batches])));
  assert.equal(it(heo.id)?.batches, 2);
  assert.equal(it(heo.id).station, 'Lẩu');
  // Sốt steak: 1.500 g / 5 sốt = 300 g mỗi sốt → 1 mẻ mỗi sốt; Hoàng Kim pha cần cốt gia vị → 1 liều
  const hk = by(/^Hoàng Kim — sốt pha/), hkc = by(/^Hoàng Kim — cốt gia vị/);
  assert.equal(it(hk.id)?.batches, 1);
  assert.equal(it(hkc.id)?.batches, 1);
  assert.equal(it(hk.id).station, 'Steak');
  // Nguyên liệu cần lấy + số cân dưới từng bước
  const s1 = it(cot.id);
  assert.ok(s1.lines.length > 10);
  assert.ok(s1.steps.some((s) => s.uses.some((u) => /Gừng/.test(u.name))));

  // Bán 2 phần lẩu Mala (định lượng: 1 ngăn + 10 g hành lá topping) → trừ 2 × (125 g cốt + 875 ml nước dùng heo), không trừ ngăn / topping của sổ
  const main = db.prepare("SELECT id FROM stores WHERE kind = 'main' ORDER BY id LIMIT 1").get().id;
  const hanh = Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES ('Hành lá test', 'g', 'g', 1, 0)").run().lastInsertRowid);
  for (const id of [cot.output_ingredient_id, heo.output_ingredient_id, hanh]) db.prepare('INSERT INTO stock_lots (store_id, ingredient_id, qty, received_at) VALUES (?, ?, 10000, 0)').run(main, id);
  const lau = Number(db.prepare("INSERT INTO menu_items (name, price) VALUES ('Lẩu Mala Tứ Xuyên', 300000)").run().lastInsertRowid);
  db.prepare('INSERT INTO menu_recipes (item_id, ingredient_id, qty) VALUES (?, ?, 1), (?, ?, 10)').run(lau, ngan, lau, hanh);
  app.ctx.consumeSale(null, [{ id: 9001, menu_item_id: lau, qty: 2, name: 'Lẩu Mala Tứ Xuyên' }]);
  const left = (id) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(id).q;
  assert.equal(left(cot.output_ingredient_id), 10000 - 250);
  assert.equal(left(heo.output_ingredient_id), 10000 - 1750);
  assert.equal(left(hanh), 10000 - 20, 'topping theo định lượng món');
  // Dự báo vẫn đếm theo số ngăn bán; cốt không đếm thêm phần tách ra
  assert.equal(db.prepare("SELECT SUM(qty) AS q FROM sale_usage WHERE ingredient_id = ? AND ref = 'sale:9001'").get(ngan).q, 2);
  assert.equal(db.prepare("SELECT via FROM sale_usage WHERE ingredient_id = ? AND ref = 'sale:9001'").get(cot.output_ingredient_id).via, ngan);
  // Huỷ món → trả lại kho
  app.ctx.restoreSale(null, { id: 9001, menu_item_id: lau, name: 'Lẩu Mala Tứ Xuyên' });
  assert.equal(left(cot.output_ingredient_id), 10000);

  // Giữ công thức: phục vụ không xem được sổ / việc nấu; bếp xem việc nấu, không xem cả sổ
  const team = (n) => db.prepare('SELECT id FROM teams WHERE name = ?').get(n)?.id ?? Number(db.prepare('INSERT INTO teams (name) VALUES (?)').run(n).lastInsertRowid);
  await o('POST', '/api/staff', { name: 'PV', team_id: team('Phục vụ'), role: 'staff', pin: '4821' });
  await o('POST', '/api/staff', { name: 'Bep', team_id: team('Bếp steak'), role: 'staff', pin: '5932' });
  cookie = null; await o('POST', '/api/login', { pin: '4821' });
  assert.equal((await o('GET', '/api/preps')).status, 403);
  assert.equal((await o('GET', '/api/preps/plan')).status, 403);
  cookie = null; await o('POST', '/api/login', { pin: '5932' });
  assert.equal((await o('GET', '/api/preps')).status, 403);
  assert.equal((await o('GET', '/api/preps/plan')).status, 200);
});
