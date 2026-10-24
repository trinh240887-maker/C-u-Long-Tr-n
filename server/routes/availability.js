import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { isDate, addDays, weekStart } from '../lib/time.js';
import { allowedPages } from '../lib/perms.js';

// Lịch rảnh: nhân viên thời vụ tự báo buổi rảnh của tuần sau; quản lý xem dư/thiếu rồi tự xếp ca.
export const DEFAULT_SLOTS = [
  { key: 'sang', label: 'Sáng', start: '06:00', end: '12:00' },
  { key: 'chieu', label: 'Chiều', start: '12:00', end: '17:00' },
  { key: 'toi', label: 'Tối', start: '17:00', end: '24:00' },
];
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };
// Lịch rảnh lưu theo KHUNG GIỜ "HH:MM-HH:MM" (nhân viên tự chọn giờ, chủ quán 24/10). Dữ liệu cũ theo buổi (sang/chieu/toi) đổi ra khung của buổi.
const RANGE = /^([01]\d|2[0-4]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/;
// Ai phải báo lịch rảnh: mọi người trừ Chủ và Quản lý
const MUST = ['staff', 'team_lead', 'shift_lead'];
// Rửa chén không dùng điện thoại → không phải báo, quản lý xếp ca thẳng (chủ quán 24/10)
const EXEMPT = /r[ửu]a ch[ée]n/i;
const exempt = (p) => EXEMPT.test(p.team_name || '') || EXEMPT.test(p.position_name || '');

export default function (r, ctx) {
  const { db } = ctx;

  ctx.availSlots = () => {
    try {
      const s = JSON.parse(ctx.setting('avail_slots') || '[]');
      if (Array.isArray(s) && s.length) return s;
    } catch { /* dùng mặc định */ }
    return DEFAULT_SLOTS;
  };
  ctx.availRange = (slot) => {
    if (RANGE.test(slot)) { const [a, b] = slot.split('-'); return { start: toMin(a), end: toMin(b) }; }
    const sl = ctx.availSlots().find((x) => x.key === slot);
    return sl ? { start: toMin(sl.start), end: toMin(sl.end) } : null;
  };
  const rangeText = (slot) => { if (RANGE.test(slot)) return slot; const sl = ctx.availSlots().find((x) => x.key === slot); return sl ? `${sl.start}-${sl.end}` : null; };
  // Nhận 1 lựa chọn của nhân viên: khung giờ hợp lệ (bắt đầu < kết thúc) hoặc mã buổi cũ → luôn trả khung giờ
  const readPick = (x) => {
    const t = rangeText(String(x));
    if (!t) return null;
    const { start, end } = ctx.availRange(t);
    return end > start && end <= 1440 ? t : null;
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
      const t = rangeText(row.slot);
      if (t) (out[row.date] ||= []).push(t);
    }
    return out;
  }

  const FIXED_NOTE = 'Lịch cố định (tự động)';
  // Tuần chưa báo mà có lịch cố định → tự điền (coi như đã gửi). Chỉ tuần hiện tại / sắp tới
  function fillFixed(ws) {
    if (ws < weekStart(ctx.today())) return;
    const rows = db.prepare(`SELECT f.staff_id, f.dow, f.slot FROM availability_fixed f JOIN staff s ON s.id = f.staff_id
      WHERE s.active = 1 AND NOT EXISTS (SELECT 1 FROM availability_weeks w WHERE w.staff_id = f.staff_id AND w.week_start = ?)`).all(ws);
    if (!rows.length) return;
    tx(db, () => {
      const add = db.prepare('INSERT OR IGNORE INTO availability (staff_id, date, slot) VALUES (?, ?, ?)');
      const wk = db.prepare("INSERT OR IGNORE INTO availability_weeks (staff_id, week_start, submitted_at, note) VALUES (?, ?, ?, ?)");
      for (const x of rows) { add.run(x.staff_id, addDays(ws, x.dow - 1), x.slot); wk.run(x.staff_id, ws, ctx.now(), FIXED_NOTE); }
    });
  }
  ctx.fillFixedAvailability = fillFixed;
  const fixedOf = (staffId) => {
    const out = {};
    for (const x of db.prepare('SELECT dow, slot FROM availability_fixed WHERE staff_id = ?').all(staffId)) { const t = rangeText(x.slot); if (t) (out[x.dow] ||= []).push(t); }
    return out;
  };
  // Quản lý / trưởng ca báo hộ cho nhân viên không dùng điện thoại
  const targetOf = (me, id) => {
    if (!id || Number(id) === me.id) return me;
    if (rank(me.role) < rank('shift_lead')) fail(403, 'Chỉ trưởng ca trở lên báo hộ');
    const st = ctx.staff(Number(id));
    if (!st || !st.active) fail(404, 'Không tìm thấy nhân viên');
    return st;
  };

  r.get('/api/availability/me', 'staff', ({ me: who, query }) => {
    const ws = readWeek(query.get('week'));
    const me = targetOf(who, query.get('staff'));
    fillFixed(ws);
    const sub = db.prepare('SELECT * FROM availability_weeks WHERE staff_id = ? AND week_start = ?').get(me.id, ws);
    const dl = deadline(ws);
    return {
      week_start: ws, days: Array.from({ length: 7 }, (_, i) => addDays(ws, i)), slots: ctx.availSlots(),
      deadline: dl, must: MUST.includes(me.role) && !exempt(db.prepare('SELECT t.name AS team_name, p.name AS position_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id LEFT JOIN positions p ON p.id = s.position_id WHERE s.id = ?').get(me.id) || {}), late: !sub && ctx.now() > dl.at,
      submitted_at: sub?.submitted_at || null, note: sub?.note || '', picks: picksOf(me.id, ws),
      auto: sub?.note === FIXED_NOTE, fixed: fixedOf(me.id), prev_picks: Object.fromEntries(Object.entries(picksOf(me.id, addDays(ws, -7))).map(([d, x]) => [addDays(d, 7), x])),
      staff_name: me.id === who.id ? null : me.name,
      locked: ws <= ctx.today() && rank(who.role) < rank('manager'),
    };
  });

  r.post('/api/availability/me', 'staff', ({ me: who, body }) => {
    const ws = readWeek(body.week);
    const me = targetOf(who, body.staff_id);
    if (ws <= ctx.today() && rank(who.role) < rank('manager')) fail(400, 'Tuần này đã bắt đầu, nhờ quản lý sửa giúp');
    const days = new Set(Array.from({ length: 7 }, (_, i) => addDays(ws, i)));
    const picks = body.picks && typeof body.picks === 'object' ? body.picks : {};
    const note = v.text(body.note, { name: 'Ghi chú', max: 200 });
    tx(db, () => {
      db.prepare('DELETE FROM availability WHERE staff_id = ? AND date BETWEEN ? AND ?').run(me.id, ws, addDays(ws, 6));
      const add = db.prepare('INSERT OR IGNORE INTO availability (staff_id, date, slot) VALUES (?, ?, ?)');
      for (const [date, slots] of Object.entries(picks)) {
        if (!days.has(date) || !Array.isArray(slots)) continue;
        for (const x of slots) { const t = readPick(x); if (t) add.run(me.id, date, t); }
      }
      db.prepare(`INSERT INTO availability_weeks (staff_id, week_start, submitted_at, note) VALUES (?, ?, ?, ?)
        ON CONFLICT (staff_id, week_start) DO UPDATE SET submitted_at = excluded.submitted_at, note = excluded.note`).run(me.id, ws, ctx.now(), note);
      // "Tuần nào cũng vậy": lưu thành lịch cố định; bỏ tick thì xoá
      if (body.fixed !== undefined) {
        db.prepare('DELETE FROM availability_fixed WHERE staff_id = ?').run(me.id);
        // Tuần sau đã tự điền theo lịch cũ → xoá để điền lại theo lịch mới
        for (const w of db.prepare('SELECT week_start FROM availability_weeks WHERE staff_id = ? AND week_start > ? AND note = ?').all(me.id, ws, FIXED_NOTE)) {
          db.prepare('DELETE FROM availability WHERE staff_id = ? AND date BETWEEN ? AND ?').run(me.id, w.week_start, addDays(w.week_start, 6));
          db.prepare('DELETE FROM availability_weeks WHERE staff_id = ? AND week_start = ?').run(me.id, w.week_start);
        }
        if (body.fixed) {
          const addF = db.prepare('INSERT OR IGNORE INTO availability_fixed (staff_id, dow, slot) VALUES (?, ?, ?)');
          for (const [date, slots] of Object.entries(picks)) {
            if (!days.has(date) || !Array.isArray(slots)) continue;
            const dow = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${ws}T00:00:00Z`)) / 86400000) + 1;
            for (const x of slots) { const t = readPick(x); if (t) addF.run(me.id, dow, t); }
          }
        }
      }
    });
    ctx.audit(who, me.id === who.id ? 'availability.submit' : 'availability.submit_for', { week: ws, staff: me.id, fixed: !!body.fixed });
    ctx.broadcast('availability');
    return { ok: true };
  });

  // Tổng hợp cho quản lý: mỗi ngày × buổi có ai rảnh, đã xếp bao nhiêu, cần tối thiểu bao nhiêu
  function summary(ws) {
    fillFixed(ws);
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
    const hours = {}; // staff:date → ['16:00-23:00']
    for (const a of avail) {
      const r = ctx.availRange(a.slot);
      if (!r) continue;
      (hours[`${a.staff_id}:${a.date}`] ||= []).push(rangeText(a.slot));
      for (const sl of slots) if (r.start < toMin(sl.end) && r.end > toMin(sl.start)) {
        const k = `${a.date}:${sl.key}`;
        if (!(free[k] ||= []).includes(a.staff_id)) free[k].push(a.staff_id);
      }
    }
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
      people: people.filter((p) => !exempt(p)).map((p) => ({ ...p, submitted_at: subs.get(p.id)?.submitted_at || null, note: subs.get(p.id)?.note === FIXED_NOTE ? '' : subs.get(p.id)?.note || '', fixed: subs.get(p.id)?.note === FIXED_NOTE })),
      cells, busy: [...busy], hours,
    };
  }
  ctx.availabilitySummary = summary;

  // Xem lịch rảnh cả quán: tổ trưởng trở lên, hoặc người được cấp quyền Xếp ca
  r.get('/api/availability', 'staff', ({ me, query }) => {
    if (rank(me.role) < rank('team_lead') && !allowedPages(ctx, me).includes('/lich#xep')) fail(403, 'Cần quyền Xếp ca');
    return summary(readWeek(query.get('week')));
  });

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
