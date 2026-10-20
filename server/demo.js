// DỮ LIỆU MẪU để chạy thử: nhân viên mẫu, loại ca mẫu, lịch tuần hiện tại.
// Dùng chung cho `npm run demo` và bản chạy thử trên web.
import crypto from 'node:crypto';
import { pinLookup, tx } from './db.js';
import { makeClock, weekStart, addDays, segmentMinutes, isoWeekday } from './lib/time.js';
import { addLot, recordMove } from './lib/stock.js';

export const DEMO_PEOPLE = [
  // tên, vai trò, tổ, PIN, lương, kiểu lương, kỹ năng phụ
  ['Hùng (mẫu)', 'manager', null, '736251', 9_000_000, 'shift', []],
  ['Phương (mẫu)', 'shift_lead', 'Phục vụ', '640512', 32000, 'hour', [['Thu ngân', 3]]],
  ['Tài (mẫu)', 'team_lead', 'Bếp steak', '5821', 35000, 'hour', [['Lẩu', 2]]],
  ['Khoa (mẫu)', 'staff', 'Bếp steak', '5822', 28000, 'hour', []],
  ['Dũng (mẫu)', 'team_lead', 'Lẩu', '5823', 32000, 'hour', [['Bếp steak', 1]]],
  ['Nga (mẫu)', 'staff', 'Lẩu', '5824', 26000, 'hour', []],
  ['Tú (mẫu)', 'team_lead', 'Bar', '5825', 30000, 'hour', []],
  ['Lan (mẫu)', 'staff', 'Bar', '5826', 25000, 'hour', [['Phục vụ', 2]]],
  ['Minh (mẫu)', 'staff', 'Phục vụ', '5827', 24000, 'hour', [['Bar', 2]]],
  ['Thảo (mẫu)', 'staff', 'Phục vụ', '5828', 24000, 'hour', []],
  ['Quân (mẫu)', 'staff', 'Phục vụ', '5829', 24000, 'hour', []],
  ['Vy (mẫu)', 'staff', 'Phục vụ', '5830', 24000, 'hour', [['Thu ngân', 1]]],
  ['Hà (mẫu)', 'staff', 'Thu ngân', '5831', 27000, 'hour', [['Phục vụ', 2]]],
  ['Bảy (mẫu)', 'staff', 'Tạp vụ', '5832', 22000, 'hour', []],
];

const TEMPLATES = [
  ['Sáng (mẫu)', '#0e7490', [['09:00', '15:00']]],
  ['Tối (mẫu)', '#9a3412', [['15:00', '23:00']]],
  ['Ca gãy (mẫu)', '#7c3aed', [['10:00', '14:00'], ['17:00', '22:00']]],
  ['Ca đóng (mẫu)', '#be123c', [['17:00', '00:30']]],
];

export function hasOtherStaff(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role != 'owner'").get().n > 0;
}

export function loadDemoData(db, { now = Date.now(), weeks = 1 } = {}) {
  const team = Object.fromEntries(db.prepare('SELECT id, name FROM teams').all().map((t) => [t.name, t.id]));
  const clock = makeClock({ offset: '+07:00' });
  const monday = weekStart(clock.businessDate(now));
  tx(db, () => {
    const tplIds = TEMPLATES.map(([name, color, segs]) => Number(db.prepare('INSERT INTO shift_templates (name, color, segments) VALUES (?, ?, ?)')
      .run(name, color, JSON.stringify(segs.map(([start, end]) => ({ start, end })))).lastInsertRowid));
    const ids = DEMO_PEOPLE.map(([name, role, t, pin, rate, type, skills], i) => {
      const id = Number(db.prepare(`INSERT INTO staff (name, phone, role, team_id, pin_lookup, pay_type, pay_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(name, `09${String(12345670 + i * 7919).slice(0, 8)}`, role, t ? team[t] : null, pinLookup(db, pin), type, rate, now).lastInsertRowid);
      for (const [k, level] of skills) db.prepare('INSERT INTO staff_skills (staff_id, team_id, level) VALUES (?, ?, ?)').run(id, team[k], level);
      return id;
    });
    // Lịch: xoay vòng các loại ca, mỗi người nghỉ 2 ngày/tuần
    const add = db.prepare(`INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, template_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    DEMO_PEOPLE.forEach(([, role, t], i) => {
      if (role === 'manager') return;
      for (let d = 0; d < 7 * weeks; d++) {
        if ((i + d) % 7 === 0 || (i + d) % 7 === 3) continue;
        const ti = (i + d) % TEMPLATES.length;
        const [label, , segs] = TEMPLATES[ti];
        const g = crypto.randomBytes(8).toString('hex');
        for (const [s, e] of segs) {
          const m = segmentMinutes(s, e);
          add.run(g, ids[i], t ? team[t] : null, addDays(monday, d), m.start_min, m.end_min, tplIds[ti], label, now);
        }
      }
    });
    // Checklist mẫu riêng cho ca sáng / ca tối của tổ Phục vụ
    const addTpl = db.prepare('INSERT INTO checklist_templates (team_id, phase, title, shift_template_id, sort) VALUES (?, ?, ?, ?, 50)');
    const addItem = db.prepare('INSERT INTO checklist_items (template_id, text, kind, unit, required, sort) VALUES (?, ?, ?, ?, 1, ?)');
    const lists = [
      [tplIds[0], 'open', 'Mở ca sáng phục vụ (mẫu)', ['Mở cửa, bật đèn, điều hoà', 'Lau bàn khu được phân', 'Kiểm tra nhà vệ sinh']],
      [tplIds[1], 'open', 'Nhận ca tối phục vụ (mẫu)', ['Nhận bàn giao từ ca sáng', 'Chuẩn bị bếp lẩu mini cho giờ cao điểm', 'Bổ sung khăn, đũa, chén']],
      [tplIds[1], 'close', 'Đóng ca tối phục vụ (mẫu)', ['Tắt bếp mini, cất bình gas', 'Thu dọn, lau sàn', 'Tắt điện, khoá cửa']],
    ];
    for (const [shift, phase, title, items] of lists) {
      const id = addTpl.run(team['Phục vụ'], phase, title, shift).lastInsertRowid;
      items.forEach((text, j) => addItem.run(id, text, 'check', '', j));
    }
  });
  loadDemoStock(db, { now });
}

// Kho mẫu: 3 NCC, ~18 nguyên liệu, 3 tuần lịch sử dùng (cuối tuần dùng nhiều hơn), tồn hiện tại có món sắp hết / sắp hết hạn
export function loadDemoStock(db, { now = Date.now() } = {}) {
  const clock = makeClock({ offset: '+07:00' });
  const today = clock.businessDate(now);
  const store = Object.fromEntries(db.prepare('SELECT id, name FROM stores').all().map((x) => [x.name, x.id]));
  const main = store['Kho tổng'];
  tx(db, () => {
    const sup = (name, phone) => Number(db.prepare('INSERT INTO suppliers (name, phone) VALUES (?, ?)').run(name, phone).lastInsertRowid);
    const s1 = sup('Bò Úc Minh Phát (mẫu)', '0901 111 222');
    const s2 = sup('Bò tươi & rau Hưng Thịnh (mẫu)', '0902 333 444');
    const s3 = sup('Đồ uống Phú An (mẫu)', '0903 555 666');
    db.prepare('UPDATE stores SET supplier_id = ? WHERE id = ?').run(s1, store['Kho Bếp steak']);
    db.prepare('UPDATE stores SET supplier_id = ? WHERE id = ?').run(s2, store['Kho Lẩu']);
    db.prepare('UPDATE stores SET supplier_id = ? WHERE id = ?').run(s3, store['Kho Bar']);
    // tên, đơn vị dùng, nhóm, khu, NCC riêng, đơn vị mua, quy đổi, bước, giá/đv mua, tồn tối thiểu, hạn (ngày), giao (ngày), chu kỳ, dùng TB/ngày, tồn kho tổng, tồn khu
    const items = [
      ['Thăn ngoại bò Úc', 'g', 'chilled', 'Kho Bếp steak', null, 'kg', 1000, 0.5, 650000, 3000, 7, 2, 4, 6000, 9000, 2500],
      ['Khoai tây cắt đông lạnh', 'g', 'dry', 'Kho Bếp steak', null, 'kg', 1000, 1, 70000, 2000, 90, 2, 7, 2500, 12000, 1500],
      ['Bơ lạt', 'g', 'chilled', 'Kho Bếp steak', null, 'kg', 1000, 0.5, 220000, 500, 20, 2, 7, 300, 1500, 400],
      ['Măng tây', 'g', 'fresh', 'Kho Bếp steak', null, 'kg', 1000, 0.5, 120000, 300, 3, 1, 1, 800, 300, 200],
      ['Tiêu đen hạt', 'g', 'dry', 'Kho Bếp steak', null, 'kg', 1000, 0.5, 260000, 300, 365, 2, 14, 60, 900, 150],
      ['Bò bắp', 'g', 'fresh', 'Kho Lẩu', null, 'kg', 1000, 0.5, 280000, 1000, 2, 1, 1, 6000, 1500, 800],
      ['Gầu bò', 'g', 'fresh', 'Kho Lẩu', null, 'kg', 1000, 0.5, 300000, 1000, 2, 1, 1, 4000, 2000, 600],
      ['Xương bò nấu nước lẩu', 'g', 'fresh', 'Kho Lẩu', null, 'kg', 1000, 1, 60000, 3000, 2, 1, 1, 8000, 6000, 2000],
      ['Rau lẩu tổng hợp', 'g', 'fresh', 'Kho Lẩu', null, 'kg', 1000, 0.5, 30000, 1000, 2, 1, 1, 5000, 3000, 1200],
      ['Nấm kim châm', 'g', 'fresh', 'Kho Lẩu', null, 'kg', 1000, 0.5, 60000, 500, 4, 1, 1, 1500, 800, 300],
      ['Bún tươi', 'g', 'fresh', 'Kho Lẩu', null, 'kg', 1000, 1, 15000, 1000, 1, 1, 1, 4000, 0, 600],
      ['Chanh', 'quả', 'fresh', 'Kho Bar', null, 'kg', 12, 0.5, 30000, 30, 7, 1, 2, 60, 40, 15],
      ['Bia Tiger', 'lon', 'dry', 'Kho Bar', null, 'thùng', 24, 1, 380000, 48, 180, 1, 3, 70, 96, 30],
      ['Coca cola', 'lon', 'dry', 'Kho Bar', null, 'thùng', 24, 1, 200000, 24, 180, 1, 5, 25, 30, 12],
      ['Nước suối', 'chai', 'dry', 'Kho Bar', null, 'thùng', 24, 1, 90000, 24, 365, 1, 7, 30, 120, 20],
      ['Siro đường', 'ml', 'dry', 'Kho Bar', null, 'chai', 750, 1, 120000, 750, 180, 2, 14, 250, 3000, 600],
      ['Đá viên', 'kg', 'fresh', null, s3, 'bao', 20, 1, 30000, 20, 0, 1, 1, 60, 20, 0],
      ['Rau thơm', 'g', 'fresh', null, s2, 'kg', 1000, 0.5, 40000, 300, 2, 1, 1, 700, 400, 0],
    ];
    const ins = db.prepare(`INSERT INTO ingredients (name, unit, freshness, home_store_id, supplier_id, purchase_unit, purchase_factor, order_step, price, min_stock, shelf_days, lead_days, cycle_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [name, unit, fresh, home, supId, pu, factor, step, price, min, shelf, lead, cycle, daily, inMain, inArea] of items) {
      const id = Number(ins.run(name, unit, fresh, home ? store[home] : null, supId, pu, factor, step, price, min, shelf, lead, cycle).lastInsertRowid);
      const area = home ? store[home] : store[name === 'Đá viên' ? 'Kho Bar' : 'Kho Lẩu'];
      // lịch sử dùng 21 ngày, cuối tuần (T6–CN) dùng nhiều hơn, dao động nhẹ
      for (let k = 21; k >= 1; k--) {
        const d = addDays(today, -k);
        const wd = isoWeekday(d);
        const q = Math.round(daily * (wd >= 5 ? 1.5 : 0.85) * (0.9 + ((k * 37 + id * 11) % 20) / 100));
        recordMove(db, { at: clock.toEpoch(d, 22 * 60 + 30), date: d, type: 'consume', ingredientId: id, fromStore: area, qty: q, cost: Math.round((q / factor) * price), note: 'Dùng trong ngày (mẫu)' });
      }
      // phần lớn còn hạn; vài món (bún tươi, bò bắp, măng tây) có lô sắp hết hạn để thấy cảnh báo
      const near = ['Bún tươi', 'Bò bắp', 'Măng tây'].includes(name);
      addLot(db, { storeId: main, ingredientId: id, qty: inMain, expiresOn: shelf ? addDays(today, shelf) : null, at: now });
      addLot(db, { storeId: area, ingredientId: id, qty: inArea, expiresOn: shelf ? addDays(today, near ? 1 : Math.max(2, shelf - 1)) : null, at: now });
    }
  });
}
