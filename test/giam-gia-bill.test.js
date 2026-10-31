import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });

test('giảm giá bill: chỉ quản lý / chủ, % hoặc tiền, bắt buộc lý do, hiện trong bill và tổng; nhân viên / trưởng ca không giảm được', async (t) => {
  const now = clock.toEpoch('2026-10-24', 18 * 60);
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const s = res.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const teams = (await o('GET', '/api/teams')).data;
  const pv = teams.find((x) => x.name === 'Phục vụ').id;
  await o('POST', '/api/staff', { name: 'Hậu', team_id: pv, pin: '4821' });
  await o('POST', '/api/staff', { name: 'Trưởng ca', team_id: pv, role: 'shift_lead', pin: '5932' });
  const menu = (await o('GET', '/api/menu')).data;
  const it = menu.items.find((i) => !i.options?.length && i.price >= 50000 && !/combo/i.test(i.name));
  const sid = (await o('POST', '/api/pos/sessions', { tables: [20], guests: 2 })).data.id;
  await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: it.id, qty: 2 });
  const before = (await o('GET', `/api/pos/sessions/${sid}`)).data.total;
  assert.equal(before, it.price * 2);
  for (const pin of ['4821', '5932']) { const x = mk(); await x('POST', '/api/login', { pin }); assert.equal((await x('POST', `/api/pos/sessions/${sid}/discount`, { type: 'percent', value: 10, reason: 'thử' })).status, 403, pin); }
  assert.equal((await o('POST', `/api/pos/sessions/${sid}/discount`, { type: 'percent', value: 10 })).status, 400, 'thiếu lý do');
  let s = (await o('POST', `/api/pos/sessions/${sid}/discount`, { type: 'percent', value: 10, reason: 'khách quen' })).data;
  assert.equal(s.total, Math.round(before * 0.9));
  assert.ok(s.bill_promos.some((p) => p.promo_id === 'manual' && /khách quen/.test(p.name)));
  s = (await o('POST', `/api/pos/sessions/${sid}/discount`, { type: 'amount', value: 20000, reason: 'món ra chậm' })).data;
  assert.equal(s.total, before - 20000);
  s = (await o('POST', `/api/pos/sessions/${sid}/discount`, { clear: true })).data;
  assert.equal(s.total, before);

  // Giảm giá nhân viên: thu ngân chọn người mua, đồ ăn 30%, nước (quầy Bar) 50%; phục vụ không áp được
  const tn = teams.find((x) => x.name === 'Thu ngân').id;
  await o('POST', '/api/staff', { name: 'Thu ngân A', team_id: tn, pin: '6043' });
  const st = Object.fromEntries(menu.stations.map((x) => [x.id, x.name]));
  const drink = menu.items.find((i) => !i.options?.length && /bar|pha chế/i.test(st[i.station_id] || '') && i.price > 0);
  assert.ok(drink, 'có món quầy Bar');
  await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: drink.id, qty: 1 });
  const hau = db.prepare("SELECT id FROM staff WHERE name = 'Hậu'").get().id;
  const H = mk(); await H('POST', '/api/login', { pin: '4821' });
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/discount`, { staff_id: hau })).status, 403, 'phục vụ không áp');
  const T = mk(); await T('POST', '/api/login', { pin: '6043' });
  assert.ok((await T('GET', '/api/staff/names')).data.some((x) => x.id === hau));
  assert.equal((await T('POST', `/api/pos/sessions/${sid}/discount`, { type: 'percent', value: 90, reason: 'x' })).status, 403, 'thu ngân không tự nhập %');
  s = (await T('POST', `/api/pos/sessions/${sid}/discount`, { staff_id: hau })).data;
  const nv = s.bill_promos.find((p) => p.promo_id === 'staff');
  assert.ok(nv && /Hậu/.test(nv.name), JSON.stringify(s.bill_promos));
  assert.equal(nv.amount, Math.round(it.price * 2 * 0.3) + Math.round(drink.price * 0.5));
  assert.equal((await T('POST', `/api/pos/sessions/${sid}/discount`, { clear: true })).status, 200, 'thu ngân bỏ giảm NV');
});
