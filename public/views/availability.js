import { useState, useEffect } from 'preact/hooks';
import { HourCoverage } from './schedule.js';
import { html, api, act, useData, Loading, Modal, dt, dayLabel, addDays, atLeast, navigate, toast } from '../ui.js';

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
  const tplD = useData('/api/shift-templates');
  const [editDay, setEditDay] = useState(null);
  useEffect(() => { if (st.data) { setPicks(st.data.picks); setNote(st.data.auto ? '' : st.data.note); setFixed(Object.keys(st.data.fixed || {}).length > 0); } }, [st.data]);
  if (!st.data || !picks) return html`<${Loading} state=${st} />`;
  const d = st.data;
  // Mỗi ngày bấm chọn KHUNG GIỜ LÀM CỦA QUÁN (loại ca: 06h–14h, 14h–22h…), chọn được nhiều (không cho tự ghi giờ, chủ quán chốt). Không chọn = bận
  const tpls = (tplD.data || []).filter((t) => t.active);
  const fix = (e) => (e === '00:00' ? '24:00' : e);
  const tplR = (t) => t.segments.map((sg) => `${sg.start}-${sg.end <= sg.start ? '24:00' : fix(sg.end)}`);
  const ranges = (day) => picks[day] || [];
  const tplOn = (day, t) => tplR(t).every((r) => ranges(day).includes(r));
  const isTpl = (r) => tpls.some((t) => tplR(t).includes(r));
  const toggleTpl = (day, t) => { const rs = tplR(t); setPicks({ ...picks, [day]: tplOn(day, t) ? ranges(day).filter((r) => !rs.includes(r)) : [...new Set([...ranges(day), ...rs])] }); };
  const setCustom = (day, old, r) => setPicks({ ...picks, [day]: ranges(day).map((x) => (x === old ? r : x)).filter(Boolean) });
  const addCustom = (day) => setPicks({ ...picks, [day]: [...ranges(day), '16:00-23:00'] });
  const firstDay = d.days.find((x) => ranges(x).length);
  const count = d.days.filter((x) => ranges(x).length).length;
  const short2 = (r) => r.replace(/:00/g, 'h').replace(/:30/g, 'h30').replace('-', '–');
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
      : html`<section class="card hint"><span>Bấm vào bảng: <b>ca nào, ngày nào bạn làm được</b> → <b>Gửi</b> cho quản lý. Tick "Tuần nào cũng vậy" thì <b>chỉ báo 1 lần</b>, các tuần sau app tự dùng. Hạn: <b>${WEEKDAY[dowOf(d.deadline.date)]} ${fmtDate(d.deadline.date)} lúc ${d.deadline.time}</b>.</span></section>`}
    ${d.locked ? html`<p class="warn-text">Tuần này đã bắt đầu. Muốn đổi, báo quản lý.</p>` : null}
    <section class="card avail stack">
      ${!tpls.length ? html`<p class="warn-text">Quán chưa tạo ca (chủ quán / quản lý vào Cài đặt → Loại ca). Tạo xong ca sẽ hiện ở đây để bạn chọn.</p>` : null}
      <div class="wk-wrap"><table class="wk av-grid">
        <thead><tr><th class="wk-name">Ca</th>${d.days.map((x) => html`<th>${dayLabel(x).split(' ')[0]}<br /><small>${x.slice(8)}/${x.slice(5, 7)}</small></th>`)}</tr></thead>
        <tbody>
          ${tpls.map((t) => html`<tr><td class="wk-name"><b>${t.name}</b><br /><small class="muted">${tplR(t).map(short2).join(' + ')}</small></td>
            ${d.days.map((x) => html`<td class=${tplOn(x, t) ? 'has' : 'off'} onClick=${() => !d.locked && toggleTpl(x, t)}>${tplOn(x, t) ? '✓' : ''}</td>`)}</tr>`)}
        </tbody>
      </table></div>
      <p class="small muted">Bấm ô để chọn / bỏ. Ô ✓ = ngày đó bạn làm được ca đó. Cột trống = bận.</p>
      <div class="row wrap">
        ${hasPrev ? html`<button disabled=${d.locked} onClick=${() => setPicks(d.prev_picks)}>↺ Giống tuần trước</button>` : null}
        ${firstDay ? html`<button disabled=${d.locked} onClick=${() => setPicks(Object.fromEntries(d.days.map((x) => [x, [...ranges(firstDay)]])))}>Cả tuần giống ${dayLabel(firstDay).split(' ')[0]}</button>` : null}
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
function AddShift({ p, date, range, onClose, replaceId = null }) {
  const [from, to] = (range || '17:00-23:00').split('-');
  const [f, setF] = useState({ from, to });
  const save = () => act(() => api('POST', '/api/shifts', { staff_id: p.id, date, team_id: p.team_id || undefined, label: 'Ca', segments: [{ start: f.from, end: f.to === '24:00' ? '00:00' : f.to }], replace_group_id: replaceId || undefined }), replaceId ? `Đã sửa ca ${p.name}` : `Đã xếp ${p.name}`).then((r) => r && onClose());
  return html`<${Modal} title=${`${replaceId ? 'Sửa ca' : 'Xếp ca'}: ${p.name}`} onClose=${onClose}><div class="stack">
    <p class="small muted">${dayLabel(date)}${range ? ` · ${replaceId ? 'đang' : 'rảnh'} ${range.replace('-', '–')}` : ''}. ${replaceId ? 'Chọn giờ mới rồi bấm Lưu.' : 'Sửa giờ nếu cần rồi bấm Xếp.'}</p>
    <div class="row tight av-time"><select value=${f.from} onChange=${(e) => setF({ ...f, from: e.target.value })}>${TIMES.slice(0, -1).map((x) => html`<option value=${x}>${x}</option>`)}</select>
      <span>→</span><select value=${f.to} onChange=${(e) => setF({ ...f, to: e.target.value })}>${TIMES.filter((x) => x > f.from).map((x) => html`<option value=${x}>${x}</option>`)}</select></div>
    <button class="primary big" onClick=${save}>✓ ${replaceId ? 'Lưu' : 'Xếp'} ca ${f.from}–${f.to}</button>
  </div><//>`;
}

// Bảng tuần giống bảng Excel "Lịch trực ca": theo bộ phận, mỗi người 1 dòng, cột T2 → CN.
// Ô đậm = đã xếp ca (bấm để bỏ) · ô xanh = rảnh (bấm để xếp) · ô trống = bận / chưa báo (vẫn bấm xếp được)
const short = (t) => t.replace(/:00/g, '').replace(/^0/, '').replace(/–0/, '–');
function WeekTable({ d, shifts, staff, team, canManage, onAdd, onTake }) {
  const [cell, setCell] = useState(null);
  const zonesD = useData('/api/zones');
  const zones = (zonesD.data || []).filter((z) => z.active !== false && z.active !== 0);
  const zShort = (n) => (n || '').replace(/^Khu\s*/i, '');
  // Giao khu cho ca: lưu lại ca với khu mới (giữ giờ)
  const setZone = (x, zoneId) => act(() => api('POST', '/api/shifts', { staff_id: x.staff_id, date: x.date, team_id: x.team_id || undefined, label: x.label || 'Ca', template_id: x.template_id || undefined,
    segments: x.segments.map((sg) => ({ start: sg.start, end: sg.end })), zone_id: zoneId || undefined, replace_group_id: x.group_id }), zoneId ? 'Đã giao khu' : 'Đã bỏ khu').then((r) => r && setCell(null));
  const [edit, setEdit] = useState(null);
  const people = staff.filter((p) => p.active !== false && p.role !== 'owner' && (!team || p.team_id === Number(team)));
  const groups = [...d.teams.map((t) => ({ id: t.id, name: t.name })), { id: null, name: 'Chưa có bộ phận' }]
    .map((g) => ({ ...g, people: people.filter((p) => (g.id ? p.team_id === g.id : !d.teams.some((t) => t.id === p.team_id))) })).filter((g) => g.people.length);
  const shiftOf = (pid, date) => shifts.filter((x) => x.staff_id === pid && x.date === date);
  const text = (x) => x.segments.map((sg) => short(`${sg.start}–${sg.end === '00:00' ? '24' : sg.end}`)).join(', ');
  return html`<div class="stack">
    <p class="small muted"><span class="lg has">6–14</span> đã xếp (bấm để sửa / bỏ) · <span class="lg free">16–23</span> rảnh (bấm để xếp) · ô trống: bận / chưa báo</p>
    ${groups.map((g) => html`<section class="card wk-card">
      <div class="wk-head">${g.name.toUpperCase()} <small>${g.people.length} người</small>
        ${canManage && g.id ? html`<button class="small wk-ok" onClick=${() => confirm(`Duyệt lịch ${g.name} tuần này?\nNgày chưa có ca mà có lịch rảnh sẽ được xếp ca theo lịch rảnh, báo từng người và bot gửi bảng lịch vào nhóm Zalo của ${g.name}.`)
          && act(() => api('POST', '/api/schedule/publish-team', { week: d.week_start, team_id: g.id })).then((r) => r && toast(`Đã duyệt ${g.name}: ${r.sent} người có ca${r.made ? `, xếp thêm ${r.made} ca theo lịch rảnh` : ''}${r.groups ? ', đã gửi nhóm Zalo' : r.group_error ? `. Nhóm Zalo lỗi: ${r.group_error}` : '. Chưa có nhóm Zalo nào chọn bộ phận này'}`))}>✅ Duyệt ${g.name}</button>` : null}</div>
      <div class="wk-wrap"><table class="wk">
        <thead><tr><th class="wk-name">Tên</th>${d.days.map((x) => html`<th>${dayLabel(x).split(' ')[0]}<br /><small>${x.slice(8)}/${x.slice(5, 7)}</small><br /><b class="wk-n">${g.people.filter((p) => shiftOf(p.id, x).length).length}</b></th>`)}</tr></thead>
        <tbody>${g.people.map((p) => { return html`<tr><td class="wk-name"><b>${p.name}</b>${staffTags(p)}
</td>
          ${d.days.map((x) => {
            const sh = shiftOf(p.id, x);
            const fr = d.hours?.[`${p.id}:${x}`] || [];
            if (sh.length) return html`<td class="has" onClick=${() => canManage && setCell({ p, x, sh })}>${sh.map(text).join(' ')}${sh.some((m) => m.zone_name) ? html`<br /><b class="zone-badge">📍${sh.map((m) => zShort(m.zone_name)).filter(Boolean).join(',')}</b>` : null}</td>`;
            if (fr.length) return html`<td class="free" onClick=${() => canManage && onAdd(p, x, fr[0])}>${fr.map((r) => short(r.replace('-', '–').replace('24:00', '24'))).join(' ')}</td>`;
            return html`<td class="off" onClick=${() => canManage && onAdd(p, x, null)}></td>`;
          })}</tr>`; })}</tbody>
      </table></div>
    </section>`)}
    ${cell ? html`<${Modal} title=${`${cell.p.name} · ${dayLabel(cell.x)}`} onClose=${() => setCell(null)}><div class="stack">
      ${cell.sh.map((x) => html`<div class="stack"><b>${x.text}${x.zone_name ? ` · 📍 ${x.zone_name}` : ''}</b>
        ${x.created_by_name ? html`<small class="muted">Xếp bởi ${x.created_by_name}${x.created_at ? ` · ${dt(x.created_at)}` : ''}</small>` : null}
        <div class="row wrap">
        ${x.segments.length === 1 ? html`<button class="primary" onClick=${() => { setEdit({ p: cell.p, date: cell.x, range: `${x.segments[0].start}-${x.segments[0].end === '00:00' ? '24:00' : x.segments[0].end}`, id: x.group_id }); setCell(null); }}>✎ Sửa giờ</button>` : null}
        <button onClick=${() => act(() => api('POST', '/api/shifts/delete', { group_id: x.group_id }), `Đã bỏ ca ${cell.p.name}`).then((r) => r && setCell(null))}>✕ Bỏ ca</button></div></div>`)}
    </div><//>` : null}
    ${edit ? html`<${AddShift} p=${edit.p} date=${edit.date} range=${edit.range} replaceId=${edit.id} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}

// Phân khu theo tuần: danh sách nhân viên, bấm khu 1 lần cho cả tuần (chủ quán 24/10)
function WeekZones({ ws, staff, teams, map, shifts = [], onClose }) {
  const zonesD = useData('/api/zones');
  const zones = (zonesD.data || []).filter((z) => z.active !== false && z.active !== 0);
  const pv = teams.find((t) => /phục vụ/i.test(t.name));
  const team = pv ? String(pv.id) : ''; // chỉ Phục vụ chia khu (chủ quán 24/10)
  const [cur, setCur] = useState(map || {});
  const RANK = ['manager', 'shift_lead', 'team_lead', 'staff'];
  // Trưởng ca, tổ trưởng lên đầu danh sách
  const people = staff.filter((p) => p.active !== false && p.role !== 'owner' && (!team || p.team_id === Number(team)))
    .sort((a, b) => RANK.indexOf(a.role) - RANK.indexOf(b.role));
  const zOf = (p) => { const v0 = cur[p.id]; return v0 && typeof v0 === 'object' ? Number(v0.z) : Number(v0) || null; };
  const tOf = (p) => { const v0 = cur[p.id]; return v0 && typeof v0 === 'object' ? v0.t || '' : ''; };
  const pick = (p, zid, tables = '') => act(() => api('POST', '/api/schedule/week-zones', { week: ws, staff_id: p.id, zone_id: zid || undefined, tables_text: tables })).then((r) => r && setCur(r.week_zones));
  const count = (zid) => people.filter((p) => zOf(p) === zid).length;
  return html`<${Modal} title=${`📍 Phân khu tuần ${fmtDate(ws)} – ${fmtDate(addDays(ws, 6))}`} onClose=${onClose}><div class="stack">
    <p class="small muted">Bấm khu cho từng bạn, áp cho <b>cả tuần</b>. Muốn chia nhỏ thì ghi <b>bàn</b> (vd 1-10, 15, 20-25). Sơ đồ bàn hiện tên người phụ trách từng bàn.</p>
    <p class="small muted">Chỉ <b>Phục vụ</b> chia theo khu. Bếp, Bar, Thu ngân, Tiếp thực phân theo đầu mục công việc (checklist "Ai làm").</p>
    <div class="chips">${zones.map((z) => html`<span class="pill">${z.name}: ${count(z.id)} người</span>`)}</div>
    ${people.map((p) => { const used = [...new Set(shifts.filter((x) => x.staff_id === p.id && x.zone_name).map((x) => x.zone_name.replace(/^Khu\s*/i, '')))]; return html`<div class="zone-row"><span class="grow"><b>${p.name}</b>
      ${zOf(p) ? html`<br /><input class="tables-in" placeholder="Bàn: vd 1-10 (trống = cả khu)" value=${tOf(p)} onChange=${(e) => pick(p, zOf(p), e.target.value)} />` : null}
      ${!cur[p.id] ? html`<br /><small class=${used.length ? 'muted' : 'warn-text'}>${used.length ? `đang: khu ${used.join(', ')} (theo ngày)` : 'chưa có khu'}</small>` : null}${p.role !== 'staff' || p.position_name ? html`<br /><small class=${p.role !== 'staff' ? 'role-tag' : 'muted'}>${p.role !== 'staff' ? `⭐ ${p.role_label}` : ''}${p.role !== 'staff' && p.position_name ? ' · ' : ''}${p.position_name || ''}</small>` : null}</span>
      <div class="chips">${zones.map((z) => html`<button class=${`chip ${zOf(p) === z.id ? 'on' : ''}`} onClick=${() => pick(p, z.id)}>${z.name.replace(/^Khu\s*/i, '')}</button>`)}
        <button class=${`chip ${!cur[p.id] ? 'on' : ''}`} onClick=${() => pick(p, null)}>—</button></div></div>`; })}
    <button class="primary" onClick=${onClose}>Xong</button>
  </div><//>`;
}

// Nhãn sau tên ở Bảng tuần: cấp bậc (Tổ trưởng / Trưởng ca), loại ca (Full ca / Ca gãy / Part-time), vị trí
const ROLE_TAG = { team_lead: '⭐ Tổ trưởng', shift_lead: '⭐ Trưởng ca', manager: 'Quản lý' };
const WORK_TAG = { full: 'Full ca', gay: 'Ca gãy', part: 'Part-time' };
function staffTags(p) {
  const tags = [ROLE_TAG[p.role], WORK_TAG[p.work_type], p.position_name].filter(Boolean);
  return tags.length ? html`<br /><span class="wk-tags">${tags.map((t) => html`<small class=${`wk-tag ${t.startsWith('⭐') ? 'lead' : ''}`}>${t}</small>`)}</span>` : null;
}

export function PlanBoard(props) { return Overview(props); }

function Overview({ me, week, onWeek }) {
  const st = useData(`/api/availability${week ? `?week=${week}` : ''}`);
  const ws = st.data?.week_start;
  const sc = useData(ws ? `/api/schedule?week=${ws}` : null);
  const staffD = useData('/api/staff');
  const zonesAll = useData('/api/zones');
  const [team, setTeam] = useState('');
  const [add, setAdd] = useState(null);
  const [covDay, setCovDay] = useState(null);
  const [zoning, setZoning] = useState(false);
  if (!st.data || !sc.data || !staffD.data) return html`<${Loading} state=${!st.data ? st : !sc.data ? sc : staffD} />`;
  const d = st.data;
  const teams = d.teams.filter((t) => staffD.data.some((p) => p.team_id === t.id));
  const inTeam = (x) => !team || x.team_id === Number(team);
  const shifts = sc.data.shifts.filter((x) => x.leave?.status !== 'approved');
  const missing = d.people.filter((p) => inTeam(p) && !p.submitted_at);
  const published = sc.data.published_at;
  const canManage = atLeast(me, 'manager') || (me.pages || []).includes('/lich#xep');
  const has = new Set(shifts.map((x) => `${x.staff_id}:${x.date}`));
  const cov = covDay && d.days.includes(covDay) ? covDay : d.days.includes(me.today) ? me.today : d.days[0];
  const freeCells = Object.entries(d.hours || {}).filter(([k, v]) => v.length && !has.has(k)).length;
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row">
        <button class="icon" aria-label="Tuần trước" onClick=${() => onWeek(addDays(d.week_start, -7))}>‹</button>
        <b>Tuần ${fmtDate(d.week_start)} – ${fmtDate(addDays(d.week_start, 6))}</b>
        <button class="icon" aria-label="Tuần sau" onClick=${() => onWeek(addDays(d.week_start, 7))}>›</button>
      </div>
      ${published ? html`<span class="pill ok">Đã duyệt ${dt(published)}</span>` : html`<span class="pill warn">Chưa duyệt</span>`}
    </div>
    ${canManage ? html`<section class="card stack plan-actions">
      <small>Nhân viên báo lịch xong là <b>tự thành ca</b> (ô đậm). Bấm ô đậm để sửa giờ / bỏ, bấm ô trống để thêm ca, xong bấm <b>Duyệt</b>.</small>
      <div class="row wrap">
        <button onClick=${() => setZoning(true)}>📍 Phân khu tuần này</button>
        <button class="primary" disabled=${!shifts.length} onClick=${() => act(() => api('POST', '/api/schedule/publish', { week: d.week_start }), 'Đã duyệt: gửi chủ xem + gửi lịch cho nhân viên')}>✅ ${published ? 'Duyệt lại' : 'Duyệt lịch tuần'} (${shifts.length} ca)</button>
      </div>
    </section>` : null}
    <section class="stack">
      <div class="chips scroll-x">${d.days.map((x) => html`<button class=${`chip ${x === cov ? 'on' : ''}`} onClick=${() => setCovDay(x)}>${dayLabel(x).split(' ')[0]} ${fmtDate(x)}</button>`)}</div>
      <${HourCoverage} key=${cov} shifts=${shifts} day=${cov} prevDay=${addDays(cov, -1)} teams=${d.teams} zones=${(zonesAll.data || []).filter((z) => z.active !== false && z.active !== 0)} />
    </section>
    <div class="row between wrap"><div class="chips"><button class=${`chip ${!team ? 'on' : ''}`} onClick=${() => setTeam('')}>Cả quán</button>
      ${teams.map((t) => html`<button class=${`chip ${team === String(t.id) ? 'on' : ''}`} onClick=${() => setTeam(String(t.id))}>${t.name}</button>`)}</div>
      <a class="btn small" href=${`/api/schedule.xlsx?week=${d.week_start}`} download>⬇ Tải Excel</a></div>
    <${WeekTable} d=${d} shifts=${shifts} staff=${staffD.data} team=${team} canManage=${canManage} onAdd=${(p, x, range) => setAdd({ p, range, date: x })} />
    <details class="card"><summary><b>Chưa báo lịch rảnh (${missing.length})</b> <small class="muted">hạn ${WEEKDAY[dowOf(d.deadline.date)]} ${fmtDate(d.deadline.date)} ${d.deadline.time}</small></summary>
      <div class="stack">${missing.length ? html`<div class="chips">${missing.map((p) => html`<span class="chip">${p.name}</span>`)}</div>` : html`<p class="muted">Mọi người đã báo.</p>`}
      ${missing.length && canManage ? html`<button onClick=${() => act(() => api('POST', '/api/availability/remind', { week: d.week_start })).then((r) => r && toast(r.group ? 'Đã nhắc trong app + nhóm Zalo' : r.group_error ? `Đã nhắc trong app. Nhóm Zalo lỗi: ${r.group_error}` : 'Đã nhắc trong app (chưa chọn nhóm Zalo nhân viên)'))}>🔔 Nhắc tất cả</button>` : null}</div>
    </details>
    ${zoning ? html`<${WeekZones} ws=${d.week_start} staff=${staffD.data} teams=${d.teams} map=${sc.data.week_zones} shifts=${shifts} onClose=${() => setZoning(false)} />` : null}
    ${add ? html`<${AddShift} p=${add.p} date=${add.date} range=${add.range} onClose=${() => setAdd(null)} />` : null}
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
