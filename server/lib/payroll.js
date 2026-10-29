import { nightMinutes, MIN } from './time.js';

// Bảng công & lương tạm tính.
//  records: [{ staff_id, date, clock_in, clock_out, group_key }]  (bản ghi chấm công đã đóng)
//  staff:   [{ id, name, pay_type: 'hour' | 'shift', pay_rate }]
//  options: { nightBonusPct } phụ cấp làm đêm (22h–6h) tính thêm trên lương giờ
// otDailyHours > 0: mỗi ngày làm quá số giờ này → phần dư là vượt giờ, tính × otRate (chủ quán 27/10: chuẩn 8 giờ, × 1,5)
export function computeTimesheet(records, staff, clock, { nightBonusPct = 30, monthStandardDays = 26, otDailyHours = 0, otRate = 1.5, ruleStandardDays = null, otRoundMinutes = 30, adjust = new Map(), hoursPerDay = 8, otHourDays = 0, otHourHours = 0 } = {}) {
  const rows = new Map(staff.map((s) => [s.id, {
    staff_id: s.id, name: s.name, pay_type: s.pay_type, pay_rate: s.pay_rate, rule: s.rule !== false,
    minutes: 0, night_minutes: 0, shifts: 0, days: 0, pay: 0, open_records: 0, ot_minutes: 0, ot_pay: 0, base_pay: 0,
  }]));
  const dayMin = new Map();
  const dayCredit = new Map();
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
    // Công theo ca (chủ quán 27/10): ca gãy 2 khúc → mỗi khúc 0,5 ngày; bỏ 1 khúc = nghỉ nửa ngày
    dayCredit.set(kk, Math.min(1, (dayCredit.get(kk) || 0) + (r.seg_n > 1 ? 1 / r.seg_n : 1)));
    const dk = dayKeys.get(r.staff_id) || new Set();
    dk.add(r.date);
    dayKeys.set(r.staff_id, dk);
  }
  for (const row of rows.values()) {
    row.shifts = shiftKeys.get(row.staff_id)?.size || 0;
    row.days = dayKeys.get(row.staff_id)?.size || 0;
    // Quy tắc bếp (s.rule): nghỉ vài ngày vẫn đủ lương (ruleStandardDays) + vượt giờ; người khác: ngày công chuẩn cũ, không vượt giờ
    const useRule = row.rule;
    if (useRule) { let c = 0; for (const [k, v0] of dayCredit) if (k.startsWith(`${row.staff_id}|`)) c += v0; row.days = Math.round(c * 100) / 100; }
    if (useRule && otDailyHours > 0) for (const [k, m] of dayMin) if (k.startsWith(`${row.staff_id}|`)) { const extra = Math.max(0, m - otDailyHours * 60); row.ot_minutes += otRoundMinutes > 1 ? Math.floor(extra / otRoundMinutes) * otRoundMinutes : extra; } // chủ quán 27/10: dư lẻ dưới 30 phút không tính
    const std = useRule && ruleStandardDays ? ruleStandardDays : monthStandardDays;
    // Chủ quán ghi tay số giờ vượt cho người này (thay số tự tính)
    const adj = adjust.get(row.staff_id);
    if (adj && adj.ot_minutes != null) { row.ot_minutes = adj.ot_minutes; row.ot_manual = true; }
    row.ot_note = adj?.note || '';
    row.std_days = std;
    row.pay = payFor(row, nightBonusPct, std, { otDailyHours: useRule ? otDailyHours : 0, otRate, hoursPerDay: otDailyHours || hoursPerDay, otHourDays, otHourHours });
    if (row.pay_type === 'month' && std > 0) { row.day_price = Math.round(row.pay_rate / std / 1000) * 1000; row.hour_price = Math.round(row.pay_rate / ((otHourDays || std) * (otHourHours || otDailyHours || hoursPerDay)) / 1000) * 1000; }
  }
  return [...rows.values()];
}

// Lương tháng: = lương tháng × số ngày công / ngày công chuẩn (tối đa đủ 1 tháng). Ngày công chuẩn = 0 → trả đủ lương cố định.
// Vượt giờ: lương tháng → giá 1 giờ = lương ÷ (ngày chuẩn × giờ chuẩn), trả × otRate; lương giờ → giờ dư đã có 1×, cộng thêm (otRate − 1)×. Lương ca: không tính vượt giờ.
export function payFor(row, nightBonusPct = 30, monthStandardDays = 26, { otDailyHours = 0, otRate = 1.5, hoursPerDay = 8, otHourDays = 0, otHourHours = 0 } = {}) {
  const rate = Number(row.pay_rate) || 0;
  const ot = (row.ot_minutes || 0) / 60;
  let base = 0, otPay = 0;
  if (row.pay_type === 'month') {
    base = monthStandardDays > 0 ? rate * Math.min(1, row.days / monthStandardDays) : rate;
    // Giá 1 giờ làm thêm: lương ÷ (số ngày chia, vd 30) ÷ (số giờ chia, vd 8); chưa đặt thì theo ngày công chuẩn × giờ chuẩn như cũ
    if (ot && monthStandardDays > 0) otPay = ot * (rate / ((otHourDays || monthStandardDays) * (otHourHours || otDailyHours || hoursPerDay))) * otRate;
  } else if (row.pay_type === 'shift') base = row.shifts * rate;
  else {
    base = (row.minutes / 60) * rate + (row.night_minutes / 60) * rate * (nightBonusPct / 100);
    // Tự tính: giờ dư đã trả theo giờ → chỉ cộng phần chênh hệ số; ghi tay: giờ làm thêm ngoài chấm công → trả đủ
    if (ot) otPay = row.ot_manual ? ot * rate * otRate : ot * rate * Math.max(0, otRate - 1);
  }
  // Làm tròn đến 1.000đ (chủ quán 27/10: không để số lẻ)
  const k = (n) => Math.round(n / 1000) * 1000;
  row.base_pay = k(base); row.ot_pay = k(otPay);
  return row.base_pay + row.ot_pay;
}
