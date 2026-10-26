import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const JPG = `data:image/jpeg;base64,${Buffer.alloc(1200, 7).toString('base64')}`;

test('Tiền hiện có: tiền mặt đang giữ + số dư tài khoản; cổ đông chi tiền mặt / CK từ đây thì tự trừ', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const date = app.ctx.today();
  assert.equal((await O('PUT', '/api/expenses/settings', { opening: '5.000.000' })).status, 200);
  db.prepare('INSERT INTO bank_day (date, opening) VALUES (?, ?)').run(date, 20_000_000);
  let m = (await O('GET', '/api/money/now')).data;
  assert.equal(m.holding.total, 5_000_000);
  assert.equal(m.bank.balance, 20_000_000);
  assert.equal(m.total, 25_000_000);
  assert.equal((await O('POST', '/api/expenses', { source: 'manager', amount: 300000, category: 'Khác', note: 'Cổ đông chi tiền mặt', photo: JPG })).status, 200);
  assert.equal((await O('POST', '/api/expenses', { source: 'bank', amount: 1000000, category: 'Khác', note: 'Cổ đông chi CK', photo: JPG })).status, 200);
  m = (await O('GET', '/api/money/now')).data;
  assert.equal(m.holding.total, 4_700_000);
  assert.equal(m.bank.balance, 19_000_000);
  assert.equal(m.total, 23_700_000);
  assert.equal(m.recent.length, 2);
});
