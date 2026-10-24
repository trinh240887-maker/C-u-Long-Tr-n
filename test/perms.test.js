import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('phân quyền: chủ quán bỏ tick → ẩn menu + máy chủ chặn; cấp riêng → người thấp hơn dùng được; mặc định giữ như cũ', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const team = (await o('GET', '/api/teams')).data[0].id;
  const qlId = (await o('POST', '/api/staff', { name: 'Hậu', role: 'manager', team_id: team, pin: '736511' })).data.id;
  const nvId = (await o('POST', '/api/staff', { name: 'Nga', role: 'staff', team_id: team, pin: '7365' })).data.id;
  const login = async (pin, np) => { const c = mk(); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
  const ql = await login('736511', '836512');
  const nv = await login('7365', '8365');

  // Mặc định như cũ
  assert.ok((await ql('GET', '/api/me')).data.pages.includes('/bao-cao'));
  assert.ok(!(await nv('GET', '/api/me')).data.pages.includes('/bao-cao'));
  assert.equal((await ql('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 200);
  assert.equal((await nv('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 403);
  assert.equal((await ql('GET', '/api/permissions')).status, 403); // chỉ chủ

  const perm = (await o('GET', '/api/permissions')).data;
  const pages = Object.fromEntries(perm.pages.map((p) => [p.path, { roles: p.roles, allow: p.allow, deny: p.deny }]));
  // Báo cáo + Cài đặt: chỉ chủ; cấp riêng Báo cáo cho Nga (nhân viên)
  pages['/bao-cao'] = { roles: [], allow: [nvId], deny: [] };
  pages['/cai-dat'] = { roles: [], allow: [], deny: [] };
  pages['/kho'].deny = [qlId];
  assert.equal((await o('PUT', '/api/permissions', { pages })).status, 200);

  const mq = (await ql('GET', '/api/me')).data.pages;
  assert.ok(!mq.includes('/bao-cao') && !mq.includes('/cai-dat') && !mq.includes('/kho'));
  assert.ok(mq.includes('/nhan-vien') && mq.includes('/'));
  assert.equal((await ql('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 403);
  assert.equal((await ql('PUT', '/api/settings', { shop_name: 'X' })).status, 403);
  assert.equal((await ql('POST', '/api/stock/receive', { lines: [] })).status, 403);
  assert.ok((await nv('GET', '/api/me')).data.pages.includes('/bao-cao'));
  assert.equal((await nv('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 200);
  // Cấp riêng không mở mục khác
  assert.equal((await nv('GET', '/api/daybook')).status, 403);
  // Chủ quán luôn dùng được
  assert.equal((await o('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 200);
});
