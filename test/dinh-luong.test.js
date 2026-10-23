import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';

test('nạp sổ định lượng (file thật của quán): giá theo file, món mới, định lượng + giá vốn, steak chọn sốt + tinh bột, chạy 1 lần', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'q.db');
  let db = openDb(file);
  const item = (n) => db.prepare('SELECT * FROM menu_items WHERE name = ?').get(n);
  const cost = (n) => Math.round(db.prepare('SELECT SUM(r.qty * g.price / g.purchase_factor) AS c FROM menu_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ?').get(item(n).id).c);
  assert.equal(item('Combo 3').price, 139000);
  assert.equal(item('Steak Âu').price, 79000);
  assert.ok(item('Set 4 Cà chua Quý Châu'), 'Set 3 cũ đổi thành Set 4');
  assert.ok(item('Set 3 Lẩu Nấm Vân Nam'));
  assert.ok(item('Xiên Bò Cửu Long'));
  assert.ok(item('Tôm hùm viên (6 viên)').active, 'món file không có vẫn bán');
  // Giá vốn khớp file (±50đ do làm tròn)
  for (const [n, c] of [['Set 1 Thảo mộc Triều Châu', 60651], ['Thăn bò tươi 100g', 27500], ['Steak Âu', 45343], ['Combo 3', 72880], ['Trà tắc xí muội', 8627], ['Xiên Bò Cửu Long', 11106]]) assert.ok(Math.abs(cost(n) - c) < 60, `${n}: ${cost(n)} ≠ ${c}`);
  // Set lẩu: 50g thăn, 50g gù, 50g gầu giòn
  const set = db.prepare('SELECT g.name, r.qty FROM menu_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ? ORDER BY g.name').all(item('Set 2 Mala Tứ Xuyên').id);
  assert.deepEqual(set.filter((x) => /^(Thăn|Gù|Gầu)/.test(x.name)).map((x) => [x.name, x.qty]), [['Gù bò tươi', 50], ['Gầu giòn', 50], ['Thăn bò tươi', 50]]);
  const groups = db.prepare('SELECT DISTINCT group_name FROM menu_options WHERE item_id = ? ORDER BY group_name').all(item('Combo 1').id).map((x) => x.group_name);
  assert.deepEqual(groups, ['Sốt', 'Tinh bột']);
  const n = db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n;
  db.close();
  db = openDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n, n, 'không nạp lại');
  db.close();
});
