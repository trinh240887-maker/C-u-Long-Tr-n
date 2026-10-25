import { fail } from '../http.js';
import { isDate, addDays } from '../lib/time.js';
import { computeTimesheet } from '../lib/payroll.js';
import { makeXlsx } from '../lib/xlsx.js';

// Năng suất & chi phí nhân sự (chỉ chủ + quản lý xem; chưa gắn thưởng):
// - Lương (theo giờ chấm công thật) so doanh thu theo từng giờ trong ngày → chỉ ra khung giờ thừa người, gợi ý cắt ca.
// - Từng người: giờ làm, lương, đi trễ, quên chấm ra, bàn mở / doanh thu / món gửi bếp trên mỗi giờ, checklist làm & bị làm lại,
//   khoảng "không thao tác" dài khi đang trong ca (chỉ tính phục vụ / tiếp thực / thu ngân — bếp làm theo phiếu in).
// - Sáng thứ Hai gửi báo cáo tuần cho chủ + quản lý.
// - Chấm công ngoài wifi quán: báo quản lý (1 lần / người / ngày).
export default function (r, ctx) {
  const { db } = ctx;
  const MIN = 60_000;
  const H = 3_600_000;
  const target = () => Number(ctx.setting('labor_target_pct') || 25);
  const idleMin = () => Number(ctx.setting('idle_alert_minutes') || 60);
  const APP_TEAMS = ['Phục vụ', 'Tiếp thực', 'Thu ngân'];

  function range(query) {
    const to = query.get('to') || ctx.today();
    const from = query.get('from') || addDays(to, -6);
    if (!isDate(from) || !isDate(to) || from > to) fail(400, 'Ngày không hợp lệ');
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    if (days > 93) fail(400, 'Tối đa 3 tháng mỗi lần xem');
    return { from, to, days };
  }

  function report(from, to, totalDays) {
    let days = totalDays;
    const clock = ctx.clock();
    const now = ctx.now();
    const t0 = clock.toEpoch(from, 0);
    const t1 = clock.toEpoch(addDays(to, 1), 0);
    const staff = db.prepare(`SELECT s.id, s.name, s.role, s.pay_type, s.pay_rate, t.name AS team_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id WHERE s.role != 'owner'`).all();
    const recs = db.prepare('SELECT a.*, a.assignment_id AS group_key FROM attendance a WHERE a.date BETWEEN ? AND ?').all(from, to);
    const closedRecs = recs.map((x) => ({ ...x, clock_out: x.clock_out || Math.min(now, x.clock_in + 12 * H) }));
    const sheet = new Map(computeTimesheet(ctx.payRecords ? ctx.payRecords(closedRecs) : closedRecs, staff, clock, { nightBonusPct: Number(ctx.setting('night_bonus_pct') || 0), monthStandardDays: Number(ctx.setting('month_standard_days') || 26) }).map((x) => [x.staff_id, x]));
    const perMin = (id) => { const x = sheet.get(id); return x && x.minutes ? x.pay / x.minutes : 0; };

    // Theo giờ trong ngày: người đang chấm công, lương, bàn có khách, doanh thu (giờ khách vào)
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, staff_min: 0, cost: 0, table_min: 0, revenue: 0, bills: 0 }));
    const spread = (a, b, fn) => {
      for (let t = a; t < b;) {
        const h = Math.floor(clock.minuteOf(t) / 60);
        const next = Math.min(b, t + (60 - (clock.minuteOf(t) % 60)) * MIN);
        fn(hours[h], (next - t) / MIN);
        t = next;
      }
    };
    for (const x of closedRecs) spread(Math.max(t0, x.clock_in), Math.min(t1, x.clock_out), (h, m) => { h.staff_min += m; h.cost += m * perMin(x.staff_id); });
    const bills = db.prepare("SELECT id, opened_at, closed_at, paid_total, opened_by FROM table_sessions WHERE status = 'closed' AND closed_date BETWEEN ? AND ?").all(from, to);
    const tablesOf = db.prepare('SELECT COUNT(*) AS n FROM session_tables WHERE session_id = ?');
    for (const b of bills) {
      const n = tablesOf.get(b.id).n || 1;
      // Doanh thu chia theo thời gian bàn ngồi (khách ngồi giờ nào thì cần người phục vụ giờ đó)
      const dur = Math.max(1, (b.closed_at - b.opened_at) / MIN);
      spread(b.opened_at, Math.max(b.closed_at, b.opened_at + MIN), (h, m) => { h.table_min += m * n; h.revenue += (b.paid_total * m) / dur; });
      hours[Math.floor(clock.minuteOf(b.opened_at) / 60)].bills++;
    }
    const revenue = bills.reduce((n, b) => n + b.paid_total, 0) - db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM refunds WHERE date BETWEEN ? AND ?').get(from, to).n;
    const laborCost = [...sheet.values()].reduce((n, x) => n + x.pay, 0);
    // Trung bình trên các ngày quán có mở (có người chấm công), không tính ngày trống trong kỳ
    const open = Math.max(1, new Set(recs.map((x) => x.date)).size);
    days = open; // eslint-disable-line no-param-reassign
    const byHour = hours.filter((h) => h.staff_min > 0 || h.revenue > 0).map((h) => ({
      hour: h.hour, staff: Math.round((h.staff_min / 60 / days) * 10) / 10, tables: Math.round((h.table_min / 60 / days) * 10) / 10,
      cost: Math.round(h.cost / days), revenue: Math.round(h.revenue / days), pct: h.revenue ? Math.round((h.cost / h.revenue) * 1000) / 10 : null,
    }));
    // Giờ thừa người: ≥ 3 người mà lương / doanh thu giờ đó vượt 1,5 lần mục tiêu → bớt người cho về gần mục tiêu, giữ tối thiểu 2
    // hoặc rất ít khách so với số người (dưới 1 bàn cho 2 người) → giữ đủ cho số bàn đang có (≥ 3 người)
    const over = byHour.filter((h) => h.staff >= 3 && (h.pct == null || h.pct > target() * 1.5 || h.tables < h.staff * 0.5))
      .map((h) => {
        const byPct = h.pct ? h.staff * (target() / h.pct) : 2;
        const byTables = Math.max(3, Math.ceil(h.tables * 2));
        const keep = h.pct != null && h.pct > target() * 1.5 ? Math.max(2, Math.min(byPct, byTables)) : byTables;
        return { ...h, cut: Math.floor(h.staff - keep), save: 0 };
      })
      .filter((h) => h.cut >= 1);
    for (const o of over) o.save = Math.round(o.cut * (o.cost / Math.max(o.staff, 1)) * days);

    // Từng người
    const activity = (id, a, b) => [
      ...db.prepare('SELECT created_at AS t FROM order_items WHERE created_by = ? AND created_at BETWEEN ? AND ?').all(id, a, b),
      ...db.prepare('SELECT sent_at AS t FROM order_items WHERE sent_by = ? AND sent_at BETWEEN ? AND ?').all(id, a, b),
      ...db.prepare('SELECT opened_at AS t FROM table_sessions WHERE opened_by = ? AND opened_at BETWEEN ? AND ?').all(id, a, b),
      ...db.prepare('SELECT closed_at AS t FROM table_sessions WHERE closed_by = ? AND closed_at BETWEEN ? AND ?').all(id, a, b),
      ...db.prepare('SELECT done_at AS t FROM checklist_entries WHERE done_by = ? AND done_at BETWEEN ? AND ?').all(id, a, b),
      ...db.prepare('SELECT at AS t FROM audit_log WHERE staff_id = ? AND at BETWEEN ? AND ?').all(id, a, b),
    ].map((x) => x.t).sort((x, y) => x - y);
    const busyN = Number(ctx.setting('idle_busy_tables') || 5);
    const openAt = db.prepare("SELECT COUNT(*) AS n FROM table_sessions WHERE opened_at <= ? AND COALESCE(closed_at, ?) > ? AND status IN ('open','paying','closed')");
    // Số phút trong [a, b) mà quán đang đông (lấy mẫu mỗi 15′)
    const busyMinutes = (a, b) => {
      let hit = 0;
      for (let t = a + 7.5 * MIN; t < b; t += 15 * MIN) if (openAt.get(t, now, t).n >= busyN) hit++;
      return hit * 15;
    };
    const people = staff.map((s) => {
      const mine = closedRecs.filter((x) => x.staff_id === s.id);
      if (!mine.length) return null;
      const ts = sheet.get(s.id);
      const hoursW = (ts?.minutes || 0) / 60;
      const opened = bills.filter((b) => b.opened_by === s.id);
      const sent = db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM order_items WHERE sent_by = ? AND sent_at BETWEEN ? AND ?').get(s.id, t0, t1).n;
      const ck = db.prepare(`SELECT COUNT(*) AS n, SUM(e.review_status = 'redo') AS redo FROM checklist_entries e JOIN checklist_runs r ON r.id = e.run_id WHERE e.done_by = ? AND r.date BETWEEN ? AND ?`).get(s.id, from, to);
      const late = mine.filter((x) => x.late_minutes > 0);
      // Khoảng không thao tác dài khi đang trong ca (chỉ tổ dùng app thường xuyên)
      let idleBlocks = 0;
      let idleMinutes = 0;
      // Quản lý đi sàn giám sát, ít bấm app → không tính
      if (APP_TEAMS.includes(s.team_name) && !['owner', 'manager'].includes(s.role)) {
        for (const x of mine) {
          const pts = [x.clock_in, ...activity(s.id, x.clock_in, x.clock_out), x.clock_out];
          for (let k = 1; k < pts.length; k++) {
            const gap = (pts[k] - pts[k - 1]) / MIN;
            // Chỉ tính lúc quán đông (≥ busy_tables bàn có khách ở phần lớn khoảng đó); quán vắng không có gì để bấm là bình thường
            if (gap < idleMin()) continue;
            const busyMin = busyMinutes(pts[k - 1], pts[k]);
            if (busyMin >= idleMin()) { idleBlocks += Math.floor(busyMin / idleMin()); idleMinutes += Math.round(busyMin); }
          }
        }
      }
      const flags = [];
      if (late.length >= 3) flags.push(`trễ ${late.length} lần (${late.reduce((n, x) => n + x.late_minutes, 0)}′)`);
      if (mine.filter((x) => x.auto_closed).length >= 2) flags.push(`quên chấm ra ${mine.filter((x) => x.auto_closed).length} lần`);
      if (idleBlocks >= 2) flags.push(`${idleBlocks} lần ≥ ${idleMin()}′ không thao tác lúc quán đông (${idleMinutes}′)`);
      if ((ck.redo || 0) >= 2) flags.push(`${ck.redo} việc checklist bị làm lại`);
      return {
        id: s.id, name: s.name, team: s.team_name || '', role: s.role,
        hours: Math.round(hoursW * 10) / 10, shifts: ts?.shifts || 0, cost: ts?.pay || 0,
        late: late.length, late_minutes: late.reduce((n, x) => n + x.late_minutes, 0), forgot_out: mine.filter((x) => x.auto_closed).length,
        bills: opened.length, revenue: opened.reduce((n, b) => n + b.paid_total, 0),
        rev_per_hour: hoursW ? Math.round(opened.reduce((n, b) => n + b.paid_total, 0) / hoursW) : 0,
        items_per_hour: hoursW ? Math.round((sent / hoursW) * 10) / 10 : 0,
        checklist: ck.n || 0, redo: ck.redo || 0, idle_blocks: idleBlocks, idle_minutes: idleMinutes, flags,
      };
    }).filter(Boolean);
    // Theo tổ
    const teams = new Map();
    for (const p of people) {
      const x = teams.get(p.team || 'Khác') || { name: p.team || 'Khác', people: 0, hours: 0, cost: 0 };
      x.people++; x.hours += p.hours; x.cost += p.cost; teams.set(x.name, x);
    }
    const service = people.filter((p) => p.team === 'Phục vụ' && p.hours >= 4).sort((a, b) => b.rev_per_hour - a.rev_per_hour);
    return {
      from, to, days: totalDays, open_days: open, target: target(),
      summary: { revenue, labor_cost: laborCost, pct: revenue ? Math.round((laborCost / revenue) * 1000) / 10 : null, hours: Math.round(people.reduce((n, p) => n + p.hours, 0)), people: people.length,
        rev_per_labor_hour: people.reduce((n, p) => n + p.hours, 0) ? Math.round(revenue / people.reduce((n, p) => n + p.hours, 0)) : 0 },
      by_hour: byHour, over, save_total: over.reduce((n, o) => n + o.save, 0),
      teams: [...teams.values()].map((t) => ({ ...t, hours: Math.round(t.hours), pct: revenue ? Math.round((t.cost / revenue) * 1000) / 10 : null })).sort((a, b) => b.cost - a.cost),
      people: people.sort((a, b) => b.flags.length - a.flags.length || b.cost - a.cost),
      top: service.slice(0, 3).map((p) => p.name), bottom: service.length > 3 ? service.slice(-3).reverse().map((p) => p.name) : [],
      flagged: people.filter((p) => p.flags.length).map((p) => ({ name: p.name, flags: p.flags })),
    };
  }
  ctx.laborReport = (from, to) => report(from, to, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);

  r.get('/api/reports/labor', 'manager', ({ query }) => { const { from, to, days } = range(query); return report(from, to, days); });

  r.get('/api/reports/labor.xlsx', 'manager', ({ me, query }) => {
    const { from, to, days } = range(query);
    const x = report(from, to, days);
    const sheets = [
      { name: 'Theo giờ', rows: [['Giờ', 'Người TB / ngày', 'Bàn có khách TB', 'Lương TB / ngày', 'Doanh thu TB / ngày', '% lương / doanh thu'], ...x.by_hour.map((h) => [`${String(h.hour).padStart(2, '0')}h`, h.staff, h.tables, h.cost, h.revenue, h.pct ?? ''])] },
      { name: 'Từng người', rows: [['Tên', 'Tổ', 'Giờ làm', 'Lương', 'Trễ (lần)', 'Trễ (phút)', 'Quên chấm ra', 'Bàn mở', 'Doanh thu', 'Doanh thu / giờ', 'Món gửi / giờ', 'Checklist', 'Bị làm lại', 'Lần không thao tác', 'Cần nhắc'],
        ...x.people.map((p) => [p.name, p.team, p.hours, p.cost, p.late, p.late_minutes, p.forgot_out, p.bills, p.revenue, p.rev_per_hour, p.items_per_hour, p.checklist, p.redo, p.idle_blocks, p.flags.join('; ')])] },
      { name: 'Theo tổ', rows: [['Tổ', 'Số người', 'Giờ', 'Lương', '% doanh thu'], ...x.teams.map((t) => [t.name, t.people, t.hours, t.cost, t.pct ?? ''])] },
    ];
    ctx.audit(me, 'report.labor.export', { from, to });
    return { __binary: makeXlsx(sheets), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `nang-suat-nhan-su_${from}_${to}.xlsx` };
  });

  // Sáng thứ Hai (mặc định 08:00) gửi báo cáo tuần trước
  ctx.laborWeeklyTick = () => {
    const clock = ctx.clock();
    const now = ctx.now();
    const date = clock.dateOf(now);
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    const [h, m] = String(ctx.setting('labor_report_time') || '08:00').split(':').map(Number);
    if (wd !== 1 || clock.minuteOf(now) < h * 60 + m || ctx.setting('labor_report_date') === date) return null;
    ctx.setSetting('labor_report_date', date);
    const x = ctx.laborReport(addDays(date, -7), addDays(date, -1));
    const vnd = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
    const to = db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((s) => s.id);
    const lines = [
      `Lương ${vnd(x.summary.labor_cost)} = ${x.summary.pct ?? '?'}% doanh thu ${vnd(x.summary.revenue)} (mục tiêu ${x.target}%)`,
      x.over.length ? `Giờ thừa người: ${x.over.map((o) => `${String(o.hour).padStart(2, '0')}h (TB ${o.staff} người / ${o.tables} bàn, bớt được ${o.cut})`).join(', ')} → tiết kiệm ~${vnd(x.save_total)}/tuần` : 'Không có giờ thừa người rõ rệt',
      x.top.length ? `Phục vụ tốt nhất (doanh thu / giờ): ${x.top.join(', ')}` : '',
      x.flagged.length ? `Cần nhắc: ${x.flagged.slice(0, 5).map((f) => `${f.name} (${f.flags.join(', ')})`).join('; ')}` : 'Không ai cần nhắc',
    ].filter(Boolean);
    ctx.notify(to, { title: `Năng suất tuần ${x.from.slice(8)}/${x.from.slice(5, 7)}–${x.to.slice(8)}/${x.to.slice(5, 7)}: lương ${x.summary.pct ?? '?'}% doanh thu`, body: lines.join('\n'), link: '/bao-cao?tab=nhansu' });
    return x;
  };

  // Chấm công ngoài wifi quán → báo quản lý 1 lần / người / ngày; IP đang dùng để chủ quán lưu làm wifi quán
  const warned = new Set();
  ctx.clockBlocked = (me, net) => {
    const key = `${me.id}:${ctx.today()}`;
    if (warned.has(key)) return;
    warned.add(key);
    const mgr = db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((s) => s.id).filter((x) => x !== me.id);
    ctx.notify(mgr, { title: `${me.name} bấm chấm công khi không ở quán`, body: `Không đúng vị trí quán và không bắt wifi quán (mạng ${net.ip || '?'}). Nếu bạn ấy đang ở quán: kiểm tra máy cầu in còn chạy, hoặc nhắc bật vị trí.`, link: '/cham-cong' });
  };
  r.get('/api/attendance/network', 'staff', ({ net }) => {
    const prefixes = ctx.setting('clock_ip_prefixes').split(',').map((s) => s.trim()).filter(Boolean);
    const bridgeAt = Number(ctx.setting('shop_bridge_ip_at') || 0);
    return { ip: net.ip, remote: net.remote, allowed: ctx.onShopWifi ? ctx.onShopWifi(net) : !prefixes.length || prefixes.some((p) => net.ip.startsWith(p)), prefixes,
      bridge_ip: ctx.setting('shop_bridge_ip') || '', bridge_at: bridgeAt || null, gps: ctx.clockPlace?.().gps || false };
  });
}
