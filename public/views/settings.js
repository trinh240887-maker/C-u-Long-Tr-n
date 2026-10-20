import { useState, useEffect } from 'preact/hooks';
import { html, api, act, useData, Modal, Field, Loading, navigate, dt, PHASE_LABEL, toast } from '../ui.js';

const TABS = [['chung', 'Chung'], ['to', 'Tổ'], ['ca', 'Loại ca'], ['checklist', 'Checklist'], ['zalo', 'Zalo OA'], ['saoluu', 'Sao lưu'], ['nhatky', 'Nhật ký']];

function General({ s, staff }) {
  const [f, setF] = useState(s);
  useEffect(() => setF(s), [s]);
  const set = (k, v) => setF({ ...f, [k]: v });
  const inp = (k, label, props = {}, hint) => html`<${Field} label=${label} hint=${hint}><input id=${`set-${k}`} value=${f[k]} onInput=${(e) => set(k, e.target.value)} ...${props} /><//>`;
  const save = () => act(() => api('PUT', '/api/settings', {
    shop_name: f.shop_name, public_url: f.public_url, day_cutoff_hour: f.day_cutoff_hour, late_grace_minutes: f.late_grace_minutes,
    clock_early_minutes: f.clock_early_minutes, auto_close_after_minutes: f.auto_close_after_minutes, clock_ip_prefixes: f.clock_ip_prefixes,
    night_bonus_pct: f.night_bonus_pct, quiet_from: f.quiet_from, quiet_to: f.quiet_to, kho_tong_staff_id: f.kho_tong_staff_id,
  }), 'Đã lưu cài đặt');
  return html`<div class="stack">
    <section class="card"><h3>Quán</h3><div class="form-grid">
      ${inp('shop_name', 'Tên quán')}
      ${inp('public_url', 'Địa chỉ truy cập từ xa', { placeholder: 'https://quan.tenmien.vn' }, 'Link Cloudflare Tunnel; dùng để gắn vào tin nhắn Zalo.')}
      <${Field} label="Người giữ kho tổng" hint="Dùng ở giai đoạn Kho. Đổi lúc nào cũng được.">
        <select id="set-kho" value=${f.kho_tong_staff_id} onChange=${(e) => set('kho_tong_staff_id', e.target.value)}>
          <option value="">(chưa chọn, tạm giao quản lý)</option>${staff.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select><//>
    </div></section>
    <section class="card"><h3>Chấm công</h3><div class="form-grid">
      ${inp('late_grace_minutes', 'Cho phép trễ (phút)', { type: 'number', min: 0 })}
      ${inp('clock_early_minutes', 'Được chấm vào sớm trước ca (phút)', { type: 'number', min: 0 })}
      ${inp('auto_close_after_minutes', 'Quên chấm ra: tự đóng sau giờ hết ca (phút)', { type: 'number', min: 15 })}
      ${inp('day_cutoff_hour', 'Giờ chốt ngày làm việc', { type: 'number', min: 0, max: 12 }, 'Trước giờ này vẫn tính là ngày hôm trước (ca qua đêm).')}
      ${inp('clock_ip_prefixes', 'Chỉ chấm công trong wifi quán', { placeholder: 'vd 192.168.1.' }, 'Để trống = không giới hạn. Truy cập từ xa luôn bị chặn chấm công khi bật.')}
      ${inp('night_bonus_pct', 'Phụ cấp làm đêm 22h–6h (%)', { type: 'number', min: 0 })}
    </div></section>
    <section class="card"><h3>Giờ yên lặng</h3><p class="muted small">Không gửi Zalo trong khung giờ này, trừ tin gấp (nhờ làm thay, việc gấp).</p><div class="row">
      ${inp('quiet_from', 'Từ', { type: 'time' })}${inp('quiet_to', 'Đến', { type: 'time' })}</div></section>
    <div class="row end"><button class="primary" onClick=${save}>Lưu cài đặt</button></div>
  </div>`;
}

function Teams() {
  const st = useData('/api/teams');
  const [name, setName] = useState('');
  if (!st.data) return html`<${Loading} state=${st} />`;
  return html`<section class="card stack">
    <p class="muted small">"Tối thiểu" là số người cần có mỗi ngày; lịch ca sẽ cảnh báo khi xếp thiếu. Đặt 0 để không cảnh báo.</p>
    ${st.data.map((t) => html`<div class="row team-row" key=${t.id}>
      <input id=${`tm-n${t.id}`} class="grow" value=${t.name} onChange=${(e) => act(() => api('PATCH', `/api/teams/${t.id}`, { name: e.target.value }), 'Đã đổi tên')} />
      <label class="row small">Tối thiểu <input id=${`tm-m${t.id}`} class="num-in" type="number" min="0" value=${t.min_staff} onChange=${(e) => act(() => api('PATCH', `/api/teams/${t.id}`, { min_staff: e.target.value }), 'Đã lưu')} /></label>
      <label class="check-row small"><input type="checkbox" checked=${!!t.active} onChange=${(e) => act(() => api('PATCH', `/api/teams/${t.id}`, { active: e.target.checked }), 'Đã lưu')} /> Dùng</label>
    </div>`)}
    <div class="row"><input id="tm-new" class="grow" placeholder="Tên tổ mới, vd Bảo vệ" value=${name} onInput=${(e) => setName(e.target.value)} />
      <button class="primary" disabled=${!name.trim()} onClick=${async () => { if (await act(() => api('POST', '/api/teams', { name }), 'Đã thêm tổ')) setName(''); }}>Thêm tổ</button></div>
  </section>`;
}

function TemplateForm({ init, onClose }) {
  const [f, setF] = useState({ name: init.name || '', color: init.color || '#c2410c', segments: init.segments || [{ start: '', end: '' }], active: init.active ?? true });
  const seg = (i, k, v) => setF({ ...f, segments: f.segments.map((s, j) => (j === i ? { ...s, [k]: v } : s)) });
  const save = async () => {
    const ok = await act(() => (init.id ? api('PATCH', `/api/shift-templates/${init.id}`, f) : api('POST', '/api/shift-templates', f)), 'Đã lưu loại ca');
    if (ok) onClose();
  };
  return html`<${Modal} title=${init.id ? 'Sửa loại ca' : 'Thêm loại ca'} onClose=${onClose}>
    <div class="stack">
      <div class="row"><${Field} label="Tên ca"><input id="tp-name" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} placeholder="vd Ca tối" /><//>
        <${Field} label="Màu"><input id="tp-color" type="color" value=${f.color} onInput=${(e) => setF({ ...f, color: e.target.value })} /><//></div>
      <div class="field"><span>Khung giờ</span>
        ${f.segments.map((s, i) => html`<div class="row seg"><input type="time" value=${s.start} onInput=${(e) => seg(i, 'start', e.target.value)} aria-label="Bắt đầu" />
          <span>đến</span><input type="time" value=${s.end} onInput=${(e) => seg(i, 'end', e.target.value)} aria-label="Kết thúc" />
          ${f.segments.length > 1 ? html`<button class="icon" aria-label="Bỏ" onClick=${() => setF({ ...f, segments: f.segments.filter((_, j) => j !== i) })}>✕</button>` : null}</div>`)}
        ${f.segments.length < 4 ? html`<button class="link" onClick=${() => setF({ ...f, segments: [...f.segments, { start: '', end: '' }] })}>+ Thêm khúc (ca gãy)</button>` : null}
      </div>
      ${init.id ? html`<label class="check-row"><input type="checkbox" checked=${f.active} onChange=${(e) => setF({ ...f, active: e.target.checked })} /> Đang dùng</label>` : null}
      <p class="muted small">Sửa loại ca không làm đổi các ca đã xếp trước đó.</p>
      <div class="row between">
        ${init.id ? html`<button class="danger" onClick=${async () => { if (await act(() => api('DELETE', `/api/shift-templates/${init.id}`), 'Đã xoá')) onClose(); }}>Xoá</button>` : html`<span></span>`}
        <div class="row"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu</button></div></div>
    </div>
  <//>`;
}

function Templates() {
  const st = useData('/api/shift-templates');
  const [edit, setEdit] = useState(null);
  if (!st.data) return html`<${Loading} state=${st} />`;
  return html`<section class="card stack">
    <p class="muted small">Loại ca do quán tự đặt, chỉ để chọn nhanh khi xếp lịch. Khi xếp lịch vẫn nhập giờ riêng được.</p>
    ${st.data.length ? st.data.map((t) => html`<button class=${`tpl-row ${t.active ? '' : 'off'}`} onClick=${() => setEdit(t)}>
      <i class="sw" style=${`background:${t.color}`}></i><b class="grow">${t.name}</b><span>${t.segments.map((s) => `${s.start}–${s.end}`).join(' + ')}</span></button>`)
      : html`<p class="muted">Chưa có loại ca nào.</p>`}
    <div><button class="primary" onClick=${() => setEdit({})}>+ Thêm loại ca</button></div>
    ${edit ? html`<${TemplateForm} init=${edit} onClose=${() => setEdit(null)} />` : null}
  </section>`;
}

function ChecklistForm({ init, teams, shifts, onClose }) {
  const [f, setF] = useState({ title: init.title || '', team_id: init.team_id ?? '', phase: init.phase || 'open', active: init.active ?? true,
    shift_template_id: init.shift_template_id ?? '',
    items: init.items?.map((i) => ({ ...i })) || [{ text: '', kind: 'check', unit: '', required: true }] });
  const item = (i, k, v) => setF({ ...f, items: f.items.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const move = (i, d) => { const items = [...f.items]; const [x] = items.splice(i, 1); items.splice(i + d, 0, x); setF({ ...f, items }); };
  const save = async () => {
    const body = { ...f, team_id: f.team_id || null, shift_template_id: f.shift_template_id || null, items: f.items.filter((x) => x.text.trim()) };
    const ok = await act(() => (init.id ? api('PATCH', `/api/checklist-templates/${init.id}`, body) : api('POST', '/api/checklist-templates', body)), 'Đã lưu checklist');
    if (ok) onClose();
  };
  return html`<${Modal} title=${init.id ? 'Sửa checklist' : 'Thêm checklist'} onClose=${onClose} wide>
    <div class="stack">
      <div class="form-grid">
        <${Field} label="Tên checklist"><input id="cl-title" value=${f.title} onInput=${(e) => setF({ ...f, title: e.target.value })} /><//>
        <${Field} label="Tổ"><select id="cl-team" value=${f.team_id} onChange=${(e) => setF({ ...f, team_id: e.target.value })}>
          <option value="">Cả quán</option>${teams.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
        <${Field} label="Thời điểm"><select id="cl-phase" value=${f.phase} onChange=${(e) => setF({ ...f, phase: e.target.value })}>
          ${Object.entries(PHASE_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select><//>
        <${Field} label="Áp dụng cho ca" hint="Người làm ca nào chỉ thấy checklist của ca đó">
          <select id="cl-shift" value=${f.shift_template_id} onChange=${(e) => setF({ ...f, shift_template_id: e.target.value })}>
            <option value="">Mọi ca</option>${shifts.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
      </div>
      <div class="field"><span>Các việc</span>
        ${f.items.map((x, i) => html`<div class="item-row">
          <input class="grow" value=${x.text} placeholder="Tên việc" onInput=${(e) => item(i, 'text', e.target.value)} aria-label="Tên việc" />
          <select value=${x.kind} onChange=${(e) => item(i, 'kind', e.target.value)} aria-label="Kiểu">
            <option value="check">Tick</option><option value="number">Nhập số</option><option value="text">Ghi chữ</option></select>
          ${x.kind === 'number' ? html`<input class="unit" value=${x.unit} placeholder="đơn vị" onInput=${(e) => item(i, 'unit', e.target.value)} aria-label="Đơn vị" />` : null}
          <label class="check-row small"><input type="checkbox" checked=${x.required} onChange=${(e) => item(i, 'required', e.target.checked)} />Bắt buộc</label>
          <span class="row tight">
            <button class="icon" aria-label="Lên" disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
            <button class="icon" aria-label="Xuống" disabled=${i === f.items.length - 1} onClick=${() => move(i, 1)}>↓</button>
            <button class="icon" aria-label="Bỏ" onClick=${() => setF({ ...f, items: f.items.filter((_, j) => j !== i) })}>✕</button></span>
        </div>`)}
        <button class="link" onClick=${() => setF({ ...f, items: [...f.items, { text: '', kind: 'check', unit: '', required: true }] })}>+ Thêm việc</button>
      </div>
      ${init.id ? html`<label class="check-row"><input type="checkbox" checked=${f.active} onChange=${(e) => setF({ ...f, active: e.target.checked })} /> Đang dùng (bỏ chọn để ẩn, vẫn giữ lịch sử)</label>` : null}
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu</button></div>
    </div>
  <//>`;
}

function Checklists({ teams }) {
  const st = useData('/api/checklist-templates?all=1');
  const shifts = useData('/api/shift-templates');
  const [edit, setEdit] = useState(null);
  if (!st.data) return html`<${Loading} state=${st} />`;
  return html`<section class="card stack">
    <p class="muted small">Checklist có chữ "(mẫu)" là ví dụ, hãy sửa lại theo cách làm của quán. Mỗi ngày mỗi checklist có một lượt mới.
      Muốn ca sáng và ca chiều có việc riêng: tạo 2 checklist, chọn "Áp dụng cho ca" tương ứng (loại ca tạo ở tab Loại ca).</p>
    ${st.data.map((c) => html`<button class=${`tpl-row ${c.active ? '' : 'off'}`} onClick=${() => setEdit(c)}>
      <b class="grow">${c.title}</b><span class="muted">${c.team_name || 'Cả quán'} · ${c.shift_name || 'Mọi ca'} · ${PHASE_LABEL[c.phase]} · ${c.items.length} việc</span></button>`)}
    <div><button class="primary" onClick=${() => setEdit({})}>+ Thêm checklist</button></div>
    ${edit ? html`<${ChecklistForm} init=${edit} teams=${teams} shifts=${(shifts.data || []).filter((t) => t.active)} onClose=${() => setEdit(null)} />` : null}
  </section>`;
}

function Zalo({ s }) {
  const [f, setF] = useState(s);
  useEffect(() => setF(s), [s]);
  const set = (k, v) => setF({ ...f, [k]: v });
  const hook = `${(s.public_url || location.origin)}${s.zalo_webhook_path}`;
  return html`<div class="stack">
    <section class="card attn"><b>Chưa thử với OA thật.</b> Phần gửi Zalo viết theo API Zalo OA v3 (tin nhắn tư vấn). Trước khi bật cho cả quán, hãy bấm "Gửi thử" và báo lại kết quả.
      Zalo chỉ cho OA gửi tin tư vấn trong một thời gian sau lần cuối nhân viên nhắn cho OA (khoảng 7 ngày), nên nút trả lời trong tin nhắn sẽ giúp giữ kết nối.</section>
    <section class="card"><h3>Kết nối</h3>
      <ol class="plain steps small">
        <li>Vào <b>developers.zalo.me</b>, tạo ứng dụng và liên kết với OA của quán.</li>
        <li>Chép <b>App ID</b> và <b>Secret key</b> vào dưới.</li>
        <li>Cấp quyền cho ứng dụng để lấy <b>Refresh token</b> (và Access token) của OA, dán vào dưới.</li>
        <li>Phần Webhook của ứng dụng: điền địa chỉ dưới, bật sự kiện "Người dùng gửi tin nhắn văn bản".</li>
      </ol>
      <div class="form-grid">
        <${Field} label="App ID"><input id="z-app" value=${f.zalo_app_id} onInput=${(e) => set('zalo_app_id', e.target.value)} /><//>
        <${Field} label="Secret key" hint=${s.zalo_secret_key ? `Đã lưu (${s.zalo_secret_key}). Để trống nếu giữ nguyên.` : ''}><input id="z-secret" type="password" value="" onInput=${(e) => set('zalo_secret_key', e.target.value)} /><//>
        <${Field} label="Refresh token" hint=${s.zalo_refresh_token ? `Đã lưu (${s.zalo_refresh_token}).` : ''}><input id="z-refresh" type="password" value="" onInput=${(e) => set('zalo_refresh_token', e.target.value)} /><//>
        <${Field} label="Access token (tuỳ chọn)" hint=${s.zalo_access_token ? `Đã lưu (${s.zalo_access_token}).` : 'App tự làm mới khi hết hạn.'}><input id="z-access" type="password" value="" onInput=${(e) => set('zalo_access_token', e.target.value)} /><//>
      </div>
      <${Field} label="Địa chỉ Webhook (dán vào Zalo)"><div class="row"><input id="z-hook" class="grow" readonly value=${hook} />
        <button class="small" onClick=${() => navigator.clipboard?.writeText(hook).then(() => toast('Đã chép')).catch(() => {})}>Chép</button></div><//>
      ${!s.public_url ? html`<p class="warn-text small">Cần điền "Địa chỉ truy cập từ xa" ở tab Chung (Cloudflare Tunnel) thì Zalo mới gọi được webhook.</p>` : null}
      <label class="check-row"><input id="z-on" type="checkbox" checked=${f.zalo_enabled === '1'} onChange=${(e) => set('zalo_enabled', e.target.checked ? '1' : '0')} /> Bật gửi thông báo qua Zalo</label>
      <div class="row end">
        <button onClick=${() => act(() => api('POST', '/api/settings/zalo-test'), 'Đã gửi thử tới Zalo của bạn')}>Gửi thử cho tôi</button>
        <button class="primary" onClick=${() => act(() => api('PUT', '/api/settings', {
          zalo_enabled: f.zalo_enabled === '1', zalo_app_id: f.zalo_app_id, zalo_secret_key: f.zalo_secret_key,
          zalo_refresh_token: f.zalo_refresh_token, zalo_access_token: f.zalo_access_token,
        }), 'Đã lưu kết nối Zalo')}>Lưu</button>
      </div>
    </section>
  </div>`;
}

function Backups({ s }) {
  const [list, setList] = useState(s.backups);
  return html`<section class="card stack">
    <p>App tự sao lưu <b>mỗi giờ</b> vào thư mục <code>data/backups</code> trên máy chủ của quán và giữ <b>7 ngày</b>.
      Nên chép thư mục này sang ổ cứng/USB khác hoặc lên Google Drive định kỳ (xem README phần Sao lưu).</p>
    <div><button class="primary" onClick=${async () => { const r = await act(() => api('POST', '/api/backup'), 'Đã sao lưu'); if (r) setList(r.backups); }}>Sao lưu ngay</button></div>
    <div class="table-wrap"><table class="list"><thead><tr><th>File</th><th>Lúc</th><th class="r">Dung lượng</th></tr></thead>
      <tbody>${list.map((b) => html`<tr><td><code>${b.file}</code></td><td>${dt(b.at)}</td><td class="r">${Math.round(b.size / 1024)} KB</td></tr>`)}</tbody></table></div>
  </section>`;
}

function Audit() {
  const st = useData('/api/audit');
  if (!st.data) return html`<${Loading} state=${st} />`;
  return html`<section class="card"><div class="table-wrap"><table class="list"><thead><tr><th>Lúc</th><th>Ai</th><th>Việc</th><th>Chi tiết</th></tr></thead>
    <tbody>${st.data.map((a) => html`<tr><td>${dt(a.at)}</td><td>${a.staff_name || '—'}</td><td><code>${a.action}</code></td><td><small class="muted">${a.detail.slice(0, 120)}</small></td></tr>`)}</tbody></table></div></section>`;
}

export function SettingsView({ me, query }) {
  const tab = query.get('tab') || 'chung';
  const st = useData('/api/settings');
  const staff = useData('/api/staff');
  return html`<div class="stack">
    <div class="tabs scroll">${TABS.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => navigate(`/cai-dat?tab=${k}`)}>${l}</button>`)}</div>
    ${!st.data ? html`<${Loading} state=${st} />`
      : tab === 'chung' ? html`<${General} s=${st.data} staff=${(staff.data || []).filter((p) => p.active)} />`
      : tab === 'to' ? html`<${Teams} />`
      : tab === 'ca' ? html`<${Templates} />`
      : tab === 'checklist' ? html`<${Checklists} teams=${me.teams} />`
      : tab === 'zalo' ? html`<${Zalo} s=${st.data} />`
      : tab === 'saoluu' ? html`<${Backups} s=${st.data} />`
      : html`<${Audit} />`}
  </div>`;
}
