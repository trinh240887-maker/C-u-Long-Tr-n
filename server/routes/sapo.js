// Nhập bán hàng từ file Excel Sapo (chủ quán 28/10: tạm thời mỗi ngày tải "Doanh thu theo danh sách mặt hàng" từ Sapo, úp lên để thử trừ kho).
// - Đọc file → gộp số lượng từng món theo ngày bán (giờ thanh toán; trước giờ chốt ngày tính vào hôm trước) → ghép món Sapo với Thực đơn
// - Ghép 1 lần, lưu lại (lần sau tự nhận) · trừ kho theo định lượng như bán trên app · mỗi ngày chỉ nhập 1 lần (không trùng)
import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { readXlsx, excelDate } from '../lib/xlsx-read.js';
import { addDays } from '../lib/time.js';
import { addLot, recordMove, takeLots } from '../lib/stock.js';

const norm = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/\*+/g, '').replace(/\(([^)]*)\)/g, ' $1 ').replace(/[-–,.]/g, ' ').replace(/\s+/g, ' ').trim();
const strip = (x) => norm(x).replace(/(^| )(thêm|combo|set|phần|100g|200g|ly|lon|chai|ngăn|tặng)(?= |$)/g, ' ').replace(/\s+/g, ' ').trim();

export default function (r, ctx) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS sapo_map (key TEXT PRIMARY KEY, menu_item_id INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS sapo_imports (id INTEGER PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL, lines INTEGER, qty REAL, revenue INTEGER, invoices INTEGER, by_staff INTEGER, at INTEGER, UNIQUE (date, kind));
    CREATE TABLE IF NOT EXISTS sapo_daily (date TEXT NOT NULL, key TEXT NOT NULL, code TEXT, name TEXT, category TEXT, qty REAL NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (date, key));`);
  // Mã riêng mỗi lần nhập (rà soát 28/10): id có thể dùng lại sau khi bỏ nhập → dùng mã ngẫu nhiên
  try { db.exec("ALTER TABLE sapo_imports ADD COLUMN tag TEXT NOT NULL DEFAULT ''"); } catch { /* đã có */ }

  function parse(data) {
    const m = /^(?:data:[^;]*;base64,)?([A-Za-z0-9+/=\s]+)$/.exec(String(data || ''));
    if (!m) fail(400, 'File không hợp lệ');
    let rows;
    try { rows = readXlsx(Buffer.from(m[1], 'base64')); } catch (e) { fail(400, `Không đọc được file: ${e.message}`); }
    const hi = rows.findIndex((x) => Object.values(x).some((c) => /^Mã hóa đơn$/i.test(String(c).trim())));
    if (hi < 0) fail(400, 'Không phải file xuất từ Sapo (không thấy cột "Mã hóa đơn")');
    const col = {};
    for (const [k, c] of Object.entries(rows[hi])) col[String(c).replace(/\s+/g, ' ').trim()] = k;
    const pick = (re) => Object.entries(col).find(([h]) => re.test(h))?.[1];
    const C = { inv: pick(/^Mã hóa đơn$/i), status: pick(/^Trạng thái/i), paid: pick(/^Thời gian thanh toán/i), created: pick(/^Thời gian tạo/i), code: pick(/^Mã mặt hàng/i), name: pick(/^Tên mặt hàng/i), cat: pick(/^Danh mục/i), qty: pick(/^Số lượng/i), amount: pick(/^Tiền hàng$/i), total: pick(/^Tổng tiền thanh toán/i) };
    if (!C.name || !C.qty) fail(400, 'File này là "Doanh thu theo danh sách HÓA ĐƠN" (không có món). Trên Sapo tải "Doanh thu theo danh sách MẶT HÀNG" rồi úp lại');
    const cutoff = Number(ctx.setting('day_cutoff_hour') || 5) * 60;
    const days = new Map();
    let skipped = 0;
    for (const row of rows.slice(hi + 1)) {
      const name = String(row[C.name] || '').trim();
      if (!name) continue;
      if (C.status && row[C.status] && !/đã thanh toán/i.test(row[C.status])) { skipped++; continue; }
      const t = excelDate(row[C.paid]) || excelDate(row[C.created]);
      if (!t) continue;
      const date = t.minute < cutoff ? addDays(t.date, -1) : t.date;
      const code = String(row[C.code] || '').trim();
      const key = code || `n:${norm(name)}`;
      const d = days.get(date) || { date, items: new Map(), invoices: new Map(), lines: 0 };
      const it = d.items.get(key) || { key, code, name, category: String(row[C.cat] || ''), qty: 0, amount: 0 };
      it.qty += Number(row[C.qty]) || 0; it.amount += Math.round(Number(row[C.amount]) || 0);
      d.items.set(key, it);
      if (row[C.inv]) d.invoices.set(row[C.inv], Math.round(Number(row[C.total]) || 0));
      d.lines++;
      days.set(date, d);
    }
    if (!days.size) fail(400, 'File không có dòng bán hàng nào');
    return { days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), skipped };
  }

  const menu = () => db.prepare('SELECT m.id, m.name, (SELECT COUNT(*) FROM menu_recipes r WHERE r.item_id = m.id) AS parts FROM menu_items m WHERE m.active = 1 ORDER BY m.name').all();
  // Ghép món Sapo ↔ Thực đơn: đã lưu → dùng; chưa → tên giống hệt / gần giống (chỉ 1 món khớp)
  function guess(it, list) {
    const saved = db.prepare('SELECT menu_item_id FROM sapo_map WHERE key = ?').get(it.key);
    if (saved) return { id: saved.menu_item_id, auto: false };
    const n = norm(it.name), s = strip(it.name);
    let hit = list.filter((m) => norm(m.name) === n);
    if (hit.length !== 1) hit = list.filter((m) => strip(m.name) === s);
    if (hit.length !== 1) hit = list.filter((m) => { const ms = strip(m.name); return ms.length > 3 && (s.includes(ms) || ms.includes(s)); });
    return { id: hit.length === 1 ? hit[0].id : null, auto: true };
  }

  // Số món bán trên app (gửi bếp) đã trừ kho trong ngày → úp Sapo ngày đó sẽ trừ 2 lần (chủ quán 30/10: chuyển dần sang trừ theo app)
  const appSales = () => (date) => db.prepare("SELECT COUNT(DISTINCT ref) AS n FROM stock_moves WHERE type = 'consume' AND date = ? AND ref LIKE 'sale:%' AND ref NOT LIKE 'sale:sapo-%'").get(date).n;
  r.post('/api/sapo/preview', 'manager', ({ body }) => {
    const { days, skipped } = parse(body.data);
    const list = menu();
    const done = new Set(db.prepare("SELECT date FROM sapo_imports WHERE kind = 'items'").all().map((x) => x.date));
    const appN = appSales();
    const items = new Map();
    for (const d of days) for (const it of d.items.values()) { const x = items.get(it.key) || { ...it, qty: 0, amount: 0 }; x.qty += it.qty; x.amount += it.amount; items.set(it.key, x); }
    return {
      skipped,
      dates: days.map((d) => ({ date: d.date, lines: d.lines, qty: [...d.items.values()].reduce((a, x) => a + x.qty, 0), invoices: d.invoices.size, revenue: [...d.invoices.values()].reduce((a, x) => a + x, 0), imported: done.has(d.date), app_sales: appN(d.date) })),
      items: [...items.values()].map((it) => { const g = guess(it, list); const m = list.find((x) => x.id === g.id); return { key: it.key, code: it.code, name: it.name, category: it.category, qty: it.qty, amount: it.amount, menu_item_id: g.id, auto: g.auto, has_recipe: !!m?.parts }; })
        .sort((a, b) => (a.menu_item_id == null ? 0 : 1) - (b.menu_item_id == null ? 0 : 1) || b.qty - a.qty),
      menu: list.map((m) => ({ id: m.id, name: m.name, has_recipe: !!m.parts })),
      last_count: db.prepare('SELECT MAX(at) AS at FROM stock_counts').get()?.at || null,
    };
  });

  r.post('/api/sapo/import', 'manager', ({ me, body }) => {
    const { days } = parse(body.data);
    const want = new Set((Array.isArray(body.dates) ? body.dates : []).map(String));
    if (!want.size) fail(400, 'Chọn ngày cần nhập');
    const map = body.map && typeof body.map === 'object' ? body.map : {};
    const list = menu(), ids = new Set(list.map((m) => m.id));
    const res = { dates: [], deducted: 0, no_recipe: new Map(), unmatched: new Map(), short: [] };
    tx(db, () => {
      // Lưu ghép món (0 = bỏ qua, không trừ kho)
      for (const [key, val] of Object.entries(map)) {
        const id = val === null || val === '' ? null : Number(val);
        if (id === null) continue;
        if (id && !ids.has(id)) fail(400, 'Món ghép không còn trong Thực đơn');
        const it = days.flatMap((d) => [...d.items.values()]).find((x) => x.key === key);
        db.prepare('INSERT INTO sapo_map (key, menu_item_id, name, code) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET menu_item_id = excluded.menu_item_id, name = excluded.name, code = excluded.code').run(key, id, it?.name || '', it?.code || '');
      }
      for (const d of days) {
        if (!want.has(d.date)) continue;
        if (db.prepare("SELECT 1 FROM sapo_imports WHERE date = ? AND kind = 'items'").get(d.date)) continue; // đã nhập ngày này
        const nApp = appSales()(d.date);
        if (nApp && !(Array.isArray(body.allow_app_days) && body.allow_app_days.includes(d.date))) fail(409, `Ngày ${d.date.split('-').reverse().join('/')} app đã trừ kho ${nApp} món bán (gửi bếp). Úp Sapo nữa sẽ trừ 2 lần. Bỏ chọn ngày này, hoặc xác nhận nếu món bán trên app chỉ là thử.`, 'app_sales', { date: d.date, n: nApp });
        // rà soát 28/10: ghi lần nhập trước để mã dòng bán / bù gắn với lần nhập này (sale:sapo-<mã lần nhập>-…), nhập lại sau khi bỏ không lẫn dòng cũ
        const tag = `i${crypto.randomBytes(5).toString('hex')}`;
        db.prepare("INSERT INTO sapo_imports (date, kind, lines, qty, revenue, invoices, by_staff, at, tag) VALUES (?, 'items', ?, ?, ?, ?, ?, ?, ?)")
          .run(d.date, d.lines, [...d.items.values()].reduce((a, x) => a + x.qty, 0), [...d.invoices.values()].reduce((a, x) => a + x, 0), d.invoices.size, me.id, ctx.now(), tag);
        const sale = [];
        for (const it of d.items.values()) {
          const g = guess(it, list);
          db.prepare('INSERT OR REPLACE INTO sapo_daily (date, key, code, name, category, qty, amount) VALUES (?, ?, ?, ?, ?, ?, ?)').run(d.date, it.key, it.code, it.name, it.category, it.qty, it.amount);
          if (g.id == null) { res.unmatched.set(it.name, (res.unmatched.get(it.name) || 0) + it.qty); continue; }
          if (!g.id) continue; // bỏ qua
          const m = list.find((x) => x.id === g.id);
          if (!m.parts) { res.no_recipe.set(m.name, (res.no_recipe.get(m.name) || 0) + it.qty); continue; }
          sale.push({ id: `sapo-${tag}-${d.date}-${it.key}`, menu_item_id: g.id, qty: it.qty, name: `${m.name} (Sapo)` });
        }
        const at = ctx.clock().toEpoch(d.date, 23 * 60);
        const short = ctx.consumeSale?.(me, sale, { date: d.date, at, quiet: true, force: true }) || [];
        res.short.push(...short.map((x) => ({ ...x, date: d.date })));
        // Đã kiểm kho ngày này (hoặc sau) trước khi úp Sapo: số đếm đã là thực tế → cộng lại phần vừa trừ (không trừ 2 lần), giữ dòng bán để tính hao hụt
        for (const mv of db.prepare("SELECT ingredient_id, from_store, SUM(qty) AS q FROM stock_moves WHERE type = 'consume' AND ref LIKE ? GROUP BY ingredient_id, from_store").all(`sale:sapo-${tag}-%`)) {
          const counted = db.prepare('SELECT 1 FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id WHERE l.ingredient_id = ? AND c.date >= ? LIMIT 1').get(mv.ingredient_id, d.date);
          if (!counted || !(mv.q > 1e-9)) continue;
          addLot(db, { storeId: mv.from_store, ingredientId: mv.ingredient_id, qty: mv.q, at });
          recordMove(db, { at, date: d.date, type: 'adjust', ingredientId: mv.ingredient_id, toStore: mv.from_store, qty: mv.q, ref: `recount:sapo-${tag}`, staffId: me.id, note: 'Đã kiểm kho trước khi úp Sapo: không trừ thêm tồn' });
          res.recount = (res.recount || 0) + 1;
        }
        res.deducted += sale.length;
        res.dates.push(d.date);
      }
    });
    ctx.audit(me, 'sapo.import', { dates: res.dates, deducted: res.deducted });
    ctx.broadcast('stock');
    return { dates: res.dates, deducted: res.deducted, no_recipe: [...res.no_recipe].map(([name, qty]) => ({ name, qty })), unmatched: [...res.unmatched].map(([name, qty]) => ({ name, qty })), short: res.short.slice(0, 50) };
  });

  r.get('/api/sapo/imports', 'manager', () => db.prepare("SELECT i.*, s.name AS by_name FROM sapo_imports i LEFT JOIN staff s ON s.id = i.by_staff ORDER BY i.date DESC LIMIT 60").all());
  // Nhập nhầm → bỏ ngày đó (trả lại kho những gì đã trừ)
  r.post('/api/sapo/undo', 'manager', ({ me, body }) => {
    if (rank(me.role) < rank('manager')) fail(403, 'Không có quyền');
    const date = v.text(body.date, { name: 'Ngày', required: true, max: 10 });
    const imp = db.prepare("SELECT * FROM sapo_imports WHERE date = ? AND kind = 'items'").get(date);
    if (!imp) fail(404, 'Ngày này chưa nhập');
    // rà soát 28/10: chỉ trả lại phần CÒN LẠI của lần nhập này = đã trừ − đã huỷ trước đó (mã cũ sale:sapo-<ngày>-… có thể đã bỏ 1 lần)
    const net = (type, refSql, args, cancelType, cancelRef) => db.prepare(`SELECT m.ref, m.ingredient_id, ${type === 'consume' ? 'm.from_store' : 'm.to_store'} AS store, SUM(m.qty)
        - COALESCE((SELECT SUM(c.qty) FROM stock_moves c WHERE c.type = '${cancelType}' AND c.ref = ${cancelRef} AND c.ingredient_id = m.ingredient_id AND ${cancelType === 'adjust' ? 'c.to_store' : 'c.from_store'} IS ${type === 'consume' ? 'm.from_store' : 'm.to_store'}), 0) AS q
      FROM stock_moves m WHERE m.type = '${type}' AND (${refSql}) GROUP BY m.ref, m.ingredient_id, store`).all(...args).filter((x) => x.q > 1e-9);
    const sales = net('consume', 'm.ref LIKE ? OR m.ref LIKE ?', [`sale:sapo-${imp.tag || date}-%`, `sale:sapo-${date}-%`], 'adjust', "'cancel:' || substr(m.ref, 6)");
    const recounts = net('adjust', 'm.ref = ? OR m.ref = ?', [`recount:sapo-${imp.tag || date}`, `recount:sapo-${date}`], 'waste', "'cancel:' || m.ref");
    tx(db, () => {
      for (const mv of sales) {
        addLot(db, { storeId: mv.store, ingredientId: mv.ingredient_id, qty: mv.q, at: ctx.now() });
        recordMove(db, { at: ctx.now(), date: ctx.today(), type: 'adjust', ingredientId: mv.ingredient_id, toStore: mv.store, qty: mv.q, ref: `cancel:${mv.ref.slice(5)}`, staffId: me.id, note: `Bỏ nhập Sapo ngày ${date}` });
      }
      for (const mv of recounts) {
        takeLots(db, { storeId: mv.store, ingredientId: mv.ingredient_id, qty: mv.q, allowShort: true });
        recordMove(db, { at: ctx.now(), date: ctx.today(), type: 'waste', ingredientId: mv.ingredient_id, fromStore: mv.store, qty: mv.q, ref: `cancel:${mv.ref}`, staffId: me.id, note: `Bỏ nhập Sapo ngày ${date}` });
      }
      try { db.prepare('DELETE FROM sale_usage WHERE ref LIKE ? OR ref LIKE ?').run(`sale:sapo-${imp.tag || date}-%`, `sale:sapo-${date}-%`); } catch { /* bảng chưa có */ }
      db.prepare("DELETE FROM sapo_imports WHERE id = ?").run(imp.id);
      db.prepare('DELETE FROM sapo_daily WHERE date = ?').run(date);
    });
    ctx.audit(me, 'sapo.undo', { date });
    ctx.broadcast('stock');
    return { ok: true };
  });
}
