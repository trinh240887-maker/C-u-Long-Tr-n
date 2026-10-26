import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, hm, dayLabel, addDays, Modal, Field } from '../ui.js';
import { PhotoThumbs, PhotoViewer } from './checklists.js';

const FILTERS = [['pending', 'Chờ duyệt'], ['redo', 'Làm lại'], ['ok', 'Đạt'], ['all', 'Tất cả']];

function RedoForm({ item, onClose }) {
  const [note, setNote] = useState('');
  const send = async () => {
    if (await act(() => api('POST', '/api/checklists/review', { run_id: item.run_id, item_id: item.item_id, status: 'redo', note }), 'Đã báo làm lại')) onClose();
  };
  return html`<${Modal} title=${`Làm lại: ${item.item_text}`} onClose=${onClose}>
    <div class="stack">
      <p class="muted small">${item.done_by_name} sẽ nhận thông báo làm lại, chủ quán cũng được báo.</p>
      <${Field} label="Chỗ chưa đạt"><textarea id="rv-note" rows="3" placeholder="vd Bàn 12 thiếu nĩa, góc trái sàn còn rác" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea><//>
      <div class="chips">${['Thiếu muỗng/đũa/nĩa', 'Chưa sạch', 'Ảnh mờ, chụp lại', 'Chưa đúng vị trí'].map((x) => html`<button class="chip" onClick=${() => setNote(note ? `${note}, ${x.toLowerCase()}` : x)}>${x}</button>`)}</div>
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="danger" disabled=${!note.trim()} onClick=${send}>Báo làm lại</button></div>
    </div>
  <//>`;
}

export function ReviewView({ me, query }) {
  const [date, setDate] = useState(query.get('date') || me.today);
  const [filter, setFilter] = useState('pending');
  const [group, setGroup] = useState('');
  const [view, setView] = useState(null);
  const [redo, setRedo] = useState(null);
  const st = useData(`/api/checklists/review?date=${date}`);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const { items, score } = st.data;
  const keyOf = (x) => x.zone_name || x.position_name || x.team_name || 'Cả quán';
  const groups = [...new Set(items.map(keyOf))];
  const status = (x) => x.review_status || 'pending';
  const list = items.filter((x) => (filter === 'all' || status(x) === filter) && (!group || keyOf(x) === group));
  const count = (k) => items.filter((x) => k === 'all' || status(x) === k).length;
  const ok = (x) => act(() => api('POST', '/api/checklists/review', { run_id: x.run_id, item_id: x.item_id, status: 'ok' }), 'Đã chấm Đạt');
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Hôm trước" onClick=${() => setDate(addDays(date, -1))}>‹</button>
        <b>${dayLabel(date, { long: true })}</b>
        <button class="icon" aria-label="Hôm sau" disabled=${date >= me.today} onClick=${() => setDate(addDays(date, 1))}>›</button>
      </div>
      <span class="muted small">Ảnh tự xoá sau 7 ngày, kết quả chấm vẫn giữ.</span>
    </div>
    <div class="tabs">${FILTERS.map(([k, l]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l} <small>${count(k)}</small></button>`)}</div>
    ${groups.length > 1 ? html`<div class="chips"><button class=${`chip ${!group ? 'on' : ''}`} onClick=${() => setGroup('')}>Mọi khu</button>
      ${groups.map((g) => html`<button class=${`chip ${group === g ? 'on' : ''}`} onClick=${() => setGroup(g)}>${g}</button>`)}</div>` : null}
    ${list.length ? list.map((x) => html`<section class=${`card stack rv rv-${status(x)}`} key=${`${x.run_id}-${x.item_id}`}>
      <div class="row between"><div><b>${x.item_text}</b><br /><small class="muted">${x.title} · ${keyOf(x)}</small></div>
        ${x.review_status === 'ok' ? html`<span class="pill ok">Đạt</span>` : x.review_status === 'redo' ? html`<span class="pill bad">Làm lại</span>` : html`<span class="pill warn">Chờ duyệt</span>`}</div>
      <small class="muted">${x.done_by_name} báo xong lúc ${hm(x.done_at)}${x.value ? ` · ghi: ${x.value}` : ''}</small>
      ${x.photos.length ? html`<${PhotoThumbs} photos=${x.photos} onOpen=${setView} />` : html`<p class="warn-text small">Không có ảnh</p>`}
      ${x.review_status ? html`<small class="muted">${x.reviewed_by_name} chấm lúc ${hm(x.reviewed_at)}${x.review_note ? `: ${x.review_note}` : ''}</small>` : null}
      <div class="row end">
        <button class="danger" onClick=${() => setRedo(x)}>✗ Làm lại</button>
        <button class="primary" disabled=${x.review_status === 'ok'} onClick=${() => ok(x)}>✓ Đạt</button>
      </div>
    </section>`) : html`<div class="empty">${filter === 'pending' ? 'Không còn ảnh nào chờ duyệt.' : 'Không có mục nào.'}</div>`}

    <section class="card">
      <h3>Bảng điểm 7 ngày (${score.from.slice(8)}/${score.from.slice(5, 7)} – ${score.to.slice(8)}/${score.to.slice(5, 7)})</h3>
      ${score.people.length ? html`<div class="table-wrap"><table class="list">
        <thead><tr><th>Người làm</th><th class="r">Đạt</th><th class="r">Làm lại</th><th class="r">Chờ</th><th class="r">Tỉ lệ đạt</th></tr></thead>
        <tbody>${score.people.map((p) => {
          const graded = p.ok + p.redo;
          return html`<tr><td>${p.name}</td><td class="r num">${p.ok}</td><td class=${`r num ${p.redo ? 'warn-text' : ''}`}>${p.redo}</td><td class="r num">${p.pending}</td>
            <td class="r num">${graded ? `${Math.round((p.ok / graded) * 100)}%` : '—'}</td></tr>`;
        })}</tbody></table></div>` : html`<p class="muted small">Chưa có dữ liệu.</p>`}
    </section>
    <${PhotoViewer} photo=${view} onClose=${() => setView(null)} />
    ${redo ? html`<${RedoForm} item=${redo} onClose=${() => setRedo(null)} />` : null}
  </div>`;
}
