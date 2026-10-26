import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Đồ dùng: thêm nhiều món 1 lần (tên số đơn vị); món có sẵn sổ 0 thì ghi số, đã có số thì giữ', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  for (const [n, q] of [['Ly', 0], ['Chén', 50]]) { if (!db.prepare('SELECT 1 FROM utensils WHERE name = ?').get(n)) db.prepare("INSERT INTO utensils (name, sort) VALUES (?, 99)").run(n); db.prepare('UPDATE utensils SET on_hand = ? WHERE name = ?').run(q, n); }
  const r = await O('POST', '/api/utensils/bulk', { text: '1. Ly bia 120 cái\nKhay inox 30\nLy 80\nChén 70 cái\n- Bếp gas mini: 100 cái\nThớt' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.added, ['Ly bia', 'Khay inox', 'Bếp gas mini', 'Thớt']);
  assert.deepEqual(r.data.updated, ['Ly']);
  assert.deepEqual(r.data.kept, ['Chén']);
  const get = (n) => db.prepare('SELECT * FROM utensils WHERE name = ?').get(n);
  assert.equal(get('Ly bia').on_hand, 120);
  assert.equal(get('Khay inox').unit, 'cái');
  assert.equal(get('Ly').on_hand, 80);
  assert.equal(get('Chén').on_hand, 50);
  assert.equal(get('Bếp gas mini').on_hand, 100);
  assert.equal(get('Thớt').on_hand, 0);
});
