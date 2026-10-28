import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Trưởng ca + tổ trưởng điều phối: việc không chia từng người; lead khu thấy việc khu mình + việc chung; nhân viên không thấy; giao người; xong phải chụp ảnh', async (t) => {
  let now = Date.parse('2026-10-28T14:10:00+07:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const O = mk();
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  const [za, zb] = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').all().map((z) => z.id);
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const mkS = async (name, role, pin, phone) => (await O('POST', '/api/staff', { name, role, team_id: pv, pin, phone })).data.id;
  const nv = await mkS('Phát', 'staff', '5851', '0900000051');
  const ttA = await mkS('Tổ A', 'team_lead', '5852', '0900000052');
  const ttB = await mkS('Tổ B', 'team_lead', '5853', '0900000053');
  const tc = await mkS('Trưởng ca', 'shift_lead', '585411', '0900000054');
  const today = app.ctx.today();
  const ins = (sid, zone) => db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g${sid}`, sid, pv, today, zone);
  ins(nv, za); ins(ttA, za); ins(ttB, zb); ins(tc, null);
  const iA = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Lau quạt khu A', zone_id: za })).data.id;
  const iB = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Lau quạt khu B', zone_id: zb })).data.id;
  const iC = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Xếp ly chung', job_scope: 'shop' })).data.id;
  assert.equal((await O('PUT', `/api/checklist-templates/${tpl}/lead-pool`, { on: true })).status, 200);
  await O('GET', '/api/jobs/board');
  const jobs = db.prepare('SELECT * FROM jobs WHERE template_id = ? AND date = ?').all(tpl, today);
  assert.ok(jobs.length >= 3);
  assert.ok(jobs.every((j) => j.staff_id == null), 'không chia cho ai');
  const login = async (pin, phone) => { const c = mk(); const r = await c('POST', '/api/login', { pin, phone }); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; };
  const N = await login('5851', '0900000051');
  const A = await login('5852', '0900000052');
  const TC = await login('585411', '0900000054');
  const mN = (await N('GET', '/api/jobs/mine')).data;
  assert.equal(mN.pool.length, 0);
  assert.ok(!mN.open.some((j) => j.template_id === tpl), 'nhân viên không thấy việc điều phối');
  const mA = (await A('GET', '/api/jobs/mine')).data;
  const itemsA = new Set(mA.pool.map((j) => j.title));
  assert.ok(itemsA.has('Lau quạt khu A') && itemsA.has('Xếp ly chung') && !itemsA.has('Lau quạt khu B'));
  const mTC = (await TC('GET', '/api/jobs/mine')).data;
  assert.ok(new Set(mTC.pool.map((j) => j.title)).has('Lau quạt khu B'), 'trưởng ca không phân khu thấy hết');
  assert.ok(mTC.crew.some((p) => p.id === nv));
  // Tổ trưởng A giao việc khu A cho nhân viên; không giao được việc khu B
  const jA = jobs.find((j) => j.item_id === iA && j.zone_id === za);
  const jB = jobs.find((j) => j.item_id === iB && j.zone_id === zb);
  assert.equal((await A('PATCH', `/api/jobs/${jA.id}`, { staff_id: nv })).status, 200);
  assert.equal((await A('PATCH', `/api/jobs/${jB.id}`, { staff_id: nv })).status, 403);
  const mine = (await N('GET', '/api/jobs/mine')).data.mine.find((j) => j.id === jA.id);
  assert.ok(mine && mine.photos_needed >= 1);
  // Trưởng ca tự làm việc chung: xong phải có ảnh
  const jC = jobs.find((j) => j.item_id === iC);
  assert.equal((await TC('POST', `/api/jobs/${jC.id}/claim`)).status, 200);
  assert.equal((await TC('POST', `/api/jobs/${jC.id}/done`, {})).status, 400);
  const img = 'data:image/jpeg;base64,' + Buffer.alloc(800, 7).toString('base64');
  assert.equal((await TC('POST', `/api/jobs/${jC.id}/shot`, { data: img })).status, 200);
  assert.equal((await TC('POST', `/api/jobs/${jC.id}/done`, {})).status, 200);
  // Chưa đạt → Làm lại: bỏ ảnh cũ, trả về đúng người, phải chụp lại
  assert.equal((await A('POST', `/api/jobs/${jC.id}/check`, { ok: false, note: 'chưa sạch' })).status, 200);
  const back = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jC.id);
  assert.equal(back.status, 'doing'); assert.equal(back.staff_id, tc); assert.equal(back.photo, null);
  assert.equal((await TC('POST', `/api/jobs/${jC.id}/done`, {})).status, 400);
  await TC('POST', `/api/jobs/${jC.id}/shot`, { data: img });
  assert.equal((await TC('POST', `/api/jobs/${jC.id}/done`, {})).status, 200);
  assert.equal((await A('POST', `/api/jobs/${jC.id}/check`, { ok: true })).status, 200);
  // Màn Quản lý theo phạm vi: trưởng ca không khu thấy mọi khu; trưởng ca khu A chỉ khu A + việc chung; quản lý bếp không thấy việc phục vụ
  const zonesSeen = async (c) => new Set((await c('GET', '/api/dashboard')).data.jobs.map((g) => g.zone_id));
  const all = await zonesSeen(TC);
  assert.ok(all.has(za) && all.has(zb) && all.has(0));
  const tcA = await mkS('Trưởng ca A', 'shift_lead', '585511', '0900000055');
  ins(tcA, za);
  const TA = await login('585511', '0900000055');
  const onlyA = await zonesSeen(TA);
  assert.ok(onlyA.has(za) && onlyA.has(0) && !onlyA.has(zb));
  const bep = db.prepare("SELECT id FROM teams WHERE name = 'Bếp'").get()?.id;
  if (bep) {
    await O('POST', '/api/staff', { name: 'QL bếp', role: 'manager', team_id: bep, pin: '585611', phone: '0900000056' });
    const QB = await login('585611', '0900000056');
    const dB = (await QB('GET', '/api/dashboard')).data;
    assert.equal(dB.jobs.length, 0);
    assert.ok(dB.teams.every((x) => x.id === bep));
  }
  assert.equal((await A('GET', '/api/dashboard')).status, 403); // tổ trưởng không vào màn Quản lý
  // Hết khung 15:30 còn việc dở → báo
  now = Date.parse('2026-10-28T15:31:00+07:00');
  app.ctx.jobsLeftTick();
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE '%việc chưa xong%' AND staff_id = ?").get(tcA).n > 0);
  void ttB;
});
