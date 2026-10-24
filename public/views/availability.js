import { useState, useEffect } from 'preact/hooks';
import { html, api, act, useData, Loading, Modal, dayLabel, addDays, atLeast, navigate } from '../ui.js';

const fmtDate = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
const TIMES = Array.from({ length: 37 }, (_, i) => { const m = 360 + i * 30; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${m % 60 ? '30' : '00'}`; }); // 06:00 … 24:00
const WEEKDAY = ['', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];
const dowOf = (d) => { const n = new Date(`${d}T00:00:00Z`).getUTCDay(); return n === 0 ? 7 : n; };

function Mine({ week, onWeek, staffId = null, onDone = null }) {
  const qs = [week ? `week=${week}` : '', staffId ? `staff=${staffId}` : ''].filter(Boolean).join('&');
  const st = useData(`/api/availability/me${qs ? `?${qs}` : ''}`);
  const [picks, setPicks] = useState(null);
  const [note, setNote] = useState('');
  const [fixed, setFixed] = useState(false);
  useEffect(() => { if (st.data) { setPicks(st.data.picks); setNote(st.data.auto ? '' : st.data.note); setFixed(Object.keys(st.data.fixed || {}).length > 0); } }, [st.data]);
  if (!st.data || !picks) return html`<${Loading} state=${st} />`;
  const d = st.data;
  // Mỗi ngày 1 khung giờ "HH:MM-HH:MM"; không chọn = bận
  const rangeOf = (day) => (picks[day] || [])[0] || null;
  const lastRange = () => d.days.map(rangeOf).filter(Boolean).at(-1) || '16:00-23:00';
  const setRange = (day, r) => setPicks({ ...picks, [day]: r ? [r] : [] });
  const toAll = (r) => setPicks(Object.fromEntries(d.days.map((x) => [x, [r]])));
  const count = d.days.filter((x) => rangeOf(x)).length;
  const submit = () => act(() => api('POST', '/api/availability/me', { week: d.week_start, picks, note, fixed, staff_id: staffId || undefined }), staffId ? `Đã báo hộ ${d.staff_name}` : 'Đã gửi lịch rảnh').then((r) => r && onDone?.());
  const hasPrev = Object.values(d.prev_picks || {}).some((x) => x.length);
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Tuần trước" onClick=${() => onWeek(addDays(d.week_start, -7))}>‹</button>
        <b>Tuần ${fmtDate(d.week_start)} – ${fmtDate(addDays(d.week_start, 6))}</b>
        <button class="icon" aria-label="Tuần sau" onClick=${() => onWeek(addDays(d.week_start, 7))}>›</button>
      </div>
      ${d.submitted_at ? html`<span class="pill ok">Đã gửi</span>` : d.late ? html`<span class="pill bad">Quá hạn, gửi ngay</span>` : html`<span class="pill warn">Chưa gửi</span>`}
    </div>
    ${d.staff_name ? html`<section class="card attn"><b>Báo hộ: ${d.staff_name}</b></section>` : null}
    ${d.auto ? html`<section class="card hint"><span>✅ Tuần này đã tự điền theo <b>lịch cố định</b>. Không cần làm gì; muốn đổi thì bấm lại các buổi rồi Gửi lại.</span></section>`
      : html`<section class="card hint"><span>Chọn <b>giờ rảnh</b> từng ngày → <b>Gửi</b>. Tick "Tuần nào cũng vậy" thì <b>chỉ báo 1 lần</b>, các tuần sau app tự dùng. Hạn: <b>${WEEKDAY[dowOf(d.deadline.date)]} ${fmtDate(d.deadline.date)} lúc ${d.deadline.time}</b>.</span></section>`}
    ${d.locked ? html`<p class="warn-text">Tuần này đã bắt đầu. Muốn đổi, báo quản lý.</p>` : null}
    <section class="card avail stack">
      ${d.days.map((day) => { const r = rangeOf(day); const [f, t] = r ? r.split('-') : []; return html`<div class=${`av-row ${r ? 'on' : ''}`} key=${day}>
        <b class="av-dname">${dayLabel(day)}</b>
        ${r ? html`<div class="row tight av-time">
            <select aria-label="Từ" disabled=${d.locked} value=${f} onChange=${(e) => setRange(day, `${e.target.value}-${t > e.target.value ? t : '24:00'}`)}>${TIMES.slice(0, -1).map((x) => html`<option value=${x}>${x}</option>`)}</select>
            <span>→</span>
            <select aria-label="Đến" disabled=${d.locked} value=${t} onChange=${(e) => setRange(day, `${f}-${e.target.value}`)}>${TIMES.filter((x) => x > f).map((x) => html`<option value=${x}>${x}</option>`)}</select>
            <button class="small" disabled=${d.locked} title="Bận" onClick=${() => setRange(day, null)}>✕</button></div>`
          : html`<button class="av-off" disabled=${d.locked} onClick=${() => setRange(day, lastRange())}>Bận · bấm nếu rảnh</button>`}
      </div>`; })}
      <div class="row wrap">
        ${hasPrev ? html`<button disabled=${d.locked} onClick=${() => setPicks(d.prev_picks)}>↺ Giống tuần trước</button>` : null}
        <button disabled=${d.locked} onClick=${() => toAll(lastRange())}>Cả tuần giờ ${lastRange().replace('-', '–')}</button>
        <button disabled=${d.locked} onClick=${() => setPicks({})}>Xoá hết</button>
      </div>
      <input id="av-note" placeholder="Ghi chú cho quản lý (vd T7 chỉ rảnh sau 19h)" value=${note} disabled=${d.locked} onInput=${(e) => setNote(e.target.value)} />
      <label class="check-row big-check"><input type="checkbox" checked=${fixed} disabled=${d.locked} onChange=${(e) => setFixed(e.target.checked)} /> <span><b>Tuần nào cũng vậy</b> (lịch cố định, khỏi báo lại)</span></label>
      <button class="primary big" disabled=${d.locked} onClick=${submit}>${d.submitted_at ? 'Gửi lại' : 'Gửi lịch rảnh'} (${count} ngày rảnh)</button>
    </section>
  </div>`;
}

// Xếp ca dễ: chọn ngày → thấy ai rảnh mấy giờ → "+ Xếp" → xong tuần bấm Công bố. Ai có quyền "Xếp ca" cũng làm được
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
function AddShift({ p, date, range, onClose }) {
  const [from, to] = (range || '17:00-23:00').split('-');
  const [f, setF] = useState({ from, to });
  const save = () => act(() => api('POST', '/api/shifts', { staff_id: p.id, date, team_id: p.team_id || undefined, label: 'Ca', segments: [{ start: f.from, end: f.to === '24:00' ? '00:00' : f.to }] }), `Đã xếp ${p.name}`).then((r) => r && onClose());
  return html`<${Modal} title=${`Xếp ca: ${p.name}`} onClose=${onClose}><div class="stack">
    <p class="small muted">${dayLabel(date)}${range ? ` · rảnh ${range.replace('-', '–')}` : ''}. Sửa giờ nếu cần rồi bấm Xếp.</p>
    <div class="row tight av-time"><select value=${f.from} onChange=${(e) => setF({ ...f, from: e.target.value })}>${TIMES.slice(0, -1).map((x) => html`<option value=${x}>${x}</option>`)}</select>
      <span>→</span><select value=${f.to} onChange=${(e) => setF({ ...f, to: e.target.value })}>${TIMES.filter((x) => x > f.from).map((x) => html`<option value=${x}>${x}</option>`)}</select></div>
    <button class="primary big" onClick=${save}>✓ Xếp ca ${f.from}–${f.to}</button>
  </div><//>`;
}

function Overview({ me, week, onWeek }) {
  const st = useData(`/api/availability${week ? `?week=${week}` : ''}`);
  const ws = st.data?.week_start;
  const sc = useData(ws ? `/api/schedule?week=${ws}` : null);
  const [team, setTeam] = useState('');
  const [day, setDay] = useState(null);
  const [add, setAdd] = useState(null);
  if (!st.data || !sc.data) return html`<${Loading} state=${st.data ? sc : st} />`;
  const d = st.data;
  const cur = day && d.days.includes(day) ? day : d.days[0];
  const teams = d.teams.filter((t) => d.people.some((p) => p.team_id === t.id));
  const inTeam = (x) => !team || x.team_id === Number(team);
  const shifts = sc.data.shifts.filter((x) => x.leave?.status !== 'approved');
  const shiftsOf = (date) => shifts.filter((x) => x.date === date && inTeam(x));
  const freeOf = (date) => {
    const has = new Set(shifts.filter((x) => x.date === date).map((x) => x.staff_id));
    return d.people.filter((p) => inTeam(p) && !has.has(p.id) && (d.hours?.[`${p.id}:${date}`] || []).length);
  };
  const missing = d.people.filter((p) => inTeam(p) && !p.submitted_at);
  const done = shiftsOf(cur);
  const free = freeOf(cur);
  const published = sc.data.published_at;
  const canManage = atLeast(me, 'manager') || (me.pages || []).includes('/lich#xep');
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Tuần trước" onClick=${() => { setDay(null); onWeek(addDays(d.week_start, -7)); }}>‹</button>
        <b>Tuần ${fmtDate(d.week_start)} – ${fmtDate(addDays(d.week_start, 6))}</b>
        <button class="icon" aria-label="Tuần sau" onClick=${() => { setDay(null); onWeek(addDays(d.week_start, 7)); }}>›</button>
      </div>
      ${published ? html`<span class="pill ok">Đã công bố</span>` : html`<span class="pill warn">Chưa công bố</span>`}
    </div>
    <section class="card hint small"><span><b>1.</b> Bấm ngày · <b>2.</b> Bấm <b>+ Xếp</b> cạnh người rảnh · <b>3.</b> Xếp xong cả tuần bấm <b>Công bố</b> để gửi lịch cho nhân viên.</span></section>
    <div class="chips scroll-x day-chips">${d.days.map((x) => { const n = shiftsOf(x).length; const fr = freeOf(x).length; return html`<button class=${`chip big ${x === cur ? 'on' : ''}`} onClick=${() => setDay(x)}>
      <b>${dayLabel(x).split(' ')[0]}</b> ${fmtDate(x)}<small>${n} ca${fr ? ` · ${fr} rảnh` : ''}</small></button>`; })}</div>
    <div class="chips"><button class=${`chip ${!team ? 'on' : ''}`} onClick=${() => setTeam('')}>Cả quán</button>
      ${teams.map((t) => html`<button class=${`chip ${team === String(t.id) ? 'on' : ''}`} onClick=${() => setTeam(String(t.id))}>${t.name}</button>`)}</div>

    <section class="card stack"><h3>🙋 Rảnh, chưa xếp (${free.length})</h3>
      ${free.length ? free.map((p) => { const rg = d.hours[`${p.id}:${cur}`]; return html`<div class="plan-row">
        <span class="grow"><b>${p.name}</b> <small class="muted">${p.team_name || ''}</small><br /><span class="ok-text">rảnh ${rg.join(', ').replace(/-/g, '–')}</span></span>
        ${canManage ? html`<button class="primary" onClick=${() => setAdd({ p, range: rg[0] })}>+ Xếp</button>` : null}</div>`; })
        : html`<p class="muted small">Không còn ai rảnh mà chưa xếp ngày này.</p>`}
    </section>

    <section class="card stack"><h3>✅ Đã xếp ca (${done.length})</h3>
      ${done.length ? done.map((x) => html`<div class="plan-row">
        <span class="grow"><b>${x.staff_name}</b> <small class="muted">${x.team_name || ''}</small><br /><span>${x.text}</span></span>
        ${canManage ? html`<button class="small" aria-label="Bỏ ca" onClick=${() => act(() => api('POST', '/api/shifts/delete', { group_id: x.group_id }), `Đã bỏ ca ${x.staff_name}`)}>✕ Bỏ</button>` : null}</div>`)
        : html`<p class="muted small">Chưa xếp ai ngày này.</p>`}
    </section>

    <details class="card"><summary><b>Chưa báo lịch rảnh (${missing.length})</b> <small class="muted">hạn ${WEEKDAY[dowOf(d.deadline.date)]} ${fmtDate(d.deadline.date)} ${d.deadline.time}</small></summary>
      <div class="stack">${missing.length ? html`<div class="chips">${missing.map((p) => html`<span class="chip">${p.name}</span>`)}</div>` : html`<p class="muted">Mọi người đã báo.</p>`}
      ${missing.length && canManage ? html`<button onClick=${() => act(() => api('POST', '/api/availability/remind', { week: d.week_start }), 'Đã nhắc')}>🔔 Nhắc tất cả</button>` : null}</div>
    </details>

    ${canManage ? html`<div class="sum-bar row between">
      <small class="muted">${shifts.length} ca cả tuần</small>
      <button class="primary big" disabled=${!shifts.length} onClick=${() => act(() => api('POST', '/api/schedule/publish', { week: d.week_start }), 'Đã gửi lịch cho nhân viên')}>📣 ${published ? 'Công bố lại' : 'Công bố lịch tuần'}</button></div>` : null}
    ${add ? html`<${AddShift} p=${add.p} date=${cur} range=${add.range} onClose=${() => setAdd(null)} />` : null}
  </div>`;
}

export function AvailabilityView({ me, query }) {
  const canPlan = atLeast(me, 'team_lead') || (me.pages || []).includes('/lich#xep');
  const mustSubmit = ['staff', 'team_lead', 'shift_lead'].includes(me.role);
  const [tab, setTab] = useState(query.get('tab') || (canPlan && !mustSubmit ? 'all' : 'mine'));
  const [week, setWeek] = useState(query.get('week') || '');
  return html`<div class="stack">
    ${canPlan ? html`<div class="tabs">${mustSubmit ? html`<button class=${tab === 'mine' ? 'on' : ''} onClick=${() => setTab('mine')}>Lịch rảnh của tôi</button>` : null}
      <button class=${tab === 'all' ? 'on' : ''} onClick=${() => setTab('all')}>🗓 Xếp ca</button></div>` : null}
    ${tab === 'all' && canPlan ? html`<${Overview} me=${me} week=${week} onWeek=${setWeek} />` : html`<${Mine} week=${week} onWeek=${setWeek} />`}
  </div>`;
}
