import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { rank } from '../db.js';

// Chốt 2 lớp: thu ngân chốt lúc đóng cửa (đếm két theo mệnh giá + chụp ảnh tiền + bỏ phong bì),
// sáng hôm sau chủ quán DUYỆT SỔ trên điện thoại: CK so với ngân hàng (tự động), tiền mặt kiểm độc lập bằng
// A) khoản NỘP TIỀN vào tài khoản (SePay báo về) hoặc B) quản lý / chủ quán ĐẾM LẠI phong bì → bấm Đã duyệt / Có vấn đề.
export const DENOMS = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000];

export default function (r, ctx) {
  const { db } = ctx;
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  addCol('day_cash', 'denoms', "TEXT NOT NULL DEFAULT ''");
  addCol('day_cash', 'keep_float', 'INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS cash_photos (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, file TEXT NOT NULL, size INTEGER NOT NULL, staff_id INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS day_reviews (
    date TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', reviewed_by INTEGER, reviewed_at INTEGER,
    check_method TEXT NOT NULL DEFAULT '', check_amount INTEGER, check_txn_id INTEGER, check_denoms TEXT NOT NULL DEFAULT '', check_by INTEGER, check_at INTEGER,
    notified_at INTEGER, reminded_at INTEGER
  );`);
  const photoDir = ctx.photoDir || path.join(os.tmpdir(), 'quanly-photos');
  const vnd = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
  const owners = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id);
  const bosses = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id);
  const isCashier = (me) => rank(me.role) >= rank('shift_lead') || !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
  const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;

  // Đếm theo mệnh giá → tổng (thu ngân không gõ được 1 số tròn cho nhanh)
  ctx.countDenoms = (obj) => {
    let total = 0;
    const clean = {};
    for (const d of DENOMS) {
      const n = v.int(obj?.[d] ?? 0, { min: 0, max: 100000, name: `Số tờ ${d.toLocaleString('vi-VN')}` });
      if (n) { clean[d] = n; total += n * d; }
    }
    return { total, denoms: clean };
  };

  // ---------- Ảnh tiền trong két lúc chốt ----------
  r.post('/api/payments/drawer-photo', 'staff', ({ me, body }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / trưởng ca trở lên');
    const date = body.date || ctx.clock().businessDate(ctx.now());
    if (db.prepare('SELECT 1 FROM day_closings WHERE date = ?').get(date)) fail(400, 'Ngày này đã chốt');
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) fail(400, 'Ảnh không hợp lệ');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500 || buf.length > 1_500_000) fail(400, 'Ảnh không hợp lệ hoặc quá lớn');
    if (db.prepare('SELECT COUNT(*) AS n FROM cash_photos WHERE date = ?').get(date).n >= 6) fail(400, 'Tối đa 6 ảnh');
    const rel = path.join('cash', date, `${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.mkdirSync(path.join(photoDir, 'cash', date), { recursive: true });
    fs.writeFileSync(path.join(photoDir, rel), buf);
    const id = Number(db.prepare('INSERT INTO cash_photos (date, file, size, staff_id, created_at) VALUES (?, ?, ?, ?, ?)').run(date, rel, buf.length, me.id, ctx.now()).lastInsertRowid);
    ctx.broadcast('pos');
    return { id };
  });
  r.get('/api/payments/drawer-photo/:id', 'staff', ({ me, params }) => {
    const p = db.prepare('SELECT * FROM cash_photos WHERE id = ?').get(params.id);
    if (!p) fail(404, 'Không có ảnh');
    if (!isCashier(me)) fail(403, 'Không xem được');
    let buf;
    try { buf = fs.readFileSync(path.join(photoDir, p.file)); } catch { fail(410, 'Ảnh không còn'); }
    return { __binary: buf, type: p.file.endsWith('.png') ? 'image/png' : p.file.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
  });
  ctx.cashPhotos = (date) => db.prepare('SELECT id, created_at, staff_id FROM cash_photos WHERE date = ? ORDER BY id').all(date);

  // ---------- Duyệt sổ ----------
  const latestClosed = () => db.prepare("SELECT c.date FROM day_closings c LEFT JOIN day_reviews r ON r.date = c.date WHERE COALESCE(r.status, '') != 'approved' ORDER BY c.date LIMIT 1").get()?.date
    || db.prepare('SELECT date FROM day_closings ORDER BY date DESC LIMIT 1').get()?.date || null;

  function book(date) {
    const d = ctx.payDay(date);
    const s = d.summary;
    const rv = db.prepare('SELECT r.*, a.name AS reviewed_by_name, b.name AS check_by_name FROM day_reviews r LEFT JOIN staff a ON a.id = r.reviewed_by LEFT JOIN staff b ON b.id = r.check_by WHERE r.date = ?').get(date) || null;
    const envelope = s.drawer_counted != null ? s.drawer_counted - (d.drawer?.keep_float || 0) : null;
    // Chuyển khoản: tiền ngân hàng báo vào (trừ khoản đã đánh dấu là nộp tiền mặt) phải = CK đã xác nhận + tip CK
    const bankSales = s.bank_in;
    const ckExpected = s.transfer_confirmed + s.tip_transfer + (s.overpay_refunded || 0); // CK dư đã hoàn lại: tiền vẫn vào TK, trả ra bằng giao dịch riêng
    const next = (() => { const x = new Date(`${date}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 3); return x.toISOString().slice(0, 10); })();
    // Khoản tiền vào chưa khớp bill trong 3 ngày sau = ứng viên "nộp tiền mặt"
    const deposits = db.prepare("SELECT id, amount, content, txn_at, received_at, date, status FROM bank_txns WHERE direction = 'in' AND date >= ? AND date <= ? AND (status = 'unmatched' OR id = ?) ORDER BY ABS(amount - ?) LIMIT 8")
      .all(date, next, rv?.check_txn_id || 0, envelope || 0);
    const checkDiff = rv?.check_amount != null && envelope != null ? rv.check_amount - envelope : null;
    const nextDay = (() => { const x = new Date(`${date}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); })();
    const nextOpening = db.prepare('SELECT opening FROM day_cash WHERE date = ?').get(nextDay)?.opening ?? null;
    return {
      date, day: d, review: rv, envelope, keep_float: d.drawer?.keep_float ?? null,
      denoms: d.drawer?.denoms ? JSON.parse(d.drawer.denoms) : null, photos: ctx.cashPhotos(date),
      checks: {
        ck: { bank: bankSales, expected: ckExpected, ok: !d.sepay ? null : bankSales === ckExpected, sepay: d.sepay },
        cash: { method: rv?.check_method || '', amount: rv?.check_amount ?? null, diff: checkDiff, ok: checkDiff == null ? null : checkDiff === 0 },
        // Tiền để lại két hôm nay phải = két đầu ngày hôm sau
        float: { keep: d.drawer?.keep_float ?? null, next_opening: nextOpening, ok: nextOpening == null || d.drawer?.keep_float == null ? null : nextOpening === d.drawer.keep_float },
      },
      deposits,
      pending_days: db.prepare("SELECT c.date FROM day_closings c LEFT JOIN day_reviews r ON r.date = c.date WHERE COALESCE(r.status, '') NOT IN ('approved') ORDER BY c.date").all().map((x) => x.date),
    };
  }
  ctx.dayBook = book;

  r.get('/api/daybook', 'manager', ({ query }) => {
    const date = query.get('date') || latestClosed();
    if (!date) return { date: null, pending_days: [] };
    if (!db.prepare('SELECT 1 FROM day_closings WHERE date = ?').get(date)) return { date, not_closed: true, pending_days: book(date).pending_days };
    return book(date);
  });

  // Kiểm tiền mặt độc lập với thu ngân: A) chọn khoản nộp ngân hàng, B) đếm lại phong bì
  r.post('/api/daybook/cash-check', 'manager', ({ me, body }) => {
    const date = String(body.date || '');
    if (!db.prepare('SELECT 1 FROM day_closings WHERE date = ?').get(date)) fail(400, 'Ngày này thu ngân chưa chốt');
    const method = v.oneOf(body.method, ['deposit', 'recount'], { name: 'Cách kiểm' });
    db.prepare('INSERT OR IGNORE INTO day_reviews (date) VALUES (?)').run(date);
    const cur = db.prepare('SELECT * FROM day_reviews WHERE date = ?').get(date);
    if (cur.status === 'approved') fail(400, 'Ngày này đã duyệt');
    let amount;
    let txnId = null;
    let denoms = '';
    if (method === 'deposit') {
      if (body.txn_id) {
        const t = db.prepare("SELECT * FROM bank_txns WHERE id = ? AND direction = 'in'").get(v.int(body.txn_id, { min: 1, name: 'Giao dịch' }));
        if (!t || !['unmatched', 'deposit'].includes(t.status)) fail(400, 'Khoản này không dùng được');
        if (cur.check_txn_id && cur.check_txn_id !== t.id) db.prepare("UPDATE bank_txns SET status = 'unmatched', note = '' WHERE id = ?").run(cur.check_txn_id);
        db.prepare("UPDATE bank_txns SET status = 'deposit', note = ?, handled_by = ? WHERE id = ?").run(`Nộp tiền mặt ngày ${dm(date)}`, me.id, t.id);
        amount = t.amount;
        txnId = t.id;
      } else {
        amount = v.int(Number(String(body.amount ?? '').replace(/[.,\s]/g, '')), { min: 0, max: 1_000_000_000, name: 'Số tiền nộp' });
      }
    } else {
      const c = ctx.countDenoms(body.denoms || {});
      amount = c.total;
      denoms = JSON.stringify(c.denoms);
    }
    db.prepare('UPDATE day_reviews SET check_method = ?, check_amount = ?, check_txn_id = ?, check_denoms = ?, check_by = ?, check_at = ? WHERE date = ?').run(method, amount, txnId, denoms, me.id, ctx.now(), date);
    const b = book(date);
    if (b.checks.cash.diff) {
      const closer = db.prepare('SELECT s.name FROM day_closings c LEFT JOIN staff s ON s.id = c.confirmed_by WHERE c.date = ?').get(date)?.name || '?';
      ctx.notify(owners().filter((x) => x !== me.id), { title: `Tiền mặt ngày ${dm(date)} lệch ${vnd(b.checks.cash.diff)}`, body: `Phong bì thu ngân ${closer} ghi ${vnd(b.envelope)}, ${method === 'deposit' ? 'nộp ngân hàng' : `${me.name} đếm lại`} ${vnd(amount)}.`, link: `/duyet-so?date=${date}`, urgent: true });
    }
    ctx.audit(me, 'daybook.cash_check', { date, method, amount, diff: b.checks.cash.diff });
    ctx.broadcast('pos');
    return { ok: true, diff: b.checks.cash.diff };
  });

  r.post('/api/daybook/review', 'owner', ({ me, body }) => {
    const date = String(body.date || '');
    if (!db.prepare('SELECT 1 FROM day_closings WHERE date = ?').get(date)) fail(400, 'Ngày này thu ngân chưa chốt');
    const status = v.oneOf(body.status, ['approved', 'issue'], { name: 'Kết quả' });
    const note = v.text(body.note, { name: 'Ghi chú', max: 300 });
    if (status === 'issue' && !note) fail(400, 'Ghi rõ vấn đề để thu ngân / quản lý biết');
    db.prepare('INSERT OR IGNORE INTO day_reviews (date) VALUES (?)').run(date);
    db.prepare('UPDATE day_reviews SET status = ?, note = ?, reviewed_by = ?, reviewed_at = ? WHERE date = ?').run(status, note, me.id, ctx.now(), date);
    if (status === 'issue') {
      const closer = db.prepare('SELECT confirmed_by FROM day_closings WHERE date = ?').get(date)?.confirmed_by;
      ctx.notify([...new Set([...bosses(), closer].filter((x) => x && x !== me.id))], { title: `Chủ quán báo vấn đề sổ ngày ${dm(date)}`, body: note, link: `/thu-ngan`, urgent: true });
    }
    ctx.audit(me, 'daybook.review', { date, status, note });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Chủ quán mở lại ngày đã chốt (vd thu ngân chốt nhầm) — ghi nhật ký
  r.post('/api/daybook/reopen', 'owner', ({ me, body }) => {
    const date = String(body.date || '');
    const reason = v.text(body.reason, { name: 'Lý do', required: true, max: 200 });
    if (!db.prepare('SELECT 1 FROM day_closings WHERE date = ?').get(date)) fail(400, 'Ngày này chưa chốt');
    db.prepare('DELETE FROM day_closings WHERE date = ?').run(date);
    db.prepare("UPDATE day_reviews SET status = '', reviewed_by = ?, reviewed_at = ?, note = ? WHERE date = ?").run(me.id, ctx.now(), `Mở lại: ${reason}`, date);
    ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND (role IN ('manager','shift_lead') OR team_id IN (SELECT id FROM teams WHERE name = 'Thu ngân'))").all().map((x) => x.id), { title: `Chủ quán mở lại sổ ngày ${dm(date)}`, body: reason, link: '/thu-ngan', urgent: true });
    ctx.audit(me, 'daybook.reopen', { date, reason });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // Mỗi 5 phút: tới giờ báo cáo sáng (mặc định 07:00) thì gửi chủ quán bản tóm tắt ngày đã chốt chưa duyệt; quá 2 ngày chưa duyệt thì nhắc
  ctx.reviewTick = () => {
    const now = ctx.now();
    const clock = ctx.clock();
    let at;
    try { at = Number((ctx.setting('review_report_time') || '07:00').split(':')[0]) * 60 + Number((ctx.setting('review_report_time') || '07:00').split(':')[1]); } catch { at = 420; }
    const min = clock.minuteOf(now);
    if (min < at || min > 22 * 60) return 0;
    let n = 0;
    for (const { date } of db.prepare("SELECT c.date FROM day_closings c LEFT JOIN day_reviews r ON r.date = c.date WHERE COALESCE(r.status, '') NOT IN ('approved') ORDER BY c.date").all()) {
      db.prepare('INSERT OR IGNORE INTO day_reviews (date) VALUES (?)').run(date);
      const rv = db.prepare('SELECT * FROM day_reviews WHERE date = ?').get(date);
      if (rv.status === 'issue') continue;
      const b = book(date);
      const s = b.day.summary;
      if (!rv.notified_at) {
        const bad = b.day.anomalies.filter((a) => a.level === 'bad').length;
        ctx.notify(owners(), {
          title: `Duyệt sổ ${dm(date)}: doanh thu ${vnd(s.net)}${bad ? ` · ${bad} điểm cần xem` : ' · không bất thường lớn'}`,
          body: `${(() => { const p = ctx.purchaseDay ? ctx.purchaseDay(date) : null; return p && (p.bills.n || p.pending) ? `Nhập hàng ${p.bills.n} bill ${vnd(p.bills.t)}${p.flagged ? ` (${p.flagged} bill lệch/giá tăng)` : ''}, chi NCC ${vnd(p.paid)}${p.pending ? `, ${p.pending} bill chờ duyệt` : ''} · ` : ''; })()}CK ${vnd(s.transfer_confirmed)}${b.checks.ck.ok === false ? ' (LỆCH ngân hàng)' : b.checks.ck.ok ? ' (khớp ngân hàng)' : ''} · TM ${vnd(s.cash_in)} · phong bì ${vnd(b.envelope)} chờ kiểm (nộp ngân hàng / đếm lại) · tip ${vnd(s.tip_cash + s.tip_transfer)} · két ${s.drawer_diff ? `lệch ${vnd(s.drawer_diff)}` : 'khớp'}. Bấm để duyệt.`,
          link: `/duyet-so?date=${date}`,
        });
        db.prepare('UPDATE day_reviews SET notified_at = ? WHERE date = ?').run(now, date);
        n++;
      } else if (now - (rv.reminded_at || rv.notified_at) > 2 * 86_400_000) {
        ctx.notify(owners(), { title: `Sổ ngày ${dm(date)} chưa duyệt (${Math.floor((now - rv.notified_at) / 86_400_000)} ngày)`, body: 'Duyệt sớm để kịp hỏi lại thu ngân nếu lệch.', link: `/duyet-so?date=${date}`, urgent: true });
        db.prepare('UPDATE day_reviews SET reminded_at = ? WHERE date = ?').run(now, date);
        n++;
      }
    }
    return n;
  };
}
