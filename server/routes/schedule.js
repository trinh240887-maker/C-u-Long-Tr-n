import { makeXlsx } from '../lib/xlsx.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { allowedPages } from '../lib/perms.js';
import { isDate, addDays, weekStart, segmentMinutes, fmtHM, overlaps, isoWeekday } from '../lib/time.js';
import { busyAround, rangeOf, groupSegments } from '../lib/schedule.js';

const WEEKDAY = ['', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

export function describeGroup(segs) {
  return segs.map((s) => `${fmtHM(s.start_min)}–${fmtHM(s.end_min)}`).join(' + ');
}

export default function (r, ctx) {
  const { db } = ctx;

  // ---------- Loại ca (do quán tự tạo) ----------
  function parseSegments(list) {
    if (!Array.isArray(list) || !list.length) fail(400, 'Ca cần ít nhất một khung giờ');
    if (list.length > 4) fail(400, 'Một ca tối đa 4 khúc');
    let segs;
    try {
      segs = list.map((s) => ({ start: String(s.start), end: String(s.end), ...segmentMinutes(s.start, s.end) }));
    } catch (e) {
      fail(400, e.message);
    }
    segs.sort((a, b) => a.start_min - b.start_min);
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].start_min < segs[i - 1].end_min) fail(400, 'Các khúc trong ca bị chồng giờ nhau. Một ca là giờ làm của 1 người; part-time giờ khác nhau hãy tạo mỗi giờ thành 1 loại ca riêng');
    }
    return segs;
  }

  r.get('/api/shift-templates', 'staff', () => db.prepare('SELECT * FROM shift_templates ORDER BY active DESC, name').all()
    .map((t) => ({ ...t, active: !!t.active, segments: JSON.parse(t.segments) })));

  r.post('/api/shift-templates', 'manager', ({ me, body }) => {
    const name = v.text(body.name, { name: 'Tên ca', required: true, max: 40 });
    const segs = parseSegments(body.segments).map(({ start, end }) => ({ start, end }));
    const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#c2410c';
    const id = Number(db.prepare('INSERT INTO shift_templates (name, color, segments) VALUES (?, ?, ?)').run(name, color, JSON.stringify(segs)).lastInsertRowid);
    ctx.audit(me, 'shift_template.create', name);
    ctx.broadcast('schedule');
    return { id };
  });

  r.patch('/api/shift-templates/:id', 'manager', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy loại ca');
    const name = body.name === undefined ? t.name : v.text(body.name, { name: 'Tên ca', required: true, max: 40 });
    const segs = body.segments === undefined ? t.segments : JSON.stringify(parseSegments(body.segments).map(({ start, end }) => ({ start, end })));
    const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : t.color;
    const active = body.active === undefined ? t.active : v.bool(body.active);
    // Sửa loại ca không làm đổi các ca đã xếp trước đó
    db.prepare('UPDATE shift_templates SET name = ?, segments = ?, color = ?, active = ? WHERE id = ?').run(name, segs, color, active, t.id);
    ctx.audit(me, 'shift_template.update', { id: t.id, name });
    ctx.broadcast('schedule');
    return { ok: true };
  });

  r.delete('/api/shift-templates/:id', 'manager', ({ me, params }) => {
    db.prepare('DELETE FROM shift_templates WHERE id = ?').run(params.id);
    ctx.audit(me, 'shift_template.delete', params.id);
    ctx.broadcast('schedule');
    return { ok: true };
  });

  // ---------- Lịch ca tuần ----------
  // Ai xem được ca của ai (chủ quán 24/10): nhân viên chỉ thấy ca mình; tổ trưởng / trưởng ca thấy người tổ mình quản;
  // quản lý, chủ, người có quyền Xếp ca thấy hết. Trả null = thấy hết
  // Quản lý có bộ phận (vd Quản lý · Bếp) chỉ xem / xếp ca bộ phận mình (chủ quán 28/10). Chủ quán, quản lý không bộ phận: cả quán.
  // Người chưa có bộ phận vẫn hiện để xếp được (vd phục vụ part-time chưa gán bộ phận)
  const teamScope = (me) => (me && me.role !== 'owner' && me.team_id && (me.role === 'manager' || allowedPages(ctx, me).includes('/lich#xep')) ? me.team_id : null);
  const staffTeam = (id) => db.prepare('SELECT team_id FROM staff WHERE id = ?').get(id)?.team_id ?? null;
  // Xem: thấy cả ca gắn bộ phận mình (người bộ phận khác sang làm)
  const canSee = (me, staffId, teamId) => { const sc = teamScope(me); if (!sc) return true; const st = staffTeam(staffId); return staffId === me.id || teamId === sc || st === sc || (st == null && (teamId == null || teamId === sc)); };
  // Sửa / xoá / gửi (rà soát 28/10): theo bộ phận GỐC của người đó, không theo bộ phận ghi trên ca (tránh gắn bộ phận mình để xếp người bộ phận khác)
  const inScope = (me, staffId, teamId) => { const sc = teamScope(me); if (!sc) return true; const st = staffTeam(staffId); return staffId === me.id || st === sc || (st == null && (teamId == null || teamId === sc)); };
  const mustScope = (me, staffId, teamId) => { if (!inScope(me, staffId, teamId)) fail(403, 'Bạn chỉ xếp ca cho người trong bộ phận mình'); };
  ctx.scheduleTeamScope = teamScope;
  ctx.scheduleInScope = inScope;
  // Tuần đã duyệt với 1 người (rà soát 28/10): duyệt cả quán HOẶC đã duyệt bộ phận của người đó
  const weekPublishedAt = (start, staffId) => {
    const all = Number(ctx.setting(`published:${start}`) || 0);
    if (all || !staffId) return all;
    const t = staffTeam(staffId);
    if (!t) return 0;
    const k = ctx.pvKind?.(staffId); // phục vụ: duyệt riêng bảng full-time / part-time (chủ quán 31/10)
    return Number(ctx.setting(`published:${start}:t${t}`) || 0) || (k ? Number(ctx.setting(`published:${start}:t${t}:${k}`) || 0) : 0);
  };
  ctx.weekPublishedAt = weekPublishedAt;
  function viewFilter(me) {
    if (teamScope(me)) return (staffId, teamId) => canSee(me, staffId, teamId);
    if (rank(me.role) >= rank('manager') || allowedPages(ctx, me).includes('/lich#xep')) return null;
    if ((me.role === 'shift_lead' || me.role === 'team_lead') && me.team_id) {
      const mine = new Set(db.prepare('SELECT id FROM staff WHERE team_id = ?').all(me.team_id).map((x) => x.id));
      return (staffId, teamId) => staffId === me.id || teamId === me.team_id || mine.has(staffId);
    }
    if (me.role === 'shift_lead') return null; // trưởng ca chung cả quán (không thuộc tổ nào)
    return (staffId) => staffId === me.id;
  }
  ctx.scheduleViewFilter = viewFilter;

  r.get('/api/schedule', 'staff', ({ me, query }) => {
    const see = viewFilter(me);
    const anchor = query.get('week') || ctx.today();
    if (!isDate(anchor)) fail(400, 'Ngày không hợp lệ');
    const start = weekStart(anchor);
    const end = addDays(start, 6);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const rows = db.prepare(`SELECT a.*, s.name AS staff_name, t.name AS team_name, st.color, z.name AS zone_name, p.name AS position_name, cb.name AS created_by_name
      FROM assignments a JOIN staff s ON s.id = a.staff_id LEFT JOIN positions p ON p.id = a.position_id LEFT JOIN staff cb ON cb.id = a.created_by
      LEFT JOIN teams t ON t.id = a.team_id LEFT JOIN shift_templates st ON st.id = a.template_id LEFT JOIN zones z ON z.id = a.zone_id
      WHERE a.date BETWEEN ? AND ? ORDER BY a.date, a.start_min`).all(start, end);
    const leaves = db.prepare(`SELECT l.id, l.group_id, l.staff_id, l.status, l.replacement_id, l.date FROM leave_requests l
      WHERE l.date BETWEEN ? AND ? AND l.status IN ('pending','approved')`).all(start, end);
    const leaveByGroup = new Map(leaves.map((l) => [l.group_id, l]));

    const groups = new Map();
    for (const a of rows) {
      const g = groups.get(a.group_id) || {
        group_id: a.group_id, staff_id: a.staff_id, staff_name: a.staff_name, team_id: a.team_id, team_name: a.team_name || '',
        date: a.date, label: a.label, note: a.note, template_id: a.template_id, color: a.color || '#64748b', segments: [],
        zone_id: a.zone_id, zone_name: a.zone_name || '', tables_text: a.tables_text || '',
        position_id: a.position_id ?? null, position_name: a.position_name || '',
        created_by_name: a.created_by_name || (a.note === 'Theo lịch rảnh' ? 'tự tạo từ lịch rảnh' : ''), created_at: a.created_at,
        leave: leaveByGroup.get(a.group_id) || null,
      };
      g.segments.push({ start_min: a.start_min, end_min: a.end_min, start: fmtHM(a.start_min), end: fmtHM(a.end_min) });
      groups.set(a.group_id, g);
    }
    const shifts = [...groups.values()].filter((g) => !see || see(g.staff_id, g.team_id)).map((g) => ({ ...g, text: describeGroup(g.segments) }));

    // Cảnh báo thiếu người theo số tối thiểu của từng tổ
    // Quản lý có bộ phận: chỉ cảnh báo bộ phận mình (ca bộ phận khác đã lọc bỏ → không báo thiếu giả) (rà soát 28/10)
    const sc = teamScope(me);
    const teams = db.prepare('SELECT id, name, min_staff FROM teams WHERE active = 1 ORDER BY sort, id').all();
    const positions = db.prepare('SELECT p.id, p.name, p.team_id, p.min_staff FROM positions p JOIN teams t ON t.id = p.team_id WHERE p.active = 1 AND t.active = 1').all();
    const warnings = [];
    const coverage = {};
    for (const d of days) {
      coverage[d] = {};
      for (const t of teams) {
        const people = new Set(shifts.filter((s) => s.date === d && s.team_id === t.id && s.leave?.status !== 'approved').map((s) => s.staff_id));
        coverage[d][t.id] = people.size;
        if (t.min_staff && people.size < t.min_staff && (!sc || t.id === sc)) {
          warnings.push({ date: d, team_id: t.id, text: `${WEEKDAY[isoWeekday(d)]} ${d.slice(8)}/${d.slice(5, 7)}: ${t.name} có ${people.size}/${t.min_staff} người` });
        }
      }
      for (const p of positions) {
        const n = new Set(shifts.filter((s) => s.date === d && s.position_id === p.id && s.leave?.status !== 'approved').map((s) => s.staff_id)).size;
        coverage[d][`p${p.id}`] = n;
        if (p.min_staff && n < p.min_staff && (!sc || p.team_id === sc)) {
          warnings.push({ date: d, team_id: p.team_id, position_id: p.id, text: `${WEEKDAY[isoWeekday(d)]} ${d.slice(8)}/${d.slice(5, 7)}: ${p.name} có ${n}/${p.min_staff} người` });
        }
      }
    }
    const availability = {};
    ctx.fillFixedAvailability?.(start);
    for (const a of db.prepare('SELECT staff_id, date, slot FROM availability WHERE date BETWEEN ? AND ?').all(start, end)) {
      const r = ctx.availRange?.(a.slot);
      if (r && (!see || see(a.staff_id, null))) ((availability[a.staff_id] ||= {})[a.date] ||= []).push(`${String(Math.floor(r.start / 60)).padStart(2, '0')}:${String(r.start % 60).padStart(2, '0')}-${String(Math.floor(r.end / 60)).padStart(2, '0')}:${String(r.end % 60).padStart(2, '0')}`);
    }
    const submitted = db.prepare('SELECT staff_id FROM availability_weeks WHERE week_start = ?').all(start).map((x) => x.staff_id);
    return { week_start: start, week_zones: weekZones(start), days, shifts, coverage, availability, avail_submitted: submitted, slots: ctx.availSlots(), warnings,
      published_at: Number(ctx.setting(`published:${start}`) || 0) || (me.team_id ? Number(ctx.setting(`published:${start}:t${me.team_id}`) || 0) : 0) };
  });

  // Phân khu theo tuần (chủ quán 24/10): mỗi người 1 khu cho cả tuần → mọi ca trong tuần nhận khu đó
  const weekZones = (ws) => { try { return JSON.parse(ctx.setting(`zone_week:${ws}`) || '{}'); } catch { return {}; } };
  // Giá trị: số (khu) hoặc { z: khu, t: 'bàn 1-10' }
  const wzOf = (v0) => (v0 && typeof v0 === 'object' ? { zoneId: Number(v0.z) || null, tablesText: v0.t || '' } : { zoneId: Number(v0) || null, tablesText: '' });
  ctx.weekZoneOf = (staffId, date) => wzOf(weekZones(weekStart(date))[staffId]);

  function createGroup(me, { staffId, date, teamId, segs, templateId, label, note, replaceGroup, zoneId = null, tablesText = '', positionId = null }) {
    const st = ctx.staff(staffId);
    if (!st || !st.active) fail(404, 'Không tìm thấy nhân viên');
    const clock = ctx.clock();
    const groupId = replaceGroup || crypto.randomBytes(8).toString('hex');
    const mine = (busyAround(db, clock, date, { excludeGroup: replaceGroup }).get(staffId) || []);
    for (const s of segs) {
      const range = rangeOf(clock, { date, ...s });
      if (mine.some((b) => overlaps(range, b))) fail(409, `${st.name} đã có ca trùng giờ ${fmtHM(s.start_min)}–${fmtHM(s.end_min)}`);
    }
    const team = teamId ?? st.team_id;
    if (!zoneId) { const wz = ctx.weekZoneOf(staffId, date); zoneId = wz.zoneId; tablesText = wz.tablesText; }
    // Ca không chọn loại ca (xếp từ lịch rảnh / Bảng tuần) mà giờ trùng đúng 1 loại ca → gắn loại ca đó,
    // để checklist theo ca (Mở ca / Đóng ca…) hiện đúng cho người làm
    if (!templateId) {
      const key = segs.map((x) => `${x.start_min}-${x.end_min % 1440}`).join('|');
      for (const t of db.prepare('SELECT id, name, segments FROM shift_templates WHERE active = 1').all()) {
        const tk = JSON.parse(t.segments).map((x) => { const m = segmentMinutes(x.start, x.end); return `${m.start_min}-${m.end_min % 1440}`; }).join('|');
        if (tk === key) { templateId = t.id; if (!label || label === 'Ca') label = t.name; break; }
      }
    }
    // Không chọn vị trí: dùng vị trí chính của người đó nếu cùng bộ phận
    const pos = positionId ?? (st.position_id && team === st.team_id ? st.position_id : null);
    const insert = db.prepare(`INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, template_id, label, note, created_by, created_at, zone_id, tables_text, position_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of segs) insert.run(groupId, staffId, team, date, s.start_min, s.end_min, templateId, label, note, me.id, ctx.now(), zoneId, tablesText, pos);
    return groupId;
  }

  function readShiftBody(body) {
    const staffId = v.int(body.staff_id, { min: 1, name: 'Nhân viên' });
    const date = String(body.date || '');
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    const teamId = v.optInt(body.team_id, { min: 1, name: 'Tổ' });
    if (teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) fail(400, 'Tổ không tồn tại');
    let templateId = v.optInt(body.template_id, { min: 1, name: 'Loại ca' });
    let label = v.text(body.label, { name: 'Tên ca', max: 40 });
    let segsInput = body.segments;
    if (templateId) {
      const t = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(templateId);
      if (!t) fail(400, 'Loại ca không tồn tại');
      if (!segsInput) segsInput = JSON.parse(t.segments);
      if (!label) label = t.name;
    }
    const segs = parseSegments(segsInput);
    const positionId = ctx.readPosition(body.position_id, teamId ?? ctx.staff(staffId)?.team_id);
    return { staffId, date, teamId, templateId, label, note: v.text(body.note, { name: 'Ghi chú', max: 200 }), segs, positionId, ...ctx.readZone(body) };
  }

  r.post('/api/shifts', 'manager', ({ me, body }) => {
    const input = readShiftBody(body);
    const replaceGroup = body.replace_group_id ? String(body.replace_group_id) : null;
    mustScope(me, input.staffId, input.teamId);
    if (replaceGroup) { const o = groupSegments(db, replaceGroup)[0]; if (o) mustScope(me, o.staff_id, o.team_id); }
    const groupId = tx(db, () => {
      if (replaceGroup) {
        const old = groupSegments(db, replaceGroup);
        if (!old.length) fail(404, 'Ca cần sửa không còn tồn tại');
        if (old[0].staff_id !== input.staffId && db.prepare("SELECT 1 FROM leave_requests WHERE group_id = ? AND status IN ('pending','approved')").get(replaceGroup)) {
          fail(409, 'Ca này đang có đơn xin nghỉ, không đổi sang người khác được. Hãy xử lý đơn nghỉ trước');
        }
        db.prepare('DELETE FROM assignments WHERE group_id = ?').run(replaceGroup);
      }
      // Sửa ca giữ nguyên mã ca để đơn nghỉ/chấm công vẫn gắn đúng
      return createGroup(me, { ...input, replaceGroup });
    });
    ctx.audit(me, replaceGroup ? 'shift.update' : 'shift.create', { group_id: groupId, staff_id: input.staffId, date: input.date });
    ctx.broadcast('schedule');
    return { group_id: groupId };
  });

  r.post('/api/shifts/delete', 'manager', ({ me, body }) => {
    const groupId = String(body.group_id || '');
    const segs = groupSegments(db, groupId);
    if (!segs.length) fail(404, 'Không tìm thấy ca');
    mustScope(me, segs[0].staff_id, segs[0].team_id);
    tx(db, () => {
      db.prepare('DELETE FROM assignments WHERE group_id = ?').run(groupId);
      db.prepare("UPDATE leave_requests SET status = 'cancelled', decision_note = 'Ca đã bị xoá' WHERE group_id = ? AND status = 'pending'").run(groupId);
    });
    ctx.audit(me, 'shift.delete', { group_id: groupId, staff_id: segs[0].staff_id, date: segs[0].date });
    ctx.broadcast('schedule');
    return { ok: true };
  });

  // Sao chép cả tuần sang tuần khác (bỏ qua người đã có ca ngày đó)
  r.post('/api/schedule/copy', 'manager', ({ me, body }) => {
    if (!isDate(body.from_week) || !isDate(body.to_week)) fail(400, 'Tuần không hợp lệ');
    const from = weekStart(body.from_week);
    const to = weekStart(body.to_week);
    if (from === to) fail(400, 'Tuần nguồn và tuần đích trùng nhau');
    const shift = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
    const rows = db.prepare(`SELECT a.* FROM assignments a JOIN staff s ON s.id = a.staff_id AND s.active = 1
      WHERE a.date BETWEEN ? AND ? ORDER BY a.group_id, a.start_min`).all(from, addDays(from, 6));
    const groups = new Map();
    for (const a of rows) groups.set(a.group_id, [...(groups.get(a.group_id) || []), a]);
    let copied = 0;
    let skipped = 0;
    // Người đã tự báo lịch rảnh tuần đích → lịch theo đúng người đó báo, không chép tuần trước đè vào ngày nghỉ (chủ quán 29/10)
    const reported = new Set(db.prepare('SELECT staff_id FROM availability_weeks WHERE week_start = ? AND note != ?').all(to, FIXED_AVAIL_NOTE).map((x) => x.staff_id));
    let reportedSkip = 0;
    tx(db, () => {
      for (const segs of groups.values()) {
        const first = segs[0];
        if (!inScope(me, first.staff_id, first.team_id)) continue;
        if (reported.has(first.staff_id)) { reportedSkip++; continue; }
        const date = addDays(first.date, shift);
        const has = db.prepare('SELECT 1 FROM assignments WHERE staff_id = ? AND date = ?').get(first.staff_id, date);
        if (has) { skipped++; continue; }
        try {
          createGroup(me, { staffId: first.staff_id, date, teamId: first.team_id, segs, templateId: first.template_id, label: first.label, note: first.note === AUTO_NOTE ? AUTO_NOTE : COPY_NOTE, zoneId: first.zone_id, tablesText: first.tables_text, positionId: first.position_id });
          copied++;
        } catch {
          skipped++;
        }
      }
    });
    ctx.audit(me, 'schedule.copy', { from, to, copied, skipped, reported: reportedSkip });
    ctx.broadcast('schedule');
    return { copied, skipped, reported: reportedSkip };
  });

  // Lịch rảnh nhân viên báo = lịch làm (chủ quán 24/10): báo xong tự thành ca, quản lý chỉ sửa / bỏ rồi Duyệt.
  // Gửi lại → thay các ca tự tạo (note 'Theo lịch rảnh') của tuần đó; ca quản lý tự xếp / đã sửa giữ nguyên. Tuần đã duyệt thì không tự đổi
  const AUTO_NOTE = 'Theo lịch rảnh';
  const COPY_NOTE = 'Chép tuần trước'; // ca chép: nhân viên báo lịch rảnh sau đó thì thay bằng lịch báo
  const FIXED_AVAIL_NOTE = 'Lịch cố định (tự động)';
  function availToShifts(staffId, start, me, { force = false } = {}) {
    if (!force && weekPublishedAt(start, staffId)) return { made: 0, skipped: 0 };
    const end = addDays(start, 6);
    const rows = db.prepare('SELECT date, slot FROM availability WHERE staff_id = ? AND date BETWEEN ? AND ? ORDER BY date, slot').all(staffId, start, end);
    let made = 0, skipped = 0;
    tx(db, () => {
      db.prepare('DELETE FROM assignments WHERE staff_id = ? AND date BETWEEN ? AND ? AND note IN (?, ?) AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = assignments.group_id)').run(staffId, start, end, AUTO_NOTE, COPY_NOTE);
      const byDay = new Map();
      for (const a of rows) { const r = ctx.availRange?.(a.slot); if (r) byDay.set(a.date, [...(byDay.get(a.date) || []), r]); }
      for (const [date, list] of byDay) {
        if (db.prepare('SELECT 1 FROM assignments WHERE staff_id = ? AND date = ?').get(staffId, date)) { skipped++; continue; }
        const segs = list.sort((x, y) => x.start - y.start).reduce((acc, r) => {
          const last = acc.at(-1);
          if (last && r.start <= last.end_min) last.end_min = Math.max(last.end_min, r.end); else acc.push({ start_min: r.start, end_min: r.end });
          return acc;
        }, []).slice(0, 4);
        try { createGroup(me, { staffId, date, teamId: null, segs, templateId: null, label: 'Ca', note: AUTO_NOTE }); made++; } catch { skipped++; }
      }
    });
    if (made) ctx.broadcast('schedule');
    return { made, skipped };
  }
  ctx.availToShifts = availToShifts;
  // 1 lần: ca đã tạo không có loại ca mà giờ trùng loại ca → gắn loại ca (từ hôm nay trở đi)
  if (!ctx.setting('shift_tpl_v1')) {
    const tpls = db.prepare('SELECT id, name, segments FROM shift_templates WHERE active = 1').all().map((t) => ({ ...t, key: JSON.parse(t.segments).map((x) => { const m = segmentMinutes(x.start, x.end); return `${m.start_min}-${m.end_min % 1440}`; }).join('|') }));
    const groups = new Map();
    for (const a of db.prepare('SELECT group_id, start_min, end_min, label FROM assignments WHERE template_id IS NULL AND date >= ? ORDER BY start_min').all(ctx.today())) groups.set(a.group_id, [...(groups.get(a.group_id) || []), a]);
    for (const [gid, segs] of groups) {
      const t = tpls.find((x) => x.key === segs.map((z) => `${z.start_min}-${z.end_min % 1440}`).join('|'));
      if (t) db.prepare("UPDATE assignments SET template_id = ?, label = CASE WHEN label IN ('', 'Ca') THEN ? ELSE label END WHERE group_id = ?").run(t.id, t.name, gid);
    }
    ctx.setSetting('shift_tpl_v1', '1');
  }
  // 1 lần: lịch rảnh đã báo trước khi có tính năng này → tạo ca cho tuần hiện tại / sắp tới chưa duyệt
  if (!ctx.setting('avail_to_shift_v1')) {
    const from = weekStart(ctx.today());
    for (const w of db.prepare('SELECT staff_id, week_start FROM availability_weeks WHERE week_start >= ?').all(from)) {
      try { availToShifts(w.staff_id, w.week_start, { id: null }); } catch { /* bỏ qua */ }
    }
    ctx.setSetting('avail_to_shift_v1', '1');
  }

  r.post('/api/schedule/week-zones', 'manager', ({ me, body }) => {
    if (!isDate(body.week)) fail(400, 'Tuần không hợp lệ');
    const ws = weekStart(body.week);
    const staffId = v.int(body.staff_id, { min: 1, name: 'Nhân viên' });
    mustScope(me, staffId, null);
    // Khu + (tuỳ chọn) bàn phụ trách, vd khu A bàn 1-10
    const { zoneId, tablesText } = ctx.readZone({ zone_id: body.zone_id, tables_text: body.tables_text });
    const map = weekZones(ws);
    if (zoneId) map[staffId] = tablesText ? { z: zoneId, t: tablesText } : zoneId; else delete map[staffId];
    ctx.setSetting(`zone_week:${ws}`, JSON.stringify(map));
    db.prepare('UPDATE assignments SET zone_id = ?, tables_text = ? WHERE staff_id = ? AND date BETWEEN ? AND ?').run(zoneId, tablesText, staffId, ws, addDays(ws, 6));
    ctx.audit(me, 'schedule.week_zone', { week: ws, staff: staffId, zone: zoneId });
    ctx.broadcast('schedule');
    return { ok: true, week_zones: map };
  });

  // Tải lịch tuần ra Excel theo kiểu bảng "Lịch trực ca": bộ phận | tên | vị trí | T2 … CN
  r.get('/api/schedule.xlsx', 'staff', ({ me, query }) => {
    const see = viewFilter(me);
    const anchor = query.get('week') || ctx.today();
    if (!isDate(anchor)) fail(400, 'Ngày không hợp lệ');
    const start = weekStart(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const staff = db.prepare(`SELECT s.id, s.name, s.team_id, t.name AS team_name, p.name AS position_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id LEFT JOIN positions p ON p.id = s.position_id
      WHERE s.active = 1 AND s.role != 'owner' ORDER BY t.sort, t.id, s.name`).all();
    const rows = db.prepare(`SELECT a.staff_id, a.date, a.group_id, a.start_min, a.end_min FROM assignments a WHERE a.date BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved') ORDER BY a.start_min`).all(start, addDays(start, 6));
    const cell = (sid, d) => rows.filter((a) => a.staff_id === sid && a.date === d).map((a) => `${fmtHM(a.start_min)}-${fmtHM(a.end_min % 1440)}`).join(', ');
    const head = ['Bộ phận', 'Tên', 'Vị trí', ...days.map((d) => `${WEEKDAY[isoWeekday(d)]} ${d.slice(8)}/${d.slice(5, 7)}`)];
    const body = staff.filter((p) => !see || see(p.id, p.team_id)).map((p) => [p.team_name || '', p.name, p.position_name || '', ...days.map((d) => cell(p.id, d))]);
    return { __binary: makeXlsx([{ name: 'Lịch ca', rows: [head, ...body] }]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `lich-ca_${start}.xlsx` };
  });

  // Gửi lịch tuần cho từng nhân viên qua thông báo (Zalo nếu đã bật)
  // Duyệt lịch TỪNG BỘ PHẬN (chủ quán 25/10): ngày chưa có ca mà có lịch rảnh → tạo ca theo lịch rảnh,
  // báo từng người, bot gửi bảng lịch bộ phận vào nhóm Zalo có bộ phận đó
  r.post('/api/schedule/publish-team', 'manager', async ({ me, body }) => {
    if (!isDate(body.week)) fail(400, 'Tuần không hợp lệ');
    const start = weekStart(body.week);
    const team = db.prepare('SELECT id, name FROM teams WHERE id = ?').get(v.int(body.team_id, { min: 1, name: 'Bộ phận' }));
    if (!team) fail(404, 'Không tìm thấy bộ phận');
    if (teamScope(me) && teamScope(me) !== team.id) fail(403, 'Bạn chỉ duyệt lịch bộ phận mình');
    const kind = ['full', 'part'].includes(body.kind) ? body.kind : null; // duyệt riêng 1 bảng của phục vụ
    const people = db.prepare("SELECT s.id, s.name, s.role, s.work_type, s.home_zone_id, p.name AS position_name FROM staff s LEFT JOIN positions p ON p.id = s.position_id WHERE s.active = 1 AND s.role != 'owner' AND s.team_id = ? ORDER BY s.name").all(team.id)
      .filter((p) => !kind || (kind === 'part') === (p.work_type === 'part'));
    let made = 0;
    for (const p of people) made += availToShifts(p.id, start, me, { force: true }).made;
    const end = addDays(start, 6);
    const lines = [];
    const days7 = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    // Khu phụ trách (Phục vụ): ghi thêm vào ô, vd "14–23 · A 1-10"
    const zname = new Map(db.prepare('SELECT id, name FROM zones').all().map((z) => [z.id, z.name.replace(/^Khu\s*/i, '')]));
    const zoneTxt = (segs) => { const a = segs.find((x) => x.zone_id); return a ? ` · ${zname.get(a.zone_id) || ''}${a.tables_text ? ` ${a.tables_text}` : ''}` : ''; };
    const short = (segs) => describeGroup(segs).replace(/:00/g, '').replace(/\b0(\d)/g, '$1').replace(/–0\b/g, '–24') + zoneTxt(segs);
    const ROLE_TAG = { team_lead: 'Tổ trưởng', shift_lead: 'Trưởng ca', manager: 'Quản lý' };
    const WORK_TAG = { full: 'Full ca', gay: 'Ca gãy', part: 'Part-time' };
    const table = { title: `LỊCH ${team.name.toUpperCase()}${kind === 'part' ? ' – PART-TIME' : kind === 'full' ? ' – FULL-TIME' : ''}`, week: `${start.slice(8)}/${start.slice(5, 7)} – ${end.slice(8)}/${end.slice(5, 7)}`, days: days7.map((d) => ({ dow: WEEKDAY[isoWeekday(d)], date: `${d.slice(8)}/${d.slice(5, 7)}` })), rows: [] };
    let sent = 0;
    for (const p of people) {
      const rows = db.prepare(`SELECT a.* FROM assignments a WHERE a.staff_id = ? AND a.date BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved') ORDER BY a.date, a.start_min`).all(p.id, start, end);
      const byDay = new Map();
      for (const a of rows) byDay.set(a.date, [...(byDay.get(a.date) || []), a]);
      // Khu chính của tuần = khu xuất hiện nhiều ngày nhất; ô chỉ ghi khu khi ngày đó khác khu chính (chủ quán 25/10: ảnh xếp theo khu)
      const zCount = new Map();
      for (const segs of byDay.values()) { const a = segs.find((x) => x.zone_id); if (a) zCount.set(a.zone_id, (zCount.get(a.zone_id) || 0) + 1); }
      const mainZ = [...zCount].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
      const cellOf = (segs) => { const a = segs.find((x) => x.zone_id); const base = describeGroup(segs).replace(/:00/g, '').replace(/\b0(\d)/g, '$1').replace(/–0\b/g, '–24');
        if (!a) return base; if (a.zone_id === mainZ) return base + (a.tables_text ? ` · bàn ${a.tables_text}` : ''); return base + zoneTxt(segs); };
      table.rows.push({ name: p.name, zone: mainZ ? `KHU ${zname.get(mainZ) || ''}`.trim() : '', zone_sort: mainZ ? [...zname.keys()].indexOf(mainZ) : 999, lead: ['shift_lead', 'team_lead', 'manager'].includes(p.role) ? 0 : 1,
        tags: [ROLE_TAG[p.role], WORK_TAG[p.work_type], p.position_name].filter(Boolean), cells: days7.map((d) => (byDay.has(d) ? cellOf(byDay.get(d)) : '')) });
      if (!rows.length) continue;
      const days = [...byDay].map(([date, segs]) => ({ date, txt: describeGroup(segs).replace(/:00/g, '').replace(/\b0(\d)/g, '$1').replace(/–0\b/g, '–24') }));
      // Gộp ngày liền nhau cùng giờ: "T2–T6 8–12 + 14–23 · T7 14–23"
      const grp = [];
      for (const x of days) { const g = grp.at(-1); if (g && g.txt === x.txt && addDays(g.to, 1) === x.date) g.to = x.date; else grp.push({ from: x.date, to: x.date, txt: x.txt }); }
      const all7 = grp.length === 1 && grp[0].from === start && grp[0].to === end;
      lines.push(`• ${p.name}: ${all7 ? `cả tuần ${grp[0].txt}` : grp.map((g) => `${WEEKDAY[isoWeekday(g.from)]}${g.to !== g.from ? `–${WEEKDAY[isoWeekday(g.to)]}` : ''} ${g.txt}`).join(' · ')}`);
      ctx.notify(p.id, { title: `Lịch làm tuần ${start.slice(8)}/${start.slice(5, 7)} đã duyệt`, body: [...byDay].map(([date, segs]) => `• ${WEEKDAY[isoWeekday(date)]} ${date.slice(8)}/${date.slice(5, 7)}: ${describeGroup(segs)}${zoneTxt(segs) ? ` · 📍 Khu${zoneTxt(segs).slice(2)}` : ''}`).join('\n'), link: '/lich' });
      sent++;
    }
    ctx.setSetting(kind ? `published:${start}:t${team.id}:${kind}` : `published:${start}:t${team.id}`, ctx.now());
    const text = `📅 LỊCH ${team.name.toUpperCase()}${kind === 'part' ? ' PART-TIME' : kind === 'full' ? ' FULL-TIME' : ''} tuần ${start.slice(8)}/${start.slice(5, 7)}–${end.slice(8)}/${end.slice(5, 7)} (đã duyệt)\n${lines.length ? lines.join('\n') : '(chưa có ai có ca)'}\nAi cần đổi ca báo quản lý. Xem chi tiết: mở app → Lịch ca.`;
    let groups = 0, group_error = '';
    // body.image = true: máy quản lý sẽ vẽ ảnh bảng rồi gọi /team-image để bot gửi ảnh (lỗi thì gửi chữ ở đó)
    if (!body.image && ctx.zaloBot?.ready() && ctx.staffGroups) {
      for (const g of ctx.staffGroups().filter((x) => (x.teams || []).includes(team.id))) {
        try { await ctx.zaloBot.send(g.id, text.slice(0, 2000)); groups++; } catch (e) { group_error = e.message; }
      }
    }
    const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id).filter((id) => id !== me.id);
    if (owners.length) ctx.notify(owners, { title: `${me.name} đã duyệt lịch ${team.name} tuần ${start.slice(8)}/${start.slice(5, 7)}`, body: `${sent} người có ca.`, link: `/ranh?tab=all&week=${start}` });
    ctx.audit(me, 'schedule.publish_team', { week: start, team: team.id, kind, made, sent, groups });
    ctx.broadcast('schedule');
    // Gộp theo khu (A, B, C… rồi chưa khu), trong khu: trưởng ca / tổ trưởng lên đầu; ai không có ca xuống cuối
    table.rows.sort((a, b) => (b.cells.some(Boolean) ? 1 : 0) - (a.cells.some(Boolean) ? 1 : 0) || a.zone_sort - b.zone_sort || a.lead - b.lead || a.name.localeCompare(b.name, 'vi'));
    table.grouped = table.rows.some((r) => r.zone);
    return { made, sent, groups, group_error, text, table };
  });

  // Ảnh bảng lịch bộ phận (máy quản lý vẽ) → lưu, tạo link công khai khó đoán → bot gửi ảnh vào nhóm; lỗi thì gửi chữ
  const pubDir = path.join(ctx.photoDir || path.join(os.tmpdir(), 'quanly-photos'), 'lich');
  r.post('/api/schedule/team-image', 'manager', async ({ me, body, req }) => {
    const team = db.prepare('SELECT id, name FROM teams WHERE id = ?').get(v.int(body.team_id, { min: 1, name: 'Bộ phận' }));
    if (!team) fail(404, 'Không tìm thấy bộ phận');
    if (teamScope(me) && teamScope(me) !== team.id) fail(403, 'Bạn chỉ gửi lịch bộ phận mình');
    const text = v.text(body.text, { name: 'Nội dung', max: 4000 });
    const targets = (ctx.staffGroups?.() || []).filter((x) => (x.teams || []).includes(team.id));
    if (!targets.length || !ctx.zaloBot?.ready()) return { groups: 0, group_error: targets.length ? 'Chưa cài bot' : '' };
    let url = '';
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (m) {
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 500 && buf.length < 4_000_000) {
        fs.mkdirSync(pubDir, { recursive: true });
        // Dọn ảnh lịch cũ hơn 30 ngày
        try { for (const f of fs.readdirSync(pubDir)) if (Date.now() - fs.statSync(path.join(pubDir, f)).mtimeMs > 30 * 86_400_000) fs.rmSync(path.join(pubDir, f)); } catch { /* bỏ qua */ }
        const file = `${crypto.randomBytes(16).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : 'png'}`;
        fs.writeFileSync(path.join(pubDir, file), buf);
        const base = (ctx.setting('public_url') || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`).replace(/\/$/, '');
        url = `${base}/api/pub/lich?f=${file}`;
      }
    }
    let groups = 0, group_error = '', photo = false;
    const caption = text.split('\n')[0] + '\nAi cần đổi ca báo quản lý. Xem chi tiết: mở app → Lịch ca.';
    for (const g of targets) {
      try {
        if (url) { try { await ctx.zaloBot.sendPhoto(g.id, url, caption); photo = true; } catch (e) { group_error = `Gửi ảnh lỗi (${e.message}), đã gửi dạng chữ`; await ctx.zaloBot.send(g.id, text.slice(0, 2000)); } }
        else await ctx.zaloBot.send(g.id, text.slice(0, 2000));
        groups++;
      } catch (e) { group_error = e.message; }
    }
    ctx.audit(me, 'schedule.team_image', { team: team.id, groups, photo });
    return { groups, group_error, photo, url };
  });
  r.get('/api/pub/lich', null, ({ query }) => {
    const file = String(query.get('f') || '');
    if (!/^[0-9a-f]{32}\.(png|jpg)$/.test(file)) fail(404, 'Không có ảnh');
    let buf;
    try { buf = fs.readFileSync(path.join(pubDir, file)); } catch { fail(404, 'Không có ảnh'); }
    return { __binary: buf, type: file.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  });

  r.post('/api/schedule/publish', 'manager', ({ me, body }) => {
    if (!isDate(body.week)) fail(400, 'Tuần không hợp lệ');
    const start = weekStart(body.week);
    // Quản lý có bộ phận: chỉ gửi lịch cho người bộ phận mình
    // Duyệt theo bộ phận: chỉ báo người thuộc bộ phận mình (người chưa có bộ phận để chủ / quản lý chung gửi, tránh nhận lịch thiếu từ từng quản lý) (rà soát 28/10)
    const sc = teamScope(me);
    const rows = db.prepare(`SELECT a.* FROM assignments a WHERE a.date BETWEEN ? AND ? ORDER BY a.date, a.start_min`).all(start, addDays(start, 6))
      .filter((a) => inScope(me, a.staff_id, a.team_id) && (!sc || staffTeam(a.staff_id) === sc));
    const byStaff = new Map();
    for (const a of rows) {
      const m = byStaff.get(a.staff_id) || new Map();
      m.set(a.group_id, [...(m.get(a.group_id) || []), a]);
      byStaff.set(a.staff_id, m);
    }
    for (const [staffId, groups] of byStaff) {
      const lines = [...groups.values()].map((segs) => `• ${WEEKDAY[isoWeekday(segs[0].date)]} ${segs[0].date.slice(8)}/${segs[0].date.slice(5, 7)}: ${segs[0].label ? segs[0].label + ' ' : ''}${describeGroup(segs)}`);
      ctx.notify(staffId, { title: `Lịch làm tuần ${start.slice(8)}/${start.slice(5, 7)}`, body: lines.join('\n'), link: '/lich' });
    }
    if (teamScope(me)) ctx.setSetting(`published:${start}:t${teamScope(me)}`, ctx.now()); else ctx.setSetting(`published:${start}`, ctx.now());
    // Duyệt lịch tuần: gửi chủ quán xem (người duyệt không phải chủ)
    const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id).filter((id) => id !== me.id);
    if (owners.length) {
      const nGroups = [...byStaff.values()].reduce((n, g) => n + g.size, 0);
      ctx.notify(owners, { title: `${me.name} đã duyệt lịch tuần ${start.slice(8)}/${start.slice(5, 7)}`, body: `${byStaff.size} người · ${nGroups} ca. Bấm để xem bảng lịch.`, link: `/ranh?tab=all&week=${start}` });
    }
    ctx.audit(me, 'schedule.publish', start);
    ctx.broadcast('schedule');
    return { sent: byStaff.size };
  });
}
