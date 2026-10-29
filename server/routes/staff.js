import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { tx, rank, ROLES, ROLE_LABEL } from '../db.js';
import { validatePin } from './auth.js';
import { addDays } from '../lib/time.js';

export default function (r, ctx) {
  const { db } = ctx;

  const teamExists = (id) => id === null || db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id);
  // Ai thêm nhân viên (chủ quán 29/10): báo chủ + hiện ở màn Quản lý
  if (!db.prepare('PRAGMA table_info(staff)').all().some((c) => c.name === 'created_by')) db.exec('ALTER TABLE staff ADD COLUMN created_by INTEGER');

  // ---------- Tổ ----------
  r.get('/api/teams', 'staff', () => {
    const pos = db.prepare('SELECT * FROM positions WHERE active = 1 ORDER BY sort, id').all();
    return db.prepare('SELECT * FROM teams ORDER BY active DESC, sort, id').all().map((t) => ({ ...t, positions: pos.filter((p) => p.team_id === t.id) }));
  });

  r.post('/api/teams', 'manager', ({ me, body }) => {
    const name = v.text(body.name, { name: 'Tên tổ', required: true, max: 40 });
    const min = v.optInt(body.min_staff, { min: 0, max: 100, name: 'Số người tối thiểu' }) ?? 0;
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM teams').get().s;
    const id = Number(db.prepare('INSERT INTO teams (name, sort, min_staff) VALUES (?, ?, ?)').run(name, sort, min).lastInsertRowid);
    ctx.audit(me, 'team.create', name);
    ctx.broadcast('teams');
    return { id };
  });

  r.patch('/api/teams/:id', 'manager', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy tổ');
    const name = body.name === undefined ? t.name : v.text(body.name, { name: 'Tên tổ', required: true, max: 40 });
    const min = body.min_staff === undefined ? t.min_staff : v.int(body.min_staff, { min: 0, max: 100, name: 'Số người tối thiểu' });
    const sort = body.sort === undefined ? t.sort : v.int(body.sort, { name: 'Thứ tự' });
    const active = body.active === undefined ? t.active : v.bool(body.active);
    db.prepare('UPDATE teams SET name = ?, min_staff = ?, sort = ?, active = ? WHERE id = ?').run(name, min, sort, active, t.id);
    ctx.audit(me, 'team.update', { id: t.id, name });
    ctx.broadcast('teams');
    return { ok: true };
  });

  // Khu cố định (chủ quán 27/10: người làm full 14–23 giữ cố định 1 khu): mọi ca mới của người đó tự vào khu này (trigger, áp cho mọi nơi tạo ca)
  if (!db.prepare('PRAGMA table_info(staff)').all().some((c) => c.name === 'home_zone_id')) db.exec('ALTER TABLE staff ADD COLUMN home_zone_id INTEGER');
  if (!db.prepare('PRAGMA table_info(staff)').all().some((c) => c.name === 'gender')) db.exec("ALTER TABLE staff ADD COLUMN gender TEXT NOT NULL DEFAULT ''"); // nam | nu | '' (chủ quán 27/10: việc chỉ nữ / chỉ nam)
  db.exec(`CREATE TRIGGER IF NOT EXISTS assign_home_zone AFTER INSERT ON assignments
    WHEN (SELECT home_zone_id FROM staff WHERE id = NEW.staff_id) IS NOT NULL
    BEGIN UPDATE assignments SET zone_id = (SELECT home_zone_id FROM staff WHERE id = NEW.staff_id) WHERE id = NEW.id; END`);

  // Phục vụ (chủ quán 27/10): Full ca = 14–23, giờ khác = Ca gãy. Gán lại 1 lần theo ca đang xếp (7 ngày trước → 7 ngày tới)
  ctx.pvWorkTypeSync = () => {
    const pv = db.prepare("SELECT id FROM teams WHERE name LIKE '%hục vụ%' OR name LIKE '%HỤC VỤ%'").get();
    if (!pv) return 0;
    const t = ctx.today(), [y, m, dd] = t.split('-').map(Number);
    const shift = (n) => new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT a.staff_id, a.group_id, COUNT(*) AS n, MIN(a.start_min) AS s, MAX(a.end_min) AS e FROM assignments a JOIN staff st ON st.id = a.staff_id
      WHERE st.team_id = ? AND st.active = 1 AND a.date BETWEEN ? AND ? GROUP BY a.staff_id, a.group_id`).all(pv.id, shift(-7), shift(7));
    const by = new Map();
    for (const r of rows) { const o = by.get(r.staff_id) || { full: 0, other: 0 }; (r.n === 1 && r.s === 840 && (r.e === 1380 || r.e === 1440 || r.e === 0) ? o.full++ : o.other++); by.set(r.staff_id, o); }
    let n = 0;
    for (const [id, o] of by) { db.prepare('UPDATE staff SET work_type = ? WHERE id = ?').run(o.full >= o.other ? 'full' : 'gay', id); n++; }
    return n;
  };
  if (!ctx.setting('pv_work_type_v1')) { ctx.pvWorkTypeSync(); ctx.setSetting('pv_work_type_v1', '1'); }

  // Lịch sử mức lương theo tháng (chủ quán 27/10: tháng đầu 23k/giờ, tháng sau 20k/giờ). from_month '0000-00' = mức trước khi có lịch sử
  db.exec('CREATE TABLE IF NOT EXISTS pay_history (staff_id INTEGER NOT NULL, from_month TEXT NOT NULL, pay_type TEXT NOT NULL, pay_rate INTEGER NOT NULL, by_staff INTEGER, at INTEGER, PRIMARY KEY (staff_id, from_month))');
  const payAt = (staffId, month) => db.prepare('SELECT pay_type, pay_rate, from_month FROM pay_history WHERE staff_id = ? AND from_month <= ? ORDER BY from_month DESC LIMIT 1').get(staffId, month);
  ctx.payForMonth = (staffId, month) => payAt(staffId, month) || null;
  // Sang tháng mới: mức đang dùng (staff.pay_*) = mức của tháng hiện tại theo lịch sử (cho báo cáo nhân sự, danh sách…)
  ctx.syncPay = () => {
    const m = ctx.today().slice(0, 7);
    for (const { staff_id: id } of db.prepare('SELECT DISTINCT staff_id FROM pay_history').all()) {
      const h = payAt(id, m);
      if (h) db.prepare('UPDATE staff SET pay_type = ?, pay_rate = ? WHERE id = ? AND (pay_type != ? OR pay_rate != ?)').run(h.pay_type, h.pay_rate, id, h.pay_type, h.pay_rate);
    }
  };

  // ---------- Nhân viên ----------
  function listStaff(me, { includeInactive = false } = {}) {
    ctx.syncPay();
    const canSeePay = rank(me.role) >= rank('manager');
    const rows = db.prepare(`SELECT s.*, t.name AS team_name, p.name AS position_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id LEFT JOIN positions p ON p.id = s.position_id
      ${includeInactive ? '' : 'WHERE s.active = 1'} ORDER BY s.active DESC, ${rankSql()} DESC, t.sort, s.name`).all();
    const skills = db.prepare('SELECT staff_id, team_id, level FROM staff_skills').all();
    const pskills = db.prepare('SELECT staff_id, position_id, level FROM position_skills').all();
    return rows.map((s) => ({
      id: s.id, name: s.name, phone: rank(me.role) >= rank('team_lead') ? s.phone : '',
      role: s.role, role_label: ROLE_LABEL[s.role], team_id: s.team_id, team_name: s.team_name || '',
      active: !!s.active, zalo_linked: !!s.zalo_user_id, weekly_limit_hours: s.weekly_limit_hours,
      position_id: s.position_id ?? null, position_name: s.position_name || '', work_type: s.work_type || '', home_zone_id: s.home_zone_id ?? null, gender: s.gender || '',
      first_login: canSeePay ? !!s.must_change_pin : undefined,
      ...(canSeePay ? { device_set: !!s.device_id, device_pending: !!s.device_pending, device_at: s.device_at || null } : {}),
      skills: skills.filter((k) => k.staff_id === s.id).map(({ team_id, level }) => ({ team_id, level })),
      pskills: pskills.filter((k) => k.staff_id === s.id).map(({ position_id, level }) => ({ position_id, level })),
      ...(canSeePay ? { pay_type: s.pay_type, pay_rate: s.pay_rate, pay_rule: s.pay_rule ?? null, zalo_user_id: s.zalo_user_id, pay_history: db.prepare("SELECT from_month, pay_type, pay_rate FROM pay_history WHERE staff_id = ? AND from_month != '0000-00' ORDER BY from_month").all(s.id) } : {}),
    }));
  }

  r.get('/api/staff', 'staff', ({ me, query }) => listStaff(me, { includeInactive: query.get('all') === '1' && rank(me.role) >= rank('manager') }));

  // Máy chấm công: "Cho đổi máy" (nhận máy mới bạn ấy vừa thử chấm) hoặc "Gỡ máy" (lần chấm sau gắn máy mới)
  r.post('/api/staff/:id/device', 'manager', ({ me, params, body }) => {
    const st = db.prepare('SELECT * FROM staff WHERE id = ?').get(params.id);
    if (!st) fail(404, 'Không tìm thấy nhân viên');
    if (!canManage(me, st.role) && !(st.id === me.id && rank(realRole(me)) >= rank('manager'))) fail(403, 'Bạn không thể đổi máy chấm công của tài khoản này'); // rà soát 28/10
    if (body.action === 'allow' && st.device_pending) db.prepare("UPDATE staff SET device_id = device_pending, device_pending = '', device_at = ? WHERE id = ?").run(ctx.now(), st.id);
    else db.prepare("UPDATE staff SET device_id = '', device_pending = '', device_at = NULL WHERE id = ?").run(st.id);
    ctx.audit(me, 'staff.device', { id: st.id, action: body.action || 'reset' });
    if (st.id !== me.id) ctx.notify([st.id], { title: 'Quản lý đã cho đổi máy chấm công', body: 'Bạn chấm công lại trên điện thoại mới được rồi.', link: '/' });
    ctx.broadcast('staff');
    return { ok: true };
  });

  // Xét theo chức vụ THẬT (rà soát 28/10): người được nâng quyền (cấp riêng) không đặt PIN / sửa người cùng cấp hoặc cao hơn mình
  const realRole = (me) => me.real_role || me.role;
  function canManage(me, role) {
    if (me.role === 'owner') return true;
    return rank(role) < rank(realRole(me));
  }
  // Đổi lương (rà soát 28/10): chỉ quản lý thật trở lên; lương của chính mình hoặc của quản lý / chủ chỉ chủ quán đổi
  function canSetPay(me, target) {
    if (me.role === 'owner') return true;
    if (rank(realRole(me)) < rank('manager')) return false;
    return target.id !== me.id && rank(target.role) < rank('manager');
  }

  function staffFields(body, current = {}) {
    const name = body.name === undefined ? current.name : v.text(body.name, { name: 'Tên', required: true, max: 60 });
    const phone = body.phone === undefined ? current.phone ?? '' : v.text(body.phone, { name: 'Số điện thoại', max: 20 });
    const role = body.role === undefined ? current.role ?? 'staff' : v.oneOf(body.role, ROLES, { name: 'Vai trò' });
    let teamId = body.team_id === undefined ? current.team_id ?? null : v.optInt(body.team_id, { min: 1, name: 'Tổ' });
    if (!teamExists(teamId)) fail(400, 'Tổ không tồn tại');
    const positionId = body.position_id === undefined && body.team_id === undefined ? current.position_id ?? null
      : teamId ? ctx.readPosition(body.position_id === undefined ? current.position_id : body.position_id, teamId) : null;
    const payType = body.pay_type === undefined ? current.pay_type ?? 'hour' : v.oneOf(body.pay_type, ['hour', 'shift', 'month'], { name: 'Cách tính lương' });
    const payRate = body.pay_rate === undefined ? current.pay_rate ?? 0 : v.int(body.pay_rate, { min: 0, max: 100_000_000, name: 'Mức lương' });
    const limit = body.weekly_limit_hours === undefined ? current.weekly_limit_hours ?? 48 : v.int(body.weekly_limit_hours, { min: 1, max: 100, name: 'Giới hạn giờ/tuần' });
    const zalo = body.zalo_user_id === undefined ? current.zalo_user_id ?? '' : v.text(body.zalo_user_id, { name: 'Zalo user ID', max: 64 });
    const workType = body.work_type === undefined ? current.work_type ?? '' : v.oneOf(body.work_type || '', ['', 'full', 'gay', 'part'], { name: 'Loại ca' });
    return { name, phone, role, teamId, positionId, payType, payRate, limit, zalo, workType };
  }

  function saveSkills(staffId, skills) {
    if (!Array.isArray(skills)) return;
    db.prepare('DELETE FROM staff_skills WHERE staff_id = ?').run(staffId);
    const add = db.prepare('INSERT OR REPLACE INTO staff_skills (staff_id, team_id, level) VALUES (?, ?, ?)');
    for (const s of skills) {
      const teamId = v.int(s.team_id, { min: 1, name: 'Tổ của kỹ năng' });
      if (!teamExists(teamId)) fail(400, 'Tổ của kỹ năng không tồn tại');
      add.run(staffId, teamId, v.int(s.level ?? 1, { min: 1, max: 3, name: 'Mức kỹ năng' }));
    }
  }

  function savePositionSkills(staffId, list) {
    if (!Array.isArray(list)) return;
    db.prepare('DELETE FROM position_skills WHERE staff_id = ?').run(staffId);
    const add = db.prepare('INSERT OR REPLACE INTO position_skills (staff_id, position_id, level) VALUES (?, ?, ?)');
    for (const s of list) add.run(staffId, ctx.readPosition(s.position_id), v.int(s.level ?? 1, { min: 1, max: 3, name: 'Mức kỹ năng' }));
  }

  // Tạo PIN hàng loạt (chủ quán 25/10): mỗi người 1 PIN 6 số ngẫu nhiên, chỉ hiện 1 lần cho người tạo; lần đầu đăng nhập phải đổi PIN
  r.post('/api/staff/bulk-pin', 'manager', ({ me, body }) => {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 200);
    if (!ids.length) fail(400, 'Chọn ít nhất 1 người');
    const out = [];
    tx(db, () => {
      for (const id of ids) {
        const st = db.prepare('SELECT id, name, role, active FROM staff WHERE id = ?').get(id);
        if (!st || !st.active || st.id === me.id || !canManage(me, st.role) || st.role === 'owner') continue;
        let pin = '', lookup = null;
        for (let k = 0; k < 20 && !lookup; k++) {
          pin = String(crypto.randomInt(100000, 1000000));
          try { lookup = validatePin(db, pin, st.role, st.id); } catch { lookup = null; }
        }
        if (!lookup) continue;
        db.prepare('UPDATE staff SET pin_lookup = ?, must_change_pin = 1 WHERE id = ?').run(lookup, st.id);
        db.prepare('DELETE FROM sessions WHERE staff_id = ?').run(st.id);
        out.push({ id: st.id, name: st.name, pin });
      }
    });
    ctx.audit(me, 'staff.bulk_pin', { n: out.length, ids: out.map((x) => x.id) });
    return { list: out };
  });

  // Báo chủ quán khi người khác thêm nhân viên: ai thêm, thêm ai, bộ phận đó giờ bao nhiêu người (chủ quán 29/10)
  function tellOwner(me, id) {
    if (realRole(me) === 'owner') return;
    const s = db.prepare('SELECT s.name, s.role, s.team_id, t.name AS team FROM staff s LEFT JOIN teams t ON t.id = s.team_id WHERE s.id = ?').get(id);
    const n = s.team_id ? db.prepare('SELECT COUNT(*) AS n FROM staff WHERE active = 1 AND team_id = ?').get(s.team_id).n : 0;
    const all = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE active = 1 AND role != 'owner'").get().n;
    const by = db.prepare('SELECT s.name, s.role, t.name AS team FROM staff s LEFT JOIN teams t ON t.id = s.team_id WHERE s.id = ?').get(me.id);
    const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id);
    ctx.notify(owners, { title: `👤 ${by?.name || me.name} vừa thêm ${s.name}`, body: `${s.team || 'Chưa có bộ phận'} · ${ROLE_LABEL[s.role]}. ${s.team ? `${s.team} giờ có ${n} người · ` : ''}cả quán ${all} người. (Người thêm: ${ROLE_LABEL[by?.role] || ''}${by?.team ? ` ${by.team}` : ''})`, link: '/quan-ly' });
  }
  ctx.tellOwnerNewStaff = tellOwner;
  // Duyệt nhân viên mới đăng ký qua bot (quyền "Duyệt nhân viên mới"): tạo tài khoản + PIN ngẫu nhiên.
  // Không cần quyền "Thêm nhân viên" (chủ quán 29/10). Người duyệt dưới quản lý chỉ tạo Nhân viên / Tổ trưởng, không đặt lương.
  ctx.createStaffFromRequest = (me, body) => {
    const f = staffFields(body);
    const maxRank = realRole(me) === 'owner' ? rank('owner') : rank(realRole(me)) >= rank('manager') ? rank(realRole(me)) : rank('shift_lead');
    if (rank(f.role) >= maxRank) fail(403, `Bạn không thể tạo tài khoản ${ROLE_LABEL[f.role]}`);
    if (!canSetPay(me, { id: 0, role: f.role }) || rank(realRole(me)) < rank('manager')) { f.payType = 'hour'; f.payRate = 0; }
    let lookup = null, pin = '';
    for (let k = 0; k < 8 && !lookup; k++) { pin = String(Math.floor(100000 + Math.random() * 900000)); try { lookup = validatePin(db, pin, f.role); } catch { lookup = null; } }
    if (!lookup) fail(500, 'Không tạo được mã PIN, thử lại');
    const id = Number(db.prepare(`INSERT INTO staff (name, phone, role, team_id, pin_lookup, pay_type, pay_rate, weekly_limit_hours, zalo_user_id, must_change_pin, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(f.name, f.phone, f.role, f.teamId, lookup, f.payType, f.payRate, f.limit, f.zalo, ctx.now(), me.id).lastInsertRowid);
    if (f.positionId) db.prepare('UPDATE staff SET position_id = ? WHERE id = ?').run(f.positionId, id);
    ctx.audit(me, 'staff.create', { id, name: f.name, role: f.role, from: 'request' });
    return { id, pin };
  };

  r.post('/api/staff', 'manager', ({ me, body }) => {
    const f = staffFields(body);
    if (!canManage(me, f.role)) fail(403, `Bạn không thể tạo tài khoản ${ROLE_LABEL[f.role]}`);
    if (!canSetPay(me, { id: 0, role: f.role })) { f.payType = 'hour'; f.payRate = 0; } // người được nâng quyền không đặt lương (rà soát 28/10)
    const lookup = validatePin(db, body.pin, f.role);
    const id = tx(db, () => {
      const id = Number(db.prepare(`INSERT INTO staff (name, phone, role, team_id, pin_lookup, pay_type, pay_rate, weekly_limit_hours, zalo_user_id, must_change_pin, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(f.name, f.phone, f.role, f.teamId, lookup, f.payType, f.payRate, f.limit, f.zalo, ctx.now()).lastInsertRowid);
      saveSkills(id, body.skills);
      savePositionSkills(id, body.pskills);
      db.prepare('UPDATE staff SET position_id = ?, work_type = ?, created_by = ? WHERE id = ?').run(f.positionId, f.workType, me.id, id);
      return id;
    });
    ctx.audit(me, 'staff.create', { id, name: f.name, role: f.role });
    ctx.broadcast('staff');
    if (!body._from_request) try { tellOwner(me, id); } catch { /* không chặn */ }
    return { id };
  });

  r.patch('/api/staff/:id', 'manager', ({ me, params, body }) => {
    const cur = ctx.staff(params.id);
    if (!cur) fail(404, 'Không tìm thấy nhân viên');
    if (cur.id !== me.id && !canManage(me, cur.role)) fail(403, 'Bạn không thể sửa tài khoản này');
    const f = staffFields(body, cur);
    if (f.role !== cur.role && (cur.id === me.id || !canManage(me, f.role))) fail(403, 'Bạn không thể đổi sang vai trò này');
    const active = body.active === undefined ? cur.active : v.bool(body.active);
    if (cur.role === 'owner' && (!active || f.role !== 'owner')) {
      const owners = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND active = 1").get().n;
      if (owners <= 1) fail(400, 'Phải còn ít nhất một tài khoản Chủ');
    }
    // Đổi lương: ghi lịch sử theo tháng áp dụng; mức đang dùng = mức của tháng hiện tại (đặt trước cho tháng sau không đổi tháng này)
    const thisMonth = ctx.today().slice(0, 7);
    let payChanged = f.payType !== cur.pay_type || f.payRate !== cur.pay_rate || body.pay_from;
    const payOk = canSetPay(me, cur);
    if (payChanged && !payOk) {
      // Quản lý thật thấy lương nên báo rõ; người được nâng quyền (không thấy lương) thì giữ nguyên lương cũ (rà soát 28/10)
      if (rank(realRole(me)) >= rank('manager') && (f.payType !== cur.pay_type || f.payRate !== cur.pay_rate)) fail(403, cur.id === me.id ? 'Chỉ chủ quán đổi được lương của bạn' : 'Chỉ chủ quán đổi được lương của tài khoản này');
      f.payType = cur.pay_type; f.payRate = cur.pay_rate; payChanged = false;
    }
    if (payChanged) {
      const from = body.pay_from && /^\d{4}-\d{2}$/.test(body.pay_from) ? body.pay_from : thisMonth;
      if (!db.prepare('SELECT 1 FROM pay_history WHERE staff_id = ?').get(cur.id)) db.prepare("INSERT INTO pay_history (staff_id, from_month, pay_type, pay_rate, by_staff, at) VALUES (?, '0000-00', ?, ?, ?, ?)").run(cur.id, cur.pay_type || 'hour', cur.pay_rate || 0, me.id, ctx.now());
      db.prepare('INSERT INTO pay_history (staff_id, from_month, pay_type, pay_rate, by_staff, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (staff_id, from_month) DO UPDATE SET pay_type = excluded.pay_type, pay_rate = excluded.pay_rate, by_staff = excluded.by_staff, at = excluded.at')
        .run(cur.id, from, f.payType, f.payRate, me.id, ctx.now());
      const eff = payAt(cur.id, thisMonth);
      if (eff) { f.payType = eff.pay_type; f.payRate = eff.pay_rate; }
      ctx.audit(me, 'staff.pay_change', { id: cur.id, from, pay_type: f.payType, pay_rate: f.payRate });
    }
    tx(db, () => {
      db.prepare(`UPDATE staff SET name = ?, phone = ?, role = ?, team_id = ?, pay_type = ?, pay_rate = ?, weekly_limit_hours = ?, zalo_user_id = ?, active = ? WHERE id = ?`)
        .run(f.name, f.phone, f.role, f.teamId, f.payType, f.payRate, f.limit, f.zalo, active, cur.id);
      saveSkills(cur.id, body.skills);
      savePositionSkills(cur.id, body.pskills);
      db.prepare('UPDATE staff SET position_id = ?, work_type = ? WHERE id = ?').run(f.positionId, f.workType, cur.id);
      if (body.gender !== undefined) db.prepare('UPDATE staff SET gender = ? WHERE id = ?').run(v.oneOf(body.gender || '', ['', 'nam', 'nu'], { name: 'Giới tính' }), cur.id);
      if (body.home_zone_id !== undefined) {
        const hz = body.home_zone_id === null || body.home_zone_id === '' ? null : v.int(body.home_zone_id, { min: 1, name: 'Khu cố định' });
        if (hz && !db.prepare('SELECT 1 FROM zones WHERE id = ?').get(hz)) fail(400, 'Khu không tồn tại');
        db.prepare('UPDATE staff SET home_zone_id = ? WHERE id = ?').run(hz, cur.id);
        if (hz) db.prepare('UPDATE assignments SET zone_id = ? WHERE staff_id = ? AND date >= ?').run(hz, cur.id, ctx.today()); // ca từ hôm nay trở đi vào khu cố định
      }
      if (body.pay_rule !== undefined && payOk) db.prepare('UPDATE staff SET pay_rule = ? WHERE id = ?').run(body.pay_rule === null || body.pay_rule === '' ? null : (v.bool(body.pay_rule) ? 1 : 0), cur.id);
      if (body.pin) {
        db.prepare('UPDATE staff SET pin_lookup = ?, must_change_pin = 1 WHERE id = ?').run(validatePin(db, body.pin, f.role, cur.id), cur.id);
      }
      if (!active || body.pin) db.prepare('DELETE FROM sessions WHERE staff_id = ? AND staff_id != ?').run(cur.id, me.id);
      // Nghỉ việc (chủ quán 25/10): bỏ ca + lịch rảnh từ ngày mai, bỏ lịch cố định, gỡ liên kết Zalo bot. Giữ chấm công / lương cũ
      if (cur.active && !active) {
        const tomorrow = addDays(ctx.today(), 1);
        db.prepare("UPDATE leave_requests SET status = 'cancelled', decision_note = 'Nhân viên đã nghỉ việc' WHERE staff_id = ? AND status = 'pending' AND date >= ?").run(cur.id, tomorrow);
        db.prepare('DELETE FROM assignments WHERE staff_id = ? AND date >= ? AND NOT EXISTS (SELECT 1 FROM attendance x WHERE x.assignment_id = assignments.id)').run(cur.id, tomorrow);
        db.prepare('DELETE FROM availability WHERE staff_id = ? AND date >= ?').run(cur.id, tomorrow);
        db.prepare('DELETE FROM availability_fixed WHERE staff_id = ?').run(cur.id);
        try { db.prepare('DELETE FROM zalo_bot_users WHERE staff_id = ?').run(cur.id); } catch { /* chưa có bảng */ }
      }
    });
    if (cur.active && !active) { ctx.broadcast('schedule'); ctx.broadcast('availability'); }
    ctx.audit(me, 'staff.update', { id: cur.id, name: f.name, active, pin_reset: !!body.pin });
    ctx.broadcast('staff');
    return { ok: true };
  });

  // ---------- Sơ đồ tổ chức ----------
  r.get('/api/org', 'staff', ({ me }) => {
    const people = listStaff(me);
    const teams = db.prepare('SELECT id, name FROM teams WHERE active = 1 ORDER BY sort, id').all();
    const pick = (role) => people.filter((p) => p.role === role);
    return {
      owners: pick('owner'),
      managers: pick('manager'),
      shift_leads: pick('shift_lead'),
      teams: teams.map((t) => ({
        ...t,
        leads: people.filter((p) => p.role === 'team_lead' && p.team_id === t.id),
        members: people.filter((p) => p.role === 'staff' && p.team_id === t.id),
        backups: people.filter((p) => p.team_id !== t.id && p.skills.some((s) => s.team_id === t.id)),
      })),
      unassigned: people.filter((p) => ['team_lead', 'staff'].includes(p.role) && !p.team_id),
    };
  });
}

function rankSql() {
  return "CASE s.role WHEN 'owner' THEN 4 WHEN 'manager' THEN 3 WHEN 'shift_lead' THEN 2 WHEN 'team_lead' THEN 1 ELSE 0 END";
}
