import { useState, useEffect } from 'preact/hooks';
import { html, api, act, useData, Link, Modal, Field, hm, dt, dayLabel, PHASE_LABEL, ago } from '../ui.js';

export function LeaveForm({ shift, onClose }) {
  const [reason, setReason] = useState('');
  return html`<${Modal} title="Xin nghỉ ca" onClose=${onClose}>
    <p><b>${dayLabel(shift.date, { long: true })}</b> · ${shift.label ? `${shift.label} · ` : ''}${shift.text}</p>
    <${Field} label="Lý do"><textarea id="leave-reason" rows="3" value=${reason} onInput=${(e) => setReason(e.target.value)} placeholder="Ví dụ: ốm, việc gia đình…" /><//>
    <p class="muted small">Tổ trưởng sẽ tìm người làm thay, quản lý duyệt. Bạn vẫn đi làm ca này cho tới khi đơn được duyệt.</p>
    <div class="row end">
      <button onClick=${onClose}>Thôi</button>
      <button class="primary" disabled=${!reason.trim()} onClick=${async () => {
        if (await act(() => api('POST', '/api/leave', { group_id: shift.group_id, reason }), 'Đã gửi đơn xin nghỉ')) onClose();
      }}>Gửi đơn</button>
    </div>
  <//>`;
}

function ClockCard() {
  const st = useData('/api/attendance/me');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  if (!st.data) return html`<section class="card clock"><p class="muted">${st.error || 'Đang tải…'}</p></section>`;
  const { open, next } = st.data;
  if (open) {
    const mins = Math.round((now - open.clock_in) / 60000);
    return html`<section class="card clock on">
      <div><div class="eyebrow">Đang trong ca</div>
        <div class="big">Vào lúc ${hm(open.clock_in)}</div>
        <div class="muted">${Math.floor(mins / 60)} giờ ${mins % 60} phút${open.late_minutes ? ` · trễ ${open.late_minutes} phút` : ''}${open.note ? ` · ${open.note}` : ''}</div></div>
      <button class="solid danger big" onClick=${() => act(() => api('POST', '/api/attendance/clock-out'), 'Đã chấm ra ca')}>Chấm ra</button>
    </section>`;
  }
  return html`<section class="card clock">
    <div><div class="eyebrow">${next ? 'Ca tiếp theo' : 'Hôm nay'}</div>
      <div class="big">${next ? `${next.label ? next.label + ' · ' : ''}${next.text}` : 'Chưa có ca sắp tới'}</div>
      <div class="muted">${next ? dayLabel(next.date, { long: true }) : 'Vẫn chấm công được nếu quản lý gọi đi làm'}</div></div>
    <button class="primary big" onClick=${() => act(async () => {
      const r = await api('POST', '/api/attendance/clock-in');
      return r;
    }, 'Đã chấm vào ca')}>Chấm vào</button>
  </section>`;
}

function Offers() {
  const offers = useData('/api/offers/me');
  if (!offers.data?.length) return null;
  return html`<section class="card attn">
    <h3>Được nhờ làm thay</h3>
    ${offers.data.map((o) => html`<div class="offer">
      <div class="grow"><b>${dayLabel(o.shift.date, { long: true })}</b> · ${o.shift.text}<br />
        <span class="muted">${o.shift.team_name ? `${o.shift.team_name} · ` : ''}thay ${o.for_name}</span></div>
      ${o.status === 'accepted'
        ? html`<span class="pill ok">Đã nhận, chờ duyệt</span>`
        : html`<div class="row"><button onClick=${() => act(() => api('POST', `/api/offers/${o.id}/respond`, { accept: false }), 'Đã từ chối')}>Không</button>
            <button class="primary" onClick=${() => act(() => api('POST', `/api/offers/${o.id}/respond`, { accept: true }), 'Đã nhận ca, chờ quản lý duyệt')}>Nhận ca</button></div>`}
    </div>`)}
  </section>`;
}

export function Home({ me }) {
  const shifts = useData('/api/my-shifts');
  const lists = useData('/api/checklists');
  const tasks = useData('/api/tasks?status=open');
  const notes = useData('/api/notifications');
  const [leaveFor, setLeaveFor] = useState(null);
  const myTasks = (tasks.data || []).filter((t) => t.assignee_id === me.id || (!t.assignee_id && t.team_id === me.team_id));
  const unread = (notes.data || []).filter((n) => !n.read_at).slice(0, 3);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

  return html`<div class="stack">
    <div class="hello">
      <h2>${hour < 11 ? 'Chào buổi sáng' : hour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối'}, ${me.name.replace(/\(.*?\)/g, '').trim().split(' ').at(-1)}</h2>
      <span class="muted">${dayLabel(me.today, { long: true })} · ${me.role_label}${me.team ? ` · ${me.team.name}` : ''}</span>
    </div>
    ${!me.zalo_linked ? html`<${Link} href="/ho-so" class="card hint">Liên kết Zalo để nhận lịch ca và lời nhờ làm thay trên điện thoại →<//>` : null}
    <${ClockCard} />
    ${(() => { const ps = (shifts.data || []).find((s) => s.date === me.today && s.position_name && !s.zone_name);
      return ps ? html`<section class="card hint"><span>▸ Hôm nay bạn đứng vị trí <b>${ps.position_name}</b>${ps.team_name ? ` (${ps.team_name})` : ''} · ${ps.text}</span></section>` : null; })()}
    ${(() => { const z = (shifts.data || []).find((s) => s.date === me.today && s.zone_name);
      return z ? html`<${Link} href="/ban" class="card hint"><span>📍 Hôm nay bạn phụ trách <b>${z.zone_name}</b>${z.tables_text ? `, bàn ${z.tables_text}` : ' (cả khu)'} · ${z.text}. Xem sơ đồ bàn →</span><//>` : null; })()}
    <${Offers} />

    ${unread.length ? html`<section class="card">
      <div class="row between"><h3>Thông báo mới</h3><${Link} href="/ho-so">Xem tất cả<//></div>
      ${unread.map((n) => html`<div class="note"><b>${n.title}</b>${n.body ? html`<div class="muted pre">${n.body}</div>` : null}<small class="muted">${ago(n.created_at)}</small></div>`)}
    </section>` : null}

    <section class="card">
      <div class="row between"><h3>Checklist hôm nay</h3><${Link} href="/checklist">Mở checklist<//></div>
      ${lists.data?.runs?.length ? html`<div class="progress-list">${lists.data.runs.map((r) => html`<${Link} href=${`/checklist#run-${r.run_id}`} class="prog">
          <span class="grow"><b>${r.title}</b><small class="muted"> ${r.team_name}${r.position_name ? ` · ${r.position_name}` : ''}${r.shift_name ? ` · ${r.shift_name}` : ''} · ${PHASE_LABEL[r.phase]}</small></span>
          <span class=${`pill ${r.done === r.total ? 'ok' : ''}`}>${r.done}/${r.total}</span><//>`)}</div>`
        : html`<p class="muted">Không có checklist cho tổ của bạn hôm nay.</p>`}
    </section>

    <section class="card">
      <div class="row between"><h3>Việc của tôi</h3><${Link} href="/viec">Tất cả việc<//></div>
      ${myTasks.length ? myTasks.slice(0, 6).map((t) => html`<div class="task-line">
          <button class="check" aria-label="Xong" onClick=${() => act(() => api('PATCH', `/api/tasks/${t.id}`, { status: 'done' }), 'Đã xong việc')}></button>
          <span class="grow">${t.priority === 1 ? html`<b class="pill bad">Gấp</b> ` : null}${t.title}
            ${t.due_at ? html`<small class=${t.overdue ? 'bad-text' : 'muted'}> · hạn ${dt(t.due_at)}</small>` : null}</span>
        </div>`) : html`<p class="muted">Không có việc nào đang chờ.</p>`}
    </section>

    <section class="card">
      <div class="row between"><h3>Ca của tôi 7 ngày tới</h3><${Link} href="/lich">Lịch cả quán<//></div>
      ${shifts.data?.length ? shifts.data.map((s) => html`<div class="shift-line">
          <span class="date">${dayLabel(s.date)}</span>
          <span class="grow"><b>${s.text}</b>${s.label ? html` <small class="muted">${s.label}</small>` : null}${s.position_name ? html` <small class="pos-tag">▸ ${s.position_name}</small>` : null}${s.zone_name ? html`<br /><small class="zone-tag">📍 ${s.zone_name}${s.tables_text ? ` · bàn ${s.tables_text}` : ' · cả khu'}</small>` : null}${s.team_name ? html`<br /><small class="muted">${s.team_name}${s.note ? ` · ${s.note}` : ''}</small>` : null}</span>
          ${s.leave?.status === 'pending' ? html`<span class="pill warn">Chờ duyệt nghỉ</span>`
            : s.leave?.status === 'approved' ? html`<span class="pill">Đã nghỉ</span>`
            : html`<button class="small" onClick=${() => setLeaveFor(s)}>Xin nghỉ</button>`}
        </div>`) : html`<p class="muted">Chưa có ca nào được xếp.</p>`}
    </section>
    ${leaveFor ? html`<${LeaveForm} shift=${leaveFor} onClose=${() => setLeaveFor(null)} />` : null}
  </div>`;
}
