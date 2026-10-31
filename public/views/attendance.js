import { useState } from '../vendor/hooks.js';
import { compressImage } from './checklists.js';
import { html, api, act, useData, Modal, Field, Loading, Confirm, hm, dt, dayLabel, addDays, hours, money, localInput, atLeast, navigate, toast } from '../ui.js';

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

// Chia bảng chấm công theo bộ phận (chủ quán 26/10): Bếp, Phục vụ, Thu ngân, Bar, Tiếp thực… mỗi nhóm 1 dải màu
const GROUPS = [
  [/bếp|steak|lẩu|nướng|topping|thái tay/i, 'Bếp', '#d9480f'],
  [/phục vụ/i, 'Phục vụ', '#1971c2'],
  [/thu ngân/i, 'Thu ngân', '#2f9e44'],
  [/bar|pha chế/i, 'Bar', '#7048e8'],
  [/tiếp thực/i, 'Tiếp thực', '#0c8599'],
  [/tạp vụ|bảo vệ/i, 'Tạp vụ', '#5c677d'],
];
export function groupByTeam(rows) {
  const out = new Map();
  for (const r of rows) {
    const i = GROUPS.findIndex(([re]) => re.test(r.team_name || ''));
    const key = i >= 0 ? GROUPS[i][1] : (r.team_name || 'Chưa có bộ phận');
    if (!out.has(key)) out.set(key, { name: key, color: i >= 0 ? GROUPS[i][2] : '#868e96', order: i >= 0 ? i : 99, rows: [] });
    out.get(key).rows.push(r);
  }
  return [...out.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'vi')).map((g) => {
    g.rows.sort((a, b) => a.staff_name.localeCompare(b.staff_name, 'vi') || a.clock_in - b.clock_in);
    // Mỗi người 1 khối / ngày: các ca (sáng, chiều…) xếp dưới tên, cộng tổng giờ tính lương (chủ quán 26/10)
    const people = [];
    for (const r of g.rows) {
      let p = people.find((x) => x.staff_id === r.staff_id);
      if (!p) people.push(p = { staff_id: r.staff_id, staff_name: r.staff_name, team_name: r.team_name, rows: [] });
      p.rows.push(r);
    }
    for (const p of people) p.paid = p.rows.reduce((a, r) => a + (r.paid_minutes || 0), 0);
    return { ...g, people, working: people.filter((p) => p.rows.some((r) => !r.clock_out)).length, late: people.filter((p) => p.rows.some((r) => r.late_minutes)).length };
  });
}

// Có ca mà chưa chấm (chủ quán 27/10): ⏳ đã tới giờ chưa chấm · ❌ hết ca không chấm · chưa tới giờ để mờ
const MISS = { late: ['⏳ Tới giờ chưa chấm', 'warn'], missed: ['❌ Hết ca, không chấm', 'bad'], upcoming: ['Chưa tới giờ', 'muted'] };
function MissingCard({ date, onAdd }) {
  const d = useData(`/api/attendance/missing?date=${date}`);
  if (!d.data) return null;
  const list = d.data;
  const due = list.filter((m) => m.status !== 'upcoming');
  if (!list.length) return html`<section class="card hint"><span>✅ Ai có ca ngày này cũng đã chấm công (hoặc nghỉ đã duyệt).</span></section>`;
  return html`<details class="card stack att-miss" open=${due.length > 0}>
    <summary><b>⚠ Có ca nhưng chưa chấm: ${due.length} người</b>${list.length > due.length ? html` <small class="muted">· ${list.length - due.length} chưa tới giờ</small>` : null}</summary>
    ${[...due, ...list.filter((m) => m.status === 'upcoming')].map((m) => html`<div class="row between wrap att-miss-row">
      <span class="grow"><b>${m.staff_name}</b> <small class="muted">${[m.role_label, m.team_name, m.zone_name].filter(Boolean).join(' · ')}</small><br />
        <small>Ca <b>${m.shift}</b></small> <span class=${`pill ${MISS[m.status][1]}`}>${MISS[m.status][0]}${m.late_min ? ` ${m.late_min}′` : ''}</span></span>
      ${m.status !== 'upcoming' ? html`<button class="small" onClick=${() => onAdd(m)}>+ Thêm tay</button>` : null}
    </div>`)}
    <small class="muted">Nghỉ có báo đã duyệt thì không hiện ở đây. Quên chấm thì bấm "+ Thêm tay" (giờ vào / ra điền sẵn theo ca, sửa nếu cần).</small>
  </details>`;
}

// Nhập chấm công tay cũ (chủ quán 28/10): dán chữ "16/10 : 8h - 12h , 14h - 22h30" → xem lại → lưu từng lượt
export function parseManual(text, today) {
  const [ty, tm] = today.split('-').map(Number);
  const out = [];
  const pad = (n) => String(n).padStart(2, '0');
  for (const raw of String(text || '').split(/\n+/)) {
    const line = raw.trim();
    const dm = /^(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/.exec(line);
    if (!dm) { if (line) out.push({ line, error: 'Không đọc được ngày' }); continue; }
    const d = Number(dm[1]), m = Number(dm[2]);
    let y = dm[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : (m > tm ? ty - 1 : ty);
    const date = `${y}-${pad(m)}-${pad(d)}`;
    const rest = line.slice(dm[0].length);
    const re = /(\d{1,2})\s*(?:h|:|giờ)\s*(\d{1,2})?\s*[-–—đến]+\s*(\d{1,2})\s*(?:(?:h|:|giờ)\s*(\d{1,2})?)?/gi;
    let mm, n = 0;
    while ((mm = re.exec(rest))) {
      n++;
      const s0 = Number(mm[1]) * 60 + Number(mm[2] || 0);
      let e0 = Number(mm[3]) * 60 + Number(mm[4] || 0), warn = '';
      let nextDay = false;
      if (e0 <= s0) {
        if (e0 < 12 * 60 && e0 + 720 > s0) { e0 += 720; warn = `hiểu giờ ra là ${pad(Math.floor(e0 / 60))}:${pad(e0 % 60)} (chiều)`; }
        else { nextDay = true; warn = 'ra qua đêm (hôm sau)'; }
      }
      const hm2 = (x) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
      let outDate = date;
      if (nextDay) { const t = new Date(`${date}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); outDate = t.toISOString().slice(0, 10); }
      out.push({ line, date, clock_in: `${date}T${hm2(s0)}`, clock_out: `${outDate}T${hm2(e0)}`, minutes: (nextDay ? e0 + 1440 : e0) - s0, warn });
    }
    if (!n) out.push({ line, error: 'Không đọc được giờ (cần dạng 8h - 12h30)' });
  }
  return out;
}
function ImportManual({ me, staff, onClose }) {
  const [sid, setSid] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState('');
  const readPhotos = async (e) => {
    const files = [...(e.target.files || [])].slice(0, 4); e.target.value = '';
    if (!files.length) return;
    setReading(true);
    try {
      const photos = []; for (const f of files) photos.push(await compressImage(f, 1600));
      const r = await act(() => api('POST', '/api/attendance/read-photo', { photos }));
      if (r) { setText((t) => (t.trim() ? `${t.trim()}\n${r.text}` : r.text)); setReadNote(r.note || ''); if (!r.text) toast('Không thấy dòng chấm công nào trong ảnh', true); }
    } finally { setReading(false); }
  };
  const rows = parseManual(text, me.today);
  const ok = rows.filter((r) => !r.error);
  const dates = ok.map((r) => r.date).sort();
  const exist = useData(sid && dates.length ? `/api/attendance?from=${dates[0]}&to=${dates[dates.length - 1]}&staff_id=${sid}` : null);
  const dup = (r) => (exist.data || []).some((x) => x.date === r.date);
  const todo = ok.filter((r) => !dup(r));
  const save = async () => {
    setBusy(true);
    let n = 0;
    try { for (const r of todo) { await api('POST', '/api/attendance', { staff_id: Number(sid), clock_in: r.clock_in, clock_out: r.clock_out, note: 'Nhập từ chấm công tay' }); n++; } toast(`Đã nhập ${n} lượt chấm công`); onClose(); }
    catch (e) { toast(`Đã nhập ${n} lượt, lỗi ở lượt tiếp theo: ${e.message}`, true); }
    finally { setBusy(false); }
  };
  const total = todo.reduce((a, r) => a + r.minutes, 0);
  return html`<${Modal} title="📋 Nhập chấm công tay" onClose=${onClose}><div class="stack">
    <select value=${sid} onChange=${(e) => setSid(e.target.value)}><option value="">— Chọn nhân viên —</option>${staff.map((x) => html`<option value=${x.id}>${x.name}${x.team_name ? ` · ${x.team_name}` : ''}</option>`)}</select>
    <label class=${`button ${reading ? 'muted' : ''}`}>📷 ${reading ? 'Đang đọc ảnh…' : 'Chọn ảnh chấm công (app tự đọc)'}<input type="file" accept="image/*" multiple hidden onChange=${readPhotos} /></label>
    ${readNote ? html`<small class="warn-text">Máy đọc ghi chú: ${readNote}</small>` : null}
    <textarea rows="8" placeholder=${'Dán chấm công tay, mỗi ngày 1 dòng, vd:\n14/10 : 13h - 21h\n16/10 : 8h - 12h , 15h - 23h30'} value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    ${rows.length ? html`<div class="table-wrap"><table class="list small"><thead><tr><th>Ngày</th><th>Vào</th><th>Ra</th><th class="r">Giờ</th><th></th></tr></thead><tbody>
      ${rows.map((r) => r.error ? html`<tr><td colspan="5" class="bad-text">⚠ "${r.line}": ${r.error}</td></tr>` : html`<tr class=${dup(r) ? 'muted' : ''}>
        <td>${r.date.slice(8)}/${r.date.slice(5, 7)}</td><td>${r.clock_in.slice(11)}</td><td>${r.clock_out.slice(11)}${r.clock_out.slice(0, 10) !== r.date ? ' (+1)' : ''}</td>
        <td class="r">${hours(r.minutes)}</td><td>${dup(r) ? html`<small>đã có chấm công ngày này, bỏ qua</small>` : r.warn ? html`<small class="warn-text">${r.warn}</small>` : '✓'}</td></tr>`)}
    </tbody></table></div>
    <small class="muted">Kiểm tra dòng màu cam (app tự đoán). Sai thì sửa chữ ở trên. Ngày đã có chấm công sẽ bỏ qua để không bị trùng. Lượt nhập tay tính lương theo giờ thực tế.</small>` : null}
    <button class="primary big" disabled=${!sid || !todo.length || busy} onClick=${save}>${busy ? 'Đang nhập…' : `✓ Lưu ${todo.length} lượt (${hours(total)})`}</button>
  </div><//>`;
}

function Records({ me }) {
  const [date, setDate] = useState(me.today);
  const st = useData(`/api/attendance?from=${date}&to=${date}`);
  const staff = useData('/api/staff');
  const [edit, setEdit] = useState(null);
  const [imp, setImp] = useState(false);
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Hôm trước" onClick=${() => setDate(addDays(date, -1))}>‹</button>
        <input id="att-date" type="date" value=${date} onInput=${(e) => e.target.value && setDate(e.target.value)} />
        <button class="icon" aria-label="Hôm sau" onClick=${() => setDate(addDays(date, 1))}>›</button>
        <b>${dayLabel(date, { long: true })}</b>
      </div>
      <div class="row"><button onClick=${() => setEdit({})}>+ Thêm tay</button>${atLeast(me, 'manager') ? html`<button onClick=${() => setImp(true)}>📋 Nhập chấm công tay</button>` : null}</div>
    </div>
    <${MissingCard} date=${date} onAdd=${(m) => setEdit({ staff_id: m.staff_id, clock_in: m.start_at, clock_out: m.status === 'missed' ? m.end_at : null, note: 'Thêm tay: có ca nhưng không chấm' })} />
    ${!st.data ? html`<${Loading} state=${st} />` : st.data.length ? html`<div class="table-wrap"><table class="list">
      <thead><tr><th>Nhân viên</th><th>Ca</th><th>Vào</th><th>Ra</th><th class="r">Giờ tính</th><th class="r">Tổng giờ ngày</th><th>Ghi chú</th></tr></thead>
      <tbody>${groupByTeam(st.data).map((g) => [html`<tr class="att-group"><td colspan="7" style=${`background:${g.color};color:#fff;font-weight:700;padding:8px 12px`}>
          ${g.name.toUpperCase()} · ${g.people.length} người${g.working ? ` · ${g.working} đang làm` : ''}${g.late ? ` · ${g.late} trễ` : ''}</td></tr>`, ...g.people.flatMap((pp) => pp.rows.map((r, idx) => {
        const mins = r.clock_out ? Math.round((r.clock_out - r.clock_in) / 60000) : null;
        const fmt = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const n = pp.rows.length;
        const top = idx === 0 ? 'border-top:2px solid var(--line, #ddd)' : 'border-top:1px dashed var(--line, #e5e5e5)';
        return html`<tr class="click" style=${top} onClick=${() => setEdit(r)}>
          ${idx === 0 ? html`<td rowspan=${n} style="vertical-align:top"><b>${pp.staff_name}</b><br /><small class="muted">${r.role_label || pp.team_name || ''}${n > 1 ? ` · ${n} lượt` : ''}</small></td>` : null}
          <td>${r.start_min != null ? html`<b>${fmt(r.start_min)}–${fmt(r.end_min)}</b>` : html`<span class="pill warn">Ngoài lịch</span>`}
            ${mins != null && mins < 5 ? html`<br /><span class="pill bad">bấm nhầm? ${mins}′</span>` : null}</td>
          <td>${hm(r.clock_in)}${r.late_minutes ? html` <span class="pill warn">trễ ${r.late_minutes}′</span>` : null}
            ${r.late_photo ? html`<br /><a class="small" href=${`/api/attendance/${r.id}/late-photo`} target="_blank" rel="noopener" onClick=${(e) => e.stopPropagation()}>📷 ảnh nón + khăn</a>` : null}</td>
          <td>${r.clock_out ? dt(r.clock_out) : html`<span class="pill ok">Đang làm</span>`}${r.auto_closed ? html` <span class="pill bad">tự đóng</span>` : null}</td>
          <td class="r num">${r.paid_minutes != null ? hours(r.paid_minutes) : '—'}${mins != null && r.paid_minutes != null && mins !== r.paid_minutes ? html`<br /><small class="muted">thực tế ${hours(mins)}</small>` : null}
            ${r.early_minutes > 0 ? html`<br /><span class="pill warn">về sớm ${r.early_minutes}′</span>` : null}
            ${r.ot_minutes > 0 && me.role === 'owner' ? html`<br /><span class=${`pill ${r.ot_status === 'approved' ? 'ok' : 'muted'}`}>ở lại ${r.ot_minutes}′ ${r.ot_status === 'approved' ? '· đã tính thêm' : '· không tính'}</span>
              <div class="row end tight" onClick=${(e) => e.stopPropagation()}>${r.ot_status === 'approved'
                ? html`<button class="small" onClick=${() => act(() => api('POST', `/api/attendance/${r.id}/overtime`, { approve: false }), 'Đã bỏ phần tính thêm')}>Bỏ tính thêm</button>`
                : html`<button class="small" onClick=${() => act(() => api('POST', `/api/attendance/${r.id}/overtime`, { approve: true }), 'Đã tính thêm vào lương')}>Tính thêm ${r.ot_minutes}′</button>`}</div>` : null}</td>
          ${idx === 0 ? html`<td rowspan=${n} class="r num" style="vertical-align:top"><b style="font-size:1.1em">${pp.paid ? hours(pp.paid) : '—'}</b>${n > 1 ? html`<br /><small class="muted">cả ngày</small>` : null}</td>` : null}
          <td><small>${r.note}${r.edited_by_name ? ` (sửa: ${r.edited_by_name})` : ''}</small></td>
        </tr>`;
      }))])}</tbody></table></div>` : html`<div class="empty">Chưa có ai chấm công ngày này.</div>`}
    ${edit && staff.data ? html`<${RecordForm} init=${edit} staff=${staff.data.filter((s) => s.active)} canDelete=${atLeast(me, 'manager')} onClose=${() => setEdit(null)} />` : null}
    ${imp && staff.data ? html`<${ImportManual} me=${me} staff=${staff.data.filter((s) => s.active && s.role !== 'owner')} onClose=${() => setImp(false)} />` : null}
  </div>`;
}

function Timesheet({ me }) {
  const [month, setMonth] = useState('');
  const [adj, setAdj] = useState(null);
  const st = useData(`/api/timesheet${month ? `?month=${month}` : ''}`);
  const shiftMonth = (n) => { const [y, m] = (month || st.data?.month || me.today.slice(0, 7)).split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)); };
  return html`<div class="stack">
    ${st.data?.part_count ? html`<p class="small muted">⏱ ${st.data.part_count} nhân viên part-time tính lương ở mục <a href="/cham-cong?tab=luong-tuan">💵 Lương tuần part-time</a>, không nằm trong bảng tháng.</p>` : null}
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Tháng trước" onClick=${() => shiftMonth(-1)}>‹</button>
        <b>${st.data ? `Kỳ ${st.data.from.slice(8)}/${st.data.from.slice(5, 7)} – ${st.data.to.slice(8)}/${st.data.to.slice(5, 7)}/${st.data.to.slice(0, 4)}` : '…'}</b>
        <button class="icon" aria-label="Kỳ sau" onClick=${() => shiftMonth(1)}>›</button>
      </div>
      ${st.data ? html`<b>Tổng lương tạm tính: ${money(st.data.total_pay)}</b>` : null}
    </div>
    ${!st.data ? html`<${Loading} state=${st} />` : html`
      <section class="card stack tight">
        <small>📅 <b>Bếp:</b> kỳ này ${st.data.month_days} ngày, được nghỉ ${st.data.paid_off_days} ngày (bỏ 1 khúc ca gãy = nửa ngày) → đi đủ <b>${st.data.month_standard_days} công</b> là đủ lương.</small>
        <small>⏱ <b>Vượt giờ (bếp):</b> ngày nào làm quá ${st.data.ot_daily_hours} giờ thì tính thêm, theo khúc 30 phút, giá giờ thường.</small>
        <small>👥 <b>Bộ phận khác:</b> lương tháng × ngày đi làm ÷ ${st.data.old_standard_days}; lương giờ = số giờ × giá giờ.</small>
      </section>
      <div class="table-wrap"><table class="list">
      <thead><tr><th>Nhân viên</th><th class="r">Đi làm</th><th class="r">Vượt giờ</th><th class="r">Lương</th></tr></thead>
      <tbody>${groupByTeam(st.data.rows.map((r) => ({ ...r, staff_name: r.name, clock_in: 0 }))).map((g) => [html`<tr class="att-group"><td colspan="4" style=${`background:${g.color};color:#fff;font-weight:700;padding:8px 12px`}>
          ${g.name.toUpperCase()} · ${g.people.length} người${st.data.can_see_pay !== false ? ` · ${money(g.rows.reduce((n, r) => n + r.pay, 0))}` : ''}</td></tr>`, ...g.rows.map((r) => html`<tr>
        <td><b>${r.name}</b>${r.role_label ? html`<br /><small>${r.role_label}</small>` : null}<br /><small class="muted">${r.pay_rate ? `${money(r.pay_rate)}/${({ hour: 'giờ', shift: 'ca', month: 'tháng' })[r.pay_type]}` : 'Chưa có mức lương'}</small>${r.segments?.length > 1 ? html`${r.segments.map((g) => html`<br /><small class="warn-text">${g.role_label} ${g.from.slice(8)}/${g.from.slice(5, 7)}–${g.to.slice(8)}/${g.to.slice(5, 7)}: ${money(g.pay_rate)}/${({ hour: 'giờ', shift: 'ca', month: 'tháng' })[g.pay_type]} = ${money(g.pay)}</small>`)}` : null}
          ${r.day_price ? html`<br /><small class="muted">1 ngày ≈ ${money(r.day_price)} · 1 giờ ≈ ${money(r.hour_price)}</small>` : null}
          ${r.late_count || r.absent || r.open_records || r.auto_closed ? html`<br />` : null}
          ${r.late_count ? html`<span class="pill warn">trễ ${r.late_count} lần</span> ` : null}${r.absent ? html`<span class="pill bad">vắng ${r.absent}</span> ` : null}${r.open_records || r.auto_closed ? html`<span class="pill warn">cần kiểm tra</span>` : null}</td>
        <td class="r num">${r.rule && r.pay_type === 'month'
          ? html`<b class=${r.days >= st.data.month_standard_days ? 'ok-text' : ''}>${String(r.days).replace('.', ',')}/${st.data.month_standard_days} công</b>`
          : html`<b>${r.pay_type === 'hour' ? hours(r.minutes) : `${r.pay_type === 'shift' ? r.shifts : r.days} ${r.pay_type === 'shift' ? 'ca' : 'ngày'}`}</b>`}
          <br /><small class="muted">${hours(r.minutes)} làm</small></td>
        <td class="r num">${r.ot_minutes ? html`<b>${hours(r.ot_minutes)}</b>${r.ot_manual ? html` <small class="warn-text">ghi tay</small>` : null}${r.ot_pay ? html`<br /><small class="muted">+${money(r.ot_pay)}</small>` : null}` : '—'}
          ${r.ot_note ? html`<br /><small class="muted">📝 ${r.ot_note}</small>` : null}
          <br /><button class="link small" onClick=${() => setAdj({ staff_id: r.staff_id, name: r.name, ot_hours: r.ot_manual ? String(r.ot_minutes / 60).replace('.', ',') : '', note: r.ot_note || '', auto: r.ot_manual ? null : r.ot_minutes })}>✏️ Ghi vượt giờ</button></td>
        <td class="r num"><b>${money(r.pay)}</b>${r.ot_pay ? html`<br /><small class="muted">${money(r.base_pay)} + ${money(r.ot_pay)}</small>` : null}${r.paid_weekly ? html`<br /><small class="ok-text">đã trả tuần ${money(r.paid_weekly)}</small><br /><small>còn ${money(Math.max(0, r.pay - r.paid_weekly))}</small>` : null}</td>
      </tr>`)])}</tbody></table></div>
      ${adj ? html`<${Modal} title=${`Vượt giờ kỳ ${st.data.from.slice(8)}/${st.data.from.slice(5, 7)}: ${adj.name}`} onClose=${() => setAdj(null)}>
        <div class="stack">
          ${adj.auto != null ? html`<small class="muted">App tự tính: ${adj.auto ? hours(adj.auto) : '0 giờ'}. Nhập số giờ để thay; để trống = dùng số app tính.</small>` : html`<small class="muted">Để trống = trả về số app tự tính.</small>`}
          <${Field} label="Số giờ vượt cả tháng"><input id="adj-h" inputmode="decimal" placeholder="vd 20 hoặc 12,5" value=${adj.ot_hours} onInput=${(e) => setAdj({ ...adj, ot_hours: e.target.value })} /><//>
          <${Field} label="Ghi chú"><input id="adj-note" placeholder="vd làm thêm sự kiện 30/10" value=${adj.note} onInput=${(e) => setAdj({ ...adj, note: e.target.value })} /><//>
          <button class="primary" onClick=${async () => { if (await act(() => api('PUT', '/api/timesheet/adjust', { month: month || st.data.month, staff_id: adj.staff_id, ot_hours: adj.ot_hours.trim() === '' ? null : adj.ot_hours, note: adj.note }), 'Đã lưu')) setAdj(null); }}>Lưu</button>
        </div><//>` : null}
      <p class="muted small">Số tạm tính, đã làm tròn 1.000đ, chưa gồm thưởng, phạt, bảo hiểm, lễ tết. Chỉnh quy tắc ở Cài đặt → Chung; chọn ai theo quy tắc bếp ở Nhân viên.</p>`}
  </div>`;
}

// Bảng chấm công theo tuần (chủ quán 28/10): hàng = nhân viên, cột = T2…CN; ô = ca được xếp + giờ chấm thực tế
const WST = { ok: ['att-ok', ''], warn: ['att-warn', ''], working: ['att-work', 'đang làm'], missing: ['att-miss2', 'không chấm'], future: ['att-fut', ''], leave: ['att-leave', 'nghỉ có phép'] };
function WeekBoard({ me }) {
  const [week, setWeek] = useState(me.today);
  const d = useData(`/api/attendance/week?week=${week}`);
  const staffD = useData('/api/staff');
  const [team, setTeam] = useState('');
  const [onlyIssue, setOnlyIssue] = useState(false);
  const [edit, setEdit] = useState(null);
  if (!d.data) return html`<${Loading} state=${d} />`;
  const { days, staff, cells, today } = d.data;
  const DOW = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
  const teams = [...new Set(staff.map((x) => x.team_name || 'Chưa có bộ phận'))];
  const cellOf = (sid, day) => cells[`${sid}:${day}`] || { shifts: [], extra: [] };
  const issue = (sid) => days.some((day) => { const c = cellOf(sid, day); return c.shifts.some((g) => ['missing', 'warn'].includes(g.status)) || c.extra.some((r) => !/chấm công tay/i.test(r.note || '')); });
  const rows = staff.filter((x) => (!team || (x.team_name || 'Chưa có bộ phận') === team) && (!onlyIssue || issue(x.id)));
  // Nhóm theo bộ phận (Bếp → Phục vụ → Thu ngân → Bar → Tiếp thực → Tạp vụ), trong nhóm xếp theo vị trí (chủ quán 28/10)
  const RANK = { manager: 0, shift_lead: 1, team_lead: 2 };
  const groups = [];
  for (const x of rows) {
    const i = GROUPS.findIndex(([re]) => re.test(x.team_name || ''));
    const key = i >= 0 ? GROUPS[i][1] : (x.team_name || 'Chưa có bộ phận');
    let g = groups.find((y) => y.name === key);
    if (!g) groups.push(g = { name: key, color: i >= 0 ? GROUPS[i][2] : '#868e96', order: i >= 0 ? i : 99, people: [] });
    g.people.push(x);
  }
  groups.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'vi'));
  for (const g of groups) g.people.sort((a, b) => (a.position || '~').localeCompare(b.position || '~', 'vi') || (RANK[a.role] ?? 9) - (RANK[b.role] ?? 9) || a.name.localeCompare(b.name, 'vi'));
  const R = (r) => html`<div class="att-rec" onClick=${(e) => { e.stopPropagation(); setEdit(r); }}>${hm(r.clock_in)} – ${r.clock_out ? hm(r.clock_out) : '…'}${r.late_minutes ? html` <b class="warn-text">trễ ${r.late_minutes}′</b>` : null}${r.early_minutes > 0 ? html` <b class="warn-text">về sớm ${r.early_minutes}′</b>` : null}${r.auto_closed ? html` <b class="bad-text">tự đóng</b>` : null}</div>`;
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row"><button class="icon" aria-label="Tuần trước" onClick=${() => setWeek(addDays(d.data.week_start, -7))}>‹</button>
        <b>Tuần ${days[0].slice(8)}/${days[0].slice(5, 7)} – ${days[6].slice(8)}/${days[6].slice(5, 7)}</b>
        <button class="icon" aria-label="Tuần sau" onClick=${() => setWeek(addDays(d.data.week_start, 7))}>›</button></div>
      <label class="check-row small"><input type="checkbox" checked=${onlyIssue} onChange=${(e) => setOnlyIssue(e.target.checked)} /> Chỉ người cần kiểm tra</label>
    </div>
    <div class="chips scroll-x"><button class=${`chip ${!team ? 'on' : ''}`} onClick=${() => setTeam('')}>Cả quán</button>${teams.map((t) => html`<button class=${`chip ${team === t ? 'on' : ''}`} onClick=${() => setTeam(t)}>${t}</button>`)}</div>
    <p class="small muted"><span class="lg-att att-ok">đúng giờ</span> <span class="lg-att att-warn">trễ / về sớm</span> <span class="lg-att att-miss2">có ca, không chấm</span> <span class="lg-att att-fut">chưa tới</span> · Bấm giờ chấm để sửa, bấm ô đỏ để thêm tay.</p>
    <div class="wk-wrap"><table class="attw">
      <thead><tr><th class="attw-name">Nhân viên</th>${days.map((day, i) => html`<th class=${day === today ? 'today' : ''}>${DOW[i]}<br /><small>${day.slice(8)}/${day.slice(5, 7)}</small></th>`)}</tr></thead>
      <tbody>${groups.map((g) => [html`<tr><td colspan="8" class="attw-group" style=${`background:${g.color}`}>${g.name.toUpperCase()} · ${g.people.length} người</td></tr>`, ...g.people.map((x) => html`<tr><td class="attw-name"><b>${x.name}</b><br /><small class="muted">${x.position ? html`<b class="attw-pos">${x.position}</b> ` : ''}${x.role !== 'staff' && x.role_label ? x.role_label.split(' · ')[0] : x.position ? '' : x.team_name || ''}</small></td>
        ${days.map((day) => { const c = cellOf(x.id, day);
          if (!c.shifts.length && !c.extra.length) return html`<td class=${`attw-cell ${day === today ? 'today' : ''}`}><div class="att-box att-free">Tự do</div></td>`;
          return html`<td class=${`attw-cell ${day === today ? 'today' : ''}`}>
            ${c.shifts.map((g) => html`<div class=${`att-box ${WST[g.status][0]}`} onClick=${() => g.status === 'missing' && setEdit({ staff_id: x.id, clock_in: g.start_at, note: 'Thêm tay từ bảng tuần' })}>
              <div class="att-shift">${g.name ? `${g.name} ` : 'Ca '}${g.time}</div>
              ${g.records.length ? g.records.map(R) : html`<div class="att-rec muted">${WST[g.status][1] || '—'}</div>`}</div>`)}
            ${c.extra.map((r) => /chấm công tay/i.test(r.note || '') ? html`<div class="att-box att-ok"><div class="att-shift">📋 Chấm tay</div>${R(r)}</div>` : html`<div class="att-box att-warn"><div class="att-shift">Ngoài lịch</div>${R(r)}</div>`)}</td>`; })}</tr>`)])}</tbody>
    </table></div>
    ${edit && staffD.data ? html`<${RecordForm} init=${edit} staff=${staffD.data.filter((s) => s.active)} canDelete=${atLeast(me, 'manager')} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}

export function AttendanceView({ me, query }) {
  const tab = query.get('tab') || 'ngay';
  return html`<div class="stack">
    <div class="tabs">
      <button class=${tab === 'ngay' ? 'on' : ''} onClick=${() => navigate('/cham-cong')}>Theo ngày</button>
      <button class=${tab === 'tuan' ? 'on' : ''} onClick=${() => navigate('/cham-cong?tab=tuan')}>Bảng tuần</button>
      <button class=${tab === 'luong-tuan' ? 'on' : ''} onClick=${() => navigate('/cham-cong?tab=luong-tuan')}>💵 Lương tuần part-time</button>
      ${atLeast(me, 'manager') ? html`<button class=${tab === 'bang-cong' ? 'on' : ''} onClick=${() => navigate('/cham-cong?tab=bang-cong')}>Bảng công & lương</button>` : null}
    </div>
    ${tab === 'luong-tuan' ? html`<${PartWeekPay} me=${me} />` : tab === 'bang-cong' && atLeast(me, 'manager') ? html`<${Timesheet} me=${me} />` : tab === 'tuan' ? html`<${WeekBoard} me=${me} />` : html`<${Records} me=${me} />`}
  </div>`;
}

// 💵 Lương part-time theo tuần (chủ quán 31/10): giờ chấm công × lương giờ, trả tối CN hoặc T2 tuần sau (chủ quán chọn)
function PartWeekPay({ me }) {
  const [week, setWeek] = useState('');
  const d0 = useData(`/api/payroll/week${week ? `?week=${week}` : ''}`);
  const [pay, setPay] = useState(null);
  if (!d0.data) return html`<${Loading} state=${d0} />`;
  const d = d0.data;
  const dm = (x) => `${x.slice(8)}/${x.slice(5, 7)}`;
  const hrs = (m) => `${Math.round(m / 6) / 10} giờ`;
  const owner = (me.real_role || me.role) === 'owner';
  const add7 = (x, n) => { const t = new Date(`${x}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  return html`<div class="stack">
    <div class="row between wrap"><div class="row"><button class="icon" aria-label="Tuần trước" onClick=${() => setWeek(add7(d.week_start, -7))}>‹</button>
      <b>Tuần ${dm(d.week_start)} – ${dm(d.week_end)}</b><button class="icon" aria-label="Tuần sau" onClick=${() => setWeek(add7(d.week_start, 7))}>›</button></div>
      <small class="muted">Trả: ${d.pay_day === 'mon' ? 'T2' : 'tối CN'} ${dm(d.pay_date)}</small></div>
    ${owner ? html`<div class="row wrap tight" style="align-items:center"><small>Ngày trả lương part-time:</small>${[['sun', 'Tối chủ nhật'], ['mon', 'Thứ 2 tuần sau']].map(([k, l]) => html`<button class=${`chip ${d.pay_day === k ? 'on' : ''}`} onClick=${() => d.pay_day !== k && act(() => api('PUT', '/api/settings', { part_pay_day: k }), `Đã chọn trả ${l.toLowerCase()}`)}>${l}</button>`)}</div>` : null}
    ${d.total != null ? html`<section class="card row between wrap"><span>Tổng tuần: <b>${money(d.total)}</b></span><span>Còn phải trả: <b class=${d.unpaid ? 'warn-text' : 'ok-text'}>${money(d.unpaid)}</b></span></section>` : null}
    ${!d.people.length ? html`<div class="empty">${d.mine ? 'Bạn không phải part-time hoặc tuần này chưa có giờ làm.' : 'Không có part-time nào tuần này.'}</div>` : null}
    ${d.people.map((x) => html`<section class="card row between wrap" style="align-items:center">
      <span><b>${x.name}</b> <small class="muted">${x.team_name}</small><br /><small>${hrs(x.minutes)} · ${x.shifts} ca · ${money(x.rate)}/giờ${x.open ? html` · <span class="warn-text">${x.open} lần chưa chấm ra</span>` : ''}</small></span>
      <span class="stack tight" style="align-items:flex-end"><b class="num">${money(x.pay)}</b>
        ${x.paid ? html`<small class="ok-text">✓ Đã trả ${money(x.paid.amount)} · ${x.paid.method === 'cash' ? 'TM' : 'CK'} · ${x.paid.by_name || ''}</small>${!d.mine ? html`<button class="link small" onClick=${() => confirm(`Huỷ ghi đã trả cho ${x.name}?`) && act(() => api('POST', '/api/payroll/week/pay', { week: d.week_start, staff_id: x.staff_id, undo: true }), 'Đã huỷ')}>huỷ</button>` : null}`
          : !d.mine && x.pay > 0 ? html`<button class="primary small" onClick=${() => setPay({ x, method: 'cash', amount: String(x.pay) })}>💵 Trả</button>` : null}</span>
    </section>`)}
    ${pay ? html`<${Modal} title=${`Trả lương tuần: ${pay.x.name}`} onClose=${() => setPay(null)}><div class="stack">
      <small>${hrs(pay.x.minutes)} × ${money(pay.x.rate)} = <b>${money(pay.x.pay)}</b></small>
      <div class="chips">${[['cash', '💵 Tiền mặt (từ két)'], ['transfer', '🏦 Chuyển khoản']].map(([k, l]) => html`<button class=${`chip ${pay.method === k ? 'on' : ''}`} onClick=${() => setPay({ ...pay, method: k })}>${l}</button>`)}</div>
      <${Field} label="Số tiền trả"><input inputmode="numeric" value=${pay.amount} onInput=${(e) => setPay({ ...pay, amount: e.target.value })} /><//>
      <button class="primary" onClick=${async () => { if (await act(() => api('POST', '/api/payroll/week/pay', { week: d.week_start, staff_id: pay.x.staff_id, method: pay.method, amount: pay.amount }), 'Đã ghi trả lương')) setPay(null); }}>Xác nhận đã trả</button>
    </div><//>` : null}
    <p class="small muted">Giờ tính theo chấm công thật (sau khi làm tròn). Trả xong app ghi phiếu chi "Lương", báo bạn đó. Ai chưa chấm ra thì sửa ở mục Theo ngày trước khi trả.</p>
  </div>`;
}
