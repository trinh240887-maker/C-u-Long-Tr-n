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
    const rows = db.prepare(`SELECT a.*, t.name AS team_name, z.name AS zone_name, p.name AS position_name FROM assignments a LEFT JOIN teams t ON t.id = a.team_id LEFT JOIN zones z ON z.id = a.zone_id LEFT JOIN positions p ON p.id = a.position_id
      WHERE a.staff_id = ? AND a.date BETWEEN ? AND ? ORDER BY a.date, a.start_min`).all(me.id, addDays(today, -1), addDays(today, 7));
    const leave = db.prepare("SELECT id, status FROM leave_requests WHERE group_id = ? AND status IN ('pending','approved','rejected') ORDER BY id DESC LIMIT 1");
    const clock = ctx.clock();
    return groupsOf(rows)
      .filter((segs) => rangeOf(clock, segs.at(-1)).end > ctx.now())
      .map((segs) => ({
        group_id: segs[0].group_id, date: segs[0].date, weekday: isoWeekday(segs[0].date), label: segs[0].label, note: segs[0].note,
        team_name: segs[0].team_name || '', position_name: segs[0].position_name || '', text: describeGroup(segs), zone_name: segs[0].zone_name || '', tables_text: segs[0].tables_text || '', start: rangeOf(clock, segs[0]).start, leave: leave.get(segs[0].group_id) || null,
      }));
  });

  // Bảng việc của quản lý / trưởng ca
  // Phạm vi màn Quản lý (chủ quán 28/10): chủ + quản lý không bộ phận = cả quán; quản lý / trưởng ca có bộ phận = bộ phận đó
  // (Phục vụ và Tiếp thực tính chung); trưởng ca không bộ phận = Phục vụ & Tiếp thực. Tổ trưởng không vào màn này.
  const pvttIds = () => db.prepare('SELECT id, name FROM teams').all().filter((x) => /phục vụ|phuc vu|tiếp thực|tiep thuc/i.test(x.name)).map((x) => x.id);
  function scopeTeams(me) {
    if (me.role === 'owner') return null;
    const pv = pvttIds();
    if (me.team_id) return pv.includes(me.team_id) ? new Set(pv) : new Set([me.team_id]);
    return me.role === 'shift_lead' ? new Set(pv) : null;
  }
  ctx.dashboardScope = scopeTeams;

  r.get('/api/dashboard', 'shift_lead', ({ me }) => {
    const scope = scopeTeams(me);
    // Trưởng ca có khu hôm nay (vd khu A): chỉ khu A + việc chung cả quán (chủ quán 28/10)
    const myZone = me.role === 'shift_lead' ? db.prepare('SELECT zone_id FROM assignments WHERE staff_id = ? AND date = ? AND zone_id IS NOT NULL').get(me.id, ctx.today())?.zone_id || null : null;
    const inScope = (teamId) => !scope || (teamId == null ? scope.has(pvttIds()[0]) && [...scope].some((x) => pvttIds().includes(x)) : scope.has(teamId));
    ctx.autoCloseAttendance();
    const clock = ctx.clock();
    const t = ctx.now();
    const today = ctx.today();
    const grace = Number(ctx.setting('late_grace_minutes') || 5) * 60_000;

    const rows = db.prepare(`SELECT a.*, s.name AS staff_name, s.phone, z.name AS zone_name, p.name AS position_name FROM assignments a JOIN staff s ON s.id = a.staff_id LEFT JOIN zones z ON z.id = a.zone_id LEFT JOIN positions p ON p.id = a.position_id
      WHERE a.date = ? ORDER BY a.start_min`).all(today);
    const leaves = new Map(db.prepare("SELECT group_id, status, id FROM leave_requests WHERE date = ? AND status IN ('pending','approved')").all(today).map((l) => [l.group_id, l]));
    const att = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND (date = ? OR clock_out IS NULL) ORDER BY clock_in');
    const teams = db.prepare('SELECT id, name, min_staff FROM teams WHERE active = 1 ORDER BY sort, id').all().filter((tm) => !scope || scope.has(tm.id));
    const staffTeam = (id) => db.prepare('SELECT team_id FROM staff WHERE id = ?').get(id)?.team_id ?? null;

    const people = groupsOf(rows).filter((segs) => inScope(segs[0].team_id ?? staffTeam(segs[0].staff_id)) && (!myZone || !segs[0].zone_id || segs[0].zone_id === myZone)).map((segs) => {
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
        zone_name: first.zone_name || '', tables_text: first.tables_text || '', position_name: first.position_name || '',
        late_minutes: mine[0]?.late_minutes || 0, clock_in: mine[0]?.clock_in || null,
      };
    });

    const unscheduled = db.prepare(`SELECT at.*, s.name AS staff_name, s.team_id FROM attendance at JOIN staff s ON s.id = at.staff_id
      WHERE at.assignment_id IS NULL AND (at.date = ? OR at.clock_out IS NULL)`).all(today).filter((u) => inScope(u.team_id));

    const runs = ctx.checklistDay(today);
    const checklistByTeam = teams.map((tm) => {
      const list = runs.filter((x) => x.team_id === tm.id);
      return { team_id: tm.id, team_name: tm.name, done: list.reduce((s, x) => s + x.done, 0), total: list.reduce((s, x) => s + x.total, 0), runs: list.map(({ items, ...x }) => x) };
    });

    const overdue = db.prepare(`SELECT k.id, k.title, k.due_at, k.priority, a.name AS assignee_name, tm.name AS team_name FROM tasks k
      LEFT JOIN staff a ON a.id = k.assignee_id LEFT JOIN teams tm ON tm.id = k.team_id
      WHERE k.status != 'done' AND k.due_at IS NOT NULL AND k.due_at < ? ORDER BY k.due_at`).all(t).filter((k) => !scope || !k.team_name || teams.some((tm) => tm.name === k.team_name));
    const openTasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'").get().n;
    const pendingLeave = db.prepare(`SELECT l.id, l.date, l.reason, s.name AS staff_name,
      (SELECT COUNT(*) FROM cover_offers o WHERE o.leave_id = l.id AND o.status = 'accepted') AS accepted
      , s.team_id, s.home_zone_id, (SELECT a.zone_id FROM assignments a WHERE a.group_id = l.group_id LIMIT 1) AS zone_id
      FROM leave_requests l JOIN staff s ON s.id = l.staff_id WHERE l.status = 'pending' ORDER BY l.date`).all()
      // trưởng ca khu A: đơn nghỉ của người khu A + người chưa phân khu (giống danh sách người) (rà soát 28/10)
      .filter((l) => inScope(l.team_id) && (!myZone || !(l.zone_id ?? l.home_zone_id) || (l.zone_id ?? l.home_zone_id) === myZone));

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

    // Việc ca hôm nay theo checklist + khu: đã xong / chưa xong (trưởng ca Phục vụ thấy cả việc chung của quán)
    try { ctx.jobsEnsureDay?.(today); } catch { /* chưa có việc ca */ }
    const zname = new Map(db.prepare('SELECT id, name FROM zones').all().map((z) => [z.id, z.name]));
    const nm = (id) => (id ? db.prepare('SELECT name FROM staff WHERE id = ?').get(id)?.name || '' : '');
    const jobGroups = [];
    for (const tp of (ctx.checklistTemplates?.() || []).filter((x) => x.job_mode)) {
      const ts = (tp.job_teams?.length ? tp.job_teams : tp.team_id ? [tp.team_id] : []).filter((x) => x > 0);
      if (scope && ts.length && !ts.some((x) => scope.has(x))) continue; // không gắn bộ phận = việc cả quán: ai cũng thấy (rà soát 28/10)
      const js = db.prepare('SELECT j.*, i.text FROM jobs j JOIN checklist_items i ON i.id = j.item_id WHERE j.date = ? AND j.template_id = ? ORDER BY j.zone_id, j.id').all(today, tp.id);
      for (const zid of [...new Set(js.map((j) => j.zone_id))].filter((z) => !myZone || !z || z === myZone)) {
        const list = js.filter((j) => j.zone_id === zid);
        jobGroups.push({ template_id: tp.id, title: tp.title, phase: tp.phase, zone_id: zid, zone_name: zid ? zname.get(zid) || 'Khu' : 'Việc chung của quán',
          done: list.filter((j) => ['done', 'ok'].includes(j.status)).length, total: list.length,
          items: list.map((j) => ({ id: j.id, title: j.text, status: j.status, staff_name: nm(j.staff_id), done_at: j.done_at, overdue: j.status === 'doing' && j.due_at && j.due_at < t, has_photo: !!j.photo })) });
      }
    }
    return {
      today, now: t, scope_label: (!scope ? 'Cả quán' : teams.map((tm) => tm.name).join(' + ')) + (myZone ? ` · ${zname.get(myZone) || 'khu'} + việc chung` : ''),
      jobs: jobGroups,
      teams: teams.map((tm) => ({ ...tm, people: people.filter((p) => p.team_id === tm.id) })),
      no_team: people.filter((p) => !p.team_id || !teams.some((tm) => tm.id === p.team_id)),
      unscheduled: unscheduled.map((u) => ({ staff_name: u.staff_name, clock_in: u.clock_in, clock_out: u.clock_out })),
      checklists: checklistByTeam,
      overdue, open_tasks: openTasks, pending_leave: pendingLeave, gaps,
      // Checklist không gắn tổ (cả quán) + bộ phận dùng chung (job_teams) cũng tính (rà soát 28/10)
      photos_pending: db.prepare(`SELECT tp.team_id, tp.job_teams FROM checklist_entries e JOIN checklist_runs r ON r.id = e.run_id JOIN checklist_items i ON i.id = e.item_id JOIN checklist_templates tp ON tp.id = r.template_id
        WHERE r.date = ? AND i.photo_required = 1 AND e.review_status IS NULL`).all(today).filter((x) => { if (!scope || x.team_id == null || scope.has(x.team_id)) return true; try { return JSON.parse(x.job_teams || '[]').some((y) => scope.has(y)); } catch { return false; } }).length,
      avail: (() => {
        const s = ctx.availabilitySummary(addDays(today, 7));
        return { week_start: s.week_start, missing: s.people.filter((p) => !p.submitted_at).length, total: s.people.length, deadline: s.deadline };
      })(),
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
