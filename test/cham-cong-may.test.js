import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('chống chấm công hộ: mỗi người 1 điện thoại; máy của người khác bị chặn + báo; quản lý cho đổi máy', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = (dev) => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(dev ? { 'x-device': dev } : {}), ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c && /sid=/.test(c)) cookie = /sid=[^;]+/.exec(c)[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const O = mk('owner-phone-1');
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  app.ctx.setSetting('clock_require_shift', '0');
  const a = (await O('POST', '/api/staff', { name: 'Bạn A', pin: '583920', role: 'staff', team_id: 4 })).data.id;
  const b = (await O('POST', '/api/staff', { name: 'Bạn B', pin: '692031', role: 'staff', team_id: 4 })).data.id;
  const login = async (dev, pin) => { const c = mk(dev); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: pin === '583920' ? '481937' : '715284' }); return c; };
  const A = await login('phoneA-123456', '583920');
  const B = await login('phoneB-123456', '692031');
  assert.equal((await A('POST', '/api/attendance/clock-in')).status, 200, 'lần đầu: gắn máy A');
  assert.equal((await B('POST', '/api/attendance/clock-in')).status, 200);
  // B cầm máy A chấm hộ cho B → chặn (máy đã gắn cho A)
  const BonA = mk('phoneA-123456'); await BonA('POST', '/api/login', { pin: '715284' });
  await B('POST', '/api/attendance/clock-out');
  const r1 = await BonA('POST', '/api/attendance/clock-in');
  assert.equal(r1.status, 403); assert.match(r1.data.error, /máy chấm công của Bạn A/);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE title LIKE '%Nghi chấm công hộ%'").get());
  // A đổi điện thoại mới → chặn, quản lý "Cho đổi máy" → chấm được
  await A('POST', '/api/attendance/clock-out');
  const Anew = mk('phoneA-new-999'); await Anew('POST', '/api/login', { pin: '481937' });
  assert.equal((await Anew('POST', '/api/attendance/clock-in')).status, 403);
  assert.equal((await O('GET', '/api/staff')).data.find((x) => x.id === a).device_pending, true);
  assert.equal((await O('POST', `/api/staff/${a}/device`, { action: 'allow' })).status, 200);
  assert.equal((await Anew('POST', '/api/attendance/clock-in')).status, 200);
  // Chấm vào máy đúng, chấm ra trên link / trình duyệt khác → vẫn cho ra (chỉ báo tổ trưởng)
  const Aweb = mk('phoneA-zalo-777'); await Aweb('POST', '/api/login', { pin: '481937' });
  assert.equal((await Aweb('POST', '/api/attendance/clock-out')).status, 200);
  void b;
});
