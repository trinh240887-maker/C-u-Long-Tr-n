import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('nhóm kho theo loại hàng: tự xếp theo tên, đổi nhóm tay, sửa danh sách nhóm, NXT chia theo nhóm', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const o = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const mk = (name, unit = 'kg') => Number(db.prepare('INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price) VALUES (?, ?, ?, 1, 1000)').run(name, unit, unit).lastInsertRowid);
  const ids = { uc: mk('Thăn ngoại bò Úc'), gau: mk('Gầu bò'), coca: mk('Coca lon 320 ml', 'lon'), ly: mk('Ly nhựa + nắp + ống hút', 'cái'), cai: mk('Cải thảo'), cot: mk('Ngăn nước lẩu Mala Tứ Xuyên', 'phần'), olong: mk('Ô long (OL) pha sẵn', 'ml') };
  const meta = async () => (await o('GET', '/api/stock/meta')).data;
  const catOf = (m, id) => m.ingredients.find((x) => x.id === id).cat_eff;
  let m = await meta();
  assert.deepEqual([catOf(m, ids.uc), catOf(m, ids.gau), catOf(m, ids.coca), catOf(m, ids.ly), catOf(m, ids.cai), catOf(m, ids.cot)], ['bo_nk', 'bo_tuoi', 'douong', 'dodung', 'rau', 'lau']);
  assert.notEqual(catOf(m, ids.olong), 'douong'); // "ô long" không phải "lon"
  // Đổi nhóm tay; null → app tự xếp lại
  assert.equal((await o('POST', '/api/stock/ingredients/cat', { id: ids.gau, cat: 'lau' })).status, 200);
  m = await meta();
  assert.equal(catOf(m, ids.gau), 'lau'); assert.equal(m.ingredients.find((x) => x.id === ids.gau).cat_auto, false);
  await o('POST', '/api/stock/ingredients/cat', { id: ids.gau, cat: null });
  assert.equal(catOf(await meta(), ids.gau), 'bo_tuoi');
  assert.equal((await o('POST', '/api/stock/ingredients/cat', { id: ids.gau, cat: 'khong_co' })).status, 400);
  // Sửa danh sách nhóm
  const cats = [...m.cats.map((c) => (c.key === 'rau' ? { ...c, label: 'Rau củ quả' } : c)), { key: '', label: 'Nhóm thử' }];
  const pc = await o('PUT', '/api/stock/cats', { cats });
  assert.equal(pc.status, 200, JSON.stringify(pc.data));
  m = await meta();
  assert.equal(m.cats.find((c) => c.key === 'rau').label, 'Rau củ quả');
  assert.ok(m.cats.some((c) => c.label === 'Nhóm thử'));
  // NXT chia theo nhóm (có phát sinh mới hiện)
  db.prepare("INSERT INTO stock_moves (at, date, type, ingredient_id, to_store, qty, cost, ref) VALUES (?, ?, 'receive', ?, (SELECT id FROM stores LIMIT 1), 5, 5000, 'x')").run(Date.now(), app.ctx.today(), ids.uc);
  const nx = (await o('GET', '/api/stock/nxt')).data;
  assert.ok(nx.groups.find((g) => g.key === 'bo_nk').rows.some((r) => r.id === ids.uc));
});
