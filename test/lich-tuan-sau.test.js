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
const WEEK = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
const PREV = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];

test('lịch tuần sau: bot báo thì bỏ lịch cố định tự điền; "Chép tuần trước" không đè người đã tự báo; sửa lại tuần từ tin bot đã lưu', async (t) => {
  const now = clock.toEpoch('2026-10-29', 10 * 60);
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const o = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const { ctx } = app;
  const bep = Number(db.prepare("INSERT INTO teams (name, sort, min_staff) VALUES ('Bếp nóng', 9, 1)").run().lastInsertRowid);
  const mk = (name) => Number(db.prepare("INSERT INTO staff (name, role, team_id, created_at) VALUES (?, 'staff', ?, 0)").run(name, bep).lastInsertRowid);
  const lan = mk('Lan Bếp'), hoa = mk('Hoa Bếp'), mai = mk('Mai Bếp');
  const fixed = (id) => { for (let dow = 1; dow <= 7; dow++) for (const sl of ['08:00-12:00', '14:00-23:00']) db.prepare('INSERT INTO availability_fixed (staff_id, dow, slot) VALUES (?, ?, ?)').run(id, dow, sl); };
  const datesOf = (table, id) => db.prepare(`SELECT DISTINCT date FROM ${table} WHERE staff_id = ? AND date >= '2026-11-02' ORDER BY date`).all(id).map((x) => x.date);

  // 1) Lan có lịch cố định → tuần sau tự điền 7 ngày; báo bot chỉ T2, T3 → bỏ các ngày tự điền còn lại
  fixed(lan);
  ctx.fillFixedAvailability('2026-11-02');
  assert.deepEqual(datesOf('availability', lan), WEEK);
  const r = ctx.handleBotAvailMsg({ chat: { id: 'g1' }, from: { id: 'u1', name: 'Lan Bếp' }, text: '@bot Lan Bếp T2 14-23, T3 14-23' });
  assert.match(r, /Đã ghi/);
  assert.deepEqual(datesOf('availability', lan), ['2026-11-02', '2026-11-03']);
  assert.deepEqual(datesOf('assignments', lan), ['2026-11-02', '2026-11-03']);

  // 2) Tuần trước Lan + Hoa có ca 7 ngày (xếp tay) → chép sang: Lan đã tự báo nên giữ đúng lịch báo; Hoa chưa báo thì chép
  for (const id of [lan, hoa]) PREV.forEach((d, i) => db.prepare("INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, note, created_at) VALUES (?, ?, ?, ?, 840, 1380, '', 0)").run(`old${id}-${i}`, id, bep, d));
  const cp = await o('POST', '/api/schedule/copy', { from_week: '2026-10-26', to_week: '2026-11-02' });
  assert.equal(cp.status, 200, JSON.stringify(cp.data));
  assert.equal(cp.data.reported, 7);
  assert.deepEqual(datesOf('assignments', lan), ['2026-11-02', '2026-11-03']);
  assert.deepEqual(datesOf('assignments', hoa), WEEK);
  // Hoa báo bot sau khi chép: chỉ T4 → ca chép bị thay bằng lịch báo
  ctx.handleBotAvailMsg({ chat: { id: 'g1' }, from: { id: 'u2', name: 'Hoa Bếp' }, text: '@bot Hoa Bếp T4 14-23' });
  assert.deepEqual(datesOf('assignments', hoa), ['2026-11-04']);

  // 3) Dữ liệu cũ bị lỗi (Mai): lịch cố định lẫn vào lịch bot + ca chép đè → sửa lại từ tin bot đã lưu trong nhật ký
  fixed(mai);
  WEEK.forEach((d) => { for (const sl of ['08:00-12:00', '14:00-23:00']) db.prepare('INSERT INTO availability (staff_id, date, slot) VALUES (?, ?, ?)').run(mai, d, sl); });
  db.prepare("INSERT INTO availability_weeks (staff_id, week_start, submitted_at, note) VALUES (?, '2026-11-02', ?, 'Báo qua Zalo')").run(mai, now);
  db.prepare("INSERT INTO audit_log (action, detail, at) VALUES ('availability.zalo', ?, ?)").run(JSON.stringify({ from: 'Mai', staff: [mai], text: '@bot Mai Bếp T5 14-23, T6 14-23' }), now - 3600_000);
  const copyAt = now - 1800_000;
  WEEK.forEach((d, i) => db.prepare("INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, note, created_at) VALUES (?, ?, ?, ?, 480, 1380, '', ?)").run(`cp${i}`, mai, bep, d, copyAt - 10));
  db.prepare("INSERT INTO audit_log (action, detail, at) VALUES ('schedule.copy', ?, ?)").run(JSON.stringify({ from: '2026-10-26', to: '2026-11-02' }), copyAt);
  const rep = ctx.repairWeekFromBot('2026-11-02');
  assert.ok(rep.replayed.includes(mai));
  assert.deepEqual(datesOf('availability', mai), ['2026-11-05', '2026-11-06']);
  assert.deepEqual(datesOf('assignments', mai), ['2026-11-05', '2026-11-06']);
  // Lan (đã đúng) không bị đổi
  assert.deepEqual(datesOf('assignments', lan), ['2026-11-02', '2026-11-03']);
});
