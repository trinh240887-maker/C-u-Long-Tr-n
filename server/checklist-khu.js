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
  { title: 'Mở ca Thái tay', rev: 2, phase: 'open', position: ['thái tay', 'bò'], team: ['lẩu', 'bếp'], items: [
    N('Nhiệt độ tủ mát (đọc trên màn tủ)', '°C'),
    X('Bò tồn đầu ca: ghi từng loại (vd Thăn 3,2kg; Bắp hoa 2kg…)', 1),
    T('Rửa tay, găng mới, nón · cân điện tử về 0 · giấy thấm dầu, xà phòng, giấy lau tay đủ', false),
    T('Lau + lắp lưỡi máy thái, chạy thử · thớt, dao, khay sạch', false),
    T('Kiểm bình gas, van, dây', false),
    T('📷 MỞ CA: chụp 1 ảnh toàn quầy (máy thái, thớt, kính, mặt quầy)'),
  ] },
  { title: 'Đóng ca Thái tay', rev: 2, phase: 'close', position: ['thái tay', 'bò'], team: ['lẩu', 'bếp'], items: [
    X('Bò còn cuối ca: cân từng loại, ghi kg (vd Thăn 1,4kg; Gù 0,8kg…)', 1),
    T('📷 Lưỡi + khay máy thái đã tháo rửa, lau khô (chụp cận)'),
    T('Bò thừa bọc màng, ghi ngày, cất tủ', false),
    T('Lau kính chắn, mặt quầy, thớt, khay · thớt dựng giá', false),
    N('Nhiệt độ tủ mát lúc đóng', '°C'),
    T('Tắt máy lạnh, đèn quầy', false),
    T('📷 KHOÁ GAS + chụp 1 ảnh toàn quầy sạch'),
    X('Hàng thiếu cần báo (giấy thấm dầu, găng…)'),
  ] },
  { title: 'Mở ca Topping', rev: 2, phase: 'open', position: ['topping'], team: ['lẩu', 'bếp'], items: [
    N('Nhiệt độ tủ trưng bày', '°C'),
    T('Rửa tay, găng, nón · kiểm rau, nấm, topping còn tươi, bỏ đồ hư', false),
    T('Rau lẩu + salad rửa ráo · topping vào hộp đúng ngăn có nhãn', false),
    T('Dầu chiên còn tốt (đen thì thay) · bật bếp chiên, lò hâm · châm đá', false),
    T('📷 MỞ CA: chụp 1 ảnh tủ trưng bày đã bày xong'),
  ] },
  { title: 'Đóng ca Topping', rev: 2, phase: 'close', position: ['topping'], team: ['lẩu', 'bếp'], items: [
    X('Topping + bánh mì còn: từng loại, ghi số bịch + số viên/ổ lẻ', 1),
    T('📷 Bên trong tủ: topping thừa trong hộp có nắp, ghi ngày (chụp cận)'),
    T('Lọc / đổ dầu, vệ sinh bếp chiên · tắt bếp chiên, lò hâm', false),
    T('Lau kính, khay tủ · rửa rổ, bồn rửa, đổ rác · rau kê lên kệ', false),
    T('Đóng kín cửa tủ trưng bày', false),
    N('Nhiệt độ tủ lúc đóng', '°C'),
    T('📷 ĐÓNG CA: chụp 1 ảnh toàn quầy sạch'),
    X('Hàng thiếu cần báo'),
  ] },
  { title: 'Mở ca Nước lẩu', rev: 2, phase: 'open', position: ['nước lẩu', 'lẩu'], team: ['lẩu', 'bếp'], items: [
    X('Nước lẩu từng vị: ghi số lít (Mala, Cà chua, Nấm, Thảo mộc…)', 1),
    N('Bình gas đầy dự phòng', 'bình'),
    T('Van xả nồi điện đóng, bật CB, chỉnh nhiệt', false),
    T('Kiểm dây, van, mùi gas · thử lửa bếp 6 họng + bếp khè', false),
    T('Nếm đạt vị · sốt, nước chấm theo công thức · máy in có giấy', false),
    T('📷 MỞ CA: chụp 1 ảnh toàn quầy nước lẩu'),
  ] },
  { title: 'Đóng ca Nước lẩu', rev: 2, phase: 'close', position: ['nước lẩu', 'lẩu'], team: ['lẩu', 'bếp'], items: [
    X('Nước lẩu còn từng vị: ghi số lít', 1),
    T('📷 Nồi điện đã xả, rửa + CB đã tắt (chụp cận)'),
    T('Rửa nồi inox, lau bếp khè, bếp 6 họng, mặt quầy, kính', false),
    T('Sốt, gia vị đậy kín / bọc màng, ghi ngày · kệ dưới gọn', false),
    T('Lau sàn khu nấu', false),
    T('📷 KHOÁ VAN TẤT CẢ BÌNH GAS + chụp 1 ảnh toàn quầy sạch'),
    X('Hàng thiếu cần báo'),
  ] },
  { title: 'Mở ca Pha chế', rev: 2, phase: 'open', team: ['bar', 'pha chế'], items: [
    T('Lấy ly từ tủ ra', false),
    T('Siro, mứt, sữa còn hạn · ly nhựa, ống hút, khay xách · bình nước uống đủ', false),
    T('Máy in mini có giấy · kiểm van, dây gas', false),
    T('Đá đủ dùng', false),
    T('📷 MỞ CA: chụp 1 ảnh toàn quầy pha chế đã sẵn sàng'),
  ] },
  { title: 'Đóng ca Pha chế', rev: 2, phase: 'close', team: ['bar', 'pha chế'], items: [
    N('Đếm ly thuỷ tinh', 'ly'),
    X('Ly bể / thiếu: ghi số và lý do'),
    T('📷 Ly đã rửa, úp ráo, cất tủ inox dưới quầy, khoá (chụp tủ)'),
    T('Lau vòi bơm siro, đậy, cất · xả đá thừa, lau thùng đá, mở nắp', false),
    T('Cọ hố rửa, đổ rác · lau quầy, lau sàn chỗ đá chảy', false),
    T('Tắt quạt, đèn, rút điện máy in · che xe / kéo bạt', false),
    T('📷 KHOÁ GAS + chụp 1 ảnh toàn quầy sạch'),
    X('Hàng thiếu cần báo'),
  ] },
  { title: 'Mở ca Tiếp thực', rev: 2, phase: 'open', team: ['tiếp thực'], items: [
    N('Số bạn tiếp thực đi làm ca này', 'người'),
    N('Số mâm sạch đủ dùng', 'mâm'),
    T('📷 ĐẦU CA: chụp 1 ảnh cả tổ xếp hàng, đội nón, cầm mâm sạch'),
    X('Bạn nào thiếu nón / mâm (ghi tên + thiếu gì)'),
    N('Đếm xe cân bằng', 'xe'),
    T('Kiểm pin xe đủ chạy ca, xe yếu thì báo', false),
    T('Lau xe, bánh xe', false),
  ] },
  // Phục vụ: mỗi bạn 2 khăn sạch + nón. Tổ trưởng chụp 1 ảnh chung các bạn vào ĐÚNG ca; bạn vào trễ tự chụp khi chấm công (chủ quán 25/10)
  { title: 'Đầu ca Phục vụ: khăn + nón', phase: 'open', team: ['phục vụ'], items: [
    T('📷 ĐẦU CA: tổ trưởng chụp 1 ảnh các bạn vào đúng ca, cầm 2 khăn, đội nón (bạn vào trễ tự chụp khi chấm công)'),
    X('Bạn nào thiếu (ghi tên + thiếu gì)'),
  ] },
  { title: 'Cuối ca Phục vụ: gom khăn', phase: 'close', team: ['phục vụ'], items: [
    N('Số khăn bẩn gom vào giỏ giặt', 'cái'),
    T('Khăn đem giặt / phơi, cất khăn sạch cho ca sau', false),
  ] },
  { title: 'Đóng ca Tiếp thực', rev: 2, phase: 'close', team: ['tiếp thực'], items: [
    N('Đếm xe cân bằng', 'xe'),
    T('Lau bánh xe · rửa mâm, úp ráo, cất', false),
    T('📷 Xe đậu đúng chỗ, cắm sạc đủ (chụp chỗ sạc)'),
  ] },
  { title: 'Đóng ca khu bán hàng', rev: 2, phase: 'close', team: ['tạp vụ'], items: [
    T('Gom rác, đổ thùng · thu bạt, cụp dù · tắt đèn bảng hiệu, đèn dây', false),
    T('Lau sàn khu khách ngồi, xếp gọn bàn ghế', false),
    T('📷 ĐÓNG CA: chụp 1 ảnh toàn khu khách ngồi'),
  ] },
  // Lối đi chính giữa 2 dãy quầy + cổng vào từ đường (ảnh 23/10): nước đọng, vết dầu, rác + lá ở cổng và miệng cống, xe đẩy / thang để giữa lối
  { title: 'Mở ca Lối đi & cổng vào', rev: 2, phase: 'open', team: ['tạp vụ'], items: [
    T('Quét cổng vào + vỉa hè, vớt rác miệng cống, xịt vết dầu', false),
    T('Lối đi khô ráo (đọng nước thì gạt khô) · dọn xe đẩy, thang, thùng chắn lối', false),
    T('Mở dù, bảng hiệu, đèn lối đi', false),
    T('📷 MỞ CA: chụp 1 ảnh lối đi từ cổng nhìn vào'),
  ] },
  { title: 'Trong ca Lối đi', rev: 2, phase: 'during', team: ['tạp vụ'], items: [
    T('19:00 đi 1 vòng: lau chỗ đổ, nhặt rác, gạt nước đọng', false),
    T('21:00 đi 1 vòng: lau chỗ đổ, nhặt rác, gạt nước đọng', false),
  ] },
  { title: 'Đóng ca Lối đi & cổng vào', rev: 2, phase: 'close', team: ['tạp vụ'], items: [
    T('Quét + lau lối đi, gạt khô · xịt vết dầu · quét cổng, vớt cống', false),
    T('Cất xe đẩy, thang, thùng đúng chỗ · thu dù, kéo bạt', false),
    T('📷 ĐÓNG CA: chụp 1 ảnh lối đi từ cổng nhìn vào'),
    X('Chỗ hư cần sửa (sơn viền bong, gạch vỡ…)'),
  ] },
  // Mặt tiền ra đường (ảnh 23/10): sân gạch đỏ có tàn thuốc, giấy, túi nilon, lá, gạch vỡ; cổng lưới đỏ có bánh xe;
  // xe khách đậu trên sân gạch / sát lối vào; chậu cau lớn; rác nhà bên đặt sát cột điện
  { title: 'Mở ca Mặt tiền & giữ xe', rev: 2, phase: 'open', team: ['bảo vệ', 'giữ xe', 'tạp vụ'], items: [
    T('Mở cổng lưới, chặn bánh · dọn gạch vỡ, vật cản trước cổng', false),
    T('Quét + lau sân gạch đỏ: tàn thuốc, giấy, túi nilon, lá · tưới cây', false),
    T('Đèn lồng, bảng hiệu sáng, ngay ngắn · khu để xe chừa lối đi bộ', false),
    T('📷 MỞ CA: chụp 1 ảnh mặt tiền từ ngoài đường'),
  ] },
  { title: 'Trong ca Mặt tiền & giữ xe', rev: 2, phase: 'during', team: ['bảo vệ', 'giữ xe', 'tạp vụ'], items: [
    T('19:00 xếp lại xe gọn, không chắn cổng; nhặt tàn thuốc, rác', false),
    T('21:00 xếp lại xe gọn, không chắn cổng; nhặt tàn thuốc, rác', false),
  ] },
  { title: 'Đóng ca Mặt tiền & giữ xe', rev: 2, phase: 'close', team: ['bảo vệ', 'giữ xe', 'tạp vụ'], items: [
    T('Quét sân · đem rác ra điểm tập kết đúng chỗ · tắt đèn bảng hiệu', false),
    T('📷 Kéo đóng cổng lưới, khoá (chụp ổ khoá)'),
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
  // Checklist chung cũ của Phục vụ: bỏ chụp từng việc (kiểm tra ngẫu nhiên thay), 1 lần
  if (!getSet.get('phuc_vu_gon_v1')) {
    db.prepare("UPDATE checklist_items SET photo_required = 0 WHERE template_id IN (SELECT id FROM checklist_templates WHERE title IN ('Mở ca phục vụ', 'Đóng ca phục vụ'))").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('phuc_vu_gon_v1', '1')").run();
  }
  // 25/10: bỏ 2 dòng đếm số người ở "Đầu ca Phục vụ: khăn + nón", đổi chữ việc chụp ảnh (giữ ảnh mẫu, lịch sử)
  if (!getSet.get('pv_khan_non_v2')) {
    const t = db.prepare("SELECT id FROM checklist_templates WHERE title = 'Đầu ca Phục vụ: khăn + nón'").get();
    if (t) {
      db.prepare("DELETE FROM checklist_items WHERE template_id = ? AND text IN ('Số bạn phục vụ đi làm ca này', 'Số bạn đủ 2 khăn sạch + nón')").run(t.id);
      db.prepare("UPDATE checklist_items SET text = ? WHERE template_id = ? AND text = '📷 ĐẦU CA: chụp 1 ảnh cả tổ xếp hàng, cầm 2 khăn, đội nón'")
        .run('📷 ĐẦU CA: tổ trưởng chụp 1 ảnh các bạn vào đúng ca, cầm 2 khăn, đội nón (bạn vào trễ tự chụp khi chấm công)', t.id);
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('pv_khan_non_v2', '1')").run();
  }
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
