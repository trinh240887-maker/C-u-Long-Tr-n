import { useState } from 'preact/hooks';
import { html, api, act, useData, Loading, hm, dayLabel, addDays, PHASE_LABEL, atLeast } from '../ui.js';
import { Checklists } from './settings.js';

function Item({ run, item, disabled }) {
  const [val, setVal] = useState(item.entry?.value ?? '');
  const done = !!item.entry;
  const save = (value, isDone = true) => act(() => api('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: item.id, value, done: isDone }));
  return html`<li class=${`ck ${done ? 'done' : ''}`}>
    ${item.kind === 'check'
      ? html`<button class="check" aria-pressed=${done} aria-label=${item.text} disabled=${disabled} onClick=${() => save('', !done)}></button>`
      : html`<span class=${`check static ${done ? 'on' : ''}`}></span>`}
    <div class="grow">
      <div>${item.text}${!item.required ? html` <small class="muted">(không bắt buộc)</small>` : null}</div>
      ${item.kind !== 'check' ? html`<div class="row">
        <input id=${`ck-${run.run_id}-${item.id}`} class="inline" inputmode=${item.kind === 'number' ? 'decimal' : 'text'} value=${val} disabled=${disabled}
          placeholder=${item.kind === 'number' ? 'Nhập số' : 'Ghi chú'} onInput=${(e) => setVal(e.target.value)}
          onKeyDown=${(e) => e.key === 'Enter' && save(val)} />
        ${item.unit ? html`<span class="muted">${item.unit}</span>` : null}
        <button class="small" disabled=${disabled || (!val && item.kind === 'number')} onClick=${() => save(val)}>${done ? 'Cập nhật' : 'Lưu'}</button>
        ${done ? html`<button class="small icon" aria-label="Bỏ" disabled=${disabled} onClick=${() => { setVal(''); save('', false); }}>↺</button>` : null}
      </div>` : null}
      ${item.entry ? html`<small class="muted">${item.entry.done_by_name} · ${hm(item.entry.done_at)}</small>` : null}
    </div>
  </li>`;
}

export function ChecklistView({ me }) {
  const [date, setDate] = useState(me.today);
  const st = useData(`/api/checklists?date=${date}`);
  const [phase, setPhase] = useState('');
  const [manage, setManage] = useState(false);
  const old = date < me.today && !atLeast(me, 'shift_lead');
  if (!st.data) return html`<${Loading} state=${st} />`;
  if (manage) return html`<div class="stack"><div class="row between"><h2>Tạo & sửa checklist</h2><button onClick=${() => setManage(false)}>← Về checklist hôm nay</button></div>
    <${Checklists} me=${me} teams=${me.teams} /></div>`;
  const runs = st.data.runs.filter((r) => !phase || r.phase === phase);
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Hôm trước" onClick=${() => setDate(addDays(date, -1))}>‹</button>
        <b>${dayLabel(date, { long: true })}</b>
        <button class="icon" aria-label="Hôm sau" disabled=${date >= me.today} onClick=${() => setDate(addDays(date, 1))}>›</button>
      </div>
      ${atLeast(me, 'team_lead') ? html`<button class="primary" onClick=${() => setManage(true)}>Tạo / sửa checklist</button>` : null}
      <div class="tabs">${[['', 'Tất cả'], ['open', 'Mở ca'], ['during', 'Trong ca'], ['close', 'Đóng ca']].map(([k, l]) => html`<button class=${phase === k ? 'on' : ''} onClick=${() => setPhase(k)}>${l}</button>`)}</div>
    </div>
    ${runs.length ? runs.map((r) => html`<section class="card" id=${`run-${r.run_id}`}>
      <div class="row between"><div><h3>${r.title}</h3><small class="muted">${r.team_name} · ${r.shift_name || 'Mọi ca'} · ${PHASE_LABEL[r.phase]}</small></div>
        <span class=${`pill ${r.done === r.total ? 'ok' : r.done ? 'warn' : ''}`}>${r.done === r.total ? 'Xong' : `${r.done}/${r.total}`}</span></div>
      <div class="meter wide"><span style=${`width:${r.total ? Math.round((r.done / r.total) * 100) : 0}%`} class=${r.done === r.total ? 'full' : ''}></span></div>
      <ul class="cklist">${r.items.map((i) => html`<${Item} key=${`${r.run_id}-${i.id}-${i.entry?.done_at || 0}`} run=${r} item=${i} disabled=${old} />`)}</ul>
    </section>`) : html`<div class="empty">Không có checklist nào cho tổ của bạn.${atLeast(me, 'manager') ? ' Tạo checklist trong Cài đặt → Checklist.' : ''}</div>`}
  </div>`;
}
