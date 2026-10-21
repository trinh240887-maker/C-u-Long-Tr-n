import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { formatTableList, parseTableList } from '../lib/tables.js';

// GĐ3B: mở bàn, gọi món, gửi bếp (tạo phiếu theo điểm in), huỷ / làm lại, chuyển & gộp bàn
const OPEN = ['open', 'paying'];
const CANCEL_GRACE_MS = 2 * 60_000; // nhân viên tự huỷ món vừa gửi trong 2 phút; sau đó cần trưởng ca

export default function (r, ctx) {
  const { db } = ctx;

  const tablesOf = (sid) => db.prepare('SELECT table_number FROM session_tables WHERE session_id = ? ORDER BY table_number').all(sid).map((x) => x.table_number);
  const busyTable = (n, exceptSession = 0) => db.prepare(`SELECT s.id FROM session_tables t JOIN table_sessions s ON s.id = t.session_id
    WHERE t.table_number = ? AND s.status IN ('open','paying') AND s.id != ?`).get(n, exceptSession);
  const zoneOf = (n) => db.prepare('SELECT z.name FROM dining_tables t JOIN zones z ON z.id = t.zone_id WHERE t.number = ?').get(n)?.name || '';
  const headerOf = (sid) => {
    const ts = tablesOf(sid);
    const zone = ts.length ? zoneOf(ts[0]) : '';
    return `${zone ? `${zone.toUpperCase()} - ` : ''}${formatTableList(ts)}`;
  };
  const itemView = (i) => ({ ...i, options: JSON.parse(i.options || '[]'), rush: !!i.rush, total: i.unit_price * i.qty });

  function session(id) {
    const s = db.prepare('SELECT s.*, o.name AS opened_by_name FROM table_sessions s LEFT JOIN staff o ON o.id = s.opened_by WHERE s.id = ?').get(id);
    if (!s) fail(404, 'Không tìm thấy bàn');
    const items = db.prepare(`SELECT i.*, c.name AS created_by_name FROM order_items i LEFT JOIN staff c ON c.id = i.created_by
      WHERE i.session_id = ? ORDER BY i.id`).all(id).map(itemView);
    const live = items.filter((i) => i.status !== 'cancelled');
    return {
      ...s, priority: !!s.priority, tables: tablesOf(id), header: headerOf(id), items,
      subtotal: live.reduce((n, i) => n + i.total, 0),
      unsent: live.filter((i) => i.status === 'new').length,
    };
  }
  ctx.posSession = session;
  const openSession = (id) => {
    const s = session(id);
    if (!OPEN.includes(s.status)) fail(400, 'Bàn này đã đóng');
    return s;
  };

  // ---------- Sơ đồ bàn bán hàng ----------
  r.get('/api/pos/tables', 'staff', () => {
    const now = ctx.now();
    const clock = ctx.clock();
    const today = ctx.today();
    const sessions = db.prepare("SELECT * FROM table_sessions WHERE status IN ('open','paying')").all();
    const bySession = new Map(sessions.map((s) => [s.id, s]));
    const totals = new Map(db.prepare(`SELECT session_id, SUM(unit_price * qty) AS total, SUM(status = 'new') AS unsent, COUNT(*) AS n
      FROM order_items WHERE status != 'cancelled' GROUP BY session_id`).all().map((x) => [x.session_id, x]));
    const tableSession = new Map();
    for (const t of db.prepare("SELECT t.* FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE s.status IN ('open','paying')").all()) tableSession.set(t.table_number, t.session_id);
    // Đặt bàn sắp tới trong 3 giờ (hoặc đang tới giờ) giữ các bàn đã gán
    const hold = Number(ctx.setting('reserve_hold_minutes') || 15);
    const upcoming = new Map();
    for (const rv of db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'booking' AND status = 'booked'").all(today)) {
      const at = clock.toEpoch(today, rv.time_min);
      if (at - now > 3 * 3600_000 || now - at > hold * 60_000) continue;
      for (const n of parseTableList(rv.tables)) if (!upcoming.has(n)) upcoming.set(n, { id: rv.id, name: rv.name, guests: rv.guests, time_min: rv.time_min, late: now > at });
    }
    const zones = db.prepare('SELECT * FROM zones WHERE active = 1 ORDER BY sort, id').all();
    const tables = db.prepare('SELECT * FROM dining_tables ORDER BY number').all();
    return {
      now,
      zones: zones.map((z) => ({
        id: z.id, name: z.name, color: z.color,
        tables: tables.filter((t) => t.zone_id === z.id).map((t) => {
          const sid = tableSession.get(t.number);
          const s = sid ? bySession.get(sid) : null;
          const tot = sid ? totals.get(sid) : null;
          return {
            number: t.number, seats: t.seats, reservation: upcoming.get(t.number) || null,
            session: s ? { id: s.id, status: s.status, guests: s.guests, priority: !!s.priority, opened_at: s.opened_at, total: tot?.total || 0, unsent: tot?.unsent || 0, items: tot?.n || 0, tables: tablesOf(s.id) } : null,
          };
        }),
      })),
    };
  });

  // ---------- Mở bàn ----------
  function readTables(list) {
    const nums = [...new Set((Array.isArray(list) ? list : parseTableList(String(list || ''))).map(Number))];
    if (!nums.length) fail(400, 'Chọn ít nhất 1 bàn');
    for (const n of nums) if (!db.prepare('SELECT 1 FROM dining_tables WHERE number = ?').get(n)) fail(400, `Bàn ${n} không có trong sơ đồ`);
    return nums;
  }
  ctx.openTableSession = (me, { tables, guests = 1, priority = false, note = '', reservationId = null }) => {
    for (const n of tables) if (busyTable(n)) fail(409, `Bàn ${n} đang có khách`);
    const id = Number(db.prepare('INSERT INTO table_sessions (guests, priority, note, reservation_id, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guests, priority ? 1 : 0, note, reservationId, ctx.now(), me.id).lastInsertRowid);
    const add = db.prepare('INSERT INTO session_tables (session_id, table_number) VALUES (?, ?)');
    for (const n of tables) add.run(id, n);
    return id;
  };

  r.post('/api/pos/sessions', 'staff', ({ me, body }) => {
    const tables = readTables(body.tables);
    const guests = v.int(body.guests ?? 1, { min: 1, max: 500, name: 'Số khách' });
    const id = tx(db, () => ctx.openTableSession(me, { tables, guests, priority: v.bool(body.priority), note: v.text(body.note, { name: 'Ghi chú', max: 200 }) }));
    ctx.audit(me, 'pos.open', { id, tables, guests });
    ctx.broadcast('pos');
    return { id };
  });

  r.get('/api/pos/sessions/:id', 'staff', ({ params }) => session(params.id));

  r.patch('/api/pos/sessions/:id', 'staff', ({ me, params, body }) => {
    const s = openSession(params.id);
    db.prepare('UPDATE table_sessions SET guests = ?, priority = ?, note = ? WHERE id = ?').run(
      body.guests === undefined ? s.guests : v.int(body.guests, { min: 1, max: 500, name: 'Số khách' }),
      body.priority === undefined ? (s.priority ? 1 : 0) : v.bool(body.priority),
      body.note === undefined ? s.note : v.text(body.note, { name: 'Ghi chú', max: 200 }), s.id);
    ctx.audit(me, 'pos.session.update', { id: s.id, ...body });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // ---------- Gọi món (nháp, chưa gửi bếp) ----------
  function readOptions(item, optionIds) {
    const all = db.prepare('SELECT * FROM menu_options WHERE item_id = ? ORDER BY sort, id').all(item.id);
    const ids = new Set((Array.isArray(optionIds) ? optionIds : []).map(Number));
    const chosen = all.filter((o) => ids.has(o.id));
    const groups = [...new Set(all.map((o) => o.group_name))];
    for (const g of groups) {
      const inGroup = all.filter((o) => o.group_name === g);
      const picked = chosen.filter((o) => o.group_name === g);
      if (inGroup.some((o) => o.required) && picked.length !== 1) fail(400, `Chọn 1 ${g.toLowerCase()} cho ${item.name}`);
    }
    return chosen.map((o) => ({ group: o.group_name, name: o.name, price: o.price }));
  }

  r.post('/api/pos/sessions/:id/items', 'staff', ({ me, params, body }) => {
    const s = openSession(params.id);
    const item = db.prepare('SELECT * FROM menu_items WHERE id = ? AND active = 1').get(v.int(body.menu_item_id, { min: 1, name: 'Món' }));
    if (!item) fail(404, 'Món không còn trong thực đơn');
    if (item.sold_out) fail(400, `${item.name} đã hết`);
    const options = readOptions(item, body.option_ids);
    const qty = v.int(body.qty ?? 1, { min: 1, max: 99, name: 'Số lượng' });
    const unit = item.price + options.reduce((n, o) => n + o.price, 0);
    const id = Number(db.prepare(`INSERT INTO order_items (session_id, menu_item_id, name, unit_price, qty, options, note, rush, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, item.id, item.name, unit, qty, JSON.stringify(options),
      v.text(body.note, { name: 'Ghi chú món', max: 120 }), v.bool(body.rush), me.id, ctx.now()).lastInsertRowid);
    ctx.broadcast('pos');
    return { id };
  });

  const loadItem = (id) => {
    const i = db.prepare('SELECT * FROM order_items WHERE id = ?').get(id);
    if (!i) fail(404, 'Không tìm thấy món');
    openSession(i.session_id);
    return i;
  };

  r.patch('/api/pos/items/:id', 'staff', ({ params, body }) => {
    const i = loadItem(params.id);
    if (i.status !== 'new') fail(400, 'Món đã gửi bếp; muốn đổi thì huỷ rồi gọi lại');
    db.prepare('UPDATE order_items SET qty = ?, note = ?, rush = ? WHERE id = ?').run(
      body.qty === undefined ? i.qty : v.int(body.qty, { min: 1, max: 99, name: 'Số lượng' }),
      body.note === undefined ? i.note : v.text(body.note, { name: 'Ghi chú món', max: 120 }),
      body.rush === undefined ? i.rush : v.bool(body.rush), i.id);
    ctx.broadcast('pos');
    return { ok: true };
  });

  // ---------- Phiếu bếp ----------
  const station = (id) => (id ? db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(id) : null);
  // Tách món thành các dòng theo điểm in (combo có nhiều phần); bàn ưu tiên / gấp / làm lại → máy ưu tiên của điểm đó
  function routeLines(items, { priority = false } = {}) {
    const byStation = new Map();
    for (const i of items) {
      const parts = i.menu_item_id ? db.prepare('SELECT * FROM menu_item_parts WHERE item_id = ? ORDER BY sort, id').all(i.menu_item_id) : [];
      const main = i.menu_item_id ? db.prepare('SELECT station_id FROM menu_items WHERE id = ?').get(i.menu_item_id)?.station_id : null;
      const targets = parts.length ? parts.map((p) => ({ station_id: p.station_id, label: p.label })) : [{ station_id: main, label: '' }];
      for (const t of targets) {
        if (!t.station_id) continue;
        let sid = t.station_id;
        const st = station(sid);
        const urgent = priority || i.rush;
        if (urgent && st?.priority_station_id) sid = st.priority_station_id;
        const key = `${sid}:${urgent ? 1 : 0}`;
        if (!byStation.has(key)) byStation.set(key, { station_id: sid, priority: urgent ? 1 : 0, lines: [] });
        byStation.get(key).lines.push({ item_id: i.id, name: i.name, qty: i.qty, options: JSON.parse(i.options || '[]').map((o) => o.name), note: i.note, label: t.label, rush: !!i.rush });
      }
    }
    return [...byStation.values()];
  }
  function makeTickets(me, s, items, kind, { priority = s.priority } = {}) {
    const add = db.prepare('INSERT INTO kitchen_tickets (session_id, station_id, kind, priority, header, lines, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const out = [];
    for (const g of routeLines(items, { priority })) {
      out.push(Number(add.run(s.id, g.station_id, kind, g.priority, s.header, JSON.stringify(g.lines), me.id, ctx.now()).lastInsertRowid));
    }
    return out;
  }

  r.post('/api/pos/sessions/:id/send', 'staff', ({ me, params }) => {
    const s = openSession(params.id);
    const items = s.items.filter((i) => i.status === 'new').map((i) => ({ ...i, options: JSON.stringify(i.options) }));
    if (!items.length) fail(400, 'Chưa có món mới để gửi');
    const first = !s.items.some((i) => i.status === 'sent' || i.status === 'done');
    const tickets = tx(db, () => {
      db.prepare("UPDATE order_items SET status = 'sent', sent_at = ?, sent_by = ? WHERE session_id = ? AND status = 'new'").run(ctx.now(), me.id, s.id);
      return makeTickets(me, s, items, first ? 'new' : 'add');
    });
    ctx.audit(me, 'pos.send', { id: s.id, items: items.length, tickets: tickets.length });
    ctx.broadcast('pos');
    ctx.broadcast('tickets');
    return { items: items.length, tickets: tickets.length };
  });

  r.post('/api/pos/items/:id/cancel', 'staff', ({ me, params, body }) => {
    const i = loadItem(params.id);
    if (i.status === 'cancelled') fail(400, 'Món đã huỷ');
    if (i.status === 'new') {
      db.prepare('DELETE FROM order_items WHERE id = ?').run(i.id);
      ctx.broadcast('pos');
      return { ok: true, deleted: true };
    }
    const reason = v.text(body.reason, { name: 'Lý do huỷ', required: true, max: 120 });
    const late = i.status === 'done' || ctx.now() - (i.sent_at || 0) > CANCEL_GRACE_MS;
    if (late && rank(me.role) < rank('shift_lead')) fail(403, 'Món đã gửi bếp quá 2 phút: nhờ trưởng ca huỷ');
    const s = session(i.session_id);
    tx(db, () => {
      db.prepare("UPDATE order_items SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?").run(ctx.now(), me.id, reason, i.id);
      makeTickets(me, s, [{ ...i, note: reason }], 'cancel');
    });
    ctx.audit(me, 'pos.item.cancel', { id: i.id, name: i.name, qty: i.qty, reason });
    ctx.broadcast('pos');
    ctx.broadcast('tickets');
    return { ok: true };
  });

  // Phục vụ bấm "Đã ra" khi bưng món ra bàn (bấm lại để bỏ)
  r.post('/api/pos/items/:id/served', 'staff', ({ me, params, body }) => {
    const i = loadItem(params.id);
    if (!['sent', 'done'].includes(i.status)) fail(400, 'Món chưa gửi bếp');
    const done = body.done === undefined ? true : v.bool(body.done);
    db.prepare('UPDATE order_items SET status = ? WHERE id = ?').run(done ? 'done' : 'sent', i.id);
    ctx.audit(me, 'pos.item.served', { id: i.id, done });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Làm lại (khách chê, làm hỏng): in lại ra máy ưu tiên, không tính tiền thêm
  r.post('/api/pos/items/:id/redo', 'staff', ({ me, params, body }) => {
    const i = loadItem(params.id);
    if (!['sent', 'done'].includes(i.status)) fail(400, 'Chỉ làm lại món đã gửi bếp');
    const reason = v.text(body.reason, { name: 'Lý do làm lại', required: true, max: 120 });
    const s = session(i.session_id);
    tx(db, () => makeTickets(me, s, [{ ...i, note: reason }], 'redo', { priority: true }));
    ctx.audit(me, 'pos.item.redo', { id: i.id, name: i.name, reason });
    ctx.broadcast('tickets');
    return { ok: true };
  });

  // ---------- Chuyển, gộp, huỷ bàn ----------
  r.post('/api/pos/sessions/:id/move', 'staff', ({ me, params, body }) => {
    const s = openSession(params.id);
    const to = readTables(body.tables);
    for (const n of to) if (busyTable(n, s.id)) fail(409, `Bàn ${n} đang có khách; muốn gộp thì dùng Gộp bàn`);
    tx(db, () => {
      db.prepare('DELETE FROM session_tables WHERE session_id = ?').run(s.id);
      const add = db.prepare('INSERT INTO session_tables (session_id, table_number) VALUES (?, ?)');
      for (const n of to) add.run(s.id, n);
      // Báo các điểm đang làm món của bàn này: giao sang bàn mới
      // Chỉ báo những món CHƯA RA bàn (phục vụ bỏ chọn món đã ra; món đã bấm "Đã ra" không báo)
      const pick = Array.isArray(body.notify_item_ids) ? new Set(body.notify_item_ids.map(Number)) : null;
      const live = s.items.filter((i) => i.status === 'sent' && (!pick || pick.has(i.id))).map((i) => ({ ...i, options: JSON.stringify(i.options), note: `Chuyển từ bàn ${s.header}` }));
      if (live.length) makeTickets(me, { ...s, header: headerOf(s.id) }, live, 'move');
    });
    ctx.audit(me, 'pos.move', { id: s.id, from: s.tables, to });
    ctx.broadcast('pos');
    ctx.broadcast('tickets');
    return { ok: true };
  });

  // Chuyển 1 món sang bàn khác (gọi nhầm bàn); bàn đích trống thì tự nhận khách
  r.post('/api/pos/items/:id/move', 'staff', ({ me, params, body }) => {
    const i = loadItem(params.id);
    if (i.status === 'cancelled') fail(400, 'Món đã huỷ');
    const [n] = readTables([v.int(body.table, { min: 1, name: 'Bàn' })]);
    const from = session(i.session_id);
    const out = tx(db, () => {
      const cur = busyTable(n);
      const target = cur ? cur.id : ctx.openTableSession(me, { tables: [n] });
      if (target === from.id) fail(400, 'Món đang ở bàn này rồi');
      db.prepare('UPDATE order_items SET session_id = ? WHERE id = ?').run(target, i.id);
      if (i.status === 'sent' && body.notify !== false) makeTickets(me, { id: target, header: headerOf(target), priority: false }, [{ ...i, note: `Chuyển từ bàn ${from.header}` }], 'move');
      return target;
    });
    ctx.audit(me, 'pos.item.move', { id: i.id, name: i.name, from: from.id, to: out });
    ctx.broadcast('pos');
    ctx.broadcast('tickets');
    return { session_id: out };
  });

  r.post('/api/pos/sessions/:id/merge', 'staff', ({ me, params, body }) => {
    const s = openSession(params.id);
    const other = openSession(v.int(body.from_session_id, { min: 1, name: 'Bàn gộp' }));
    if (other.id === s.id) fail(400, 'Chọn bàn khác để gộp');
    tx(db, () => {
      db.prepare('UPDATE order_items SET session_id = ? WHERE session_id = ?').run(s.id, other.id);
      db.prepare('UPDATE kitchen_tickets SET session_id = ? WHERE session_id = ?').run(s.id, other.id);
      for (const n of other.tables) db.prepare('INSERT OR IGNORE INTO session_tables (session_id, table_number) VALUES (?, ?)').run(s.id, n);
      db.prepare('DELETE FROM session_tables WHERE session_id = ?').run(other.id);
      db.prepare('UPDATE table_sessions SET guests = guests + ?, priority = MAX(priority, ?) WHERE id = ?').run(other.guests, other.priority ? 1 : 0, s.id);
      db.prepare("UPDATE table_sessions SET status = 'cancelled', closed_at = ?, closed_by = ?, note = ? WHERE id = ?").run(ctx.now(), me.id, `Gộp vào bàn ${s.header}`, other.id);
    });
    ctx.audit(me, 'pos.merge', { into: s.id, from: other.id });
    ctx.broadcast('pos');
    return { ok: true };
  });

  r.post('/api/pos/sessions/:id/request-bill', 'staff', ({ me, params }) => {
    const s = openSession(params.id);
    if (s.unsent) fail(400, `Còn ${s.unsent} món chưa gửi bếp`);
    db.prepare("UPDATE table_sessions SET status = 'paying' WHERE id = ?").run(s.id);
    ctx.notify(ctx.managers().filter((x) => x !== me.id).concat(db.prepare("SELECT id FROM staff WHERE active = 1 AND team_id IN (SELECT id FROM teams WHERE name = 'Thu ngân')").all().map((x) => x.id)), {
      title: `Bàn ${s.header} xin thanh toán`, body: `Tạm tính ${s.subtotal.toLocaleString('vi-VN')}đ`, link: `/goi-mon?s=${s.id}`,
    });
    ctx.audit(me, 'pos.request_bill', { id: s.id });
    ctx.broadcast('pos');
    return { ok: true };
  });

  r.post('/api/pos/sessions/:id/cancel', 'staff', ({ me, params, body }) => {
    const s = openSession(params.id);
    const sent = s.items.filter((i) => ['sent', 'done'].includes(i.status));
    if (sent.length && rank(me.role) < rank('shift_lead')) fail(403, 'Bàn đã gửi món bếp: nhờ trưởng ca huỷ');
    const reason = v.text(body.reason, { name: 'Lý do', max: 120 }) || 'Khách về / mở nhầm';
    tx(db, () => {
      if (sent.length) {
        db.prepare("UPDATE order_items SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE session_id = ? AND status IN ('sent','done')").run(ctx.now(), me.id, reason, s.id);
        makeTickets(me, s, sent.map((i) => ({ ...i, options: JSON.stringify(i.options), note: reason })), 'cancel');
      }
      db.prepare("DELETE FROM order_items WHERE session_id = ? AND status = 'new'").run(s.id);
      db.prepare("UPDATE table_sessions SET status = 'cancelled', closed_at = ?, closed_by = ?, note = ? WHERE id = ?").run(ctx.now(), me.id, reason, s.id);
    });
    ctx.audit(me, 'pos.session.cancel', { id: s.id, reason, sent: sent.length });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Phiếu bếp gần đây (để kiểm tra trước khi có màn hình bếp / cầu nối in ở GĐ3C)
  r.get('/api/pos/tickets', 'team_lead', ({ query }) => {
    const sid = v.optInt(query.get('station'), { min: 1, name: 'Điểm in' });
    return db.prepare(`SELECT k.*, st.name AS station_name FROM kitchen_tickets k LEFT JOIN kitchen_stations st ON st.id = k.station_id
      ${sid ? 'WHERE k.station_id = ?' : ''} ORDER BY k.id DESC LIMIT 100`).all(...(sid ? [sid] : [])).map((k) => ({ ...k, lines: JSON.parse(k.lines), priority: !!k.priority }));
  });
}
