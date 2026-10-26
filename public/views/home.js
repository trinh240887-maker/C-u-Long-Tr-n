import { compressImage } from './checklists.js';
import { useState, useEffect } from 'preact/hooks';
import { html, api, act, useData, Link, Modal, Field, Confirm, hm, dt, dayLabel, PHASE_LABEL, ago } from '../ui.js';
import { MyCashCard } from './pay.js';
import { PendingBookCard } from './daybook.js';
import { MyJobsCard } from './jobs.js';

export function LeaveForm({ shift, onClose }) {
  const [reason, setReason] = useState('');
  return html`<${Modal} title="Xin nghỉ ca" onClose=${onClose}>
    <p><b>${dayLabel(shift.date, { long: true })}</b> · ${shift.label ? `${shift.label} · ` : ''}${shift.text}</p>
    <${Field} label="Lý do"><textarea id="leave-reason" rows="3" value=${reason} onInput=${(e) => setReason(e.target.value)} placeholder="Ví dụ: ốm, việc gia đình…" /><//>
    <p class="muted small">Quản lý sẽ duyệt đơn. Bạn vẫn đi làm ca này cho tới khi đơn được duyệt.</p>
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
  const [ask, setAsk] = useState(false);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  if (!st.data) return html`<section class="card clock"><p class="muted">${st.error || 'Đang tải…'}</p></section>`;
  const { open, next, undo_out: undo } = st.data;
  const out = async () => act(async () => api('POST', '/api/attendance/clock-out', { ...(st.data.gps ? await myPlace() : {}), confirm: true }), 'Đã chấm ra ca');
  if (open) {
    const mins = Math.round((now - open.clock_in) / 60000);
    return html`<section class="card clock on">
      <div><div class="eyebrow">Đang trong ca</div>
        <div class="big">Vào lúc ${hm(open.clock_in)}</div>
        <div class="muted">${Math.floor(mins / 60)} giờ ${mins % 60} phút${open.late_minutes ? ` · trễ ${open.late_minutes} phút` : ''}${open.note ? ` · ${open.note}` : ''}</div></div>
      ${open.need_photo ? html`<${LatePhoto} late=${open.late_minutes} />` : null}
      <button class="solid danger big" onClick=${() => setAsk(true)}>Chấm ra</button>
      ${ask ? html`<${Confirm} danger yes="Chấm ra" onClose=${() => setAsk(false)} onYes=${() => { setAsk(false); out(); }}
        text=${`Chấm ra lúc ${hm(now)}?${mins < 10 ? ` Bạn vừa chấm vào ${mins} phút trước.` : ''} Chỉ bấm khi đã hết ca, về sớm sẽ bị trừ lương.`} />` : null}
    </section>`;
  }
  return html`<section class="card clock">
    ${undo ? html`<div class="card tight stack" style="border:2px solid var(--danger, #c92a2a)"><b>Bạn vừa chấm ra lúc ${hm(undo.clock_out)}</b>
      <small class="muted">Lỡ bấm nhầm khi đang làm? Huỷ để tiếp tục ca (trong 30 phút).</small>
      <button class="primary big" onClick=${() => act(() => api('POST', '/api/attendance/undo-out', {}), 'Đã huỷ chấm ra, tiếp tục ca')}>↩ Huỷ chấm ra, tiếp tục ca</button></div>` : null}
    <div><div class="eyebrow">${next ? 'Ca tiếp theo' : 'Hôm nay'}</div>
      <div class="big">${next ? `${next.label ? next.label + ' · ' : ''}${next.text}` : 'Chưa có ca sắp tới'}</div>
      <div class="muted">${next ? dayLabel(next.date, { long: true }) : 'Chưa có ca thì chưa chấm công được: báo lịch rảnh hoặc nhờ quản lý thêm ca'}</div></div>
    <button class="primary big" onClick=${() => act(async () => {
      const r = await api('POST', '/api/attendance/clock-in', st.data.gps ? await myPlace() : {});
      return r;
    }, 'Đã chấm vào ca')}>Chấm vào</button>
  </section>`;
}

// Vào trễ: tự chụp ảnh đội nón + cầm 2 khăn (tổ trưởng chỉ chụp chung các bạn vào đúng ca)
function LatePhoto({ late }) {
  const [busy, setBusy] = useState(false);
  const up = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try { const data = await compressImage(file); await act(() => api('POST', '/api/attendance/late-photo', { data }), 'Đã gửi ảnh'); } finally { setBusy(false); }
  };
  return html`<div class="late-photo"><b>⚠ Bạn vào trễ ${late} phút</b><span class="small">Chụp 1 ảnh tự sướng: đội nón + cầm 2 khăn sạch.</span>
    <label class=${`button primary ${busy ? 'muted' : ''}`}>📷 ${busy ? 'Đang gửi…' : 'Chụp ảnh nón + khăn'}<input type="file" accept="image/*" capture="user" hidden onChange=${up} /></label></div>`;
}

// Lấy vị trí điện thoại để chấm công (quán bật kiểm tra vị trí). Không cho phép / lỗi → gửi rỗng, máy chủ thử theo wifi quán
function myPlace() {
  return new Promise((done) => {
    if (!navigator.geolocation) return done({});
    navigator.geolocation.getCurrentPosition((p) => done({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
      () => done({}), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
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
  const promos = useData('/api/promotions');
  const must = ['staff', 'team_lead', 'shift_lead'].includes(me.role);
  const avail = useData(must ? '/api/availability/me' : null);
  const [leaveFor, setLeaveFor] = useState(null);
  const [pickLeave, setPickLeave] = useState(false);
  const myTasks = (tasks.data || []).filter((t) => t.assignee_id === me.id || (!t.assignee_id && t.team_id === me.team_id));
  // Khuyến mãi đã có thẻ 🎁 ở trên → không lặp trong Thông báo mới
  const unread = (notes.data || []).filter((n) => !n.read_at && n.link !== '/khuyen-mai').slice(0, 3);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

  return html`<div class="stack">
    <div class="hello">
      <h2>${hour < 11 ? 'Chào buổi sáng' : hour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối'}, ${me.name.replace(/\(.*?\)/g, '').trim().split(' ').at(-1)}</h2>
      <span class="muted">${dayLabel(me.today, { long: true })} · ${me.role_label}${me.team ? ` · ${me.team.name}` : ''}</span>
    </div>
    ${!me.zalo_linked ? html`<${Link} href="/ho-so" class="card hint">Liên kết Zalo để nhận lịch ca và lời nhờ làm thay trên điện thoại →<//>` : null}
    <${PendingBookCard} me=${me} />
    <${MyCashCard} />
    <${ClockCard} />
    <${MyJobsCard} />
    ${(() => { const ps = (promos.data?.items || []).filter((p) => p.status === 'running' || p.status === 'upcoming');
      return ps.length ? html`<${Link} href="/khuyen-mai" class="card promo-card stack"><b>🎁 Khuyến mãi</b>${ps.map((p) => html`<span><b>${p.name}</b>${p.status === 'upcoming' ? ' (sắp tới)' : ''}: ${p.summary}${p.note ? ` · ${p.note}` : ''}</span>`)}<//>` : null; })()}
    <${Link} href="/ban" class="card order-cta"><b>🍽 Order bàn</b><span>Bấm bàn trống để gọi món · đặt bàn ở Thêm → Đặt bàn →</span><//>
    ${avail.data && avail.data.must && !avail.data.submitted_at ? html`<${Link} href="/ranh" class=${`card hint ${avail.data.late ? 'bad' : ''}`}><span>
      ◷ ${avail.data.late ? 'Đã quá hạn, bạn' : 'Bạn'} chưa báo <b>lịch rảnh tuần sau</b> (${avail.data.week_start.slice(8)}/${avail.data.week_start.slice(5, 7)}).
      Hạn ${avail.data.deadline.time} ngày ${avail.data.deadline.date.slice(8)}/${avail.data.deadline.date.slice(5, 7)}. Bấm để báo →</span><//>` : null}
    ${(() => { const ps = (shifts.data || []).find((s) => s.date === me.today && s.position_name && !s.zone_name);
      return ps ? html`<section class="card hint"><span>▸ Hôm nay bạn đứng vị trí <b>${ps.position_name}</b>${ps.team_name ? ` (${ps.team_name})` : ''} · ${ps.text}</span></section>` : null; })()}
    ${(() => { const z = (shifts.data || []).find((s) => s.date === me.today && s.zone_name);
      return z ? html`<${Link} href="/ban" class="card hint"><span>📍 Hôm nay bạn phụ trách <b>${z.zone_name}</b>${z.tables_text ? `, bàn ${z.tables_text}` : ''} · ${z.text}. Xem sơ đồ bàn →</span><//>` : null; })()}
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
      <div class="row between"><h3>Ca của tôi 7 ngày tới</h3><${Link} href="/lich">${me.role === 'staff' ? 'Xem cả tuần' : 'Lịch cả quán'}<//></div>
      ${shifts.data?.length ? shifts.data.map((s) => html`<div class="shift-line">
          <span class="date">${dayLabel(s.date)}</span>
          <span class="grow"><b>${s.text}</b>${s.label ? html` <small class="muted">${s.label}</small>` : null}${s.position_name ? html` <small class="pos-tag">▸ ${s.position_name}</small>` : null}${s.zone_name ? html`<br /><small class="zone-tag">📍 ${s.zone_name}${s.tables_text ? ` · bàn ${s.tables_text}` : ''}</small>` : null}${s.team_name ? html`<br /><small class="muted">${s.team_name}${s.note && s.note !== 'Theo lịch rảnh' ? ` · ${s.note}` : ''}</small>` : null}</span>
          ${s.leave?.status === 'pending' ? html`<span class="pill warn">Chờ duyệt nghỉ</span>`
            : s.leave?.status === 'approved' ? html`<span class="pill">Đã nghỉ</span>`
            : null}
        </div>`) : html`<p class="muted">Chưa có ca nào được xếp.</p>`}
    </section>
    ${(shifts.data || []).some((x) => !x.leave) ? html`<button onClick=${() => setPickLeave(true)}>✋ Xin nghỉ</button>` : null}
    ${pickLeave ? html`<${Modal} title="Xin nghỉ ca nào?" onClose=${() => setPickLeave(false)}><div class="stack">
      ${(shifts.data || []).filter((x) => !x.leave).map((x) => html`<button class="tpl-row" onClick=${() => { setPickLeave(false); setLeaveFor(x); }}><b class="grow">${dayLabel(x.date)}</b><span>${x.text}</span></button>`)}
    </div><//>` : null}
    ${leaveFor ? html`<${LeaveForm} shift=${leaveFor} onClose=${() => setLeaveFor(null)} />` : null}
  </div>`;
}
