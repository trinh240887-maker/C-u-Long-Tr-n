import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export const ROLES = ['staff', 'team_lead', 'shift_lead', 'manager', 'owner'];
export const ROLE_LABEL = { owner: 'Chủ', manager: 'Quản lý', shift_lead: 'Trưởng ca', team_lead: 'Tổ trưởng', staff: 'Nhân viên' };
export const rank = (role) => ROLES.indexOf(role);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  min_staff INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'staff',
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  pin_lookup TEXT UNIQUE,
  pay_type TEXT NOT NULL DEFAULT 'hour',
  pay_rate INTEGER NOT NULL DEFAULT 0,
  weekly_limit_hours INTEGER NOT NULL DEFAULT 48,
  zalo_user_id TEXT NOT NULL DEFAULT '',
  zalo_link_code TEXT,
  must_change_pin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Vị trí trong bộ phận, vd Bếp: Steak, Lẩu, Nướng… Chọn theo từng ca.
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  min_staff INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS position_skills (
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (staff_id, position_id)
);

-- Lịch rảnh nhân viên tự báo (theo buổi) và lần nộp mỗi tuần
CREATE TABLE IF NOT EXISTS availability (
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  PRIMARY KEY (staff_id, date, slot)
);
CREATE TABLE IF NOT EXISTS availability_weeks (
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (staff_id, week_start)
);

CREATE TABLE IF NOT EXISTS staff_skills (
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (staff_id, team_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- Loại ca do chủ/quản lý tự tạo. segments = JSON [{ "start": "17:00", "end": "00:30" }, ...]
CREATE TABLE IF NOT EXISTS shift_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#c2410c',
  segments TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- Mỗi dòng là một khúc ca. Ca gãy có nhiều khúc cùng group_id.
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  template_id INTEGER REFERENCES shift_templates(id) ON DELETE SET NULL,
  label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assignments_by_date ON assignments(date);
CREATE INDEX IF NOT EXISTS assignments_by_staff ON assignments(staff_id, date);
CREATE INDEX IF NOT EXISTS assignments_by_group ON assignments(group_id);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | cancelled
  replacement_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  decided_by INTEGER,
  decided_at INTEGER,
  decision_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS leave_by_status ON leave_requests(status, date);

CREATE TABLE IF NOT EXISTS cover_offers (
  id INTEGER PRIMARY KEY,
  leave_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'invited',   -- invited | accepted | declined | closed
  invited_by INTEGER,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  UNIQUE (leave_id, staff_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  clock_in INTEGER NOT NULL,
  clock_out INTEGER,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  auto_closed INTEGER NOT NULL DEFAULT 0,
  edited_by INTEGER,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS attendance_by_date ON attendance(date);
CREATE INDEX IF NOT EXISTS attendance_by_staff ON attendance(staff_id, clock_in);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_attendance ON attendance(staff_id) WHERE clock_out IS NULL;

-- Checklist mẫu theo tổ và thời điểm (mở ca / trong ca / đóng ca)
CREATE TABLE IF NOT EXISTS checklist_templates (
  id INTEGER PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  phase TEXT NOT NULL DEFAULT 'open',       -- open | during | close
  title TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'check',       -- check | number | text
  unit TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
-- Mỗi checklist mẫu sinh một "lượt" cho mỗi ngày làm việc
CREATE TABLE IF NOT EXISTS checklist_runs (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  completed_at INTEGER,
  completed_by INTEGER,
  UNIQUE (template_id, date)
);
CREATE TABLE IF NOT EXISTS checklist_entries (
  run_id INTEGER NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  value TEXT NOT NULL DEFAULT '',
  done_by INTEGER,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, item_id)
);

-- Ảnh báo cáo checklist; file tự xoá sau 7 ngày (deleted_at), kết quả duyệt vẫn giữ
CREATE TABLE IF NOT EXISTS checklist_photos (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- Dụng cụ ăn uống (dao, nĩa, đũa…) và bộ dụng cụ cho mỗi kiểu phục vụ (Steak, Lẩu…)
CREATE TABLE IF NOT EXISTS utensils (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'cái',
  on_hand INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS service_kits (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS kit_items (
  kit_id INTEGER NOT NULL REFERENCES service_kits(id) ON DELETE CASCADE,
  utensil_id INTEGER NOT NULL REFERENCES utensils(id) ON DELETE CASCADE,
  per_guest REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (kit_id, utensil_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  due_at INTEGER,
  priority INTEGER NOT NULL DEFAULT 2,      -- 1 cao, 2 thường, 3 thấp
  status TEXT NOT NULL DEFAULT 'todo',      -- todo | doing | done
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  done_by INTEGER,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks(status, due_at);

-- Thông báo trong app + hàng đợi gửi Zalo
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  urgent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  zalo_status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
  zalo_attempts INTEGER NOT NULL DEFAULT 0,
  zalo_next_at INTEGER NOT NULL DEFAULT 0,
  zalo_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS notifications_by_staff ON notifications(staff_id, created_at);
CREATE INDEX IF NOT EXISTS notifications_queue ON notifications(zalo_status, zalo_next_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  staff_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
-- ================= KHU & BÀN =================
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#9a3412',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS dining_tables (
  number INTEGER PRIMARY KEY,          -- số bàn, duy nhất cả quán
  zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  seats INTEGER NOT NULL DEFAULT 4
);

-- ================= KHO (GĐ2) =================
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
-- Kho tổng (kind = main) và kho từng khu (kind = area, gắn với tổ, mỗi khu 1 NCC)
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'area',
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
-- Nguyên liệu. unit = đơn vị dùng (g, ml, quả, lon…); purchase_unit = đơn vị mua (kg, thùng…), 1 đơn vị mua = purchase_factor đơn vị dùng
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  freshness TEXT NOT NULL DEFAULT 'dry',         -- fresh | chilled | dry
  home_store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL, -- khu chính; NULL = kho chung
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, -- NULL = theo NCC của khu chính
  purchase_unit TEXT NOT NULL DEFAULT '',
  purchase_factor REAL NOT NULL DEFAULT 1,
  order_step REAL NOT NULL DEFAULT 1,           -- làm tròn số lượng đặt (theo đơn vị mua)
  price INTEGER NOT NULL DEFAULT 0,              -- đồng / 1 đơn vị mua (giá nhập gần nhất)
  min_stock REAL NOT NULL DEFAULT 0,             -- tồn tối thiểu cả quán (đơn vị dùng)
  shelf_days INTEGER NOT NULL DEFAULT 0,         -- số ngày dùng được sau khi nhập (0 = không theo dõi)
  lead_days INTEGER NOT NULL DEFAULT 1,          -- NCC giao sau bao nhiêu ngày
  cycle_days INTEGER NOT NULL DEFAULT 1,         -- đặt đủ dùng bao nhiêu ngày
  safety_pct INTEGER NOT NULL DEFAULT 10,        -- dự phòng %
  active INTEGER NOT NULL DEFAULT 1
);
-- Tồn kho theo lô (để biết hạn dùng, xuất trước hết hạn trước)
CREATE TABLE IF NOT EXISTS stock_lots (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  expires_on TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lots_by_store ON stock_lots(store_id, ingredient_id);
-- Lịch sử: receive (nhập NCC) | transfer (kho tổng → khu) | consume (dùng) | waste (hao hụt/hỏng) | adjust (kiểm kho thừa)
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  from_store INTEGER,
  to_store INTEGER,
  qty REAL NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0,
  ref TEXT NOT NULL DEFAULT '',
  staff_id INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS moves_by_date ON stock_moves(date);
CREATE INDEX IF NOT EXISTS moves_by_ing ON stock_moves(ingredient_id, date);
CREATE TABLE IF NOT EXISTS stock_counts (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  staff_id INTEGER,
  at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS stock_count_lines (
  count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  expected REAL NOT NULL,
  actual REAL NOT NULL,
  PRIMARY KEY (count_id, ingredient_id)
);
-- Phiếu lĩnh hàng: khu xin → kho tổng xuất → khu nhận
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY,
  from_store INTEGER NOT NULL REFERENCES stores(id),
  to_store INTEGER NOT NULL REFERENCES stores(id),
  status TEXT NOT NULL DEFAULT 'requested',     -- requested | sent | received | cancelled
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER, created_at INTEGER NOT NULL,
  sent_by INTEGER, sent_at INTEGER,
  received_by INTEGER, received_at INTEGER
);
CREATE TABLE IF NOT EXISTS transfer_lines (
  transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty_requested REAL NOT NULL DEFAULT 0,
  qty_sent REAL,
  qty_received REAL,
  expires_on TEXT,
  PRIMARY KEY (transfer_id, ingredient_id)
);
-- Đơn đặt hàng NCC: draft → submitted (tổ trưởng gửi) → approved (quản lý duyệt, gửi Zalo) → received (nhập kho)
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  status TEXT NOT NULL DEFAULT 'draft',
  deliver_on TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER, created_at INTEGER NOT NULL,
  submitted_by INTEGER, submitted_at INTEGER,
  approved_by INTEGER, approved_at INTEGER,
  received_by INTEGER, received_at INTEGER
);
CREATE TABLE IF NOT EXISTS po_lines (
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty REAL NOT NULL,                 -- theo đơn vị mua
  suggested REAL NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 0,  -- đồng / đơn vị mua
  qty_received REAL,
  price_received INTEGER,
  PRIMARY KEY (po_id, ingredient_id)
);
`;

export const DEFAULT_OWNER_PIN = '123456';

export function pinLookup(db, pin) {
  const secret = db.prepare("SELECT value FROM settings WHERE key = 'pin_secret'").get().value;
  return crypto.createHmac('sha256', secret).update(String(pin)).digest('hex');
}

export function openDb(file, { now = Date.now() } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  seedBase(db, now);
  migrate(db);
  return db;
}

// Nâng cấp dữ liệu cũ khi thêm cột mới
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('checklist_templates').includes('shift_template_id')) {
    db.exec('ALTER TABLE checklist_templates ADD COLUMN shift_template_id INTEGER REFERENCES shift_templates(id) ON DELETE SET NULL');
  }
  const aCols = cols('assignments');
  if (!aCols.includes('zone_id')) db.exec('ALTER TABLE assignments ADD COLUMN zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL');
  if (!aCols.includes('tables_text')) db.exec("ALTER TABLE assignments ADD COLUMN tables_text TEXT NOT NULL DEFAULT ''");
  if (!aCols.includes('position_id')) db.exec('ALTER TABLE assignments ADD COLUMN position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL');
  if (!cols('staff').includes('position_id')) db.exec('ALTER TABLE staff ADD COLUMN position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL');
  const iCols = cols('checklist_items');
  if (!iCols.includes('photo_required')) {
    db.exec('ALTER TABLE checklist_items ADD COLUMN photo_required INTEGER NOT NULL DEFAULT 1');
    // Chủ quán chốt 21/10: mọi khu đều phải có ảnh; mục nhập số/chữ thì không bắt ảnh
    db.exec("UPDATE checklist_items SET photo_required = CASE WHEN kind = 'check' THEN 1 ELSE 0 END");
  }
  const eCols = cols('checklist_entries');
  if (!eCols.includes('review_status')) {
    db.exec("ALTER TABLE checklist_entries ADD COLUMN review_status TEXT");      // null = chờ duyệt | ok | redo
    db.exec("ALTER TABLE checklist_entries ADD COLUMN review_note TEXT NOT NULL DEFAULT ''");
    db.exec('ALTER TABLE checklist_entries ADD COLUMN reviewed_by INTEGER');
    db.exec('ALTER TABLE checklist_entries ADD COLUMN reviewed_at INTEGER');
  }
  if (!cols('checklist_templates').includes('zone_id')) db.exec('ALTER TABLE checklist_templates ADD COLUMN zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL');
  if (!cols('checklist_templates').includes('position_id')) db.exec('ALTER TABLE checklist_templates ADD COLUMN position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL');
  // Khu mặc định A, B, C (sửa số bàn trong Cài đặt → Khu & bàn)
  if (!db.prepare('SELECT 1 FROM zones LIMIT 1').get()) {
    const addZone = db.prepare('INSERT INTO zones (name, color, sort) VALUES (?, ?, ?)');
    const addTable = db.prepare('INSERT OR IGNORE INTO dining_tables (number, zone_id) VALUES (?, ?)');
    [['Khu A', '#b45309', 1, 40], ['Khu B', '#0e7490', 41, 80], ['Khu C', '#4d7c0f', 81, 100]].forEach(([name, color, a, b], i) => {
      const id = Number(addZone.run(name, color, i).lastInsertRowid);
      for (let n = a; n <= b; n++) addTable.run(n, id);
    });
  }
  // Dụng cụ mẫu: chủ quán sửa lại trong Cài đặt → Dụng cụ
  if (!db.prepare('SELECT 1 FROM utensils LIMIT 1').get()) {
    const addU = db.prepare('INSERT INTO utensils (name, sort) VALUES (?, ?)');
    const u = {};
    ['Dao steak', 'Nĩa', 'Khăn ăn', 'Ly', 'Đũa', 'Muỗng', 'Chén', 'Vá lẩu'].forEach((n, i) => { u[n] = Number(addU.run(n, i).lastInsertRowid); });
    const addK = db.prepare('INSERT INTO service_kits (name, sort) VALUES (?, ?)');
    const addI = db.prepare('INSERT INTO kit_items (kit_id, utensil_id, per_guest) VALUES (?, ?, ?)');
    const steak = Number(addK.run('Steak', 0).lastInsertRowid);
    [['Dao steak', 1], ['Nĩa', 1], ['Khăn ăn', 1], ['Ly', 1]].forEach(([n, q]) => addI.run(steak, u[n], q));
    const lau = Number(addK.run('Lẩu', 1).lastInsertRowid);
    [['Đũa', 1], ['Muỗng', 1], ['Chén', 1], ['Ly', 1], ['Khăn ăn', 1], ['Vá lẩu', 0.25]].forEach(([n, q]) => addI.run(lau, u[n], q));
  }
  // Kho mặc định: kho tổng + kho cho các tổ chế biến
  if (!db.prepare('SELECT 1 FROM stores LIMIT 1').get()) {
    const add = db.prepare('INSERT INTO stores (name, kind, team_id, sort) VALUES (?, ?, ?, ?)');
    add.run('Kho tổng', 'main', null, 0);
    ['Bếp steak', 'Lẩu', 'Bar'].forEach((name, i) => {
      const team = db.prepare('SELECT id FROM teams WHERE name = ?').get(name);
      add.run(`Kho ${name}`, 'area', team?.id ?? null, i + 1);
    });
  }
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const DEFAULT_SETTINGS = {
  shop_name: 'Cửu Long Trấn',
  tz_offset: '+07:00',
  day_cutoff_hour: '5',          // trước 5h sáng tính là ngày hôm trước
  late_grace_minutes: '5',
  clock_early_minutes: '60',     // được chấm vào sớm nhất trước giờ ca
  auto_close_after_minutes: '120', // quên chấm ra: tự đóng sau giờ hết ca
  clock_ip_prefixes: '',         // vd "192.168.1." — để trống là không giới hạn
  night_bonus_pct: '30',
  month_standard_days: '26',  // lương tháng chia theo ngày công chuẩn; 0 = trả đủ cố định
  quiet_from: '23:00',
  quiet_to: '07:00',
  zalo_enabled: '0',
  zalo_app_id: '',
  zalo_secret_key: '',
  zalo_access_token: '',
  zalo_refresh_token: '',
  zalo_token_expires_at: '0',
  zalo_webhook_key: '',
  kho_tong_staff_id: '',
  area_count_is_usage: '1',      // chưa có bán hàng: chênh lệch kiểm kho khu = lượng đã dùng
  expiry_warn_days: '1',
  wash_cycle_minutes: '30',     // rửa xong 1 mẻ dụng cụ
  dining_minutes: '70',         // khách ngồi trung bình 1 lượt bàn
  utensil_reserve_pct: '10',    // dự phòng thêm
  avail_deadline_dow: '4',      // hạn báo lịch rảnh tuần sau: Thứ Năm
  avail_deadline_time: '21:00',
};

function seedBase(db, now) {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const put = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  put.run('pin_secret', crypto.randomBytes(32).toString('hex'));
  put.run('zalo_webhook_key', crypto.randomBytes(16).toString('hex'));
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) put.run(k, v);
  if (get.get('seeded')) return;

  tx(db, () => {
    const addTeam = db.prepare('INSERT INTO teams (name, sort, min_staff) VALUES (?, ?, ?)');
    const teams = [['Bếp steak', 2], ['Lẩu', 2], ['Bar', 1], ['Phục vụ', 4], ['Thu ngân', 1], ['Tạp vụ', 1]];
    const ids = {};
    teams.forEach(([name, min], i) => { ids[name] = Number(addTeam.run(name, i, min).lastInsertRowid); });

    db.prepare(`INSERT INTO staff (name, role, pin_lookup, must_change_pin, created_at) VALUES (?, 'owner', ?, 1, ?)`)
      .run('Chủ quán', pinLookup(db, DEFAULT_OWNER_PIN), now);

    // Checklist MẪU — sửa lại theo thực tế của quán
    const addTpl = db.prepare('INSERT INTO checklist_templates (team_id, phase, title, sort) VALUES (?, ?, ?, ?)');
    const addItem = db.prepare('INSERT INTO checklist_items (template_id, text, kind, unit, required, sort) VALUES (?, ?, ?, ?, ?, ?)');
    const lists = [
      ['Bếp steak', 'open', 'Mở ca bếp steak (mẫu)', [
        ['Nhiệt độ tủ mát', 'number', '°C'], ['Nhiệt độ tủ đông', 'number', '°C'],
        ['Rã đông thịt theo kế hoạch', 'check'], ['Chuẩn bị sốt tiêu đen, sốt nấm', 'check'],
        ['Khoai cắt sẵn, bơ tỏi', 'check'], ['Kiểm tra bếp gas, máy hút khói', 'check'],
      ]],
      ['Bếp steak', 'close', 'Đóng ca bếp steak (mẫu)', [
        ['Vệ sinh bếp, vỉ nướng', 'check'], ['Bọc màng, dán ngày thịt còn lại', 'check'],
        ['Khoá van gas', 'check'], ['Ghi chú bàn giao', 'text', '', 0],
      ]],
      ['Lẩu', 'open', 'Mở ca lẩu (mẫu)', [
        ['Nấu nước lẩu', 'number', 'lít'], ['Thái bò (bắp, gầu)', 'number', 'kg'],
        ['Rau, nấm, topping sẵn sàng', 'check'], ['Nhiệt độ tủ mát', 'number', '°C'],
      ]],
      ['Bar', 'open', 'Mở ca bar (mẫu)', [
        ['Đá viên đủ dùng', 'check'], ['Chanh, cam, bạc hà', 'check'],
        ['Siro, trà, sữa còn hạn', 'check'], ['Kiểm nước đóng chai trong tủ mát', 'check'],
      ]],
      ['Phục vụ', 'open', 'Mở ca phục vụ (mẫu)', [
        ['Setup bàn, khăn, menu', 'check'], ['Kiểm tra bếp lẩu mini, bình gas mini', 'check'],
        ['Vệ sinh khu vực được phân', 'check'],
      ]],
      ['Phục vụ', 'close', 'Đóng ca phục vụ (mẫu)', [
        ['Thu dọn, lau bàn ghế', 'check'], ['Tắt bếp mini, cất bình gas', 'check'],
      ]],
    ];
    lists.forEach(([team, phase, title, items], i) => {
      const tplId = addTpl.run(ids[team], phase, title, i).lastInsertRowid;
      items.forEach(([text, kind, unit = '', required = 1], j) => addItem.run(tplId, text, kind, unit, required, j));
    });
    db.prepare("INSERT INTO settings (key, value) VALUES ('seeded', '1')").run();
  });
}
