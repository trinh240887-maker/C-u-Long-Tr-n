#!/usr/bin/env node
// Nạp DỮ LIỆU MẪU để chạy thử app. Chỉ chạy khi chưa có nhân viên nào ngoài Chủ quán.
//   npm run demo
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { loadDemoData, hasOtherStaff, DEMO_PEOPLE } from '../server/demo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = openDb(path.join(dataDir, 'quanly.db'));

if (hasOtherStaff(db) && !process.argv.includes('--force')) {
  console.error('Đã có nhân viên trong dữ liệu, không nạp dữ liệu mẫu (thêm --force nếu chắc chắn).');
  process.exit(1);
}
loadDemoData(db);
console.log('Đã nạp dữ liệu mẫu. PIN đăng nhập thử:');
for (const [name, role, , pin] of DEMO_PEOPLE) console.log(`  ${name.padEnd(14)} ${role.padEnd(10)} PIN ${pin}`);
console.log('Tên có chữ "(mẫu)" là dữ liệu thử; xoá/sửa lại khi dùng thật.');
