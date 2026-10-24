import { useState, useEffect } from 'preact/hooks';
import { html, api, act, useData, Loading, dayLabel, addDays, atLeast, navigate } from '../ui.js';

const fmtDate = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
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
  const has = (day, k) => (picks[day] || []).includes(k);
  const toggle = (day, k) => setPicks({ ...picks, [day]: has(day, k) ? picks[day].filter((x) => x !== k) : [...(picks[day] || []), k] });
  const allDay = (day) => setPicks({ ...picks, [day]: d.slots.every((s) => has(day, s.key)) ? [] : d.slots.map((s) => s.key) });
  const count = Object.values(picks).reduce((n, x) => n + x.length, 0);
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
      : html`<section class="card hint"><span>Bấm <b>buổi rảnh</b> → <b>Gửi</b>. Tick "Tuần nào cũng vậy" thì <b>chỉ báo 1 lần</b>, các tuần sau app tự dùng. Hạn: <b>${WEEKDAY[dowOf(d.deadline.date)]} ${fmtDate(d.deadline.date)} lúc ${d.deadline.time}</b>.</span></section>`}
    ${d.locked ? html`<p class="warn-text">Tuần này đã bắt đầu. Muốn đổi, báo quản lý.</p>` : null}
    <section class="card avail">
      ${d.days.map((day) => html`<div class="av-day" key=${day}>
        <button class="av-name" disabled=${d.locked} onClick=${() => allDay(day)}>${dayLabel(day)}</button>
        <div class="av-slots">${d.slots.map((s) => html`<button class=${`av-slot ${has(day, s.key) ? 'on' : ''}`} disabled=${d.locked} onClick=${() => toggle(day, s.key)}>
          <b>${s.label}</b><small>${s.start}–${s.end}</small></button>`)}</div>
      </div>`)}
      <div class="row wrap">
        ${hasPrev ? html`<button disabled=${d.locked} onClick=${() => setPicks(d.prev_picks)}>↺ Giống tuần trước</button>` : null}
        <button disabled=${d.locked} onClick=${() => setPicks(Object.fromEntries(d.days.map((x) => [x, d.slots.map((s) => s.key)])))}>Rảnh cả tuần</button>
        <button disabled=${d.locked} onClick=${() => setPicks({})}>Xoá hết</button>
      </div>
      <input id="av-note" placeholder="Ghi chú cho quản lý (vd T7 chỉ rảnh sau 19h)" value=${note} disabled=${d.locked} onInput=${(e) => setNote(e.target.value)} />
      <label class="check-row big-check"><input type="checkbox" checked=${fixed} disabled=${d.locked} onChange=${(e) => setFixed(e.target.checked)} /> <span><b>Tuần nào cũng vậy</b> (lịch cố định, khỏi báo lại)</span></label>
      <button class="primary big" disabled=${d.locked} onClick=${submit}>${d.submitted_at ? 'Gửi lại' : 'Gửi lịch rảnh'} (${count} buổi)</button>
    </section>
  </div>`;
}

function Overview({ me, week, onWeek }) {
  const st = useData(`/api/availability${week ? `?week=${week}` : ''}`);
  const [team, setTeam] = useState('');
  const [open, setOpen] = useState(null);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const teams = d.teams.filter((t) => d.people.some((p) => p.team_id === t.id));
  const people = d.people.filter((p) => !team || p.team_id === Number(team));
  const pid = new Set(people.map((p) => p.id));
  const busy = new Set(d.busy);
  const missing = people.filter((p) => !p.submitted_at);
  const cellOf = (day, slot) => {
    const c = d.cells[`${day}:${slot}`];
    const free = c.free.filter((id) => pid.has(id));
    const need = team ? c.by_team[team]?.need || 0 : 0;
    const sched = team ? c.by_team[team]?.scheduled || 0 : Object.values(c.by_team).reduce((n, x) => n + x.scheduled, 0);
    return { free, need, sched };
  };
  const tone = ({ free, need }) => (!need ? (free.length ? 'ok' : 'zero') : free.length < need ? 'low' : free.length > need * 1.5 ? 'many' : 'ok');
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Tuần trước" onClick=${() => onWeek(addDays(d.week_start, -7))}>‹</button>
        <b>Tuần ${fmtDate(d.week_start)} – ${fmtDate(addDays(d.week_start, 6))}</b>
        <button class="icon" aria-label="Tuần sau" onClick=${() => onWeek(addDays(d.week_start, 7))}>›</button>
      </div>
      <button onClick=${() => navigate(`/lich?week=${d.week_start}`)}>Mở lịch ca tuần này →</button>
    </div>
    <div class="chips"><button class=${`chip ${!team ? 'on' : ''}`} onClick=${() => setTeam('')}>Cả quán</button>
      ${teams.map((t) => html`<button class=${`chip ${team === String(t.id) ? 'on' : ''}`} onClick=${() => setTeam(String(t.id))}>${t.name}</button>`)}</div>
    <section class="card">
      <div class="row between"><h3>Số người rảnh</h3><span class="muted small">${team ? 'rảnh / cần tối thiểu · đỏ = thiếu, xanh đậm = dư' : 'chọn bộ phận để so với số tối thiểu'}</span></div>
      <div class="grid-wrap"><table class="hours avail-grid">
        <thead><tr><th class="who">Ngày</th>${d.slots.map((s) => html`<th>${s.label}</th>`)}</tr></thead>
        <tbody>${d.days.map((day) => html`<tr><td class="who">${dayLabel(day)}</td>${d.slots.map((s) => {
          const c = cellOf(day, s.key);
          return html`<td class=${`av-cell ${tone(c)}`} onClick=${() => setOpen({ day, slot: s })}>
            <b>${c.free.length}</b>${c.need ? html`<small>/${c.need}</small>` : null}${c.sched ? html`<br /><small>đã xếp ${c.sched}</small>` : null}</td>`;
        })}</tr>`)}</tbody>
      </table></div>
    </section>
    ${open ? html`<section class="card stack">
      <div class="row between"><h3>${dayLabel(open.day)} · ${open.slot.label} (${open.slot.start}–${open.slot.end})</h3><button class="icon" aria-label="Đóng" onClick=${() => setOpen(null)}>✕</button></div>
      ${(() => {
        const ids = cellOf(open.day, open.slot.key).free;
        const list = people.filter((p) => ids.includes(p.id));
        return list.length ? html`<ul class="plain">${list.map((p) => html`<li class="row between"><span><b>${p.name}</b> <small class="muted">${p.team_name || ''}${p.position_name ? ` · ${p.position_name}` : ''}</small></span>
          ${busy.has(`${p.id}:${open.day}:${open.slot.key}`) ? html`<span class="pill ok">Đã xếp</span>` : html`<span class="pill muted">Chưa xếp</span>`}</li>`)}</ul>`
          : html`<p class="muted">Không ai báo rảnh buổi này.</p>`;
      })()}
    </section>` : null}
    <section class="card stack">
      <div class="row between"><h3>Chưa gửi lịch rảnh (${missing.length})</h3>
        ${missing.length && atLeast(me, 'manager') ? html`<button onClick=${() => act(() => api('POST', '/api/availability/remind', { week: d.week_start }), 'Đã nhắc')}>Nhắc tất cả</button>` : null}</div>
      <p class="muted small">Hạn: ${WEEKDAY[dowOf(d.deadline.date)]} ${fmtDate(d.deadline.date)} lúc ${d.deadline.time}.</p>
      ${missing.length ? html`<div class="chips">${missing.map((p) => html`<span class="chip">${p.name}</span>`)}</div>` : html`<p class="muted">Mọi người đã gửi.</p>`}
      ${people.some((p) => p.fixed) ? html`<p class="small muted">${people.filter((p) => p.fixed).length} bạn dùng lịch cố định (tự điền mỗi tuần).</p>` : null}
      ${people.some((p) => p.note) ? html`<details><summary class="muted small">Ghi chú của nhân viên</summary><ul class="plain small">
        ${people.filter((p) => p.note).map((p) => html`<li><b>${p.name}:</b> ${p.note}</li>`)}</ul></details>` : null}
    </section>
  </div>`;
}

export function AvailabilityView({ me, query }) {
  const lead = atLeast(me, 'team_lead');
  const [tab, setTab] = useState(query.get('tab') || (lead && !['staff', 'team_lead', 'shift_lead'].includes(me.role) ? 'all' : 'mine'));
  const [week, setWeek] = useState(query.get('week') || '');
  const mustSubmit = ['staff', 'team_lead', 'shift_lead'].includes(me.role);
  return html`<div class="stack">
    ${lead ? html`<div class="tabs">${mustSubmit ? html`<button class=${tab === 'mine' ? 'on' : ''} onClick=${() => setTab('mine')}>Lịch rảnh của tôi</button>` : null}
      <button class=${tab === 'all' ? 'on' : ''} onClick=${() => setTab('all')}>Cả quán</button></div>` : null}
    ${tab === 'all' && lead ? html`<${Overview} me=${me} week=${week} onWeek=${setWeek} />` : html`<${Mine} week=${week} onWeek=${setWeek} />`}
  </div>`;
}
