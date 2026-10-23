// Bộ checklist theo từng khu, soạn từ ảnh chủ quán chụp (22–23/10/2026). Mỗi checklist chỉ tạo 1 lần
// (settings.checklist_khu_done ghi tên đã tạo) → thêm khu mới vào danh sách là app đang chạy tự có, chủ quán xoá thì không tạo lại.
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
  // Lối đi chính giữa 2 dãy quầy + cổng vào từ đường (ảnh 23/10): nước đọng, vết dầu, rác + lá ở cổng và miệng cống, xe đẩy / thang để giữa lối
  { title: 'Mở ca Lối đi & cổng vào', phase: 'open', team: ['tạp vụ'], items: [
    T('Quét cổng vào + vỉa hè trước quán, nhặt rác, lá'),
    T('Vớt rác miệng cống trước cổng'),
    T('Xịt rửa vết dầu, vết đen ở cổng vào'),
    T('Lối đi chính khô ráo, không đọng nước (đọng thì gạt khô)'),
    T('Dọn đồ chắn lối: xe đẩy, thang, thùng, ghế'),
    T('Mở dù, bảng hiệu, đèn lối đi sáng đủ', false),
  ] },
  { title: 'Trong ca Lối đi', phase: 'during', team: ['tạp vụ'], items: [
    T('19:00 đi 1 vòng: lau chỗ đổ, nhặt rác, gạt nước đọng'),
    T('21:00 đi 1 vòng: lau chỗ đổ, nhặt rác, gạt nước đọng'),
  ] },
  { title: 'Đóng ca Lối đi & cổng vào', phase: 'close', team: ['tạp vụ'], items: [
    T('Quét + lau lối đi chính, gạt khô nước'),
    T('Xịt rửa vết dầu, vết bẩn trên lối đi'),
    T('Quét cổng vào, vớt rác miệng cống'),
    T('Cất xe đẩy, thang, thùng vào đúng chỗ'),
    T('Thu dù, kéo bạt', false),
    X('Chỗ hư cần sửa (sơn viền bong, gạch vỡ…)'),
  ] },
  // Mặt tiền ra đường (ảnh 23/10): sân gạch đỏ có tàn thuốc, giấy, túi nilon, lá, gạch vỡ; cổng lưới đỏ có bánh xe;
  // xe khách đậu trên sân gạch / sát lối vào; chậu cau lớn; rác nhà bên đặt sát cột điện
  { title: 'Mở ca Mặt tiền & giữ xe', phase: 'open', team: ['bảo vệ', 'giữ xe', 'tạp vụ'], items: [
    T('Kéo mở cổng lưới, chặn bánh xe cho đứng yên'),
    T('Quét + lau sân gạch đỏ mặt tiền: tàn thuốc, giấy, túi nilon, lá'),
    T('Dọn gạch vỡ, vật cản trước cổng'),
    T('Tưới cây, nhặt lá úa chậu cau', false),
    T('Khu để xe xếp gọn, chừa lối đi bộ cho khách vào'),
    T('Đèn lồng, bảng hiệu mặt tiền sáng / ngay ngắn', false),
  ] },
  { title: 'Trong ca Mặt tiền & giữ xe', phase: 'during', team: ['bảo vệ', 'giữ xe', 'tạp vụ'], items: [
    T('19:00 xếp lại xe gọn, không chắn cổng; nhặt tàn thuốc, rác', false),
    T('21:00 xếp lại xe gọn, không chắn cổng; nhặt tàn thuốc, rác', false),
  ] },
  { title: 'Đóng ca Mặt tiền & giữ xe', phase: 'close', team: ['bảo vệ', 'giữ xe', 'tạp vụ'], items: [
    T('Quét sân gạch mặt tiền'),
    T('Đem rác ra điểm tập kết đúng chỗ (không để trước nhà bên cạnh)'),
    T('Kéo đóng cổng lưới, khoá'),
    T('Tắt đèn bảng hiệu, đèn lồng', false),
    X('Xe khách còn gửi qua đêm / sự cố (ghi biển số nếu có)'),
  ] },
  // Bếp steak (8 ảnh 23/10) + định lượng Sổ 5: bò Aukobe 120g Steak Âu · 100g Combo 1, 2, món xào · 150g Combo 3; sốt 100g/dĩa;
  // salad 40g xà lách + dầu giấm; pate 30g; nui / mì Ý 80g chín (món thêm), 160g chín (món xào). Chia phần sẵn trước giờ đông.
  { title: 'Sơ chế & mở ca Bếp steak', rev: 2, phase: 'open', team: ['bếp steak', 'bếp'], items: [
    N('Nhiệt độ tủ mát trưng bày', '°C'),
    N('Nhiệt độ tủ đông', '°C'),
    N('Chia sẵn bò Aukobe 100g (Combo 1, 2, món xào)', 'phần'),
    N('Chia sẵn bò Aukobe 120g (Steak Âu)', 'phần'),
    N('Chia sẵn bò Aukobe 150g (Combo 3)', 'phần'),
    T('Sốt 4 loại chia hũ 100g · salad 40g · nui, mì Ý luộc sẵn · trứng, pate, xúc xích, bánh mì đủ', false),
    T('Gas: kiểm dây, van, thử lửa; đĩa gang làm nóng', false),
    T('Hàng vào tủ hết, không để thịt / rau / đồ dùng dưới sàn; đồ cá nhân cất ngoài bếp', false),
    T('📷 SƠ CHẾ XONG: chụp 1 ảnh toàn bộ khay chuẩn bị + mặt bếp'),
  ] },
  { title: 'Trong ca Bếp steak', rev: 2, phase: 'during', team: ['bếp steak', 'bếp'], items: [
    T('18:00 bò chia sẵn còn đủ cho giờ đông (thiếu thì chia thêm)', false),
  ] },
  { title: 'Dọn & đóng ca Bếp steak', rev: 2, phase: 'close', team: ['bếp steak', 'bếp'], items: [
    N('Bò đã chia phần còn lại', 'phần'),
    T('Bò, sốt, salad thừa bọc màng, ghi ngày, cất tủ', false),
    T('Rửa đĩa gang, khay gỗ, thớt, dao, bồn rửa; lau bếp, mặt bàn', false),
    T('Gia vị, túi bột đậy kín, lên kệ; đổ rác, lau sàn', false),
    N('Nhiệt độ tủ mát lúc đóng', '°C'),
    T('📷 KHOÁ GAS + chụp 1 ảnh toàn khu bếp sạch'),
    X('Hàng thiếu cần báo (bò, sốt, trứng, bánh mì…)'),
  ] },
];

// 11 checklist của bản đầu (23/10, settings.checklist_khu_v1)
const V1_TITLES = ['Mở ca Thái tay', 'Đóng ca Thái tay', 'Mở ca Topping', 'Đóng ca Topping', 'Mở ca Nước lẩu', 'Đóng ca Nước lẩu',
  'Mở ca Pha chế', 'Đóng ca Pha chế', 'Mở ca Tiếp thực', 'Đóng ca Tiếp thực', 'Đóng ca khu bán hàng'];

export function seedKhuChecklists(db) {
  const getSet = db.prepare('SELECT value FROM settings WHERE key = ?');
  let done;
  try { done = new Set(JSON.parse(getSet.get('checklist_khu_done')?.value || '[]')); } catch { done = new Set(); }
  // Bản đầu (23/10, checklist_khu_v1) đã tạo 11 checklist đầu: coi như xong, không tạo lại cái chủ quán đã xoá
  if (getSet.get('checklist_khu_v1')) for (const t of V1_TITLES) done.add(t);
  // Bản sửa (rev): checklist đã tạo trước thì thay danh sách việc 1 lần theo bản mới (vd Bếp steak bớt chụp ảnh 23/10)
  const resync = KHU_CHECKLISTS.filter((c) => c.rev && done.has(c.title) && !done.has(`${c.title}#${c.rev}`));
  const todo = KHU_CHECKLISTS.filter((c) => !done.has(c.title));
  if (!todo.length && !resync.length) return;
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
    for (const c of todo) {
      done.add(c.title);
      const pos = c.position ? findPos(c.position) : null;
      const team = pos ? teams.find((t) => t.id === pos.team_id) : findTeam(c.team);
      const title = team ? c.title : `${c.title} (chọn tổ)`;
      if (exists.get(c.title) || exists.get(title)) continue;
      const id = Number(addTpl.run(team?.id ?? null, c.phase, title, sort++, pos?.id ?? null, team ? 1 : 0).lastInsertRowid);
      c.items.forEach(([text, kind, unit, required, photo], i) => addItem.run(id, text, kind, unit, required, photo, i));
    }
    for (const c of resync) {
      done.add(`${c.title}#${c.rev}`);
      const t = db.prepare('SELECT id FROM checklist_templates WHERE lower(title) = lower(?)').get(c.title);
      if (!t) continue;
      db.prepare('DELETE FROM checklist_items WHERE template_id = ?').run(t.id);
      c.items.forEach(([text, kind, unit, required, photo], i) => addItem.run(t.id, text, kind, unit, required, photo, i));
    }
    for (const c of todo) if (c.rev) done.add(`${c.title}#${c.rev}`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('checklist_khu_done', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify([...done]));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
