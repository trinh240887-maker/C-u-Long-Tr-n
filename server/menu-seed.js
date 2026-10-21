// Thực đơn ban đầu của quán (nhập từ ảnh menu chủ quán gửi 21/10). Chỉ nạp khi chưa có món nào.
export const MENU_SCHEMA = `
-- Điểm chế biến / điểm in phiếu (mỗi điểm 1 máy in LAN, có thể chưa có)
CREATE TABLE IF NOT EXISTS kitchen_stations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  printer_ip TEXT NOT NULL DEFAULT '',
  printer_port INTEGER NOT NULL DEFAULT 9100,
  fallback_station_id INTEGER REFERENCES kitchen_stations(id) ON DELETE SET NULL, -- máy lỗi thì in sang đây
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS menu_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES menu_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,           -- VNĐ
  station_id INTEGER REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  kit_id INTEGER REFERENCES service_kits(id) ON DELETE SET NULL, -- bộ dụng cụ (Steak/Lẩu) để dự trù
  sold_out INTEGER NOT NULL DEFAULT 0,        -- hết món hôm nay
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
-- Món combo in ra nhiều điểm: vd Set lẩu = nước lẩu (N.Lẩu) + bò (Thái tay) + rau, mì (Rau)
CREATE TABLE IF NOT EXISTS menu_item_parts (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  station_id INTEGER REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
-- Tuỳ chọn: nhóm (vd "Sốt"), bắt buộc chọn 1 hay không, giá cộng thêm
CREATE TABLE IF NOT EXISTS menu_options (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
-- Công thức: 1 phần món dùng bao nhiêu nguyên liệu (đơn vị dùng của nguyên liệu)
CREATE TABLE IF NOT EXISTS menu_recipes (
  item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  PRIMARY KEY (item_id, ingredient_id)
);
`;

const STATIONS = [
  ['Steak', '192.168.1.234'], ['Ưu tiên', ''], ['Nước lẩu', '192.168.1.238'], ['Bò', '192.168.1.236'],
  ['Topping – Nướng – Rau', '192.168.1.248'], ['Pha chế', '192.168.1.244'],
];
const SOT = ['Tứ xuyên', 'Kem phô mai', 'Tiêu đen'];
const LAU_PARTS = (nuoc) => [[`Ngăn nước lẩu ${nuoc}`, 'Nước lẩu'], ['Bò tươi 150g (thăn, bắp hoa, gù)', 'Bò'], ['Rau tổng hợp', 'Topping – Nướng – Rau'], ['Mì trứng 2 vắt', 'Topping – Nướng – Rau']];
// [danh mục, điểm in, kiểu dụng cụ, [[tên, giá, mô tả, {sot, parts}]]]
const MENU = [
  ['Steak', 'Steak', 'Steak', [
    ['Steak Âu', 69000, '100g bò, salad dầu giấm', { sot: true }],
    ['Combo 1', 79000, '100g bò, 1 trứng, salad dầu giấm', { sot: true }],
    ['Combo 2', 79000, '100g bò, pate, salad dầu giấm', { sot: true }],
    ['Combo 3', 89000, '100g bò, 1 trứng, pate, salad dầu giấm', { sot: true }],
  ]],
  ['Món thêm steak', 'Topping – Nướng – Rau', null, [['Trứng', 8000, ''], ['Salad', 10000, '']]],
  ['Combo lẩu', 'Nước lẩu', 'Lẩu', [
    ['Set 1 Thảo mộc Triều Châu', 150000, '1 ngăn nước lẩu, 150g bò tươi, rau tổng hợp, mì trứng 2 vắt, quầy nước chấm', { parts: LAU_PARTS('Thảo mộc Triều Châu') }],
    ['Set 2 Mala Tứ Xuyên', 150000, '1 ngăn nước lẩu, 150g bò tươi, rau tổng hợp, mì trứng 2 vắt, quầy nước chấm', { parts: LAU_PARTS('Mala Tứ Xuyên') }],
    ['Set 3 Cà chua Quý Châu', 150000, '1 ngăn nước lẩu, 150g bò tươi, rau tổng hợp, mì trứng 2 vắt, quầy nước chấm', { parts: LAU_PARTS('Cà chua Quý Châu') }],
  ]],
  ['Ngăn nước lẩu thêm', 'Nước lẩu', null, [['Nước lẩu Thảo mộc Triều Châu', 29000, ''], ['Nước lẩu Mala Tứ Xuyên', 29000, ''], ['Nước lẩu Cà chua Quý Châu', 29000, '']]],
  ['Bò tươi', 'Bò', null, [
    ['Bò ướp mala 100g', 69000, ''], ['Bò tắm trứng 100g', 69000, ''], ['Gù hoa bò Úc 100g', 79000, ''], ['Aukobe bông tuyết 100g', 79000, ''],
    ['Lõi vai bò Úc 100g', 79000, ''], ['Bắp hoa tươi 100g', 69000, ''], ['Gù bò tươi 100g', 69000, ''], ['Thăn bò tươi 100g', 69000, ''], ['Ba chỉ Mỹ 100g', 59000, ''],
  ]],
  ['Topping', 'Topping – Nướng – Rau', null, [
    ['Đậu hủ phô mai (4 viên)', 39000, ''], ['Bò viên (4 viên)', 39000, ''], ['Túi tiền (2 túi)', 49000, ''], ['Tôm hùm viên (6 viên)', 39000, ''],
    ['Thanh cua (3 thanh)', 25000, ''], ['Bánh bao ngũ sắc (6 viên)', 39000, ''], ['Chả tôm phi thúy', 69000, ''], ['Xách bò trắng 100g', 55000, ''], ['Xách bò đen 100g', 55000, ''],
  ]],
  ['Rau – Nấm – Mì', 'Topping – Nướng – Rau', null, [['Rau tổng hợp', 15000, ''], ['Nấm thập cẩm', 35000, ''], ['Nấm kim châm', 15000, ''], ['Mì trứng 2 vắt', 10000, ''], ['Tàu hủ ki 1 đĩa', 15000, '']]],
  ['Cà phê', 'Pha chế', null, [['Cafe đen đá (phin)', 20000, ''], ['Cafe sữa đá (phin)', 25000, ''], ['Bạc xỉu đá (phin)', 25000, '']]],
  ['Trà trái cây', 'Pha chế', null, [
    ['Trà tắc xí muội', 20000, ''], ['Cam vắt', 25000, ''], ['Trà vải', 25000, ''], ['Trà dâu', 25000, ''], ['Trà ổi hồng', 25000, ''],
    ['Trà đào', 25000, ''], ['Trà đào cam xả', 29000, ''], ['Trà dâu cam xả', 29000, ''],
  ]],
  ['Nước khác', 'Pha chế', null, [
    ['Nước suối', 10000, ''], ['Coca', 15000, ''], ['Coca không đường', 15000, ''], ['Sprite', 15000, ''], ['Sting dâu', 15000, ''],
    ['Fanta cam', 15000, ''], ['Heineken lùn', 25000, ''], ['Tiger bạc', 25000, ''],
  ]],
];

export function seedMenu(db) {
  if (!db.prepare('SELECT 1 FROM kitchen_stations LIMIT 1').get()) {
    const add = db.prepare('INSERT INTO kitchen_stations (name, printer_ip, sort) VALUES (?, ?, ?)');
    STATIONS.forEach(([n, ip], i) => add.run(n, ip, i));
    // Máy Ưu tiên lỗi thì in sang máy Steak
    db.prepare("UPDATE kitchen_stations SET fallback_station_id = (SELECT id FROM kitchen_stations WHERE name = 'Steak') WHERE name = 'Ưu tiên'").run();
  }
  if (db.prepare('SELECT 1 FROM menu_items LIMIT 1').get()) return;
  const st = Object.fromEntries(db.prepare('SELECT id, name FROM kitchen_stations').all().map((s) => [s.name, s.id]));
  const kit = Object.fromEntries(db.prepare('SELECT id, name FROM service_kits').all().map((k) => [k.name, k.id]));
  const addCat = db.prepare('INSERT INTO menu_categories (name, sort) VALUES (?, ?)');
  const addItem = db.prepare('INSERT INTO menu_items (category_id, name, description, price, station_id, kit_id, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const addPart = db.prepare('INSERT INTO menu_item_parts (item_id, label, station_id, sort) VALUES (?, ?, ?, ?)');
  const addOpt = db.prepare('INSERT INTO menu_options (item_id, group_name, name, price, required, sort) VALUES (?, ?, ?, 0, 1, ?)');
  MENU.forEach(([cat, station, kitName, items], ci) => {
    const catId = Number(addCat.run(cat, ci).lastInsertRowid);
    items.forEach(([name, price, desc, extra = {}], i) => {
      const id = Number(addItem.run(catId, name, desc, price, st[station] ?? null, kitName ? kit[kitName] ?? null : null, i).lastInsertRowid);
      if (extra.sot) SOT.forEach((s, j) => addOpt.run(id, 'Sốt', s, j));
      (extra.parts || []).forEach(([label, ps], j) => addPart.run(id, label, st[ps] ?? null, j));
    });
  });
}
