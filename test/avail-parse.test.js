import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAvailMessage } from '../server/lib/avail-parse.js';

const staff = ['Trần Nguyễn Trường Giang', 'Cẩm Tú', 'Trần Kim'].map((name, i) => ({ id: i + 1, name }));
const read = (t) => {
  const r = parseAvailMessage(t, { staff, today: '2026-10-25', sender: null });
  return { who: r.people.map((p) => p.name), picks: Object.fromEntries(Object.entries(r.picks).sort().map(([d, x]) => [d.slice(5), x.join('+')])), off: r.off.map((d) => d.slice(5)) };
};

test('đọc tin báo lịch: khoảng ngày 26/10-30/10 không bị hiểu nhầm là giờ', () => {
  const a = read('@Bot Cửu Long Trấn Trường Giang : 26/10-30/11: 14:00-17:00\n31/10-1/11: 14:00-23:00');
  assert.deepEqual(a.who, ['Trần Nguyễn Trường Giang']);
  assert.deepEqual(a.picks, { '10-26': '14:00-17:00', '10-27': '14:00-17:00', '10-28': '14:00-17:00', '10-29': '14:00-17:00', '10-30': '14:00-17:00', '10-31': '14:00-23:00', '11-01': '14:00-23:00' });
  assert.deepEqual(read('Cẩm Tú 26-30/10 14-23, 31/10 nghỉ').off, ['10-31']);
  assert.deepEqual(Object.keys(read('Cẩm Tú 27/10 - 29/10 10h-14h').picks), ['10-27', '10-28', '10-29']);
  assert.deepEqual(read('Trần kim(thu ngân)\n26/10\n14h-23h').picks, { '10-26': '14:00-23:00' });
});

test('đọc tin báo lịch: "nghỉ" từng ngày thắng khoảng T3-T6; "14h,23h" hiểu là 14h-23h', () => {
  const a = read('@Bot Cửu Long Trấn  Cẩm Tú T2 nghỉ , T4 nghỉ , T5 nghỉ , T3-T6: 14h-23h , T6: 14h-23h , T7: 14h-23h , CN: 14h,23h');
  assert.deepEqual(a.who, ['Cẩm Tú']);
  assert.deepEqual(a.off, ['10-26', '10-28', '10-29']);
  assert.deepEqual(a.picks, { '10-27': '14:00-23:00', '10-30': '14:00-23:00', '10-31': '14:00-23:00', '11-01': '14:00-23:00' });
  // Ca gãy vẫn đúng
  assert.deepEqual(read('Cẩm Tú T2 10h-14h, 17h-22h').picks, { '10-26': '10:00-14:00+17:00-22:00' });
});
