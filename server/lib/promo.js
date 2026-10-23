// Bộ tính khuyến mãi: chỉ đổi TIỀN trên bill, không đổi món, không đổi phiếu bếp.
// Loại: bogo (mua X tặng Y cùng loại) · gift (mua món A tặng món B) · percent / amount (giảm món) · bill_percent / bill_amount (giảm cả bill).
//  - Mua X tặng Y: pair 'same' = tặng đúng món đã mua (mua 1 Combo 3 tặng 1 Combo 3); 'cheapest' = gom các món trong phạm vi, tặng phần rẻ nhất.
//  - Mua A tặng B: mỗi X phần món A (phạm vi) được Y phần món B (gift_item_ids, khách chọn 1 trong các món này) miễn phí.
//    Phục vụ bấm "Thêm món tặng" để món B ra bếp; app tự giảm tiền, chỉ giảm tối đa số phần được tặng.
// Quy tắc:
//  - Mỗi dòng món chỉ hưởng 1 chương trình giảm món (chương trình có lợi cho khách nhất).
//  - Mua X tặng Y: gom các phần cùng chương trình, xếp giá cao → thấp, mỗi nhóm X+Y thì Y phần rẻ nhất được tặng.
//  - Giảm bill: lấy 1 chương trình có lợi nhất; mặc định không giảm chồng lên món đã khuyến mãi (trừ khi bật "cộng dồn").
//  - Giờ áp dụng tính theo lúc gọi món (giảm món) / lúc mở bàn (giảm bill).
export const TYPES = {
  bogo: 'Mua X tặng Y', gift: 'Mua món A tặng món B', percent: 'Giảm % món', amount: 'Giảm tiền món', bill_percent: 'Giảm % cả bill', bill_amount: 'Giảm tiền cả bill',
};
export const isBill = (p) => p.type === 'bill_percent' || p.type === 'bill_amount';
const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
// Tiền giảm làm tròn tới 1.000đ (lên, có lợi cho khách) để bill luôn chẵn nghìn, thối tiền mặt được
export const round1k = (n) => Math.ceil(n / 1000) * 1000;
const vnd = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;

// Chương trình có hiệu lực tại thời điểm ms không
export function validAt(p, ms, clock) {
  if (!p.active) return false;
  const date = clock.dateOf(ms);
  if (date < p.start_date || date > p.end_date) return false;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = CN
  if (p.days && !String(p.days).includes(String(dow === 0 ? 7 : dow))) return false;
  if (p.time_from != null && p.time_to != null && p.time_from !== p.time_to) {
    const m = clock.minuteOf(ms);
    const inside = p.time_from < p.time_to ? m >= p.time_from && m < p.time_to : m >= p.time_from || m < p.time_to;
    if (!inside) return false;
  }
  return true;
}

export function status(p, ms, clock) {
  const today = clock.dateOf(ms);
  if (!p.active) return 'off';
  if (today > p.end_date) return 'ended';
  if (today < p.start_date) return 'upcoming';
  return 'running';
}

export const matches = (p, item) => {
  if (isBill(p)) return false;
  if (p.scope === 'items') return p.item_ids.includes(item.menu_item_id);
  if (p.scope === 'categories') return p.category_ids.includes(item.category_id);
  return true;
};

// Mô tả ngắn cho nhân viên đọc, vd "Mua 1 tặng 1 · Trà đào, Trà vải · 22/10–31/10 · 14:00–17:00"
export function describe(p, names = {}) {
  const giftNames = (p.gift_item_ids || []).map((id) => names.items?.[id]).filter(Boolean).join(' / ') || '(chưa chọn món tặng)';
  const what = p.type === 'bogo' ? `Mua ${p.buy_qty} tặng ${p.get_qty}${p.pair === 'same' ? ' cùng món' : ''}`
    : p.type === 'gift' ? `Mua ${p.buy_qty} tặng ${p.get_qty} ${giftNames}`
    : p.type === 'percent' ? `Giảm ${p.value}%`
    : p.type === 'amount' ? `Giảm ${vnd(p.value)}/phần`
    : p.type === 'bill_percent' ? `Giảm ${p.value}% bill` : `Giảm ${vnd(p.value)} bill`;
  const scope = isBill(p) ? (p.min_bill ? `bill từ ${vnd(p.min_bill)}` : 'mọi bill')
    : p.scope === 'items' ? p.item_ids.map((id) => names.items?.[id]).filter(Boolean).join(', ') || '(chưa chọn món)'
    : p.scope === 'categories' ? `nhóm ${p.category_ids.map((id) => names.categories?.[id]).filter(Boolean).join(', ')}` : 'mọi món';
  const days = p.days && p.days !== '1234567' ? [...String(p.days)].map((d) => DOW[Number(d) % 7]).join(' ') : '';
  const time = p.time_from != null && p.time_to != null && p.time_from !== p.time_to ? `${hm(p.time_from)}–${hm(p.time_to)}` : '';
  return [what, scope, p.start_date === p.end_date ? dm(p.start_date) : `${dm(p.start_date)}–${dm(p.end_date)}`, days, time].filter(Boolean).join(' · ');
}

// Nhãn gắn trên món ở màn gọi món
export const tag = (p, names = {}) => (p.type === 'bogo' ? `Mua ${p.buy_qty} tặng ${p.get_qty}` : p.type === 'gift' ? `Tặng ${(p.gift_item_ids || []).map((id) => names.items?.[id]).filter(Boolean)[0] || 'món'}` : p.type === 'percent' ? `-${p.value}%` : `-${vnd(p.value)}`);

// Tỉ lệ được giảm ước tính, để chọn chương trình có lợi nhất cho 1 dòng món
const rate = (p, unit) => (p.type === 'gift' ? 0 : p.type === 'bogo' ? p.get_qty / (p.buy_qty + p.get_qty) : p.type === 'percent' ? p.value / 100 : unit ? Math.min(1, p.value / unit) : 0);

/**
 * items: [{id, menu_item_id, category_id, unit_price, qty, created_at}] (món chưa huỷ)
 * Trả về { lines: Map(itemId → [{promo_id, name, amount, free_qty}]), item_discount, bill: [{promo_id, name, amount}], discount, subtotal, total }
 */
export function applyPromos(items, promos, { clock, openedAt }) {
  const subtotal = items.reduce((n, i) => n + i.unit_price * i.qty, 0);
  const lines = new Map();
  const push = (id, x) => { if (!lines.has(id)) lines.set(id, []); lines.get(id).push(x); };
  let itemDiscount = 0;
  // 0. Mua A tặng B: dòng món tặng được giảm trước, không hưởng chương trình khác
  const giftLine = new Set();
  const gifts = [];
  for (const p of promos.filter((x) => x.type === 'gift')) {
    const buyUnits = items.filter((it) => !giftLine.has(it.id) && !(p.gift_item_ids || []).includes(it.menu_item_id) && matches(p, it) && validAt(p, it.created_at, clock)).reduce((n, it) => n + it.qty, 0);
    const allow = Math.floor(buyUnits / p.buy_qty) * p.get_qty;
    const cands = items.filter((it) => !giftLine.has(it.id) && (p.gift_item_ids || []).includes(it.menu_item_id) && validAt(p, it.created_at, clock))
      .sort((a, b) => b.unit_price - a.unit_price || a.id - b.id);
    let left = allow;
    for (const it of cands) {
      if (left <= 0) break;
      const q = Math.min(left, it.qty);
      push(it.id, { promo_id: p.id, name: p.name, amount: q * it.unit_price, free_qty: q, gift: true });
      itemDiscount += q * it.unit_price;
      giftLine.add(it.id);
      left -= q;
    }
    if (allow) gifts.push({ promo_id: p.id, name: p.name, allow, used: allow - left, left, gift_item_ids: p.gift_item_ids || [] });
  }
  // 1. Mỗi dòng chọn 1 chương trình giảm món tốt nhất
  const groups = new Map();
  for (const it of items) {
    if (giftLine.has(it.id)) continue;
    const cands = promos.filter((p) => !isBill(p) && p.type !== 'gift' && matches(p, it) && validAt(p, it.created_at, clock));
    if (!cands.length) continue;
    const best = cands.reduce((a, b) => (rate(b, it.unit_price) > rate(a, it.unit_price) ? b : a));
    if (!groups.has(best.id)) groups.set(best.id, { p: best, items: [] });
    groups.get(best.id).items.push(it);
  }
  for (const { p, items: its } of groups.values()) {
    if (p.type === 'bogo') {
      // Tặng cùng món: chia nhóm theo từng món; không thì gom cả phạm vi
      const parts = p.pair === 'same' ? [...its.reduce((m, it) => m.set(it.menu_item_id, [...(m.get(it.menu_item_id) || []), it]), new Map()).values()] : [its];
      for (const part of parts) {
      const units = part.flatMap((it) => Array.from({ length: it.qty }, () => it)).sort((a, b) => b.unit_price - a.unit_price || a.id - b.id);
      const n = p.buy_qty + p.get_qty;
      const free = new Map();
      for (let g = 0; g + n <= units.length; g += n) {
        for (let k = g + p.buy_qty; k < g + n; k++) free.set(units[k].id, (free.get(units[k].id) || 0) + 1);
      }
      for (const it of part) {
        const q = free.get(it.id) || 0;
        if (q) { push(it.id, { promo_id: p.id, name: p.name, amount: q * it.unit_price, free_qty: q }); itemDiscount += q * it.unit_price; }
      }
      }
    } else {
      for (const it of its) {
        const amount = p.type === 'percent' ? Math.min(it.unit_price * it.qty, round1k((it.unit_price * it.qty * p.value) / 100)) : Math.min(it.unit_price, p.value) * it.qty;
        if (amount > 0) { push(it.id, { promo_id: p.id, name: p.name, amount }); itemDiscount += amount; }
      }
    }
  }
  // 2. Giảm bill: 1 chương trình có lợi nhất
  const after = subtotal - itemDiscount;
  const plain = items.filter((i) => !lines.has(i.id)).reduce((n, i) => n + i.unit_price * i.qty, 0);
  let bill = null;
  for (const p of promos.filter((x) => isBill(x) && validAt(x, openedAt, clock))) {
    if (p.min_bill && after < p.min_bill) continue;
    const base = p.stack ? after : plain;
    const amount = Math.min(base, p.type === 'bill_percent' ? round1k((base * p.value) / 100) : p.value);
    if (amount > 0 && (!bill || amount > bill.amount)) bill = { promo_id: p.id, name: p.name, amount };
  }
  const discount = itemDiscount + (bill?.amount || 0);
  return { lines, item_discount: itemDiscount, bill: bill ? [bill] : [], discount, subtotal, total: subtotal - discount, gifts };
}
