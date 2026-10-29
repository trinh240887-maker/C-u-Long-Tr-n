import { useState, useEffect } from '../vendor/hooks.js';
import { Samples } from './checklists.js';
import { html, api, act, useData, Modal, Field, Loading, navigate, dt, PHASE_LABEL, toast, atLeast, hm, dayLabel, SaveInput } from '../ui.js';

const TABS = [['chung', 'Chung'], ['quyen', '🔐 Phân quyền'], ['luong', '💵 Khung lương'], ['bot', '🤖 Zalo Bot'], ['to', 'Bộ phận & vị trí'], ['khu', 'Khu & bàn'], ['dung-cu', 'Dụng cụ'], ['ca', 'Loại ca'], ['checklist', 'Checklist'], ['ketnoi', 'Kết nối (mã)'], ['zalo', 'Zalo OA'], ['saoluu', 'Sao lưu'], ['nhatky', 'Nhật ký']];

const DEF_SLOTS = [{ key: 'sang', label: 'Sáng', start: '06:00', end: '12:00' }, { key: 'chieu', label: 'Chiều', start: '12:00', end: '17:00' }, { key: 'toi', label: 'Tối', start: '17:00', end: '24:00' }];

// Lấy địa chỉ mạng điện thoại đang dùng (đứng ở quán, bắt wifi quán rồi bấm) để làm "wifi quán"
// Vị trí quán cho chấm công: đứng ở quán bấm "Lấy vị trí hiện tại"
function ShopPlace({ f, set, setMany }) {
  const [busy, setBusy] = useState(false);
  const grab = () => {
    if (!navigator.geolocation) return toast('Máy này không lấy được vị trí', true);
    setBusy(true);
    navigator.geolocation.getCurrentPosition((p) => { setBusy(false); setMany({ shop_lat: p.coords.latitude.toFixed(6), shop_lng: p.coords.longitude.toFixed(6) }); toast(`Đã lấy vị trí (sai số ~${Math.round(p.coords.accuracy)}m). Bấm Lưu.`); },
      (e) => { setBusy(false); toast(e.code === 1 ? 'Chưa cho phép vị trí: vào Cài đặt điện thoại → Safari/Chrome → Vị trí → Cho phép' : 'Không lấy được vị trí, thử lại', true); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };
  return html`<div class="stack tight" style="grid-column:1/-1">
    <b>📍 Chỉ chấm công khi ở quán</b>
    <p class="small muted">Nhân viên chấm được khi <b>đứng gần quán</b> (GPS) <b>hoặc</b> đang <b>bắt wifi quán</b>. Đứng trong quán bấm nút dưới rồi bấm Lưu.</p>
    <div class="row wrap"><button onClick=${grab} disabled=${busy}>${busy ? 'Đang lấy…' : '📍 Lấy vị trí hiện tại làm vị trí quán'}</button>
      ${f.shop_lat && f.shop_lng ? html`<a class="small" target="_blank" rel="noopener" href=${`https://maps.google.com/?q=${f.shop_lat},${f.shop_lng}`}>Xem trên bản đồ</a> <button class="small" onClick=${() => setMany({ shop_lat: '', shop_lng: '' })}>Bỏ vị trí</button>` : html`<span class="small warn-text">Chưa có vị trí quán</span>`}</div>
    <label class="row small">Bán kính cho phép <input class="num-in" type="number" min="30" max="2000" value=${f.clock_radius_m || 150} onInput=${(e) => set('clock_radius_m', e.target.value)} /> mét</label>
  </div>`;
}

function WifiHere({ value, onUse }) {
  const st = useData('/api/attendance/network');
  if (!st.data) return null;
  const { ip, allowed } = st.data;
  return html`<div class="small stack"><span>Mạng điện thoại này đang dùng: <b>${ip || '?'}</b> ${value ? (allowed ? html`<span class="pill ok">đúng wifi quán</span>` : html`<span class="pill warn">không phải wifi quán</span>`) : ''}</span>
    <div><button class="small" onClick=${() => onUse(ip)}>Dùng mạng đang kết nối làm wifi quán</button> <small class="muted">Đứng ở quán, tắt 4G, bắt wifi quán rồi bấm, sau đó bấm Lưu. Wifi quán đổi địa chỉ (nhà mạng cấp lại) thì app báo, bấm lại nút này.</small></div></div>`;
}

function General({ s, staff }) {
  const [f, setF] = useState(s);
  useEffect(() => setF(s), [s]);
  const set = (k, v) => setF({ ...f, [k]: v });
  const inp = (k, label, props = {}, hint) => html`<${Field} label=${label} hint=${hint}><input id=${`set-${k}`} value=${f[k]} onInput=${(e) => set(k, e.target.value)} ...${props} /><//>`;
  const save = () => act(() => api('PUT', '/api/settings', {
    shop_name: f.shop_name, public_url: f.public_url, day_cutoff_hour: f.day_cutoff_hour, late_grace_minutes: f.late_grace_minutes, pos_need_shift: f.pos_need_shift === '1' ? '1' : '0',
    clock_early_minutes: f.clock_early_minutes, auto_close_after_minutes: f.auto_close_after_minutes, clock_ip_prefixes: f.clock_ip_prefixes, shop_lat: f.shop_lat, shop_lng: f.shop_lng, clock_radius_m: f.clock_radius_m || '150',
    labor_target_pct: f.labor_target_pct, idle_alert_minutes: f.idle_alert_minutes, count_tolerance_pct: f.count_tolerance_pct, spot_photos_per_run: f.spot_photos_per_run,
    night_bonus_pct: f.night_bonus_pct, pay_period_start_day: f.pay_period_start_day, month_paid_off_days: f.month_paid_off_days, ot_daily_hours: f.ot_daily_hours, ot_rate: f.ot_rate, ot_hour_days: f.ot_hour_days, ot_hour_hours: f.ot_hour_hours, quiet_from: f.quiet_from, quiet_to: f.quiet_to, kho_tong_staff_id: f.kho_tong_staff_id,
    avail_deadline_dow: f.avail_deadline_dow, avail_deadline_time: f.avail_deadline_time, avail_slots: JSON.stringify(slots),
  }), 'Đã lưu cài đặt');
  const slots = (() => { try { const x = JSON.parse(f.avail_slots || '[]'); return x.length ? x : DEF_SLOTS; } catch { return DEF_SLOTS; } })();
  const setSlot = (i, k, val) => set('avail_slots', JSON.stringify(slots.map((s, j) => (j === i ? { ...s, [k]: val } : s))));
  return html`<div class="stack">
    <section class="card"><h3>Quán</h3><div class="form-grid">
      ${inp('shop_name', 'Tên quán')}
      ${inp('public_url', 'Địa chỉ truy cập từ xa', { placeholder: 'https://quan.tenmien.vn' }, 'Link Cloudflare Tunnel; dùng để gắn vào tin nhắn Zalo.')}
      <${Field} label="Người giữ kho tổng" hint="Dùng ở giai đoạn Kho. Đổi lúc nào cũng được.">
        <select id="set-kho" value=${f.kho_tong_staff_id} onChange=${(e) => set('kho_tong_staff_id', e.target.value)}>
          <option value="">(chưa chọn, tạm giao quản lý)</option>${staff.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select><//>
      ${inp('spot_photos_per_run', 'Kiểm tra ngẫu nhiên: số việc bắt chụp thêm mỗi checklist', { type: 'number', min: 0, max: 5 }, 'App tự chọn ngẫu nhiên việc (nhân viên không biết trước) bắt chụp ảnh. 0 = tắt.')}
      ${inp('count_tolerance_pct', 'Lệch kiểm kho cho phép (%)', { type: 'number', min: 0, max: 50 }, 'Cân tồn cuối ca lệch so với sổ (đã trừ theo định lượng) quá mức này thì báo chủ quán + quản lý.')}
    </div></section>
    <section class="card"><h3>Chấm công</h3><div class="form-grid">
      <label class="check-row" style="grid-column:1/-1"><input id="set-pos-shift" type="checkbox" checked=${f.pos_need_shift === '1'} onChange=${(e) => set('pos_need_shift', e.target.checked ? '1' : '0')} />
        <span><b>Chỉ người đang trong ca mới được order / tính tiền</b><br /><small class="muted">Phải chấm công vào (ở quán) mới gọi món, gửi bếp, huỷ món, thu tiền được; chấm ra rồi hoặc ở nhà thì chỉ xem. Chủ quán + quản lý không bị chặn. Đang trong ca dùng 4G vẫn được.</small></span></label>
      ${inp('late_grace_minutes', 'Cho phép trễ (phút)', { type: 'number', min: 0 })}
      ${inp('clock_early_minutes', 'Được chấm vào sớm trước ca (phút)', { type: 'number', min: 0 })}
      ${inp('auto_close_after_minutes', 'Quên chấm ra: tự đóng sau giờ hết ca (phút)', { type: 'number', min: 15 })}
      ${inp('day_cutoff_hour', 'Giờ chốt ngày làm việc', { type: 'number', min: 0, max: 12 }, 'Trước giờ này vẫn tính là ngày hôm trước (ca qua đêm).')}
      <${ShopPlace} f=${f} set=${set} setMany=${(o) => setF((x) => ({ ...x, ...o }))} />
      ${inp('clock_ip_prefixes', 'Wifi quán (nhập tay, không bắt buộc)', { placeholder: 'vd 113.161.20.5' }, 'Thường để trống: máy cầu in ở quán tự báo IP wifi quán. Nhiều mạng cách nhau dấu phẩy.')}
      <${WifiHere} value=${f.clock_ip_prefixes} onUse=${(ip) => set('clock_ip_prefixes', [...new Set([...String(f.clock_ip_prefixes || '').split(',').map((x) => x.trim()).filter(Boolean), ip])].join(', '))} />
      ${inp('labor_target_pct', 'Lương / doanh thu mục tiêu (%)', { type: 'number', min: 5, max: 80 }, 'Giờ nào vượt 1,5 lần mức này mà ít bàn thì app báo thừa người.')}
      ${inp('idle_alert_minutes', 'Không thao tác bao lâu thì ghi nhận (phút)', { type: 'number', min: 15 }, 'Chỉ tính phục vụ, tiếp thực, thu ngân.')}
      ${inp('night_bonus_pct', 'Phụ cấp làm đêm 22h–6h (%)', { type: 'number', min: 0 })}
      ${inp('pay_period_start_day', 'Kỳ lương bắt đầu ngày', { type: 'number', min: 1, max: 28 }, 'vd 18: kỳ 18/10–17/11, 18/11–17/12…')}
      ${inp('month_paid_off_days', 'Lương tháng: ngày nghỉ vẫn đủ lương / tháng', { type: 'number', min: 0, max: 15 }, 'vd 2: tháng 31 ngày làm 29 ngày là đủ lương; nghỉ thêm mỗi ngày trừ 1/29')}
      ${inp('ot_daily_hours', 'Giờ chuẩn / ngày (quá là vượt giờ)', { type: 'number', min: 0, max: 16 }, 'vd 8: ca 8–12 + 14–23 (13 giờ) → vượt 5 giờ. 0 = không tính vượt giờ')}
      ${inp('ot_rate', 'Hệ số tiền vượt giờ', { inputmode: 'decimal' }, '1 = giá giờ thường; 1,5 = trả 150%')}
      ${inp('ot_hour_days', 'Giá 1 giờ làm thêm: chia cho bao nhiêu ngày', { type: 'number', min: 0, max: 31 }, 'vd 30: lương 7tr ÷ 30 ÷ 8 giờ = 29.167đ/giờ. 0 = theo ngày công chuẩn của tháng')}
      ${inp('ot_hour_hours', 'Giá 1 giờ làm thêm: chia cho bao nhiêu giờ', { type: 'number', min: 0, max: 16 }, 'vd 8. 0 = theo giờ chuẩn / ngày')}
    </div></section>
    <section class="card"><h3>Lịch rảnh</h3><p class="muted small">Nhân viên báo buổi rảnh của tuần sau trước hạn này. Giờ của buổi dùng để so với ca đã xếp.</p>
      <div class="row">
        <${Field} label="Hạn nộp (tuần trước đó)"><select id="set-avdow" value=${f.avail_deadline_dow || '4'} onChange=${(e) => set('avail_deadline_dow', e.target.value)}>
          ${['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'].map((l, i) => html`<option value=${i + 1}>${l}</option>`)}</select><//>
        ${inp('avail_deadline_time', 'Lúc', { type: 'time' })}
      </div>
      ${slots.map((s, i) => html`<div class="row"><input class="grow" value=${s.label} aria-label="Tên buổi" onInput=${(e) => setSlot(i, 'label', e.target.value)} />
        <input type="time" value=${s.start} aria-label="Từ" onInput=${(e) => setSlot(i, 'start', e.target.value)} /><span>–</span>
        <input type="time" value=${s.end === '24:00' ? '23:59' : s.end} aria-label="Đến" onInput=${(e) => setSlot(i, 'end', e.target.value === '23:59' ? '24:00' : e.target.value)} /></div>`)}
    </section>
    <section class="card"><h3>Giờ yên lặng</h3><p class="muted small">Không gửi Zalo trong khung giờ này, trừ tin gấp (nhờ làm thay, việc gấp).</p><div class="row">
      ${inp('quiet_from', 'Từ', { type: 'time' })}${inp('quiet_to', 'Đến', { type: 'time' })}</div></section>
    <div class="row end"><button class="primary" onClick=${save}>Lưu cài đặt</button></div>
  </div>`;
}

function Teams() {
  const st = useData('/api/teams');
  const [name, setName] = useState('');
  const [newPos, setNewPos] = useState({});
  const [combine, setCombine] = useState({ name: 'Bếp', ids: [] });
  if (!st.data) return html`<${Loading} state=${st} />`;
  const active = st.data.filter((t) => t.active);
  const toggle = (id) => setCombine({ ...combine, ids: combine.ids.includes(id) ? combine.ids.filter((x) => x !== id) : [...combine.ids, id] });
  return html`<div class="stack">
  <section class="card stack">
    <p class="muted small"><b>Bộ phận</b> gán cố định cho nhân viên (Bếp, Bar, Phục vụ…). <b>Vị trí</b> nằm trong bộ phận (Bếp: Steak, Lẩu, Nướng…), chọn theo từng ca.
      "Tối thiểu" là số người cần mỗi ngày; lịch ca báo vàng khi thiếu. Đặt 0 để không cảnh báo.</p>
    ${active.map((t) => html`<div class="dept" key=${t.id}>
      <div class="row team-row">
        <${SaveInput} id=${`tm-n${t.id}`} class="grow" value=${t.name} aria-label="Tên bộ phận" onSave=${(val) => act(() => api('PATCH', `/api/teams/${t.id}`, { name: val }), 'Đã đổi tên')} />
        <label class="row small">Tối thiểu <${SaveInput} id=${`tm-m${t.id}`} class="num-in" type="number" min="0" value=${t.min_staff} onSave=${(val) => act(() => api('PATCH', `/api/teams/${t.id}`, { min_staff: val }), 'Đã lưu')} /></label>
        <label class="check-row small"><input type="checkbox" checked=${!!t.active} onChange=${(e) => act(() => api('PATCH', `/api/teams/${t.id}`, { active: e.target.checked }), 'Đã lưu')} /> Dùng</label>
      </div>
      <div class="pos-list">
        ${t.positions.map((p) => html`<div class="row pos-row" key=${p.id}>
          <span class="muted">↳</span>
          <${SaveInput} class="grow" value=${p.name} aria-label="Tên vị trí" onSave=${(val) => act(() => api('PATCH', `/api/positions/${p.id}`, { name: val }), 'Đã đổi tên')} />
          <label class="row small">Tối thiểu <${SaveInput} class="num-in" type="number" min="0" value=${p.min_staff} onSave=${(val) => act(() => api('PATCH', `/api/positions/${p.id}`, { min_staff: val }), 'Đã lưu')} /></label>
          <button class="btn-link small" onClick=${() => confirm(`Bỏ vị trí ${p.name}? Ca cũ vẫn giữ.`) && act(() => api('PATCH', `/api/positions/${p.id}`, { active: false }), 'Đã bỏ vị trí')}>Bỏ</button>
        </div>`)}
        <div class="row pos-row"><span class="muted">+</span>
          <input class="grow" placeholder=${t.positions.length ? 'Thêm vị trí' : 'Thêm vị trí, vd Lẩu'} value=${newPos[t.id] || ''} onInput=${(e) => setNewPos({ ...newPos, [t.id]: e.target.value })} />
          <button disabled=${!(newPos[t.id] || '').trim()} onClick=${async () => { if (await act(() => api('POST', '/api/positions', { team_id: t.id, name: newPos[t.id] }), 'Đã thêm vị trí')) setNewPos({ ...newPos, [t.id]: '' }); }}>Thêm</button></div>
      </div>
    </div>`)}
    <div class="row"><input id="tm-new" class="grow" placeholder="Tên bộ phận mới, vd Bảo vệ" value=${name} onInput=${(e) => setName(e.target.value)} />
      <button class="primary" disabled=${!name.trim()} onClick=${async () => { if (await act(() => api('POST', '/api/teams', { name }), 'Đã thêm bộ phận')) setName(''); }}>Thêm bộ phận</button></div>
    ${st.data.some((t) => !t.active) ? html`<details><summary class="muted small">Bộ phận đã tắt (${st.data.filter((t) => !t.active).length})</summary>
      ${st.data.filter((t) => !t.active).map((t) => html`<label class="check-row small"><input type="checkbox" checked=${false} onChange=${() => act(() => api('PATCH', `/api/teams/${t.id}`, { active: true }), 'Đã bật lại')} /> ${t.name}</label>`)}</details>` : null}
  </section>
  <section class="card stack">
    <h3>Gộp nhiều tổ thành 1 bộ phận</h3>
    <p class="muted small">Ví dụ chọn Bếp steak, Lẩu, Topping, Thái tay, Tiếp thực → gộp thành <b>Bếp</b>. Mỗi tổ cũ thành 1 vị trí; nhân viên, ca đã xếp, checklist, kỹ năng chuyển theo, không mất dữ liệu.</p>
    <div class="chips">${active.map((t) => html`<button class=${`chip ${combine.ids.includes(t.id) ? 'on' : ''}`} onClick=${() => toggle(t.id)}>${combine.ids.includes(t.id) ? '✓ ' : ''}${t.name}</button>`)}</div>
    <div class="row"><input id="cb-name" class="grow" value=${combine.name} placeholder="Tên bộ phận sau khi gộp" onInput=${(e) => setCombine({ ...combine, name: e.target.value })} />
      <button class="primary" disabled=${!combine.ids.length || !combine.name.trim()} onClick=${async () => {
        const names = active.filter((t) => combine.ids.includes(t.id)).map((t) => t.name).join(', ');
        if (!confirm(`Gộp ${names} thành bộ phận "${combine.name}"?`)) return;
        if (await act(() => api('POST', '/api/teams/combine', { name: combine.name, team_ids: combine.ids }), 'Đã gộp')) setCombine({ name: combine.name, ids: [] });
      }}>Gộp</button></div>
  </section>
  </div>`;
}

function Utensils({ s }) {
  const st = useData('/api/utensils');
  const [nu, setNu] = useState('');
  const [nk, setNk] = useState('');
  const [guests, setGuests] = useState({});
  const [plan, setPlan] = useState(null);
  const [prm, setPrm] = useState({ wash_cycle_minutes: s.wash_cycle_minutes || '30', dining_minutes: s.dining_minutes || '70', utensil_reserve_pct: s.utensil_reserve_pct || '10' });
  if (!st.data) return html`<${Loading} state=${st} />`;
  const { utensils, kits } = st.data;
  const active = utensils.filter((u) => u.active);
  const perGuest = (k, uid) => k.items.find((i) => i.utensil_id === uid)?.per_guest ?? '';
  const setKitItem = (k, uid, val) => {
    const items = [...k.items.filter((i) => i.utensil_id !== uid), ...(Number(String(val).replace(',', '.')) > 0 ? [{ utensil_id: uid, per_guest: String(val).replace(',', '.') }] : [])];
    act(() => api('PATCH', `/api/service-kits/${k.id}`, { items }), 'Đã lưu');
  };
  const calc = async () => setPlan(await act(() => api('POST', '/api/utensils/plan', { guests })));
  return html`<div class="stack">
    <section class="card stack">
      <h3>1. Dụng cụ của quán</h3>
      <p class="muted small">Nhập <b>số đang có</b> (đếm thật). Đổi tên, thêm, hoặc bỏ chọn "Dùng" để ẩn.</p>
      ${utensils.map((u) => html`<div class="row ut-row" key=${u.id}>
        <${SaveInput} class="grow" value=${u.name} aria-label="Tên dụng cụ" onSave=${(val) => act(() => api('PATCH', `/api/utensils/${u.id}`, { name: val }), 'Đã lưu')} />
        <label class="row small">Đang có <${SaveInput} class="num-in" type="number" min="0" value=${u.on_hand} onSave=${(val) => act(() => api('PATCH', `/api/utensils/${u.id}`, { on_hand: val }), 'Đã lưu')} /></label>
        <label class="check-row small"><input type="checkbox" checked=${u.active} onChange=${(e) => act(() => api('PATCH', `/api/utensils/${u.id}`, { active: e.target.checked }), 'Đã lưu')} /> Dùng</label>
      </div>`)}
      <div class="row"><input id="ut-new" class="grow" placeholder="Dụng cụ mới, vd Kẹp gắp" value=${nu} onInput=${(e) => setNu(e.target.value)} />
        <button class="primary" disabled=${!nu.trim()} onClick=${async () => { if (await act(() => api('POST', '/api/utensils', { name: nu }), 'Đã thêm')) setNu(''); }}>Thêm</button></div>
    </section>

    <section class="card stack">
      <h3>2. Mỗi khách dùng gì</h3>
      <p class="muted small">Ghi <b>số cái cho 1 khách</b>. Dùng chung thì ghi số lẻ, vd 1 vá lẩu cho 4 khách = <b>0.25</b>. Để trống = không dùng.</p>
      <div class="table-wrap"><table class="list kit-grid">
        <thead><tr><th>Dụng cụ</th>${kits.filter((k) => k.active).map((k) => html`<th class="r">${k.name}</th>`)}</tr></thead>
        <tbody>${active.map((u) => html`<tr><td>${u.name}</td>${kits.filter((k) => k.active).map((k) => html`<td class="r">
          <${SaveInput} class="num-in" inputmode="decimal" value=${perGuest(k, u.id)} placeholder="–" aria-label=${`${u.name} cho ${k.name}`} onSave=${(val) => setKitItem(k, u.id, val)} /></td>`)}</tr>`)}</tbody>
      </table></div>
      <div class="row"><input id="kit-new" class="grow" placeholder="Kiểu phục vụ mới, vd Combo nướng" value=${nk} onInput=${(e) => setNk(e.target.value)} />
        <button disabled=${!nk.trim()} onClick=${async () => { if (await act(() => api('POST', '/api/service-kits', { name: nk, items: [] }), 'Đã thêm')) setNk(''); }}>Thêm kiểu</button></div>
      ${kits.some((k) => !k.active) || kits.length > 1 ? html`<details><summary class="muted small">Bật / tắt kiểu phục vụ</summary>
        ${kits.map((k) => html`<label class="check-row small"><input type="checkbox" checked=${k.active} onChange=${(e) => act(() => api('PATCH', `/api/service-kits/${k.id}`, { active: e.target.checked }), 'Đã lưu')} /> ${k.name}</label>`)}</details>` : null}
    </section>

    <section class="card stack">
      <h3>3. Thông số quay vòng</h3>
      <div class="row wrap">
        <${Field} label="Khách ngồi trung bình (phút)"><input type="number" min="10" value=${prm.dining_minutes} onInput=${(e) => setPrm({ ...prm, dining_minutes: e.target.value })} /><//>
        <${Field} label="Rửa xong 1 mẻ (phút)"><input type="number" min="1" value=${prm.wash_cycle_minutes} onInput=${(e) => setPrm({ ...prm, wash_cycle_minutes: e.target.value })} /><//>
        <${Field} label="Dự phòng (%)"><input type="number" min="0" value=${prm.utensil_reserve_pct} onInput=${(e) => setPrm({ ...prm, utensil_reserve_pct: e.target.value })} /><//>
      </div>
      <div class="row end"><button onClick=${() => act(() => api('PUT', '/api/settings', prm), 'Đã lưu thông số')}>Lưu thông số</button></div>
      <p class="muted small">Khi có phần Bán hàng, app tự đo thời gian ngồi thật và số khách theo giờ.</p>
    </section>

    <section class="card stack">
      <h3>4. Dự trù nhanh</h3>
      <p class="muted small">Nhập số khách <b>ngồi cùng lúc lúc đông nhất</b> của mỗi kiểu. App tính số cái cần có, gồm cả bộ đang chờ rửa và dự phòng.</p>
      <div class="row wrap">${kits.filter((k) => k.active).map((k) => html`<${Field} label=${`Khách ${k.name}`}><input type="number" min="0" inputmode="numeric" value=${guests[k.id] || ''} onInput=${(e) => setGuests({ ...guests, [k.id]: e.target.value })} /><//>`)}</div>
      <div class="row end"><button class="primary" onClick=${calc}>Tính</button></div>
      ${plan ? html`<div class="table-wrap"><table class="list">
        <thead><tr><th>Dụng cụ</th><th class="r">Trên bàn</th><th class="r">Cần có</th><th class="r">Đang có</th><th class="r">Thiếu</th></tr></thead>
        <tbody>${plan.rows.map((x) => html`<tr><td>${x.name}</td><td class="r num">${x.at_table}</td><td class="r num"><b>${x.required}</b></td><td class="r num">${x.on_hand}</td>
          <td class=${`r num ${x.short ? 'warn-text' : ''}`}>${x.short ? `−${x.short}` : '✓'}</td></tr>`)}</tbody></table></div>
        <p class="muted small">Cần có = trên bàn × ${plan.factor} (rửa ${plan.params.wash_cycle_minutes}′ / ngồi ${plan.params.dining_minutes}′, dự phòng ${plan.params.reserve_pct}%).</p>` : null}
    </section>
  </div>`;
}

function Zones() {
  const st = useData('/api/zones?all=1');
  const [nz, setNz] = useState({ name: '', tables: '' });
  if (!st.data) return html`<${Loading} state=${st} />`;
  return html`<section class="card stack">
    <p class="muted small">Mỗi khu gồm các số bàn, ghi kiểu <b>1-20</b> hoặc <b>1-10, 15, 20-22</b>. Một bàn chỉ thuộc 1 khu. Phân người vào khu khi xếp ca.</p>
    ${st.data.map((z) => html`<div class="zone-row" key=${z.id}>
      <${SaveInput} type="color" value=${z.color} aria-label="Màu" onSave=${(val) => act(() => api('PATCH', `/api/zones/${z.id}`, { color: val }), 'Đã đổi màu')} />
      <${SaveInput} class="grow" value=${z.name} aria-label="Tên khu" onSave=${(val) => act(() => api('PATCH', `/api/zones/${z.id}`, { name: val }), 'Đã đổi tên')} />
      <${SaveInput} class="grow" value=${z.tables_text} placeholder="vd 1-40" aria-label="Các bàn" onSave=${(val) => act(() => api('PATCH', `/api/zones/${z.id}`, { tables: val }), 'Đã lưu bàn')} />
      <span class="muted small">${z.table_count} bàn</span>
      <label class="check-row small"><input type="checkbox" checked=${z.active} onChange=${(e) => act(() => api('PATCH', `/api/zones/${z.id}`, { active: e.target.checked }), 'Đã lưu')} /> Dùng</label>
    </div>`)}
    <div class="row"><input id="zn-name" class="grow" placeholder="Tên khu mới, vd Khu D" value=${nz.name} onInput=${(e) => setNz({ ...nz, name: e.target.value })} />
      <input id="zn-tables" class="grow" placeholder="Bàn, vd 101-110" value=${nz.tables} onInput=${(e) => setNz({ ...nz, tables: e.target.value })} />
      <button class="primary" disabled=${!nz.name.trim()} onClick=${async () => { if (await act(() => api('POST', '/api/zones', nz), 'Đã thêm khu')) setNz({ name: '', tables: '' }); }}>Thêm khu</button></div>
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
      <p class="muted small">Một loại ca = giờ làm của <b>1 người</b>. Chỉ thêm khúc khi cùng 1 người làm 2 buổi trong ngày (ca gãy). Part-time làm giờ khác nhau thì tạo mỗi giờ thành 1 loại ca riêng. Sửa loại ca không làm đổi các ca đã xếp trước đó.</p>
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

const hmOf = (m) => (m == null ? '' : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
function ChecklistForm({ init, teams, shifts, onClose, allowAll = true }) {
  const posD = useData('/api/positions');
  const metaD = useData('/api/stock/meta');
  const ings = (metaD.data?.ingredients || []).filter((g) => g.active !== 0 && g.active !== false);
  const zonesD = useData('/api/zones');
  const staffD = useData('/api/staff');
  const [f, setF] = useState({ title: init.title || '', team_id: init.team_id ?? '', phase: init.phase || 'open', active: init.active ?? true,
    shift_template_id: init.shift_template_id ?? '', position_id: init.position_id ?? '', zone_id: init.zone_id ?? '', doer: init.doer || '', section: init.section || '', rules: init.rules || '', job_mode: !!init.job_mode, job_teams: init.job_teams || [], job_from: hmOf(init.job_from), job_to: hmOf(init.job_to),
    items: init.items?.map((i) => ({ ...i, job_with_idx: i.job_with ? init.items.findIndex((y) => y.id === i.job_with) : '' })) || [{ text: '', kind: 'check', unit: '', required: true, photo_required: true }] });
  const item = (i, k, v) => setF({ ...f, items: f.items.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const move = (i, d) => { const items = [...f.items]; const [x] = items.splice(i, 1); items.splice(i + d, 0, x); setF({ ...f, items }); };
  const save = async () => {
    const body = { ...f, team_id: f.team_id || null, shift_template_id: f.shift_template_id || null, position_id: (f.team_id && f.position_id) || null, zone_id: f.zone_id || null, items: f.items.filter((x) => x.text.trim()) };
    const ok = await act(() => (init.id ? api('PATCH', `/api/checklist-templates/${init.id}`, body) : api('POST', '/api/checklist-templates', body)), 'Đã lưu checklist');
    if (ok) onClose();
  };
  return html`<${Modal} title=${init.id ? 'Sửa checklist' : 'Thêm checklist'} onClose=${onClose} wide>
    <div class="stack">
      <div class="form-grid">
        <${Field} label="Tên checklist"><input id="cl-title" value=${f.title} onInput=${(e) => setF({ ...f, title: e.target.value })} /><//>
        <div class="field"><span>Ai làm</span>
          <div class="row wrap tight">
            <button class=${`chip ${!f.doer ? 'on' : ''}`} onClick=${() => setF({ ...f, doer: '' })}>Mọi người trong mục (mặc định)</button>
            <button class=${`chip ${f.doer ? 'on' : ''}`} onClick=${() => setF({ ...f, doer: f.doer || 'lead' })}>👤 Giao riêng</button>
          </div>
          ${f.doer ? html`<div class="row wrap tight">
            <select id="cl-doer" value=${f.doer.startsWith('staff:') ? 'staff' : f.doer} onChange=${(e) => setF({ ...f, doer: e.target.value === 'staff' ? `staff:${(staffD.data || []).find((x) => x.role !== 'owner')?.id || ''}` : e.target.value })}>
              <option value="lead">Trưởng ca</option><option value="manager">Quản lý</option><option value="staff">1 người cụ thể…</option></select>
            ${f.doer.startsWith('staff:') ? html`<select id="cl-doer-staff" value=${f.doer.slice(6)} onChange=${(e) => setF({ ...f, doer: `staff:${e.target.value}` })}>
              ${(staffD.data || []).filter((x) => x.active !== false && x.role !== 'owner').map((x) => html`<option value=${x.id}>${x.name}${x.team_name ? ` · ${x.team_name}` : ''}</option>`)}</select>` : null}
          </div><small class="muted">Chỉ người được giao thấy và làm checklist này.</small>` : null}
        </div>
      </div>
      <div class="field"><span>Cách làm</span>
        <div class="row wrap tight">
          <button class=${`chip ${!f.job_mode ? 'on' : ''}`} onClick=${() => setF({ ...f, job_mode: false })}>☑ Checklist chung (ai cũng tick)</button>
          <button class=${`chip ${f.job_mode ? 'on' : ''}`} onClick=${() => setF({ ...f, job_mode: true, job_teams: f.job_teams.length ? f.job_teams : f.team_id ? [Number(f.team_id)] : [] })}>👥 Giao việc từng người</button>
        </div>
        ${f.job_mode ? html`<small class="muted">Mỗi việc thành 1 thẻ: app gợi ý ai làm theo khu đã phân (chia đều, xoay vòng mỗi ngày, mở ca ưu tiên người vào sớm). Nhân viên bấm Nhận → Xong (+ảnh), tổ trưởng khu kiểm. Xem ở <b>Việc ca</b>.</small>
          <div class="row wrap tight"><span class="small">⏰ Khung giờ làm:</span><input type="time" value=${f.job_from} onInput=${(e) => setF({ ...f, job_from: e.target.value })} aria-label="Từ giờ" /><span>–</span><input type="time" value=${f.job_to} onInput=${(e) => setF({ ...f, job_to: e.target.value })} aria-label="Đến giờ" /></div>
          <small class="muted">vd Mở ca 14:00 – 15:30: chỉ người có ca trong khung này mới được phân việc. Để trống = theo giờ ca.</small>
          <div class="row wrap tight"><span class="small">Bộ phận làm chung:</span>${[...teams, { id: -1, name: '⭐ Trưởng ca (làm rồi đi kiểm)' }].map((t) => html`<button class=${`chip ${f.job_teams.includes(t.id) ? 'on' : ''}`} onClick=${() => setF({ ...f, job_teams: f.job_teams.includes(t.id) ? f.job_teams.filter((y) => y !== t.id) : [...f.job_teams, t.id] })}>${t.name}</button>`)}</div>` : null}
      </div>
      <div class="field"><span>Các việc</span>
        ${f.items.map((x, i) => html`<div class="item-card">
          <div class="row tight"><b class="item-no">${i + 1}.</b><input class="grow" value=${x.text} placeholder="Tên công việc (vd Lau bàn ghế khu A)" onInput=${(e) => item(i, 'text', e.target.value)} aria-label="Tên việc" />
            <button class="icon" aria-label="Bỏ" onClick=${() => setF({ ...f, items: f.items.filter((_, j) => j !== i) })}>✕</button></div>
          <div class="row wrap tight">
            <button class=${`chip ${(x.photo_required ?? x.kind === 'check') ? 'on' : ''}`} onClick=${() => item(i, 'photo_required', !(x.photo_required ?? x.kind === 'check'))}>📷 ${(x.photo_required ?? x.kind === 'check') ? 'Phải chụp ảnh' : 'Không cần ảnh'}</button>
            ${init.id && x.id ? html`<${Samples} samples=${x.samples || []} templateId=${init.id} itemId=${x.id} canEdit=${true} label="Ảnh mẫu" />` : html`<small class="muted">Ảnh mẫu: lưu xong mở lại để thêm</small>`}
          </div>
          ${f.job_mode ? html`<div class="row wrap tight job-fields">
            <button class=${`chip ${!x.job_scope || x.job_scope === 'zone' ? 'on' : ''}`} onClick=${() => item(i, 'job_scope', 'zone')}>Mỗi khu 1 người</button>
            <button class=${`chip ${x.job_scope === 'shop' ? 'on' : ''}`} onClick=${() => item(i, 'job_scope', 'shop')}>Cả quán 1 người</button>
            <button class=${`chip ${x.job_scope === 'each' ? 'on' : ''}`} onClick=${() => item(i, 'job_scope', 'each')}>Mỗi người tự làm</button>
            <label class="row tight small">⏱<input class="num-in" type="number" inputmode="numeric" min="0" value=${x.job_minutes || ''} placeholder="phút" onInput=${(e) => item(i, 'job_minutes', e.target.value)} aria-label="Thời gian chuẩn (phút)" />phút</label>
            <input class="grow" value=${x.job_qty || ''} placeholder="Số lượng (vd 200 muỗng)" onInput=${(e) => item(i, 'job_qty', e.target.value)} aria-label="Số lượng" />
            ${x.job_scope === 'zone' || !x.job_scope ? html`<label class="row tight small">hoặc mỗi bàn<input class="num-in" type="number" inputmode="decimal" min="0" step="0.5" value=${x.job_per_table || ''} placeholder="0" onInput=${(e) => item(i, 'job_per_table', e.target.value)} aria-label="Số lượng mỗi bàn" /><input class="unit" value=${x.unit || ''} placeholder="bếp, ly…" onInput=${(e) => item(i, 'unit', e.target.value)} /></label>` : null}
            <label class="row tight small">Đi kèm việc<select value=${x.job_with_idx ?? ''} onChange=${(e) => item(i, 'job_with_idx', e.target.value === '' ? '' : Number(e.target.value))} aria-label="Đi kèm việc">
              <option value="">(không)</option>${f.items.map((y, k) => (k !== i && y.text.trim() ? html`<option value=${k}>${k + 1}. ${y.text.slice(0, 30)}</option>` : null))}</select></label>
            <label class="row tight small">Số phải đủ<input class="num-in" type="number" inputmode="numeric" min="0" value=${x.job_expect || ''} placeholder="—" onInput=${(e) => item(i, 'job_expect', e.target.value)} aria-label="Số phải đủ" /></label>
            <input class="grow" value=${x.fetch_where || ''} placeholder="📦 Hết thì lấy ở đâu (vd Kệ 2 Kho bếp)" onInput=${(e) => item(i, 'fetch_where', e.target.value)} aria-label="Chỗ lấy đồ" />
          </div>` : null}
          <details class="item-more"><summary class="muted small">Tuỳ chọn (kiểu nhập số / chữ, nối kho, thứ tự)</summary><div class="row wrap tight">
          <select value=${x.kind} onChange=${(e) => setF({ ...f, items: f.items.map((y, j) => (j === i ? { ...y, kind: e.target.value, photo_required: e.target.value === 'check' } : y)) })} aria-label="Kiểu">
            <option value="check">Tick</option><option value="number">Nhập số</option><option value="text">Ghi chữ</option></select>
          ${x.kind === 'number' ? html`<input class="unit" value=${x.unit} placeholder="đơn vị" onInput=${(e) => item(i, 'unit', e.target.value)} aria-label="Đơn vị" />` : null}
          ${x.kind === 'number' && ings.length ? html`<select class="ing-link" value=${x.ingredient_id || ''} aria-label="Nối kho" onChange=${(e) => {
            const g = ings.find((y) => y.id === Number(e.target.value));
            setF({ ...f, items: f.items.map((y, j) => (j === i ? { ...y, ingredient_id: g?.id || null, store_id: g?.home_store_id || null,
              unit: g && !y.unit ? (g.unit === 'g' ? 'kg' : g.purchase_unit && g.purchase_factor > 1 && g.unit !== 'ml' ? g.purchase_unit : g.unit) : y.unit } : y)) });
          }}><option value="">Không nối kho</option>${ings.map((g) => html`<option value=${g.id}>📦 Cân tồn: ${g.name}</option>`)}</select>` : null}
          ${x.kind === 'number' && x.ingredient_id ? (() => {
            const g0 = ings.find((y) => y.id === Number(x.ingredient_id));
            const same = ings.filter((y) => g0 && y.id !== g0.id && y.unit === g0.unit && y.home_store_id === g0.home_store_id);
            const ex = x.extra_ingredient_ids || [];
            return same.length ? html`<div class="ing-link small"><span class="muted">Cân chung với (cân 1 lần cả nhóm):</span><div class="chips">${same.map((y) => html`<button class=${`chip ${ex.includes(y.id) ? 'on' : ''}`}
              onClick=${() => item(i, 'extra_ingredient_ids', ex.includes(y.id) ? ex.filter((z) => z !== y.id) : [...ex, y.id])}>${y.name}</button>`)}</div></div>` : null;
          })() : null}
          <label class="check-row small"><input type="checkbox" checked=${x.required} onChange=${(e) => item(i, 'required', e.target.checked)} />Bắt buộc</label>
          <span class="row tight">
            <button class="icon" aria-label="Lên" disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
            <button class="icon" aria-label="Xuống" disabled=${i === f.items.length - 1} onClick=${() => move(i, 1)}>↓</button>
</span>
          </div></details>
        </div>`)}
        <button class="link" onClick=${() => setF({ ...f, items: [...f.items, { text: '', kind: 'check', unit: '', required: true, photo_required: true }] })}>+ Thêm việc</button>
        <p class="muted small">Việc "Nhập số" chọn <b>📦 Cân tồn</b>: số nhân viên cân = tồn thực tế trong kho. App tự kiểm kho, so với số đã bán theo định lượng và báo nếu lệch. Đồ đếm theo cái (viên, cái…) mà đơn vị ghi là <b>bịch / gói</b> → nhân viên nhập số bịch nguyên + số lẻ.</p>
      </div>
      <${Field} label="⚠ Chế tài nếu không làm / làm sai" hint="Nhân viên thấy ngay trên đầu checklist. vd: Không chụp ảnh đóng ca: nhắc nhở lần 1, trừ 20.000đ từ lần 2">
        <textarea id="cl-rules" rows="2" value=${f.rules} onInput=${(e) => setF({ ...f, rules: e.target.value })}></textarea><//>
      <details class="cl-more"><summary class="muted">⚙ Thiết lập khác (tổ, khu, mục, mở / đóng ca, ca)</summary><div class="form-grid">
        <${Field} label="Tổ"><select id="cl-team" value=${f.team_id} onChange=${(e) => setF({ ...f, team_id: e.target.value, position_id: '' })}>
          ${allowAll ? html`<option value="">Cả quán</option>` : null}${teams.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
        ${(() => { const ps = (posD.data || []).filter((p) => p.team_id === Number(f.team_id)); return ps.length ? html`<${Field} label="Vị trí" hint="Chỉ người đứng vị trí này trong ca thấy">
          <select id="cl-pos" value=${f.position_id} onChange=${(e) => setF({ ...f, position_id: e.target.value })}><option value="">Cả bộ phận</option>${ps.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select><//>` : null; })()}
        ${(zonesD.data || []).length ? html`<${Field} label="Khu" hint="Chỉ người phụ trách khu này trong ca thấy">
          <select id="cl-zone" value=${f.zone_id} onChange=${(e) => setF({ ...f, zone_id: e.target.value })}><option value="">Mọi khu</option>${zonesD.data.map((z) => html`<option value=${z.id}>${z.name}</option>`)}</select><//>` : null}
        <${Field} label="Mục (tab trên trang Checklist)" hint="vd Bếp, Phục vụ, Thu ngân, Tổng khu A, Khu vực vệ sinh, Khu vực rửa chén. Để trống = tự theo tổ / khu">
          <input id="cl-section" list="cl-sections" value=${f.section} placeholder=${init.section_label || 'tự theo tổ / khu'} onInput=${(e) => setF({ ...f, section: e.target.value })} />
          <datalist id="cl-sections">${['Bếp', 'Bar', 'Phục vụ', 'Thu ngân', 'Tiếp thực', 'Tổng khu A', 'Tổng khu B', 'Tổng khu C', 'Khu vực vệ sinh', 'Khu vực rửa chén'].map((x) => html`<option value=${x} />`)}</datalist><//>
        <${Field} label="Thời điểm"><select id="cl-phase" value=${f.phase} onChange=${(e) => setF({ ...f, phase: e.target.value })}>
          ${Object.entries(PHASE_LABEL).filter(([k]) => k !== 'during' || f.phase === 'during').map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select><//>
        <${Field} label="Áp dụng cho ca" hint="Người làm ca nào chỉ thấy checklist của ca đó">
          <select id="cl-shift" value=${f.shift_template_id} onChange=${(e) => setF({ ...f, shift_template_id: e.target.value })}>
            <option value="">Mọi ca</option>${shifts.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
      </div></details>
      ${init.id ? html`<label class="check-row"><input type="checkbox" checked=${f.active} onChange=${(e) => setF({ ...f, active: e.target.checked })} /> Đang dùng (bỏ chọn để ẩn, vẫn giữ lịch sử)</label>` : null}
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu</button></div>
    </div>
  <//>`;
}

// Tạo & sửa checklist theo mục (chủ quán 24/10): bấm tab Phục vụ → thấy checklist Phục vụ (Mở ca / Đóng ca) → "+ Thêm" tạo luôn trong mục đó
const STD_SECTIONS = ['Bếp', 'Bar', 'Phục vụ', 'Thu ngân', 'Tiếp thực', 'Tổng khu A', 'Tổng khu B', 'Tổng khu C', 'Khu vực vệ sinh', 'Khu vực rửa chén'];
export function Checklists({ me, teams }) {
  const st = useData('/api/checklist-templates?all=1');
  const shifts = useData('/api/shift-templates');
  const zonesD = useData('/api/zones');
  const [edit, setEdit] = useState(null);
  const [sec, setSec] = useState('');
  if (!st.data) return html`<${Loading} state=${st} />`;
  const own = me && !atLeast(me, 'shift_lead');
  const list = own ? st.data.filter((c) => c.team_id === me.team?.id) : st.data;
  const myTeams = own ? teams.filter((t) => t.id === me.team?.id) : teams;
  const sections = own ? [...new Set(list.map((c) => c.section_label))] : [...new Set([...STD_SECTIONS, ...list.map((c) => c.section_label)])];
  const cur = sections.includes(sec) ? sec : sections[0] || 'Phục vụ';
  const inSec = list.filter((c) => c.section_label === cur);
  const norm = (x) => (x || '').toLowerCase().normalize('NFC');
  // Thêm mới trong mục: tự chọn tổ / khu theo tên mục
  const blank = (phase) => {
    const zone = (zonesD.data || []).find((z) => norm(cur) === norm(`tổng ${z.name}`) || norm(cur) === norm(`tổng khu ${z.name}`));
    const team = myTeams.find((t) => norm(t.name) === norm(cur)) || (zone ? myTeams.find((t) => /phục vụ/i.test(t.name)) : null) || myTeams.find((t) => norm(t.name).startsWith(norm(cur)));
    return { phase, section: STD_SECTIONS.includes(cur) || !team ? cur : '', team_id: team?.id ?? (own ? me.team?.id : ''), zone_id: zone?.id ?? '' };
  };
  const group = (phase, label) => {
    const rows = inSec.filter((c) => (phase === 'close' ? c.phase === 'close' : c.phase !== 'close'));
    return html`<section class="card stack">
      <div class="row between"><h3>${label} <small class="muted">${rows.length} checklist</small></h3>
        <button class="primary" onClick=${() => setEdit(blank(phase))}>+ Thêm</button></div>
      ${rows.length ? rows.map((c) => html`<button class=${`tpl-row2 ${c.active ? '' : 'off'}`} onClick=${() => setEdit(c)}>
        <b>${c.title}${c.active ? '' : ' (đang tắt)'}</b>
        <small class="muted">${c.items.length} việc${c.doer_name ? ` · 👤 ${c.doer_name}` : ''}${c.zone_name ? ` · 📍 ${c.zone_name}` : ''}${c.position_name ? ` · ${c.position_name}` : ''}${c.shift_name ? ` · ${c.shift_name}` : ''}</small></button>`)
        : html`<p class="muted small">Chưa có. Bấm + Thêm.</p>`}
    </section>`;
  };
  return html`<div class="stack">
    ${own ? html`<p class="small"><b>Bạn là tổ trưởng ${me.team?.name || ''}:</b> tạo và sửa checklist của tổ mình.</p>` : null}
    <div class="chips scroll-x sec-tabs">${sections.map((x) => html`<button class=${`chip big ${x === cur ? 'on' : ''}`} onClick=${() => setSec(x)}>${x} <small>${list.filter((c) => c.section_label === x).length}</small></button>`)}</div>
    ${group('open', 'Mở ca')}
    ${group('close', 'Đóng ca')}
    <p class="muted small">Ảnh mẫu (khu / từng việc) thêm ngay trên màn Checklist hằng ngày: bấm "+ Thêm ảnh mẫu".</p>
    ${edit ? html`<${ChecklistForm} init=${own && !edit.id ? { team_id: me.team?.id, ...edit } : edit} teams=${myTeams} allowAll=${!own} shifts=${(shifts.data || []).filter((t) => t.active)} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}

// Mã kết nối dịch vụ ngoài: chủ quán dán thẳng trong app (không cần vào Railway). Lưu xong chỉ hiện 4 ký tự cuối.
function Keys({ s, me, only }) {
  const [f, setF] = useState({ anthropic_api_key: '', zalo_bot_token: '' });
  const owner = me.role === 'owner';
  const save = (k, msg) => act(() => api('PUT', '/api/settings', { [k]: f[k] }), msg).then((r) => r && setF({ ...f, [k]: '' }));
  return html`<div class="stack">
    ${!owner ? html`<p class="warn-text">Chỉ chủ quán dán / đổi mã ở đây.</p>` : null}
    ${only !== 'bot' ? html`<section class="card stack"><h3>📖 Đọc bill tự động (Claude)</h3>
      <p class="small muted">Lấy mã ở console.anthropic.com → API Keys → Create Key (bắt đầu bằng sk-ant-). Nạp tiền ở mục Billing.</p>
      <${Field} label="Mã Claude" hint=${s.anthropic_api_key ? `Đã lưu (${s.anthropic_api_key}). Dán mã mới để đổi.` : 'Chưa có: nút Đọc bill sẽ báo chưa cài.'}><input id="k-claude" type="password" autocomplete="off" disabled=${!owner} value=${f.anthropic_api_key} placeholder="sk-ant-…" onInput=${(e) => setF({ ...f, anthropic_api_key: e.target.value })} /><//>
      <div class="row end"><button class="primary" disabled=${!owner || !f.anthropic_api_key} onClick=${() => save('anthropic_api_key', 'Đã lưu mã Claude')}>Lưu mã</button></div>
    </section>` : null}
    ${only !== 'claude' ? html`<section class="card stack"><h3>🤖 Zalo Bot (nhóm đặt hàng + nhóm nhân viên)</h3>
      <p class="small"><b>Bước 1:</b> dán Token bot (chuỗi dài dạng 123456789:AbCd…, không phải ID bot) rồi bấm Lưu token.</p>
      <${Field} label="Token Zalo Bot" hint=${s.zalo_bot_token ? `Đã lưu (${s.zalo_bot_token}). Dán token mới để đổi.` : 'Chưa có.'}><input id="k-zbot" type="password" autocomplete="off" disabled=${!owner} value=${f.zalo_bot_token} onInput=${(e) => setF({ ...f, zalo_bot_token: e.target.value })} /><//>
      <div class="row end"><button class="primary" disabled=${!owner || !f.zalo_bot_token} onClick=${() => save('zalo_bot_token', 'Đã lưu token Zalo Bot')}>Lưu token</button></div>
      ${owner ? html`<${BotGroup} s=${s} kind="order" /><${StaffGroups} s=${s} /><${SupplierGroups} />` : html`<p class="warn-text small">Đăng nhập bằng tài khoản chủ quán để cài bot.</p>`}
    </section>` : null}
  </div>`;
}

// Chọn nhóm Zalo cho bot: Kiểm tra bot → Tìm nhóm → Chọn → Gửi thử.
// kind 'order': nhóm đặt hàng (gửi đơn duyệt) · 'staff': nhóm nhân viên (nhắc lịch rảnh tối thứ 7)
const BOT_KINDS = {
  order: { id: 'zalo_bot_group_id', name: 'zalo_bot_group_name', test: '/api/zalo-bot/test', title: '🛒 Nhóm nhận đơn đặt hàng', none: 'chưa chọn (duyệt đơn chỉ hiện nút sao chép)', note: 'Mỗi lần anh bấm Duyệt đơn đặt hàng, app tự gửi nội dung đơn vào nhóm. Gửi lỗi thì app báo và vẫn còn nút "Chép nội dung gửi Zalo".' },
  staff: { id: 'zalo_bot_staff_group_id', name: 'zalo_bot_staff_group_name', test: '/api/zalo-bot/test-staff', title: '👥 Nhóm nhân viên (nhắc lịch rảnh)', none: 'chưa chọn', note: 'Nhân viên nhắn trong nhóm "@tên bot Tên mình 14-23\" (cả tuần), ngày khác ghi riêng: \"@bot Tên 14-23, T7 nghỉ, CN 10-23\" → bot tự điền lịch rảnh + tạo ca và trả lời ✅. Tin không có @bot thì bot không đọc được. Tối thứ 7 lúc 20:00, bot tự nhắn vào nhóm tên các bạn CHƯA báo lịch rảnh tuần tới (chỉ các bộ phận đã chọn ở trên) kèm link vào app. Nút "Nhắc người chưa báo" ở Lịch ca cũng gửi vào nhóm này.' },
};
// Bot nhận được tin nào, đã làm gì (để biết vì sao bot không trả lời)
function BotLog() {
  const [open, setOpen] = useState(0);
  const lg = useData(open ? `/api/zalo-bot/log?k=${open}` : null);
  const d = lg.data;
  const t = (ms) => (ms ? new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  return html`<div class="stack tight">
    <div class="row wrap tight"><button onClick=${() => setOpen(open + 1)}>📋 ${open ? 'Tải lại nhật ký' : 'Xem bot nhận được tin gì'}</button></div>
    ${open && d ? html`<div class="small stack tight">
      <p>Lần đọc tin gần nhất: ${d.poll ? html`<b>${t(d.poll.at)}</b> · ${d.poll.error ? html`<span class="warn-text">lỗi: ${d.poll.error}</span>` : `${d.poll.n} tin mới`}` : html`<span class="warn-text">chưa đọc lần nào (máy chủ vừa khởi động?)</span>`}</p>
      <p>Nhóm nhân viên: <b>${d.staff_group || 'chưa chọn'}</b></p>
      ${d.msgs?.length ? d.msgs.map((m) => html`<div class="card tight"><b>${t(m.at)} · ${m.from || '?'}</b> (${m.chat})<br/>"${m.text}"<br/><span class="muted">→ ${m.result}</span></div>`) : html`<p class="muted">Chưa nhận tin @bot nào từ lúc máy chủ khởi động.</p>`}
      ${d.raw ? html`<details><summary class="muted">Dữ liệu gốc (gửi Claude nếu cần)</summary><code style="word-break:break-all">${d.raw}</code></details>` : null}
    </div>` : null}
  </div>`;
}

// Nhóm Zalo của từng nhà cung cấp (chủ quán 26/10): nhắn "@bot thăn 10kg, bắp 5kg" trong nhóm → đơn chờ nhận; nhận hàng → bot báo đủ / thiếu
function SupplierGroups() {
  const d = useData('/api/zalo-bot/supplier-groups');
  if (!d.data) return html`<${Loading} state=${d} />`;
  const { groups, suppliers } = d.data;
  return html`<section class="card stack">
    <b>🛒 Nhóm nhà cung cấp</b>
    <small class="muted">Thêm bot vào nhóm Zalo của từng NCC. Đặt hàng: nhắn <b>@bot thăn bò 10kg, bắp hoa 5kg</b> → bot ghi đơn chờ nhận. Nhận hàng theo đơn → bot báo đủ / thiếu vào nhóm. Nhắn <b>@bot đơn</b> để xem 3 đơn gần nhất. Nhóm tự hiện ở đây sau tin đặt hàng đầu tiên; tên nhóm có tên NCC thì tự gắn.</small>
    ${groups.length ? groups.map((g) => html`<div class="row wrap tight">
      <span class="grow">${g.name}</span>
      <select class="auto" value=${g.supplier_id || ''} onChange=${(e) => act(() => api('PUT', '/api/zalo-bot/supplier-groups', { id: g.id, supplier_id: e.target.value || null }), 'Đã gắn NCC')}>
        <option value="">(chưa gắn NCC)</option>${suppliers.map((x) => html`<option value=${x.id}>${x.name}</option>`)}</select>
      <button class="small link" onClick=${() => act(() => api('PUT', '/api/zalo-bot/supplier-groups', { id: g.id, remove: true }), 'Đã bỏ nhóm')}>Bỏ</button></div>`)
    : html`<p class="muted small">Chưa có nhóm. Thêm bot vào nhóm NCC rồi nhắn 1 đơn @bot.</p>`}
  </section>`;
}

// Nhóm nhân viên (có thể nhiều nhóm: nhóm chung, nhóm Bếp…): bot đọc tin @bot báo lịch rảnh + tối thứ 7 nhắc người chưa báo của bộ phận đã chọn
function StaffGroups({ s }) {
  const gd = useData('/api/zalo-bot/staff-groups');
  const td = useData('/api/teams');
  const [chats, setChats] = useState(null);
  const [on, setOn] = useState(s.avail_bot_on !== '0');
  const groups = gd.data?.groups || [];
  const teams = (td.data || []).filter((t) => t.active !== 0);
  const save = (list, msg) => act(() => api('PUT', '/api/zalo-bot/staff-groups', { groups: list }), msg);
  const flip = (g, id) => save(groups.map((x) => (x.id === g.id ? { ...x, teams: x.teams.includes(id) ? x.teams.filter((y) => y !== id) : [...x.teams, id] } : x)), 'Đã lưu');
  const find = () => act(() => api('POST', '/api/zalo-bot/chats')).then((r) => r && setChats(r.chats));
  const add = (c) => save([...groups, { id: c.id, name: c.name || c.id, teams: [] }], 'Đã thêm nhóm, chọn bộ phận bên dưới').then((r) => r && setChats(null));
  const toggle = () => act(() => api('PUT', '/api/settings', { avail_bot_on: on ? '0' : '1' }), on ? 'Đã tắt nhắc tự động' : 'Đã bật nhắc tự động').then((r) => r && setOn(!on));
  return html`<section class="card stack">
    <h3>👥 Nhóm nhân viên (báo lịch rảnh)</h3>
    <p class="small muted">Nhân viên nhắn trong nhóm "@tên bot Tên 14-23" (cả tuần), ngày khác ghi riêng: "@bot Tên 14-23, T7 nghỉ, CN 10-23" → bot tự điền lịch rảnh + tạo ca và trả lời ✅. Tối thứ 5, 6, 7 lúc 20:00 bot nhắn vào từng nhóm tên người CHƯA báo của các bộ phận đã chọn cho nhóm đó.</p>
    ${!groups.length ? html`<p class="warn-text small">Chưa có nhóm nào.</p>` : null}
    ${groups.map((g) => html`<div class="card tight stack">
      <div class="row wrap"><b class="grow">${g.name}</b>
        <button class="small" onClick=${() => act(() => api('POST', '/api/zalo-bot/test-staff', { id: g.id }), 'Đã gửi, mở nhóm Zalo xem')}>Gửi thử</button>
        <button class="small" onClick=${() => confirm(`Bỏ nhóm ${g.name}?`) && save(groups.filter((x) => x.id !== g.id), 'Đã bỏ nhóm')}>Bỏ</button></div>
      <span class="small">Nhắc tên các bộ phận:</span>
      <div class="row wrap tight">${teams.map((t) => html`<button class=${`chip ${g.teams.includes(t.id) ? 'on' : ''}`} onClick=${() => flip(g, t.id)}>${g.teams.includes(t.id) ? '✓ ' : ''}${t.name}</button>`)}</div>
      ${!g.teams.length ? html`<p class="small warn-text">Chưa chọn bộ phận → bot vẫn ghi lịch từ nhóm này nhưng không nhắc ai.</p>` : null}
    </div>`)}
    <ol class="plain steps small"><li>Gửi link mời bot vào nhóm, trưởng nhóm bấm Xác nhận.</li><li>Trong nhóm nhắn "@tên bot" kèm giờ (ví dụ "@bot Tên 14-23"). Bot tự thêm nhóm vào đây; hoặc bấm "Tìm nhóm".</li><li>Chọn bộ phận cho nhóm.</li></ol>
    <div class="row wrap"><button onClick=${find}>Tìm nhóm</button>
      <button class=${`chip ${on ? 'on' : ''}`} onClick=${toggle}>${on ? '🔔 Tự nhắc tối T5, T6, T7: BẬT' : '🔕 Tự nhắc tối T5, T6, T7: TẮT'}</button></div>
    ${chats ? (chats.filter((c) => !groups.some((g) => g.id === c.id)).length ? chats.filter((c) => !groups.some((g) => g.id === c.id)).map((c) => html`<button class="tpl-row" onClick=${() => add(c)}><b class="grow">+ ${c.name || '(không tên)'}</b><span class="muted">${c.text ? `"${c.text.slice(0, 30)}"` : ''}</span></button>`)
      : html`<p class="warn-text small">Không thấy nhóm mới. Nhắn @bot trong nhóm rồi bấm lại.</p>`) : null}
    <${BotLog} />
  </section>`;
}

// Bộ phận bot nhắc tên trong nhóm (mặc định Phục vụ + Tiếp thực)
function BotTeams({ s }) {
  const st = useData('/api/teams');
  const [sel, setSel] = useState(s.avail_bot_teams || []);
  const teams = (st.data?.teams || st.data || []).filter((t) => t.active !== 0);
  const flip = (id) => {
    const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
    act(() => api('PUT', '/api/settings', { avail_bot_teams: next }), 'Đã lưu').then((r) => r && setSel(next));
  };
  return html`<div class="stack tight"><b class="small">Bot nhắc tên các bộ phận:</b>
    <div class="row wrap tight">${teams.map((t) => html`<button class=${`chip ${sel.includes(t.id) ? 'on' : ''}`} onClick=${() => flip(t.id)}>${sel.includes(t.id) ? '✓ ' : ''}${t.name}</button>`)}</div>
    ${!sel.length ? html`<p class="small warn-text">Chưa chọn bộ phận nào → bot nhắc cả quán.</p>` : null}</div>`;
}

function BotGroup({ s, kind = 'order' }) {
  const K = BOT_KINDS[kind];
  const [bot, setBot] = useState(null);
  const [chats, setChats] = useState(null);
  const [grp, setGrp] = useState({ id: s[K.id] || '', name: s[K.name] || '' });
  const [on, setOn] = useState(s.avail_bot_on !== '0');
  const check = () => act(() => api('POST', '/api/zalo-bot/check'), 'Bot chạy được').then((r) => r && setBot(r.bot));
  const find = () => act(() => api('POST', '/api/zalo-bot/chats')).then((r) => r && setChats(r.chats));
  const pick = (c) => act(() => api('PUT', '/api/settings', { [K.id]: c.id, [K.name]: c.name || c.id }), 'Đã chọn nhóm').then((r) => { if (r) { setGrp({ id: c.id, name: c.name || c.id }); setChats(null); } });
  const off = () => act(() => api('PUT', '/api/settings', { [K.id]: '', [K.name]: '' }), 'Đã tắt gửi nhóm').then((r) => r && setGrp({ id: '', name: '' }));
  const toggle = () => act(() => api('PUT', '/api/settings', { avail_bot_on: on ? '0' : '1' }), on ? 'Đã tắt nhắc tự động' : 'Đã bật nhắc tự động').then((r) => r && setOn(!on));
  return html`<section class="card stack">
    <h3>${K.title}</h3>
    <div class="row wrap"><button onClick=${check}>Kiểm tra bot</button>
      ${bot ? html`<span class="ok-text">✓ ${bot.account_name || bot.display_name || bot.name || 'Bot'} </span>` : null}</div>
    <p class="small"><b>Nhóm:</b> ${grp.id ? html`${grp.name} <button class="small" onClick=${off}>Bỏ nhóm</button>` : html`<span class="muted">${K.none}</span>`}</p>
    <ol class="plain steps small">
      <li>Thêm bot vào nhóm Zalo.</li>
      <li>Trong nhóm, nhắn <b>@tên bot</b> một câu bất kỳ (ví dụ "@bot xin chào").</li>
      <li>Bấm "Tìm nhóm", chọn đúng nhóm, rồi "Gửi thử".</li>
    </ol>
    <div class="row wrap"><button onClick=${find}>Tìm nhóm</button>${grp.id ? html`<button class="primary" onClick=${() => act(() => api('POST', K.test), 'Đã gửi, mở nhóm Zalo xem')}>Gửi thử vào nhóm</button>` : null}</div>
    ${chats ? (chats.length ? chats.map((c) => html`<button class="tpl-row" onClick=${() => pick(c)}><b class="grow">${c.name || '(không tên)'}</b><span class="muted">${c.type}${c.text ? ` · "${c.text.slice(0, 30)}"` : ''}</span></button>`)
      : html`<p class="warn-text small">Chưa thấy tin nào. Nhắn @bot trong nhóm rồi bấm lại.</p>`) : null}
    ${kind === 'staff' ? html`<${BotTeams} s=${s} /><${BotLog} />` : null}
    ${kind === 'staff' && grp.id ? html`<button class=${`chip ${on ? 'on' : ''}`} onClick=${toggle}>${on ? '🔔 Tự nhắc tối T5, T6, T7: BẬT' : '🔕 Tự nhắc tối T5, T6, T7: TẮT'}</button>` : null}
    <p class="small muted">${K.note}</p>
  </section>`;
}

function Zalo({ s }) {
  const [f, setF] = useState(s);
  useEffect(() => setF(s), [s]);
  const set = (k, v) => setF({ ...f, [k]: v });
  const hook = `${(s.public_url || location.origin)}${s.zalo_webhook_path}`;
  return html`<div class="stack">
    <section class="card row wrap"><b class="grow">Cài Zalo Bot (gửi đơn vào nhóm) không ở đây.</b><button class="primary" onClick=${() => navigate('/cai-dat?tab=bot')}>🤖 Sang tab Zalo Bot</button></section>
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
    <div class="row wrap"><button class="primary" onClick=${async () => { const r = await act(() => api('POST', '/api/backup'), 'Đã sao lưu'); if (r) setList(r.backups); }}>Sao lưu ngay</button>
      <a class="btn" href="/api/backup/download" download>⬇ Tải toàn bộ dữ liệu về máy (chủ quán)</a></div>
    <p class="muted small">File tải về dùng để chuyển dữ liệu sang máy chủ ở quán (đặt vào thư mục <code>may-chu-quan</code> rồi chạy <b>khoi-phuc.bat</b>) hoặc cất giữ.</p>
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

// Quyền chi tiết TỪNG NGƯỜI (chủ quán 26/10): chọn 1 người → tick từng việc trong từng mục
function ActsFor({ id, staff, onDone }) {
  const d = useData(`/api/permissions/acts?staff_id=${id}`);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  // Chỉ lấy lại từ máy chủ khi chưa có bản nháp (mở lần đầu / vừa lưu): app tự tải lại mỗi khi có thao tác trong quán,
  // trước đây làm mất các ô vừa tick chưa kịp lưu (chủ quán 28/10)
  const noDraft = draft === null;
  useEffect(() => { if (d.data && noDraft) setDraft(Object.fromEntries(d.data.groups.flatMap((g) => g.acts.map((a) => [a.key, a.on])))); }, [d.data, noDraft]);
  if (!d.data || !draft) return html`<${Loading} state=${d} />`;
  const x = d.data;
  if (x.owner) return html`<p class="muted">Chủ quán luôn có mọi quyền.</p>`;
  const all = x.groups.flatMap((g) => g.acts);
  const changed = all.filter((a) => draft[a.key] !== a.on).length;
  const save = async () => {
    setBusy(true);
    try { const r = await act(() => api('PUT', '/api/permissions/acts', { staff_id: id, overrides: Object.fromEntries(all.map((a) => [a.key, draft[a.key] === a.def ? null : draft[a.key]])) }), `Đã lưu quyền của ${x.staff.name}`); void r; } finally { setBusy(false); }
  };
  const copyFrom = async (otherId) => {
    if (!otherId) return;
    try { // rà soát 28/10: lỗi mạng / quyền thì báo, không im lặng
      const o = await api('GET', `/api/permissions/acts?staff_id=${otherId}`);
      setDraft(Object.fromEntries(o.groups.flatMap((g) => g.acts.map((a) => [a.key, a.on]))));
      toast('Đã chép, bấm Lưu để áp dụng');
    } catch (e) { toast(e.message, true); }
  };
  const setGroup = (g, val) => setDraft({ ...draft, ...Object.fromEntries(g.acts.map((a) => [a.key, val])) });
  return html`<div class="stack">
    <div class="row wrap between"><span><b>${x.staff.name}</b> <small class="muted">${ROLE_SHORT[x.staff.role] || x.staff.role}${x.staff.team_name ? ` · ${x.staff.team_name}` : ''}</small></span>
      <select id="acts-copy" class="auto" onChange=${(e) => { copyFrom(Number(e.target.value)); e.target.value = ''; }}>
        <option value="">Chép quyền từ người khác…</option>${staff.filter((s) => s.id !== id).map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select></div>
    <small class="muted">☑ = được làm. Ô có dấu <b>•</b> là bạn đã chỉnh riêng cho người này (khác mặc định theo chức vụ / bộ phận).</small>
    ${x.groups.map((g) => { const on = g.acts.filter((a) => draft[a.key]).length; return html`<details class="card stack" open=${on > 0 && on < g.acts.length}>
      <summary class="row between"><b>${g.name}</b><small class="muted">${on}/${g.acts.length}</small></summary>
      <div class="row wrap tight"><button class="small" onClick=${() => setGroup(g, true)}>Bật hết</button><button class="small" onClick=${() => setGroup(g, false)}>Tắt hết</button><button class="small link" onClick=${() => setDraft({ ...draft, ...Object.fromEntries(g.acts.map((a) => [a.key, a.def])) })}>Mặc định</button></div>
      ${g.acts.map((a) => html`<label class="row tight" style=${draft[a.key] !== a.on ? 'background:var(--warn-bg, #fff4d6);border-radius:6px' : ''}>
        <input type="checkbox" id=${`act-${a.key}`} checked=${!!draft[a.key]} onChange=${(e) => setDraft({ ...draft, [a.key]: e.target.checked })} />
        <span class="grow">${a.label}${(draft[a.key] !== a.def) ? html` <b class="warn-text">•</b>` : null}</span></label>`)}
    </details>`; })}
    <div class="row wrap end" style="position:sticky;bottom:0;background:var(--bg, #fff);padding:8px 0">
      <button class="link small" onClick=${async () => { if (await act(() => api('PUT', '/api/permissions/acts', { staff_id: id, reset: true }), 'Đã về mặc định')) setDraft(Object.fromEntries(all.map((a) => [a.key, a.def]))); }}>↺ Về hết mặc định</button>
      <button class="primary" disabled=${busy || !changed} onClick=${save}>${changed ? `Lưu ${changed} thay đổi` : 'Đã lưu'}</button></div>
  </div>`;
}
// Theo từng người (chủ quán 28/10): danh sách nhân sự theo bộ phận, bấm tên để phân quyền
const TEAM_ORDER = ['Quản lý', 'Bếp', 'Lẩu', 'Bar', 'Thu ngân', 'Tiếp thực', 'Phục vụ', 'Tạp vụ'];
function UserActs({ staffId }) {
  const st = useData('/api/staff');
  const [id, setId] = useState(staffId || '');
  const [q, setQ] = useState('');
  if (!st.data) return html`<${Loading} state=${st} />`;
  const staff = st.data.filter((s) => s.active && s.role !== 'owner').sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  if (id) return html`<div class="stack">
    <button class="small" style="align-self:flex-start" onClick=${() => setId('')}>← Danh sách nhân sự</button>
    <${ActsFor} key=${id} id=${id} staff=${staff} /></div>`;
  const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  const list = staff.filter((s) => !q || fold(s.name).includes(fold(q)));
  const groupOf = (s) => (s.team_name ? s.team_name : ['manager', 'shift_lead'].includes(s.role) ? 'Quản lý' : 'Chưa có bộ phận');
  const groups = [...new Set(list.map(groupOf))].sort((a, b) => ((TEAM_ORDER.indexOf(a) + 1) || 99) - ((TEAM_ORDER.indexOf(b) + 1) || 99) || a.localeCompare(b, 'vi'));
  const rk = { manager: 0, shift_lead: 1, team_lead: 2, staff: 3 };
  return html`<div class="stack">
    <input id="acts-q" placeholder="🔍 Tìm tên" value=${q} onInput=${(e) => setQ(e.target.value)} />
    <small class="muted">Bấm vào tên 1 người để tick bật / tắt từng việc cho người đó.</small>
    ${groups.map((g) => { const ps = list.filter((s) => groupOf(s) === g).sort((a, b) => (rk[a.role] ?? 9) - (rk[b.role] ?? 9) || a.name.localeCompare(b.name, 'vi')); return html`<section class="card stack tight">
      <div class="row between"><b>${g}</b><small class="muted">${ps.length} người</small></div>
      <div class="row wrap tight">${ps.map((s) => html`<button class="chip" onClick=${() => setId(s.id)}>${s.name}${s.role !== 'staff' ? html` <small class="muted">· ${ROLE_SHORT[s.role] || s.role}</small>` : null}</button>`)}</div>
    </section>`; })}
    ${!list.length ? html`<p class="muted">Không tìm thấy ai.</p>` : null}
  </div>`;
}
function PermTabs({ staffId }) {
  const [mode, setMode] = useState('nguoi');
  return html`<div class="stack">
    <div class="tabs"><button class=${mode === 'nguoi' ? 'on' : ''} onClick=${() => setMode('nguoi')}>👤 Theo từng người</button><button class=${mode === 'muc' ? 'on' : ''} onClick=${() => setMode('muc')}>📋 Theo mục</button></div>
    ${mode === 'nguoi' ? html`<${UserActs} staffId=${staffId} />` : html`<${Perms} staffId=${staffId} />`}
  </div>`;
}

// Phân quyền từng mục: tick vai trò được thấy, cấp / chặn riêng từng người. Chủ quán luôn thấy hết.
const ROLE_SHORT = { staff: 'Nhân viên', team_lead: 'Tổ trưởng', shift_lead: 'Trưởng ca', manager: 'Quản lý' };
const ROLE_ABBR = { staff: 'NV', team_lead: 'TT', shift_lead: 'TC', manager: 'QL' };
function Perms({ staffId }) {
  const d = useData('/api/permissions');
  const [cfg, setCfg] = useState(null);
  const [who, setWho] = useState(staffId || null);
  const [matrix, setMatrix] = useState(false);
  // Chỉ nạp lần đầu: tải lại tự động không được xoá phần đang sửa chưa lưu (chủ quán 28/10)
  const noCfg = cfg === null;
  useEffect(() => { if (d.data && noCfg) setCfg(Object.fromEntries(d.data.pages.map((p) => [p.path, { roles: p.roles, allow: p.allow, deny: p.deny, teams: p.teams }]))); }, [d.data, noCfg]);
  if (!d.data || !cfg) return html`<${Loading} state=${d} />`;
  const { roles, pages, staff, teams = [] } = d.data;
  const orig = JSON.stringify(Object.fromEntries(pages.map((p) => [p.path, { roles: p.roles, allow: p.allow, deny: p.deny, teams: p.teams }])));
  const dirty = JSON.stringify(cfg) !== orig;
  const set = (path, patch) => setCfg((c) => ({ ...c, [path]: { ...c[path], ...patch } }));
  const save = () => act(() => api('PUT', '/api/permissions', { pages: cfg }), 'Đã lưu phân quyền');
  const person = staff.find((x) => x.id === who);
  // Người này có thấy mục không: chặn riêng > cấp riêng > cấp bậc (+ tổ Thu ngân)
  const LEAD = ['shift_lead', 'manager'];
  const teamOk = (p, x) => LEAD.includes(x.role) || !Array.isArray(cfg[p.path].teams) || cfg[p.path].teams.includes(x.team_id);
  const byRole = (p, x) => (cfg[p.path].roles.includes(x.role) && teamOk(p, x)) || (p.team && x.team_name === p.team);
  const toggleTeam = (path, id) => { const cur = cfg[path].teams; const list = Array.isArray(cur) ? cur : teams.map((t) => t.id); set(path, { teams: list.includes(id) ? list.filter((y) => y !== id) : [...list, id] }); };
  const sees = (p, x) => p.fixed || (!cfg[p.path].deny.includes(x.id) && (cfg[p.path].allow.includes(x.id) || byRole(p, x)));
  const flip = (p, x) => {
    const c = cfg[p.path]; const on = sees(p, x);
    const allow = c.allow.filter((i) => i !== x.id); const deny = c.deny.filter((i) => i !== x.id);
    if (on && byRole(p, x)) deny.push(x.id); else if (!on && !byRole(p, x)) allow.push(x.id);
    set(p.path, { allow, deny });
  };
  const resetPerson = (x) => { for (const p of pages) set(p.path, { allow: cfg[p.path].allow.filter((i) => i !== x.id), deny: cfg[p.path].deny.filter((i) => i !== x.id) }); };
  const custom = (x) => pages.filter((p) => cfg[p.path].allow.includes(x.id) || cfg[p.path].deny.includes(x.id)).length;
  const toggleRole = (path, r) => { const c = cfg[path]; set(path, { roles: c.roles.includes(r) ? c.roles.filter((y) => y !== r) : [...c.roles, r] }); };
  const groups = roles.slice().reverse().map((r) => ({ r, people: staff.filter((x) => x.role === r) })).filter((g) => g.people.length);
  const bar = html`<div class="sum-bar row end">${dirty ? html`<span class="grow warn-text small">Chưa lưu</span>` : null}<button class="primary big" disabled=${!dirty} onClick=${save}>Lưu phân quyền</button></div>`;

  if (person) return html`<div class="stack">
    <button class="small" onClick=${() => setWho(null)}>← Danh sách nhân viên</button>
    <section class="card"><h3>🔐 ${person.name}</h3>
      <p class="small muted">${ROLE_SHORT[person.role]}${person.team_name ? ` · ${person.team_name}` : ''}. Tick mục bạn này được thấy và dùng. Mặc định theo cấp bậc; mục anh đổi riêng có chữ <b>riêng</b>.</p></section>
    <section class="card stack perm-list">${pages.map((p) => { const on = sees(p, person); const own = cfg[p.path].allow.includes(person.id) || cfg[p.path].deny.includes(person.id); return html`
      <label class=${`perm-row ${on ? 'on' : ''}`}><input type="checkbox" checked=${on} disabled=${p.fixed} onChange=${() => flip(p, person)} />
        <span class="grow">${p.label}</span>${own ? html`<b class="pill warn">riêng</b>` : p.fixed ? html`<small class="muted">ai cũng có</small>` : null}</label>`; })}</section>
    <div class="row between"><button class="small" onClick=${() => resetPerson(person)}>Về mặc định theo cấp bậc</button></div>
    ${bar}
  </div>`;

  return html`<div class="stack">
    <section class="card"><p class="small">Bấm tên nhân viên → tick từng quyền của bạn đó. Quyền mặc định lấy theo <b>cấp bậc</b> (Nhân viên / Tổ trưởng / Trưởng ca / Quản lý), anh chỉ cần sửa chỗ khác. Chủ quán luôn thấy hết.</p></section>
    ${groups.map((g) => html`<section class="card stack"><h3>${ROLE_SHORT[g.r]} <small class="muted">${g.people.length} người</small></h3>
      ${g.people.map((x) => html`<button class="tpl-row" onClick=${() => setWho(x.id)}><b class="grow">${x.name}</b><span class="muted">${x.team_name || ''}${custom(x) ? ` · ${custom(x)} quyền riêng` : ''} · ${pages.filter((p) => sees(p, x)).length} mục</span></button>`)}
    </section>`)}
    <section class="card stack"><h3>Theo bộ phận</h3>
      <p class="small muted">Nhân viên / Tổ trưởng chỉ thấy mục khi thuộc bộ phận được tick. Trưởng ca, quản lý thấy hết. Muốn cho riêng 1 người thì bấm tên người đó ở trên rồi tick.</p>
      ${pages.filter((p) => !p.fixed && cfg[p.path].roles.some((r) => !LEAD.includes(r))).map((p) => { const t = cfg[p.path].teams; return html`<div class="stack tight perm-team">
        <div class="row"><b class="grow small">${p.label}</b>${Array.isArray(t) ? html`<button class="small" onClick=${() => set(p.path, { teams: null })}>Mọi bộ phận</button>` : html`<small class="muted">mọi bộ phận</small>`}</div>
        <div class="row wrap">${teams.map((tm) => html`<button class=${`chip ${!Array.isArray(t) || t.includes(tm.id) ? 'on' : ''}`} onClick=${() => toggleTeam(p.path, tm.id)}>${tm.name}</button>`)}</div></div>`; })}
    </section>
    <section class="card stack"><button class="link-btn" onClick=${() => setMatrix(!matrix)}><b>${matrix ? '▾' : '▸'} Mặc định theo cấp bậc</b> <small class="muted">(áp cho người mới / người chưa đổi riêng)</small></button>
      ${matrix ? html`<p class="small muted">NV = Nhân viên · TT = Tổ trưởng · TC = Trưởng ca · QL = Quản lý</p>
      <div class="perm-wrap"><table class="perm"><thead><tr><th>Mục</th>${roles.map((r) => html`<th title=${ROLE_SHORT[r]}>${ROLE_ABBR[r]}</th>`)}</tr></thead>
        <tbody>${pages.map((p) => html`<tr><td>${p.label}${p.team ? html`<small class="muted"> + tổ ${p.team}</small>` : null}</td>
          ${roles.map((r) => html`<td><input type="checkbox" aria-label=${`${p.label} – ${ROLE_SHORT[r]}`} disabled=${p.fixed} checked=${cfg[p.path].roles.includes(r)} onChange=${() => toggleRole(p.path, r)} /></td>`)}</tr>`)}</tbody></table></div>` : null}
    </section>
    ${bar}
  </div>`;
}

// 💵 Khung lương theo bộ phận × chức vụ (chủ quán 29/10, chỉ chủ): nhân viên "theo khung" tự lấy mức này
function PayScales() {
  const st = useData('/api/pay-scales');
  const [draft, setDraft] = useState(null);
  const [from, setFrom] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const val = (t, r, k) => draft?.[`${t}|${r}`]?.[k] ?? d.teams.find((x) => x.id === t).scales[r][k];
  const set = (t, r, k, x) => setDraft({ ...(draft || {}), [`${t}|${r}`]: { ...(draft?.[`${t}|${r}`] || {}), [k]: x } });
  const unit = (x) => ({ hour: 'giờ', shift: 'ca', month: 'tháng' })[x];
  const save = async () => {
    setBusy(true);
    const items = Object.entries(draft || {}).map(([k]) => { const [t, r] = k.split('|'); return { team_id: Number(t), role: r, pay_type: val(Number(t), r, 'pay_type'), pay_rate: Number(String(val(Number(t), r, 'pay_rate') || 0).replace(/[.,\s]/g, '')) || 0 }; });
    try { if (await act(() => api('PUT', '/api/pay-scales', { from_month: from || d.month, items }), 'Đã lưu khung lương')) setDraft(null); } finally { setBusy(false); }
  };
  return html`<div class="stack">
    <section class="card stack tight">
      <p class="small">Mỗi bộ phận × chức vụ 1 mức. Nhân viên <b>theo khung</b> tự lấy mức này, không phải điền tay từng người. Đổi khung thì mọi người trong khung đổi theo. Người có đặc quyền: bật <b>Lương riêng</b> trong form nhân viên.</p>
      <p class="small muted">Để trống / 0 = chưa có khung (người đó dùng mức riêng cũ nếu có).</p>
    </section>
    <${OtCard} d=${d} />
    ${d.teams.map((t) => html`<section class="card stack tight" key=${t.id}><h3>${t.name}</h3>
      ${d.roles.map((r) => html`<div class="scale-row" key=${r.key}>
        <span><b>${r.label}</b><br /><small class="muted">${t.scales[r.key].count} người</small></span>
        <input inputmode="numeric" placeholder="0" value=${val(t.id, r.key, 'pay_rate') || ''} onInput=${(e) => set(t.id, r.key, 'pay_rate', e.target.value)} />
        <select value=${val(t.id, r.key, 'pay_type')} onChange=${(e) => set(t.id, r.key, 'pay_type', e.target.value)}><option value="hour">/giờ</option><option value="shift">/ca</option><option value="month">/tháng</option></select>
      </div>`)}
    </section>`)}
    ${draft ? html`<section class="card stack tight sticky-acts">
      <label class="small">Áp dụng từ tháng <input type="month" value=${from || d.month} onInput=${(e) => setFrom(e.target.value)} /></label>
      <small class="muted">Tháng trước giữ mức cũ. Chọn tháng sau để đặt trước.</small>
      <div class="row tight"><button class="primary grow" disabled=${busy} onClick=${save}>Lưu khung lương</button><button onClick=${() => setDraft(null)}>Huỷ</button></div>
    </section>` : null}
    ${d.custom.length ? html`<section class="card stack tight"><h3>Đang lương riêng (${d.custom.length})</h3>
      <small class="muted">Người có mức nhập tay. Chuyển về theo khung khi không còn đặc quyền.</small>
      ${d.custom.map((p) => html`<div class="row between wrap" key=${p.id}><span><b>${p.name}</b> <small class="muted">${p.team_name} · ${p.role_label}</small><br /><small>${money0(p.pay_rate)}/${unit(p.pay_type)}${p.scale ? html` · khung: ${money0(p.scale.pay_rate)}/${unit(p.scale.pay_type)}` : html` · <span class="muted">chưa có khung</span>`}</small></span>
        <button class="small" disabled=${!p.scale} onClick=${() => act(() => api('POST', '/api/pay-scales/use', { ids: [p.id], custom: false }), `${p.name}: theo khung`)}>Theo khung</button></div>`)}
      ${d.custom.some((p) => p.scale) ? html`<button onClick=${() => confirm('Chuyển mọi người đã có khung về theo khung?') && act(() => api('POST', '/api/pay-scales/use', { ids: d.custom.filter((p) => p.scale).map((p) => p.id), custom: false }), 'Đã chuyển')}>Chuyển tất cả người đã có khung → theo khung</button>` : null}
    </section>` : null}
    ${d.no_scale.length ? html`<section class="card stack tight warn-card"><b>${d.no_scale.length} người theo khung nhưng bộ phận × chức vụ chưa có mức</b>
      <small>${d.no_scale.map((p) => `${p.name} (${p.team_name || 'chưa có bộ phận'} · ${p.role_label})`).join(', ')}</small></section>` : null}
  </div>`;
}
const money0 = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
// Lương tháng (bếp) + làm thêm ca sáng: giải thích bằng ví dụ theo khung đang có (chủ quán 29/10)
function OtCard({ d }) {
  const [f, setF] = useState(null);
  const ot = { ...d.ot, ...(f || {}) };
  const num = (x) => Number(String(x).replace(',', '.')) || 0;
  const ex = d.teams.flatMap((t) => d.roles.filter((r) => t.scales[r.key].pay_type === 'month' && t.scales[r.key].pay_rate > 0).map((r) => ({ name: `${t.name} · ${r.label}`, rate: t.scales[r.key].pay_rate })));
  const hourDays = num(ot.hour_days) || 30, hourHours = num(ot.hour_hours) || num(ot.daily_hours) || 8;
  const set = (k, x) => setF({ ...(f || {}), [k]: x });
  return html`<section class="card stack tight">
    <h3>⏱ Lương tháng & làm thêm giờ</h3>
    <p class="small">Ca chuẩn làm đủ <b>${ot.daily_hours} giờ</b>/ngày (vd 14–23) = 1 ngày công. Làm thêm ngoài ca chuẩn (vd ca sáng 8–12) → cộng tiền số giờ đó.
      Giá 1 giờ = lương tháng ÷ <b>${hourDays}</b> ngày ÷ <b>${hourHours}</b> giờ${num(ot.rate) !== 1 ? html` × <b>${ot.rate}</b>` : ''}. Nghỉ ${ot.paid_off} ngày/tháng vẫn đủ lương.</p>
    ${ex.slice(0, 4).map((x) => { const h = x.rate / hourDays / hourHours * (num(ot.rate) || 1); return html`<div class="small">• <b>${x.name}</b> ${money0(x.rate)}/tháng → 1 giờ thêm <b>${money0(Math.round(h))}</b> · ca sáng 8–12 (4 giờ) <b>${money0(Math.round(h * 4 / 1000) * 1000)}</b></div>`; })}
    <details><summary class="small">Chỉnh cách tính</summary>
      <div class="scale-row"><span class="small">Giờ ca chuẩn / ngày (quá là làm thêm)</span><input inputmode="numeric" value=${ot.daily_hours} onInput=${(e) => set('daily_hours', e.target.value)} /><span></span></div>
      <div class="scale-row"><span class="small">Giá 1 giờ: chia số ngày</span><input inputmode="numeric" value=${ot.hour_days} onInput=${(e) => set('hour_days', e.target.value)} /><span></span></div>
      <div class="scale-row"><span class="small">Giá 1 giờ: chia số giờ</span><input inputmode="numeric" value=${ot.hour_hours} onInput=${(e) => set('hour_hours', e.target.value)} /><span></span></div>
      <div class="scale-row"><span class="small">Hệ số giờ làm thêm (1 = như giờ thường)</span><input inputmode="decimal" value=${ot.rate} onInput=${(e) => set('rate', e.target.value)} /><span></span></div>
      <div class="scale-row"><span class="small">Ngày nghỉ vẫn đủ lương / tháng</span><input inputmode="numeric" value=${ot.paid_off} onInput=${(e) => set('paid_off', e.target.value)} /><span></span></div>
      ${f ? html`<button class="primary" onClick=${async () => { if (await act(() => api('PUT', '/api/settings', { ot_daily_hours: ot.daily_hours, ot_hour_days: ot.hour_days, ot_hour_hours: ot.hour_hours, ot_rate: ot.rate, month_paid_off_days: ot.paid_off }), 'Đã lưu cách tính')) setF(null); }}>Lưu cách tính</button>` : null}
    </details>
  </section>`;
}

export function SettingsView({ me, query }) {
  const tab = query.get('tab') || 'chung';
  const st = useData('/api/settings');
  const staff = useData('/api/staff');
  const ver = useData('/api/version');
  return html`<div class="stack">
    ${ver.data ? html`<small class="muted">Phiên bản đang chạy: <b>${ver.data.version}</b> · khởi động ${hm(ver.data.started_at)} ${dayLabel(new Date(ver.data.started_at + 7 * 3600e3).toISOString().slice(0, 10))}</small>` : null}
    <div class="tabs scroll">${TABS.filter(([k]) => !['quyen', 'luong'].includes(k) || me.role === 'owner').map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => navigate(`/cai-dat?tab=${k}`)}>${l}</button>`)}</div>
    ${!st.data ? html`<${Loading} state=${st} />`
      : tab === 'chung' ? html`<${General} s=${st.data} staff=${(staff.data || []).filter((p) => p.active)} />`
      : tab === 'to' ? html`<${Teams} />`
      : tab === 'khu' ? html`<${Zones} />`
      : tab === 'dung-cu' ? html`<${Utensils} s=${st.data} />`
      : tab === 'ca' ? html`<${Templates} />`
      : tab === 'checklist' ? html`<${Checklists} me=${me} teams=${me.teams} />`
      : tab === 'ketnoi' ? html`<${Keys} s=${st.data} me=${me} only="claude" />`
      : tab === 'bot' ? html`<${Keys} s=${st.data} me=${me} only="bot" />`
      : tab === 'luong' ? (me.role === 'owner' ? html`<${PayScales} />` : html`<p class="warn-text">Chỉ chủ quán xem / sửa khung lương.</p>`)
      : tab === 'quyen' ? (me.role === 'owner' ? html`<${PermTabs} staffId=${Number(query.get('staff')) || null} />` : html`<p class="warn-text">Chỉ chủ quán phân quyền.</p>`)
      : tab === 'zalo' ? html`<${Zalo} s=${st.data} />`
      : tab === 'saoluu' ? html`<${Backups} s=${st.data} />`
      : html`<${Audit} />`}
  </div>`;
}
