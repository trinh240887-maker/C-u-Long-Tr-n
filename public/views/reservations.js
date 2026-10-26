import { useState, useEffect } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, Modal, Field, dayLabel, addDays, navigate, atLeast } from '../ui.js';
import { QR } from './pay.js';

const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const LABEL = { requested: 'Chờ xác nhận', booked: 'Đã đặt', waiting: 'Đang chờ', arrived: 'Đã đến', no_show: 'Không đến', cancelled: 'Đã huỷ' };

function Form({ init, date, zones, onClose }) {
  const walkin = init.kind === 'walkin';
  const [f, setF] = useState({
    kind: init.kind || 'booking', name: init.name || '', phone: init.phone || '', guests: init.guests || 2, date: init.date || date,
    time: init.time_min !== undefined ? fmtMin(init.time_min) : '19:00', zone_id: init.zone_id ?? '', tables: init.tables || '',
    priority: !!init.priority, fixed_table: !!init.fixed_table, note: init.note || '',
  });
  const set = (k, val) => setF({ ...f, [k]: val });
  const sug = useData(!walkin && f.guests && /^\d\d:\d\d$/.test(f.time)
    ? `/api/reservations/suggest?date=${f.date}&time=${f.time}&guests=${f.guests}${f.zone_id ? `&zone_id=${f.zone_id}` : ''}${init.id ? `&except=${init.id}` : ''}` : null);
  const save = async () => {
    const body = { ...f, zone_id: f.zone_id || null, guests: Number(f.guests) };
    const r = await act(() => (init.id ? api('PATCH', `/api/reservations/${init.id}`, body) : api('POST', '/api/reservations', body)), walkin ? 'Đã thêm vào danh sách chờ' : 'Đã đặt bàn');
    if (r) onClose();
  };
  return html`<${Modal} title=${init.id ? 'Sửa đặt bàn' : walkin ? 'Thêm khách chờ' : 'Đặt bàn mới'} onClose=${onClose}>
    <div class="stack">
      <div class="form-grid">
        <${Field} label="Tên khách"><input id="rv-name" value=${f.name} onInput=${(e) => set('name', e.target.value)} /><//>
        <${Field} label=${walkin ? 'SĐT (tuỳ chọn)' : 'Số điện thoại'}><input id="rv-phone" type="tel" value=${f.phone} onInput=${(e) => set('phone', e.target.value)} /><//>
        <${Field} label="Số khách"><input id="rv-guests" inputmode="numeric" value=${f.guests} onInput=${(e) => set('guests', e.target.value.replace(/\D/g, ''))} /><//>
        ${!walkin ? html`
          <${Field} label="Ngày"><input id="rv-date" type="date" value=${f.date} onInput=${(e) => set('date', e.target.value)} /><//>
          <${Field} label="Giờ đến"><input id="rv-time" type="time" value=${f.time} onInput=${(e) => set('time', e.target.value)} /><//>
          <${Field} label="Khu muốn ngồi"><select value=${f.zone_id} onChange=${(e) => set('zone_id', e.target.value)}><option value="">Khu nào cũng được</option>${zones.map((z) => html`<option value=${z.id}>${z.name}</option>`)}</select><//>` : null}
      </div>
      ${!walkin ? html`<details class="stack" open=${!!init.tables || !!init.openTables}><summary class="muted">Xếp bàn luôn (không bắt buộc: quản lý xếp sau cũng được)</summary>
        <${Field} label="Giữ bàn" hint="Bấm gợi ý bên dưới, hoặc ghi số bàn vd 12, 13"><input id="rv-tables" inputmode="numeric" value=${f.tables} placeholder="chưa giữ bàn" onInput=${(e) => set('tables', e.target.value)} /><//>
        ${sug.data?.length ? html`<div class="chips">${sug.data.map((x) => html`<button class=${`chip ${f.tables === x.tables_text ? 'on' : ''}`} onClick=${() => set('tables', x.tables_text)}>
          ${x.zone_name} · bàn ${x.tables_text} <small>${x.seats} chỗ${x.busy_now ? ' · đang có khách' : ''}</small></button>`)}</div>` : sug.data ? html`<p class="warn-text small">Không còn bàn trống đủ chỗ giờ này.</p>` : null}
        <label class="check-row"><input type="checkbox" checked=${f.fixed_table} onChange=${(e) => set('fixed_table', e.target.checked)} /> Khách chọn bàn này: không tự đổi bàn (bàn còn khách thì app báo gấp quản lý)</label></details>` : null}
      <${Field} label="Ghi chú"><input id="rv-note" value=${f.note} placeholder="vd sinh nhật, ghế em bé, dị ứng tôm" onInput=${(e) => set('note', e.target.value)} /><//>
      <label class="check-row"><input type="checkbox" checked=${f.priority} onChange=${(e) => set('priority', e.target.checked)} /> Khách ưu tiên (VIP / nhóm đông): steak in máy Ưu tiên</label>
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu</button></div>
    </div>
  <//>`;
}

function Arrive({ rv, onClose }) {
  const [tables, setTables] = useState(rv.tables || '');
  const [guests, setGuests] = useState(rv.guests);
  const go = async () => {
    const r = await act(() => api('POST', `/api/reservations/${rv.id}/arrive`, { tables, guests: Number(guests) }), 'Đã mở bàn');
    if (r?.session_id) navigate(`/goi-mon?s=${r.session_id}`);
  };
  return html`<${Modal} title=${`${rv.name} đã đến`} onClose=${onClose}><div class="stack">
    <${Field} label="Ngồi bàn"><input id="ar-tables" inputmode="numeric" value=${tables} placeholder="vd 12, 13" onInput=${(e) => setTables(e.target.value)} /><//>
    <${Field} label="Số khách thực tế"><input id="ar-guests" inputmode="numeric" value=${guests} onInput=${(e) => setGuests(e.target.value.replace(/\D/g, ''))} /><//>
    <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary big" disabled=${!tables.trim()} onClick=${go}>Mở bàn & gọi món</button></div>
  </div><//>`;
}

export function ReservationsView({ me, query }) {
  const [date, setDate] = useState(query.get('date') || me.today);
  const [tab, setTab] = useState('booking');
  const [edit, setEdit] = useState(null);
  const [arrive, setArrive] = useState(null);
  const [confirmX, setConfirmX] = useState(null);
  const [reject, setReject] = useState(null);
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(id); }, []);
  const st = useData(`/api/reservations?date=${date}`);
  const zonesD = useData('/api/zones');
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const nowMin = (() => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':'); return Number(p[0]) * 60 + Number(p[1]); })();
  const list = d.items.filter((x) => x.kind === tab);
  const active = list.filter((x) => ['booked', 'waiting'].includes(x.status));
  const done = list.filter((x) => !['booked', 'waiting'].includes(x.status));
  const setStatus = (x, status, msg) => act(() => api('PATCH', `/api/reservations/${x.id}`, { status }), msg);
  const row = (x) => {
    const late = date === me.today && x.kind === 'booking' && x.status === 'booked' && nowMin > x.time_min + d.hold_minutes;
    return html`<section class=${`card rv-card ${x.status} ${late ? 'late' : ''}`} key=${x.id}>
      <div class="row between">
        <div><b class="big-num">${x.kind === 'booking' ? fmtMin(x.time_min) : `#${x.id}`}</b> <b>${x.name}</b> · ${x.guests} khách ${x.priority ? html`<span class="pill warn">Ưu tiên</span>` : null} ${x.fixed_table ? html`<span class="pill">Giữ đúng bàn</span>` : null}</div>
        <span class=${`pill ${x.status === 'arrived' ? 'ok' : x.status === 'no_show' ? 'bad' : late ? 'bad' : 'muted'}`}>${late ? `Trễ ${nowMin - x.time_min}′` : LABEL[x.status]}</span>
      </div>
      <small class="muted">${x.phone ? html`<a href=${`tel:${x.phone}`}>${x.phone}</a> · ` : null}${x.tables ? `Bàn ${x.tables}` : 'Chưa giữ bàn'}${x.zone_name ? ` · ${x.zone_name}` : ''}${x.note ? ` · ${x.note}` : ''}</small>
      ${x.history && (x.history.no_show || x.history.arrived) ? html`<small class=${x.history.no_show ? 'warn-text' : 'muted'}>Khách cũ: đến ${x.history.arrived} lần${x.history.no_show ? `, bỏ đặt ${x.history.no_show} lần` : ''}</small>` : null}
      ${['booked', 'waiting'].includes(x.status) ? html`<div class="row wrap end">
        ${x.kind === 'booking' && !x.tables ? html`<button class="primary" onClick=${() => setEdit({ ...x, openTables: true })}>Xếp bàn</button>` : null}
        <button onClick=${() => setEdit(x)}>Sửa</button>
        ${x.kind === 'booking' ? html`<button onClick=${() => setStatus(x, 'no_show', 'Đã ghi không đến')}>Không đến</button>` : null}
        <button onClick=${() => setStatus(x, 'cancelled', 'Đã huỷ')}>Huỷ</button>
        <button class="primary" onClick=${() => setArrive(x)}>${x.kind === 'booking' ? 'Khách đến' : 'Có bàn → mời vào'}</button></div>`
        : x.session_id ? html`<div class="row end"><button onClick=${() => navigate(`/goi-mon?s=${x.session_id}`)}>Xem bàn →</button></div>` : null}
    </section>`;
  };
  return html`<div class="stack">
    ${atLeast(me, 'manager') ? html`<${HoldSettings} d=${d} />` : null}
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Hôm trước" onClick=${() => setDate(addDays(date, -1))}>‹</button>
        <b>${dayLabel(date, { long: true })}</b>
        <button class="icon" aria-label="Hôm sau" onClick=${() => setDate(addDays(date, 1))}>›</button>
      </div>
      <span class="muted small">${d.guests} khách đặt trước · giữ bàn ${d.hold_minutes}′</span>
    </div>
    <div class="tabs"><button class=${tab === 'booking' ? 'on' : ''} onClick=${() => setTab('booking')}>Đặt bàn (${d.items.filter((x) => x.kind === 'booking' && x.status === 'booked').length})</button>
      <button class=${tab === 'walkin' ? 'on' : ''} onClick=${() => setTab('walkin')}>Khách chờ (${d.items.filter((x) => x.kind === 'walkin' && x.status === 'waiting').length})</button></div>
    ${tab === 'booking' ? d.items.filter((x) => x.status === 'requested').map((x) => html`<section class="card stack warn-card" key=${x.id}>
      <div class="row between wrap"><b>🌐 Đặt online · ${fmtMin(x.time_min)} · ${x.name} · ${x.guests} khách</b><span class="pill warn">Chờ xác nhận</span></div>
      <small><a href=${`tel:${x.phone}`}>${x.phone}</a>${x.zone_name ? ` · muốn ngồi ${x.zone_name}` : ''}${x.note ? ` · ${x.note}` : ''}</small>
      ${x.history && (x.history.no_show || x.history.arrived) ? html`<small class=${x.history.no_show ? 'warn-text' : 'muted'}>Khách cũ: đến ${x.history.arrived} lần${x.history.no_show ? `, bỏ đặt ${x.history.no_show} lần` : ''}</small>` : null}
      <div class="row wrap end"><button class="danger" onClick=${() => setReject(x)}>Từ chối</button><button class="primary" onClick=${() => setConfirmX(x)}>Chọn bàn & xác nhận</button></div>
    </section>`) : null}
    <button class="primary big" onClick=${() => setEdit({ kind: tab, date })}>${tab === 'booking' ? '+ Đặt bàn mới' : '+ Thêm khách chờ'}</button>
    ${active.length ? active.map(row) : html`<div class="empty">${tab === 'booking' ? 'Chưa có đặt bàn ngày này.' : 'Không có khách đang chờ.'}</div>`}
    ${done.length ? html`<details><summary class="muted small">Đã xử lý (${done.length})</summary><div class="stack">${done.map(row)}</div></details>` : null}
    ${edit ? html`<${Form} init=${edit} date=${date} zones=${zonesD.data || []} onClose=${() => setEdit(null)} />` : null}
    ${arrive ? html`<${Arrive} rv=${arrive} onClose=${() => setArrive(null)} />` : null}
    ${confirmX ? html`<${ConfirmOnline} rv=${confirmX} onClose=${() => setConfirmX(null)} />` : null}
    ${reject ? html`<${RejectOnline} rv=${reject} onClose=${() => setReject(null)} />` : null}
    ${atLeast(me, 'manager') ? html`<${ShareBooking} />` : null}
  </div>`;
}

// Quy định giữ bàn (quản lý chỉnh): khoá bàn trước giờ đặt X phút, giữ thêm Y phút nếu khách trễ
function HoldSettings({ d }) {
  const [b, setB] = useState(String(d.block_minutes));
  const [h, setH] = useState(String(d.hold_minutes));
  const [bt, setBt] = useState(d.brief_time || '16:00');
  const dirty = b !== String(d.block_minutes) || h !== String(d.hold_minutes) || bt !== (d.brief_time || '16:00');
  return html`<details class="card small">
    <summary>Giữ bàn: khoá trước giờ đặt <b>${d.block_minutes}′</b> · chờ khách trễ <b>${d.hold_minutes}′</b></summary>
    <div class="row wrap" style="margin-top:8px">
      <label>Khoá trước <input type="number" min="0" max="240" style="width:5em" value=${b} onInput=${(e) => setB(e.target.value)} /> phút</label>
      <label>Chờ trễ <input type="number" min="0" max="120" style="width:5em" value=${h} onInput=${(e) => setH(e.target.value)} /> phút</label>
      <label>Gửi tóm tắt cho ca lúc <input type="time" value=${bt} onInput=${(e) => setBt(e.target.value)} /></label>
      ${dirty ? html`<button class="primary" onClick=${() => act(() => api('PUT', '/api/settings', { reserve_block_minutes: b, reserve_hold_minutes: h, booking_brief_time: bt }), 'Đã lưu')}>Lưu</button>` : null}
    </div>
    <p class="muted">Trước giờ đặt quá ${d.block_minutes}′ thì bàn vẫn nhận khách vãng lai bình thường. Trong ${d.block_minutes}′ trước giờ đặt, phục vụ bấm vào bàn phải xác nhận. Khách trễ quá ${d.hold_minutes}′ thì bàn trả lại.</p>
    <p class="muted">Tự động: nhận khách vãng lai vào bàn sắp có khách đặt → app cảnh báo và gợi ý bàn khác. 30′ trước giờ đặt báo cả ca. 20′ trước mà bàn còn khách → tự chuyển đơn sang bàn trống và báo; hết bàn thì báo gấp quản lý. Khách trễ ${d.hold_minutes}′ → nhắc gọi khách hoặc bấm "Không đến".</p>
  </details>`;
}

// Xác nhận đơn khách đặt online: chọn bàn (gợi ý bàn trống đủ chỗ) → app báo khách qua Zalo
function ConfirmOnline({ rv, onClose }) {
  const hhmm = fmtMin(rv.time_min);
  const sug = useData(`/api/reservations/suggest?date=${rv.date}&time=${hhmm}&guests=${rv.guests}${rv.zone_id ? `&zone_id=${rv.zone_id}` : ''}`);
  const [tables, setTables] = useState('');
  const ok = async () => {
    const r = await act(() => api('POST', `/api/reservations/${rv.id}/confirm`, { tables }), 'Đã xác nhận đặt bàn');
    if (r) { if (!r.notified) alert(`${r.notify_error || 'Chưa gửi được Zalo'}.\nGọi báo khách: ${rv.phone}`); onClose(); }
  };
  return html`<${Modal} title=${`Xác nhận: ${rv.name} · ${rv.guests} khách · ${hhmm}`} onClose=${onClose}>
    <div class="stack">
      <b class="small">Bàn trống gợi ý</b>
      ${sug.data ? html`<div class="chips">${sug.data.map((x) => html`<button class=${`chip ${tables === x.tables_text ? 'on' : ''}`} onClick=${() => setTables(x.tables_text)}>${x.zone_name} · ${x.tables_text} (${x.seats} chỗ)</button>`)}</div>` : html`<${Loading} state=${sug} />`}
      <${Field} label="Hoặc nhập bàn"><input value=${tables} onInput=${(e) => setTables(e.target.value)} placeholder="vd 81, 82" /><//>
      <p class="muted small">Xác nhận xong app gửi Zalo cho khách (nếu đã cài Zalo ZNS); chưa cài thì gọi điện báo khách.</p>
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" disabled=${!tables.trim()} onClick=${ok}>Xác nhận</button></div>
    </div>
  <//>`;
}

function RejectOnline({ rv, onClose }) {
  const [reason, setReason] = useState('');
  return html`<${Modal} title=${`Từ chối đặt bàn: ${rv.name}`} onClose=${onClose}>
    <div class="stack">
      <${Field} label="Lý do (khách sẽ thấy)"><input value=${reason} onInput=${(e) => setReason(e.target.value)} /><//>
      <div class="chips">${['Khung giờ này kín bàn, mời anh/chị chọn giờ khác', 'Quán nghỉ ngày này', 'Không liên lạc được số điện thoại'].map((x) => html`<button class=${`chip ${reason === x ? 'on' : ''}`} onClick=${() => setReason(x)}>${x}</button>`)}</div>
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="danger" disabled=${!reason.trim()} onClick=${() => act(() => api('POST', `/api/reservations/${rv.id}/reject`, { reason }), 'Đã từ chối').then((r) => r && onClose())}>Từ chối</button></div>
    </div>
  <//>`;
}

// Link + mã QR trang khách tự đặt bàn (dán lên Facebook, Google Maps, in để bàn) + cài Zalo xác nhận
function ShareBooking() {
  const url = `${location.origin}/datban`;
  const st = useData('/api/settings');
  const [f, setF] = useState(null);
  const s = st.data || {};
  const cur = f || { online_booking_enabled: s.online_booking_enabled, online_open: s.online_open, online_last: s.online_last, online_max_guests: s.online_max_guests, online_min_lead_minutes: s.online_min_lead_minutes,
    zns_enabled: s.zns_enabled, zns_mode: s.zns_mode, zns_template_confirm: s.zns_template_confirm, zns_template_reject: s.zns_template_reject, zns_template_remind: s.zns_template_remind, zns_template_cancel: s.zns_template_cancel, zns_template_queue: s.zns_template_queue, zns_template_ready: s.zns_template_ready };
  const set = (k, val) => setF({ ...cur, [k]: val });
  const inp = (k, label, extra = {}) => html`<${Field} label=${label}><input value=${cur[k] ?? ''} onInput=${(e) => set(k, e.target.value)} ...${extra} /><//>`;
  return html`<details class="card small"><summary><b>Đặt bàn online & Zalo xác nhận</b> · ${s.online_booking_enabled === '0' ? 'đang tắt' : 'đang nhận'}${s.zns_enabled === '1' ? ` · Zalo ${s.zns_mode === 'production' ? 'đang gửi thật' : 'chế độ thử'}` : ' · chưa bật Zalo'}</summary>
    ${st.data ? html`<div class="stack" style="margin-top:8px">
      <label class="check-row"><input type="checkbox" checked=${cur.online_booking_enabled !== '0'} onChange=${(e) => set('online_booking_enabled', e.target.checked ? '1' : '0')} /> Nhận đặt bàn online</label>
      <div class="row">${inp('online_open', 'Nhận từ giờ', { type: 'time' })}${inp('online_last', 'Đến giờ (giờ đến muộn nhất)', { type: 'time' })}</div>
      <div class="row">${inp('online_max_guests', 'Tối đa khách / đơn', { inputmode: 'numeric' })}${inp('online_min_lead_minutes', 'Đặt trước tối thiểu (phút)', { inputmode: 'numeric' })}</div>
      <b>Zalo xác nhận cho khách (ZNS)</b>
      <p class="muted">Cần: OA đã xác thực, tài khoản Zalo Cloud có nạp ví, App được cấp quyền ZNS, mẫu tin loại "Giao dịch" đã duyệt (≈300đ/tin). Tham số mẫu phải đúng tên:
        xác nhận <code>customer_name, booking_code, booking_date, booking_time, guests, table_no</code>; từ chối <code>customer_name, booking_code, booking_date, booking_time, reason</code>; nhắc trước 2 giờ <code>customer_name, booking_code, booking_date, booking_time, table_no</code>; vào danh sách chờ <code>customer_name, queue_no, guests, wait_minutes</code>; đã có bàn <code>customer_name, table_no, hold_minutes</code>. Zalo chỉ gửi 6:00–22:00.</p>
      <label class="check-row"><input type="checkbox" checked=${cur.zns_enabled === '1'} onChange=${(e) => set('zns_enabled', e.target.checked ? '1' : '0')} /> Bật gửi Zalo cho khách</label>
      <div class="chips">${[['development', 'Thử (chỉ gửi quản trị viên OA, không mất tiền)'], ['production', 'Gửi thật cho khách']].map(([k, l]) => html`<button class=${`chip ${cur.zns_mode === k ? 'on' : ''}`} onClick=${() => set('zns_mode', k)}>${l}</button>`)}</div>
      ${inp('zns_template_confirm', 'Mã mẫu "Xác nhận đặt bàn"', { inputmode: 'numeric' })}
      ${inp('zns_template_reject', 'Mã mẫu "Từ chối đặt bàn"', { inputmode: 'numeric' })}
      ${inp('zns_template_remind', 'Mã mẫu "Nhắc trước 2 giờ" (để trống = không nhắc)', { inputmode: 'numeric' })}
      ${inp('zns_template_cancel', 'Mã mẫu "Quá giờ giữ bàn, quán đã huỷ" (customer_name, booking_code, booking_date, booking_time, hold_minutes)', { inputmode: 'numeric' })}
      ${inp('zns_template_queue', 'Mã mẫu "Đã vào danh sách chờ" (số thứ tự, chờ khoảng bao lâu)', { inputmode: 'numeric' })}
      ${inp('zns_template_ready', 'Mã mẫu "Đã có bàn, mời vào"', { inputmode: 'numeric' })}
      ${f ? html`<button class="primary" onClick=${() => act(() => api('PUT', '/api/settings', f), 'Đã lưu').then((ok) => ok && setF(null))}>Lưu</button>` : null}
    </div>` : null}
    <div class="stack center" style="margin-top:8px">
      <${QR} data=${url} size=${180} />
      <code>${url}</code>
      <button onClick=${() => { navigator.clipboard?.writeText(url); alert('Đã chép link'); }}>Chép link</button>
      <p class="muted">Dán link lên Facebook, Zalo OA, Google Maps; in mã QR để ở quầy / tờ rơi.</p>
    </div>
  </details>`;
}
