import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });

test('phục vụ 2 bảng: full-time (có khu cố định) bot không ghi lịch; part-time bot ghi nhưng chỉ ca 18–23; duyệt riêng từng bảng', async (t) => {
  let now = clock.toEpoch('2026-10-24', 10 * 60); // T7 24/10
  const db = openDb(':memory:', { now });
  const sent = [];
  let inbox = [];
  const zaloBot = { ready: () => true, send: async (chat, text) => { sent.push({ chat, text }); }, call: async () => ({}), chats: async () => [], updates: async () => inbox, remember: () => [] };
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} }, zaloBot });
  t.after(() => app.close());
  const { ctx } = app;
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get()?.id ?? Number(db.prepare("INSERT INTO teams (name, sort, min_staff) VALUES ('Phục vụ', 1, 1)").run().lastInsertRowid);
  const zone = db.prepare('SELECT id FROM zones ORDER BY id LIMIT 1').get()?.id ?? Number(db.prepare("INSERT INTO zones (name) VALUES ('Khu A')").run().lastInsertRowid);
  db.prepare("INSERT INTO staff (name, role, team_id, home_zone_id, work_type, created_at) VALUES ('Lan Full', 'staff', ?, ?, 'full', 0), ('Mai Part', 'staff', ?, ?, 'part', 0)").run(pv, zone, pv, zone);
  const id = (n) => db.prepare('SELECT id FROM staff WHERE name = ?').get(n).id;
  ctx.setSetting('zalo_bot_staff_group_id', 'grpNV');
  const msg = (mid, text, name) => ({ id: mid, date: now, chat: { id: 'grpNV', type: 'GROUP', name: 'Nhóm' }, from: { id: `u-${name}`, name }, text });
  inbox = [msg('m1', '@Bot Lan Full 14-23', 'Lan Full'), msg('m2', '@Bot Mai Part 14-23, T7 8-12', 'Mai Part')];
  await ctx.zaloBotPoll();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM availability WHERE staff_id = ?').get(id('Lan Full')).n, 0, 'full-time: bot không ghi');
  assert.match(sent.map((x) => x.text).join('\n'), /FULL-TIME/);
  const mai = db.prepare('SELECT date, slot FROM availability WHERE staff_id = ? ORDER BY date').all(id('Mai Part'));
  assert.ok(mai.length >= 5, JSON.stringify(mai));
  assert.ok(mai.every((x) => x.slot === '18:00-23:00'), JSON.stringify(mai));
  assert.ok(!mai.some((x) => x.date === '2026-10-31'), 'T7 8–12 ngoài ca tối → bỏ');
  // Duyệt riêng bảng part-time
  const ws = '2026-10-26';
  const s = ctx.availabilitySummary(ws);
  const t1 = s.teams.find((x) => x.id === pv);
  assert.equal(t1.published_part, null); assert.equal(t1.part_shift, '18:00-23:00');
  ctx.setSetting(`published:${ws}:t${pv}:part`, String(now));
  const t2 = ctx.availabilitySummary(ws).teams.find((x) => x.id === pv);
  assert.ok(t2.published_part); assert.equal(t2.published_full, null);
  assert.ok(ctx.weekPublishedAt(ws, id('Mai Part'))); assert.ok(!ctx.weekPublishedAt(ws, id('Lan Full')));
});
