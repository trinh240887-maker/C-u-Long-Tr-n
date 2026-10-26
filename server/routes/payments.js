import { fail, v } from '../http.js';
import { addDays as addD } from '../lib/time.js';
import { tx, rank, pinLookup } from '../db.js';
import { billQR } from '../lib/vietqr.js';
import { billBytes, refundBytes } from '../lib/escpos.js';

// GĐ3D Thanh toán (quy trình chủ quán chốt 22/10)
// Bill: đang phục vụ → ĐÃ THANH TOÁN (bàn trống, bán tiếp) → THU NGÂN XÁC NHẬN → CHỐT NGÀY (khoá).
// - Tiền mặt: phục vụ thu, bấm "Đã thu tiền mặt" → bill đóng, bàn mở bán lại, bill ở trạng thái "CHỜ THU NGÂN XÁC NHẬN".
//   Phục vụ đưa ngay tiền + bill cho thu ngân → thu ngân đếm, bấm Xác nhận (lệch thì ghi tên, báo chủ quán).
//   Thu ngân / trưởng ca tự thu thì tiền vào thẳng két. Khách không lấy tiền thối = tip quỹ chung.
// - Chuyển khoản: QR đúng số tiền + mã CLT<số bill>. Ngân hàng báo tiền về (SePay) → app tự đóng bill, mở bàn.
//   Chưa có báo tiền về: phục vụ bấm "Khách đã CK, chờ tiền về". CK dư = tip quỹ chung; CK thiếu = chưa đóng bill.
// - Cuối ngày: két đầu ngày + tiền nhận từ phục vụ − hoàn tiền = phải có; thu ngân đếm két thật, xác nhận CK, chốt ngày.
// - Khách trả rồi mới báo thiếu món: không sửa bill, PHIẾU HOÀN TIỀN MẶT (quản lý duyệt PIN), chủ quán nhận báo.
// Không VAT, không quẹt thẻ.
export default function (r, ctx) {
  const { db } = ctx;
  const addCol = (table, col, def) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('table_sessions', 'bill_no', 'INTEGER');
  addCol('table_sessions', 'bill_snapshot', 'TEXT');
  addCol('table_sessions', 'pay_method', "TEXT NOT NULL DEFAULT ''"); // cash | transfer | mixed
  addCol('table_sessions', 'paid_total', 'INTEGER NOT NULL DEFAULT 0');
  addCol('table_sessions', 'cash_amount', 'INTEGER NOT NULL DEFAULT 0');
  addCol('table_sessions', 'transfer_amount', 'INTEGER NOT NULL DEFAULT 0');
  addCol('table_sessions', 'cash_given', 'INTEGER NOT NULL DEFAULT 0');
  addCol('table_sessions', 'closed_date', "TEXT NOT NULL DEFAULT ''");
  addCol('table_sessions', 'reconcile_status', "TEXT NOT NULL DEFAULT ''"); // pending | confirmed | missing
  addCol('table_sessions', 'reconciled_at', 'INTEGER');
  addCol('table_sessions', 'reconciled_by', 'INTEGER');
  addCol('table_sessions', 'reconcile_note', "TEXT NOT NULL DEFAULT ''");
  addCol('order_items', 'refunded_qty', 'INTEGER NOT NULL DEFAULT 0');
  addCol('table_sessions', 'cash_status', "TEXT NOT NULL DEFAULT ''"); // held (chờ thu ngân xác nhận) | received (thu ngân đã xác nhận)
  addCol('table_sessions', 'cash_received_by', 'INTEGER');
  addCol('table_sessions', 'cash_received_at', 'INTEGER');
  addCol('table_sessions', 'handover_id', 'INTEGER');
  addCol('table_sessions', 'tip_cash', 'INTEGER NOT NULL DEFAULT 0');
  addCol('table_sessions', 'tip_transfer', 'INTEGER NOT NULL DEFAULT 0');
  addCol('table_sessions', 'pending_alerted', 'INTEGER NOT NULL DEFAULT 0');
  addCol('table_sessions', 'overpay', 'INTEGER NOT NULL DEFAULT 0');           // CK dư bất thường (có thể khách chuyển 2 lần)
  addCol('table_sessions', 'overpay_status', "TEXT NOT NULL DEFAULT ''");     // pending | tip | refunded
  db.exec(`CREATE TABLE IF NOT EXISTS cash_handovers (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, staff_id INTEGER NOT NULL, session_ids TEXT NOT NULL, expected INTEGER NOT NULL, counted INTEGER NOT NULL,
    diff INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', received_by INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS day_cash (
    date TEXT PRIMARY KEY, opening INTEGER, opening_by INTEGER, opening_at INTEGER,
    counted INTEGER, counted_by INTEGER, counted_at INTEGER, note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS bank_txns (
    id INTEGER PRIMARY KEY, provider TEXT NOT NULL, ext_id TEXT NOT NULL, direction TEXT NOT NULL, amount INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '', account TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '',
    txn_at TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, received_at INTEGER NOT NULL,
    session_id INTEGER, status TEXT NOT NULL DEFAULT 'unmatched',
    note TEXT NOT NULL DEFAULT '', handled_by INTEGER, raw TEXT NOT NULL DEFAULT '{}',
    UNIQUE (provider, ext_id)
  );`);
  // bank_txns.status: tiền vào matched | unmatched (chưa khớp) | review (cần thu ngân xem) | ignored; tiền ra unassigned (chờ gán công nợ NCC)
  db.exec(`CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'cash', reason TEXT NOT NULL, lines TEXT NOT NULL DEFAULT '[]',
    date TEXT NOT NULL, created_by INTEGER, approved_by INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS day_closings (
    date TEXT PRIMARY KEY, totals TEXT NOT NULL, confirmed_by INTEGER, confirmed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_closed ON table_sessions (closed_date, status);`);

  // Đối soát số dư tài khoản ngân hàng mỗi ngày: đầu ngày + thu − chi = phải có, so với số dư thật trên app ngân hàng
  db.exec(`CREATE TABLE IF NOT EXISTS bank_day (date TEXT PRIMARY KEY, opening INTEGER, closing INTEGER, other_in INTEGER NOT NULL DEFAULT 0, other_out INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '', by_staff INTEGER, at INTEGER)`);
  const isCashier = (me) => rank(me.role) >= rank('shift_lead') || !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
  // Đóng bill / thu tiền: chỉ chủ quán + người tổ Thu ngân (chủ quán 24/10). Quản lý, trưởng ca, phục vụ: chỉ xem bill, in bill
  const canCollect = (me) => me.role === 'owner' || !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
  const needCashier = (me) => { if (!isCashier(me)) fail(403, 'Chỉ thu ngân / trưởng ca trở lên'); };
  const staffName = (id) => (id ? db.prepare('SELECT name FROM staff WHERE id = ?').get(id)?.name || '' : '');
  const billNo = (sid) => {
    const s = db.prepare('SELECT bill_no FROM table_sessions WHERE id = ?').get(sid);
    if (s.bill_no) return s.bill_no;
    const n = Number(ctx.setting('bill_seq') || 0) + 1;
    ctx.setSetting('bill_seq', n);
    db.prepare('UPDATE table_sessions SET bill_no = ? WHERE id = ?').run(n, sid);
    return n;
  };
  const noteOf = (no) => `CLT${no}`;
  const billStation = () => Number(ctx.setting('bill_station_id')) || db.prepare("SELECT id FROM kitchen_stations WHERE name = 'Bò'").get()?.id || db.prepare('SELECT id FROM kitchen_stations ORDER BY sort LIMIT 1').get()?.id;
  const refundsOf = (sid) => db.prepare('SELECT r.*, a.name AS approver_name, c.name AS by_name FROM refunds r LEFT JOIN staff a ON a.id = r.approved_by LEFT JOIN staff c ON c.id = r.created_by WHERE r.session_id = ? ORDER BY r.id').all(sid)
    .map((x) => ({ ...x, lines: JSON.parse(x.lines) }));

  function billData(id) {
    const s = ctx.posSession(id);
    const no = billNo(s.id);
    const live = s.items.filter((i) => i.status !== 'cancelled');
    const paid = s.status === 'closed';
    const bankIn = bankReceived(s.id);
    const qrAmount = paid ? Math.max(0, s.transfer_amount - bankIn) : Math.max(0, s.total - bankIn);
    const qr = ctx.setting('bank_qr') && qrAmount > 0 && (!paid || s.transfer_amount > 0) ? billQR(ctx.setting('bank_qr'), { amount: qrAmount, content: noteOf(no) }) : '';
    const refunds = refundsOf(s.id);
    const clock = ctx.clock();
    return {
      id: s.id, status: s.status, paid, bill_no: no, header: s.header, tables: s.tables, ck_claimed: (s.note || '').includes('[CK]'),
      shop: { name: ctx.setting('shop_name'), address: ctx.setting('shop_address'), phone: ctx.setting('shop_phone') },
      opened: clock.fmt(s.opened_at), printed: clock.fmt(ctx.now()),
      staff: s.opened_by_name || '', cashier: paid ? staffName(s.closed_by) : '',
      lines: live.map((i) => ({ id: i.id, name: i.name, qty: i.qty, unit_price: i.unit_price, total: i.total, net: i.net, status: i.status, refunded_qty: i.refunded_qty || 0,
        options: i.options.map((o) => o.name).join(', '), promos: i.promos || [] })),
      count: live.reduce((n, i) => n + i.qty, 0),
      subtotal: s.subtotal, item_discount: s.item_discount, bill_promos: s.bill_promos, discount: s.discount, total: s.total,
      unserved: live.filter((i) => i.status === 'sent').length, unsent: s.unsent,
      pay_method: s.pay_method, cash_amount: s.cash_amount, transfer_amount: s.transfer_amount, cash_given: s.cash_given, change: s.cash_given ? s.cash_given - s.cash_amount : 0,
      reconcile_status: s.reconcile_status, closed_at: s.closed_at, closed_auto: paid && !s.closed_by,
      cash_status: s.cash_status, tip_cash: s.tip_cash, tip_transfer: s.tip_transfer, bank_received: bankIn,
      bank_txns: db.prepare("SELECT id, amount, content, txn_at, provider FROM bank_txns WHERE session_id = ? AND direction = 'in' ORDER BY id").all(s.id),
      refunds, refunded: refunds.reduce((n, x) => n + x.amount, 0),
      changes: db.prepare('SELECT c.*, s.name AS by_name FROM payment_changes c LEFT JOIN staff s ON s.id = c.changed_by WHERE c.session_id = ? ORDER BY c.id').all(s.id),
      qr, qr_amount: qrAmount, transfer_note: noteOf(no), bank_name: ctx.setting('bank_name') || 'Ngân hàng',
      sepay: ctx.setting('sepay_enabled') === '1',
    };
  }
  ctx.billData = billData;
  function bankReceived(sid) { return db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM bank_txns WHERE session_id = ? AND direction = 'in' AND status IN ('matched','review')").get(sid).n; }
  const dayClosed = (date) => !!db.prepare('SELECT 1 FROM day_closings WHERE date = ?').get(date);
  const cashiers = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND (role IN ('owner','manager','shift_lead') OR team_id IN (SELECT id FROM teams WHERE name = 'Thu ngân'))").all().map((x) => x.id);
  const bosses = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id);
  const vnd = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;

  // Đóng bill (dùng chung: phục vụ bấm, hoặc ngân hàng báo tiền về). by = null nghĩa là tự động
  // cashStatus: received = thu ngân thu thẳng vào két; held = người thu còn giữ, phải giao lại két
  function closeBill(s, { by, method, cash = 0, transfer = 0, given = 0, tipCash = 0, tipTransfer = 0, reconcile = '', cashStatus = 'received' }) {
    const snapshot = { lines: s.items.filter((i) => i.promos?.length).map((i) => [i.id, i.promos]), item_discount: s.item_discount, bill: s.bill_promos, discount: s.discount, subtotal: s.subtotal, total: s.total };
    tx(db, () => {
      billNo(s.id);
      db.prepare(`UPDATE table_sessions SET status = 'closed', closed_at = ?, closed_by = ?, closed_date = ?, pay_method = ?, paid_total = ?, cash_amount = ?, transfer_amount = ?, cash_given = ?,
        reconcile_status = ?, cash_status = ?, tip_cash = ?, tip_transfer = ?, bill_snapshot = ? WHERE id = ?`)
        .run(ctx.now(), by, ctx.clock().businessDate(ctx.now()), method, s.total, cash, transfer, given, transfer > 0 ? reconcile || 'pending' : '', cash > 0 || tipCash > 0 ? cashStatus : '', tipCash, tipTransfer, JSON.stringify(snapshot), s.id);
      if ((cash > 0 || tipCash > 0) && cashStatus === 'received') db.prepare('UPDATE table_sessions SET cash_received_by = ?, cash_received_at = ? WHERE id = ?').run(by, ctx.now(), s.id);
    });
  }

  // Khách CK dư: dư ít (≤ 100.000đ và ≤ 30% bill) = tip quỹ chung; dư nhiều = bất thường (chuyển 2 lần / gõ thừa số 0) → quản lý quyết
  function setExcess(sid, excess, bill) {
    const cur = db.prepare('SELECT overpay, overpay_status FROM table_sessions WHERE id = ?').get(sid);
    const normal = excess <= 100000 && excess <= bill * 0.3;
    if (excess <= 0) { db.prepare("UPDATE table_sessions SET tip_transfer = 0, overpay = 0, overpay_status = '' WHERE id = ?").run(sid); return; }
    if (normal) { db.prepare("UPDATE table_sessions SET tip_transfer = ?, overpay = 0, overpay_status = '' WHERE id = ?").run(excess, sid); return; }
    if (cur.overpay === excess && ['tip', 'refunded'].includes(cur.overpay_status)) return; // đã xử lý
    db.prepare("UPDATE table_sessions SET tip_transfer = 0, overpay = ?, overpay_status = 'pending' WHERE id = ?").run(excess, sid);
    const s = db.prepare('SELECT bill_no FROM table_sessions WHERE id = ?').get(sid);
    ctx.notify([...new Set([...bosses(), ...cashiers()])], { title: `Bill ${s.bill_no}: khách CK dư bất thường ${vnd(excess)}`, body: 'Có thể khách chuyển 2 lần hoặc gõ thừa số. Liên hệ khách: hoàn lại hay tip? Quản lý xử lý ở Thu ngân.', link: '/thu-ngan', urgent: true });
  }

  // Tiền vào từ ngân hàng: khớp bill theo mã CLT<số bill>
  ctx.applyBankIn = (txnId) => {
    const t = db.prepare('SELECT * FROM bank_txns WHERE id = ?').get(txnId);
    if (!t || t.direction !== 'in') return null;
    let sid = t.session_id;
    if (!sid) {
      const m = /CLT\s*0*(\d{1,8})/i.exec(`${t.code} ${t.content}`);
      const s0 = m ? db.prepare("SELECT id FROM table_sessions WHERE bill_no = ? AND status != 'cancelled'").get(Number(m[1])) : null;
      if (!s0) {
        db.prepare("UPDATE bank_txns SET status = 'unmatched' WHERE id = ?").run(t.id);
        ctx.notify(cashiers(), { title: `Tiền vào chưa khớp bill: ${vnd(t.amount)}`, body: `Nội dung "${t.content.slice(0, 80)}". Vào Thu ngân → Tiền chưa khớp để ghép bill.`, link: '/thu-ngan' });
        ctx.broadcast('pos');
        return { matched: false };
      }
      sid = s0.id;
    }
    db.prepare("UPDATE bank_txns SET session_id = ?, status = 'matched' WHERE id = ?").run(sid, t.id);
    const s = ctx.posSession(sid);
    const got = bankReceived(sid);
    const waiter = [s.opened_by].filter(Boolean);
    if (['open', 'paying'].includes(s.status)) {
      if (got >= s.total) {
        closeBill(s, { by: null, method: 'transfer', transfer: s.total, reconcile: 'matched' });
        setExcess(sid, got - s.total, s.total);
        ctx.notify([...new Set([...waiter, ...cashiers()])], { title: `Bàn ${s.header} đã nhận CK ${vnd(got)}`, body: `Bill ${billNo(sid)} đã thanh toán, bàn trống.${got > s.total ? ` Khách CK dư ${vnd(got - s.total)} → tip quỹ chung.` : ''}`, link: `/goi-mon?s=${sid}` });
        ctx.audit(null, 'pay.auto_close', { id: sid, got, total: s.total });
      } else {
        ctx.notify(waiter, { title: `Bàn ${s.header}: mới nhận ${vnd(got)}, còn thiếu ${vnd(s.total - got)}`, body: 'Mở Tính tiền để khách quét mã phần còn thiếu.', link: `/goi-mon?s=${sid}`, urgent: true });
      }
    } else if (s.status === 'closed') {
      if (s.transfer_amount > 0) {
        if (got >= s.transfer_amount) {
          db.prepare("UPDATE table_sessions SET reconcile_status = CASE WHEN reconcile_status = 'confirmed' THEN 'confirmed' ELSE 'matched' END WHERE id = ?").run(sid);
          setExcess(sid, got - s.transfer_amount, s.paid_total);
        } else {
          ctx.notify(cashiers(), { title: `Bill ${s.bill_no} CK thiếu ${vnd(s.transfer_amount - got)}`, body: `Phải nhận ${vnd(s.transfer_amount)}, mới về ${vnd(got)}. Bàn ${s.header}.`, link: '/thu-ngan', urgent: true });
        }
      } else {
        // Bill đã trả tiền mặt mà vẫn có CK về: thu ngân xem (khách trả 2 lần thì hoàn lại, hay tip)
        db.prepare("UPDATE bank_txns SET status = 'review', note = 'Bill đã trả tiền mặt' WHERE id = ?").run(t.id);
        ctx.notify(cashiers(), { title: `Bill ${s.bill_no} trả tiền mặt nhưng có CK ${vnd(t.amount)}`, body: 'Kiểm tra: khách trả 2 lần (hoàn lại) hay tip.', link: '/thu-ngan', urgent: true });
      }
    }
    ctx.broadcast('pos');
    return { matched: true, session_id: sid };
  };
  const printBill = (id) => {
    const b = billData(id);
    const st = billStation();
    if (!st) fail(400, 'Chưa có máy in bill');
    ctx.printDoc(st, `Bill ${b.bill_no}`, billBytes(b, { mode: ctx.printMode() }));
    return b;
  };

  // QR cho phần chuyển khoản của bill trả kết hợp (TM + CK)
  r.get('/api/payments/qr', 'staff', ({ query }) => {
    const amount = v.int(Number(query.get('amount')), { min: 1000, max: 1_000_000_000, name: 'Số tiền' });
    const note = v.text(query.get('note'), { name: 'Nội dung', max: 25 });
    if (!ctx.setting('bank_qr')) fail(400, 'Chưa cài mã QR ngân hàng');
    return { qr: billQR(ctx.setting('bank_qr'), { amount, content: note }) };
  });

  // Phục vụ báo thu ngân: khách trả tiền mặt (phục vụ không cầm tiền)
  r.post('/api/pos/sessions/:id/request-cash', 'staff', ({ me, params }) => {
    const s = ctx.posSession(params.id);
    if (!['open', 'paying'].includes(s.status)) fail(400, 'Bàn này đã đóng');
    if (s.unsent) fail(400, `Còn ${s.unsent} món chưa gửi bếp`);
    const no = billNo(s.id);
    db.prepare("UPDATE table_sessions SET status = 'paying', note = CASE WHEN note LIKE '%[TM]%' THEN note ELSE TRIM(note || ' [TM]') END WHERE id = ?").run(s.id);
    ctx.notify(cashiers().filter((x) => x !== me.id), { title: `Bàn ${s.header} trả TIỀN MẶT ${vnd(s.total)}`, body: `Bill ${no} · ${me.name} báo. Mời khách ra quầy hoặc ra bàn thu.`, link: `/goi-mon?s=${s.id}`, urgent: true });
    ctx.audit(me, 'pay.request_cash', { id: s.id, total: s.total });
    ctx.broadcast('pos');
    return { ok: true, bill_no: no };
  });
  // Bàn đang chờ thu ngân thu tiền
  r.get('/api/payments/waiting', 'staff', ({ me }) => {
    needCashier(me);
    // Mọi bàn đang mở có món (phục vụ không báo nữa, chủ quán 24/10): bàn xin tính tiền / đã báo lên trước
    return db.prepare("SELECT id FROM table_sessions WHERE status IN ('open','paying') AND EXISTS (SELECT 1 FROM order_items i WHERE i.session_id = table_sessions.id AND i.status != 'cancelled') ORDER BY status = 'paying' DESC, id").all().map((x) => {
      const s = ctx.posSession(x.id);
      return { id: s.id, header: s.header, total: s.total, bill_no: s.bill_no, cash: s.note.includes('[TM]'), ck: s.note.includes('[CK]'), asking: s.status === 'paying', opened_by: s.opened_by_name, unserved: s.items.filter((i) => i.status === 'sent').length };
    });
  });

  r.get('/api/pos/sessions/:id/bill', 'staff', ({ params }) => billData(params.id));

  r.post('/api/pos/sessions/:id/print-bill', 'staff', ({ me, params }) => {
    const b = printBill(params.id);
    ctx.audit(me, 'pay.print_bill', { id: b.id, bill_no: b.bill_no, total: b.total });
    return { ok: true, bill_no: b.bill_no };
  });

  r.post('/api/pos/sessions/:id/pay', 'staff', ({ me, params, body }) => {
    const s = ctx.posSession(params.id);
    if (!['open', 'paying'].includes(s.status)) fail(400, 'Bàn này đã đóng');
    if (s.unsent) fail(400, `Còn ${s.unsent} món chưa gửi bếp: gửi hoặc xoá trước khi tính tiền`);
    const live = s.items.filter((i) => i.status !== 'cancelled');
    if (!live.length) fail(400, 'Bàn chưa có món nào');
    const unserved = live.filter((i) => i.status === 'sent');
    if (unserved.length && !body.confirm_unserved) {
      fail(409, `Còn ${unserved.length} món chưa bấm "Đã ra" (${unserved.slice(0, 3).map((i) => i.name).join(', ')}${unserved.length > 3 ? '…' : ''}). Hỏi khách đã nhận đủ món chưa?`);
    }
    const method = v.oneOf(body.method, ['cash', 'transfer', 'mixed'], { name: 'Cách trả' });
    // Chỉ thu ngân / trưởng ca trở lên thu tiền mặt đóng bill; phục vụ bấm "Báo thu ngân" (chủ quán 24/10)
    if (method !== 'transfer' && !canCollect(me)) fail(403, 'Chỉ thu ngân / chủ quán thu tiền mặt, đóng bill');
    const total = s.total;
    // Phục vụ bấm "Khách đã CK": chưa đóng bill — chờ thu ngân xác nhận (hoặc ngân hàng báo tiền về thì tự đóng), bàn vẫn giữ
    if (method === 'transfer' && !canCollect(me) && bankReceived(s.id) < total) {
      db.prepare("UPDATE table_sessions SET status = 'paying', note = CASE WHEN note LIKE '%[CK]%' THEN note ELSE TRIM(note || ' [CK]') END WHERE id = ?").run(s.id);
      ctx.notify(cashiers().filter((x) => x !== me.id), { title: `Bàn ${s.header} báo khách đã CK ${vnd(total)}`, body: `Bill ${billNo(s.id)} · ${me.name} báo. Kiểm tra tiền về rồi bấm xác nhận để mở bàn.`, link: `/goi-mon?s=${s.id}`, urgent: true });
      ctx.audit(me, 'pay.claim_transfer', { id: s.id, total });
      ctx.broadcast('pos');
      return { ok: true, waiting: true, total };
    }
    const money = (x, name) => v.int(Number(String(x ?? '').replace(/[.,\s]/g, '')), { min: 0, max: 1_000_000_000, name });
    let cash = 0;
    let transfer = 0;
    let given = 0;
    let tipCash = 0;
    if (method === 'transfer') transfer = total;
    else if (method === 'cash') {
      cash = total;
      given = body.cash_given === undefined || body.cash_given === '' ? 0 : money(body.cash_given, 'Tiền khách đưa');
      if (given && given < total) fail(400, `Khách đưa ${vnd(given)} chưa đủ ${vnd(total)}`);
      // Khách không lấy tiền thối → tip quỹ chung
      if (body.keep_change && given > total) tipCash = given - total;
    } else {
      cash = v.int(Number(String(body.cash_amount ?? '').replace(/[.,\s]/g, '')), { min: 1, max: total - 1, name: 'Phần tiền mặt' });
      transfer = total - cash;
    }
    const got = bankReceived(s.id);
    // Khách CK thêm tip (không nối ngân hàng): thu ngân lấy đúng số này tiền mặt trong két bỏ thùng tip
    const tipTransfer = transfer > 0 && body.tip_transfer ? money(body.tip_transfer, 'Tip CK') : 0;
    if (tipTransfer > Math.max(500000, total)) fail(400, `Tip CK ${vnd(tipTransfer)} lớn bất thường so với bill ${vnd(total)}: kiểm tra lại số`);
    closeBill(s, { by: me.id, method, cash, transfer, given, tipCash, tipTransfer, reconcile: transfer > 0 && got >= transfer ? 'matched' : 'pending', cashStatus: isCashier(me) ? 'received' : 'held' });
    if (transfer > 0 && got > transfer) setExcess(s.id, got - transfer, total);
    let printed = false;
    if (body.print) { try { printed = !!printBill(s.id); } catch { printed = false; } } // chưa có máy in bill thì vẫn đóng bill bình thường
    ctx.audit(me, 'pay.close', { id: s.id, total, method, cash, transfer, tip_cash: tipCash, tip_transfer: tipTransfer, unserved: unserved.length });
    ctx.broadcast('pos');
    return { ok: true, total, change: given ? given - cash - tipCash : 0, tip: tipCash, hand_over: cash + tipCash, printed };
  });

  // Tiền mặt đang nằm trong tay phục vụ (chưa giao thu ngân)
  const heldRows = (staffId) => db.prepare(`SELECT s.id, s.bill_no, s.closed_at, s.closed_by, s.cash_amount, s.tip_cash, c.name AS staff_name FROM table_sessions s LEFT JOIN staff c ON c.id = s.closed_by
    WHERE s.status = 'closed' AND s.cash_status = 'held' ${staffId ? 'AND s.closed_by = ?' : ''} ORDER BY s.closed_at`).all(...(staffId ? [staffId] : []))
    .map((x) => ({ ...x, amount: x.cash_amount + x.tip_cash, header: ctx.posSession(x.id).header }));
  ctx.cashHeldBy = (staffId) => heldRows(staffId).reduce((n, x) => n + x.amount, 0);
  r.get('/api/payments/my-cash', 'staff', ({ me }) => { const rows = heldRows(me.id); return { amount: rows.reduce((n, x) => n + x.amount, 0), bills: rows }; });

  // Thu ngân nhận tiền phục vụ giao (ngay sau mỗi bill). Đếm lệch → ghi tên người giữ, báo chủ quán
  r.post('/api/payments/handover', 'staff', ({ me, body }) => {
    needCashier(me);
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => v.int(x, { min: 1, name: 'Bill' })) : [];
    if (!ids.length) fail(400, 'Chọn bill');
    const rows = heldRows().filter((x) => ids.includes(x.id));
    if (rows.length !== ids.length) fail(400, 'Có bill đã nhận rồi hoặc không phải tiền mặt');
    const staffIds = [...new Set(rows.map((x) => x.closed_by))];
    if (staffIds.length !== 1) fail(400, 'Mỗi lần nhận tiền của 1 người');
    const expected = rows.reduce((n, x) => n + x.amount, 0);
    const counted = body.counted === undefined || body.counted === '' ? expected : v.int(Number(String(body.counted).replace(/[.,\s]/g, '')), { min: 0, max: 1_000_000_000, name: 'Số tiền đếm được' });
    const note = v.text(body.note, { name: 'Ghi chú', max: 120 });
    const date = ctx.clock().businessDate(ctx.now());
    if (dayClosed(date)) fail(400, 'Ngày này đã chốt');
    const id = tx(db, () => {
      const hid = Number(db.prepare('INSERT INTO cash_handovers (date, staff_id, session_ids, expected, counted, diff, note, received_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(date, staffIds[0], JSON.stringify(ids), expected, counted, counted - expected, note, me.id, ctx.now()).lastInsertRowid);
      const up = db.prepare("UPDATE table_sessions SET cash_status = 'received', cash_received_by = ?, cash_received_at = ?, handover_id = ? WHERE id = ?");
      for (const x of rows) up.run(me.id, ctx.now(), hid, x.id);
      return hid;
    });
    if (counted !== expected) {
      ctx.notify(bosses().filter((x) => x !== me.id), { title: `Nhận tiền ${counted < expected ? 'THIẾU' : 'DƯ'} ${vnd(Math.abs(counted - expected))}: ${rows[0].staff_name}`, body: `Phải giao ${vnd(expected)} (${rows.length} bill ${rows.map((x) => x.bill_no).join(', ')}), đếm được ${vnd(counted)}. Thu ngân ${me.name}${note ? `: ${note}` : ''}.`, link: '/thu-ngan', urgent: true });
    }
    ctx.audit(me, 'pay.handover', { id, staff: staffIds[0], expected, counted });
    ctx.broadcast('pos');
    return { ok: true, expected, counted, diff: counted - expected };
  });

  // Két: tiền đầu ngày (tiền lẻ để thối) và tiền đếm cuối ngày
  r.post('/api/payments/drawer', 'staff', ({ me, body }) => {
    needCashier(me);
    const date = body.date || ctx.clock().businessDate(ctx.now());
    if (dayClosed(date)) fail(400, 'Ngày này đã chốt');
    const amt = (x, name) => v.int(Number(String(x).replace(/[.,\s]/g, '')), { min: 0, max: 1_000_000_000, name });
    db.prepare('INSERT OR IGNORE INTO day_cash (date) VALUES (?)').run(date);
    if (body.opening !== undefined) db.prepare('UPDATE day_cash SET opening = ?, opening_by = ?, opening_at = ? WHERE date = ?').run(amt(body.opening, 'Tiền đầu ngày'), me.id, ctx.now(), date);
    // Đếm két theo mệnh giá (ưu tiên) hoặc 1 số tổng
    let counted = body.counted;
    if (body.denoms) { const c = ctx.countDenoms(body.denoms); counted = c.total; db.prepare('UPDATE day_cash SET denoms = ? WHERE date = ?').run(JSON.stringify(c.denoms), date); }
    if (counted !== undefined) db.prepare('UPDATE day_cash SET counted = ?, counted_by = ?, counted_at = ?, note = ? WHERE date = ?').run(amt(counted, 'Tiền đếm trong két'), me.id, ctx.now(), v.text(body.note, { name: 'Ghi chú', max: 120 }), date);
    // Để lại két làm tiền lẻ ngày mai; phần còn lại bỏ phong bì đi nộp
    if (body.keep_float !== undefined) db.prepare('UPDATE day_cash SET keep_float = ? WHERE date = ?').run(amt(body.keep_float, 'Tiền để lại két'), date);
    ctx.audit(me, 'pay.drawer', { date, opening: body.opening, counted: body.counted });
    ctx.broadcast('pos');
    return { ok: true };
  });

  r.post('/api/payments/bank-balance', 'staff', ({ me, body }) => {
    needCashier(me);
    const date = body.date || ctx.clock().businessDate(ctx.now());
    if (dayClosed(date) && rank(me.role) < rank('owner')) fail(400, 'Ngày này đã chốt');
    const amt = (x, name) => (x === undefined ? undefined : x === null || x === '' ? null : v.int(Number(String(x).replace(/[.,\s]/g, '')), { min: 0, max: 100_000_000_000, name }));
    db.prepare('INSERT OR IGNORE INTO bank_day (date) VALUES (?)').run(date);
    const f = { opening: amt(body.opening, 'Số dư đầu ngày'), closing: amt(body.closing, 'Số dư cuối ngày'), other_in: amt(body.other_in, 'Thu khác'), other_out: amt(body.other_out, 'Chi khác') };
    for (const [k, x] of Object.entries(f)) if (x !== undefined) db.prepare(`UPDATE bank_day SET ${k} = ? WHERE date = ?`).run(k.startsWith('other') ? x || 0 : x, date);
    if (body.note !== undefined) db.prepare('UPDATE bank_day SET note = ? WHERE date = ?').run(v.text(body.note, { name: 'Ghi chú', max: 200 }), date);
    db.prepare('UPDATE bank_day SET by_staff = ?, at = ? WHERE date = ?').run(me.id, ctx.now(), date);
    const b = day(date).bank;
    ctx.audit(me, 'pay.bank_balance', { date, ...f, diff: b.diff });
    if (b.diff && Math.abs(b.diff) >= 10000) ctx.notify(bosses().filter((x) => x !== me.id), { title: `Số dư tài khoản ${date.slice(8)}/${date.slice(5, 7)} lệch ${vnd(b.diff)}`, body: `Phải có ${vnd(b.expected)} (đầu ngày ${vnd(b.opening)} + CK vào ${vnd(b.ck_in)} − chi CK ${vnd(b.ck_out)} ± khác), thật ${vnd(b.closing)}. ${me.name} ghi.`, link: '/thu-ngan', urgent: true });
    ctx.broadcast('pos');
    return { ok: true, bank: b };
  });

  r.post('/api/pos/sessions/:id/overpay', 'manager', ({ me, params, body }) => {
    const s = db.prepare('SELECT * FROM table_sessions WHERE id = ?').get(params.id);
    if (!s || s.overpay_status !== 'pending') fail(400, 'Bill này không có khoản CK dư chờ xử lý');
    if (dayClosed(s.closed_date)) fail(400, 'Ngày này đã chốt');
    const action = v.oneOf(body.action, ['tip', 'refunded'], { name: 'Cách xử lý' });
    const note = v.text(body.note, { name: 'Ghi chú', max: 120 });
    db.prepare('UPDATE table_sessions SET overpay_status = ?, tip_transfer = tip_transfer + ? WHERE id = ?').run(action, action === 'tip' ? s.overpay : 0, s.id);
    ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id).filter((x) => x !== me.id), { title: `CK dư ${vnd(s.overpay)} bill ${s.bill_no}: ${action === 'tip' ? 'tính tip' : 'đã hoàn lại khách'}`, body: `${me.name}${note ? `: ${note}` : ''}`, link: '/thu-ngan' });
    ctx.audit(me, 'pay.overpay', { id: s.id, action, amount: s.overpay });
    ctx.broadcast('pos');
    return { ok: true };
  });

  // ---------- Đổi cách thanh toán (bấm nhầm tiền mặt ↔ chuyển khoản) ----------
  db.exec(`CREATE TABLE IF NOT EXISTS payment_changes (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, date TEXT NOT NULL, from_method TEXT NOT NULL, to_method TEXT NOT NULL,
    from_cash INTEGER NOT NULL, to_cash INTEGER NOT NULL, reason TEXT NOT NULL, changed_by INTEGER, created_at INTEGER NOT NULL
  )`);
  const METHOD_VI = { cash: 'Tiền mặt', transfer: 'CK', mixed: 'TM + CK' };
  r.post('/api/pos/sessions/:id/change-method', 'staff', ({ me, params, body }) => {
    needCashier(me);
    const s = ctx.posSession(params.id);
    if (s.status !== 'closed') fail(400, 'Bill chưa thanh toán');
    if (dayClosed(s.closed_date)) fail(400, 'Ngày này đã chốt: nhờ chủ quán mở lại ngày ở Duyệt sổ');
    const method = v.oneOf(body.method, ['cash', 'transfer', 'mixed'], { name: 'Cách trả' });
    const reason = v.text(body.reason, { name: 'Lý do', required: true, max: 120 });
    const total = s.paid_total;
    const cash = method === 'cash' ? total : method === 'transfer' ? 0 : v.int(Number(String(body.cash_amount ?? '').replace(/[.,\s]/g, '')), { min: 1, max: total - 1, name: 'Phần tiền mặt' });
    const transfer = total - cash;
    if (cash === s.cash_amount && transfer === s.transfer_amount) fail(400, 'Bill đã đúng cách trả này');
    const got = bankReceived(s.id);
    // Ngân hàng đã báo nhận tiền CK → không thể nói khách trả tiền mặt phần đó
    if (got > 0 && transfer < Math.min(got, total)) fail(400, `Ngân hàng đã báo nhận ${vnd(got)} chuyển khoản cho bill này: không đổi sang tiền mặt được`);
    // Tiền mặt đã giao thu ngân qua lần nhận tiền: chỉ quản lý đổi (sổ giao tiền đã ghi)
    if (s.handover_id && cash !== s.cash_amount && rank(me.role) < rank('manager')) fail(403, 'Thu ngân đã xác nhận nhận tiền mặt bill này: nhờ quản lý đổi');
    let cashStatus = '';
    if (cash > 0) cashStatus = s.cash_status === 'received' && s.cash_amount >= cash ? 'received' : 'held';
    const tipCash = cash > 0 ? s.tip_cash : 0;
    const reconcile = transfer > 0 ? (got >= transfer ? 'matched' : 'pending') : '';
    db.prepare(`UPDATE table_sessions SET pay_method = ?, cash_amount = ?, transfer_amount = ?, cash_given = ?, tip_cash = ?, tip_transfer = ?, cash_status = ?,
      reconcile_status = ?, pending_alerted = 0, reconciled_at = NULL, reconciled_by = NULL WHERE id = ?`)
      .run(method, cash, transfer, cash > 0 ? s.cash_given : 0, tipCash, 0, cashStatus, reconcile, s.id);
    if (transfer > 0) setExcess(s.id, Math.max(0, got - transfer), total);
    // CK về lúc bill còn ghi tiền mặt (đang "cần xem") → nay khớp
    if (transfer > 0) db.prepare("UPDATE bank_txns SET status = 'matched', note = 'Bill đổi sang CK' WHERE session_id = ? AND status = 'review'").run(s.id);
    db.prepare('INSERT INTO payment_changes (session_id, date, from_method, to_method, from_cash, to_cash, reason, changed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.closed_date, s.pay_method, method, s.cash_amount, cash, reason, me.id, ctx.now());
    ctx.notify(bosses().filter((x) => x !== me.id), {
      title: `Đổi cách trả bill ${s.bill_no}: ${METHOD_VI[s.pay_method]} → ${METHOD_VI[method]}`,
      body: `${vnd(total)} · bàn ${s.header} · ${reason} · ${me.name} đổi.${cashStatus === 'held' ? ' Tiền mặt chờ thu ngân xác nhận.' : ''}${reconcile === 'pending' ? ' CK chờ tiền về.' : ''}`,
      link: `/goi-mon?s=${s.id}`,
    });
    ctx.audit(me, 'pay.change_method', { id: s.id, from: s.pay_method, to: method, cash, reason });
    ctx.broadcast('pos');
    return { ok: true, cash_status: cashStatus, reconcile_status: reconcile };
  });

  // Hoàn tiền mặt cho bill đã đóng (khách báo thiếu món / món lỗi). Quản lý duyệt.
  r.post('/api/pos/sessions/:id/refund', 'staff', ({ me, params, body, net }) => {
    const s = ctx.posSession(params.id);
    if (s.status !== 'closed') fail(400, 'Bill chưa thanh toán: huỷ món trực tiếp, không cần hoàn tiền');
    const reason = v.text(body.reason, { name: 'Lý do hoàn tiền', required: true, max: 120 });
    let approver = me;
    if (rank(me.role) < rank('manager')) {
      const key = `refund:${net?.ip || me.id}`;
      ctx.loginGuard.check(key);
      const pin = String(body.approver_pin ?? '');
      const a = pin ? db.prepare('SELECT * FROM staff WHERE pin_lookup = ? AND active = 1').get(pinLookup(db, pin)) : null;
      if (!a || rank(a.role) < rank('manager')) { if (pin) ctx.loginGuard.failed(key); fail(403, 'Cần quản lý nhập PIN để duyệt hoàn tiền'); }
      ctx.loginGuard.ok(key);
      approver = a;
    }
    if (!Array.isArray(body.items) || !body.items.length) fail(400, 'Chọn món cần hoàn');
    const lines = [];
    for (const x of body.items) {
      const it = s.items.find((i) => i.id === Number(x.id) && i.status !== 'cancelled');
      if (!it) fail(400, 'Món không thuộc bill này');
      const left = it.qty - (it.refunded_qty || 0);
      const q = v.int(x.qty ?? left, { min: 1, max: left, name: `Số lượng hoàn của ${it.name}` });
      // Tiền hoàn = số khách thật sự đã trả cho phần đó (đã trừ khuyến mãi món)
      const amount = Math.round((it.net * q) / it.qty / 1000) * 1000;
      lines.push({ item: it, qty: q, amount });
    }
    let amount = lines.reduce((n, l) => n + l.amount, 0);
    // Khuyến mãi bill chia đều theo tỉ lệ
    if (s.bill_promos?.length && s.subtotal - s.item_discount > 0) amount = Math.round((amount * (1 - s.bill_promos[0].amount / (s.subtotal - s.item_discount))) / 1000) * 1000;
    const already = refundsOf(s.id).reduce((n, x) => n + x.amount, 0);
    if (amount + already > s.paid_total) fail(400, 'Số tiền hoàn vượt quá số khách đã trả');
    const id = tx(db, () => {
      for (const l of lines) {
        db.prepare('UPDATE order_items SET refunded_qty = refunded_qty + ? WHERE id = ?').run(l.qty, l.item.id);
        // Món bếp chưa ra: in phiếu HUỶ để bếp ngừng làm
        if (l.item.status === 'sent') ctx.posMakeTickets(me, s, [{ ...l.item, qty: l.qty, options: JSON.stringify(l.item.options), note: `Khách đã về, hoàn tiền: ${reason}` }], 'cancel', { priority: 0 });
      }
      return Number(db.prepare('INSERT INTO refunds (session_id, amount, reason, lines, date, created_by, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.id, amount, reason, JSON.stringify(lines.map((l) => ({ id: l.item.id, name: l.item.name, qty: l.qty, amount: l.amount, kitchen: l.item.status === 'done' ? 'made' : 'cancelled' }))),
          ctx.clock().businessDate(ctx.now()), me.id, approver.id, ctx.now()).lastInsertRowid);
    });
    const st = billStation();
    if (st) {
      ctx.printDoc(st, `Hoàn tiền bill ${s.bill_no}`, refundBytes({ bill_no: s.bill_no, header: s.header, time: ctx.clock().fmt(ctx.now()), lines: lines.map((l) => ({ name: l.item.name, qty: l.qty, amount: l.amount })), amount, reason, by: me.name, approver: approver.name }, { mode: ctx.printMode() }));
    }
    const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id).filter((x) => x !== me.id);
    ctx.notify(owners, {
      title: `Hoàn tiền ${amount.toLocaleString('vi-VN')}đ · bàn ${s.header}`,
      body: `${lines.map((l) => `${l.qty} × ${l.item.name}`).join(', ')}. Lý do: ${reason}. ${me.name} hoàn, ${approver.name} duyệt.${lines.some((l) => l.item.status === 'done') ? ' Có món bếp đã làm (hao hụt).' : ''}`,
      link: `/goi-mon?s=${s.id}`, urgent: true,
    });
    ctx.audit(me, 'pay.refund', { id: s.id, refund_id: id, amount, reason, approver: approver.id });
    ctx.broadcast('pos');
    return { ok: true, id, amount };
  });

  // ---------- Thu ngân: doanh thu ngày, tiền mặt, đối soát chuyển khoản, bất thường ----------
  // Số dư đầu ngày gối đầu (chủ quán 26/10): chỉ nhập 1 lần; ngày sau tự lấy số dư cuối ngày hôm trước
  // (số thật nếu đã ghi, chưa ghi thì số "phải có" của hôm trước). Ngược tối đa 40 ngày.
  function carriedOpening(date, depth = 0) {
    const prev = addD(date, -1);
    if (depth > 40 || !db.prepare('SELECT 1 FROM bank_day WHERE date <= ? AND (opening IS NOT NULL OR closing IS NOT NULL) LIMIT 1').get(prev)) return null;
    const row = db.prepare('SELECT opening, closing FROM bank_day WHERE date = ?').get(prev);
    if (row?.closing != null) return row.closing;
    return day(prev, depth + 1).bank.expected;
  }
  function day(date, depth = 0) {
    const bills = db.prepare(`SELECT s.id, s.bill_no, s.opened_at, s.closed_at, s.closed_by, s.pay_method, s.paid_total, s.cash_amount, s.transfer_amount, s.reconcile_status, s.reconcile_note,
        s.cash_status, s.handover_id, s.tip_cash, s.tip_transfer, s.overpay, s.overpay_status, c.name AS closed_by_name, json_extract(s.bill_snapshot, '$.discount') AS discount
      FROM table_sessions s LEFT JOIN staff c ON c.id = s.closed_by WHERE s.status = 'closed' AND s.closed_date = ? ORDER BY s.closed_at`).all(date)
      .map((b) => ({ ...b, closed_by_name: b.closed_by ? b.closed_by_name : 'Tự động (ngân hàng)', header: ctx.posSession(b.id).header, transfer_note: noteOf(b.bill_no), bank_received: bankReceived(b.id) }));
    const refunds = db.prepare('SELECT r.*, s.bill_no, a.name AS approver_name, c.name AS by_name FROM refunds r JOIN table_sessions s ON s.id = r.session_id LEFT JOIN staff a ON a.id = r.approved_by LEFT JOIN staff c ON c.id = r.created_by WHERE r.date = ? ORDER BY r.id').all(date)
      .map((x) => ({ ...x, lines: JSON.parse(x.lines) }));
    const handovers = db.prepare('SELECT h.*, s.name AS staff_name, r.name AS received_by_name FROM cash_handovers h LEFT JOIN staff s ON s.id = h.staff_id LEFT JOIN staff r ON r.id = h.received_by WHERE h.date = ? ORDER BY h.id').all(date);
    const drawer = db.prepare('SELECT d.*, a.name AS opening_by_name, b.name AS counted_by_name FROM day_cash d LEFT JOIN staff a ON a.id = d.opening_by LEFT JOIN staff b ON b.id = d.counted_by WHERE d.date = ?').get(date) || null;
    const txns = db.prepare('SELECT t.*, s.bill_no FROM bank_txns t LEFT JOIN table_sessions s ON s.id = t.session_id WHERE t.date = ? ORDER BY t.id').all(date);
    const held = heldRows().filter((x) => bills.some((b) => b.id === x.id));
    const sum = (arr, k) => arr.reduce((n, x) => n + (x[k] || 0), 0);
    const tr = bills.filter((b) => b.transfer_amount > 0);
    const refundCash = sum(refunds, 'amount');
    const handedIn = sum(handovers, 'counted');
    // Thu ngân thu thẳng (không qua giao tiền) = tiền mặt + tip của bill đã nhận mà không có lần giao
    const direct = bills.filter((b) => b.cash_status === 'received' && !b.handover_id).reduce((n, b) => n + b.cash_amount + b.tip_cash, 0);
    // Tiền mặt chi ra từ két: trả NCC, tạm ứng đi chợ (trừ tiền thừa hoàn ứng)
    const cashOut = ctx.cashOut ? ctx.cashOut(date) : { total: 0 };
    // Tip bỏ thùng tip: tip TM thu ngân đã nhận + tip CK (lấy tiền mặt trong két bỏ vào bằng đúng số tip) → không nằm trong két
    const tipBoxCash = bills.filter((b) => b.cash_status === 'received').reduce((n, b) => n + b.tip_cash, 0);
    const tipBoxCk = sum(bills, 'tip_transfer');
    const tipToBox = tipBoxCash + tipBoxCk;
    const expectedDrawer = drawer?.opening != null ? drawer.opening + direct + handedIn - refundCash - cashOut.total - tipToBox : null;
    // Số dư tài khoản: tiền CK vào (bill + tip + CK dư) − chi CK (trả NCC) ± khoản khác
    const bk = db.prepare('SELECT b.*, s.name AS by_name FROM bank_day b LEFT JOIN staff s ON s.id = b.by_staff WHERE b.date = ?').get(date) || null;
    const ckIn = sum(tr.filter((b) => b.reconcile_status !== 'missing'), 'transfer_amount') + sum(bills.filter((b) => b.reconcile_status !== 'missing'), 'tip_transfer')
      + sum(bills.filter((b) => b.overpay && b.overpay_status !== 'tip'), 'overpay');
    const ckOutNcc = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM supplier_payments WHERE date = ? AND method = 'transfer' AND status = 'done'").get(date)?.n || 0;
    const ckOutBill = db.prepare("SELECT COALESCE(SUM(paid_now), 0) AS n FROM purchase_bills WHERE date = ? AND paid_method = 'transfer' AND status != 'void'").get(date)?.n || 0;
    const ckOutExp = ctx.expenseBankOut ? ctx.expenseBankOut(date) : 0; // phiếu chi chuyển khoản
    const ckOut = ckOutNcc + ckOutBill + ckOutExp + sum(bills.filter((b) => b.overpay_status === 'refunded'), 'overpay');
    const carried = bk?.opening != null ? null : carriedOpening(date, depth);
    const opening = bk?.opening ?? carried;
    const bankExpected = opening != null ? opening + ckIn - ckOut + (bk?.other_in || 0) - (bk?.other_out || 0) : null;
    const bank = {
      opening, carried: bk?.opening == null && carried != null, closing: bk?.closing ?? null, other_in: bk?.other_in || 0, other_out: bk?.other_out || 0, note: bk?.note || '', by_name: bk?.by_name || '', at: bk?.at || null,
      ck_in: ckIn, ck_out: ckOut, ck_out_ncc: ckOutNcc + ckOutBill, expected: bankExpected,
      diff: bk?.closing != null && bankExpected != null ? bk.closing - bankExpected : null,
      suggested_opening: db.prepare('SELECT closing FROM bank_day WHERE date < ? AND closing IS NOT NULL ORDER BY date DESC LIMIT 1').get(date)?.closing ?? null,
    };
    const confirmedOf = (b) => (b.cash_amount + b.tip_cash === 0 || b.cash_status === 'received') && (b.transfer_amount === 0 || b.reconcile_status === 'confirmed');
    const summary = {
      bills: bills.length, gross: sum(bills, 'paid_total'), discount: sum(bills, 'discount'),
      refund_cash: refundCash, net: sum(bills, 'paid_total') - refundCash,
      confirmed: sum(bills.filter(confirmedOf), 'paid_total'), unconfirmed: sum(bills.filter((b) => !confirmedOf(b)), 'paid_total'),
      tip_cash: sum(bills, 'tip_cash'), tip_transfer: sum(bills, 'tip_transfer'), tip_to_box: tipToBox, tip_box_cash: tipBoxCash, tip_box_ck: tipBoxCk,
      cash_in: sum(bills, 'cash_amount'), cash_held: sum(held, 'amount'), cash_direct: direct, handed_in: handedIn, handover_diff: sum(handovers, 'diff'),
      cash_out: cashOut.total, cash_out_detail: cashOut,
      opening: drawer?.opening ?? null, drawer_expected: expectedDrawer, drawer_counted: drawer?.counted ?? null,
      drawer_diff: drawer?.counted != null && expectedDrawer != null ? drawer.counted - expectedDrawer : null,
      transfer_in: sum(tr, 'transfer_amount'),
      transfer_confirmed: sum(tr.filter((b) => b.reconcile_status === 'confirmed'), 'transfer_amount'),
      transfer_matched: sum(tr.filter((b) => b.reconcile_status === 'matched'), 'transfer_amount'),
      transfer_pending: sum(tr.filter((b) => b.reconcile_status === 'pending'), 'transfer_amount'),
      transfer_missing: sum(tr.filter((b) => b.reconcile_status === 'missing'), 'transfer_amount'),
      bank_in: sum(txns.filter((t) => t.direction === 'in' && !['ignored', 'deposit'].includes(t.status)), 'amount'),
      unmatched: txns.filter((t) => t.direction === 'in' && ['unmatched', 'review'].includes(t.status)).length,
      overpay_pending: bills.filter((b) => b.overpay_status === 'pending').length,
      overpay_refunded: sum(bills.filter((b) => b.overpay_status === 'refunded'), 'overpay'),
    };
    const closing = db.prepare('SELECT d.*, s.name AS by_name FROM day_closings d LEFT JOIN staff s ON s.id = d.confirmed_by WHERE d.date = ?').get(date);
    return {
      date, bills, refunds, handovers, drawer, held, txns: txns.map(({ raw, ...t }) => t), summary, bank,
      anomalies: anomalies(date, { bills, refunds, handovers, summary, txns, bank }),
      open_tables: db.prepare("SELECT COUNT(*) AS n FROM table_sessions WHERE status IN ('open','paying')").get().n,
      sepay: ctx.setting('sepay_enabled') === '1',
      photos: ctx.cashPhotos ? ctx.cashPhotos(date) : [],
      // Gợi ý két đầu ngày = số thu ngân hôm trước để lại
      suggested_opening: db.prepare('SELECT keep_float FROM day_cash WHERE date < ? AND keep_float IS NOT NULL ORDER BY date DESC LIMIT 1').get(date)?.keep_float ?? null,
      closing: closing ? { ...closing, totals: JSON.parse(closing.totals) } : null,
    };
  }

  // Báo cáo bất thường trong ngày (hiện ở Thu ngân, gửi chủ quán khi chốt)
  function anomalies(date, { bills, refunds, handovers, summary, txns, bank = {} }) {
    const clock = ctx.clock();
    const out = [];
    const add = (level, text) => out.push({ level, text });
    const from = clock.toEpoch(date, clock.cutoffHour * 60);
    const to = from + 86_400_000;
    const late = db.prepare(`SELECT i.qty, c.name AS by_name FROM order_items i LEFT JOIN staff c ON c.id = i.cancelled_by
      WHERE i.status = 'cancelled' AND i.sent_at IS NOT NULL AND i.cancelled_at >= ? AND i.cancelled_at < ? AND i.cancelled_at - i.sent_at > 120000
        AND (SELECT status FROM table_sessions WHERE id = i.session_id) != 'cancelled'`).all(from, to);
    if (late.length) {
      const by = {};
      for (const x of late) by[x.by_name || '?'] = (by[x.by_name || '?'] || 0) + x.qty;
      add('warn', `Huỷ món đã gửi bếp quá 2′: ${late.length} lần (${Object.entries(by).map(([k, n]) => `${k} ${n} phần`).join(', ')})`);
    }
    const cancelled = db.prepare(`SELECT s.note, c.name AS by_name, (SELECT COALESCE(SUM(unit_price * qty), 0) FROM order_items i WHERE i.session_id = s.id AND i.sent_at IS NOT NULL) AS value
      FROM table_sessions s LEFT JOIN staff c ON c.id = s.closed_by WHERE s.status = 'cancelled' AND s.closed_at >= ? AND s.closed_at < ? AND EXISTS (SELECT 1 FROM order_items i WHERE i.session_id = s.id AND i.sent_at IS NOT NULL)`).all(from, to);
    if (cancelled.length) add(cancelled.some((x) => /bỏ trốn|không trả|chưa trả/i.test(x.note)) ? 'bad' : 'warn', `Huỷ cả bàn đã gửi bếp: ${cancelled.length} bàn, ${vnd(cancelled.reduce((n, x) => n + x.value, 0))} món đã làm (${cancelled.map((x) => `${x.note} · ${x.by_name} ${vnd(x.value)}`).join('; ')})`);
    const rep = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pos.ticket.reprint' AND at >= ? AND at < ?").get(from, to).n;
    if (rep) add('warn', `In lại phiếu bếp: ${rep} lần (kiểm tra bếp không làm trùng món)`);
    if (refunds.length) add('warn', `Hoàn tiền mặt: ${refunds.length} lần, ${vnd(summary.refund_cash)} (${refunds.map((x) => `bill ${x.bill_no}: ${x.by_name} hoàn, ${x.approver_name} duyệt`).join('; ')})`);
    for (const h of handovers.filter((x) => x.diff)) add('bad', `Nhận tiền ${h.diff < 0 ? 'thiếu' : 'dư'} ${vnd(Math.abs(h.diff))}: ${h.staff_name} (thu ngân ${h.received_by_name} nhận)`);
    if (summary.drawer_diff) add('bad', `Két ${summary.drawer_diff < 0 ? 'thiếu' : 'dư'} ${vnd(Math.abs(summary.drawer_diff))} so với số phải có ${vnd(summary.drawer_expected)}`);
    const um = txns.filter((t) => t.direction === 'in' && ['unmatched', 'review'].includes(t.status));
    if (um.length) add('bad', `Tiền CK vào chưa khớp bill: ${um.length} khoản, ${vnd(um.reduce((n, t) => n + t.amount, 0))}`);
    for (const b of bills.filter((x) => x.reconcile_status === 'missing')) add('bad', `Bill ${b.bill_no} CK chưa thấy tiền ${vnd(b.transfer_amount)} (đóng bởi ${b.closed_by_name})`);
    for (const b of bills.filter((x) => x.reconcile_status === 'missing' && x.tip_transfer)) add('bad', `Bill ${b.bill_no} có tip CK ${vnd(b.tip_transfer)} đã lấy tiền mặt bỏ thùng tip, nhưng CK chưa thấy về`);
    if (bank.diff) add(Math.abs(bank.diff) >= 10000 ? 'bad' : 'warn', `Số dư tài khoản lệch ${bank.diff > 0 ? '+' : '−'}${vnd(Math.abs(bank.diff))}: phải có ${vnd(bank.expected)}, thật ${vnd(bank.closing)}${Math.abs(bank.diff) < 10000 ? ' (lệch nhỏ: phí / lãi ngân hàng? ghi vào "khác")' : ''}`);
    if (bills.some((b) => b.transfer_amount) && bank.closing == null) add('warn', 'Chưa đối soát số dư tài khoản ngân hàng cuối ngày');
    for (const b of bills.filter((x) => x.tip_cash + x.tip_transfer > Math.max(200000, x.paid_total * 0.3))) add('warn', `Tip lớn bất thường: bill ${b.bill_no} tip ${vnd(b.tip_cash + b.tip_transfer)} / bill ${vnd(b.paid_total)}`);
    if (summary.cash_held) add('bad', `Bill tiền mặt chưa được thu ngân xác nhận: ${vnd(summary.cash_held)}`);
    const long = db.prepare("SELECT COUNT(*) AS n FROM table_sessions WHERE status IN ('open','paying') AND opened_at < ?").get(ctx.now() - 3 * 3_600_000).n;
    if (long) add('warn', `Bàn mở quá 3 giờ chưa tính tiền: ${long} bàn`);
    for (const b of bills.filter((x) => x.overpay)) add(b.overpay_status === 'pending' ? 'bad' : 'warn', `Bill ${b.bill_no} khách CK dư ${vnd(b.overpay)}: ${b.overpay_status === 'pending' ? 'CHƯA XỬ LÝ' : b.overpay_status === 'tip' ? 'quản lý tính tip' : 'đã hoàn lại khách (phải có giao dịch chuyển trả)'}`);
    const ch = db.prepare('SELECT c.*, t.bill_no, s.name AS by_name FROM payment_changes c JOIN table_sessions t ON t.id = c.session_id LEFT JOIN staff s ON s.id = c.changed_by WHERE c.date = ? ORDER BY c.id').all(date);
    if (ch.length) add('warn', `Đổi cách thanh toán: ${ch.length} lần (${ch.map((c) => `bill ${c.bill_no} ${{ cash: 'TM', transfer: 'CK', mixed: 'TM+CK' }[c.from_method]}→${{ cash: 'TM', transfer: 'CK', mixed: 'TM+CK' }[c.to_method]} ${c.by_name}: ${c.reason}`).join('; ')})`);
    return out;
  }
  ctx.payDay = day;

  // Chạy mỗi 5 phút: bill "chờ tiền về" quá 30′ (khi đã nối SePay) → báo quản lý
  ctx.payTick = () => {
    if (ctx.setting('sepay_enabled') !== '1') return 0;
    const rows = db.prepare("SELECT id, bill_no, transfer_amount, closed_by FROM table_sessions WHERE status = 'closed' AND reconcile_status = 'pending' AND pending_alerted = 0 AND closed_at < ?").all(ctx.now() - 30 * 60_000);
    for (const x of rows) {
      ctx.notify([...new Set([...bosses(), ...cashiers()])], { title: `Bill ${x.bill_no}: 30′ chưa thấy tiền CK ${vnd(x.transfer_amount)}`, body: `Phục vụ ${staffName(x.closed_by)} bấm "khách đã CK" nhưng ngân hàng chưa báo tiền về. Kiểm tra với khách / sao kê.`, link: '/thu-ngan', urgent: true });
      db.prepare('UPDATE table_sessions SET pending_alerted = 1 WHERE id = ?').run(x.id);
    }
    return rows.length;
  };

  r.get('/api/payments', 'staff', ({ me, query }) => {
    needCashier(me);
    const date = query.get('date') || ctx.clock().businessDate(ctx.now());
    return day(date);
  });

  r.post('/api/payments/reconcile', 'staff', ({ me, body }) => {
    needCashier(me);
    const status = v.oneOf(body.status, ['confirmed', 'missing', 'pending'], { name: 'Trạng thái' });
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => v.int(x, { min: 1, name: 'Bill' })) : [];
    if (!ids.length) fail(400, 'Chọn bill');
    const note = v.text(body.note, { name: 'Ghi chú', max: 120 });
    const rows = ids.map((id) => db.prepare("SELECT s.*, c.name AS closed_by_name FROM table_sessions s LEFT JOIN staff c ON c.id = s.closed_by WHERE s.id = ? AND s.status = 'closed' AND s.transfer_amount > 0").get(id)).filter(Boolean);
    if (rows.some((x) => db.prepare('SELECT 1 FROM day_closings WHERE date = ?').get(x.closed_date))) fail(400, 'Ngày này đã chốt doanh thu');
    // Bỏ đánh dấu (pending): bill đã có tiền ngân hàng báo về thì trả về matched
    const up = db.prepare('UPDATE table_sessions SET reconcile_status = ?, reconciled_at = ?, reconciled_by = ?, reconcile_note = ? WHERE id = ?');
    tx(db, () => rows.forEach((x) => up.run(status === 'pending' && bankReceived(x.id) >= x.transfer_amount ? 'matched' : status, ctx.now(), me.id, note, x.id)));
    if (status === 'missing') {
      const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id).filter((x) => x !== me.id);
      for (const x of rows) {
        ctx.notify(owners, { title: `Chưa thấy tiền CK bill ${x.bill_no}`, body: `${x.transfer_amount.toLocaleString('vi-VN')}đ, nội dung ${noteOf(x.bill_no)}. Người đóng bill: ${x.closed_by_name || '?'}. ${me.name} đối soát${note ? `: ${note}` : ''}.`, link: '/thu-ngan', urgent: true });
      }
    }
    ctx.audit(me, 'pay.reconcile', { ids: rows.map((x) => x.id), status });
    ctx.broadcast('pos');
    return { n: rows.length };
  });

  r.post('/api/payments/close-day', 'staff', ({ me, body }) => {
    needCashier(me);
    const date = body.date || ctx.clock().businessDate(ctx.now());
    const d = day(date);
    if (d.closing) fail(400, 'Ngày này đã chốt');
    if (!d.bills.length) fail(400, 'Chưa có bill nào');
    const waitCk = d.bills.filter((b) => ['pending', 'matched'].includes(b.reconcile_status)).length;
    if (waitCk) fail(400, `Còn ${waitCk} bill CK chưa xác nhận`);
    if (d.summary.cash_held) fail(400, `Còn ${vnd(d.summary.cash_held)} tiền mặt chờ thu ngân xác nhận`);
    if (d.summary.unmatched) fail(400, `Còn ${d.summary.unmatched} khoản tiền CK chưa khớp bill: ghép bill hoặc đánh dấu bỏ qua`);
    if (d.summary.overpay_pending) fail(400, `Còn ${d.summary.overpay_pending} bill khách CK dư bất thường chưa xử lý`);
    if (d.summary.opening == null) fail(400, 'Chưa nhập tiền két đầu ngày');
    if (d.summary.drawer_counted == null) fail(400, 'Chưa nhập tiền đếm trong két cuối ngày');
    if (!ctx.cashPhotos(date).length) fail(400, 'Chưa chụp ảnh tiền đã đếm');
    if (d.drawer?.keep_float == null) fail(400, 'Chưa ghi số tiền để lại két cho ngày mai');
    if (d.drawer.keep_float > d.summary.drawer_counted) fail(400, 'Tiền để lại két lớn hơn tiền đếm được');
    db.prepare('INSERT INTO day_closings (date, totals, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?)').run(date, JSON.stringify(d.summary), me.id, ctx.now());
    ctx.tipBoxClose?.(date, d.summary, me);
    const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id).filter((x) => x !== me.id);
    const f = (n) => n.toLocaleString('vi-VN');
    ctx.notify(owners, {
      title: `Đã chốt doanh thu ${date.slice(8)}/${date.slice(5, 7)}: ${f(d.summary.net)}đ`,
      body: `${d.summary.bills} bill · Doanh thu ${f(d.summary.net)}đ (CK ${f(d.summary.transfer_confirmed)}đ, TM ${f(d.summary.cash_in)}đ, hoàn ${f(d.summary.refund_cash)}đ, KM đã giảm ${f(d.summary.discount)}đ) · Tip bỏ thùng ${f(d.summary.tip_to_box)}đ (TM ${f(d.summary.tip_box_cash)}, CK ${f(d.summary.tip_box_ck)})${d.bank.closing != null ? ` · Số dư TK ${f(d.bank.closing)}đ${d.bank.diff ? ` (LỆCH ${f(d.bank.diff)}đ)` : ' (khớp)'}` : ''} · Két đếm ${f(d.summary.drawer_counted)}đ${d.summary.drawer_diff ? ` (LỆCH ${f(d.summary.drawer_diff)}đ)` : ' (khớp)'}${d.summary.transfer_missing ? ` · CK CHƯA THẤY ${f(d.summary.transfer_missing)}đ` : ''}. Người chốt: ${me.name}.${d.anomalies.length ? `\nBất thường:\n- ${d.anomalies.map((a) => a.text).join('\n- ')}` : '\nKhông có bất thường.'}`,
      link: '/thu-ngan',
    });
    ctx.audit(me, 'pay.close_day', { date, ...d.summary });
    return { ok: true };
  });
}
