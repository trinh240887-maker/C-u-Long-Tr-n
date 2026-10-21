import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { addDays, isDate, fmtHM } from '../lib/time.js';
import { rangeOf } from '../lib/schedule.js';
import { computeTimesheet } from '../lib/payroll.js';

export default function (r, ctx) {
  const { db } = ctx;
  const num = (k, d) => Number(ctx.setting(k) || d);

  function parseLocal(text, clock) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/.exec(String(text || ''));
    if (!m || !isDate(m[1])) fail(400, 'Thời gian không hợp lệ (cần dạng YYYY-MM-DDTHH:MM)');
    return clock.toEpoch(m[1], Number(m[2]) * 60 + Number(m[3]));
  }

  // Các khúc ca của một người quanh thời điểm hiện tại (chưa bị nghỉ đã duyệt)
  function mySegments(staffId, date) {
    return db.prepare(`SELECT a.* FROM assignments a WHERE a.staff_id = ? AND a.date BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')
      ORDER BY a.date, a.start_min`).all(staffId, addDays(date, -1), addDays(date, 1));
  }

  // Tự đóng các lượt chấm công bị quên chấm ra
  ctx.autoCloseAttendance = function autoClose() {
    const clock = ctx.clock();
    const t = ctx.now();
    const after = num('auto_close_after_minutes', 120) * 60_000;
    const open = db.prepare(`SELECT at.*, a.date AS a_date, a.end_min, s.name, s.team_id FROM attendance at
      LEFT JOIN assignments a ON a.id = at.assignment_id JOIN staff s ON s.id = at.staff_id WHERE at.clock_out IS NULL`).all();
    for (const o of open) {
      let out = null;
      if (o.a_date) {
        const end = clock.toEpoch(o.a_date, o.end_min);
        if (t > end + after) out = Math.max(o.clock_in, end);
      } else if (t > o.clock_in + 14 * 3600_000) {
        out = o.clock_in; // không có lịch: để 0 giờ cho quản lý sửa lại
      }
      if (out !== null) {
        db.prepare("UPDATE attendance SET clock_out = ?, auto_closed = 1, note = TRIM(note || ' Quên chấm ra, hệ thống tự đóng') WHERE id = ?").run(out, o.id);
        ctx.notify(ctx.leadsOf(o.team_id).filter((id) => id !== o.staff_id), { title: `${o.name} quên chấm ra`, body: 'Hệ thống đã tự đóng ca, vui lòng kiểm tra lại giờ.', link: '/cham-cong' });
        ctx.notify(o.staff_id, { title: 'Bạn quên chấm ra ca', body: `Hệ thống đã tự đóng lúc ${clock.fmt(out)}. Báo trưởng ca nếu giờ chưa đúng.`, link: '/' });
      }
    }
  };

  function myStatus(me) {
    ctx.autoCloseAttendance();
    const clock = ctx.clock();
    const t = ctx.now();
    const open = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND clock_out IS NULL').get(me.id);
    const segs = mySegments(me.id, clock.businessDate(t)).map((a) => ({ ...a, ...rangeOf(clock, a) }));
    const done = new Set(db.prepare('SELECT assignment_id FROM attendance WHERE staff_id = ? AND assignment_id IS NOT NULL AND clock_in > ?')
      .all(me.id, t - 3 * 86_400_000).map((x) => x.assignment_id));
    const next = segs.find((s) => s.end > t && !done.has(s.id)) || null;
    return {
      open: open ? { ...open } : null,
      next: next ? { id: next.id, date: next.date, label: next.label, start: next.start, end: next.end, text: `${fmtHM(next.start_min)}–${fmtHM(next.end_min)}` } : null,
      ip_restricted: Boolean(ctx.setting('clock_ip_prefixes')),
    };
  }

  r.get('/api/attendance/me', 'staff', ({ me }) => myStatus(me));

  function checkNetwork(net) {
    const prefixes = ctx.setting('clock_ip_prefixes').split(',').map((s) => s.trim()).filter(Boolean);
    if (!prefixes.length) return;
    if (net.remote || !prefixes.some((p) => net.ip.startsWith(p))) fail(403, 'Chỉ chấm công được khi dùng wifi của quán');
  }

  r.post('/api/attendance/clock-in', 'staff', ({ me, net }) => {
    checkNetwork(net);
    ctx.autoCloseAttendance();
    const clock = ctx.clock();
    const t = ctx.now();
    const early = num('clock_early_minutes', 60) * 60_000;
    const grace = num('late_grace_minutes', 5) * 60_000;
    const result = tx(db, () => {
      if (db.prepare('SELECT 1 FROM attendance WHERE staff_id = ? AND clock_out IS NULL').get(me.id)) fail(409, 'Bạn đang trong ca, hãy chấm ra trước');
      const done = new Set(db.prepare('SELECT assignment_id FROM attendance WHERE staff_id = ? AND assignment_id IS NOT NULL').all(me.id).map((x) => x.assignment_id));
      const seg = mySegments(me.id, clock.businessDate(t))
        .map((a) => ({ ...a, ...rangeOf(clock, a) }))
        .find((s) => !done.has(s.id) && t >= s.start - early && t < s.end);
      const late = seg && t > seg.start + grace ? Math.round((t - seg.start) / 60_000) : 0;
      const date = seg ? seg.date : clock.businessDate(t);
      const id = Number(db.prepare(`INSERT INTO attendance (staff_id, assignment_id, date, clock_in, late_minutes, note, source) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(me.id, seg?.id ?? null, date, t, late, seg ? '' : 'Ngoài lịch', net.ip).lastInsertRowid);
      return { id, seg, late };
    });
    if (!result.seg) {
      ctx.notify(ctx.leadsOf(me.team_id).filter((id) => id !== me.id), { title: `${me.name} chấm công ngoài lịch`, body: `Lúc ${clock.fmt(t)}`, link: '/cham-cong' });
    } else if (result.late) {
      ctx.notify(ctx.leadsOf(me.team_id).filter((id) => id !== me.id), { title: `${me.name} đi trễ ${result.late} phút`, link: '/cham-cong' });
    }
    ctx.audit(me, 'clock.in', result.id);
    ctx.broadcast('attendance');
    return { ...myStatus(me), late_minutes: result.late, scheduled: Boolean(result.seg) };
  });

  r.post('/api/attendance/clock-out', 'staff', ({ me, net }) => {
    checkNetwork(net);
    const open = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND clock_out IS NULL').get(me.id);
    if (!open) fail(409, 'Bạn chưa chấm vào ca');
    // Còn giữ tiền mặt của khách chưa giao thu ngân thì không cho ra ca
    const held = ctx.cashHeldBy ? ctx.cashHeldBy(me.id) : 0;
    if (held) fail(409, `Bạn còn giữ ${held.toLocaleString('vi-VN')}đ tiền mặt chưa giao thu ngân. Giao tiền rồi chấm ra.`);
    db.prepare('UPDATE attendance SET clock_out = ? WHERE id = ?').run(ctx.now(), open.id);
    ctx.audit(me, 'clock.out', open.id);
    ctx.broadcast('attendance');
    return myStatus(me);
  });

  // ---------- Quản lý chấm công ----------
  r.get('/api/attendance', 'shift_lead', ({ query }) => {
    ctx.autoCloseAttendance();
    const from = query.get('from') || ctx.today();
    const to = query.get('to') || from;
    if (!isDate(from) || !isDate(to)) fail(400, 'Ngày không hợp lệ');
    const staffId = query.get('staff_id');
    return db.prepare(`SELECT at.*, s.name AS staff_name, t.name AS team_name, a.start_min, a.end_min, a.label, e.name AS edited_by_name
      FROM attendance at JOIN staff s ON s.id = at.staff_id LEFT JOIN teams t ON t.id = s.team_id
      LEFT JOIN assignments a ON a.id = at.assignment_id LEFT JOIN staff e ON e.id = at.edited_by
      WHERE at.date BETWEEN ? AND ? ${staffId ? 'AND at.staff_id = ?' : ''} ORDER BY at.clock_in DESC LIMIT 1000`)
      .all(...[from, to, ...(staffId ? [Number(staffId)] : [])]);
  });

  r.post('/api/attendance', 'shift_lead', ({ me, body }) => {
    const clock = ctx.clock();
    const staffId = v.int(body.staff_id, { min: 1, name: 'Nhân viên' });
    if (!ctx.staff(staffId)) fail(404, 'Không tìm thấy nhân viên');
    const cin = parseLocal(body.clock_in, clock);
    const cout = body.clock_out ? parseLocal(body.clock_out, clock) : null;
    if (cout !== null && cout <= cin) fail(400, 'Giờ ra phải sau giờ vào');
    if (cout !== null && cout - cin > 20 * 3600_000) fail(400, 'Một lượt chấm công không quá 20 giờ');
    const note = v.text(body.note, { name: 'Ghi chú', max: 200 }) || 'Quản lý thêm tay';
    const id = Number(db.prepare(`INSERT INTO attendance (staff_id, date, clock_in, clock_out, edited_by, note, source) VALUES (?, ?, ?, ?, ?, ?, 'manual')`)
      .run(staffId, clock.businessDate(cin), cin, cout, me.id, note).lastInsertRowid);
    ctx.audit(me, 'attendance.create', { id, staffId });
    ctx.broadcast('attendance');
    return { id };
  });

  r.patch('/api/attendance/:id', 'shift_lead', ({ me, params, body }) => {
    const clock = ctx.clock();
    const cur = db.prepare('SELECT * FROM attendance WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy lượt chấm công');
    const cin = body.clock_in ? parseLocal(body.clock_in, clock) : cur.clock_in;
    const cout = body.clock_out === undefined ? cur.clock_out : body.clock_out ? parseLocal(body.clock_out, clock) : null;
    if (cout !== null && cout <= cin) fail(400, 'Giờ ra phải sau giờ vào');
    if (cout !== null && cout - cin > 20 * 3600_000) fail(400, 'Một lượt chấm công không quá 20 giờ');
    const note = body.note === undefined ? cur.note : v.text(body.note, { name: 'Ghi chú', max: 200 });
    db.prepare('UPDATE attendance SET clock_in = ?, clock_out = ?, date = ?, note = ?, edited_by = ?, auto_closed = 0 WHERE id = ?')
      .run(cin, cout, cur.assignment_id ? cur.date : clock.businessDate(cin), note, me.id, cur.id);
    ctx.audit(me, 'attendance.update', { id: cur.id, before: [cur.clock_in, cur.clock_out], after: [cin, cout] });
    ctx.broadcast('attendance');
    return { ok: true };
  });

  r.delete('/api/attendance/:id', 'manager', ({ me, params }) => {
    const cur = db.prepare('SELECT * FROM attendance WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy lượt chấm công');
    db.prepare('DELETE FROM attendance WHERE id = ?').run(cur.id);
    ctx.audit(me, 'attendance.delete', cur);
    ctx.broadcast('attendance');
    return { ok: true };
  });

  // ---------- Bảng công & lương tạm tính theo tháng ----------
  r.get('/api/timesheet', 'manager', ({ me, query }) => {
    ctx.autoCloseAttendance();
    const month = query.get('month') || ctx.today().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'Tháng không hợp lệ');
    const from = `${month}-01`;
    const to = addDays(addDays(from, 32).slice(0, 7) + '-01', -1);
    const clock = ctx.clock();
    const staff = db.prepare('SELECT id, name, pay_type, pay_rate, team_id, active FROM staff ORDER BY name').all();
    const records = db.prepare(`SELECT at.*, a.group_id AS group_key FROM attendance at LEFT JOIN assignments a ON a.id = at.assignment_id
      WHERE at.date BETWEEN ? AND ?`).all(from, to);
    const rows = computeTimesheet(records, staff, clock, { nightBonusPct: num('night_bonus_pct', 30), monthStandardDays: num('month_standard_days', 26) });
    const stats = db.prepare(`SELECT staff_id, SUM(late_minutes > 0) AS late_count, SUM(late_minutes) AS late_minutes, SUM(auto_closed) AS auto_closed
      FROM attendance WHERE date BETWEEN ? AND ? GROUP BY staff_id`).all(from, to);
    const today = ctx.today();
    const absent = db.prepare(`SELECT a.staff_id, COUNT(DISTINCT a.group_id) AS n FROM assignments a
      WHERE a.date BETWEEN ? AND ? AND a.date < ?
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')
      AND NOT EXISTS (SELECT 1 FROM attendance x WHERE x.assignment_id IN (SELECT id FROM assignments WHERE group_id = a.group_id))
      GROUP BY a.staff_id`).all(from, to, today);
    const statBy = new Map(stats.map((s) => [s.staff_id, s]));
    const absentBy = new Map(absent.map((s) => [s.staff_id, s.n]));
    const active = new Set(staff.filter((s) => s.active).map((s) => s.id));
    return {
      month, from, to,
      night_bonus_pct: num('night_bonus_pct', 30),
      month_standard_days: num('month_standard_days', 26),
      rows: rows
        .map((row) => ({ ...row, late_count: statBy.get(row.staff_id)?.late_count || 0, late_minutes: statBy.get(row.staff_id)?.late_minutes || 0,
          auto_closed: statBy.get(row.staff_id)?.auto_closed || 0, absent: absentBy.get(row.staff_id) || 0 }))
        .filter((row) => active.has(row.staff_id) || row.minutes > 0),
      total_pay: rows.reduce((s, x) => s + x.pay, 0),
      can_see_pay: rank(me.role) >= rank('manager'),
    };
  });
}
