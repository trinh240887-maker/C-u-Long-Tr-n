import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const JPG = `data:image/jpeg;base64,${Buffer.alloc(1200, 7).toString('base64')}`;

test('Việc ca: gợi ý chia việc theo khu (tiếp thực vào sớm hỗ trợ) → nhận → xong + ảnh → tổ trưởng kiểm → làm lại → quá giờ báo', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const sent = [];
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const O = mk();
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = 4;
  const tt = (await O('POST', '/api/teams', { name: 'Tiếp thực' })).data?.id || db.prepare("INSERT INTO teams (name) VALUES ('Tiếp thực')").run().lastInsertRowid;
  const mkStaff = async (name, role, pin, team) => (await O('POST', '/api/staff', { name, role, pin, team_id: team })).data.id;
  const lead = await mkStaff('Tổ trưởng A', 'team_lead', '481902', pv);
  const a1 = await mkStaff('PV A1', 'staff', '593017', pv);
  const b1 = await mkStaff('PV B1', 'staff', '702913', pv);
  const sup = await mkStaff('Tiếp thực sớm', 'staff', '815204', Number(tt));
  const date = app.ctx.today();
  const asg = db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, zone_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  asg.run('g1', lead, pv, date, 840, 1380, 1, Date.now());
  asg.run('g2', a1, pv, date, 840, 1380, 1, Date.now());
  asg.run('g3', b1, pv, date, 840, 1380, 2, Date.now());
  asg.run('g4', sup, Number(tt), date, 780, 1380, null, Date.now()); // vào sớm 1 tiếng, chưa phân khu
  const eve = await mkStaff('PV ca tối', 'staff', '926315', pv);
  asg.run('g5', eve, pv, date, 1080, 1380, 1, Date.now()); // ca 18h: ngoài khung mở ca 14:00–15:30 → không được phân

  // Chủ quán soạn checklist giao việc: Phục vụ + Tiếp thực dùng chung, chỉ Khu A, B
  db.prepare('UPDATE zones SET active = 0 WHERE id = 3').run();
  const tpl = (await O('POST', '/api/checklist-templates', { title: 'Mở ca Phục vụ (giao việc)', team_id: pv, phase: 'open', job_mode: true, job_teams: [pv, Number(tt)], job_from: '14:00', job_to: '15:30', items: [
    { text: 'Lau muỗng', job_qty: '200 cái', job_minutes: 20, photo_required: true },
    { text: 'Check bếp ga', job_per_table: 1, unit: 'bếp', job_minutes: 10, photo_required: false },
    { text: 'Châm tương ớt', job_minutes: 5, fetch_where: 'Kệ 2 Kho bếp', photo_required: false },
    { text: 'Tưới cây', job_scope: 'shop', job_minutes: 15, photo_required: false },
  ] })).data;
  assert.ok(tpl.id, JSON.stringify(tpl));
  // Checklist giao việc không hiện ở checklist thường
  assert.ok(!(await O('GET', '/api/checklists')).data.runs.some((x) => x.template_id === tpl.id));
  assert.ok((await O('GET', '/api/checklists')).data.jobs.some((x) => x.template_id === tpl.id), 'vẫn hiện thẻ tóm tắt ở màn Checklist');

  const board = (await O('GET', '/api/jobs/board')).data;
  const T = board.templates.find((x) => x.id === tpl.id);
  assert.deepEqual(T.zones.map((z) => z.zone_id), [1, 2, 0]);
  const all = T.zones.flatMap((z) => z.jobs);
  assert.equal(all.length, 3 * 2 + 1);
  const ga = all.find((j) => j.title === 'Check bếp ga' && j.zone_id === 1);
  assert.equal(ga.qty, '40 bếp');
  assert.ok(all.every((j) => j.staff_id), 'mọi việc đều có người được gợi ý');
  // Việc khu B không giao cho người khu A
  assert.ok(T.zones.find((z) => z.zone_id === 2).jobs.every((j) => j.staff_id !== a1 && j.staff_id !== lead));
  assert.ok(all.every((j) => j.staff_id !== eve), 'người ca tối không được phân việc mở ca');
  assert.equal(T.window, '14:00–15:30');
  assert.ok(!T.zones.find((z) => z.zone_id === 1).people.some((p) => p.id === eve));
  // Tiếp thực vào sớm được giao việc
  assert.ok(all.some((j) => j.staff_id === sup));
  // Người kiểm tra khu A = tổ trưởng có ca ở khu A
  assert.deepEqual(T.zones.find((z) => z.zone_id === 1).checkers.map((x) => x.id), [lead]);

  const S = {}; for (const [id, pin] of [[lead, '481902'], [a1, '593017'], [b1, '702913'], [sup, '815204']]) { S[id] = mk(); await S[id]('POST', '/api/login', { pin }); }
  const job = all.find((j) => j.title === 'Lau muỗng' && j.zone_id === 1);
  const doer = job.staff_id, other = [lead, a1, sup].find((x) => x !== doer);
  assert.equal((await S[other]('POST', `/api/jobs/${job.id}/claim`)).status, 409); // đã giao cho người khác
  const mine = (await S[doer]('GET', '/api/jobs/mine')).data;
  assert.ok(mine.mine.some((j) => j.id === job.id));
  assert.equal((await S[doer]('POST', `/api/jobs/${job.id}/done`)).status, 409); // chưa nhận
  const cl = (await S[doer]('POST', `/api/jobs/${job.id}/claim`)).data;
  assert.ok(cl.due_at > Date.now() + 19 * 60_000);
  assert.equal((await S[doer]('POST', `/api/jobs/${job.id}/done`, {})).status, 400); // bắt buộc ảnh
  assert.equal((await S[doer]('POST', `/api/jobs/${job.id}/done`, { data: JPG })).data.late, false);
  // Tổ trưởng kiểm: làm lại → trả về người làm, đồng hồ chạy lại
  const checker = doer === lead ? O : S[lead];
  assert.equal((await S[b1]('POST', `/api/jobs/${job.id}/check`, { ok: true })).status, 403); // người khu khác không kiểm
  assert.equal((await checker('POST', `/api/jobs/${job.id}/check`, { ok: false })).status, 400); // cần lý do
  assert.equal((await checker('POST', `/api/jobs/${job.id}/check`, { ok: false, note: 'Còn vết nước' })).status, 200);
  let j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  assert.equal(j.status, 'doing'); assert.equal(j.redo_count, 1);
  // Quá giờ → báo người kiểm tra, ghi trễ
  db.prepare('UPDATE jobs SET due_at = ? WHERE id = ?').run(Date.now() - 1000, job.id);
  const before = db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
  app.ctx.jobsTick();
  j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
  assert.equal(j.late, 1); assert.equal(j.alerted, 1);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n > before);
  await S[doer]('POST', `/api/jobs/${job.id}/done`, { data: JPG });
  assert.equal((await checker('POST', `/api/jobs/${job.id}/check`, { ok: true })).status, 200);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'ok');

  // Tổ trưởng đổi người cho việc chưa làm; chia lại không đụng việc đã xong
  const ga2 = all.find((j2) => j2.title === 'Check bếp ga' && j2.zone_id === 1);
  assert.equal((await S[lead]('PATCH', `/api/jobs/${ga2.id}`, { staff_id: sup })).status, 200);
  assert.equal((await S[sup]('POST', `/api/jobs/${ga2.id}/claim`)).status, 200);
  assert.equal((await S[lead]('POST', '/api/jobs/reassign', {})).status, 200);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'ok');
  assert.equal(db.prepare('SELECT staff_id FROM jobs WHERE id = ?').get(ga2.id).staff_id, sup);
  // Báo hết đồ, ảnh tổng khu, báo cáo
  assert.equal((await S[sup]('POST', `/api/jobs/${ga2.id}/out`, { what: 'Tương ớt' })).status, 200);
  assert.equal((await S[lead]('POST', '/api/jobs/zone-photo', { template_id: tpl.id, zone_id: 1, data: JPG })).status, 200);
  const rep = (await O('GET', '/api/jobs/report')).data;
  const rd = rep.staff.find((x) => x.staff_id === doer);
  assert.equal(rd.late, 1); assert.equal(rd.redo, 1);

  // Cả tuần: ngày mai theo lịch mới nhất, giữ việc chọn tay; checklist thêm việc → tự thêm vào các ngày
  const tmr = (await import('../server/lib/time.js')).addDays(date, 1);
  asg.run('h1', a1, pv, tmr, 840, 1380, 1, Date.now());
  asg.run('h2', b1, pv, tmr, 840, 1380, 2, Date.now());
  const wk = (await O('GET', `/api/jobs/week?start=${tmr}`)).data;
  assert.equal(wk.days.length, 7);
  const cellA = wk.templates.find((x) => x.id === tpl.id).rows.find((r) => r.zone_id === 1).cells.find((c) => c.date === tmr);
  assert.equal(cellA.people, 1); assert.equal(cellA.jobs, 3); assert.equal(cellA.unassigned, 0);
  let tb = (await O('GET', `/api/jobs/board?date=${tmr}`)).data.templates.find((x) => x.id === tpl.id);
  assert.ok(tb.zones.find((z) => z.zone_id === 1).jobs.every((x) => x.staff_id === a1), JSON.stringify(tb.zones.map((z) => z.jobs.map((x) => [x.title, x.staff_name, x.minutes]))));
  // Tổ trưởng chọn tay 1 việc cho người khu B → giữ nguyên khi lịch đổi
  const pick = tb.zones.find((z) => z.zone_id === 1).jobs[0];
  assert.equal((await O('PATCH', `/api/jobs/${pick.id}`, { staff_id: b1 })).status, 200);
  asg.run('h3', lead, pv, tmr, 840, 1380, 1, Date.now()); // thêm tổ trưởng vào khu A ngày mai
  tb = (await O('GET', `/api/jobs/board?date=${tmr}`)).data.templates.find((x) => x.id === tpl.id);
  const zA = tb.zones.find((z) => z.zone_id === 1).jobs;
  assert.equal(zA.find((x) => x.id === pick.id).staff_id, b1);
  assert.ok(zA.some((x) => x.staff_id === lead), 'lịch thêm người → app chia lại');
  // Thêm việc mới vào checklist → hôm nay và ngày mai tự có thẻ
  const full = (await O('GET', '/api/checklist-templates')).data.find((x) => x.id === tpl.id);
  await O('PATCH', `/api/checklist-templates/${tpl.id}`, { items: [...full.items, { text: 'Lau menu', job_minutes: 5, photo_required: false }] });
  for (const d of [date, tmr]) {
    const tz = (await O('GET', `/api/jobs/board?date=${d}`)).data.templates.find((x) => x.id === tpl.id);
    assert.equal(tz.zones.flatMap((z) => z.jobs).filter((x) => x.title === 'Lau menu').length, 2, d);
  }

  // Mỗi người tự làm + số phải đủ: cuối ca mỗi bạn giặt 2 khăn của mình, thiếu → ghi vào tên (đền)
  const kh = (await O('POST', '/api/checklist-templates', { title: 'Cuối ca: khăn', team_id: pv, phase: 'close', job_mode: true, job_teams: [pv, Number(tt)], items: [
    { text: 'Giặt + phơi khăn của mình', job_scope: 'each', job_expect: 2, unit: 'khăn', job_minutes: 10, photo_required: false }] })).data;
  const kb = (await O('GET', '/api/jobs/board')).data.templates.find((x) => x.id === kh.id);
  const kj = kb.zones.flatMap((z) => z.jobs);
  assert.deepEqual(kj.map((x) => x.staff_id).sort(), [lead, a1, b1, sup, eve].sort(), 'mỗi người có ca 1 thẻ');
  const mineK = kj.find((x) => x.staff_id === b1);
  await S[b1]('POST', `/api/jobs/${mineK.id}/claim`);
  assert.equal((await S[b1]('POST', `/api/jobs/${mineK.id}/done`, {})).status, 400); // phải nhập số
  assert.equal((await S[b1]('POST', `/api/jobs/${mineK.id}/done`, { count: 1 })).data.short, 1);
  assert.equal((await O('GET', '/api/jobs/report')).data.staff.find((x) => x.staff_id === b1).short, 1);

  // Đi kèm việc: giặt khăn lau chén → đúng người lau muỗng của khu; đổi người việc chính → việc kèm theo; trưởng ca cũng làm
  const sl = await mkStaff('Trưởng ca', 'shift_lead', '637281', null);
  asg.run('h4', sl, null, tmr, 840, 1380, 2, Date.now());
  const cur2 = (await O('GET', '/api/checklist-templates')).data.find((x) => x.id === tpl.id);
  const muong = cur2.items.find((x) => x.text === 'Lau muỗng');
  assert.equal((await O('PATCH', `/api/checklist-templates/${tpl.id}`, { job_teams: [pv, Number(tt), -1], items: [...cur2.items, { text: 'Giặt khăn lau chén', job_with: muong.id, job_minutes: 5, photo_required: false }] })).status, 200);
  const kid = (await O('GET', '/api/checklist-templates')).data.find((x) => x.id === tpl.id).items.find((x) => x.text === 'Giặt khăn lau chén');
  assert.equal(kid.job_with, muong.id);
  const bt = (await O('GET', `/api/jobs/board?date=${tmr}`)).data.templates.find((x) => x.id === tpl.id);
  for (const z of bt.zones.filter((z2) => z2.zone_id)) {
    const m = z.jobs.find((x) => x.title === 'Lau muỗng'), k = z.jobs.find((x) => x.title === 'Giặt khăn lau chén');
    assert.equal(k.staff_id, m.staff_id, `khu ${z.zone_id}`);
    assert.equal(k.with_title, 'Lau muỗng');
  }
  assert.ok(bt.zones.find((z) => z.zone_id === 2).people.some((x) => x.id === sl), 'trưởng ca có trong danh sách người làm');
  const mB = bt.zones.find((z) => z.zone_id === 2).jobs.find((x) => x.title === 'Lau muỗng');
  const newer = mB.staff_id === sl ? b1 : sl;
  await O('PATCH', `/api/jobs/${mB.id}`, { staff_id: newer });
  const kB = (await O('GET', `/api/jobs/board?date=${tmr}`)).data.templates.find((x) => x.id === tpl.id).zones.find((z) => z.zone_id === 2).jobs.find((x) => x.title === 'Giặt khăn lau chén');
  assert.equal(kB.staff_id, newer);

  // Khu thiếu người (không ai có ca ở khu C) → mượn người khu khác
  db.prepare('UPDATE zones SET active = 1 WHERE id = 3').run();
  const d3 = (await import('../server/lib/time.js')).addDays(date, 2);
  asg.run('k1', a1, pv, d3, 840, 1380, 1, Date.now()); asg.run('k2', lead, pv, d3, 840, 1380, 1, Date.now()); asg.run('k3', b1, pv, d3, 840, 1380, 2, Date.now());
  const b3 = (await O('GET', `/api/jobs/board?date=${d3}`)).data.templates.find((x) => x.id === tpl.id);
  const zC = b3.zones.find((z) => z.zone_id === 3);
  assert.ok(zC.jobs.every((x) => x.staff_id), 'khu C không ai có ca → vẫn có người được mượn');
  assert.ok(zC.people.some((p) => p.borrowed));
  void sent;
});
