import { fail, v } from '../http.js';
import { rank } from '../db.js';

// Thùng tip (quỹ tip chung, thu ngân giữ, cuối tháng chia):
// - Tip tiền mặt (khách không lấy tiền thối) và tip CK (thu ngân lấy đúng số đó tiền mặt trong két bỏ vào) đều nằm trong thùng,
//   két phải có đã trừ phần này → không lệch két.
// - Chốt ngày → app tự ghi "phiếu chi két → thùng tip" của ngày đó vào sổ thùng tip; chủ quán mở lại sổ ngày → xoá.
// - Đếm thùng bất cứ lúc nào: lệch so với sổ → báo chủ quán.
// - Cuối tháng chia: app gợi ý theo giờ công (chấm công), thu ngân sửa được → phiếu chi tip có tên từng người, chủ quán nhận báo.
export default function (r, ctx) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS tip_box (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, counted INTEGER,
    note TEXT NOT NULL DEFAULT '', lines TEXT NOT NULL DEFAULT '[]', period_from TEXT, period_to TEXT, by_staff INTEGER, at INTEGER NOT NULL
  )`);
  // kind: in_cash | in_ck (tự động khi chốt ngày) · payout (chia tip, số âm) · count (đếm thùng) · adjust (chủ quán chỉnh)
  const vnd = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
  const isCashier = (me) => rank(me.role) >= rank('shift_lead') || !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
  const needCashier = (me) => { if (!isCashier(me)) fail(403, 'Chỉ thu ngân / trưởng ca trở lên'); };
  const owners = () => db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id);
  const balance = () => db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM tip_box WHERE kind != 'count'").get().n;
  const amt = (x, name, min = 0) => v.int(Number(String(x ?? '').replace(/[.,\s]/g, '')), { min, max: 1_000_000_000, name });

  ctx.tipBoxClose = (date, summary, me) => {
    db.prepare("DELETE FROM tip_box WHERE date = ? AND kind IN ('in_cash','in_ck')").run(date);
    const add = db.prepare('INSERT INTO tip_box (date, kind, amount, note, by_staff, at) VALUES (?, ?, ?, ?, ?, ?)');
    if (summary.tip_box_cash) add.run(date, 'in_cash', summary.tip_box_cash, 'Tip tiền mặt (khách không lấy tiền thối)', me?.id ?? null, ctx.now());
    if (summary.tip_box_ck) add.run(date, 'in_ck', summary.tip_box_ck, 'Tip CK: lấy tiền mặt trong két bỏ thùng bằng số tip', me?.id ?? null, ctx.now());
  };
  ctx.tipBoxReopen = (date) => db.prepare("DELETE FROM tip_box WHERE date = ? AND kind IN ('in_cash','in_ck')").run(date);
  ctx.tipBoxBalance = balance;

  const rows = (limit = 60) => db.prepare('SELECT t.*, s.name AS by_name FROM tip_box t LEFT JOIN staff s ON s.id = t.by_staff ORDER BY t.at DESC, t.id DESC LIMIT ?').all(limit)
    .map((x) => ({ ...x, lines: JSON.parse(x.lines || '[]') }));

  r.get('/api/tip-box', 'staff', ({ me }) => {
    needCashier(me);
    const lastPay = db.prepare("SELECT * FROM tip_box WHERE kind = 'payout' ORDER BY at DESC LIMIT 1").get();
    const lastCount = db.prepare("SELECT * FROM tip_box WHERE kind = 'count' ORDER BY at DESC LIMIT 1").get();
    const since = lastPay?.period_to || '0000-00-00';
    return {
      balance: balance(),
      since_last_payout: db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM tip_box WHERE kind IN ('in_cash','in_ck') AND date > ?").get(since).n,
      last_payout: lastPay ? { ...lastPay, lines: JSON.parse(lastPay.lines) } : null,
      last_count: lastCount || null,
      moves: rows(),
    };
  });

  // Đếm thùng tip
  r.post('/api/tip-box/count', 'staff', ({ me, body }) => {
    needCashier(me);
    const counted = amt(body.counted, 'Số tiền đếm được');
    const bal = balance();
    const diff = counted - bal;
    db.prepare('INSERT INTO tip_box (date, kind, amount, counted, note, by_staff, at) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run(ctx.today(), 'count', counted, `Sổ ${vnd(bal)}${diff ? ` · lệch ${diff > 0 ? '+' : '−'}${vnd(Math.abs(diff))}` : ' · khớp'}${body.note ? ` · ${v.text(body.note, { name: 'Ghi chú', max: 120 })}` : ''}`, me.id, ctx.now());
    if (diff) ctx.notify(owners().filter((x) => x !== me.id), { title: `Thùng tip lệch ${diff > 0 ? '+' : '−'}${vnd(Math.abs(diff))}`, body: `${me.name} đếm ${vnd(counted)}, sổ phải có ${vnd(bal)}.`, link: '/thu-ngan?tab=tip', urgent: Math.abs(diff) >= 50000 });
    ctx.audit(me, 'tipbox.count', { counted, balance: bal });
    return { ok: true, balance: bal, counted, diff };
  });

  // Gợi ý chia theo giờ công trong kỳ (chỉ ca đã chấm ra)
  r.get('/api/tip-box/suggest', 'staff', ({ me, query }) => {
    needCashier(me);
    const from = query.get('from');
    const to = query.get('to');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) fail(400, 'Chọn từ ngày / đến ngày');
    const total = query.get('amount') ? amt(query.get('amount'), 'Số tiền chia') : balance();
    const hrs = db.prepare(`SELECT a.staff_id, s.name, t.name AS team, SUM(a.clock_out - a.clock_in) / 3600000.0 AS h FROM attendance a JOIN staff s ON s.id = a.staff_id
      LEFT JOIN teams t ON t.id = s.team_id WHERE a.date BETWEEN ? AND ? AND a.clock_out IS NOT NULL AND s.role != 'owner' GROUP BY a.staff_id ORDER BY h DESC`).all(from, to);
    const sumH = hrs.reduce((n, x) => n + x.h, 0);
    // Làm tròn nghìn, phần dư dồn người nhiều giờ nhất
    const lines = hrs.map((x) => ({ staff_id: x.staff_id, name: x.name, team: x.team, hours: Math.round(x.h * 10) / 10, amount: sumH ? Math.floor((total * x.h) / sumH / 1000) * 1000 : 0 }));
    if (lines.length) lines[0].amount += total - lines.reduce((n, x) => n + x.amount, 0);
    return { from, to, total, hours: Math.round(sumH * 10) / 10, lines };
  });

  // Chia tip → phiếu chi
  r.post('/api/tip-box/payout', 'staff', ({ me, body }) => {
    needCashier(me);
    const lines = (Array.isArray(body.lines) ? body.lines : []).map((l) => {
      const st = db.prepare('SELECT id, name FROM staff WHERE id = ?').get(v.int(l.staff_id, { min: 1, name: 'Nhân viên' }));
      if (!st) fail(404, 'Không tìm thấy nhân viên');
      return { staff_id: st.id, name: st.name, hours: Number(l.hours) || null, amount: amt(l.amount, `Tip của ${st.name}`) };
    }).filter((l) => l.amount > 0);
    if (!lines.length) fail(400, 'Chưa có ai nhận tip');
    const total = lines.reduce((n, l) => n + l.amount, 0);
    const bal = balance();
    if (total > bal) fail(400, `Chia ${vnd(total)} nhiều hơn thùng tip đang có ${vnd(bal)}`);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || '') ? body.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(body.to || '') ? body.to : ctx.today();
    const id = Number(db.prepare('INSERT INTO tip_box (date, kind, amount, note, lines, period_from, period_to, by_staff, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.today(), 'payout', -total, v.text(body.note, { name: 'Ghi chú', max: 200 }) || `Chia tip ${from || ''}${from ? ' → ' : ''}${to}`, JSON.stringify(lines), from, to, me.id, ctx.now()).lastInsertRowid);
    ctx.notify(owners().filter((x) => x !== me.id), {
      title: `Phiếu chi tip #${id}: ${vnd(total)} cho ${lines.length} người`,
      body: `${me.name} chia${from ? ` kỳ ${from} → ${to}` : ''}. Còn trong thùng ${vnd(bal - total)}.\n${lines.slice(0, 12).map((l) => `• ${l.name}: ${vnd(l.amount)}`).join('\n')}`,
      link: '/thu-ngan?tab=tip',
    });
    for (const l of lines) ctx.notify([l.staff_id], { title: `Tip ${from ? `kỳ ${from.slice(8)}/${from.slice(5, 7)} → ${to.slice(8)}/${to.slice(5, 7)}` : 'quỹ chung'}: ${vnd(l.amount)}`, body: `Nhận tại thu ngân ${me.name}, ký vào phiếu chi #${id}.` });
    ctx.audit(me, 'tipbox.payout', { id, total, n: lines.length });
    return { ok: true, id, total, balance: bal - total };
  });

  // Chủ quán chỉnh thùng (lệch đã tìm ra nguyên nhân)
  r.post('/api/tip-box/adjust', 'owner', ({ me, body }) => {
    const amount = v.int(Number(String(body.amount ?? '').replace(/[.,\s]/g, '')), { min: -1_000_000_000, max: 1_000_000_000, name: 'Số tiền' });
    const note = v.text(body.note, { name: 'Lý do', required: true, max: 200 });
    db.prepare('INSERT INTO tip_box (date, kind, amount, note, by_staff, at) VALUES (?, ?, ?, ?, ?, ?)').run(ctx.today(), 'adjust', amount, note, me.id, ctx.now());
    ctx.audit(me, 'tipbox.adjust', { amount, note });
    return { ok: true, balance: balance() };
  });
}
