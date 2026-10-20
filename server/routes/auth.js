import crypto from 'node:crypto';
import { fail } from '../http.js';
import { pinLookup, rank, ROLE_LABEL } from '../db.js';

export function pinRule(role) {
  return rank(role) >= rank('manager') ? { min: 6, label: '6 đến 8 chữ số' } : { min: 4, label: '4 đến 8 chữ số' };
}

export function validatePin(db, pin, role, exceptStaffId = null) {
  const s = String(pin ?? '');
  const rule = pinRule(role);
  if (!new RegExp(`^\\d{${rule.min},8}$`).test(s)) fail(400, `Mã PIN của ${ROLE_LABEL[role]} phải gồm ${rule.label}`);
  if (/^(\d)\1+$/.test(s) || '0123456789'.includes(s) || '9876543210'.includes(s)) fail(400, 'Mã PIN quá dễ đoán (số lặp lại hoặc liên tiếp)');
  const lookup = pinLookup(db, s);
  const taken = db.prepare('SELECT id FROM staff WHERE pin_lookup = ? AND id IS NOT ?').get(lookup, exceptStaffId);
  if (taken) fail(400, 'Mã PIN này đã có người dùng, hãy chọn mã khác');
  return lookup;
}

export default function (r, ctx) {
  const { db } = ctx;

  r.post('/api/login', null, ({ req, res, body, net }) => {
    ctx.loginGuard.check(net.ip);
    const pin = String(body.pin ?? '');
    const st = /^\d{4,8}$/.test(pin) ? db.prepare('SELECT * FROM staff WHERE pin_lookup = ? AND active = 1').get(pinLookup(db, pin)) : null;
    if (!st) { ctx.loginGuard.failed(net.ip); fail(401, 'Mã PIN không đúng'); }
    ctx.loginGuard.ok(net.ip);
    ctx.login(req, res, st);
    ctx.audit(st, 'login', net.remote ? `từ xa ${net.ip}` : net.ip);
    return { id: st.id, name: st.name, role: st.role };
  });

  r.post('/api/logout', null, ({ token, res }) => {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  });

  r.get('/api/me', 'staff', ({ me }) => {
    const team = me.team_id ? db.prepare('SELECT id, name FROM teams WHERE id = ?').get(me.team_id) : null;
    const skills = db.prepare('SELECT t.id, t.name, k.level FROM staff_skills k JOIN teams t ON t.id = k.team_id WHERE k.staff_id = ?').all(me.id);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE staff_id = ? AND read_at IS NULL').get(me.id).n;
    return {
      id: me.id, name: me.name, role: me.role, role_label: ROLE_LABEL[me.role], team, skills,
      must_change_pin: !!me.must_change_pin, zalo_linked: !!me.zalo_user_id, unread,
      shop_name: ctx.setting('shop_name'), today: ctx.today(),
      teams: db.prepare('SELECT id, name, min_staff FROM teams WHERE active = 1 ORDER BY sort, id').all(),
    };
  });

  r.post('/api/me/pin', 'staff', ({ me, body }) => {
    const current = db.prepare('SELECT pin_lookup FROM staff WHERE id = ?').get(me.id).pin_lookup;
    if (pinLookup(db, String(body.current_pin ?? '')) !== current) fail(400, 'Mã PIN hiện tại không đúng');
    const lookup = validatePin(db, body.new_pin, me.role, me.id);
    db.prepare('UPDATE staff SET pin_lookup = ?, must_change_pin = 0 WHERE id = ?').run(lookup, me.id);
    ctx.audit(me, 'pin.change');
    return { ok: true };
  });

  // Mã để nhân viên nhắn cho Zalo OA của quán, liên kết tài khoản nhận thông báo
  r.post('/api/me/zalo-code', 'staff', ({ me }) => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
    } while (db.prepare('SELECT 1 FROM staff WHERE zalo_link_code = ?').get(code));
    db.prepare('UPDATE staff SET zalo_link_code = ? WHERE id = ?').run(code, me.id);
    return { code };
  });

  r.get('/api/notifications', 'staff', ({ me }) => db.prepare(
    'SELECT id, title, body, link, urgent, created_at, read_at, zalo_status FROM notifications WHERE staff_id = ? ORDER BY id DESC LIMIT 100',
  ).all(me.id));

  r.post('/api/notifications/read', 'staff', ({ me }) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE staff_id = ? AND read_at IS NULL').run(ctx.now(), me.id);
    return { ok: true };
  });
}
