import { useState } from 'preact/hooks';
import { html, api, act, useData, Loading, hm, dayLabel, addDays, PHASE_LABEL, atLeast, Link } from '../ui.js';
import { Checklists } from './settings.js';

// Nén ảnh trên điện thoại trước khi gửi: cạnh dài tối đa 1280px, JPEG
export async function compressImage(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('Không đọc được ảnh')); i.src = url; });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    let q = 0.72;
    let data = c.toDataURL('image/jpeg', q);
    while (data.length > 1_400_000 && q > 0.35) { q -= 0.12; data = c.toDataURL('image/jpeg', q); }
    return data;
  } finally { URL.revokeObjectURL(url); }
}

export function PhotoThumbs({ photos, onOpen, onDelete }) {
  if (!photos.length) return null;
  return html`<div class="thumbs">${photos.map((p) => (p.deleted_at
    ? html`<span class="thumb gone" title="Ảnh đã tự xoá sau 7 ngày">đã xoá</span>`
    : html`<span class=${`thumb ${p.old ? 'old' : ''}`}><img src=${`/api/photos/${p.id}`} loading="lazy" alt="Ảnh báo cáo" onClick=${() => onOpen?.(p)} />
        ${onDelete ? html`<button class="x" aria-label="Xoá ảnh" onClick=${() => onDelete(p)}>✕</button>` : null}</span>`))}</div>`;
}

export function PhotoViewer({ photo, onClose }) {
  if (!photo) return null;
  return html`<div class="viewer" onClick=${onClose}><img src=${`/api/photos/${photo.id}`} alt="Ảnh báo cáo" /></div>`;
}

function Item({ run, item, disabled, me }) {
  const [val, setVal] = useState(item.entry?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);
  const redo = item.entry?.review_status === 'redo';
  const done = !!item.entry && !redo;
  const since = redo ? item.entry.reviewed_at : 0;
  const photos = item.photos.map((p) => ({ ...p, old: p.created_at <= since }));
  const fresh = photos.filter((p) => !p.deleted_at && !p.old);
  const needPhoto = item.photo_required && !done && !fresh.length;
  const save = (value, isDone = true) => act(() => api('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: item.id, value, done: isDone }));
  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const data = await compressImage(file);
      await act(() => api('POST', '/api/checklists/photo', { run_id: run.run_id, item_id: item.id, data }), 'Đã gửi ảnh');
    } catch (err) { act(() => Promise.reject(err)); } finally { setBusy(false); }
  };
  const del = (p) => confirm('Xoá ảnh này?') && act(() => api('POST', '/api/checklists/photo/delete', { id: p.id }), 'Đã xoá ảnh');
  const status = !item.entry ? null : redo ? null : item.entry.review_status === 'ok' ? html`<span class="pill ok">Đạt</span>`
    : item.photo_required ? html`<span class="pill muted">Chờ duyệt</span>` : null;
  return html`<li class=${`ck ${done ? 'done' : ''} ${redo ? 'redo' : ''}`}>
    ${item.kind === 'check'
      ? html`<button class="check" aria-pressed=${done} aria-label=${item.text} disabled=${disabled || busy || (needPhoto && !done)}
          title=${needPhoto ? 'Chụp ảnh trước' : ''} onClick=${() => save('', !done)}></button>`
      : html`<span class=${`check static ${done ? 'on' : ''}`}></span>`}
    <div class="grow">
      <div>${item.text}${!item.required ? html` <small class="muted">(không bắt buộc)</small>` : null} ${status}</div>
      ${redo ? html`<div class="redo-box"><b>Làm lại:</b> ${item.entry.review_note}<br /><small>${item.entry.reviewed_by_name || ''} · ${hm(item.entry.reviewed_at)}. Sửa xong chụp ảnh mới rồi bấm xong lại.</small></div>` : null}
      ${item.entry?.review_status === 'ok' && item.entry.review_note ? html`<small class="muted">Nhận xét: ${item.entry.review_note}</small>` : null}
      ${item.kind !== 'check' ? html`<div class="row">
        <input id=${`ck-${run.run_id}-${item.id}`} class="inline" inputmode=${item.kind === 'number' ? 'decimal' : 'text'} value=${val} disabled=${disabled}
          placeholder=${item.kind === 'number' ? 'Nhập số' : 'Ghi chú'} onInput=${(e) => setVal(e.target.value)}
          onKeyDown=${(e) => e.key === 'Enter' && save(val)} />
        ${item.unit ? html`<span class="muted">${item.unit}</span>` : null}
        <button class="small" disabled=${disabled || needPhoto || (!val && item.kind === 'number')} onClick=${() => save(val)}>${done ? 'Cập nhật' : 'Lưu'}</button>
        ${done ? html`<button class="small icon" aria-label="Bỏ" disabled=${disabled} onClick=${() => { setVal(''); save('', false); }}>↺</button>` : null}
      </div>` : null}
      <${PhotoThumbs} photos=${photos} onOpen=${setView} onDelete=${!disabled && (!item.entry || redo) ? (p) => (p.staff_id === me.id || atLeast(me, 'shift_lead')) && del(p) : null} />
      ${!disabled && (!done || item.photo_required === false) && (item.photo_required || item.kind === 'check') && !done ? html`<label class=${`btn-photo ${needPhoto ? 'need' : ''}`}>
        <input type="file" accept="image/*" capture="environment" hidden onChange=${upload} />
        ${busy ? 'Đang gửi ảnh…' : fresh.length ? '📷 Chụp thêm' : item.photo_required ? '📷 Chụp ảnh (bắt buộc)' : '📷 Chụp ảnh'}</label>` : null}
      ${item.entry ? html`<small class="muted">${item.entry.done_by_name} · ${hm(item.entry.done_at)}</small>` : null}
    </div>
    <${PhotoViewer} photo=${view} onClose=${() => setView(null)} />
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
      ${atLeast(me, 'team_lead') ? html`<div class="row"><${Link} href="/duyet-anh" class="btn-link">Duyệt ảnh<//><button class="primary" onClick=${() => setManage(true)}>Tạo / sửa checklist</button></div>` : null}
      <div class="tabs">${[['', 'Tất cả'], ['open', 'Mở ca'], ['during', 'Trong ca'], ['close', 'Đóng ca']].map(([k, l]) => html`<button class=${phase === k ? 'on' : ''} onClick=${() => setPhase(k)}>${l}</button>`)}</div>
    </div>
    ${runs.length ? runs.map((r) => html`<section class="card" id=${`run-${r.run_id}`}>
      <div class="row between"><div><h3>${r.title}</h3><small class="muted">${r.team_name}${r.position_name ? ` · ${r.position_name}` : ''}${r.zone_name ? ` · 📍 ${r.zone_name}` : ''} · ${r.shift_name || 'Mọi ca'} · ${PHASE_LABEL[r.phase]}</small></div>
        <span class=${`pill ${r.redo ? 'bad' : r.done === r.total ? 'ok' : r.done ? 'warn' : ''}`}>${r.redo ? `${r.redo} việc làm lại` : r.done === r.total ? 'Xong' : `${r.done}/${r.total}`}</span></div>
      <div class="meter wide"><span style=${`width:${r.total ? Math.round((r.done / r.total) * 100) : 0}%`} class=${r.done === r.total ? 'full' : ''}></span></div>
      <ul class="cklist">${r.items.map((i) => html`<${Item} key=${`${r.run_id}-${i.id}-${i.entry?.done_at || 0}`} run=${r} item=${i} disabled=${old} me=${me} />`)}</ul>
    </section>`) : html`<div class="empty">Không có checklist nào cho tổ của bạn.${atLeast(me, 'manager') ? ' Tạo checklist trong Cài đặt → Checklist.' : ''}</div>`}
  </div>`;
}
