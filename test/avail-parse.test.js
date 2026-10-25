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

test('đọc tin báo lịch: "T2-T4-T5 nghỉ" là liệt kê, không phải khoảng', () => {
  const a = read('@Bot Cửu Long Trấn Cẩm Tú T3 T6 T7 CN (18h-23h) : T2-T4-T5 nghỉ');
  assert.deepEqual(a.off, ['10-26', '10-28', '10-29']);
  assert.deepEqual(a.picks, { '10-27': '18:00-23:00', '10-30': '18:00-23:00', '10-31': '18:00-23:00', '11-01': '18:00-23:00' });
  assert.deepEqual(Object.keys(read('Trần Kim T2-T6 14-23, T7 CN 10-22').picks).length, 7);
});

test('đọc tin báo lịch: "Trần Trung Hậu" không bị nhận nhầm là "Phước Hậu" (chỉ trùng chữ cuối)', () => {
  const st = [{ id: 1, name: 'Phước Hậu' }, { id: 2, name: 'Cẩm Tú' }];
  const r = parseAvailMessage('@Bot Cửu Long Trấn Trần trung hậu 8h - 12h , 14h - 23h', { staff: st, today: '2026-10-25', sender: null });
  assert.deepEqual(r.people, []);
  assert.ok(r.unknownName);
  // Chỉ ghi 1 chữ "Tú" thì vẫn hiểu là Cẩm Tú
  assert.deepEqual(parseAvailMessage('@Bot Tú 14-23', { staff: st, today: '2026-10-25', sender: null }).people.map((x) => x.name), ['Cẩm Tú']);
});

test('đọc tin báo lịch: khác họ ("Phan Thành Phát" ↔ Lê Thành Phát) không đoán, gợi ý người gần giống; ghi thiếu họ vẫn nhận', () => {
  const st = [{ id: 1, name: 'Lê Thành Phát' }, { id: 2, name: 'Nguyễn Hồng Phúc' }];
  const r = parseAvailMessage('@Bot Cửu Long Trấn Phan Thành Phát T2-CN (14-23h)', { staff: st, today: '2026-10-25', sender: null });
  assert.deepEqual(r.people, []);
  assert.deepEqual(r.near.map((x) => x.name), ['Lê Thành Phát']);
  assert.equal(parseAvailMessage('@Bot Thành Phát T2-CN 14-23', { staff: st, today: '2026-10-25', sender: null }).people[0]?.name, 'Lê Thành Phát');
  assert.equal(parseAvailMessage('@Bot Lê Thành Phát T2-CN 14-23', { staff: st, today: '2026-10-25', sender: null }).people[0]?.name, 'Lê Thành Phát');
  assert.equal(parseAvailMessage('Hồng Phúc 14-23 làm được', { staff: st, today: '2026-10-25', sender: null }).people[0]?.name, 'Nguyễn Hồng Phúc');
});

test('đọc tin báo lịch: "Nguyễn Trường Giang" chọn đúng người tên đó, không nhầm "Trần Nguyễn Trường Giang"; mơ hồ thì không đoán', async () => {
  const { parseNewStaff, findStaff } = await import('../server/lib/avail-parse.js');
  const st = [{ id: 1, name: 'Trần Nguyễn Trường Giang' }, { id: 2, name: 'Nguyễn Trường Giang' }];
  assert.deepEqual(findStaff('@Bot nguyễn trường giang (T2-CN) 14h-23h', st).map((x) => x.id), [2]);
  assert.deepEqual(findStaff('Trần Nguyễn Trường Giang 14-23', st).map((x) => x.id), [1]);
  assert.deepEqual(findStaff('Trường Giang 14-23', st).map((x) => x.id), []); // 2 người cùng "Trường Giang" → hỏi lại
  // Tên đăng ký dính chữ chức vụ
  assert.equal(parseNewStaff('@bot NV mới: Nguyễn Trường Giang Nhân Viên, 0901234567, Phục vụ').name, 'Nguyễn Trường Giang');
  assert.equal(parseNewStaff('@bot NV mới: Lê Văn Tèo tổ trưởng, 0901234568').role, 'team_lead');
});
