import { nightMinutes, MIN } from './time.js';

// Bảng công & lương tạm tính.
//  records: [{ staff_id, date, clock_in, clock_out, group_key }]  (bản ghi chấm công đã đóng)
//  staff:   [{ id, name, pay_type: 'hour' | 'shift', pay_rate }]
//  options: { nightBonusPct } phụ cấp làm đêm (22h–6h) tính thêm trên lương giờ
// otDailyHours > 0: mỗi ngày làm quá số giờ này → phần dư là vượt giờ, tính × otRate (chủ quán 27/10: chuẩn 8 giờ, × 1,5)
export function computeTimesheet(records, staff, clock, { nightBonusPct = 30, monthStandardDays = 26, otDailyHours = 0, otRate = 1.5 } = {}) {
  const rows = new Map(staff.map((s) => [s.id, {
    staff_id: s.id, name: s.name, pay_type: s.pay_type, pay_rate: s.pay_rate,
    minutes: 0, night_minutes: 0, shifts: 0, days: 0, pay: 0, open_records: 0, ot_minutes: 0, ot_pay: 0, base_pay: 0,
  }]));
  const dayMin = new Map();
  const shiftKeys = new Map();
  const dayKeys = new Map();
  for (const r of records) {
    const row = rows.get(r.staff_id);
    if (!row) continue;
    if (!r.clock_out) { row.open_records++; continue; }
    const minutes = Math.max(0, Math.round((r.clock_out - r.clock_in) / MIN));
    row.minutes += minutes;
    row.night_minutes += nightMinutes(r.clock_in, r.clock_out, clock);
    const sk = shiftKeys.get(r.staff_id) || new Set();
    sk.add(r.group_key || `${r.date}`);
    shiftKeys.set(r.staff_id, sk);
    const kk = `${r.staff_id}|${r.date}`;
    dayMin.set(kk, (dayMin.get(kk) || 0) + minutes);
    const dk = dayKeys.get(r.staff_id) || new Set();
    dk.add(r.date);
    dayKeys.set(r.staff_id, dk);
  }
  for (const row of rows.values()) {
    row.shifts = shiftKeys.get(row.staff_id)?.size || 0;
    row.days = dayKeys.get(row.staff_id)?.size || 0;
    if (otDailyHours > 0) for (const [k, m] of dayMin) if (k.startsWith(`${row.staff_id}|`)) row.ot_minutes += Math.max(0, m - otDailyHours * 60);
    row.pay = payFor(row, nightBonusPct, monthStandardDays, { otDailyHours, otRate });
  }
  return [...rows.values()];
}

// Lương tháng: = lương tháng × số ngày công / ngày công chuẩn (tối đa đủ 1 tháng). Ngày công chuẩn = 0 → trả đủ lương cố định.
// Vượt giờ: lương tháng → giá 1 giờ = lương ÷ (ngày chuẩn × giờ chuẩn), trả × otRate; lương giờ → giờ dư đã có 1×, cộng thêm (otRate − 1)×. Lương ca: không tính vượt giờ.
export function payFor(row, nightBonusPct = 30, monthStandardDays = 26, { otDailyHours = 0, otRate = 1.5 } = {}) {
  const rate = Number(row.pay_rate) || 0;
  const ot = (row.ot_minutes || 0) / 60;
  let base = 0, otPay = 0;
  if (row.pay_type === 'month') {
    base = monthStandardDays > 0 ? rate * Math.min(1, row.days / monthStandardDays) : rate;
    if (ot && otDailyHours > 0 && monthStandardDays > 0) otPay = ot * (rate / (monthStandardDays * otDailyHours)) * otRate;
  } else if (row.pay_type === 'shift') base = row.shifts * rate;
  else {
    base = (row.minutes / 60) * rate + (row.night_minutes / 60) * rate * (nightBonusPct / 100);
    if (ot) otPay = ot * rate * Math.max(0, otRate - 1);
  }
  row.base_pay = Math.round(base); row.ot_pay = Math.round(otPay);
  return Math.round(base + otPay);
}
