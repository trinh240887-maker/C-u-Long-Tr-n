import { fail, v } from '../http.js';
import { tx, rank, ROLES, ROLE_LABEL } from '../db.js';
import { validatePin } from './auth.js';

export default function (r, ctx) {
  const { db } = ctx;

  const teamExists = (id) => id === null || db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id);

  // ---------- Tổ ----------
  r.get('/api/teams', 'staff', () => db.prepare('SELECT * FROM teams ORDER BY active DESC, sort, id').all());

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

  // ---------- Nhân viên ----------
  function listStaff(me, { includeInactive = false } = {}) {
    const canSeePay = rank(me.role) >= rank('manager');
    const rows = db.prepare(`SELECT s.*, t.name AS team_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id
      ${includeInactive ? '' : 'WHERE s.active = 1'} ORDER BY s.active DESC, ${rankSql()} DESC, t.sort, s.name`).all();
    const skills = db.prepare('SELECT staff_id, team_id, level FROM staff_skills').all();
    return rows.map((s) => ({
      id: s.id, name: s.name, phone: rank(me.role) >= rank('team_lead') ? s.phone : '',
      role: s.role, role_label: ROLE_LABEL[s.role], team_id: s.team_id, team_name: s.team_name || '',
      active: !!s.active, zalo_linked: !!s.zalo_user_id, weekly_limit_hours: s.weekly_limit_hours,
      skills: skills.filter((k) => k.staff_id === s.id).map(({ team_id, level }) => ({ team_id, level })),
      ...(canSeePay ? { pay_type: s.pay_type, pay_rate: s.pay_rate, zalo_user_id: s.zalo_user_id } : {}),
    }));
  }

  r.get('/api/staff', 'staff', ({ me, query }) => listStaff(me, { includeInactive: query.get('all') === '1' && rank(me.role) >= rank('manager') }));

  function canManage(me, role) {
    if (me.role === 'owner') return true;
    return rank(role) < rank(me.role);
  }

  function staffFields(body, current = {}) {
    const name = body.name === undefined ? current.name : v.text(body.name, { name: 'Tên', required: true, max: 60 });
    const phone = body.phone === undefined ? current.phone ?? '' : v.text(body.phone, { name: 'Số điện thoại', max: 20 });
    const role = body.role === undefined ? current.role ?? 'staff' : v.oneOf(body.role, ROLES, { name: 'Vai trò' });
    let teamId = body.team_id === undefined ? current.team_id ?? null : v.optInt(body.team_id, { min: 1, name: 'Tổ' });
    if (!teamExists(teamId)) fail(400, 'Tổ không tồn tại');
    const payType = body.pay_type === undefined ? current.pay_type ?? 'hour' : v.oneOf(body.pay_type, ['hour', 'shift'], { name: 'Cách tính lương' });
    const payRate = body.pay_rate === undefined ? current.pay_rate ?? 0 : v.int(body.pay_rate, { min: 0, max: 100_000_000, name: 'Mức lương' });
    const limit = body.weekly_limit_hours === undefined ? current.weekly_limit_hours ?? 48 : v.int(body.weekly_limit_hours, { min: 1, max: 100, name: 'Giới hạn giờ/tuần' });
    const zalo = body.zalo_user_id === undefined ? current.zalo_user_id ?? '' : v.text(body.zalo_user_id, { name: 'Zalo user ID', max: 64 });
    return { name, phone, role, teamId, payType, payRate, limit, zalo };
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

  r.post('/api/staff', 'manager', ({ me, body }) => {
    const f = staffFields(body);
    if (!canManage(me, f.role)) fail(403, `Bạn không thể tạo tài khoản ${ROLE_LABEL[f.role]}`);
    const lookup = validatePin(db, body.pin, f.role);
    const id = tx(db, () => {
      const id = Number(db.prepare(`INSERT INTO staff (name, phone, role, team_id, pin_lookup, pay_type, pay_rate, weekly_limit_hours, zalo_user_id, must_change_pin, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(f.name, f.phone, f.role, f.teamId, lookup, f.payType, f.payRate, f.limit, f.zalo, ctx.now()).lastInsertRowid);
      saveSkills(id, body.skills);
      return id;
    });
    ctx.audit(me, 'staff.create', { id, name: f.name, role: f.role });
    ctx.broadcast('staff');
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
    tx(db, () => {
      db.prepare(`UPDATE staff SET name = ?, phone = ?, role = ?, team_id = ?, pay_type = ?, pay_rate = ?, weekly_limit_hours = ?, zalo_user_id = ?, active = ? WHERE id = ?`)
        .run(f.name, f.phone, f.role, f.teamId, f.payType, f.payRate, f.limit, f.zalo, active, cur.id);
      saveSkills(cur.id, body.skills);
      if (body.pin) {
        db.prepare('UPDATE staff SET pin_lookup = ?, must_change_pin = 1 WHERE id = ?').run(validatePin(db, body.pin, f.role, cur.id), cur.id);
      }
      if (!active || body.pin) db.prepare('DELETE FROM sessions WHERE staff_id = ? AND staff_id != ?').run(cur.id, me.id);
    });
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
