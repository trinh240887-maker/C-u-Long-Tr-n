import { fail, v } from '../http.js';
import { tx } from '../db.js';
import { isDate, parseHM } from '../lib/time.js';
import { formatTableList, parseTableList } from '../lib/tables.js';

// Đặt bàn R1 (nhân viên nhập khi khách gọi / nhắn) + danh sách chờ khách vãng lai
const STATUS = ['booked', 'waiting', 'arrived', 'no_show', 'cancelled'];

export default function (r, ctx) {
  const { db } = ctx;
  const dining = () => Number(ctx.setting('dining_minutes') || 70);
  const minOf = (x) => { try { return parseHM(String(x)); } catch { return fail(400, 'Giờ không hợp lệ'); } };
  const overlap = (a, b) => a.start < b.end && b.start < a.end;

  // Bàn đã có đặt chỗ trùng khung giờ (trừ chính đơn đang sửa)
  function heldTables(date, start, end, exceptId = 0) {
    const out = new Map();
    for (const x of db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'booking' AND status IN ('booked','arrived') AND id != ?").all(date, exceptId)) {
      if (!overlap({ start, end }, { start: x.time_min, end: x.time_min + x.duration_min })) continue;
      for (const n of parseTableList(x.tables)) out.set(n, x);
    }
    return out;
  }

  function readBody(body, cur = {}) {
    const kind = body.kind === undefined ? cur.kind ?? 'booking' : v.oneOf(body.kind, ['booking', 'walkin'], { name: 'Loại' });
    const date = body.date === undefined ? cur.date ?? ctx.today() : String(body.date);
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    const time = body.time === undefined ? cur.time_min ?? 0 : minOf(body.time);
    const guests = body.guests === undefined ? cur.guests ?? 2 : v.int(body.guests, { min: 1, max: 500, name: 'Số khách' });
    const duration = body.duration_min === undefined ? cur.duration_min ?? Math.max(60, dining() + 15) : v.int(body.duration_min, { min: 15, max: 600, name: 'Thời gian ngồi' });
    let tables = cur.tables ?? '';
    if (body.tables !== undefined) {
      let nums;
      try { nums = parseTableList(String(body.tables || '')); } catch (e) { fail(400, e.message); }
      for (const n of nums) if (!db.prepare('SELECT 1 FROM dining_tables WHERE number = ?').get(n)) fail(400, `Bàn ${n} không có trong sơ đồ`);
      tables = formatTableList(nums);
    }
    const phone = body.phone === undefined ? cur.phone ?? '' : v.text(body.phone, { name: 'Số điện thoại', max: 20 }).replace(/[^\d+]/g, '');
    if (kind === 'booking' && !phone) fail(400, 'Cần số điện thoại khách đặt bàn');
    return {
      kind, date, time, guests, duration, tables, phone,
      name: body.name === undefined ? cur.name : v.text(body.name, { name: 'Tên khách', required: true, max: 60 }),
      zone: body.zone_id === undefined ? cur.zone_id ?? null : v.optInt(body.zone_id, { min: 1, name: 'Khu' }),
      priority: body.priority === undefined ? cur.priority ?? 0 : v.bool(body.priority),
      note: body.note === undefined ? cur.note ?? '' : v.text(body.note, { name: 'Ghi chú', max: 200 }),
    };
  }

  function checkClash(f, exceptId = 0) {
    if (f.kind !== 'booking' || !f.tables) return;
    const held = heldTables(f.date, f.time, f.time + f.duration, exceptId);
    const clash = parseTableList(f.tables).filter((n) => held.has(n));
    if (clash.length) {
      const x = held.get(clash[0]);
      fail(409, `Bàn ${formatTableList(clash)} đã giữ cho ${x.name} lúc ${String(Math.floor(x.time_min / 60)).padStart(2, '0')}:${String(x.time_min % 60).padStart(2, '0')}`);
    }
  }

  // Lịch sử khách theo SĐT: số lần đến / không đến
  function history(phone) {
    if (!phone) return null;
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM reservations WHERE phone = ? AND kind = 'booking' GROUP BY status").all(phone);
    const get = (s) => rows.find((x) => x.status === s)?.n || 0;
    return { arrived: get('arrived'), no_show: get('no_show'), cancelled: get('cancelled') };
  }

  r.get('/api/reservations', 'staff', ({ query }) => {
    const date = query.get('date') || ctx.today();
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    const rows = db.prepare(`SELECT x.*, z.name AS zone_name, c.name AS created_by_name FROM reservations x
      LEFT JOIN zones z ON z.id = x.zone_id LEFT JOIN staff c ON c.id = x.created_by
      WHERE x.date = ? ORDER BY x.kind, x.time_min, x.id`).all(date);
    const guests = rows.filter((x) => x.kind === 'booking' && ['booked', 'arrived'].includes(x.status)).reduce((n, x) => n + x.guests, 0);
    return {
      date, hold_minutes: Number(ctx.setting('reserve_hold_minutes') || 15), guests,
      items: rows.map((x) => ({ ...x, priority: !!x.priority, history: history(x.phone) })),
    };
  });

  // Gợi ý bàn trống đủ chỗ cho khung giờ; nhóm đông thì gợi ý gộp các bàn liền số trong cùng khu
  r.get('/api/reservations/suggest', 'staff', ({ query }) => {
    const date = query.get('date') || ctx.today();
    const start = minOf(query.get('time') || '19:00');
    const guests = v.int(query.get('guests') || 2, { min: 1, max: 500, name: 'Số khách' });
    const zoneId = v.optInt(query.get('zone_id'), { min: 1, name: 'Khu' });
    const except = v.optInt(query.get('except'), { min: 1, name: 'Đơn' }) || 0;
    const held = heldTables(date, start, start + Math.max(60, dining() + 15), except);
    const busyNow = date === ctx.today() ? new Set(db.prepare("SELECT t.table_number FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE s.status IN ('open','paying')").all().map((x) => x.table_number)) : new Set();
    const zones = db.prepare('SELECT * FROM zones WHERE active = 1 ORDER BY sort, id').all().filter((z) => !zoneId || z.id === zoneId);
    const out = [];
    for (const z of zones) {
      const free = db.prepare('SELECT number, seats FROM dining_tables WHERE zone_id = ? ORDER BY number').all(z.id).filter((t) => !held.has(t.number));
      for (const t of free) if (t.seats >= guests) out.push({ zone_id: z.id, zone_name: z.name, tables: [t.number], seats: t.seats, busy_now: busyNow.has(t.number) });
      // Gộp bàn liền nhau
      for (let i = 0; i < free.length && out.length < 30; i++) {
        let seats = 0;
        const run = [];
        for (let j = i; j < free.length && (j === i || free[j].number === free[j - 1].number + 1); j++) {
          run.push(free[j].number);
          seats += free[j].seats;
          if (run.length > 1 && seats >= guests) { out.push({ zone_id: z.id, zone_name: z.name, tables: [...run], seats, busy_now: run.some((n) => busyNow.has(n)) }); break; }
          if (seats >= guests) break;
        }
      }
    }
    // Ít ghế thừa nhất, ít bàn nhất, chưa có khách lúc này
    out.sort((a, b) => Number(a.busy_now) - Number(b.busy_now) || a.tables.length - b.tables.length || (a.seats - guests) - (b.seats - guests) || a.tables[0] - b.tables[0]);
    return out.slice(0, 12).map((x) => ({ ...x, tables_text: formatTableList(x.tables) }));
  });

  r.post('/api/reservations', 'staff', ({ me, body }) => {
    const f = readBody(body);
    checkClash(f);
    const id = Number(db.prepare(`INSERT INTO reservations (kind, name, phone, guests, date, time_min, duration_min, zone_id, tables, priority, note, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.kind, f.name, f.phone, f.guests, f.date, f.time, f.duration, f.zone, f.tables, f.priority, f.note,
      f.kind === 'walkin' ? 'waiting' : 'booked', me.id, ctx.now()).lastInsertRowid);
    ctx.audit(me, 'reservation.create', { id, name: f.name, date: f.date, guests: f.guests });
    ctx.broadcast('reservations');
    ctx.broadcast('pos');
    return { id, history: history(f.phone) };
  });

  r.patch('/api/reservations/:id', 'staff', ({ me, params, body }) => {
    const cur = db.prepare('SELECT * FROM reservations WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy đặt bàn');
    const f = readBody(body, cur);
    const status = body.status === undefined ? cur.status : v.oneOf(body.status, STATUS, { name: 'Trạng thái' });
    if (status === 'arrived' && cur.status !== 'arrived') fail(400, 'Bấm "Khách đến" để mở bàn');
    if (['booked', 'arrived'].includes(status)) checkClash(f, cur.id);
    db.prepare(`UPDATE reservations SET name = ?, phone = ?, guests = ?, date = ?, time_min = ?, duration_min = ?, zone_id = ?, tables = ?, priority = ?, note = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(f.name, f.phone, f.guests, f.date, f.time, f.duration, f.zone, f.tables, f.priority, f.note, status, ctx.now(), cur.id);
    ctx.audit(me, 'reservation.update', { id: cur.id, status });
    ctx.broadcast('reservations');
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Khách đến: mở bàn trên các bàn đã giữ (hoặc bàn chọn lúc đó)
  r.post('/api/reservations/:id/arrive', 'staff', ({ me, params, body }) => {
    const cur = db.prepare('SELECT * FROM reservations WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy đặt bàn');
    if (!['booked', 'waiting'].includes(cur.status)) fail(400, 'Đặt bàn này đã xử lý');
    let tables = body.tables !== undefined ? String(body.tables) : cur.tables;
    let nums;
    try { nums = parseTableList(tables); } catch (e) { fail(400, e.message); }
    if (!nums.length) fail(400, 'Chọn bàn cho khách');
    tables = formatTableList(nums);
    const guests = body.guests === undefined ? cur.guests : v.int(body.guests, { min: 1, max: 500, name: 'Số khách' });
    // Bàn giữ đang có khách khác ngồi → gợi ý bàn trống cùng khu để chọn
    const busy = nums.filter((n) => db.prepare("SELECT 1 FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE t.table_number = ? AND s.status IN ('open','paying')").get(n));
    if (busy.length) {
      const zone = db.prepare('SELECT zone_id FROM dining_tables WHERE number = ?').get(busy[0])?.zone_id;
      const free = db.prepare(`SELECT number FROM dining_tables d WHERE NOT EXISTS (SELECT 1 FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE t.table_number = d.number AND s.status IN ('open','paying'))
        ORDER BY (zone_id = ?) DESC, ABS(number - ?) LIMIT 5`).all(zone, busy[0]).map((x) => x.number).filter((n) => !(ctx.reservedSoon && ctx.reservedSoon(n) && ctx.reservedSoon(n).id !== cur.id));
      fail(409, `Bàn ${busy.join(', ')} đang có khách. Bàn trống gần nhất: ${free.join(', ') || 'hết bàn, cho khách vào danh sách chờ'}`);
    }
    const sid = tx(db, () => {
      const id = ctx.openTableSession(me, { tables: nums, guests, priority: !!cur.priority, note: cur.note, reservationId: cur.id });
      db.prepare("UPDATE reservations SET status = 'arrived', session_id = ?, tables = ?, guests = ?, updated_at = ? WHERE id = ?").run(id, tables, guests, ctx.now(), cur.id);
      return id;
    });
    ctx.audit(me, 'reservation.arrive', { id: cur.id, session: sid });
    ctx.broadcast('reservations');
    ctx.broadcast('pos');
    return { session_id: sid };
  });
}
