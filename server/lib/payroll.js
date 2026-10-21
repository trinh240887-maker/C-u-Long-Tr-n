import { nightMinutes, MIN } from './time.js';

// Bảng công & lương tạm tính.
//  records: [{ staff_id, date, clock_in, clock_out, group_key }]  (bản ghi chấm công đã đóng)
//  staff:   [{ id, name, pay_type: 'hour' | 'shift', pay_rate }]
//  options: { nightBonusPct } phụ cấp làm đêm (22h–6h) tính thêm trên lương giờ
export function computeTimesheet(records, staff, clock, { nightBonusPct = 30, monthStandardDays = 26 } = {}) {
  const rows = new Map(staff.map((s) => [s.id, {
    staff_id: s.id, name: s.name, pay_type: s.pay_type, pay_rate: s.pay_rate,
    minutes: 0, night_minutes: 0, shifts: 0, days: 0, pay: 0, open_records: 0,
  }]));
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
    const dk = dayKeys.get(r.staff_id) || new Set();
    dk.add(r.date);
    dayKeys.set(r.staff_id, dk);
  }
  for (const row of rows.values()) {
    row.shifts = shiftKeys.get(row.staff_id)?.size || 0;
    row.days = dayKeys.get(row.staff_id)?.size || 0;
    row.pay = payFor(row, nightBonusPct, monthStandardDays);
  }
  return [...rows.values()];
}

// Lương tháng: = lương tháng × số ngày công / ngày công chuẩn (tối đa đủ 1 tháng). Ngày công chuẩn = 0 → trả đủ lương cố định.
export function payFor(row, nightBonusPct = 30, monthStandardDays = 26) {
  const rate = Number(row.pay_rate) || 0;
  if (row.pay_type === 'month') return monthStandardDays > 0 ? Math.round(rate * Math.min(1, row.days / monthStandardDays)) : Math.round(rate);
  if (row.pay_type === 'shift') return Math.round(row.shifts * rate);
  const base = (row.minutes / 60) * rate;
  const night = (row.night_minutes / 60) * rate * (nightBonusPct / 100);
  return Math.round(base + night);
}
