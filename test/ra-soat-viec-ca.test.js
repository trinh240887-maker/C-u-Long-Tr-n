// Rà soát 28/10: việc ca, checklist, màn Quản lý, giao việc
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const IMG = 'data:image/jpeg;base64,' + Buffer.alloc(800, 7).toString('base64');

async function boot(t, { now, photoDir } = {}) {
  const db = openDb(':memory:', { now: now() });
  const app = createApp({ db, now, photoDir, publicDir, zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const O = mk();
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const login = async (pin, phone) => { const c = mk(); const r = await c('POST', '/api/login', { pin, phone }); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; };
  return { db, app, O, login };
}

test('DB mới khởi động 2 lần: không chuyển việc Bếp / Bar / Tạp vụ sang bản ẩn "(việc cũ 27/10)"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-soat-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    const snap = (db) => db.prepare('SELECT t.id, t.title, t.active, (SELECT COUNT(*) FROM checklist_items i WHERE i.template_id = t.id) AS n FROM checklist_templates t ORDER BY t.id').all();
    const run = () => { const db = openDb(file); const app = createApp({ db, publicDir, photoDir: path.join(dir, 'ph'), zaloTransport: { send: async () => {} } }); const s = snap(db); const flags = ['common_shop_v1', 'tv_bar_bep_clear_v1', 'lead_pool_v1'].map((k) => app.ctx.setting(k)); app.close(); db.close(); return { s, flags }; };
    const a = run();
    assert.deepEqual(a.flags, ['1', '1', '1'], 'DB mới: đánh dấu các bước 1 lần là đã làm');
    const b = run();
    assert.deepEqual(b.s, a.s, 'lần khởi động 2 không đổi checklist');
    assert.ok(!b.s.some((x) => /việc cũ/i.test(x.title)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Việc ca điều phối: nhân viên không tự nhận; giao ngoài ca bị chặn; số sai không mất ảnh; không báo "Chưa ai nhận" từng việc; hết khung qua nửa đêm vẫn báo', async (t) => {
  let now = Date.parse('2026-10-28T14:10:00+07:00');
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-soat-ph-'));
  t.after(() => fs.rmSync(photoDir, { recursive: true, force: true }));
  const { db, app, O, login } = await boot(t, { now: () => now, photoDir });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  const za = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').get().id;
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const mkS = async (name, role, pin, phone) => (await O('POST', '/api/staff', { name, role, team_id: pv, pin, phone })).data.id;
  const nv = await mkS('Phát', 'staff', '5861', '0900000061');
  const tc = await mkS('Trưởng ca', 'shift_lead', '586211', '0900000062');
  const off = await mkS('Nghỉ hôm nay', 'staff', '5863', '0900000063');
  const today = app.ctx.today();
  const ins = (sid, zone) => db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g${sid}`, sid, pv, today, zone);
  ins(nv, za); ins(tc, null);
  db.prepare('DELETE FROM checklist_items WHERE template_id = ?').run(tpl);
  const iA = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Giặt khăn', zone_id: za })).data.id;
  db.prepare('UPDATE checklist_items SET job_expect = 2 WHERE id = ?').run(iA);
  assert.equal((await O('PUT', `/api/checklist-templates/${tpl}/lead-pool`, { on: true })).status, 200);
  await O('GET', '/api/jobs/board');
  const job = db.prepare('SELECT * FROM jobs WHERE template_id = ? AND item_id = ?').get(tpl, iA);
  assert.equal(job.staff_id, null);
  const N = await login('5861', '0900000061');
  const TC = await login('586211', '0900000062');
  assert.equal((await N('POST', `/api/jobs/${job.id}/claim`)).status, 403, 'nhân viên không tự nhận việc điều phối');
  assert.equal((await TC('PATCH', `/api/jobs/${job.id}`, { staff_id: off })).status, 400, 'không giao cho người không có ca');
  assert.equal((await TC('PATCH', `/api/jobs/${job.id}`, { staff_id: nv })).status, 200);
  assert.equal((await N('POST', `/api/jobs/${job.id}/claim`)).status, 200);
  assert.equal((await N('POST', `/api/jobs/${job.id}/shot`, { data: IMG })).status, 200);
  assert.equal((await N('POST', `/api/jobs/${job.id}/done`, { count: 'abc' })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_shots WHERE job_id = ?').get(job.id).n, 1, 'số sai: ảnh chụp dở vẫn còn');
  // Trưởng ca đổi người khi đang làm → bỏ ảnh dở của người cũ
  assert.equal((await TC('PATCH', `/api/jobs/${job.id}`, { staff_id: tc })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_shots WHERE job_id = ?').get(job.id).n, 0);
  // Việc trống của checklist điều phối: không báo "Chưa ai nhận" từng việc
  db.prepare('UPDATE jobs SET staff_id = NULL, status = \'todo\' WHERE id = ?').run(job.id);
  now = Date.parse('2026-10-28T14:40:00+07:00');
  app.ctx.jobsTick();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE 'Chưa ai nhận%'").get().n, 0);
  // Khung 22:00–00:30 (qua nửa đêm): 00:40 vẫn trong ngày làm việc → báo còn việc dở
  db.prepare('UPDATE checklist_templates SET job_from = 1320, job_to = 1470 WHERE id = ?').run(tpl);
  now = Date.parse('2026-10-29T00:40:00+07:00');
  assert.equal(app.ctx.today(), today);
  app.ctx.jobsLeftTick();
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE '%việc chưa xong%'").get().n > 0);
});

test('Xoá việc checklist = xoá mềm: ẩn khỏi checklist, giữ kết quả đã làm', async (t) => {
  const { db, O } = await boot(t, { now: () => Date.now() });
  const tid = Number(db.prepare("INSERT INTO checklist_templates (team_id, phase, title, sort, active) VALUES (NULL, 'during', 'Rà soát xoá mềm', 0, 1)").run().lastInsertRowid);
  const iid = Number(db.prepare("INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, extra_ingredient_ids, sort) VALUES (?, 'Lau kính', 'check', '', 1, 0, '[]', 0)").run(tid).lastInsertRowid);
  const run = (await O('GET', '/api/checklists')).data.runs.find((r) => r.template_id === tid);
  assert.equal((await O('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: iid })).status, 200);
  assert.equal((await O('POST', `/api/checklist-items/${iid}/delete`, {})).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checklist_entries WHERE item_id = ?').get(iid).n, 1, 'giữ lịch sử');
  const after = (await O('GET', '/api/checklists')).data.runs.find((r) => r.template_id === tid);
  assert.ok(!after.items.some((i) => i.id === iid), 'ẩn khỏi checklist');
  // Sửa checklist (gửi danh sách không có việc cũ) cũng chỉ ẩn
  const i2 = Number(db.prepare("INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, extra_ingredient_ids, sort) VALUES (?, 'Lau bàn', 'check', '', 1, 0, '[]', 1)").run(tid).lastInsertRowid);
  assert.equal((await O('PATCH', `/api/checklist-templates/${tid}`, { items: [{ text: 'Quét sàn', kind: 'check' }] })).status, 200);
  assert.ok(db.prepare('SELECT deleted_at FROM checklist_items WHERE id = ?').get(i2).deleted_at);
  assert.deepEqual((await O('GET', '/api/checklist-templates')).data.find((x) => x.id === tid).items.map((i) => i.text), ['Quét sàn']);
});

test('Dọn mỗi ngày: ảnh việc ca cũ, cờ nhắc theo ngày cũ; giữ cờ không có ngày', async (t) => {
  const now = Date.parse('2026-10-28T10:00:00+07:00');
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-soat-ph-'));
  t.after(() => fs.rmSync(photoDir, { recursive: true, force: true }));
  const { db, app } = await boot(t, { now: () => now, photoDir });
  const it = db.prepare('SELECT id, template_id FROM checklist_items LIMIT 1').get();
  const put = (rel) => { fs.mkdirSync(path.join(photoDir, 'viec', path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(photoDir, 'viec', rel), 'x'); };
  put('2026-10-01/a.jpg'); put('2026-10-01/mo-coi.jpg'); put('2026-10-27/b.jpg');
  const j1 = Number(db.prepare("INSERT INTO jobs (date, template_id, item_id, status, photo) VALUES ('2026-10-01', ?, ?, 'ok', '2026-10-01/a.jpg')").run(it.template_id, it.id).lastInsertRowid);
  const j2 = Number(db.prepare("INSERT INTO jobs (date, template_id, item_id, status, photo) VALUES ('2026-10-27', ?, ?, 'ok', '2026-10-27/b.jpg')").run(it.template_id, it.id).lastInsertRowid);
  for (const k of ['noshow:2026-10-01:1', 'jobs_left:2026-10-27:1', 'zone_week:2026-09-01', 'opening_note:2026-09-30']) app.ctx.setSetting(k, '1');
  app.ctx.jobsCleanup();
  assert.equal(db.prepare('SELECT photo FROM jobs WHERE id = ?').get(j1).photo, null);
  assert.equal(db.prepare('SELECT photo FROM jobs WHERE id = ?').get(j2).photo, '2026-10-27/b.jpg');
  assert.ok(!fs.existsSync(path.join(photoDir, 'viec', '2026-10-01')), 'xoá cả file mồ côi');
  assert.ok(fs.existsSync(path.join(photoDir, 'viec', '2026-10-27', 'b.jpg')));
  assert.equal(app.ctx.setting('noshow:2026-10-01:1'), '');
  assert.equal(app.ctx.setting('opening_note:2026-09-30'), '');
  assert.equal(app.ctx.setting('jobs_left:2026-10-27:1'), '1');
  assert.equal(app.ctx.setting('zone_week:2026-09-01'), '1');
});

test('Sửa việc giao: tổ trưởng không đổi người nhận sang tổ khác; người mới được báo; nhân viên thấy việc của mình', async (t) => {
  const { db, O, login } = await boot(t, { now: () => Date.now() });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const bep = db.prepare("SELECT id FROM teams WHERE name = 'Bar'").get().id;
  const mkS = async (name, role, team, pin, phone) => (await O('POST', '/api/staff', { name, role, team_id: team, pin, phone })).data.id;
  await mkS('Tổ trưởng PV', 'team_lead', pv, '5871', '0900000071');
  const a = await mkS('PV A', 'staff', pv, '5872', '0900000072');
  const b = await mkS('PV B', 'staff', pv, '5873', '0900000073');
  const k = await mkS('Bếp K', 'staff', bep, '5874', '0900000074');
  const L = await login('5871', '0900000071');
  const id = (await L('POST', '/api/tasks', { title: 'Lau quầy', assignee_id: a })).data.id;
  assert.equal((await L('PATCH', `/api/tasks/${id}`, { assignee_id: k })).status, 403);
  assert.equal((await L('PATCH', `/api/tasks/${id}`, { assignee_id: b })).status, 200);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE staff_id = ? AND title = 'Việc mới: Lau quầy'").get(b).n > 0);
  // Nhiều việc khác (> 300) không che việc của nhân viên
  const ins = db.prepare("INSERT INTO tasks (title, team_id, assignee_id, priority, created_at) VALUES ('x', ?, ?, 1, 0)");
  for (let i = 0; i < 320; i++) ins.run(bep, k);
  const B = await login('5873', '0900000073');
  assert.ok((await B('GET', '/api/tasks')).data.some((x) => x.id === id));
});
