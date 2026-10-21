import { fail, v } from '../http.js';
import { tx, rank, pinLookup } from '../db.js';
import { billQR } from '../lib/vietqr.js';
import { billBytes, refundBytes } from '../lib/escpos.js';

// GĐ3D Thanh toán
// - Khách chuyển khoản: phục vụ bấm "Khách đã CK" → bill đóng ngay, bàn trống; bill ở trạng thái "chờ đối soát".
// - Cuối ngày thu ngân so tổng CK với sao kê ngân hàng → chọn tất cả → xác nhận doanh thu.
// - Khách trả rồi mới báo thiếu món: không sửa bill, tạo PHIẾU HOÀN TIỀN MẶT (quản lý duyệt bằng PIN), chủ quán nhận báo.
// Không VAT, không quẹt thẻ (chủ quán chốt 22/10).
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
  db.exec(`CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'cash', reason TEXT NOT NULL, lines TEXT NOT NULL DEFAULT '[]',
    date TEXT NOT NULL, created_by INTEGER, approved_by INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS day_closings (
    date TEXT PRIMARY KEY, totals TEXT NOT NULL, confirmed_by INTEGER, confirmed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_closed ON table_sessions (closed_date, status);`);

  const isCashier = (me) => rank(me.role) >= rank('shift_lead') || !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
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
    const qrAmount = paid ? s.transfer_amount : s.total;
    const qr = ctx.setting('bank_qr') && qrAmount > 0 && (!paid || s.transfer_amount > 0) ? billQR(ctx.setting('bank_qr'), { amount: qrAmount, content: noteOf(no) }) : '';
    const refunds = refundsOf(s.id);
    const clock = ctx.clock();
    return {
      id: s.id, status: s.status, paid, bill_no: no, header: s.header, tables: s.tables,
      shop: { name: ctx.setting('shop_name'), address: ctx.setting('shop_address'), phone: ctx.setting('shop_phone') },
      opened: clock.fmt(s.opened_at), printed: clock.fmt(ctx.now()),
      staff: s.opened_by_name || '', cashier: paid ? staffName(s.closed_by) : '',
      lines: live.map((i) => ({ id: i.id, name: i.name, qty: i.qty, unit_price: i.unit_price, total: i.total, net: i.net, status: i.status, refunded_qty: i.refunded_qty || 0,
        options: i.options.map((o) => o.name).join(', '), promos: i.promos || [] })),
      count: live.reduce((n, i) => n + i.qty, 0),
      subtotal: s.subtotal, item_discount: s.item_discount, bill_promos: s.bill_promos, discount: s.discount, total: s.total,
      unserved: live.filter((i) => i.status === 'sent').length, unsent: s.unsent,
      pay_method: s.pay_method, cash_amount: s.cash_amount, transfer_amount: s.transfer_amount, cash_given: s.cash_given, change: s.cash_given ? s.cash_given - s.cash_amount : 0,
      reconcile_status: s.reconcile_status, closed_at: s.closed_at,
      refunds, refunded: refunds.reduce((n, x) => n + x.amount, 0),
      qr, qr_amount: qrAmount, transfer_note: noteOf(no), bank_name: ctx.setting('bank_name') || 'Ngân hàng',
    };
  }
  ctx.billData = billData;
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
    const total = s.total;
    let cash = 0;
    let transfer = 0;
    let given = 0;
    if (method === 'transfer') transfer = total;
    else if (method === 'cash') {
      cash = total;
      given = body.cash_given === undefined || body.cash_given === '' ? 0 : v.int(Number(String(body.cash_given).replace(/[.,\s]/g, '')), { min: 0, max: 1_000_000_000, name: 'Tiền khách đưa' });
      if (given && given < total) fail(400, `Khách đưa ${given.toLocaleString('vi-VN')}đ chưa đủ ${total.toLocaleString('vi-VN')}đ`);
    } else {
      cash = v.int(Number(String(body.cash_amount ?? '').replace(/[.,\s]/g, '')), { min: 1, max: total - 1, name: 'Phần tiền mặt' });
      transfer = total - cash;
    }
    const snapshot = { lines: s.items.filter((i) => i.promos?.length).map((i) => [i.id, i.promos]), item_discount: s.item_discount, bill: s.bill_promos, discount: s.discount, subtotal: s.subtotal, total };
    tx(db, () => {
      billNo(s.id);
      db.prepare(`UPDATE table_sessions SET status = 'closed', closed_at = ?, closed_by = ?, closed_date = ?, pay_method = ?, paid_total = ?, cash_amount = ?, transfer_amount = ?, cash_given = ?,
        reconcile_status = ?, bill_snapshot = ? WHERE id = ?`)
        .run(ctx.now(), me.id, ctx.clock().businessDate(ctx.now()), method, total, cash, transfer, given, transfer > 0 ? 'pending' : '', JSON.stringify(snapshot), s.id);
    });
    const printed = body.print ? !!printBill(s.id) : false;
    ctx.audit(me, 'pay.close', { id: s.id, total, method, cash, transfer, unserved: unserved.length });
    ctx.broadcast('pos');
    return { ok: true, total, change: given ? given - cash : 0, printed };
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
      const amount = Math.round((it.net * q) / it.qty);
      lines.push({ item: it, qty: q, amount });
    }
    let amount = lines.reduce((n, l) => n + l.amount, 0);
    // Khuyến mãi bill chia đều theo tỉ lệ
    if (s.bill_promos?.length && s.subtotal - s.item_discount > 0) amount = Math.round(amount * (1 - s.bill_promos[0].amount / (s.subtotal - s.item_discount)));
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

  // ---------- Thu ngân: doanh thu ngày & đối soát chuyển khoản ----------
  function day(date) {
    const bills = db.prepare(`SELECT s.id, s.bill_no, s.closed_at, s.pay_method, s.paid_total, s.cash_amount, s.transfer_amount, s.reconcile_status, s.reconcile_note,
        c.name AS closed_by_name, json_extract(s.bill_snapshot, '$.discount') AS discount
      FROM table_sessions s LEFT JOIN staff c ON c.id = s.closed_by WHERE s.status = 'closed' AND s.closed_date = ? ORDER BY s.closed_at`).all(date)
      .map((b) => ({ ...b, header: ctx.posSession(b.id).header, transfer_note: noteOf(b.bill_no) }));
    const refunds = db.prepare('SELECT r.*, s.bill_no, a.name AS approver_name, c.name AS by_name FROM refunds r JOIN table_sessions s ON s.id = r.session_id LEFT JOIN staff a ON a.id = r.approved_by LEFT JOIN staff c ON c.id = r.created_by WHERE r.date = ? ORDER BY r.id').all(date)
      .map((x) => ({ ...x, lines: JSON.parse(x.lines) }));
    const sum = (arr, k) => arr.reduce((n, x) => n + (x[k] || 0), 0);
    const tr = bills.filter((b) => b.transfer_amount > 0);
    const cashIn = sum(bills, 'cash_amount');
    const refundCash = sum(refunds, 'amount');
    const closing = db.prepare('SELECT d.*, s.name AS by_name FROM day_closings d LEFT JOIN staff s ON s.id = d.confirmed_by WHERE d.date = ?').get(date);
    return {
      date, bills, refunds,
      summary: {
        bills: bills.length, gross: sum(bills, 'paid_total'), discount: sum(bills, 'discount'),
        cash_in: cashIn, refund_cash: refundCash, cash_expected: cashIn - refundCash,
        transfer_in: sum(tr, 'transfer_amount'),
        transfer_confirmed: sum(tr.filter((b) => b.reconcile_status === 'confirmed'), 'transfer_amount'),
        transfer_pending: sum(tr.filter((b) => b.reconcile_status === 'pending'), 'transfer_amount'),
        transfer_missing: sum(tr.filter((b) => b.reconcile_status === 'missing'), 'transfer_amount'),
        net: sum(bills, 'paid_total') - refundCash,
      },
      open_tables: db.prepare("SELECT COUNT(*) AS n FROM table_sessions WHERE status IN ('open','paying')").get().n,
      closing: closing ? { ...closing, totals: JSON.parse(closing.totals) } : null,
    };
  }

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
    const up = db.prepare('UPDATE table_sessions SET reconcile_status = ?, reconciled_at = ?, reconciled_by = ?, reconcile_note = ? WHERE id = ?');
    tx(db, () => rows.forEach((x) => up.run(status, ctx.now(), me.id, note, x.id)));
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
    if (d.summary.transfer_pending) fail(400, `Còn ${d.bills.filter((b) => b.reconcile_status === 'pending').length} bill CK chưa đối soát`);
    if (!d.bills.length) fail(400, 'Chưa có bill nào');
    db.prepare('INSERT INTO day_closings (date, totals, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?)').run(date, JSON.stringify(d.summary), me.id, ctx.now());
    const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id).filter((x) => x !== me.id);
    const f = (n) => n.toLocaleString('vi-VN');
    ctx.notify(owners, {
      title: `Đã chốt doanh thu ${date.slice(8)}/${date.slice(5, 7)}: ${f(d.summary.net)}đ`,
      body: `${d.summary.bills} bill · Tiền mặt ${f(d.summary.cash_expected)}đ (đã trừ hoàn ${f(d.summary.refund_cash)}đ) · CK ${f(d.summary.transfer_confirmed)}đ${d.summary.transfer_missing ? ` · CHƯA THẤY ${f(d.summary.transfer_missing)}đ` : ''} · KM ${f(d.summary.discount)}đ. Người chốt: ${me.name}`,
      link: '/thu-ngan',
    });
    ctx.audit(me, 'pay.close_day', { date, ...d.summary });
    return { ok: true };
  });
}
