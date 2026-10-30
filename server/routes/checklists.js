import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDate, addDays } from '../lib/time.js';

const PHASES = ['open', 'during', 'close'];

// Đổi số nhân viên nhập (theo đơn vị của việc) sang đơn vị dùng của nguyên liệu
const UNIT_CONV = { 'kg>g': 1000, 'g>kg': 0.001, 'lít>ml': 1000, 'l>ml': 1000, 'ml>lít': 0.001, 'ml>l': 0.001 };
export function unitFactor(unit, ing) {
  const u = String(unit || '').trim().toLowerCase();
  const base = String(ing.unit || '').trim().toLowerCase();
  if (!u || u === base) return 1;
  if (ing.purchase_unit && u === String(ing.purchase_unit).trim().toLowerCase()) return ing.purchase_factor || 1;
  return UNIT_CONV[`${u}>${base}`] ?? null;
}

// Đếm theo bao bì: đơn vị của việc = đơn vị mua (bịch, gói, thùng…) của nguyên liệu tính theo cái (viên, cái, lon…)
// → nhân viên nhập số bịch nguyên + số lẻ; cân theo khối lượng (g, ml) thì vẫn 1 ô
export function packMode(unit, ing) {
  if (!ing || ['g', 'ml'].includes(String(ing.unit || '').toLowerCase())) return false;
  const u = String(unit || '').trim().toLowerCase();
  return !!ing.purchase_unit && u === String(ing.purchase_unit).trim().toLowerCase() && (ing.purchase_factor || 1) > 1;
}

export default function (r, ctx) {
  const { db } = ctx;
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  // Việc "Nhập số" nối kho: số nhân viên cân = tồn thực tế của nguyên liệu ở kho đó → app tự kiểm kho, tính lệch định lượng
  addCol('checklist_items', 'ingredient_id', 'INTEGER');
  addCol('checklist_items', 'extra_ingredient_ids', "TEXT NOT NULL DEFAULT '[]'"); // cân chung nhiều loại (vd thịt tươi: thăn, bắp hoa, gù, gầu)
  addCol('checklist_items', 'store_id', 'INTEGER');
  addCol('checklist_entries', 'count_id', 'INTEGER');
  // Ai làm (chủ quán 24/10): '' = theo tổ / vị trí / khu · 'lead' = trưởng ca · 'manager' = quản lý · 'staff:<id>' = 1 người cụ thể
  addCol('checklist_templates', 'doer', "TEXT NOT NULL DEFAULT ''");
  // Mục (tab ngang trên trang Checklist): Bếp, Phục vụ, Thu ngân, Tổng khu A, Khu vực vệ sinh… Trống = tự suy
  addCol('checklist_templates', 'section', "TEXT NOT NULL DEFAULT ''");
  // Chế tài nếu không làm / làm sai (chủ quán tự ghi), hiện cho nhân viên trên đầu checklist
  addCol('checklist_templates', 'rules', "TEXT NOT NULL DEFAULT ''");
  // Giao việc từng người (chủ quán 25/10): checklist bật chế độ này → mỗi việc thành 1 thẻ việc giao cho 1 người trong khu
  // (màn Việc ca), có giờ nhận / giờ xong, tổ trưởng khu kiểm. job_teams = các bộ phận dùng chung (vd Phục vụ + Tiếp thực)
  addCol('checklist_templates', 'job_mode', 'INTEGER NOT NULL DEFAULT 0');
  addCol('checklist_templates', 'job_teams', "TEXT NOT NULL DEFAULT '[]'");
  addCol('checklist_templates', 'job_from', 'INTEGER'); // khung giờ làm (phút trong ngày), vd mở ca 14:00–15:30: chỉ người có ca trùng khung này được phân
  addCol('checklist_templates', 'job_to', 'INTEGER');
  addCol('checklist_items', 'job_minutes', 'INTEGER NOT NULL DEFAULT 0');      // thời gian chuẩn (phút)
  addCol('checklist_items', 'job_scope', "TEXT NOT NULL DEFAULT 'zone'");     // zone = mỗi khu 1 người · shop = cả quán 1 người
  addCol('checklist_items', 'job_qty', "TEXT NOT NULL DEFAULT ''");           // số lượng ghi tay: "200 muỗng"
  addCol('checklist_items', 'job_per_table', 'REAL NOT NULL DEFAULT 0');      // số lượng theo số bàn của khu (vd 1 bếp ga / bàn)
  addCol('checklist_items', 'fetch_where', "TEXT NOT NULL DEFAULT ''");
  addCol('checklist_items', 'job_with', 'INTEGER NOT NULL DEFAULT 0');        // đi kèm việc khác: giao cho đúng người làm việc đó (vd lau chén → giặt khăn lau chén)
  addCol('checklist_items', 'job_zone_id', 'INTEGER');
  addCol('checklist_items', 'job_guide', "TEXT NOT NULL DEFAULT ''");          // hướng dẫn cách làm (chủ quán 27/10)
  addCol('checklist_items', 'job_deadline', 'INTEGER');                       // phải xong trước (phút trong ngày), vd 14:30 = 870
  addCol('checklist_templates', 'job_note', "TEXT NOT NULL DEFAULT ''");     // lưu ý chung cho mọi người (vd giờ ăn cơm 15h35–15h55)
  addCol('checklist_items', 'job_crew', "TEXT NOT NULL DEFAULT '[]'");       // việc chung nhiều bạn cùng làm: mỗi bạn 1 thẻ (chủ quán 27/10)
  addCol('checklist_templates', 'job_lead_mode', 'INTEGER NOT NULL DEFAULT 0'); // giao cả khu cho người phụ trách (đóng ca)
  addCol('checklist_templates', 'job_lead_pool', 'INTEGER NOT NULL DEFAULT 0'); // chủ quán 28/10: không chia việc từng người; trưởng ca + tổ trưởng thấy hết, tự điều người, mọi việc chụp ảnh
  addCol('checklist_items', 'job_ask_note', 'INTEGER NOT NULL DEFAULT 0');    // bắt nhân viên ghi chú khi xong (vd báo tình trạng khu rửa chén)
  addCol('checklist_items', 'job_role', "TEXT NOT NULL DEFAULT ''");          // '' ai cũng được · lead = chỉ tổ trưởng / trưởng ca (chủ quán 27/10)
  addCol('checklist_items', 'job_gender', "TEXT NOT NULL DEFAULT ''");        // '' ai cũng được · nu chỉ nữ · nam chỉ nam
  addCol('checklist_items', 'job_fixed_staff', 'INTEGER');                   // việc chung: người làm cố định (chủ quán tự chọn), ngày nào có ca thì giao người này
  addCol('checklist_items', 'job_photos', 'INTEGER NOT NULL DEFAULT 0');      // số ảnh rộng phải chụp khi xong (0 = theo photo_required)                       // việc riêng của 1 khu (chủ quán 27/10); trống = khu nào cũng làm
  addCol('checklist_items', 'job_expect', 'INTEGER NOT NULL DEFAULT 0');
  addCol('checklist_items', 'deleted_at', 'INTEGER'); // xoá mềm (rà soát 28/10): giữ lịch sử đã làm, ảnh, việc ca cũ      // số phải đủ khi xong (vd 2 khăn); thiếu → ghi vào tên người làm       // hết đồ thì lấy ở đâu
  const hadMoCa = !!ctx.setting('mo_ca_pv_v1'); // DB đang chạy thật (đã qua bản 26/10) — DB mới tạo thì không ẩn gì
  // Chủ quán 26/10: 12 việc mở ca chung Phục vụ + Tiếp thực (14:00–15:30), giao từng người; làm 1 lần
  if (!ctx.setting('mo_ca_pv_v1')) {
    const team = (n) => db.prepare('SELECT id FROM teams WHERE name = ?').get(n)?.id;
    const pv = team('Phục vụ'), tt = team('Tiếp thực');
    const TASKS = [
      ['Lau dụng cụ ăn uống', 'zone', 20, 1, 0, '', /lau.*(dụng cụ|chén|muỗng|ly)/i],
      ['Sắp bàn, kéo dù (bảo vệ cũng có thể làm)', 'zone', 15, 1, 0, '', /setup bàn|sắp bàn|dù/i],
      ['Rửa sàn xi măng', 'shop', 20, 1, 0, '', /sàn|sân/i],
      ['Chuẩn bị combo (bếp gas, tương ớt, tương cà, muỗng, đũa, tăm, giấy)', 'zone', 20, 1, 1, 'combo', /bếp lẩu|bình gas|combo|tương/i],
      ['Chuẩn bị sọt rác', 'zone', 5, 0, 0, '', /rác/i],
      ['Phân chia muỗng đũa dự trù', 'zone', 10, 0, 0, '', /muỗng đũa|đũa/i],
      ['Chuẩn bị quạt các khu', 'zone', 5, 0, 0, '', /quạt/i],
      ['Kiểm tra gas, giấy, hộp mang về, bọc dự trù', 'shop', 10, 0, 0, '', /hộp|mang về|bọc/i],
      ['Kiểm tra nhà vệ sinh', 'shop', 5, 1, 0, '', /vệ sinh|wc/i],
      ['Chuẩn bị chén để khách tự lấy', 'zone', 10, 1, 0, '', /chén.*tự lấy|tự lấy/i],
      ['Bố trí quầy nước chấm tự pha', 'shop', 15, 1, 0, '', /nước chấm/i],
      ['Chuẩn bị khay đựng đồ ăn xong của khách các khu', 'zone', 5, 0, 0, '', /khay/i],
    ];
    if (pv) {
      let t = db.prepare("SELECT id FROM checklist_templates WHERE active = 1 AND title LIKE 'Mở ca phục vụ%' ORDER BY id").get()
        || db.prepare("SELECT id FROM checklist_templates WHERE active = 1 AND team_id = ? AND phase = 'open' AND zone_id IS NULL ORDER BY id").get(pv);
      tx(db, () => {
        if (!t) t = { id: Number(db.prepare("INSERT INTO checklist_templates (team_id, phase, title, sort) VALUES (?, 'open', 'Mở ca phục vụ', 0)").run(pv).lastInsertRowid) };
        db.prepare('UPDATE checklist_templates SET job_mode = 1, job_teams = ?, job_from = 840, job_to = 930 WHERE id = ?')
          .run(JSON.stringify([pv, tt, -1].filter(Boolean)), t.id);
        const old = db.prepare('SELECT id, text FROM checklist_items WHERE template_id = ? ORDER BY sort, id').all(t.id);
        const used = new Set();
        TASKS.forEach(([text, scope, min, photo, per, unit, re], i) => {
          const hit = old.find((o) => !used.has(o.id) && re.test(o.text)); // giữ ảnh mẫu của việc cũ giống
          const v = [text, scope, min, photo, per, unit, i];
          if (hit) {
            used.add(hit.id);
            db.prepare("UPDATE checklist_items SET text = ?, kind = 'check', job_scope = ?, job_minutes = ?, photo_required = ?, job_per_table = ?, unit = ?, sort = ?, required = 1, job_qty = '', job_with = 0, job_expect = 0 WHERE id = ?").run(...v, hit.id);
          } else {
            db.prepare("INSERT INTO checklist_items (template_id, text, kind, job_scope, job_minutes, photo_required, job_per_table, unit, sort, required) VALUES (?, ?, 'check', ?, ?, ?, ?, ?, ?, 1)").run(t.id, ...v);
          }
        });
        for (const o of old) if (!used.has(o.id)) db.prepare('DELETE FROM checklist_items WHERE id = ?').run(o.id);
      });
      ctx.setSetting('mo_ca_pv_split', String(t.id)); // jobs.js chia việc lại 1 lần
    }
    ctx.setSetting('mo_ca_pv_v1', '1');
  }
  // Chủ quán 26/10: người chuẩn bị combo lau luôn dụng cụ ăn uống (2 việc riêng, cùng 1 người)
  if (!ctx.setting('mo_ca_pv_v2')) {
    const t = db.prepare("SELECT id FROM checklist_templates WHERE active = 1 AND title LIKE 'Mở ca phục vụ%' ORDER BY id").get();
    const it = (re) => t && db.prepare('SELECT id, text FROM checklist_items WHERE template_id = ?').all(t.id).find((x) => re.test(x.text));
    const lau = it(/^Lau dụng cụ ăn uống/i), combo = it(/combo/i);
    if (lau && combo) {
      db.prepare('UPDATE checklist_items SET job_with = ? WHERE id = ?').run(combo.id, lau.id);
      ctx.setSetting('mo_ca_pv_split', String(t.id));
    }
    ctx.setSetting('mo_ca_pv_v2', '1');
  }
  // Chủ quán 27/10: ẩn hết checklist Phục vụ & Tiếp thực để làm lại (giữ ảnh / kết quả cũ; bật lại được ở Tạo / sửa checklist). Bỏ việc ca chưa làm từ hôm nay
  if (!ctx.setting('pv_tt_hide_v1')) {
    if (hadMoCa) {
      const ids = db.prepare(`SELECT c.id FROM checklist_templates c LEFT JOIN teams t ON t.id = c.team_id
        WHERE c.active = 1 AND (t.name LIKE '%Phục vụ%' OR t.name LIKE '%phục vụ%' OR t.name LIKE '%Tiếp thực%' OR t.name LIKE '%tiếp thực%' OR c.section IN ('Phục vụ', 'Tiếp thực', 'Phục vụ & Tiếp thực'))`).all().map((x) => x.id);
      for (const id of ids) {
        db.prepare('UPDATE checklist_templates SET active = 0 WHERE id = ?').run(id);
        try { db.prepare("DELETE FROM jobs WHERE template_id = ? AND date >= ? AND status = 'todo'").run(id, ctx.today()); } catch { /* chưa có bảng việc ca */ }
      }
      ctx.setSetting('pv_tt_hidden_ids', JSON.stringify(ids));
    }
    ctx.setSetting('pv_tt_hide_v1', '1');
  }
  // Chủ quán 27/10 (sửa lại): chỉ bỏ các VIỆC để ghi lại, giữ checklist → bật lại checklist đã ẩn, chuyển việc cũ sang bản lưu ẩn "(việc cũ 27/10)" (giữ lịch sử, ảnh)
  if (!ctx.setting('pv_tt_restore_v1')) {
    let ids = [];
    try { ids = JSON.parse(ctx.setting('pv_tt_hidden_ids') || '[]'); } catch { ids = []; }
    tx(db, () => {
      for (const id of ids) {
        const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(id);
        if (!t) continue;
        db.prepare('UPDATE checklist_templates SET active = 1 WHERE id = ?').run(id);
        if (!db.prepare('SELECT 1 FROM checklist_items WHERE template_id = ?').get(id)) continue;
        const arch = Number(db.prepare("INSERT INTO checklist_templates (team_id, phase, title, sort, active) VALUES (?, ?, ?, ?, 0)").run(t.team_id, t.phase, `${t.title} (việc cũ 27/10)`, t.sort).lastInsertRowid);
        db.prepare('UPDATE checklist_samples SET template_id = ? WHERE item_id IN (SELECT id FROM checklist_items WHERE template_id = ?)').run(arch, id);
        db.prepare('UPDATE checklist_items SET template_id = ? WHERE template_id = ?').run(arch, id);
      }
    });
    ctx.setSetting('pv_tt_restore_v1', '1');
  }
  // Chủ quán 27/10: ở Mở ca / Đầu ca phục vụ, việc không gắn khu = việc chung cả quán (1 người), không chia mỗi khu
  // DB mới: đánh dấu đã làm luôn, không chạy ở lần khởi động sau (rà soát 28/10)
  if (!ctx.setting('common_shop_v1') && !hadMoCa) ctx.setSetting('common_shop_v1', '1');
  if (!ctx.setting('common_shop_v1')) { // chỉ DB đang chạy thật (DB mới giữ 12 việc mẫu chia mỗi khu)
    db.prepare(`UPDATE checklist_items SET job_scope = 'shop' WHERE job_zone_id IS NULL AND job_scope = 'zone' AND template_id IN
      (SELECT id FROM checklist_templates WHERE title LIKE '%ở ca phục vụ%' OR title LIKE '%ầu ca Phục vụ%' OR title LIKE '%ầu ca phục vụ%')`).run();
    try { db.prepare(`DELETE FROM jobs WHERE status = 'todo' AND zone_id != 0 AND item_id IN (SELECT id FROM checklist_items WHERE job_scope = 'shop')`).run(); } catch { /* chưa có bảng jobs */ }
    ctx.setSetting('common_shop_v1', '1');
  }
  // Chủ quán 27/10: "ăn cơm từ 15h35 đến 15h55" là giờ ăn của mọi người, không phải việc của 1 khu → chuyển thành lưu ý chung
  if (!ctx.setting('com_note_v1')) {
    for (const it of db.prepare("SELECT i.id, i.text, i.template_id FROM checklist_items i JOIN checklist_templates t ON t.id = i.template_id WHERE t.title LIKE '%ở ca phục vụ%' AND i.text LIKE '%ăn cơm%'").all()) {
      const cur = db.prepare('SELECT job_note FROM checklist_templates WHERE id = ?').get(it.template_id).job_note || '';
      const line = `🍚 ${it.text.charAt(0).toUpperCase()}${it.text.slice(1)} (tất cả nhân sự)`;
      db.prepare('UPDATE checklist_templates SET job_note = ? WHERE id = ?').run(cur ? `${cur}\n${line}` : line, it.template_id);
      try { db.prepare('DELETE FROM jobs WHERE item_id = ?').run(it.id); } catch { /* chưa có bảng jobs */ }
      db.prepare('DELETE FROM checklist_items WHERE id = ?').run(it.id);
    }
    ctx.setSetting('com_note_v1', '1');
  }
  // Chủ quán 27/10: bỏ thẻ "Đầu ca Phục vụ: khăn + nón" → tắt (giữ dữ liệu, bật lại ở Tạo / sửa checklist)
  if (!ctx.setting('dau_ca_off_v1')) {
    db.prepare("UPDATE checklist_templates SET active = 0 WHERE title = 'Đầu ca Phục vụ: khăn + nón'").run();
    try { db.prepare("DELETE FROM jobs WHERE status = 'todo' AND template_id IN (SELECT id FROM checklist_templates WHERE title = 'Đầu ca Phục vụ: khăn + nón')").run(); } catch { /* chưa có bảng jobs */ }
    ctx.setSetting('dau_ca_off_v1', '1');
  }
  // Chủ quán 27/10: Đóng ca phục vụ bị đặt khung 14:00–15:30 của mở ca → bỏ khung (đóng ca = người ở lại giờ cuối)
  if (!ctx.setting('dong_ca_win_v1')) {
    db.prepare("UPDATE checklist_templates SET job_from = NULL, job_to = NULL WHERE phase = 'close' AND job_from IS NOT NULL AND job_from < 1020 AND title LIKE '%óng ca%'").run();
    ctx.setSetting('dong_ca_win_v1', '1');
  }
  const PV_TT = 'Phục vụ & Tiếp thực'; // chủ quán 27/10: gom Phục vụ + Tiếp thực làm 1 mục
  const sectionOf = (t) => {
    if (t.section) return /^(phục vụ|tiếp thực)$/i.test(t.section.trim()) ? PV_TT : t.section;
    if (!t.zone_name && /phục vụ|phuc vu|tiếp thực|tiep thuc/i.test(t.team_name || '')) return PV_TT;
    if (t.zone_name) return `Tổng ${t.zone_name.toLowerCase().startsWith('khu') ? t.zone_name.replace(/^Khu/i, 'khu') : `khu ${t.zone_name}`}`;
    if (/vệ sinh|wc|toilet/i.test(t.title)) return 'Khu vực vệ sinh';
    if (/rửa chén|rửa bát/i.test(t.title)) return 'Khu vực rửa chén';
    return t.team_name || 'Cả quán';
  };

  function templates({ activeOnly = true } = {}) {
    const tpls = db.prepare(`SELECT c.*, t.name AS team_name, st.name AS shift_name, p.name AS position_name, z.name AS zone_name FROM checklist_templates c LEFT JOIN teams t ON t.id = c.team_id
      LEFT JOIN shift_templates st ON st.id = c.shift_template_id LEFT JOIN positions p ON p.id = c.position_id LEFT JOIN zones z ON z.id = c.zone_id
      ${activeOnly ? 'WHERE c.active = 1' : ''} ORDER BY t.sort, CASE c.phase WHEN 'open' THEN 0 WHEN 'during' THEN 1 ELSE 2 END, c.sort, c.id`).all();
    const items = db.prepare(`SELECT i.*, g.name AS ingredient_name, g.unit AS ingredient_unit, g.purchase_unit AS ingredient_pack, g.purchase_factor AS ingredient_factor, st.name AS store_name FROM checklist_items i
      LEFT JOIN ingredients g ON g.id = i.ingredient_id LEFT JOIN stores st ON st.id = i.store_id WHERE i.deleted_at IS NULL ORDER BY i.sort, i.id`).all();
    const samples = db.prepare('SELECT id, template_id, item_id, note FROM checklist_samples ORDER BY id').all();
    const doerName = (d) => (d === 'lead' ? 'Trưởng ca' : d === 'manager' ? 'Quản lý' : /^staff:\d+$/.test(d || '') ? db.prepare('SELECT name FROM staff WHERE id = ?').get(Number(d.slice(6)))?.name || '?' : '');
    return tpls.map((c) => ({
      ...c, active: !!c.active, job_mode: !!c.job_mode, job_teams: JSON.parse(c.job_teams || '[]'), doer_name: doerName(c.doer), section_label: sectionOf(c),
      samples: samples.filter((x) => x.template_id === c.id && !x.item_id),
      items: items.filter((i) => i.template_id === c.id).map((i) => ({ ...i, extra_ingredient_ids: JSON.parse(i.extra_ingredient_ids || '[]'),
        group_names: JSON.parse(i.extra_ingredient_ids || '[]').length ? [i.ingredient_id, ...JSON.parse(i.extra_ingredient_ids)].map((id) => db.prepare('SELECT name FROM ingredients WHERE id = ?').get(id)?.name).filter(Boolean) : [], pack_mode: !!i.ingredient_id && packMode(i.unit, { unit: i.ingredient_unit, purchase_unit: i.ingredient_pack, purchase_factor: i.ingredient_factor }), required: !!i.required, photo_required: !!i.photo_required, samples: samples.filter((x) => x.item_id === i.id) })),
    }));
  }

  ctx.checklistTemplates = templates;
  // Chủ quán 27/10: Tạp vụ, Bar, Bếp — giữ checklist, chỉ bỏ các VIỆC để ghi lại (chuyển sang bản lưu ẩn "(việc cũ 27/10)"); giữ dòng kiểm kho (nối nguyên liệu)
  // DB mới: đánh dấu đã làm luôn — trước đây lần khởi động thứ 2 chuyển hết việc Bếp / Bar / Tạp vụ sang bản ẩn (rà soát 28/10)
  if (!ctx.setting('tv_bar_bep_clear_v1') && !hadMoCa) ctx.setSetting('tv_bar_bep_clear_v1', '1');
  if (!ctx.setting('tv_bar_bep_clear_v1')) {
    tx(db, () => {
      for (const t of templates()) {
        if (/\(việc cũ/i.test(t.title)) continue;
        if (!/^(bếp|bar|tạp vụ)/i.test(t.section_label || '') && !/bếp|lẩu|bar|tạp vụ/i.test(t.team_name || '')) continue;
        const move = db.prepare('SELECT id FROM checklist_items WHERE template_id = ? AND ingredient_id IS NULL AND deleted_at IS NULL').all(t.id).map((x) => x.id);
        if (!move.length) continue;
        const arch = Number(db.prepare('INSERT INTO checklist_templates (team_id, phase, title, sort, active) VALUES (?, ?, ?, ?, 0)').run(t.team_id, t.phase, `${t.title} (việc cũ 27/10)`, t.sort).lastInsertRowid);
        for (const id of move) {
          db.prepare('UPDATE checklist_samples SET template_id = ? WHERE item_id = ?').run(arch, id);
          db.prepare('UPDATE checklist_items SET template_id = ? WHERE id = ?').run(arch, id);
          try { db.prepare("DELETE FROM jobs WHERE item_id = ? AND status = 'todo'").run(id); } catch { /* chưa có bảng jobs */ }
        }
      }
    });
    ctx.setSetting('tv_bar_bep_clear_v1', '1');
  }
  r.get('/api/checklist-templates', 'staff', ({ query }) => templates({ activeOnly: query.get('all') !== '1' }));

  function saveItems(templateId, items) {
    if (!Array.isArray(items) || !items.length) fail(400, 'Checklist cần ít nhất một việc');
    if (items.length > 60) fail(400, 'Tối đa 60 việc trong một checklist');
    const existing = new Set(db.prepare('SELECT id FROM checklist_items WHERE template_id = ? AND deleted_at IS NULL').all(templateId).map((x) => x.id));
    const keep = new Set();
    const ids = [];
    items.forEach((it, i) => {
      const text = v.text(it.text, { name: 'Tên việc', required: true, max: 120 });
      const kind = v.oneOf(it.kind ?? 'check', ['check', 'number', 'text'], { name: 'Kiểu việc' });
      const unit = v.text(it.unit, { name: 'Đơn vị', max: 12 });
      const required = it.required === undefined ? 1 : v.bool(it.required);
      const photo = it.photo_required === undefined ? (kind === 'check' ? 1 : 0) : v.bool(it.photo_required);
      let extra = [];
      let ingId = kind === 'number' ? v.optInt(it.ingredient_id || null, { min: 1, name: 'Nguyên liệu' }) : null;
      let storeId = null;
      if (ingId) {
        const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ingId);
        if (!ing) fail(400, 'Nguyên liệu không tồn tại');
        if (unitFactor(unit, ing) == null) fail(400, `"${text}": đơn vị "${unit}" không đổi được sang ${ing.unit} của ${ing.name}. Dùng ${[ing.unit, ing.purchase_unit, ing.unit === 'g' ? 'kg' : ''].filter(Boolean).join(' / ')}`);
        storeId = v.optInt(it.store_id || null, { min: 1, name: 'Kho' }) || ing.home_store_id
          || db.prepare("SELECT id FROM stores WHERE kind = 'main' AND active = 1 ORDER BY id LIMIT 1").get()?.id || null;
        if (!storeId || !db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) fail(400, `"${text}": chọn kho để nối`);
        extra = (Array.isArray(it.extra_ingredient_ids) ? it.extra_ingredient_ids : []).map(Number).filter((x) => x && x !== ingId);
        for (const x of extra) {
          const g2 = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(x);
          if (!g2) fail(400, 'Nguyên liệu cân chung không tồn tại');
          if (g2.unit !== ing.unit) fail(400, `"${text}": ${g2.name} khác đơn vị (${g2.unit}), không cân chung với ${ing.name} (${ing.unit}) được`);
        }
      } else ingId = null;
      const job = { minutes: it.job_minutes ? v.int(it.job_minutes, { min: 0, max: 600, name: 'Thời gian chuẩn' }) : 0, scope: ['shop', 'each'].includes(it.job_scope) ? it.job_scope : 'zone', expect: it.job_expect ? v.int(it.job_expect, { min: 0, max: 999, name: 'Số phải đủ' }) : 0,
        qty: v.text(it.job_qty, { name: 'Số lượng', max: 40 }), perTable: it.job_per_table ? Number(it.job_per_table) || 0 : 0, fetch: v.text(it.fetch_where, { name: 'Chỗ lấy đồ', max: 80 }) };
      if (job.perTable < 0 || job.perTable > 50) fail(400, `"${text}": số lượng mỗi bàn không hợp lệ`);
      if (it.id && existing.has(Number(it.id))) {
        db.prepare('UPDATE checklist_items SET text = ?, kind = ?, unit = ?, required = ?, photo_required = ?, ingredient_id = ?, store_id = ?, extra_ingredient_ids = ?, sort = ? WHERE id = ?').run(text, kind, unit, required, photo, ingId, storeId, JSON.stringify(extra), i, Number(it.id));
        db.prepare('UPDATE checklist_items SET job_minutes = ?, job_scope = ?, job_qty = ?, job_per_table = ?, fetch_where = ?, job_expect = ? WHERE id = ?').run(job.minutes, job.scope, job.qty, job.perTable, job.fetch, job.expect, Number(it.id));
        if (it.job_zone_id !== undefined) db.prepare('UPDATE checklist_items SET job_zone_id = ? WHERE id = ?').run(Number(it.job_zone_id) || null, Number(it.id));
        keep.add(Number(it.id));
        ids[i] = Number(it.id);
      } else {
        db.prepare('INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, ingredient_id, store_id, extra_ingredient_ids, sort, job_minutes, job_scope, job_qty, job_per_table, fetch_where, job_expect) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(templateId, text, kind, unit, required, photo, ingId, storeId, JSON.stringify(extra), i, job.minutes, job.scope, job.qty, job.perTable, job.fetch, job.expect);
        ids[i] = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
      }
    });
    // Đi kèm việc: client gửi job_with_idx (vị trí việc chính trong danh sách) hoặc job_with (id)
    items.forEach((it, i) => {
      let w = 0;
      if (it.job_with_idx !== undefined && it.job_with_idx !== null && it.job_with_idx !== '') { const k = Number(it.job_with_idx); if (k !== i && ids[k]) w = ids[k]; }
      else if (it.job_with && ids.includes(Number(it.job_with)) && Number(it.job_with) !== ids[i]) w = Number(it.job_with);
      if (w && items[ids.indexOf(w)]?.job_with_idx !== undefined && Number(items[ids.indexOf(w)].job_with_idx) === i) w = 0; // không cho 2 việc kèm nhau vòng tròn
      db.prepare('UPDATE checklist_items SET job_with = ? WHERE id = ?').run(w, ids[i]);
    });
    for (const id of existing) if (!keep.has(id)) softDelete(id);
  }
  // Xoá mềm 1 việc (rà soát 28/10): ẩn khỏi checklist, giữ lịch sử (đã làm, ảnh, việc ca cũ); chỉ bỏ việc ca chưa làm từ hôm nay
  function softDelete(id) {
    db.prepare('UPDATE checklist_items SET deleted_at = ? WHERE id = ?').run(ctx.now(), id);
    try { db.prepare("DELETE FROM jobs WHERE item_id = ? AND status = 'todo' AND date >= ?").run(id, ctx.today()); } catch { /* chưa có bảng jobs */ }
  }

  function tplFields(body, cur = {}) {
    const title = body.title === undefined ? cur.title : v.text(body.title, { name: 'Tên checklist', required: true, max: 80 });
    const teamId = body.team_id === undefined ? cur.team_id ?? null : v.optInt(body.team_id, { min: 1, name: 'Tổ' });
    if (teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) fail(400, 'Tổ không tồn tại');
    const phase = body.phase === undefined ? cur.phase ?? 'open' : v.oneOf(body.phase, PHASES, { name: 'Thời điểm' });
    const shiftId = body.shift_template_id === undefined ? cur.shift_template_id ?? null : v.optInt(body.shift_template_id, { min: 1, name: 'Ca' });
    if (shiftId && !db.prepare('SELECT 1 FROM shift_templates WHERE id = ?').get(shiftId)) fail(400, 'Loại ca không tồn tại');
    const positionId = !teamId ? null : body.position_id === undefined && body.team_id === undefined ? cur.position_id ?? null
      : ctx.readPosition(body.position_id === undefined ? cur.position_id : body.position_id, teamId);
    const zoneId = body.zone_id === undefined ? cur.zone_id ?? null : v.optInt(body.zone_id, { min: 1, name: 'Khu' });
    if (zoneId && !db.prepare('SELECT 1 FROM zones WHERE id = ?').get(zoneId)) fail(400, 'Khu không tồn tại');
    let doer = body.doer === undefined ? cur.doer ?? '' : String(body.doer || '');
    if (!['', 'lead', 'manager'].includes(doer)) {
      const m = /^staff:(\d+)$/.exec(doer);
      if (!m || !db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1').get(Number(m[1]))) fail(400, 'Người làm không hợp lệ');
    }
    const section = body.section === undefined ? cur.section ?? '' : v.text(body.section, { name: 'Mục', max: 40 });
    const rules = body.rules === undefined ? cur.rules ?? '' : v.text(body.rules, { name: 'Chế tài', max: 500 });
    const jobMode = body.job_mode === undefined ? cur.job_mode ?? 0 : v.bool(body.job_mode);
    const jobTeams = body.job_teams === undefined ? cur.job_teams ?? '[]' : JSON.stringify((Array.isArray(body.job_teams) ? body.job_teams : []).map(Number).filter((x) => x === -1 || db.prepare('SELECT 1 FROM teams WHERE id = ?').get(x)));
    const hm = (x, label) => { if (x === '' || x == null) return null; const m = /^(\d{1,2}):(\d{2})$/.exec(String(x)); if (!m || +m[1] > 29 || +m[2] > 59) fail(400, `${label} không hợp lệ (vd 14:00)`); return +m[1] * 60 + +m[2]; };
    let jobFrom = body.job_from === undefined ? cur.job_from ?? null : hm(body.job_from, 'Giờ bắt đầu');
    let jobTo = body.job_to === undefined ? cur.job_to ?? null : hm(body.job_to, 'Giờ kết thúc');
    if (jobFrom != null && jobTo != null && jobTo <= jobFrom) jobTo += 24 * 60; // qua nửa đêm
    if ((jobFrom == null) !== (jobTo == null)) fail(400, 'Khung giờ cần đủ giờ bắt đầu và giờ kết thúc');
    return { title, teamId, phase, shiftId, positionId, zoneId, doer, section, rules, jobMode, jobTeams, jobFrom, jobTo };
  }

  // Tổ trưởng chỉ tạo/sửa checklist của tổ mình; trưởng ca trở lên sửa mọi tổ và checklist "Cả quán"
  function canEditTpl(me, teamId) {
    if (rank(me.role) >= rank('shift_lead')) return;
    if (me.role === 'team_lead' && teamId && teamId === me.team_id) return;
    fail(403, me.role === 'team_lead' ? 'Tổ trưởng chỉ tạo và sửa checklist của tổ mình' : 'Bạn không có quyền sửa checklist');
  }

  r.post('/api/checklist-templates', 'team_lead', ({ me, body }) => {
    const f = tplFields(body);
    canEditTpl(me, f.teamId);
    const id = tx(db, () => {
      const id = Number(db.prepare('INSERT INTO checklist_templates (team_id, phase, title, shift_template_id, position_id, zone_id, doer, section, rules, job_mode, job_teams, job_from, job_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(f.teamId, f.phase, f.title, f.shiftId, f.positionId, f.zoneId, f.doer, f.section, f.rules, f.jobMode, f.jobTeams, f.jobFrom, f.jobTo).lastInsertRowid);
      saveItems(id, body.items);
      return id;
    });
    ctx.audit(me, 'checklist.create', f.title);
    ctx.broadcast('checklists');
    return { id };
  });

  // Thêm nhanh 1 việc ngay trên màn checklist hằng ngày (chủ quán 24/10)
  r.post('/api/checklist-templates/:id/items', 'team_lead', ({ me, params, body }) => {
    const cur = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, cur.team_id);
    const text = v.text(body.text, { name: 'Tên việc', required: true, max: 120 });
    const n = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sort), -1) AS m FROM checklist_items WHERE template_id = ? AND deleted_at IS NULL').get(cur.id);
    if (n.n >= 60) fail(400, 'Tối đa 60 việc trong một checklist');
    const zoneId = body.zone_id ? v.int(body.zone_id, { min: 1, name: 'Khu' }) : null;
    if (zoneId && !db.prepare('SELECT 1 FROM zones WHERE id = ?').get(zoneId)) fail(400, 'Khu không tồn tại');
    const scope = body.job_scope === 'shop' ? 'shop' : 'zone';
    const id = Number(db.prepare("INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, extra_ingredient_ids, sort, job_zone_id, job_scope) VALUES (?, ?, 'check', '', 1, ?, '[]', ?, ?, ?)").run(cur.id, text, body.photo_required === false ? 0 : 1, n.m + 1, zoneId, scope).lastInsertRowid);
    ctx.audit(me, 'checklist.item_add', { template: cur.id, text });
    ctx.broadcast('checklists');
    return { id };
  });

  // Sửa 1 việc ngay trên màn checklist: tên, hướng dẫn, số phút, phải xong trước, số ảnh phải chụp
  r.patch('/api/checklist-items/:id', 'team_lead', ({ me, params, body }) => {
    const it = db.prepare('SELECT i.*, t.team_id FROM checklist_items i JOIN checklist_templates t ON t.id = i.template_id WHERE i.id = ? AND i.deleted_at IS NULL').get(params.id);
    if (!it) fail(404, 'Không tìm thấy việc');
    canEditTpl(me, it.team_id);
    const text = body.text === undefined ? it.text : v.text(body.text, { name: 'Tên việc', required: true, max: 120 });
    const guide = body.job_guide === undefined ? it.job_guide : v.text(body.job_guide, { name: 'Hướng dẫn', max: 1000 });
    const minutes = body.job_minutes === undefined ? it.job_minutes : (body.job_minutes === '' || body.job_minutes === null ? 0 : v.int(body.job_minutes, { min: 0, max: 600, name: 'Số phút' }));
    let deadline = it.job_deadline;
    if (body.job_deadline !== undefined) {
      if (body.job_deadline === '' || body.job_deadline === null) deadline = null;
      else { const m = /^(\d{1,2}):(\d{2})$/.exec(String(body.job_deadline)); if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) fail(400, 'Giờ phải xong không hợp lệ (vd 14:30)'); deadline = Number(m[1]) * 60 + Number(m[2]); }
    }
    const photos = body.job_photos === undefined ? it.job_photos : v.int(body.job_photos || 0, { min: 0, max: 6, name: 'Số ảnh' });
    const photoReq = photos > 0 ? 1 : body.photo_required === undefined ? it.photo_required : (v.bool(body.photo_required) ? 1 : 0);
    db.prepare('UPDATE checklist_items SET text = ?, job_guide = ?, job_minutes = ?, job_deadline = ?, job_photos = ?, photo_required = ? WHERE id = ?').run(text, guide, minutes, deadline, photos, photoReq, it.id);
    if (body.job_crew !== undefined) {
      const ids = [...new Set((Array.isArray(body.job_crew) ? body.job_crew : []).map(Number).filter(Boolean))].slice(0, 20);
      for (const x of ids) if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1').get(x)) fail(404, 'Không tìm thấy nhân viên');
      // 1 bạn = người cố định; nhiều bạn = mỗi bạn 1 thẻ
      db.prepare("UPDATE checklist_items SET job_crew = ?, job_fixed_staff = ?, job_scope = CASE WHEN job_zone_id IS NULL THEN 'shop' ELSE job_scope END WHERE id = ?").run(JSON.stringify(ids.length > 1 ? ids : []), ids.length === 1 ? ids[0] : null, it.id);
      try { ctx.jobsResetItem?.(ctx.today(), it.id); } catch { /* chưa có bảng jobs */ }
    }
    if (body.job_ask_note !== undefined) db.prepare('UPDATE checklist_items SET job_ask_note = ? WHERE id = ?').run(v.bool(body.job_ask_note) ? 1 : 0, it.id);
    if (body.job_role !== undefined) db.prepare('UPDATE checklist_items SET job_role = ? WHERE id = ?').run(v.oneOf(body.job_role || '', ['', 'lead'], { name: 'Cấp bậc' }), it.id);
    if (body.job_gender !== undefined) db.prepare('UPDATE checklist_items SET job_gender = ? WHERE id = ?').run(v.oneOf(body.job_gender || '', ['', 'nam', 'nu'], { name: 'Ai làm' }), it.id);
    if (body.job_fixed_staff !== undefined) {
      const sid = body.job_fixed_staff ? v.int(body.job_fixed_staff, { min: 1, name: 'Người làm' }) : null;
      if (sid && !db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1').get(sid)) fail(404, 'Không tìm thấy nhân viên');
      db.prepare("UPDATE checklist_items SET job_fixed_staff = ?, job_scope = CASE WHEN job_zone_id IS NULL THEN 'shop' ELSE job_scope END WHERE id = ?").run(sid, it.id);
      try { ctx.jobsApplyFixed?.(ctx.today()); } catch { /* chưa có bảng jobs */ }
    }
    ctx.audit(me, 'checklist.item_edit', { id: it.id, text });
    ctx.broadcast('checklists');
    return { ok: true };
  });

  // Đóng ca: bật / tắt giao cả khu cho người phụ trách; chọn người phụ trách cố định từng khu
  r.put('/api/checklist-templates/:id/lead-mode', 'shift_lead', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, t.team_id);
    db.prepare('UPDATE checklist_templates SET job_lead_mode = ? WHERE id = ?').run(v.bool(body.on) ? 1 : 0, t.id);
    try { ctx.jobsResetTemplate?.(ctx.today(), t.id); } catch { /* chưa có bảng jobs */ }
    ctx.audit(me, 'checklist.lead_mode', { id: t.id, on: !!body.on });
    ctx.broadcast('checklists');
    return { ok: true };
  });
  r.put('/api/checklist-templates/:id/lead-pool', 'shift_lead', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, t.team_id);
    db.prepare('UPDATE checklist_templates SET job_lead_pool = ? WHERE id = ?').run(v.bool(body.on) ? 1 : 0, t.id);
    try { ctx.jobsResetTemplate?.(ctx.today(), t.id); } catch { /* chưa có bảng jobs */ }
    ctx.audit(me, 'checklist.lead_pool', { id: t.id, on: !!body.on });
    ctx.broadcast('checklists'); ctx.broadcast('jobs');
    return { ok: true };
  });
  r.put('/api/checklist-templates/:id/zone-lead', 'shift_lead', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, t.team_id);
    const zid = v.int(body.zone_id, { min: 1, name: 'Khu' });
    if (body.staff_id) {
      const sid = v.int(body.staff_id, { min: 1, name: 'Người phụ trách' });
      if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1').get(sid)) fail(404, 'Không tìm thấy nhân viên');
      db.prepare('INSERT OR REPLACE INTO job_zone_leads (template_id, zone_id, staff_id) VALUES (?, ?, ?)').run(t.id, zid, sid);
    } else db.prepare('DELETE FROM job_zone_leads WHERE template_id = ? AND zone_id = ?').run(t.id, zid);
    try { ctx.jobsResetTemplate?.(ctx.today(), t.id); } catch { /* chưa có bảng jobs */ }
    ctx.broadcast('checklists');
    return { ok: true };
  });

  r.put('/api/checklist-templates/:id/note', 'team_lead', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, t.team_id);
    db.prepare('UPDATE checklist_templates SET job_note = ? WHERE id = ?').run(v.text(body.note, { name: 'Lưu ý', max: 500 }), t.id);
    ctx.broadcast('checklists');
    return { ok: true };
  });

  // Chép việc của 1 khu sang các khu khác (chủ quán 27/10: chép Khu A → B, C rồi bỏ việc không hợp). Bỏ qua việc trùng tên; chép cả hướng dẫn, thời gian, ảnh mẫu
  r.post('/api/checklist-templates/:id/copy-zone', 'team_lead', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, t.team_id);
    const from = v.int(body.from, { min: 1, name: 'Khu gốc' });
    const to = (Array.isArray(body.to) ? body.to : []).map(Number).filter((z) => z && z !== from && db.prepare('SELECT 1 FROM zones WHERE id = ?').get(z));
    if (!to.length) fail(400, 'Chọn khu để chép sang');
    const src = db.prepare('SELECT * FROM checklist_items WHERE template_id = ? AND job_zone_id = ? AND deleted_at IS NULL ORDER BY sort, id').all(t.id, from);
    if (!src.length) fail(400, 'Khu này chưa có việc để chép');
    let n = 0;
    tx(db, () => {
      let sort = db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM checklist_items WHERE template_id = ?').get(t.id).m;
      for (const z of to) {
        const have = new Set(db.prepare('SELECT text FROM checklist_items WHERE template_id = ? AND job_zone_id = ? AND deleted_at IS NULL').all(t.id, z).map((x) => x.text.trim().toLowerCase()));
        for (const it of src) {
          if (have.has(it.text.trim().toLowerCase())) continue;
          const id = Number(db.prepare(`INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, extra_ingredient_ids, sort, job_minutes, job_scope, job_qty, job_per_table, fetch_where, job_expect, job_zone_id, job_guide, job_deadline, job_photos)
            VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.id, it.text, it.kind, it.unit, it.required, it.photo_required, ++sort, it.job_minutes, it.job_scope, it.job_qty, it.job_per_table, it.fetch_where, it.job_expect, z, it.job_guide, it.job_deadline, it.job_photos).lastInsertRowid);
          for (const sm of db.prepare('SELECT * FROM checklist_samples WHERE item_id = ?').all(it.id)) {
            const file = `${t.id}-${id}-${crypto.randomBytes(6).toString('hex')}${path.extname(sm.file)}`;
            try { fs.copyFileSync(path.join(sampleDir, sm.file), path.join(sampleDir, file)); } catch { continue; }
            db.prepare('INSERT INTO checklist_samples (template_id, item_id, file, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(t.id, id, file, sm.note, me.id, ctx.now());
          }
          n++;
        }
      }
    });
    ctx.audit(me, 'checklist.copy_zone', { template: t.id, from, to, n });
    ctx.broadcast('checklists');
    return { copied: n };
  });

  // Xoá 1 việc ngay trên màn checklist (việc theo khu ở Mở ca phục vụ)
  r.post('/api/checklist-items/:id/delete', 'team_lead', ({ me, params }) => {
    const it = db.prepare('SELECT i.*, t.team_id FROM checklist_items i JOIN checklist_templates t ON t.id = i.template_id WHERE i.id = ? AND i.deleted_at IS NULL').get(params.id);
    if (!it) fail(404, 'Không tìm thấy việc');
    canEditTpl(me, it.team_id);
    softDelete(it.id);
    ctx.audit(me, 'checklist.item_delete', { template: it.template_id, text: it.text });
    ctx.broadcast('checklists');
    return { ok: true };
  });

  r.patch('/api/checklist-templates/:id', 'team_lead', ({ me, params, body }) => {
    const cur = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, cur.team_id);
    const f = tplFields(body, cur);
    canEditTpl(me, f.teamId);
    const active = body.active === undefined ? cur.active : v.bool(body.active);
    tx(db, () => {
      db.prepare('UPDATE checklist_templates SET team_id = ?, phase = ?, title = ?, shift_template_id = ?, position_id = ?, zone_id = ?, doer = ?, section = ?, rules = ?, job_mode = ?, job_teams = ?, job_from = ?, job_to = ?, active = ? WHERE id = ?').run(f.teamId, f.phase, f.title, f.shiftId, f.positionId, f.zoneId, f.doer, f.section, f.rules, f.jobMode, f.jobTeams, f.jobFrom, f.jobTo, active, cur.id);
      if (body.items !== undefined) saveItems(cur.id, body.items);
    });
    ctx.audit(me, 'checklist.update', { id: cur.id, title: f.title });
    ctx.broadcast('checklists');
    return { ok: true };
  });

  // ---------- Checklist trong ngày ----------
  // Chủ quán 30/10: khu nào thấy khu đó — nhân viên, tổ trưởng, trưởng ca chỉ thấy checklist bộ phận mình (+ bộ phận được xếp ca hôm nay); quản lý / chủ thấy hết
  function myScope(me, date) {
    if (rank(me.role) >= rank('manager')) return null;
    const teams = new Set(me.team_id ? [me.team_id] : []);
    const shifts = new Set();
    const positions = new Set(me.position_id ? [me.position_id] : []);
    const zones = new Set();
    const rows = db.prepare(`SELECT a.team_id, a.template_id, a.label, a.position_id, a.zone_id FROM assignments a WHERE a.staff_id = ? AND a.date = ?
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')`).all(me.id, date);
    const byName = new Map(db.prepare('SELECT id, name FROM shift_templates').all().map((t) => [t.name, t.id]));
    for (const a of rows) {
      if (a.team_id) teams.add(a.team_id);
      if (a.position_id) positions.add(a.position_id);
      if (a.zone_id) zones.add(a.zone_id);
      if (a.template_id) shifts.add(a.template_id);
      else if (byName.has(a.label)) shifts.add(byName.get(a.label));
    }
    // Không có ca hôm nay và chưa chấm công → không có checklist (chủ quán 24/10: chỉ người đi làm mới thấy việc)
    const off = !rows.length && !db.prepare('SELECT 1 FROM attendance WHERE staff_id = ? AND date = ?').get(me.id, date);
    return { teams, shifts, positions, zones, off, me: me.id };
  }
  const inScope = (scope, t) => !scope || (!scope.off && (t.doer || '') === '' && (t.team_id === null || scope.teams.has(t.team_id))
    && (t.shift_template_id === null || scope.shifts.has(t.shift_template_id))
    && (!t.position_id || scope.positions.has(t.position_id))
    && (!t.zone_id || scope.zones.has(t.zone_id))) || (!!scope && !scope.off && (t.doer || '') === `staff:${scope.me}`);
  ctx.checklistScope = myScope;
  ctx.checklistInScope = inScope;

  // Kiểm tra ngẫu nhiên: mỗi lượt checklist (mở / đóng ca, ≥ 4 việc tick không ảnh) app chọn N việc bắt chụp thêm.
  // Chọn theo mã bí mật của quán + ngày + lượt → cả ngày cố định, nhân viên không biết trước việc nào.
  const spotN = () => Math.max(0, Number(ctx.setting('spot_photos_per_run') ?? 1));
  function spotIds(runId, templateId, phase) {
    const n = spotN();
    if (!n || phase === 'during') return new Set();
    const pool = db.prepare("SELECT id FROM checklist_items WHERE template_id = ? AND kind = 'check' AND photo_required = 0 AND deleted_at IS NULL ORDER BY id").all(templateId).map((x) => x.id);
    if (pool.length < 3) return new Set();
    const key = String(ctx.setting('pin_secret') || 'clt');
    const score = (id) => crypto.createHash('sha256').update(`${key}:${runId}:${id}`).digest().readUInt32BE(0);
    return new Set(pool.sort((a, b) => score(a) - score(b)).slice(0, n));
  }
  ctx.checklistSpot = spotIds;

  function dayView(date, scope) {
    const tpls = templates().filter((t) => !t.job_mode && inScope(scope, t)); // checklist giao việc từng người nằm ở màn Việc ca
    const ensure = db.prepare('INSERT OR IGNORE INTO checklist_runs (template_id, date) VALUES (?, ?)');
    const getRun = db.prepare('SELECT * FROM checklist_runs WHERE template_id = ? AND date = ?');
    const entries = db.prepare(`SELECT e.*, s.name AS done_by_name, rv.name AS reviewed_by_name FROM checklist_entries e LEFT JOIN staff s ON s.id = e.done_by LEFT JOIN staff rv ON rv.id = e.reviewed_by WHERE e.run_id = ?`);
    const photos = db.prepare('SELECT p.id, p.item_id, p.created_at, p.deleted_at, p.staff_id, s.name AS staff_name FROM checklist_photos p LEFT JOIN staff s ON s.id = p.staff_id WHERE p.run_id = ? ORDER BY p.id');
    return tpls.map((t) => {
      ensure.run(t.id, date);
      const run = getRun.get(t.id, date);
      const byItem = new Map(entries.all(run.id).map((e) => [e.item_id, e]));
      const ph = photos.all(run.id);
      const spot = spotIds(run.id, t.id, t.phase);
      const items = t.items.map((i) => ({ ...i, spot: spot.has(i.id), photo_required: i.photo_required || spot.has(i.id), entry: byItem.get(i.id) || null, photos: ph.filter((p) => p.item_id === i.id) }));
      const required = items.filter((i) => i.required);
      return {
        run_id: run.id, template_id: t.id, title: t.title, phase: t.phase, team_id: t.team_id, team_name: t.team_name || 'Cả quán', section: sectionOf(t), rules: t.rules || '',
        shift_template_id: t.shift_template_id, shift_name: t.shift_name || '', position_id: t.position_id ?? null, position_name: t.position_name || '', zone_id: t.zone_id ?? null, zone_name: t.zone_name || '',
        completed_at: run.completed_at, items, samples: t.samples,
        done: required.filter((i) => i.entry && i.entry.review_status !== 'redo').length, total: required.length,
        redo: items.filter((i) => i.entry?.review_status === 'redo').length,
      };
    });
  }
  ctx.checklistDay = (date) => dayView(date, null);

  // Thẻ chia theo khu: Mở ca phục vụ, Đầu ca phục vụ (khăn + nón)
  const zoneTpl = (t) => /mở ca phục vụ|đầu ca phục vụ|đóng ca phục vụ/i.test(t.title);
  // Người chọn làm việc ở thẻ theo khu: Phục vụ + Tiếp thực + người có khu (gửi kèm để màn checklist không phụ thuộc quyền xem danh sách nhân viên)
  const poolOf = () => db.prepare(`SELECT s.id, s.name, s.gender, s.role, s.home_zone_id, COALESCE(t.name, '') AS team_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id
    WHERE s.active = 1 AND s.role != 'owner' ORDER BY s.name`).all().filter((x) => /phục vụ|phuc vu|tiếp thực|tiep thuc/i.test(x.team_name.normalize('NFC')) || x.home_zone_id)
    .map((x) => ({ id: x.id, name: x.name, gender: x.gender || '', role: x.role, team_name: x.team_name, home_zone_id: x.home_zone_id ?? null }));
  const jobRowsOf = (date, tid) => { try { return db.prepare('SELECT id, item_id, zone_id, staff_id, status, owner_id, done_note, photo IS NOT NULL AS has_photo, done_at FROM jobs WHERE date = ? AND template_id = ?').all(date, tid); } catch { return []; } };
  const zonePhotosOf = (date, tid) => { try { return db.prepare('SELECT id, zone_id, staff_id, at FROM job_zone_photos WHERE date = ? AND template_id = ? ORDER BY id').all(date, tid); } catch { return []; } };

  r.get('/api/checklists', 'staff', ({ me, query }) => {
    const date = query.get('date') || ctx.today();
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    // Checklist đang giao việc từng người: vẫn hiện thẻ tóm tắt (bấm sang Việc ca, thêm việc mới ngay tại đây)
    const scope = myScope(me, date);
    try { if (date === ctx.today()) ctx.jobsEnsureDay?.(date); } catch { /* chưa có bảng jobs */ }
    const nameOf = (id) => (id ? db.prepare('SELECT name FROM staff WHERE id = ?').get(id)?.name || '' : '');
    const jobs = templates().filter((t) => t.job_mode && (!scope || (!scope.off && (t.team_id === null || scope.teams.has(t.team_id) || (t.job_teams || []).some((x) => scope.teams.has(x)))))).map((t) => {
      let total = 0, done = 0;
      try { const c = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('done','ok') THEN 1 ELSE 0 END) AS d FROM jobs WHERE date = ? AND template_id = ?").get(date, t.id); total = c.n; done = c.d || 0; } catch { /* chưa có bảng jobs */ }
      return { template_id: t.id, title: t.title, phase: t.phase, team_id: t.team_id, team_name: t.team_name || 'Cả quán', section: sectionOf(t), items: t.items.length, total, done,
        item_list: t.items.map((i) => ({ id: i.id, text: i.text, job_scope: i.job_scope, job_zone_id: i.job_zone_id ?? null, job_fixed_staff: i.job_fixed_staff ?? null, job_gender: i.job_gender || '', job_role: i.job_role || '', job_ask_note: !!i.job_ask_note, job_crew: JSON.parse(i.job_crew || '[]'), job_guide: i.job_guide || '', job_minutes: i.job_minutes || 0,
          job_deadline: i.job_deadline ?? null, job_photos: i.job_photos || 0, photo_required: !!i.photo_required, samples: (i.samples || []).map((x) => x.id) })), opening_tpl: zoneTpl(t),
        zone_photo: /đầu ca phục vụ/i.test(t.title), note: t.job_note || '', note_tpl: t.id, win: zoneTpl(t) && t.phase === 'close' ? opening(date, t) : null, // trưởng ca chụp ảnh từng khu (chủ quán 27/10)
        job_rows: zoneTpl(t) ? jobRowsOf(date, t.id).map((j) => ({ id: j.id, item_id: j.item_id, zone_id: j.zone_id, owner_id: j.owner_id, staff_id: j.staff_id, staff_name: nameOf(j.staff_id), status: j.status, done_note: j.done_note || '', redo_count: j.redo_count || 0, check_note: j.check_note || '', has_photo: !!j.has_photo, done_at: j.done_at || null, extra_photos: (() => { try { return db.prepare('SELECT id FROM job_photos WHERE job_id = ? ORDER BY id').all(j.id).map((x) => x.id); } catch { return []; } })() })) : [],
        pool: zoneTpl(t) ? poolOf() : [],
        lead_mode: !!t.job_lead_mode, lead_pool: !!t.job_lead_pool,
        zone_leads: zoneTpl(t) && t.job_lead_mode ? Object.fromEntries(db.prepare('SELECT id FROM zones WHERE active = 1').all().map((z) => { let fx = null, now = null; try { fx = db.prepare('SELECT staff_id FROM job_zone_leads WHERE template_id = ? AND zone_id = ?').get(t.id, z.id)?.staff_id ?? null; now = ctx.jobsZoneLead?.(date, t, z.id) ?? null; } catch { /* chưa có bảng */ } return [z.id, { fixed: fx, fixed_name: nameOf(fx), today: now, today_name: nameOf(now) }]; })) : {},
        photos: zoneTpl(t) ? zonePhotosOf(date, t.id).map((x) => ({ id: x.id, zone_id: x.zone_id, at: x.at, staff_name: nameOf(x.staff_id) })) : [] };
    });
    return { date, runs: dayView(date, scope), jobs, opening: opening(date) };
  });

  // Đầu ca Phục vụ + Tiếp thực (chủ quán 27/10): ai có ca trong khung mở ca (mặc định 14:00–15:30), ai ca ngắn kết thúc ≤ 18:00
  // Nhân sự khung giờ của thẻ: mở ca = khung đầu ca (14:00–15:30); đóng ca (chưa đặt khung) = giờ cuối cùng trước khi về
  function opening(date, ctpl = null) {
    const tpl = ctpl || templates().find((t) => t.job_mode && t.job_from != null && /mở ca phục vụ/i.test(t.title)) || null;
    let from = tpl?.job_from ?? 840, to = tpl?.job_to ?? 930;
    // Người chưa có bộ phận mà có khu (vd trưởng ca) vẫn tính vào Phục vụ
    const segs = db.prepare(`SELECT a.staff_id, a.start_min, a.end_min, s.name, s.gender, s.role, COALESCE(t.name, CASE WHEN a.zone_id IS NOT NULL OR s.home_zone_id IS NOT NULL THEN 'Phục vụ' END) AS team, z.name AS zone, z.id AS zone_id
      FROM assignments a JOIN staff s ON s.id = a.staff_id AND s.active = 1
      LEFT JOIN teams t ON t.id = s.team_id LEFT JOIN zones z ON z.id = a.zone_id WHERE a.date = ? ORDER BY a.start_min`).all(date).filter((x) => /phục vụ|phuc vu|tiếp thực|tiep thuc/i.test(x.team || ''));
    for (const x of segs) if (x.end_min <= x.start_min) x.end_min += 1440; // ca qua nửa đêm
    if (ctpl && ctpl.phase === 'close' && (ctpl.job_from == null || ctpl.job_from < 17 * 60)) { const last = segs.length ? Math.max(...segs.map((x) => x.end_min)) : 1380; from = last - 60; to = last; }
    const by = new Map();
    for (const x of segs) { const p = by.get(x.staff_id) || { id: x.staff_id, name: x.name, gender: x.gender || '', role: x.role, team: x.team, zone: '', zone_id: null, segs: [] }; p.segs.push([x.start_min, x.end_min]); if (x.zone && !p.zone) { p.zone = x.zone; p.zone_id = x.zone_id; } by.set(x.staff_id, p); }
    const hm = (m) => `${Math.floor((m % 1440) / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
    const inOpen = (p) => p.segs.some(([a, b]) => Math.min(b, to) - Math.max(a, from) >= 30);
    const clocked = new Set(db.prepare('SELECT DISTINCT staff_id FROM attendance WHERE date = ?').all(date).map((x) => x.staff_id));
    const people = [...by.values()].filter(inOpen).map((p) => {
      const seg = p.segs.find(([a, b]) => Math.min(b, to) - Math.max(a, from) >= 30);
      return { id: p.id, name: p.name, gender: p.gender, role: p.role, team: p.team, zone: p.zone || '', zone_id: p.zone_id, shift: p.segs.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(' + '), short: !(ctpl && ctpl.phase === 'close') && seg[1] <= 18 * 60, clocked: clocked.has(p.id) };
    }).sort((a, b) => (!a.zone - !b.zone) || (a.zone || '').localeCompare(b.zone || '', 'vi') || a.team.localeCompare(b.team) || a.name.localeCompare(b.name, 'vi'));
    const pv = people.filter((x) => /phục vụ|phuc vu/i.test(x.team)).length;
    const zones = [...new Set(people.map((x) => x.zone || 'Chưa phân khu'))].map((z) => ({ name: z, people: people.filter((x) => (x.zone || 'Chưa phân khu') === z) }));
    // Người vào sau khung đầu ca (vd 16h, 17h): để chủ quán giao thêm việc khi họ còn trống (chủ quán 27/10)
    const later = ctpl && ctpl.phase === 'close' ? [] : [...by.values()].filter((p) => !inOpen(p) && Math.min(...p.segs.map(([a]) => a)) >= to).map((p) => ({ id: p.id, name: p.name, gender: p.gender, role: p.role, team: p.team, zone: p.zone || '', zone_id: p.zone_id,
      start: hm(Math.min(...p.segs.map(([a]) => a))), shift: p.segs.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(' + '), clocked: clocked.has(p.id) }))
      .sort((a, b) => a.start.localeCompare(b.start, 'vi', { numeric: true }) || a.name.localeCompare(b.name, 'vi'));
    // Tổng phút việc đã giao trong ngày (mọi checklist giao việc) của từng người
    let loads = {};
    try { for (const x of db.prepare('SELECT j.staff_id, COUNT(*) AS n, SUM(COALESCE(i.job_minutes, 0)) AS m FROM jobs j JOIN checklist_items i ON i.id = j.item_id WHERE j.date = ? AND j.staff_id IS NOT NULL GROUP BY j.staff_id').all(date)) loads[x.staff_id] = { min: x.m || 0, n: x.n }; } catch { loads = {}; }
    return { zones, from: hm(from), to: hm(to), total: people.length, pv, tt: people.length - pv, clocked: people.filter((x) => x.clocked).length, people, later, loads, short: people.filter((x) => x.short) };
  }
  ctx.openingInfo = opening;
  // Trước giờ mở ca 10 phút: báo chủ quán / quản lý / trưởng ca số người đầu ca + ai ca 14–18 (1 lần / ngày)
  ctx.openingTick = () => {
    const date = ctx.today(), c = ctx.clock();
    // Hết khung đầu ca (15:30): khu có người mà chưa có ảnh khăn + nón → báo chủ quán / quản lý (1 lần / ngày)
    const dc = templates().find((t) => t.job_mode && /đầu ca phục vụ/i.test(t.title));
    const mo = templates().find((t) => t.job_mode && t.job_from != null && /mở ca phục vụ/i.test(t.title));
    const end = dc?.job_to ?? mo?.job_to ?? 930;
    if (dc && c.minuteOf(ctx.now()) >= end && !ctx.setting(`dau_ca_photo:${date}`)) {
      ctx.setSetting(`dau_ca_photo:${date}`, '1');
      const o = opening(date);
      const has = new Set(zonePhotosOf(date, dc.id).map((x) => x.zone_id));
      const miss = [...new Map(o.people.filter((x) => x.zone_id && !has.has(x.zone_id)).map((x) => [x.zone_id, x.zone])).values()];
      if (miss.length) {
        const to = db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id);
        ctx.notify(to, { title: `📷 Chưa có ảnh khăn + nón: ${miss.join(', ')}`, body: `Hết ${o.to} mà trưởng ca chưa chụp ảnh đầu ca các khu này.`, link: '/checklist' });
      }
    }
    const tpl = templates().find((t) => t.job_mode && t.job_from != null && /mở ca phục vụ/i.test(t.title));
    const from = tpl?.job_from ?? 840;
    if (c.minuteOf(ctx.now()) < from - 10 || ctx.setting(`opening_note:${date}`)) return;
    ctx.setSetting(`opening_note:${date}`, '1');
    const o = opening(date);
    if (!o.total) return;
    const to = db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((x) => x.id);
    ctx.notify(to, { title: `Đầu ca ${o.from}–${o.to}: ${o.total} người (PV ${o.pv} · TT ${o.tt})`,
      body: `${o.zones.map((z) => `${z.name}: ${z.people.map((x) => x.name).join(', ')}`).join('\n')}\n${o.short.length ? `Ca ngắn về ≤ 18h: ${o.short.map((x) => `${x.name} (${x.shift})`).join(', ')}` : 'Không ai về trước 18h.'}`, link: '/checklist' });
  };

  // Lượt checklist xong khi mọi việc bắt buộc đã làm và không có việc nào bị chấm "Làm lại"
  function updateRun(run, by) {
    const left = db.prepare(`SELECT COUNT(*) AS n FROM checklist_items i WHERE i.template_id = ? AND i.required = 1 AND i.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM checklist_entries e WHERE e.run_id = ? AND e.item_id = i.id AND COALESCE(e.review_status, '') != 'redo')`).get(run.template_id, run.id).n;
    const cur = db.prepare('SELECT completed_at FROM checklist_runs WHERE id = ?').get(run.id);
    if (left === 0 && !cur.completed_at) db.prepare('UPDATE checklist_runs SET completed_at = ?, completed_by = ? WHERE id = ?').run(ctx.now(), by, run.id);
    if (left > 0 && cur.completed_at) db.prepare('UPDATE checklist_runs SET completed_at = NULL, completed_by = NULL WHERE id = ?').run(run.id);
  }

  function loadRunItem(me, runId, itemId) {
    const run = db.prepare('SELECT r.*, t.team_id, t.shift_template_id, t.position_id, t.zone_id, t.doer, t.title FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id WHERE r.id = ?').get(runId);
    if (!run) fail(404, 'Không tìm thấy checklist');
    const item = db.prepare('SELECT * FROM checklist_items WHERE id = ? AND template_id = ? AND deleted_at IS NULL').get(itemId, run.template_id);
    if (!item) fail(404, 'Không tìm thấy việc');
    if (!inScope(myScope(me, run.date), run)) fail(403, 'Checklist này không thuộc tổ hoặc ca của bạn hôm nay');
    if (run.date < ctx.today() && rank(me.role) < rank('shift_lead')) fail(403, 'Checklist ngày cũ chỉ trưởng ca trở lên mới sửa được');
    return { run, item };
  }

  // ---------- Ảnh báo cáo ----------
  const photoDir = ctx.photoDir || path.join(os.tmpdir(), 'quanly-photos');
  const KEEP_DAYS = 7;
  ctx.photoKeepDays = KEEP_DAYS; // jobs.js dọn ảnh việc ca cùng số ngày (rà soát 28/10)

  r.post('/api/checklists/photo', 'staff', ({ me, body }) => {
    const { run, item } = loadRunItem(me, v.int(body.run_id, { min: 1, name: 'Checklist' }), v.int(body.item_id, { min: 1, name: 'Việc' }));
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) fail(400, 'Ảnh không hợp lệ');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500) fail(400, 'Ảnh không hợp lệ');
    if (buf.length > 1_500_000) fail(413, 'Ảnh quá lớn, chụp lại giúp');
    const n = db.prepare('SELECT COUNT(*) AS n FROM checklist_photos WHERE run_id = ? AND item_id = ? AND deleted_at IS NULL').get(run.id, item.id).n;
    if (n >= 4) fail(400, 'Tối đa 4 ảnh cho mỗi việc');
    const rel = path.join(run.date, `${run.id}-${item.id}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.mkdirSync(path.join(photoDir, run.date), { recursive: true });
    fs.writeFileSync(path.join(photoDir, rel), buf);
    const id = Number(db.prepare('INSERT INTO checklist_photos (run_id, item_id, staff_id, file, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(run.id, item.id, me.id, rel, buf.length, ctx.now()).lastInsertRowid);
    ctx.broadcast('checklists');
    return { id };
  });

  r.post('/api/checklists/photo/delete', 'staff', ({ me, body }) => {
    const p = db.prepare('SELECT * FROM checklist_photos WHERE id = ?').get(v.int(body.id, { min: 1, name: 'Ảnh' }));
    if (!p || p.deleted_at) fail(404, 'Không tìm thấy ảnh');
    if (p.staff_id !== me.id && rank(me.role) < rank('shift_lead')) fail(403, 'Chỉ xoá được ảnh của mình');
    const e = db.prepare('SELECT review_status FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(p.run_id, p.item_id);
    if (e && e.review_status !== 'redo') fail(400, 'Việc đã bấm xong; bỏ dấu xong trước rồi mới xoá ảnh');
    try { fs.unlinkSync(path.join(photoDir, p.file)); } catch { /* đã mất */ }
    db.prepare('UPDATE checklist_photos SET deleted_at = ? WHERE id = ?').run(ctx.now(), p.id);
    ctx.broadcast('checklists');
    return { ok: true };
  });

  r.get('/api/photos/:id', 'staff', ({ me, params }) => {
    const p = db.prepare(`SELECT p.*, r.date, t.team_id, t.shift_template_id, t.position_id, t.zone_id, t.doer FROM checklist_photos p
      JOIN checklist_runs r ON r.id = p.run_id JOIN checklist_templates t ON t.id = r.template_id WHERE p.id = ?`).get(params.id);
    if (!p) fail(404, 'Không tìm thấy ảnh');
    if (p.deleted_at) fail(410, `Ảnh đã tự xoá sau ${KEEP_DAYS} ngày`);
    if (p.staff_id !== me.id && !canReview(me, p.team_id) && !inScope(myScope(me, p.date), p)) fail(403, 'Không xem được ảnh này');
    let buf;
    try { buf = fs.readFileSync(path.join(photoDir, p.file)); } catch { fail(410, 'Ảnh không còn'); }
    const ext = path.extname(p.file);
    return { __binary: buf, type: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
  });

  // ---------- Ảnh mẫu: tổ trưởng / quản lý chụp ảnh chuẩn cho checklist (khu) hoặc từng việc ----------
  const sampleDir = path.join(photoDir, 'mau');
  r.post('/api/checklist-templates/:id/samples', 'team_lead', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, t.team_id);
    const itemId = body.item_id ? v.int(body.item_id, { min: 1, name: 'Việc' }) : null;
    if (itemId && !db.prepare('SELECT 1 FROM checklist_items WHERE id = ? AND template_id = ? AND deleted_at IS NULL').get(itemId, t.id)) fail(400, 'Việc không thuộc checklist này');
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) fail(400, 'Ảnh không hợp lệ');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500) fail(400, 'Ảnh không hợp lệ');
    if (buf.length > 1_500_000) fail(413, 'Ảnh quá lớn, chụp lại giúp');
    const n = db.prepare(`SELECT COUNT(*) AS n FROM checklist_samples WHERE template_id = ? AND ${itemId ? 'item_id = ?' : 'item_id IS NULL'}`).get(...(itemId ? [t.id, itemId] : [t.id])).n;
    if (n >= 6) fail(400, itemId ? 'Tối đa 6 ảnh mẫu cho mỗi việc' : 'Tối đa 6 ảnh mẫu cho mỗi checklist');
    const file = `${t.id}-${itemId || 0}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.mkdirSync(sampleDir, { recursive: true });
    fs.writeFileSync(path.join(sampleDir, file), buf);
    const note = v.text(body.note, { name: 'Ghi chú', max: 120 });
    const id = Number(db.prepare('INSERT INTO checklist_samples (template_id, item_id, file, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(t.id, itemId, file, note, me.id, ctx.now()).lastInsertRowid);
    ctx.audit(me, 'checklist.sample.add', { template: t.id, item: itemId });
    ctx.broadcast('checklists');
    return { id };
  });
  r.post('/api/checklist-samples/:id/delete', 'team_lead', ({ me, params }) => {
    const x = db.prepare('SELECT s.*, t.team_id FROM checklist_samples s JOIN checklist_templates t ON t.id = s.template_id WHERE s.id = ?').get(params.id);
    if (!x) fail(404, 'Không tìm thấy ảnh mẫu');
    canEditTpl(me, x.team_id);
    try { fs.unlinkSync(path.join(sampleDir, x.file)); } catch { /* đã mất */ }
    db.prepare('DELETE FROM checklist_samples WHERE id = ?').run(x.id);
    ctx.audit(me, 'checklist.sample.delete', { id: x.id });
    ctx.broadcast('checklists');
    return { ok: true };
  });
  r.get('/api/checklist-samples/:id', 'staff', ({ params }) => {
    const x = db.prepare('SELECT * FROM checklist_samples WHERE id = ?').get(params.id);
    if (!x) fail(404, 'Không tìm thấy ảnh mẫu');
    let buf;
    try { buf = fs.readFileSync(path.join(sampleDir, x.file)); } catch { fail(410, 'Ảnh mẫu không còn, chụp lại giúp'); }
    const ext = path.extname(x.file);
    return { __binary: buf, type: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
  });

  ctx.cleanupPhotos = () => {
    const before = ctx.now() - KEEP_DAYS * 86_400_000;
    const old = db.prepare('SELECT id, file FROM checklist_photos WHERE deleted_at IS NULL AND created_at < ?').all(before);
    for (const p of old) {
      try { fs.unlinkSync(path.join(photoDir, p.file)); } catch { /* đã mất */ }
      db.prepare('UPDATE checklist_photos SET deleted_at = ? WHERE id = ?').run(ctx.now(), p.id);
    }
    // Dọn thư mục ngày trống
    try {
      for (const d of fs.readdirSync(photoDir)) {
        const full = path.join(photoDir, d);
        if (fs.statSync(full).isDirectory() && !fs.readdirSync(full).length) fs.rmdirSync(full);
      }
    } catch { /* chưa có thư mục */ }
    return old.length;
  };

  // ---------- Duyệt ảnh: Đạt / Làm lại ----------
  // Duyệt ảnh: quản lý / chủ mọi bộ phận; tổ trưởng, trưởng ca chỉ bộ phận mình (chủ quán 30/10: khu nào thấy khu đó)
  const canReview = (me, teamId) => rank(me.role) >= rank('manager') || (['team_lead', 'shift_lead'].includes(me.role) && teamId && teamId === me.team_id) || (me.role === 'shift_lead' && !teamId);

  r.get('/api/checklists/review', 'team_lead', ({ me, query }) => {
    const date = query.get('date') || ctx.today();
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    const rows = db.prepare(`SELECT e.run_id, e.item_id, e.value, e.done_at, e.review_status, e.review_note, e.reviewed_at,
        d.name AS done_by_name, rv.name AS reviewed_by_name, i.text AS item_text, t.title, t.team_id, tm.name AS team_name,
        t.zone_id, z.name AS zone_name, t.position_id, p.name AS position_name, r.date
      FROM checklist_entries e JOIN checklist_runs r ON r.id = e.run_id JOIN checklist_templates t ON t.id = r.template_id
      JOIN checklist_items i ON i.id = e.item_id LEFT JOIN staff d ON d.id = e.done_by LEFT JOIN staff rv ON rv.id = e.reviewed_by
      LEFT JOIN teams tm ON tm.id = t.team_id LEFT JOIN zones z ON z.id = t.zone_id LEFT JOIN positions p ON p.id = t.position_id
      WHERE r.date = ? AND (i.photo_required = 1 OR EXISTS (SELECT 1 FROM checklist_photos ph WHERE ph.run_id = e.run_id AND ph.item_id = e.item_id))
      ORDER BY e.done_at DESC`).all(date).filter((x) => canReview(me, x.team_id));
    const photos = db.prepare('SELECT id, deleted_at FROM checklist_photos WHERE run_id = ? AND item_id = ? ORDER BY id');
    const items = rows.map((x) => ({ ...x, photos: photos.all(x.run_id, x.item_id) }));
    // Bảng điểm 7 ngày gần nhất (tính theo người làm)
    const from = addDays(date, -6);
    const score = db.prepare(`SELECT s.id, s.name, s.team_id, SUM(CASE WHEN e.review_status = 'ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN e.review_status = 'redo' THEN 1 ELSE 0 END) AS redo,
        SUM(CASE WHEN e.review_status IS NULL THEN 1 ELSE 0 END) AS pending, COUNT(*) AS total
      FROM checklist_entries e JOIN checklist_runs r ON r.id = e.run_id JOIN checklist_items i ON i.id = e.item_id JOIN staff s ON s.id = e.done_by
      WHERE r.date BETWEEN ? AND ? AND i.photo_required = 1 GROUP BY s.id ORDER BY redo DESC, s.name`).all(from, date).filter((x) => rank(me.role) >= rank('manager') || x.team_id === me.team_id);
    return { date, items, score: { from, to: date, people: score } };
  });

  r.post('/api/checklists/review', 'team_lead', ({ me, body }) => {
    const runId = v.int(body.run_id, { min: 1, name: 'Checklist' });
    const itemId = v.int(body.item_id, { min: 1, name: 'Việc' });
    const status = v.oneOf(body.status, ['ok', 'redo'], { name: 'Kết quả' });
    const note = v.text(body.note, { name: 'Ghi chú', max: 300 });
    if (status === 'redo' && !note) fail(400, 'Ghi rõ chỗ chưa đạt để bạn làm lại');
    const e = db.prepare(`SELECT e.*, r.date, r.template_id, t.team_id, t.title, i.text AS item_text FROM checklist_entries e
      JOIN checklist_runs r ON r.id = e.run_id JOIN checklist_templates t ON t.id = r.template_id JOIN checklist_items i ON i.id = e.item_id
      WHERE e.run_id = ? AND e.item_id = ?`).get(runId, itemId);
    if (!e) fail(404, 'Việc này chưa được báo xong');
    if (!canReview(me, e.team_id)) fail(403, 'Bạn không duyệt được checklist của tổ này');
    tx(db, () => {
      db.prepare('UPDATE checklist_entries SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE run_id = ? AND item_id = ?')
        .run(status, note, me.id, ctx.now(), runId, itemId);
      updateRun({ id: runId, template_id: e.template_id }, e.done_by);
    });
    if (status === 'redo') {
      const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id);
      const doer = ctx.staff(e.done_by);
      ctx.notify([e.done_by].filter((x) => x && x !== me.id), { title: `Làm lại: ${e.item_text}`, body: `${e.title}\n${note}\nChụp ảnh mới rồi bấm xong lại.`, link: '/checklist', urgent: true });
      ctx.notify(owners.filter((x) => x !== me.id), { title: `Chưa đạt: ${e.item_text} (${doer?.name || ''})`, body: `${e.title} · ${me.name} chấm: ${note}`, link: `/duyet-anh?date=${e.date}` });
    }
    ctx.audit(me, status === 'redo' ? 'checklist.redo' : 'checklist.ok', { run_id: runId, item_id: itemId, note });
    ctx.broadcast('checklists');
    return { ok: true };
  });

  r.post('/api/checklists/entry', 'staff', ({ me, body }) => {
    const runId = v.int(body.run_id, { min: 1, name: 'Checklist' });
    const itemId = v.int(body.item_id, { min: 1, name: 'Việc' });
    const { run, item } = loadRunItem(me, runId, itemId);
    const done = body.done === undefined ? true : v.bool(body.done);
    const prevEntry = db.prepare('SELECT count_id, value FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(runId, itemId);
    const prevCount = prevEntry?.count_id;
    let stockActual = null;
    tx(db, () => {
      if (!done) {
        db.prepare('DELETE FROM checklist_entries WHERE run_id = ? AND item_id = ?').run(runId, itemId);
      } else {
        let value = v.text(body.value, { name: 'Giá trị', max: 300 });
        const ing = item.ingredient_id ? db.prepare('SELECT * FROM ingredients WHERE id = ?').get(item.ingredient_id) : null;
        const numOf = (x, label) => { const t = String(x ?? '').trim().replace(',', '.') || '0'; if (!/^\d+(\.\d+)?$/.test(t)) fail(400, `Nhập số ${label} cho "${item.text}"`); return Number(t); };
        if (item.kind === 'number' && packMode(item.unit, ing)) {
          // Nhập số bịch nguyên + số lẻ → tổng theo đơn vị dùng
          const packs = numOf(body.value, item.unit);
          const loose = numOf(body.loose, `${ing.unit} lẻ`);
          if (!String(body.value ?? '').trim() && !String(body.loose ?? '').trim()) fail(400, `Nhập số ${item.unit} và ${ing.unit} lẻ cho "${item.text}" (không còn thì nhập 0)`);
          stockActual = packs * (ing.purchase_factor || 1) + loose;
          value = `${packs} ${item.unit} + ${loose} ${ing.unit}`;
        } else if (item.kind === 'number') {
          value = value.replace(',', '.');
          if (!/^-?\d+(\.\d+)?$/.test(value)) fail(400, `Nhập số cho "${item.text}"`);
          if (ing) stockActual = Math.round(Number(value) * (unitFactor(item.unit, ing) || 1) * 1000) / 1000;
        }
        if (item.kind === 'text' && item.required && !value) fail(400, `Nhập nội dung cho "${item.text}"`);
        // Bị chấm "Làm lại" thì phải có ảnh MỚI chụp sau lúc chấm
        const prev = db.prepare('SELECT review_status, reviewed_at FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(runId, itemId);
        const since = prev?.review_status === 'redo' ? prev.reviewed_at : 0;
        const tplPhase = db.prepare('SELECT phase FROM checklist_templates WHERE id = ?').get(run.template_id)?.phase;
        if ((item.photo_required || spotIds(run.id, run.template_id, tplPhase).has(item.id)) && !db.prepare('SELECT 1 FROM checklist_photos WHERE run_id = ? AND item_id = ? AND deleted_at IS NULL AND created_at > ?').get(runId, itemId, since)) {
          fail(400, since ? `Chụp ảnh mới cho "${item.text}" sau khi sửa rồi bấm xong lại` : `Chụp ảnh cho "${item.text}" trước khi bấm xong`);
        }
        // Làm lại sau khi bị chấm "Làm lại": về trạng thái chờ duyệt
        db.prepare(`INSERT INTO checklist_entries (run_id, item_id, value, done_by, done_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (run_id, item_id) DO UPDATE SET value = excluded.value, done_by = excluded.done_by, done_at = excluded.done_at,
            review_status = NULL, review_note = '', reviewed_by = NULL, reviewed_at = NULL`)
          .run(runId, itemId, value, me.id, ctx.now());
      }
      updateRun(run, me.id);
    });
    // Việc nối kho: sửa số / bỏ tick → huỷ lần kiểm cũ; nhập số → kiểm kho mới, báo nếu lệch quá mức cho phép
    let count = null;
    if (item.ingredient_id && ctx.stockCount) {
      if (prevCount) {
        ctx.undoCount(prevCount);
        db.prepare('UPDATE checklist_entries SET count_id = NULL WHERE run_id = ? AND item_id = ?').run(runId, itemId);
        const now = db.prepare('SELECT value FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(runId, itemId)?.value ?? '(bỏ)';
        ctx.audit(me, 'checklist.recount', { item: item.id, from: prevEntry.value, to: now });
        // Nhân viên sửa số cân → báo quản lý (chống sửa cho khớp sổ)
        if (rank(me.role) < rank('shift_lead') && now !== prevEntry.value) {
          ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id), {
            title: `${me.name} sửa số cân "${item.text}"`, body: `Từ ${prevEntry.value} → ${now} ${item.unit}. Kiểm tra lại nếu thấy lạ.`, link: '/checklist',
          });
        }
      }
      if (done && stockActual != null) count = countFromEntry(me, run, item, stockActual);
      // Nhân viên không xem số trên sổ (tránh cân cho khớp); trưởng ca trở lên xem đủ
      if (count && rank(me.role) < rank('shift_lead')) count = { name: count.name, text: 'Đã ghi tồn, app đã tự kiểm kho', over: false };
    }
    // Đầu ca đồng phục: "Số bạn đủ …" ít hơn "Số bạn … đi làm" → báo trưởng ca / quản lý
    if (done && item.kind === 'number' && /^Số bạn đủ/i.test(item.text)) {
      const total = db.prepare("SELECT e.value FROM checklist_entries e JOIN checklist_items i ON i.id = e.item_id WHERE e.run_id = ? AND i.text LIKE 'Số bạn % đi làm%'").get(run.id)?.value;
      const okN = Number(body.value);
      if (total != null && okN < Number(total)) {
        const tpl = db.prepare('SELECT title FROM checklist_templates WHERE id = ?').get(run.template_id);
        ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((x) => x.id).filter((x) => x !== me.id),
          { title: `${tpl?.title}: ${Number(total) - okN}/${total} bạn thiếu đồ`, body: `${me.name} ghi: ${okN}/${total} bạn đủ. Xem dòng "Bạn nào thiếu" trong checklist.`, link: '/checklist' });
      }
    }
    // Nhiệt độ tủ ngoài mức an toàn (tủ mát > 5°C, tủ đông > −15°C) → báo quản lý + tổ trưởng ngay
    if (done && item.kind === 'number' && /°c/i.test(item.unit)) {
      const val = Number(String(body.value).replace(',', '.'));
      const freezer = /đông/i.test(item.text);
      const limit = freezer ? Number(ctx.setting('freezer_max_c') || -15) : Number(ctx.setting('fridge_max_c') || 5);
      if (Number.isFinite(val) && val > limit) {
        const tpl = db.prepare('SELECT title, team_id FROM checklist_templates WHERE id = ?').get(run.template_id);
        const to = db.prepare("SELECT id FROM staff WHERE active = 1 AND (role IN ('owner','manager') OR (role = 'team_lead' AND team_id = ?))").all(tpl?.team_id ?? -1).map((x) => x.id).filter((x) => x !== me.id);
        ctx.notify(to, { title: `Tủ ${freezer ? 'đông' : 'mát'} ${val}°C (chuẩn ≤ ${limit}°C): ${tpl?.title || ''}`, body: `${me.name} ghi "${item.text}" = ${val}°C. Kiểm tra cửa tủ, đá bám, gioăng; đồ tươi chuyển tủ khác nếu tủ hỏng.`, link: '/checklist', urgent: true });
      }
    }
    ctx.broadcast('checklists');
    return { ok: true, count };
  });

  function countFromEntry(me, run, item, actual) {
    const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(item.ingredient_id);
    const e = db.prepare('SELECT * FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(run.id, item.id);
    if (!ing || !e) return null;
    const tpl = db.prepare('SELECT title FROM checklist_templates WHERE id = ?').get(run.template_id);
    // Cân chung nhiều loại: chia số cân theo tỉ lệ tồn trên sổ từng loại; lệch tính cho cả nhóm
    const ids = [ing.id, ...JSON.parse(item.extra_ingredient_ids || '[]').filter((x) => x !== ing.id)];
    const sid = ctx.effectiveStore ? ctx.effectiveStore(item.store_id) : item.store_id;
    const book = ids.map((id) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE store_id = ? AND ingredient_id = ?').get(sid, id).q);
    const sumBook = book.reduce((n, x) => n + x, 0);
    const parts = ids.map((id, k) => ({ ingredient_id: id, actual: ids.length === 1 ? actual : sumBook > 0 ? Math.round((actual * book[k] / sumBook) * 1000) / 1000 : k === 0 ? actual : 0 }));
    const res = ctx.stockCount(me, item.store_id, parts, `Checklist: ${tpl?.title || ''} · ${item.text}${ids.length > 1 ? ' (cân chung)' : ''}`);
    db.prepare('UPDATE checklist_entries SET count_id = ? WHERE run_id = ? AND item_id = ?').run(res.count_id, run.id, item.id);
    const l = res.lines.reduce((a, x) => ({ before: a.before + x.before, actual: a.actual + x.actual, diff: Math.round((a.diff + x.diff) * 1000) / 1000 }), { before: 0, actual: 0, diff: 0 });
    if (ids.length > 1) ing.name = `${item.text.replace(/\s*còn.*$/i, '') || 'Nhóm'} (${res.lines.map((x) => x.name).join(', ')})`;
    const pct = l.before > 0 ? Math.round((l.diff / l.before) * 1000) / 10 : null;
    const tol = Number(ctx.setting('count_tolerance_pct') || 3);
    const pk = packMode(item.unit, ing) ? ing.purchase_factor : 0;
    const show = (q) => (ing.unit === 'g' && Math.abs(q) >= 1000 ? `${(q / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} kg`
      : pk && Math.abs(q) >= pk ? `${Math.round(q * 100) / 100} ${ing.unit} (${Math.floor(Math.abs(q) / pk)} ${item.unit} + ${Math.round((Math.abs(q) % pk) * 100) / 100} lẻ)` : `${Math.round(q * 100) / 100} ${ing.unit}`);
    const over = l.diff !== 0 && (pct === null || Math.abs(pct) > tol);
    if (over) {
      const recipeQty = ids.length > 1 ? 100 : db.prepare('SELECT MIN(qty) AS q FROM menu_recipes WHERE ingredient_id = ? AND qty > 0').get(ing.id)?.q;
      const portions = recipeQty && l.diff < 0 ? ` ≈ ${Math.round(-l.diff / recipeQty)} phần` : '';
      ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id).filter((x) => x !== me.id), {
        title: `Lệch ${ing.name} ${l.diff < 0 ? 'THIẾU' : 'DƯ'} ${show(Math.abs(l.diff))}${pct !== null ? ` (${Math.abs(pct)}%)` : ''}${portions}`,
        body: `${me.name} cân ${show(l.actual)}, sổ phải còn ${show(l.before)} (đầu ca + nhập − đã bán × định lượng). ${l.diff < 0 ? 'Thiếu: thái dư tay, hư, hoặc lấy không ghi.' : 'Dư: thái thiếu tay (khách thiệt) hoặc nhập hàng chưa ghi.'} Mức cho phép ${tol}%.`,
        link: '/kho', urgent: Math.abs(pct ?? 100) > tol * 2,
      });
    }
    return { name: ing.name, unit: ing.unit, expected: l.before, actual: l.actual, diff: l.diff, pct, over, text: `Sổ ${show(l.before)} · cân ${show(l.actual)} · ${l.diff === 0 ? 'khớp' : `${l.diff < 0 ? 'thiếu' : 'dư'} ${show(Math.abs(l.diff))}${pct !== null ? ` (${Math.abs(pct)}%)` : ''}`}` };
  }
}
