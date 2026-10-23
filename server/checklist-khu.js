// Bộ checklist theo từng khu, soạn từ ảnh chủ quán chụp (22–23/10/2026). Chạy 1 lần (settings.checklist_khu_v1).
// - Gán tổ / vị trí theo TÊN đang có trong app (vị trí "Thái tay", "Topping"…; tổ "Lẩu", "Bar", "Tiếp thực", "Tạp vụ").
//   Không tìm thấy thì để "Cả quán" và thêm "(chọn tổ)" vào tên để chủ quán gán lại, không tự tạo tổ mới.
// - Không tìm thấy tổ → tạo ở trạng thái TẮT (chủ quán chọn tổ rồi bật), tránh hiện cho cả quán.
// - Không ghi đè checklist cùng tên đã có, không tự tắt checklist cũ của quán.
// Kiểu việc: [tên, kiểu ('check' | 'number' | 'text'), đơn vị, bắt buộc (mặc định 1), chụp ảnh (mặc định: check có ảnh)]
const T = (text, photo = true) => [text, 'check', '', 1, photo ? 1 : 0];
const N = (text, unit) => [text, 'number', unit, 1, 0];
const X = (text, required = 0) => [text, 'text', '', required, 0];

export const KHU_CHECKLISTS = [
  { title: 'Mở ca Thái tay', phase: 'open', position: ['thái tay', 'bò'], team: ['lẩu', 'bếp'], items: [
    T('Rửa tay, đeo găng mới, đội nón', false),
    N('Nhiệt độ tủ mát (đọc trên màn tủ)', '°C'),
    X('Bò tồn đầu ca: ghi từng loại (vd Thăn 3,2kg; Bắp hoa 2kg…)', 1),
    T('Cân điện tử: bật, về 0', false),
    T('Lau máy thái trước khi dùng'),
    T('Lắp lưỡi máy thái, chạy thử'),
    T('Thớt, dao, khay sạch'),
    T('Giấy thấm dầu đủ dùng, bổ sung', false),
    T('Bồn rửa tay có xà phòng + giấy lau tay', false),
    T('Kiểm bình gas, van, dây'),
    T('Lau kính chắn quầy'),
    T('Lau mặt quầy'),
  ] },
  { title: 'Đóng ca Thái tay', phase: 'close', position: ['thái tay', 'bò'], team: ['lẩu', 'bếp'], items: [
    X('Bò còn cuối ca: cân từng loại, ghi kg (vd Thăn 1,4kg; Gù 0,8kg…)', 1),
    T('Bò thừa bọc màng, ghi ngày, cất tủ'),
    T('Tháo, rửa lưỡi và khay máy thái'),
    T('Lau máy thái, lau khô'),
    T('Lau kính chắn quầy trong + ngoài'),
    T('Lau mặt quầy, thớt, khay'),
    T('Thớt dựng giá cho khô (không để thau dưới sàn)'),
    N('Nhiệt độ tủ mát lúc đóng', '°C'),
    T('Khoá van gas'),
    T('Tắt máy lạnh, đèn quầy', false),
    X('Hàng thiếu cần báo (giấy thấm dầu, găng…)'),
  ] },
  { title: 'Mở ca Topping', phase: 'open', position: ['topping'], team: ['lẩu', 'bếp'], items: [
    T('Rửa tay, đeo găng, đội nón', false),
    N('Nhiệt độ tủ trưng bày', '°C'),
    T('Kiểm rau, nấm, topping còn tươi, bỏ đồ hư'),
    T('Rửa, để ráo rau lẩu + salad'),
    T('Bày topping vào hộp đúng ngăn có nhãn'),
    T('Kiểm dầu chiên, dầu đen thì thay'),
    T('Bật bếp chiên, lò hâm, chạy thử'),
    T('Châm đá thùng đá', false),
  ] },
  { title: 'Đóng ca Topping', phase: 'close', position: ['topping'], team: ['lẩu', 'bếp'], items: [
    X('Topping + bánh mì còn: từng loại, ghi số bịch + số viên/ổ lẻ', 1),
    T('Topping thừa vào hộp có nắp, ghi ngày'),
    T('Lọc / đổ dầu, vệ sinh bếp chiên'),
    T('Lau kính + khay tủ trưng bày trong ngoài'),
    T('Rau, cà chua kê lên kệ, không để sát sàn'),
    T('Rửa rổ, bồn rửa, đổ rác'),
    T('Lau mặt quầy'),
    T('Tắt bếp chiên, lò hâm'),
    T('Đóng kín cửa tủ trưng bày'),
    N('Nhiệt độ tủ lúc đóng', '°C'),
    X('Hàng thiếu cần báo'),
  ] },
  { title: 'Mở ca Nước lẩu', phase: 'open', position: ['nước lẩu', 'lẩu'], team: ['lẩu', 'bếp'], items: [
    T('Van xả nồi điện đóng, bật CB, chỉnh nhiệt'),
    X('Nước lẩu từng vị: ghi số lít (Mala, Cà chua, Nấm, Thảo mộc…)', 1),
    T('Nếm đạt vị theo công thức', false),
    T('Kiểm dây, van, mùi gas'),
    N('Bình gas đầy dự phòng', 'bình'),
    T('Thử lửa bếp 6 họng + bếp khè'),
    T('Sốt, nước chấm làm theo công thức'),
    T('Máy in phiếu có giấy', false),
  ] },
  { title: 'Đóng ca Nước lẩu', phase: 'close', position: ['nước lẩu', 'lẩu'], team: ['lẩu', 'bếp'], items: [
    X('Nước lẩu còn từng vị: ghi số lít', 1),
    T('Xả, rửa nồi điện + van xả'),
    T('Tắt CB nồi điện'),
    T('Rửa nồi inox, lau bếp khè'),
    T('Lau bếp 6 họng, mặt quầy, kính'),
    T('Khoá van tất cả bình gas'),
    T('Sốt, gia vị đậy kín / bọc màng, ghi ngày'),
    T('Xếp gọn kệ dưới (ớt khô cho vào hũ kín)'),
    T('Lau sàn khu nấu'),
    X('Hàng thiếu cần báo'),
  ] },
  { title: 'Mở ca Pha chế', phase: 'open', team: ['bar', 'pha chế'], items: [
    T('Lấy ly từ tủ ra', false),
    T('Đá đủ dùng'),
    T('Siro, mứt, sữa còn hạn, đủ dùng', false),
    T('Ly nhựa, ống hút, khay xách đủ', false),
    T('Lau quầy + xe'),
    T('Bình nước uống còn', false),
    T('Máy in mini có giấy', false),
    T('Kiểm van, dây gas'),
  ] },
  { title: 'Đóng ca Pha chế', phase: 'close', team: ['bar', 'pha chế'], items: [
    T('Rửa ly, bình đong, thau, úp ráo'),
    N('Đếm ly thuỷ tinh', 'ly'),
    X('Ly bể / thiếu: ghi số và lý do'),
    T('Cất ly vào tủ inox dưới quầy, khoá'),
    T('Lau vòi bơm siro, đậy nắp, cất'),
    T('Xả nước đá thừa, lau thùng đá, mở nắp cho khô'),
    T('Cọ hố rửa, đổ rác'),
    T('Lau quầy, lau sàn chỗ đá chảy'),
    T('Khoá van gas'),
    T('Tắt quạt, đèn, rút điện máy in', false),
    T('Che xe / kéo bạt'),
    X('Hàng thiếu cần báo'),
  ] },
  { title: 'Mở ca Tiếp thực', phase: 'open', team: ['tiếp thực'], items: [
    N('Đếm xe cân bằng', 'xe'),
    T('Kiểm pin xe đủ chạy ca, xe yếu thì báo'),
    T('Lau xe, bánh xe', false),
  ] },
  { title: 'Đóng ca Tiếp thực', phase: 'close', team: ['tiếp thực'], items: [
    N('Đếm xe cân bằng', 'xe'),
    T('Cắm sạc đủ xe'),
    T('Lau bánh xe trước khi cất', false),
    T('Đậu xe đúng chỗ quy định (không dưới quầy thực phẩm)'),
  ] },
  { title: 'Đóng ca khu bán hàng', phase: 'close', team: ['tạp vụ'], items: [
    T('Lau sàn khu khách ngồi'),
    T('Gom rác, đổ thùng', false),
    T('Thu bạt, cụp dù', false),
    T('Tắt đèn bảng hiệu, đèn dây', false),
    T('Xếp gọn bàn ghế'),
  ] },
];

export function seedKhuChecklists(db) {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'checklist_khu_v1'").get()) return;
  const lc = (s) => String(s || '').toLocaleLowerCase('vi');
  const teams = db.prepare('SELECT id, name FROM teams').all();
  const positions = db.prepare('SELECT id, team_id, name FROM positions').all();
  const findTeam = (keys = []) => { for (const k of keys) { const t = teams.find((x) => lc(x.name) === k) || teams.find((x) => lc(x.name).includes(k)); if (t) return t; } return null; };
  const findPos = (keys = []) => { for (const k of keys) { const p = positions.find((x) => lc(x.name) === k) || positions.find((x) => lc(x.name).includes(k)); if (p) return p; } return null; };
  const exists = db.prepare('SELECT 1 FROM checklist_templates WHERE lower(title) = lower(?)');
  const addTpl = db.prepare('INSERT INTO checklist_templates (team_id, phase, title, sort, position_id, active) VALUES (?, ?, ?, ?, ?, ?)');
  const addItem = db.prepare('INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    let sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM checklist_templates').get().s || 0) + 1;
    let made = 0;
    for (const c of KHU_CHECKLISTS) {
      const pos = c.position ? findPos(c.position) : null;
      const team = pos ? teams.find((t) => t.id === pos.team_id) : findTeam(c.team);
      const title = team ? c.title : `${c.title} (chọn tổ)`;
      if (exists.get(c.title) || exists.get(title)) continue;
      const id = Number(addTpl.run(team?.id ?? null, c.phase, title, sort++, pos?.id ?? null, team ? 1 : 0).lastInsertRowid);
      c.items.forEach(([text, kind, unit, required, photo], i) => addItem.run(id, text, kind, unit, required, photo, i));
      made++;
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('checklist_khu_v1', ?)").run(String(made));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
