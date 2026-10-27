import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Ẩn checklist Phục vụ & Tiếp thực 1 lần (DB đang chạy): giữ Bếp, giữ lịch sử, bỏ việc ca chưa làm', () => {
  const db = openDb(':memory:', { now: Date.now() });
  const mk = () => createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  let app = mk();
  // DB mới: không ẩn gì
  const active = () => db.prepare("SELECT c.title, t.name AS team FROM checklist_templates c LEFT JOIN teams t ON t.id = c.team_id WHERE c.active = 1").all();
  assert.ok(active().some((x) => /Mở ca phục vụ/i.test(x.title)));
  app.close();
  // Giả lập bản đang chạy thật: cờ ẩn chưa có → lần khởi động sau sẽ ẩn
  db.prepare("DELETE FROM settings WHERE key IN ('pv_tt_hide_v1', 'pv_tt_restore_v1')").run();
  const bepBefore = active().filter((x) => /bếp|lẩu|bar/i.test(x.team || '')).length;
  app = mk();
  // Sửa lại: checklist Phục vụ vẫn dùng (bật lại) nhưng TRỐNG việc; việc cũ nằm ở bản "(việc cũ 27/10)" đang tắt
  const mo = db.prepare("SELECT * FROM checklist_templates WHERE title = 'Mở ca phục vụ'").get();
  assert.equal(mo.active, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE template_id = ?').get(mo.id).n, 0);
  const arch = db.prepare("SELECT * FROM checklist_templates WHERE title = 'Mở ca phục vụ (việc cũ 27/10)'").get();
  assert.equal(arch.active, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE template_id = ?').get(arch.id).n, 12);
  assert.equal(active().filter((x) => /bếp|lẩu|bar/i.test(x.team || '')).length, bepBefore);
  assert.ok(JSON.parse(app.ctx.setting('pv_tt_hidden_ids')).length >= 1);
  app.close();
});
