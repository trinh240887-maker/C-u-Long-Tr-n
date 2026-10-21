import { useState } from 'preact/hooks';
import { html, api, act, useData, Modal, Field, Loading, money, ROLE_LABEL, atLeast } from '../ui.js';

const ROLES = ['staff', 'team_lead', 'shift_lead', 'manager', 'owner'];

function StaffForm({ me, init, teams, onClose }) {
  const isNew = !init.id;
  const [f, setF] = useState({
    name: init.name || '', phone: init.phone || '', role: init.role || 'staff', team_id: init.team_id ?? '',
    pay_type: init.pay_type || 'hour', pay_rate: init.pay_rate ?? '', weekly_limit_hours: init.weekly_limit_hours ?? 48,
    zalo_user_id: init.zalo_user_id || '', active: init.active ?? true, pin: '',
    skills: init.skills || [],
  });
  const set = (k, v) => setF({ ...f, [k]: v });
  const allowed = ROLES.filter((r) => me.role === 'owner' || ROLES.indexOf(r) < ROLES.indexOf(me.role));
  const skillOf = (id) => f.skills.find((s) => s.team_id === id)?.level || 0;
  const setSkill = (id, level) => set('skills', [...f.skills.filter((s) => s.team_id !== id), ...(level ? [{ team_id: id, level }] : [])]);
  const needPin = ROLES.indexOf(f.role) >= ROLES.indexOf('manager') ? 6 : 4;
  const save = async () => {
    const body = { ...f, team_id: f.team_id || null, pay_rate: Number(f.pay_rate || 0) };
    if (!body.pin) delete body.pin;
    const ok = await act(() => (isNew ? api('POST', '/api/staff', body) : api('PATCH', `/api/staff/${init.id}`, body)), isNew ? 'Đã thêm nhân viên' : 'Đã lưu');
    if (ok) onClose();
  };
  return html`<${Modal} title=${isNew ? 'Thêm nhân viên' : `Sửa: ${init.name}`} onClose=${onClose} wide>
    <div class="form-grid">
      <${Field} label="Họ tên"><input id="st-name" value=${f.name} onInput=${(e) => set('name', e.target.value)} /><//>
      <${Field} label="Số điện thoại"><input id="st-phone" type="tel" value=${f.phone} onInput=${(e) => set('phone', e.target.value)} /><//>
      <${Field} label="Vai trò"><select id="st-role" value=${f.role} onChange=${(e) => set('role', e.target.value)}>
        ${(allowed.includes(f.role) ? allowed : [f.role, ...allowed]).map((r) => html`<option value=${r}>${ROLE_LABEL[r]}</option>`)}</select><//>
      <${Field} label="Tổ chính"><select id="st-team" value=${f.team_id} onChange=${(e) => set('team_id', e.target.value ? Number(e.target.value) : '')}>
        <option value="">(không thuộc tổ)</option>${teams.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
      <${Field} label="Tính lương"><select id="st-paytype" value=${f.pay_type} onChange=${(e) => set('pay_type', e.target.value)}>
        <option value="hour">Theo giờ</option><option value="shift">Theo ca</option><option value="month">Theo tháng</option></select><//>
      <${Field} label=${({ hour: 'Lương 1 giờ (đ)', shift: 'Lương 1 ca (đ)', month: 'Lương 1 tháng (đ)' })[f.pay_type]}><input id="st-rate" type="number" inputmode="numeric" min="0" step="1000" value=${f.pay_rate} onInput=${(e) => set('pay_rate', e.target.value)} /><//>
      <${Field} label="Tối đa giờ/tuần" hint="Dùng khi gợi ý người làm thay"><input id="st-limit" type="number" min="1" max="100" value=${f.weekly_limit_hours} onInput=${(e) => set('weekly_limit_hours', e.target.value)} /><//>
      <${Field} label=${isNew ? 'Mã PIN đăng nhập' : 'Đặt lại mã PIN (để trống nếu giữ nguyên)'} hint=${`${needPin}–8 chữ số. Nhân viên sẽ phải đổi PIN khi đăng nhập lần đầu.`}>
        <input id="st-pin" inputmode="numeric" value=${f.pin} maxlength="8" onInput=${(e) => set('pin', e.target.value.replace(/\D/g, ''))} /><//>
    </div>
    <div class="field"><span>Vị trí phụ đã được đào tạo (để làm thay khi thiếu người)</span>
      <div class="skills">${teams.filter((t) => t.id !== f.team_id).map((t) => html`<div class="skill">
        <span class="grow">${t.name}</span>
        <div class="seg-ctl small">${[['Không', 0], ['Cơ bản', 1], ['Khá', 2], ['Thạo', 3]].map(([l, n]) => html`<button type="button" class=${skillOf(t.id) === n ? 'on' : ''} onClick=${() => setSkill(t.id, n)}>${l}</button>`)}</div>
      </div>`)}</div>
    </div>
    <details><summary class="muted">Nâng cao</summary>
      <div class="form-grid">
        <${Field} label="Zalo user ID" hint="Tự điền khi nhân viên liên kết qua mã. Chỉ nhập tay nếu biết chính xác."><input id="st-zalo" value=${f.zalo_user_id} onInput=${(e) => set('zalo_user_id', e.target.value)} /><//>
        ${!isNew ? html`<label class="check-row"><input id="st-active" type="checkbox" checked=${f.active} onChange=${(e) => set('active', e.target.checked)} /> Đang làm việc (bỏ chọn khi nghỉ việc)</label>` : null}
      </div>
    </details>
    <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu</button></div>
  <//>`;
}

export function StaffView({ me }) {
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const st = useData(`/api/staff${all ? '?all=1' : ''}`);
  const [edit, setEdit] = useState(null);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const teams = me.teams;
  const list = st.data.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.phone.includes(q));
  const teamName = (id) => teams.find((t) => t.id === id)?.name || '';
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row"><input id="staff-q" type="search" placeholder="Tìm tên, số điện thoại" value=${q} onInput=${(e) => setQ(e.target.value)} />
        <label class="check-row"><input id="staff-all" type="checkbox" checked=${all} onChange=${(e) => setAll(e.target.checked)} /> Hiện cả người đã nghỉ việc</label></div>
      <button class="primary" onClick=${() => setEdit({})}>+ Thêm nhân viên</button>
    </div>
    <div class="table-wrap"><table class="list">
      <thead><tr><th>Tên</th><th>Vai trò</th><th>Tổ chính</th><th>Làm thay được</th><th class="r">Lương</th><th>Zalo</th></tr></thead>
      <tbody>${list.map((s) => html`<tr class=${s.active ? 'click' : 'click off'} onClick=${() => (atLeast(me, 'manager') ? setEdit(s) : null)}>
        <td><b>${s.name}</b><br /><small class="muted">${s.phone}</small></td>
        <td>${s.role_label}</td>
        <td>${s.team_name || '—'}</td>
        <td><small>${s.skills.map((k) => `${teamName(k.team_id)}${'★'.repeat(k.level)}`).join(', ') || '—'}</small></td>
        <td class="r num">${s.pay_rate ? `${money(s.pay_rate)}/${({ hour: 'giờ', shift: 'ca', month: 'tháng' })[s.pay_type]}` : '—'}</td>
        <td>${s.zalo_linked ? html`<span class="pill ok">Đã liên kết</span>` : html`<span class="pill muted">Chưa</span>`}</td>
      </tr>`)}</tbody>
    </table></div>
    ${!list.length ? html`<div class="empty">Không có ai khớp.</div>` : null}
    ${edit ? html`<${StaffForm} me=${me} init=${edit} teams=${teams} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}
