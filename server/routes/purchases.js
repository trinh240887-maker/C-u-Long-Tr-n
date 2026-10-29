import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { isDate, addDays } from '../lib/time.js';
import { makeXlsx } from '../lib/xlsx.js';
import { takeLots, recordMove, addLot } from '../lib/stock.js';
import { can as canPerm } from '../lib/perms.js';
import { readBill, billReaderReady, billReaderKey } from '../lib/bill-reader.js';

// Hoá đơn mua hàng + công nợ NCC + tạm ứng đi chợ.
// 1. Khu nhận hàng (bếp / lẩu / bar): nhập số thực nhận, CHỤP BILL NCC (có chữ ký người nhận), ghi tên người ký,
//    trả tại chỗ hay ghi nợ → hàng vào kho ngay, bill "chờ thu ngân duyệt".
// 2. Thu ngân (khác người nhận) so ảnh bill với số nhập → Duyệt (cộng công nợ NCC) hoặc Trả lại (ghi lý do, khu sửa).
// 3. Trả NCC: thu ngân chi tiền mặt / CK; khoản > ngưỡng (mặc định 5 triệu) chờ chủ / quản lý duyệt. CK ra (SePay) gán vào NCC.
// 4. Tạm ứng đi chợ: thu ngân đưa tiền → người đi chợ nhập bill → hoàn ứng (trả lại tiền thừa), lệch thì báo.
// Tiền mặt chi từ két (trả tại chỗ, trả NCC, tạm ứng − hoàn ứng) được trừ khi tính két cuối ngày.
export default function (r, ctx) {
  const { db } = ctx;
  db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_bills (
    id INTEGER PRIMARY KEY, supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, supplier_name TEXT NOT NULL DEFAULT '',
    store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL, po_id INTEGER, date TEXT NOT NULL,
    total INTEGER NOT NULL, lines_total INTEGER NOT NULL DEFAULT 0,
    paid_now INTEGER NOT NULL DEFAULT 0, paid_method TEXT NOT NULL DEFAULT '', advance_id INTEGER,
    signer_name TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', flags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'received', received_by INTEGER, received_at INTEGER NOT NULL,
    approved_by INTEGER, approved_at INTEGER, return_reason TEXT NOT NULL DEFAULT '', returned_by INTEGER, returned_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS purchase_bill_lines (
    id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE,
    ingredient_id INTEGER, name TEXT NOT NULL, qty REAL NOT NULL, unit TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL, amount INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS purchase_bill_photos (
    id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE, file TEXT NOT NULL, created_by INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS supplier_payments (
    id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE, amount INTEGER NOT NULL,
    method TEXT NOT NULL, date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', photo TEXT NOT NULL DEFAULT '', bank_txn_id INTEGER,
    status TEXT NOT NULL DEFAULT 'done', created_by INTEGER, created_at INTEGER NOT NULL, approved_by INTEGER, approved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS cash_advances (
    id INTEGER PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff(id), amount INTEGER NOT NULL, date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', given_by INTEGER, created_at INTEGER NOT NULL,
    returned INTEGER, settled_by INTEGER, settled_at INTEGER, settle_date TEXT, diff INTEGER
  );
  -- Quy đổi đơn vị trên bill (két, lốc…) ra đơn vị kho: 1 bill_unit = factor đơn vị dùng (chai, lon, g…). Nhập 1 lần, app nhớ
  CREATE TABLE IF NOT EXISTS unit_aliases (
    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE, bill_unit TEXT NOT NULL, factor REAL NOT NULL,
    PRIMARY KEY (ingredient_id, bill_unit)
  );
  CREATE INDEX IF NOT EXISTS pb_status ON purchase_bills (status, date);
  CREATE INDEX IF NOT EXISTS pb_supplier ON purchase_bills (supplier_id, status);
  `);

  // Ảnh hàng thực nhận (chủ quán 24/10): cùng bảng ảnh, phân biệt bằng kind
  try { db.exec("ALTER TABLE purchase_bill_photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'bill'"); } catch { /* đã có */ }
  const photoDir = path.join(ctx.photoDir || path.join(os.tmpdir(), 'quanly-photos'), 'hoadon-mua');
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const vnd = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
  const money = (x, name, { min = 0 } = {}) => v.int(Number(String(x ?? '').replace(/[.,\s]/g, '') || 0), { min, max: 2_000_000_000, name });
  // Bill NCC gửi trước qua Zalo (chủ quán 28/10): status 'waiting' = có bill, hàng chưa về; pre_by = người áp bill
  if (!db.prepare('PRAGMA table_info(purchase_bills)').all().some((c) => c.name === 'pre_by')) db.exec('ALTER TABLE purchase_bills ADD COLUMN pre_by INTEGER');
  // bill_unit: dòng nhập đúng như bill, chưa quy đổi (vd 3 mẹt) → chủ quán quy đổi sau ở Mua hàng → ⚖ Quy đổi (chủ quán 28/10)
  if (!db.prepare('PRAGMA table_info(purchase_bill_lines)').all().some((c) => c.name === 'bill_unit')) db.exec('ALTER TABLE purchase_bill_lines ADD COLUMN bill_unit TEXT');
  // Ngày hàng thực về (bill áp trước): giữ nguyên date = ngày áp bill để CK đã ghi không nhảy sang ngày khác (rà soát 28/10)
  if (!db.prepare('PRAGMA table_info(purchase_bills)').all().some((c) => c.name === 'received_date')) db.exec('ALTER TABLE purchase_bills ADD COLUMN received_date TEXT');
  if (!db.prepare('PRAGMA table_info(purchase_bill_lines)').all().some((c) => c.name === 'old_price')) db.exec('ALTER TABLE purchase_bill_lines ADD COLUMN old_price INTEGER'); // giá trước khi nhập bill này (huỷ bill thì trả lại)
  const isCashier = (me) => rank(me.role) >= rank('shift_lead') || !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
  const isBoss = (me) => rank(me.role) >= rank('manager');
  const cashiers = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND (role IN ('owner','manager','shift_lead') OR team_id IN (SELECT id FROM teams WHERE name = 'Thu ngân'))").all().map((x) => x.id);
  const bosses = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id);
  const approveOver = () => Number(ctx.setting('supplier_pay_approve_over') || 5_000_000);
  const jumpPct = () => Number(ctx.setting('price_jump_pct') || 10);

  function savePhoto(billId, data, me, kind = 'bill') {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!m) fail(400, 'Ảnh bill không hợp lệ');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500) fail(400, 'Ảnh bill không hợp lệ');
    if (buf.length > 1_500_000) fail(413, 'Ảnh quá lớn, chụp lại giúp');
    const file = `${billId}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.mkdirSync(photoDir, { recursive: true });
    fs.writeFileSync(path.join(photoDir, file), buf);
    db.prepare('INSERT INTO purchase_bill_photos (bill_id, file, created_by, created_at, kind) VALUES (?, ?, ?, ?, ?)').run(billId, file, me.id, ctx.now(), kind);
  }

  function readLines(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((l) => l && (l.name || l.ingredient_id)).slice(0, 60).map((l) => {
      const ing = l.ingredient_id ? db.prepare('SELECT * FROM ingredients WHERE id = ?').get(Number(l.ingredient_id)) : null;
      if (l.ingredient_id && !ing) fail(404, 'Không tìm thấy nguyên liệu');
      const name = ing ? ing.name : v.text(l.name, { name: 'Tên hàng', required: true, max: 300 });
      const qty = Number(String(l.qty ?? '').replace(',', '.'));
      if (!Number.isFinite(qty) || qty < 0 || qty > 1e6) fail(400, `Số lượng ${name} không hợp lệ`);
      const price = money(l.price, `Đơn giá ${name}`);
      return { ingredient_id: ing?.id ?? null, name, qty, unit: ing ? ing.purchase_unit || ing.unit : v.text(l.unit, { name: 'Đơn vị', max: 40 }), price, amount: Math.round(qty * price), raw: l };
    });
  }

  // Hàng chưa có trong kho mà người nhận chọn "Tạo mới trong kho" → tạo nguyên liệu theo tên / đơn vị / giá trên bill (chủ quán 26/10).
  // Lần sau bill ghi đúng tên đó thì máy đọc tự nhận ra.
  function createNew(lines, storeId) {
    const made = [];
    for (const l of lines) {
      if (l.ingredient_id || !l.raw?.create_new) continue;
      const unit = (l.unit || '').trim() || 'cái';
      const ex = db.prepare('SELECT id, purchase_unit, unit FROM ingredients WHERE lower(name) = lower(?) AND active = 1').get(l.name);
      l.ingredient_id = ex ? ex.id : Number(db.prepare("INSERT INTO ingredients (name, unit, freshness, home_store_id, purchase_unit, purchase_factor, price) VALUES (?, ?, 'dry', ?, ?, 1, ?)").run(l.name, unit, storeId, unit, l.price).lastInsertRowid);
      if (ex) l.unit = ex.purchase_unit || ex.unit; else made.push(l.name);
    }
    return made;
  }
  const notifyCreated = (me, names, b) => {
    if (!names.length) return;
    ctx.audit(me, 'ingredient.create_from_bill', { bill: b.id, names });
    ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id).filter((x) => x !== me.id),
      { title: `Nguyên liệu mới từ bill: ${names.join(', ')}`, body: `${me.name} tạo khi nhập bill ${b.supplier_name}. Kiểm tra quy đổi (Kho → ⚖ Quy đổi) và khu chính.`, link: '/kho?tab=quydoi' });
  };

  function load(id) {
    const b = db.prepare(`SELECT b.*, st.name AS store_name, rb.name AS received_by_name, ab.name AS approved_by_name, tb.name AS returned_by_name, s.name AS sup_name
      FROM purchase_bills b LEFT JOIN stores st ON st.id = b.store_id LEFT JOIN staff rb ON rb.id = b.received_by LEFT JOIN staff ab ON ab.id = b.approved_by
      LEFT JOIN staff tb ON tb.id = b.returned_by LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = ?`).get(id);
    if (!b) fail(404, 'Không tìm thấy hoá đơn mua');
    return {
      ...b, supplier_name: b.sup_name || b.supplier_name, flags: JSON.parse(b.flags || '[]'),
      lines: db.prepare('SELECT * FROM purchase_bill_lines WHERE bill_id = ? ORDER BY id').all(b.id),
      photos: db.prepare("SELECT id FROM purchase_bill_photos WHERE bill_id = ? AND kind = 'bill' ORDER BY id").all(b.id).map((p) => p.id),
      goods_photos: db.prepare("SELECT id FROM purchase_bill_photos WHERE bill_id = ? AND kind = 'goods' ORDER BY id").all(b.id).map((p) => p.id),
      owed: b.status === 'approved' && b.supplier_id && typeof openBills === 'function' ? openBills(b.supplier_id).find((x) => x.id === b.id)?.remaining ?? 0 : null,
      // Các lần trả cho đúng phiếu này (kèm ảnh chứng từ) để đối chiếu ngay trên phiếu
      payments: b.supplier_id ? db.prepare("SELECT p.id, p.date, p.amount, p.method, p.source, p.status, p.note, p.photo, p.bill_ids, p.bank_txn_id, c.name AS by_name FROM supplier_payments p LEFT JOIN staff c ON c.id = p.created_by WHERE p.supplier_id = ? AND p.bill_ids LIKE ? AND p.status != 'rejected' ORDER BY p.id")
        .all(b.supplier_id, `%${b.id}%`).filter((p) => { try { return JSON.parse(p.bill_ids || '[]').map(Number).includes(b.id); } catch { return false; } })
        .map(({ photo, bill_ids, ...p }) => ({ ...p, has_photo: !!photo })) : [],
    };
  }

  // Kiểm tra chéo khi nhận: tổng bill ≠ tổng dòng, nhận lệch đơn đặt, giá tăng bất thường
  function flagsOf({ total, lines, po, oldPrice }) {
    const f = [];
    const sum = lines.reduce((n, l) => n + l.amount, 0);
    if (lines.length && Math.abs(sum - total) > 1000) f.push(`Tổng bill ${vnd(total)} khác cộng các dòng ${vnd(sum)} (lệch ${vnd(total - sum)})`);
    if (po) {
      for (const pl of po.lines) {
        const got = lines.find((l) => l.ingredient_id === pl.ingredient_id);
        const q = got ? got.qty : 0;
        if (Math.abs(q - pl.qty) > Math.max(0.05 * pl.qty, 0.001)) f.push(`${pl.name}: đặt ${pl.qty}, nhận ${q}`);
        if (got && pl.price && got.price > pl.price) f.push(`${pl.name}: giá ${vnd(got.price)} cao hơn giá đặt ${vnd(pl.price)}`);
      }
    }
    for (const l of lines) {
      const old = l.ingredient_id ? oldPrice?.get(l.ingredient_id) : null;
      if (old && l.price > old * (1 + jumpPct() / 100)) f.push(`${l.name}: giá tăng ${Math.round(((l.price - old) / old) * 100)}% (${vnd(old)} → ${vnd(l.price)})`);
    }
    return f;
  }

  const receiversOf = (storeId) => db.prepare('SELECT id, role, team_id FROM staff WHERE active = 1').all().filter((x) => { try { return ctx.canReceiveStore(x, storeId); } catch { return false; } }).map((x) => x.id);
  const unitOf = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 20);
  const unconvFlag = (name, qty, unit) => `${name}: bill ghi ${qty} ${unit}, chưa quy đổi, kiểm lại số kho`;
  // Cờ tính lại được từ dòng bill (tổng lệch, giá tăng, chưa quy đổi); cờ khác (Nhận thiếu, lệch đơn đặt…) giữ nguyên khi sửa (rà soát 28/10)
  const isUnconvFlag = (x) => /: bill ghi .*, chưa quy đổi, kiểm lại số kho$/.test(x);
  const isCalcFlag = (x) => isUnconvFlag(x) || /^Tổng bill .* khác cộng các dòng /.test(x) || /: giá tăng -?\d+% \(/.test(x);
  const unconvFlags = (billId) => db.prepare('SELECT name, qty, bill_unit FROM purchase_bill_lines WHERE bill_id = ? AND ingredient_id IS NOT NULL AND bill_unit IS NOT NULL ORDER BY id').all(billId).map((l) => unconvFlag(l.name, l.qty, l.bill_unit));
  // 1 nguyên liệu 2 dòng → lúc nhận hàng kho báo "nhập 2 lần" (rà soát 28/10): bắt gộp ngay khi lưu
  // Chủ quán 29/10: bill thật hay có 1 món 2 dòng (vd Cải thảo 2 lần) → app tự gộp (cộng số lượng + thành tiền, đơn giá = trung bình).
  // Chỉ báo lỗi khi 2 dòng khác kiểu đơn vị (1 dòng đã quy đổi, 1 dòng chưa) vì không cộng được
  const noDupIng = (lines) => {
    const first = new Map();
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k];
      if (!l.ingredient_id) continue;
      const o = first.get(l.ingredient_id);
      if (!o) { first.set(l.ingredient_id, l); continue; }
      const uo = o.raw?.unconv ? unitOf(o.raw.unit) : '', ul = l.raw?.unconv ? unitOf(l.raw.unit) : '';
      if (uo !== ul) fail(400, `${l.name} có 2 dòng khác đơn vị (${o.raw?.unit || o.unit} / ${l.raw?.unit || l.unit}): sửa cho cùng đơn vị rồi lưu`);
      o.qty = Math.round((o.qty + l.qty) * 1000) / 1000;
      o.amount += l.amount;
      o.price = o.qty ? Math.round(o.amount / o.qty) : o.price;
      lines.splice(k, 1); k--;
    }
  };
  // Có bill khác nhận nguyên liệu này sau bill b không (để khỏi ghi đè giá mới bằng giá bill cũ) (rà soát 28/10)
  const newerReceive = (ingId, b) => !!db.prepare("SELECT 1 FROM purchase_bill_lines x JOIN purchase_bills y ON y.id = x.bill_id WHERE x.ingredient_id = ? AND y.id != ? AND y.status NOT IN ('void','waiting') AND (y.received_at > ? OR (y.received_at = ? AND y.id > ?)) LIMIT 1")
    .get(ingId, b.id, b.received_at, b.received_at, b.id);
  // Sửa bill: giữ id dòng cũ (khớp theo id, không có id thì theo nguyên liệu) → giữ dấu "chưa quy đổi" đúng dòng, màn nhận hàng không bị lệch id (rà soát 28/10)
  function writeLines(billId, lines, old) {
    const byId = new Map(old.map((o) => [o.id, o]));
    const used = new Set();
    const pair = lines.map((l) => { const o = byId.get(Number(l.raw?.id)); if (o && !used.has(o.id)) { used.add(o.id); return o; } return null; });
    lines.forEach((l, i) => { if (pair[i] || !l.ingredient_id) return; const o = old.find((x) => !used.has(x.id) && x.ingredient_id === l.ingredient_id); if (o) { used.add(o.id); pair[i] = o; } });
    const priceByIng = new Map(old.filter((o) => o.ingredient_id).map((o) => [o.ingredient_id, o.old_price]));
    for (const o of old) if (!used.has(o.id)) db.prepare('DELETE FROM purchase_bill_lines WHERE id = ?').run(o.id);
    const add = db.prepare('INSERT INTO purchase_bill_lines (bill_id, ingredient_id, name, qty, unit, price, amount, old_price, bill_unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const upd = db.prepare('UPDATE purchase_bill_lines SET ingredient_id = ?, name = ?, qty = ?, unit = ?, price = ?, amount = ?, old_price = ?, bill_unit = ? WHERE id = ?');
    lines.forEach((l, i) => {
      const o = pair[i];
      const same = o && o.ingredient_id === l.ingredient_id; // đổi sang hàng khác → bỏ dấu chưa quy đổi
      const oldPrice = same ? o.old_price : l.ingredient_id ? priceByIng.get(l.ingredient_id) ?? null : null;
      const billUnit = same && l.ingredient_id ? o.bill_unit : null;
      if (o) upd.run(l.ingredient_id, l.name, l.qty, l.unit, l.price, l.amount, oldPrice, billUnit, o.id);
      else add.run(billId, l.ingredient_id, l.name, l.qty, l.unit, l.price, l.amount, oldPrice, billUnit);
    });
  }
  const supplierRow = (id) => db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);

  // ---------- Khu nhận hàng ----------
  r.post('/api/purchases', 'staff', ({ me, body }) => {
    const pre = !!body.pre_bill;
    if (pre && !canPerm(ctx, me, 'mh.apbill')) fail(403, 'Chỉ người được chủ quán chỉ định mới áp bill trước (hàng chưa về)');
    const poId = !pre && body.po_id ? v.int(body.po_id, { min: 1, name: 'Đơn đặt hàng' }) : null;
    const po = poId ? ctx.loadPo(poId) : null;
    const storeId = po ? po.store_id : v.int(body.store_id, { min: 1, name: 'Khu nhận' });
    if (!pre && !ctx.canReceiveStore(me, storeId)) fail(403, 'Bạn không nhận hàng cho khu này');
    let supplierId = po ? po.supplier_id : body.supplier_id ? v.int(body.supplier_id, { min: 1, name: 'NCC' }) : null;
    if (supplierId && !supplierRow(supplierId)) fail(404, 'Không tìm thấy NCC');
    const supplierName = supplierId ? supplierRow(supplierId).name : v.text(body.supplier_name, { name: 'Tên nơi bán', required: true, max: 300 });
    // Nơi bán ghi tay: tìm NCC trùng tên, chưa có thì tạo mới → bill ghi nợ không bị sót khỏi công nợ
    if (!supplierId) {
      const norm = (x) => x.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
      supplierId = db.prepare('SELECT id, name FROM suppliers').all().find((x) => norm(x.name) === norm(supplierName))?.id
        ?? Number(db.prepare("INSERT INTO suppliers (name, note) VALUES (?, 'Tự tạo khi nhận hàng')").run(supplierName).lastInsertRowid);
    }
    const signer = v.text(body.signer_name, { name: 'Tên người ký nhận trên bill', required: true, max: 150 });
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 4) : [];
    if (!photos.length) fail(400, 'Chụp ảnh bill NCC (có chữ ký người nhận) trước khi lưu');
    const goodsPhotos = Array.isArray(body.goods_photos) ? body.goods_photos.slice(0, 4) : [];
    let lines = readLines(body.lines);
    if (po && !lines.length) lines = po.lines.map((pl) => ({ ingredient_id: pl.ingredient_id, name: pl.name, qty: pl.qty, unit: pl.purchase_unit || pl.unit, price: pl.price, amount: Math.round(pl.qty * pl.price), raw: {} }));
    if (po) {
      // Đơn đặt: dòng thiếu thì coi như nhận đủ theo đơn, giá theo đơn
      lines = po.lines.map((pl) => lines.find((l) => l.ingredient_id === pl.ingredient_id) || { ingredient_id: pl.ingredient_id, name: pl.name, qty: pl.qty, unit: pl.purchase_unit || pl.unit, price: pl.price, amount: Math.round(pl.qty * pl.price), raw: {} })
        .concat(lines.filter((l) => !l.ingredient_id || !po.lines.some((pl) => pl.ingredient_id === l.ingredient_id)));
    }
    noDupIng(lines);
    const total = body.total === undefined || body.total === '' ? lines.reduce((n, l) => n + l.amount, 0) : money(body.total, 'Tổng tiền bill');
    // Cộng các dòng lệch nhiều so với tổng bill (vd gõ / đọc mất dấu phẩy: 28,1 → 281) → phải xác nhận mới lưu (chủ quán 26/10)
    const linesSum = lines.reduce((n, l) => n + l.amount, 0);
    if (lines.length && body.total !== undefined && body.total !== '' && Math.abs(linesSum - total) > Math.max(50000, total * 0.05) && !body.confirm_mismatch) {
      const k = total ? linesSum / total : 0;
      fail(409, `Cộng các dòng ${vnd(linesSum)} lệch tổng bill ${vnd(total)}${k >= 8 ? ` (gấp ~${Math.round(k)} lần: kiểm tra số lượng có mất dấu phẩy không, vd 28,1 kg)` : ''}. Sửa lại, hoặc xác nhận đúng như bill.`);
    }
    if (total <= 0) fail(400, 'Nhập tổng tiền trên bill');
    if (pre && (body.advance_id || body.paid_method === 'cash')) fail(400, 'Bill chờ nhận hàng: chọn ghi nợ hoặc đã chuyển khoản');
    const advanceId = body.advance_id ? v.int(body.advance_id, { min: 1, name: 'Tạm ứng' }) : null;
    if (advanceId) {
      const a = db.prepare('SELECT * FROM cash_advances WHERE id = ?').get(advanceId);
      if (!a || a.status !== 'open') fail(400, 'Khoản tạm ứng đã quyết toán hoặc không có');
      if (a.staff_id !== me.id && rank(me.role) < rank('shift_lead')) fail(403, 'Tạm ứng này của người khác');
    }
    const paidMethod = advanceId ? 'advance' : v.oneOf(body.paid_method || '', ['', 'cash', 'transfer'], { name: 'Cách trả' });
    const paidNow = advanceId ? total : paidMethod ? (body.paid_now === undefined || body.paid_now === '' ? total : money(body.paid_now, 'Số tiền đã trả')) : 0;
    if (paidNow > total) fail(400, 'Số đã trả lớn hơn tổng bill');
    if (paidMethod === 'cash' && !isCashier(me)) fail(403, 'Trả tiền mặt tại chỗ: thu ngân bấm, hoặc chọn "ghi nợ"');
    const date = ctx.today();
    const created = [];
    const id = tx(db, () => {
      created.push(...createNew(lines, storeId));
      const { oldPrice } = pre ? { oldPrice: new Map() } : ctx.stockReceive(me, { poId, storeId, lines: lines.filter((l) => l.ingredient_id).map((l) => ({ ingredient_id: l.ingredient_id, qty: l.qty, price: l.raw?.unconv ? undefined : l.price, expires_on: l.raw.expires_on })) }); // dòng chưa quy đổi: giá theo đơn vị bill (vd /mẹt) → không ghi đè giá kho (rà soát 28/10)
      const flags = flagsOf({ total, lines, po, oldPrice });
      // Dòng chưa quy đổi: nhập đúng như bill, chủ quán kiểm & quy đổi sau (chủ quán 28/10)
      for (const l of lines) if (l.ingredient_id && l.raw?.unconv) flags.push(unconvFlag(l.name, l.qty, unitOf(l.raw.unit) || l.unit));
      const id = Number(db.prepare(`INSERT INTO purchase_bills (supplier_id, supplier_name, store_id, po_id, date, total, lines_total, paid_now, paid_method, advance_id, signer_name, note, flags, received_by, received_at, status, pre_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(supplierId, supplierName, storeId, poId, date, total, lines.reduce((n, l) => n + l.amount, 0), paidNow, paidMethod, advanceId,
        signer, v.text(body.note, { name: 'Ghi chú', max: 1000 }), JSON.stringify(flags), pre ? null : me.id, ctx.now(), pre ? 'waiting' : 'received', pre ? me.id : null).lastInsertRowid);
      const add = db.prepare('INSERT INTO purchase_bill_lines (bill_id, ingredient_id, name, qty, unit, price, amount, old_price, bill_unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const l of lines) add.run(id, l.ingredient_id, l.name, l.qty, l.unit, l.price, l.amount, l.ingredient_id ? oldPrice.get(l.ingredient_id) ?? null : null, l.ingredient_id && l.raw?.unconv ? unitOf(l.raw.unit) : null);
      for (const ph of photos) savePhoto(id, ph, me);
      for (const ph of goodsPhotos) savePhoto(id, ph, me, 'goods');
      // Nhớ quy đổi nhân viên vừa nhập (1 két = 24 chai) cho lần đọc bill sau
      for (const c of Array.isArray(body.conversions) ? body.conversions.slice(0, 60) : []) {
        const f = Number(c?.factor);
        const unitName = String(c?.bill_unit || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 20);
        if (c?.ingredient_id && unitName && f > 0 && f <= 100000 && db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(Number(c.ingredient_id))) db.prepare('INSERT INTO unit_aliases (ingredient_id, bill_unit, factor) VALUES (?, ?, ?) ON CONFLICT (ingredient_id, bill_unit) DO UPDATE SET factor = excluded.factor').run(Number(c.ingredient_id), unitName, f);
      }
      return id;
    });
    const b = load(id);
    notifyCreated(me, created, b);
    if (pre) {
      ctx.notify(receiversOf(storeId).filter((x) => x !== me.id), { title: `Hàng sắp về: ${b.supplier_name}`, body: `${b.lines.map((l) => `• ${l.name}: ${l.qty} ${l.unit}`).join('\n')}\nHàng về thì kiểm, chụp ảnh hàng rồi bấm "Đã nhận hàng" (Mua hàng → ⏳ Chờ nhận hàng).`, link: '/mua-hang?tab=cho' });
      ctx.audit(me, 'purchase.pre_bill', { id, total, supplier: b.supplier_name });
      ctx.broadcast('purchases');
      return b;
    }
    if (po && ctx.poReceivedReport) ctx.poReceivedReport(ctx.loadPo(po.id), lines, me).catch(() => {}); // bot báo đủ / thiếu vào nhóm Zalo của đơn
    ctx.notify(cashiers().filter((x) => x !== me.id), { title: `Hoá đơn mua chờ duyệt: ${b.supplier_name} ${vnd(total)}`, body: `${b.store_name || ''} · nhận bởi ${me.name}, ký ${signer}${b.flags.length ? ` · ${b.flags.length} điểm cần xem` : ''}`, link: '/mua-hang', urgent: b.flags.length > 0 });
    ctx.audit(me, 'purchase.receive', { id, total, supplier: b.supplier_name });
    ctx.broadcast('purchases');
    return b;
  });

  // Khu sửa lại bill bị trả lại (chỉ tiền / ảnh / tên ký; số kho sửa bằng kiểm kho)
  r.patch('/api/purchases/:id', 'staff', ({ me, params, body }) => {
    const b = load(params.id);
    // Sửa bill: người nhận sửa bill bị trả lại; thu ngân / trưởng ca trở lên sửa ngay trong mục duyệt (chủ quán 26/10)
    if (b.status === 'waiting') { if (!isCashier(me) && !canPerm(ctx, me, 'mh.apbill')) fail(403, 'Thu ngân / trưởng ca trở lên mới sửa bill chờ nhận hàng'); }
    else if (b.status === 'returned') { if (b.received_by !== me.id && rank(me.role) < rank('shift_lead')) fail(403, 'Người nhận hàng sửa lại'); }
    else if (b.status === 'received') { if (!isCashier(me)) fail(403, 'Thu ngân / trưởng ca trở lên mới sửa bill đang chờ duyệt'); }
    else if (b.status === 'approved') { if (rank(me.role) < rank('manager')) fail(403, 'Bill đã duyệt: quản lý / chủ quán mới sửa được'); } // chủ quán 26/10: gắn dòng "hàng khác" vào kho
    else fail(400, 'Bill này không sửa được');
    const lines = body.lines ? readLines(body.lines) : null;
    let created = [];
    const total = body.total === undefined ? b.total : money(body.total, 'Tổng tiền bill');
    tx(db, () => {
      if (lines && b.status === 'waiting') {
        // Hàng chưa về: chỉ sửa dòng bill, chưa đụng kho
        created = createNew(lines, b.store_id);
        noDupIng(lines);
        writeLines(b.id, lines, db.prepare('SELECT * FROM purchase_bill_lines WHERE bill_id = ?').all(b.id));
      } else if (lines) {
        created = createNew(lines, b.store_id);
        // Kho đã cộng theo số cũ lúc gửi bill → cộng / trừ phần chênh theo số mới
        const old = db.prepare('SELECT l.*, g.purchase_factor FROM purchase_bill_lines l LEFT JOIN ingredients g ON g.id = l.ingredient_id WHERE l.bill_id = ?').all(b.id);
        const store = ctx.effectiveStore ? ctx.effectiveStore(b.store_id) : b.store_id;
        const sumBy = (arr) => arr.filter((l) => l.ingredient_id).reduce((m, l) => m.set(l.ingredient_id, (m.get(l.ingredient_id) || 0) + l.qty), new Map());
        const before = sumBy(old), after = sumBy(lines);
        const at = ctx.now(), date = ctx.today();
        for (const id of new Set([...before.keys(), ...after.keys()])) {
          const g = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
          const d = Math.round(((after.get(id) || 0) - (before.get(id) || 0)) * (g?.purchase_factor || 1) * 1000) / 1000;
          if (!d) continue;
          if (d > 0) addLot(db, { storeId: store, ingredientId: id, qty: d, expiresOn: g?.shelf_days > 0 ? addDays(date, g.shelf_days) : null, at });
          else takeLots(db, { storeId: store, ingredientId: id, qty: -d, allowShort: true });
          recordMove(db, { at, date, type: 'receive', ingredientId: id, toStore: store, qty: d, cost: 0, ref: `fix-bill:${b.id}`, staffId: me.id, note: `Sửa bill nhập #${b.id}` });
        }
        writeLines(b.id, lines, old);
        // Giá nguyên liệu: chỉ theo dòng đã quy đổi và khi bill này là lần nhập mới nhất (rà soát 28/10)
        for (const l of db.prepare('SELECT * FROM purchase_bill_lines WHERE bill_id = ?').all(b.id)) if (l.ingredient_id && l.price > 0 && !l.bill_unit && !newerReceive(l.ingredient_id, b)) db.prepare('UPDATE ingredients SET price = ? WHERE id = ?').run(l.price, l.ingredient_id);
      }
      for (const ph of Array.isArray(body.photos) ? body.photos.slice(0, 4) : []) savePhoto(b.id, ph, me);
      const ls = db.prepare('SELECT * FROM purchase_bill_lines WHERE bill_id = ?').all(b.id);
      const flags = [...b.flags.filter((x) => !isCalcFlag(x)), ...flagsOf({ total, lines: ls, po: null, oldPrice: new Map(ls.filter((l) => l.old_price != null).map((l) => [l.ingredient_id, l.old_price])) }), ...unconvFlags(b.id)];
      db.prepare(`UPDATE purchase_bills SET total = ?, lines_total = ?, signer_name = ?, note = ?, flags = ?, status = ${b.status === 'approved' ? "'approved'" : b.status === 'waiting' ? "'waiting'" : "'received'"} WHERE id = ?`)
        .run(total, ls.reduce((n, l) => n + l.amount, 0), body.signer_name ? v.text(body.signer_name, { name: 'Tên người ký', max: 150 }) : b.signer_name, body.note === undefined ? b.note : v.text(body.note, { max: 1000 }), JSON.stringify(flags), b.id);
    });
    notifyCreated(me, created, b);
    if (b.status !== 'approved' && b.status !== 'waiting') ctx.notify(cashiers().filter((x) => x !== me.id), { title: `Bill mua đã sửa, duyệt lại: ${b.supplier_name} ${vnd(total)}`, link: '/mua-hang' });
    ctx.audit(me, 'purchase.fix', { id: b.id, total, was: b.status });
    ctx.broadcast('purchases');
    return load(b.id);
  });

  r.get('/api/purchases', 'staff', ({ me, query }) => {
    const status = query.get('status') || '';
    const from = query.get('from') || addDays(ctx.today(), -30);
    const to = query.get('to') || ctx.today();
    if (!isDate(from) || !isDate(to)) fail(400, 'Ngày không hợp lệ');
    const mine = !isCashier(me);
    const ids = db.prepare(`SELECT id FROM purchase_bills WHERE date BETWEEN ? AND ? ${status ? 'AND status = ?' : ''} ${mine ? 'AND received_by = ?' : ''} ORDER BY id DESC LIMIT 300`)
      .all(...[from, to, ...(status ? [status] : []), ...(mine ? [me.id] : [])]).map((x) => x.id);
    const pending = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS t FROM purchase_bills WHERE status = 'received'").get();
    // Bill chờ nhận hàng: ai nhận hàng được cho khu đó đều thấy
    // + bill chính mình áp trước (rà soát 28/10)
    const arriving = db.prepare("SELECT id, store_id, pre_by FROM purchase_bills WHERE status = 'waiting' ORDER BY id").all()
      .filter((x) => isCashier(me) || x.pre_by === me.id || ctx.canReceiveStore(me, x.store_id)).map((x) => load(x.id));
    return { bills: ids.map(load).filter((b) => b.status !== 'waiting'), arriving, pending: pending.n, pending_total: pending.t, can_approve: isCashier(me), is_boss: isBoss(me), bill_reader: billReaderReady(ctx) };
  });
  // Người chỉ có quyền Nhập kho (không có "Xem bill đã nhận"): vẫn mở được màn Nhập kho + Chờ nhận hàng (chủ quán 29/10)
  r.get('/api/purchases/info', 'staff', ({ me }) => ({
    bills: [], pending: 0, pending_total: 0, can_approve: false, is_boss: isBoss(me), bill_reader: billReaderReady(ctx), limited: true,
    arriving: db.prepare("SELECT id, store_id, pre_by FROM purchase_bills WHERE status = 'waiting' ORDER BY id").all()
      .filter((x) => x.pre_by === me.id || ctx.canReceiveStore(me, x.store_id)).map((x) => load(x.id)),
  }));

  // Đọc ảnh bill bằng AI → điền sẵn dòng hàng; nhân viên vẫn kiểm & sửa trước khi lưu. Giới hạn số lần / ngày để khỏi tốn tiền.
  r.post('/api/purchases/read-bill', 'staff', async ({ me, body }) => {
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 4) : [];
    if (!photos.length) fail(400, 'Chụp bill trước rồi bấm Đọc bill');
    const max = Number(ctx.setting('bill_reader_daily_max') || 80);
    const today = ctx.today();
    const cnt = JSON.parse(ctx.setting('bill_reader_count') || '{}');
    const n = cnt.date === today ? cnt.n : 0;
    if (n >= max) fail(429, `Hôm nay đã đọc ${n} bill (tối đa ${max}). Nhập tay giúp, hoặc chủ quán tăng giới hạn`);
    ctx.setSetting('bill_reader_count', JSON.stringify({ date: today, n: n + 1 }));
    const ings = db.prepare('SELECT id, name, unit, purchase_unit, purchase_factor FROM ingredients WHERE active = 1 ORDER BY name').all();
    let out;
    try { out = await (ctx.readBill || readBill)(photos, ings, { apiKey: billReaderKey(ctx) }); } catch (e) { fail(502, e.message); }
    const norm = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
    const byId = new Map(ings.map((g) => [g.id, g]));
    const sup = out.supplier_name ? db.prepare('SELECT id, name FROM suppliers WHERE active = 1').all().find((x) => norm(x.name) === norm(out.supplier_name) || norm(out.supplier_name).includes(norm(x.name))) : null;
    ctx.audit(me, 'purchase.read_bill', { photos: photos.length, lines: out.lines.length, usage: out.usage });
    return {
      supplier_id: sup?.id || null, supplier_name: sup ? sup.name : out.supplier_name || '', signer_name: out.signer_name || '', total: out.total || 0, note: out.note || '',
      lines: out.lines.map((l) => {
        const g = l.ingredient_id ? byId.get(l.ingredient_id) : null;
        const ku = g ? g.purchase_unit || g.unit : '';
        const base = { ingredient_id: g?.id || null, name: g ? g.name : l.name, bill_name: l.name, unit: g ? ku : l.unit, bill_unit: l.unit, bill_qty: l.qty, bill_price: l.price, qty: l.qty, price: l.price,
          use_unit: g?.unit || '', pf: g?.purchase_factor || 1, unit_mismatch: false, need_factor: false, factor: null };
        if (!g || !l.unit || norm(ku) === norm(l.unit) || norm(g.unit) === norm(l.unit)) {
          // Bill ghi theo đơn vị dùng (vd chai) mà kho mua theo thùng → đổi ra thùng
          if (g && l.unit && norm(ku) !== norm(l.unit) && norm(g.unit) === norm(l.unit)) return { ...base, factor: 1, qty: r3(l.qty / base.pf), price: Math.round(l.price * base.pf) };
          return base;
        }
        const al = db.prepare('SELECT factor FROM unit_aliases WHERE ingredient_id = ? AND bill_unit = ?').get(g.id, norm(l.unit));
        if (!al) return { ...base, unit_mismatch: true, need_factor: true };
        return { ...base, factor: al.factor, qty: r3((l.qty * al.factor) / base.pf), price: Math.round((l.price * base.pf) / al.factor) };
      }),
    };
  });

  // So sánh giá NCC (chủ quán 29/10, chỉ chủ xem): giá thật đã mua theo từng NCC, cùng đơn vị mua của nguyên liệu.
  // Nguồn: dòng bill đã nhận (bỏ bill huỷ / trả lại / chưa về / chưa quy đổi) + đơn đặt đã nhận không có bill.
  r.get('/api/purchases/compare', 'staff', ({ me, query }) => {
    if ((me.real_role || me.role) !== 'owner') fail(403, 'Chỉ chủ quán xem so sánh giá');
    const days = Math.min(365, Math.max(7, Number(query.days) || 90));
    const from = addDays(ctx.today(), -days);
    const fromMs = ctx.now() - days * 86_400_000;
    const rows = [
      ...db.prepare(`SELECT l.ingredient_id AS ing, b.supplier_id AS sup, COALESCE(s.name, b.supplier_name) AS sup_name, b.date, b.id AS ord, l.qty, l.price
        FROM purchase_bill_lines l JOIN purchase_bills b ON b.id = l.bill_id LEFT JOIN suppliers s ON s.id = b.supplier_id
        WHERE l.ingredient_id IS NOT NULL AND l.bill_unit IS NULL AND l.price > 0 AND l.qty > 0 AND b.status NOT IN ('void', 'returned', 'waiting') AND b.date >= ?`).all(from),
      ...db.prepare(`SELECT l.ingredient_id AS ing, p.supplier_id AS sup, s.name AS sup_name, date(p.received_at / 1000, 'unixepoch', '+7 hours') AS date, -p.id AS ord, l.qty_received AS qty, l.price_received AS price
        FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.status = 'received' AND p.received_at >= ? AND l.price_received > 0 AND l.qty_received > 0 AND NOT EXISTS (SELECT 1 FROM purchase_bills b WHERE b.po_id = p.id)`).all(fromMs),
    ].filter((x) => x.sup_name);
    const ings = new Map(db.prepare('SELECT i.id, i.name, i.unit, i.purchase_unit, i.supplier_id, s.name AS sup_name FROM ingredients i LEFT JOIN suppliers s ON s.id = i.supplier_id').all().map((g) => [g.id, g]));
    const by = new Map();
    for (const x of rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ord - b.ord))) {
      const g = ings.get(x.ing); if (!g) continue;
      if (!by.has(x.ing)) by.set(x.ing, new Map());
      const key = x.sup ? `id${x.sup}` : `n${x.sup_name.toLowerCase()}`;
      const m = by.get(x.ing);
      const c = m.get(key) || { supplier_id: x.sup || null, name: x.sup_name, n: 0, qty: 0, spent: 0, min: Infinity, max: 0, last_price: 0, last_date: '' };
      c.n++; c.qty += x.qty; c.spent += x.qty * x.price; c.min = Math.min(c.min, x.price); c.max = Math.max(c.max, x.price);
      c.last_price = x.price; c.last_date = x.date; // đã sắp theo ngày tăng dần → dòng cuối là lần mua gần nhất
      m.set(key, c);
    }
    const items = [];
    for (const [id, m] of by) {
      const g = ings.get(id);
      const sups = [...m.values()].map((c) => ({ ...c, qty: Math.round(c.qty * 1000) / 1000, avg: Math.round(c.spent / c.qty), spent: Math.round(c.spent) })).sort((a, b) => a.last_price - b.last_price);
      const best = sups[0];
      const totalQty = sups.reduce((n, c) => n + c.qty, 0);
      const spent = sups.reduce((n, c) => n + c.spent, 0);
      // Nếu cả kỳ đều mua với giá rẻ nhất hiện tại → tiết kiệm được bao nhiêu (ước tính)
      const save = sups.length > 1 ? Math.max(0, Math.round(spent - totalQty * best.last_price)) : 0;
      const spread = sups.length > 1 ? Math.round((sups[sups.length - 1].last_price - best.last_price) * 100 / best.last_price) : 0;
      items.push({ id, name: g.name, unit: g.purchase_unit || g.unit, default_supplier: g.sup_name || '', suppliers: sups, best_id: best.supplier_id, best_name: best.name, save, spread, spent });
    }
    items.sort((a, b) => (b.suppliers.length > 1) - (a.suppliers.length > 1) || b.save - a.save || b.spent - a.spent);
    return { days, from, items, total_save: items.reduce((n, i) => n + i.save, 0) };
  });

  // ⚖ Quy đổi ở Mua hàng (chủ quán 28/10): các dòng bill nhập đúng như bill, chưa quy đổi
  r.get('/api/purchases/unconverted', 'manager', () => db.prepare(`SELECT l.id, l.bill_id, l.ingredient_id, l.name, l.qty, l.price, l.amount, l.bill_unit, g.purchase_unit, g.unit AS use_unit, g.purchase_factor, b.date, b.supplier_name
    FROM purchase_bill_lines l JOIN purchase_bills b ON b.id = l.bill_id JOIN ingredients g ON g.id = l.ingredient_id WHERE l.bill_unit IS NOT NULL AND b.status != 'void' ORDER BY b.id DESC LIMIT 200`).all());
  // Nhập "1 mẹt = 2,5 kg" → app tự sửa số kho + dòng bill và nhớ cho lần đọc bill sau
  r.post('/api/purchases/lines/:id/convert', 'manager', ({ me, params, body }) => {
    const l = db.prepare('SELECT l.*, g.purchase_factor, g.purchase_unit, g.unit AS use_unit, g.shelf_days FROM purchase_bill_lines l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.id = ?').get(Number(params.id));
    if (!l || !l.bill_unit) fail(404, 'Dòng này đã quy đổi rồi');
    const b = load(l.bill_id);
    if (b.status === 'void') fail(400, 'Bill đã huỷ');
    const f = Number(String(body.factor ?? '').replace(',', '.'));
    if (!(f > 0 && f <= 100000)) fail(400, `Nhập 1 ${l.bill_unit} = bao nhiêu ${l.purchase_unit || l.use_unit}`);
    const pf = l.purchase_factor || 1;
    const qty = Math.round(l.qty * f * 1000) / 1000;
    const price = Math.round(l.price / f);
    // Bill chờ nhận hàng: kho chưa cộng → chỉ sửa dòng bill, không cộng / trừ kho, không đổi giá (lúc nhận hàng mới tính) (rà soát 28/10)
    const waiting = b.status === 'waiting';
    // Bill cũ: chỉ đổi giá nguyên liệu khi đây là lần nhập mới nhất của nguyên liệu đó (rà soát 28/10)
    const newer = newerReceive(l.ingredient_id, b);
    tx(db, () => {
      const store = ctx.effectiveStore ? ctx.effectiveStore(b.store_id) : b.store_id;
      const d = waiting ? 0 : Math.round((qty - l.qty) * pf * 1000) / 1000;
      const at = ctx.now(), date = ctx.today();
      if (d > 0) addLot(db, { storeId: store, ingredientId: l.ingredient_id, qty: d, expiresOn: l.shelf_days > 0 ? addDays(date, l.shelf_days) : null, at });
      else if (d < 0) takeLots(db, { storeId: store, ingredientId: l.ingredient_id, qty: -d, allowShort: true });
      if (d) recordMove(db, { at, date, type: 'receive', ingredientId: l.ingredient_id, toStore: store, qty: d, cost: 0, ref: `fix-bill:${b.id}`, staffId: me.id, note: `Quy đổi bill #${b.id}: 1 ${l.bill_unit} = ${f} ${l.purchase_unit || l.use_unit}` });
      db.prepare('UPDATE purchase_bill_lines SET qty = ?, price = ?, unit = ?, bill_unit = NULL WHERE id = ?').run(qty, price, l.purchase_unit || l.use_unit, l.id);
      if (price > 0 && !waiting && !newer) db.prepare('UPDATE ingredients SET price = ? WHERE id = ?').run(price, l.ingredient_id);
      db.prepare('INSERT INTO unit_aliases (ingredient_id, bill_unit, factor) VALUES (?, ?, ?) ON CONFLICT (ingredient_id, bill_unit) DO UPDATE SET factor = excluded.factor').run(l.ingredient_id, l.bill_unit, f * pf);
      // Bỏ cờ "chưa quy đổi" theo mẫu (không so nguyên chuỗi: số lượng có thể đã sửa), dựng lại cho dòng còn chưa quy đổi (rà soát 28/10)
      const flags = [...b.flags.filter((x) => !isUnconvFlag(x)), ...unconvFlags(b.id)];
      db.prepare('UPDATE purchase_bills SET flags = ? WHERE id = ?').run(JSON.stringify(flags), b.id);
    });
    ctx.audit(me, 'purchase.convert', { line: l.id, bill: b.id, unit: l.bill_unit, factor: f });
    ctx.broadcast('purchases');
    return { ok: true, qty, price };
  });

  // Đơn vị trên bill đã học (vd bill ghi "thùng" = 150 vắt) → hiện ở Kho → ⚖ Quy đổi
  r.get('/api/stock/unit-aliases', 'manager', () => db.prepare('SELECT ingredient_id, bill_unit, factor FROM unit_aliases ORDER BY ingredient_id').all());
  // Món ăn dùng nguyên liệu nào, bao nhiêu / phần → Quy đổi đánh dấu "cần quy đổi" (vd trừ 0,2 gói / phần)
  r.get('/api/stock/recipe-use', 'manager', () => db.prepare('SELECT r.ingredient_id, r.qty, m.name AS item FROM menu_recipes r JOIN menu_items m ON m.id = r.item_id WHERE m.active = 1 ORDER BY m.name').all());
  r.delete('/api/stock/unit-aliases', 'manager', ({ me, query }) => {
    db.prepare('DELETE FROM unit_aliases WHERE ingredient_id = ? AND bill_unit = ?').run(Number(query.get('ingredient_id')), String(query.get('bill_unit') || ''));
    ctx.audit(me, 'unit_alias.delete', { ingredient_id: query.get('ingredient_id'), bill_unit: query.get('bill_unit') });
    return { ok: true };
  });

  r.get('/api/purchases/photo/:id', 'staff', ({ params }) => {
    const p = db.prepare('SELECT * FROM purchase_bill_photos WHERE id = ?').get(params.id);
    if (!p) fail(404, 'Không tìm thấy ảnh');
    let buf;
    try { buf = fs.readFileSync(path.join(photoDir, p.file)); } catch { fail(410, 'Ảnh không còn'); }
    const ext = path.extname(p.file);
    return { __binary: buf, type: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
  });

  // ---------- Hàng về theo bill đã áp trước (chủ quán 28/10) ----------
  // Bếp / khu kiểm hàng, chụp ảnh hàng, sửa số thực nhận → cộng kho. Nhận đủ → tự duyệt; thiếu → chờ thu ngân duyệt
  r.post('/api/purchases/:id/arrive', 'staff', ({ me, params, body }) => {
    const b = load(params.id);
    if (b.status !== 'waiting') fail(400, 'Bill này đã nhận hàng rồi');
    if (!ctx.canReceiveStore(me, b.store_id)) fail(403, 'Bạn không nhận hàng cho khu này');
    const goods = Array.isArray(body.goods_photos) ? body.goods_photos.slice(0, 4) : [];
    if (!goods.length) fail(400, 'Chụp ảnh hàng thực nhận trước khi bấm Đã nhận');
    const got = new Map((Array.isArray(body.lines) ? body.lines : []).map((x) => [Number(x.id), x.qty]));
    const short = [], over = [];
    const lines = b.lines.map((l) => {
      // Không gửi số (vd màn hình cũ) → coi như nhận đúng số trên bill (rà soát 28/10)
      const v0 = got.get(l.id);
      const raw = v0 === undefined || v0 === null || String(v0).trim() === '' || String(v0) === 'undefined' ? l.qty : Number(String(v0).replace(',', '.'));
      if (!Number.isFinite(raw) || raw < 0 || raw > 1e6) fail(400, `Số lượng ${l.name} không hợp lệ`);
      const qty = r3(raw);
      if (qty < l.qty - 1e-9) short.push(`${l.name}: bill ${l.qty} ${l.unit}, nhận ${qty} ${l.unit}`);
      else if (qty > l.qty + 1e-9) over.push(`${l.name}: bill ${l.qty} ${l.unit}, nhận ${qty} ${l.unit}`);
      return { ...l, qty, amount: Math.round(qty * l.price) };
    });
    // Bill cũ có 2 dòng cùng nguyên liệu → gộp khi cộng kho (cộng SL, giá bình quân) để khỏi bị chặn "nhập 2 lần" (rà soát 28/10)
    const merged = new Map();
    for (const l of lines) {
      if (!l.ingredient_id || !(l.qty > 0)) continue;
      const m = merged.get(l.ingredient_id) || { ingredient_id: l.ingredient_id, qty: 0, amount: 0, unconv: false };
      m.qty += l.qty; m.amount += l.amount; if (l.bill_unit) m.unconv = true; // dòng chưa quy đổi: giá theo đơn vị bill, không ghi vào giá kho
      merged.set(l.ingredient_id, m);
    }
    const at = ctx.now();
    let status = 'approved', serious = [];
    tx(db, () => {
      const { oldPrice } = ctx.stockReceive(me, { poId: null, storeId: b.store_id, lines: [...merged.values()].map((m) => ({ ingredient_id: m.ingredient_id, qty: r3(m.qty), price: m.unconv ? undefined : m.qty > 0 ? Math.round(m.amount / m.qty) : 0 })) });
      for (const l of lines) db.prepare('UPDATE purchase_bill_lines SET qty = ?, amount = ?, old_price = ? WHERE id = ?').run(l.qty, l.amount, l.ingredient_id ? oldPrice.get(l.ingredient_id) ?? null : null, l.id);
      // Lúc áp bill chưa có giá cũ → kiểm lại giá tăng / tổng lệch với giá thật lúc nhận; có cờ mới thì chờ thu ngân duyệt (rà soát 28/10)
      const cmp = new Map([...oldPrice].filter(([id]) => !merged.get(id)?.unconv));
      serious = [...flagsOf({ total: b.total, lines, po: null, oldPrice: cmp }).filter((x) => !b.flags.includes(x)), ...over.map((x) => `Nhận thừa: ${x}`)];
      const flags = [...b.flags, ...short.map((x) => `Nhận thiếu: ${x}`), ...serious];
      status = short.length || serious.length ? 'received' : 'approved';
      // Giữ date = ngày áp bill (CK đã ghi theo ngày đó); ngày hàng về ghi riêng received_date (rà soát 28/10)
      db.prepare(`UPDATE purchase_bills SET status = ?, received_by = ?, received_at = ?, received_date = ?, lines_total = ?, flags = ?, approved_by = ?, approved_at = ? WHERE id = ?`)
        .run(status, me.id, at, ctx.today(), lines.reduce((n, l) => n + l.amount, 0), JSON.stringify(flags), status === 'received' ? null : b.pre_by || me.id, status === 'received' ? null : at, b.id);
      for (const ph of goods) savePhoto(b.id, ph, me, 'goods');
    });
    if (status === 'received') ctx.notify([...new Set([...cashiers(), ...(b.pre_by ? [b.pre_by] : [])])].filter((x) => x !== me.id), { title: `${short.length ? 'Nhận thiếu hàng' : 'Nhận hàng cần xem lại'}: ${b.supplier_name}`, body: `${me.name} nhận:\n${[...short, ...serious].join('\n')}\nBill chờ duyệt${short.length ? ' (sửa tổng tiền nếu NCC trừ lại)' : ''}.`, link: '/mua-hang?tab=duyet', urgent: true });
    else if (b.pre_by && b.pre_by !== me.id) ctx.notify([b.pre_by], { title: `Đã nhận đủ hàng: ${b.supplier_name} ${vnd(b.total)}`, body: `${me.name} đã kiểm & nhận. Bill tự duyệt, cộng công nợ.`, link: '/mua-hang?tab=lichsu' });
    ctx.audit(me, 'purchase.arrive', { id: b.id, short: short.length });
    ctx.broadcast('purchases'); ctx.broadcast('stock');
    return load(b.id);
  });

  // Nhắc bill chờ nhận hàng quá 1 ngày (chủ quán 28/10): mỗi ngày 1 lần / bill, báo khu nhận + người áp bill + quản lý
  ctx.arriveRemindTick = () => {
    const n = ctx.now(), m = ctx.clock().minuteOf(n), d0 = ctx.today();
    if (m < 9 * 60 || m > 22 * 60) return;
    for (const b of db.prepare("SELECT id, store_id, supplier_name, total, pre_by, received_at FROM purchase_bills WHERE status = 'waiting' AND received_at <= ?").all(n - 24 * 3600e3)) {
      const k = `arrive_remind:${b.id}`;
      if (ctx.setting(k) === d0) continue;
      ctx.setSetting(k, d0);
      const days = Math.floor((n - b.received_at) / (24 * 3600e3));
      ctx.notify([...new Set([...receiversOf(b.store_id), ...bosses(), ...(b.pre_by ? [b.pre_by] : [])])],
        { title: `⏳ Bill ${b.supplier_name} ${vnd(b.total)} chờ nhận hàng ${days} ngày`, body: 'Hàng về rồi thì kiểm, chụp ảnh hàng và bấm "Đã nhận hàng". NCC không giao thì quản lý huỷ bill.', link: '/mua-hang?tab=cho', urgent: true });
    }
  };

  // ---------- Thu ngân duyệt ----------
  r.post('/api/purchases/:id/approve', 'staff', ({ me, params }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / trưởng ca trở lên duyệt hoá đơn mua');
    const b = load(params.id);
    if (b.status !== 'received') fail(400, 'Bill này không chờ duyệt');
    if (b.received_by === me.id && me.role !== 'owner') fail(403, 'Người nhận hàng không tự duyệt bill của mình; nhờ người khác duyệt');
    db.prepare("UPDATE purchase_bills SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(me.id, ctx.now(), b.id);
    ctx.audit(me, 'purchase.approve', { id: b.id, total: b.total });
    ctx.broadcast('purchases');
    return load(b.id);
  });

  r.post('/api/purchases/:id/return', 'staff', ({ me, params, body }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / trưởng ca trở lên');
    const b = load(params.id);
    if (b.status !== 'received') fail(400, 'Bill này không chờ duyệt');
    const reason = v.text(body.reason, { name: 'Lý do trả lại', required: true, max: 500 });
    db.prepare("UPDATE purchase_bills SET status = 'returned', return_reason = ?, returned_by = ?, returned_at = ? WHERE id = ?").run(reason, me.id, ctx.now(), b.id);
    if (b.received_by) ctx.notify([b.received_by], { title: `Bill ${b.supplier_name} ${vnd(b.total)} bị trả lại`, body: `${reason}. Sửa lại rồi gửi duyệt.`, link: '/mua-hang', urgent: true });
    ctx.audit(me, 'purchase.return', { id: b.id, reason });
    ctx.broadcast('purchases');
    return load(b.id);
  });

  // Huỷ bill nhập sai (chủ quán 26/10): trừ lại hàng đã cộng vào kho, bỏ khỏi công nợ / chi két. Không xoá, giữ lịch sử.
  // Quản lý / chủ huỷ mọi bill; người nhận hoặc thu ngân huỷ được bill CHƯA duyệt.
  r.post('/api/purchases/:id/void', 'staff', ({ me, params, body }) => {
    const b = load(params.id);
    if (b.status === 'void') fail(400, 'Bill đã huỷ');
    const boss = rank(me.role) >= rank('manager');
    if (!boss && !(b.status !== 'approved' && (b.received_by === me.id || b.pre_by === me.id || isCashier(me)))) fail(403, b.status === 'approved' ? 'Bill đã duyệt: chỉ quản lý / chủ quán huỷ được' : 'Chỉ người nhận, thu ngân hoặc quản lý huỷ được');
    const reason = v.text(body.reason, { name: 'Lý do huỷ', required: true, max: 500 });
    const at = ctx.now(), date = ctx.today();
    const store = ctx.effectiveStore ? ctx.effectiveStore(b.store_id) : b.store_id;
    tx(db, () => {
      // Bill chờ nhận hàng: kho chưa cộng → không trừ lại
      for (const l of b.status === 'waiting' ? [] : db.prepare('SELECT l.*, g.purchase_factor FROM purchase_bill_lines l LEFT JOIN ingredients g ON g.id = l.ingredient_id WHERE l.bill_id = ? AND l.ingredient_id IS NOT NULL').all(b.id)) {
        const useQty = Math.round(l.qty * (l.purchase_factor || 1) * 1000) / 1000;
        if (!(useQty > 0)) continue;
        takeLots(db, { storeId: store, ingredientId: l.ingredient_id, qty: useQty, allowShort: true });
        recordMove(db, { at, date, type: 'receive', ingredientId: l.ingredient_id, toStore: store, qty: -useQty, cost: -l.amount, ref: `void-bill:${b.id}`, staffId: me.id, note: `Huỷ bill nhập #${b.id}: ${reason}` });
        // Giá nhập đang là giá của bill sai → trả về giá trước đó
        if (l.old_price != null) db.prepare('UPDATE ingredients SET price = ? WHERE id = ? AND price = ?').run(l.old_price, l.ingredient_id, l.price);
      }
      db.prepare("UPDATE purchase_bills SET status = 'void', return_reason = ?, returned_by = ?, returned_at = ? WHERE id = ?").run(`Huỷ: ${reason}`, me.id, at, b.id);
    });
    ctx.notify(bosses().filter((x) => x !== me.id), { title: `Huỷ bill nhập ${b.supplier_name} ${vnd(b.total)}`, body: `${me.name}: ${reason}. ${b.status === 'waiting' ? 'Bill chờ nhận hàng, kho chưa cộng nên không trừ.' : 'Hàng đã trừ lại khỏi kho.'}`, link: '/mua-hang' }); // (rà soát 28/10)
    ctx.audit(me, 'purchase.void', { id: b.id, reason });
    ctx.broadcast('purchases'); ctx.broadcast('stock');
    return load(b.id);
  });

  // ---------- Công nợ NCC ----------
  function balance(supplierId, until = '9999-12-31') {
    const bills = db.prepare("SELECT COALESCE(SUM(total), 0) AS t, COALESCE(SUM(paid_now), 0) AS p FROM purchase_bills WHERE supplier_id = ? AND status = 'approved' AND date <= ?").get(supplierId, until);
    const pays = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM supplier_payments WHERE supplier_id = ? AND status = 'done' AND date <= ?").get(supplierId, until).n;
    return bills.t - bills.p - pays;
  }
  ctx.supplierBalance = balance;
  // Nợ theo TỪNG PHIẾU (chủ quán 26/10): mỗi lần trả trừ vào phiếu được chọn trước, phần dư trừ phiếu cũ nhất
  if (!db.prepare('PRAGMA table_info(supplier_payments)').all().some((c) => c.name === 'bill_ids')) db.exec("ALTER TABLE supplier_payments ADD COLUMN bill_ids TEXT NOT NULL DEFAULT '[]'");
  function openBills(supplierId) {
    const bills = db.prepare("SELECT id, date, total, paid_now FROM purchase_bills WHERE supplier_id = ? AND status = 'approved' ORDER BY date, id").all(supplierId)
      .map((b) => ({ ...b, remaining: Math.max(0, b.total - b.paid_now) }));
    const byId = new Map(bills.map((b) => [b.id, b]));
    for (const p of db.prepare("SELECT amount, bill_ids FROM supplier_payments WHERE supplier_id = ? AND status = 'done' ORDER BY date, id").all(supplierId)) {
      let amt = p.amount;
      let ids = []; try { ids = JSON.parse(p.bill_ids || '[]'); } catch { /* cũ */ }
      for (const id of ids) { const b = byId.get(Number(id)); if (!b || amt <= 0) continue; const t = Math.min(amt, b.remaining); b.remaining -= t; amt -= t; }
      for (const b of bills) { if (amt <= 0) break; const t = Math.min(amt, b.remaining); b.remaining -= t; amt -= t; }
    }
    return bills;
  }
  ctx.supplierOpenBills = openBills;

  r.get('/api/suppliers/debts', 'staff', ({ me }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý');
    const rows = db.prepare('SELECT id, name, phone FROM suppliers WHERE active = 1 ORDER BY name').all().map((s) => ({
      // Kèm ảnh bill + ảnh hàng của từng phiếu còn nợ để nhìn thấy ngay khi trả (chủ quán 28/10)
      ...s, debt: balance(s.id), open_bills: openBills(s.id).filter((b) => b.remaining > 0).map((b) => ({ ...b,
        photos: db.prepare("SELECT id FROM purchase_bill_photos WHERE bill_id = ? AND kind = 'bill' ORDER BY id").all(b.id).map((x) => x.id),
        goods_photos: db.prepare("SELECT id FROM purchase_bill_photos WHERE bill_id = ? AND kind = 'goods' ORDER BY id").all(b.id).map((x) => x.id),
        lines: db.prepare('SELECT name, qty, unit, price, amount FROM purchase_bill_lines WHERE bill_id = ? ORDER BY id').all(b.id) })),
      pending: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total - paid_now), 0) AS t FROM purchase_bills WHERE supplier_id = ? AND status IN ('received','returned')").get(s.id),
      last_bill: db.prepare("SELECT MAX(date) AS d FROM purchase_bills WHERE supplier_id = ?").get(s.id).d,
    }));
    const waiting = db.prepare("SELECT p.*, s.name AS supplier_name, c.name AS created_by_name FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN staff c ON c.id = p.created_by WHERE p.status = 'pending' ORDER BY p.id").all();
    const outTxns = db.prepare("SELECT id, amount, content, txn_at, date FROM bank_txns WHERE direction = 'out' AND status = 'unassigned' ORDER BY id DESC LIMIT 50").all();
    return { suppliers: rows, total: rows.reduce((n, s) => n + s.debt, 0), waiting, out_txns: outTxns, approve_over: approveOver(), is_boss: isBoss(me) };
  });

  function statement(supplierId, from, to) {
    const s = supplierRow(supplierId);
    if (!s) fail(404, 'Không tìm thấy NCC');
    const opening = balance(supplierId, addDays(from, -1));
    const bills = db.prepare("SELECT id, date, total, paid_now, paid_method, signer_name, status FROM purchase_bills WHERE supplier_id = ? AND status = 'approved' AND date BETWEEN ? AND ? ORDER BY date, id").all(supplierId, from, to);
    const pays = db.prepare("SELECT id, date, amount, method, note FROM supplier_payments WHERE supplier_id = ? AND status = 'done' AND date BETWEEN ? AND ? ORDER BY date, id").all(supplierId, from, to);
    const rows = [
      ...bills.map((b) => ({ date: b.date, kind: 'bill', ref: `HĐ mua #${b.id}`, plus: b.total, minus: b.paid_now, note: b.paid_now ? `trả tại chỗ ${b.paid_method === 'advance' ? '(tạm ứng)' : b.paid_method === 'cash' ? 'tiền mặt' : 'CK'}` : 'ghi nợ' })),
      ...pays.map((p) => ({ date: p.date, kind: 'pay', ref: `Chi #${p.id}`, plus: 0, minus: p.amount, note: `${p.method === 'cash' ? 'Tiền mặt' : 'Chuyển khoản'}${p.note ? ` · ${p.note}` : ''}` })),
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'bill' ? -1 : 1));
    let run = opening;
    for (const x of rows) { run += x.plus - x.minus; x.balance = run; }
    return { supplier: s, from, to, opening, rows, closing: run, bought: bills.reduce((n, b) => n + b.total, 0), paid: rows.reduce((n, x) => n + x.minus, 0) };
  }

  r.get('/api/suppliers/:id/statement', 'staff', ({ me, params, query }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý');
    const to = query.get('to') || ctx.today();
    const from = query.get('from') || `${to.slice(0, 8)}01`;
    if (!isDate(from) || !isDate(to) || from > to) fail(400, 'Ngày không hợp lệ');
    return statement(params.id, from, to);
  });

  r.get('/api/suppliers/:id/statement.xlsx', 'staff', ({ me, params, query }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý');
    const to = query.get('to') || ctx.today();
    const from = query.get('from') || `${to.slice(0, 8)}01`;
    if (!isDate(from) || !isDate(to) || from > to) fail(400, 'Ngày không hợp lệ');
    const x = statement(params.id, from, to);
    const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
    const rows = [['Ngày', 'Chứng từ', 'Phát sinh nợ (mua)', 'Đã trả', 'Còn nợ', 'Ghi chú'], [dm(from), 'Nợ đầu kỳ', '', '', x.opening, ''],
      ...x.rows.map((r0) => [dm(r0.date), r0.ref, r0.plus || '', r0.minus || '', r0.balance, r0.note]), [dm(to), 'Nợ cuối kỳ', x.bought, x.paid, x.closing, '']];
    return { __binary: makeXlsx([{ name: 'Công nợ', rows }]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `cong-no-ncc-${x.supplier.id}_${from}_${to}.xlsx` };
  });

  // Trả NCC: thu ngân bấm; > ngưỡng phải chủ / quản lý duyệt; không trả quá công nợ đã duyệt
  r.post('/api/suppliers/:id/pay', 'staff', ({ me, params, body }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý chi tiền NCC');
    const s = supplierRow(params.id);
    if (!s) fail(404, 'Không tìm thấy NCC');
    const amount = money(body.amount, 'Số tiền', { min: 1000 });
    const method = v.oneOf(body.method, ['cash', 'transfer'], { name: 'Cách trả' });
    const debt = balance(s.id);
    const waiting = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM supplier_payments WHERE supplier_id = ? AND status = 'pending'").get(s.id).n;
    if (amount > debt - waiting) fail(400, `Công nợ đã duyệt còn ${vnd(debt - waiting)}; bill chưa duyệt thì duyệt trước rồi mới trả`);
    const bankTxn = body.bank_txn_id ? db.prepare("SELECT * FROM bank_txns WHERE id = ? AND direction = 'out' AND status = 'unassigned'").get(Number(body.bank_txn_id)) : null;
    if (body.bank_txn_id && !bankTxn) fail(400, 'Giao dịch ngân hàng không hợp lệ hoặc đã gán');
    if (bankTxn && bankTxn.amount !== amount) fail(400, `Giao dịch ngân hàng là ${vnd(bankTxn.amount)}, khác số trả`);
    const needOk = amount > approveOver() && !isBoss(me);
    let photo = '';
    if (body.photo) {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.photo));
      if (!m) fail(400, 'Ảnh không hợp lệ');
      photo = `pay-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      fs.mkdirSync(photoDir, { recursive: true });
      fs.writeFileSync(path.join(photoDir, photo), Buffer.from(m[2], 'base64'));
    }
    const id = tx(db, () => {
      const billIds = (Array.isArray(body.bill_ids) ? body.bill_ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 100);
      const id0 = Number(db.prepare('INSERT INTO supplier_payments (supplier_id, amount, method, date, note, photo, bank_txn_id, status, created_by, created_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.id, amount, method, ctx.today(), v.text(body.note, { max: 1000 }), photo, bankTxn?.id ?? null, needOk ? 'pending' : 'done', me.id, ctx.now(), needOk ? null : me.id, needOk ? null : ctx.now()).lastInsertRowid);
      const id = id0;
      if (billIds.length) db.prepare('UPDATE supplier_payments SET bill_ids = ? WHERE id = ?').run(JSON.stringify(billIds), id);
      // Tiền mặt lấy từ két (thu ngân) hay tiền quản lý giữ (chỉ quản lý / chủ chọn được)
      if (method === 'cash' && body.source === 'manager' && isBoss(me)) db.prepare("UPDATE supplier_payments SET source = 'manager' WHERE id = ?").run(id);
      if (bankTxn) db.prepare("UPDATE bank_txns SET status = 'supplier', note = ?, handled_by = ? WHERE id = ?").run(`Trả NCC ${s.name} (chi #${id})`, me.id, bankTxn.id);
      return id;
    });
    if (needOk) ctx.notify(bosses(), { title: `Duyệt chi NCC: ${s.name} ${vnd(amount)}`, body: `${me.name} đề nghị chi ${method === 'cash' ? 'tiền mặt' : 'chuyển khoản'}; công nợ ${vnd(debt)}`, link: '/mua-hang?tab=congno', urgent: true });
    ctx.audit(me, 'supplier.pay', { id, supplier: s.id, amount, method, pending: needOk });
    ctx.broadcast('purchases');
    return { id, status: needOk ? 'pending' : 'done', debt: balance(s.id) };
  });

  r.get('/api/supplier-payments/:id/photo', 'staff', ({ me, params }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý');
    const p = db.prepare('SELECT photo FROM supplier_payments WHERE id = ?').get(params.id);
    if (!p?.photo) fail(404, 'Không có ảnh');
    let buf; try { buf = fs.readFileSync(path.join(photoDir, p.photo)); } catch { fail(410, 'Ảnh không còn'); }
    return { __binary: buf, type: p.photo.endsWith('.png') ? 'image/png' : p.photo.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
  });

  r.post('/api/supplier-payments/:id/approve', 'manager', ({ me, params, body }) => {
    const p = db.prepare('SELECT * FROM supplier_payments WHERE id = ?').get(params.id);
    if (!p || p.status !== 'pending') fail(400, 'Khoản chi này không chờ duyệt');
    const ok = body.reject ? 'rejected' : 'done';
    db.prepare('UPDATE supplier_payments SET status = ?, approved_by = ?, approved_at = ?, date = ? WHERE id = ?').run(ok, me.id, ctx.now(), ok === 'done' ? ctx.today() : p.date, p.id);
    if (ok === 'rejected' && p.bank_txn_id) db.prepare("UPDATE bank_txns SET status = 'unassigned', note = '' WHERE id = ?").run(p.bank_txn_id);
    if (p.created_by) ctx.notify([p.created_by], { title: `Khoản chi NCC ${vnd(p.amount)} ${ok === 'done' ? 'đã được duyệt' : 'bị từ chối'}`, link: '/mua-hang?tab=congno' });
    ctx.audit(me, 'supplier.pay.approve', { id: p.id, ok });
    ctx.broadcast('purchases');
    return { ok: true };
  });

  // ---------- Tạm ứng đi chợ ----------
  r.post('/api/advances', 'staff', ({ me, body }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý đưa tạm ứng');
    const staffId = v.int(body.staff_id, { min: 1, name: 'Người nhận tạm ứng' });
    if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1').get(staffId)) fail(404, 'Không tìm thấy nhân viên');
    const amount = money(body.amount, 'Số tiền', { min: 1000 });
    const id = Number(db.prepare('INSERT INTO cash_advances (staff_id, amount, date, note, given_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(staffId, amount, ctx.today(), v.text(body.note, { max: 120 }), me.id, ctx.now()).lastInsertRowid);
    ctx.notify([staffId], { title: `Bạn nhận tạm ứng ${vnd(amount)} đi chợ`, body: 'Mua xong chụp bill, nhập ở Mua hàng → chọn khoản tạm ứng này, rồi hoàn ứng tiền thừa cho thu ngân.', link: '/mua-hang' });
    ctx.audit(me, 'advance.give', { id, staffId, amount });
    ctx.broadcast('purchases');
    return { id };
  });

  r.get('/api/advances/staff', 'staff', ({ me }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý');
    return db.prepare('SELECT s.id, s.name, t.name AS team_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id WHERE s.active = 1 ORDER BY t.sort, s.name').all();
  });
  const advanceView = (a) => {
    const spent = db.prepare("SELECT COALESCE(SUM(total), 0) AS n, COUNT(*) AS c FROM purchase_bills WHERE advance_id = ? AND status != 'void'").get(a.id);
    return { ...a, spent: spent.n, bills: spent.c, should_return: a.amount - spent.n };
  };
  r.get('/api/advances', 'staff', ({ me }) => {
    const rows = db.prepare(`SELECT a.*, s.name AS staff_name, g.name AS given_by_name FROM cash_advances a JOIN staff s ON s.id = a.staff_id LEFT JOIN staff g ON g.id = a.given_by
      WHERE ${isCashier(me) ? '1 = 1' : 'a.staff_id = ?'} AND (a.status = 'open' OR a.date >= ?) ORDER BY a.id DESC`).all(...(isCashier(me) ? [] : [me.id]), addDays(ctx.today(), -14));
    return rows.map(advanceView);
  });

  r.post('/api/advances/:id/settle', 'staff', ({ me, params, body }) => {
    if (!isCashier(me)) fail(403, 'Thu ngân nhận lại tiền thừa và quyết toán');
    const a = db.prepare('SELECT * FROM cash_advances WHERE id = ?').get(params.id);
    if (!a || a.status !== 'open') fail(400, 'Khoản tạm ứng này đã quyết toán');
    if (a.staff_id === me.id && me.role !== 'owner') fail(403, 'Người cầm tạm ứng không tự quyết toán');
    const x = advanceView(a);
    const returned = money(body.returned, 'Tiền thừa trả lại');
    const diff = returned - x.should_return;
    db.prepare("UPDATE cash_advances SET status = 'settled', returned = ?, diff = ?, settled_by = ?, settled_at = ?, settle_date = ? WHERE id = ?").run(returned, diff, me.id, ctx.now(), ctx.today(), a.id);
    if (diff !== 0) {
      const who = db.prepare('SELECT name FROM staff WHERE id = ?').get(a.staff_id)?.name;
      ctx.notify(bosses(), { title: `Hoàn ứng ${diff < 0 ? 'THIẾU' : 'DƯ'} ${vnd(Math.abs(diff))}: ${who}`, body: `Ứng ${vnd(a.amount)}, bill ${vnd(x.spent)}, phải trả lại ${vnd(x.should_return)}, trả ${vnd(returned)}`, link: '/mua-hang?tab=tamung', urgent: true });
    }
    ctx.audit(me, 'advance.settle', { id: a.id, returned, diff });
    ctx.broadcast('purchases');
    return { ok: true, diff };
  });

  // Tiền mặt rời két trong ngày: trả NCC tại chỗ + chi NCC tiền mặt + tạm ứng − tiền thừa hoàn ứng (dùng khi tính két cuối ngày)
  ctx.cashOut = (date) => {
    const now1 = db.prepare("SELECT COALESCE(SUM(paid_now), 0) AS n FROM purchase_bills WHERE date = ? AND paid_method = 'cash' AND status != 'void'").get(date).n;
    const pay = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM supplier_payments WHERE date = ? AND method = 'cash' AND status = 'done'").get(date).n;
    const adv = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM cash_advances WHERE date = ?').get(date).n;
    const back = db.prepare("SELECT COALESCE(SUM(returned), 0) AS n FROM cash_advances WHERE settle_date = ? AND status = 'settled'").get(date).n;
    return { supplier_now: now1, supplier_pay: pay, advances: adv, advance_back: back, total: now1 + pay + adv - back };
  };
  // Tóm tắt cho chủ quán buổi sáng
  ctx.purchaseDay = (date) => ({
    bills: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS t FROM purchase_bills WHERE date = ?").get(date),
    pending: db.prepare("SELECT COUNT(*) AS n FROM purchase_bills WHERE status = 'received'").get().n,
    flagged: db.prepare("SELECT COUNT(*) AS n FROM purchase_bills WHERE date = ? AND flags != '[]'").get(date).n,
    paid: db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM supplier_payments WHERE date = ? AND status = 'done'").get(date).n,
  });
}
