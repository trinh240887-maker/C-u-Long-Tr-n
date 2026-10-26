import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Modal, Field, Loading, dt, atLeast, ago } from '../ui.js';

const PRI = { 1: ['Gấp', 'bad'], 2: ['Thường', ''], 3: ['Thấp', 'muted'] };
const ST = { todo: 'Cần làm', doing: 'Đang làm', done: 'Xong' };

function TaskForm({ me, staff, onClose }) {
  const teams = me.role === 'team_lead' ? me.teams.filter((t) => t.id === me.team?.id) : me.teams;
  const people = me.role === 'team_lead' ? staff.filter((s) => s.team_id === me.team?.id) : staff;
  const [f, setF] = useState({ title: '', detail: '', assignee_id: '', team_id: teams.length === 1 ? teams[0].id : '', priority: 2, due_at: '' });
  const set = (k, v) => setF({ ...f, [k]: v });
  const save = async () => {
    const ok = await act(() => api('POST', '/api/tasks', { ...f, assignee_id: f.assignee_id || null, team_id: f.team_id || null, due_at: f.due_at || null }), 'Đã giao việc');
    if (ok) onClose();
  };
  return html`<${Modal} title="Giao việc" onClose=${onClose}>
    <div class="stack">
      <${Field} label="Việc cần làm"><input id="tk-title" value=${f.title} onInput=${(e) => set('title', e.target.value)} placeholder="Ví dụ: Vệ sinh hút mùi bếp steak" /><//>
      <${Field} label="Mô tả (tuỳ chọn)"><textarea id="tk-detail" rows="2" value=${f.detail} onInput=${(e) => set('detail', e.target.value)} /><//>
      <div class="row">
        <${Field} label="Giao cho người"><select id="tk-who" value=${f.assignee_id} onChange=${(e) => set('assignee_id', e.target.value)}>
          <option value="">(cả tổ)</option>${people.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
        <${Field} label="Hoặc cả tổ"><select id="tk-team" value=${f.team_id} onChange=${(e) => set('team_id', e.target.value)}>
          <option value="">(chọn tổ)</option>${teams.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
      </div>
      <div class="row">
        <${Field} label="Hạn chót"><input id="tk-due" type="datetime-local" value=${f.due_at} onInput=${(e) => set('due_at', e.target.value)} /><//>
        <${Field} label="Mức ưu tiên"><select id="tk-pri" value=${f.priority} onChange=${(e) => set('priority', Number(e.target.value))}>
          <option value="1">Gấp</option><option value="2">Thường</option><option value="3">Thấp</option></select><//>
      </div>
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" disabled=${!f.title.trim()} onClick=${save}>Giao việc</button></div>
    </div>
  <//>`;
}

export function TasksView({ me }) {
  const [filter, setFilter] = useState('open');
  const st = useData(`/api/tasks?status=${filter}`);
  const staff = useData('/api/staff');
  const [form, setForm] = useState(false);
  const canAssign = atLeast(me, 'team_lead');
  const canDelete = (t) => t.created_by === me.id || atLeast(me, 'shift_lead');
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="tabs">${[['open', 'Đang mở'], ['done', 'Đã xong (14 ngày)']].map(([k, l]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l}</button>`)}</div>
      ${canAssign ? html`<button class="primary" onClick=${() => setForm(true)}>+ Giao việc</button>` : null}
    </div>
    ${!st.data ? html`<${Loading} state=${st} />` : st.data.length ? st.data.map((t) => html`<section class=${`card task ${t.overdue ? 'over' : ''}`}>
      <div class="row">
        <button class=${`check ${t.status === 'done' ? 'on' : ''}`} aria-label="Xong" onClick=${() => act(() => api('PATCH', `/api/tasks/${t.id}`, { status: t.status === 'done' ? 'todo' : 'done' }))}></button>
        <div class="grow">
          <b class=${t.status === 'done' ? 'strike' : ''}>${t.title}</b> <span class=${`pill ${PRI[t.priority][1]}`}>${PRI[t.priority][0]}</span>
          ${t.detail ? html`<div class="muted pre small">${t.detail}</div>` : null}
          <div class="muted small">${t.assignee_name || (t.team_name ? `Cả tổ ${t.team_name}` : '')} · giao bởi ${t.created_by_name || '—'} ${ago(t.created_at)}
            ${t.due_at ? html` · <span class=${t.overdue ? 'bad-text' : ''}>hạn ${dt(t.due_at)}</span>` : null}
            ${t.done_by_name ? ` · xong bởi ${t.done_by_name}` : ''}</div>
        </div>
        ${t.status !== 'done' ? html`<select class="small" aria-label="Trạng thái" value=${t.status} onChange=${(e) => act(() => api('PATCH', `/api/tasks/${t.id}`, { status: e.target.value }))}>
          ${Object.entries(ST).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>` : null}
        ${canDelete(t) ? html`<button class="icon" aria-label="Xoá việc" onClick=${() => act(() => api('DELETE', `/api/tasks/${t.id}`), 'Đã xoá việc')}>🗑</button>` : null}
      </div>
    </section>`) : html`<div class="empty">${filter === 'open' ? 'Không có việc nào đang mở.' : 'Chưa có việc nào xong.'}</div>`}
    ${form && staff.data ? html`<${TaskForm} me=${me} staff=${staff.data.filter((s) => s.active)} onClose=${() => setForm(false)} />` : null}
  </div>`;
}
