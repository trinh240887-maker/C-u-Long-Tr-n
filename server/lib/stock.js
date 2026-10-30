import { r3 } from './forecast.js';
import { fail } from '../http.js';

// Tồn kho lưu theo lô; xuất kho lấy lô hết hạn sớm nhất trước (FEFO), lô không có hạn lấy sau cùng theo ngày nhập.

export function stockQty(db, storeId, ingredientId) {
  return r3(db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE store_id = ? AND ingredient_id = ?').get(storeId, ingredientId).q);
}

export function addLot(db, { storeId, ingredientId, qty, expiresOn = null, at }) {
  if (!(qty > 1e-9)) return;
  db.prepare('INSERT INTO stock_lots (store_id, ingredient_id, qty, expires_on, received_at) VALUES (?, ?, ?, ?, ?)')
    .run(storeId, ingredientId, r3(qty), expiresOn || null, at);
}

// Lấy `qty` khỏi kho. Trả về các phần đã lấy [{ qty, expires_on }].
export function takeLots(db, { storeId, ingredientId, qty, allowShort = false, name = 'Nguyên liệu' }) {
  const lots = db.prepare(`SELECT * FROM stock_lots WHERE store_id = ? AND ingredient_id = ?
    ORDER BY expires_on IS NULL, expires_on, received_at, id`).all(storeId, ingredientId);
  const have = r3(lots.reduce((s, l) => s + l.qty, 0));
  if (!allowShort && have + 1e-9 < qty) fail(409, `${name}: kho chỉ còn ${have}, không đủ ${r3(qty)}`);
  let left = qty;
  const taken = [];
  for (const l of lots) {
    if (left <= 1e-9) break;
    const take = Math.min(l.qty, left);
    if (l.qty - take <= 1e-9) db.prepare('DELETE FROM stock_lots WHERE id = ?').run(l.id);
    else db.prepare('UPDATE stock_lots SET qty = ? WHERE id = ?').run(r3(l.qty - take), l.id);
    taken.push({ qty: r3(take), expires_on: l.expires_on });
    left = r3(left - take);
  }
  return taken;
}

// Đặt tồn về số thực tế khi kiểm kho. Trả về { before, diff } (diff < 0 là thiếu so với sổ).
export function setActual(db, { storeId, ingredientId, actual, at }) {
  const before = stockQty(db, storeId, ingredientId);
  const diff = r3(actual - before);
  if (diff < 0) takeLots(db, { storeId, ingredientId, qty: -diff, allowShort: true });
  if (diff > 0) addLot(db, { storeId, ingredientId, qty: diff, at });
  return { before, diff };
}

// Sổ kho đã khoá (chủ quán khoá tháng): chặn ghi / xoá phát sinh có ngày ≤ ngày khoá
export function assertOpen(db, date) {
  const lock = db.prepare("SELECT value FROM settings WHERE key = 'stock_lock_until'").get()?.value;
  if (lock && date && date <= lock) fail(409, `Sổ kho đã khoá đến ${lock.split('-').reverse().join('/')}. Muốn sửa thì chủ quán mở khoá ở Kho → Báo cáo → Nhập – Xuất – Tồn.`, 'stock_locked');
}

export function recordMove(db, { at, date, type, ingredientId, fromStore = null, toStore = null, qty, cost = 0, ref = '', staffId = null, note = '' }) {
  if (!(Math.abs(qty) > 1e-9)) return;
  assertOpen(db, date);
  db.prepare(`INSERT INTO stock_moves (at, date, type, ingredient_id, from_store, to_store, qty, cost, ref, staff_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(at, date, type, ingredientId, fromStore, toStore, r3(qty), Math.round(cost), ref, staffId, note);
}

// Giá vốn của một lượng (đơn vị dùng) theo giá nhập gần nhất
export function costOf(ing, qtyUse) {
  // Nhóm cân chung (vd thịt tươi): giá vốn bình quân của cả nhóm theo tồn kho (đồng / đơn vị dùng)
  if (ing.cost_group && ing.avg_cost > 0) return Math.round(qtyUse * ing.avg_cost);
  return Math.round((qtyUse / (ing.purchase_factor || 1)) * (ing.price || 0));
}
