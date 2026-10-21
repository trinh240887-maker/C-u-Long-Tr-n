import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { isDate, addDays, weekStart } from '../lib/time.js';

// Lịch rảnh: nhân viên thời vụ tự báo buổi rảnh của tuần sau; quản lý xem dư/thiếu rồi tự xếp ca.
export const DEFAULT_SLOTS = [
  { key: 'sang', label: 'Sáng', start: '06:00', end: '12:00' },
  { key: 'chieu', label: 'Chiều', start: '12:00', end: '17:00' },
  { key: 'toi', label: 'Tối', start: '17:00', end: '24:00' },
];
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };
// Ai phải báo lịch rảnh: mọi người trừ Chủ và Quản lý
const MUST = ['staff', 'team_lead', 'shift_lead'];

export default function (r, ctx) {
  const { db } = ctx;

  ctx.availSlots = () => {
    try {
      const s = JSON.parse(ctx.setting('avail_slots') || '[]');
      if (Array.isArray(s) && s.length) return s;
    } catch { /* dùng mặc định */ }
    return DEFAULT_SLOTS;
  };
  // Khúc ca (phút trong ngày, có thể > 1440) chạm buổi nào
  ctx.slotsOfSegment = (startMin, endMin) => ctx.availSlots()
    .filter((s) => startMin < toMin(s.end) && endMin > toMin(s.start)).map((s) => s.key);

  function deadline(ws) {
    const dow = Number(ctx.setting('avail_deadline_dow') || 4); // 1 = Thứ Hai … 7 = Chủ nhật, của tuần trước đó
    const at = ctx.setting('avail_deadline_time') || '21:00';
    const date = addDays(ws, dow - 8);
    return { date, time: at, at: ctx.clock().toEpoch(date, toMin(at)) };
  }

  function readWeek(q) {
    const raw = q || addDays(weekStart(ctx.today()), 7);
    if (!isDate(raw)) fail(400, 'Tuần không hợp lệ');
    return weekStart(raw);
  }

  function picksOf(staffId, ws) {
    const out = {};
    for (const row of db.prepare('SELECT date, slot FROM availability WHERE staff_id = ? AND date BETWEEN ? AND ?').all(staffId, ws, addDays(ws, 6))) {
      (out[row.date] ||= []).push(row.slot);
    }
    return out;
  }

  r.get('/api/availability/me', 'staff', ({ me, query }) => {
    const ws = readWeek(query.get('week'));
    const sub = db.prepare('SELECT * FROM availability_weeks WHERE staff_id = ? AND week_start = ?').get(me.id, ws);
    const dl = deadline(ws);
    return {
      week_start: ws, days: Array.from({ length: 7 }, (_, i) => addDays(ws, i)), slots: ctx.availSlots(),
      deadline: dl, must: MUST.includes(me.role), late: !sub && ctx.now() > dl.at,
      submitted_at: sub?.submitted_at || null, note: sub?.note || '', picks: picksOf(me.id, ws),
      locked: ws <= ctx.today() && rank(me.role) < rank('manager'),
    };
  });

  r.post('/api/availability/me', 'staff', ({ me, body }) => {
    const ws = readWeek(body.week);
    if (ws <= ctx.today() && rank(me.role) < rank('manager')) fail(400, 'Tuần này đã bắt đầu, nhờ quản lý sửa giúp');
    const keys = new Set(ctx.availSlots().map((s) => s.key));
    const days = new Set(Array.from({ length: 7 }, (_, i) => addDays(ws, i)));
    const picks = body.picks && typeof body.picks === 'object' ? body.picks : {};
    const note = v.text(body.note, { name: 'Ghi chú', max: 200 });
    tx(db, () => {
      db.prepare('DELETE FROM availability WHERE staff_id = ? AND date BETWEEN ? AND ?').run(me.id, ws, addDays(ws, 6));
      const add = db.prepare('INSERT OR IGNORE INTO availability (staff_id, date, slot) VALUES (?, ?, ?)');
      for (const [date, slots] of Object.entries(picks)) {
        if (!days.has(date) || !Array.isArray(slots)) continue;
        for (const s of slots) if (keys.has(s)) add.run(me.id, date, s);
      }
      db.prepare(`INSERT INTO availability_weeks (staff_id, week_start, submitted_at, note) VALUES (?, ?, ?, ?)
        ON CONFLICT (staff_id, week_start) DO UPDATE SET submitted_at = excluded.submitted_at, note = excluded.note`).run(me.id, ws, ctx.now(), note);
    });
    ctx.audit(me, 'availability.submit', { week: ws });
    ctx.broadcast('availability');
    return { ok: true };
  });

  // Tổng hợp cho quản lý: mỗi ngày × buổi có ai rảnh, đã xếp bao nhiêu, cần tối thiểu bao nhiêu
  function summary(ws) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const slots = ctx.availSlots();
    const people = db.prepare(`SELECT s.id, s.name, s.role, s.team_id, s.position_id, t.name AS team_name, p.name AS position_name
      FROM staff s LEFT JOIN teams t ON t.id = s.team_id LEFT JOIN positions p ON p.id = s.position_id
      WHERE s.active = 1 AND s.role IN (${MUST.map(() => '?').join(',')}) ORDER BY t.sort, s.name`).all(...MUST);
    const subs = new Map(db.prepare('SELECT * FROM availability_weeks WHERE week_start = ?').all(ws).map((x) => [x.staff_id, x]));
    const avail = db.prepare('SELECT staff_id, date, slot FROM availability WHERE date BETWEEN ? AND ?').all(ws, addDays(ws, 6));
    const rows = db.prepare(`SELECT a.staff_id, a.team_id, a.date, a.start_min, a.end_min FROM assignments a
      WHERE a.date BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')`).all(ws, addDays(ws, 6));
    const busy = new Set();
    const scheduled = {};
    for (const a of rows) {
      for (const k of ctx.slotsOfSegment(a.start_min, a.end_min)) {
        busy.add(`${a.staff_id}:${a.date}:${k}`);
        const key = `${a.date}:${k}:${a.team_id ?? 0}`;
        (scheduled[key] ||= new Set()).add(a.staff_id);
      }
    }
    const free = {};
    for (const a of avail) (free[`${a.date}:${a.slot}`] ||= []).push(a.staff_id);
    const teams = db.prepare('SELECT id, name, min_staff FROM teams WHERE active = 1 ORDER BY sort, id').all();
    const cells = {};
    for (const d of days) {
      for (const s of slots) {
        const ids = free[`${d}:${s.key}`] || [];
        cells[`${d}:${s.key}`] = {
          free: ids,
          by_team: Object.fromEntries(teams.map((t) => [t.id, {
            free: ids.filter((id) => people.find((p) => p.id === id)?.team_id === t.id).length,
            scheduled: scheduled[`${d}:${s.key}:${t.id}`]?.size || 0,
            need: t.min_staff,
          }])),
        };
      }
    }
    return {
      week_start: ws, days, slots, teams, deadline: deadline(ws),
      people: people.map((p) => ({ ...p, submitted_at: subs.get(p.id)?.submitted_at || null, note: subs.get(p.id)?.note || '' })),
      cells, busy: [...busy],
    };
  }
  ctx.availabilitySummary = summary;

  r.get('/api/availability', 'team_lead', ({ query }) => summary(readWeek(query.get('week'))));

  r.post('/api/availability/remind', 'manager', ({ me, body }) => {
    const ws = readWeek(body.week);
    const s = summary(ws);
    const ids = s.people.filter((p) => !p.submitted_at).map((p) => p.id);
    const dl = s.deadline;
    if (ids.length) {
      ctx.notify(ids, {
        title: 'Báo lịch rảnh tuần sau',
        body: `Bạn chưa báo lịch rảnh tuần ${ws.slice(8)}/${ws.slice(5, 7)}. Hạn ${dl.time} ngày ${dl.date.slice(8)}/${dl.date.slice(5, 7)}.`,
        link: `/ranh?week=${ws}`,
      });
    }
    ctx.audit(me, 'availability.remind', { week: ws, n: ids.length });
    return { sent: ids.length };
  });
}
