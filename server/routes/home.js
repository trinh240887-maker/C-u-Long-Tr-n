import { addDays, fmtHM, isoWeekday } from '../lib/time.js';
import { rangeOf } from '../lib/schedule.js';
import { describeGroup } from './schedule.js';

export default function (r, ctx) {
  const { db } = ctx;

  function groupsOf(rows) {
    const map = new Map();
    for (const a of rows) map.set(a.group_id, [...(map.get(a.group_id) || []), a]);
    return [...map.values()];
  }

  // Ca sắp tới của tôi (7 ngày)
  r.get('/api/my-shifts', 'staff', ({ me }) => {
    const today = ctx.today();
    const rows = db.prepare(`SELECT a.*, t.name AS team_name, z.name AS zone_name FROM assignments a LEFT JOIN teams t ON t.id = a.team_id LEFT JOIN zones z ON z.id = a.zone_id
      WHERE a.staff_id = ? AND a.date BETWEEN ? AND ? ORDER BY a.date, a.start_min`).all(me.id, addDays(today, -1), addDays(today, 7));
    const leave = db.prepare("SELECT id, status FROM leave_requests WHERE group_id = ? AND status IN ('pending','approved','rejected') ORDER BY id DESC LIMIT 1");
    const clock = ctx.clock();
    return groupsOf(rows)
      .filter((segs) => rangeOf(clock, segs.at(-1)).end > ctx.now())
      .map((segs) => ({
        group_id: segs[0].group_id, date: segs[0].date, weekday: isoWeekday(segs[0].date), label: segs[0].label, note: segs[0].note,
        team_name: segs[0].team_name || '', text: describeGroup(segs), zone_name: segs[0].zone_name || '', tables_text: segs[0].tables_text || '', start: rangeOf(clock, segs[0]).start, leave: leave.get(segs[0].group_id) || null,
      }));
  });

  // Bảng việc của quản lý / trưởng ca
  r.get('/api/dashboard', 'shift_lead', () => {
    ctx.autoCloseAttendance();
    const clock = ctx.clock();
    const t = ctx.now();
    const today = ctx.today();
    const grace = Number(ctx.setting('late_grace_minutes') || 5) * 60_000;

    const rows = db.prepare(`SELECT a.*, s.name AS staff_name, s.phone, z.name AS zone_name FROM assignments a JOIN staff s ON s.id = a.staff_id LEFT JOIN zones z ON z.id = a.zone_id
      WHERE a.date = ? ORDER BY a.start_min`).all(today);
    const leaves = new Map(db.prepare("SELECT group_id, status, id FROM leave_requests WHERE date = ? AND status IN ('pending','approved')").all(today).map((l) => [l.group_id, l]));
    const att = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND (date = ? OR clock_out IS NULL) ORDER BY clock_in');
    const teams = db.prepare('SELECT id, name, min_staff FROM teams WHERE active = 1 ORDER BY sort, id').all();

    const people = groupsOf(rows).map((segs) => {
      const first = segs[0];
      const start = rangeOf(clock, first).start;
      const end = rangeOf(clock, segs.at(-1)).end;
      const leave = leaves.get(first.group_id);
      const recs = att.all(first.staff_id, today);
      const ids = new Set(segs.map((s) => s.id));
      const mine = recs.filter((x) => ids.has(x.assignment_id));
      const open = recs.find((x) => !x.clock_out);
      let status;
      if (leave?.status === 'approved') status = 'leave';
      else if (open) status = 'working';
      else if (mine.length && mine.every((x) => x.clock_out) && t > end - 30 * 60_000) status = 'done';
      else if (mine.length) status = 'break';
      else if (t > start + grace) status = t > end ? 'absent' : 'late';
      else status = 'upcoming';
      return {
        group_id: first.group_id, staff_id: first.staff_id, staff_name: first.staff_name, phone: first.phone, team_id: first.team_id,
        text: describeGroup(segs), label: first.label, start, status, leave_pending: leave?.status === 'pending',
        zone_name: first.zone_name || '', tables_text: first.tables_text || '',
        late_minutes: mine[0]?.late_minutes || 0, clock_in: mine[0]?.clock_in || null,
      };
    });

    const unscheduled = db.prepare(`SELECT at.*, s.name AS staff_name, s.team_id FROM attendance at JOIN staff s ON s.id = at.staff_id
      WHERE at.assignment_id IS NULL AND (at.date = ? OR at.clock_out IS NULL)`).all(today);

    const runs = ctx.checklistDay(today);
    const checklistByTeam = teams.map((tm) => {
      const list = runs.filter((x) => x.team_id === tm.id);
      return { team_id: tm.id, team_name: tm.name, done: list.reduce((s, x) => s + x.done, 0), total: list.reduce((s, x) => s + x.total, 0), runs: list.map(({ items, ...x }) => x) };
    });

    const overdue = db.prepare(`SELECT k.id, k.title, k.due_at, k.priority, a.name AS assignee_name, tm.name AS team_name FROM tasks k
      LEFT JOIN staff a ON a.id = k.assignee_id LEFT JOIN teams tm ON tm.id = k.team_id
      WHERE k.status != 'done' AND k.due_at IS NOT NULL AND k.due_at < ? ORDER BY k.due_at`).all(t);
    const openTasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'").get().n;
    const pendingLeave = db.prepare(`SELECT l.id, l.date, l.reason, s.name AS staff_name,
      (SELECT COUNT(*) FROM cover_offers o WHERE o.leave_id = l.id AND o.status = 'accepted') AS accepted
      FROM leave_requests l JOIN staff s ON s.id = l.staff_id WHERE l.status = 'pending' ORDER BY l.date`).all();

    // Thiếu người 7 ngày tới
    const upcoming = db.prepare(`SELECT a.date, a.team_id, COUNT(DISTINCT a.staff_id) AS n FROM assignments a
      WHERE a.date BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')
      GROUP BY a.date, a.team_id`).all(today, addDays(today, 6));
    const count = new Map(upcoming.map((u) => [`${u.date}:${u.team_id}`, u.n]));
    const gaps = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, i);
      for (const tm of teams) {
        const n = count.get(`${d}:${tm.id}`) || 0;
        if (tm.min_staff && n < tm.min_staff) gaps.push({ date: d, team_id: tm.id, team_name: tm.name, have: n, need: tm.min_staff });
      }
    }

    return {
      today, now: t,
      teams: teams.map((tm) => ({ ...tm, people: people.filter((p) => p.team_id === tm.id) })),
      no_team: people.filter((p) => !p.team_id),
      unscheduled: unscheduled.map((u) => ({ staff_name: u.staff_name, clock_in: u.clock_in, clock_out: u.clock_out })),
      checklists: checklistByTeam,
      overdue, open_tasks: openTasks, pending_leave: pendingLeave, gaps,
      counts: {
        working: people.filter((p) => p.status === 'working').length + unscheduled.filter((u) => !u.clock_out).length,
        late: people.filter((p) => p.status === 'late').length,
        absent: people.filter((p) => p.status === 'absent').length,
        leave: people.filter((p) => p.status === 'leave').length,
        scheduled: people.length,
      },
      fmt: { cutoff: fmtHM(Number(ctx.setting('day_cutoff_hour') || 5) * 60) },
    };
  });
}
