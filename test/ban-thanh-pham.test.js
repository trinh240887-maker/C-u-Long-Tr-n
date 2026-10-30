import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('bán thành phẩm: tự nạp 4 sổ (cốt lẩu, nước dùng, chấm, sốt steak, xiên), khớp mã kho, sửa phút giữ khi nạp lại, gắn / tạo mã kho', async (t) => {
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
  const d = (await o('GET', '/api/preps')).data;
  assert.ok(d.preps.length >= 40, `chỉ có ${d.preps.length}`);
  assert.deepEqual([...new Set(d.preps.map((p) => p.book))].sort(), ['Lẩu', 'Nước chấm', 'Sốt steak', 'Xiên nướng'].sort());
  const tx = d.preps.find((p) => p.name === 'Cốt Tứ Xuyên');
  assert.equal(tx.out_qty, 5000); assert.equal(tx.shelf_days, 5);
  assert.ok(tx.steps.some((s) => /rót túi|Chia túi/i.test(s.text) && s.min >= 10) && tx.steps.some((s) => /đá/.test(s.text) && s.wait === 20)); // rót túi + ngâm đá
  assert.ok(tx.active_min >= 30);
  const dau = tx.lines.find((l) => /Dầu đậu nành/.test(l.name));
  assert.ok(dau.ingredient_id, 'khớp mã kho Dầu đậu nành');
  const bo = d.preps.find((p) => /Nước dùng bò/.test(p.name));
  assert.ok(bo.wait_min >= 480, 'ninh 8–10 giờ là phút chờ');
  // Sửa phút → nạp lại không ghi đè
  const steps = tx.steps.map((s, k) => ({ ...s, min: k === 0 ? 15 : s.min }));
  assert.equal((await o('PATCH', `/api/preps/${tx.id}/steps`, { steps })).status, 200);
  await o('POST', '/api/preps/import');
  const tx2 = (await o('GET', '/api/preps')).data.preps.find((p) => p.id === tx.id);
  assert.equal(tx2.steps[0].min, 15);
  // Tạo mã kho cho dòng chưa khớp → các sổ khác cùng tên cũng gắn; nạp lại vẫn giữ
  const miss = tx2.lines.find((l) => !l.ingredient_id && l.unit_price > 0);
  const r = await o('PATCH', `/api/preps/lines/${miss.id}`, { create: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(r.data.ingredient_id));
  const same = db.prepare('SELECT COUNT(*) AS n FROM prep_lines WHERE code = ? AND ingredient_id IS NULL').get(miss.code).n;
  assert.equal(same, 0);
  await o('POST', '/api/preps/import');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prep_lines WHERE code = ? AND ingredient_id IS NULL').get(miss.code).n, 0);
  // Tạo hàng loạt mã kho còn thiếu
  const cm = await o('POST', '/api/preps/create-missing');
  assert.equal(cm.status, 200); assert.ok(cm.data.made > 10);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prep_lines WHERE ingredient_id IS NULL AND unit_price > 0').get().n, 0);
});
