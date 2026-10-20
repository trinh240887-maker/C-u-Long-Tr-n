import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { addDays, isDate } from '../lib/time.js';
import { forecastDay, areaNeed, purchaseNeed, toPurchaseUnits, r3 } from '../lib/forecast.js';
import { stockQty, addLot, takeLots, setActual, recordMove, costOf } from '../lib/stock.js';

const FRESHNESS = ['fresh', 'chilled', 'dry'];
const FRESH_LABEL = { fresh: 'Đồ tươi', chilled: 'Đồ mát', dry: 'Đồ khô/đông' };

export default function (r, ctx) {
  const { db } = ctx;
  const today = () => ctx.today();
  const num = (value, name, { min = 0, max = 1e9 } = {}) => {
    const n = Number(String(value ?? '').replace(',', '.'));
    if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n < min || n > max) fail(400, `${name} không hợp lệ`);
    return r3(n);
  };

  // ---------- Dữ liệu nền ----------
  const stores = () => db.prepare(`SELECT s.*, t.name AS team_name, p.name AS supplier_name FROM stores s
    LEFT JOIN teams t ON t.id = s.team_id LEFT JOIN suppliers p ON p.id = s.supplier_id WHERE s.active = 1 ORDER BY s.sort, s.id`).all();
  const storeById = (id) => db.prepare('SELECT * FROM stores WHERE id = ? AND active = 1').get(id);
  const mainStore = () => db.prepare("SELECT * FROM stores WHERE kind = 'main' AND active = 1 ORDER BY id LIMIT 1").get();
  const ingredients = ({ all = false } = {}) => db.prepare(`SELECT i.*, hs.name AS home_name, hs.supplier_id AS home_supplier_id,
      COALESCE(i.supplier_id, hs.supplier_id) AS eff_supplier_id, p.name AS supplier_name
    FROM ingredients i LEFT JOIN stores hs ON hs.id = i.home_store_id
    LEFT JOIN suppliers p ON p.id = COALESCE(i.supplier_id, hs.supplier_id)
    ${all ? '' : 'WHERE i.active = 1'} ORDER BY COALESCE(hs.sort, 99), i.name`).all();
  const ingById = (id) => db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);

  const holderId = () => Number(ctx.setting('kho_tong_staff_id') || 0);
  const isHolder = (me) => me.id === holderId() || rank(me.role) >= rank('shift_lead');
  const canStore = (me, st) => rank(me.role) >= rank('shift_lead') || (st.kind === 'main' ? isHolder(me) : st.team_id && st.team_id === me.team_id);
  const isLeadOf = (me, st) => rank(me.role) >= rank('shift_lead') || (me.role === 'team_lead' && st.team_id && st.team_id === me.team_id);
  const holderTargets = () => (holderId() ? [holderId(), ...ctx.managers()] : ctx.managers());
  const leadsOfStore = (st) => ctx.leadsOf(st.team_id);

  // Lượng dùng thực tế theo ngày (từ kiểm kho cuối ca, sau này thêm từ bán hàng)
  function usageMaps(days = 35) {
    const rows = db.prepare(`SELECT ingredient_id, from_store, date, SUM(qty) AS q FROM stock_moves
      WHERE type = 'consume' AND date >= ? GROUP BY ingredient_id, from_store, date`).all(addDays(today(), -days));
    const total = new Map();
    const perStore = new Map();
    for (const x of rows) {
      const t = total.get(x.ingredient_id) || new Map();
      t.set(x.date, r3((t.get(x.date) || 0) + x.q));
      total.set(x.ingredient_id, t);
      const k = `${x.from_store}:${x.ingredient_id}`;
      const p = perStore.get(k) || new Map();
      p.set(x.date, r3((p.get(x.date) || 0) + x.q));
      perStore.set(k, p);
    }
    return { total, perStore };
  }

  function stockMap() {
    const m = new Map();
    for (const x of db.prepare('SELECT store_id, ingredient_id, SUM(qty) AS q FROM stock_lots GROUP BY store_id, ingredient_id').all()) {
      m.set(`${x.store_id}:${x.ingredient_id}`, r3(x.q));
    }
    return m;
  }

  // ---------- Tổng quan tồn kho ----------
  function overview() {
    const t = today();
    const tomorrow = addDays(t, 1);
    const warnTo = addDays(t, Number(ctx.setting('expiry_warn_days') || 1));
    const sts = stores();
    const stock = stockMap();
    const usage = usageMaps();
    const lots = db.prepare('SELECT store_id, ingredient_id, qty, expires_on FROM stock_lots WHERE expires_on IS NOT NULL AND expires_on <= ? ORDER BY expires_on').all(warnTo);
    const items = ingredients().map((i) => {
      const per = Object.fromEntries(sts.map((s) => [s.id, stock.get(`${s.id}:${i.id}`) || 0]));
      const total = r3(Object.values(per).reduce((a, b) => a + b, 0));
      const exp = lots.filter((l) => l.ingredient_id === i.id).map((l) => ({ ...l, expired: l.expires_on < t }));
      const expired = r3(exp.filter((e) => e.expired).reduce((a, e) => a + e.qty, 0));
      const f = forecastDay(usage.total.get(i.id) || new Map(), tomorrow);
      const available = r3(total - expired);
      let status = 'ok';
      if (available <= 1e-9) status = 'out';
      else if (available < i.min_stock || available < f.qty) status = 'low';
      return {
        id: i.id, name: i.name, unit: i.unit, freshness: i.freshness, freshness_label: FRESH_LABEL[i.freshness],
        home_store_id: i.home_store_id, home_name: i.home_name || 'Kho chung', supplier_id: i.eff_supplier_id, supplier_name: i.supplier_name || '',
        purchase_unit: i.purchase_unit, purchase_factor: i.purchase_factor, price: i.price, min_stock: i.min_stock,
        stock: per, total, available, expiring: exp, forecast_tomorrow: f.qty, avg_daily: f.avg, basis: f.basis,
        days_left: f.avg > 0 ? r3(available / f.avg) : null, status,
      };
    });
    return { today: t, tomorrow, stores: sts, items };
  }

  r.get('/api/stock/overview', 'staff', () => overview());

  r.get('/api/stock/meta', 'staff', ({ me }) => {
    const sts = stores();
    return {
      stores: sts.map((s) => ({ ...s, can_count: !!canStore(me, s), is_lead: !!isLeadOf(me, s) })),
      suppliers: db.prepare('SELECT * FROM suppliers ORDER BY active DESC, name').all(),
      ingredients: ingredients({ all: rank(me.role) >= rank('manager') }),
      is_holder: isHolder(me),
      holder_id: holderId() || null,
      freshness: FRESH_LABEL,
    };
  });

  r.get('/api/stock/alerts', 'staff', () => {
    const o = overview();
    const pick = (st) => o.items.filter((x) => x.status === st).map((x) => ({ id: x.id, name: x.name, available: x.available, unit: x.unit, forecast: x.forecast_tomorrow }));
    const count = (sql) => db.prepare(sql).get().n;
    return {
      out: pick('out'), low: pick('low'),
      expiring: o.items.flatMap((x) => x.expiring.map((e) => ({ name: x.name, unit: x.unit, ...e, store: o.stores.find((s) => s.id === e.store_id)?.name || '' }))),
      po_submitted: count("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'submitted'"),
      po_approved: count("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'approved'"),
      po_draft: count("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'draft'"),
      transfers_requested: count("SELECT COUNT(*) AS n FROM transfers WHERE status = 'requested'"),
      transfers_sent: count("SELECT COUNT(*) AS n FROM transfers WHERE status = 'sent'"),
    };
  });

  // ---------- Nhà cung cấp, kho, nguyên liệu (quản lý) ----------
  r.post('/api/stock/suppliers', 'manager', ({ me, body }) => {
    const id = Number(db.prepare('INSERT INTO suppliers (name, phone, note) VALUES (?, ?, ?)').run(
      v.text(body.name, { name: 'Tên NCC', required: true, max: 80 }), v.text(body.phone, { name: 'Số điện thoại', max: 30 }), v.text(body.note, { name: 'Ghi chú', max: 300 }),
    ).lastInsertRowid);
    ctx.audit(me, 'supplier.create', body.name);
    ctx.broadcast('stock');
    return { id };
  });

  r.patch('/api/stock/suppliers/:id', 'manager', ({ me, params, body }) => {
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(params.id);
    if (!s) fail(404, 'Không tìm thấy NCC');
    db.prepare('UPDATE suppliers SET name = ?, phone = ?, note = ?, active = ? WHERE id = ?').run(
      body.name === undefined ? s.name : v.text(body.name, { name: 'Tên NCC', required: true, max: 80 }),
      body.phone === undefined ? s.phone : v.text(body.phone, { name: 'Số điện thoại', max: 30 }),
      body.note === undefined ? s.note : v.text(body.note, { name: 'Ghi chú', max: 300 }),
      body.active === undefined ? s.active : v.bool(body.active), s.id,
    );
    ctx.audit(me, 'supplier.update', s.id);
    ctx.broadcast('stock');
    return { ok: true };
  });

  r.patch('/api/stock/stores/:id', 'manager', ({ me, params, body }) => {
    const s = storeById(params.id);
    if (!s) fail(404, 'Không tìm thấy kho');
    const supplier = body.supplier_id === undefined ? s.supplier_id : v.optInt(body.supplier_id, { min: 1, name: 'NCC' });
    if (supplier && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplier)) fail(400, 'NCC không tồn tại');
    const team = body.team_id === undefined ? s.team_id : v.optInt(body.team_id, { min: 1, name: 'Tổ' });
    db.prepare('UPDATE stores SET name = ?, supplier_id = ?, team_id = ? WHERE id = ?').run(
      body.name === undefined ? s.name : v.text(body.name, { name: 'Tên kho', required: true, max: 60 }), supplier, s.kind === 'main' ? null : team, s.id,
    );
    ctx.audit(me, 'store.update', s.id);
    ctx.broadcast('stock');
    return { ok: true };
  });

  function ingFields(body, cur = {}) {
    const pick = (k, fn) => (body[k] === undefined ? cur[k] : fn(body[k]));
    const f = {
      name: pick('name', (x) => v.text(x, { name: 'Tên nguyên liệu', required: true, max: 80 })),
      unit: pick('unit', (x) => v.text(x, { name: 'Đơn vị dùng', required: true, max: 12 })),
      freshness: pick('freshness', (x) => v.oneOf(x, FRESHNESS, { name: 'Nhóm hàng' })) ?? 'dry',
      home_store_id: pick('home_store_id', (x) => v.optInt(x, { min: 1, name: 'Khu chính' })) ?? null,
      supplier_id: pick('supplier_id', (x) => v.optInt(x, { min: 1, name: 'NCC' })) ?? null,
      purchase_unit: pick('purchase_unit', (x) => v.text(x, { name: 'Đơn vị mua', max: 12 })) ?? '',
      purchase_factor: pick('purchase_factor', (x) => num(x, 'Quy đổi', { min: 0.001 })) ?? 1,
      order_step: pick('order_step', (x) => num(x, 'Bước làm tròn', { min: 0.001 })) ?? 1,
      price: pick('price', (x) => v.int(x, { min: 0, max: 1e9, name: 'Giá nhập' })) ?? 0,
      min_stock: pick('min_stock', (x) => num(x, 'Tồn tối thiểu')) ?? 0,
      shelf_days: pick('shelf_days', (x) => v.int(x, { min: 0, max: 3650, name: 'Hạn dùng' })) ?? 0,
      lead_days: pick('lead_days', (x) => v.int(x, { min: 0, max: 60, name: 'Số ngày giao' })) ?? 1,
      cycle_days: pick('cycle_days', (x) => v.int(x, { min: 1, max: 90, name: 'Chu kỳ đặt' })) ?? 1,
      safety_pct: pick('safety_pct', (x) => v.int(x, { min: 0, max: 200, name: 'Dự phòng' })) ?? 10,
      active: body.active === undefined ? (cur.active ?? 1) : v.bool(body.active),
    };
    if (!f.name || !f.unit) fail(400, 'Thiếu tên hoặc đơn vị');
    if (f.home_store_id && !storeById(f.home_store_id)) fail(400, 'Khu chính không tồn tại');
    if (f.supplier_id && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(f.supplier_id)) fail(400, 'NCC không tồn tại');
    if (!f.purchase_unit) { f.purchase_unit = f.unit; f.purchase_factor = 1; }
    return f;
  }
  const ING_COLS = ['name', 'unit', 'freshness', 'home_store_id', 'supplier_id', 'purchase_unit', 'purchase_factor', 'order_step', 'price', 'min_stock', 'shelf_days', 'lead_days', 'cycle_days', 'safety_pct', 'active'];

  r.post('/api/stock/ingredients', 'manager', ({ me, body }) => {
    const f = ingFields(body);
    const id = Number(db.prepare(`INSERT INTO ingredients (${ING_COLS.join(', ')}) VALUES (${ING_COLS.map(() => '?').join(', ')})`).run(...ING_COLS.map((k) => f[k])).lastInsertRowid);
    ctx.audit(me, 'ingredient.create', f.name);
    ctx.broadcast('stock');
    return { id };
  });

  r.patch('/api/stock/ingredients/:id', 'manager', ({ me, params, body }) => {
    const cur = ingById(params.id);
    if (!cur) fail(404, 'Không tìm thấy nguyên liệu');
    const f = ingFields(body, cur);
    db.prepare(`UPDATE ingredients SET ${ING_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...ING_COLS.map((k) => f[k]), cur.id);
    ctx.audit(me, 'ingredient.update', { id: cur.id, name: f.name });
    ctx.broadcast('stock');
    return { ok: true };
  });

  // ---------- Kiểm kho ----------
  function sheetFor(st) {
    const all = ingredients();
    if (st.kind === 'main') return all;
    const used = new Set(db.prepare('SELECT DISTINCT ingredient_id AS id FROM stock_moves WHERE to_store = ? OR from_store = ?').all(st.id, st.id).map((x) => x.id));
    for (const x of db.prepare('SELECT DISTINCT ingredient_id AS id FROM stock_lots WHERE store_id = ?').all(st.id)) used.add(x.id);
    return all.filter((i) => i.home_store_id === st.id || (i.home_store_id === null && used.has(i.id)) || used.has(i.id));
  }

  r.get('/api/stock/count-sheet', 'staff', ({ me, query }) => {
    const st = storeById(Number(query.get('store')));
    if (!st) fail(404, 'Không tìm thấy kho');
    const last = db.prepare('SELECT c.*, s.name AS staff_name FROM stock_counts c LEFT JOIN staff s ON s.id = c.staff_id WHERE c.store_id = ? ORDER BY c.at DESC LIMIT 1').get(st.id);
    return {
      store: st, can_count: !!canStore(me, st), last_count: last || null,
      lines: sheetFor(st).map((i) => ({ ingredient_id: i.id, name: i.name, unit: i.unit, freshness: i.freshness, expected: stockQty(db, st.id, i.id) })),
      shared: ingredients().filter((i) => i.home_store_id === null).map((i) => ({ ingredient_id: i.id, name: i.name, unit: i.unit })),
    };
  });

  // Gợi ý khu lĩnh thêm từ kho tổng cho ngày mai
  function transferSuggestion(st) {
    const main = mainStore();
    const usage = usageMaps();
    const tomorrow = addDays(today(), 1);
    return sheetFor(st).map((i) => {
      const f = forecastDay(usage.perStore.get(`${st.id}:${i.id}`) || new Map(), tomorrow);
      const have = stockQty(db, st.id, i.id);
      const need = areaNeed({ forecast: f.qty, safetyPct: i.safety_pct, stock: have });
      const inMain = main ? stockQty(db, main.id, i.id) : 0;
      return { ingredient_id: i.id, name: i.name, unit: i.unit, forecast: f.qty, basis: f.basis, have, need, main_stock: inMain, short: need > inMain + 1e-9 };
    }).filter((x) => x.need > 0);
  }

  r.get('/api/stock/suggest-transfer', 'staff', ({ query }) => {
    const st = storeById(Number(query.get('store')));
    if (!st || st.kind !== 'area') fail(404, 'Chọn kho của khu');
    return { store: st, lines: transferSuggestion(st) };
  });

  r.post('/api/stock/count', 'staff', ({ me, body }) => {
    const st = storeById(v.int(body.store_id, { min: 1, name: 'Kho' }));
    if (!st) fail(404, 'Không tìm thấy kho');
    if (!canStore(me, st)) fail(403, 'Bạn không kiểm được kho này');
    const lines = Array.isArray(body.lines) ? body.lines.filter((l) => l.actual !== '' && l.actual !== null && l.actual !== undefined) : [];
    if (!lines.length) fail(400, 'Nhập số thực tế cho ít nhất một nguyên liệu');
    const usageMode = st.kind === 'area' && ctx.setting('area_count_is_usage') === '1';
    const t = ctx.now();
    const date = today();
    const result = tx(db, () => {
      const countId = Number(db.prepare('INSERT INTO stock_counts (store_id, date, staff_id, at, note) VALUES (?, ?, ?, ?, ?)')
        .run(st.id, date, me.id, t, v.text(body.note, { name: 'Ghi chú', max: 300 })).lastInsertRowid);
      const out = [];
      for (const l of lines) {
        const ing = ingById(v.int(l.ingredient_id, { min: 1, name: 'Nguyên liệu' }));
        if (!ing) fail(404, 'Không tìm thấy nguyên liệu');
        const actual = num(l.actual, `Số thực tế của ${ing.name}`);
        const { before, diff } = setActual(db, { storeId: st.id, ingredientId: ing.id, actual, at: t });
        db.prepare('INSERT INTO stock_count_lines (count_id, ingredient_id, expected, actual) VALUES (?, ?, ?, ?)').run(countId, ing.id, before, actual);
        if (diff < 0) {
          recordMove(db, { at: t, date, type: usageMode ? 'consume' : 'waste', ingredientId: ing.id, fromStore: st.id, qty: -diff, cost: costOf(ing, -diff), ref: `count:${countId}`, staffId: me.id, note: usageMode ? 'Dùng trong ngày (kiểm kho cuối ca)' : 'Hao hụt khi kiểm kho' });
        } else if (diff > 0) {
          recordMove(db, { at: t, date, type: 'adjust', ingredientId: ing.id, toStore: st.id, qty: diff, ref: `count:${countId}`, staffId: me.id, note: 'Kiểm kho thừa so với sổ' });
        }
        out.push({ ingredient_id: ing.id, name: ing.name, unit: ing.unit, before, actual, diff });
      }
      return { countId, out };
    });
    const suggestion = st.kind === 'area' ? transferSuggestion(st) : [];
    const short = suggestion.filter((x) => x.short);
    if (short.length) {
      ctx.notify([...leadsOfStore(st), ...holderTargets()].filter((x) => x !== me.id), {
        title: `Sắp hết ở ${st.name}`,
        body: short.map((x) => `• ${x.name}: cần ${x.need} ${x.unit}, kho tổng còn ${x.main_stock}`).join('\n'),
        link: '/kho', urgent: true,
      });
    }
    ctx.audit(me, 'stock.count', { store: st.id, count: result.countId, lines: result.out.length });
    ctx.broadcast('stock');
    return { count_id: result.countId, lines: result.out, suggestion };
  });

  // ---------- Phiếu lĩnh hàng (kho tổng → khu) ----------
  function loadTransfer(id) {
    const t = db.prepare(`SELECT t.*, fs.name AS from_name, ts.name AS to_name, ts.team_id AS to_team, c.name AS created_by_name, sb.name AS sent_by_name, rb.name AS received_by_name
      FROM transfers t JOIN stores fs ON fs.id = t.from_store JOIN stores ts ON ts.id = t.to_store
      LEFT JOIN staff c ON c.id = t.created_by LEFT JOIN staff sb ON sb.id = t.sent_by LEFT JOIN staff rb ON rb.id = t.received_by WHERE t.id = ?`).get(id);
    if (!t) fail(404, 'Không tìm thấy phiếu lĩnh');
    t.lines = db.prepare(`SELECT l.*, i.name, i.unit FROM transfer_lines l JOIN ingredients i ON i.id = l.ingredient_id WHERE l.transfer_id = ? ORDER BY i.name`).all(id)
      .map((l) => ({ ...l, from_stock: stockQty(db, t.from_store, l.ingredient_id) }));
    return t;
  }

  r.get('/api/stock/transfers', 'staff', ({ query }) => {
    const status = query.get('status');
    const ids = db.prepare(`SELECT id FROM transfers ${status ? 'WHERE status = ?' : ''} ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END, id DESC LIMIT 100`)
      .all(...(status ? [status] : []));
    return ids.map((x) => loadTransfer(x.id));
  });

  const readLines = (lines, key = 'qty') => {
    if (!Array.isArray(lines) || !lines.length) fail(400, 'Phiếu cần ít nhất một dòng');
    const seen = new Set();
    return lines.map((l) => {
      const id = v.int(l.ingredient_id, { min: 1, name: 'Nguyên liệu' });
      if (seen.has(id)) fail(400, 'Một nguyên liệu bị nhập 2 lần');
      seen.add(id);
      const ing = ingById(id);
      if (!ing) fail(404, 'Không tìm thấy nguyên liệu');
      return { ing, qty: num(l[key] ?? l.qty, `Số lượng ${ing.name}`), raw: l };
    });
  };

  r.post('/api/stock/transfers', 'staff', ({ me, body }) => {
    const to = storeById(v.int(body.to_store_id, { min: 1, name: 'Kho nhận' }));
    if (!to || to.kind !== 'area') fail(400, 'Chọn kho của khu');
    if (!canStore(me, to)) fail(403, 'Bạn chỉ xin lĩnh hàng cho khu của mình');
    const main = mainStore();
    const lines = readLines(body.lines).filter((l) => l.qty > 0);
    if (!lines.length) fail(400, 'Nhập số lượng cần lĩnh');
    const id = tx(db, () => {
      const id = Number(db.prepare('INSERT INTO transfers (from_store, to_store, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(main.id, to.id, v.text(body.note, { name: 'Ghi chú', max: 300 }), me.id, ctx.now()).lastInsertRowid);
      for (const l of lines) db.prepare('INSERT INTO transfer_lines (transfer_id, ingredient_id, qty_requested) VALUES (?, ?, ?)').run(id, l.ing.id, l.qty);
      return id;
    });
    ctx.notify(holderTargets().filter((x) => x !== me.id), { title: `${to.name} xin lĩnh hàng (phiếu #${id})`, body: lines.map((l) => `• ${l.ing.name}: ${l.qty} ${l.ing.unit}`).join('\n'), link: '/kho?tab=linh' });
    ctx.audit(me, 'transfer.create', id);
    ctx.broadcast('stock');
    return { id };
  });

  r.post('/api/stock/transfers/:id/send', 'staff', ({ me, params, body }) => {
    const t = loadTransfer(params.id);
    if (!isHolder(me)) fail(403, 'Chỉ người giữ kho tổng hoặc trưởng ca trở lên mới xuất kho');
    if (t.status !== 'requested') fail(409, 'Phiếu này đã được xử lý');
    const given = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [Number(l.ingredient_id), l.qty]));
    const at = ctx.now();
    tx(db, () => {
      for (const l of t.lines) {
        const ing = ingById(l.ingredient_id);
        const qty = given.has(l.ingredient_id) ? num(given.get(l.ingredient_id), `Số xuất ${l.name}`) : l.qty_requested;
        const taken = qty > 0 ? takeLots(db, { storeId: t.from_store, ingredientId: l.ingredient_id, qty, name: l.name }) : [];
        const exp = taken.map((x) => x.expires_on).filter(Boolean).sort()[0] || null;
        db.prepare('UPDATE transfer_lines SET qty_sent = ?, expires_on = ? WHERE transfer_id = ? AND ingredient_id = ?').run(qty, exp, t.id, l.ingredient_id);
        recordMove(db, { at, date: today(), type: 'transfer', ingredientId: l.ingredient_id, fromStore: t.from_store, toStore: t.to_store, qty, cost: costOf(ing, qty), ref: `transfer:${t.id}`, staffId: me.id, note: 'Xuất kho tổng' });
      }
      db.prepare("UPDATE transfers SET status = 'sent', sent_by = ?, sent_at = ? WHERE id = ?").run(me.id, at, t.id);
    });
    ctx.notify([t.created_by, ...ctx.leadsOf(t.to_team)].filter((x) => x && x !== me.id), { title: `Kho tổng đã xuất phiếu #${t.id} cho ${t.to_name}`, body: 'Kiểm đếm và bấm "Đã nhận" trong app.', link: '/kho?tab=linh' });
    ctx.audit(me, 'transfer.send', t.id);
    ctx.broadcast('stock');
    return loadTransfer(t.id);
  });

  r.post('/api/stock/transfers/:id/receive', 'staff', ({ me, params, body }) => {
    const t = loadTransfer(params.id);
    const to = storeById(t.to_store);
    if (!canStore(me, to)) fail(403, 'Chỉ người của khu nhận mới xác nhận được');
    if (t.status !== 'sent') fail(409, 'Phiếu chưa được xuất hoặc đã nhận rồi');
    const given = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [Number(l.ingredient_id), l.qty]));
    const at = ctx.now();
    const missing = [];
    tx(db, () => {
      for (const l of t.lines) {
        const ing = ingById(l.ingredient_id);
        const got = given.has(l.ingredient_id) ? num(given.get(l.ingredient_id), `Số nhận ${l.name}`, { max: l.qty_sent }) : l.qty_sent;
        addLot(db, { storeId: t.to_store, ingredientId: l.ingredient_id, qty: got, expiresOn: l.expires_on, at });
        db.prepare('UPDATE transfer_lines SET qty_received = ? WHERE transfer_id = ? AND ingredient_id = ?').run(got, t.id, l.ingredient_id);
        const lost = r3(l.qty_sent - got);
        if (lost > 0) {
          missing.push(`${l.name}: thiếu ${lost} ${l.unit}`);
          recordMove(db, { at, date: today(), type: 'waste', ingredientId: l.ingredient_id, fromStore: t.to_store, qty: lost, cost: costOf(ing, lost), ref: `transfer:${t.id}`, staffId: me.id, note: 'Thiếu khi nhận hàng từ kho tổng' });
        }
      }
      db.prepare("UPDATE transfers SET status = 'received', received_by = ?, received_at = ? WHERE id = ?").run(me.id, at, t.id);
    });
    if (missing.length) ctx.notify(holderTargets().filter((x) => x !== me.id), { title: `Phiếu #${t.id}: nhận thiếu hàng`, body: missing.join('\n'), link: '/kho?tab=linh' });
    ctx.audit(me, 'transfer.receive', t.id);
    ctx.broadcast('stock');
    return loadTransfer(t.id);
  });

  r.post('/api/stock/transfers/:id/cancel', 'staff', ({ me, params }) => {
    const t = loadTransfer(params.id);
    if (t.status !== 'requested') fail(409, 'Chỉ huỷ được phiếu chưa xuất');
    if (t.created_by !== me.id && !isHolder(me)) fail(403, 'Bạn không huỷ được phiếu này');
    db.prepare("UPDATE transfers SET status = 'cancelled' WHERE id = ?").run(t.id);
    ctx.broadcast('stock');
    return { ok: true };
  });

  // ---------- Đơn đặt hàng NCC ----------
  function poText(po) {
    const dd = (d) => (d ? `${d.slice(8)}/${d.slice(5, 7)}` : '');
    const lines = po.lines.filter((l) => l.qty > 0).map((l) => `• ${l.name}: ${l.qty} ${l.purchase_unit}`);
    return [
      `🛒 ĐƠN ĐẶT HÀNG #${po.id}${po.supplier_name ? ` – ${po.supplier_name}` : ''}`,
      `Quán: ${ctx.setting('shop_name')}${po.deliver_on ? ` · Giao ngày ${dd(po.deliver_on)}` : ''} · Nhận tại: ${po.store_name}`,
      ...lines,
      po.note ? `Ghi chú: ${po.note}` : '',
      po.approved_by_name ? `Người duyệt: ${po.approved_by_name}` : '',
    ].filter(Boolean).join('\n');
  }

  function loadPo(id) {
    const po = db.prepare(`SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, st.name AS store_name,
      c.name AS created_by_name, sb.name AS submitted_by_name, a.name AS approved_by_name, rb.name AS received_by_name
      FROM purchase_orders p LEFT JOIN suppliers s ON s.id = p.supplier_id JOIN stores st ON st.id = p.store_id
      LEFT JOIN staff c ON c.id = p.created_by LEFT JOIN staff sb ON sb.id = p.submitted_by LEFT JOIN staff a ON a.id = p.approved_by LEFT JOIN staff rb ON rb.id = p.received_by
      WHERE p.id = ?`).get(id);
    if (!po) fail(404, 'Không tìm thấy đơn đặt hàng');
    po.lines = db.prepare(`SELECT l.*, i.name, i.unit, i.purchase_unit, i.purchase_factor, i.shelf_days FROM po_lines l JOIN ingredients i ON i.id = l.ingredient_id
      WHERE l.po_id = ? ORDER BY i.name`).all(id);
    po.total = po.lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0);
    po.text = poText(po);
    po.lead_store_ids = db.prepare('SELECT id FROM stores WHERE supplier_id IS ? AND kind = ?').all(po.supplier_id, 'area').map((x) => x.id);
    return po;
  }

  const canEditPo = (me, po) => rank(me.role) >= rank('shift_lead')
    || (me.role === 'team_lead' && po.lead_store_ids.some((sid) => storeById(sid)?.team_id === me.team_id));

  r.get('/api/stock/po', 'staff', ({ query }) => {
    const status = query.get('status');
    const ids = db.prepare(`SELECT id FROM purchase_orders ${status ? 'WHERE status = ?' : "WHERE status != 'cancelled'"}
      ORDER BY CASE status WHEN 'submitted' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, id DESC LIMIT 100`).all(...(status ? [status] : []));
    return ids.map((x) => loadPo(x.id));
  });

  // Tạo/làm mới đề xuất đặt hàng cho từng NCC từ tồn kho và tốc độ dùng
  ctx.generatePurchaseDrafts = (me) => {
    const main = mainStore();
    const o = overview();
    const incoming = new Map(db.prepare(`SELECT l.ingredient_id, SUM(l.qty * i.purchase_factor) AS q FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id
      JOIN ingredients i ON i.id = l.ingredient_id WHERE p.status IN ('submitted','approved') GROUP BY l.ingredient_id`).all().map((x) => [x.ingredient_id, x.q]));
    const bySupplier = new Map();
    for (const it of o.items) {
      const ing = ingById(it.id);
      const need = purchaseNeed({
        freshness: ing.freshness, forecastTomorrow: it.forecast_tomorrow, avgDaily: it.avg_daily, leadDays: ing.lead_days,
        cycleDays: ing.cycle_days, minStock: ing.min_stock, safetyPct: ing.safety_pct, stock: it.available + (incoming.get(ing.id) || 0),
      });
      const units = toPurchaseUnits(need, { factor: ing.purchase_factor, step: ing.order_step });
      if (units <= 0) continue;
      const key = it.supplier_id ?? 0;
      bySupplier.set(key, [...(bySupplier.get(key) || []), { ing, units }]);
    }
    const t = ctx.now();
    const touched = [];
    tx(db, () => {
      const drafts = db.prepare("SELECT * FROM purchase_orders WHERE status = 'draft'").all();
      for (const d of drafts) if (!bySupplier.has(d.supplier_id ?? 0)) db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(d.id);
      for (const [sid, lines] of bySupplier) {
        let po = drafts.find((d) => (d.supplier_id ?? 0) === sid);
        const ld = Math.max(...lines.map((l) => l.ing.lead_days), 1);
        if (!po) {
          const id = Number(db.prepare('INSERT INTO purchase_orders (supplier_id, store_id, deliver_on, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(sid || null, main.id, addDays(today(), ld), me?.id ?? null, t).lastInsertRowid);
          po = { id };
        } else {
          db.prepare('UPDATE purchase_orders SET deliver_on = ? WHERE id = ?').run(addDays(today(), ld), po.id);
        }
        db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(po.id);
        for (const l of lines) db.prepare('INSERT INTO po_lines (po_id, ingredient_id, qty, suggested, price) VALUES (?, ?, ?, ?, ?)').run(po.id, l.ing.id, l.units, l.units, l.ing.price);
        touched.push(po.id);
      }
    });
    return touched;
  };

  r.post('/api/stock/po/generate', 'team_lead', ({ me }) => {
    const ids = ctx.generatePurchaseDrafts(me);
    ctx.audit(me, 'po.generate', ids.join(','));
    ctx.broadcast('stock');
    return { ids, orders: ids.map(loadPo) };
  });

  r.patch('/api/stock/po/:id', 'team_lead', ({ me, params, body }) => {
    const po = loadPo(params.id);
    if (po.status !== 'draft') fail(409, 'Chỉ sửa được đơn nháp');
    if (!canEditPo(me, po)) fail(403, 'Bạn chỉ sửa được đơn của NCC khu mình');
    tx(db, () => {
      if (body.lines !== undefined) {
        const lines = readLines(body.lines);
        const old = new Map(po.lines.map((l) => [l.ingredient_id, l]));
        db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(po.id);
        for (const l of lines) {
          if (l.qty <= 0) continue;
          const price = l.raw.price === undefined ? (old.get(l.ing.id)?.price ?? l.ing.price) : v.int(l.raw.price, { min: 0, max: 1e9, name: `Giá ${l.ing.name}` });
          db.prepare('INSERT INTO po_lines (po_id, ingredient_id, qty, suggested, price) VALUES (?, ?, ?, ?, ?)').run(po.id, l.ing.id, l.qty, old.get(l.ing.id)?.suggested ?? 0, price);
        }
      }
      const deliver = body.deliver_on === undefined ? po.deliver_on : body.deliver_on;
      if (deliver && !isDate(deliver)) fail(400, 'Ngày giao không hợp lệ');
      db.prepare('UPDATE purchase_orders SET deliver_on = ?, note = ? WHERE id = ?').run(deliver || null, body.note === undefined ? po.note : v.text(body.note, { name: 'Ghi chú', max: 300 }), po.id);
    });
    ctx.broadcast('stock');
    return loadPo(po.id);
  });

  r.post('/api/stock/po/:id/submit', 'team_lead', ({ me, params }) => {
    const po = loadPo(params.id);
    if (po.status !== 'draft') fail(409, 'Đơn này đã gửi duyệt rồi');
    if (!canEditPo(me, po)) fail(403, 'Bạn chỉ gửi được đơn của NCC khu mình');
    if (!po.lines.some((l) => l.qty > 0)) fail(400, 'Đơn chưa có hàng');
    db.prepare("UPDATE purchase_orders SET status = 'submitted', submitted_by = ?, submitted_at = ? WHERE id = ?").run(me.id, ctx.now(), po.id);
    ctx.notify(ctx.managers().filter((x) => x !== me.id), { title: `Đơn đặt hàng #${po.id} chờ duyệt`, body: `${po.supplier_name || 'Chưa chọn NCC'} · ${po.lines.length} mặt hàng · khoảng ${po.total.toLocaleString('vi-VN')}đ`, link: '/kho?tab=dat' });
    ctx.audit(me, 'po.submit', po.id);
    ctx.broadcast('stock');
    return loadPo(po.id);
  });

  r.post('/api/stock/po/:id/approve', 'manager', ({ me, params }) => {
    const po = loadPo(params.id);
    if (!['draft', 'submitted'].includes(po.status)) fail(409, 'Đơn này đã được duyệt hoặc đã nhận');
    if (!po.supplier_id) fail(400, 'Đơn chưa có NCC. Gán NCC cho kho khu hoặc nguyên liệu trước');
    db.prepare("UPDATE purchase_orders SET status = 'approved', approved_by = ?, approved_at = ?, submitted_by = COALESCE(submitted_by, ?), submitted_at = COALESCE(submitted_at, ?) WHERE id = ?")
      .run(me.id, ctx.now(), me.id, ctx.now(), po.id);
    const done = loadPo(po.id);
    // Gửi nội dung đơn cho người giữ kho và người lập/gửi đơn. Gửi thẳng vào nhóm Zalo "Mua đồ" cần nhóm của OA (chưa xác nhận API) → tạm dùng nút sao chép.
    ctx.notify([...holderTargets(), po.created_by, po.submitted_by].filter((x) => x && x !== me.id), { title: `Đã duyệt đơn #${po.id} – gửi NCC`, body: done.text, link: '/kho?tab=dat' });
    ctx.audit(me, 'po.approve', po.id);
    ctx.broadcast('stock');
    return done;
  });

  r.post('/api/stock/po/:id/reject', 'manager', ({ me, params, body }) => {
    const po = loadPo(params.id);
    if (po.status !== 'submitted') fail(409, 'Chỉ trả lại được đơn đang chờ duyệt');
    const note = v.text(body.note, { name: 'Lý do', max: 300 });
    db.prepare("UPDATE purchase_orders SET status = 'draft', note = ? WHERE id = ?").run(note || po.note, po.id);
    ctx.notify([po.submitted_by].filter((x) => x && x !== me.id), { title: `Đơn #${po.id} bị trả lại`, body: note, link: '/kho?tab=dat' });
    ctx.broadcast('stock');
    return loadPo(po.id);
  });

  r.post('/api/stock/po/:id/cancel', 'team_lead', ({ me, params }) => {
    const po = loadPo(params.id);
    if (po.status === 'received') fail(409, 'Đơn đã nhận hàng, không huỷ được');
    if (po.status === 'approved' && rank(me.role) < rank('manager')) fail(403, 'Đơn đã duyệt chỉ quản lý mới huỷ được');
    if (!canEditPo(me, po)) fail(403, 'Bạn không huỷ được đơn này');
    db.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").run(po.id);
    ctx.audit(me, 'po.cancel', po.id);
    ctx.broadcast('stock');
    return { ok: true };
  });

  function receiveInto(me, { po, storeId, lines }) {
    const at = ctx.now();
    const t = today();
    for (const l of lines) {
      const ing = l.ing;
      const qty = l.qty;
      if (qty <= 0) continue;
      const price = l.raw.price === undefined || l.raw.price === '' ? (l.defaultPrice ?? ing.price) : v.int(l.raw.price, { min: 0, max: 1e9, name: `Giá ${ing.name}` });
      let exp = l.raw.expires_on || null;
      if (exp && !isDate(exp)) fail(400, `Hạn dùng của ${ing.name} không hợp lệ`);
      if (!exp && ing.shelf_days > 0) exp = addDays(t, ing.shelf_days);
      const useQty = r3(qty * (ing.purchase_factor || 1));
      addLot(db, { storeId, ingredientId: ing.id, qty: useQty, expiresOn: exp, at });
      recordMove(db, { at, date: t, type: 'receive', ingredientId: ing.id, toStore: storeId, qty: useQty, cost: qty * price, ref: po ? `po:${po.id}` : 'nhap-le', staffId: me.id, note: po?.supplier_name || '' });
      if (price > 0) db.prepare('UPDATE ingredients SET price = ? WHERE id = ?').run(price, ing.id);
      if (po) db.prepare('UPDATE po_lines SET qty_received = ?, price_received = ? WHERE po_id = ? AND ingredient_id = ?').run(qty, price, po.id, ing.id);
    }
  }

  r.post('/api/stock/po/:id/receive', 'staff', ({ me, params, body }) => {
    const po = loadPo(params.id);
    if (!isHolder(me)) fail(403, 'Chỉ người giữ kho tổng hoặc trưởng ca trở lên mới nhập kho');
    if (po.status !== 'approved') fail(409, 'Chỉ nhận hàng cho đơn đã duyệt');
    const given = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [Number(l.ingredient_id), l]));
    tx(db, () => {
      const lines = po.lines.map((pl) => {
        const raw = given.get(pl.ingredient_id) || {};
        return { ing: ingById(pl.ingredient_id), qty: raw.qty === undefined ? pl.qty : num(raw.qty, `Số nhận ${pl.name}`), raw, defaultPrice: pl.price };
      });
      receiveInto(me, { po, storeId: po.store_id, lines });
      db.prepare("UPDATE purchase_orders SET status = 'received', received_by = ?, received_at = ? WHERE id = ?").run(me.id, ctx.now(), po.id);
    });
    ctx.audit(me, 'po.receive', po.id);
    ctx.broadcast('stock');
    return loadPo(po.id);
  });

  // Nhập kho lẻ (không qua đơn), vd mua ngoài chợ
  r.post('/api/stock/receive', 'staff', ({ me, body }) => {
    if (!isHolder(me)) fail(403, 'Chỉ người giữ kho tổng hoặc trưởng ca trở lên mới nhập kho');
    const st = storeById(v.optInt(body.store_id, { min: 1, name: 'Kho' }) ?? mainStore().id);
    if (!st) fail(404, 'Không tìm thấy kho');
    const lines = readLines(body.lines);
    tx(db, () => receiveInto(me, { po: null, storeId: st.id, lines }));
    ctx.audit(me, 'stock.receive', { store: st.id, lines: lines.length });
    ctx.broadcast('stock');
    return { ok: true };
  });

  // ---------- Lịch sử ----------
  r.get('/api/stock/moves', 'staff', ({ query }) => {
    const from = query.get('from') || addDays(today(), -7);
    const to = query.get('to') || today();
    if (!isDate(from) || !isDate(to)) fail(400, 'Ngày không hợp lệ');
    const ing = query.get('ingredient');
    return db.prepare(`SELECT m.*, i.name, i.unit, fs.name AS from_name, ts.name AS to_name, s.name AS staff_name FROM stock_moves m
      JOIN ingredients i ON i.id = m.ingredient_id LEFT JOIN stores fs ON fs.id = m.from_store LEFT JOIN stores ts ON ts.id = m.to_store
      LEFT JOIN staff s ON s.id = m.staff_id WHERE m.date BETWEEN ? AND ? ${ing ? 'AND m.ingredient_id = ?' : ''} ORDER BY m.at DESC, m.id DESC LIMIT 500`)
      .all(...[from, to, ...(ing ? [Number(ing)] : [])]);
  });
}
