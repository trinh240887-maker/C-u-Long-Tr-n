import { html, useData, Link, Loading, hm, dt, dayLabel, PHASE_LABEL } from '../ui.js';

const STATUS = {
  working: ['Đang làm', 'ok'], upcoming: ['Sắp vào', ''], late: ['Chưa vào', 'warn'], absent: ['Vắng', 'bad'],
  done: ['Đã xong', 'muted'], break: ['Nghỉ giữa ca', ''], leave: ['Nghỉ phép', 'muted'],
};

function StockCard() {
  const st = useData('/api/stock/alerts');
  if (!st.data) return null;
  const a = st.data;
  const rows = [
    [a.out.length, 'nguyên liệu đã hết', 'bad', '/kho?tab=ton'], [a.low.length, 'sắp hết (không đủ cho mai)', 'warn', '/kho?tab=ton'],
    [a.expiring.length, 'lô sắp/đã hết hạn', 'warn', '/kho?tab=ton'], [a.po_submitted, 'đơn đặt hàng chờ duyệt', 'warn', '/kho?tab=dat'],
    [a.po_approved, 'đơn đã duyệt chờ hàng về', '', '/kho?tab=dat'], [a.transfers_requested, 'phiếu lĩnh chờ kho tổng xuất', 'warn', '/kho?tab=linh'],
    [a.transfers_sent, 'phiếu lĩnh chờ khu nhận', '', '/kho?tab=linh'],
  ].filter((x) => x[0]);
  return html`<section class="card">
    <div class="row between"><h3>Kho</h3><${Link} href="/kho">Mở kho<//></div>
    ${rows.length ? rows.map(([n, l, tone, href]) => html`<${Link} href=${href} class="person"><span class="grow">${l}</span><span class=${`pill ${tone}`}>${n}</span><//>`)
      : html`<p class="muted">Kho ổn, không có cảnh báo.</p>`}
    ${a.out.length || a.low.length ? html`<div class="muted small">${[...a.out, ...a.low].slice(0, 6).map((x) => x.name).join(', ')}</div>` : null}
  </section>`;
}

export function Dashboard() {
  const st = useData('/api/dashboard');
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const tiles = [
    ['Đang làm', d.counts.working, 'ok'], ['Chưa vào ca', d.counts.late, d.counts.late ? 'warn' : ''],
    ['Vắng', d.counts.absent, d.counts.absent ? 'bad' : ''], ['Xin nghỉ chờ duyệt', d.pending_leave.length, d.pending_leave.length ? 'warn' : ''],
    ['Việc quá hạn', d.overdue.length, d.overdue.length ? 'bad' : ''],
  ];
  return html`<div class="stack">
    <div class="row between"><h2>${dayLabel(d.today, { long: true })}</h2><span class="muted">${d.counts.scheduled} người có lịch hôm nay</span></div>
    <div class="tiles">${tiles.map(([label, n, tone]) => html`<div class=${`tile ${tone}`}><div class="n">${n}</div><div class="l">${label}</div></div>`)}</div>

    ${d.gaps.length ? html`<section class="card attn">
      <h3>Thiếu người 7 ngày tới</h3>
      <div class="chips">${d.gaps.map((g) => html`<${Link} href=${`/lich?week=${g.date}`} class="pill warn">${dayLabel(g.date)} · ${g.team_name} ${g.have}/${g.need}<//>`)}</div>
    </section>` : null}

    <div class="cols">
      <section class="card">
        <h3>Ai đang trong ca</h3>
        ${d.teams.filter((t) => t.people.length).map((t) => html`<div class="team-block">
          <div class="team-name">${t.name} <small class="muted">${t.people.filter((p) => p.status !== 'leave').length}${t.min_staff ? `/${t.min_staff}` : ''}</small></div>
          ${t.people.map((p) => html`<div class="person">
            <span class="grow"><b>${p.staff_name}</b> <small class="muted">${p.text}${p.position_name ? ` · ${p.position_name}` : ''}${p.zone_name ? ` · 📍 ${p.zone_name}${p.tables_text ? ` bàn ${p.tables_text}` : ''}` : ''}</small>
              ${p.leave_pending ? html` <small class="pill warn">xin nghỉ</small>` : null}
              ${p.late_minutes ? html` <small class="bad-text">trễ ${p.late_minutes}′</small>` : null}</span>
            <span class=${`pill ${STATUS[p.status][1]}`}>${STATUS[p.status][0]}${p.status === 'working' && p.clock_in ? ` ${hm(p.clock_in)}` : ''}</span>
          </div>`)}
        </div>`)}
        ${d.unscheduled.length ? html`<div class="team-block"><div class="team-name">Ngoài lịch</div>
          ${d.unscheduled.map((u) => html`<div class="person"><span class="grow"><b>${u.staff_name}</b></span><span class="pill">${hm(u.clock_in)}${u.clock_out ? `–${hm(u.clock_out)}` : ''}</span></div>`)}</div>` : null}
        ${!d.counts.scheduled && !d.unscheduled.length ? html`<p class="muted">Hôm nay chưa xếp ca. <${Link} href="/lich">Mở lịch ca<//></p>` : null}
      </section>

      <div class="stack">
        <${StockCard} />
        <section class="card">
          <div class="row between"><h3>Checklist theo tổ</h3><${Link} href="/checklist">Chi tiết<//></div>
          ${d.checklists.filter((c) => c.total).map((c) => {
            const pct = Math.round((c.done / c.total) * 100);
            return html`<div class="meter-row">
              <span class="name">${c.team_name}</span>
              <span class="meter"><span style=${`width:${pct}%`} class=${pct === 100 ? 'full' : ''}></span></span>
              <span class="num">${c.done}/${c.total}</span>
            </div>
            <div class="sub muted small">${c.runs.map((r) => `${r.shift_name ? `${r.shift_name} ` : ''}${PHASE_LABEL[r.phase]} ${r.done}/${r.total}`).join(' · ')}</div>`;
          })}
          ${!d.checklists.some((c) => c.total) ? html`<p class="muted">Chưa có checklist. <${Link} href="/cai-dat?tab=checklist">Tạo checklist<//></p>` : null}
        </section>

        <section class="card">
          <div class="row between"><h3>Xin nghỉ chờ duyệt</h3><${Link} href="/nghi">Xử lý<//></div>
          ${d.pending_leave.length ? d.pending_leave.map((l) => html`<div class="person"><span class="grow"><b>${l.staff_name}</b> <small class="muted">${dayLabel(l.date)} · ${l.reason}</small></span>
            ${l.accepted ? html`<span class="pill ok">${l.accepted} người nhận thay</span>` : html`<span class="pill warn">Chưa có người thay</span>`}</div>`)
            : html`<p class="muted">Không có đơn nào.</p>`}
        </section>

        <section class="card">
          <div class="row between"><h3>Việc quá hạn</h3><${Link} href="/viec">${d.open_tasks} việc đang mở<//></div>
          ${d.overdue.length ? d.overdue.map((t) => html`<div class="person"><span class="grow"><b>${t.title}</b> <small class="muted">${t.assignee_name || t.team_name || ''}</small></span>
            <span class="pill bad">hạn ${dt(t.due_at)}</span></div>`) : html`<p class="muted">Không có việc quá hạn.</p>`}
        </section>
      </div>
    </div>
  </div>`;
}
