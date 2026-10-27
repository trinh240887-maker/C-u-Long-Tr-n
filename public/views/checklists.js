import { useState } from '../vendor/hooks.js';
import { html, api, act, toast, useData, Loading, hm, dayLabel, addDays, PHASE_LABEL, atLeast, Link, navigate } from '../ui.js';
import { Checklists } from './settings.js';

// Nén ảnh trên điện thoại trước khi gửi: cạnh dài tối đa 1280px, JPEG
// Bật "Giao việc từng người" cho checklist này: bộ phận của checklist + Tiếp thực (nếu có) làm chung → mở Bảng khu để phân việc
async function toJobs(me, r) {
  const tt = (me.teams || []).find((t) => /tiếp thực|tiep thuc/i.test(t.name));
  const pv = r.team_id && /phục vụ|phuc vu/i.test(r.team_name);
  const teams = [...new Set([r.team_id, pv ? tt?.id : null, pv ? -1 : null].filter(Boolean))];
  if (!confirm(`Chuyển "${r.title}" sang giao việc từng người?\nMỗi việc thành 1 thẻ, app gợi ý ai làm theo khu đã phân, nhân viên bấm Nhận → Xong. Checklist này sẽ không còn hiện ở đây mà nằm ở Việc ca.`)) return;
  const ok = await act(() => api('PATCH', `/api/checklist-templates/${r.template_id}`, { job_mode: true, job_teams: teams }), 'Đã chuyển, mở Bảng khu để phân việc');
  if (ok) navigate('/viec-ca?tab=khu');
}

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

// Ảnh mẫu: nhân viên bấm xem để làm đúng chuẩn; tổ trưởng / quản lý chụp thêm hoặc xoá
export function Samples({ samples, templateId, itemId, canEdit, label = 'Ảnh mẫu' }) {
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!samples.length && !canEdit) return null;
  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const data = await compressImage(file);
      await act(() => api('POST', `/api/checklist-templates/${templateId}/samples`, { data, item_id: itemId || undefined }), 'Đã lưu ảnh mẫu');
    } catch (err) { act(() => Promise.reject(err)); } finally { setBusy(false); }
  };
  return html`<div class="samples">
    ${samples.length ? html`<small class="muted">📷 ${label} · bấm để xem, làm giống ảnh</small>` : null}
    <div class="thumbs">
      ${samples.map((x) => html`<span class="thumb sample"><img src=${`/api/checklist-samples/${x.id}`} loading="lazy" alt=${label} onClick=${() => setView(x)} />
        ${canEdit ? html`<button class="x" aria-label="Xoá ảnh mẫu" onClick=${() => confirm('Xoá ảnh mẫu này?') && act(() => api('POST', `/api/checklist-samples/${x.id}/delete`), 'Đã xoá ảnh mẫu')}>✕</button>` : null}</span>`)}
      ${canEdit ? html`<label class=${`btn-photo sample-add ${itemId ? 'mini' : ''}`}><input type="file" accept="image/*" hidden onChange=${upload} />${busy ? 'Đang lưu…' : samples.length ? '+ Ảnh mẫu' : itemId ? '+ ảnh mẫu' : `+ Thêm ${label.toLowerCase()}`}</label>` : null}
    </div>
    ${view ? html`<div class="viewer" onClick=${() => setView(null)}><img src=${`/api/checklist-samples/${view.id}`} alt=${label} /></div>` : null}
  </div>`;
}
const canEditTpl = (me, teamId) => atLeast(me, 'shift_lead') || (me.role === 'team_lead' && teamId && me.team?.id === teamId);

function Item({ run, item, disabled, me }) {
  const [val, setVal] = useState(item.pack_mode && item.entry ? '' : item.entry?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);
  const redo = item.entry?.review_status === 'redo';
  const done = !!item.entry && !redo;
  const since = redo ? item.entry.reviewed_at : 0;
  const photos = item.photos.map((p) => ({ ...p, old: p.created_at <= since }));
  const fresh = photos.filter((p) => !p.deleted_at && !p.old);
  const needPhoto = item.photo_required && !done && !fresh.length;
  const [count, setCount] = useState(null);
  const [loose, setLoose] = useState('');
  const save = async (value, isDone = true) => {
    const r = await act(() => api('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: item.id, value, loose: item.pack_mode ? loose : undefined, done: isDone }));
    setCount(r?.count || null);
    if (r?.count) toast(`${r.count.name}: ${r.count.text}`, r.count.over);
  };
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
      ${item.ingredient_id ? html`<small class="muted">📦 ${item.pack_mode ? `Đếm tồn ${item.ingredient_name}: nhập số ${item.unit} nguyên + số ${item.ingredient_unit} lẻ (${item.ingredient_factor} ${item.ingredient_unit}/${item.unit})` : `Cân tồn ${item.group_names?.length ? `chung ${item.group_names.join(', ')}` : item.ingredient_name}: số này là tồn thực tế`}${item.store_name ? ` · ${item.store_name}` : ''}, app tự kiểm kho</small>` : null}
      ${item.pack_mode && done ? html`<small><b>Đã nhập: ${item.entry.value}</b></small>` : null}
      ${count ? html`<div class=${`pill ${count.over ? 'warn' : 'ok'}`}>${count.text}</div>` : null}
      <${Samples} samples=${item.samples || []} templateId=${run.template_id} itemId=${item.id} canEdit=${!disabled && canEditTpl(me, run.team_id)} label="Mẫu việc này" />
      ${redo ? html`<div class="redo-box"><b>Làm lại:</b> ${item.entry.review_note}<br /><small>${item.entry.reviewed_by_name || ''} · ${hm(item.entry.reviewed_at)}. Sửa xong chụp ảnh mới rồi bấm xong lại.</small></div>` : null}
      ${item.entry?.review_status === 'ok' && item.entry.review_note ? html`<small class="muted">Nhận xét: ${item.entry.review_note}</small>` : null}
      ${item.kind !== 'check' ? html`<div class="row">
        <input id=${`ck-${run.run_id}-${item.id}`} class="inline" inputmode=${item.kind === 'number' ? 'decimal' : 'text'} value=${val} disabled=${disabled}
          placeholder=${item.kind === 'number' ? 'Nhập số' : 'Ghi chú'} onInput=${(e) => setVal(e.target.value)}
          onKeyDown=${(e) => e.key === 'Enter' && save(val)} />
        ${item.unit ? html`<span class="muted">${item.unit}</span>` : null}
        ${item.pack_mode ? html`<span class="muted">+</span><input class="inline" inputmode="decimal" value=${loose} disabled=${disabled} placeholder="lẻ"
          aria-label=${`${item.ingredient_unit} lẻ`} onInput=${(e) => setLoose(e.target.value)} /><span class="muted">${item.ingredient_unit} lẻ</span>` : null}
        <button class="small" disabled=${disabled || needPhoto || (!val && !(item.pack_mode && loose) && item.kind === 'number')} onClick=${() => save(val)}>${done ? 'Cập nhật' : 'Lưu'}</button>
        ${done ? html`<button class="small icon" aria-label="Bỏ" disabled=${disabled} onClick=${() => { setVal(''); save('', false); }}>↺</button>` : null}
      </div>` : null}
      <${PhotoThumbs} photos=${photos} onOpen=${setView} onDelete=${!disabled && (!item.entry || redo) ? (p) => (p.staff_id === me.id || atLeast(me, 'shift_lead')) && del(p) : null} />
      ${!disabled && (!done || item.photo_required === false) && (item.photo_required || item.kind === 'check') && !done ? html`<label class=${`btn-photo ${needPhoto ? 'need' : ''}`}>
        <input type="file" accept="image/*" capture="environment" hidden onChange=${upload} />
        ${busy ? 'Đang gửi ảnh…' : fresh.length ? '📷 Chụp thêm' : item.spot ? '🎲 Kiểm tra ngẫu nhiên: chụp ảnh việc này' : item.photo_required ? '📷 Chụp ảnh (bắt buộc)' : '📷 Chụp ảnh'}</label>` : null}
      ${item.entry ? html`<small class="muted">${item.entry.done_by_name} · ${hm(item.entry.done_at)}</small>` : null}
    </div>
    <${PhotoViewer} photo=${view} onClose=${() => setView(null)} />
  </li>`;
}

// Thêm nhanh 1 việc vào checklist ngay trên màn hằng ngày
function AddItemInline({ templateId, zoneId = null, placeholder = '+ Thêm việc mới vào checklist này…' }) {
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState(true);
  const add = () => act(() => api('POST', `/api/checklist-templates/${templateId}/items`, { text, photo_required: photo, zone_id: zoneId || undefined }), 'Đã thêm việc').then((r) => r && setText(''));
  return html`<div class="add-inline">
    <input value=${text} placeholder=${placeholder} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && text.trim() && add()} />
    ${text.trim() ? html`<div class="row wrap tight">
      <button class=${`chip ${photo ? 'on' : ''}`} onClick=${() => setPhoto(!photo)}>📷 ${photo ? 'Phải chụp ảnh' : 'Không cần ảnh'}</button>
      <button class="primary" onClick=${add}>Thêm</button></div>` : null}
  </div>`;
}

export function ChecklistView({ me }) {
  const [date, setDate] = useState(me.today);
  const st = useData(`/api/checklists?date=${date}`);
  const [phase, setPhase] = useState(() => (new Date().getHours() >= 17 ? 'close' : 'open'));
  const [sec, setSec] = useState('');
  const [manage, setManage] = useState(false);
  const old = date < me.today && !atLeast(me, 'shift_lead');
  if (!st.data) return html`<${Loading} state=${st} />`;
  if (manage) return html`<div class="stack"><div class="row between"><h2>Tạo & sửa checklist</h2><button onClick=${() => setManage(false)}>← Về checklist hôm nay</button></div>
    <${Checklists} me=${me} teams=${me.teams} /></div>`;
  // Mục ngang (Bếp, Phục vụ, Thu ngân, Tổng khu A…) × Mở ca / Đóng ca ("Trong ca" gộp vào Mở ca) — chủ quán 24/10
  const sections = [...new Set([...st.data.runs, ...(st.data.jobs || [])].map((r) => r.section))];
  const curSec = sections.includes(sec) ? sec : sections[0] || '';
  const ph = (r) => (r.phase === 'close' ? 'close' : 'open');
  const runs = st.data.runs.filter((r) => r.section === curSec && ph(r) === phase);
  const jobCards = (st.data.jobs || []).filter((r) => r.section === curSec && ph(r) === phase);
  const left = (s0, p0) => st.data.runs.filter((r) => r.section === s0 && (!p0 || ph(r) === p0) && r.done < r.total).length;
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Hôm trước" onClick=${() => setDate(addDays(date, -1))}>‹</button>
        <b>${dayLabel(date, { long: true })}</b>
        <button class="icon" aria-label="Hôm sau" disabled=${date >= me.today} onClick=${() => setDate(addDays(date, 1))}>›</button>
      </div>
      ${atLeast(me, 'team_lead') ? html`<div class="row"><${Link} href="/viec-ca?tab=khu" class="btn-link">✋ Việc ca<//><${Link} href="/duyet-anh" class="btn-link">Duyệt ảnh<//><button class="primary" onClick=${() => setManage(true)}>Tạo / sửa checklist</button></div>` : null}
    </div>
    ${sections.length ? html`<div class="chips scroll-x sec-tabs">${sections.map((x) => html`<button class=${`chip big ${x === curSec ? 'on' : ''}`} onClick=${() => setSec(x)}>${x}${left(x) ? html` <b class="dotn">${left(x)}</b>` : ''}</button>`)}</div>` : null}
    <div class="tabs">${[['open', 'Mở ca'], ['close', 'Đóng ca']].map(([k, l]) => html`<button class=${phase === k ? 'on' : ''} onClick=${() => setPhase(k)}>${l}${left(curSec, k) ? ` (${left(curSec, k)})` : ''}</button>`)}</div>
    ${phase === 'open' && /phục vụ/i.test(curSec) && st.data.opening?.total && !jobCards.some((r) => r.opening_tpl) ? html`<${OpeningCard} o=${st.data.opening} />` : null}
    ${jobCards.map((r) => html`<section class="card job-card">
      <div class="row between"><div><h3>${r.title}</h3><small class="muted">${r.team_name} · 👥 Giao việc từng người · ${r.items} việc</small></div>
        <span class=${`pill ${r.total && r.done === r.total ? 'ok' : r.done ? 'warn' : ''}`}>${r.total ? `${r.done}/${r.total}` : '—'}</span></div>
      <p class="small muted">Mỗi việc đã giao cho từng bạn theo khu. Nhân viên làm ở <b>Việc ca</b> (Nhận → Xong).</p>
      <div class="row wrap"><${Link} href="/viec-ca" class="btn-link">✋ Việc của tôi<//>${atLeast(me, 'team_lead') ? html`<${Link} href="/viec-ca?tab=khu" class="btn-link">📋 Bảng khu (ai làm gì)<//>` : null}</div>
      ${r.opening_tpl ? html`<${ZoneTasks} r=${r} o=${st.data.opening} me=${me} today=${date === me.today} canEdit=${!old && canEditTpl(me, r.team_id)} />`
        : !old && canEditTpl(me, r.team_id) ? html`<${AddItemInline} templateId=${r.template_id} />` : null}
      ${!old && atLeast(me, 'shift_lead') ? html`<button class="link small" onClick=${() => confirm(`Thôi giao việc từng người cho "${r.title}"? Checklist quay về kiểu cũ (ai cũng tick).`) && act(() => api('PATCH', `/api/checklist-templates/${r.template_id}`, { job_mode: false }), 'Đã chuyển về checklist chung')}>↩ Thôi giao việc từng người</button>` : null}
    </section>`)}
    ${runs.length ? runs.map((r) => html`<section class="card" id=${`run-${r.run_id}`}>
      <div class="row between"><div><h3>${r.title}</h3><small class="muted">${r.team_name}${r.position_name ? ` · ${r.position_name}` : ''}${r.zone_name ? ` · 📍 ${r.zone_name}` : ''} · ${r.shift_name || 'Mọi ca'} · ${PHASE_LABEL[r.phase]}</small></div>
        <span class=${`pill ${r.redo ? 'bad' : r.done === r.total ? 'ok' : r.done ? 'warn' : ''}`}>${r.redo ? `${r.redo} việc làm lại` : r.done === r.total ? 'Xong' : `${r.done}/${r.total}`}</span></div>
      ${r.rules ? html`<div class="rules-box">⚠ <b>Chế tài:</b> ${r.rules}</div>` : null}
      <div class="meter wide"><span style=${`width:${r.total ? Math.round((r.done / r.total) * 100) : 0}%`} class=${r.done === r.total ? 'full' : ''}></span></div>
      <${Samples} samples=${r.samples || []} templateId=${r.template_id} canEdit=${!old && canEditTpl(me, r.team_id)} label="Ảnh mẫu khu" />
      <ul class="cklist">${r.items.map((i) => html`<${Item} key=${`${r.run_id}-${i.id}-${i.entry?.done_at || 0}`} run=${r} item=${i} disabled=${old} me=${me} />`)}</ul>
      ${!old && canEditTpl(me, r.team_id) ? html`<${AddItemInline} templateId=${r.template_id} />` : null}
      ${!old && atLeast(me, 'shift_lead') && r.items.length >= 2 ? html`<button class="job-switch" onClick=${() => toJobs(me, r)}>👥 Chuyển sang giao việc từng người</button>` : null}
    </section>`) : jobCards.length ? null : html`<div class="empty">${sections.length ? `Mục ${curSec} không có checklist ${phase === 'open' ? 'mở ca' : 'đóng ca'}.` : `Hôm nay bạn không có checklist.${atLeast(me, 'manager') ? ' Tạo checklist ở nút Tạo / sửa checklist.' : ''}`}</div>`}
  </div>`;
}

// Mở ca phục vụ theo khu (chủ quán 27/10): mỗi khu 1 khối = nhân sự khung đầu ca của khu + việc riêng của khu (chủ quán tự ghi)
function ZoneTasks({ r, o, me, today, canEdit }) {
  const zd = useData('/api/zones');
  const zones = (zd.data || []).filter((z) => z.active !== false && z.active !== 0);
  const people = o?.people || [];
  const items = r.item_list || [];
  const common = items.filter((i) => !i.job_zone_id);
  const lead = atLeast(me, 'team_lead');
  const del = (i) => confirm(`Xoá việc "${i.text}"?`) && act(() => api('POST', `/api/checklist-items/${i.id}/delete`, {}), 'Đã xoá việc');
  const jobOf = (i, zid) => (r.job_rows || []).find((j) => j.item_id === i.id && j.zone_id === (i.job_scope === 'shop' ? 0 : zid));
  const give = (j, sid) => act(() => api('PATCH', `/api/jobs/${j.id}`, { staff_id: sid ? Number(sid) : null }), sid ? 'Đã giao việc' : 'Đã bỏ giao');
  // Người làm của 1 việc trong khu: tổ trưởng / trưởng ca chọn từ danh sách (người trong khu lên đầu)
  const Who1 = (i, zid, ps) => {
    const j = jobOf(i, zid);
    if (!j) return today ? html`<small class="muted">chưa tạo thẻ</small>` : null;
    const done = ['done', 'ok'].includes(j.status);
    if (!lead || done) return html`<small class=${j.staff_name ? '' : 'warn-text'}>${done ? '✅ ' : '👤 '}${j.staff_name || 'chưa giao'}</small>`;
    const others = people.filter((x) => !ps.some((p) => p.id === x.id));
    return html`<select class="zt-sel" value=${j.staff_id || ''} onChange=${(e) => give(j, e.target.value)}>
      <option value="">👤 chưa giao</option>
      ${ps.map((x) => html`<option value=${x.id}>${x.name}</option>`)}
      ${j.staff_id && !people.some((x) => x.id === j.staff_id) ? html`<option value=${j.staff_id}>${j.staff_name}</option>` : null}
      ${others.length ? html`<optgroup label="Khu khác / chưa phân khu">${others.map((x) => html`<option value=${x.id}>${x.name}</option>`)}</optgroup>` : null}
    </select>`;
  };
  const Items = (list, zid, ps, removable) => (list.length ? html`<ul class="zt-list">${list.map((i) => html`<li>
      <span class="grow">${i.job_zone_id ? '• ' : '🔁 '}${i.text}${i.job_scope === 'shop' ? html` <small class="muted">(1 người cả quán)</small>` : ''}</span>
      ${zid !== null ? Who1(i, zid, ps) : i.job_scope === 'shop' ? Who1(i, 0, people) : null}
      ${removable && canEdit && (i.job_zone_id || zid === null) ? html`<button class="link small" aria-label="Xoá" onClick=${() => del(i)}>✕</button>` : null}</li>`)}</ul>` : html`<p class="small muted">Chưa có việc.</p>`);
  const Who = (list) => (list.length ? html`<div class="zt-who">${list.map((x) => html`<span class="zt-p">${x.clocked ? '✅' : '⏳'} ${x.name} <small class=${x.short ? 'warn-text' : 'muted'}>${x.shift}</small></span>`)}</div>` : html`<p class="small warn-text">Chưa có ai trong khung ${o?.from || '14h'}–${o?.to || '15h30'}.</p>`);
  // Ảnh khăn + nón từng khu: trưởng ca / tổ trưởng chụp bằng camera
  const Photo = (z) => {
    const ph = (r.photos || []).filter((x) => x.zone_id === z.id);
    const up = async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const data = await compressImage(f); act(() => api('POST', '/api/jobs/zone-photo', { template_id: r.template_id, zone_id: z.id, data }), `Đã gửi ảnh ${z.name}`); };
    return html`<div class="zt-photo">
      ${ph.length ? html`<div class="row wrap">${ph.map((x) => html`<a href=${`/api/jobs/zone-photo/${x.id}`} target="_blank"><img class="job-photo" src=${`/api/jobs/zone-photo/${x.id}`} /></a><small class="muted">✅ ${x.staff_name} ${hm(x.at)}</small>`)}</div>`
        : html`<small class="warn-text">⏳ Chưa chụp ảnh khăn + nón</small>`}
      ${lead && today ? html`<label class="button primary">📷 ${ph.length ? 'Chụp thêm' : 'Chụp ảnh khu'}<input type="file" accept="image/*" capture="environment" hidden onChange=${up} /></label>` : null}
    </div>`;
  };
  const noZone = people.filter((x) => !x.zone_id);
  return html`<div class="stack zt">
    <p class="small"><b>👥 Khung ${o?.from || '14h'}–${o?.to || '15h30'}: ${people.length} người</b>${o?.total ? html` · đã chấm vào ${o.clocked}/${o.total}` : ''}</p>
    ${zones.map((z) => { const ps = people.filter((x) => x.zone_id === z.id); const own = items.filter((i) => i.job_zone_id === z.id); return html`<div class="zt-zone">
      <div class="zt-head">📍 ${z.name} <small>${ps.length} người · ${own.length + common.filter((i) => i.job_scope !== 'shop').length} việc</small></div>
      ${Who(ps)}
      ${r.zone_photo ? Photo(z) : null}
      ${Items([...own, ...common.filter((i) => i.job_scope !== 'shop')], z.id, ps, true)}
      ${canEdit ? html`<${AddItemInline} templateId=${r.template_id} zoneId=${z.id} placeholder=${`+ Thêm việc cho ${z.name}…`} />` : null}
    </div>`; })}
    <div class="zt-zone">
      <div class="zt-head">🔁 Việc chung, khu nào cũng làm <small>${common.length} việc · việc mỗi khu hiện trong từng khu ở trên, việc 1 người cả quán giao ở đây</small></div>
      ${Items(common, null, [], true)}
      ${canEdit ? html`<${AddItemInline} templateId=${r.template_id} placeholder="+ Thêm việc chung cho mọi khu…" />` : null}
    </div>
    ${noZone.length ? html`<div class="zt-zone"><div class="zt-head warn">⚠ Chưa phân khu <small>${noZone.length} người</small></div>${Who(noZone)}</div>` : null}
  </div>`;
}

// Đầu ca Phục vụ + Tiếp thực: số người trong khung mở ca, ai đã chấm vào, ai ca ngắn về ≤ 18h (chủ quán 27/10)
function OpeningCard({ o }) {
  const [open, setOpen] = useState(false);
  return html`<section class="card stack tight">
    <div class="row between"><b>👥 Đầu ca ${o.from}–${o.to}: ${o.total} người</b><small class="muted">đã chấm vào ${o.clocked}/${o.total}</small></div>
    <small>Phục vụ <b>${o.pv}</b> · Tiếp thực <b>${o.tt}</b></small>
    ${o.short.length ? html`<small class="warn-text">⏰ Ca ngắn, về ≤ 18h (${o.short.length}): ${o.short.map((x) => `${x.name} (${x.shift})`).join(', ')}</small>` : html`<small class="muted">Không ai về trước 18h.</small>`}
    <div class="chips">${(o.zones || []).map((z) => html`<span class=${`pill ${z.name === 'Chưa phân khu' ? 'warn' : 'muted'}`}>${z.name}: ${z.people.length}</span>`)}</div>
    <button class="link small" style="align-self:flex-start" onClick=${() => setOpen(!open)}>${open ? 'Ẩn danh sách' : 'Xem danh sách theo khu'}</button>
    ${open ? (o.zones || []).map((z) => html`<div class="stack tight"><b class="small">📍 ${z.name} (${z.people.length})</b>
      ${z.people.map((x) => html`<div class="row between small"><span>${x.clocked ? '✅' : '⏳'} ${x.name} <span class="muted">· ${x.team}</span></span><span class=${x.short ? 'warn-text' : 'muted'}>${x.shift}</span></div>`)}</div>`) : null}
    <a class="link small" href="/viec-ca?tab=khu">✋ Phân lại việc ở Việc ca → Bảng khu</a>
  </section>`;
}
