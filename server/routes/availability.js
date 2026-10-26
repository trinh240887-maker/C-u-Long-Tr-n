import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { isDate, addDays, weekStart, isoWeekday } from '../lib/time.js';
import { allowedPages } from '../lib/perms.js';
import { parseAvailMessage, findStaff, isNewStaffMsg, parseNewStaff, norm } from '../lib/avail-parse.js';

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
    for (const id of new Set(rows.map((x) => x.staff_id))) ctx.availToShifts?.(id, ws, { id: null });
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
    ctx.availToShifts?.(me.id, ws, who);
    ctx.broadcast('availability');
    return { ok: true };
  });

  // Tổng hợp cho quản lý: mỗi ngày × buổi có ai rảnh, đã xếp bao nhiêu, cần tối thiểu bao nhiêu
  function summary(ws) {
    fillFixed(ws);
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const slots = ctx.availSlots();
    const people = db.prepare(`SELECT s.id, s.name, s.role, s.work_type, s.team_id, s.position_id, t.name AS team_name, p.name AS position_name
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

  // Tin nhắc vào nhóm Zalo nhân viên: liệt kê người chưa báo lịch rảnh tuần ws (chủ quán 24/10: tối thứ 7)
  const ddmm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
  // Bộ phận được bot nhắc (Cài đặt → Zalo Bot). Chưa chọn = mặc định Phục vụ + Tiếp thực (chủ quán 25/10)
  const BOT_DEFAULT = /^(phục vụ|phuc vu|tiếp thực|tiep thuc)$/i;
  function botTeams() {
    try { const x = JSON.parse(ctx.setting('avail_bot_teams') || 'null'); if (Array.isArray(x)) return x.map(Number); } catch { /* mặc định */ }
    return db.prepare('SELECT id, name FROM teams').all().filter((t) => BOT_DEFAULT.test(t.name.trim())).map((t) => t.id);
  }
  ctx.availBotTeams = botTeams;
  // Nhiều nhóm nhân viên (chủ quán 25/10: nhóm chung + nhóm Bếp): mỗi nhóm nhắc các bộ phận của nhóm đó
  function staffGroups() {
    try { const x = JSON.parse(ctx.setting('zalo_bot_staff_groups') || 'null'); if (Array.isArray(x)) return x; } catch { /* cũ */ }
    const id = ctx.setting('zalo_bot_staff_group_id');
    return id ? [{ id, name: ctx.setting('zalo_bot_staff_group_name') || 'Nhóm nhân viên', teams: botTeams() }] : [];
  }
  const saveGroups = (list) => ctx.setSetting('zalo_bot_staff_groups', JSON.stringify(list.slice(0, 10)));
  ctx.staffGroups = staffGroups;
  ctx.saveStaffGroups = saveGroups;
  const groupOf = (chatId) => staffGroups().find((g) => g.id === chatId);
  function groupText(ws, all, teams = botTeams()) {
    const people = teams.length ? all.filter((p) => teams.includes(p.team_id)) : all;
    const missing = people.filter((p) => !p.submitted_at);
    const head = `📅 Lịch rảnh tuần ${ddmm(ws)}–${ddmm(addDays(ws, 6))}`;
    const base = (ctx.setting('public_url') || '').replace(/\/$/, '');
    const how = `\n👉 Mọi người báo lịch rảnh TUẦN SAU, từ ${ddmm(ws)} đến ${ddmm(addDays(ws, 6))}, để bot ghi nhận. Nhắn: @bot Họ tên 14-23 (cả tuần); ngày khác ghi riêng: T7 nghỉ, CN 10-23; chỉ làm vài ngày: T2, T5, CN 14-22 (ngày không ghi = nghỉ).`;
    const link = `${how}${base ? `\nHoặc vào app: ${base}/ranh?week=${ws}` : ''}`;
    if (!missing.length) return `${head}: ✅ đã báo đủ (${people.length} người). Cảm ơn mọi người!`;
    const byTeam = new Map();
    for (const p of missing) { const k = p.team_name || 'Khác'; byTeam.set(k, [...(byTeam.get(k) || []), p.name]); }
    const lines = [...byTeam].map(([t, names]) => `• ${t}: ${names.join(', ')}`);
    return `${head}\nCòn ${missing.length}/${people.length} bạn CHƯA báo:\n${lines.join('\n')}${link}`;
  }
  ctx.availGroupText = (week, groupId) => {
    const ws = readWeek(week);
    const g = groupId ? groupOf(groupId) : staffGroups()[0];
    return groupText(ws, summary(ws).people, g ? g.teams || [] : botTeams());
  };
  // Gửi tin nhắc vào mọi nhóm nhân viên đã chọn bộ phận; trả số nhóm gửi được
  // onlyMissing: nhắc tự động thì nhóm nào đã đủ người báo → không nhắn nữa
  async function sendGroup(ws, people, { onlyMissing = false } = {}) {
    if (!ctx.zaloBot?.ready()) return 0;
    let n = 0, err = null;
    for (const g of staffGroups()) {
      if (!g.teams?.length) continue; // nhóm chưa chọn bộ phận → không nhắc
      if (onlyMissing && !people.some((p) => g.teams.includes(p.team_id) && !p.submitted_at)) continue;
      try { await ctx.zaloBot.send(g.id, groupText(ws, people, g.teams)); n++; } catch (e) { err = e; }
    }
    if (!n && err) throw err;
    return n;
  }
  // Chạy mỗi phút: tối thứ 5, 6, 7 lúc 20:00 (chủ quán 25/10) bot nhắc người chưa báo lịch tuần tới, mỗi ngày 1 lần, đủ người thì thôi
  ctx.availBotTick = async () => {
    if (ctx.setting('avail_bot_on') === '0') return;
    const c = ctx.clock(), n = ctx.now();
    const date = c.dateOf(n);
    const days = String(ctx.setting('avail_bot_days') || '4,5,6').split(',').map(Number);
    if (!days.includes(isoWeekday(date)) || c.minuteOf(n) < toMin(ctx.setting('avail_bot_time') || '20:00')) return;
    const ws = addDays(weekStart(date), 7);
    const key = `avail_bot_sent:${date}`;
    if (ctx.setting(key)) return;
    ctx.setSetting(key, String(n));
    try { const k = await sendGroup(ws, summary(ws).people, { onlyMissing: true }); if (k) ctx.audit(null, 'availability.bot_remind', { week: ws, groups: k }); }
    catch (e) { ctx.setSetting(key, ''); console.error('Bot nhắc lịch rảnh lỗi:', e.message); }
  };

  // ---------- Bot đọc tin báo lịch rảnh trong nhóm nhân viên → tự điền (chủ quán 24/10) ----------
  db.exec(`CREATE TABLE IF NOT EXISTS zalo_bot_msgs (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS zalo_bot_users (uid TEXT PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE)`);
  const BOT_NOTE = 'Báo qua Zalo';
  const DOWS = ['', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
  const dayTxt = (d) => `${DOWS[isoWeekday(d)]} ${ddmm(d)}`;
  // Ghi lịch rảnh cho 1 người: chỉ những ngày có trong tin (ngày khác giữ nguyên)
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  // Lịch rảnh cũ của ngày trừ khúc nghỉ ("off 8h-12h" khi đang rảnh 8–12 + 14–23 → còn 14–23)
  const minusRanges = (slots, cuts) => {
    let parts = slots.map((x) => { const r = ctx.availRange(rangeText(x) || x); return [r.start, r.end]; }).filter((x) => x[1] > x[0]);
    for (const c of cuts) { const r = ctx.availRange(c); parts = parts.flatMap(([a, b]) => (r.end <= a || r.start >= b ? [[a, b]] : [[a, r.start], [r.end, b]].filter(([x, y]) => y - x >= 30))); }
    return parts.map(([a, b]) => `${hhmm(a)}-${hhmm(b)}`);
  };
  function applyBot(staffId, picks, off, offParts = {}, { chat = '' } = {}) {
    const today = ctx.today(), from = weekStart(today);
    // Nghỉ 1 khúc: lịch rảnh ngày đó = lịch đang có trừ khúc nghỉ
    picks = { ...picks };
    for (const [d, cuts] of Object.entries(offParts)) {
      const cur = db.prepare('SELECT slot FROM availability WHERE staff_id = ? AND date = ?').all(staffId, d).map((x) => x.slot);
      const left = minusRanges(cur, cuts);
      if (left.length) picks[d] = left; else if (!off.includes(d)) off = [...off, d];
    }
    const dates = [...new Set([...Object.keys(picks), ...off])].filter((d) => d >= today && weekStart(d) >= from).sort();
    const weeks = new Set();
    tx(db, () => {
      for (const d of dates) {
        db.prepare('DELETE FROM availability WHERE staff_id = ? AND date = ?').run(staffId, d);
        for (const x of picks[d] || []) { const t = readPick(x); if (t) db.prepare('INSERT OR IGNORE INTO availability (staff_id, date, slot) VALUES (?, ?, ?)').run(staffId, d, t); }
        weeks.add(weekStart(d));
      }
      for (const ws of weeks) {
        db.prepare(`INSERT INTO availability_weeks (staff_id, week_start, submitted_at, note) VALUES (?, ?, ?, ?)
          ON CONFLICT (staff_id, week_start) DO UPDATE SET submitted_at = excluded.submitted_at, note = CASE WHEN note = '${FIXED_NOTE}' OR note = '' THEN excluded.note ELSE note END`).run(staffId, ws, ctx.now(), BOT_NOTE);
      }
    });
    const locked = [];
    for (const ws of weeks) { if (Number(ctx.setting(`published:${ws}`) || 0)) locked.push(ws); else ctx.availToShifts?.(staffId, ws, { id: null }); }
    // Tuần đã duyệt lịch: báo "nghỉ" ngày có ca → tự tạo đơn xin nghỉ (quản lý duyệt); đổi giờ → báo quản lý xếp lại (chủ quán 25/10)
    const leaves = [], noShift = [], changed = [];
    for (const d of dates.filter((x) => locked.includes(weekStart(x)))) {
      const groups = db.prepare('SELECT DISTINCT group_id FROM assignments WHERE staff_id = ? AND date = ?').all(staffId, d).map((x) => x.group_id);
      if (offParts[d]) {
        // Nghỉ 1 khúc ngày có ca → đơn nghỉ đúng khúc đó (ca phần còn lại vẫn giữ)
        if (!groups.length) { noShift.push(d); continue; }
        for (const cut of offParts[d]) {
          const r0 = ctx.availRange(cut);
          for (const g of groups) {
            const segs = db.prepare('SELECT start_min, end_min FROM assignments WHERE group_id = ?').all(g);
            if (!segs.some((x) => x.start_min < r0.end && x.end_min > r0.start)) continue;
            try { const r = ctx.createLeave(null, g, `Báo nghỉ ${hhmm(r0.start)}–${hhmm(r0.end)} qua nhóm Zalo (bot)`, { from: r0.start, to: r0.end }, { chat }); leaves.push({ date: d, label: r.label, status: 'new', part: `${hhmm(r0.start)}–${hhmm(r0.end)}` }); }
            catch (e) { leaves.push({ date: d, label: '', status: /đã có đơn/.test(e.message) ? 'pending' : 'err', err: e.message }); }
          }
        }
        continue;
      }
      if (off.includes(d) && !picks[d]) {
        if (!groups.length) { noShift.push(d); continue; }
        for (const g of groups) {
          const had = db.prepare("SELECT status FROM leave_requests WHERE group_id = ? AND status IN ('pending','approved')").get(g);
          if (had) { leaves.push({ date: d, label: '', status: had.status }); continue; }
          try { const r = ctx.createLeave(null, g, `Báo nghỉ qua nhóm Zalo (bot) ${ddmm(d)}`, null, { chat }); leaves.push({ date: d, label: r.label, status: 'new' }); } catch { /* ca đã qua */ }
        }
      } else changed.push(d);
    }
    if (changed.length) {
      const st = db.prepare('SELECT name, team_id FROM staff WHERE id = ?').get(staffId);
      ctx.notify(ctx.leadsOf(st?.team_id), { title: `${st?.name} báo đổi giờ (lịch đã duyệt)`, body: `${changed.map((d) => `${dayTxt(d)}: ${(picks[d] || []).join(', ')}`).join(' · ')}. Ca cũ giữ nguyên, quản lý xếp lại nếu đồng ý.`, link: '/lich' });
    }
    return { dates, locked, leaves, noShift, changed };
  }
  function describe(picks, off, dates, week) {
    const all = Array.from({ length: 7 }, (_, i) => addDays(week, i));
    const txt = (d) => (picks[d] || []).map((r) => r.replace('-', '–')).join(', ');
    if (all.every((d) => dates.includes(d)) && new Set(all.map(txt)).size === 1 && txt(all[0])) return `cả tuần ${ddmm(all[0])}–${ddmm(all[6])}: ${txt(all[0])}`;
    // Gộp các ngày liền nhau cùng giờ: "T2–T6 14:00–23:00 · T7 nghỉ · CN 10:00–23:00"
    const val = (d) => (off.includes(d) && !picks[d] ? 'nghỉ' : txt(d));
    const groups = [];
    for (const d of dates) { const g = groups.at(-1); if (g && val(d) === g.v && addDays(g.to, 1) === d) g.to = d; else groups.push({ from: d, to: d, v: val(d) }); }
    return groups.map((g) => `${g.from === g.to ? dayTxt(g.from) : `${DOWS[isoWeekday(g.from)]}–${DOWS[isoWeekday(g.to)]} (${ddmm(g.from)}–${ddmm(g.to)})`} ${g.v}`).join(' · ');
  }
  // Bỏ "@tên bot" khỏi tin (vd "@Bot Cửu Long Trấn" → không hiểu nhầm "Long" là tên nhân viên)
  // Tên bot có thể là mã (account_name "bot.xxx") khác tên hiện trong nhóm ("Bot Cửu Long Trấn") → bỏ mọi tên đã biết + "Bot <tên quán>"
  function botNames() {
    const out = new Set();
    try { for (const x of JSON.parse(ctx.setting('zalo_bot_names') || '[]')) if (x) out.add(String(x)); } catch { /* cũ */ }
    if (ctx.setting('zalo_bot_name')) out.add(ctx.setting('zalo_bot_name'));
    const shop = (ctx.setting('shop_name') || '').trim();
    if (shop) { out.add(`Bot ${shop}`); out.add(shop); }
    out.add('Bot Cửu Long Trấn'); out.add('Cửu Long Trấn');
    return [...out].filter((x) => x.trim().length >= 3).sort((a, b) => b.length - a.length);
  }
  ctx.saveBotNames = (me) => { const names = [me?.display_name, me?.account_name, me?.name].filter(Boolean).map((x) => String(x).slice(0, 80)); if (names.length) { ctx.setSetting('zalo_bot_names', JSON.stringify(names)); ctx.setSetting('zalo_bot_name', names[0]); } };
  function stripBotName(text) {
    let t = String(text || '');
    for (const name of botNames()) {
      const esc = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      t = t.replace(new RegExp(`@?${esc}`, 'giu'), ' ');
    }
    return t;
  }
  // ---------- Nhân viên mới đăng ký qua bot → quản lý duyệt (chủ quán 25/10) ----------
  db.exec(`CREATE TABLE IF NOT EXISTS staff_requests (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, chat_id TEXT NOT NULL DEFAULT '', from_uid TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', team_id INTEGER, position_id INTEGER, role TEXT NOT NULL DEFAULT 'staff',
    raw TEXT NOT NULL DEFAULT '', avail_text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', staff_id INTEGER, decided_by INTEGER, decided_at INTEGER)`);
  const NEW_HINT = 'Nhắn: @bot NV mới: Họ tên, Số điện thoại, Bộ phận, Chức vụ (vd: @bot NV mới: Trần Trung Hậu, 0901234567, Phục vụ, nhân viên)';
  // Lịch báo trước khi có tên trong app: giữ lại theo người nhắn, duyệt xong tự điền
  const pendingAvail = (uid, text) => {
    if (!uid) return;
    const r = db.prepare("SELECT id FROM staff_requests WHERE from_uid = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(uid);
    if (r) db.prepare('UPDATE staff_requests SET avail_text = ? WHERE id = ?').run(text, r.id);
    else db.prepare("INSERT INTO staff_requests (at, from_uid, status, avail_text) VALUES (?, ?, 'draft', ?) ").run(ctx.now(), uid, text);
  };
  function handleNewStaff(u) {
    const teams = db.prepare('SELECT id, name FROM teams WHERE active = 1').all();
    const positions = db.prepare('SELECT id, team_id, name FROM positions WHERE active = 1').all();
    const f = parseNewStaff(u.text, { teams, positions });
    if (!f.name) return `❓ Chưa đọc được họ tên. ${NEW_HINT}`;
    if (!f.phone) return `❓ Thiếu số điện thoại (để phân biệt khi trùng tên). ${NEW_HINT}`;
    const dupPhone = db.prepare("SELECT name FROM staff WHERE active = 1 AND replace(replace(phone, ' ', ''), '.', '') = ?").get(f.phone);
    if (dupPhone) return `ℹ Số ${f.phone} đã có trong danh sách: ${dupPhone.name}. Báo lịch bình thường: @bot ${dupPhone.name} 14-23`;
    const old = db.prepare("SELECT * FROM staff_requests WHERE status IN ('pending', 'draft') AND (phone = ? OR (from_uid = ? AND from_uid != '')) ORDER BY id DESC LIMIT 1").get(f.phone, u.from.id || '');
    const vals = [ctx.now(), u.chat.id, u.from.id || '', u.from.name || '', f.name, f.phone, f.team_id, f.position_id, f.role, u.text.slice(0, 300)];
    if (old) db.prepare("UPDATE staff_requests SET at = ?, chat_id = ?, from_uid = ?, from_name = ?, name = ?, phone = ?, team_id = ?, position_id = ?, role = ?, raw = ?, status = 'pending' WHERE id = ?").run(...vals, old.id);
    else db.prepare("INSERT INTO staff_requests (at, chat_id, from_uid, from_name, name, phone, team_id, position_id, role, raw, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')").run(...vals);
    const ROLE = { staff: 'nhân viên', team_lead: 'tổ trưởng', shift_lead: 'trưởng ca' };
    ctx.notify(ctx.managers(), { title: `🆕 Nhân viên mới chờ duyệt: ${f.name}`, body: `${f.phone} · ${f.team_name || 'chưa rõ bộ phận'} · ${ROLE[f.role]}. Vào Nhân viên để thêm.`, link: '/nhan-vien', urgent: true });
    ctx.broadcast('staff');
    return `📝 Đã ghi nhân viên mới: ${f.name} · ${f.phone} · ${f.team_name || 'chưa rõ bộ phận'} · ${ROLE[f.role]}.\nChờ quản lý duyệt; duyệt xong bot báo ở đây${old?.avail_text ? ' và tự điền lịch bạn đã báo' : ''}.`;
  }
  ctx.handleNewStaffMsg = handleNewStaff;

  function handleBotMsg(u0) {
    const u = { ...u0, text: stripBotName(u0.text) };
    if (isNewStaffMsg(u.text)) return handleNewStaff(u);
    const staff = db.prepare('SELECT id, name, phone FROM staff WHERE active = 1').all();
    // Người nhắn: đã liên kết, hoặc tên Zalo trùng đúng 1 nhân viên
    let sender = u.from.id ? db.prepare('SELECT staff_id FROM zalo_bot_users WHERE uid = ?').get(u.from.id)?.staff_id : null;
    if (!sender && u.from.id && u.from.name) {
      const m = findStaff(u.from.name, staff);
      if (m.length === 1) { sender = m[0].id; db.prepare('INSERT OR REPLACE INTO zalo_bot_users (uid, staff_id) VALUES (?, ?)').run(u.from.id, sender); }
    }
    const p = parseAvailMessage(u.text, { staff, today: ctx.today(), sender });
    // Trùng tên: ghi thêm SĐT (đủ số hoặc 4 số cuối) để chọn đúng người
    const digits = (u.text.match(/\d[\d.\s]{3,13}\d/g) || []).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 4 && x.length <= 11);
    if (digits.length) {
      const byPhone = staff.filter((x) => { const ph = String(x.phone || '').replace(/\D/g, ''); return ph && digits.some((d) => ph.endsWith(d.slice(-Math.min(d.length, 10)))); });
      if (byPhone.length === 1) { p.people = byPhone; p.bySender = false; p.unknownName = ''; }
    }
    const hint = 'Nhắn kiểu: @bot Tên 14-23 (cả tuần), ngày khác ghi riêng: @bot Tên 14-23, T7 nghỉ, CN 10-23';
    if (!Object.keys(p.picks).length && !p.off.length && !Object.keys(p.offParts || {}).length) return `❓ Chưa đọc được giờ. ${hint}`;
    // Tên chưa có trong danh sách → báo là người mới, giữ lịch lại chờ duyệt
    if (!p.people.length || (p.bySender && p.unknownName)) {
      // Tên trùng người đã nghỉ việc → không ghi, báo quản lý mở lại nếu đi làm lại
      const quit = findStaff(u.text, db.prepare('SELECT id, name FROM staff WHERE active = 0').all(), { single: false });
      if (quit.length) return `⛔ ${quit.map((x) => x.name).join(', ')} đã nghỉ việc trong danh sách nên bot không ghi lịch. Đi làm lại thì báo quản lý mở lại tài khoản (Nhân viên → Hiện cả người đã nghỉ việc → bật lại).`;
      if (p.near?.length) return `❓ Danh sách không có đúng tên bạn nhắn. Có phải ${p.near.map((x) => x.name).join(' / ')}? Nhắn lại ĐÚNG họ tên trong danh sách, hoặc thêm 4 số cuối SĐT, vd: @bot ${p.near[0].name} 1234 T2-CN 14-23.\nNếu bạn là người mới: ${NEW_HINT}`;
      const same = p.unknownName ? staff.filter((x) => norm(x.name).includes(p.unknownName.split(' ').slice(-2).join(' '))) : [];
      if (same.length > 1) return `❓ Có ${same.length} bạn tên giống nhau (${same.map((x) => x.name).join(', ')}). Ghi thêm 4 số cuối SĐT, vd: @bot ${same[0].name} 1234 14-23`;
      pendingAvail(u.from.id, u.text);
      return `🆕 Bạn là người mới, chưa có trong danh sách nhân viên nên bot chưa ghi lịch.\n${NEW_HINT}\nĐăng ký xong, quản lý duyệt là lịch bạn vừa báo được điền luôn.`;
    }
    const lines = [];
    let locked = false;
    for (const person of p.people) {
      const r = applyBot(person.id, p.picks, p.off, p.offParts || {}, { chat: u.chat.id });
      if (!r.dates.length) { lines.push(`• ${person.name}: ngày đã qua, không ghi`); continue; }
      if (r.changed.length) locked = true;
      const offTxt = Object.entries(p.offParts || {}).map(([d, x]) => `${dayTxt(d)} nghỉ ${x.map((y) => y.replace('-', '–')).join(', ')}`).join(' · ');
      const main = describe(Object.fromEntries(Object.entries(p.picks).filter(([d]) => !(p.offParts || {})[d])), p.off, r.dates.filter((d) => !(p.offParts || {})[d]), p.week);
      lines.push(`• ${person.name}: ${[main, offTxt].filter(Boolean).join(' · ')}`);
      for (const l of r.leaves) lines.push(l.status === 'new' ? `  📝 Đã gửi đơn xin nghỉ ${l.label}${l.part ? ' (phần còn lại của ca vẫn làm)' : ''} cho quản lý. Chưa duyệt thì vẫn đi làm; duyệt xong app báo bạn.` : l.status === 'err' ? `  ${dayTxt(l.date)}: ${l.err}` : `  ${dayTxt(l.date)}: đã có đơn nghỉ (${l.status === 'approved' ? 'đã duyệt' : 'chờ duyệt'})`);
      if (r.noShift.length) lines.push(`  ${r.noShift.map(dayTxt).join(', ')}: bạn không có ca, ghi nghỉ là xong`);
      // Ghi cho TUẦN SAU trong khi tuần này đã có lịch → nói rõ để bạn khỏi tưởng đã đổi lịch tuần này (chủ quán 26/10)
      const today = ctx.today(), ws = weekStart(today);
      if (r.dates.every((d) => weekStart(d) > ws)) {
        const cur = db.prepare(`SELECT date, start_min, end_min FROM assignments a WHERE staff_id = ? AND date BETWEEN ? AND ?
          AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved') ORDER BY date, start_min`).all(person.id, today, addDays(ws, 6));
        if (cur.length) {
          const by = new Map();
          for (const c of cur) by.set(c.date, [...(by.get(c.date) || []), `${String(Math.floor(c.start_min / 60)).padStart(2, '0')}${c.start_min % 60 ? ':' + String(c.start_min % 60).padStart(2, '0') : ''}–${String(Math.floor(c.end_min / 60) % 24).padStart(2, '0')}${c.end_min % 60 ? ':' + String(c.end_min % 60).padStart(2, '0') : ''}`]);
          lines.push(`  ℹ️ Bot ghi cho TUẦN SAU (${ddmm(addDays(ws, 7))}–${ddmm(addDays(ws, 13))}). Tuần này bạn đã có lịch${Number(ctx.setting(`published:${ws}`) || 0) ? ' đã duyệt' : ''}: ${[...by].map(([d, x]) => `${dayTxt(d)} ${x.join(' + ')}`).join(', ')}. Muốn đổi tuần này: ghi ngày cụ thể, vd "${ddmm(addDays(today, 1))} nghỉ" hoặc "${ddmm(addDays(today, 1))} 18-23".`);
        }
      }
    }
    ctx.audit(null, 'availability.zalo', { from: u.from.name, staff: p.people.map((x) => x.id), text: u.text.slice(0, 200) });
    ctx.broadcast('availability');
    return `✅ Đã ghi lịch rảnh:\n${lines.join('\n')}${locked ? '\n(Tuần đã duyệt lịch: giờ mới đã báo quản lý, ca cũ giữ nguyên tới khi quản lý xếp lại)' : ''}`;
  }
  ctx.handleBotAvailMsg = handleBotMsg;
  // Nhật ký bot: lần đọc gần nhất + 15 tin gần nhất và bot đã làm gì (Cài đặt → Zalo Bot)
  const botLog = { poll: null, msgs: [] };
  const logMsg = (u, result) => { botLog.msgs.unshift({ at: ctx.now(), chat: u.chat.name || u.chat.id, from: u.from.name, text: u.text.slice(0, 120), result }); botLog.msgs.length = Math.min(botLog.msgs.length, 15); };
  ctx.zaloBotLog = () => ({ ...botLog, raw: ctx.zaloBot?.state?.lastRaw || '', staff_group: staffGroups().map((g) => g.name).join(', ') });
  let polling = false;
  ctx.zaloBotPoll = async () => {
    if (polling || !ctx.zaloBot?.ready() || !ctx.zaloBot.updates) return;
    polling = true;
    try {
      const list = await ctx.zaloBot.updates();
      if (list.length) ctx.zaloBot.remember?.(list); // nút "Tìm nhóm" lấy từ đây, không gọi Zalo song song với vòng đọc tin
      botLog.poll = { at: ctx.now(), n: list.length, error: '' };
      if (!list.length) return;
      ctx.zaloBot.remember?.(list);
      // Lấy tên bot 1 lần (để bỏ "@tên bot" khỏi tin)
      if (!ctx.setting('zalo_bot_names')) {
        try { ctx.saveBotNames(await ctx.zaloBot.call('getMe')); } catch { /* bỏ qua */ }
      }
      // Tin báo giờ từ 1 nhóm chưa có trong danh sách (không phải nhóm đặt hàng) → tự thêm nhóm, báo chủ chọn bộ phận
      for (const u of list) {
        if (groupOf(u.chat.id) || !/group/i.test(u.chat.type || 'group') || u.chat.id === ctx.setting('zalo_bot_group_id')) continue;
        if (!/\d{1,2}\s*(?:h|g|:\d\d)?\s*[-–]\s*\d{1,2}/.test(u.text)) continue;
        const first = !staffGroups().length;
        saveGroups([...staffGroups(), { id: u.chat.id, name: u.chat.name || 'Nhóm nhân viên', teams: first ? botTeams() : [] }]);
        const owners = db.prepare("SELECT id FROM staff WHERE role = 'owner' AND active = 1").all().map((x) => x.id);
        ctx.notify(owners, { title: `Bot đã thêm nhóm "${u.chat.name || u.chat.id}"`, body: first ? 'Nhóm này giờ là nhóm báo lịch rảnh.' : 'Bot đã ghi lịch từ nhóm này. Vào Cài đặt → Zalo Bot chọn bộ phận để bot nhắc người chưa báo trong nhóm.', link: '/cai-dat?tab=bot' });
      }
      for (const u of list) {
        if (u.from.bot || !u.text.trim()) continue;
        const key = `${u.chat.id}:${u.id || `${u.from.id}:${u.date}:${u.text}`}`;
        const fresh = db.prepare('INSERT OR IGNORE INTO zalo_bot_msgs (key, at) VALUES (?, ?)').run(key, ctx.now()).changes > 0;
        if (!fresh) continue;
        if (!groupOf(u.chat.id)) { logMsg(u, staffGroups().length ? 'Bỏ qua: không phải nhóm nhân viên' : 'Bỏ qua: chưa chọn nhóm nhân viên'); continue; }
        if (u.date && ctx.now() - u.date > 2 * 86_400_000) { logMsg(u, 'Bỏ qua: tin cũ hơn 2 ngày'); continue; }
        let reply;
        try { reply = handleBotMsg(u); } catch (e) { reply = `⚠ Lỗi khi ghi: ${e.message}`; }
        logMsg(u, reply.split('\n').join(' '));
        if (reply) await ctx.zaloBot.send(u.chat.id, reply).catch((e) => console.error('Bot trả lời lỗi:', e.message));
      }
      db.prepare('DELETE FROM zalo_bot_msgs WHERE at < ?').run(ctx.now() - 7 * 86_400_000);
    } catch (e) {
      botLog.poll = { at: ctx.now(), n: 0, error: e.message };
      if (!/Chưa dán token/.test(e.message)) console.error('Bot đọc tin lỗi:', e.message);
    } finally { polling = false; }
  };

  // Danh sách chờ duyệt + duyệt / từ chối (quản lý). Duyệt: tạo tài khoản ở /api/staff rồi gọi /done để liên kết Zalo + điền lịch + báo nhóm
  r.get('/api/staff-requests', 'manager', () => {
    // Yêu cầu cũ bị lấy nhầm tên bot làm tên người ("Cửu Long Trấn") → đọc lại
    const names = botNames().map((x) => norm(x));
    for (const q of db.prepare("SELECT * FROM staff_requests WHERE status = 'pending'").all()) {
      if (!names.includes(norm(q.name))) continue;
      const f = parseNewStaff(stripBotName(q.raw), { teams: db.prepare('SELECT id, name FROM teams').all(), positions: [] });
      if (f.name && !names.includes(norm(f.name))) db.prepare('UPDATE staff_requests SET name = ? WHERE id = ?').run(f.name, q.id);
    }
    return db.prepare(`SELECT q.*, t.name AS team_name FROM staff_requests q LEFT JOIN teams t ON t.id = q.team_id
      WHERE q.status = 'pending' ORDER BY q.at DESC`).all();
  });
  r.post('/api/staff-requests/:id/done', 'manager', async ({ me, params, body }) => {
    const q = db.prepare('SELECT * FROM staff_requests WHERE id = ?').get(params.id);
    if (!q || q.status !== 'pending') fail(404, 'Không tìm thấy yêu cầu');
    const st = db.prepare('SELECT id, name FROM staff WHERE id = ? AND active = 1').get(v.int(body.staff_id, { min: 1, name: 'Nhân viên' }));
    if (!st) fail(404, 'Không tìm thấy nhân viên vừa tạo');
    db.prepare("UPDATE staff_requests SET status = 'approved', staff_id = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(st.id, me.id, ctx.now(), q.id);
    // Liên kết Zalo người nhắn ↔ nhân viên mới chỉ khi chính bạn ấy nhắn (tên Zalo khớp), tránh trưởng ca đăng ký hộ bị gắn nhầm
    if (q.from_uid && findStaff(q.from_name, [st]).length && !db.prepare('SELECT 1 FROM zalo_bot_users WHERE uid = ?').get(q.from_uid)) db.prepare('INSERT INTO zalo_bot_users (uid, staff_id) VALUES (?, ?)').run(q.from_uid, st.id);
    let extra = '';
    if (q.avail_text) {
      const p = parseAvailMessage(q.avail_text, { staff: [st], today: ctx.today(), sender: st.id });
      if (Object.keys(p.picks).length || p.off.length) { const r = applyBot(st.id, p.picks, p.off); if (r.dates.length) extra = `\nĐã điền lịch bạn báo trước: ${describe(p.picks, p.off, r.dates, p.week)}`; }
      ctx.broadcast('availability');
    }
    if (q.chat_id && ctx.zaloBot?.ready()) await ctx.zaloBot.send(q.chat_id, `✅ Đã thêm ${st.name} vào danh sách nhân viên.${extra}\nTừ giờ báo lịch: @bot ${st.name} 14-23`).catch(() => {});
    ctx.audit(me, 'staff_request.approve', { id: q.id, staff: st.id });
    ctx.broadcast('staff');
    return { ok: true };
  });
  r.post('/api/staff-requests/:id/reject', 'manager', async ({ me, params }) => {
    const q = db.prepare('SELECT * FROM staff_requests WHERE id = ?').get(params.id);
    if (!q || q.status !== 'pending') fail(404, 'Không tìm thấy yêu cầu');
    db.prepare("UPDATE staff_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?").run(me.id, ctx.now(), q.id);
    ctx.audit(me, 'staff_request.reject', q.id);
    ctx.broadcast('staff');
    return { ok: true };
  });

  r.post('/api/availability/remind', 'manager', async ({ me, body }) => {
    const ws = readWeek(body.week);
    const s = summary(ws);
    const ids = s.people.filter((p) => !p.submitted_at).map((p) => p.id);
    const dl = s.deadline;
    let group = 0, group_error = '';
    try { group = await sendGroup(ws, s.people); } catch (e) { group_error = e.message; }
    if (ids.length) {
      ctx.notify(ids, {
        title: 'Báo lịch rảnh tuần sau',
        body: `Bạn chưa báo lịch rảnh tuần ${ws.slice(8)}/${ws.slice(5, 7)}. Hạn ${dl.time} ngày ${dl.date.slice(8)}/${dl.date.slice(5, 7)}.`,
        link: `/ranh?week=${ws}`,
      });
    }
    ctx.audit(me, 'availability.remind', { week: ws, n: ids.length, group });
    return { sent: ids.length, group, group_error };
  });
}
