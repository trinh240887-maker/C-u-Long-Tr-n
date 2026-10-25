import { useState } from 'preact/hooks';
import { html, api, act, useData, Modal, Field, Loading, Confirm, hm, dt, dayLabel, addDays, hours, money, localInput, atLeast, navigate } from '../ui.js';

function RecordForm({ init, staff, onClose, canDelete }) {
  const [f, setF] = useState({
    staff_id: init.staff_id || staff[0]?.id, clock_in: init.clock_in ? localInput(init.clock_in) : '',
    clock_out: init.clock_out ? localInput(init.clock_out) : '', note: init.note || '',
  });
  const [ask, setAsk] = useState(false);
  const set = (k, v) => setF({ ...f, [k]: v });
  const save = async () => {
    const ok = await act(() => (init.id ? api('PATCH', `/api/attendance/${init.id}`, f) : api('POST', '/api/attendance', f)), 'Đã lưu');
    if (ok) onClose();
  };
  return html`<${Modal} title=${init.id ? `Sửa chấm công: ${init.staff_name}` : 'Thêm lượt chấm công'} onClose=${onClose}>
    <div class="stack">
      ${!init.id ? html`<${Field} label="Nhân viên"><select id="rf-staff" value=${f.staff_id} onChange=${(e) => set('staff_id', Number(e.target.value))}>
        ${staff.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>` : null}
      <div class="row">
        <${Field} label="Giờ vào"><input id="rf-in" type="datetime-local" value=${f.clock_in} onInput=${(e) => set('clock_in', e.target.value)} /><//>
        <${Field} label="Giờ ra"><input id="rf-out" type="datetime-local" value=${f.clock_out} onInput=${(e) => set('clock_out', e.target.value)} /><//>
      </div>
      <${Field} label="Ghi chú (lý do sửa)"><input id="rf-note" value=${f.note} onInput=${(e) => set('note', e.target.value)} /><//>
      <div class="row between">
        ${init.id && canDelete ? html`<button class="danger" onClick=${() => setAsk(true)}>Xoá</button>` : html`<span></span>`}
        <div class="row"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu</button></div>
      </div>
    </div>
    ${ask ? html`<${Confirm} text="Xoá lượt chấm công này?" danger yes="Xoá" onClose=${() => setAsk(false)}
      onYes=${async () => { if (await act(() => api('DELETE', `/api/attendance/${init.id}`), 'Đã xoá')) onClose(); }} />` : null}
  <//>`;
}

function Records({ me }) {
  const [date, setDate] = useState(me.today);
  const st = useData(`/api/attendance?from=${date}&to=${date}`);
  const staff = useData('/api/staff');
  const [edit, setEdit] = useState(null);
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Hôm trước" onClick=${() => setDate(addDays(date, -1))}>‹</button>
        <input id="att-date" type="date" value=${date} onInput=${(e) => e.target.value && setDate(e.target.value)} />
        <button class="icon" aria-label="Hôm sau" onClick=${() => setDate(addDays(date, 1))}>›</button>
        <b>${dayLabel(date, { long: true })}</b>
      </div>
      <button onClick=${() => setEdit({})}>+ Thêm tay</button>
    </div>
    ${!st.data ? html`<${Loading} state=${st} />` : st.data.length ? html`<div class="table-wrap"><table class="list">
      <thead><tr><th>Nhân viên</th><th>Ca</th><th>Vào</th><th>Ra</th><th class="r">Giờ tính lương</th><th>Ghi chú</th></tr></thead>
      <tbody>${st.data.map((r) => {
        const mins = r.clock_out ? Math.round((r.clock_out - r.clock_in) / 60000) : null;
        const fmt = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        return html`<tr class="click" onClick=${() => setEdit(r)}>
          <td><b>${r.staff_name}</b><br /><small class="muted">${r.team_name || ''}</small></td>
          <td>${r.start_min != null ? `${fmt(r.start_min)}–${fmt(r.end_min)}` : html`<span class="pill warn">Ngoài lịch</span>`}</td>
          <td>${hm(r.clock_in)}${r.late_minutes ? html` <span class="pill warn">trễ ${r.late_minutes}′</span>` : null}
            ${r.late_photo ? html`<br /><a class="small" href=${`/api/attendance/${r.id}/late-photo`} target="_blank" rel="noopener" onClick=${(e) => e.stopPropagation()}>📷 ảnh nón + khăn</a>` : null}</td>
          <td>${r.clock_out ? dt(r.clock_out) : html`<span class="pill ok">Đang làm</span>`}${r.auto_closed ? html` <span class="pill bad">tự đóng</span>` : null}</td>
          <td class="r num">${r.paid_minutes != null ? hours(r.paid_minutes) : '—'}${mins != null && r.paid_minutes != null && mins !== r.paid_minutes ? html`<br /><small class="muted">thực tế ${hours(mins)}</small>` : null}
            ${r.early_minutes > 0 ? html`<br /><span class="pill warn">về sớm ${r.early_minutes}′</span>` : null}
            ${r.ot_minutes > 0 && me.role === 'owner' ? html`<br /><span class=${`pill ${r.ot_status === 'approved' ? 'ok' : 'muted'}`}>ở lại ${r.ot_minutes}′ ${r.ot_status === 'approved' ? '· đã tính thêm' : '· không tính'}</span>
              <div class="row end tight" onClick=${(e) => e.stopPropagation()}>${r.ot_status === 'approved'
                ? html`<button class="small" onClick=${() => act(() => api('POST', `/api/attendance/${r.id}/overtime`, { approve: false }), 'Đã bỏ phần tính thêm')}>Bỏ tính thêm</button>`
                : html`<button class="small" onClick=${() => act(() => api('POST', `/api/attendance/${r.id}/overtime`, { approve: true }), 'Đã tính thêm vào lương')}>Tính thêm ${r.ot_minutes}′</button>`}</div>` : null}</td>
          <td><small>${r.note}${r.edited_by_name ? ` (sửa: ${r.edited_by_name})` : ''}</small></td>
        </tr>`;
      })}</tbody></table></div>` : html`<div class="empty">Chưa có ai chấm công ngày này.</div>`}
    ${edit && staff.data ? html`<${RecordForm} init=${edit} staff=${staff.data.filter((s) => s.active)} canDelete=${atLeast(me, 'manager')} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}

function Timesheet({ me }) {
  const [month, setMonth] = useState(me.today.slice(0, 7));
  const st = useData(`/api/timesheet?month=${month}`);
  const shiftMonth = (n) => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)); };
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Tháng trước" onClick=${() => shiftMonth(-1)}>‹</button>
        <input id="ts-month" type="month" value=${month} onInput=${(e) => e.target.value && setMonth(e.target.value)} />
        <button class="icon" aria-label="Tháng sau" onClick=${() => shiftMonth(1)}>›</button>
      </div>
      ${st.data ? html`<b>Tổng lương tạm tính: ${money(st.data.total_pay)}</b>` : null}
    </div>
    ${!st.data ? html`<${Loading} state=${st} />` : html`<div class="table-wrap"><table class="list">
      <thead><tr><th>Nhân viên</th><th class="r">Số ca</th><th class="r">Giờ làm</th><th class="r">Giờ đêm</th><th class="r">Trễ</th><th class="r">Vắng</th><th class="r">Lương tạm tính</th></tr></thead>
      <tbody>${st.data.rows.map((r) => html`<tr>
        <td><b>${r.name}</b><br /><small class="muted">${r.pay_rate ? `${money(r.pay_rate)}/${({ hour: 'giờ', shift: 'ca', month: 'tháng' })[r.pay_type]}` : 'Chưa có mức lương'}</small></td>
        <td class="r num">${r.shifts}</td><td class="r num">${hours(r.minutes)}</td><td class="r num">${hours(r.night_minutes)}</td>
        <td class="r num">${r.late_count ? `${r.late_count} lần` : '—'}</td>
        <td class="r num">${r.absent ? html`<span class="bad-text">${r.absent}</span>` : '—'}</td>
        <td class="r num"><b>${money(r.pay)}</b>${r.open_records || r.auto_closed ? html`<br /><small class="warn-text">cần kiểm tra</small>` : null}</td>
      </tr>`)}</tbody></table></div>
      <p class="muted small">Lương theo giờ có cộng phụ cấp làm đêm ${st.data.night_bonus_pct}% cho giờ từ 22h–6h. Ca gãy tính là 1 ca. Lương tháng = lương tháng × số ngày công / ${st.data.month_standard_days || 'đủ'} ${st.data.month_standard_days ? 'ngày công chuẩn' : '(trả cố định)'}.
        Đây là số tạm tính để tham khảo, chưa gồm thưởng, phạt, bảo hiểm và tăng ca ngày lễ. Bạn tự đối chiếu với quy định của quán và Bộ luật Lao động.</p>`}
  </div>`;
}

export function AttendanceView({ me, query }) {
  const tab = query.get('tab') || 'ngay';
  return html`<div class="stack">
    <div class="tabs">
      <button class=${tab === 'ngay' ? 'on' : ''} onClick=${() => navigate('/cham-cong')}>Theo ngày</button>
      ${atLeast(me, 'manager') ? html`<button class=${tab === 'bang-cong' ? 'on' : ''} onClick=${() => navigate('/cham-cong?tab=bang-cong')}>Bảng công & lương</button>` : null}
    </div>
    ${tab === 'bang-cong' && atLeast(me, 'manager') ? html`<${Timesheet} me=${me} />` : html`<${Records} me=${me} />`}
  </div>`;
}
