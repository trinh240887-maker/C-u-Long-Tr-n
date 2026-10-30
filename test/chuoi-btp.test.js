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
});
