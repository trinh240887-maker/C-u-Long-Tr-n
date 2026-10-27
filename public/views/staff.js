import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Modal, Field, Loading, money, ROLE_LABEL, atLeast, navigate, toast } from '../ui.js';

const ROLES = ['staff', 'team_lead', 'shift_lead', 'manager', 'owner'];

// Tạo PIN hàng loạt: tick người cần cấp mã → app tạo PIN 6 số, hiện 1 lần để quản lý gửi riêng từng bạn
function BulkPin({ me, staff, teams, onClose }) {
  const people = staff.filter((s) => s.active && s.role !== 'owner' && s.id !== me.id);
  const [sel, setSel] = useState(() => new Set(people.filter((s) => s.first_login).map((s) => s.id)));
  const [res, setRes] = useState(null);
  const flip = (id) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  const tname = (id) => teams.find((t) => t.id === id)?.name || 'Chưa có bộ phận';
  const url = location.origin;
  const phoneOf = (id) => staff.find((s) => s.id === id)?.phone || '';
  const msg = (x) => `Chào ${x.name}, tài khoản app quán:\n• Số điện thoại: ${phoneOf(x.id) || '(báo quản lý thêm SĐT)'}\n• Mã PIN: ${x.pin}\nVào: ${url}\nLần đầu đăng nhập app bắt đổi PIN mới, nhớ giữ kín.`;
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Đã chép'), () => toast('Không chép được, giữ lâu để chép tay', true));
  const run = async () => {
    if (!confirm(`Tạo PIN mới cho ${sel.size} người? PIN cũ của các bạn này sẽ không dùng được nữa.`)) return;
    const r = await act(() => api('POST', '/api/staff/bulk-pin', { ids: [...sel] }), 'Đã tạo PIN');
    if (r) setRes(r.list);
  };
  const groups = [...new Set(people.map((p) => p.team_id || 0))].map((tid) => ({ tid, name: tname(tid), list: people.filter((p) => (p.team_id || 0) === tid) }));
  return html`<${Modal} title="🔑 Tạo mã PIN hàng loạt" onClose=${onClose}><div class="stack">
    ${res ? html`
      <p class="small">Đã tạo <b>${res.length}</b> mã PIN. Gửi <b>RIÊNG</b> cho từng bạn (Zalo cá nhân), không gửi vào nhóm. Đóng ô này là không xem lại được.</p>
      <button class="primary" onClick=${() => copy(res.map((x) => `${x.name} · SĐT ${phoneOf(x.id) || '?'} · PIN ${x.pin}`).join('\n'))}>📋 Chép cả danh sách</button>
      ${res.map((x) => html`<div class="row"><b class="grow">${x.name}<br /><small class="muted">${phoneOf(x.id) || 'chưa có SĐT'}</small></b><b style="font-size:20px;letter-spacing:2px">${x.pin}</b><button class="small" onClick=${() => copy(msg(x))}>Chép tin gửi</button></div>`)}
      <button onClick=${onClose}>Xong</button>`
    : html`
      <p class="small muted">Tick người cần cấp mã. Mặc định đã chọn sẵn các bạn <b>chưa đăng nhập lần nào</b>. Mỗi người được 1 PIN 6 số, lần đầu đăng nhập app bắt đổi PIN riêng. Đăng nhập = <b>số điện thoại + PIN</b>, nên ai "chưa có SĐT" thì thêm SĐT trước.</p>
      <div class="row wrap"><button class="small" onClick=${() => setSel(new Set(people.map((p) => p.id)))}>Chọn tất cả</button><button class="small" onClick=${() => setSel(new Set())}>Bỏ chọn</button><span class="small muted">Đã chọn ${sel.size}</span></div>
      ${groups.map((g) => html`<div class="stack tight"><b class="small">${g.name}</b>${g.list.map((p) => html`<label class="check-row"><input type="checkbox" checked=${sel.has(p.id)} onChange=${() => flip(p.id)} /> ${p.name}${p.first_login ? html` <small class="warn-text">· chưa đăng nhập</small>` : ''}${!p.phone ? html` <small class="bad-text">· chưa có SĐT</small>` : ''}</label>`)}</div>`)}
      <button class="primary" disabled=${!sel.size} onClick=${run}>Tạo PIN cho ${sel.size} người</button>`}
  </div><//>`;
}

// Nhân viên mới đăng ký qua bot Zalo → quản lý kiểm tra, bấm Thêm (app tạo tài khoản + PIN, bot báo nhóm, điền lịch đã báo)
function StaffRequests({ me, teams }) {
  const rq = useData('/api/staff-requests');
  const [f, setF] = useState({});
  const [made, setMade] = useState(null);
  if (!rq.data?.length && !made) return null;
  const val = (q, k) => (f[q.id]?.[k] ?? q[k] ?? '');
  const set = (q, k, v) => setF({ ...f, [q.id]: { ...(f[q.id] || {}), [k]: v } });
  const add = async (q) => {
    const body = { name: val(q, 'name'), phone: val(q, 'phone'), team_id: Number(val(q, 'team_id')) || null, role: val(q, 'role') || 'staff', pay_type: val(q, 'pay_type') || 'hour', pay_rate: Number(val(q, 'pay_rate')) || 0, position_id: q.position_id || null };
    let res = null, pin = '';
    for (let k = 0; k < 4 && !res; k++) {
      pin = String(Math.floor(100000 + Math.random() * 900000));
      try { res = await api('POST', '/api/staff', { ...body, pin }); } catch (e) { if (!/PIN/.test(e.message)) { act(() => Promise.reject(e)); return; } }
    }
    if (!res) return;
    if (await act(() => api('POST', `/api/staff-requests/${q.id}/done`, { staff_id: res.id }), 'Đã thêm nhân viên')) setMade({ name: body.name, pin });
  };
  return html`<section class="card stack attn">
    <h3>🆕 Nhân viên mới chờ duyệt (${rq.data?.length || 0})</h3>
    ${made ? html`<p class="ok-text">✓ Đã thêm <b>${made.name}</b>. Mã PIN đăng nhập: <b style="font-size:20px">${made.pin}</b> (gửi riêng cho bạn ấy, lần đầu đăng nhập app bắt đổi).</p>` : null}
    ${(rq.data || []).map((q) => html`<div class="card tight stack">
      <small class="muted">Nhắn qua Zalo${q.from_name ? ` (${q.from_name})` : ''}: "${q.raw}"</small>
      <div class="form-grid">
        <${Field} label="Họ tên"><input value=${val(q, 'name')} onInput=${(e) => set(q, 'name', e.target.value)} /><//>
        <${Field} label="Số điện thoại"><input value=${val(q, 'phone')} inputmode="tel" onInput=${(e) => set(q, 'phone', e.target.value)} /><//>
        <${Field} label="Bộ phận"><select value=${val(q, 'team_id')} onChange=${(e) => set(q, 'team_id', e.target.value)}><option value="">(chưa chọn)</option>${teams.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
        <${Field} label="Chức vụ"><select value=${val(q, 'role') || 'staff'} onChange=${(e) => set(q, 'role', e.target.value)}>${['staff', 'team_lead', 'shift_lead'].map((r) => html`<option value=${r}>${ROLE_LABEL[r]}</option>`)}</select><//>
        ${atLeast(me, 'manager') ? html`<${Field} label="Tính lương"><select value=${val(q, 'pay_type') || 'hour'} onChange=${(e) => set(q, 'pay_type', e.target.value)}><option value="hour">Theo giờ</option><option value="shift">Theo ca</option><option value="month">Theo tháng</option></select><//>
        <${Field} label="Mức lương (đ)"><input type="number" inputmode="numeric" step="1000" value=${val(q, 'pay_rate')} onInput=${(e) => set(q, 'pay_rate', e.target.value)} /><//>` : null}
      </div>
      ${q.avail_text ? html`<small class="muted">Lịch đã báo trước: "${q.avail_text.slice(0, 80)}" (duyệt xong tự điền)</small>` : null}
      <div class="row end"><button onClick=${() => confirm(`Không thêm ${q.name}?`) && act(() => api('POST', `/api/staff-requests/${q.id}/reject`), 'Đã bỏ')}>Không thêm</button>
        <button class="primary" disabled=${!val(q, 'name')} onClick=${() => add(q)}>Thêm vào danh sách</button></div>
    </div>`)}
  </section>`;
}

function StaffForm({ me, init, teams, positions = [], onClose }) {
  const isNew = !init.id;
  const [f, setF] = useState({
    name: init.name || '', phone: init.phone || '', role: init.role || 'staff', team_id: init.team_id ?? '',
    pay_type: init.pay_type || 'hour', pay_rate: init.pay_rate ?? '', weekly_limit_hours: init.weekly_limit_hours ?? 48,
    zalo_user_id: init.zalo_user_id || '', active: init.active ?? true, pin: '',
    skills: init.skills || [], pskills: init.pskills || [], position_id: init.position_id ?? '', work_type: init.work_type || '',
    pay_rule: init.pay_rule == null ? '' : String(init.pay_rule), pay_from: me.today.slice(0, 7),
  });
  const set = (k, v) => setF({ ...f, [k]: v });
  const allowed = ROLES.filter((r) => me.role === 'owner' || ROLES.indexOf(r) < ROLES.indexOf(me.role));
  const skillOf = (id) => f.skills.find((s) => s.team_id === id)?.level || 0;
  const setSkill = (id, level) => set('skills', [...f.skills.filter((s) => s.team_id !== id), ...(level ? [{ team_id: id, level }] : [])]);
  const pskillOf = (id) => f.pskills.find((s) => s.position_id === id)?.level || 0;
  const setPSkill = (id, level) => set('pskills', [...f.pskills.filter((s) => s.position_id !== id), ...(level ? [{ position_id: id, level }] : [])]);
  const posOf = (teamId) => positions.filter((p) => p.team_id === Number(teamId));
  const LEVELS = [['Không', 0], ['Cơ bản', 1], ['Khá', 2], ['Thạo', 3]];
  // Dòng kỹ năng: bộ phận có vị trí thì chấm theo từng vị trí, không thì chấm cả bộ phận
  const skillRows = teams.flatMap((t) => (posOf(t.id).length
    ? posOf(t.id).filter((p) => p.id !== Number(f.position_id)).map((p) => ({ key: `p${p.id}`, label: `${t.name} · ${p.name}`, level: pskillOf(p.id), set: (n) => setPSkill(p.id, n) }))
    : t.id === Number(f.team_id) ? [] : [{ key: `t${t.id}`, label: t.name, level: skillOf(t.id), set: (n) => setSkill(t.id, n) }]));
  const needPin = ROLES.indexOf(f.role) >= ROLES.indexOf('manager') ? 6 : 4;
  const save = async () => {
    const body = { ...f, team_id: f.team_id || null, position_id: (f.team_id && f.position_id) || null, pay_rate: Number(f.pay_rate || 0), pay_rule: f.pay_rule === '' ? null : f.pay_rule === '1', pay_from: (Number(f.pay_rate || 0) !== Number(init.pay_rate || 0) || f.pay_type !== init.pay_type || f.pay_from !== me.today.slice(0, 7)) ? f.pay_from : undefined };
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
      <${Field} label="Bộ phận"><select id="st-team" value=${f.team_id} onChange=${(e) => setF({ ...f, team_id: e.target.value ? Number(e.target.value) : '', position_id: '' })}>
        <option value="">(chưa chọn bộ phận)</option>${teams.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
      ${posOf(f.team_id).length ? html`<${Field} label="Vị trí chính" hint="Vị trí hay đứng nhất. Khi xếp ca vẫn đổi được"><select id="st-pos" value=${f.position_id} onChange=${(e) => set('position_id', e.target.value ? Number(e.target.value) : '')}>
        <option value="">(chưa chọn)</option>${posOf(f.team_id).map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select><//>` : null}
      <${Field} label="Loại ca" hint="Hiện cạnh tên ở Lịch ca → Bảng tuần"><select id="st-worktype" value=${f.work_type} onChange=${(e) => set('work_type', e.target.value)}>
        <option value="">(chưa chọn)</option><option value="full">Full ca</option><option value="gay">Ca gãy</option><option value="part">Part-time</option></select><//>
      <${Field} label="Tính lương"><select id="st-paytype" value=${f.pay_type} onChange=${(e) => set('pay_type', e.target.value)}>
        <option value="hour">Theo giờ</option><option value="shift">Theo ca</option><option value="month">Theo tháng</option></select><//>
      <${Field} label=${({ hour: 'Lương 1 giờ (đ)', shift: 'Lương 1 ca (đ)', month: 'Lương 1 tháng (đ)' })[f.pay_type]}><input id="st-rate" type="number" inputmode="numeric" min="0" step="1000" value=${f.pay_rate} onInput=${(e) => set('pay_rate', e.target.value)} /><//>
      ${atLeast(me, 'manager') && !isNew ? html`<${Field} label="Mức lương áp dụng từ tháng" hint="Đổi lương thì chọn tháng bắt đầu. Tháng trước vẫn giữ mức cũ; chọn tháng sau để đặt trước (vd thử việc 23k, từ tháng sau 20k)">
        <input id="st-payfrom" type="month" value=${f.pay_from} onInput=${(e) => set('pay_from', e.target.value)} />
        ${init.pay_history?.length ? html`<small class="muted">Lịch sử: ${init.pay_history.map((h) => `từ ${h.from_month.slice(5)}/${h.from_month.slice(0, 4)}: ${money(h.pay_rate)}/${({ hour: 'giờ', shift: 'ca', month: 'tháng' })[h.pay_type]}`).join(' · ')}</small>` : null}<//>` : null}
      ${atLeast(me, 'manager') ? html`<${Field} label="Quy tắc lương bếp" hint="Nghỉ 2 ngày/tháng vẫn đủ lương + mỗi ngày quá 8 giờ tính vượt giờ (chỉnh số ở Cài đặt → Chung)"><select id="st-payrule" value=${f.pay_rule} onChange=${(e) => set('pay_rule', e.target.value)}>
        <option value="">Theo bộ phận (bếp: có · khác: không)</option><option value="1">Có áp dụng</option><option value="0">Không áp dụng</option></select><//>` : null}
      <${Field} label="Tối đa giờ/tuần" hint="Dùng khi gợi ý người làm thay"><input id="st-limit" type="number" min="1" max="100" value=${f.weekly_limit_hours} onInput=${(e) => set('weekly_limit_hours', e.target.value)} /><//>
      <${Field} label=${isNew ? 'Mã PIN đăng nhập' : 'Đặt lại mã PIN (để trống nếu giữ nguyên)'} hint=${`${needPin}–8 chữ số. Nhân viên sẽ phải đổi PIN khi đăng nhập lần đầu.`}>
        <input id="st-pin" inputmode="numeric" value=${f.pin} maxlength="8" onInput=${(e) => set('pin', e.target.value.replace(/\D/g, ''))} /><//>
      ${!isNew && init.device_set !== undefined ? html`<div class="field"><span>📱 Điện thoại chấm công</span>
        <div class="row wrap tight">${init.device_pending ? html`<b class="warn-text small">Vừa thử chấm từ máy khác</b>` : html`<small class="muted">${init.device_set ? `Đã gắn 1 máy${init.device_at ? ` từ ${new Date(init.device_at).toLocaleDateString('vi-VN')}` : ''}` : 'Chưa gắn (lần chấm đầu tiên sẽ gắn máy)'}</small>`}
          ${init.device_pending ? html`<button class="small primary" onClick=${() => act(() => api('POST', `/api/staff/${init.id}/device`, { action: 'allow' }), 'Đã cho đổi máy')}>Cho đổi máy</button>` : null}
          ${init.device_set || init.device_pending ? html`<button class="small" onClick=${() => confirm('Gỡ máy chấm công? Lần chấm sau sẽ gắn máy mới.') && act(() => api('POST', `/api/staff/${init.id}/device`, { action: 'reset' }), 'Đã gỡ máy')}>Gỡ máy</button>` : null}</div>
        <small class="muted">Mỗi bạn chấm công trên 1 điện thoại của mình; máy khác hoặc máy của người khác sẽ bị chặn.</small></div>` : null}
    </div>
    <div class="field"><span>Vị trí khác đã được đào tạo (để xếp xoay vị trí, làm thay khi thiếu người)</span>
      <div class="skills">${skillRows.map((r) => html`<div class="skill" key=${r.key}>
        <span class="grow">${r.label}</span>
        <div class="seg-ctl small">${LEVELS.map(([l, n]) => html`<button type="button" class=${r.level === n ? 'on' : ''} onClick=${() => r.set(n)}>${l}</button>`)}</div>
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
  const [dept, setDept] = useState(() => { try { return localStorage.getItem('staff-dept') || 'all'; } catch { return 'all'; } });
  const st = useData(`/api/staff${all ? '?all=1' : ''}`);
  const posD = useData('/api/positions');
  const [edit, setEdit] = useState(null);
  const [bulk, setBulk] = useState(false);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const teams = me.teams;
  const positions = posD.data || [];
  const posName = (id) => positions.find((p) => p.id === id)?.name || '';
  const posSort = (id) => { const i = positions.findIndex((p) => p.id === id); return i < 0 ? 999 : i; };
  const teamName = (id) => teams.find((t) => t.id === id)?.name || '';
  const MGMT = ['owner', 'manager', 'shift_lead'];
  const ROLE_ORDER = ['owner', 'manager', 'shift_lead', 'team_lead', 'staff'];
  const found = st.data.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.phone.includes(q));
  // Nhóm theo bộ phận; Chủ/Quản lý/Trưởng ca chưa có bộ phận vào nhóm "Ban quản lý"
  const groups = [
    { key: 'mgmt', name: 'Ban quản lý', people: found.filter((s) => !s.team_id && MGMT.includes(s.role)) },
    ...teams.map((t) => ({ key: `t${t.id}`, name: t.name, people: found.filter((s) => s.team_id === t.id) })),
    { key: 'none', name: 'Chưa có bộ phận', people: found.filter((s) => (!s.team_id || !teams.some((t) => t.id === s.team_id)) && !MGMT.includes(s.role)) },
  ].map((g) => ({ ...g, people: [...g.people].sort((x, y) => ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role) || posSort(x.position_id) - posSort(y.position_id) || x.name.localeCompare(y.name, 'vi')) }));
  const pick = (k) => { setDept(k); try { localStorage.setItem('staff-dept', k); } catch {} };
  const shown = groups.filter((g) => g.people.length && (dept === 'all' || dept === g.key));
  const row = (s) => html`<tr class=${s.active ? 'click' : 'click off'} onClick=${() => (atLeast(me, 'manager') ? setEdit(s) : null)}>
    <td><b>${s.name}</b><br /><small class="muted">${s.phone}</small>
      ${me.role === 'owner' && s.role !== 'owner' && s.active ? html`<br /><button class="small" onClick=${(e) => { e.stopPropagation(); navigate(`/cai-dat?tab=quyen&staff=${s.id}`); }}>🔐 Quyền</button>` : null}</td>
    <td>${s.role_label}</td>
    <td>${s.position_name || (s.team_id ? html`<span class="muted">—</span>` : MGMT.includes(s.role) ? html`<span class="muted">Cả quán</span>` : html`<span class="warn-text">Chưa có bộ phận</span>`)}</td>
    <td><small>${[...s.pskills.map((k) => `${posName(k.position_id)}${'★'.repeat(k.level)}`), ...s.skills.map((k) => `${teamName(k.team_id)}${'★'.repeat(k.level)}`)].join(', ') || '—'}</small></td>
    <td class="r num">${s.pay_rate ? `${money(s.pay_rate)}/${({ hour: 'giờ', shift: 'ca', month: 'tháng' })[s.pay_type]}` : '—'}</td>
    <td>${s.zalo_linked ? html`<span class="pill ok">Đã liên kết</span>` : html`<span class="pill muted">Chưa</span>`}</td>
  </tr>`;
  return html`<div class="stack">
    ${atLeast(me, 'manager') ? html`<${StaffRequests} me=${me} teams=${teams} />` : null}
    <div class="row between wrap">
      <div class="row"><input id="staff-q" type="search" placeholder="Tìm tên, số điện thoại" value=${q} onInput=${(e) => setQ(e.target.value)} />
        <label class="check-row"><input id="staff-all" type="checkbox" checked=${all} onChange=${(e) => setAll(e.target.checked)} /> Hiện cả người đã nghỉ việc</label></div>
      <div class="row">${atLeast(me, 'manager') ? html`<button onClick=${() => setBulk(true)}>🔑 Tạo PIN hàng loạt</button>` : null}
      <button class="primary" onClick=${() => setEdit(dept.startsWith('t') ? { team_id: Number(dept.slice(1)) } : {})}>+ Thêm nhân viên</button></div>
    </div>
    <div class="chips dept-chips">
      <button class=${`chip ${dept === 'all' ? 'on' : ''}`} onClick=${() => pick('all')}>Tất cả <small>${found.length}</small></button>
      ${groups.filter((g) => g.people.length || g.key.startsWith('t')).map((g) => html`<button class=${`chip ${dept === g.key ? 'on' : ''} ${g.key === 'none' ? 'warn' : ''}`} onClick=${() => pick(g.key)}>${g.name} <small>${g.people.length}</small></button>`)}
    </div>
    ${shown.map((g) => html`<section class="card stack" key=${g.key}>
      <div class="row between"><h3>${g.name}</h3><span class="pill">${g.people.length} người</span></div>
      ${g.key.startsWith('t') && positions.some((p) => `t${p.team_id}` === g.key) ? html`<div class="chips pos-sum">${positions.filter((p) => `t${p.team_id}` === g.key).map((p) => {
        const n = g.people.filter((s) => s.position_id === p.id).length;
        return html`<span class=${`pill ${n ? 'ok' : 'muted'}`}>${p.name} ${n}</span>`;
      })}</div>` : null}
      <div class="table-wrap"><table class="list">
        <thead><tr><th>Tên</th><th>Vai trò</th><th>${g.key.startsWith('t') ? 'Vị trí chính' : 'Phụ trách'}</th><th>Làm được thêm</th><th class="r">Lương</th><th>Zalo</th></tr></thead>
        <tbody>${g.people.map(row)}</tbody>
      </table></div>
    </section>`)}
    ${!shown.length ? html`<div class="empty">${dept === 'all' || !found.length ? 'Không có ai khớp.' : 'Bộ phận này chưa có ai. Bấm "+ Thêm nhân viên" hoặc sửa hồ sơ để chọn bộ phận.'}</div>` : null}
    ${edit ? html`<${StaffForm} me=${me} init=${edit} teams=${teams} positions=${positions} onClose=${() => setEdit(null)} />` : null}
    ${bulk ? html`<${BulkPin} me=${me} staff=${st.data} teams=${teams} onClose=${() => setBulk(false)} />` : null}
  </div>`;
}
