import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTimesheet } from '../server/lib/payroll.js';
import { makeClock } from '../server/lib/time.js';

const clock = makeClock({ offset: '+07:00' });
const at = (d, h) => clock.toEpoch(d, h * 60);

test('lương tháng: nghỉ 2 ngày vẫn đủ lương; mỗi ngày quá 8 giờ → vượt giờ × 1,5', () => {
  const staff = [{ id: 1, name: 'Bếp A', pay_type: 'month', pay_rate: 7_000_000 }, { id: 2, name: 'PV giờ', pay_type: 'hour', pay_rate: 23_000 }];
  const recs = [];
  // Bếp A: tháng 10 (31 ngày) làm 29 ngày, ca gãy 8–12 + 14–23 = 13 giờ
  for (let d = 1; d <= 29; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    recs.push({ staff_id: 1, date, clock_in: at(date, 8), clock_out: at(date, 12) }, { staff_id: 1, date, clock_in: at(date, 14), clock_out: at(date, 23) });
  }
  // PV giờ: 1 ngày 10 giờ
  recs.push({ staff_id: 2, date: '2026-10-05', clock_in: at('2026-10-05', 13), clock_out: at('2026-10-05', 23) });
  const rows = computeTimesheet(recs, staff, clock, { nightBonusPct: 0, monthStandardDays: 29, otDailyHours: 8, otRate: 1.5 });
  const a = rows.find((r) => r.staff_id === 1);
  assert.equal(a.base_pay, 7_000_000);
  assert.equal(a.ot_minutes, 29 * 5 * 60);
  assert.equal(a.ot_pay, Math.round(145 * (7_000_000 / (29 * 8)) * 1.5));
  assert.equal(a.pay, a.base_pay + a.ot_pay);
  const b = rows.find((r) => r.staff_id === 2);
  assert.equal(b.ot_minutes, 120);
  assert.equal(b.pay, 10 * 23_000 + Math.round(2 * 23_000 * 0.5));
  // Nghỉ thêm: chỉ làm 27 ngày → 27/29 lương
  const rows2 = computeTimesheet(recs.filter((r) => r.staff_id !== 1 || Number(r.date.slice(8)) <= 27), staff, clock, { nightBonusPct: 0, monthStandardDays: 29, otDailyHours: 8, otRate: 1.5 });
  assert.equal(rows2.find((r) => r.staff_id === 1).base_pay, Math.round(7_000_000 * 27 / 29));
  // Nghỉ theo ca: 29 ngày làm đủ + bỏ ca sáng 2 ngày (mỗi ngày ca gãy 2 khúc) → nghỉ 2 + 1 = 3 ngày… chỉ làm 28 ngày đủ + 2 ngày nửa = 29 công → đủ lương
  const half = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    if (d > 28) { half.push({ staff_id: 1, date, clock_in: at(date, 14), clock_out: at(date, 23), seg_n: 2 }); continue; }
    half.push({ staff_id: 1, date, clock_in: at(date, 8), clock_out: at(date, 12), seg_n: 2 }, { staff_id: 1, date, clock_in: at(date, 14), clock_out: at(date, 23), seg_n: 2 });
  }
  const rh = computeTimesheet(half, [staff[0]], clock, { nightBonusPct: 0, monthStandardDays: 29, otDailyHours: 8, otRate: 1 })[0];
  assert.equal(rh.days, 29); // 28 + 0,5 + 0,5 = 29 công (nghỉ 1 ngày + 2 nửa ngày = 2 ngày)
  assert.equal(rh.base_pay, 7_000_000);
  // Không áp quy tắc bếp (vd phục vụ lương tháng): ngày công ÷ 26 cũ, không vượt giờ
  const rows3 = computeTimesheet(recs.filter((r) => r.staff_id === 1), [{ ...staff[0], rule: false }], clock, { nightBonusPct: 0, monthStandardDays: 26, ruleStandardDays: 29, otDailyHours: 8, otRate: 1 });
  assert.equal(rows3[0].ot_minutes, 0);
  assert.equal(rows3[0].pay, 7_000_000);
});
