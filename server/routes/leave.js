import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { overlaps } from '../lib/time.js';
import { busyAround, weekMinutes, rangeOf, groupSegments } from '../lib/schedule.js';
import { suggestReplacements } from '../lib/replacement.js';
import { describeGroup } from './schedule.js';

export default function (r, ctx) {
  const { db } = ctx;

  function loadLeave(id) {
    const l = db.prepare(`SELECT l.*, s.name AS staff_name, s.team_id AS staff_team FROM leave_requests l JOIN staff s ON s.id = l.staff_id WHERE l.id = ?`).get(id);
    if (!l) fail(404, 'Không tìm thấy đơn nghỉ');
    return l;
  }

  function shiftInfo(groupId) {
    const segs = groupSegments(db, groupId);
    if (!segs.length) return null;
    const team = segs[0].team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(segs[0].team_id) : null;
    return { date: segs[0].date, team_id: segs[0].team_id, team_name: team?.name || '', label: segs[0].label, text: describeGroup(segs), segments: segs };
  }

  function canSee(me, leave) {
    if (leave.staff_id === me.id) return true;
    if (rank(me.role) >= rank('shift_lead')) return true;
    const info = shiftInfo(leave.group_id);
    return me.role === 'team_lead' && (me.team_id === leave.staff_team || me.team_id === info?.team_id);
  }

  function shiftLabel(info) {
    return `${info.date.slice(8)}/${info.date.slice(5, 7)} ${info.label ? info.label + ' ' : ''}${info.text}`;
  }

  // ---------- Xin nghỉ ----------
  r.post('/api/leave', 'staff', ({ me, body }) => {
    const groupId = String(body.group_id || '');
    const info = shiftInfo(groupId);
    if (!info) fail(404, 'Không tìm thấy ca');
    const owner = info.segments[0].staff_id;
    if (owner !== me.id && rank(me.role) < rank('shift_lead')) fail(403, 'Bạn chỉ xin nghỉ được ca của mình');
    const clock = ctx.clock();
    if (rangeOf(clock, info.segments.at(-1)).end < ctx.now()) fail(400, 'Ca này đã qua');
    const reason = v.text(body.reason, { name: 'Lý do', max: 300, required: true });
    const id = tx(db, () => {
      if (db.prepare("SELECT 1 FROM leave_requests WHERE group_id = ? AND status IN ('pending','approved')").get(groupId)) fail(409, 'Ca này đã có đơn nghỉ');
      return Number(db.prepare('INSERT INTO leave_requests (staff_id, group_id, date, reason, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(owner, groupId, info.date, reason, ctx.now()).lastInsertRowid);
    });
    const person = ctx.staff(owner);
    const urgent = rangeOf(clock, info.segments[0]).start - ctx.now() < 12 * 3600_000;
    ctx.notify(ctx.leadsOf(info.team_id ?? person.team_id).filter((x) => x !== me.id), {
      title: `${person.name} xin nghỉ ${shiftLabel(info)}`,
      body: `Lý do: ${reason}\nCần tìm người làm thay.`, link: `/nghi`, urgent,
    });
    ctx.audit(me, 'leave.create', { id, groupId });
    ctx.broadcast('leave');
    return { id };
  });

  r.get('/api/leave', 'staff', ({ me, query }) => {
    const status = query.get('status');
    const rows = db.prepare(`SELECT l.*, s.name AS staff_name, s.team_id AS staff_team, rp.name AS replacement_name, d.name AS decided_by_name
      FROM leave_requests l JOIN staff s ON s.id = l.staff_id LEFT JOIN staff rp ON rp.id = l.replacement_id LEFT JOIN staff d ON d.id = l.decided_by
      ${status ? 'WHERE l.status = ?' : ''} ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.date DESC, l.id DESC LIMIT 200`)
      .all(...(status ? [status] : []));
    const offers = db.prepare('SELECT o.*, s.name AS staff_name FROM cover_offers o JOIN staff s ON s.id = o.staff_id WHERE o.leave_id = ?');
    return rows.filter((l) => canSee(me, l)).map((l) => ({ ...l, shift: shiftInfo(l.group_id), offers: offers.all(l.id) }));
  });

  r.post('/api/leave/:id/cancel', 'staff', ({ me, params }) => {
    const l = loadLeave(params.id);
    if (l.staff_id !== me.id && rank(me.role) < rank('manager')) fail(403, 'Bạn không huỷ được đơn này');
    if (l.status !== 'pending') fail(409, 'Chỉ huỷ được đơn đang chờ duyệt');
    tx(db, () => {
      db.prepare("UPDATE leave_requests SET status = 'cancelled', decided_at = ? WHERE id = ?").run(ctx.now(), l.id);
      db.prepare("UPDATE cover_offers SET status = 'closed' WHERE leave_id = ? AND status IN ('invited','accepted')").run(l.id);
    });
    ctx.audit(me, 'leave.cancel', l.id);
    ctx.broadcast('leave');
    return { ok: true };
  });

  // ---------- Gợi ý người làm thay ----------
  function suggestions(l) {
    const info = shiftInfo(l.group_id);
    if (!info) fail(404, 'Ca của đơn này không còn');
    const clock = ctx.clock();
    const candidates = db.prepare("SELECT id, name, team_id, weekly_limit_hours FROM staff WHERE active = 1 AND role != 'owner'").all();
    const skills = db.prepare('SELECT staff_id, team_id, level FROM staff_skills').all();
    for (const c of candidates) c.skills = Object.fromEntries(skills.filter((k) => k.staff_id === c.id).map((k) => [k.team_id, k.level]));
    const onLeave = new Set(db.prepare("SELECT staff_id FROM leave_requests WHERE date = ? AND status IN ('pending','approved') AND id != ?").all(info.date, l.id).map((x) => x.staff_id));
    const list = suggestReplacements({
      shift: { team_id: info.team_id ?? l.staff_team, ranges: info.segments.map((s) => rangeOf(clock, s)) },
      candidates,
      busy: busyAround(db, clock, info.date),
      onLeave,
      weekMinutes: weekMinutes(db, info.date),
      excludeId: l.staff_id,
    });
    const offers = new Map(db.prepare('SELECT staff_id, status FROM cover_offers WHERE leave_id = ?').all(l.id).map((o) => [o.staff_id, o.status]));
    return { shift: info, candidates: list.map((c) => ({ ...c, offer: offers.get(c.staff_id) || null })) };
  }

  function requireLead(me, l) {
    if (rank(me.role) >= rank('shift_lead')) return;
    const info = shiftInfo(l.group_id);
    if (me.role === 'team_lead' && (me.team_id === l.staff_team || me.team_id === info?.team_id)) return;
    fail(403, 'Chỉ tổ trưởng, trưởng ca hoặc quản lý mới làm được việc này');
  }

  r.get('/api/leave/:id/suggestions', 'team_lead', ({ me, params }) => {
    const l = loadLeave(params.id);
    requireLead(me, l);
    return suggestions(l);
  });

  r.post('/api/leave/:id/invite', 'team_lead', ({ me, params, body }) => {
    const l = loadLeave(params.id);
    requireLead(me, l);
    if (l.status !== 'pending') fail(409, 'Đơn này đã được xử lý');
    const ids = Array.isArray(body.staff_ids) ? body.staff_ids.map((x) => v.int(x, { min: 1, name: 'Nhân viên' })) : [];
    if (!ids.length) fail(400, 'Chọn ít nhất một người');
    const { shift, candidates } = suggestions(l);
    const ok = new Set(candidates.filter((c) => c.eligible).map((c) => c.staff_id));
    const bad = ids.filter((id) => !ok.has(id));
    if (bad.length) fail(400, 'Có người không phù hợp ca này (trùng giờ, nghỉ, hoặc chưa biết việc)');
    const add = db.prepare("INSERT INTO cover_offers (leave_id, staff_id, invited_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (leave_id, staff_id) DO UPDATE SET status = 'invited', created_at = excluded.created_at");
    tx(db, () => { for (const id of ids) add.run(l.id, id, me.id, ctx.now()); });
    ctx.notify(ids, {
      title: `Nhờ làm thay ca ${shiftLabel(shift)}`,
      body: `${shift.team_name ? `Vị trí: ${shift.team_name}. ` : ''}Thay cho ${l.staff_name}. Mở app để nhận hoặc từ chối.`,
      link: '/', urgent: true,
    });
    ctx.audit(me, 'leave.invite', { id: l.id, ids });
    ctx.broadcast('leave');
    return { invited: ids.length };
  });

  r.get('/api/offers/me', 'staff', ({ me }) => db.prepare(`SELECT o.id, o.status, o.created_at, l.id AS leave_id, l.group_id, s.name AS for_name
      FROM cover_offers o JOIN leave_requests l ON l.id = o.leave_id JOIN staff s ON s.id = l.staff_id
      WHERE o.staff_id = ? AND o.status IN ('invited','accepted') AND l.status = 'pending' ORDER BY o.id DESC`).all(me.id)
    .map((o) => ({ ...o, shift: shiftInfo(o.group_id) })).filter((o) => o.shift));

  r.post('/api/offers/:id/respond', 'staff', ({ me, params, body }) => {
    const o = db.prepare('SELECT * FROM cover_offers WHERE id = ? AND staff_id = ?').get(params.id, me.id);
    if (!o) fail(404, 'Không tìm thấy lời nhờ');
    const l = loadLeave(o.leave_id);
    if (l.status !== 'pending') fail(409, 'Ca này đã có người xử lý');
    const accept = v.bool(body.accept);
    if (accept) {
      const { candidates } = suggestions(l);
      const mine = candidates.find((c) => c.staff_id === me.id);
      if (!mine?.eligible) fail(409, `Bạn không nhận được ca này: ${mine?.reasons.join(', ') || 'không phù hợp'}`);
    }
    db.prepare('UPDATE cover_offers SET status = ?, answered_at = ? WHERE id = ?').run(accept ? 'accepted' : 'declined', ctx.now(), o.id);
    const info = shiftInfo(l.group_id);
    ctx.notify([...ctx.managers(), o.invited_by].filter((x) => x && x !== me.id), {
      title: accept ? `${me.name} nhận làm thay ${l.staff_name}` : `${me.name} không nhận ca thay ${l.staff_name}`,
      body: `Ca ${shiftLabel(info)}${accept ? '. Chờ quản lý duyệt.' : ''}`, link: '/nghi',
    });
    ctx.audit(me, accept ? 'offer.accept' : 'offer.decline', o.id);
    ctx.broadcast('leave');
    return { ok: true };
  });

  // ---------- Duyệt đơn nghỉ (quản lý) ----------
  r.post('/api/leave/:id/decide', 'manager', ({ me, params, body }) => {
    const l = loadLeave(params.id);
    if (l.status !== 'pending') fail(409, 'Đơn này đã được xử lý');
    const approve = v.bool(body.approve);
    const note = v.text(body.note, { name: 'Ghi chú', max: 300 });
    const replacementId = approve ? v.optInt(body.replacement_id, { min: 1, name: 'Người làm thay' }) : null;
    const info = shiftInfo(l.group_id);
    const clock = ctx.clock();
    tx(db, () => {
      if (replacementId) {
        const { candidates } = suggestions(l);
        const c = candidates.find((x) => x.staff_id === replacementId);
        if (!c?.eligible) fail(409, `Không xếp được người này: ${c?.reasons.join(', ') || 'không phù hợp'}`);
        const groupId = crypto.randomBytes(8).toString('hex');
        const insert = db.prepare(`INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, template_id, label, note, created_by, created_at, zone_id, tables_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const s of info.segments) {
          const busy = busyAround(db, clock, info.date).get(replacementId) || [];
          if (busy.some((b) => overlaps(rangeOf(clock, s), b))) fail(409, 'Người làm thay vừa bị trùng ca');
          insert.run(groupId, replacementId, s.team_id, s.date, s.start_min, s.end_min, s.template_id, s.label, `Làm thay ${l.staff_name}`, me.id, ctx.now(), s.zone_id, s.tables_text);
        }
        db.prepare("UPDATE cover_offers SET status = CASE WHEN staff_id = ? THEN 'accepted' ELSE 'closed' END WHERE leave_id = ? AND status IN ('invited','accepted')").run(replacementId, l.id);
      } else {
        db.prepare("UPDATE cover_offers SET status = 'closed' WHERE leave_id = ? AND status IN ('invited','accepted')").run(l.id);
      }
      db.prepare('UPDATE leave_requests SET status = ?, replacement_id = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?')
        .run(approve ? 'approved' : 'rejected', replacementId, me.id, ctx.now(), note, l.id);
    });
    const label = shiftLabel(info);
    ctx.notify(l.staff_id, {
      title: approve ? `Đã duyệt nghỉ ca ${label}` : `Không duyệt nghỉ ca ${label}`,
      body: [replacementId ? `Người làm thay: ${ctx.staff(replacementId).name}` : '', note].filter(Boolean).join('\n'), link: '/',
    });
    if (replacementId) {
      ctx.notify(replacementId, { title: `Bạn có ca mới: ${label}`, body: `Làm thay ${l.staff_name}${info.team_name ? ` (${info.team_name})` : ''}.`, link: '/lich', urgent: true });
    }
    ctx.audit(me, approve ? 'leave.approve' : 'leave.reject', { id: l.id, replacementId });
    ctx.broadcast('leave');
    ctx.broadcast('schedule');
    return { ok: true };
  });

}
