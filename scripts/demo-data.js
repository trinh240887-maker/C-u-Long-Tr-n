#!/usr/bin/env node
// Nạp DỮ LIỆU MẪU để chạy thử app: nhân viên mẫu, loại ca mẫu, lịch tuần này.
// Chỉ chạy được khi chưa có nhân viên nào ngoài Chủ quán (tránh ghi đè dữ liệu thật).
//   npm run demo
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, pinLookup, tx } from '../server/db.js';
import { makeClock, weekStart, addDays, segmentMinutes } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = openDb(path.join(dataDir, 'quanly.db'));

const others = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role != 'owner'").get().n;
if (others > 0 && !process.argv.includes('--force')) {
  console.error('Đã có nhân viên trong dữ liệu, không nạp dữ liệu mẫu (thêm --force nếu chắc chắn).');
  process.exit(1);
}

const team = Object.fromEntries(db.prepare('SELECT id, name FROM teams').all().map((t) => [t.name, t.id]));
const now = Date.now();
const clock = makeClock({ offset: '+07:00' });
const today = clock.businessDate(now);
const monday = weekStart(today);

const people = [
  // tên, vai trò, tổ, PIN, lương, kiểu, kỹ năng phụ
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

const templates = [
  ['Sáng (mẫu)', '#0e7490', [['09:00', '15:00']]],
  ['Tối (mẫu)', '#9a3412', [['15:00', '23:00']]],
  ['Ca gãy (mẫu)', '#7c3aed', [['10:00', '14:00'], ['17:00', '22:00']]],
  ['Ca đóng (mẫu)', '#be123c', [['17:00', '00:30']]],
];

tx(db, () => {
  const tplIds = templates.map(([name, color, segs]) => Number(db.prepare('INSERT INTO shift_templates (name, color, segments) VALUES (?, ?, ?)')
    .run(name, color, JSON.stringify(segs.map(([start, end]) => ({ start, end })))).lastInsertRowid));
  const ids = people.map(([name, role, t, pin, rate, type, skills]) => {
    const id = Number(db.prepare(`INSERT INTO staff (name, phone, role, team_id, pin_lookup, pay_type, pay_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, `09${String(10000000 + Math.floor(Math.random() * 8e7))}`, role, t ? team[t] : null, pinLookup(db, pin), type, rate, now).lastInsertRowid);
    for (const [k, level] of skills) db.prepare('INSERT INTO staff_skills (staff_id, team_id, level) VALUES (?, ?, ?)').run(id, team[k], level);
    return id;
  });
  // Lịch tuần này: xoay vòng các loại ca
  const add = db.prepare(`INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, template_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  people.forEach(([, role, t], i) => {
    if (role === 'manager') return;
    for (let d = 0; d < 7; d++) {
      if ((i + d) % 7 === 0 || (i + d) % 7 === 3) continue; // mỗi người nghỉ 2 ngày/tuần
      const ti = (i + d) % templates.length;
      const [label, , segs] = templates[ti];
      const g = crypto.randomBytes(8).toString('hex');
      for (const [s, e] of segs) {
        const m = segmentMinutes(s, e);
        add.run(g, ids[i], t ? team[t] : null, addDays(monday, d), m.start_min, m.end_min, tplIds[ti], label, now);
      }
    }
  });
});

console.log('Đã nạp dữ liệu mẫu. PIN đăng nhập thử:');
for (const [name, role, , pin] of people) console.log(`  ${name.padEnd(14)} ${role.padEnd(10)} PIN ${pin}`);
console.log('Tên có chữ "(mẫu)" là dữ liệu thử; xoá/sửa lại khi dùng thật.');
