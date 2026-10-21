import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { isDate } from '../lib/time.js';

const PHASES = ['open', 'during', 'close'];

export default function (r, ctx) {
  const { db } = ctx;

  function templates({ activeOnly = true } = {}) {
    const tpls = db.prepare(`SELECT c.*, t.name AS team_name, st.name AS shift_name FROM checklist_templates c LEFT JOIN teams t ON t.id = c.team_id
      LEFT JOIN shift_templates st ON st.id = c.shift_template_id
      ${activeOnly ? 'WHERE c.active = 1' : ''} ORDER BY t.sort, CASE c.phase WHEN 'open' THEN 0 WHEN 'during' THEN 1 ELSE 2 END, c.sort, c.id`).all();
    const items = db.prepare('SELECT * FROM checklist_items ORDER BY sort, id').all();
    return tpls.map((c) => ({ ...c, active: !!c.active, items: items.filter((i) => i.template_id === c.id).map((i) => ({ ...i, required: !!i.required })) }));
  }

  r.get('/api/checklist-templates', 'staff', ({ query }) => templates({ activeOnly: query.get('all') !== '1' }));

  function saveItems(templateId, items) {
    if (!Array.isArray(items) || !items.length) fail(400, 'Checklist cần ít nhất một việc');
    if (items.length > 60) fail(400, 'Tối đa 60 việc trong một checklist');
    const existing = new Set(db.prepare('SELECT id FROM checklist_items WHERE template_id = ?').all(templateId).map((x) => x.id));
    const keep = new Set();
    items.forEach((it, i) => {
      const text = v.text(it.text, { name: 'Tên việc', required: true, max: 120 });
      const kind = v.oneOf(it.kind ?? 'check', ['check', 'number', 'text'], { name: 'Kiểu việc' });
      const unit = v.text(it.unit, { name: 'Đơn vị', max: 12 });
      const required = it.required === undefined ? 1 : v.bool(it.required);
      if (it.id && existing.has(Number(it.id))) {
        db.prepare('UPDATE checklist_items SET text = ?, kind = ?, unit = ?, required = ?, sort = ? WHERE id = ?').run(text, kind, unit, required, i, Number(it.id));
        keep.add(Number(it.id));
      } else {
        db.prepare('INSERT INTO checklist_items (template_id, text, kind, unit, required, sort) VALUES (?, ?, ?, ?, ?, ?)').run(templateId, text, kind, unit, required, i);
      }
    });
    for (const id of existing) if (!keep.has(id)) db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id);
  }

  function tplFields(body, cur = {}) {
    const title = body.title === undefined ? cur.title : v.text(body.title, { name: 'Tên checklist', required: true, max: 80 });
    const teamId = body.team_id === undefined ? cur.team_id ?? null : v.optInt(body.team_id, { min: 1, name: 'Tổ' });
    if (teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) fail(400, 'Tổ không tồn tại');
    const phase = body.phase === undefined ? cur.phase ?? 'open' : v.oneOf(body.phase, PHASES, { name: 'Thời điểm' });
    const shiftId = body.shift_template_id === undefined ? cur.shift_template_id ?? null : v.optInt(body.shift_template_id, { min: 1, name: 'Ca' });
    if (shiftId && !db.prepare('SELECT 1 FROM shift_templates WHERE id = ?').get(shiftId)) fail(400, 'Loại ca không tồn tại');
    return { title, teamId, phase, shiftId };
  }

  // Tổ trưởng chỉ tạo/sửa checklist của tổ mình; trưởng ca trở lên sửa mọi tổ và checklist "Cả quán"
  function canEditTpl(me, teamId) {
    if (rank(me.role) >= rank('shift_lead')) return;
    if (me.role === 'team_lead' && teamId && teamId === me.team_id) return;
    fail(403, me.role === 'team_lead' ? 'Tổ trưởng chỉ tạo và sửa checklist của tổ mình' : 'Bạn không có quyền sửa checklist');
  }

  r.post('/api/checklist-templates', 'team_lead', ({ me, body }) => {
    const f = tplFields(body);
    canEditTpl(me, f.teamId);
    const id = tx(db, () => {
      const id = Number(db.prepare('INSERT INTO checklist_templates (team_id, phase, title, shift_template_id) VALUES (?, ?, ?, ?)').run(f.teamId, f.phase, f.title, f.shiftId).lastInsertRowid);
      saveItems(id, body.items);
      return id;
    });
    ctx.audit(me, 'checklist.create', f.title);
    ctx.broadcast('checklists');
    return { id };
  });

  r.patch('/api/checklist-templates/:id', 'team_lead', ({ me, params, body }) => {
    const cur = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, cur.team_id);
    const f = tplFields(body, cur);
    canEditTpl(me, f.teamId);
    const active = body.active === undefined ? cur.active : v.bool(body.active);
    tx(db, () => {
      db.prepare('UPDATE checklist_templates SET team_id = ?, phase = ?, title = ?, shift_template_id = ?, active = ? WHERE id = ?').run(f.teamId, f.phase, f.title, f.shiftId, active, cur.id);
      if (body.items !== undefined) saveItems(cur.id, body.items);
    });
    ctx.audit(me, 'checklist.update', { id: cur.id, title: f.title });
    ctx.broadcast('checklists');
    return { ok: true };
  });

  // ---------- Checklist trong ngày ----------
  // Nhân viên chỉ thấy checklist của tổ mình và của loại ca mình làm hôm đó; trưởng ca trở lên thấy hết
  function myScope(me, date) {
    if (rank(me.role) >= rank('shift_lead')) return null;
    const teams = new Set(me.team_id ? [me.team_id] : []);
    const shifts = new Set();
    const rows = db.prepare(`SELECT a.team_id, a.template_id, a.label FROM assignments a WHERE a.staff_id = ? AND a.date = ?
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')`).all(me.id, date);
    const byName = new Map(db.prepare('SELECT id, name FROM shift_templates').all().map((t) => [t.name, t.id]));
    for (const a of rows) {
      if (a.team_id) teams.add(a.team_id);
      if (a.template_id) shifts.add(a.template_id);
      else if (byName.has(a.label)) shifts.add(byName.get(a.label));
    }
    return { teams, shifts };
  }
  const inScope = (scope, t) => !scope || ((t.team_id === null || scope.teams.has(t.team_id)) && (t.shift_template_id === null || scope.shifts.has(t.shift_template_id)));

  function dayView(date, scope) {
    const tpls = templates().filter((t) => inScope(scope, t));
    const ensure = db.prepare('INSERT OR IGNORE INTO checklist_runs (template_id, date) VALUES (?, ?)');
    const getRun = db.prepare('SELECT * FROM checklist_runs WHERE template_id = ? AND date = ?');
    const entries = db.prepare(`SELECT e.*, s.name AS done_by_name FROM checklist_entries e LEFT JOIN staff s ON s.id = e.done_by WHERE e.run_id = ?`);
    return tpls.map((t) => {
      ensure.run(t.id, date);
      const run = getRun.get(t.id, date);
      const byItem = new Map(entries.all(run.id).map((e) => [e.item_id, e]));
      const items = t.items.map((i) => ({ ...i, entry: byItem.get(i.id) || null }));
      const required = items.filter((i) => i.required);
      return {
        run_id: run.id, template_id: t.id, title: t.title, phase: t.phase, team_id: t.team_id, team_name: t.team_name || 'Cả quán',
        shift_template_id: t.shift_template_id, shift_name: t.shift_name || '',
        completed_at: run.completed_at, items,
        done: required.filter((i) => i.entry).length, total: required.length,
      };
    });
  }
  ctx.checklistDay = (date) => dayView(date, null);

  r.get('/api/checklists', 'staff', ({ me, query }) => {
    const date = query.get('date') || ctx.today();
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    return { date, runs: dayView(date, myScope(me, date)) };
  });

  r.post('/api/checklists/entry', 'staff', ({ me, body }) => {
    const runId = v.int(body.run_id, { min: 1, name: 'Checklist' });
    const itemId = v.int(body.item_id, { min: 1, name: 'Việc' });
    const run = db.prepare('SELECT r.*, t.team_id, t.shift_template_id FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id WHERE r.id = ?').get(runId);
    if (!run) fail(404, 'Không tìm thấy checklist');
    const item = db.prepare('SELECT * FROM checklist_items WHERE id = ? AND template_id = ?').get(itemId, run.template_id);
    if (!item) fail(404, 'Không tìm thấy việc');
    if (!inScope(myScope(me, run.date), run)) fail(403, 'Checklist này không thuộc tổ hoặc ca của bạn hôm nay');
    if (run.date < ctx.today() && rank(me.role) < rank('shift_lead')) fail(403, 'Checklist ngày cũ chỉ trưởng ca trở lên mới sửa được');
    const done = body.done === undefined ? true : v.bool(body.done);
    tx(db, () => {
      if (!done) {
        db.prepare('DELETE FROM checklist_entries WHERE run_id = ? AND item_id = ?').run(runId, itemId);
      } else {
        let value = v.text(body.value, { name: 'Giá trị', max: 300 });
        if (item.kind === 'number') {
          value = value.replace(',', '.');
          if (!/^-?\d+(\.\d+)?$/.test(value)) fail(400, `Nhập số cho "${item.text}"`);
        }
        if (item.kind === 'text' && item.required && !value) fail(400, `Nhập nội dung cho "${item.text}"`);
        db.prepare(`INSERT INTO checklist_entries (run_id, item_id, value, done_by, done_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (run_id, item_id) DO UPDATE SET value = excluded.value, done_by = excluded.done_by, done_at = excluded.done_at`)
          .run(runId, itemId, value, me.id, ctx.now());
      }
      const left = db.prepare(`SELECT COUNT(*) AS n FROM checklist_items i WHERE i.template_id = ? AND i.required = 1
        AND NOT EXISTS (SELECT 1 FROM checklist_entries e WHERE e.run_id = ? AND e.item_id = i.id)`).get(run.template_id, runId).n;
      if (left === 0 && !run.completed_at) db.prepare('UPDATE checklist_runs SET completed_at = ?, completed_by = ? WHERE id = ?').run(ctx.now(), me.id, runId);
      if (left > 0 && run.completed_at) db.prepare('UPDATE checklist_runs SET completed_at = NULL, completed_by = NULL WHERE id = ?').run(runId);
    });
    ctx.broadcast('checklists');
    return { ok: true };
  });
}
