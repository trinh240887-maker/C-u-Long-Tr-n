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
  db.prepare("INSERT INTO staff (name, role, team_id, created_at) VALUES ('Lan', 'staff', ?, 0), ('Hùng', 'staff', ?, 0)").run(pv, rc);
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
  now += 60_000;
  await ctx.availBotTick(); // đã gửi tuần này → không gửi lại
  assert.equal(sent.length, 1);

  ctx.setSetting('avail_bot_on', '0');
  now = clock.toEpoch('2026-11-07', 20 * 60 + 5);
  await ctx.availBotTick();
  assert.equal(sent.length, 1);
});
