// Phiếu chi (chủ quán 26/10). 3 nguồn tiền, tách riêng:
// - drawer: thu ngân chi TIỀN MẶT TỪ KÉT trong ngày → két "phải có" tự trừ
// - manager: quản lý chi TIỀN MẶT từ tiền đã kết (phong bì sau chốt) → "tiền quản lý đang giữ" tự trừ
// - bank: chi CHUYỂN KHOẢN từ tài khoản quán → số dư tài khoản "phải có" tự trừ
// Mọi phiếu chi phải có ảnh hoá đơn / chứng từ. Thu ngân chi từ két quá ngưỡng (mặc định 500.000đ) → chờ trưởng ca trở lên duyệt.
// Trả nhà cung cấp vẫn đi qua Mua hàng → Công nợ (để trừ đúng công nợ NCC), có chọn nguồn két / quản lý / CK.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { rank } from '../db.js';
import { isDate, addDays } from '../lib/time.js';
import { can } from '../lib/perms.js';

export const DEFAULT_CATEGORIES = ['Nguyên liệu mua lẻ', 'Gas / đá', 'Vận chuyển / ship', 'Sửa chữa', 'Điện / nước / internet', 'Đồ dùng / vật dụng', 'Lương / thưởng / tạm ứng', 'Khác'];
const SOURCES = { drawer: 'Tiền mặt từ két (thu ngân)', manager: 'Tiền mặt quản lý giữ (đã kết)', bank: 'Chuyển khoản từ tài khoản quán' };

export default function (r, ctx) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, amount INTEGER NOT NULL,
    source TEXT NOT NULL,                       -- drawer | manager | bank
    category TEXT NOT NULL DEFAULT 'Khác', note TEXT NOT NULL DEFAULT '', photo TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'done',        -- done | pending | rejected | void
    created_by INTEGER, created_at INTEGER NOT NULL, approved_by INTEGER, approved_at INTEGER, decision_note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS expenses_by_date ON expenses(date);`);
  // Trả NCC bằng tiền mặt: lấy từ két hay tiền quản lý giữ (trước đây coi như từ két)
  if (!db.prepare('PRAGMA table_info(supplier_payments)').all().some((c) => c.name === 'source')) db.exec("ALTER TABLE supplier_payments ADD COLUMN source TEXT NOT NULL DEFAULT 'drawer'");

  const photoDir = path.join(ctx.photoDir || path.join(os.tmpdir(), 'quanly-photos'), 'chi');
  const vnd = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
  const name = (id) => (id ? db.prepare('SELECT name FROM staff WHERE id = ?').get(id)?.name || '' : '');
  const isCashier = (me) => rank(me.role) >= rank('shift_lead') || !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
  const isBoss = (me) => rank(me.role) >= rank('manager');
  const bosses = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id);
  const approvers = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((x) => x.id);
  const approveOver = () => Number(ctx.setting('expense_approve_over') || 500000);
  const categories = () => { try { const c = JSON.parse(ctx.setting('expense_categories') || '[]'); return c.length ? c : DEFAULT_CATEGORIES; } catch { return DEFAULT_CATEGORIES; } };
  const dayClosed = (date) => !!db.prepare('SELECT 1 FROM day_closings WHERE date = ?').get(date);

  // Két: chi từ két (đã chi hoặc đang chờ duyệt: tiền đã ra khỏi két) → trừ "phải có"
  const drawerOut = (date) => db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM expenses WHERE date = ? AND source = 'drawer' AND status IN ('done','pending')").get(date).n;
  const prevCashOut = ctx.cashOut;
  ctx.cashOut = (date) => {
    const base = prevCashOut ? prevCashOut(date) : { total: 0 };
    const exp = drawerOut(date);
    // Trả NCC tiền mặt từ tiền quản lý giữ không ra khỏi két
    const mgrNcc = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM supplier_payments WHERE date = ? AND method = 'cash' AND status = 'done' AND source = 'manager'").get(date).n;
    return { ...base, supplier_pay: (base.supplier_pay || 0) - mgrNcc, expenses: exp, total: (base.total || 0) - mgrNcc + exp };
  };
  // Tài khoản: chi CK trong ngày
  ctx.expenseBankOut = (date) => db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM expenses WHERE date = ? AND source = 'bank' AND status = 'done'").get(date).n;

  // Tiền quản lý đang giữ = số đầu + phong bì các ngày đã chốt (đếm két − để lại két) − chi quản lý − trả NCC từ tiền quản lý − nộp ngân hàng
  function holding() {
    const start = ctx.setting('manager_cash_start') || ctx.today();
    if (!ctx.setting('manager_cash_start')) ctx.setSetting('manager_cash_start', start);
    const opening = Number(ctx.setting('manager_cash_opening') || 0);
    const env = db.prepare(`SELECT COALESCE(SUM(c.counted - COALESCE(c.keep_float, 0)), 0) AS n FROM day_cash c JOIN day_closings d ON d.date = c.date WHERE c.date >= ? AND c.counted IS NOT NULL`).get(start).n;
    const spent = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM expenses WHERE date >= ? AND source = 'manager' AND status = 'done'").get(start).n;
    const ncc = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM supplier_payments WHERE date >= ? AND method = 'cash' AND status = 'done' AND source = 'manager'").get(start).n;
    let dep = 0;
    try { dep = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM bank_txns WHERE direction = 'in' AND status = 'deposit' AND date >= ?").get(start).n; } catch { /* chưa có bảng */ }
    return { start, opening, envelopes: env, spent, ncc, deposits: dep, total: opening + env - spent - ncc - dep };
  }
  ctx.managerHolding = holding;

  const row = (e) => ({ ...e, source_name: SOURCES[e.source], created_by_name: name(e.created_by), approved_by_name: name(e.approved_by), has_photo: !!e.photo, photo: undefined });

  r.get('/api/expenses/meta', 'staff', ({ me }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý');
    return { categories: categories(), sources: Object.entries(SOURCES).filter(([k]) => k === 'drawer' || can(ctx, me, 'chi.quanly')).map(([k, n]) => ({ key: k, name: n })), approve_over: approveOver(), is_boss: isBoss(me) };
  });

  r.post('/api/expenses', 'staff', ({ me, body }) => {
    const source = v.oneOf(body.source, Object.keys(SOURCES), { name: 'Nguồn tiền' });
    if (source === 'drawer' ? !isCashier(me) : !can(ctx, me, 'chi.quanly')) fail(403, source === 'drawer' ? 'Chỉ thu ngân / trưởng ca chi từ két' : 'Chỉ quản lý / chủ quán chi tiền đã kết hoặc chuyển khoản');
    const amount = v.int(Number(String(body.amount ?? '').replace(/[.,\s]/g, '')), { min: 1000, max: 1_000_000_000, name: 'Số tiền' });
    const category = v.text(body.category, { name: 'Loại chi', max: 40 }) || 'Khác';
    const note = v.text(body.note, { name: 'Nội dung', max: 200, required: true });
    const date = source === 'drawer' ? ctx.today() : (body.date && isDate(body.date) ? body.date : ctx.today());
    if (source === 'drawer' && dayClosed(date)) fail(400, 'Ngày đã chốt két, không chi từ két được nữa');
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.photo || ''));
    if (!m) fail(400, 'Chụp ảnh hoá đơn / chứng từ của khoản chi');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500 || buf.length > 1_500_000) fail(400, 'Ảnh không hợp lệ, chụp lại giúp');
    fs.mkdirSync(photoDir, { recursive: true });
    const photo = `${date}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(photoDir, photo), buf);
    const pending = source === 'drawer' && amount > approveOver() && rank(me.role) < rank('shift_lead');
    const id = Number(db.prepare('INSERT INTO expenses (date, amount, source, category, note, photo, status, created_by, created_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(date, amount, source, category, note, photo, pending ? 'pending' : 'done', me.id, ctx.now(), pending ? null : me.id, pending ? null : ctx.now()).lastInsertRowid);
    const title = `${pending ? 'Duyệt chi' : 'Đã chi'} ${vnd(amount)}: ${category}`;
    ctx.notify((pending ? approvers() : bosses()).filter((x) => x !== me.id), { title, body: `${me.name} · ${SOURCES[source]} · ${note}`, link: '/chi', urgent: pending });
    ctx.audit(me, 'expense.create', { id, amount, source, category, pending });
    ctx.broadcast('pos');
    return { id, status: pending ? 'pending' : 'done' };
  });

  r.get('/api/expenses', 'staff', ({ me, query }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý');
    const to = query.get('to') || ctx.today(), from = query.get('from') || (isBoss(me) ? `${to.slice(0, 8)}01` : to);
    if (!isDate(from) || !isDate(to)) fail(400, 'Ngày không hợp lệ');
    const rows = db.prepare('SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC').all(from, to)
      .filter((e) => isBoss(me) || e.source === 'drawer');
    const ok = rows.filter((e) => e.status === 'done');
    const by = (k) => Object.entries(ok.reduce((m0, e) => ({ ...m0, [e[k]]: (m0[e[k]] || 0) + e.amount }), {})).map(([key, total]) => ({ key, name: SOURCES[key] || key, total })).sort((a, b) => b.total - a.total);
    // Trả NCC cùng kỳ (để báo cáo chi đủ, chi tiết ở Công nợ)
    const ncc = isBoss(me) ? db.prepare("SELECT p.date, p.amount, p.method, p.source, s.name AS supplier FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id WHERE p.status = 'done' AND p.date BETWEEN ? AND ? ORDER BY p.date DESC").all(from, to) : [];
    return {
      from, to, list: rows.map(row), total: ok.reduce((n, e) => n + e.amount, 0), by_source: by('source'), by_category: by('category'),
      pending: rows.filter((e) => e.status === 'pending').length, ncc, ncc_total: ncc.reduce((n, x) => n + x.amount, 0),
      holding: isBoss(me) ? holding() : null,
    };
  });

  r.get('/api/expenses/:id/photo', 'staff', ({ me, params }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / quản lý');
    const e = db.prepare('SELECT photo FROM expenses WHERE id = ?').get(params.id);
    if (!e?.photo) fail(404, 'Không có ảnh');
    let buf; try { buf = fs.readFileSync(path.join(photoDir, e.photo)); } catch { fail(410, 'Ảnh không còn'); }
    return { __binary: buf, type: e.photo.endsWith('.png') ? 'image/png' : e.photo.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
  });

  r.post('/api/expenses/:id/approve', 'shift_lead', ({ me, params, body }) => {
    const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(params.id);
    if (!e || e.status !== 'pending') fail(400, 'Phiếu chi này không chờ duyệt');
    if (e.created_by === me.id) fail(403, 'Không tự duyệt phiếu mình lập');
    const status = body.reject ? 'rejected' : 'done';
    db.prepare('UPDATE expenses SET status = ?, approved_by = ?, approved_at = ?, decision_note = ? WHERE id = ?').run(status, me.id, ctx.now(), v.text(body.note, { max: 200 }), e.id);
    if (e.created_by) ctx.notify([e.created_by], { title: `Phiếu chi ${vnd(e.amount)} ${status === 'done' ? 'đã được duyệt' : 'bị từ chối'}`, body: body.note || '', link: '/chi' });
    ctx.audit(me, 'expense.approve', { id: e.id, status });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Huỷ phiếu ghi nhầm: người lập (trong ngày, chưa chốt) hoặc quản lý
  r.post('/api/expenses/:id/void', 'staff', ({ me, params, body }) => {
    const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(params.id);
    if (!e || e.status === 'void') fail(404, 'Không tìm thấy phiếu chi');
    if (!isBoss(me) && !(e.created_by === me.id && e.date === ctx.today())) fail(403, 'Chỉ người lập (trong ngày) hoặc quản lý huỷ được');
    if (e.source === 'drawer' && dayClosed(e.date) && rank(me.role) < rank('owner')) fail(400, 'Ngày đã chốt két');
    db.prepare("UPDATE expenses SET status = 'void', decision_note = ? WHERE id = ?").run(v.text(body.note, { name: 'Lý do', max: 200 }) || 'Ghi nhầm', e.id);
    ctx.notify(bosses().filter((x) => x !== me.id), { title: `Huỷ phiếu chi ${vnd(e.amount)}`, body: `${me.name}: ${e.note}`, link: '/chi' });
    ctx.audit(me, 'expense.void', { id: e.id });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Chủ quán đặt số tiền quản lý đang giữ lúc bắt đầu dùng + loại chi
  r.put('/api/expenses/settings', 'owner', ({ me, body }) => {
    if (body.opening !== undefined) { ctx.setSetting('manager_cash_opening', v.int(Number(String(body.opening).replace(/[.,\s]/g, '')) || 0, { min: 0, max: 10_000_000_000, name: 'Số đang giữ' })); ctx.setSetting('manager_cash_start', ctx.today()); }
    if (Array.isArray(body.categories)) ctx.setSetting('expense_categories', JSON.stringify(body.categories.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 30)));
    if (body.approve_over !== undefined) ctx.setSetting('expense_approve_over', v.int(Number(body.approve_over), { min: 0, max: 100_000_000, name: 'Ngưỡng duyệt' }));
    ctx.audit(me, 'expense.settings', body);
    return { ok: true, holding: holding() };
  });

  // Tiền hiện có (chủ quán 26/10): tiền mặt quản lý đang giữ (thu ngân nộp mỗi ngày) + số dư tài khoản → cổ đông biết quán đang có bao nhiêu, chi từ đây
  r.get('/api/money/now', 'manager', () => {
    const h = holding();
    const date = ctx.today();
    let bank = { balance: null, date, entered: false };
    try {
      const b = ctx.payDay(date).bank;
      bank = { balance: b.closing ?? b.expected, date, entered: b.closing != null, opening: b.opening, ck_in: b.ck_in, ck_out: b.ck_out };
    } catch { /* chưa có số dư */ }
    const from = addDays(date, -30);
    const exp = db.prepare("SELECT id, date, amount, source, category, note, status, created_by, created_at FROM expenses WHERE source IN ('manager','bank') AND status IN ('done','pending') AND date >= ? ORDER BY date DESC, id DESC").all(from)
      .map((e) => ({ kind: 'expense', id: e.id, date: e.date, amount: e.amount, from: e.source === 'bank' ? 'bank' : 'cash', what: `${e.category} · ${e.note}`, by: name(e.created_by), status: e.status, at: e.created_at }));
    const ncc = db.prepare("SELECT p.id, p.date, p.amount, p.method, p.created_at, s.name AS supplier FROM supplier_payments p JOIN suppliers s ON s.id = p.supplier_id WHERE p.status = 'done' AND p.date >= ? AND (p.method = 'transfer' OR (p.method = 'cash' AND p.source = 'manager')) ORDER BY p.date DESC").all(from)
      .map((p) => ({ kind: 'ncc', id: p.id, date: p.date, amount: p.amount, from: p.method === 'transfer' ? 'bank' : 'cash', what: `Trả NCC ${p.supplier}`, status: 'done', at: p.created_at || 0 }));
    const recent = [...exp, ...ncc].sort((a, b) => b.date.localeCompare(a.date) || (b.at || 0) - (a.at || 0)).slice(0, 40);
    return { holding: h, bank, total: h.total + (bank.balance || 0), recent };
  });

  void addDays;
}
