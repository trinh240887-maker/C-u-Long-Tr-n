import { fail, v } from '../http.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { tx, rank } from '../db.js';
import { addDays, isDate, fmtHM } from '../lib/time.js';
import { rangeOf } from '../lib/schedule.js';
import { computeTimesheet } from '../lib/payroll.js';

export default function (r, ctx) {
  const { db } = ctx;
  const num = (k, d) => Number(ctx.setting(k) || d);
  // Chủ quán 25/10: không có phụ cấp làm đêm (làm đúng ca). Đặt lại > 0 ở Cài đặt nếu sau này cần
  if (!ctx.setting('night_bonus_off_v1')) { ctx.setSetting('night_bonus_pct', '0'); ctx.setSetting('night_bonus_off_v1', '1'); }
  // Chủ quán 25/10: lương chỉ tính TRONG KHUNG CA. Vào sớm không tính; về sớm bị trừ (báo trưởng ca);
  // ở lại sau giờ ca (tăng ca) chỉ tính khi CHỦ QUÁN duyệt. Lượt không có ca (quản lý) tính giờ thực tế.
  if (!db.prepare('PRAGMA table_info(attendance)').all().some((x) => x.name === 'ot_status')) {
    db.exec("ALTER TABLE attendance ADD COLUMN ot_status TEXT NOT NULL DEFAULT ''"); // '' | pending | approved | rejected
    db.exec('ALTER TABLE attendance ADD COLUMN ot_by INTEGER');
  }
  // Vào trễ: bạn Phục vụ / Tiếp thực tự chụp ảnh nón + khăn khi chấm vào (tổ trưởng đã chụp ảnh chung các bạn vào đúng ca)
  if (!db.prepare('PRAGMA table_info(attendance)').all().some((x) => x.name === 'late_photo')) db.exec("ALTER TABLE attendance ADD COLUMN late_photo TEXT NOT NULL DEFAULT ''");
  const photoDir = ctx.photoDir || path.join(os.tmpdir(), 'quanly-photos');

  // ---------- Chống chấm công hộ (chủ quán 26/10) ----------
  // 1. Mỗi tài khoản gắn 1 điện thoại: lần chấm đầu tiên ghi nhớ máy; máy khác → chặn, báo quản lý "Cho đổi máy".
  // 2. 1 điện thoại chỉ chấm cho 1 người: máy đã gắn / đã chấm cho người khác hôm nay → chặn, báo chủ quán ngay.
  // Mã máy: cookie "did" (máy chủ đặt, 2 năm) + localStorage gửi kèm header X-Device (lỡ xoá 1 trong 2 vẫn nhận ra).
  // Quản lý / chủ quán không bị khoá. Tắt được: setting clock_device_lock = 0.
  const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!colsOf('staff').includes('device_id')) db.exec("ALTER TABLE staff ADD COLUMN device_id TEXT NOT NULL DEFAULT ''; ALTER TABLE staff ADD COLUMN device_pending TEXT NOT NULL DEFAULT ''; ALTER TABLE staff ADD COLUMN device_at INTEGER");
  if (!colsOf('attendance').includes('device_id')) db.exec("ALTER TABLE attendance ADD COLUMN device_id TEXT NOT NULL DEFAULT ''");
  const DEV = /^[A-Za-z0-9_-]{8,64}$/;
  function deviceOf(req, res) {
    const ck = /(?:^|;\s*)did=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
    const hd = String(req.headers['x-device'] || '');
    const id = DEV.test(ck) ? ck : DEV.test(hd) ? hd : '';
    if (!id) return ''; // máy không gửi mã (bản app cũ chưa tải lại) → không khoá
    if (id !== ck) {
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      const prev = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), `did=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${2 * 365 * 86400}${secure}`]);
    }
    return id;
  }
  // Chủ quán 26/10: đổi tên web (link mới) → mọi điện thoại thành "máy mới"; xoá đăng ký máy cũ 1 lần, lần chấm tới tự đăng ký lại
  if (!ctx.setting('device_reset_domain_v1')) {
    db.exec("UPDATE staff SET device_id = '', device_pending = ''");
    ctx.setSetting('device_reset_domain_v1', '1');
  }
  function checkDevice(me, dev, { out = false } = {}) {
    if (!dev || rank(me.role) >= rank('manager') || ctx.setting('clock_device_lock') === '0') return;
    const date = ctx.today();
    const owner = db.prepare('SELECT id, name FROM staff WHERE device_id = ? AND id != ? AND active = 1').get(dev, me.id)
      || db.prepare('SELECT s.id, s.name FROM attendance a JOIN staff s ON s.id = a.staff_id WHERE a.device_id = ? AND a.date = ? AND a.staff_id != ? LIMIT 1').get(dev, date, me.id);
    if (owner) {
      ctx.notify([...new Set([...ctx.managers(), ...ctx.leadsOf(me.team_id)])].filter((x) => x !== me.id), { title: `⚠ Nghi chấm công hộ: máy của ${owner.name} vừa chấm cho ${me.name}`, body: `Lúc ${ctx.clock().fmt(ctx.now())}. App đã chặn.`, link: '/cham-cong', urgent: true });
      ctx.audit(me, 'clock.device_shared', { other: owner.id });
      fail(403, `Điện thoại này là máy chấm công của ${owner.name}. Mỗi người chấm trên điện thoại của chính mình.`);
    }
    const st = db.prepare('SELECT device_id FROM staff WHERE id = ?').get(me.id);
    if (!st.device_id) { db.prepare("UPDATE staff SET device_id = ?, device_pending = '', device_at = ? WHERE id = ?").run(dev, ctx.now(), me.id); return; }
    if (st.device_id !== dev) {
      db.prepare('UPDATE staff SET device_pending = ? WHERE id = ?').run(dev, me.id);
      ctx.notify(ctx.leadsOf(me.team_id).filter((x) => x !== me.id), { title: `${me.name} chấm công từ điện thoại lạ`, body: 'Nếu bạn ấy đổi máy thật: Nhân viên → sửa bạn đó → "Cho đổi máy".', link: '/nhan-vien', urgent: true });
      ctx.audit(me, 'clock.device_new', { out });
      if (out) return; // chấm ra: không chặn (đã chấm vào trên máy đúng), chỉ báo tổ trưởng
      fail(403, 'Đây không phải điện thoại đã đăng ký chấm công của bạn. Nếu bạn đổi máy (hoặc đổi trình duyệt Zalo ↔ Safari), nhờ quản lý bấm "Cho đổi máy" rồi chấm lại.');
    }
  }
  const LATE_PHOTO_TEAMS = /^(phục vụ|phuc vu|tiếp thực|tiep thuc)$/i;
  const needLatePhoto = (staffId) => {
    const t = db.prepare('SELECT t.name FROM staff s JOIN teams t ON t.id = s.team_id WHERE s.id = ?').get(staffId);
    return Boolean(t && LATE_PHOTO_TEAMS.test(t.name.trim()));
  };
  const OT_MIN = 10; // ở lại quá 10 phút mới tính là tăng ca chờ duyệt
  const segOf = (assignmentId) => (assignmentId ? db.prepare('SELECT date, start_min, end_min FROM assignments WHERE id = ?').get(assignmentId) : null);
  // Phút tính lương, về sớm, tăng ca của 1 lượt chấm công
  function payInfo(r) {
    const a = segOf(r.assignment_id);
    if (!r.clock_out) return { paid_from: r.clock_in, paid_to: null, early_minutes: 0, ot_minutes: 0 };
    if (!a) return { paid_from: r.clock_in, paid_to: r.clock_out, early_minutes: 0, ot_minutes: 0 };
    const { start, end } = rangeOf(ctx.clock(), a);
    const from = Math.max(r.clock_in, start);
    const ot = Math.max(0, Math.round((r.clock_out - end) / 60_000));
    const to = r.ot_status === 'approved' ? r.clock_out : Math.min(r.clock_out, end);
    return { paid_from: from, paid_to: Math.max(from, to), early_minutes: Math.max(0, Math.round((end - r.clock_out) / 60_000)), ot_minutes: ot >= OT_MIN ? ot : 0 };
  }
  ctx.attendancePayInfo = payInfo;
  // Bản ghi đưa vào tính lương: giờ vào / ra đã cắt theo khung ca
  ctx.payRecords = (records) => records.map((r) => { if (!r.clock_out) return r; const p = payInfo(r); return { ...r, clock_in: p.paid_from, clock_out: p.paid_to }; });

  function parseLocal(text, clock) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/.exec(String(text || ''));
    if (!m || !isDate(m[1])) fail(400, 'Thời gian không hợp lệ (cần dạng YYYY-MM-DDTHH:MM)');
    return clock.toEpoch(m[1], Number(m[2]) * 60 + Number(m[3]));
  }

  // Các khúc ca của một người quanh thời điểm hiện tại (chưa bị nghỉ đã duyệt)
  function mySegments(staffId, date) {
    return db.prepare(`SELECT a.* FROM assignments a WHERE a.staff_id = ? AND a.date BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')
      ORDER BY a.date, a.start_min`).all(staffId, addDays(date, -1), addDays(date, 1));
  }

  // Tự đóng các lượt chấm công bị quên chấm ra
  ctx.autoCloseAttendance = function autoClose() {
    const clock = ctx.clock();
    const t = ctx.now();
    const after = num('auto_close_after_minutes', 120) * 60_000;
    const open = db.prepare(`SELECT at.*, a.date AS a_date, a.end_min, s.name, s.team_id FROM attendance at
      LEFT JOIN assignments a ON a.id = at.assignment_id JOIN staff s ON s.id = at.staff_id WHERE at.clock_out IS NULL`).all();
    for (const o of open) {
      let out = null;
      if (o.a_date) {
        const end = clock.toEpoch(o.a_date, o.end_min);
        if (t > end + after) out = Math.max(o.clock_in, end);
      } else if (t > o.clock_in + 14 * 3600_000) {
        out = o.clock_in; // không có lịch: để 0 giờ cho quản lý sửa lại
      }
      if (out !== null) {
        db.prepare("UPDATE attendance SET clock_out = ?, auto_closed = 1, note = TRIM(note || ' Quên chấm ra, hệ thống tự đóng') WHERE id = ?").run(out, o.id);
        ctx.notify(ctx.leadsOf(o.team_id).filter((id) => id !== o.staff_id), { title: `${o.name} quên chấm ra`, body: 'Hệ thống đã tự đóng ca, vui lòng kiểm tra lại giờ.', link: '/cham-cong' });
        ctx.notify(o.staff_id, { title: 'Bạn quên chấm ra ca', body: `Hệ thống đã tự đóng lúc ${clock.fmt(out)}. Báo trưởng ca nếu giờ chưa đúng.`, link: '/' });
      }
    }
  };

  // Lỡ bấm chấm ra (chủ quán 26/10: bấm 2 lần liền → vừa vào đã ra): trong 30 phút, ra trước giờ hết ca → tự huỷ được
  const UNDO_MS = 30 * 60_000;
  function undoable(staffId) {
    const a = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND clock_out IS NOT NULL ORDER BY clock_out DESC LIMIT 1').get(staffId);
    if (!a || ctx.now() - a.clock_out > UNDO_MS) return null;
    const seg = segOf(a.assignment_id);
    if (seg && a.clock_out >= rangeOf(ctx.clock(), seg).end) return null;
    return a;
  }
  function myStatus(me) {
    ctx.autoCloseAttendance();
    const clock = ctx.clock();
    const t = ctx.now();
    const open = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND clock_out IS NULL').get(me.id);
    const segs = mySegments(me.id, clock.businessDate(t)).map((a) => ({ ...a, ...rangeOf(clock, a) }));
    const done = new Set(db.prepare('SELECT assignment_id FROM attendance WHERE staff_id = ? AND assignment_id IS NOT NULL AND clock_in > ?')
      .all(me.id, t - 3 * 86_400_000).map((x) => x.assignment_id));
    const next = segs.find((s) => s.end > t && !done.has(s.id)) || null;
    const last = open ? null : undoable(me.id);
    return {
      undo_out: last ? { id: last.id, clock_in: last.clock_in, clock_out: last.clock_out } : null,
      open: open ? { ...open, need_photo: open.late_minutes > 0 && !open.late_photo && needLatePhoto(me.id) } : null,
      next: next ? { id: next.id, date: next.date, label: next.label, start: next.start, end: next.end, text: `${fmtHM(next.start_min)}–${fmtHM(next.end_min)}` } : null,
      ip_restricted: Boolean(ctx.setting('clock_ip_prefixes')) || place().gps,
      gps: place().gps,
    };
  }

  r.get('/api/attendance/me', 'staff', ({ me }) => myStatus(me));

  // Chỉ chấm công khi ở quán (chủ quán 25/10): đúng VỊ TRÍ quán (GPS) HOẶC đang bắt WIFI quán.
  // Wifi quán: IP máy cầu in ở quán báo lên (tự theo khi nhà mạng đổi IP) hoặc dải IP nhập tay.
  const distM = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180; const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  const place = () => {
    const lat = Number(ctx.setting('shop_lat') || 0), lng = Number(ctx.setting('shop_lng') || 0);
    const prefixes = (ctx.setting('clock_ip_prefixes') || '').split(',').map((x) => x.trim()).filter(Boolean);
    return { lat, lng, gps: Boolean(lat && lng), radius: Number(ctx.setting('clock_radius_m') || 150), prefixes };
  };
  ctx.clockPlace = place;
  function onShopWifi(net) {
    const p = place();
    if (!net.remote && p.prefixes.some((x) => net.ip.startsWith(x))) return true;
    const bip = ctx.setting('shop_bridge_ip');
    return Boolean(bip && net.ip === bip && ctx.now() - Number(ctx.setting('shop_bridge_ip_at') || 0) < 15 * 60_000);
  }
  ctx.onShopWifi = onShopWifi;
  function checkNetwork(net, me, body = {}) {
    const p = place();
    if (!p.gps && !p.prefixes.length) return 'không giới hạn';
    if (onShopWifi(net)) return `wifi quán ${net.ip}`;
    let why = '';
    if (p.gps) {
      const lat = Number(body.lat), lng = Number(body.lng), acc = Math.max(0, Number(body.acc) || 0);
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
        const d = Math.round(distM(p.lat, p.lng, lat, lng));
        if (acc > 1000) why = 'Vị trí chưa chính xác (bật Vị trí chính xác cho trình duyệt rồi thử lại).';
        else if (d <= p.radius + Math.min(acc, 100)) return `GPS cách quán ${d}m`;
        else why = `Bạn đang cách quán khoảng ${d >= 1000 ? `${Math.round(d / 100) / 10}km` : `${d}m`}.`;
      } else why = 'Chưa lấy được vị trí: bấm "Cho phép" khi trình duyệt hỏi vị trí, hoặc bắt wifi quán.';
    }
    if (me) ctx.clockBlocked?.(me, net);
    fail(403, `Chỉ chấm công được khi đang ở quán. ${why || 'Kết nối wifi quán rồi bấm lại.'}`.trim());
  }

  r.post('/api/attendance/clock-in', 'staff', ({ req, res, me, net, body }) => {
    const how = checkNetwork(net, me, body || {});
    const dev = deviceOf(req, res);
    checkDevice(me, dev);
    ctx.autoCloseAttendance();
    const clock = ctx.clock();
    const t = ctx.now();
    const early = num('clock_early_minutes', 60) * 60_000;
    const grace = num('late_grace_minutes', 5) * 60_000;
    const result = tx(db, () => {
      if (db.prepare('SELECT 1 FROM attendance WHERE staff_id = ? AND clock_out IS NULL').get(me.id)) fail(409, 'Bạn đang trong ca, hãy chấm ra trước');
      const done = new Set(db.prepare('SELECT assignment_id FROM attendance WHERE staff_id = ? AND assignment_id IS NOT NULL').all(me.id).map((x) => x.assignment_id));
      const seg = mySegments(me.id, clock.businessDate(t))
        .map((a) => ({ ...a, ...rangeOf(clock, a) }))
        .find((s) => !done.has(s.id) && t >= s.start - early && t < s.end);
      // Chủ quán 25/10: phải có ca trong lịch (đã báo lịch rảnh / quản lý xếp) mới chấm công được → không ca = không công, không lương.
      // Quản lý, chủ quán không bị chặn. Tắt được bằng setting clock_require_shift = 0.
      if (!seg && ctx.setting('clock_require_shift') !== '0' && rank(me.role) < rank('manager')) {
        const next = mySegments(me.id, clock.businessDate(t)).map((a) => ({ ...a, ...rangeOf(clock, a) })).find((s) => !done.has(s.id) && s.start - early > t);
        fail(403, next ? `Chưa tới giờ chấm: ca của bạn bắt đầu ${fmtHM(next.start_min)}, chấm được từ ${clock.fmt(next.start - early).slice(0, 5)}.`
          : 'Bạn chưa có ca trong lịch hôm nay nên chưa chấm công được (không có ca = không tính công, không tính lương). Báo lịch rảnh trước, hoặc nhờ quản lý thêm ca rồi chấm lại.');
      }
      const late = seg && t > seg.start + grace ? Math.round((t - seg.start) / 60_000) : 0;
      const date = seg ? seg.date : clock.businessDate(t);
      const id = Number(db.prepare(`INSERT INTO attendance (staff_id, assignment_id, date, clock_in, late_minutes, note, source, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(me.id, seg?.id ?? null, date, t, late, seg ? '' : 'Ngoài lịch', how.slice(0, 60), dev).lastInsertRowid);
      return { id, seg, late };
    });
    if (!result.seg) {
      ctx.notify(ctx.leadsOf(me.team_id).filter((id) => id !== me.id), { title: `${me.name} chấm công ngoài lịch`, body: `Lúc ${clock.fmt(t)}`, link: '/cham-cong' });
    } else if (result.late) {
      ctx.notify(ctx.leadsOf(me.team_id).filter((id) => id !== me.id), { title: `${me.name} đi trễ ${result.late} phút`, body: needLatePhoto(me.id) ? 'Bạn ấy phải tự chụp ảnh nón + khăn trong app.' : '', link: '/cham-cong' });
    }
    ctx.audit(me, 'clock.in', result.id);
    ctx.broadcast('attendance');
    return { ...myStatus(me), late_minutes: result.late, scheduled: Boolean(result.seg) };
  });

  // Ảnh nón + khăn của bạn vào trễ
  r.post('/api/attendance/late-photo', 'staff', ({ me, body }) => {
    const open = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND clock_out IS NULL').get(me.id);
    if (!open) fail(409, 'Bạn chưa chấm vào ca');
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) fail(400, 'Ảnh không hợp lệ');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500 || buf.length > 1_500_000) fail(400, 'Ảnh không hợp lệ, chụp lại giúp');
    const rel = path.join(open.date, `tre-${open.id}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.mkdirSync(path.join(photoDir, open.date), { recursive: true });
    fs.writeFileSync(path.join(photoDir, rel), buf);
    db.prepare('UPDATE attendance SET late_photo = ? WHERE id = ?').run(rel, open.id);
    ctx.notify(ctx.leadsOf(me.team_id).filter((id) => id !== me.id), { title: `${me.name} vào trễ ${open.late_minutes}′ đã chụp ảnh nón + khăn`, body: 'Xem ở Chấm công.', link: '/cham-cong' });
    ctx.broadcast('attendance');
    return { ok: true };
  });
  r.get('/api/attendance/:id/late-photo', 'staff', ({ me, params }) => {
    const a = db.prepare('SELECT staff_id, late_photo FROM attendance WHERE id = ?').get(params.id);
    if (!a || !a.late_photo) fail(404, 'Không có ảnh');
    if (a.staff_id !== me.id && rank(me.role) < rank('team_lead')) fail(403, 'Không xem được ảnh này');
    let buf;
    try { buf = fs.readFileSync(path.join(photoDir, a.late_photo)); } catch { fail(410, 'Ảnh không còn'); }
    return { __binary: buf, type: a.late_photo.endsWith('.png') ? 'image/png' : a.late_photo.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
  });

  r.post('/api/attendance/clock-out', 'staff', ({ req, res, me, net, body }) => {
    checkNetwork(net, me, body || {});
    checkDevice(me, deviceOf(req, res), { out: true });
    const open = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND clock_out IS NULL').get(me.id);
    if (!open) fail(409, 'Bạn chưa chấm vào ca');
    const since = Math.round((ctx.now() - open.clock_in) / 60_000);
    if (since < 10 && !body?.confirm) fail(409, `Bạn vừa chấm vào ${since} phút trước. Chắc chắn chấm ra?`);
    // Còn giữ tiền mặt của khách chưa giao thu ngân thì không cho ra ca
    const held = ctx.cashHeldBy ? ctx.cashHeldBy(me.id) : 0;
    if (held) fail(409, `Còn ${held.toLocaleString('vi-VN')}đ tiền mặt bạn thu chưa được thu ngân xác nhận. Đưa tiền cho thu ngân bấm xác nhận rồi chấm ra.`);
    const outAt = ctx.now();
    const p = payInfo({ ...open, clock_out: outAt });
    // Ở lại sau giờ ca = làm cho xong việc, KHÔNG phải tăng ca, không báo ai (chủ quán 25/10). Chủ muốn tính thì tự bấm ở Chấm công.
    db.prepare("UPDATE attendance SET clock_out = ?, ot_status = '' WHERE id = ?").run(outAt, open.id);
    const grace = num('late_grace_minutes', 5);
    if (p.early_minutes > grace) ctx.notify(ctx.leadsOf(me.team_id).filter((id) => id !== me.id), { title: `${me.name} về sớm ${p.early_minutes} phút`, body: `Chấm ra lúc ${ctx.clock().fmt(outAt)}. Giờ về sớm bị trừ lương.`, link: '/cham-cong' });
    ctx.audit(me, 'clock.out', open.id);
    ctx.broadcast('attendance');
    return myStatus(me);
  });

  r.post('/api/attendance/undo-out', 'staff', ({ me }) => {
    if (db.prepare('SELECT 1 FROM attendance WHERE staff_id = ? AND clock_out IS NULL').get(me.id)) fail(409, 'Bạn đang trong ca');
    const a = undoable(me.id);
    if (!a) fail(409, 'Quá 30 phút hoặc đã hết ca: nhờ trưởng ca / quản lý sửa ở Chấm công');
    db.prepare("UPDATE attendance SET clock_out = NULL, ot_status = '', note = TRIM(note || ' · huỷ chấm ra nhầm') WHERE id = ?").run(a.id);
    ctx.notify(ctx.leadsOf(me.team_id).filter((id) => id !== me.id), { title: `${me.name} huỷ chấm ra nhầm`, body: `Đã chấm ra lúc ${ctx.clock().fmt(a.clock_out)}, giờ tiếp tục ca.`, link: '/cham-cong' });
    ctx.audit(me, 'clock.undo_out', a.id);
    ctx.broadcast('attendance');
    return myStatus(me);
  });

  // ---------- Quản lý chấm công ----------
  r.get('/api/attendance', 'shift_lead', ({ me, query }) => {
    ctx.autoCloseAttendance();
    const from = query.get('from') || ctx.today();
    const to = query.get('to') || from;
    if (!isDate(from) || !isDate(to)) fail(400, 'Ngày không hợp lệ');
    const staffId = query.get('staff_id');
    return db.prepare(`SELECT at.*, s.name AS staff_name, t.name AS team_name, a.start_min, a.end_min, a.label, e.name AS edited_by_name
      FROM attendance at JOIN staff s ON s.id = at.staff_id LEFT JOIN teams t ON t.id = s.team_id
      LEFT JOIN assignments a ON a.id = at.assignment_id LEFT JOIN staff e ON e.id = at.edited_by
      WHERE at.date BETWEEN ? AND ? ${staffId ? 'AND at.staff_id = ?' : ''} ORDER BY at.clock_in DESC LIMIT 1000`)
      .all(...[from, to, ...(staffId ? [Number(staffId)] : [])]).map((r) => {
        const p = payInfo(r);
        const out = { ...r, ...p, paid_minutes: p.paid_to ? Math.round((p.paid_to - p.paid_from) / 60_000) : null };
        if (me.role !== 'owner') { out.ot_minutes = 0; out.ot_status = ''; } // phần ở lại sau ca chỉ chủ quán thấy
        return out;
      });
  });

  // Chủ quán duyệt / không duyệt giờ tăng ca (ở lại sau giờ ca)
  r.post('/api/attendance/:id/overtime', 'manager', ({ me, params, body }) => {
    if (me.role !== 'owner') fail(403, 'Chỉ chủ quán');
    const cur = db.prepare('SELECT at.*, s.name FROM attendance at JOIN staff s ON s.id = at.staff_id WHERE at.id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy lượt chấm công');
    if (!payInfo(cur).ot_minutes) fail(400, 'Lượt này không có tăng ca');
    const ok = v.bool(body.approve);
    db.prepare('UPDATE attendance SET ot_status = ?, ot_by = ? WHERE id = ?').run(ok ? 'approved' : 'rejected', me.id, cur.id);
    ctx.audit(me, ok ? 'attendance.ot_approve' : 'attendance.ot_reject', cur.id);
    ctx.broadcast('attendance');
    return { ok: true };
  });

  r.post('/api/attendance', 'shift_lead', ({ me, body }) => {
    const clock = ctx.clock();
    const staffId = v.int(body.staff_id, { min: 1, name: 'Nhân viên' });
    if (!ctx.staff(staffId)) fail(404, 'Không tìm thấy nhân viên');
    const cin = parseLocal(body.clock_in, clock);
    const cout = body.clock_out ? parseLocal(body.clock_out, clock) : null;
    if (cout !== null && cout <= cin) fail(400, 'Giờ ra phải sau giờ vào');
    if (cout !== null && cout - cin > 20 * 3600_000) fail(400, 'Một lượt chấm công không quá 20 giờ');
    const note = v.text(body.note, { name: 'Ghi chú', max: 200 }) || 'Quản lý thêm tay';
    const id = Number(db.prepare(`INSERT INTO attendance (staff_id, date, clock_in, clock_out, edited_by, note, source) VALUES (?, ?, ?, ?, ?, ?, 'manual')`)
      .run(staffId, clock.businessDate(cin), cin, cout, me.id, note).lastInsertRowid);
    ctx.audit(me, 'attendance.create', { id, staffId });
    ctx.broadcast('attendance');
    return { id };
  });

  r.patch('/api/attendance/:id', 'shift_lead', ({ me, params, body }) => {
    const clock = ctx.clock();
    const cur = db.prepare('SELECT * FROM attendance WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy lượt chấm công');
    const cin = body.clock_in ? parseLocal(body.clock_in, clock) : cur.clock_in;
    const cout = body.clock_out === undefined ? cur.clock_out : body.clock_out ? parseLocal(body.clock_out, clock) : null;
    if (cout !== null && cout <= cin) fail(400, 'Giờ ra phải sau giờ vào');
    if (cout !== null && cout - cin > 20 * 3600_000) fail(400, 'Một lượt chấm công không quá 20 giờ');
    const note = body.note === undefined ? cur.note : v.text(body.note, { name: 'Ghi chú', max: 200 });
    db.prepare('UPDATE attendance SET clock_in = ?, clock_out = ?, date = ?, note = ?, edited_by = ?, auto_closed = 0 WHERE id = ?')
      .run(cin, cout, cur.assignment_id ? cur.date : clock.businessDate(cin), note, me.id, cur.id);
    ctx.audit(me, 'attendance.update', { id: cur.id, before: [cur.clock_in, cur.clock_out], after: [cin, cout] });
    ctx.broadcast('attendance');
    return { ok: true };
  });

  r.delete('/api/attendance/:id', 'manager', ({ me, params }) => {
    const cur = db.prepare('SELECT * FROM attendance WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy lượt chấm công');
    db.prepare('DELETE FROM attendance WHERE id = ?').run(cur.id);
    ctx.audit(me, 'attendance.delete', cur);
    ctx.broadcast('attendance');
    return { ok: true };
  });

  // ---------- Bảng công & lương tạm tính theo tháng ----------
  r.get('/api/timesheet', 'manager', ({ me, query }) => {
    ctx.autoCloseAttendance();
    const month = query.get('month') || ctx.today().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'Tháng không hợp lệ');
    const from = `${month}-01`;
    const to = addDays(addDays(from, 32).slice(0, 7) + '-01', -1);
    const clock = ctx.clock();
    const staff = db.prepare('SELECT id, name, pay_type, pay_rate, team_id, active FROM staff ORDER BY name').all();
    const records = db.prepare(`SELECT at.*, a.group_id AS group_key FROM attendance at LEFT JOIN assignments a ON a.id = at.assignment_id
      WHERE at.date BETWEEN ? AND ?`).all(from, to);
    const rows = computeTimesheet(ctx.payRecords(records), staff, clock, { nightBonusPct: num('night_bonus_pct', 0), monthStandardDays: num('month_standard_days', 26) });
    const stats = db.prepare(`SELECT staff_id, SUM(late_minutes > 0) AS late_count, SUM(late_minutes) AS late_minutes, SUM(auto_closed) AS auto_closed
      FROM attendance WHERE date BETWEEN ? AND ? GROUP BY staff_id`).all(from, to);
    const today = ctx.today();
    const absent = db.prepare(`SELECT a.staff_id, COUNT(DISTINCT a.group_id) AS n FROM assignments a
      WHERE a.date BETWEEN ? AND ? AND a.date < ?
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')
      AND NOT EXISTS (SELECT 1 FROM attendance x WHERE x.assignment_id IN (SELECT id FROM assignments WHERE group_id = a.group_id))
      GROUP BY a.staff_id`).all(from, to, today);
    const statBy = new Map(stats.map((s) => [s.staff_id, s]));
    const absentBy = new Map(absent.map((s) => [s.staff_id, s.n]));
    const active = new Set(staff.filter((s) => s.active).map((s) => s.id));
    return {
      month, from, to,
      night_bonus_pct: num('night_bonus_pct', 0),
      month_standard_days: num('month_standard_days', 26),
      rows: rows
        .map((row) => ({ ...row, late_count: statBy.get(row.staff_id)?.late_count || 0, late_minutes: statBy.get(row.staff_id)?.late_minutes || 0,
          auto_closed: statBy.get(row.staff_id)?.auto_closed || 0, absent: absentBy.get(row.staff_id) || 0 }))
        .filter((row) => active.has(row.staff_id) || row.minutes > 0),
      total_pay: rows.reduce((s, x) => s + x.pay, 0),
      can_see_pay: rank(me.role) >= rank('manager'),
    };
  });
}
