import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));

async function setup() {
  let now = at('2026-10-19', '08:00'); // thứ Hai
  const sent = [];
  const db = openDb(':memory:', { now });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-'));
  const app = createApp({
    db, now: () => now, publicDir: path.join(here, '..', 'public'), backupDir: dir,
    zaloTransport: { send: async (m) => { sent.push(m); } },
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
        body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    };
    return {
      get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b),
      put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u),
      async login(pin) { const r = await call('POST', '/api/login', { pin }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; },
    };
  };
  return {
    db, app, client, sent,
    setNow: (ms) => { now = ms; },
    close: () => new Promise((r) => { app.close(); server.close(r); }),
  };
}

const TINY_JPG = `data:image/jpeg;base64,${Buffer.alloc(800, 7).toString('base64')}`;

test('luồng nhân sự: tạo người, xếp ca, chấm công qua đêm, xin nghỉ & người thay, checklist, việc, bảng công', async (t) => {
  const env = await setup();
  t.after(env.close);
  const owner = env.client();

  // Đăng nhập chủ, bắt đổi PIN
  await owner.login(DEFAULT_OWNER_PIN);
  let me = (await owner.get('/api/me')).data;
  assert.equal(me.role, 'owner');
  assert.equal(me.must_change_pin, true);
  assert.equal((await owner.post('/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '111111' })).status, 400); // quá dễ đoán
  assert.equal((await owner.post('/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' })).status, 200);

  const teams = (await owner.get('/api/teams')).data;
  const team = Object.fromEntries(teams.map((x) => [x.name, x.id]));

  // Tạo nhân viên
  const mk = async (body) => {
    const r = await owner.post('/api/staff', body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.id;
  };
  const ql = await mk({ name: 'Hùng', role: 'manager', team_id: null, pin: '736251' });
  const lan = await mk({ name: 'Lan', role: 'staff', team_id: team['Bar'], pin: '4821', pay_type: 'hour', pay_rate: 25000 });
  const minh = await mk({ name: 'Minh', role: 'staff', team_id: team['Phục vụ'], pin: '5932', skills: [{ team_id: team['Bar'], level: 2 }], pay_type: 'shift', pay_rate: 220000 });
  const tu = await mk({ name: 'Tú', role: 'team_lead', team_id: team['Bar'], pin: '6043' });
  assert.equal((await owner.post('/api/staff', { name: 'Trùng PIN', pin: '4821' })).status, 400);

  // Quản lý không được tạo chủ
  const hung = env.client();
  await hung.login('736251');
  assert.equal((await hung.post('/api/staff', { name: 'X', role: 'owner', pin: '918273' })).status, 403);

  // Loại ca do quán tự tạo + xếp lịch
  const tpl = (await owner.post('/api/shift-templates', { name: 'Ca đóng', segments: [{ start: '17:00', end: '00:30' }] })).data.id;
  const s1 = await owner.post('/api/shifts', { staff_id: lan, date: '2026-10-19', template_id: tpl });
  assert.equal(s1.status, 200, JSON.stringify(s1.data));
  // Trùng giờ bị chặn
  assert.equal((await owner.post('/api/shifts', { staff_id: lan, date: '2026-10-19', segments: [{ start: '23:00', end: '02:00' }] })).status, 409);
  // Ca gãy cho Minh ngày thứ Bảy
  const split = await owner.post('/api/shifts', { staff_id: lan, date: '2026-10-24', label: 'Ca gãy', segments: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '22:00' }] });
  assert.equal(split.status, 200);

  const week = (await owner.get('/api/schedule?week=2026-10-21')).data;
  assert.equal(week.week_start, '2026-10-19');
  assert.equal(week.shifts.length, 2);
  assert.ok(week.warnings.some((w) => /Bếp steak/.test(w.text)));

  // Gửi lịch → thông báo cho Lan
  assert.equal((await owner.post('/api/schedule/publish', { week: '2026-10-19' })).data.sent, 1);

  // Lan chấm công ca qua đêm, trễ 10 phút
  const lanC = env.client();
  await lanC.login('4821');
  env.setNow(at('2026-10-19', '17:10'));
  const cin = await lanC.post('/api/attendance/clock-in');
  assert.equal(cin.status, 200, JSON.stringify(cin.data));
  assert.equal(cin.data.late_minutes, 10);
  assert.equal(cin.data.scheduled, true);
  env.setNow(at('2026-10-20', '00:40'));
  assert.equal((await lanC.post('/api/attendance/clock-out')).status, 200);
  const rec = (await owner.get('/api/attendance?from=2026-10-19&to=2026-10-19')).data;
  assert.equal(rec.length, 1);
  assert.equal(rec[0].date, '2026-10-19');

  // Lan xin nghỉ ca thứ Bảy → gợi ý → mời Minh → Minh nhận → quản lý duyệt
  env.setNow(at('2026-10-21', '09:00'));
  const shifts = (await lanC.get('/api/my-shifts')).data;
  const sat = shifts.find((x) => x.date === '2026-10-24');
  assert.ok(sat);
  const leave = await lanC.post('/api/leave', { group_id: sat.group_id, reason: 'Về quê' });
  assert.equal(leave.status, 200, JSON.stringify(leave.data));

  const tuC = env.client();
  await tuC.login('6043');
  const sug = (await tuC.get(`/api/leave/${leave.data.id}/suggestions`)).data;
  const eligible = sug.candidates.filter((c) => c.eligible).map((c) => c.name);
  assert.ok(eligible.includes('Minh'));
  assert.ok(eligible.includes('Tú'));
  assert.ok(!sug.candidates.some((c) => c.name === 'Lan'));
  assert.equal((await tuC.post(`/api/leave/${leave.data.id}/invite`, { staff_ids: [minh] })).status, 200);

  const minhC = env.client();
  await minhC.login('5932');
  const offers = (await minhC.get('/api/offers/me')).data;
  assert.equal(offers.length, 1);
  assert.equal((await minhC.post(`/api/offers/${offers[0].id}/respond`, { accept: true })).status, 200);

  assert.equal((await tuC.post(`/api/leave/${leave.data.id}/decide`, { approve: true, replacement_id: minh })).status, 403); // tổ trưởng không duyệt
  const ok = await hung.post(`/api/leave/${leave.data.id}/decide`, { approve: true, replacement_id: minh });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const minhShifts = (await minhC.get('/api/my-shifts')).data;
  assert.ok(minhShifts.some((x) => x.date === '2026-10-24' && x.text === '10:00–14:00 + 17:00–22:00'));
  const notes = (await lanC.get('/api/notifications')).data;
  assert.ok(notes.some((n) => /Đã duyệt nghỉ/.test(n.title)));

  // Checklist: Lan (Bar) chỉ thấy checklist của Bar
  const cl = (await lanC.get('/api/checklists')).data;
  assert.ok(cl.runs.length > 0);
  assert.ok(cl.runs.every((x) => x.team_name === 'Bar'));
  const run = cl.runs[0];
  for (const item of run.items) {
    if (item.photo_required) {
      // Việc bắt buộc ảnh: chưa có ảnh thì không bấm xong được
      assert.equal((await lanC.post('/api/checklists/entry', { run_id: run.run_id, item_id: item.id, value: 'ok' })).status, 400);
      assert.equal((await lanC.post('/api/checklists/photo', { run_id: run.run_id, item_id: item.id, data: TINY_JPG })).status, 200);
    }
    const r = await lanC.post('/api/checklists/entry', { run_id: run.run_id, item_id: item.id, value: item.kind === 'number' ? '4' : 'ok' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const after = (await lanC.get('/api/checklists')).data.runs.find((x) => x.run_id === run.run_id);
  assert.equal(after.done, after.total);
  assert.ok(after.completed_at);
  // Không được tick checklist của tổ khác
  const other = (await owner.get('/api/checklists')).data.runs.find((x) => x.team_name === 'Bếp steak');
  assert.equal((await lanC.post('/api/checklists/entry', { run_id: other.run_id, item_id: other.items[0].id, value: '3' })).status, 403);

  // Giao việc
  const task = await tuC.post('/api/tasks', { title: 'Lau tủ mát', assignee_id: lan, due_at: '2026-10-21T15:00' });
  assert.equal(task.status, 200, JSON.stringify(task.data));
  assert.equal((await tuC.post('/api/tasks', { title: 'Sai tổ', team_id: team['Bếp steak'] })).status, 403);
  assert.equal((await lanC.patch(`/api/tasks/${task.data.id}`, { status: 'done' })).status, 200);

  // Bảng việc quản lý
  env.setNow(at('2026-10-24', '18:00'));
  const dash = (await hung.get('/api/dashboard')).data;
  assert.equal(dash.today, '2026-10-24');
  const barPeople = dash.teams.find((x) => x.name === 'Bar').people;
  assert.ok(barPeople.some((p) => p.staff_name === 'Lan' && p.status === 'leave'));
  assert.ok(barPeople.some((p) => p.staff_name === 'Minh' && p.status === 'late')); // chưa chấm vào khúc 10h

  // Bảng công tháng
  const ts = (await owner.get('/api/timesheet?month=2026-10')).data;
  const lanRow = ts.rows.find((x) => x.name === 'Lan');
  assert.equal(lanRow.minutes, 450);
  assert.equal(lanRow.night_minutes, 160);
  assert.equal(lanRow.late_count, 1);
  // Nhân viên thường không xem được bảng công
  assert.equal((await lanC.get('/api/timesheet?month=2026-10')).status, 403);

  // Tự đóng ca khi quên chấm ra
  env.setNow(at('2026-10-25', '10:05'));
  await owner.post('/api/shifts', { staff_id: tu, date: '2026-10-25', segments: [{ start: '10:00', end: '14:00' }] });
  assert.equal((await tuC.post('/api/attendance/clock-in')).status, 200);
  env.setNow(at('2026-10-25', '16:30'));
  const auto = (await owner.get('/api/attendance?from=2026-10-25&to=2026-10-25')).data[0];
  assert.equal(auto.auto_closed, 1);
  assert.equal(auto.clock_out, at('2026-10-25', '14:00'));

  // Sao lưu
  const b = await owner.post('/api/backup');
  assert.equal(b.status, 200);
  assert.equal(b.data.backups.length, 1);
});

test('bảo mật: khoá sau 5 lần sai PIN, chặn chấm công ngoài wifi quán, ẩn khoá bí mật', async (t) => {
  const env = await setup();
  t.after(env.close);
  const c = env.client();
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/login', { pin: '999999' })).status, 401);
  assert.equal((await c.post('/api/login', { pin: DEFAULT_OWNER_PIN })).status, 429);

  env.setNow(at('2026-10-19', '08:20'));
  const d = env.client();
  await d.login(DEFAULT_OWNER_PIN);
  await d.put('/api/settings', { clock_ip_prefixes: '192.168.1.' });
  assert.equal((await d.post('/api/attendance/clock-in')).status, 403);

  assert.equal((await d.get('/api/settings')).data.zalo_secret_key, '');
});

test('Zalo: liên kết bằng mã qua webhook và gửi thông báo qua hàng đợi', async (t) => {
  const env = await setup();
  t.after(env.close);
  const c = env.client();
  await c.login(DEFAULT_OWNER_PIN);
  await c.put('/api/settings', { zalo_enabled: true });
  const { code } = (await c.post('/api/me/zalo-code')).data;
  assert.match(code, /^[A-Z0-9]{6}$/);
  const key = env.db.prepare("SELECT value FROM settings WHERE key = 'zalo_webhook_key'").get().value;
  const hook = env.app.ctx.notifier.matchWebhook('POST', `/webhooks/zalo/${key}`);
  hook({ event_name: 'user_send_text', sender: { id: 'zalo-123' }, message: { text: `lk ${code.toLowerCase()}` } });
  assert.equal((await c.get('/api/me')).data.zalo_linked, true);
  env.app.ctx.notify(1, { title: 'Thử', body: 'Nội dung', urgent: true });
  await env.app.ctx.notifier.processQueue();
  assert.ok(env.sent.some((m) => m.userId === 'zalo-123' && m.text.startsWith('Thử')));
  assert.equal(env.app.ctx.notifier.matchWebhook('POST', '/webhooks/zalo/' + '0'.repeat(32)), null);
});

test('checklist theo ca: người làm ca sáng chỉ thấy checklist ca sáng', async (t) => {
  const env = await setup();
  t.after(env.close);
  const o = env.client();
  await o.login(DEFAULT_OWNER_PIN);
  const bar = (await o.get('/api/teams')).data.find((x) => x.name === 'Bar').id;
  const sang = (await o.post('/api/shift-templates', { name: 'Ca sáng', segments: [{ start: '09:00', end: '15:00' }] })).data.id;
  const chieu = (await o.post('/api/shift-templates', { name: 'Ca chiều', segments: [{ start: '15:00', end: '23:00' }] })).data.id;
  for (const [title, shift] of [['Mở ca sáng bar', sang], ['Mở ca chiều bar', chieu]]) {
    assert.equal((await o.post('/api/checklist-templates', { title, team_id: bar, phase: 'open', shift_template_id: shift, items: [{ text: 'Đá viên' }] })).status, 200);
  }
  const a = (await o.post('/api/staff', { name: 'An', team_id: bar, pin: '4821' })).data.id;
  const b = (await o.post('/api/staff', { name: 'Bình', team_id: bar, pin: '5932' })).data.id;
  await o.post('/api/shifts', { staff_id: a, date: '2026-10-19', template_id: sang });
  await o.post('/api/shifts', { staff_id: b, date: '2026-10-19', segments: [{ start: '15:00', end: '23:00' }], label: 'Ca chiều' });
  const an = env.client(); await an.login('4821');
  const binh = env.client(); await binh.login('5932');
  const titles = async (c) => (await c.get('/api/checklists?date=2026-10-19')).data.runs.map((r) => r.title);
  const tA = await titles(an);
  const tB = await titles(binh);
  assert.ok(tA.includes('Mở ca sáng bar') && !tA.includes('Mở ca chiều bar'));
  assert.ok(tB.includes('Mở ca chiều bar') && !tB.includes('Mở ca sáng bar'));
  assert.ok(tA.includes('Mở ca bar (mẫu)')); // checklist "Mọi ca" vẫn hiện
  const run = (await o.get('/api/checklists?date=2026-10-19')).data.runs.find((r) => r.title === 'Mở ca chiều bar');
  assert.equal(run.shift_name, 'Ca chiều');
  assert.equal((await an.post('/api/checklists/entry', { run_id: run.run_id, item_id: run.items[0].id })).status, 403);
});

test('tổ trưởng tạo và sửa checklist của tổ mình, không đụng được tổ khác', async (t) => {
  const env = await setup();
  t.after(env.close);
  const o = env.client();
  await o.login(DEFAULT_OWNER_PIN);
  const teams = Object.fromEntries((await o.get('/api/teams')).data.map((x) => [x.name, x.id]));
  await o.post('/api/staff', { name: 'Tú', role: 'team_lead', team_id: teams['Bar'], pin: '6043' });
  await o.post('/api/staff', { name: 'Lan', role: 'staff', team_id: teams['Bar'], pin: '4821' });
  const tu = env.client(); await tu.login('6043');
  const lan = env.client(); await lan.login('4821');
  const mine = await tu.post('/api/checklist-templates', { title: 'Đóng ca bar', team_id: teams['Bar'], phase: 'close', items: [{ text: 'Rửa máy xay' }] });
  assert.equal(mine.status, 200);
  assert.equal((await tu.patch(`/api/checklist-templates/${mine.data.id}`, { title: 'Đóng ca bar (sửa)' })).status, 200);
  assert.equal((await tu.post('/api/checklist-templates', { title: 'X', team_id: teams['Bếp steak'], items: [{ text: 'a' }] })).status, 403);
  assert.equal((await tu.post('/api/checklist-templates', { title: 'X', team_id: null, items: [{ text: 'a' }] })).status, 403);
  assert.equal((await tu.patch(`/api/checklist-templates/${mine.data.id}`, { team_id: teams['Lẩu'] })).status, 403);
  const bep = (await o.get('/api/checklist-templates')).data.find((c) => c.team_id === teams['Bếp steak']);
  assert.equal((await tu.patch(`/api/checklist-templates/${bep.id}`, { title: 'hack' })).status, 403);
  assert.equal((await lan.post('/api/checklist-templates', { title: 'X', team_id: teams['Bar'], items: [{ text: 'a' }] })).status, 403);
});
