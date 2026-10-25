// Phân hệ Kho & Tài sản theo chứng từ (spec chủ quán 25/10/2026, bản 2).
// Dùng lại bảng có sẵn: stores (vị trí kho), ingredients (mặt hàng), stock_lots (lô, FEFO), stock_moves (sổ biến động),
// suppliers, menu_recipes (định lượng), staff, teams, dining_tables. Chỉ thêm cột (đã hỏi chủ quán) + bảng mới tiền tố wh_.
// Nguyên tắc: mọi biến động tồn đi qua chứng từ; tồn chỉ đổi khi chứng từ ĐÃ DUYỆT (xuất bán tự động ghi ngay ở stock-sale.js);
// không ai duyệt chứng từ mình lập; người giữ kho không đếm kho mình; chứng từ đã duyệt không sửa (lập phiếu điều chỉnh).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { stockQty, addLot, takeLots, recordMove, costOf } from '../lib/stock.js';
import { addDays } from '../lib/time.js';
import { makeXlsx } from '../lib/xlsx.js';

export const WH_GROUPS = [
  // mã, tên, tần suất kiểm mặc định, ngưỡng vàng %, đỏ %
  ['TUOI', 'Hàng tươi (bò thái tay, rau, nấm, đậu hũ)', 'shift', 2, 3],
  ['LANH', 'Hàng lạnh / đông (bò steak, viên, hải sản)', 'shift', 2, 3],
  ['NONG', 'Bán thành phẩm nóng (nước lẩu, sốt, nước chấm)', 'day', 5, 10],
  ['TIEU_HAO', 'Tiêu hao (gia vị, dầu, gas, than, khăn giấy)', 'week', 5, 10],
  ['DO_UONG', 'Đồ uống (bia, nước ngọt)', 'shift', 0, 1],
  ['NHAN_SU', 'Đồ nhân sự (đồng phục, mũ, tạp dề, khăn, găng)', 'month', 0, 0],
  ['CCDC', 'Công cụ dụng cụ (chén, dĩa, ly, nồi lẩu, bếp mini…)', 'week', 0, 0],
  ['TAI_SAN', 'Tài sản (bàn, ghế, tủ, máy…)', 'halfyear', 0, 0],
];
export const WH_STORES = [['KHO_CHINH', 'Kho chính'], ['BEP', 'Kho bếp'], ['BAR', 'Tồn quầy bar'], ['CAP_PHAT', 'Kho cấp phát & tài sản']];
export const WH_ROLES = { thu_kho: 'Thủ kho', bep_truong: 'Bếp trưởng', truong_quay: 'Trưởng quầy bar', cap_phat: 'Phụ trách cấp phát', ke_toan: 'Kế toán' };
// Loại chứng từ: tên, kho nguồn/đích (theo mã kho), ai duyệt
export const VTYPES = {
  DNM: { name: 'Đề nghị mua', stock: false, approve: 'manager' },
  NM: { name: 'Nhập mua', to: true, approve: 'confirm' },          // người dùng hàng (≠ người lập) cân/đếm, ký
  NSX: { name: 'Sơ chế / nấu mẻ', from: true, to: true, approve: 'shift_lead' }, // dòng kind=in lấy ra, kind=out nhập vào
  NTL: { name: 'Nhập trả lại', from: true, to: true, approve: 'holder' },
  NDC: { name: 'Nhập điều chỉnh (kiểm kê thừa)', to: true, approve: 'auto' },
  XDC: { name: 'Xuất điều chỉnh (kiểm kê thiếu)', from: true, approve: 'auto' },
  XB: { name: 'Xuất bù đầu ca', from: true, to: true, approve: 'confirm' },
  YC: { name: 'Yêu cầu bổ sung', stock: false, approve: 'manager' },
  XH: { name: 'Xuất huỷ / bể vỡ', from: true, approve: 'shift_lead' },
  XCP: { name: 'Xuất cấp phát nhân viên', from: true, approve: 'target' },
  XCC: { name: 'Xuất thay CCDC', from: true, to: true, approve: 'ref_or_manager' },
  XTN: { name: 'Xuất trả NCC', from: true, approve: 'manager' },
  HK: { name: 'Hoàn kho (huỷ món đã bán)', to: true, approve: 'manager' },
  KK_CA: { name: 'Kiểm kê cuối ca', count: true, approve: 'manager' },
  KK_TUAN: { name: 'Kiểm kê tuần', count: true, approve: 'owner' },
  KK_THANG: { name: 'Kiểm kê tháng', count: true, approve: 'owner' },
  KK_DX: { name: 'Kiểm đột xuất', count: true, approve: 'none' },
  KK_DAU_KY: { name: 'Kiểm kê khởi tạo (tồn đầu kỳ)', count: true, approve: 'owner' },
};
export const WASTE_REASONS = { HONG: 'Hỏng', HET_HAN: 'Hết hạn', LAM_SAI: 'Làm sai', KHACH_TRA: 'Khách trả', DO_BO_CUOI_NGAY: 'Đổ bỏ cuối ngày', BE_VO: 'Bể vỡ', KHAC: 'Khác' };
const STATUS = { draft: 'Nháp', pending: 'Chờ duyệt', approved: 'Đã duyệt', cancelled: 'Huỷ' };

export default function (r, ctx) {
  const { db } = ctx;
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((x) => x.name);
  const addCol = (t, c, d) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  // ---------- Schema: thêm cột (đã được chủ quán đồng ý 25/10) ----------
  addCol('stores', 'code', "TEXT NOT NULL DEFAULT ''");
  addCol('stores', 'owner_id', 'INTEGER');
  addCol('ingredients', 'code', "TEXT NOT NULL DEFAULT ''");
  addCol('ingredients', 'group_code', "TEXT NOT NULL DEFAULT ''");
  addCol('ingredients', 'max_stock', 'REAL NOT NULL DEFAULT 0');
  addCol('ingredients', 'lot_tracked', 'INTEGER NOT NULL DEFAULT 0');
  addCol('ingredients', 'dev_pct', 'REAL');
  addCol('ingredients', 'size', "TEXT NOT NULL DEFAULT ''");
  addCol('ingredients', 'need_review', 'INTEGER NOT NULL DEFAULT 0');   // tạo khi kiểm kê khởi tạo, chưa có trong danh mục
  addCol('staff', 'wh_roles', "TEXT NOT NULL DEFAULT ''");              // thu_kho,bep_truong,truong_quay,cap_phat,ke_toan
  db.exec(`
  CREATE TABLE IF NOT EXISTS wh_groups (code TEXT PRIMARY KEY, name TEXT NOT NULL, count_freq TEXT NOT NULL DEFAULT 'week', warn_pct REAL NOT NULL DEFAULT 2, red_pct REAL NOT NULL DEFAULT 3, sort INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS wh_par (store_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL, qty REAL NOT NULL DEFAULT 0, PRIMARY KEY (store_id, ingredient_id));
  CREATE TABLE IF NOT EXISTS wh_prep (id INTEGER PRIMARY KEY, output_id INTEGER NOT NULL, input_id INTEGER NOT NULL, input_qty REAL NOT NULL, output_qty REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS wh_vouchers (
    id INTEGER PRIMARY KEY, no TEXT NOT NULL UNIQUE, type TEXT NOT NULL, date TEXT NOT NULL, shift TEXT NOT NULL DEFAULT '',
    from_store INTEGER, to_store INTEGER, supplier_id INTEGER, target_staff_id INTEGER, ref_id INTEGER,
    status TEXT NOT NULL DEFAULT 'draft', note TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER, created_at INTEGER NOT NULL, confirmed_by INTEGER, confirmed_at INTEGER, approved_by INTEGER, approved_at INTEGER,
    submitted_at INTEGER, paid_ok INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS whv_status ON wh_vouchers(status, type);
  CREATE TABLE IF NOT EXISTS wh_lines (
    id INTEGER PRIMARY KEY, voucher_id INTEGER NOT NULL REFERENCES wh_vouchers(id) ON DELETE CASCADE,
    ingredient_id INTEGER, name_free TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', qty REAL NOT NULL DEFAULT 0,
    qty_expected REAL, price INTEGER NOT NULL DEFAULT 0, expires_on TEXT, temp REAL, reason TEXT NOT NULL DEFAULT '', who_broke INTEGER,
    note TEXT NOT NULL DEFAULT '', diff REAL, pct REAL, color TEXT NOT NULL DEFAULT '', explain TEXT NOT NULL DEFAULT '', explain_by INTEGER, explain_at INTEGER);
  CREATE TABLE IF NOT EXISTS wh_photos (id INTEGER PRIMARY KEY, voucher_id INTEGER, asset_issue_id INTEGER, file TEXT NOT NULL, staff_id INTEGER, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS wh_issue_norms (id INTEGER PRIMARY KEY, team_id INTEGER, ingredient_id INTEGER NOT NULL, qty REAL NOT NULL DEFAULT 1, cycle_months INTEGER NOT NULL DEFAULT 12);
  CREATE TABLE IF NOT EXISTS wh_towels (id INTEGER PRIMARY KEY, date TEXT NOT NULL, shift TEXT NOT NULL DEFAULT '', issued INTEGER NOT NULL DEFAULT 0, returned INTEGER NOT NULL DEFAULT 0,
    to_laundry INTEGER NOT NULL DEFAULT 0, from_laundry INTEGER NOT NULL DEFAULT 0, diff INTEGER NOT NULL DEFAULT 0, explain TEXT NOT NULL DEFAULT '', staff_id INTEGER, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS wh_assets (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', bought_on TEXT, price INTEGER NOT NULL DEFAULT 0,
    supplier_id INTEGER, warranty_to TEXT, location TEXT NOT NULL DEFAULT '', owner_id INTEGER, status TEXT NOT NULL DEFAULT 'DANG_DUNG', table_number INTEGER,
    note TEXT NOT NULL DEFAULT '', qr TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS wh_maint (asset_id INTEGER PRIMARY KEY, cycle_days INTEGER NOT NULL DEFAULT 90, last_on TEXT, next_on TEXT);
  CREATE TABLE IF NOT EXISTS wh_maint_log (id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL, date TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', cost INTEGER NOT NULL DEFAULT 0, staff_id INTEGER, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS wh_asset_issues (id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL, staff_id INTEGER, at INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'MOI', handled_by INTEGER, handled_at INTEGER, result TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS wh_asset_minutes (id INTEGER PRIMARY KEY, type TEXT NOT NULL, asset_id INTEGER, content TEXT NOT NULL DEFAULT '', to_location TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', created_by INTEGER, created_at INTEGER NOT NULL, approved_by INTEGER, approved_at INTEGER);
  `);
  const seedGroups = db.prepare('INSERT OR IGNORE INTO wh_groups (code, name, count_freq, warn_pct, red_pct, sort) VALUES (?, ?, ?, ?, ?, ?)');
  WH_GROUPS.forEach(([c, n, f, w, rd], i) => seedGroups.run(c, n, f, w, rd, i));

  // ---------- 4 vị trí kho (chủ quán bấm "Bắt đầu kho mới" 1 lần): Kho tổng = KHO_CHINH, gộp Bếp steak + Lẩu = BEP, Bar = BAR, thêm CAP_PHAT ----------
  function setupStores() {
    if (ctx.setting('wh_stores_v1')) return;
    tx(db, () => {
      const main = db.prepare("SELECT * FROM stores WHERE kind = 'main' ORDER BY id LIMIT 1").get()
        || { id: Number(db.prepare("INSERT INTO stores (name, kind, sort) VALUES ('Kho chính', 'main', 0)").run().lastInsertRowid) };
      db.prepare("UPDATE stores SET code = 'KHO_CHINH', name = 'Kho chính' WHERE id = ?").run(main.id);
      const areas = db.prepare("SELECT s.*, t.name AS team_name FROM stores s LEFT JOIN teams t ON t.id = s.team_id WHERE s.kind = 'area' ORDER BY s.sort, s.id").all();
      const isBar = (s) => /bar/i.test(`${s.name} ${s.team_name || ''}`);
      const bar = areas.find(isBar);
      const kitchens = areas.filter((s) => !isBar(s));
      let bep = kitchens[0];
      if (!bep) bep = { id: Number(db.prepare("INSERT INTO stores (name, kind, sort) VALUES ('Kho bếp', 'area', 1)").run().lastInsertRowid) };
      db.prepare("UPDATE stores SET code = 'BEP', name = 'Kho bếp', active = 1 WHERE id = ?").run(bep.id);
      for (const k of kitchens.slice(1)) {
        // Gộp: lô, nguyên liệu nhà, mức chuẩn chuyển sang BEP; kho cũ tắt (giữ lịch sử)
        db.prepare('UPDATE stock_lots SET store_id = ? WHERE store_id = ?').run(bep.id, k.id);
        db.prepare('UPDATE ingredients SET home_store_id = ? WHERE home_store_id = ?').run(bep.id, k.id);
        db.prepare("UPDATE stores SET active = 0, code = '', name = name || ' (đã gộp vào Kho bếp)' WHERE id = ?").run(k.id);
      }
      if (bar) db.prepare("UPDATE stores SET code = 'BAR', name = 'Tồn quầy bar', active = 1 WHERE id = ?").run(bar.id);
      else db.prepare("INSERT INTO stores (name, kind, code, sort) VALUES ('Tồn quầy bar', 'area', 'BAR', 2)").run();
      if (!db.prepare("SELECT 1 FROM stores WHERE code = 'CAP_PHAT'").get()) db.prepare("INSERT INTO stores (name, kind, code, sort) VALUES ('Kho cấp phát & tài sản', 'issue', 'CAP_PHAT', 3)").run();
      ctx.setSetting('wh_stores_v1', '1');
    });
  }
  ctx.whSetup = setupStores;
  const storeByCode = (c) => db.prepare('SELECT * FROM stores WHERE code = ? AND active = 1').get(c);
  const storeById = (id) => (id ? db.prepare('SELECT * FROM stores WHERE id = ?').get(id) : null);
  const ing = (id) => db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
  const group = (code) => db.prepare('SELECT * FROM wh_groups WHERE code = ?').get(code);
  const setting = (k, d) => (ctx.setting(k) === '' || ctx.setting(k) == null ? d : ctx.setting(k));
  const num = (x, name, { min = 0, max = 1e9 } = {}) => {
    const n = Number(String(x ?? '').replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > max) fail(400, `${name} không hợp lệ`);
    return n;
  };
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const rolesOf = (st) => String(st?.wh_roles || '').split(',').filter(Boolean);
  const hasRole = (me, role) => me.role === 'owner' || rolesOf(db.prepare('SELECT wh_roles FROM staff WHERE id = ?').get(me.id)).includes(role);
  const isMgr = (me) => rank(me.role) >= rank('manager');
  const isLead = (me) => rank(me.role) >= rank('shift_lead');
  const staffName = (id) => (id ? db.prepare('SELECT name FROM staff WHERE id = ?').get(id)?.name || '' : '');
  const audit = (me, action, detail) => ctx.audit(me, `wh.${action}`, detail);
  const live = () => ctx.setting('wh_live') === '1';

  // ---------- Số phiếu tự sinh theo loại: NM-261025-001 ----------
  function nextNo(type) {
    const d = ctx.today().replace(/-/g, '').slice(2);
    const n = db.prepare('SELECT COUNT(*) AS n FROM wh_vouchers WHERE type = ? AND date = ?').get(type, ctx.today()).n + 1;
    let no = `${type}-${d}-${String(n).padStart(3, '0')}`;
    while (db.prepare('SELECT 1 FROM wh_vouchers WHERE no = ?').get(no)) no = `${no}x`;
    return no;
  }
  function shiftNow() {
    const m = ctx.clock().minuteOf(ctx.now());
    return m < 15 * 60 ? 'Sáng' : 'Tối';
  }

  // ---------- Đọc chứng từ đầy đủ ----------
  function load(id, me) {
    const vch = db.prepare('SELECT * FROM wh_vouchers WHERE id = ?').get(id);
    if (!vch) fail(404, 'Không tìm thấy chứng từ');
    const lines = db.prepare(`SELECT l.*, g.name AS ing_name, g.unit, g.purchase_unit, g.purchase_factor, g.group_code, g.code AS ing_code
      FROM wh_lines l LEFT JOIN ingredients g ON g.id = l.ingredient_id WHERE l.voucher_id = ? ORDER BY l.id`).all(id)
      .map((l) => ({ ...l, name: l.ing_name || l.name_free, who_broke_name: staffName(l.who_broke), explain_by_name: staffName(l.explain_by) }));
    const blind = VTYPES[vch.type]?.count && vch.status === 'draft' && me && !isMgr(me);
    return {
      ...vch, meta: JSON.parse(vch.meta || '{}'), type_name: VTYPES[vch.type]?.name || vch.type, status_name: STATUS[vch.status],
      from_name: storeById(vch.from_store)?.name || '', to_name: storeById(vch.to_store)?.name || '', supplier_name: vch.supplier_id ? db.prepare('SELECT name FROM suppliers WHERE id = ?').get(vch.supplier_id)?.name || '' : '',
      target_name: staffName(vch.target_staff_id), created_by_name: staffName(vch.created_by), confirmed_by_name: staffName(vch.confirmed_by), approved_by_name: staffName(vch.approved_by),
      lines: blind ? lines.map(({ qty_expected, diff, pct, color, ...l }) => l) : lines,
      photos: db.prepare('SELECT id, staff_id, at FROM wh_photos WHERE voucher_id = ?').all(id),
    };
  }
  ctx.whLoad = load;

  // ---------- Áp chứng từ vào tồn (chỉ khi duyệt) ----------
  function applyStock(vch, me) {
    const V = VTYPES[vch.type];
    if (!V || V.stock === false || V.count) return;
    const at = ctx.now(), date = ctx.today();
    const lines = db.prepare('SELECT * FROM wh_lines WHERE voucher_id = ? AND ingredient_id IS NOT NULL').all(vch.id);
    for (const l of lines) {
      const g = ing(l.ingredient_id);
      const qty = r3(l.qty);
      if (!(qty > 0)) continue;
      const ref = `wh:${vch.no}`;
      const moveType = { NM: 'receive', NSX: 'transfer', NTL: 'transfer', NDC: 'adjust', XDC: 'waste', XB: 'transfer', XH: 'waste', XCP: 'issue', XCC: 'transfer', XTN: 'return', HK: 'adjust' }[vch.type];
      if (vch.type === 'NSX') {
        // Sơ chế: kind in = nguyên liệu thô lấy khỏi BEP, kind out = thành phẩm nhập vào BEP
        if (l.kind === 'in') { takeLots(db, { storeId: vch.from_store, ingredientId: g.id, qty, allowShort: true, name: g.name }); recordMove(db, { at, date, type: 'consume', ingredientId: g.id, fromStore: vch.from_store, qty, cost: costOf(g, qty), ref, staffId: me.id, note: 'Sơ chế (xuất sản xuất)' }); }
        else { addLot(db, { storeId: vch.to_store, ingredientId: g.id, qty, expiresOn: l.expires_on, at }); recordMove(db, { at, date, type: 'adjust', ingredientId: g.id, toStore: vch.to_store, qty, ref, staffId: me.id, note: 'Sơ chế (nhập sản xuất)' }); }
        continue;
      }
      if (V.from && vch.from_store) {
        const strict = !['XH', 'XDC'].includes(vch.type);
        takeLots(db, { storeId: vch.from_store, ingredientId: g.id, qty, allowShort: !strict, name: `${g.name} (${storeById(vch.from_store)?.name})` });
      }
      if (V.to && vch.to_store) addLot(db, { storeId: vch.to_store, ingredientId: g.id, qty, expiresOn: l.expires_on || (g.shelf_days ? addDays(date, g.shelf_days) : null), at });
      const cost = vch.type === 'NM' && l.price ? Math.round((qty / (g.purchase_factor || 1)) * l.price) : costOf(g, qty);
      recordMove(db, { at, date, type: moveType, ingredientId: g.id, fromStore: V.from ? vch.from_store : null, toStore: V.to ? vch.to_store : null, qty, cost, ref, staffId: me.id,
        note: `${VTYPES[vch.type].name}${l.reason ? ` · ${WASTE_REASONS[l.reason] || l.reason}` : ''}${l.note ? ` · ${l.note}` : ''}` });
      // Giá vốn bình quân khi nhập mua (giá / đơn vị mua)
      if (vch.type === 'NM' && l.price > 0) {
        const haveUse = db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(g.id).q - qty;
        const oldP = (Math.max(0, haveUse) / (g.purchase_factor || 1)), newP = qty / (g.purchase_factor || 1);
        const avg = oldP + newP > 0 ? Math.round((oldP * (g.price || l.price) + newP * l.price) / (oldP + newP)) : l.price;
        db.prepare('UPDATE ingredients SET price = ? WHERE id = ?').run(avg, g.id);
      }
    }
    ctx.refreshAvailability?.();
  }

  // ---------- Quyền duyệt (backend) ----------
  function canApprove(vch, me) {
    if (vch.created_by === me.id) fail(403, 'Không được tự duyệt chứng từ do chính mình lập');
    const V = VTYPES[vch.type];
    const holderOf = (sid) => storeById(sid)?.owner_id;
    switch (V.approve) {
      case 'manager': if (!isMgr(me)) fail(403, 'Cần quản lý duyệt'); break;
      case 'owner': if (me.role !== 'owner') fail(403, 'Cần chủ quán duyệt'); break;
      case 'shift_lead': if (!isLead(me)) fail(403, 'Cần quản lý ca (trưởng ca trở lên) duyệt'); break;
      case 'holder': if (!(holderOf(vch.to_store) === me.id || isLead(me))) fail(403, 'Người giữ kho nhận mới xác nhận được'); break;
      case 'target': if (vch.target_staff_id !== me.id) fail(403, 'Chỉ nhân viên nhận đồ xác nhận trên tài khoản của mình'); break;
      case 'confirm': {
        // NM: người dùng hàng (bếp/bar, ≠ người lập) cân/đếm ký nhận; XB: bếp trưởng / trưởng quầy ký nhận
        const dest = storeById(vch.to_store);
        const ok = isLead(me) || holderOf(vch.to_store) === me.id || (dest?.code === 'BEP' && hasRole(me, 'bep_truong')) || (dest?.code === 'BAR' && hasRole(me, 'truong_quay'))
          || (vch.type === 'NM' && (hasRole(me, 'bep_truong') || hasRole(me, 'truong_quay') || hasRole(me, 'thu_kho')));
        if (!ok) fail(403, 'Người dùng hàng (bếp trưởng / trưởng quầy / người giữ kho) mới ký nhận được');
        if (vch.type === 'NM' && !db.prepare('SELECT 1 FROM wh_photos WHERE voucher_id = ?').get(vch.id)) fail(400, 'Nhập mua bắt buộc có ảnh số cân / hàng');
        break;
      }
      case 'ref_or_manager': if (!vch.ref_id && !isMgr(me)) fail(403, 'Không tham chiếu phiếu bể vỡ thì cần quản lý duyệt'); break;
      case 'auto': case 'none': break;
      default: fail(403, 'Không duyệt được loại này');
    }
  }

  // ---------- Tạo / sửa / gửi chứng từ ----------
  function readLines(type, body) {
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const out = [];
    for (const l of lines.slice(0, 300)) {
      const id = l.ingredient_id ? v.int(l.ingredient_id, { min: 1, name: 'Mặt hàng' }) : null;
      if (id && !ing(id)) fail(404, 'Không tìm thấy mặt hàng');
      const free = id ? '' : v.text(l.name_free, { name: 'Tên mặt hàng', max: 80 });
      if (!id && !free) continue;
      if (!id && type !== 'KK_DAU_KY') fail(400, 'Chọn mặt hàng trong danh mục');
      const qty = l.qty === '' || l.qty == null ? null : num(l.qty, `Số lượng ${id ? ing(id).name : free}`, { max: 1e7 });
      if (qty == null && !VTYPES[type].count) continue;
      const reason = l.reason ? v.oneOf(l.reason, Object.keys(WASTE_REASONS), { name: 'Lý do' }) : '';
      if (type === 'XH' && !reason) fail(400, 'Ghi huỷ cần chọn lý do');
      const whoBroke = l.who_broke ? v.int(l.who_broke, { min: 1, name: 'Người làm bể' }) : null;
      if (type === 'XH' && reason === 'BE_VO' && !whoBroke && !l.note) fail(400, 'Bể vỡ: ghi người làm bể (hoặc ghi chú nếu khách làm bể)');
      out.push({ ingredient_id: id, name_free: free, kind: l.kind === 'in' || l.kind === 'out' ? l.kind : '', qty: qty ?? 0, counted: qty != null,
        qty_expected: l.qty_expected == null || l.qty_expected === '' ? null : num(l.qty_expected, 'Số đặt', { max: 1e7 }),
        price: l.price ? Math.round(num(l.price, 'Đơn giá', { max: 1e9 })) : 0, expires_on: l.expires_on || null,
        temp: l.temp === '' || l.temp == null ? null : num(l.temp, 'Nhiệt độ', { min: -60, max: 60 }), reason, who_broke: whoBroke, note: v.text(l.note, { name: 'Ghi chú', max: 200 }) });
    }
    return out;
  }
  function writeLines(id, lines) {
    db.prepare('DELETE FROM wh_lines WHERE voucher_id = ?').run(id);
    const add = db.prepare(`INSERT INTO wh_lines (voucher_id, ingredient_id, name_free, kind, qty, qty_expected, price, expires_on, temp, reason, who_broke, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of lines) add.run(id, l.ingredient_id, l.name_free, l.kind, l.qty, l.qty_expected, l.price, l.expires_on, l.temp, l.reason, l.who_broke, l.note);
  }
  function storeArg(x, name) { if (!x) return null; const st = typeof x === 'string' && !/^\d+$/.test(x) ? storeByCode(x) : storeById(Number(x)); if (!st) fail(404, `Không tìm thấy ${name}`); return st.id; }

  function createVoucher(me, body) {
    const type = v.oneOf(body.type, Object.keys(VTYPES), { name: 'Loại chứng từ' });
    const V = VTYPES[type];
    const lines = readLines(type, body);
    if (!lines.length && !V.count) fail(400, 'Chứng từ cần ít nhất 1 dòng');
    let from = storeArg(body.from_store, 'kho xuất'), to = storeArg(body.to_store, 'kho nhận');
    // Mặc định theo loại
    if (type === 'XB' && !from) from = storeByCode('KHO_CHINH')?.id;
    if (type === 'NSX') { from = from || storeByCode('BEP')?.id; to = from; }
    if (['XCP', 'XCC'].includes(type) && !from) from = storeByCode('CAP_PHAT')?.id;
    if (type === 'XTN' && !from) from = storeByCode('KHO_CHINH')?.id;
    if (V.from && !from) fail(400, 'Chọn kho xuất');
    if (V.to && !to && type !== 'XCP') fail(400, 'Chọn kho nhận');
    if (V.count && !from) fail(400, 'Chọn kho kiểm kê');
    let refId = body.ref_id ? v.int(body.ref_id, { min: 1, name: 'Chứng từ gốc' }) : null;
    if (type === 'NM' && refId) {
      const dnm = db.prepare("SELECT * FROM wh_vouchers WHERE id = ? AND type = 'DNM'").get(refId);
      if (!dnm || dnm.status !== 'approved') fail(400, 'Đề nghị mua chưa được duyệt');
      if (dnm.created_by === me.id) fail(403, 'Người đề nghị mua không được tự nhận hàng (người đặt ≠ người nhận)');
      // Số thực nhận khác số đặt → bắt buộc lý do
      for (const l of lines) if (l.qty_expected != null && Math.abs(l.qty - l.qty_expected) > 1e-9 && !l.note) fail(400, `${ing(l.ingredient_id)?.name}: nhận khác số đặt, ghi lý do (thiếu, trả lại vì chất lượng…)`);
    }
    if (type === 'NM') for (const l of lines) { const g = ing(l.ingredient_id); if (g.group_code === 'LANH' && (l.temp == null || !l.expires_on)) fail(400, `${g.name}: hàng lạnh cần nhiệt độ khi nhận + hạn dùng`); }
    if (type === 'XCC' && refId) { const xh = db.prepare("SELECT * FROM wh_vouchers WHERE id = ? AND type = 'XH'").get(refId); if (!xh) fail(400, 'Phiếu bể vỡ tham chiếu không đúng'); }
    if (type === 'XCP') { const t = v.int(body.target_staff_id, { min: 1, name: 'Nhân viên nhận' }); if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1').get(t)) fail(404, 'Không tìm thấy nhân viên'); }
    if (type === 'XCP' && body.kind === 'DOI_CU_LAY_MOI' && !body.note) fail(400, 'Đổi cũ lấy mới: ghi đã thu món cũ nào');
    // Kiểm kê: người giữ kho không được đếm kho mình
    if (V.count && storeById(from)?.owner_id === me.id) fail(403, 'Người giữ kho này không được là người đếm');
    const meta = {};
    if (body.meta && typeof body.meta === 'object') for (const k of ['invoice_no', 'invoice_total', 'reason_text']) if (body.meta[k] != null) meta[k] = body.meta[k];
    const id = tx(db, () => {
      const vid = Number(db.prepare(`INSERT INTO wh_vouchers (no, type, date, shift, from_store, to_store, supplier_id, target_staff_id, ref_id, status, note, kind, meta, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`).run(nextNo(type), type, ctx.today(), body.shift || shiftNow(), from, to,
        body.supplier_id ? v.int(body.supplier_id, { min: 1, name: 'NCC' }) : null, type === 'XCP' ? Number(body.target_staff_id) : null, refId,
        v.text(body.note, { name: 'Ghi chú', max: 300 }), v.text(body.kind, { name: 'Loại', max: 30 }), JSON.stringify(meta), me.id, ctx.now()).lastInsertRowid);
      writeLines(vid, lines);
      return vid;
    });
    audit(me, 'create', { id, type });
    if (body.submit) return submitVoucher(me, id);
    return load(id, me);
  }
  ctx.whCreate = createVoucher;

  function submitVoucher(me, id) {
    const vch = db.prepare('SELECT * FROM wh_vouchers WHERE id = ?').get(id);
    if (!vch) fail(404, 'Không tìm thấy chứng từ');
    if (vch.status !== 'draft') fail(409, 'Chứng từ đã gửi');
    if (vch.created_by !== me.id && !isMgr(me)) fail(403, 'Chỉ người lập gửi được');
    const V = VTYPES[vch.type];
    if (vch.type === 'XH' && !db.prepare('SELECT 1 FROM wh_photos WHERE voucher_id = ?').get(id)) fail(400, 'Ghi huỷ / bể vỡ bắt buộc có ảnh');
    tx(db, () => {
      if (V.count) computeCount(vch);
      db.prepare("UPDATE wh_vouchers SET status = 'pending', submitted_at = ? WHERE id = ?").run(ctx.now(), id);
    });
    audit(me, 'submit', { id, no: vch.no });
    // Không cần duyệt (đột xuất) hoặc tự động
    if (['none', 'auto'].includes(V.approve)) return approveVoucher(me, id, { system: true });
    notifyApprovers(db.prepare('SELECT * FROM wh_vouchers WHERE id = ?').get(id));
    ctx.broadcast('wh');
    return load(id, me);
  }

  function notifyApprovers(vch) {
    const V = VTYPES[vch.type];
    let ids = [];
    if (V.approve === 'target') ids = [vch.target_staff_id];
    else if (V.approve === 'owner') ids = db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id);
    else if (V.approve === 'confirm') { const st = storeById(vch.to_store); ids = [st?.owner_id, ...db.prepare("SELECT id FROM staff WHERE active = 1 AND (role IN ('shift_lead','manager') OR wh_roles LIKE ?)").all(st?.code === 'BAR' ? '%truong_quay%' : '%bep_truong%').map((x) => x.id)]; }
    else if (V.approve === 'holder') ids = [storeById(vch.to_store)?.owner_id, ...ctx.managers()];
    else ids = db.prepare(`SELECT id FROM staff WHERE active = 1 AND role IN (${V.approve === 'shift_lead' ? "'shift_lead','manager','owner'" : "'manager','owner'"})`).all().map((x) => x.id);
    ids = [...new Set(ids.filter((x) => x && x !== vch.created_by))];
    if (ids.length) ctx.notify(ids, { title: `${V.name} ${vch.no} chờ ${V.approve === 'target' ? 'bạn xác nhận' : V.approve === 'confirm' ? 'ký nhận' : 'duyệt'}`, body: `Lập bởi ${staffName(vch.created_by)}`, link: `/kho-tx?v=${vch.id}` });
  }

  function approveVoucher(me, id, { system = false } = {}) {
    const vch = db.prepare('SELECT * FROM wh_vouchers WHERE id = ?').get(id);
    if (!vch) fail(404, 'Không tìm thấy chứng từ');
    if (vch.status !== 'pending') fail(409, `Chứng từ đang ở trạng thái ${STATUS[vch.status]}`);
    if (!system) canApprove(vch, me);
    const V = VTYPES[vch.type];
    if (V.count) {
      const red = db.prepare("SELECT COUNT(*) AS n FROM wh_lines WHERE voucher_id = ? AND color = 'red' AND explain = ''").get(id).n;
      if (red && vch.type !== 'KK_DAU_KY' && !system) fail(400, `Còn ${red} dòng đỏ chưa có giải trình của người phụ trách kho`);
    }
    tx(db, () => {
      if (V.count) applyCount(vch, me);
      else applyStock(vch, me);
      const confirmCol = ['confirm', 'target', 'holder'].includes(V.approve);
      db.prepare(`UPDATE wh_vouchers SET status = 'approved', approved_by = ?, approved_at = ?${confirmCol ? ', confirmed_by = ?, confirmed_at = ?' : ''} WHERE id = ?`)
        .run(...(confirmCol ? [system ? null : me.id, ctx.now(), system ? null : me.id, ctx.now(), id] : [system ? null : me.id, ctx.now(), id]));
    });
    if (vch.type === 'KK_DAU_KY') goLiveCheck(me);
    audit(me, 'approve', { id, no: vch.no, type: vch.type });
    if (vch.created_by && !system) ctx.notify(vch.created_by, { title: `${V.name} ${vch.no} đã ${['confirm', 'target'].includes(V.approve) ? 'được ký nhận' : 'được duyệt'}`, body: `Bởi ${me.name || ''}`, link: `/kho-tx?v=${vch.id}` });
    ctx.broadcast('wh'); ctx.broadcast('stock');
    return load(id, me);
  }
  ctx.whApprove = approveVoucher;

  function rejectVoucher(me, id, note) {
    const vch = db.prepare('SELECT * FROM wh_vouchers WHERE id = ?').get(id);
    if (!vch) fail(404, 'Không tìm thấy chứng từ');
    if (vch.status === 'approved') fail(409, 'Chứng từ đã duyệt không huỷ được; lập phiếu điều chỉnh');
    if (vch.created_by !== me.id) { if (vch.status === 'pending') canApprove(vch, me); else fail(403, 'Chỉ người lập huỷ được nháp'); }
    db.prepare("UPDATE wh_vouchers SET status = 'cancelled', note = TRIM(note || ' ' || ?) WHERE id = ?").run(note ? `[Huỷ: ${note}]` : '[Huỷ]', id);
    audit(me, 'cancel', { id, no: vch.no, note });
    if (vch.created_by !== me.id) ctx.notify(vch.created_by, { title: `${VTYPES[vch.type].name} ${vch.no} bị trả lại`, body: note || '', link: `/kho-tx?v=${id}` });
    ctx.broadcast('wh');
    return load(id, me);
  }

  // ---------- Kiểm kê mù: tính lý thuyết khi gửi, áp khi duyệt ----------
  // Lý thuyết = tồn sổ hiện tại (đã trừ bán theo định lượng, huỷ, xuất) − phần bán vượt sổ chưa trừ được kể từ lần kiểm trước
  function theoretical(storeId, ingId) {
    const lastAt = db.prepare(`SELECT MAX(v.approved_at) AS t FROM wh_vouchers v JOIN wh_lines l ON l.voucher_id = v.id
      WHERE v.status = 'approved' AND v.type LIKE 'KK_%' AND v.from_store = ? AND l.ingredient_id = ?`).get(storeId, ingId).t || 0;
    const short = db.prepare("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE type = 'short' AND from_store = ? AND ingredient_id = ? AND at > ?").get(storeId, ingId, lastAt).q;
    return r3(stockQty(db, storeId, ingId) - short);
  }
  ctx.whTheoretical = theoretical;
  function thresholds(g) {
    const gr = group(g.group_code) || { warn_pct: Number(setting('wh_default_warn', 2)), red_pct: Number(setting('wh_default_red', 3)) };
    if (g.dev_pct != null) return { warn: g.dev_pct, red: g.dev_pct * 1.5 };
    return { warn: gr.warn_pct, red: gr.red_pct };
  }
  function computeCount(vch) {
    for (const l of db.prepare('SELECT * FROM wh_lines WHERE voucher_id = ?').all(vch.id)) {
      if (!l.ingredient_id) { db.prepare("UPDATE wh_lines SET qty_expected = 0, diff = qty, pct = NULL, color = 'new' WHERE id = ?").run(l.id); continue; }
      const g = ing(l.ingredient_id);
      const th = theoretical(vch.from_store, g.id);
      const diff = r3(th - l.qty); // dương = thiếu so với lý thuyết
      const pct = th > 1e-9 ? Math.round((diff / th) * 10000) / 100 : (l.qty > 0 ? -100 : 0);
      const t = thresholds(g);
      const a = Math.abs(pct);
      const color = Math.abs(diff) < 1e-9 ? 'green' : a > t.red ? 'red' : a > t.warn ? 'yellow' : 'green';
      db.prepare('UPDATE wh_lines SET qty_expected = ?, diff = ?, pct = ?, color = ? WHERE id = ?').run(th, diff, pct, color, l.id);
    }
    const red = db.prepare("SELECT COUNT(*) AS n FROM wh_lines WHERE voucher_id = ? AND color = 'red'").get(vch.id).n;
    const st = storeById(vch.from_store);
    if (red && st?.owner_id) ctx.notify(st.owner_id, { title: `Kiểm kê ${st.name}: ${red} dòng lệch đỏ cần bạn giải trình trong ngày`, body: vch.no, link: `/kho-tx?v=${vch.id}`, urgent: true });
  }
  function applyCount(vch, me) {
    const at = ctx.now(), date = ctx.today();
    const ref = `wh:${vch.no}`;
    for (const l of db.prepare('SELECT * FROM wh_lines WHERE voucher_id = ?').all(vch.id)) {
      let ingId = l.ingredient_id;
      if (!ingId && vch.type === 'KK_DAU_KY' && l.name_free) {
        // Mặt hàng chưa có trong danh mục: tạo tạm, đánh dấu để bổ sung sau
        ingId = Number(db.prepare("INSERT INTO ingredients (name, unit, home_store_id, need_review) VALUES (?, 'cái', ?, 1)").run(l.name_free, vch.from_store).lastInsertRowid);
        db.prepare('UPDATE wh_lines SET ingredient_id = ? WHERE id = ?').run(ingId, l.id);
      }
      if (!ingId) continue;
      const g = ing(ingId);
      const book = stockQty(db, vch.from_store, ingId);
      const d = r3(l.qty - book);
      if (d < 0) { takeLots(db, { storeId: vch.from_store, ingredientId: ingId, qty: -d, allowShort: true }); recordMove(db, { at, date, type: vch.type === 'KK_DAU_KY' ? 'adjust' : 'waste', ingredientId: ingId, fromStore: vch.from_store, qty: -d, cost: costOf(g, -d), ref, staffId: me.id, note: `${VTYPES[vch.type].name}: thiếu so với sổ` }); }
      if (d > 0) { addLot(db, { storeId: vch.from_store, ingredientId: ingId, qty: d, at }); recordMove(db, { at, date, type: 'adjust', ingredientId: ingId, toStore: vch.from_store, qty: d, cost: costOf(g, d), ref, staffId: me.id, note: `${VTYPES[vch.type].name}: thừa so với sổ` }); }
    }
  }

  // Chốt tồn đầu kỳ: khi mọi vị trí kho đã có kiểm kê khởi tạo được duyệt → bật chế độ chứng từ (bán trừ đúng kho bếp/bar)
  function goLiveCheck(me) {
    const done = new Set(db.prepare("SELECT from_store FROM wh_vouchers WHERE type = 'KK_DAU_KY' AND status = 'approved'").all().map((x) => x.from_store));
    const need = ['KHO_CHINH', 'BEP', 'BAR'].map((c) => storeByCode(c)?.id).filter(Boolean);
    if (need.every((id) => done.has(id)) || ctx.setting('wh_live') === '1') {
      if (ctx.setting('wh_live') !== '1') {
        ctx.setSetting('wh_live', '1');
        ctx.setSetting('single_store', '0');
        ctx.setSetting('wh_live_at', String(ctx.now()));
        // Mặt hàng chưa có kho nhà: đồ uống → BAR, tươi/lạnh/nóng → BEP, còn lại → KHO_CHINH
        const by = { DO_UONG: 'BAR', TUOI: 'BEP', LANH: 'BEP', NONG: 'BEP', NHAN_SU: 'CAP_PHAT', CCDC: 'CAP_PHAT' };
        for (const g of db.prepare('SELECT id, group_code, home_store_id FROM ingredients').all()) {
          const want = storeByCode(by[g.group_code] || 'KHO_CHINH')?.id;
          const cur = storeById(g.home_store_id);
          if (!cur || !cur.active || !cur.code) db.prepare('UPDATE ingredients SET home_store_id = ? WHERE id = ?').run(want, g.id);
        }
        audit(me, 'go_live', { at: ctx.now() });
      }
    }
  }

  // ---------- Ảnh chứng từ / báo hỏng ----------
  const photoDir = path.join(ctx.photoDir || path.join(os.tmpdir(), 'quanly-photos'), 'kho');
  function savePhoto(data, { voucherId = null, issueId = null, me }) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!m) fail(400, 'Ảnh không hợp lệ');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500 || buf.length > 2_000_000) fail(400, 'Ảnh không hợp lệ, chụp lại giúp');
    fs.mkdirSync(photoDir, { recursive: true });
    const file = `${crypto.randomBytes(10).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(photoDir, file), buf);
    return Number(db.prepare('INSERT INTO wh_photos (voucher_id, asset_issue_id, file, staff_id, at) VALUES (?, ?, ?, ?, ?)').run(voucherId, issueId, file, me.id, ctx.now()).lastInsertRowid);
  }

  // ================= API =================
  // Danh mục + thông tin dùng chung cho màn hình
  r.get('/api/wh/meta', 'staff', ({ me }) => {
    const myRoles = me.role === 'owner' ? Object.keys(WH_ROLES) : rolesOf(db.prepare('SELECT wh_roles FROM staff WHERE id = ?').get(me.id));
    return {
      setup: !!ctx.setting('wh_stores_v1'), live: live(), my_roles: myRoles, role_names: WH_ROLES, types: Object.fromEntries(Object.entries(VTYPES).map(([k, x]) => [k, x.name])), reasons: WASTE_REASONS,
      stores: db.prepare("SELECT id, code, name, kind, owner_id FROM stores WHERE active = 1 AND code != '' ORDER BY sort, id").all().map((s) => ({ ...s, owner_name: staffName(s.owner_id) })),
      groups: db.prepare('SELECT * FROM wh_groups ORDER BY sort').all(),
      items: db.prepare(`SELECT id, code, name, unit, purchase_unit, purchase_factor, group_code, home_store_id, lot_tracked, shelf_days, min_stock, max_stock, price, size, need_review, supplier_id
        FROM ingredients WHERE active = 1 ORDER BY name`).all(),
      suppliers: db.prepare('SELECT id, name, phone FROM suppliers WHERE active = 1 ORDER BY name').all(),
      staff: db.prepare("SELECT s.id, s.name, s.role, s.team_id, s.wh_roles, t.name AS team_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id WHERE s.active = 1 ORDER BY s.name").all(),
      is_mgr: isMgr(me), is_lead: isLead(me), is_owner: me.role === 'owner',
    };
  });

  r.post('/api/wh/setup', 'owner', ({ me }) => { setupStores(); audit(me, 'setup', {}); ctx.broadcast('wh'); return { ok: true }; });

  // Tồn theo vị trí (thủ kho / quản lý xem; nhân viên chỉ thấy kho mình phụ trách)
  r.get('/api/wh/stock', 'staff', ({ me, query }) => {
    const st = storeArg(query.get('store') || 'KHO_CHINH', 'kho');
    const s = storeById(st);
    if (!isLead(me) && !hasRole(me, 'thu_kho') && s.owner_id !== me.id && !hasRole(me, 'ke_toan')) fail(403, 'Không xem được tồn kho này');
    const soon = Number(setting('wh_expiry_days', 2));
    const rows = db.prepare(`SELECT g.id, g.code, g.name, g.unit, g.group_code, g.min_stock, g.max_stock, COALESCE(SUM(l.qty), 0) AS qty, MIN(l.expires_on) AS exp
      FROM ingredients g LEFT JOIN stock_lots l ON l.ingredient_id = g.id AND l.store_id = ? WHERE g.active = 1 GROUP BY g.id HAVING qty > 0 OR g.home_store_id = ? ORDER BY g.name`).all(st, st);
    const par = new Map(db.prepare('SELECT ingredient_id, qty FROM wh_par WHERE store_id = ?').all(st).map((x) => [x.ingredient_id, x.qty]));
    return { store: s, rows: rows.map((x) => ({ ...x, qty: r3(x.qty), par: par.get(x.id) ?? null, low: x.min_stock > 0 && x.qty < x.min_stock, expiring: x.exp && x.exp <= addDays(ctx.today(), soon) })) };
  });

  // Danh sách chứng từ (lọc) + hàng chờ duyệt của tôi
  r.get('/api/wh/vouchers', 'staff', ({ me, query }) => {
    const type = query.get('type'), status = query.get('status'), mine = query.get('mine') === '1';
    const where = [], args = [];
    if (type) { where.push('type = ?'); args.push(type); }
    if (status) { where.push('status = ?'); args.push(status); }
    if (mine || !isLead(me)) { where.push('(created_by = ? OR target_staff_id = ? OR confirmed_by = ?)'); args.push(me.id, me.id, me.id); }
    return db.prepare(`SELECT id, no, type, date, shift, status, from_store, to_store, created_by, target_staff_id, created_at, approved_at, paid_ok FROM wh_vouchers
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 200`).all(...args)
      .map((x) => ({ ...x, type_name: VTYPES[x.type]?.name, status_name: STATUS[x.status], created_by_name: staffName(x.created_by), from_name: storeById(x.from_store)?.name || '', to_name: storeById(x.to_store)?.name || '' }));
  });
  // Hàng chờ duyệt (1 màn hình gom tất cả): những phiếu tôi được duyệt / ký nhận, không phải tôi lập
  r.get('/api/wh/inbox', 'staff', ({ me }) => {
    const out = [];
    for (const vch of db.prepare("SELECT * FROM wh_vouchers WHERE status = 'pending' ORDER BY id").all()) {
      try { canApprove(vch, me); out.push({ id: vch.id, no: vch.no, type: vch.type, type_name: VTYPES[vch.type].name, created_by_name: staffName(vch.created_by), created_at: vch.created_at, from_name: storeById(vch.from_store)?.name || '', to_name: storeById(vch.to_store)?.name || '' }); } catch { /* không phải việc của tôi */ }
    }
    const redToExplain = db.prepare(`SELECT l.id, l.voucher_id, v.no, g.name, l.diff, l.pct FROM wh_lines l JOIN wh_vouchers v ON v.id = l.voucher_id JOIN stores s ON s.id = v.from_store
      LEFT JOIN ingredients g ON g.id = l.ingredient_id WHERE l.color = 'red' AND l.explain = '' AND s.owner_id = ? AND v.status IN ('pending','approved')`).all(me.id);
    const assets = isLead(me) || hasRole(me, 'cap_phat') ? db.prepare("SELECT i.id, a.code, a.name, i.description, i.at FROM wh_asset_issues i JOIN wh_assets a ON a.id = i.asset_id WHERE i.status = 'MOI' ORDER BY i.id DESC").all() : [];
    return { vouchers: out, explain: redToExplain, asset_issues: assets };
  });
  r.get('/api/wh/vouchers/:id', 'staff', ({ me, params }) => load(params.id, me));
  r.post('/api/wh/vouchers', 'staff', ({ me, body }) => createVoucher(me, body));
  r.patch('/api/wh/vouchers/:id', 'staff', ({ me, params, body }) => {
    const vch = db.prepare('SELECT * FROM wh_vouchers WHERE id = ?').get(params.id);
    if (!vch) fail(404, 'Không tìm thấy chứng từ');
    if (vch.status !== 'draft') fail(409, 'Chỉ sửa được nháp. Chứng từ đã gửi / duyệt thì lập phiếu điều chỉnh');
    if (vch.created_by !== me.id) fail(403, 'Chỉ người lập sửa được');
    tx(db, () => { writeLines(vch.id, readLines(vch.type, body)); if (body.note !== undefined) db.prepare('UPDATE wh_vouchers SET note = ? WHERE id = ?').run(v.text(body.note, { name: 'Ghi chú', max: 300 }), vch.id); });
    audit(me, 'edit', { id: vch.id });
    return body.submit ? submitVoucher(me, vch.id) : load(vch.id, me);
  });
  r.post('/api/wh/vouchers/:id/submit', 'staff', ({ me, params }) => submitVoucher(me, params.id));
  r.post('/api/wh/vouchers/:id/approve', 'staff', ({ me, params }) => approveVoucher(me, params.id));
  r.post('/api/wh/vouchers/:id/reject', 'staff', ({ me, params, body }) => rejectVoucher(me, params.id, v.text(body.note, { name: 'Lý do', max: 200 })));
  r.post('/api/wh/vouchers/:id/photo', 'staff', ({ me, params, body }) => {
    const vch = db.prepare('SELECT * FROM wh_vouchers WHERE id = ?').get(params.id);
    if (!vch) fail(404, 'Không tìm thấy chứng từ');
    if (vch.status === 'approved' || vch.status === 'cancelled') fail(409, 'Chứng từ đã chốt');
    const id = savePhoto(body.data, { voucherId: vch.id, me });
    audit(me, 'photo', { voucher: vch.id });
    return { id };
  });
  r.get('/api/wh/photos/:id', 'staff', ({ params }) => {
    const p = db.prepare('SELECT * FROM wh_photos WHERE id = ?').get(params.id);
    if (!p) fail(404, 'Không có ảnh');
    let buf; try { buf = fs.readFileSync(path.join(photoDir, p.file)); } catch { fail(410, 'Ảnh không còn'); }
    return { __binary: buf, type: p.file.endsWith('.png') ? 'image/png' : p.file.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
  });
  // Giải trình dòng đỏ (người phụ trách vị trí kho)
  r.post('/api/wh/lines/:id/explain', 'staff', ({ me, params, body }) => {
    const l = db.prepare('SELECT l.*, v.from_store, v.no FROM wh_lines l JOIN wh_vouchers v ON v.id = l.voucher_id WHERE l.id = ?').get(params.id);
    if (!l) fail(404, 'Không tìm thấy dòng');
    const owner = storeById(l.from_store)?.owner_id;
    if (owner !== me.id && !(owner == null && isLead(me))) fail(403, 'Người phụ trách kho mới giải trình được');
    const text = v.text(body.text, { name: 'Giải trình', required: true, max: 300 });
    db.prepare('UPDATE wh_lines SET explain = ?, explain_by = ?, explain_at = ? WHERE id = ?').run(text, me.id, ctx.now(), l.id);
    audit(me, 'explain', { line: l.id, no: l.no });
    ctx.broadcast('wh');
    return { ok: true };
  });

  // ---------- Đề nghị mua: gợi ý hàng dưới tồn tối thiểu ----------
  r.get('/api/wh/suggest-purchase', 'staff', () => db.prepare(`SELECT g.id, g.name, g.unit, g.purchase_unit, g.purchase_factor, g.min_stock, g.max_stock, g.price, g.supplier_id,
      COALESCE((SELECT SUM(qty) FROM stock_lots WHERE ingredient_id = g.id), 0) AS have FROM ingredients g WHERE g.active = 1 AND g.min_stock > 0`).all()
    .filter((x) => x.have < x.min_stock).map((x) => ({ ...x, have: r3(x.have), suggest: r3(Math.max(x.max_stock || x.min_stock * 2, x.min_stock) - x.have) })));

  // Đối chiếu 3 chứng từ: đề nghị đã duyệt – phiếu nhập – hoá đơn NCC → khớp mới được thanh toán
  r.post('/api/wh/vouchers/:id/match', 'staff', ({ me, params, body }) => {
    if (!hasRole(me, 'ke_toan') && !isMgr(me)) fail(403, 'Kế toán / quản lý mới đối chiếu được');
    const nm = db.prepare("SELECT * FROM wh_vouchers WHERE id = ? AND type = 'NM'").get(params.id);
    if (!nm) fail(404, 'Không tìm thấy phiếu nhập mua');
    if (nm.status !== 'approved') fail(400, 'Phiếu nhập chưa được ký nhận');
    if (!nm.ref_id) fail(400, 'Phiếu nhập không gắn đề nghị mua');
    const invoiceNo = v.text(body.invoice_no, { name: 'Số hoá đơn', required: true, max: 40 });
    const invoiceTotal = Math.round(num(body.invoice_total, 'Tổng hoá đơn', { max: 1e11 }));
    const lines = db.prepare('SELECT l.*, g.purchase_factor FROM wh_lines l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.voucher_id = ?').all(nm.id);
    const nmTotal = Math.round(lines.reduce((s, l) => s + (l.qty / (l.purchase_factor || 1)) * l.price, 0));
    const dnmLines = new Map(db.prepare('SELECT ingredient_id, qty FROM wh_lines WHERE voucher_id = ?').all(nm.ref_id).map((x) => [x.ingredient_id, x.qty]));
    const issues = [];
    for (const l of lines) { const want = dnmLines.get(l.ingredient_id); if (want == null) issues.push(`${ing(l.ingredient_id).name}: không có trong đề nghị`); else if (l.qty - want > 1e-9) issues.push(`${ing(l.ingredient_id).name}: nhận ${l.qty} > đề nghị ${want}`); }
    const tol = Number(setting('wh_match_tolerance', 1000));
    if (Math.abs(invoiceTotal - nmTotal) > tol) issues.push(`Hoá đơn ${invoiceTotal.toLocaleString('vi-VN')}đ ≠ phiếu nhập ${nmTotal.toLocaleString('vi-VN')}đ`);
    const meta = { ...JSON.parse(nm.meta || '{}'), invoice_no: invoiceNo, invoice_total: invoiceTotal, nm_total: nmTotal, match_issues: issues, matched_by: me.id, matched_at: ctx.now() };
    db.prepare('UPDATE wh_vouchers SET meta = ?, paid_ok = ? WHERE id = ?').run(JSON.stringify(meta), issues.length ? 0 : 1, nm.id);
    audit(me, 'match', { id: nm.id, ok: !issues.length, issues });
    return { ok: !issues.length, issues, nm_total: nmTotal };
  });

  // ---------- Xuất bù đầu ca: app tính = mức chuẩn − tồn hiện tại ----------
  r.get('/api/wh/restock', 'staff', ({ query }) => {
    const to = storeArg(query.get('store') || 'BEP', 'kho');
    const main = storeByCode('KHO_CHINH')?.id;
    return db.prepare('SELECT p.ingredient_id, p.qty AS par, g.name, g.unit FROM wh_par p JOIN ingredients g ON g.id = p.ingredient_id WHERE p.store_id = ? AND g.active = 1 ORDER BY g.name').all(to)
      .map((x) => { const have = stockQty(db, to, x.ingredient_id); const inMain = main ? stockQty(db, main, x.ingredient_id) : 0; const need = r3(Math.max(0, x.par - have)); return { ...x, have, main_stock: inMain, need, give: r3(Math.min(need, inMain)) }; })
      .filter((x) => x.need > 0);
  });
  r.get('/api/wh/par', 'staff', ({ query }) => db.prepare('SELECT p.*, g.name, g.unit FROM wh_par p JOIN ingredients g ON g.id = p.ingredient_id WHERE p.store_id = ? ORDER BY g.name').all(storeArg(query.get('store') || 'BEP', 'kho')));
  r.put('/api/wh/par', 'manager', ({ me, body }) => {
    const st = storeArg(body.store, 'kho');
    tx(db, () => { for (const x of (body.items || [])) { const q = num(x.qty, 'Mức chuẩn', { max: 1e6 }); if (q > 0) db.prepare('INSERT OR REPLACE INTO wh_par (store_id, ingredient_id, qty) VALUES (?, ?, ?)').run(st, v.int(x.ingredient_id, { min: 1, name: 'Mặt hàng' }), q); else db.prepare('DELETE FROM wh_par WHERE store_id = ? AND ingredient_id = ?').run(st, Number(x.ingredient_id)); } });
    audit(me, 'par', { store: st, n: (body.items || []).length });
    return { ok: true };
  });

  // ---------- Bán thành phẩm (yield chuẩn) ----------
  r.get('/api/wh/prep', 'staff', () => db.prepare(`SELECT p.*, o.name AS output_name, o.unit AS output_unit, i.name AS input_name, i.unit AS input_unit FROM wh_prep p
    JOIN ingredients o ON o.id = p.output_id JOIN ingredients i ON i.id = p.input_id ORDER BY o.name`).all());
  r.put('/api/wh/prep', 'manager', ({ me, body }) => {
    const out = v.int(body.output_id, { min: 1, name: 'Bán thành phẩm' }), inp = v.int(body.input_id, { min: 1, name: 'Nguyên liệu thô' });
    db.prepare('DELETE FROM wh_prep WHERE output_id = ? AND input_id = ?').run(out, inp);
    db.prepare('INSERT INTO wh_prep (output_id, input_id, input_qty, output_qty) VALUES (?, ?, ?, ?)').run(out, inp, num(body.input_qty, 'Lượng thô', { min: 0.001 }), num(body.output_qty, 'Sản lượng', { min: 0.001 }));
    audit(me, 'prep', { out, inp });
    return { ok: true };
  });

  // ---------- Nhân sự: định mức, đang giữ, khăn, nghỉ việc ----------
  function holdings(staffId) {
    const rows = db.prepare(`SELECT l.ingredient_id, g.name, g.size, SUM(CASE WHEN v.type = 'XCP' THEN l.qty ELSE -l.qty END) AS qty
      FROM wh_lines l JOIN wh_vouchers v ON v.id = l.voucher_id JOIN ingredients g ON g.id = l.ingredient_id
      WHERE v.status = 'approved' AND ((v.type = 'XCP' AND v.target_staff_id = ?) OR (v.type = 'NTL' AND v.kind = 'staff' AND v.created_by = ?)) GROUP BY l.ingredient_id`).all(staffId, staffId);
    return rows.filter((x) => x.qty > 1e-9).map((x) => ({ ...x, qty: r3(x.qty) }));
  }
  ctx.whHoldings = holdings;
  r.get('/api/wh/my-items', 'staff', ({ me }) => ({
    holding: holdings(me.id),
    to_confirm: db.prepare("SELECT id, no, created_at FROM wh_vouchers WHERE type = 'XCP' AND target_staff_id = ? AND status = 'pending'").all(me.id),
  }));
  r.get('/api/wh/holdings', 'staff', ({ me }) => {
    if (!isLead(me) && !hasRole(me, 'cap_phat')) fail(403, 'Không xem được');
    return db.prepare('SELECT id, name, active FROM staff ORDER BY active DESC, name').all().map((s) => ({ ...s, items: holdings(s.id) })).filter((s) => s.items.length || s.active);
  });
  r.get('/api/wh/norms', 'staff', () => db.prepare('SELECT n.*, g.name, t.name AS team_name FROM wh_issue_norms n JOIN ingredients g ON g.id = n.ingredient_id LEFT JOIN teams t ON t.id = n.team_id ORDER BY t.name, g.name').all());
  r.post('/api/wh/norms', 'manager', ({ me, body }) => {
    const id = Number(db.prepare('INSERT INTO wh_issue_norms (team_id, ingredient_id, qty, cycle_months) VALUES (?, ?, ?, ?)').run(body.team_id ? Number(body.team_id) : null, v.int(body.ingredient_id, { min: 1, name: 'Mặt hàng' }), num(body.qty, 'Số lượng', { min: 0.001 }), v.int(body.cycle_months ?? 12, { min: 1, max: 120, name: 'Chu kỳ' })).lastInsertRowid);
    audit(me, 'norm', { id }); return { id };
  });
  r.get('/api/wh/towels', 'staff', () => db.prepare('SELECT t.*, s.name AS staff_name FROM wh_towels t LEFT JOIN staff s ON s.id = t.staff_id ORDER BY t.id DESC LIMIT 60').all());
  r.post('/api/wh/towels', 'staff', ({ me, body }) => {
    if (!isLead(me) && !hasRole(me, 'cap_phat')) fail(403, 'Quản lý ca ghi khăn');
    const n = (k) => Math.round(num(body[k] ?? 0, k, { max: 100000 }));
    const issued = n('issued'), returned = n('returned'), toL = n('to_laundry'), fromL = n('from_laundry');
    const diff = issued - returned; // phát ra mà không thu về = thất lạc
    const explain = v.text(body.explain, { name: 'Giải trình', max: 300 });
    if (diff > Number(setting('wh_towel_tolerance', 0)) && !explain) fail(400, `Khăn lệch ${diff} cái: ghi giải trình`);
    const id = Number(db.prepare('INSERT INTO wh_towels (date, shift, issued, returned, to_laundry, from_laundry, diff, explain, staff_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.today(), body.shift || shiftNow(), issued, returned, toL, fromL, diff, explain, me.id, ctx.now()).lastInsertRowid);
    audit(me, 'towel', { id, diff });
    return { id, diff };
  });
  // Checklist nghỉ việc: đồ đang giữ chưa thu hồi
  r.get('/api/wh/offboarding', 'staff', ({ me }) => {
    if (!isLead(me) && !hasRole(me, 'cap_phat')) fail(403, 'Không xem được');
    return db.prepare('SELECT id, name FROM staff WHERE active = 0 ORDER BY name').all().map((s) => ({ ...s, items: holdings(s.id) })).filter((s) => s.items.length);
  });

  // ---------- Tài sản: danh sách, QR, báo hỏng, bảo trì, biên bản ----------
  const ASSET_STATUS = { DANG_DUNG: 'Đang dùng', HONG: 'Hỏng', DANG_SUA: 'Đang sửa', THANH_LY: 'Thanh lý' };
  r.get('/api/wh/assets', 'staff', ({ query }) => {
    const q = query.get('code');
    const rows = db.prepare(`SELECT a.*, m.cycle_days, m.last_on, m.next_on FROM wh_assets a LEFT JOIN wh_maint m ON m.asset_id = a.id ${q ? 'WHERE a.code = ?' : ''} ORDER BY a.code`).all(...(q ? [q] : []));
    return rows.map((a) => ({ ...a, status_name: ASSET_STATUS[a.status], owner_name: staffName(a.owner_id), maint_due: a.next_on && a.next_on <= ctx.today(), warranty_over: a.warranty_to && a.warranty_to < ctx.today() }));
  });
  function readAsset(body) {
    return {
      code: v.text(body.code, { name: 'Mã tài sản', required: true, max: 30 }).toUpperCase(), name: v.text(body.name, { name: 'Tên', required: true, max: 80 }), kind: v.text(body.kind, { name: 'Loại', max: 30 }),
      bought_on: body.bought_on || null, price: body.price ? Math.round(num(body.price, 'Giá mua')) : 0, warranty_to: body.warranty_to || null, location: v.text(body.location, { name: 'Vị trí', max: 60 }),
      owner_id: body.owner_id ? Number(body.owner_id) : null, table_number: body.table_number ? v.int(body.table_number, { min: 1, name: 'Số bàn' }) : null, note: v.text(body.note, { name: 'Ghi chú', max: 200 }),
    };
  }
  r.post('/api/wh/assets', 'staff', ({ me, body }) => {
    if (!isMgr(me) && !hasRole(me, 'cap_phat')) fail(403, 'Người phụ trách cấp phát / quản lý mới thêm tài sản');
    const a = readAsset(body);
    if (db.prepare('SELECT 1 FROM wh_assets WHERE code = ?').get(a.code)) fail(409, `Mã ${a.code} đã có`);
    const id = Number(db.prepare(`INSERT INTO wh_assets (code, name, kind, bought_on, price, warranty_to, location, owner_id, table_number, note, qr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.code, a.name, a.kind, a.bought_on, a.price, a.warranty_to, a.location, a.owner_id, a.table_number, a.note, a.code, ctx.now()).lastInsertRowid);
    if (body.cycle_days) db.prepare('INSERT OR REPLACE INTO wh_maint (asset_id, cycle_days, last_on, next_on) VALUES (?, ?, ?, ?)').run(id, Number(body.cycle_days), ctx.today(), addDays(ctx.today(), Number(body.cycle_days)));
    audit(me, 'asset.create', { id, code: a.code });
    return { id };
  });
  // Sinh mã hàng loạt: vd BAN 1–100 → BAN-001..BAN-100 (gắn số bàn)
  r.post('/api/wh/assets/bulk', 'staff', ({ me, body }) => {
    if (!isMgr(me) && !hasRole(me, 'cap_phat')) fail(403, 'Không có quyền');
    const prefix = v.text(body.prefix, { name: 'Tiền tố mã', required: true, max: 10 }).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = v.text(body.name, { name: 'Tên', required: true, max: 60 });
    const from = v.int(body.from ?? 1, { min: 1, max: 9999, name: 'Từ số' }), to = v.int(body.to, { min: from, max: from + 499, name: 'Đến số' });
    let n = 0;
    tx(db, () => { for (let i = from; i <= to; i++) { const code = `${prefix}-${String(i).padStart(3, '0')}`; if (db.prepare('SELECT 1 FROM wh_assets WHERE code = ?').get(code)) continue; db.prepare('INSERT INTO wh_assets (code, name, kind, location, table_number, qr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(code, `${name} ${i}`, prefix, v.text(body.location, { name: 'Vị trí', max: 60 }), body.is_table ? i : null, code, ctx.now()); n++; } });
    audit(me, 'asset.bulk', { prefix, from, to, n });
    return { created: n };
  });
  r.patch('/api/wh/assets/:id', 'staff', ({ me, params, body }) => {
    if (!isMgr(me) && !hasRole(me, 'cap_phat')) fail(403, 'Không có quyền');
    const a = db.prepare('SELECT * FROM wh_assets WHERE id = ?').get(params.id);
    if (!a) fail(404, 'Không tìm thấy tài sản');
    if (body.status) { const s = v.oneOf(body.status, Object.keys(ASSET_STATUS), { name: 'Trạng thái' }); if (s === 'THANH_LY') fail(400, 'Thanh lý phải qua biên bản tài sản'); db.prepare('UPDATE wh_assets SET status = ? WHERE id = ?').run(s, a.id); }
    if (body.owner_id !== undefined) db.prepare('UPDATE wh_assets SET owner_id = ? WHERE id = ?').run(body.owner_id ? Number(body.owner_id) : null, a.id);
    if (body.location !== undefined) db.prepare('UPDATE wh_assets SET location = ? WHERE id = ?').run(v.text(body.location, { name: 'Vị trí', max: 60 }), a.id);
    if (body.cycle_days !== undefined) db.prepare('INSERT OR REPLACE INTO wh_maint (asset_id, cycle_days, last_on, next_on) VALUES (?, ?, COALESCE((SELECT last_on FROM wh_maint WHERE asset_id = ?), ?), ?)').run(a.id, Number(body.cycle_days), a.id, ctx.today(), addDays(ctx.today(), Number(body.cycle_days)));
    audit(me, 'asset.update', { id: a.id, body });
    return { ok: true };
  });
  // Báo hỏng (ai cũng báo được, quét QR ra mã)
  r.post('/api/wh/assets/issue', 'staff', ({ me, body }) => {
    const a = db.prepare('SELECT * FROM wh_assets WHERE code = ? OR id = ?').get(String(body.code || '').toUpperCase(), Number(body.asset_id) || 0);
    if (!a) fail(404, 'Không tìm thấy tài sản (kiểm tra mã trên tem)');
    const id = Number(db.prepare('INSERT INTO wh_asset_issues (asset_id, staff_id, at, description) VALUES (?, ?, ?, ?)').run(a.id, me.id, ctx.now(), v.text(body.description, { name: 'Mô tả', required: true, max: 300 })).lastInsertRowid);
    if (body.photo) savePhoto(body.photo, { issueId: id, me });
    db.prepare("UPDATE wh_assets SET status = 'HONG' WHERE id = ? AND status = 'DANG_DUNG'").run(a.id);
    const ids = [a.owner_id, ...db.prepare("SELECT id FROM staff WHERE active = 1 AND (role IN ('manager','owner') OR wh_roles LIKE '%cap_phat%')").all().map((x) => x.id)].filter((x) => x && x !== me.id);
    ctx.notify([...new Set(ids)], { title: `Báo hỏng ${a.code} · ${a.name}`, body: `${me.name || ''}: ${body.description}`, link: '/kho-tx?tab=ts', urgent: true });
    audit(me, 'asset.issue', { asset: a.id, id });
    return { id, asset: a };
  });
  r.post('/api/wh/assets/issues/:id/handle', 'staff', ({ me, params, body }) => {
    if (!isLead(me) && !hasRole(me, 'cap_phat')) fail(403, 'Không có quyền');
    const i = db.prepare('SELECT * FROM wh_asset_issues WHERE id = ?').get(params.id);
    if (!i) fail(404, 'Không tìm thấy');
    const st = v.oneOf(body.status, ['DANG_SUA', 'XONG'], { name: 'Trạng thái' });
    db.prepare('UPDATE wh_asset_issues SET status = ?, handled_by = ?, handled_at = ?, result = ? WHERE id = ?').run(st, me.id, ctx.now(), v.text(body.result, { name: 'Kết quả', max: 200 }), i.id);
    db.prepare('UPDATE wh_assets SET status = ? WHERE id = ?').run(st === 'XONG' ? 'DANG_DUNG' : 'DANG_SUA', i.asset_id);
    audit(me, 'asset.handle', { id: i.id, st });
    return { ok: true };
  });
  r.post('/api/wh/assets/:id/maint', 'staff', ({ me, params, body }) => {
    if (!isLead(me) && !hasRole(me, 'cap_phat')) fail(403, 'Không có quyền');
    const a = db.prepare('SELECT * FROM wh_assets WHERE id = ?').get(params.id);
    if (!a) fail(404, 'Không tìm thấy tài sản');
    db.prepare('INSERT INTO wh_maint_log (asset_id, date, content, cost, staff_id, at) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, ctx.today(), v.text(body.content, { name: 'Nội dung', required: true, max: 200 }), body.cost ? Math.round(num(body.cost, 'Chi phí')) : 0, me.id, ctx.now());
    const m = db.prepare('SELECT * FROM wh_maint WHERE asset_id = ?').get(a.id);
    if (m) db.prepare('UPDATE wh_maint SET last_on = ?, next_on = ? WHERE asset_id = ?').run(ctx.today(), addDays(ctx.today(), m.cycle_days), a.id);
    audit(me, 'asset.maint', { id: a.id });
    return { ok: true };
  });
  r.post('/api/wh/asset-minutes', 'staff', ({ me, body }) => {
    if (!isLead(me) && !hasRole(me, 'cap_phat')) fail(403, 'Không có quyền');
    const type = v.oneOf(body.type, ['DIEU_CHUYEN', 'HU_HONG', 'THANH_LY'], { name: 'Loại biên bản' });
    const a = db.prepare('SELECT * FROM wh_assets WHERE id = ?').get(v.int(body.asset_id, { min: 1, name: 'Tài sản' }));
    if (!a) fail(404, 'Không tìm thấy tài sản');
    const id = Number(db.prepare('INSERT INTO wh_asset_minutes (type, asset_id, content, to_location, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(type, a.id, v.text(body.content, { name: 'Nội dung', required: true, max: 400 }), v.text(body.to_location, { name: 'Nơi chuyển đến', max: 60 }), me.id, ctx.now()).lastInsertRowid);
    ctx.notify(ctx.managers().filter((x) => x !== me.id), { title: `Biên bản tài sản ${a.code} chờ duyệt`, body: type, link: '/kho-tx?tab=ts' });
    audit(me, 'minute.create', { id, type, asset: a.id });
    return { id };
  });
  r.get('/api/wh/asset-minutes', 'staff', () => db.prepare('SELECT m.*, a.code, a.name FROM wh_asset_minutes m JOIN wh_assets a ON a.id = m.asset_id ORDER BY m.id DESC LIMIT 100').all().map((m) => ({ ...m, created_by_name: staffName(m.created_by), approved_by_name: staffName(m.approved_by) })));
  r.post('/api/wh/asset-minutes/:id/approve', 'manager', ({ me, params }) => {
    const m = db.prepare('SELECT * FROM wh_asset_minutes WHERE id = ?').get(params.id);
    if (!m || m.status !== 'pending') fail(404, 'Không tìm thấy biên bản chờ duyệt');
    if (m.created_by === me.id) fail(403, 'Không được tự duyệt biên bản do chính mình lập');
    tx(db, () => {
      db.prepare("UPDATE wh_asset_minutes SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(me.id, ctx.now(), m.id);
      if (m.type === 'THANH_LY') db.prepare("UPDATE wh_assets SET status = 'THANH_LY' WHERE id = ?").run(m.asset_id);
      if (m.type === 'HU_HONG') db.prepare("UPDATE wh_assets SET status = 'HONG' WHERE id = ?").run(m.asset_id);
      if (m.type === 'DIEU_CHUYEN' && m.to_location) db.prepare('UPDATE wh_assets SET location = ? WHERE id = ?').run(m.to_location, m.asset_id);
    });
    audit(me, 'minute.approve', { id: m.id });
    return { ok: true };
  });

  // ---------- Cấu hình (ngưỡng, nhóm hàng, người phụ trách, vai trò kho) ----------
  r.put('/api/wh/groups/:code', 'owner', ({ me, params, body }) => {
    const g = group(params.code);
    if (!g) fail(404, 'Không tìm thấy nhóm');
    db.prepare('UPDATE wh_groups SET count_freq = ?, warn_pct = ?, red_pct = ? WHERE code = ?').run(v.oneOf(body.count_freq ?? g.count_freq, ['shift', 'day', 'week', 'month', 'halfyear'], { name: 'Tần suất' }), num(body.warn_pct ?? g.warn_pct, 'Ngưỡng vàng', { max: 100 }), num(body.red_pct ?? g.red_pct, 'Ngưỡng đỏ', { max: 100 }), g.code);
    audit(me, 'group', { code: g.code, body });
    return { ok: true };
  });
  r.put('/api/wh/stores/:id/owner', 'owner', ({ me, params, body }) => {
    const st = storeById(Number(params.id));
    if (!st) fail(404, 'Không tìm thấy kho');
    db.prepare('UPDATE stores SET owner_id = ? WHERE id = ?').run(body.owner_id ? Number(body.owner_id) : null, st.id);
    audit(me, 'store.owner', { store: st.id, owner: body.owner_id });
    return { ok: true };
  });
  r.put('/api/wh/staff/:id/roles', 'owner', ({ me, params, body }) => {
    const roles = (Array.isArray(body.roles) ? body.roles : []).filter((x) => WH_ROLES[x]);
    db.prepare('UPDATE staff SET wh_roles = ? WHERE id = ?').run(roles.join(','), Number(params.id));
    audit(me, 'staff.roles', { staff: Number(params.id), roles });
    return { ok: true };
  });
  r.put('/api/wh/items/:id', 'manager', ({ me, params, body }) => {
    const g = ing(Number(params.id));
    if (!g) fail(404, 'Không tìm thấy mặt hàng');
    const f = {};
    if (body.code !== undefined) f.code = v.text(body.code, { name: 'Mã', max: 30 });
    if (body.group_code !== undefined) f.group_code = body.group_code ? v.oneOf(body.group_code, WH_GROUPS.map((x) => x[0]), { name: 'Nhóm' }) : '';
    for (const k of ['min_stock', 'max_stock']) if (body[k] !== undefined) f[k] = num(body[k], k);
    if (body.dev_pct !== undefined) f.dev_pct = body.dev_pct === '' || body.dev_pct == null ? null : num(body.dev_pct, 'Ngưỡng lệch riêng', { max: 100 });
    if (body.lot_tracked !== undefined) f.lot_tracked = body.lot_tracked ? 1 : 0;
    if (body.size !== undefined) f.size = v.text(body.size, { name: 'Size', max: 10 });
    if (body.need_review !== undefined) f.need_review = body.need_review ? 1 : 0;
    if (body.home_store_id !== undefined) f.home_store_id = body.home_store_id ? Number(body.home_store_id) : null;
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE ingredients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), g.id);
    audit(me, 'item', { id: g.id, f });
    return { ok: true };
  });

  // ---------- Import CSV + file mẫu ----------
  const TEMPLATES = {
    mat_hang: ['ma', 'ten', 'nhom_hang', 'don_vi_nhap', 'don_vi_kho', 'he_so_quy_doi', 'quan_ly_theo_lo', 'so_ngay_han_dung', 'ton_min', 'ton_max', 'gia_nhap', 'nguong_lech_rieng', 'size', 'nha_cung_cap', 'kho_nha'],
    nha_cung_cap: ['ten', 'sdt', 'mat_hang_cung_cap', 'ghi_chu'],
    dinh_muc_cap_phat: ['bo_phan', 'ma_mat_hang', 'so_luong', 'chu_ky_thay_thang'],
    muc_chuan: ['kho', 'ma_mat_hang', 'so_luong_chuan_ca'],
    tai_san: ['ma', 'ten', 'loai', 'ngay_mua', 'gia_mua', 'bao_hanh_den', 'vi_tri', 'so_ban', 'chu_ky_bao_tri_ngay'],
  };
  const SAMPLES = {
    mat_hang: [['BO-TT', 'Bò thái tay', 'TUOI', 'kg', 'suat', 6, 0, 2, 30, 80, 280000, '', '', 'Lò mổ A', 'BEP'], ['BIA-TG', 'Bia Tiger lon', 'DO_UONG', 'thung', 'lon', 24, 0, 0, 48, 240, 380000, '', '', '', 'BAR']],
    nha_cung_cap: [['Lò mổ A', '0901234567', 'Bò thái tay, bò steak', '']],
    dinh_muc_cap_phat: [['Phục vụ', 'AO-PV', 2, 12]],
    muc_chuan: [['BEP', 'BO-TT', 40], ['BAR', 'BIA-TG', 96]],
    tai_san: [['TUDONG-01', 'Tủ đông 1', 'TU', '2025-01-10', 12000000, '2027-01-10', 'Bếp', '', 180]],
  };
  r.get('/api/wh/template', 'manager', ({ query }) => {
    const kind = v.oneOf(query.get('kind'), Object.keys(TEMPLATES), { name: 'Loại file' });
    return { __binary: makeXlsx([{ name: kind, rows: [TEMPLATES[kind], ...SAMPLES[kind]] }]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `mau-${kind}.xlsx` };
  });
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    const s = String(text || '').replace(/^﻿/, '');
    const sep = (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : s.includes('\t') && !s.includes(',') ? '\t' : ',';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
      if (c === '"') q = true; else if (c === sep) { row.push(cell.trim()); cell = ''; } else if (c === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
    return rows.filter((x) => x.some((c) => c !== ''));
  }
  r.post('/api/wh/import', 'manager', ({ me, body }) => {
    const kind = v.oneOf(body.kind, Object.keys(TEMPLATES), { name: 'Loại file' });
    const rows = parseCsv(body.text);
    if (rows.length < 2) fail(400, 'File trống (cần dòng tiêu đề + ít nhất 1 dòng)');
    const head = rows[0].map((h) => h.toLowerCase().trim());
    const get = (row, k) => { const i = head.indexOf(k); return i < 0 ? '' : row[i] ?? ''; };
    const nn = (x, d = 0) => { const n = Number(String(x).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : d; };
    let ok = 0; const errors = [];
    const byCode = (c) => db.prepare('SELECT * FROM ingredients WHERE code = ? AND code != ?').get(c, '') || db.prepare('SELECT * FROM ingredients WHERE lower(name) = lower(?)').get(c);
    tx(db, () => {
      rows.slice(1).forEach((row, i) => {
        try {
          if (kind === 'mat_hang') {
            const name = get(row, 'ten'); if (!name) throw new Error('thiếu tên');
            const grp = get(row, 'nhom_hang').toUpperCase(); if (grp && !group(grp)) throw new Error(`nhóm ${grp} không có`);
            const sup = get(row, 'nha_cung_cap') ? (db.prepare('SELECT id FROM suppliers WHERE lower(name) = lower(?)').get(get(row, 'nha_cung_cap'))?.id ?? Number(db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(get(row, 'nha_cung_cap')).lastInsertRowid)) : null;
            const home = get(row, 'kho_nha') ? storeByCode(get(row, 'kho_nha').toUpperCase())?.id ?? null : null;
            const f = [get(row, 'ma'), name, grp, get(row, 'don_vi_nhap'), get(row, 'don_vi_kho') || 'cái', nn(get(row, 'he_so_quy_doi'), 1) || 1, nn(get(row, 'quan_ly_theo_lo')) ? 1 : 0, nn(get(row, 'so_ngay_han_dung')), nn(get(row, 'ton_min')), nn(get(row, 'ton_max')), Math.round(nn(get(row, 'gia_nhap'))), get(row, 'nguong_lech_rieng') === '' ? null : nn(get(row, 'nguong_lech_rieng')), get(row, 'size'), sup, home];
            const ex = (f[0] && byCode(f[0])) || db.prepare('SELECT id FROM ingredients WHERE lower(name) = lower(?)').get(name);
            if (ex) db.prepare('UPDATE ingredients SET code = ?, name = ?, group_code = ?, purchase_unit = ?, unit = ?, purchase_factor = ?, lot_tracked = ?, shelf_days = ?, min_stock = ?, max_stock = ?, price = ?, dev_pct = ?, size = ?, supplier_id = COALESCE(?, supplier_id), home_store_id = COALESCE(?, home_store_id), need_review = 0 WHERE id = ?').run(...f, ex.id);
            else db.prepare('INSERT INTO ingredients (code, name, group_code, purchase_unit, unit, purchase_factor, lot_tracked, shelf_days, min_stock, max_stock, price, dev_pct, size, supplier_id, home_store_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...f);
          } else if (kind === 'nha_cung_cap') {
            const name = get(row, 'ten'); if (!name) throw new Error('thiếu tên');
            const ex = db.prepare('SELECT id FROM suppliers WHERE lower(name) = lower(?)').get(name);
            const note = [get(row, 'mat_hang_cung_cap'), get(row, 'ghi_chu')].filter(Boolean).join(' · ');
            if (ex) db.prepare('UPDATE suppliers SET phone = ?, note = ? WHERE id = ?').run(get(row, 'sdt'), note, ex.id); else db.prepare('INSERT INTO suppliers (name, phone, note) VALUES (?, ?, ?)').run(name, get(row, 'sdt'), note);
          } else if (kind === 'dinh_muc_cap_phat') {
            const g = byCode(get(row, 'ma_mat_hang')); if (!g) throw new Error(`không thấy mặt hàng ${get(row, 'ma_mat_hang')}`);
            const team = db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?)').get(get(row, 'bo_phan'));
            db.prepare('INSERT INTO wh_issue_norms (team_id, ingredient_id, qty, cycle_months) VALUES (?, ?, ?, ?)').run(team?.id ?? null, g.id, nn(get(row, 'so_luong'), 1), nn(get(row, 'chu_ky_thay_thang'), 12) || 12);
          } else if (kind === 'muc_chuan') {
            const st = storeByCode(get(row, 'kho').toUpperCase()); if (!st) throw new Error(`kho ${get(row, 'kho')} không có`);
            const g = byCode(get(row, 'ma_mat_hang')); if (!g) throw new Error(`không thấy mặt hàng ${get(row, 'ma_mat_hang')}`);
            db.prepare('INSERT OR REPLACE INTO wh_par (store_id, ingredient_id, qty) VALUES (?, ?, ?)').run(st.id, g.id, nn(get(row, 'so_luong_chuan_ca')));
          } else if (kind === 'tai_san') {
            const code = get(row, 'ma').toUpperCase(); if (!code || !get(row, 'ten')) throw new Error('thiếu mã / tên');
            if (db.prepare('SELECT 1 FROM wh_assets WHERE code = ?').get(code)) throw new Error(`mã ${code} đã có`);
            const id = Number(db.prepare('INSERT INTO wh_assets (code, name, kind, bought_on, price, warranty_to, location, table_number, qr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(code, get(row, 'ten'), get(row, 'loai'), get(row, 'ngay_mua') || null, Math.round(nn(get(row, 'gia_mua'))), get(row, 'bao_hanh_den') || null, get(row, 'vi_tri'), get(row, 'so_ban') ? nn(get(row, 'so_ban')) : null, code, ctx.now()).lastInsertRowid);
            const cyc = nn(get(row, 'chu_ky_bao_tri_ngay')); if (cyc > 0) db.prepare('INSERT INTO wh_maint (asset_id, cycle_days, last_on, next_on) VALUES (?, ?, ?, ?)').run(id, cyc, ctx.today(), addDays(ctx.today(), cyc));
          }
          ok++;
        } catch (e) { errors.push(`Dòng ${i + 2}: ${e.message}`); }
      });
    });
    audit(me, 'import', { kind, ok, errors: errors.length });
    return { ok, errors };
  });

  // ---------- Dashboard & báo cáo ----------
  r.get('/api/wh/dashboard', 'staff', ({ me, query }) => {
    if (!isLead(me) && !hasRole(me, 'ke_toan')) fail(403, 'Quản lý / kế toán mới xem được');
    const from = query.get('from') || addDays(ctx.today(), -1), to = query.get('to') || ctx.today();
    const counts = db.prepare(`SELECT v.id, v.no, v.type, v.date, v.shift, v.from_store, v.status, s.name AS store_name, s.owner_id FROM wh_vouchers v JOIN stores s ON s.id = v.from_store
      WHERE v.type LIKE 'KK_%' AND v.status IN ('pending','approved') AND v.date BETWEEN ? AND ? ORDER BY v.id DESC`).all(from, to);
    const lines = counts.flatMap((c) => db.prepare(`SELECT l.id, l.qty, l.qty_expected, l.diff, l.pct, l.color, l.explain, g.name, g.unit FROM wh_lines l LEFT JOIN ingredients g ON g.id = l.ingredient_id WHERE l.voucher_id = ? AND l.color IN ('yellow','red')`).all(c.id)
      .map((l) => ({ ...l, voucher_id: c.id, no: c.no, store_name: c.store_name, owner_name: staffName(c.owner_id), date: c.date, shift: c.shift })));
    const moves = (type, extra = '') => db.prepare(`SELECT m.note, m.qty, m.cost, m.date, g.name, g.group_code, g.unit FROM stock_moves m JOIN ingredients g ON g.id = m.ingredient_id WHERE m.type = ? AND m.date BETWEEN ? AND ? ${extra}`).all(type, from, to);
    const waste = moves('waste', "AND m.ref LIKE 'wh:XH%'");
    const wasteByReason = {};
    for (const w of waste) { const k = Object.values(WASTE_REASONS).find((x) => w.note.includes(x)) || 'Khác'; wasteByReason[k] = (wasteByReason[k] || 0) + w.cost; }
    const vegByDay = {};
    for (const w of waste.filter((x) => x.group_code === 'TUOI' && !/bò/i.test(x.name))) vegByDay[w.date] = r3((vegByDay[w.date] || 0) + w.qty);
    const consumeCost = db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM stock_moves WHERE type IN ('consume','waste') AND date BETWEEN ? AND ?").get(from, to).c;
    const revenue = (() => { try { return db.prepare("SELECT COALESCE(SUM(paid_total), 0) AS t FROM table_sessions WHERE status = 'closed' AND closed_date BETWEEN ? AND ?").get(from, to).t; } catch { return 0; } })();
    // Yield sơ chế thực tế vs chuẩn
    const yields = db.prepare("SELECT v.id, v.no, v.date, v.supplier_id FROM wh_vouchers v WHERE v.type = 'NSX' AND v.status = 'approved' AND v.date BETWEEN ? AND ?").all(from, to).map((vch) => {
      const ls = db.prepare('SELECT l.*, g.name FROM wh_lines l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.voucher_id = ?').all(vch.id);
      const out = ls.find((l) => l.kind === 'out'), inp = ls.find((l) => l.kind === 'in');
      const std = out && inp ? db.prepare('SELECT * FROM wh_prep WHERE output_id = ? AND input_id = ?').get(out.ingredient_id, inp.ingredient_id) : null;
      const actual = out && inp && inp.qty > 0 ? out.qty / inp.qty : null;
      const standard = std ? std.output_qty / std.input_qty : null;
      return { no: vch.no, date: vch.date, input: inp?.name, output: out?.name, input_qty: inp?.qty, output_qty: out?.qty, actual: actual && r3(actual), standard: standard && r3(standard), pct: actual && standard ? Math.round((actual / standard) * 1000) / 10 : null };
    });
    const soon = Number(setting('wh_expiry_days', 2));
    return {
      from, to, variance: lines, red_unexplained: lines.filter((l) => l.color === 'red' && !l.explain).length,
      pending: db.prepare("SELECT COUNT(*) AS n FROM wh_vouchers WHERE status = 'pending'").get().n,
      waste_by_reason: wasteByReason, veg_waste_by_day: vegByDay,
      food_cost: { cost: consumeCost, revenue, pct: revenue ? Math.round((consumeCost / revenue) * 1000) / 10 : null },
      yields,
      reorder: db.prepare(`SELECT g.id, g.name, g.unit, g.min_stock, COALESCE((SELECT SUM(qty) FROM stock_lots WHERE ingredient_id = g.id), 0) AS have FROM ingredients g WHERE g.active = 1 AND g.min_stock > 0`).all().filter((x) => x.have < x.min_stock),
      expiring: db.prepare(`SELECT g.name, l.qty, l.expires_on, s.name AS store_name FROM stock_lots l JOIN ingredients g ON g.id = l.ingredient_id JOIN stores s ON s.id = l.store_id WHERE l.expires_on IS NOT NULL AND l.expires_on <= ? ORDER BY l.expires_on`).all(addDays(ctx.today(), soon)),
      breakage: db.prepare(`SELECT g.name, l.qty, l.who_broke, v.date FROM wh_lines l JOIN wh_vouchers v ON v.id = l.voucher_id JOIN ingredients g ON g.id = l.ingredient_id WHERE v.type = 'XH' AND v.status = 'approved' AND l.reason = 'BE_VO' AND v.date >= ?`).all(addDays(ctx.today(), -31))
        .map((x) => ({ ...x, who: staffName(x.who_broke) })),
      towels: db.prepare('SELECT date, shift, diff, explain FROM wh_towels WHERE date BETWEEN ? AND ? AND diff != 0 ORDER BY id DESC').all(addDays(from, -6), to),
      assets: { maint_due: db.prepare('SELECT a.code, a.name, m.next_on FROM wh_maint m JOIN wh_assets a ON a.id = m.asset_id WHERE m.next_on <= ? AND a.status != \'THANH_LY\'').all(ctx.today()),
        broken: db.prepare("SELECT code, name, status FROM wh_assets WHERE status IN ('HONG','DANG_SUA')").all(),
        warranty_over: db.prepare("SELECT code, name, warranty_to FROM wh_assets WHERE warranty_to IS NOT NULL AND warranty_to < ? AND status != 'THANH_LY'").all(ctx.today()) },
      offboarding: db.prepare('SELECT id, name FROM staff WHERE active = 0').all().map((s) => ({ ...s, items: holdings(s.id) })).filter((s) => s.items.length),
      by_owner: db.prepare(`SELECT s.owner_id, COUNT(*) AS n, SUM(CASE WHEN l.color = 'red' THEN 1 ELSE 0 END) AS red FROM wh_lines l JOIN wh_vouchers v ON v.id = l.voucher_id JOIN stores s ON s.id = v.from_store
        WHERE v.type LIKE 'KK_%' AND v.date >= ? AND l.color IN ('yellow','red') GROUP BY s.owner_id`).all(addDays(ctx.today(), -31)).map((x) => ({ ...x, owner_name: staffName(x.owner_id) || '(chưa gán)' })),
      no_owner: db.prepare("SELECT code, name FROM stores WHERE active = 1 AND code != '' AND owner_id IS NULL").all(),
    };
  });

  // Gợi ý người đếm luân phiên: không phải người giữ kho, cảnh báo nếu đếm cùng kho quá N lần liên tiếp
  r.get('/api/wh/count-hint', 'staff', ({ me, query }) => {
    const st = storeArg(query.get('store'), 'kho');
    const n = Number(setting('wh_rotate_n', 3));
    const last = db.prepare("SELECT created_by FROM wh_vouchers WHERE type LIKE 'KK_%' AND from_store = ? AND status != 'cancelled' ORDER BY id DESC LIMIT ?").all(st, n).map((x) => x.created_by);
    const streak = last.length >= n && last.every((x) => x === me.id);
    const owner = storeById(st)?.owner_id;
    const candidates = db.prepare("SELECT id, name FROM staff WHERE active = 1 AND (role IN ('shift_lead','manager','owner') OR wh_roles LIKE '%thu_kho%') AND id IS NOT ?").all(owner)
      .map((s) => ({ ...s, recent: db.prepare("SELECT COUNT(*) AS c FROM wh_vouchers WHERE type LIKE 'KK_%' AND from_store = ? AND created_by = ? AND created_at > ?").get(st, s.id, ctx.now() - 14 * 86_400_000).c }))
      .sort((a, b) => a.recent - b.recent);
    // Danh sách mặt hàng cần đếm theo nhóm & tần suất (mù: không trả tồn sổ)
    const freq = query.get('freq') || 'shift';
    const items = db.prepare(`SELECT DISTINCT g.id, g.name, g.unit, g.group_code FROM ingredients g LEFT JOIN wh_groups gr ON gr.code = g.group_code
      WHERE g.active = 1 AND (g.home_store_id = ? OR EXISTS (SELECT 1 FROM stock_lots l WHERE l.ingredient_id = g.id AND l.store_id = ?) OR EXISTS (SELECT 1 FROM wh_par p WHERE p.ingredient_id = g.id AND p.store_id = ?))
      ${freq === 'all' ? '' : 'AND (gr.count_freq = ? OR g.group_code = \'CCDC\')'} ORDER BY g.group_code, g.name`).all(st, st, st, ...(freq === 'all' ? [] : [freq]));
    return { is_owner: owner === me.id, streak, streak_n: n, suggest: candidates.slice(0, 3), items };
  });

  // Nhật ký (chủ quán)
  r.get('/api/wh/audit', 'owner', () => db.prepare("SELECT a.*, s.name AS staff_name FROM audit_log a LEFT JOIN staff s ON s.id = a.staff_id WHERE a.action LIKE 'wh.%' ORDER BY a.id DESC LIMIT 300").all());

  // Xuất bán vượt sổ (chế độ chứng từ): ghi phần thiếu để kiểm kê tính đúng tồn lý thuyết
  ctx.whRecordShort = (storeId, ingId, qty, note) => {
    if (!live() || !(qty > 1e-9)) return;
    recordMove(db, { at: ctx.now(), date: ctx.today(), type: 'short', ingredientId: ingId, fromStore: storeId, qty, ref: 'sale-short', note });
  };
}
