import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });

test('bot nhắc lịch rảnh: tối thứ 7 20h gửi 1 lần vào nhóm nhân viên, liệt kê người chưa báo', async (t) => {
  let now = clock.toEpoch('2026-10-31', 19 * 60 + 50); // Thứ 7, 19:50
  const db = openDb(':memory:', { now });
  const sent = [];
  const zaloBot = { ready: () => true, send: async (chat, text) => { sent.push({ chat, text }); }, call: async () => ({}), chats: async () => [] };
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} }, zaloBot });
  t.after(() => app.close());
  const pv = Number(db.prepare("INSERT INTO teams (name, sort, min_staff) VALUES ('Phục vụ', 9, 1)").run().lastInsertRowid);
  const rc = Number(db.prepare("INSERT INTO teams (name, sort, min_staff) VALUES ('Rửa chén', 10, 1)").run().lastInsertRowid);
  const tn = Number(db.prepare("INSERT INTO teams (name, sort, min_staff) VALUES ('Thu ngân', 11, 1)").run().lastInsertRowid);
  db.prepare("INSERT INTO staff (name, role, team_id, created_at) VALUES ('Lan', 'staff', ?, 0), ('Hùng', 'staff', ?, 0), ('Kim', 'staff', ?, 0)").run(pv, rc, tn);
  const { ctx } = app;

  await ctx.availBotTick(); // chưa chọn nhóm → không gửi
  assert.equal(sent.length, 0);
  ctx.setSetting('zalo_bot_staff_group_id', 'grpNV');
  await ctx.availBotTick(); // 19:50 chưa tới giờ
  assert.equal(sent.length, 0);
  now = clock.toEpoch('2026-10-31', 20 * 60 + 1);
  await ctx.availBotTick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, 'grpNV');
  assert.match(sent[0].text, /tuần 02\/11–08\/11/);
  assert.match(sent[0].text, /Phục vụ: .*Lan/);
  assert.doesNotMatch(sent[0].text, /Hùng/); // rửa chén không phải báo
  assert.doesNotMatch(sent[0].text, /Kim/); // mặc định chỉ nhắc Phục vụ + Tiếp thực
  ctx.setSetting('avail_bot_teams', JSON.stringify([tn]));
  assert.match(ctx.availGroupText('2026-11-02'), /Thu ngân: Kim/);
  ctx.setSetting('avail_bot_teams', '');
  now += 60_000;
  await ctx.availBotTick(); // đã gửi tuần này → không gửi lại
  assert.equal(sent.length, 1);

  // Nhiều nhóm: mỗi nhóm chỉ nhắc bộ phận của nhóm đó
  ctx.saveStaffGroups([{ id: 'grpNV', name: 'Chung', teams: [pv] }, { id: 'grpTN', name: 'Thu ngân', teams: [tn] }, { id: 'grpX', name: 'Chưa chọn', teams: [] }]);
  now = clock.toEpoch('2026-11-07', 20 * 60 + 5);
  await ctx.availBotTick();
  assert.deepEqual(sent.slice(1).map((x) => x.chat), ['grpNV', 'grpTN']);
  assert.match(sent[1].text, /Lan/);
  assert.doesNotMatch(sent[1].text, /Kim/);
  assert.match(sent[2].text, /Thu ngân: Kim/);
  sent.length = 1;
  // Nhắc tối T5, T6 (chưa đủ) → gửi mỗi ngày 1 lần; đủ người thì thôi
  ctx.saveStaffGroups([{ id: 'grpNV', name: 'Chung', teams: [pv] }]);
  now = clock.toEpoch('2026-11-12', 20 * 60 + 1); // T5
  await ctx.availBotTick(); await ctx.availBotTick();
  assert.equal(sent.length, 2);
  const lan = db.prepare("SELECT id FROM staff WHERE name = 'Lan'").get().id;
  db.prepare('INSERT INTO availability_weeks (staff_id, week_start, submitted_at) VALUES (?, ?, ?)').run(lan, '2026-11-16', now);
  now = clock.toEpoch('2026-11-13', 20 * 60 + 1); // T6: Lan đã báo → nhóm đủ, không nhắn
  await ctx.availBotTick();
  assert.equal(sent.length, 2);
  sent.length = 1;
  ctx.setSetting('avail_bot_on', '0');
  now = clock.toEpoch('2026-11-14', 20 * 60 + 5);
  await ctx.availBotTick();
  assert.equal(sent.length, 1);
});

test('bot đọc tin @bot trong nhóm nhân viên → tự điền lịch rảnh + trả lời', async (t) => {
  let now = clock.toEpoch('2026-10-24', 23 * 60 + 40); // T7 24/10 23:40
  const db = openDb(':memory:', { now });
  const sent = [];
  let inbox = [];
  const zaloBot = { ready: () => true, send: async (chat, text) => { sent.push({ chat, text }); }, call: async () => ({}), chats: async () => [], updates: async () => inbox, remember: () => [] };
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} }, zaloBot });
  t.after(() => app.close());
  const pv = Number(db.prepare("INSERT INTO teams (name, sort, min_staff) VALUES ('Tiếp thực', 9, 1)").run().lastInsertRowid);
  db.prepare("INSERT INTO staff (name, role, team_id, created_at) VALUES ('Trần Nguyễn Trường Giang', 'staff', ?, 0), ('Nguyễn Hồng Phúc', 'staff', ?, 0), ('Cẩm Tú', 'staff', ?, 0)").run(pv, pv, pv);
  const id = (n) => db.prepare('SELECT id FROM staff WHERE name = ?').get(n).id;
  const { ctx } = app;
  ctx.setSetting('zalo_bot_staff_group_id', 'grpNV');
  const msg = (mid, text, from = { id: 'u1', name: 'Trường Giang' }, chat = 'grpNV') => ({ id: mid, date: now, chat: { id: chat, type: 'GROUP', name: 'Demo Quán' }, from, text });

  inbox = [msg('m1', '@Bot Trường Giang ( tiếp thực)\nHồng phúc ( Tiếp Thực)\n14h-23h'), msg('x', '@Bot xin chào', { id: 'u9', name: 'Ai' }, 'grpKhac')];
  await ctx.zaloBotPoll();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Đã ghi lịch rảnh/);
  assert.match(sent[0].text, /Trần Nguyễn Trường Giang: cả tuần 26\/10–01\/11: 14:00–23:00/);
  const rows = db.prepare('SELECT date, slot FROM availability WHERE staff_id = ? ORDER BY date').all(id('Nguyễn Hồng Phúc'));
  assert.equal(rows.length, 7);
  assert.equal(rows[0].slot, '14:00-23:00');
  // Tạo ca tự động theo lịch rảnh
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE staff_id = ? AND note = 'Theo lịch rảnh'").get(id('Nguyễn Hồng Phúc')).n >= 7);

  const lg = ctx.zaloBotLog();
  assert.equal(lg.msgs.length, 2);
  assert.match(lg.msgs[0].result, /không phải nhóm nhân viên/);
  assert.match(lg.msgs[1].result, /Đã ghi/);
  await ctx.zaloBotPoll(); // cùng tin → không xử lý lại
  assert.equal(sent.length, 1);

  // Sửa 1 ngày: T3 nghỉ, ngày khác giữ nguyên; tên lấy từ người nhắn (Zalo "Cẩm Tú")
  inbox = [msg('m2', '@Bot T3 nghỉ\nT4 10-14, 17h-22h', { id: 'u3', name: 'Cẩm Tú' })];
  await ctx.zaloBotPoll();
  assert.match(sent[1].text, /Cẩm Tú: T3 27\/10 nghỉ · T4 28\/10 10:00–14:00, 17:00–22:00/);
  assert.deepEqual(db.prepare('SELECT slot FROM availability WHERE staff_id = ? AND date = ?').all(id('Cẩm Tú'), '2026-10-28').map((x) => x.slot), ['10:00-14:00', '17:00-22:00']);

  // Cả tuần + ngày ghi riêng
  inbox = [msg('m7', '@Bot Cẩm Tú 14-23, T7 nghỉ, CN 10-23', { id: 'u3', name: 'Cẩm Tú' })];
  await ctx.zaloBotPoll();
  assert.match(sent.at(-1).text, /Cẩm Tú: T2–T6 \(26\/10–30\/10\) 14:00–23:00 · T7 31\/10 nghỉ · CN 01\/11 10:00–23:00/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM availability WHERE staff_id = ? AND date = ?').get(id('Cẩm Tú'), '2026-10-31').n, 0);

  inbox = [msg('m3', '@Bot xin chào', { id: 'u3', name: 'Cẩm Tú' })];
  await ctx.zaloBotPoll();
  assert.match(sent.at(-1).text, /Chưa đọc được giờ/);
  // Tên bot có chữ trùng tên nhân viên ("Cửu Long Trấn") → không nhận nhầm
  db.prepare("INSERT INTO staff (name, role, team_id, created_at) VALUES ('Trường Long', 'staff', ?, 0)").run(pv);
  ctx.setSetting('zalo_bot_name', 'Bot Cửu Long Trấn');
  inbox = [msg('m5', '@Bot Cửu Long Trấn 14-23', { id: 'u8', name: 'Khách' })];
  await ctx.zaloBotPoll();
  assert.match(sent.at(-1).text, /Chưa thấy tên/);
  inbox = [msg('m4', '@Bot Ai đó 14-23', { id: 'u7', name: 'Người lạ' })];
  await ctx.zaloBotPoll();
  assert.match(sent.at(-1).text, /Chưa thấy tên/);

  // Chưa chọn nhóm nhân viên → tin báo giờ đầu tiên tự nhận nhóm
  // Nhóm thứ 2 (vd nhóm Bếp) nhắn báo giờ → bot tự thêm nhóm (chưa chọn bộ phận), vẫn ghi lịch + trả lời đúng nhóm
  inbox = [msg('m6', '@Bot Cẩm Tú 15-22', { id: 'u3', name: 'Cẩm Tú' }, 'grpBep')];
  await ctx.zaloBotPoll();
  assert.deepEqual(ctx.staffGroups().map((g) => [g.id, g.teams.length > 0]), [['grpNV', true], ['grpBep', false]]);
  assert.equal(sent.at(-1).chat, 'grpBep');
  assert.match(sent.at(-1).text, /Cẩm Tú: cả tuần/);
});
