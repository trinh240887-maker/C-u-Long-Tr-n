import { addDays } from './time.js';

export const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

// Dự báo lượng dùng cho ngày `target` từ lịch sử dùng thực tế.
//  usage: Map<'YYYY-MM-DD', số lượng> chỉ gồm những ngày có số liệu (đã kiểm kho / có bán).
//  Có ≥ 2 ngày cùng thứ trong 4 tuần gần nhất → lấy trung bình các ngày cùng thứ (cuối tuần bán khác ngày thường).
//  Không đủ → trung bình 14 ngày gần nhất có số liệu.
export function forecastDay(usage, target, { weeks = 4, recentDays = 14 } = {}) {
  const same = [];
  for (let k = 1; k <= weeks; k++) {
    const d = addDays(target, -7 * k);
    if (usage.has(d)) same.push(usage.get(d));
  }
  const recent = [];
  for (let k = 1; k <= recentDays; k++) {
    const d = addDays(target, -k);
    if (usage.has(d)) recent.push(usage.get(d));
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const avg = recent.length ? mean(recent) : 0;
  if (same.length >= 2) return { qty: r3(mean(same)), avg: r3(avg), basis: 'weekday', days: same.length };
  return { qty: r3(avg), avg: r3(avg), basis: recent.length ? 'recent' : 'none', days: recent.length };
}

// Làm tròn lên theo bước (vd 0.5 kg, 1 thùng)
export function roundUp(qty, step = 1) {
  if (!(qty > 1e-9)) return 0;
  const s = step > 0 ? step : 1;
  return r3(Math.ceil(r3(qty / s) - 1e-9) * s);
}

// Khu cần lĩnh thêm bao nhiêu từ kho tổng cho ngày mai (đơn vị dùng)
export function areaNeed({ forecast, safetyPct = 10, stock }) {
  return r3(Math.max(0, forecast * (1 + safetyPct / 100) - stock));
}

// Cần mua thêm bao nhiêu (đơn vị dùng), theo nhóm hàng:
//  - Đồ tươi: đặt hằng ngày = dự báo ngày mai + dự phòng − tồn còn dùng được (ít nhất đủ mức tối thiểu).
//  - Đồ mát / khô-đông: khi tồn ≤ điểm đặt hàng (dùng TB/ngày × số ngày NCC giao + tồn tối thiểu)
//    thì đặt đủ dùng thêm một chu kỳ.
export function purchaseNeed({ freshness, forecastTomorrow = 0, avgDaily = 0, leadDays = 1, cycleDays = 1, minStock = 0, safetyPct = 10, stock = 0 }) {
  const s = 1 + safetyPct / 100;
  if (freshness === 'fresh') {
    const want = Math.max(forecastTomorrow * s, minStock);
    return r3(Math.max(0, want - stock));
  }
  const reorderPoint = avgDaily * leadDays + minStock;
  if (stock > reorderPoint + 1e-9) return 0;
  return r3(Math.max(0, avgDaily * (leadDays + cycleDays) * s + minStock - stock));
}

// Đổi đơn vị dùng → đơn vị mua và làm tròn
export function toPurchaseUnits(needUse, { factor = 1, step = 1 }) {
  return roundUp(needUse / (factor > 0 ? factor : 1), step);
}
