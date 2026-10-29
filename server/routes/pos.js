import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { overridesOf } from '../lib/acts.js';
import { formatTableList, parseTableList } from '../lib/tables.js';
import { applyPromos } from '../lib/promo.js';

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
  // Ngưỡng trễ của món = số phút lớn nhất trong các điểm làm món đó (combo nhiều điểm thì lấy điểm chậm nhất)
  const lateCache = new Map();
  function lateLimit(menuItemId) {
    if (!menuItemId) return 15;
    if (lateCache.has(menuItemId)) return lateCache.get(menuItemId);
    const ids = db.prepare('SELECT station_id FROM menu_item_parts WHERE item_id = ? AND station_id IS NOT NULL').all(menuItemId).map((x) => x.station_id);
    if (!ids.length) { const m = db.prepare('SELECT station_id FROM menu_items WHERE id = ?').get(menuItemId)?.station_id; if (m) ids.push(m); }
    const lim = ids.length ? Math.max(...ids.map((id) => db.prepare('SELECT late_minutes FROM kitchen_stations WHERE id = ?').get(id)?.late_minutes ?? 10)) : 15;
    lateCache.set(menuItemId, lim);
    setTimeout(() => lateCache.delete(menuItemId), 60_000);
    return lim;
  }
  const stationNames = (menuItemId) => {
    if (!menuItemId) return [];
    const parts = db.prepare('SELECT DISTINCT s.name FROM menu_item_parts p JOIN kitchen_stations s ON s.id = p.station_id WHERE p.item_id = ?').all(menuItemId).map((x) => x.name);
    if (parts.length) return parts;
    const m = db.prepare('SELECT s.name FROM menu_items i JOIN kitchen_stations s ON s.id = i.station_id WHERE i.id = ?').get(menuItemId);
    return m ? [m.name] : [];
  };
  const waitInfo = (i) => {
    if (i.status !== 'sent' || !i.sent_at) return { wait_min: null, late_min: 0 };
    const wait = Math.floor((ctx.now() - i.sent_at) / 60_000);
    const lim = lateLimit(i.menu_item_id);
    return { wait_min: wait, limit_min: lim, late_min: Math.max(0, wait - lim) };
  };
  // Nhân viên xin huỷ món đã gửi bếp (chủ quán 29/10): ghi lý do → báo trưởng ca / quản lý duyệt
  for (const [c, d] of [['cancel_req_reason', 'TEXT'], ['cancel_req_by', 'INTEGER'], ['cancel_req_at', 'INTEGER']]) {
    if (!db.prepare('PRAGMA table_info(order_items)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE order_items ADD COLUMN ${c} ${d}`);
  }
  const leadsOnShift = () => {
    const ids = db.prepare(`SELECT DISTINCT s.id FROM staff s WHERE s.active = 1 AND s.role IN ('shift_lead','manager')
      AND (EXISTS (SELECT 1 FROM attendance a WHERE a.staff_id = s.id AND a.clock_out IS NULL) OR EXISTS (SELECT 1 FROM assignments a WHERE a.staff_id = s.id AND a.date = ?))`).all(ctx.today()).map((x) => x.id);
    return ids.length ? ids : db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id);
  };
  const itemView = (i) => ({ ...i, options: JSON.parse(i.options || '[]'), rush: !!i.rush, total: i.unit_price * i.qty, ...waitInfo(i) });
  // Món đã gửi bếp quá ngưỡng mà chưa ra (dùng cho sơ đồ bàn, màn Quản lý, nhắc bếp)
  function lateItems() {
    const rows = db.prepare(`SELECT i.* FROM order_items i JOIN table_sessions s ON s.id = i.session_id
      WHERE i.status = 'sent' AND s.status IN ('open','paying') ORDER BY i.sent_at`).all();
    return rows.map(itemView).filter((i) => i.late_min > 0).map((i) => ({ ...i, header: headerOf(i.session_id), stations: stationNames(i.menu_item_id) }));
  }
  ctx.posLateItems = lateItems;

  function session(id) {
    const s = db.prepare('SELECT s.*, o.name AS opened_by_name FROM table_sessions s LEFT JOIN staff o ON o.id = s.opened_by WHERE s.id = ?').get(id);
    if (!s) fail(404, 'Không tìm thấy bàn');
    const rows = db.prepare(`SELECT i.*, c.name AS created_by_name, m.category_id, rq.name AS cancel_req_by_name FROM order_items i LEFT JOIN staff c ON c.id = i.created_by
      LEFT JOIN staff rq ON rq.id = i.cancel_req_by LEFT JOIN menu_items m ON m.id = i.menu_item_id WHERE i.session_id = ? ORDER BY i.id`).all(id).map(itemView);
    // Khuyến mãi chỉ đổi tiền: tính lại mỗi lần xem bàn (huỷ / tách / gộp món thì tự đúng)
    let pr = applyPromos(rows.filter((i) => i.status !== 'cancelled'), ctx.promosFor ? ctx.promosFor() : [], { clock: ctx.clock(), openedAt: s.opened_at || s.created_at });
    // Bill đã thanh toán: dùng số đã chốt lúc thu tiền (sửa / hết khuyến mãi sau này không làm đổi bill cũ)
    if (s.bill_snapshot) {
      const snap = JSON.parse(s.bill_snapshot);
      pr = { ...snap, lines: new Map(snap.lines) };
    }
    const items = rows.map((i) => {
      const promos = pr.lines.get(i.id) || [];
      const discount = promos.reduce((n, x) => n + x.amount, 0);
      return { ...i, promos, discount, net: i.total - discount };
    });
    const live = items.filter((i) => i.status !== 'cancelled');
    return {
      ...s, priority: !!s.priority, tables: tablesOf(id), header: headerOf(id), items,
      subtotal: pr.subtotal, item_discount: pr.item_discount, bill_promos: pr.bill, discount: pr.discount, total: pr.total,
      // Mua A tặng B: còn được tặng bao nhiêu phần → màn gọi món hiện nút "Thêm món tặng"
      gifts: s.bill_snapshot ? [] : (pr.gifts || []).map((g) => ({ ...g, items: g.gift_item_ids.map((mid) => db.prepare('SELECT id, name, price, sold_out FROM menu_items WHERE id = ? AND active = 1').get(mid)).filter(Boolean) })),
      promo_hints: s.bill_snapshot ? [] : (pr.hints || []).map((h) => ({ ...h, item_name: h.menu_item_id ? live.find((i) => i.menu_item_id === h.menu_item_id)?.name : null })),
      unsent: live.filter((i) => i.status === 'new').length,
      late: live.filter((i) => i.late_min > 0).length,
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
    const totals = new Map(db.prepare(`SELECT session_id, SUM(unit_price * qty) AS total, SUM(status = 'new') AS unsent, SUM(status = 'sent') AS cooking, MAX(created_at) AS last_order, COUNT(*) AS n
      FROM order_items WHERE status != 'cancelled' GROUP BY session_id`).all().map((x) => [x.session_id, x]));
    const lateBySession = new Map();
    for (const i of lateItems()) lateBySession.set(i.session_id, (lateBySession.get(i.session_id) || 0) + 1);
    const tableSession = new Map();
    for (const t of db.prepare("SELECT t.* FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE s.status IN ('open','paying')").all()) tableSession.set(t.table_number, t.session_id);
    // Đặt bàn sắp tới trong 3 giờ (hoặc đang tới giờ) giữ các bàn đã gán
    const hold = Number(ctx.setting('reserve_hold_minutes') || 15);
    const upcoming = new Map();
    for (const rv of db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'booking' AND status = 'booked'").all(today)) {
      const at = clock.toEpoch(today, rv.time_min);
      if (at - now > 3 * 3600_000 || now - at > hold * 60_000) continue;
      const locked = at - now <= Number(ctx.setting('reserve_block_minutes') || 15) * 60_000;
      for (const n of parseTableList(rv.tables)) if (!upcoming.has(n)) upcoming.set(n, { id: rv.id, name: rv.name, guests: rv.guests, time_min: rv.time_min, late: now > at, locked });
    }
    const zones = db.prepare('SELECT * FROM zones WHERE active = 1 ORDER BY sort, id').all();
    const tables = db.prepare('SELECT * FROM dining_tables ORDER BY number').all();
    const sitting = (sid) => { const s = bySession.get(sid); return s ? Math.round((now - s.opened_at) / 60_000) : 0; };
    const longSit = Number(ctx.setting('dining_minutes') || 70);
    const sessIds = new Set(tableSession.values());
    const dirty = ctx.dirtyTables ? ctx.dirtyTables() : new Map();
    const freeNums = tables.filter((t) => !tableSession.has(t.number) && !upcoming.get(t.number)?.locked && !dirty.has(t.number)).map((t) => t.number);
    const zoneOfT = new Map(tables.map((t) => [t.number, t.zone_id]));
    const waitRows = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(guests), 0) AS g FROM reservations WHERE date = ? AND kind = 'walkin' AND status = 'waiting'").get(today);
    // Thời gian ngồi trung bình hôm nay (bàn đã tính tiền), chưa có thì dùng số trong Cài đặt
    const dwellRows = db.prepare("SELECT closed_at - opened_at AS d FROM table_sessions WHERE status = 'closed' AND closed_date = ? AND closed_at IS NOT NULL").all(today).map((x) => x.d / 60_000).filter((d) => d > 10 && d < 300);
    const avgDwell = dwellRows.length >= 5 ? Math.round(dwellRows.reduce((a, b) => a + b, 0) / dwellRows.length) : longSit;
    // Ước tính bàn nào trống trước: xin tính tiền ~5′; ăn xong (món đã ra hết, 15′ không gọi thêm) ~10′; còn lại theo thời gian ngồi trung bình
    const soon = [...sessIds].map((sid) => {
      const ss = bySession.get(sid);
      const tot = totals.get(sid) || {};
      const sat = sitting(sid);
      let min;
      let why;
      if (ss.status === 'paying') { min = 5; why = 'xin tính tiền'; }
      else if (tot.n && !tot.cooking && !tot.unsent && now - (tot.last_order || 0) > 15 * 60_000) { min = Math.min(15, Math.max(5, avgDwell - sat)); why = 'đã ra đủ món'; }
      else { min = Math.max(10, avgDwell - sat); why = tot.cooking ? `còn ${tot.cooking} món chưa ra` : `ngồi ${sat}′`; }
      return { session_id: sid, tables: tablesOf(sid), sitting: sat, minutes: min, reason: why };
    }).sort((a, b) => a.minutes - b.minutes);
    // Nhóm chờ thứ k sẽ có bàn khi bàn sắp trống thứ (k − số bàn trống) trống
    const waitList = db.prepare("SELECT id, name, guests, created_at FROM reservations WHERE date = ? AND kind = 'walkin' AND status = 'waiting' ORDER BY created_at, id").all(today);
    const freeCount = freeNums.length;
    const etaOf = (k) => (k < freeCount ? 0 : soon[k - freeCount]?.minutes ?? null);
    const summary = {
      total: tables.length,
      free: freeNums.length,
      // cặp bàn trống liền nhau cùng khu (cho nhóm đông 6–10 người)
      free_pairs: freeNums.filter((n) => freeNums.includes(n + 1) && zoneOfT.get(n) === zoneOfT.get(n + 1)).length,
      held: [...upcoming.entries()].filter(([n, x]) => x.locked && !tableSession.has(n)).length,
      busy: tableSession.size,
      paying: [...sessIds].filter((sid) => bySession.get(sid)?.status === 'paying').length,
      long_sitting: [...sessIds].filter((sid) => sitting(sid) >= longSit && bySession.get(sid)?.status !== 'paying').length,
      waiting: waitRows.n, waiting_guests: waitRows.g, long_minutes: longSit,
      avg_dwell: avgDwell,
      soon: soon.slice(0, 8),
      dirty: dirty.size,
      queue: ctx.waitPlan ? ctx.waitPlan({ soon }).queue : waitList.map((w, k) => ({ ...w, waited: Math.round((now - w.created_at) / 60_000), eta: etaOf(k) })),
      next_eta: etaOf(waitList.length), // khách mới tới lúc này phải chờ khoảng bao lâu
    };
    return {
      now, summary,
      zones: zones.map((z) => ({
        id: z.id, name: z.name, color: z.color,
        tables: tables.filter((t) => t.zone_id === z.id).map((t) => {
          const sid = tableSession.get(t.number);
          const s = sid ? bySession.get(sid) : null;
          const tot = sid ? totals.get(sid) : null;
          return {
            number: t.number, seats: t.seats, reservation: upcoming.get(t.number) || null, dirty: !tableSession.has(t.number) && dirty.has(t.number) ? dirty.get(t.number).minutes : null,
            session: s ? { id: s.id, status: s.status, guests: s.guests, priority: !!s.priority, opened_at: s.opened_at, total: tot?.total || 0, unsent: tot?.unsent || 0, items: tot?.n || 0, late: lateBySession.get(s.id) || 0, tables: tablesOf(s.id) } : null,
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

  // Bàn đang giữ cho khách đặt trong 90 phút tới (hoặc khách đặt đang trễ trong thời gian giữ)
  ctx.reservedSoon = (n) => {
    const now = ctx.now();
    const clock = ctx.clock();
    const today = clock.businessDate(now);
    const hold = Number(ctx.setting('reserve_hold_minutes') || 15);
    const block = Number(ctx.setting('reserve_block_minutes') || 15);
    for (const rv of db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'booking' AND status = 'booked'").all(today)) {
      const at = clock.toEpoch(today, rv.time_min);
      if (at - now <= block * 60_000 && now - at <= hold * 60_000 && parseTableList(rv.tables).includes(n)) return rv;
    }
    return null;
  };
  // Bàn có khách đặt trong khoảng "khách vãng lai ngồi không kịp" (thời gian ngồi TB + 15′)
  ctx.reservedWithin = (n, minutes) => {
    const now = ctx.now();
    const clock = ctx.clock();
    const today = clock.businessDate(now);
    for (const rv of db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'booking' AND status = 'booked'").all(today)) {
      const at = clock.toEpoch(today, rv.time_min);
      if (at - now > 0 && at - now <= minutes * 60_000 && parseTableList(rv.tables).includes(n)) return { ...rv, in_min: Math.round((at - now) / 60_000) };
    }
    return null;
  };
  // Bàn trống lúc này, không vướng đơn đặt nào trong khung giờ tới
  ctx.freeTablesNow = (minutes, exceptRes = 0) => {
    const now = ctx.now();
    const clock = ctx.clock();
    const today = clock.businessDate(now);
    const busy = new Set(db.prepare("SELECT t.table_number FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE s.status IN ('open','paying')").all().map((x) => x.table_number));
    for (const rv of db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'booking' AND status = 'booked' AND id != ?").all(today, exceptRes)) {
      const at = clock.toEpoch(today, rv.time_min);
      if (at - now <= minutes * 60_000 && now - at <= (rv.duration_min || 85) * 60_000) for (const x of parseTableList(rv.tables)) busy.add(x);
    }
    return db.prepare('SELECT t.number, t.seats, t.zone_id FROM dining_tables t JOIN zones z ON z.id = t.zone_id WHERE z.active = 1 ORDER BY t.number').all().filter((t) => !busy.has(t.number));
  };
  const fmtM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  r.post('/api/pos/sessions', 'staff', ({ me, body }) => {
    const tables = readTables(body.tables);
    if (!body.override_reserved) {
      for (const n of tables) {
        const rv = ctx.reservedSoon(n);
        if (rv) fail(409, `Bàn ${n} đang giữ cho ${rv.name} lúc ${fmtM(rv.time_min)}. Chọn bàn khác, hoặc xác nhận vẫn nhận khách.`);
      }
    }
    // Đang đông khách (có nhóm chờ hoặc còn ≤ 10% bàn trống): nhóm nhỏ vào bàn lớn → gợi ý bàn vừa chỗ
    if (!body.override_size && body.guests && tables.length === 1) {
      const g = Number(body.guests);
      const seats = db.prepare('SELECT seats FROM dining_tables WHERE number = ?').get(tables[0])?.seats || 0;
      if (seats >= 6 && g <= seats - 3) {
        const dwell = Number(ctx.setting('dining_minutes') || 70) + 15;
        const free = ctx.freeTablesNow(dwell);
        const waiting = db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE date = ? AND kind = 'walkin' AND status = 'waiting'").get(ctx.today()).n;
        const total = db.prepare('SELECT COUNT(*) AS n FROM dining_tables').get().n;
        const better = free.filter((t) => t.seats >= g && t.seats < seats && t.number !== tables[0]).sort((a, b) => a.seats - b.seats || Math.abs(a.number - tables[0]) - Math.abs(b.number - tables[0])).slice(0, 3);
        if ((waiting > 0 || free.length <= total * 0.1) && better.length) fail(409, `Đang đông khách: nhóm ${g} người vào bàn ${tables[0]} (${seats} chỗ) sẽ phí chỗ. Nên dùng bàn ${better.map((t) => `${t.number} (${t.seats} chỗ)`).join(', ')}. Vẫn ngồi bàn này thì bấm xác nhận.`);
      }
    }
    // Có khách đặt sắp tới mà khách vãng lai ngồi không kịp xong → cảnh báo, gợi ý bàn khác
    if (!body.override_reserved && !body.override_soon) {
      const dwell = Number(ctx.setting('dining_minutes') || 70) + 15;
      for (const n of tables) {
        const rv = ctx.reservedWithin(n, dwell);
        if (!rv) continue;
        const zone = db.prepare('SELECT zone_id FROM dining_tables WHERE number = ?').get(n)?.zone_id;
        const alt = ctx.freeTablesNow(dwell).sort((a, b) => Number(b.zone_id === zone) - Number(a.zone_id === zone) || Math.abs(a.number - n) - Math.abs(b.number - n)).slice(0, 4).map((t) => t.number);
        fail(409, `Bàn ${n} có khách đặt ${fmtM(rv.time_min)} (còn ${rv.in_min}′), khách ngồi TB ${dwell - 15}′ sẽ chưa xong. ${alt.length ? `Bàn trống nên dùng: ${alt.join(', ')}.` : 'Hết bàn trống khác.'} Vẫn nhận thì bấm xác nhận.`);
      }
    }
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
    const hidden = new Set(JSON.parse(ctx.setting('hidden_option_groups') || '["Tinh bột"]'));
    const groups = [...new Set(all.map((o) => o.group_name))].filter((g) => !hidden.has(g));
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
    // Tính cả phần đã gọi chưa gửi bếp của món này ở mọi bàn
    const pendingQty = db.prepare("SELECT COALESCE(SUM(qty), 0) AS n FROM order_items WHERE menu_item_id = ? AND status = 'new'").get(item.id).n;
    ctx.portionsCheck?.(item, qty + pendingQty, v.bool(body.override_stock));
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
  // Lẩu 1 ngăn / 2 ngăn: món nhóm "Ngăn nước lẩu thêm" gọi cùng lượt được ghép vào set lẩu (theo thứ tự gọi)
  // → phiếu Nước lẩu in "Lẩu 2 ngăn · Mala Tứ Xuyên + Cà chua Quý Châu"; set không có ngăn thêm → "Lẩu 1 ngăn · Mala Tứ Xuyên".
  const BROTH_PART = /^Ngăn nước lẩu /;
  const ADDON_CAT = 'Ngăn nước lẩu thêm';
  const brothOf = (name) => String(name).replace(/^Nước lẩu /, '');
  function routeLines(items, { priority = false } = {}) {
    const byStation = new Map();
    const catName = (mid) => db.prepare('SELECT c.name FROM menu_items m JOIN menu_categories c ON c.id = m.category_id WHERE m.id = ?').get(mid)?.name;
    const addons = []; // từng ngăn thêm chờ ghép: { item, used }
    for (const i of items) if (i.menu_item_id && catName(i.menu_item_id) === ADDON_CAT) for (let k = 0; k < i.qty; k++) addons.push({ item: i, used: false });
    // Lượt 1: ghép từng nồi của set với ngăn thêm (theo thứ tự gọi)
    const pots = new Map(); // set item id → ['Lẩu 2 ngăn · A + B', ...]
    for (const i of items) {
      const bp = i.menu_item_id && db.prepare('SELECT label FROM menu_item_parts WHERE item_id = ? AND label LIKE ?').get(i.menu_item_id, 'Ngăn nước lẩu %');
      if (!bp) continue;
      const a = bp.label.replace(BROTH_PART, '');
      const list = [];
      for (let k = 0; k < i.qty; k++) {
        const add = addons.find((x) => !x.used && x.item.created_at >= (i.created_at || 0)) || addons.find((x) => !x.used);
        if (add) add.used = true;
        list.push(add ? `Lẩu 2 ngăn\t${a}\t${brothOf(add.item.name)}` : `Lẩu 1 ngăn\t${a}`);
      }
      pots.set(i.id, list);
    }
    for (const i of items) {
      const parts = i.menu_item_id ? db.prepare('SELECT * FROM menu_item_parts WHERE item_id = ? ORDER BY sort, id').all(i.menu_item_id) : [];
      const main = i.menu_item_id ? db.prepare('SELECT station_id FROM menu_items WHERE id = ?').get(i.menu_item_id)?.station_id : null;
      let targets = parts.length ? parts.map((p) => ({ station_id: p.station_id, label: p.label, qty: i.qty })) : [{ station_id: main, label: '', qty: i.qty }];
      targets = targets.flatMap((t) => {
        if (!BROTH_PART.test(t.label) || !pots.has(i.id)) return [t];
        const list = pots.get(i.id);
        // "Lẩu 2 ngăn" + dòng "Ngăn 1: Mala Tứ Xuyên", "Ngăn 2: Cà chua Quý Châu"; 1 ngăn: "Lẩu 1 ngăn" + "Mala Tứ Xuyên"
        return [...new Set(list)].map((key) => {
          const [label, ...ng] = key.split('\t');
          return { station_id: t.station_id, label, pre: ng.length > 1 ? ng.map((x, k) => `Ngăn ${k + 1}: ${x}`) : ng, qty: list.filter((x) => x === key).length };
        });
      });
      if (addons.some((x) => x.item === i)) {
        const left = addons.filter((x) => x.item === i && !x.used).length;
        if (!left) continue; // đã ghép hết vào set
        targets = targets.map((t) => ({ ...t, label: 'Thêm ngăn nước lẩu', pre: [brothOf(i.name)], qty: left }));
      }
      // Món tặng (chương trình "mua A tặng B", vd lẩu tặng thăn bò): in dòng riêng "… (TẶNG)" trước dòng khách gọi thêm (chủ quán chốt 24/10)
      const giftQty = Math.min(i.qty, (i.promos || []).filter((p) => p.gift).reduce((n, p) => n + (p.free_qty || 0), 0));
      if (giftQty && !parts.length) targets = targets.flatMap((t) => [{ ...t, qty: giftQty, gift: true }, { ...t, qty: i.qty - giftQty }]).filter((t) => t.qty > 0);
      for (const t of targets) {
        if (!t.station_id) continue;
        let sid = t.station_id;
        const st = station(sid);
        const urgent = priority || i.rush;
        if (urgent && st?.priority_station_id) sid = st.priority_station_id;
        const key = `${sid}:${urgent ? 1 : 0}`;
        if (!byStation.has(key)) byStation.set(key, { station_id: sid, priority: urgent ? 1 : 0, lines: [] });
        // Món có nhiều phần (set lẩu): mỗi điểm in tên PHẦN (vd "Rau tổng hợp"), cộng dồn cả bàn → "2 x Rau tổng hợp"
        const line = { item_id: i.id, name: `${t.label || i.name}${t.gift ? ' (TẶNG)' : ''}`, qty: t.qty, options: [...(t.pre || []), ...JSON.parse(i.options || '[]').map((o) => o.name)], note: i.note, label: '', rush: !!i.rush };
        // Mua 1 tặng 1 cùng món (steak): phiếu bếp chỉ ghi tổng số phần phải làm. Món tặng kèm (gift) in dòng riêng ở trên
        // Dòng giống hệt (cùng món, tuỳ chọn, ghi chú) thì cộng số lượng: bếp đọc 1 dòng "2 x" thay vì 2 dòng
        const same = byStation.get(key).lines.find((l) => l.name === line.name && l.label === line.label && l.note === line.note && l.rush === line.rush && l.options.join('|') === line.options.join('|'));
        if (same) same.qty += line.qty; else byStation.get(key).lines.push(line);
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

  ctx.posMakeTickets = makeTickets;
  ctx.cancelGraceMs = CANCEL_GRACE_MS;

  r.post('/api/pos/sessions/:id/send', 'staff', ({ me, params }) => {
    const s = openSession(params.id);
    const items = s.items.filter((i) => i.status === 'new').map((i) => ({ ...i, options: JSON.stringify(i.options) }));
    if (!items.length) fail(400, 'Chưa có món mới để gửi');
    const first = !s.items.some((i) => i.status === 'sent' || i.status === 'done');
    const tickets = tx(db, () => {
      db.prepare("UPDATE order_items SET status = 'sent', sent_at = ?, sent_by = ? WHERE session_id = ? AND status = 'new'").run(ctx.now(), me.id, s.id);
      ctx.consumeSale?.(me, items);
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
    const reason = v.text(body.reason || i.cancel_req_reason, { name: 'Lý do huỷ', required: true, max: 120 }); // duyệt yêu cầu xin huỷ: dùng lý do nhân viên ghi
    // Chủ quán 29/10: món ĐÃ GỬI BẾP chỉ trưởng ca / quản lý / chủ huỷ (hoặc người chủ quán tick riêng quyền "Huỷ món, huỷ bàn").
    // Nhân viên phải báo trưởng ca / quản lý. Món chưa gửi bếp thì nhân viên vẫn bớt / xoá được.
    if (rank(me.real_role || me.role) < rank('shift_lead') && overridesOf(ctx, me.id)['ban.huy'] !== true) fail(403, 'Món đã gửi bếp: báo trưởng ca hoặc quản lý huỷ');
    const late = i.status === 'done' || ctx.now() - (i.sent_at || 0) > CANCEL_GRACE_MS; // quá 2 phút: không trả kho
    const soldOut = v.bool(body.sold_out);
    if (soldOut && rank(me.role) < rank('team_lead')) fail(403, 'Chỉ tổ trưởng trở lên mới báo hết món');
    const s = session(i.session_id);
    tx(db, () => {
      db.prepare("UPDATE order_items SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?").run(ctx.now(), me.id, reason, i.id);
      makeTickets(me, s, [{ ...i, note: reason }], 'cancel');
      if (!late) ctx.restoreSale?.(me, i);
      if (soldOut && i.menu_item_id) db.prepare('UPDATE menu_items SET sold_out = 1 WHERE id = ?').run(i.menu_item_id);
    });
    if (soldOut) ctx.broadcast('menu');
    ctx.audit(me, 'pos.item.cancel', { id: i.id, name: i.name, qty: i.qty, reason, sold_out: soldOut });
    // Báo lại người xin huỷ là đã được duyệt (chủ quán 29/10: không cần báo thu ngân, bill tự trừ món đã huỷ)
    if (i.cancel_req_by && i.cancel_req_by !== me.id) ctx.notify([i.cancel_req_by], { title: `Đã huỷ: ${i.qty} × ${i.name} · Bàn ${s.header}`, body: `${me.name} đồng ý huỷ · lý do: ${reason}`, link: `/goi-mon?s=${s.id}` });
    ctx.broadcast('pos');
    ctx.broadcast('tickets');
    return { ok: true };
  });

  // Phục vụ bấm "Đã ra" khi bưng món ra bàn (bấm lại để bỏ)
  r.post('/api/pos/items/:id/cancel-request', 'staff', ({ me, params, body }) => {
    const i = loadItem(params.id);
    if (!['sent', 'done'].includes(i.status)) fail(400, 'Chỉ xin huỷ món đã gửi bếp');
    const reason = v.text(body.reason, { name: 'Lý do huỷ', required: true, max: 120 });
    db.prepare('UPDATE order_items SET cancel_req_reason = ?, cancel_req_by = ?, cancel_req_at = ? WHERE id = ?').run(reason, me.id, ctx.now(), i.id);
    const s = session(i.session_id);
    ctx.notify(leadsOnShift().filter((x) => x !== me.id), { title: `Xin huỷ món · Bàn ${s.header}`, body: `${me.name}: ${i.qty} × ${i.name} · lý do: ${reason}`, link: `/goi-mon?s=${s.id}`, urgent: true });
    ctx.audit(me, 'pos.item.cancel_request', { id: i.id, reason });
    ctx.broadcast('pos');
    return { ok: true };
  });
  r.post('/api/pos/items/:id/cancel-reject', 'staff', ({ me, params }) => {
    if (rank(me.real_role || me.role) < rank('shift_lead') && overridesOf(ctx, me.id)['ban.huy'] !== true) fail(403, 'Trưởng ca / quản lý mới duyệt huỷ');
    const i = loadItem(params.id);
    if (!i.cancel_req_by) fail(400, 'Món này không có yêu cầu huỷ');
    db.prepare('UPDATE order_items SET cancel_req_reason = NULL, cancel_req_by = NULL, cancel_req_at = NULL WHERE id = ?').run(i.id);
    ctx.notify([i.cancel_req_by], { title: `Không huỷ: ${i.name}`, body: `${me.name} không đồng ý huỷ món này`, link: `/goi-mon?s=${i.session_id}` });
    ctx.audit(me, 'pos.item.cancel_reject', { id: i.id });
    ctx.broadcast('pos');
    return { ok: true };
  });

  r.post('/api/pos/items/:id/served', 'staff', ({ me, params, body }) => {
    const i = loadItem(params.id);
    if (!['sent', 'done'].includes(i.status)) fail(400, 'Món chưa gửi bếp');
    const done = body.done === undefined ? true : v.bool(body.done);
    db.prepare('UPDATE order_items SET status = ? WHERE id = ?').run(done ? 'done' : 'sent', i.id);
    ctx.audit(me, 'pos.item.served', { id: i.id, done });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Nhắc bếp món ra trễ: in phiếu NHẮC ra máy ưu tiên của điểm đó; mỗi món nhắc cách nhau ít nhất 3 phút
  r.post('/api/pos/items/:id/remind', 'staff', ({ me, params }) => {
    const i = loadItem(params.id);
    if (i.status !== 'sent') fail(400, 'Món này không còn chờ bếp');
    if (i.reminded_at && ctx.now() - i.reminded_at < 3 * 60_000) fail(429, 'Vừa nhắc rồi, đợi 3 phút rồi nhắc lại');
    const s = session(i.session_id);
    const w = waitInfo(i);
    tx(db, () => {
      makeTickets(me, s, [{ ...i, note: `Khách chờ ${w.wait_min} phút` }], 'remind', { priority: true });
      db.prepare('UPDATE order_items SET reminded_at = ? WHERE id = ?').run(ctx.now(), i.id);
    });
    ctx.audit(me, 'pos.item.remind', { id: i.id, name: i.name, wait: w.wait_min });
    ctx.broadcast('tickets');
    ctx.broadcast('pos');
    return { ok: true };
  });

  r.get('/api/pos/late', 'staff', () => lateItems());

  // Tách bàn: chuyển một số món (có thể một phần số lượng) sang bàn khác để tính riêng; không in phiếu
  r.post('/api/pos/sessions/:id/split', 'staff', ({ me, params, body }) => {
    const s = openSession(params.id);
    const [n] = readTables([v.int(body.table, { min: 1, name: 'Bàn' })]);
    const list = Array.isArray(body.items) ? body.items : [];
    if (!list.length) fail(400, 'Chọn món cần tách');
    // Tách bàn: chỉ sang 1 bàn TRỐNG → 1 bàn thành 2 bàn, món khách chọn sang bàn mới
    if (busyTable(n)) fail(409, `Bàn ${n} đang có khách; tách bàn chỉ chọn bàn trống`);
    const out = tx(db, () => {
      const target = ctx.openTableSession(me, { tables: [n] });
      let moved = 0;
      for (const x of list) {
        const it = db.prepare("SELECT * FROM order_items WHERE id = ? AND session_id = ? AND status != 'cancelled'").get(v.int(x.id, { min: 1, name: 'Món' }), s.id);
        if (!it) fail(400, 'Món không thuộc bàn này');
        const qty = v.int(x.qty ?? it.qty, { min: 1, max: it.qty, name: `Số lượng tách của ${it.name}` });
        if (qty === it.qty) {
          db.prepare('UPDATE order_items SET session_id = ? WHERE id = ?').run(target, it.id);
        } else {
          db.prepare('UPDATE order_items SET qty = qty - ? WHERE id = ?').run(qty, it.id);
          const nid = Number(db.prepare(`INSERT INTO order_items (session_id, menu_item_id, name, unit_price, qty, options, note, rush, status, created_by, created_at, sent_at, sent_by)
            SELECT ?, menu_item_id, name, unit_price, ?, options, note, rush, status, created_by, created_at, sent_at, sent_by FROM order_items WHERE id = ?`).run(target, qty, it.id).lastInsertRowid);
          // Món đã gửi bếp: chia phần trừ kho theo số lượng (rà soát 28/10) → huỷ dòng nào trả kho đúng phần dòng đó
          if (it.status !== 'new') ctx.splitSale?.(it.id, nid, qty / it.qty);
        }
        moved += qty;
      }
      // Bàn cũ không còn món nào thì tự đóng
      const left = db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE session_id = ? AND status != 'cancelled'").get(s.id).n;
      if (!left) db.prepare("UPDATE table_sessions SET status = 'cancelled', closed_at = ?, closed_by = ?, note = 'Tách hết sang bàn khác' WHERE id = ?").run(ctx.now(), me.id, s.id);
      return { target, moved };
    });
    ctx.audit(me, 'pos.split', { from: s.id, to: out.target, qty: out.moved });
    ctx.broadcast('pos');
    return { session_id: out.target, moved: out.moved };
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
    // Chuyển bàn: chọn đúng 1 bàn trống; cả bill sang bàn mới, bàn cũ thành bàn trống (chủ quán chốt 24/10)
    const to = readTables(body.tables);
    if (to.length !== 1) fail(400, 'Chuyển bàn: chọn 1 bàn trống');
    for (const n of to) if (busyTable(n, s.id)) fail(409, `Bàn ${n} đang có khách; muốn gộp thì dùng Gộp bàn`);
    tx(db, () => {
      db.prepare('DELETE FROM session_tables WHERE session_id = ?').run(s.id);
      const add = db.prepare('INSERT INTO session_tables (session_id, table_number) VALUES (?, ?)');
      for (const n of to) add.run(s.id, n);
    });
    ctx.audit(me, 'pos.move', { id: s.id, from: s.tables, to });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Chuyển 1 món sang bàn khác (gọi nhầm bàn); bàn đích trống thì tự nhận khách.
  // Không in phiếu báo bếp khi chuyển (chủ quán chốt 21/10: phục vụ tự báo bằng bộ đàm)
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
      // Tiền CK ngân hàng đã báo về cho bàn gộp chuyển theo sang bàn đích (rà soát 28/10), không bị kẹt ở bill đã huỷ
      try { db.prepare('UPDATE bank_txns SET session_id = ? WHERE session_id = ?').run(s.id, other.id); } catch { /* chưa có bảng */ }
      // Gộp bàn 1 → bàn 2: cả bill bàn 1 sang bàn 2, bàn 1 thành bàn trống (gọi mới là bill riêng). Chủ quán chốt 24/10
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
    if (sent.length && rank(me.real_role || me.role) < rank('shift_lead') && overridesOf(ctx, me.id)['ban.huy'] !== true) fail(403, 'Bàn đã gửi món bếp: báo trưởng ca hoặc quản lý huỷ');
    const reason = v.text(body.reason, { name: 'Lý do', max: 120 }) || 'Khách về / mở nhầm';
    tx(db, () => {
      if (sent.length) {
        db.prepare("UPDATE order_items SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE session_id = ? AND status IN ('sent','done')").run(ctx.now(), me.id, reason, s.id);
        makeTickets(me, s, sent.map((i) => ({ ...i, options: JSON.stringify(i.options), note: reason })), 'cancel');
        // Cùng luật huỷ từng món (rà soát 28/10): món gửi bếp chưa quá 2′ và chưa ra → trả lại kho
        for (const i of sent) if (i.status === 'sent' && ctx.now() - (i.sent_at || 0) <= CANCEL_GRACE_MS) ctx.restoreSale?.(me, i);
      }
      db.prepare("DELETE FROM order_items WHERE session_id = ? AND status = 'new'").run(s.id);
      db.prepare("UPDATE table_sessions SET status = 'cancelled', closed_at = ?, closed_by = ?, note = ? WHERE id = ?").run(ctx.now(), me.id, reason, s.id);
    });
    ctx.audit(me, 'pos.session.cancel', { id: s.id, reason, sent: sent.length });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Phiếu bếp gần đây (để kiểm tra trước khi có màn hình bếp / cầu nối in ở GĐ3C)
  // Màn "Phiếu bếp": dự phòng khi máy in / wifi ở quán hỏng — bếp, bar xem phiếu trên điện thoại (4G)
  r.get('/api/pos/tickets', 'staff', ({ query }) => {
    const sid = v.optInt(query.get('station'), { min: 1, name: 'Điểm in' });
    const since = ctx.now() - 3 * 3_600_000;
    const rows = db.prepare(`SELECT k.*, st.name AS station_name, c.name AS by_name FROM kitchen_tickets k LEFT JOIN kitchen_stations st ON st.id = k.station_id LEFT JOIN staff c ON c.id = k.created_by
      WHERE k.created_at > ? ${sid ? 'AND k.station_id = ?' : ''} ORDER BY k.id DESC LIMIT 150`).all(since, ...(sid ? [sid] : []));
    return rows.map((k) => ({ ...k, lines: JSON.parse(k.lines), priority: !!k.priority }));
  });
  // In lại phiếu (phiếu rách / mất / máy cắt giấy kẹt). Ghi nhật ký, cuối ngày vào mục bất thường
  r.post('/api/pos/tickets/:id/reprint', 'staff', ({ me, params, body }) => {
    const k = db.prepare('SELECT * FROM kitchen_tickets WHERE id = ?').get(params.id);
    if (!k) fail(404, 'Không có phiếu');
    const reason = v.text(body.reason, { name: 'Lý do', max: 80 }) || 'Mất phiếu';
    db.prepare("UPDATE kitchen_tickets SET print_status = 'pending', attempts = 0, reprint = reprint + 1, reprint_at = ?, done_at = NULL WHERE id = ?").run(ctx.now(), k.id);
    ctx.audit(me, 'pos.ticket.reprint', { id: k.id, station: k.station_id, reason });
    ctx.broadcast('tickets');
    ctx.broadcast('print');
    return { ok: true };
  });
  // Bếp bấm "Đã nhận" trên màn hình: phiếu chưa in thì bỏ in (máy in chạy lại không in trùng)
  r.post('/api/pos/tickets/:id/done', 'staff', ({ me, params }) => {
    const k = db.prepare('SELECT * FROM kitchen_tickets WHERE id = ?').get(params.id);
    if (!k) fail(404, 'Không có phiếu');
    db.prepare("UPDATE kitchen_tickets SET done_at = COALESCE(done_at, ?), print_status = CASE WHEN print_status = 'pending' THEN 'skipped' ELSE print_status END WHERE id = ?").run(ctx.now(), k.id);
    ctx.audit(me, 'pos.ticket.done', { id: k.id, was: k.print_status });
    ctx.broadcast('tickets');
    return { ok: true };
  });
}
