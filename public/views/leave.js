import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Modal, Field, Loading, dayLabel, ago, atLeast } from '../ui.js';

const STATUS = { pending: ['Chờ duyệt', 'warn'], approved: ['Đã duyệt', 'ok'], rejected: ['Không duyệt', 'bad'], cancelled: ['Đã huỷ', 'muted'] };

// Chủ quán 24/10: không chọn người làm thay — quản lý duyệt / không duyệt, rồi tự sắp xếp lại sơ đồ quán
function Handle({ me, leave, onClose }) {
  const [note, setNote] = useState('');
  const isManager = atLeast(me, 'manager');
  return html`<${Modal} title=${`Đơn nghỉ của ${leave.staff_name}`} onClose=${onClose}>
    <div class="stack">
    <p><b>${dayLabel(leave.shift?.date || leave.date, { long: true })}</b> · ${leave.shift?.text}${leave.shift?.team_name ? ` · ${leave.shift.team_name}` : ''}<br />
      <span class="muted">Lý do: ${leave.reason}</span></p>
    ${isManager ? html`
      <${Field} label="Ghi chú (không bắt buộc)"><input id="lv-note" value=${note} onInput=${(e) => setNote(e.target.value)} /><//>
      <div class="row end">
        <button class="danger" onClick=${async () => { if (await act(() => api('POST', `/api/leave/${leave.id}/decide`, { approve: false, note }), 'Đã từ chối đơn')) onClose(); }}>Không duyệt</button>
        <button class="primary" onClick=${async () => { if (await act(() => api('POST', `/api/leave/${leave.id}/decide`, { approve: true, note }), 'Đã duyệt nghỉ, nhớ sắp xếp lại người')) onClose(); }}>✓ Duyệt nghỉ</button>
      </div>` : html`<p class="muted small">Quản lý sẽ duyệt đơn này.</p>`}
    </div>
  <//>`;
}

export function LeaveView({ me }) {
  const [filter, setFilter] = useState('pending');
  const st = useData(`/api/leave${filter ? `?status=${filter}` : ''}`);
  const [open, setOpen] = useState(null);
  const canHandle = atLeast(me, 'team_lead');
  return html`<div class="stack">
    <div class="tabs">${[['pending', 'Chờ duyệt'], ['approved', 'Đã duyệt'], ['', 'Tất cả']].map(([k, l]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l}</button>`)}</div>
    <p class="muted small">Muốn xin nghỉ? Vào <b>Hôm nay</b> → bấm <b>✋ Xin nghỉ</b> → chọn ca. Duyệt nghỉ thì ca đó bỏ khỏi lịch, quản lý xếp lại người ở Lịch ca.</p>
    ${!st.data ? html`<${Loading} state=${st} />` : st.data.length ? st.data.map((l) => html`<section class=${`card ${canHandle && l.status === 'pending' && l.staff_id !== me.id ? 'click' : ''}`}
        onClick=${() => canHandle && l.status === 'pending' && l.staff_id !== me.id && setOpen(l)}>
      <div class="row between"><b>${l.staff_name}</b><span class=${`pill ${STATUS[l.status][1]}`}>${STATUS[l.status][0]}</span></div>
      <div>${dayLabel(l.shift?.date || l.date, { long: true })} · ${l.shift?.text || 'ca đã bị xoá'}${l.shift?.team_name ? ` · ${l.shift.team_name}` : ''}</div>
      <div class="muted small">Lý do: ${l.reason} · ${ago(l.created_at)}</div>
      ${l.offers.length ? html`<div class="chips">${l.offers.map((o) => html`<span class=${`pill ${OFFER[o.status][1]}`}>${o.staff_name}: ${OFFER[o.status][0]}</span>`)}</div>` : null}
      ${l.replacement_name ? html`<div class="small">Người làm thay: <b>${l.replacement_name}</b></div>` : null}
      ${l.decided_by_name ? html`<div class="muted small">${STATUS[l.status][0]} bởi ${l.decided_by_name}${l.decision_note ? `: ${l.decision_note}` : ''}</div>` : null}
      ${l.status === 'pending' && l.staff_id === me.id ? html`<div class="row end"><button class="small" onClick=${(e) => { e.stopPropagation(); act(() => api('POST', `/api/leave/${l.id}/cancel`), 'Đã huỷ đơn'); }}>Huỷ đơn</button></div>` : null}
      ${canHandle && l.status === 'pending' && l.staff_id !== me.id ? html`<div class="row end"><span class="link">Duyệt / không duyệt →</span></div>` : null}
    </section>`) : html`<div class="empty">Không có đơn nào.</div>`}
    ${open ? html`<${Handle} me=${me} leave=${open} onClose=${() => setOpen(null)} />` : null}
  </div>`;
}
