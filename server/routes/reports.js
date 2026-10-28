import { fail } from '../http.js';
import { isDate, addDays } from '../lib/time.js';
import { makeXlsx } from '../lib/xlsx.js';

// GĐ4 Báo cáo doanh thu (quản lý trở lên): theo ngày / giờ / khu / món / nhóm món / khuyến mãi / người mở bàn,
// so với kỳ trước cùng số ngày, xuất Excel.
// Doanh thu = tiền khách trả của bill đã đóng (đã trừ khuyến mãi, không gồm tip), trừ tiền hoàn trong kỳ.
export default function (r, ctx) {
  const { db } = ctx;
  const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

  function range(query) {
    const today = ctx.today();
    const to = query.get('to') || today;
    const from = query.get('from') || to;
    if (!isDate(from) || !isDate(to)) fail(400, 'Ngày không hợp lệ');
    if (from > to) fail(400, 'Từ ngày phải trước đến ngày');
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    if (days > 366) fail(400, 'Tối đa 1 năm mỗi lần xem');
    return { from, to, days };
  }

  const bills = (from, to) => db.prepare(`SELECT s.id, s.closed_date, s.opened_at, s.closed_at, s.paid_total, s.cash_amount, s.transfer_amount, s.tip_cash, s.tip_transfer,
      s.pay_method, s.bill_snapshot, s.opened_by, st.name AS opened_by_name
    FROM table_sessions s LEFT JOIN staff st ON st.id = s.opened_by WHERE s.status = 'closed' AND s.closed_date BETWEEN ? AND ?`).all(from, to);

  // Khoảng thời gian theo ngày kinh doanh (mốc 5h sáng, rà soát 28/10), giống closed_date của bill
  const dayRange = (from, to) => { const c = ctx.clock(); return [c.toEpoch(from, c.cutoffHour * 60), c.toEpoch(addDays(to, 1), c.cutoffHour * 60)]; };

  function summary(from, to, list = bills(from, to)) {
    const sum = (f) => list.reduce((n, b) => n + (Number(f(b)) || 0), 0);
    const snap = (b) => { try { return JSON.parse(b.bill_snapshot || '{}'); } catch { return {}; } };
    const refunds = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n, COUNT(*) AS c FROM refunds WHERE date BETWEEN ? AND ?').get(from, to);
    const revenue = sum((b) => b.paid_total);
    const dwell = list.map((b) => (b.closed_at - b.opened_at) / 60_000).filter((d) => d > 5 && d < 300);
    const cancelled = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(i.unit_price * i.qty), 0) AS v FROM table_sessions s JOIN order_items i ON i.session_id = s.id
      WHERE s.status = 'cancelled' AND i.sent_at IS NOT NULL AND s.closed_at >= ? AND s.closed_at < ?`).get(...dayRange(from, to));
    return {
      bills: list.length,
      gross: sum((b) => snap(b).subtotal ?? b.paid_total),
      discount: sum((b) => snap(b).discount || 0),
      revenue,
      refunds: refunds.n, refund_count: refunds.c,
      net: revenue - refunds.n,
      cash: sum((b) => b.cash_amount), transfer: sum((b) => b.transfer_amount),
      tip: sum((b) => (b.tip_cash || 0) + (b.tip_transfer || 0)),
      avg_bill: list.length ? Math.round(revenue / list.length) : 0,
      avg_dwell: dwell.length ? Math.round(dwell.reduce((a, b) => a + b, 0) / dwell.length) : null,
      lost_value: cancelled.v,
    };
  }

  function report(from, to, days) {
    const clock = ctx.clock();
    const list = bills(from, to);
    const cur = summary(from, to, list);
    const pFrom = addDays(from, -days);
    const pTo = addDays(from, -1);
    const prev = summary(pFrom, pTo);

    // Theo ngày
    const byDay = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) byDay.set(d, { date: d, weekday: WD[new Date(`${d}T00:00:00Z`).getUTCDay()], bills: 0, revenue: 0 });
    for (const b of list) { const x = byDay.get(b.closed_date); if (x) { x.bills++; x.revenue += b.paid_total; } }
    const refundsByDay = db.prepare('SELECT date, SUM(amount) AS n FROM refunds WHERE date BETWEEN ? AND ? GROUP BY date').all(from, to);
    for (const x of refundsByDay) { const d = byDay.get(x.date); if (d) d.revenue -= x.n; }

    // Theo giờ khách vào
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, bills: 0, revenue: 0 }));
    for (const b of list) { const h = Math.floor(clock.minuteOf(b.opened_at) / 60); hours[h].bills++; hours[h].revenue += b.paid_total; }

    // Theo thứ trong tuần (trung bình 1 ngày)
    const wd = WD.map((name) => ({ name, days: 0, revenue: 0 }));
    for (const d of byDay.values()) { const k = WD.indexOf(d.weekday); wd[k].days++; wd[k].revenue += d.revenue; }

    // Theo khu (bàn đầu tiên của bill)
    const ids = list.map((b) => b.id);
    const zoneOf = new Map();
    if (ids.length) {
      for (const x of db.prepare(`SELECT t.session_id, MIN(t.table_number) AS n FROM session_tables t WHERE t.session_id IN (${ids.map(() => '?').join(',')}) GROUP BY t.session_id`).all(...ids)) zoneOf.set(x.session_id, x.n);
    }
    const tables = new Map(db.prepare('SELECT d.number, z.id AS zone_id, z.name FROM dining_tables d JOIN zones z ON z.id = d.zone_id').all().map((t) => [t.number, t]));
    const zones = new Map();
    for (const b of list) {
      const z = tables.get(zoneOf.get(b.id))?.name || 'Không rõ';
      const x = zones.get(z) || { name: z, bills: 0, revenue: 0 };
      x.bills++; x.revenue += b.paid_total; zones.set(z, x);
    }

    // Món + nhóm món + khuyến mãi
    const lineDisc = new Map();
    const promos = new Map();
    for (const b of list) {
      let s = {};
      try { s = JSON.parse(b.bill_snapshot || '{}'); } catch { /* bill cũ */ }
      for (const [itemId, ps] of s.lines || []) for (const p of ps) {
        lineDisc.set(itemId, (lineDisc.get(itemId) || 0) + p.amount);
        const x = promos.get(p.name) || { name: p.name, count: 0, amount: 0 }; x.count++; x.amount += p.amount; promos.set(p.name, x);
      }
      // KM bill: bản chụp lưu dạng mảng [bill] (lib/promo.js), bill cũ có thể là 1 đối tượng (rà soát 28/10)
      for (const bp of [].concat(s.bill || [])) {
        if (!bp?.amount) continue;
        const x = promos.get(bp.name) || { name: bp.name, count: 0, amount: 0 }; x.count++; x.amount += bp.amount; promos.set(bp.name, x);
      }
    }
    const items = new Map();
    const cats = new Map();
    if (ids.length) {
      const rows = db.prepare(`SELECT i.id, i.menu_item_id, i.name, i.unit_price, i.qty, COALESCE(i.refunded_qty, 0) AS refunded_qty, c.name AS category
        FROM order_items i LEFT JOIN menu_items m ON m.id = i.menu_item_id LEFT JOIN menu_categories c ON c.id = m.category_id
        WHERE i.status != 'cancelled' AND i.session_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      for (const i of rows) {
        const key = i.menu_item_id ?? `n:${i.name}`;
        const qty = i.qty - i.refunded_qty;
        const gross = i.unit_price * i.qty;
        const net = gross - (lineDisc.get(i.id) || 0) - i.unit_price * i.refunded_qty;
        const x = items.get(key) || { name: i.name, category: i.category || 'Khác', qty: 0, gross: 0, net: 0, bills: new Set() };
        x.qty += qty; x.gross += gross; x.net += net; x.bills.add(i.id);
        items.set(key, x);
        const c = cats.get(x.category) || { name: x.category, qty: 0, net: 0 };
        c.qty += qty; c.net += net; cats.set(x.category, c);
      }
    }
    const totalNet = [...items.values()].reduce((n, x) => n + x.net, 0) || 1;
    const menuCount = db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE active = 1').get().n;
    const itemList = [...items.values()].map(({ bills: _b, ...x }) => ({ ...x, share: Math.round((x.net / totalNet) * 1000) / 10 })).sort((a, b) => b.net - a.net);
    const sold = new Set(itemList.map((x) => x.name));
    const notSold = db.prepare('SELECT m.name, c.name AS category FROM menu_items m LEFT JOIN menu_categories c ON c.id = m.category_id WHERE m.active = 1 ORDER BY c.sort, m.sort').all().filter((m) => !sold.has(m.name));

    // Người mở bàn
    const staff = new Map();
    for (const b of list) {
      const k = b.opened_by_name || 'Không rõ';
      const x = staff.get(k) || { name: k, bills: 0, revenue: 0 }; x.bills++; x.revenue += b.paid_total; staff.set(k, x);
    }

    return {
      from, to, days, prev_from: pFrom, prev_to: pTo,
      summary: cur, prev,
      by_day: [...byDay.values()],
      by_hour: hours.filter((h) => h.bills),
      by_weekday: [...wd.slice(1), wd[0]].filter((x) => x.days).map((x) => ({ name: x.name, days: x.days, avg: Math.round(x.revenue / x.days) })),
      by_zone: [...zones.values()].sort((a, b) => b.revenue - a.revenue),
      categories: [...cats.values()].sort((a, b) => b.net - a.net),
      items: itemList, not_sold: notSold, menu_count: menuCount,
      promos: [...promos.values()].sort((a, b) => b.amount - a.amount),
      staff: [...staff.values()].sort((a, b) => b.revenue - a.revenue),
    };
  }
  ctx.salesReport = (from, to) => report(from, to, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);

  r.get('/api/reports/sales', 'manager', ({ query }) => {
    const { from, to, days } = range(query);
    return report(from, to, days);
  });

  r.get('/api/reports/sales.xlsx', 'manager', ({ me, query }) => {
    const { from, to, days } = range(query);
    const x = report(from, to, days);
    const s = x.summary;
    const p = x.prev;
    const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : '');
    const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
    const sheets = [
      { name: 'Tổng quan', rows: [
        ['Chỉ số', `Kỳ này (${dm(from)} – ${dm(to)})`, `Kỳ trước (${dm(x.prev_from)} – ${dm(x.prev_to)})`, 'Tăng/giảm %'],
        ['Doanh thu thực (đã trừ hoàn tiền)', s.net, p.net, pct(s.net, p.net)],
        ['Tiền món trước giảm giá', s.gross, p.gross, pct(s.gross, p.gross)],
        ['Giảm giá khuyến mãi', s.discount, p.discount, pct(s.discount, p.discount)],
        ['Khách trả (sau giảm giá)', s.revenue, p.revenue, pct(s.revenue, p.revenue)],
        ['Hoàn tiền', s.refunds, p.refunds, pct(s.refunds, p.refunds)],
        ['Số bill', s.bills, p.bills, pct(s.bills, p.bills)],
        ['Trung bình 1 bill', s.avg_bill, p.avg_bill, pct(s.avg_bill, p.avg_bill)],
        ['Chuyển khoản', s.transfer, p.transfer, pct(s.transfer, p.transfer)],
        ['Tiền mặt', s.cash, p.cash, pct(s.cash, p.cash)],
        ['Tip (quỹ chung, không tính doanh thu)', s.tip, p.tip, pct(s.tip, p.tip)],
        ['Món đã làm bị huỷ bàn (khách bỏ về / bỏ trốn)', s.lost_value, p.lost_value, pct(s.lost_value, p.lost_value)],
        ['Thời gian ngồi trung bình (phút)', s.avg_dwell ?? '', p.avg_dwell ?? '', ''],
      ] },
      { name: 'Theo ngày', rows: [['Ngày', 'Thứ', 'Số bill', 'Doanh thu'], ...x.by_day.map((d) => [dm(d.date), d.weekday, d.bills, d.revenue])] },
      { name: 'Theo giờ', rows: [['Giờ khách vào', 'Số bill', 'Doanh thu'], ...x.by_hour.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, h.bills, h.revenue])] },
      { name: 'Theo thứ', rows: [['Thứ', 'Số ngày', 'Doanh thu TB 1 ngày'], ...x.by_weekday.map((w) => [w.name, w.days, w.avg])] },
      { name: 'Theo khu', rows: [['Khu', 'Số bill', 'Doanh thu'], ...x.by_zone.map((z) => [z.name, z.bills, z.revenue])] },
      { name: 'Món', rows: [['Món', 'Nhóm', 'Số phần', 'Tiền trước giảm', 'Tiền sau giảm', '% doanh thu món'], ...x.items.map((i) => [i.name, i.category, i.qty, i.gross, i.net, i.share])] },
      { name: 'Nhóm món', rows: [['Nhóm', 'Số phần', 'Tiền sau giảm'], ...x.categories.map((c) => [c.name, c.qty, c.net])] },
      { name: 'Món không bán', rows: [['Món', 'Nhóm'], ...x.not_sold.map((m) => [m.name, m.category || ''])] },
      { name: 'Khuyến mãi', rows: [['Chương trình', 'Số lần áp', 'Tiền giảm'], ...x.promos.map((m) => [m.name, m.count, m.amount])] },
      { name: 'Nhân viên', rows: [['Người mở bàn', 'Số bill', 'Doanh thu'], ...x.staff.map((m) => [m.name, m.bills, m.revenue])] },
    ];
    ctx.audit(me, 'report.export', { from, to });
    return { __binary: makeXlsx(sheets), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `bao-cao-doanh-thu_${from}_${to}.xlsx` };
  });
}
