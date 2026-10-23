import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { KHU_CHECKLISTS } from '../server/checklist-khu.js';

test('checklist theo khu: tạo 1 lần, gán đúng vị trí theo tên, không tìm thấy tổ thì để tắt, không trùng khi mở lại', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ck-')), 'q.db');
  let db = openDb(file);
  const get = (t) => db.prepare('SELECT c.*, p.name AS pos, tm.name AS team FROM checklist_templates c LEFT JOIN positions p ON p.id = c.position_id LEFT JOIN teams tm ON tm.id = c.team_id WHERE c.title = ?').get(t);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checklist_items WHERE template_id = ?").get(get('Mở ca Thái tay').id).n, KHU_CHECKLISTS[0].items.length);
  assert.equal(get('Mở ca Pha chế').team, 'Bar');
  assert.equal(get('Mở ca Tiếp thực (chọn tổ)').active, 0, 'chưa có tổ Tiếp thực → để tắt');
  // Việc tick máy móc / vệ sinh bắt ảnh, việc nhập số không
  const it = db.prepare("SELECT kind, photo_required FROM checklist_items WHERE text = 'Lau máy thái trước khi dùng'").get();
  assert.equal(it.photo_required, 1);
  assert.equal(db.prepare("SELECT kind FROM checklist_items WHERE text = 'Lấy ly từ tủ ra'").get().kind, 'check');
  const n = db.prepare('SELECT COUNT(*) AS n FROM checklist_templates').get().n;
  db.close();
  // Mở lại: không tạo thêm
  db = openDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checklist_templates').get().n, n);
  // Quán có tổ "Bếp" với vị trí "Thái tay", tổ "Tiếp thực" → chạy lại thì gán đúng vị trí
  // Bản cũ đã chạy v1 (12 checklist) → mở lại chỉ thêm khu mới (Lối đi), không tạo lại cái đã xoá
  db.exec("DELETE FROM settings WHERE key = 'checklist_khu_done'");
  db.exec("DELETE FROM checklist_templates WHERE title LIKE '%Lối đi%' OR title = 'Mở ca Pha chế'");
  db.exec("INSERT INTO settings (key, value) VALUES ('checklist_khu_v1', '12')");
  db.close();
  db = openDb(file);
  assert.ok(get('Mở ca Lối đi & cổng vào'), 'khu mới được thêm');
  assert.ok(!get('Mở ca Pha chế'), 'không tạo lại checklist chủ quán đã xoá');
  db.exec("DELETE FROM settings WHERE key IN ('checklist_khu_v1', 'checklist_khu_done')");
  for (const c of KHU_CHECKLISTS) db.prepare('DELETE FROM checklist_templates WHERE title IN (?, ?)').run(c.title, `${c.title} (chọn tổ)`);
  const bep = Number(db.prepare("INSERT INTO teams (name, sort, min_staff) VALUES ('Bếp', 9, 1)").run().lastInsertRowid);
  db.prepare("INSERT INTO positions (team_id, name, sort, min_staff) VALUES (?, 'Thái tay', 0, 1)").run(bep);
  db.prepare("INSERT INTO teams (name, sort, min_staff) VALUES ('Tiếp thực', 10, 1)").run();
  db.close();
  db = openDb(file);
  assert.equal(get('Đóng ca Thái tay').pos, 'Thái tay');
  assert.equal(get('Đóng ca Thái tay').team, 'Bếp');
  assert.equal(get('Mở ca Tiếp thực').active, 1);
  db.close();
});
