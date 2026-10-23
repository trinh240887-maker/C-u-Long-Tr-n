import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Nạp "Sổ 5 — Định lượng & cost menu bán" (14/10/2026, chủ quán gửi 23/10) vào app, chạy 1 lần (settings.dinh_luong_v1):
// - Thực đơn theo file: sửa giá, thêm món mới (xiên nướng, món xào, lẩu Nấm Vân Nam, Mala Trứng Muối, cà phê, soju…), giữ món file không có (Tôm hùm viên).
// - Nguyên liệu + giá mua theo sheet Đơn giá (giá / đơn vị mua, 1 đơn vị mua = quy cách × tỉ lệ dùng được).
// - Định lượng từng món thay bằng định lượng trong file. Bán thành phẩm (rổ rau, salad, ngăn nước lẩu, sốt…) là 1 nguyên liệu.
// Nguyên liệu chưa từng nhập kho thì app chưa tự khoá món (xem stock-sale.js), nên nạp vào không làm hết món.
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, 'data', 'dinh-luong-v1.json');

// Mã món trong file → tên món trong app (+ tên cũ trong app nếu khác), danh mục, điểm in, bộ dụng cụ
const SET_DESC = '1 ngăn nước lẩu, 150g bò tươi (50 thăn, 50 gù, 50 gầu giòn), rau tổng hợp, mì trứng 2 vắt, 2 chén chấm';
const STEAK_SOT = ['Hoàng kim', 'Tứ xuyên', 'Kem phô mai', 'Tiêu đen'];
const TINH_BOT = ['Bánh mì', 'Mì Ý', 'Nui'];
const MAP = {
  'LAU-S1': { name: 'Set 1 Thảo mộc Triều Châu', cat: 'Combo lẩu', set: 'Thảo mộc Triều Châu' },
  'LAU-S2': { name: 'Set 2 Mala Tứ Xuyên', cat: 'Combo lẩu', set: 'Mala Tứ Xuyên' },
  'LAU-S3': { name: 'Set 3 Lẩu Nấm Vân Nam', cat: 'Combo lẩu', set: 'Nấm Vân Nam' },
  'LAU-S4': { name: 'Set 4 Cà chua Quý Châu', old: ['Set 3 Cà chua Quý Châu'], cat: 'Combo lẩu', set: 'Cà chua Quý Châu' },
  'LAU-S5': { name: 'Set 5 Mala Trứng Muối', cat: 'Combo lẩu', set: 'Mala Trứng Muối' },
  'LAU-N1': { name: 'Nước lẩu Thảo mộc Triều Châu', cat: 'Ngăn nước lẩu thêm' },
  'LAU-N2': { name: 'Nước lẩu Mala Tứ Xuyên', cat: 'Ngăn nước lẩu thêm' },
  'LAU-N3': { name: 'Nước lẩu Nấm Vân Nam', cat: 'Ngăn nước lẩu thêm' },
  'LAU-N4': { name: 'Nước lẩu Cà chua Quý Châu', cat: 'Ngăn nước lẩu thêm' },
  'LAU-N5': { name: 'Nước lẩu Mala Trứng Muối', cat: 'Ngăn nước lẩu thêm' },
  'BO-01': { name: 'Xách bò trắng 100g', cat: 'Bò tươi' }, 'BO-02': { name: 'Xách bò đen 100g', cat: 'Bò tươi' },
  'BO-03': { name: 'Thăn bò tươi 100g', cat: 'Bò tươi' }, 'BO-04': { name: 'Gầu giòn 100g', cat: 'Bò tươi' },
  'BO-05': { name: 'Bò tắm trứng 100g', cat: 'Bò tươi' }, 'BO-06': { name: 'Aukobe bông tuyết 100g', cat: 'Bò tươi' },
  'BO-07': { name: 'Bắp hoa tươi 100g', cat: 'Bò tươi' }, 'BO-08': { name: 'Gù bò tươi 100g', cat: 'Bò tươi' },
  'BO-09': { name: 'Bò ướp mala 100g', cat: 'Bò tươi' }, 'BO-10': { name: 'Ba chỉ bò Mỹ 100g', old: ['Ba chỉ Mỹ 100g'], cat: 'Bò tươi' },
  'BO-11': { name: 'Lõi vai bò Úc 100g', cat: 'Bò tươi' }, 'BO-12': { name: 'Gù hoa bò Úc 100g', cat: 'Bò tươi' },
  'TOP-01': { name: 'Đậu hủ phô mai (4 viên)', cat: 'Topping' }, 'TOP-02': { name: 'Bò viên (4 viên)', cat: 'Topping' },
  'TOP-03': { name: 'Túi tiền (2 túi)', cat: 'Topping' }, 'TOP-04': { name: 'Thanh cua (3 thanh)', cat: 'Topping' },
  'TOP-05': { name: 'Bánh bao ngũ sắc (6 viên)', cat: 'Topping' }, 'TOP-06': { name: 'Chả tôm phi thúy', cat: 'Topping' },
  'RNM-01': { name: 'Rau tổng hợp', cat: 'Rau – Nấm – Mì' }, 'RNM-02': { name: 'Nấm thập cẩm', cat: 'Rau – Nấm – Mì' },
  'RNM-03': { name: 'Nấm kim châm', cat: 'Rau – Nấm – Mì' }, 'RNM-04': { name: 'Mì trứng 2 vắt', cat: 'Rau – Nấm – Mì' },
  'RNM-05': { name: 'Tàu hủ ki 1 đĩa', cat: 'Rau – Nấm – Mì' },
  'XN-01': { name: 'Xiên Bò Cửu Long', cat: 'Xiên nướng' }, 'XN-02': { name: 'Heo Nướng HongKong', cat: 'Xiên nướng' },
  'XN-03': { name: 'Mề Gà Tân Cương', cat: 'Xiên nướng' }, 'XN-04': { name: 'Xách Bò Tứ Xuyên', cat: 'Xiên nướng' },
  'XN-05': { name: 'Cánh Gà Triều Châu', cat: 'Xiên nướng' }, 'XN-06': { name: 'Ức Gà Trùng Khánh', cat: 'Xiên nướng' },
  'XN-07': { name: 'Phèo non rắc ớt HongKong', cat: 'Xiên nướng' }, 'XN-08': { name: 'Chẳng Dừng rắc ớt HongKong', cat: 'Xiên nướng' },
  'STK-01': { name: 'Steak Âu', cat: 'Steak', steak: true, desc: '120g bò Aukobe, salad dầu giấm, 1 tinh bột (bánh mì / mì Ý / nui), sốt 100g' },
  'STK-02': { name: 'Combo 1', cat: 'Steak', steak: true, desc: 'Triều Châu: 100g bò, 1 trứng (hoặc 30g pate), salad, 1 tinh bột, sốt 100g' },
  'STK-03': { name: 'Combo 2', cat: 'Steak', steak: true, desc: 'Hong Kong: 100g bò, 1 trứng, 30g pate, salad, 1 tinh bột, sốt 100g' },
  'STK-04': { name: 'Combo 3', cat: 'Steak', steak: true, desc: 'Kowloon: 150g bò, 2 trứng, 30g pate, 1 xúc xích, salad, 1 tinh bột, sốt 100g, 1 ly trà tắc xí muội' },
  'XAO-01': { name: 'Nui xào Triều Châu', cat: 'Món xào', sot: true, desc: '160g nui chín, 100g bò Aukobe, hành tây, sốt tự chọn' },
  'XAO-02': { name: 'Mì Ý xào HongKong', cat: 'Món xào', sot: true, desc: '160g mì Ý chín, 100g bò Aukobe, hành tây, sốt tự chọn' },
  'THEM-01': { name: 'Bánh mì', cat: 'Món thêm steak' }, 'THEM-02': { name: 'Nui', cat: 'Món thêm steak' },
  'THEM-03': { name: 'Mì Ý', cat: 'Món thêm steak' }, 'THEM-04': { name: 'Trứng', cat: 'Món thêm steak' },
  'THEM-05': { name: 'Salad', cat: 'Món thêm steak' }, 'THEM-06': { name: 'Khoai tây chiên', cat: 'Món thêm steak' },
  'CF-01': { name: 'Cafe đen đá (phin)', cat: 'Cà phê' }, 'CF-02': { name: 'Cafe sữa đá (phin)', cat: 'Cà phê' },
  'CF-03': { name: 'Bạc xỉu đá (phin)', cat: 'Cà phê' }, 'CF-04': { name: 'Cafe muối phô mai', cat: 'Cà phê' },
  'CF-05': { name: 'Espresso (nóng/đá)', cat: 'Cà phê' }, 'CF-06': { name: 'Latte (nóng/đá)', cat: 'Cà phê' },
  'CF-07': { name: 'Cappuccino (nóng/đá)', cat: 'Cà phê' },
  'TRA-01': { name: 'Trà tắc xí muội', cat: 'Trà trái cây' }, 'TRA-02': { name: 'Cam vắt', cat: 'Trà trái cây' },
  'TRA-03': { name: 'Trà vải', cat: 'Trà trái cây' }, 'TRA-04': { name: 'Trà dâu', cat: 'Trà trái cây' },
  'TRA-05': { name: 'Trà ổi hồng', cat: 'Trà trái cây' }, 'TRA-06': { name: 'Trà đào', cat: 'Trà trái cây' },
  'TRA-07': { name: 'Trà đào cam xả', cat: 'Trà trái cây' }, 'TRA-08': { name: 'Trà dâu cam xả', cat: 'Trà trái cây' },
  'TRA-09': { name: 'Trà trái cây nhiệt đới', cat: 'Trà trái cây' },
  'NK-01': { name: 'Nước suối', cat: 'Nước khác' }, 'NK-02': { name: 'Coca', cat: 'Nước khác' }, 'NK-03': { name: 'Coca không đường', cat: 'Nước khác' },
  'NK-04': { name: 'Sprite', cat: 'Nước khác' }, 'NK-05': { name: 'Sting dâu', cat: 'Nước khác' }, 'NK-06': { name: 'Fanta cam', cat: 'Nước khác' },
  'BR-01': { name: 'Heineken lùn', cat: 'Nước khác' }, 'BR-02': { name: 'Tiger bạc', cat: 'Nước khác' },
  'BR-03': { name: 'Rượu nóng Cửu Long 500ml', cat: 'Nước khác' }, 'BR-04': { name: 'Soju trà chanh HongKong', cat: 'Nước khác' },
  'BR-05': { name: 'Soju trái cây nhiệt đới', cat: 'Nước khác' },
};
// Danh mục mới: [điểm in, bộ dụng cụ]
const NEW_CATS = { 'Xiên nướng': ['Topping – Nướng – Rau', null], 'Món xào': ['Steak', 'Steak'] };
const CAT_DEFAULT = { 'Combo lẩu': ['Nước lẩu', 'Lẩu'], 'Steak': ['Steak', 'Steak'], 'Món thêm steak': ['Topping – Nướng – Rau', null], 'Cà phê': ['Pha chế', null],
  'Trà trái cây': ['Pha chế', null], 'Nước khác': ['Pha chế', null], 'Bò tươi': ['Bò', null], 'Topping': ['Topping – Nướng – Rau', null],
  'Rau – Nấm – Mì': ['Topping – Nướng – Rau', null], 'Ngăn nước lẩu thêm': ['Nước lẩu', null] };

// Đơn vị mua theo quy cách (1 đơn vị mua = quy cách đơn vị dùng)
function purchaseUnit(ing) {
  if (ing.pack === 1) return ing.unit;
  if (ing.pack === 1000 && ing.unit === 'g') return 'kg';
  if (ing.pack === 1000 && ing.unit === 'ml') return 'lít';
  const n = ing.name;
  if (/^Nui|^Mì Ý/.test(n)) return 'kg khô';
  if (/Mì trứng|^Tắc|Dâu tây|Sả cây|Cam tươi/.test(n)) return 'kg';
  if (/Túi tiền/.test(n)) return 'gói';
  if (/Siro pha chế|Sprite chai/.test(n)) return 'chai';
  if (/hộp|Đào ngâm|Kem Rich/.test(n)) return 'hộp';
  if (/Xí muội/.test(n)) return 'hũ';
  if (/Đá viên/.test(n)) return 'bao';
  if (/Soju|lon|chai|Sting/.test(n)) return 'thùng';
  if (ing.group === 'Bán thành phẩm') return 'mẻ';
  return 'gói';
}
function storeKey(ing) {
  const n = ing.name;
  if (ing.group === 'Bò' || ing.group === 'Topping' || ing.group === 'Rau nấm mì' || ing.group === 'Thịt xiên' || ing.group === 'Xiên') return 'lẩu';
  if (ing.group === 'Steak') return 'steak';
  if (ing.group === 'BTP sổ') return /Sốt steak/.test(n) ? 'steak' : 'lẩu';
  if (ing.group === 'Bán thành phẩm') return /Salad/.test(n) ? 'steak' : /Rau tổng hợp/.test(n) ? 'lẩu' : 'bar';
  return 'bar';
}
const FRESH = { 'Bò': 'fresh', 'Thịt xiên': 'fresh', 'Rau nấm mì': 'fresh', 'Topping': 'chilled', 'Steak': 'chilled', 'Bán thành phẩm': 'chilled', 'BTP sổ': 'chilled' };
const norm = (s) => String(s || '').toLocaleLowerCase('vi').replace(/[—–-]/g, ' ').replace(/(\d)\s+g\b/g, '$1g').replace(/\s+/g, ' ').trim();

export function seedDinhLuong(db) {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'dinh_luong_v1'").get()) return;
  if (!fs.existsSync(DATA)) return;
  if (!db.prepare('SELECT 1 FROM menu_items LIMIT 1').get()) return; // chưa có thực đơn (đang tạo dữ liệu ban đầu)
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const st = Object.fromEntries(db.prepare('SELECT id, name FROM kitchen_stations').all().map((s) => [s.name, s.id]));
  const kit = Object.fromEntries(db.prepare('SELECT id, name FROM service_kits').all().map((k) => [k.name, k.id]));
  const stores = db.prepare('SELECT id, name, kind FROM stores WHERE active = 1').all();
  const storeFor = (key) => stores.find((s) => s.kind === 'area' && norm(s.name).includes(key))?.id ?? stores.find((s) => s.kind === 'main')?.id ?? null;
  const report = { items_new: [], items_price: [], ingredients_new: 0, recipes: 0 };
  db.exec('BEGIN');
  try {
    // ---- Nguyên liệu ----
    const ingId = new Map();
    const findIng = db.prepare('SELECT * FROM ingredients WHERE lower(name) = lower(?)');
    const addIng = db.prepare(`INSERT INTO ingredients (name, unit, freshness, home_store_id, purchase_unit, purchase_factor, price, shelf_days, lead_days, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`);
    for (const g of data.ingredients) {
      if (g.group === 'Món') continue; // món dùng trong món khác (ly trà tắc của Combo 3) → bung công thức
      const factor = Math.round(g.pack * (g.yield || 1) * 1000) / 1000;
      const cur = findIng.get(g.name);
      if (cur) {
        // Đã có: giữ đơn vị của quán, chỉ điền giá nếu chưa có
        if (!cur.price && g.price && cur.unit === g.unit) db.prepare('UPDATE ingredients SET price = ?, purchase_unit = ?, purchase_factor = ? WHERE id = ?').run(Math.round(g.price), purchaseUnit(g), factor, cur.id);
        ingId.set(g.name, { id: cur.id, mul: cur.unit === g.unit ? 1 : cur.unit === 'kg' && g.unit === 'g' ? 0.001 : cur.unit === 'lít' && g.unit === 'ml' ? 0.001 : 1 });
        continue;
      }
      const fr = FRESH[g.group] || 'dry';
      const id = Number(addIng.run(g.name, g.unit, fr, storeFor(storeKey(g)), purchaseUnit(g), factor, Math.round(g.price || 0), fr === 'fresh' ? 2 : fr === 'chilled' ? 5 : 0).lastInsertRowid);
      ingId.set(g.name, { id, mul: 1 });
      report.ingredients_new++;
    }
    // ---- Công thức theo mã món (bung món lồng: ly trà tắc trong Combo 3) ----
    const byCode = new Map();
    for (const l of data.lines) (byCode.get(l.code) || byCode.set(l.code, []).get(l.code)).push(l);
    const nameToCode = new Map(data.items.map((i) => [`${i.file_name} (1 ly)`, i.code]));
    const expand = (code, mul = 1, depth = 0) => (byCode.get(code) || []).flatMap((l) => {
      const sub = nameToCode.get(l.ing) || (l.ing === 'Trà Tắc Xí Muội (1 ly)' ? 'TRA-01' : null);
      if (sub && depth < 2) return expand(sub, mul * l.qty, depth + 1);
      return [{ ...l, qty: l.qty * mul }];
    });
    // ---- Danh mục ----
    const cats = new Map(db.prepare('SELECT id, name FROM menu_categories').all().map((c) => [norm(c.name), c.id]));
    const catId = (name) => {
      if (cats.has(norm(name))) return cats.get(norm(name));
      const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM menu_categories').get().s;
      const id = Number(db.prepare('INSERT INTO menu_categories (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid);
      cats.set(norm(name), id);
      return id;
    };
    const allItems = () => db.prepare('SELECT * FROM menu_items').all();
    const addOpt = db.prepare('INSERT INTO menu_options (item_id, group_name, name, price, required, sort) VALUES (?, ?, ?, 0, 1, ?)');
    const ensureOpts = (itemId, group, names) => {
      const have = new Set(db.prepare('SELECT name FROM menu_options WHERE item_id = ? AND group_name = ?').all(itemId, group).map((o) => norm(o.name)));
      names.forEach((n, i) => { if (!have.has(norm(n))) addOpt.run(itemId, group, n, i); });
    };
    for (const it of data.items) {
      const m = MAP[it.code];
      if (!m) continue;
      const items = allItems();
      let row = items.find((x) => norm(x.name) === norm(m.name)) || items.find((x) => (m.old || []).some((o) => norm(o) === norm(x.name))) || items.find((x) => norm(x.name) === norm(it.file_name));
      const [stationName, kitName] = NEW_CATS[m.cat] || CAT_DEFAULT[m.cat] || [null, null];
      if (!row) {
        const cid = catId(m.cat);
        const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM menu_items WHERE category_id = ?').get(cid).s;
        const id = Number(db.prepare('INSERT INTO menu_items (category_id, name, description, price, station_id, kit_id, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(cid, m.name, m.desc || (m.set ? SET_DESC : ''), it.price || 0, st[stationName] ?? null, kitName ? kit[kitName] ?? null : null, sort).lastInsertRowid);
        row = { id, name: m.name, price: it.price || 0 };
        report.items_new.push(m.name);
        if (m.set) {
          const parts = [[`Ngăn nước lẩu ${m.set}`, 'Nước lẩu'], ['Bò tươi 150g (thăn, gù, gầu giòn)', 'Bò'], ['Rau tổng hợp', 'Topping – Nướng – Rau'], ['Mì trứng 2 vắt', 'Topping – Nướng – Rau']];
          parts.forEach(([label, ps], j) => db.prepare('INSERT INTO menu_item_parts (item_id, label, station_id, sort) VALUES (?, ?, ?, ?)').run(id, label, st[ps] ?? null, j));
        }
      } else {
        if (it.price && row.price !== it.price) { report.items_price.push(`${m.name}: ${row.price} → ${it.price}`); db.prepare('UPDATE menu_items SET price = ? WHERE id = ?').run(it.price, row.id); }
        if (row.name !== m.name) db.prepare('UPDATE menu_items SET name = ? WHERE id = ?').run(m.name, row.id);
        if (m.desc || m.set) db.prepare('UPDATE menu_items SET description = ? WHERE id = ?').run(m.desc || SET_DESC, row.id);
        if (m.set) db.prepare("UPDATE menu_item_parts SET label = 'Bò tươi 150g (thăn, gù, gầu giòn)' WHERE item_id = ? AND label LIKE 'Bò tươi 150g%'").run(row.id);
      }
      if (m.steak) { ensureOpts(row.id, 'Sốt', STEAK_SOT); ensureOpts(row.id, 'Tinh bột', TINH_BOT); }
      if (m.sot) ensureOpts(row.id, 'Sốt', STEAK_SOT);
      if (!it.price) db.prepare('UPDATE menu_items SET active = 0 WHERE id = ? AND price = 0').run(row.id); // món chưa có giá: tắt, chủ quán điền giá rồi bật
      // Định lượng: thay bằng file, cộng dồn nguyên liệu trùng
      const qty = new Map();
      for (const l of expand(it.code)) {
        const g = ingId.get(l.ing);
        if (!g) continue;
        qty.set(g.id, (qty.get(g.id) || 0) + l.qty * g.mul);
      }
      if (qty.size) {
        db.prepare('DELETE FROM menu_recipes WHERE item_id = ?').run(row.id);
        for (const [gid, q] of qty) db.prepare('INSERT INTO menu_recipes (item_id, ingredient_id, qty) VALUES (?, ?, ?)').run(row.id, gid, Math.round(q * 1000) / 1000);
        report.recipes++;
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('dinh_luong_v1', ?)").run(JSON.stringify({ at: Date.now(), new: report.items_new.length, price: report.items_price.length, ingredients: report.ingredients_new, recipes: report.recipes }));
    db.exec('COMMIT');
    return report;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
