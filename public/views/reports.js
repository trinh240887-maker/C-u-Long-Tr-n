import { useState } from '../vendor/hooks.js';
import { html, useData, Loading, money, addDays, navigate } from '../ui.js';
import { MoneyNow } from './expenses.js';

// GĐ4 Báo cáo doanh thu: chọn kỳ → tổng quan so kỳ trước, theo ngày / giờ / thứ / khu, món bán chạy / ế, khuyến mãi, nhân viên, xuất Excel
const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
const k = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}tr` : `${Math.round(n / 1000).toLocaleString('vi-VN')}k`);

function presets(today) {
  const m0 = `${today.slice(0, 8)}01`;
  const prevEnd = addDays(m0, -1);
  return [
    ['today', 'Hôm nay', today, today],
    ['yesterday', 'Hôm qua', addDays(today, -1), addDays(today, -1)],
    ['7d', '7 ngày', addDays(today, -6), today],
    ['month', 'Tháng này', m0, today],
    ['lastmonth', 'Tháng trước', `${prevEnd.slice(0, 8)}01`, prevEnd],
  ];
}

function Delta({ cur, prev, invert }) {
  if (!prev) return html`<small class="muted">kỳ trước: 0</small>`;
  const p = Math.round(((cur - prev) / prev) * 1000) / 10;
  const good = invert ? p < 0 : p > 0;
  return html`<small class=${p === 0 ? 'muted' : good ? 'ok-text' : 'danger-text'}>${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${Math.abs(p).toLocaleString('vi-VN')}% so kỳ trước</small>`;
}

function Bars({ rows, label, value, fmt = k, hint }) {
  const max = Math.max(1, ...rows.map(value));
  return html`<div class="rbars">${rows.map((r) => html`<div class="rbar">
    <span class="rl">${label(r)}</span>
    <span class="rt"><i style=${`width:${Math.max(2, (value(r) / max) * 100)}%`}></i></span>
    <span class="rv"><b>${fmt(value(r))}</b>${hint ? html`<small class="muted">${hint(r)}</small>` : null}</span>
  </div>`)}</div>`;
}

function DayChart({ days }) {
  const max = Math.max(1, ...days.map((d) => d.revenue));
  const best = days.reduce((a, b) => (b.revenue > a.revenue ? b : a), days[0]);
  return html`<div class="dchart" style=${`--n:${days.length}`}>
    ${days.map((d) => html`<div class="dcol" title=${`${dm(d.date)}: ${money(d.revenue)} · ${d.bills} bill`}>
      <i style=${`height:${Math.max(1, (d.revenue / max) * 100)}%`} class=${d === best ? 'best' : d.weekday === 'T7' || d.weekday === 'CN' ? 'we' : ''}></i>
      ${days.length <= 16 ? html`<small>${dm(d.date)}</small>` : null}
    </div>`)}
  </div>
  <p class="muted small">Cao nhất ${dm(best.date)} (${best.weekday}): <b>${money(best.revenue)}</b>${days.length > 16 ? ` · từ ${dm(days[0].date)} đến ${dm(days[days.length - 1].date)}` : ''}. Cột cam: T7/CN.</p>`;
}

function SalesReport({ me }) {
  const today = me.today;
  const list = presets(today);
  const [sel, setSel] = useState('7d');
  const [custom, setCustom] = useState({ from: addDays(today, -29), to: today });
  const [from, to] = sel === 'custom' ? [custom.from, custom.to] : list.find((p) => p[0] === sel).slice(2);
  const st = useData(`/api/reports/sales?from=${from}&to=${to}`);
  const [showAll, setShowAll] = useState(false);
  const x = st.data;
  const s = x?.summary;
  const p = x?.prev;
  return html`<div class="stack">
    <div class="chips">${list.map(([id, l]) => html`<button class=${`chip ${sel === id ? 'on' : ''}`} onClick=${() => setSel(id)}>${l}</button>`)}
      <button class=${`chip ${sel === 'custom' ? 'on' : ''}`} onClick=${() => setSel('custom')}>Tuỳ chọn</button></div>
    ${sel === 'custom' ? html`<div class="row wrap">
      <label>Từ <input type="date" value=${custom.from} max=${today} onChange=${(e) => setCustom({ ...custom, from: e.target.value })} /></label>
      <label>Đến <input type="date" value=${custom.to} max=${today} onChange=${(e) => setCustom({ ...custom, to: e.target.value })} /></label></div>` : null}
    ${!x ? html`<${Loading} state=${st} />` : html`
      <div class="row between wrap"><b>${from === to ? dm(from) : `${dm(from)} – ${dm(to)}`}</b>
        <a class="button" href=${`/api/reports/sales.xlsx?from=${from}&to=${to}`} download>⬇ Xuất Excel</a></div>

      <section class="kpis">
        <div class="kpi main"><small>Doanh thu thực</small><b>${money(s.net)}</b><${Delta} cur=${s.net} prev=${p.net} /></div>
        <div class="kpi"><small>Số bill</small><b>${s.bills}</b><${Delta} cur=${s.bills} prev=${p.bills} /></div>
        <div class="kpi"><small>Trung bình 1 bill</small><b>${money(s.avg_bill)}</b><${Delta} cur=${s.avg_bill} prev=${p.avg_bill} /></div>
        <div class="kpi"><small>Giảm giá khuyến mãi</small><b>${money(s.discount)}</b><small class="muted">${s.gross ? Math.round((s.discount / s.gross) * 1000) / 10 : 0}% tiền món</small></div>
        <div class="kpi"><small>Chuyển khoản / Tiền mặt</small><b>${k(s.transfer)} / ${k(s.cash)}</b>
          <span class="split"><i style=${`width:${s.transfer + s.cash ? (s.transfer / (s.transfer + s.cash)) * 100 : 0}%`}></i></span></div>
        <div class="kpi"><small>Tip quỹ chung</small><b>${money(s.tip)}</b><small class="muted">không tính doanh thu</small></div>
        ${s.refunds ? html`<div class="kpi warn"><small>Hoàn tiền (${s.refund_count} lần)</small><b>${money(s.refunds)}</b></div>` : null}
        ${s.lost_value ? html`<div class="kpi warn"><small>Món đã làm bị huỷ bàn</small><b>${money(s.lost_value)}</b><small class="muted">khách bỏ về / bỏ trốn</small></div>` : null}
        ${s.avg_dwell ? html`<div class="kpi"><small>Ngồi trung bình</small><b>${s.avg_dwell} phút</b></div>` : null}
      </section>
      <p class="muted small">Kỳ trước để so: ${dm(x.prev_from)} – ${dm(x.prev_to)} (${x.days} ngày). Doanh thu thực = khách trả sau giảm giá, trừ tiền hoàn; không gồm tip.</p>

      ${!s.bills ? html`<div class="empty">Chưa có bill nào đã thanh toán trong kỳ này.</div>` : html`
        ${x.days > 1 ? html`<section class="card"><h3>Theo ngày</h3><${DayChart} days=${x.by_day} /></section>` : null}

        <section class="card"><h3>Giờ khách vào</h3>
          <${Bars} rows=${x.by_hour} label=${(h) => `${String(h.hour).padStart(2, '0')}h`} value=${(h) => h.revenue} hint=${(h) => `${h.bills} bill`} />
          <p class="muted small">Giờ đông nhất: <b>${String(x.by_hour.reduce((a, b) => (b.bills > a.bills ? b : a)).hour).padStart(2, '0')}h</b>. Dùng để xếp thêm người vào khung này.</p></section>

        ${x.days >= 14 && x.by_weekday.length >= 5 ? html`<section class="card"><h3>Theo thứ (trung bình 1 ngày)</h3>
          <${Bars} rows=${x.by_weekday} label=${(w) => w.name} value=${(w) => w.avg} hint=${(w) => `${w.days} ngày`} /></section>` : null}

        <section class="card"><h3>Theo khu</h3>
          <${Bars} rows=${x.by_zone} label=${(z) => z.name} value=${(z) => z.revenue} hint=${(z) => `${z.bills} bill`} /></section>

        <section class="card"><h3>Nhóm món</h3>
          <${Bars} rows=${x.categories} label=${(c) => c.name} value=${(c) => c.net} hint=${(c) => `${c.qty} phần`} /></section>

        <section class="card"><h3>Món bán chạy</h3>
          <div class="table-wrap"><table class="list"><thead><tr><th>Món</th><th class="r">Phần</th><th class="r">Tiền</th><th class="r">%</th></tr></thead>
          <tbody>${(showAll ? x.items : x.items.slice(0, 10)).map((i, n) => html`<tr><td>${n + 1}. ${i.name}<br /><small class="muted">${i.category}</small></td><td class="r">${i.qty}</td><td class="r">${k(i.net)}</td><td class="r">${i.share.toLocaleString('vi-VN')}</td></tr>`)}</tbody></table></div>
          ${x.items.length > 10 ? html`<button class="small" onClick=${() => setShowAll(!showAll)}>${showAll ? 'Thu gọn' : `Xem cả ${x.items.length} món`}</button>` : null}
        </section>

        <section class="card"><h3>Món bán ít / không bán</h3>
          ${x.items.length > 10 ? html`<p class="small">Bán ít nhất: ${x.items.slice(-5).reverse().map((i) => `${i.name} (${i.qty})`).join(' · ')}</p>` : null}
          ${x.not_sold.length ? html`<details><summary class="small"><b>${x.not_sold.length}/${x.menu_count} món</b> không bán được phần nào</summary>
            <p class="small">${x.not_sold.map((m) => m.name).join(' · ')}</p></details>` : html`<p class="small ok-text">Món nào cũng có người gọi.</p>`}
          <p class="muted small">Món ế lâu ngày: cân nhắc bỏ khỏi thực đơn hoặc chạy khuyến mãi; bớt hàng tồn trong kho.</p></section>

        ${x.promos.length ? html`<section class="card"><h3>Khuyến mãi</h3>
          <${Bars} rows=${x.promos} label=${(m) => m.name} value=${(m) => m.amount} hint=${(m) => `${m.count} lần`} /></section>` : null}

        <section class="card"><h3>Theo người mở bàn</h3>
          <${Bars} rows=${x.staff} label=${(m) => m.name} value=${(m) => m.revenue} hint=${(m) => `${m.bills} bill`} /></section>
      `}`}
  </div>`;
}

// Năng suất & chi phí nhân sự (chủ + quản lý)
function LaborReport({ me }) {
  const today = me.today;
  const list = presets(today).filter(([id]) => id !== 'today');
  const [sel, setSel] = useState('7d');
  const [from, to] = list.find((p) => p[0] === sel).slice(2);
  const st = useData(`/api/reports/labor?from=${from}&to=${to}`);
  const x = st.data;
  if (!x) return html`<${Loading} state=${st} />`;
  const s = x.summary;
  const bad = s.pct != null && s.pct > x.target;
  return html`<div class="stack">
    <div class="chips">${list.map(([id, l]) => html`<button class=${`chip ${sel === id ? 'on' : ''}`} onClick=${() => setSel(id)}>${l}</button>`)}</div>
    <div class="row between wrap"><b>${dm(from)} – ${dm(to)}</b><a class="button" href=${`/api/reports/labor.xlsx?from=${from}&to=${to}`} download>⬇ Xuất Excel</a></div>
    <section class="kpis">
      <div class=${`kpi main ${bad ? 'warn' : ''}`}><small>Lương / doanh thu</small><b>${s.pct == null ? '—' : `${s.pct.toLocaleString('vi-VN')}%`}</b><small class=${bad ? 'danger-text' : 'muted'}>mục tiêu ${x.target}% · lương ${money(s.labor_cost)} / doanh thu ${money(s.revenue)}</small></div>
      <div class="kpi"><small>Giờ công</small><b>${s.hours} giờ</b><small class="muted">${s.people} người</small></div>
      <div class="kpi"><small>Doanh thu / 1 giờ công</small><b>${money(s.rev_per_labor_hour)}</b></div>
    </section>
    ${x.over.length ? html`<section class="card warn-card stack"><b>Giờ thừa người → nên cắt ca / cho về sớm</b>
      ${x.over.map((o) => html`<div class="row between small"><span><b>${String(o.hour).padStart(2, '0')}h</b>: TB ${o.staff.toLocaleString('vi-VN')} người, ${o.tables.toLocaleString('vi-VN')} bàn có khách${o.pct != null ? ` · lương ${o.pct.toLocaleString('vi-VN')}% doanh thu giờ đó` : ''}</span><b>bớt ${o.cut} người</b></div>`)}
      <small>Ước tiết kiệm ~<b>${money(x.save_total)}</b> cho ${x.open_days} ngày mở cửa. Sửa ở Lịch ca: rút giờ ca, đổi sang ca gãy, hoặc dồn người sang giờ đông.</small></section>`
      : html`<p class="small ok-text">Không có khung giờ thừa người rõ rệt.</p>`}
    <section class="card"><h3>Người đang làm so với bàn có khách (TB 1 ngày mở cửa)</h3>
      <div class="table-wrap"><table class="list small"><thead><tr><th>Giờ</th><th class="r">Người</th><th class="r">Bàn</th><th class="r">Lương</th><th class="r">Doanh thu</th><th class="r">%</th></tr></thead>
      <tbody>${x.by_hour.map((h) => html`<tr class=${x.over.some((o) => o.hour === h.hour) ? 'warn-row' : ''}><td>${String(h.hour).padStart(2, '0')}h</td><td class="r">${h.staff.toLocaleString('vi-VN')}</td><td class="r">${h.tables.toLocaleString('vi-VN')}</td><td class="r">${k(h.cost)}</td><td class="r">${k(h.revenue)}</td>
        <td class=${`r ${h.pct != null && h.pct > x.target * 1.5 ? 'danger-text' : ''}`}>${h.pct == null ? '—' : h.pct.toLocaleString('vi-VN')}</td></tr>`)}</tbody></table></div></section>
    ${x.flagged.length ? html`<section class="card stack"><b>Cần nhắc</b>${x.flagged.map((f) => html`<div class="small"><b>${f.name}</b>: ${f.flags.join(' · ')}</div>`)}</section>` : null}
    ${x.top.length ? html`<p class="small">Phục vụ doanh thu / giờ cao nhất: <b>${x.top.join(', ')}</b>${x.bottom.length ? html` · thấp nhất: ${x.bottom.join(', ')}` : null}</p>` : null}
    <section class="card"><h3>Từng người</h3>
      <div class="table-wrap"><table class="list small"><thead><tr><th>Tên</th><th class="r">Giờ</th><th class="r">Lương</th><th class="r">Trễ</th><th class="r">DT/giờ</th><th class="r">Món/giờ</th></tr></thead>
      <tbody>${x.people.map((p) => html`<tr><td>${p.name}<br /><small class="muted">${p.team}${p.flags.length ? html` · <span class="danger-text">${p.flags.length} điểm</span>` : ''}</small></td><td class="r">${p.hours.toLocaleString('vi-VN')}</td><td class="r">${k(p.cost)}</td><td class="r">${p.late || ''}</td><td class="r">${p.rev_per_hour ? k(p.rev_per_hour) : ''}</td><td class="r">${p.items_per_hour ? p.items_per_hour.toLocaleString('vi-VN') : ''}</td></tr>`)}</tbody></table></div></section>
    <section class="card"><h3>Theo tổ</h3>
      <${Bars} rows=${x.teams} label=${(t) => t.name} value=${(t) => t.cost} hint=${(t) => `${t.hours} giờ · ${t.pct ?? '?'}%`} /></section>
    <p class="muted small">Chỉ chủ quán và quản lý xem. "Không thao tác" chỉ tính phục vụ / tiếp thực / thu ngân lúc quán đông (từ 5 bàn có khách); bếp làm theo phiếu in nên không tính. Lương tính theo giờ chấm công thật. Số này để nhắc nhở, chưa gắn thưởng phạt.</p>
  </div>`;
}

export function ReportsView({ me, query }) {
  const tab = query?.get('tab') || 'doanhthu';
  return html`<div class="stack">
    <div class="tabs">${[['doanhthu', 'Doanh thu'], ['nhansu', 'Nhân sự'], ['tien', '💰 Tiền hiện có']].map(([k0, l]) => html`<button class=${tab === k0 ? 'on' : ''} onClick=${() => navigate(`/bao-cao?tab=${k0}`)}>${l}</button>`)}</div>
    ${tab === 'nhansu' ? html`<${LaborReport} me=${me} />` : tab === 'tien' ? html`<${MoneyNow} me=${me} />` : html`<${SalesReport} me=${me} />`}
  </div>`;
}
