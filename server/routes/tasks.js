import { fail, v } from '../http.js';
import { rank } from '../db.js';

export default function (r, ctx) {
  const { db } = ctx;

  function parseDue(text) {
    if (!text) return null;
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/.exec(String(text));
    if (!m) fail(400, 'Hạn chót không hợp lệ');
    return ctx.clock().toEpoch(m[1], Number(m[2]) * 60 + Number(m[3]));
  }

  const visible = (me, t) =>
    rank(me.role) >= rank('shift_lead') || t.assignee_id === me.id || t.created_by === me.id ||
    (t.team_id && t.team_id === me.team_id && !t.assignee_id) || (me.role === 'team_lead' && t.team_id === me.team_id);

  r.get('/api/tasks', 'staff', ({ me, query }) => {
    const status = query.get('status');
    const rows = db.prepare(`SELECT k.*, a.name AS assignee_name, t.name AS team_name, c.name AS created_by_name, d.name AS done_by_name
      FROM tasks k LEFT JOIN staff a ON a.id = k.assignee_id LEFT JOIN teams t ON t.id = k.team_id
      LEFT JOIN staff c ON c.id = k.created_by LEFT JOIN staff d ON d.id = k.done_by
      WHERE ${status === 'open' ? "k.status != 'done'" : status ? 'k.status = ?' : '1'} AND (k.status != 'done' OR k.done_at > ?)
      ORDER BY CASE k.status WHEN 'done' THEN 1 ELSE 0 END, k.priority, COALESCE(k.due_at, 9e15), k.id DESC LIMIT 300`)
      .all(...(status && status !== 'open' ? [status] : []), ctx.now() - 14 * 86_400_000);
    return rows.filter((t) => visible(me, t)).map((t) => ({ ...t, overdue: t.status !== 'done' && t.due_at && t.due_at < ctx.now() }));
  });

  r.post('/api/tasks', 'team_lead', ({ me, body }) => {
    const title = v.text(body.title, { name: 'Tên việc', required: true, max: 120 });
    const detail = v.text(body.detail, { name: 'Mô tả', max: 1000 });
    const assignee = v.optInt(body.assignee_id, { min: 1, name: 'Người nhận' });
    const teamId = v.optInt(body.team_id, { min: 1, name: 'Tổ' });
    const priority = v.optInt(body.priority, { min: 1, max: 3, name: 'Mức ưu tiên' }) ?? 2;
    const dueAt = parseDue(body.due_at);
    const person = assignee ? ctx.staff(assignee) : null;
    if (assignee && (!person || !person.active)) fail(400, 'Người nhận không hợp lệ');
    if (me.role === 'team_lead') {
      const team = teamId ?? person?.team_id;
      if (team !== me.team_id) fail(403, 'Tổ trưởng chỉ giao việc trong tổ của mình');
    }
    if (!assignee && !teamId) fail(400, 'Chọn người nhận hoặc tổ nhận việc');
    const id = Number(db.prepare(`INSERT INTO tasks (title, detail, assignee_id, team_id, due_at, priority, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(title, detail, assignee, teamId ?? person?.team_id ?? null, dueAt, priority, me.id, ctx.now()).lastInsertRowid);
    const targets = assignee ? [assignee] : db.prepare('SELECT id FROM staff WHERE team_id = ? AND active = 1').all(teamId).map((x) => x.id);
    ctx.notify(targets.filter((x) => x !== me.id), {
      title: `Việc mới: ${title}`,
      body: [detail, dueAt ? `Hạn: ${ctx.clock().fmt(dueAt)}` : ''].filter(Boolean).join('\n'),
      link: '/viec', urgent: priority === 1,
    });
    ctx.audit(me, 'task.create', { id, title });
    ctx.broadcast('tasks');
    return { id };
  });

  r.patch('/api/tasks/:id', 'staff', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id);
    if (!t || !visible(me, t)) fail(404, 'Không tìm thấy việc');
    const isLead = rank(me.role) >= rank('shift_lead') || t.created_by === me.id;
    const status = body.status === undefined ? t.status : v.oneOf(body.status, ['todo', 'doing', 'done'], { name: 'Trạng thái' });
    let { title, detail, priority, due_at: dueAt, assignee_id: assignee } = t;
    if (isLead) {
      if (body.title !== undefined) title = v.text(body.title, { name: 'Tên việc', required: true, max: 120 });
      if (body.detail !== undefined) detail = v.text(body.detail, { name: 'Mô tả', max: 1000 });
      if (body.priority !== undefined) priority = v.int(body.priority, { min: 1, max: 3, name: 'Mức ưu tiên' });
      if (body.due_at !== undefined) dueAt = parseDue(body.due_at);
      if (body.assignee_id !== undefined) assignee = v.optInt(body.assignee_id, { min: 1, name: 'Người nhận' });
    }
    const doneNow = status === 'done' && t.status !== 'done';
    db.prepare('UPDATE tasks SET title = ?, detail = ?, priority = ?, due_at = ?, assignee_id = ?, status = ?, done_by = ?, done_at = ? WHERE id = ?')
      .run(title, detail, priority, dueAt, assignee, status, status === 'done' ? (doneNow ? me.id : t.done_by) : null, status === 'done' ? (doneNow ? ctx.now() : t.done_at) : null, t.id);
    if (doneNow && t.created_by && t.created_by !== me.id) ctx.notify(t.created_by, { title: `${me.name} đã xong: ${title}`, link: '/viec' });
    ctx.broadcast('tasks');
    return { ok: true };
  });

  r.delete('/api/tasks/:id', 'team_lead', ({ me, params }) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy việc');
    if (t.created_by !== me.id && rank(me.role) < rank('shift_lead')) fail(403, 'Bạn chỉ xoá được việc mình giao');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    ctx.audit(me, 'task.delete', { id: t.id, title: t.title });
    ctx.broadcast('tasks');
    return { ok: true };
  });
}
