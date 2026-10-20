// DỮ LIỆU MẪU để chạy thử: nhân viên mẫu, loại ca mẫu, lịch tuần hiện tại.
// Dùng chung cho `npm run demo` và bản chạy thử trên web.
import crypto from 'node:crypto';
import { pinLookup, tx } from './db.js';
import { makeClock, weekStart, addDays, segmentMinutes } from './lib/time.js';

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
  });
}
