import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Mở ca phục vụ theo khu: việc riêng từng khu chỉ sinh thẻ cho khu đó; nhân sự khung 14–15h30 theo khu (cả người chưa có bộ phận)', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  const [za, zb] = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').all().map((z) => z.id);
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const a = (await O('POST', '/api/staff', { name: 'Phát', team_id: pv, pin: '5821' })).data.id;
  const lead = (await O('POST', '/api/staff', { name: 'Thiện', pin: '5822' })).data.id; // chưa có bộ phận
  await O('PATCH', `/api/staff/${lead}`, { home_zone_id: za });
  const today = app.ctx.today();
  const ins = (sid, zone) => db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g${sid}`, sid, pv, today, zone);
  ins(a, za); ins(lead, null);
  const add = await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Lau kính khu A', zone_id: za });
  assert.equal(add.status, 200);
  const day = (await O('GET', '/api/checklists')).data;
  const card = day.jobs.find((j) => j.template_id === tpl);
  assert.equal(card.opening_tpl, true);
  assert.equal(card.item_list.find((i) => i.id === add.data.id).job_zone_id, za);
  const inA = day.opening.people.filter((x) => x.zone_id === za).map((x) => x.name).sort();
  assert.deepEqual(inA, ['Phát', 'Thiện']);
  await O('GET', '/api/jobs/board');
  const zonesOf = db.prepare('SELECT DISTINCT zone_id FROM jobs WHERE item_id = ?').all(add.data.id).map((x) => x.zone_id);
  assert.deepEqual(zonesOf, [za]);
  assert.ok(!zonesOf.includes(zb));
  assert.equal((await O('POST', `/api/checklist-items/${add.data.id}/delete`, {})).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE id = ?').get(add.data.id).n, 0);
});

test('Đầu ca khăn + nón theo khu: thẻ có ảnh từng khu, giao người cho việc; hết 15h30 khu chưa có ảnh → báo chủ quán', async (t) => {
  const start = Date.parse('2026-10-27T13:00:00+07:00');
  let now = start;
  const db = openDb(':memory:', { now });
  const sent = [];
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const dc = db.prepare("SELECT * FROM checklist_templates WHERE title = 'Đầu ca Phục vụ: khăn + nón'").get();
  if (!dc) return; // DB mới không có checklist này thì bỏ qua
  db.prepare('UPDATE checklist_templates SET job_mode = 1, active = 1 WHERE id = ?').run(dc.id);
  const za = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').get().id;
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const a = (await O('POST', '/api/staff', { name: 'Phát', team_id: pv, pin: '5831' })).data.id;
  const b = (await O('POST', '/api/staff', { name: 'Tú', team_id: pv, pin: '5832' })).data.id;
  const today = app.ctx.today();
  for (const sid of [a, b]) db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g${sid}`, sid, pv, today, za);
  const it = (await O('POST', `/api/checklist-templates/${dc.id}/items`, { text: 'Quét sạch khu', zone_id: za })).data.id;
  let card = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === dc.id);
  assert.equal(card.zone_photo, true);
  const row = card.job_rows.find((j) => j.item_id === it && j.zone_id === za);
  assert.ok(row, 'có thẻ việc cho khu A');
  assert.equal((await O('PATCH', `/api/jobs/${row.id}`, { staff_id: b })).status, 200);
  card = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === dc.id);
  assert.equal(card.job_rows.find((j) => j.id === row.id).staff_name, 'Tú');
  const owners = db.prepare("SELECT id FROM staff WHERE role = 'owner'").all().map((x) => x.id);
  const before = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE title LIKE ?').get('%khăn + nón%').n;
  now = Date.parse('2026-10-27T15:31:00+07:00');
  app.ctx.openingTick();
  const after = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE title LIKE ?').get('%khăn + nón%').n;
  assert.ok(after > before, 'báo chưa có ảnh');
  assert.ok(owners.length);
  void sent;
});

test('Sửa việc: hướng dẫn, số phút, phải xong trước, số ảnh; Xong phải đủ ảnh; quá giờ phải xong → báo', async (t) => {
  let now = Date.parse('2026-10-27T13:50:00+07:00');
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
  const za = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').get().id;
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const a = (await O('POST', '/api/staff', { name: 'Phát', team_id: pv, pin: '5841', phone: '0900000041' })).data.id;
  const today = app.ctx.today();
  db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run('ga', a, pv, today, za);
  const it = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Lau bàn ghế', zone_id: za })).data.id;
  assert.equal((await O('PATCH', `/api/checklist-items/${it}`, { job_guide: 'Khăn xanh + cồn', job_minutes: 15, job_deadline: '14:30', job_photos: 2 })).status, 200);
  assert.equal((await O('PATCH', `/api/checklist-items/${it}`, { job_deadline: '25:00' })).status, 400);
  const row = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(it);
  assert.equal(row.job_guide, 'Khăn xanh + cồn'); assert.equal(row.job_minutes, 15); assert.equal(row.job_deadline, 870); assert.equal(row.job_photos, 2); assert.equal(row.photo_required, 1);
  const card = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === tpl);
  const job = card.job_rows.find((j) => j.item_id === it);
  await O('PATCH', `/api/jobs/${job.id}`, { staff_id: a });
  const S = mk();
  const lg = await S('POST', '/api/login', { pin: '5841', phone: '0900000041' });
  assert.equal(lg.status, 200, JSON.stringify(lg.data));
  const mine = (await S('GET', '/api/jobs/mine')).data.mine.find((j) => j.id === job.id);
  assert.equal(mine.guide, 'Khăn xanh + cồn'); assert.equal(mine.deadline, '14:30'); assert.equal(mine.photos_needed, 2);
  assert.equal((await S('POST', `/api/jobs/${job.id}/claim`)).status, 200);
  const img = 'data:image/jpeg;base64,' + Buffer.alloc(800, 7).toString('base64');
  assert.equal((await S('POST', `/api/jobs/${job.id}/done`, { photos: [img] })).status, 400); // thiếu ảnh
  now = Date.parse('2026-10-27T14:31:00+07:00');
  app.ctx.jobsTick(); app.ctx.jobsTick(); // lần 1 báo quá số phút, lần 2 báo quá giờ phải xong
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE '%Quá 14:30%'").get().n > 0);
  const ok = await S('POST', `/api/jobs/${job.id}/done`, { photos: [img, img] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_photos WHERE job_id = ?').get(job.id).n, 1);
  const jr = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === tpl).job_rows.find((j) => j.id === job.id);
  assert.equal(jr.has_photo, true); assert.equal(jr.extra_photos.length, 1); // ảnh hiện ngay trong thẻ
});

test('Việc chung cả quán: 1 thẻ (không chia khu), giao bạn cố định; lưu ý chung', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  const za = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').get().id;
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const a = (await O('POST', '/api/staff', { name: 'Phát', team_id: pv, pin: '5851' })).data.id;
  const b = (await O('POST', '/api/staff', { name: 'Tú', team_id: pv, pin: '5852' })).data.id;
  const today = app.ctx.today();
  for (const sid of [a, b]) db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g${sid}`, sid, pv, today, za);
  const it = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Rửa sàn xi măng', job_scope: 'shop' })).data.id;
  assert.equal((await O('PATCH', `/api/checklist-items/${it}`, { job_fixed_staff: b })).status, 200);
  await O('GET', '/api/checklists');
  const rows = db.prepare('SELECT zone_id, staff_id FROM jobs WHERE item_id = ? AND date = ?').all(it, today);
  assert.equal(rows.length, 1); assert.equal(rows[0].zone_id, 0); assert.equal(rows[0].staff_id, b);
  assert.equal((await O('PUT', `/api/checklist-templates/${tpl}/note`, { note: 'Ăn cơm 15h35–15h55' })).status, 200);
  const card = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === tpl);
  assert.equal(card.note, 'Ăn cơm 15h35–15h55');
  assert.equal(card.item_list.find((i) => i.id === it).job_fixed_staff, b);
});

test('Chép việc Khu A sang B, C: chép cả hướng dẫn / thời gian, bỏ qua việc trùng', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  const [za, zb, zc] = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').all().map((z) => z.id);
  const i1 = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Quét sạch khu', zone_id: za })).data.id;
  await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Kéo bạt', zone_id: za });
  await O('PATCH', `/api/checklist-items/${i1}`, { job_guide: 'Chổi + hốt rác', job_minutes: 15, job_photos: 4 });
  await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Kéo bạt', zone_id: zb }); // B đã có
  const r = await O('POST', `/api/checklist-templates/${tpl}/copy-zone`, { from: za, to: [zb, zc] });
  assert.equal(r.status, 200);
  assert.equal(r.data.copied, 3);
  const c = db.prepare('SELECT * FROM checklist_items WHERE template_id = ? AND job_zone_id = ? ORDER BY sort').all(tpl, zc);
  assert.deepEqual(c.map((x) => x.text), ['Quét sạch khu', 'Kéo bạt']);
  assert.equal(c[0].job_guide, 'Chổi + hốt rác'); assert.equal(c[0].job_minutes, 15); assert.equal(c[0].job_photos, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE template_id = ? AND job_zone_id = ?').get(tpl, zb).n, 2);
});

test('Chia việc: chỉ nữ giao bạn nữ; người cố định; 14:15 chưa chấm vào → chuyển việc', async (t) => {
  let now = Date.parse('2026-10-27T12:00:00+07:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  db.prepare("DELETE FROM checklist_items WHERE template_id = ?").run(tpl); // chỉ giữ việc của test
  const za = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').get().id;
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const mk = async (name, pin, gender) => { const id = (await O('POST', '/api/staff', { name, team_id: pv, pin })).data.id; await O('PATCH', `/api/staff/${id}`, { gender }); return id; };
  const nam = await mk('Phát', '5861', 'nam'), nu1 = await mk('Ngân', '5862', 'nu'), nu2 = await mk('Ý', '5863', 'nu');
  assert.equal((await O('GET', '/api/staff')).data.find((x) => x.id === nu1).gender, 'nu');
  const today = app.ctx.today();
  for (const sid of [nam, nu1, nu2]) db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g${sid}`, sid, pv, today, za);
  const wc = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Kiểm tra nhà vệ sinh Nữ', zone_id: za })).data.id;
  await O('PATCH', `/api/checklist-items/${wc}`, { job_gender: 'nu', job_minutes: 30 });
  const gas = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Check bình gas', zone_id: za })).data.id;
  await O('PATCH', `/api/checklist-items/${gas}`, { job_fixed_staff: nu2 });
  await O('GET', '/api/checklists');
  const who = (item) => db.prepare('SELECT staff_id FROM jobs WHERE item_id = ? AND date = ?').get(item, today)?.staff_id;
  assert.ok([nu1, nu2].includes(who(wc)), 'việc chỉ nữ giao bạn nữ');
  assert.equal(who(gas), nu2, 'người cố định');
  // Ngân + Phát chấm vào, Ý không đến → 14:16 chuyển việc của Ý
  for (const sid of [nam, nu1]) db.prepare('INSERT INTO attendance (staff_id, date, clock_in) VALUES (?, ?, ?)').run(sid, today, Date.parse('2026-10-27T13:55:00+07:00'));
  now = Date.parse('2026-10-27T14:16:00+07:00');
  app.ctx.jobsTick();
  assert.notEqual(who(gas), nu2);
  assert.ok([nam, nu1].includes(who(gas)));
  if (who(wc) !== undefined) assert.equal(who(wc), nu1, 'việc chỉ nữ chuyển cho bạn nữ còn lại');
});

test('Việc chung nhiều bạn cùng làm: mỗi bạn có ca 1 thẻ; bạn nghỉ thì không có thẻ', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const ids = [];
  for (const [n, pin] of [['Tú', '5871'], ['Phát', '5872'], ['Ý', '5873']]) ids.push((await O('POST', '/api/staff', { name: n, team_id: pv, pin })).data.id);
  const today = app.ctx.today();
  for (const sid of ids.slice(0, 2)) db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at) VALUES (?, ?, ?, ?, 840, 1380, 0)').run(`g${sid}`, sid, pv, today); // Ý nghỉ
  const it = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Lau toàn bộ chén đũa muỗng', job_scope: 'shop' })).data.id;
  assert.equal((await O('PATCH', `/api/checklist-items/${it}`, { job_crew: ids })).status, 200);
  const card = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === tpl);
  assert.deepEqual(card.item_list.find((i) => i.id === it).job_crew, ids);
  const rows = db.prepare('SELECT staff_id, owner_id FROM jobs WHERE item_id = ? AND date = ? ORDER BY staff_id').all(it, today);
  assert.deepEqual(rows.map((x) => x.staff_id), ids.slice(0, 2));
  // còn 1 bạn → thành người cố định, 1 thẻ chung
  await O('PATCH', `/api/checklist-items/${it}`, { job_crew: [ids[1]] });
  await O('GET', '/api/checklists');
  const one = db.prepare('SELECT staff_id, owner_id FROM jobs WHERE item_id = ? AND date = ?').all(it, today);
  assert.equal(one.length, 1); assert.equal(one[0].owner_id, 0); assert.equal(one[0].staff_id, ids[1]);
});

test('Người vào sau khung đầu ca (16h, 17h): có trong danh sách để giao thêm việc, kèm tổng phút', async () => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  try {
    const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
    const mk = (name) => Number(db.prepare("INSERT INTO staff (name, role, team_id, active, created_at) VALUES (?, 'staff', ?, 1, 0)").run(name, pv).lastInsertRowid);
    const early = mk('Sớm'), late = mk('Muộn');
    const today = app.ctx.today();
    db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at) VALUES (?, ?, ?, ?, 840, 1380, 0)').run('g1', early, pv, today);
    db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at) VALUES (?, ?, ?, ?, 960, 1380, 0)').run('g2', late, pv, today);
    const o = app.ctx.openingInfo(today);
    assert.ok(o.people.some((x) => x.id === early));
    assert.ok(!o.people.some((x) => x.id === late));
    const l = o.later.find((x) => x.id === late);
    assert.ok(l); assert.equal(l.start, '16h');
    assert.equal(typeof o.loads, 'object');
  } finally { app.close(); }
});

test('Việc chỉ tổ trưởng / trưởng ca: chỉ giao cho tổ trưởng, trưởng ca', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  db.prepare('DELETE FROM checklist_items WHERE template_id = ?').run(tpl);
  const za = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').get().id;
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const nv = (await O('POST', '/api/staff', { name: 'NV', team_id: pv, pin: '5881' })).data.id;
  const tt = (await O('POST', '/api/staff', { name: 'Tổ trưởng', team_id: pv, pin: '5882', role: 'team_lead' })).data.id;
  const today = app.ctx.today();
  for (const sid of [nv, tt]) db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g${sid}`, sid, pv, today, za);
  const it = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Chụp tổng thể khu', zone_id: za })).data.id;
  const other = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Quét khu', zone_id: za })).data.id;
  for (const x of [other]) await O('PATCH', `/api/checklist-items/${x}`, { job_minutes: 30 });
  assert.equal((await O('PATCH', `/api/checklist-items/${it}`, { job_role: 'lead', job_minutes: 5 })).status, 200);
  await O('GET', '/api/checklists');
  assert.equal(db.prepare('SELECT staff_id FROM jobs WHERE item_id = ? AND date = ?').get(it, today).staff_id, tt);
});

test('Đóng ca phục vụ theo khu: thẻ có nhân sự giờ cuối (người đóng ca)', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  let tpl = db.prepare("SELECT id FROM checklist_templates WHERE title = 'Đóng ca phục vụ'").get()?.id;
  if (!tpl) tpl = Number(db.prepare("INSERT INTO checklist_templates (team_id, phase, title, sort, active, job_mode) VALUES (?, 'close', 'Đóng ca phục vụ', 0, 1, 1)").run(pv).lastInsertRowid);
  db.prepare('UPDATE checklist_templates SET active = 1, job_mode = 1, phase = ? WHERE id = ?').run('close', tpl);
  const za = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').get().id;
  const a = (await O('POST', '/api/staff', { name: 'Về muộn', team_id: pv, pin: '5891' })).data.id;
  const b = (await O('POST', '/api/staff', { name: 'Về sớm', team_id: pv, pin: '5892' })).data.id;
  const today = app.ctx.today();
  db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run('ga', a, pv, today, za);
  db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1080, 0, ?)').run('gb', b, pv, today, za);
  await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Dọn bàn khu A', zone_id: za });
  const card = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === tpl);
  assert.equal(card.opening_tpl, true);
  assert.ok(card.win);
  assert.equal(card.win.from, '22h'); assert.equal(card.win.to, '23h');
  assert.deepEqual(card.win.people.map((x) => x.name), ['Về muộn']);
});

test('Đóng ca: lưu ý riêng (không lấy giờ ăn cơm của Mở ca); khung 14h của đóng ca bị bỏ', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app0 = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  app0.close();
  const pv0 = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const cid = Number(db.prepare("INSERT INTO checklist_templates (team_id, phase, title, sort, active, job_mode, job_from, job_to) VALUES (?, 'close', 'Đóng ca phục vụ', 0, 1, 1, 840, 930)").run(pv0).lastInsertRowid);
  db.prepare("DELETE FROM settings WHERE key = 'dong_ca_win_v1'").run();
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const close = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(cid);
  assert.equal(close.job_from, null);
  const mo = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  await O('PUT', `/api/checklist-templates/${mo}/note`, { note: 'Ăn cơm 15h35–15h55' });
  const day = (await O('GET', '/api/checklists')).data;
  const c = day.jobs.find((j) => j.template_id === close.id);
  assert.equal(c.note, ''); // đóng ca không có giờ ăn cơm (chủ quán 27/10)
  assert.equal(c.note_tpl, close.id);
  assert.equal(day.jobs.find((j) => j.template_id === mo).note, 'Ăn cơm 15h35–15h55');
});

test('Tạp vụ / Bar / Bếp: giữ checklist, việc cũ cất bản lưu ẩn, giữ dòng kiểm kho', () => {
  const db = openDb(':memory:', { now: Date.now() });
  createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } }).close(); // lần chạy đầu
  db.prepare("DELETE FROM settings WHERE key = 'tv_bar_bep_clear_v1'").run();
  const team = (re) => db.prepare('SELECT id, name FROM teams').all().find((x) => re.test(x.name))?.id;
  const tv = team(/tạp vụ/i), bep = team(/bếp/i);
  const tpl = (teamId, title) => Number(db.prepare("INSERT INTO checklist_templates (team_id, phase, title, sort, active) VALUES (?, 'close', ?, 0, 1)").run(teamId, title).lastInsertRowid);
  const a = tpl(tv, 'Đóng ca khu bán hàng'), k = tpl(bep, 'Kiểm bếp');
  db.prepare("INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, extra_ingredient_ids, sort) VALUES (?, 'Gom rác', 'check', '', 1, 0, '[]', 0)").run(a);
  const ing = db.prepare('SELECT id FROM ingredients LIMIT 1').get()?.id ?? null;
  db.prepare("INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, extra_ingredient_ids, sort) VALUES (?, 'Lau bếp', 'check', '', 1, 0, '[]', 0)").run(k);
  if (ing) db.prepare("INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, extra_ingredient_ids, sort, ingredient_id) VALUES (?, 'Cân thịt bò', 'number', 'kg', 1, 0, '[]', 1, ?)").run(k, ing);
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  try {
    const items = (id) => db.prepare('SELECT text FROM checklist_items WHERE template_id = ?').all(id).map((x) => x.text);
    assert.deepEqual(items(a), []);
    assert.equal(db.prepare('SELECT active FROM checklist_templates WHERE id = ?').get(a).active, 1, 'giữ checklist');
    assert.deepEqual(items(k), ing ? ['Cân thịt bò'] : []);
    const arch = db.prepare("SELECT id, active FROM checklist_templates WHERE title = 'Đóng ca khu bán hàng (việc cũ 27/10)'").get();
    assert.ok(arch); assert.equal(arch.active, 0);
    assert.deepEqual(items(arch.id), ['Gom rác']);
  } finally { app.close(); }
});

test('Bắt ghi chú khi xong: thiếu ghi chú không cho Xong; có ghi chú thì lưu và hiện ở thẻ', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const O = mk();
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  db.prepare('DELETE FROM checklist_items WHERE template_id = ?').run(tpl);
  const za = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').get().id;
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const a = (await O('POST', '/api/staff', { name: 'Lan', team_id: pv, pin: '5901', phone: '0900000901' })).data.id;
  db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run('ga', a, pv, app.ctx.today(), za);
  const it = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Khu rửa chén đã rửa hết chưa?', zone_id: za, photo_required: false })).data.id;
  await O('PATCH', `/api/checklist-items/${it}`, { job_ask_note: true, job_photos: 0 });
  const job = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === tpl).job_rows.find((j) => j.item_id === it);
  const S = mk();
  await S('POST', '/api/login', { pin: '5901', phone: '0900000901' });
  assert.equal((await S('POST', `/api/jobs/${job.id}/claim`)).status, 200);
  assert.equal((await S('POST', `/api/jobs/${job.id}/done`, {})).status, 400);
  assert.equal((await S('POST', `/api/jobs/${job.id}/done`, { note: 'Còn 2 thau chưa rửa' })).status, 200);
  const row = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === tpl).job_rows.find((j) => j.id === job.id);
  assert.equal(row.done_note, 'Còn 2 thau chưa rửa');
});

test('Đóng ca giao cả khu cho người phụ trách: việc khu → tổ trưởng khu (hoặc người chọn cố định); việc chung → Tiếp thực', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const tt = db.prepare("SELECT id FROM teams WHERE name = 'Tiếp thực'").get()?.id || Number(db.prepare("INSERT INTO teams (name, sort, active) VALUES ('Tiếp thực', 9, 1)").run().lastInsertRowid);
  const tpl = Number(db.prepare("INSERT INTO checklist_templates (team_id, phase, title, sort, active, job_mode, job_teams) VALUES (?, 'close', 'Đóng ca phục vụ', 0, 1, 1, ?)").run(pv, JSON.stringify([pv, tt])).lastInsertRowid);
  const [za, zb] = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').all().map((z) => z.id);
  const mk = async (name, pin, team, role) => (await O('POST', '/api/staff', { name, pin, team_id: team, role })).data.id;
  const leadA = await mk('Tổ trưởng A', '5911', pv, 'team_lead'), nvA = await mk('NV A', '5912', pv, 'staff'), nvB = await mk('NV B', '5913', pv, 'staff'), ttx = await mk('Tiếp thực 1', '5914', tt, 'staff');
  const today = app.ctx.today();
  const ins = (sid, team, zone) => db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g${sid}`, sid, team, today, zone);
  ins(leadA, pv, za); ins(nvA, pv, za); ins(nvB, pv, zb); ins(ttx, tt, null);
  const a1 = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Thu dọn khu A', zone_id: za })).data.id;
  const b1 = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Thu dọn khu B', zone_id: zb })).data.id;
  const c1 = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Đổ rác cả quán', job_scope: 'shop' })).data.id;
  assert.equal((await O('PUT', `/api/checklist-templates/${tpl}/lead-mode`, { on: true })).status, 200);
  assert.equal((await O('PUT', `/api/checklist-templates/${tpl}/zone-lead`, { zone_id: zb, staff_id: nvB })).status, 200);
  const card = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === tpl);
  assert.equal(card.lead_mode, true);
  const who = (it) => db.prepare('SELECT staff_id FROM jobs WHERE item_id = ? AND date = ?').get(it, today)?.staff_id;
  assert.equal(who(a1), leadA);
  assert.equal(who(b1), nvB);
  assert.equal(who(c1), ttx);
  assert.equal(card.zone_leads[za].today, leadA);
  assert.equal(card.zone_leads[zb].fixed, nvB);
});

test('Đóng ca: trưởng ca chưa có bộ phận (có khu) vẫn được chọn làm người phụ trách khu', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const tpl = Number(db.prepare("INSERT INTO checklist_templates (team_id, phase, title, sort, active, job_mode, job_lead_mode) VALUES (?, 'close', 'Đóng ca phục vụ', 0, 1, 1, 1)").run(pv).lastInsertRowid);
  const za = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').get().id;
  const sl = (await O('POST', '/api/staff', { name: 'Đỗ Thiện', pin: '5921', role: 'shift_lead' })).data.id; // chưa có bộ phận
  const tl = (await O('POST', '/api/staff', { name: 'Thành Đạt', pin: '5922', role: 'team_lead', team_id: pv })).data.id;
  const today = app.ctx.today();
  db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, NULL, ?, 840, 1380, 0, ?)').run('g1', sl, today, za);
  db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run('g2', tl, pv, today, za);
  await O('PUT', `/api/checklist-templates/${tpl}/zone-lead`, { zone_id: za, staff_id: sl });
  const it = (await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Thu dọn khu A', zone_id: za })).data.id;
  const card = (await O('GET', '/api/checklists')).data.jobs.find((j) => j.template_id === tpl);
  assert.equal(card.zone_leads[za].today, sl);
  assert.equal(db.prepare('SELECT staff_id FROM jobs WHERE item_id = ? AND date = ?').get(it, today).staff_id, sl);
});
