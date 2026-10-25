import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Đăng nhập: 1 bạn nhập sai 5 lần chỉ khoá số của bạn đó, bạn khác cùng wifi vẫn vào được', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (body, cookie = '') => { const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }); return { status: res.status, cookie: (res.headers.get('set-cookie') || '').split(';')[0], data: await res.json() }; };
  const own = await call({ pin: DEFAULT_OWNER_PIN });
  const mk = async (name, phone, pin) => (await fetch(base + '/api/staff', { method: 'POST', headers: { 'content-type': 'application/json', cookie: own.cookie }, body: JSON.stringify({ name, phone, pin, role: 'staff', team_id: 4 }) })).json();
  await mk('Huy', '0384034084', '583920');
  await mk('Lan', '0912000111', '692031');
  for (let i = 0; i < 5; i++) assert.equal((await call({ phone: '0384034084', pin: '111999' })).status, 401);
  assert.equal((await call({ phone: '0384034084', pin: '583920' })).status, 429); // số của Huy bị khoá 2 phút
  assert.equal((await call({ phone: '0912000111', pin: '692031' })).status, 200); // Lan cùng wifi vẫn vào được
});
