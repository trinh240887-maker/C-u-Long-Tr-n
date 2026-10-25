import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';
import { addLot, stockQty } from '../server/lib/stock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });

async function setup(t, start) {
  let now = start;
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const sent = [];
  app.ctx.notify = (ids, msg) => { sent.push({ ids: [].concat(ids), ...msg }); };
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  return { db, app, mk, sent, setNow: (ms) => { now = ms; } };
}

test('kiểm nguyên liệu cuối ngày: lệch so với định lượng ≥ 200.000đ → báo chủ; 22:30 chưa kiểm → nhắc', async (t) => {
  const { db, app, sent, setNow } = await setup(t, clock.toEpoch('2026-10-25', 20 * 60));
  const { ctx } = app;
  const bep = db.prepare("SELECT * FROM stores WHERE kind = 'area' ORDER BY id LIMIT 1").get();
  const bar = db.prepare("SELECT * FROM stores WHERE kind = 'area' ORDER BY id DESC LIMIT 1").get();
  const ing = Number(db.prepare("INSERT INTO ingredients (name, unit, home_store_id, purchase_factor, price) VALUES ('Thăn bò test', 'g', ?, 1000, 450000)").run(bep.id).lastInsertRowid);
  const ing2 = Number(db.prepare("INSERT INTO ingredients (name, unit, home_store_id, purchase_factor, price) VALUES ('Siro test', 'ml', ?, 1000, 100000)").run(bar.id).lastInsertRowid);
  const item = db.prepare('SELECT id FROM menu_items LIMIT 1').get().id;
  db.prepare('INSERT OR REPLACE INTO menu_recipes (item_id, ingredient_id, qty) VALUES (?, ?, 200), (?, ?, 30)').run(item, ing, item, ing2);
  addLot(db, { storeId: bep.id, ingredientId: ing, qty: 5000, at: ctx.now() });
  const owner = ctx.staff(db.prepare("SELECT id FROM staff WHERE role = 'owner'").get().id);
  const lead = Number(db.prepare("INSERT INTO staff (name, role, team_id, created_at) VALUES ('Tổ trưởng bếp', 'team_lead', ?, 0)").run(bep.team_id).lastInsertRowid);

  // Thiếu 300g ≈ 135.000đ: dưới ngưỡng → không báo
  ctx.stockCount(ctx.staff(lead), bep.id, [{ ingredient_id: ing, actual: 4700 }]);
  assert.equal(sent.filter((x) => /Lệch kho/.test(x.title)).length, 0);
  // Thiếu thêm 600g ≈ 270.000đ → báo chủ
  const r = ctx.stockCount(ctx.staff(lead), bep.id, [{ ingredient_id: ing, actual: 4100 }]);
  assert.equal(r.lech_total, 270000);
  const a = sent.find((x) => /Lệch kho/.test(x.title));
  assert.ok(a && a.ids.includes(owner.id));
  assert.match(a.body, /Thăn bò test: −600 g ≈ 270\.000đ/);
  assert.equal(stockQty(db, bep.id, ing), 4100);

  // 22:30: Bếp đã kiểm hôm nay, Bar chưa → chỉ nhắc Bar, 1 lần
  ctx.stockCountRemindTick();
  assert.equal(sent.filter((x) => /Chưa kiểm/.test(x.title)).length, 0);
  setNow(clock.toEpoch('2026-10-25', 22 * 60 + 31));
  ctx.stockCountRemindTick();
  ctx.stockCountRemindTick();
  const rm = sent.filter((x) => /Chưa kiểm/.test(x.title));
  assert.equal(rm.length, 1);
  assert.match(rm[0].title, new RegExp(bar.name));
});

test('đồ dùng: báo vỡ trừ sổ, kiểm tuần ra "mất không rõ", nhắc Chủ nhật 21h', async (t) => {
  const { db, app, mk, sent, setNow } = await setup(t, clock.toEpoch('2026-10-25', 15 * 60)); // CN
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const id = (await o('POST', '/api/utensils', { name: 'Chén test' })).data.id;
  await o('PATCH', `/api/utensils/${id}`, { on_hand: 100 });
  const pv = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Phục vụ');
  await o('POST', '/api/staff', { name: 'Lan', team_id: pv.id, pin: '4821' });
  const L = mk();
  await L('POST', '/api/login', { pin: '4821' });
  assert.equal((await L('POST', `/api/utensils/${id}/break`, { qty: 3, who: 'Lan', note: 'rơi khi bưng' })).status, 200);
  assert.equal(db.prepare('SELECT on_hand FROM utensils WHERE id = ?').get(id).on_hand, 97);
  assert.ok(sent.some((x) => /Vỡ 3 cái Chén test/.test(x.title)));
  assert.equal((await L('POST', '/api/utensils/count', { lines: [{ utensil_id: id, actual: 90 }] })).status, 403); // nhân viên không kiểm
  // Nhắc CN 21h khi chưa kiểm
  setNow(clock.toEpoch('2026-10-25', 21 * 60 + 5));
  app.ctx.utensilCountTick();
  assert.ok(sent.some((x) => /Đến hạn kiểm đồ dùng/.test(x.title)));
  const c = (await o('POST', '/api/utensils/count', { lines: [{ utensil_id: id, actual: 92 }] })).data;
  assert.deepEqual(c.lines[0], { utensil_id: id, name: 'Chén test', unit: 'cái', expected: 97, actual: 92, diff: -5 });
  const rep = (await L('GET', '/api/utensils/report')).data;
  assert.equal(rep.due, false);
  assert.deepEqual(rep.moves.map((m) => [m.type, m.qty]), [['count', -5], ['break', -3]]);
});
