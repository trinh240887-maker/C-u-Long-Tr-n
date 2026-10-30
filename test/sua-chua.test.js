import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMG = `data:image/jpeg;base64,${Buffer.alloc(3000, 9).toString('base64')}`;

test('bill mua: dòng sửa chữa / đồ dùng / tài sản không nhập kho; đồ dùng cộng vào Đồ dùng, tài sản vào danh sách; sổ sửa chữa = vật tư + công thợ', async (t) => {
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
  const store = db.prepare("SELECT id FROM stores WHERE kind = 'main' ORDER BY id LIMIT 1").get().id;
  const rep = (await o('POST', '/api/repairs', { title: 'Quạt khu B', area: 'Khu B' })).data;
  const ingBefore = db.prepare('SELECT COUNT(*) AS n FROM ingredients').get().n;
  const r = await o('POST', '/api/purchases', { store_id: store, supplier_name: 'Điện nước Ngũ Kiệt', signer_name: 'Ngân', total: 962000, photos: [IMG], goods_photos: [IMG],
    lines: [{ name: 'Ke + vít láy', qty: 1, unit: 'bộ', price: 10000, kind: 'repair', repair_id: rep.id },
      { name: 'Tụ quạt', qty: 2, unit: 'cái', price: 26000, kind: 'repair', repair_id: rep.id },
      { name: 'Thớt nhựa', qty: 2, unit: 'cái', price: 60000, kind: 'tool' },
      { name: 'Quạt đứng Senko', qty: 1, unit: 'cái', price: 790000, kind: 'asset' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingredients').get().n, ingBefore, 'không tạo mã kho');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_moves').get().n, 0, 'không nhập kho');
  assert.equal(db.prepare("SELECT on_hand FROM utensils WHERE name = 'Thớt nhựa'").get().on_hand, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wh_assets WHERE name = 'Quạt đứng Senko'").get().n, 1);
  // Công thợ: phiếu chi "Sửa chữa" gắn việc sửa
  const e = await o('POST', '/api/expenses', { source: 'manager', amount: '150.000', category: 'Sửa chữa', note: 'Công thợ sửa quạt', photo: IMG, repair_id: rep.id });
  assert.equal(e.status, 200, JSON.stringify(e.data));
  const v = (await o('GET', '/api/repairs')).data;
  const q = v.repairs.find((x) => x.id === rep.id);
  assert.equal(q.parts, 62000); assert.equal(q.labor, 150000); assert.equal(q.total, 212000);
  assert.equal(v.by_kind.repair, 62000); assert.equal(v.by_kind.tool, 120000); assert.equal(v.by_kind.asset, 790000);
  assert.equal((await o('PATCH', `/api/repairs/${rep.id}`, { done: true })).status, 200);
});
