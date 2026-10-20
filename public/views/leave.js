import { useState } from 'preact/hooks';
import { html, api, act, useData, Modal, Field, Loading, dayLabel, ago, atLeast } from '../ui.js';

const STATUS = { pending: ['Chờ duyệt', 'warn'], approved: ['Đã duyệt', 'ok'], rejected: ['Không duyệt', 'bad'], cancelled: ['Đã huỷ', 'muted'] };
const OFFER = { invited: ['Đã mời', ''], accepted: ['Nhận làm thay', 'ok'], declined: ['Từ chối', 'muted'], closed: ['Đã đóng', 'muted'] };

function Handle({ me, leave, onClose }) {
  const sug = useData(`/api/leave/${leave.id}/suggestions`);
  const [pick, setPick] = useState([]);
  const [note, setNote] = useState('');
  const [rep, setRep] = useState(leave.offers.find((o) => o.status === 'accepted')?.staff_id || '');
  const isManager = atLeast(me, 'manager');
  const toggle = (id) => setPick(pick.includes(id) ? pick.filter((x) => x !== id) : [...pick, id]);
  return html`<${Modal} title=${`Đơn nghỉ của ${leave.staff_name}`} onClose=${onClose} wide>
    <p><b>${dayLabel(leave.shift?.date || leave.date, { long: true })}</b> · ${leave.shift?.text}${leave.shift?.team_name ? ` · ${leave.shift.team_name}` : ''}<br />
      <span class="muted">Lý do: ${leave.reason}</span></p>
    <h4>Người có thể làm thay</h4>
    ${!sug.data ? html`<${Loading} state=${sug} />` : html`<div class="cands">
      ${sug.data.candidates.filter((c) => c.eligible).map((c) => html`<label class=${`cand ${pick.includes(c.staff_id) ? 'on' : ''}`}>
        <input type="checkbox" checked=${pick.includes(c.staff_id)} disabled=${c.offer === 'invited' || c.offer === 'accepted'} onChange=${() => toggle(c.staff_id)} />
        <span class="grow"><b>${c.name}</b><br /><small class="muted">${c.primary ? 'Cùng tổ' : `Vị trí phụ ${'★'.repeat(c.level)}`} · đã xếp ${c.week_hours} giờ tuần này</small></span>
        ${c.offer ? html`<span class=${`pill ${OFFER[c.offer][1]}`}>${OFFER[c.offer][0]}</span>` : null}
      </label>`)}
      ${!sug.data.candidates.some((c) => c.eligible) ? html`<p class="warn-text">Không có ai phù hợp. Có thể điều người đang trong ca hoặc gọi thêm người.</p>` : null}
      <details><summary class="muted small">Không phù hợp (${sug.data.candidates.filter((c) => !c.eligible).length})</summary>
        <ul class="plain small">${sug.data.candidates.filter((c) => !c.eligible).map((c) => html`<li><b>${c.name}</b>: ${c.reasons.join(', ')}</li>`)}</ul></details>
    </div>
    <div class="row end"><button class="primary" disabled=${!pick.length} onClick=${() => act(() => api('POST', `/api/leave/${leave.id}/invite`, { staff_ids: pick }), 'Đã gửi lời nhờ qua thông báo').then((ok) => ok && setPick([]))}>
      Nhờ ${pick.length || ''} người làm thay</button></div>`}

    ${isManager ? html`<hr /><h4>Duyệt đơn</h4>
      <div class="row">
        <${Field} label="Người làm thay"><select id="lv-rep" value=${rep} onChange=${(e) => setRep(e.target.value)}>
          <option value="">(không có, để trống ca)</option>
          ${(sug.data?.candidates || []).filter((c) => c.eligible).map((c) => html`<option value=${c.staff_id}>${c.name}${c.offer === 'accepted' ? ' (đã nhận)' : ''}</option>`)}
        </select><//>
        <${Field} label="Ghi chú"><input id="lv-note" value=${note} onInput=${(e) => setNote(e.target.value)} /><//>
      </div>
      <div class="row end">
        <button class="danger" onClick=${async () => { if (await act(() => api('POST', `/api/leave/${leave.id}/decide`, { approve: false, note }), 'Đã từ chối đơn')) onClose(); }}>Không duyệt</button>
        <button class="primary" onClick=${async () => { if (await act(() => api('POST', `/api/leave/${leave.id}/decide`, { approve: true, replacement_id: rep || null, note }), 'Đã duyệt')) onClose(); }}>Duyệt nghỉ</button>
      </div>` : html`<p class="muted small">Quản lý sẽ duyệt đơn sau khi có người nhận làm thay.</p>`}
  <//>`;
}

export function LeaveView({ me }) {
  const [filter, setFilter] = useState('pending');
  const st = useData(`/api/leave${filter ? `?status=${filter}` : ''}`);
  const [open, setOpen] = useState(null);
  const canHandle = atLeast(me, 'team_lead');
  return html`<div class="stack">
    <div class="tabs">${[['pending', 'Chờ duyệt'], ['approved', 'Đã duyệt'], ['', 'Tất cả']].map(([k, l]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l}</button>`)}</div>
    <p class="muted small">Muốn xin nghỉ? Vào <b>Hôm nay</b> → mục "Ca của tôi" → bấm <b>Xin nghỉ</b> ở ca đó.</p>
    ${!st.data ? html`<${Loading} state=${st} />` : st.data.length ? st.data.map((l) => html`<section class=${`card ${canHandle && l.status === 'pending' && l.staff_id !== me.id ? 'click' : ''}`}
        onClick=${() => canHandle && l.status === 'pending' && l.staff_id !== me.id && setOpen(l)}>
      <div class="row between"><b>${l.staff_name}</b><span class=${`pill ${STATUS[l.status][1]}`}>${STATUS[l.status][0]}</span></div>
      <div>${dayLabel(l.shift?.date || l.date, { long: true })} · ${l.shift?.text || 'ca đã bị xoá'}${l.shift?.team_name ? ` · ${l.shift.team_name}` : ''}</div>
      <div class="muted small">Lý do: ${l.reason} · ${ago(l.created_at)}</div>
      ${l.offers.length ? html`<div class="chips">${l.offers.map((o) => html`<span class=${`pill ${OFFER[o.status][1]}`}>${o.staff_name}: ${OFFER[o.status][0]}</span>`)}</div>` : null}
      ${l.replacement_name ? html`<div class="small">Người làm thay: <b>${l.replacement_name}</b></div>` : null}
      ${l.decided_by_name ? html`<div class="muted small">${STATUS[l.status][0]} bởi ${l.decided_by_name}${l.decision_note ? `: ${l.decision_note}` : ''}</div>` : null}
      ${l.status === 'pending' && l.staff_id === me.id ? html`<div class="row end"><button class="small" onClick=${(e) => { e.stopPropagation(); act(() => api('POST', `/api/leave/${l.id}/cancel`), 'Đã huỷ đơn'); }}>Huỷ đơn</button></div>` : null}
      ${canHandle && l.status === 'pending' && l.staff_id !== me.id ? html`<div class="row end"><span class="link">Tìm người thay / duyệt →</span></div>` : null}
    </section>`) : html`<div class="empty">Không có đơn nào.</div>`}
    ${open ? html`<${Handle} me=${me} leave=${open} onClose=${() => setOpen(null)} />` : null}
  </div>`;
}
