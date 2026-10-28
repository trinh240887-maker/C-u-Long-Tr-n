// Việc ca (chủ quán 25/10): checklist bật "Giao việc từng người" → mỗi việc thành 1 thẻ việc.
// - App gợi ý ai làm: chia đều theo thời gian chuẩn cho người có ca trong khu, xoay vòng theo ngày,
//   mở ca ưu tiên người vào sớm (tiếp thực), đóng ca ưu tiên người về muộn nhất. Tổ trưởng đổi người được.
// - Nhân viên bấm Nhận (ghi giờ nhận, bắt đầu đếm ngược) → Xong + ảnh (ghi giờ xong, số phút).
// - Quá thời gian chuẩn → báo người kiểm tra khu: tổ trưởng có ca trong khu; tổ trưởng nghỉ → trưởng ca → quản lý.
// - Người kiểm tra bấm Đạt / Làm lại, chụp 1 ảnh tổng khu. Trễ / làm lại chỉ ghi lỗi (chủ quán tự quyết thưởng phạt).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { isDate, addDays } from '../lib/time.js';

const DEFAULT_MIN = 10; // việc chưa đặt thời gian chuẩn tính 10 phút khi chia việc
const BORROW = 30; // phút: khu khác phải rảnh hơn ít nhất ngần này mới được mượn sang (lớn hơn điểm xoay vòng 25 để không mượn chỉ vì đổi việc)

export default function (r, ctx) {
  const { db } = ctx;
  // owner_id: việc "mỗi người tự làm" (vd giặt 2 khăn của mình) → 1 thẻ / người; 0 = việc chia (khu / cả quán)
  // Bảng cũ (chưa có owner_id) → dựng lại để đổi khoá UNIQUE, giữ dữ liệu
  const JOB_COLS = 'id, date, template_id, item_id, zone_id, staff_id, assigned_by, assigned_at, claimed_at, due_at, done_at, minutes_used, status, late, redo_count, nudged, alerted, photo, checked_by, checked_at, check_note';
  const oldJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get() && !db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'owner_id');
  if (oldJobs) db.exec('DROP INDEX IF EXISTS jobs_by_date; ALTER TABLE jobs RENAME TO jobs_old');
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
    zone_id INTEGER NOT NULL DEFAULT 0,          -- 0 = việc cả quán
    staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
    assigned_by INTEGER, assigned_at INTEGER,
    claimed_at INTEGER, due_at INTEGER, done_at INTEGER, minutes_used INTEGER,
    status TEXT NOT NULL DEFAULT 'todo',         -- todo | doing | done | ok | redo
    late INTEGER NOT NULL DEFAULT 0, redo_count INTEGER NOT NULL DEFAULT 0,
    nudged INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0,
    photo TEXT, checked_by INTEGER, checked_at INTEGER, check_note TEXT NOT NULL DEFAULT '',
    owner_id INTEGER NOT NULL DEFAULT 0,
    count INTEGER, short INTEGER NOT NULL DEFAULT 0,   -- số đếm được khi xong (vd khăn đã giặt) · thiếu so với số phải đủ
    UNIQUE (date, item_id, zone_id, owner_id)
  );
  CREATE INDEX IF NOT EXISTS jobs_by_date ON jobs(date);
  CREATE TABLE IF NOT EXISTS job_zone_photos (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, template_id INTEGER NOT NULL, zone_id INTEGER NOT NULL DEFAULT 0,
    staff_id INTEGER, file TEXT NOT NULL, at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_checkers (date TEXT NOT NULL, zone_id INTEGER NOT NULL, staff_id INTEGER NOT NULL, PRIMARY KEY (date, zone_id));`);

  // Đóng ca giao cả khu cho người phụ trách (chủ quán 27/10): người phụ trách cố định từng khu
  db.exec('CREATE TABLE IF NOT EXISTS job_zone_leads (template_id INTEGER NOT NULL, zone_id INTEGER NOT NULL, staff_id INTEGER NOT NULL, PRIMARY KEY (template_id, zone_id))');
  if (!db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'done_note')) db.exec("ALTER TABLE jobs ADD COLUMN done_note TEXT NOT NULL DEFAULT ''"); // ghi chú của người làm khi xong
  if (!db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'deadline_alerted')) db.exec('ALTER TABLE jobs ADD COLUMN deadline_alerted INTEGER NOT NULL DEFAULT 0');
  // Trưởng ca / tổ trưởng điều phối (chủ quán 28/10): ai thấy việc trống của khu nào
  const LEADS = ['team_lead', 'shift_lead', 'manager', 'owner'];
  const zonesOfToday = (staffId, date) => new Set(db.prepare('SELECT zone_id FROM assignments WHERE staff_id = ? AND date = ? AND zone_id IS NOT NULL').all(staffId, date).map((x) => x.zone_id));
  // t: checklist của việc → chỉ trưởng ca / tổ trưởng thuộc bộ phận của checklist (vd Phục vụ) đang có ca (chủ quán 28/10)
  const poolLead = (me, date, zoneId, t) => {
    if (!LEADS.includes(me.role)) return false;
    if (rank(me.role) >= rank('manager')) return true;
    if (!db.prepare('SELECT 1 FROM assignments WHERE staff_id = ? AND date = ?').get(me.id, date)) return false; // phải có ca hôm đó
    if (t && !people(date, t).some((p) => p.id === me.id)) return false;
    const zs = zonesOfToday(me.id, date);
    return !zoneId || !zs.size || zs.has(zoneId); // việc chung: mọi trưởng ca + tổ trưởng; việc khu: người của khu (không phân khu = thấy hết)
  };
  // Ảnh chụp dở khi đang làm (chủ quán 28/10): chụp tới đâu lưu lên máy chủ tới đó, thoát app vào lại vẫn còn
  db.exec('CREATE TABLE IF NOT EXISTS job_shots (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, file TEXT NOT NULL, at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS job_photos (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, file TEXT NOT NULL, at INTEGER NOT NULL)'); // ảnh thêm khi xong (nhiều góc)
  if (oldJobs) db.exec(`INSERT INTO jobs (${JOB_COLS}) SELECT ${JOB_COLS} FROM jobs_old; DROP TABLE jobs_old`);
  const K = (itemId, zoneId, ownerId) => `${itemId}:${zoneId}:${ownerId || 0}`;

  const photoDir = path.join(ctx.photoDir || path.join(os.tmpdir(), 'quanly-photos'), 'viec');
  const name = (id) => (id ? db.prepare('SELECT name FROM staff WHERE id = ?').get(id)?.name || '' : '');
  const isLead = (me) => rank(me.role) >= rank('shift_lead');
  const zonesAll = () => db.prepare('SELECT id, name, color FROM zones WHERE active = 1 ORDER BY sort, id').all();
  const tables = (zoneId) => db.prepare('SELECT COUNT(*) AS n FROM dining_tables WHERE zone_id = ?').get(zoneId).n;

  // Checklist giao việc đang dùng
  const jobTemplates = () => ctx.checklistTemplates().filter((t) => t.job_mode && t.items.length);
  const teamsOf = (t) => (t.job_teams?.length ? t.job_teams : t.team_id ? [t.team_id] : null); // null = mọi bộ phận

  const pvTeamIds = () => new Set(db.prepare('SELECT id, name FROM teams').all().filter((x) => /phục vụ|phuc vu/i.test(x.name)).map((x) => x.id));
  // Người đi làm hôm đó thuộc các bộ phận của checklist (gộp các khúc ca của 1 người)
  function people(date, t) {
    const teams = teamsOf(t);
    const rows = db.prepare(`SELECT a.staff_id, a.team_id, a.zone_id, a.start_min, a.end_min, s.name, s.role, s.gender, s.team_id AS home_team, (SELECT name FROM teams WHERE id = s.team_id) AS team_name FROM assignments a JOIN staff s ON s.id = a.staff_id
      WHERE a.date = ? AND s.active = 1 AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved') ORDER BY a.start_min`).all(date);
    const by = new Map();
    for (const a of rows) {
      // Người chưa có bộ phận mà có khu / là trưởng ca (vd Đỗ Thiện) vẫn tính vào checklist Phục vụ (chủ quán 27/10)
      const noTeamPv = !a.home_team && (a.zone_id || a.role === 'shift_lead') && teams && teams.some((x) => pvTeamIds().has(x));
      if (teams && !teams.includes(a.team_id) && !teams.includes(a.home_team) && !(teams.includes(-1) && a.role === 'shift_lead') && !noTeamPv) continue; // -1 = trưởng ca cũng làm
      const p = by.get(a.staff_id) || { id: a.staff_id, name: a.name, role: a.role, gender: a.gender || '', team_name: a.team_name || '', zone_id: 0, start: a.start_min, end: a.end_min };
      p.start = Math.min(p.start, a.start_min); p.end = Math.max(p.end, a.end_min);
      if (!p.zone_id && a.zone_id) p.zone_id = a.zone_id;
      by.set(a.staff_id, p);
    }
    return [...by.values()];
  }

  // Có mặt trong khung giờ làm của checklist ít nhất 30 phút (vd mở ca 14:00–15:30)
  const inWindow = (p, t) => t.job_from == null || Math.min(p.end, t.job_to) - Math.max(p.start, t.job_from) >= Math.min(30, t.job_to - t.job_from);
  const winText = (t) => (t.job_from == null ? '' : `${hhmm(t.job_from)}–${hhmm(t.job_to)}`);
  const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  // Các thẻ việc cần có của 1 checklist trong ngày: việc "mỗi khu" × từng khu, việc "cả quán" 1 thẻ
  function slots(t, date) {
    const zs = t.zone_id ? zonesAll().filter((z) => z.id === t.zone_id) : zonesAll();
    const out = [];
    const everyone = t.items.some((i) => i.job_scope === 'each') && date ? people(date, t) : [];
    const crewOn = (it) => { const ids = JSON.parse(it.job_crew || '[]'); if (!ids.length || !date) return []; const ps = people(date, t).filter((p) => inWindow(p, t)); return ids.filter((x) => ps.some((p) => p.id === x)); };
    for (const it of t.items) {
      // Nhiều bạn cùng làm (việc chung): mỗi bạn có ca trong khung giờ 1 thẻ; không ai có ca → 1 thẻ chung để app chia người khác
      const crew = crewOn(it);
      if (crew.length) { for (const x of crew) out.push({ item: it, zone_id: 0, owner_id: x }); continue; }
      // Mỗi người tự làm: mọi người có ca hôm đó thuộc các bộ phận của checklist (không theo khung giờ: ai về giờ nào làm giờ đó)
      if (it.job_scope === 'each') { for (const p of everyone) out.push({ item: it, zone_id: p.zone_id || 0, owner_id: p.id }); continue; }
      if (it.job_zone_id) { if (zs.some((z) => z.id === it.job_zone_id)) out.push({ item: it, zone_id: it.job_zone_id }); continue; } // việc riêng 1 khu
      if (it.job_scope === 'shop' || !zs.length) out.push({ item: it, zone_id: 0 });
      else for (const z of zs) out.push({ item: it, zone_id: z.id });
    }
    return out;
  }
  const qtyText = (it, zoneId) => {
    if (it.job_per_table > 0 && zoneId) { const n = Math.round(tables(zoneId) * it.job_per_table); return `${n}${it.unit ? ` ${it.unit}` : ''}`; }
    return it.job_qty || '';
  };

  // Gợi ý ai làm việc nào. fixed = việc đã nhận / đã xong (giữ nguyên, tính vào tải của người đó)
  function suggest(date, t, fixed = []) {
    // Trưởng ca / tổ trưởng điều phối (chủ quán 28/10): không giao ai, để trống cho người phụ trách tự điều
    if (t.job_lead_pool) { const fk = new Set(fixed.map((f) => K(f.item_id, f.zone_id, f.owner_id))); return slots(t, date).filter((s) => !fk.has(K(s.item.id, s.zone_id, s.owner_id))).map((s) => ({ ...s, staff_id: s.owner_id || null })); }
    let ps = people(date, t);
    if (t.job_from != null) ps = ps.filter((p) => inWindow(p, t));
    const all = slots(t, date);
    if (!ps.length) return all.map((s) => ({ ...s, staff_id: s.owner_id || null }));
    if (t.job_from != null) { /* đã lọc theo khung giờ của checklist */ } else if (t.phase === 'close') { const last = Math.max(...ps.map((p) => p.end)); ps = ps.filter((p) => p.end >= last - 90); }
    else { const first = Math.min(...ps.map((p) => p.start)); const early = ps.filter((p) => p.start <= first + 120); if (early.length) ps = early; }
    const first = Math.min(...ps.map((p) => p.start)), last = Math.max(...ps.map((p) => p.end));
    const load = new Map(ps.map((p) => [p.id, 0]));
    for (const f of fixed) if (load.has(f.staff_id)) load.set(f.staff_id, load.get(f.staff_id) + (f.minutes || DEFAULT_MIN));
    const yesterday = new Map(db.prepare('SELECT item_id, zone_id, staff_id FROM jobs WHERE date = ? AND template_id = ?').all(addDays(date, -1), t.id).map((x) => [`${x.item_id}:${x.zone_id}`, x.staff_id]));
    const fixedKeys = new Set(fixed.map((f) => K(f.item_id, f.zone_id, f.owner_id)));
    const todo = all.filter((s) => !fixedKeys.has(K(s.item.id, s.zone_id, s.owner_id)))
      .sort((a, b) => (b.owner_id ? 1 : 0) - (a.owner_id ? 1 : 0) || (b.item.job_minutes || DEFAULT_MIN) - (a.item.job_minutes || DEFAULT_MIN) || (a.zone_id - b.zone_id));
    // Việc đi kèm (vd giặt khăn lau chén) làm sau, giao đúng người làm việc chính cùng khu
    const withParent = (s) => s.item.job_with && t.items.some((i) => i.id === s.item.job_with);
    const chosen = new Map(fixed.map((f) => [`${f.item_id}:${f.zone_id}`, f.staff_id]));
    todo.sort((a, b) => (withParent(a) ? 1 : 0) - (withParent(b) ? 1 : 0));
    return todo.map((s) => {
      const r = pickOne(s);
      chosen.set(`${s.item.id}:${s.zone_id}`, r.staff_id);
      return r;
    });
    function pickOne(s) {
      if (withParent(s) && !s.owner_id) {
        const sid = chosen.get(`${s.item.job_with}:${s.zone_id}`) ?? null;
        if (sid && load.has(sid)) load.set(sid, load.get(sid) + (s.item.job_minutes || DEFAULT_MIN));
        if (sid) return { ...s, staff_id: sid };
      }
      if (s.owner_id) { if (load.has(s.owner_id)) load.set(s.owner_id, load.get(s.owner_id) + (s.item.job_minutes || DEFAULT_MIN)); return { ...s, staff_id: s.owner_id }; }
      // Giao cả khu cho người phụ trách: việc của khu → người phụ trách khu; việc chung → ưu tiên Tiếp thực
      if (t.job_lead_mode) {
        if (s.zone_id) { const lid = zoneLeadOf(t, s.zone_id, ps); if (lid) { if (load.has(lid)) load.set(lid, load.get(lid) + (s.item.job_minutes || DEFAULT_MIN)); return { ...s, staff_id: lid }; } }
        else if (!s.item.job_fixed_staff) {
          const tt = fitPool(ps.filter((p) => /tiếp thực|tiep thuc/i.test(p.team_name || '')), s.item);
          if (tt.length) { const best = tt.reduce((a, b) => (load.get(b.id) < load.get(a.id) ? b : a)); load.set(best.id, load.get(best.id) + (s.item.job_minutes || DEFAULT_MIN)); return { ...s, staff_id: best.id }; }
        }
      }
      // Việc chỉ nữ / chỉ nam: đúng giới tính trước; chưa ghi giới tính thì dùng khi không còn ai đúng; khác giới tính thì không giao
      const fit = fitPool(ps, s.item);
      // Người cố định (chủ quán chọn): có ca trong khung giờ thì giao luôn
      const fx = s.item.job_fixed_staff && fit.find((p) => p.id === s.item.job_fixed_staff);
      if (fx) { load.set(fx.id, load.get(fx.id) + (s.item.job_minutes || DEFAULT_MIN)); return { ...s, staff_id: fx.id }; }
      // Việc của khu: người trong khu trước → người chưa phân khu (vd tiếp thực) → người khu khác (chỉ khi khu này thiếu người rõ rệt)
      const pool = fit;
      const near = ps.filter((p) => !s.zone_id || !p.zone_id || p.zone_id === s.zone_id).length; // người cùng khu + hỗ trợ
      if (!pool.length) return { ...s, staff_id: null };
      const cost = (p) => load.get(p.id)
        + (s.zone_id && !p.zone_id ? 8 : 0)
        + (s.zone_id && p.zone_id && p.zone_id !== s.zone_id ? BORROW : 0)              // mượn người khu khác: chỉ khi chênh > ~30 phút việc
        + (p.role === 'shift_lead' ? 10 : 0)                                         // trưởng ca còn đi kiểm → bớt việc                                           // người hỗ trợ: sau người của khu
        + (yesterday.get(`${s.item.id}:${s.zone_id}`) === p.id && near > 1 ? 25 : 0) // hôm qua làm việc này → đổi người (khi khu có người khác để đổi)
        + (t.phase === 'close' ? (last - p.end) / 60 * 15 : (p.start - first) / 60 * 15); // mở ca: vào sớm làm trước
      const best = pool.reduce((a, b) => (cost(b) < cost(a) ? b : a));
      load.set(best.id, load.get(best.id) + (s.item.job_minutes || DEFAULT_MIN));
      return { ...s, staff_id: best.id };
    }
  }

  // Người phụ trách khu (đóng ca): chủ quán chọn cố định → tổ trưởng / trưởng ca có ca trong khu → trưởng ca của quán
  function zoneLeadOf(t, zoneId, ps) {
    const fx = db.prepare('SELECT staff_id FROM job_zone_leads WHERE template_id = ? AND zone_id = ?').get(t.id, zoneId)?.staff_id;
    if (fx && ps.some((p) => p.id === fx)) return fx;
    const inZone = ps.filter((p) => p.zone_id === zoneId && ['team_lead', 'shift_lead'].includes(p.role));
    if (inZone.length) return (inZone.find((p) => p.role === 'team_lead') || inZone[0]).id;
    return ps.find((p) => p.role === 'shift_lead')?.id || null;
  }
  ctx.jobsZoneLead = (date, t, zoneId) => { let ps = people(date, t); if (t.phase === 'close' && t.job_from == null && ps.length) { const last = Math.max(...ps.map((p) => p.end)); ps = ps.filter((p) => p.end >= last - 90); } return zoneLeadOf(t, zoneId, ps); };
  // 1 lần (chủ quán 28/10): checklist Phục vụ & Tiếp thực → trưởng ca + tổ trưởng điều phối; bỏ hết gán cố định
  if (!ctx.setting('lead_pool_v1') && db.prepare('SELECT 1 FROM jobs LIMIT 1').get()) {
    const pvtt = new Set(db.prepare('SELECT id, name FROM teams').all().filter((x) => /phục vụ|phuc vu|tiếp thực|tiep thuc/i.test(x.name)).map((x) => x.id));
    tx(db, () => {
      for (const t of jobTemplates()) {
        const ts = teamsOf(t) || [];
        if (!ts.some((x) => pvtt.has(x))) continue;
        db.prepare('UPDATE checklist_templates SET job_lead_pool = 1, job_lead_mode = 0 WHERE id = ?').run(t.id);
        db.prepare("UPDATE checklist_items SET job_fixed_staff = NULL, job_crew = '[]' WHERE template_id = ?").run(t.id);
        db.prepare('DELETE FROM job_zone_leads WHERE template_id = ?').run(t.id);
        db.prepare("DELETE FROM jobs WHERE date >= ? AND template_id = ? AND status = 'todo'").run(ctx.today(), t.id);
      }
    });
    ctx.setSetting('lead_pool_v1', '1');
  }
  ctx.jobsResetTemplate = (date, tid) => { db.prepare("DELETE FROM jobs WHERE date >= ? AND template_id = ? AND status = 'todo'").run(date, tid); ensureDay(date); };
  // Việc chỉ tổ trưởng / trưởng ca (chủ quán 27/10): quản lý cũng làm được
  const LEAD = ['team_lead', 'shift_lead', 'manager'];
  const fitPool = (ps, it) => genderPool(it.job_role === 'lead' ? ps.filter((p) => LEAD.includes(p.role)) : ps, it.job_gender);
  function genderPool(ps, g) {
    if (!g) return ps;
    const ok = ps.filter((p) => p.gender === g);
    return ok.length ? ok : ps.filter((p) => !p.gender);
  }

  // Tạo thẻ việc trong ngày (chỉ lần đầu); chia lại thì chỉ đổi việc chưa ai bắt đầu
  // Tạo / cập nhật thẻ việc của 1 ngày.
  // fill  = hôm nay: chỉ bổ sung thẻ còn thiếu (checklist thêm việc), không đổi người đã giao
  // auto  = ngày tới trong tuần: chia lại theo lịch mới nhất, giữ việc tổ trưởng đã chọn tay
  // force = bấm "Chia lại": chia lại mọi việc chưa ai bắt đầu
  function materialize(date, t, { mode = 'fill' } = {}) {
    const rows = db.prepare('SELECT * FROM jobs WHERE date = ? AND template_id = ?').all(date, t.id);
    if (rows.length && mode === 'fill') {
      const have = new Set(rows.map((x) => K(x.item_id, x.zone_id, x.owner_id)));
      if (slots(t, date).every((s) => have.has(K(s.item.id, s.zone_id, s.owner_id)))) return;
    }
    const keep = (x) => x.status !== 'todo' || mode === 'fill' || (mode === 'auto' && x.assigned_by != null);
    const fixed = rows.filter(keep).map((x) => ({ item_id: x.item_id, zone_id: x.zone_id, owner_id: x.owner_id, staff_id: x.staff_id, minutes: t.items.find((i) => i.id === x.item_id)?.job_minutes }));
    const plan = suggest(date, t, fixed);
    const at = ctx.now();
    tx(db, () => {
      // Ngày tới: người đã bỏ khỏi lịch → bỏ thẻ "mỗi người tự làm" của họ (chưa bắt đầu)
      if (mode !== 'fill') {
        const want = new Set(slots(t, date).filter((x) => x.owner_id).map((x) => K(x.item.id, x.zone_id, x.owner_id)));
        for (const x of rows) if (x.owner_id && x.status === 'todo' && !want.has(K(x.item_id, x.zone_id, x.owner_id))) db.prepare('DELETE FROM jobs WHERE id = ?').run(x.id);
      }
      for (const p of plan) {
        db.prepare(`INSERT INTO jobs (date, template_id, item_id, zone_id, owner_id, staff_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT (date, item_id, zone_id, owner_id) DO UPDATE SET staff_id = excluded.staff_id, assigned_by = NULL, assigned_at = excluded.assigned_at, nudged = 0
          WHERE jobs.status = 'todo' AND (? = 'force' OR jobs.assigned_by IS NULL)`)
          .run(date, t.id, p.item.id, p.zone_id, p.owner_id || 0, p.staff_id, at, mode);
      }
    });
  }
  // Việc chung có người cố định: ngày nào người đó có ca thì giao cho họ (việc chưa bắt đầu)
  const applyFixed = (date) => {
    for (const t of jobTemplates().filter((x) => !x.job_lead_pool)) {
      const its = t.items.filter((it) => it.job_fixed_staff && (it.job_zone_id || it.job_scope === 'shop'));
      if (!its.length) continue;
      const on = new Set(people(date, t).filter((p) => inWindow(p, t)).map((p) => p.id));
      for (const it of its) {
        if (!on.has(it.job_fixed_staff)) continue; // nghỉ / không có ca khung này → để app chia người khác
        db.prepare("UPDATE jobs SET staff_id = ?, assigned_by = NULL, nudged = 0 WHERE date = ? AND item_id = ? AND status = 'todo' AND owner_id = 0 AND assigned_by IS NULL AND (staff_id IS NULL OR staff_id != ?)").run(it.job_fixed_staff, date, it.id, it.job_fixed_staff);
      }
    }
  };
  ctx.jobsResetItem = (date, itemId) => { db.prepare("DELETE FROM jobs WHERE date >= ? AND item_id = ? AND status = 'todo'").run(date, itemId); ensureDay(date); };
  ctx.jobsApplyFixed = (date) => { db.prepare("DELETE FROM jobs WHERE date >= ? AND status = 'todo' AND zone_id != 0 AND item_id IN (SELECT id FROM checklist_items WHERE job_scope = 'shop')").run(date); ensureDay(date); };
  // Hôm nay: giữ ổn định; các ngày tới (tối đa 14 ngày): luôn theo lịch ca / phân khu mới nhất
  ctx.jobsEnsureDay = (date) => ensureDay(date); // màn Checklist dùng để hiện ai làm việc nào theo khu
  const ensureDay = (date) => {
    const today = ctx.today();
    if (date < today || date > addDays(today, 14)) return;
    for (const t of jobTemplates()) materialize(date, t, { mode: date === today ? 'fill' : 'auto' });
    applyFixed(date);
  };

  // Người kiểm tra khu: chỉ định riêng → tổ trưởng có ca trong khu → trưởng ca có ca hôm đó → quản lý
  function checkerOf(date, zoneId) {
    const o = db.prepare('SELECT staff_id FROM job_checkers WHERE date = ? AND zone_id = ?').get(date, zoneId);
    if (o) return [o.staff_id];
    const on = db.prepare(`SELECT DISTINCT a.staff_id AS id, s.role, a.zone_id FROM assignments a JOIN staff s ON s.id = a.staff_id WHERE a.date = ? AND s.active = 1
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')`).all(date);
    const tl = zoneId ? on.filter((x) => x.role === 'team_lead' && x.zone_id === zoneId) : [];
    if (tl.length) return [...new Set(tl.map((x) => x.id))];
    const sl = on.filter((x) => x.role === 'shift_lead');
    if (sl.length) return [...new Set(sl.map((x) => x.id))];
    return ctx.managers();
  }
  const canCheck = (me, date, zoneId) => isLead(me) || checkerOf(date, zoneId).includes(me.id);

  function jobRow(j, t) {
    const it = t?.items.find((i) => i.id === j.item_id) || db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(j.item_id) || {};
    return {
      id: j.id, date: j.date, template_id: j.template_id, title: it.text, phase: t?.phase, template_title: t?.title, zone_id: j.zone_id,
      qty: qtyText(it, j.zone_id), minutes: it.job_minutes || 0, fetch_where: it.fetch_where || '', photo_required: !!it.photo_required,
      staff_id: j.staff_id, staff_name: name(j.staff_id), staff_role: j.staff_id ? db.prepare('SELECT role FROM staff WHERE id = ?').get(j.staff_id)?.role || '' : '', status: j.status, claimed_at: j.claimed_at, due_at: j.due_at, done_at: j.done_at,
      minutes_used: j.minutes_used, late: !!j.late, redo_count: j.redo_count, has_photo: !!j.photo, checked_by_name: name(j.checked_by), check_note: j.check_note,
      overdue: j.status === 'doing' && j.due_at && j.due_at < ctx.now(),
      template_note: t?.job_note || '',
      ask_note: !!it.job_ask_note, done_note: j.done_note || '',
      guide: it.job_guide || '', deadline: it.job_deadline != null ? hhmm(it.job_deadline) : '', photos_needed: Math.max(it.job_photos || (it.photo_required ? 1 : 0), t?.job_lead_pool ? 1 : 0), pool: !!t?.job_lead_pool,
      samples: it.id ? db.prepare('SELECT id FROM checklist_samples WHERE item_id = ? ORDER BY id').all(it.id).map((x) => x.id) : [],
      extra_photos: db.prepare('SELECT id FROM job_photos WHERE job_id = ? ORDER BY id').all(j.id).map((x) => x.id),
      shots: db.prepare('SELECT id FROM job_shots WHERE job_id = ? ORDER BY id').all(j.id).map((x) => x.id),
      own: !!j.owner_id, with_title: it.job_with ? (t?.items.find((i) => i.id === it.job_with)?.text || '') : '', expect: it.job_expect || 0, count: j.count, short: j.short || 0,
    };
  }

  // ---------- Bảng việc (mọi người trong ca xem được: biết việc nào còn trống) ----------
  // Cả tuần: mỗi khu mỗi ngày có bao nhiêu người trong khung giờ (+ người hỗ trợ chưa phân khu), bao nhiêu việc, ~phút / người
  r.get('/api/jobs/week', 'staff', ({ query }) => {
    let start = query.get('start') || ctx.today();
    if (!isDate(start)) fail(400, 'Ngày không hợp lệ');
    const dow = new Date(`${start}T00:00:00Z`).getUTCDay();
    start = addDays(start, -((dow + 6) % 7)); // về thứ 2
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    for (const d of days) ensureDay(d);
    const zs = zonesAll();
    return { start, days, templates: jobTemplates().map((t) => {
      const zoneIds = [...new Set(days.flatMap((d) => slots(t, d).map((x) => x.zone_id)))].sort((a, b) => (a || 1e9) - (b || 1e9));
      return {
        id: t.id, title: t.title, phase: t.phase, window: winText(t),
        rows: zoneIds.map((zid) => ({
          zone_id: zid, zone_name: zid ? zs.find((z) => z.id === zid)?.name || 'Khu' : 'Việc chung cả quán', color: zid ? zs.find((z) => z.id === zid)?.color : '#666',
          cells: days.map((d) => {
            const ps = people(d, t).filter((p) => inWindow(p, t));
            const jobs = db.prepare('SELECT j.staff_id, j.status, i.job_minutes FROM jobs j JOIN checklist_items i ON i.id = j.item_id WHERE j.date = ? AND j.template_id = ? AND j.zone_id = ?').all(d, t.id, zid);
            const min = jobs.reduce((a, j) => a + (j.job_minutes || DEFAULT_MIN), 0);
            const who = new Set(jobs.map((j) => j.staff_id).filter(Boolean));
            return {
              date: d, people: zid ? ps.filter((p) => p.zone_id === zid).length : ps.length, helpers: zid ? ps.filter((p) => !p.zone_id).length : 0,
              jobs: jobs.length, doers: who.size, min_per: who.size ? Math.round(min / who.size) : null,
              unassigned: jobs.filter((j) => !j.staff_id).length, done: jobs.filter((j) => ['done', 'ok'].includes(j.status)).length,
            };
          }),
        })),
      };
    }) };
  });

  r.get('/api/jobs/board', 'staff', ({ me, query }) => {
    const date = query.get('date') || ctx.today();
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    ensureDay(date);
    const zname = new Map(zonesAll().map((z) => [z.id, z]));
    return { date, templates: jobTemplates().map((t) => {
      const rows = db.prepare('SELECT * FROM jobs WHERE date = ? AND template_id = ? ORDER BY zone_id, id').all(date, t.id).map((j) => jobRow(j, t));
      const ps = people(date, t);
      const zoneIds = [...new Set(rows.map((x) => x.zone_id))].sort((a, b) => (a || 1e9) - (b || 1e9));
      return {
        id: t.id, title: t.title, phase: t.phase, window: winText(t),
        zones: zoneIds.map((zid) => {
          const list = rows.filter((x) => x.zone_id === zid);
          return {
            zone_id: zid, zone_name: zid ? zname.get(zid)?.name || 'Khu' : 'Việc chung cả quán', color: zid ? zname.get(zid)?.color : '#666', tables: zid ? tables(zid) : 0,
            checkers: checkerOf(date, zid).map((id) => ({ id, name: name(id) })), can_check: canCheck(me, date, zid),
            // Mọi người trong khung giờ (để chọn tay); khu = 'own' người khu này · 'help' chưa phân khu · 'other' khu khác (mượn nếu có việc ở đây)
            people: ps.filter((p) => inWindow(p, t)).map((p) => ({ id: p.id, name: p.name, role: p.role, zone_id: p.zone_id, start: p.start, end: p.end,
              kind: !zid || p.zone_id === zid ? 'own' : !p.zone_id ? 'help' : 'other', zone_name: p.zone_id ? zname.get(p.zone_id)?.name || '' : '', borrowed: !!zid && !!p.zone_id && p.zone_id !== zid && list.some((x) => x.staff_id === p.id) }))
              .sort((a, b) => ['own', 'help', 'other'].indexOf(a.kind) - ['own', 'help', 'other'].indexOf(b.kind)),
            jobs: list, done: list.filter((x) => ['done', 'ok'].includes(x.status)).length, ok: list.filter((x) => x.status === 'ok').length,
            photos: db.prepare('SELECT id, staff_id, at FROM job_zone_photos WHERE date = ? AND template_id = ? AND zone_id = ? ORDER BY id').all(date, t.id, zid).map((p) => ({ ...p, staff_name: name(p.staff_id) })),
          };
        }),
      };
    }) };
  });

  // Việc của tôi hôm nay + việc trống trong khu tôi (hỗ trợ được)
  r.get('/api/jobs/mine', 'staff', ({ me }) => {
    const date = ctx.today();
    ensureDay(date);
    const tpl = new Map(jobTemplates().map((t) => [t.id, t]));
    const myZones = new Set(db.prepare('SELECT zone_id FROM assignments WHERE staff_id = ? AND date = ? AND zone_id IS NOT NULL').all(me.id, date).map((x) => x.zone_id));
    const onShift = !!db.prepare('SELECT 1 FROM assignments WHERE staff_id = ? AND date = ?').get(me.id, date);
    const all = db.prepare('SELECT * FROM jobs WHERE date = ? ORDER BY id').all(date).filter((j) => tpl.has(j.template_id));
    const inTeams = (t) => { const ts = teamsOf(t); return !ts || ts.includes(me.team_id) || !!db.prepare('SELECT 1 FROM assignments WHERE staff_id = ? AND date = ? AND team_id IN (' + ts.map(() => '?').join(',') + ')').get(me.id, date, ...ts); };
    const zname = new Map(zonesAll().map((z) => [z.id, z.name]));
    const fmt = (j) => ({ ...jobRow(j, tpl.get(j.template_id)), zone_name: j.zone_id ? zname.get(j.zone_id) || '' : 'Cả quán' });
    return {
      date, on_shift: onShift,
      mine: all.filter((j) => j.staff_id === me.id).map(fmt),
      // Việc điều phối: trưởng ca + tổ trưởng thấy cả danh sách (trống / đang làm / xong) để tự điều người
      pool: all.filter((j) => tpl.get(j.template_id)?.job_lead_pool && !j.owner_id && poolLead(me, date, j.zone_id, tpl.get(j.template_id))).map((j) => ({ ...fmt(j), people: undefined })),
      open: onShift ? all.filter((j) => !j.staff_id && j.status === 'todo' && !tpl.get(j.template_id)?.job_lead_pool && inTeams(tpl.get(j.template_id)) && (!j.zone_id || !myZones.size || myZones.has(j.zone_id))).map(fmt) : [],
      to_check: all.filter((j) => j.status === 'done' && j.staff_id !== me.id && canCheck(me, date, j.zone_id)).length,
      // Người để giao việc điều phối: ai có ca hôm nay trong các bộ phận của checklist
      crew: LEADS.includes(me.role) ? (() => { const m = new Map(); for (const t of tpl.values()) if (t.job_lead_pool) for (const p of people(date, t)) m.set(p.id, { id: p.id, name: p.name, role: p.role, zone_id: p.zone_id, zone_name: p.zone_id ? zname.get(p.zone_id) || '' : '', team_name: p.team_name, start: p.start, end: p.end }); return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi')); })() : [],
    };
  });

  const getJob = (id) => { const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id); if (!j) fail(404, 'Không tìm thấy việc'); return j; };
  const tplOf = (j) => jobTemplates().find((t) => t.id === j.template_id) || ctx.checklistTemplates({ activeOnly: false }).find((t) => t.id === j.template_id);
  const itemOf = (j) => db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(j.item_id);
  const zoneLabel = (zid) => (zid ? db.prepare('SELECT name FROM zones WHERE id = ?').get(zid)?.name || '' : 'cả quán');

  // Việc đi kèm (chưa bắt đầu) theo người làm việc chính
  const moveKids = (j, sid, by = null) => db.prepare("UPDATE jobs SET staff_id = ?, assigned_by = COALESCE(?, assigned_by), nudged = 0 WHERE date = ? AND zone_id = ? AND owner_id = 0 AND status = 'todo' AND item_id IN (SELECT id FROM checklist_items WHERE job_with = ?)").run(sid, by, j.date, j.zone_id, j.item_id);

  // Nhận việc: ghi giờ nhận, bắt đầu đếm thời gian chuẩn
  r.post('/api/jobs/:id/claim', 'staff', ({ me, params }) => {
    const j = getJob(params.id);
    if (j.date !== ctx.today()) fail(400, 'Chỉ nhận việc của hôm nay');
    if (j.status !== 'todo') fail(409, j.staff_id === me.id ? 'Bạn đã nhận việc này rồi' : `Việc đã có ${name(j.staff_id)} làm`);
    if (j.staff_id && j.staff_id !== me.id) fail(409, `Việc này đã giao cho ${name(j.staff_id)}. Nhờ tổ trưởng đổi người nếu bạn làm thay`);
    if (!db.prepare('SELECT 1 FROM assignments WHERE staff_id = ? AND date = ?').get(me.id, j.date) && !isLead(me)) fail(403, 'Bạn không có ca hôm nay');
    const it = itemOf(j), at = ctx.now();
    db.prepare("UPDATE jobs SET staff_id = ?, claimed_at = ?, due_at = ?, status = 'doing' WHERE id = ?").run(me.id, at, it.job_minutes ? at + it.job_minutes * 60_000 : null, j.id);
    if (!j.staff_id) moveKids(j, me.id);
    ctx.broadcast('jobs');
    return { ok: true, due_at: it.job_minutes ? at + it.job_minutes * 60_000 : null };
  });

  function savePhoto(data, prefix) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!m) fail(400, 'Ảnh không hợp lệ');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500) fail(400, 'Ảnh không hợp lệ');
    if (buf.length > 1_500_000) fail(413, 'Ảnh quá lớn, chụp lại giúp');
    const rel = path.join(ctx.today(), `${prefix}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.mkdirSync(path.join(photoDir, ctx.today()), { recursive: true });
    fs.writeFileSync(path.join(photoDir, rel), buf);
    return rel;
  }
  const sendPhoto = (rel) => {
    if (!rel) fail(404, 'Không có ảnh');
    let buf; try { buf = fs.readFileSync(path.join(photoDir, rel)); } catch { fail(410, 'Ảnh không còn'); }
    return { __binary: buf, type: rel.endsWith('.png') ? 'image/png' : rel.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
  };

  // Xong việc: ghi giờ xong + số phút; trễ so với thời gian chuẩn → ghi lỗi
  r.post('/api/jobs/:id/done', 'staff', ({ me, params, body }) => {
    const j = getJob(params.id);
    if (j.staff_id !== me.id) fail(403, 'Đây không phải việc của bạn');
    if (j.status !== 'doing') fail(409, j.status === 'todo' ? 'Bấm Nhận trước khi làm' : 'Việc đã báo xong');
    const it = itemOf(j);
    // Nhiều ảnh (chụp rộng các góc): body.photos = [data,…]; cũ: body.data = 1 ảnh
    const list = Array.isArray(body.photos) ? body.photos.filter(Boolean).slice(0, 6) : body.data ? [body.data] : [];
    const saved = db.prepare('SELECT file FROM job_shots WHERE job_id = ? ORDER BY id').all(j.id).map((x) => x.file);
    const need = Math.max(it.job_photos || (it.photo_required ? 1 : 0), tplOf(j)?.job_lead_pool ? 1 : 0); // điều phối: mọi việc phải chụp ảnh (chủ quán 28/10)
    if (list.length + saved.length < need) fail(400, need > 1 ? `Việc này phải chụp đủ ${need} ảnh (đang có ${list.length + saved.length})` : 'Việc này phải chụp ảnh khi xong');
    const doneNote = v.text(body.note, { name: 'Ghi chú', max: 1000 });
    if (it.job_ask_note && !doneNote.trim()) fail(400, 'Việc này phải ghi chú khi xong (vd tình trạng, còn thiếu gì)');
    const files = [...saved, ...list.map((d, k) => savePhoto(d, `j${j.id}-${k}`))].slice(0, 8);
    db.prepare('DELETE FROM job_shots WHERE job_id = ?').run(j.id);
    const photo = files[0] || null;
    if (files.length > 1) { db.prepare('DELETE FROM job_photos WHERE job_id = ?').run(j.id); for (const f of files.slice(1)) db.prepare('INSERT INTO job_photos (job_id, file, at) VALUES (?, ?, ?)').run(j.id, f, ctx.now()); }
    // Việc có số phải đủ (vd giặt 2 khăn): nhập số thực tế, thiếu → ghi vào tên người làm (đền)
    let count = null, short = 0;
    if (it.job_expect) {
      if (body.count === undefined || body.count === '' || body.count === null) fail(400, `Nhập số ${it.unit || 'cái'} thực tế (phải đủ ${it.job_expect})`);
      count = v.int(body.count, { min: 0, max: 9999, name: 'Số lượng' });
      short = Math.max(0, it.job_expect - count);
    }
    const at = ctx.now();
    const late = j.due_at && at > j.due_at ? 1 : 0;
    db.prepare("UPDATE jobs SET status = 'done', done_at = ?, minutes_used = ?, late = MAX(late, ?), photo = COALESCE(?, photo), count = ?, short = ? WHERE id = ?").run(at, Math.max(1, Math.round((at - j.claimed_at) / 60_000)), late, photo, count, short, j.id);
    db.prepare('UPDATE jobs SET done_note = ? WHERE id = ?').run(doneNote, j.id);
    if (short) {
      const ids = [...new Set([...checkerOf(j.date, j.zone_id), ...ctx.managers()])].filter((x) => x !== me.id);
      ctx.notify(ids, { title: `Thiếu ${short} ${it.unit || ''}: ${it.text}`.replace('  ', ' '), body: `${me.name}: ${count}/${it.job_expect} → ghi vào tên ${me.name} (đền)`, link: '/viec-ca?tab=khu', urgent: true });
      ctx.audit(me, 'job.short', { id: j.id, short, count });
    }
    ctx.broadcast('jobs');
    return { ok: true, late: !!late, short };
  });

  // Người kiểm tra: Đạt / Làm lại (trả về đúng người, đồng hồ chạy lại)
  r.post('/api/jobs/:id/check', 'staff', ({ me, params, body }) => {
    const j = getJob(params.id);
    if (!canCheck(me, j.date, j.zone_id) && !(tplOf(j)?.job_lead_pool && poolLead(me, j.date, j.zone_id, tplOf(j)))) fail(403, 'Chỉ tổ trưởng khu / trưởng ca kiểm tra việc này');
    if (j.staff_id === me.id && rank(me.role) < rank('manager')) fail(403, 'Không tự kiểm việc của mình');
    if (!['done', 'ok'].includes(j.status)) fail(409, 'Việc chưa báo xong');
    const ok = v.bool(body.ok);
    const note = v.text(body.note, { name: 'Ghi chú', max: 200 });
    if (!ok && !note) fail(400, 'Ghi lý do làm lại');
    const at = ctx.now();
    if (ok) db.prepare("UPDATE jobs SET status = 'ok', checked_by = ?, checked_at = ?, check_note = ? WHERE id = ?").run(me.id, at, note, j.id);
    else {
      const it = itemOf(j);
      // Làm lại: bỏ ảnh cũ để người làm chụp lại (chủ quán 28/10)
      db.prepare('DELETE FROM job_photos WHERE job_id = ?').run(j.id);
      db.prepare("UPDATE jobs SET status = 'doing', photo = NULL, redo_count = redo_count + 1, claimed_at = ?, due_at = ?, done_at = NULL, alerted = 0, checked_by = ?, checked_at = ?, check_note = ? WHERE id = ?")
        .run(at, it.job_minutes ? at + it.job_minutes * 60_000 : null, me.id, at, note, j.id);
      if (j.staff_id) ctx.notify([j.staff_id], { title: `↩ Làm lại: ${it.text}`, body: `${me.name}: ${note}`, link: '/viec-ca', urgent: true });
    }
    ctx.audit(me, 'job.check', { id: j.id, ok, note });
    ctx.broadcast('jobs');
    return { ok: true };
  });

  // Đổi người làm (việc chưa bắt đầu, hoặc đang làm mà người đó phải đi việc khác)
  r.patch('/api/jobs/:id', 'staff', ({ me, params, body }) => {
    const j = getJob(params.id);
    if (!canCheck(me, j.date, j.zone_id) && !(tplOf(j)?.job_lead_pool && poolLead(me, j.date, j.zone_id, tplOf(j)))) fail(403, 'Chỉ tổ trưởng khu / trưởng ca đổi người');
    if (['done', 'ok'].includes(j.status)) fail(409, 'Việc đã xong, không đổi người');
    const sid = body.staff_id ? v.int(body.staff_id, { min: 1, name: 'Người làm' }) : null;
    if (sid && !db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1').get(sid)) fail(404, 'Không tìm thấy nhân viên');
    db.prepare("UPDATE jobs SET staff_id = ?, status = 'todo', claimed_at = NULL, due_at = NULL, nudged = 0, alerted = 0, assigned_by = ?, assigned_at = ? WHERE id = ?").run(sid, me.id, ctx.now(), j.id);
    moveKids(j, sid, me.id);
    if (sid && sid !== me.id) ctx.notify([sid], { title: `Việc mới: ${itemOf(j).text}`, body: `${zoneLabel(j.zone_id)} · ${me.name} giao`, link: '/viec-ca' });
    ctx.broadcast('jobs');
    return { ok: true };
  });

  // Chia lại theo gợi ý (vd sau khi đổi ca / phân khu lại): chỉ đổi việc chưa ai bắt đầu
  r.post('/api/jobs/reassign', 'staff', ({ me, body }) => {
    const date = body.date || ctx.today();
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    const ts = jobTemplates().filter((t) => !body.template_id || t.id === Number(body.template_id));
    if (!isLead(me) && !zonesAll().some((z) => checkerOf(date, z.id).includes(me.id))) fail(403, 'Chỉ tổ trưởng / trưởng ca chia lại việc');
    for (const t of ts) materialize(date, t, { mode: 'force' });
    ctx.audit(me, 'job.reassign', { date, template: body.template_id || null });
    ctx.broadcast('jobs');
    return { ok: true };
  });

  // Chỉ định người kiểm tra khu trong ngày (thay tổ trưởng)
  r.put('/api/jobs/checker', 'shift_lead', ({ me, body }) => {
    const date = body.date || ctx.today();
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    const zid = Number(body.zone_id) || 0;
    if (body.staff_id) db.prepare('INSERT OR REPLACE INTO job_checkers (date, zone_id, staff_id) VALUES (?, ?, ?)').run(date, zid, v.int(body.staff_id, { min: 1, name: 'Người kiểm tra' }));
    else db.prepare('DELETE FROM job_checkers WHERE date = ? AND zone_id = ?').run(date, zid);
    ctx.audit(me, 'job.checker', { date, zid, staff: body.staff_id || null });
    ctx.broadcast('jobs');
    return { ok: true };
  });

  // Báo hết đồ (vd tương ớt): báo người kiểm tra khu + quản lý, kèm chỗ lấy
  r.post('/api/jobs/:id/out', 'staff', ({ me, params, body }) => {
    const j = getJob(params.id);
    const it = itemOf(j);
    const what = v.text(body.what, { name: 'Hết gì', max: 80 }) || it.text;
    const ids = [...new Set([...checkerOf(j.date, j.zone_id), ...ctx.managers()])].filter((x) => x !== me.id);
    ctx.notify(ids, { title: `Hết đồ: ${what}`, body: `${me.name} · ${zoneLabel(j.zone_id)}${it.fetch_where ? ` · chỗ lấy: ${it.fetch_where} (cũng hết)` : ''}`, link: '/viec-ca?tab=khu', urgent: true });
    ctx.audit(me, 'job.out', { id: j.id, what });
    return { ok: true };
  });

  r.get('/api/jobs/:id/photo', 'staff', ({ params }) => sendPhoto(getJob(params.id).photo));
  r.post('/api/jobs/:id/shot', 'staff', ({ me, params, body }) => {
    const j = getJob(params.id);
    if (j.staff_id !== me.id) fail(403, 'Đây không phải việc của bạn');
    if (j.status !== 'doing') fail(409, 'Bấm Nhận việc trước khi chụp');
    if (db.prepare('SELECT COUNT(*) AS n FROM job_shots WHERE job_id = ?').get(j.id).n >= 8) fail(400, 'Tối đa 8 ảnh');
    const id = Number(db.prepare('INSERT INTO job_shots (job_id, file, at) VALUES (?, ?, ?)').run(j.id, savePhoto(body.data, `j${j.id}-s`), ctx.now()).lastInsertRowid);
    ctx.broadcast('jobs');
    return { id };
  });
  r.post('/api/jobs/shot/:sid/delete', 'staff', ({ me, params }) => {
    const x = db.prepare('SELECT s.id, j.staff_id FROM job_shots s JOIN jobs j ON j.id = s.job_id WHERE s.id = ?').get(Number(params.sid));
    if (!x) fail(404, 'Không có ảnh');
    if (x.staff_id !== me.id) fail(403, 'Không phải ảnh của bạn');
    db.prepare('DELETE FROM job_shots WHERE id = ?').run(x.id);
    ctx.broadcast('jobs');
    return { ok: true };
  });
  r.get('/api/jobs/shot/:sid', 'staff', ({ params }) => sendPhoto(db.prepare('SELECT file FROM job_shots WHERE id = ?').get(params.sid)?.file));
  r.get('/api/jobs/photo-extra/:id', 'staff', ({ params }) => sendPhoto(db.prepare('SELECT file FROM job_photos WHERE id = ?').get(params.id)?.file));

  // Ảnh tổng khu (người kiểm tra chụp 1 lần khi khu xong)
  r.post('/api/jobs/zone-photo', 'staff', ({ me, body }) => {
    const date = ctx.today(), zid = Number(body.zone_id) || 0, tid = v.int(body.template_id, { min: 1, name: 'Checklist' });
    if (!canCheck(me, date, zid)) fail(403, 'Chỉ tổ trưởng khu / trưởng ca chụp ảnh tổng khu');
    const file = savePhoto(body.data, `z${tid}-${zid}`);
    const id = Number(db.prepare('INSERT INTO job_zone_photos (date, template_id, zone_id, staff_id, file, at) VALUES (?, ?, ?, ?, ?, ?)').run(date, tid, zid, me.id, file, ctx.now()).lastInsertRowid);
    ctx.broadcast('jobs');
    return { id };
  });
  r.get('/api/jobs/zone-photo/:id', 'staff', ({ params }) => sendPhoto(db.prepare('SELECT file FROM job_zone_photos WHERE id = ?').get(params.id)?.file));

  // Báo cáo: ai trễ, ai bị làm lại, ai làm nhanh; khu xong lúc mấy giờ
  r.get('/api/jobs/report', 'shift_lead', ({ query }) => {
    const to = query.get('to') || ctx.today(), from = query.get('from') || addDays(to, -6);
    if (!isDate(from) || !isDate(to)) fail(400, 'Ngày không hợp lệ');
    const rows = db.prepare(`SELECT j.*, i.job_minutes FROM jobs j JOIN checklist_items i ON i.id = j.item_id WHERE j.date BETWEEN ? AND ? AND j.staff_id IS NOT NULL`).all(from, to);
    const by = new Map();
    for (const j of rows) {
      const x = by.get(j.staff_id) || { staff_id: j.staff_id, name: name(j.staff_id), total: 0, done: 0, late: 0, redo: 0, missed: 0, used: 0, std: 0, short: 0 };
      x.total++;
      if (['done', 'ok'].includes(j.status)) { x.done++; if (j.job_minutes) { x.used += j.minutes_used || 0; x.std += j.job_minutes; } }
      else if (j.date < ctx.today()) x.missed++;
      x.late += j.late; x.redo += j.redo_count; x.short += j.short || 0;
      by.set(j.staff_id, x);
    }
    const staff = [...by.values()].map((x) => ({ ...x, speed: x.std ? Math.round((x.used / x.std) * 100) : null })).sort((a, b) => (b.late + b.redo + b.missed) - (a.late + a.redo + a.missed) || a.name.localeCompare(b.name));
    const zones = db.prepare(`SELECT date, template_id, zone_id, COUNT(*) AS n, SUM(CASE WHEN status IN ('done','ok') THEN 1 ELSE 0 END) AS d, MAX(done_at) AS last_done FROM jobs WHERE date BETWEEN ? AND ? GROUP BY date, template_id, zone_id ORDER BY date DESC`).all(from, to)
      .map((z) => ({ ...z, zone_name: zoneLabel(z.zone_id), template_title: db.prepare('SELECT title FROM checklist_templates WHERE id = ?').get(z.template_id)?.title || '' }));
    return { from, to, staff, zones };
  });

  // Chủ quán 26/10: nạp xong 12 việc mở ca → chia lại việc hôm nay + 6 ngày tới (1 lần)
  if (ctx.setting('mo_ca_pv_split')) {
    const t = jobTemplates().find((x) => x.id === Number(ctx.setting('mo_ca_pv_split')));
    ctx.setSetting('mo_ca_pv_split', '');
    if (t) for (let i = 0; i < 7; i++) materialize(addDays(ctx.today(), i), t, { mode: 'force' });
  }

  // ---------- Nhắc giờ (mỗi phút) ----------
  ctx.jobsTick = () => {
    const date = ctx.today(), now = ctx.now(), c = ctx.clock();
    const ts = jobTemplates();
    if (!ts.length) return;
    // Tạo thẻ việc trong ngày từ 1 tiếng trước ca sớm nhất
    const nowMin = c.minuteOf(now);
    for (const t of ts) { const ps = people(date, t); if (ps.length && nowMin >= (t.job_from ?? Math.min(...ps.map((p) => p.start))) - 60) materialize(date, t); }
    // 15 phút sau giờ bắt đầu (vd 14:15): người được giao mà chưa chấm vào → chuyển việc cho người đã chấm vào (cùng khu → hỗ trợ → khu khác), báo người kiểm tra (1 lần / ngày)
    for (const t of ts) {
      if (t.job_lead_pool || t.job_from == null || nowMin < t.job_from + 15 || ctx.setting(`noshow:${date}:${t.id}`)) continue; // điều phối: trưởng ca tự điều
      ctx.setSetting(`noshow:${date}:${t.id}`, '1');
      const inAtt = new Set(db.prepare('SELECT DISTINCT staff_id FROM attendance WHERE date = ?').all(date).map((x) => x.staff_id));
      const everyone = people(date, t), startOf = new Map(everyone.map((p) => [p.id, p.start]));
      const ps = everyone.filter((p) => inWindow(p, t));
      const here = ps.filter((p) => inAtt.has(p.id));
      const rows = db.prepare("SELECT * FROM jobs WHERE date = ? AND template_id = ? AND status = 'todo' AND owner_id = 0 AND staff_id IS NOT NULL").all(date, t.id);
      const cnt = new Map(here.map((p) => [p.id, rows.filter((r) => r.staff_id === p.id).length]));
      const moved = [];
      for (const j of rows) {
        if (inAtt.has(j.staff_id) || (startOf.get(j.staff_id) ?? 0) > nowMin) continue; // đã đến / ca bắt đầu muộn hơn → không chuyển
        const it = itemOf(j);
        const fit = fitPool(here, it);
        if (!fit.length) { moved.push(`${it.text}: chưa có người thay (${name(j.staff_id)} chưa chấm vào)`); continue; }
        const cost = (p) => cnt.get(p.id) * 10 + (j.zone_id && p.zone_id === j.zone_id ? 0 : !p.zone_id ? 5 : 15);
        const best = fit.reduce((a, b) => (cost(b) < cost(a) ? b : a));
        db.prepare('UPDATE jobs SET staff_id = ?, nudged = 0, assigned_at = ? WHERE id = ?').run(best.id, now, j.id);
        cnt.set(best.id, cnt.get(best.id) + 1);
        ctx.notify([best.id], { title: `Việc thêm: ${it.text}`, body: `${zoneLabel(j.zone_id)} · làm thay ${name(j.staff_id)} (chưa chấm vào)`, link: '/viec-ca' });
        moved.push(`${it.text}: ${name(j.staff_id)} → ${best.name}`);
      }
      if (moved.length) ctx.notify([...new Set(zonesAll().flatMap((z) => checkerOf(date, z.id)))], { title: `🔁 Chuyển ${moved.length} việc (người chưa chấm vào)`, body: moved.join('\n'), link: '/viec-ca?tab=khu' });
    }
    const tpl = new Map(ts.map((t) => [t.id, t]));
    for (const j of db.prepare("SELECT * FROM jobs WHERE date = ? AND status IN ('todo','doing')").all(date)) {
      const t = tpl.get(j.template_id);
      if (!t) continue;
      const it = itemOf(j);
      // Quá thời gian chuẩn → báo người làm + người kiểm tra khu (1 lần), ghi trễ
      if (j.status === 'doing' && j.due_at && now > j.due_at && !j.alerted) {
        db.prepare('UPDATE jobs SET alerted = 1, late = 1 WHERE id = ?').run(j.id);
        ctx.notify([...new Set([j.staff_id, ...checkerOf(date, j.zone_id)])].filter(Boolean), { title: `⏰ Quá giờ: ${it.text}`, body: `${name(j.staff_id)} · ${zoneLabel(j.zone_id)} · chuẩn ${it.job_minutes} phút`, link: '/viec-ca?tab=khu', urgent: true });
        continue;
      }
      // Quá giờ phải xong (vd 14:30) mà chưa xong → báo người làm + người kiểm tra khu (1 lần)
      if (it.job_deadline != null && nowMin >= it.job_deadline && !j.deadline_alerted) {
        db.prepare('UPDATE jobs SET deadline_alerted = 1, late = 1 WHERE id = ?').run(j.id);
        ctx.notify([...new Set([j.staff_id, ...checkerOf(date, j.zone_id)])].filter(Boolean), { title: `⏰ Quá ${hhmm(it.job_deadline)} chưa xong: ${it.text}`, body: `${j.staff_id ? name(j.staff_id) : 'Chưa ai nhận'} · ${zoneLabel(j.zone_id)}`, link: '/viec-ca?tab=khu', urgent: true });
        continue;
      }
      if (j.status !== 'todo' || j.nudged) continue;
      if (j.staff_id) {
        // Đã giao mà chưa bấm Nhận: mở ca → 10 phút sau khi chấm công vào; đóng ca → 30 phút trước giờ về
        const att = db.prepare('SELECT clock_in FROM attendance WHERE staff_id = ? AND date = ? ORDER BY id LIMIT 1').get(j.staff_id, date);
        const p = people(date, t).find((x) => x.id === j.staff_id);
        const due = j.owner_id && t.phase === 'close' ? (p ? nowMin >= p.end - 20 : false) : t.job_from != null ? nowMin >= t.job_from + 10 : t.phase === 'close' ? (p ? nowMin >= p.end - 30 : false) : (att && now > att.clock_in + 10 * 60_000);
        if (due) { db.prepare('UPDATE jobs SET nudged = 1 WHERE id = ?').run(j.id); ctx.notify([j.staff_id], { title: `Việc của bạn: ${it.text}`, body: `${zoneLabel(j.zone_id)} · bấm Nhận rồi làm${it.job_minutes ? ` (chuẩn ${it.job_minutes} phút)` : ''}`, link: '/viec-ca' }); }
      } else {
        // Chưa ai nhận 15 phút sau ca sớm nhất → báo người kiểm tra khu
        const ps = people(date, t);
        if (ps.length && nowMin >= (t.job_from ?? Math.min(...ps.map((p) => p.start))) + 15) { db.prepare('UPDATE jobs SET nudged = 1 WHERE id = ?').run(j.id); ctx.notify(checkerOf(date, j.zone_id), { title: `Chưa ai nhận: ${it.text}`, body: zoneLabel(j.zone_id), link: '/viec-ca?tab=khu' }); }
      }
    }
  };
}
