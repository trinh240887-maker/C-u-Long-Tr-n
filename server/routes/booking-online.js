import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { isDate, parseHM } from '../lib/time.js';
import { formatTableList, parseTableList } from '../lib/tables.js';

// Khách tự đặt bàn online (trang /datban, không cần đăng nhập).
// Đơn vào trạng thái "requested" (chờ quán xác nhận) → nhân viên chọn bàn, bấm Xác nhận / Từ chối
// → báo khách (Zalo ZNS nếu đã cài, không thì nhân viên gọi lại). Khách xem / huỷ bằng mã đặt bàn.
export default function (r, ctx) {
  const { db } = ctx;
  const addCol = (c, d) => { if (!db.prepare('PRAGMA table_info(reservations)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE reservations ADD COLUMN ${c} ${d}`); };
  addCol('source', "TEXT NOT NULL DEFAULT 'staff'");      // staff | online
  addCol('code', "TEXT NOT NULL DEFAULT ''");             // mã để khách tra / huỷ
  addCol('confirmed_by', 'INTEGER');
  addCol('confirmed_at', 'INTEGER');
  addCol('reject_reason', "TEXT NOT NULL DEFAULT ''");
  addCol('notify_status', "TEXT NOT NULL DEFAULT ''");    // sent | failed | skipped (chưa cài Zalo ZNS → nhân viên gọi)
  addCol('notify_error', "TEXT NOT NULL DEFAULT ''");
  addCol('reminded_at', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_res_code ON reservations (code)');
  const S = (k, d) => ctx.setting(k) || d;
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
  const cfg = () => ({
    enabled: S('online_booking_enabled', '1') === '1',
    open: parseHM(S('online_open', '10:00')), last: parseHM(S('online_last', '21:30')),
    step: Number(S('online_slot_minutes', '30')), lead: Number(S('online_min_lead_minutes', '60')),
    days: Number(S('online_days_ahead', '30')), maxGuests: Number(S('online_max_guests', '20')),
  });
  const dining = () => Math.max(60, Number(ctx.setting('dining_minutes') || 70) + 15);
  const staffToTell = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND (role IN ('owner','manager','shift_lead') OR team_id IN (SELECT id FROM teams WHERE name IN ('Thu ngân','Tiếp thực')))").all().map((x) => x.id);

  // Bàn còn trống cho khung giờ (không tính đơn đang chờ xác nhận)
  function freeTables(date, start, guests) {
    const held = new Set();
    for (const x of db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'booking' AND status IN ('booked','arrived')").all(date)) {
      if (start < x.time_min + x.duration_min && x.time_min < start + dining()) for (const n of parseTableList(x.tables)) held.add(n);
    }
    const tables = db.prepare('SELECT t.number, t.seats, t.zone_id FROM dining_tables t JOIN zones z ON z.id = t.zone_id WHERE z.active = 1 ORDER BY t.number').all().filter((t) => !held.has(t.number));
    const seats = tables.reduce((n, t) => n + t.seats, 0);
    return { tables, seats, fits: tables.some((t) => t.seats >= guests) || seats >= guests * 1.5 };
  }

  function slots(date, guests) {
    const c = cfg();
    const now = ctx.now();
    const clock = ctx.clock();
    const today = clock.dateOf(now);
    const out = [];
    for (let m = c.open; m <= c.last; m += c.step) {
      const at = clock.toEpoch(date, m);
      const tooSoon = date === today && at - now < c.lead * 60_000;
      out.push({ time: hm(m), ok: !tooSoon && date >= today && freeTables(date, m, guests).fits, reason: tooSoon ? 'Đặt trước ít nhất ' + c.lead + ' phút' : '' });
    }
    return out;
  }

  // ---------- Trang công khai ----------
  r.get('/api/public/booking/info', null, () => {
    const c = cfg();
    return {
      enabled: c.enabled, shop: { name: ctx.setting('shop_name'), address: ctx.setting('shop_address'), phone: ctx.setting('shop_phone') },
      open: hm(c.open), last: hm(c.last), days: c.days, max_guests: c.maxGuests, today: ctx.clock().dateOf(ctx.now()),
      zones: db.prepare('SELECT id, name FROM zones WHERE active = 1 ORDER BY sort, id').all(),
    };
  });
  r.get('/api/public/booking/slots', null, ({ query }) => {
    const date = String(query.get('date') || '');
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    const guests = v.int(query.get('guests') || 2, { min: 1, max: 500, name: 'Số khách' });
    return { date, slots: slots(date, guests) };
  });

  // Chống spam: mỗi máy (IP) tối đa 5 đơn / giờ; mỗi SĐT 1 đơn đang hiệu lực / ngày
  const hits = new Map();
  r.post('/api/public/booking', null, ({ body, net }) => {
    const c = cfg();
    if (!c.enabled) fail(403, 'Quán tạm ngưng nhận đặt bàn online, vui lòng gọi điện');
    if (body.website) return { code: 'OK' }; // ô bẫy máy tự động: im lặng bỏ qua
    const ip = net?.ip || 'x';
    const now = ctx.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
    if (list.length >= 5) fail(429, 'Bạn gửi quá nhiều lần, thử lại sau hoặc gọi quán');
    const name = v.text(body.name, { name: 'Tên', required: true, max: 60 });
    let phone = String(body.phone || '').replace(/[^\d]/g, '');
    if (phone.startsWith('84')) phone = `0${phone.slice(2)}`;
    if (!/^0\d{9}$/.test(phone)) fail(400, 'Số điện thoại chưa đúng (10 số, vd 0909123456)');
    const guests = v.int(body.guests, { min: 1, max: c.maxGuests, name: `Số khách (tối đa ${c.maxGuests}, đông hơn vui lòng gọi quán)` });
    const date = String(body.date || '');
    if (!isDate(date)) fail(400, 'Chọn ngày');
    let time;
    try { time = parseHM(String(body.time || '')); } catch { fail(400, 'Chọn giờ'); }
    const clock = ctx.clock();
    const today = clock.dateOf(now);
    if (date < today) fail(400, 'Ngày đã qua');
    const maxDate = new Date(`${today}T00:00:00Z`); maxDate.setUTCDate(maxDate.getUTCDate() + c.days);
    if (date > maxDate.toISOString().slice(0, 10)) fail(400, `Chỉ nhận đặt trước tối đa ${c.days} ngày`);
    if (time < c.open || time > c.last) fail(400, `Giờ nhận đặt từ ${hm(c.open)} đến ${hm(c.last)}`);
    if (clock.toEpoch(date, time) - now < c.lead * 60_000) fail(400, `Vui lòng đặt trước ít nhất ${c.lead} phút, gấp thì gọi quán`);
    const dup = db.prepare("SELECT code, time_min FROM reservations WHERE phone = ? AND date = ? AND status IN ('requested','booked')").get(phone, date);
    if (dup) fail(409, `Số này đã đặt bàn ngày ${dm(date)} lúc ${hm(dup.time_min)} (mã ${dup.code}). Muốn đổi vui lòng huỷ đơn cũ hoặc gọi quán.`);
    if (!freeTables(date, time, guests).fits) fail(409, 'Khung giờ này đã kín bàn, vui lòng chọn giờ khác');
    const note = v.text(body.note, { name: 'Ghi chú', max: 200 });
    const zone = v.optInt(body.zone_id, { min: 1, name: 'Khu' });
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const id = Number(db.prepare(`INSERT INTO reservations (kind, name, phone, guests, date, time_min, duration_min, zone_id, tables, priority, note, status, source, code, created_at)
      VALUES ('booking', ?, ?, ?, ?, ?, ?, ?, '', 0, ?, 'requested', 'online', ?, ?)`).run(name, phone, guests, date, time, dining(), zone, note, code, now).lastInsertRowid);
    list.push(now); hits.set(ip, list);
    const hist = db.prepare("SELECT SUM(status = 'no_show') AS ns, SUM(status = 'arrived') AS ar FROM reservations WHERE phone = ? AND id != ?").get(phone, id);
    ctx.notify(staffToTell(), {
      title: `Khách đặt online: ${name} · ${guests} khách · ${dm(date)} ${hm(time)}`,
      body: `${phone}${note ? ` · ${note}` : ''}${hist?.ns ? ` · ⚠ đã bỏ đặt ${hist.ns} lần` : hist?.ar ? ` · khách quen (đến ${hist.ar} lần)` : ''}. Chọn bàn và bấm Xác nhận.`,
      link: `/dat-ban?date=${date}`, urgent: true,
    });
    ctx.audit(null, 'reservation.online', { id, name, date, guests });
    ctx.broadcast('reservations');
    return { code, status: 'requested' };
  });

  const byCode = (code) => {
    const c = String(code || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    const x = c.length === 8 ? db.prepare("SELECT * FROM reservations WHERE code = ? AND source = 'online'").get(c) : null;
    if (!x) fail(404, 'Không tìm thấy mã đặt bàn');
    return x;
  };
  const publicView = (x) => ({
    code: x.code, name: x.name, guests: x.guests, date: x.date, time: hm(x.time_min), status: x.status,
    tables: x.status === 'booked' ? x.tables : '', reason: x.status === 'cancelled' ? x.reject_reason : '',
    phone_tail: x.phone.slice(-3),
  });
  r.get('/api/public/booking/status', null, ({ query }) => publicView(byCode(query.get('code'))));
  r.post('/api/public/booking/cancel', null, ({ body }) => {
    const x = byCode(body.code);
    if (!['requested', 'booked'].includes(x.status)) fail(400, 'Đơn này không huỷ được nữa');
    db.prepare("UPDATE reservations SET status = 'cancelled', reject_reason = 'Khách tự huỷ online', updated_at = ? WHERE id = ?").run(ctx.now(), x.id);
    ctx.notify(staffToTell(), { title: `Khách huỷ đặt bàn: ${x.name} ${dm(x.date)} ${hm(x.time_min)}`, body: `${x.guests} khách${x.tables ? ` · bàn ${x.tables} trả lại` : ''}`, link: `/dat-ban?date=${x.date}` });
    ctx.broadcast('reservations');
    ctx.broadcast('pos');
    return publicView({ ...x, status: 'cancelled', reject_reason: 'Khách tự huỷ online' });
  });

  // ---------- Nhân viên xác nhận / từ chối ----------
  async function tellCustomer(x, kind) {
    const res = ctx.customerNotify ? await ctx.customerNotify(x, kind).catch((e) => ({ ok: false, error: e.message })) : { ok: false, skipped: true };
    db.prepare('UPDATE reservations SET notify_status = ?, notify_error = ? WHERE id = ?').run(res.ok ? 'sent' : res.skipped ? 'skipped' : 'failed', res.error || '', x.id);
    return res;
  }
  ctx.tellCustomer = tellCustomer;

  r.post('/api/reservations/:id/confirm', 'staff', async ({ me, params, body }) => {
    const x = db.prepare('SELECT * FROM reservations WHERE id = ?').get(params.id);
    if (!x || x.status !== 'requested') fail(400, 'Đơn này không chờ xác nhận');
    let nums;
    try { nums = parseTableList(String(body.tables || '')); } catch (e) { fail(400, e.message); }
    if (!nums.length) fail(400, 'Chọn bàn cho khách');
    const free = new Set(freeTables(x.date, x.time_min, x.guests).tables.map((t) => t.number));
    const bad = nums.filter((n) => !free.has(n));
    if (bad.length) fail(409, `Bàn ${formatTableList(bad)} đã giữ cho khách khác khung giờ này`);
    db.prepare("UPDATE reservations SET status = 'booked', tables = ?, confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?").run(formatTableList(nums), me.id, ctx.now(), ctx.now(), x.id);
    const res = await tellCustomer({ ...x, tables: formatTableList(nums), status: 'booked' }, 'confirm');
    ctx.audit(me, 'reservation.confirm', { id: x.id, tables: nums, notify: res.ok ? 'sent' : res.error || 'skipped' });
    ctx.broadcast('reservations');
    ctx.broadcast('pos');
    return { ok: true, notified: !!res.ok, notify_error: res.ok ? '' : res.skipped ? 'Chưa cài Zalo ZNS: gọi điện báo khách' : res.error };
  });

  r.post('/api/reservations/:id/reject', 'staff', async ({ me, params, body }) => {
    const x = db.prepare('SELECT * FROM reservations WHERE id = ?').get(params.id);
    if (!x || !['requested', 'booked'].includes(x.status)) fail(400, 'Đơn này không từ chối được');
    const reason = v.text(body.reason, { name: 'Lý do', required: true, max: 120 });
    db.prepare("UPDATE reservations SET status = 'cancelled', reject_reason = ?, updated_at = ? WHERE id = ?").run(reason, ctx.now(), x.id);
    const res = x.source === 'online' ? await tellCustomer({ ...x, reject_reason: reason }, 'reject') : { ok: false, skipped: true };
    ctx.audit(me, 'reservation.reject', { id: x.id, reason });
    ctx.broadcast('reservations');
    ctx.broadcast('pos');
    return { ok: true, notified: !!res.ok };
  });

  // Mỗi 5 phút: đơn online chờ xác nhận quá 15′ → nhắc lại quản lý; khách đã xác nhận → nhắc khách trước 2 giờ (nếu có Zalo ZNS)
  ctx.bookingTick = async () => {
    const now = ctx.now();
    const clock = ctx.clock();
    let n = 0;
    for (const x of db.prepare("SELECT * FROM reservations WHERE status = 'requested' AND source = 'online' AND created_at < ? AND COALESCE(reminded_at, 0) = 0").all(now - 15 * 60_000)) {
      ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((s) => s.id), { title: `Đơn đặt online chờ 15′ chưa xác nhận: ${x.name}`, body: `${x.guests} khách · ${dm(x.date)} ${hm(x.time_min)} · ${x.phone}`, link: `/dat-ban?date=${x.date}`, urgent: true });
      db.prepare('UPDATE reservations SET reminded_at = ? WHERE id = ?').run(now, x.id);
      n++;
    }
    if (ctx.customerNotify && ctx.setting('zns_template_remind')) {
      for (const x of db.prepare("SELECT * FROM reservations WHERE status = 'booked' AND kind = 'booking' AND phone != '' AND COALESCE(reminded_at, 0) = 0 AND date = ?").all(clock.dateOf(now))) {
        const at = clock.toEpoch(x.date, x.time_min);
        if (at - now > 0 && at - now <= 2 * 3_600_000) {
          db.prepare('UPDATE reservations SET reminded_at = ? WHERE id = ?').run(now, x.id);
          await tellCustomer(x, 'remind');
          n++;
        }
      }
    }
    return n;
  };
}
