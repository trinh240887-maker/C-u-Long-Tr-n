import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMG = 'data:image/jpeg;base64,' + Buffer.alloc(300, 7).toString('base64');

test('nhập từ ảnh menu: món cũ xếp theo thứ tự menu, món mới thêm vào đúng danh mục + điểm in, giá khác chỉ đổi khi chọn, món không có trên menu chỉ ẩn khi tick', async (t) => {
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
  const st = Number(db.prepare("INSERT INTO kitchen_stations (name, sort) VALUES ('Bếp thử', 99)").run().lastInsertRowid);
  const cat = Number(db.prepare("INSERT INTO menu_categories (name, sort) VALUES ('Thử Steak', 99)").run().lastInsertRowid);
  const mk = (name, price, sort) => Number(db.prepare('INSERT INTO menu_items (category_id, name, price, station_id, active, sold_out, sort) VALUES (?, ?, ?, ?, 1, 0, ?)').run(cat, name, price, st, sort).lastInsertRowid);
  const a = mk('Steak A', 79000, 0), b = mk('Steak B', 89000, 1), c = mk('Steak C', 99000, 2);
  // Menu mới: B trước A, A tăng giá, có món mới, không còn C
  app.ctx.readMenu = async (photos, items) => {
    assert.ok(items.some((i) => i.id === a));
    return { note: '', sections: [{ name: 'MÓN THỬ ĐẶC BIỆT', items: [
      { item_id: b, name: 'Steak B', price: 89000, description: '' },
      { item_id: null, name: 'Steak Mới', price: 109000, description: 'bò Mỹ' },
      { item_id: null, name: 'steak a', price: 85000, description: '' }, // máy không khớp id → app khớp theo tên
    ] }] };
  };
  const r = await o('POST', '/api/menu/import/read', { photos: [IMG] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rows = r.data.rows;
  assert.deepEqual(rows.map((x) => [x.name, x.item_id]), [['Steak B', b], ['Steak Mới', null], ['steak a', a]]);
  assert.equal(rows[1].cat_id, cat); // món mới vào danh mục của món cũ bên cạnh
  assert.deepEqual(r.data.missing.filter((x) => x.id === c).length, 1);
  // Lưu: thêm món mới, KHÔNG đổi giá A, không ẩn C
  const ap = await o('POST', '/api/menu/import/apply', { rows: rows.map((x) => ({ ...x, add: !x.item_id, set_price: false })), hide_ids: [] });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.equal(ap.data.added, 1);
  const get = (id) => db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  const nw = db.prepare("SELECT * FROM menu_items WHERE name = 'Steak Mới'").get();
  assert.deepEqual([get(b).sort, nw.sort, get(a).sort, get(c).sort], [0, 1, 2, 3]);
  assert.equal(nw.category_id, cat); assert.equal(nw.station_id, st); assert.equal(nw.price, 109000);
  assert.equal(get(a).price, 79000);
  assert.equal(get(c).active, 1);
  // Lần 2: đổi giá A + ẩn C
  await o('POST', '/api/menu/import/apply', { rows: [{ item_id: a, price: 85000, set_price: true }], hide_ids: [c] });
  assert.equal(get(a).price, 85000);
  assert.equal(get(c).active, 0);
  // Danh mục xuất hiện trên menu lên đầu
  assert.equal(db.prepare('SELECT sort FROM menu_categories WHERE id = ?').get(cat).sort, 0);
});
