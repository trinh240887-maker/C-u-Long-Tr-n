import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('bill đã duyệt: chỉ chủ quán huỷ (quản lý bị chặn); huỷ thì bỏ khỏi công nợ', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const teams = (await o('GET', '/api/teams')).data;
  await o('POST', '/api/staff', { name: 'QL', role: 'manager', team_id: teams[0].id, pin: '741151' });
  const Q = mk(); await Q('POST', '/api/login', { pin: '741151' }); await Q('POST', '/api/me/pin', { current_pin: '741151', new_pin: '841151' });
  const sup = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('NT Hiếu')").run().lastInsertRowid);
  const id = Number(db.prepare("INSERT INTO purchase_bills (supplier_id, supplier_name, date, total, status, received_at) VALUES (?, 'NT Hiếu', ?, 3800000, 'approved', ?)").run(sup, app.ctx.today(), Date.now()).lastInsertRowid);
  const r1 = await Q('POST', `/api/purchases/${id}/void`, { reason: 'trùng' });
  assert.equal(r1.status, 403); assert.match(r1.data.error, /chỉ chủ quán/);
  assert.equal((await o('POST', `/api/purchases/${id}/void`, { reason: 'Chụp trùng phiếu #45' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM purchase_bills WHERE id = ?').get(id).status, 'void');
  const d = (await o('GET', '/api/suppliers/debts')).data;
  const s = (Array.isArray(d) ? d : d.suppliers || []).find((x) => x.id === sup);
  assert.ok(!s || !s.open_bills?.some((b) => b.id === id));
});
