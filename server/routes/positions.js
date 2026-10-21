import { fail, v } from '../http.js';
import { tx } from '../db.js';

// Bộ phận (bảng teams) chia thành vị trí, vd Bếp: Steak, Lẩu, Nướng… Vị trí chọn theo từng ca.
export default function (r, ctx) {
  const { db } = ctx;

  const positionsOf = (teamId) => db.prepare('SELECT * FROM positions WHERE team_id = ? AND active = 1 ORDER BY sort, id').all(teamId);
  ctx.positionsOf = positionsOf;

  r.get('/api/positions', 'staff', ({ query }) => db.prepare(`SELECT p.*, t.name AS team_name FROM positions p JOIN teams t ON t.id = p.team_id
    ${query.get('all') === '1' ? '' : 'WHERE p.active = 1'} ORDER BY t.sort, t.id, p.sort, p.id`).all());

  function addPosition(teamId, name, min = 0) {
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM positions WHERE team_id = ?').get(teamId).s;
    return Number(db.prepare('INSERT INTO positions (team_id, name, sort, min_staff) VALUES (?, ?, ?, ?)').run(teamId, name, sort, min).lastInsertRowid);
  }

  r.post('/api/positions', 'manager', ({ me, body }) => {
    const teamId = v.int(body.team_id, { min: 1, name: 'Bộ phận' });
    if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) fail(400, 'Bộ phận không tồn tại');
    const name = v.text(body.name, { name: 'Tên vị trí', required: true, max: 40 });
    if (db.prepare('SELECT 1 FROM positions WHERE team_id = ? AND name = ? AND active = 1').get(teamId, name)) fail(409, `Đã có vị trí "${name}"`);
    const min = v.optInt(body.min_staff, { min: 0, max: 100, name: 'Số người tối thiểu' }) ?? 0;
    const id = addPosition(teamId, name, min);
    ctx.audit(me, 'position.create', { team_id: teamId, name });
    ctx.broadcast('teams');
    return { id };
  });

  r.patch('/api/positions/:id', 'manager', ({ me, params, body }) => {
    const p = db.prepare('SELECT * FROM positions WHERE id = ?').get(params.id);
    if (!p) fail(404, 'Không tìm thấy vị trí');
    db.prepare('UPDATE positions SET name = ?, min_staff = ?, sort = ?, active = ? WHERE id = ?').run(
      body.name === undefined ? p.name : v.text(body.name, { name: 'Tên vị trí', required: true, max: 40 }),
      body.min_staff === undefined ? p.min_staff : v.int(body.min_staff, { min: 0, max: 100, name: 'Số người tối thiểu' }),
      body.sort === undefined ? p.sort : v.int(body.sort, { name: 'Thứ tự' }),
      body.active === undefined ? p.active : v.bool(body.active), p.id,
    );
    ctx.audit(me, 'position.update', { id: p.id });
    ctx.broadcast('teams');
    return { ok: true };
  });

  // Gộp nhiều tổ thành 1 bộ phận (dùng cho nút Gộp và tự gộp tổ bếp lần đầu)
  function combineTeams(name, sources, rename = {}) {
    return tx(db, () => {
      // Bộ phận đích: tổ trùng tên nếu có, không thì lấy tổ đầu tiên đổi tên
      const target = db.prepare('SELECT * FROM teams WHERE name = ? AND active = 1').get(name) || sources[0];
      db.prepare('UPDATE teams SET name = ?, active = 1 WHERE id = ?').run(name, target.id);
      const moved = [];
      for (const t of sources) {
        const existing = db.prepare('SELECT id FROM positions WHERE team_id = ? AND name = ? AND active = 1').get(target.id, rename[t.name.trim().toLowerCase()] || t.name);
        const posId = existing?.id ?? addPosition(target.id, rename[t.name.trim().toLowerCase()] || t.name, t.min_staff);
        const where = t.id === target.id ? 'team_id = ? AND position_id IS NULL' : 'team_id = ?';
        db.prepare(`UPDATE staff SET team_id = ?, position_id = ? WHERE ${where}`).run(target.id, posId, t.id);
        db.prepare(`UPDATE assignments SET team_id = ?, position_id = ? WHERE ${where}`).run(target.id, posId, t.id);
        db.prepare(`UPDATE checklist_templates SET team_id = ?, position_id = ? WHERE ${where}`).run(target.id, posId, t.id);
        // Kỹ năng phụ của tổ cũ thành kỹ năng của vị trí
        for (const k of db.prepare('SELECT staff_id, level FROM staff_skills WHERE team_id = ?').all(t.id)) {
          db.prepare('INSERT OR REPLACE INTO position_skills (staff_id, position_id, level) VALUES (?, ?, MAX(?, COALESCE((SELECT level FROM position_skills WHERE staff_id = ? AND position_id = ?), 0)))')
            .run(k.staff_id, posId, k.level, k.staff_id, posId);
        }
        if (t.id !== target.id) {
          db.prepare('UPDATE tasks SET team_id = ? WHERE team_id = ?').run(target.id, t.id);
          db.prepare('UPDATE stores SET team_id = ? WHERE team_id = ?').run(target.id, t.id);
          db.prepare('DELETE FROM staff_skills WHERE team_id = ?').run(t.id);
          db.prepare('UPDATE teams SET active = 0 WHERE id = ?').run(t.id);
        }
        moved.push(t.name);
      }
      // Người thuộc bộ phận rồi không cần kỹ năng phụ của chính bộ phận đó
      db.prepare('DELETE FROM staff_skills WHERE team_id = ? AND staff_id IN (SELECT id FROM staff WHERE team_id = ?)').run(target.id, target.id);
      const min = db.prepare('SELECT COALESCE(SUM(min_staff), 0) AS m FROM positions WHERE team_id = ? AND active = 1').get(target.id).m;
      db.prepare('UPDATE teams SET min_staff = MAX(min_staff, ?) WHERE id = ?').run(min, target.id);
      return { id: target.id, positions: moved };
    });
  }

  // Gộp nhiều tổ thành 1 bộ phận: mỗi tổ cũ thành 1 vị trí, người/ca/checklist/việc/kho chuyển theo.
  r.post('/api/teams/combine', 'manager', ({ me, body }) => {
    const name = v.text(body.name, { name: 'Tên bộ phận', required: true, max: 40 });
    const ids = [...new Set((Array.isArray(body.team_ids) ? body.team_ids : []).map((x) => v.int(x, { min: 1, name: 'Tổ' })))];
    if (!ids.length) fail(400, 'Chọn ít nhất 1 tổ để gộp');
    const sources = ids.map((id) => db.prepare('SELECT * FROM teams WHERE id = ?').get(id) || fail(400, 'Tổ không tồn tại'));
    const result = combineTeams(name, sources);
    ctx.audit(me, 'team.combine', { name, from: result.positions });
    ctx.broadcast('teams');
    ctx.broadcast('staff');
    ctx.broadcast('schedule');
    return result;
  });

  // Tự gộp các tổ bếp cũ thành bộ phận "Bếp" một lần (chủ quán chốt 21/10: Bếp chọn chung, vị trí chia theo ca).
  // Chỉ chạy khi có từ 3 tổ bếp trở lên, để không đụng dữ liệu mẫu/test.
  const KITCHEN = { 'bếp': 'Bếp', 'bếp steak': 'Steak', 'steak': 'Steak', 'lẩu': 'Lẩu', 'nướng': 'Nướng', 'topping': 'Topping', 'thái tay': 'Thái tay', 'tiếp thực': 'Tiếp thực' };
  if (!ctx.setting('kitchen_merged')) {
    const found = db.prepare('SELECT * FROM teams WHERE active = 1 ORDER BY sort, id').all()
      .filter((t) => KITCHEN[t.name.trim().toLowerCase()]);
    if (found.length >= 3) {
      // Tổ "Bếp" (nếu có) hoặc "Bếp steak" làm gốc để giữ kho và lịch sử
      found.sort((x, y) => ['bếp', 'bếp steak'].indexOf(y.name.trim().toLowerCase()) - ['bếp', 'bếp steak'].indexOf(x.name.trim().toLowerCase()));
      const res = combineTeams('Bếp', found, KITCHEN);
      const bep = res.id;
      if (!db.prepare("SELECT 1 FROM positions WHERE team_id = ? AND name = 'Nướng' AND active = 1").get(bep)) addPosition(bep, 'Nướng', 0);
      // Tổ "Bếp" gốc không phải vị trí: bỏ vị trí trùng tên bộ phận nếu không ai dùng
      db.prepare("UPDATE positions SET active = 0 WHERE team_id = ? AND name = 'Bếp' AND id NOT IN (SELECT position_id FROM staff WHERE position_id IS NOT NULL) AND id NOT IN (SELECT position_id FROM assignments WHERE position_id IS NOT NULL)").run(bep);
      ctx.audit(null, 'team.combine.auto', res.positions);
    }
    ctx.setSetting('kitchen_merged', '1');
  }

  // Kiểm tra vị trí khi xếp ca / lưu nhân viên: phải thuộc đúng bộ phận
  ctx.readPosition = (value, teamId) => {
    const id = v.optInt(value, { min: 1, name: 'Vị trí' });
    if (!id) return null;
    const p = db.prepare('SELECT * FROM positions WHERE id = ? AND active = 1').get(id);
    if (!p) fail(400, 'Vị trí không tồn tại');
    if (teamId && p.team_id !== Number(teamId)) fail(400, `Vị trí "${p.name}" không thuộc bộ phận này`);
    return id;
  };
}
