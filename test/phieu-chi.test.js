import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const JPG = `data:image/jpeg;base64,${Buffer.alloc(1200, 7).toString('base64')}`;

test('phiếu chi: thu ngân chi từ két (trừ két, > 500k chờ duyệt), quản lý chi tiền đã kết (trừ tiền đang giữ), chi CK (trừ số dư TK)', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c && /sid=/.test(c)) cookie = /sid=[^;]+/.exec(c)[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const O = mk(); await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tn = db.prepare("SELECT id FROM teams WHERE name = 'Thu ngân'").get().id;
  await O('POST', '/api/staff', { name: 'Thu ngân A', pin: '583920', role: 'staff', team_id: tn });
  await O('POST', '/api/staff', { name: 'Trưởng ca', pin: '692031', role: 'shift_lead', team_id: null });
  const T = mk(); await T('POST', '/api/login', { pin: '583920' }); await T('POST', '/api/me/pin', { current_pin: '583920', new_pin: '481937' });
  const L = mk(); await L('POST', '/api/login', { pin: '692031' }); await L('POST', '/api/me/pin', { current_pin: '692031', new_pin: '715284' });
  const date = app.ctx.today();
  await T('POST', '/api/payments/drawer', { date, opening: 2000000 });
  const exp0 = (await T('GET', `/api/payments?date=${date}`)).data.summary.drawer_expected;
  assert.equal((await T('POST', '/api/expenses', { source: 'drawer', amount: '150.000', category: 'Gas / đá', note: 'Mua 5 bao đá' })).status, 400); // thiếu ảnh
  assert.equal((await T('POST', '/api/expenses', { source: 'drawer', amount: 150000, category: 'Gas / đá', note: 'Mua 5 bao đá', photo: JPG })).data.status, 'done');
  assert.equal((await T('GET', `/api/payments?date=${date}`)).data.summary.drawer_expected, exp0 - 150000);
  const big = (await T('POST', '/api/expenses', { source: 'drawer', amount: 800000, category: 'Sửa chữa', note: 'Thợ sửa máy lạnh', photo: JPG })).data;
  assert.equal(big.status, 'pending');
  assert.equal((await T('POST', `/api/expenses/${big.id}/approve`, {})).status, 403);
  assert.equal((await L('POST', `/api/expenses/${big.id}/approve`, {})).status, 200);
  assert.equal((await T('POST', '/api/expenses', { source: 'manager', amount: 100000, category: 'Khác', note: 'x', photo: JPG })).status, 403); // thu ngân không chi tiền quản lý
  // Quản lý / chủ: chi CK → số dư TK phải có trừ; chi tiền đã kết → tiền đang giữ trừ
  await O('PUT', '/api/expenses/settings', { opening: '5.000.000' });
  await O('POST', '/api/payments/bank-balance', { date, opening: 10000000 });
  await O('POST', '/api/expenses', { source: 'bank', amount: 1200000, category: 'Điện / nước / internet', note: 'Tiền điện T10', photo: JPG });
  await O('POST', '/api/expenses', { source: 'manager', amount: 300000, category: 'Vận chuyển / ship', note: 'Ship hàng', photo: JPG });
  const day = (await O('GET', `/api/payments?date=${date}`)).data;
  assert.equal(day.bank.ck_out, 1200000);
  assert.equal(day.summary.drawer_expected, exp0 - 150000 - 800000);
  const list = (await O('GET', '/api/expenses')).data;
  assert.equal(list.total, 150000 + 800000 + 1200000 + 300000);
  assert.equal(list.holding.total, 5000000 - 300000);
  assert.ok(list.by_category.some((c) => c.name === 'Sửa chữa' && c.total === 800000));
  // Thu ngân chỉ thấy phiếu chi từ két
  assert.ok((await T('GET', '/api/expenses')).data.list.every((e) => e.source === 'drawer'));
});
