import { useState } from 'preact/hooks';
import { html, api, act, useData, Modal, Field, Loading, Confirm, dayLabel, addDays, atLeast, navigate, Link } from '../ui.js';

function ShiftForm({ init, staff, teams, templates, onClose }) {
  const person = staff.find((s) => s.id === init.staff_id);
  const [f, setF] = useState({
    staff_id: init.staff_id, date: init.date, team_id: init.team_id ?? person?.team_id ?? '',
    template_id: init.template_id ?? '', label: init.label ?? '', note: init.note ?? '',
    segments: init.segments?.map((s) => ({ start: s.start, end: s.end })) ?? [{ start: '', end: '' }],
  });
  const [ask, setAsk] = useState(false);
  const set = (k, v) => setF({ ...f, [k]: v });
  const pick = (t) => setF({ ...f, template_id: t.id, label: t.name, segments: t.segments.map((s) => ({ ...s })) });
  const seg = (i, k, v) => setF({ ...f, template_id: '', segments: f.segments.map((s, j) => (j === i ? { ...s, [k]: v } : s)) });
  const save = async () => {
    const body = { ...f, team_id: f.team_id || null, template_id: f.template_id || null, replace_group_id: init.group_id || undefined };
    if (await act(() => api('POST', '/api/shifts', body), init.group_id ? 'Đã sửa ca' : 'Đã xếp ca')) onClose();
  };
  return html`<${Modal} title=${init.group_id ? 'Sửa ca' : 'Xếp ca'} onClose=${onClose}>
    <div class="stack">
      <div class="row">
        <${Field} label="Nhân viên"><select id="sf-staff" value=${f.staff_id} onChange=${(e) => {
          const s = staff.find((x) => x.id === Number(e.target.value));
          setF({ ...f, staff_id: Number(e.target.value), team_id: s?.team_id ?? f.team_id });
        }}>${staff.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
        <${Field} label="Ngày"><input id="sf-date" type="date" value=${f.date} onInput=${(e) => set('date', e.target.value)} /><//>
      </div>
      <${Field} label="Làm ở tổ"><select id="sf-team" value=${f.team_id} onChange=${(e) => set('team_id', e.target.value)}>
        <option value="">(tổ chính của nhân viên)</option>${teams.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
      ${templates.length ? html`<div class="field"><span>Chọn nhanh loại ca</span><div class="chips">
        ${templates.filter((t) => t.active).map((t) => html`<button type="button" class=${`chip ${Number(f.template_id) === t.id ? 'on' : ''}`} onClick=${() => pick(t)}>
          <i class="sw" style=${`background:${t.color}`}></i>${t.name} <small>${t.segments.map((s) => `${s.start}–${s.end}`).join(' + ')}</small></button>`)}
      </div></div>` : html`<p class="muted small">Chưa có loại ca mẫu. Bạn vẫn nhập giờ trực tiếp được, hoặc tạo loại ca trong <${Link} href="/cai-dat?tab=ca">Cài đặt<//>.</p>`}
      <div class="field"><span>Giờ làm ${f.segments.length > 1 ? '(ca gãy)' : ''}</span>
        ${f.segments.map((s, i) => html`<div class="row seg">
          <input id=${`sf-s${i}`} type="time" value=${s.start} onInput=${(e) => seg(i, 'start', e.target.value)} aria-label="Bắt đầu" />
          <span>đến</span>
          <input id=${`sf-e${i}`} type="time" value=${s.end} onInput=${(e) => seg(i, 'end', e.target.value)} aria-label="Kết thúc" />
          ${f.segments.length > 1 ? html`<button class="icon" aria-label="Bỏ khúc này" onClick=${() => setF({ ...f, segments: f.segments.filter((_, j) => j !== i) })}>✕</button>` : null}
        </div>`)}
        ${f.segments.length < 4 ? html`<button type="button" class="link" onClick=${() => setF({ ...f, template_id: '', segments: [...f.segments, { start: '', end: '' }] })}>+ Thêm khúc (ca gãy)</button>` : null}
        <small class="muted">Giờ kết thúc nhỏ hơn giờ bắt đầu nghĩa là qua ngày hôm sau (vd 17:00 đến 00:30).</small>
      </div>
      <div class="row">
        <${Field} label="Tên ca (tuỳ chọn)"><input id="sf-label" value=${f.label} onInput=${(e) => set('label', e.target.value)} /><//>
        <${Field} label="Ghi chú"><input id="sf-note" value=${f.note} onInput=${(e) => set('note', e.target.value)} /><//>
      </div>
      <div class="row between">
        ${init.group_id ? html`<button class="danger" onClick=${() => setAsk(true)}>Xoá ca</button>` : html`<span></span>`}
        <div class="row"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu</button></div>
      </div>
    </div>
    ${ask ? html`<${Confirm} text="Xoá ca này khỏi lịch?" danger yes="Xoá" onClose=${() => setAsk(false)}
      onYes=${async () => { if (await act(() => api('POST', '/api/shifts/delete', { group_id: init.group_id }), 'Đã xoá ca')) onClose(); }} />` : null}
  <//>`;
}

function ShiftChip({ s, onClick, mine }) {
  const leave = s.leave?.status;
  return html`<button class=${`shift ${leave ? `lv-${leave}` : ''} ${mine ? 'mine' : ''}`} style=${`--c:${s.color}`} onClick=${onClick} disabled=${!onClick}>
    <b>${s.text}</b>${s.label ? html`<small>${s.label}</small>` : null}${leave === 'approved' ? html`<small>Nghỉ</small>` : leave === 'pending' ? html`<small>Xin nghỉ</small>` : null}
  </button>`;
}


// Số người theo từng giờ trong ngày (tính cả ca qua đêm từ hôm trước), mỗi tổ một hàng
export function hourlyCoverage(shifts, day, prevDay) {
  const rows = new Map();
  const add = (teamId, staffId, fromMin, toMin) => {
    for (let h = Math.max(0, Math.floor(fromMin / 60)); h < Math.min(24, Math.ceil(toMin / 60)); h++) {
      if (Math.min(toMin, (h + 1) * 60) - Math.max(fromMin, h * 60) <= 0) continue;
      const r = rows.get(teamId) || Array.from({ length: 24 }, () => new Set());
      r[h].add(staffId);
      rows.set(teamId, r);
    }
  };
  for (const sh of shifts) {
    if (sh.leave?.status === 'approved') continue;
    for (const seg of sh.segments) {
      if (sh.date === day) add(sh.team_id, sh.staff_id, seg.start_min, seg.end_min);
      else if (sh.date === prevDay && seg.end_min > 1440) add(sh.team_id, sh.staff_id, 0, seg.end_min - 1440);
    }
  }
  return rows;
}

function HourCoverage({ shifts, day, prevDay, teams }) {
  const rows = hourlyCoverage(shifts, day, prevDay);
  const counts = (r) => r.map((set) => set.size);
  const total = Array.from({ length: 24 }, (_, h) => [...rows.values()].reduce((n, r) => n + r[h].size, 0));
  const used = total.map((n, h) => (n ? h : null)).filter((h) => h !== null);
  if (!used.length) return html`<section class="card"><h3>Số người theo giờ</h3><p class="muted small">Ngày này chưa xếp ca nào.</p></section>`;
  const from = Math.min(...used);
  const to = Math.max(...used);
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const max = Math.max(...total, 1);
  const cell = (n, min, isTotal) => {
    const tone = n === 0 ? 'zero' : !isTotal && min && n < min ? 'low' : '';
    const alpha = n ? 0.15 + 0.6 * (n / (isTotal ? max : Math.max(min || 1, n))) : 0;
    return html`<td class=${`hc ${tone}`} style=${tone ? '' : `--a:${Math.min(alpha, 0.75)}`}>${n || ''}</td>`;
  };
  return html`<section class="card">
    <div class="row between"><h3>Số người theo giờ</h3><span class="muted small">ô vàng: ít hơn số tối thiểu của tổ</span></div>
    <div class="grid-wrap"><table class="hours">
      <thead><tr><th class="who">Tổ</th>${hours.map((h) => html`<th>${h}h</th>`)}</tr></thead>
      <tbody>
        ${teams.filter((t) => rows.has(t.id)).map((t) => html`<tr><td class="who">${t.name}</td>${hours.map((h) => cell(counts(rows.get(t.id))[h], t.min_staff))}</tr>`)}
        ${rows.has(null) ? html`<tr><td class="who">Chưa có tổ</td>${hours.map((h) => cell(rows.get(null)[h].size, 0))}</tr>` : null}
        <tr class="sum"><td class="who">Cả quán</td>${hours.map((h) => cell(total[h], 0, true))}</tr>
      </tbody>
    </table></div>
  </section>`;
}

export function Schedule({ me, query }) {
  const week = query.get('week') || me.today;
  const st = useData(`/api/schedule?week=${week}`);
  const staff = useData('/api/staff');
  const tpl = useData('/api/shift-templates');
  const [edit, setEdit] = useState(null);
  const [mode, setMode] = useState(() => (window.innerWidth < 760 ? 'day' : 'week'));
  const [day, setDay] = useState(me.today);
  const canEdit = atLeast(me, 'manager');
  if (!st.data || !staff.data) return html`<${Loading} state=${st.data ? staff : st} />`;
  const d = st.data;
  const teams = me.teams;
  const go = (n) => navigate(`/lich?week=${addDays(d.week_start, n)}`);
  const byCell = new Map();
  for (const s of d.shifts) byCell.set(`${s.staff_id}:${s.date}`, [...(byCell.get(`${s.staff_id}:${s.date}`) || []), s]);
  const activeDay = d.days.includes(day) ? day : d.days[0];
  // Tổng giờ mỗi người trong ngày / tuần (không tính ca đã duyệt nghỉ) để đánh dấu người làm 2 ca, làm quá giờ
  const mins = (list) => list.filter((s) => s.leave?.status !== 'approved').reduce((n, s) => n + s.segments.reduce((m, g) => m + g.end_min - g.start_min, 0), 0);
  const dayInfo = (pid, date) => {
    const list = (byCell.get(`${pid}:${date}`) || []).filter((s) => s.leave?.status !== 'approved');
    const m = mins(list);
    return { count: list.length, minutes: m, over: m > 10 * 60 };
  };
  const weekMin = (pid) => mins(d.shifts.filter((s) => s.staff_id === pid));
  const fmtH = (m) => `${Math.floor(m / 60)}g${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
  const DayBadge = ({ pid, date }) => {
    const i = dayInfo(pid, date);
    if (i.count < 2 && !i.over) return null;
    return html`<div class=${`daybadge ${i.over ? 'bad' : 'warn'}`}>${i.count >= 2 ? `${i.count} ca · ` : ''}${fmtH(i.minutes)}${i.over ? ' (quá 10g)' : ''}</div>`;
  };
  const doubles = [];
  for (const p of staff.data) for (const x of d.days) { const i = dayInfo(p.id, x); if (i.count >= 2 || i.over) doubles.push({ p, x, i }); }
  const groups = [...teams.map((t) => ({ ...t, people: staff.data.filter((p) => p.team_id === t.id) })),
    { id: null, name: 'Chưa có tổ', people: staff.data.filter((p) => !p.team_id && p.role !== 'owner') }].filter((g) => g.people.length);

  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Tuần trước" onClick=${() => go(-7)}>‹</button>
        <b>Tuần ${dayLabel(d.days[0]).slice(3)} – ${dayLabel(d.days[6]).slice(3)}</b>
        <button class="icon" aria-label="Tuần sau" onClick=${() => go(7)}>›</button>
        <button class="small" onClick=${() => navigate('/lich')}>Tuần này</button>
      </div>
      <div class="row">
        <div class="seg-ctl"><button class=${mode === 'day' ? 'on' : ''} onClick=${() => setMode('day')}>Theo ngày</button><button class=${mode === 'week' ? 'on' : ''} onClick=${() => setMode('week')}>Cả tuần</button></div>
        ${canEdit ? html`
          <button onClick=${() => act(async () => {
            const r = await api('POST', '/api/schedule/copy', { from_week: addDays(d.week_start, -7), to_week: d.week_start });
            return r;
          }, 'Đã chép lịch tuần trước (bỏ qua ô đã có ca)')}>Chép tuần trước</button>
          <button class="primary" onClick=${() => act(() => api('POST', '/api/schedule/publish', { week: d.week_start }), 'Đã gửi lịch cho nhân viên')}>
            ${d.published_at ? 'Gửi lại lịch' : 'Gửi lịch cho nhân viên'}</button>` : null}
      </div>
    </div>

    ${doubles.length ? html`<details class="card attn"><summary><b>${doubles.length} lượt làm 2 ca hoặc quá 10 giờ/ngày</b> trong tuần này</summary>
      <ul class="plain">${doubles.map(({ p, x, i }) => html`<li>${dayLabel(x)}: <b>${p.name}</b> ${i.count} ca, ${fmtH(i.minutes)}${i.over ? ' (quá 10 giờ)' : ''}</li>`)}</ul></details>` : null}
    ${d.warnings.length ? html`<details class="card attn"><summary><b>${d.warnings.length} chỗ thiếu người</b> so với số tối thiểu của tổ</summary>
      <ul class="plain">${d.warnings.map((w) => html`<li>${w.text}</li>`)}</ul></details>` : null}

    ${mode === 'week' ? html`<div class="grid-wrap"><table class="sched">
      <thead><tr><th class="who">Nhân viên</th>${d.days.map((x) => html`<th class=${x === me.today ? 'today' : ''}>${dayLabel(x)}</th>`)}</tr></thead>
      <tbody>${groups.map((g) => html`
        <tr class="grp"><td class="who">${g.name}</td>${d.days.map((x) => html`<td class="cov">${g.id ? `${d.coverage[x]?.[g.id] ?? 0}${teams.find((t) => t.id === g.id)?.min_staff ? `/${teams.find((t) => t.id === g.id).min_staff}` : ''}` : ''}</td>`)}</tr>
        ${g.people.map((p) => html`<tr class=${p.id === me.id ? 'me' : ''}>
          <td class="who">${p.name}<small>${p.role !== 'staff' ? `${p.role_label} · ` : ''}<span class=${weekMin(p.id) > (p.weekly_limit_hours || 48) * 60 ? 'bad-text' : ''}>${fmtH(weekMin(p.id))}/${p.weekly_limit_hours || 48}g tuần</span></small></td>
          ${d.days.map((x) => {
            const cell = byCell.get(`${p.id}:${x}`) || [];
            return html`<td class=${x === me.today ? 'today' : ''}>
              <${DayBadge} pid=${p.id} date=${x} />
              ${cell.map((s) => html`<${ShiftChip} s=${s} mine=${p.id === me.id} onClick=${canEdit ? () => setEdit(s) : null} />`)}
              ${canEdit ? html`<button class="add" aria-label=${`Xếp ca ${p.name} ${x}`} onClick=${() => setEdit({ staff_id: p.id, date: x, team_id: p.team_id })}>+</button>` : null}
            </td>`;
          })}
        </tr>`)}`)}
      </tbody></table></div>`
    : html`<div class="daytabs">${d.days.map((x) => html`<button class=${`${x === activeDay ? 'on' : ''} ${x === me.today ? 'today' : ''}`} onClick=${() => setDay(x)}>${dayLabel(x)}</button>`)}</div>
      <${HourCoverage} shifts=${d.shifts} day=${activeDay} prevDay=${addDays(activeDay, -1)} teams=${teams} />
      ${groups.map((g) => {
        const people = g.people.map((p) => ({ p, cell: byCell.get(`${p.id}:${activeDay}`) || [] }));
        const on = people.filter((x) => x.cell.length);
        const min = teams.find((t) => t.id === g.id)?.min_staff;
        return html`<section class="card">
          <div class="row between"><h3>${g.name}</h3><span class=${`pill ${min && (d.coverage[activeDay]?.[g.id] ?? 0) < min ? 'warn' : ''}`}>${g.id ? d.coverage[activeDay]?.[g.id] ?? 0 : on.length}${min ? `/${min}` : ''} người</span></div>
          ${on.map(({ p, cell }) => html`<div class="person"><span class="grow"><b>${p.name}</b><${DayBadge} pid=${p.id} date=${activeDay} /></span>
            <div class="row">${cell.map((s) => html`<${ShiftChip} s=${s} mine=${p.id === me.id} onClick=${canEdit ? () => setEdit(s) : null} />`)}</div></div>`)}
          ${canEdit ? html`<details><summary class="muted small">Xếp thêm người (${people.length - on.length} người chưa có ca)</summary>
            <div class="chips">${people.filter((x) => !x.cell.length).map(({ p }) => html`<button class="chip" onClick=${() => setEdit({ staff_id: p.id, date: activeDay, team_id: p.team_id })}>+ ${p.name}</button>`)}</div></details>`
            : !on.length ? html`<p class="muted small">Chưa có ai.</p>` : null}
        </section>`;
      })}`}

    ${edit ? html`<${ShiftForm} init=${edit} staff=${staff.data.filter((s) => s.active)} teams=${teams} templates=${tpl.data || []} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}
