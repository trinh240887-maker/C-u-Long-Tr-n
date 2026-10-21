import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClock, segmentMinutes, nightMinutes, addDays, weekStart, isoWeekday } from '../server/lib/time.js';
import { computeTimesheet } from '../server/lib/payroll.js';
import { suggestReplacements } from '../server/lib/replacement.js';

const clock = makeClock({ offset: '+07:00', cutoffHour: 5 });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));

test('ca qua nửa đêm: 17:00–00:30 dài 7.5 giờ', () => {
  const s = segmentMinutes('17:00', '00:30');
  assert.deepEqual(s, { start_min: 1020, end_min: 1470 });
  assert.equal(clock.toEpoch('2026-10-20', s.end_min) - clock.toEpoch('2026-10-20', s.start_min), 7.5 * 3600_000);
});

test('ngày làm việc: 1h sáng vẫn tính là hôm trước', () => {
  assert.equal(clock.businessDate(at('2026-10-21', '01:00')), '2026-10-20');
  assert.equal(clock.businessDate(at('2026-10-21', '06:00')), '2026-10-21');
});

test('giờ đêm 22h–6h', () => {
  assert.equal(nightMinutes(at('2026-10-20', '17:00'), at('2026-10-21', '00:30'), clock), 150);
  assert.equal(nightMinutes(at('2026-10-20', '09:00'), at('2026-10-20', '15:00'), clock), 0);
  assert.equal(nightMinutes(at('2026-10-21', '04:00'), at('2026-10-21', '08:00'), clock), 120);
  assert.equal(nightMinutes(at('2026-10-20', '20:00'), at('2026-10-21', '07:00'), clock), 480);
});

test('tuần bắt đầu thứ Hai', () => {
  assert.equal(isoWeekday('2026-10-25'), 7);
  assert.equal(weekStart('2026-10-25'), '2026-10-19');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('khúc ca không được quá 16 giờ, giờ sai báo lỗi', () => {
  assert.throws(() => segmentMinutes('06:00', '23:00'));
  assert.throws(() => segmentMinutes('25:00', '23:00'));
});

test('lương theo giờ có phụ cấp đêm 30%, lương theo ca đếm số ca', () => {
  const staff = [
    { id: 1, name: 'A', pay_type: 'hour', pay_rate: 25000 },
    { id: 2, name: 'B', pay_type: 'shift', pay_rate: 200000 },
  ];
  const records = [
    { staff_id: 1, date: '2026-10-20', clock_in: at('2026-10-20', '17:00'), clock_out: at('2026-10-21', '00:30'), group_key: 'g1' },
    // ca gãy: 2 khúc cùng một ca → tính 1 ca
    { staff_id: 2, date: '2026-10-20', clock_in: at('2026-10-20', '10:00'), clock_out: at('2026-10-20', '14:00'), group_key: 'g2' },
    { staff_id: 2, date: '2026-10-20', clock_in: at('2026-10-20', '17:00'), clock_out: at('2026-10-20', '22:00'), group_key: 'g2' },
    { staff_id: 2, date: '2026-10-21', clock_in: at('2026-10-21', '10:00'), clock_out: null, group_key: 'g3' },
  ];
  const [a, b] = computeTimesheet(records, staff, clock, { nightBonusPct: 30 });
  assert.equal(a.minutes, 450);
  assert.equal(a.night_minutes, 150);
  assert.equal(a.pay, Math.round(7.5 * 25000 + 2.5 * 25000 * 0.3)); // 206 250
  assert.equal(b.shifts, 1);
  assert.equal(b.pay, 200000);
  assert.equal(b.open_records, 1);
});

test('lương tháng chia theo ngày công chuẩn, 0 = trả cố định', async () => {
  const { payFor } = await import('../server/lib/payroll.js');
  assert.equal(payFor({ pay_type: 'month', pay_rate: 9_100_000, days: 13 }, 30, 26), 4_550_000);
  assert.equal(payFor({ pay_type: 'month', pay_rate: 9_000_000, days: 30 }, 30, 26), 9_000_000);
  assert.equal(payFor({ pay_type: 'month', pay_rate: 9_000_000, days: 5 }, 30, 0), 9_000_000);
});

test('gợi ý người làm thay: lọc trùng giờ, nghỉ, kỹ năng, giới hạn giờ', () => {
  const shift = { team_id: 3, ranges: [{ start: at('2026-10-24', '17:00'), end: at('2026-10-24', '23:00') }] };
  const candidates = [
    { id: 1, name: 'Lan', team_id: 3, skills: {} },               // cùng tổ, rảnh
    { id: 2, name: 'Minh', team_id: 4, skills: { 3: 2 } },        // tổ khác, biết việc
    { id: 3, name: 'Hoa', team_id: 4, skills: {} },               // chưa biết việc
    { id: 4, name: 'Tú', team_id: 3, skills: {} },                // trùng ca
    { id: 5, name: 'Vy', team_id: 3, skills: {}, weekly_limit_hours: 40 }, // gần đủ giờ
    { id: 6, name: 'Nam', team_id: 3, skills: {} },               // đang nghỉ
    { id: 9, name: 'Người xin nghỉ', team_id: 3, skills: {} },
  ];
  const busy = new Map([[4, [{ start: at('2026-10-24', '22:00'), end: at('2026-10-25', '01:00') }]]]);
  const list = suggestReplacements({
    shift, candidates, busy, onLeave: new Set([6]), weekMinutes: new Map([[5, 36 * 60], [1, 10 * 60]]), excludeId: 9,
  });
  assert.deepEqual(list.filter((x) => x.eligible).map((x) => x.name), ['Lan', 'Minh']);
  const why = Object.fromEntries(list.map((x) => [x.name, x.reasons.join('; ')]));
  assert.match(why['Hoa'], /đào tạo/);
  assert.match(why['Tú'], /Trùng giờ/);
  assert.match(why['Vy'], /40 giờ/);
  assert.match(why['Nam'], /nghỉ/);
  assert.ok(!list.some((x) => x.staff_id === 9));
});
