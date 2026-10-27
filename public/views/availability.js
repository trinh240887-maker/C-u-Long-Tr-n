import { useState, useEffect } from '../vendor/hooks.js';
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
// 2 lịch riêng (chủ quán 27/10): 🔒 Ca full cố định (Full ca hoặc có khu cố định, xếp theo khu) · ⏱ Part-time (còn lại, xếp theo giờ vào)
export const isFixedStaff = (p) => p.work_type === 'full';
const minOf = (t) => { const [h, m] = String(t || '99:99').split(':').map(Number); return h * 60 + (m || 0); };
function firstStart(p, days, shifts, hours) {
  let best = 9999;
  for (const x of days) {
    for (const s of shifts) if (s.staff_id === p.id && s.date === x) best = Math.min(best, ...s.segments.map((g) => minOf(g.start)));
    for (const r of hours[`${p.id}:${x}`] || []) best = Math.min(best, minOf(r.split('-')[0]));
  }
  return best;
}
// Bấm tên ở 2 lịch riêng: đưa vào / bỏ khỏi lịch cố định, chọn khu cố định
function FixStaff({ p, zones, teams = [], onClose }) {
  const save = (body, msg) => act(() => api('PATCH', `/api/staff/${p.id}`, body), msg).then((r) => r && onClose());
  const full = p.work_type === 'full';
  return html`<${Modal} title=${p.name} onClose=${onClose}><div class="stack">
    <b>1. Ca làm</b>
    <div class="row wrap"><button class=${`big ${full ? 'primary' : ''}`} onClick=${() => !full && save({ work_type: 'full' }, `${p.name}: Full ca 14–23`)}>Full ca 14–23</button>
      <button class=${`big ${!full ? 'primary' : ''}`} onClick=${() => full && save({ work_type: 'gay' }, `${p.name}: Ca gãy`)}>Ca gãy</button></div>
    <b>2. Khu</b>
    <div class="row wrap">${zones.map((z) => html`<button class=${`big ${p.home_zone_id === z.id ? 'primary' : ''}`} onClick=${() => save({ home_zone_id: z.id }, `${p.name}: ${z.name}`)}>${z.name}</button>`)}
      <button class=${`big ${!p.home_zone_id ? 'primary' : ''}`} onClick=${() => p.home_zone_id && save({ home_zone_id: null }, `${p.name}: không cố định khu`)}>Không cố định</button></div>
    <details><summary class="small muted">Đổi bộ phận</summary><div class="chips">${teams.map((t) => html`<button class=${`chip ${p.team_id === t.id ? 'on' : ''}`} onClick=${() => p.team_id !== t.id && save({ team_id: t.id, position_id: null }, `Đã chuyển ${p.name} sang ${t.name}`)}>${t.name}</button>`)}</div></details>
  </div><//>`;
}

function WeekTable({ d, shifts, staff, team, canManage, onAdd, onTake, kind = '' }) {
  const [fix, setFix] = useState(null);
  const [cell, setCell] = useState(null);
  const zonesD = useData('/api/zones');
  const zones = (zonesD.data || []).filter((z) => z.active !== false && z.active !== 0);
  const zShort = (n) => (n || '').replace(/^Khu\s*/i, '');
  // Giao khu cho ca: lưu lại ca với khu mới (giữ giờ)
  const setZone = (x, zoneId) => act(() => api('POST', '/api/shifts', { staff_id: x.staff_id, date: x.date, team_id: x.team_id || undefined, label: x.label || 'Ca', template_id: x.template_id || undefined,
    segments: x.segments.map((sg) => ({ start: sg.start, end: sg.end })), zone_id: zoneId || undefined, replace_group_id: x.group_id }), zoneId ? 'Đã giao khu' : 'Đã bỏ khu').then((r) => r && setCell(null));
  const [edit, setEdit] = useState(null);
  const people = staff.filter((p) => p.active !== false && p.role !== 'owner' && (!team || p.team_id === Number(team))
    && (!kind || (kind === 'full') === isFixedStaff(p)));
  const zName = (id) => zones.find((z) => z.id === id)?.name || '';
  const hours = d.hours || {};
  const order = (list) => {
    if (kind === 'full') return [...list].sort((a, b) => (zName(a.home_zone_id) || '~').localeCompare(zName(b.home_zone_id) || '~', 'vi') || a.name.localeCompare(b.name, 'vi'));
    if (kind === 'part') { const k = new Map(list.map((p) => [p.id, firstStart(p, d.days, shifts, hours)])); return [...list].sort((a, b) => k.get(a.id) - k.get(b.id) || a.name.localeCompare(b.name, 'vi')); }
    return list;
  };
  const groups = [...d.teams.map((t) => ({ id: t.id, name: t.name })), { id: null, name: 'Chưa có bộ phận' }]
    .map((g) => ({ ...g, people: order(people.filter((p) => (g.id ? p.team_id === g.id : !d.teams.some((t) => t.id === p.team_id)))) })).filter((g) => g.people.length);
  // Lịch cố định: chèn dòng tiêu đề khu (📍 Khu A · 5 người)
  const zoneHead = (g, i) => {
    if (kind !== 'full') return null;
    const p = g.people[i], prev = g.people[i - 1];
    if (prev && (prev.home_zone_id || null) === (p.home_zone_id || null)) return null;
    const n = g.people.filter((x) => (x.home_zone_id || null) === (p.home_zone_id || null)).length;
    return html`<tr class="wk-sub"><td colspan=${d.days.length + 1}>${p.home_zone_id ? `📍 ${zName(p.home_zone_id) || 'Khu'}` : '📍 Chưa chọn khu'} · ${n} người</td></tr>`;
  };
  const shiftOf = (pid, date) => shifts.filter((x) => x.staff_id === pid && x.date === date);
  const text = (x) => x.segments.map((sg) => short(`${sg.start}–${sg.end === '00:00' ? '24' : sg.end}`)).join(', ');
  return html`<div class="stack">
    <p class="small muted"><span class="lg has">6–14</span> đã xếp (bấm để sửa / bỏ) · <span class="lg free">16–23</span> rảnh (bấm để xếp) · ô trống: bận / chưa báo</p>
    ${groups.map((g) => html`<section class="card wk-card">
      <div class="wk-head">${g.name.toUpperCase()} <small>${g.people.length} người</small>
        ${canManage && g.id ? html`<button class="small wk-ok" onClick=${() => confirm(`Duyệt lịch ${g.name} tuần này?\nNgày chưa có ca mà có lịch rảnh sẽ được xếp ca theo lịch rảnh, báo từng người và bot gửi bảng lịch vào nhóm Zalo của ${g.name}.`)
          && publishTeam(d.week_start, g)}>✅ Duyệt ${g.name}</button>` : null}</div>
      <div class="wk-wrap"><table class="wk">
        <thead><tr><th class="wk-name">Tên</th>${d.days.map((x) => html`<th>${dayLabel(x).split(' ')[0]}<br /><small>${x.slice(8)}/${x.slice(5, 7)}</small><br /><b class="wk-n">${g.people.filter((p) => shiftOf(p.id, x).length).length}</b></th>`)}</tr></thead>
        <tbody>${g.people.map((p, i) => { return html`${zoneHead(g, i)}<tr><td class=${`wk-name ${canManage ? 'tap' : ''}`} onClick=${() => canManage && setFix(p)}><b>${p.name}</b>${canManage ? html` <small class="muted">✎</small>` : null}${staffTags(p, !!kind)}
</td>
          ${d.days.map((x) => {
            const sh = shiftOf(p.id, x);
            const fr = d.hours?.[`${p.id}:${x}`] || [];
            if (sh.length) return html`<td class="has" onClick=${() => canManage && setCell({ p, x, sh })}>${sh.map(text).join(' ')}${sh.some((m) => m.zone_name && !(kind === 'full' && m.zone_id === p.home_zone_id)) ? html`<br /><b class="zone-badge">📍${sh.map((m) => zShort(m.zone_name)).filter(Boolean).join(',')}</b>` : null}</td>`;
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
    ${!groups.length ? html`<p class="muted">${kind === 'full' ? 'Chưa có ai Full ca. Bấm Tất cả, rồi bấm tên người để chọn Full ca 14–23.' : 'Không có ai.'}</p>` : null}
    ${edit ? html`<${AddShift} p=${edit.p} date=${edit.date} range=${edit.range} replaceId=${edit.id} onClose=${() => setEdit(null)} />` : null}
    ${fix ? html`<${FixStaff} p=${fix} zones=${zones} teams=${d.teams} onClose=${() => setFix(null)} />` : null}
  </div>`;
}

// Phân khu theo tuần: danh sách nhân viên, bấm khu 1 lần cho cả tuần (chủ quán 24/10)
function WeekZones({ ws, staff, teams, map, shifts = [], hours = {}, onClose }) {
  const zonesD = useData('/api/zones');
  const zones = (zonesD.data || []).filter((z) => z.active !== false && z.active !== 0);
  const pv = teams.find((t) => /phục vụ/i.test(t.name));
  const team = pv ? String(pv.id) : ''; // chỉ Phục vụ chia khu (chủ quán 24/10)
  const [cur, setCur] = useState(map || {});
  const RANK = ['manager', 'shift_lead', 'team_lead', 'staff'];
  // Trưởng ca, tổ trưởng lên đầu danh sách
  // Phục vụ + người chưa có bộ phận + ai có ca Phục vụ trong tuần (tránh sót người, chủ quán 27/10)
  const pvShift = new Set(shifts.filter((x) => pv && x.team_id === pv.id).map((x) => x.staff_id));
  const people = staff.filter((p) => p.active !== false && p.role !== 'owner'
    && (!team || p.team_id === Number(team) || !teams.some((t) => t.id === p.team_id) || pvShift.has(p.id)))
    .sort((a, b) => RANK.indexOf(a.role) - RANK.indexOf(b.role));
  const zOf = (p) => { const v0 = cur[p.id]; return v0 && typeof v0 === 'object' ? Number(v0.z) : Number(v0) || null; };
  const tOf = (p) => { const v0 = cur[p.id]; return v0 && typeof v0 === 'object' ? v0.t || '' : ''; };
  const pick = (p, zid, tables = '') => act(() => api('POST', '/api/schedule/week-zones', { week: ws, staff_id: p.id, zone_id: zid || undefined, tables_text: tables })).then((r) => r && setCur(r.week_zones));
  const count = (zid) => people.filter((p) => zOf(p) === zid).length;
  // 1 bạn phục vụ bao nhiêu bàn (chủ quán 25/10: vd 6) → mỗi khu cần = số bàn ÷ số bàn mỗi bạn, làm tròn lên
  const [per, setPer] = useState(() => { try { return Number(localStorage.getItem('tables-per-waiter')) || 6; } catch { return 6; } });
  const setPer2 = (n) => { setPer(n); try { localStorage.setItem('tables-per-waiter', String(n)); } catch {} };
  const need = (z) => Math.max(1, Math.ceil((z.table_count || 0) / per));
  return html`<${Modal} title=${`📍 Phân khu tuần ${fmtDate(ws)} – ${fmtDate(addDays(ws, 6))}`} onClose=${onClose}><div class="stack">
    <p class="small muted">Bấm khu cho từng bạn, áp cho <b>cả tuần</b>. Muốn chia nhỏ thì ghi <b>bàn</b> (vd 1-10, 15, 20-25). Sơ đồ bàn hiện tên người phụ trách từng bàn.</p>
    <p class="small muted">Chỉ <b>Phục vụ</b> chia theo khu. Bếp, Bar, Thu ngân, Tiếp thực phân theo đầu mục công việc (checklist "Ai làm").</p>
    <label class="small row">1 bạn phục vụ <input class="num-in" type="number" min="1" max="30" value=${per} onInput=${(e) => setPer2(Number(e.target.value) || 1)} /> bàn</label>
    <div class="chips">${zones.map((z) => { const n = count(z.id), k = need(z); return html`<span class=${`pill ${n < k ? 'bad' : n > k ? 'warn' : 'ok'}`}>${z.name}: ${z.table_count || 0} bàn → cần <b>${k}</b> · đã phân ${n}${n < k ? ` (thiếu ${k - n})` : n > k ? ` (dư ${n - k})` : ' ✓'}</span>`; })}
      <span class="pill">Cả quán cần <b>${zones.reduce((a, z) => a + need(z), 0)}</b> người/ngày</span></div>
    <${ZoneCoverage} ws=${ws} zones=${zones} people=${people} shifts=${shifts} hours=${hours} zOf=${zOf} per=${per} />
    ${people.map((p) => { const used = [...new Set(shifts.filter((x) => x.staff_id === p.id && x.zone_name).map((x) => x.zone_name.replace(/^Khu\s*/i, '')))]; return html`<div class="zone-row"><span class="grow"><b>${p.name}</b>
      ${zOf(p) ? html`<br /><input class="tables-in" placeholder="Bàn: vd 1-10 (trống = cả khu)" value=${tOf(p)} onChange=${(e) => pick(p, zOf(p), e.target.value)} />` : null}
      <br /><small class="muted">🗓 ${workDays(p.id, ws, shifts, hours)}</small>${team && p.team_id !== Number(team) ? html`<br /><small class="warn-text">${teams.find((t) => t.id === p.team_id)?.name || 'Chưa có bộ phận'}: bấm tên ở bảng tuần để chuyển sang Phục vụ</small>` : null}
      ${!cur[p.id] ? html`<br /><small class=${used.length ? 'muted' : 'warn-text'}>${used.length ? `đang: khu ${used.join(', ')} (theo ngày)` : 'chưa có khu'}</small>` : null}${p.role !== 'staff' || p.position_name ? html`<br /><small class=${p.role !== 'staff' ? 'role-tag' : 'muted'}>${p.role !== 'staff' ? `⭐ ${p.role_label}` : ''}${p.role !== 'staff' && p.position_name ? ' · ' : ''}${p.position_name || ''}</small>` : null}</span>
      <div class="chips">${zones.map((z) => html`<button class=${`chip ${zOf(p) === z.id ? 'on' : ''}`} onClick=${() => pick(p, z.id)}>${z.name.replace(/^Khu\s*/i, '')}</button>`)}
        <button class=${`chip ${!cur[p.id] ? 'on' : ''}`} onClick=${() => pick(p, null)}>—</button></div></div>`; })}
    <button class="primary" onClick=${onClose}>Xong</button>
  </div><//>`;
}

// Ngày đi làm của 1 người trong tuần: theo ca đã xếp, chưa có ca thì theo lịch rảnh
const DOWS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
function onDay(pid, date, shifts, hours) {
  const sh = shifts.filter((x) => x.staff_id === pid && x.date === date);
  if (sh.length) return { on: true, shift: sh[0], zone: sh.find((x) => x.zone_name)?.zone_id || null };
  return { on: (hours[`${pid}:${date}`] || []).length > 0, shift: null, zone: null };
}
function workDays(pid, ws, shifts, hours) {
  const on = DOWS.map((_, i) => onDay(pid, addDays(ws, i), shifts, hours).on);
  if (on.every(Boolean)) return 'làm cả tuần';
  if (!on.some(Boolean)) return 'chưa có lịch tuần này';
  return `làm ${DOWS.filter((_, i) => on[i]).join(', ')} · nghỉ ${DOWS.filter((_, i) => !on[i]).join(', ')}`;
}
// Bảng khu × ngày: mỗi ngày mỗi khu có mấy người đi làm; thiếu thì đỏ, bấm để giao khu riêng ngày đó
function ZoneCoverage({ ws, zones, people, shifts, hours, zOf, per }) {
  const need = (z) => Math.max(1, Math.ceil((z.table_count || 0) / per));
  const [open, setOpen] = useState(null);
  const days = DOWS.map((_, i) => addDays(ws, i));
  const zoneOn = (p, date) => { const o = onDay(p.id, date, shifts, hours); return o.on ? (o.zone || zOf(p)) : null; };
  const who = (zid, date) => people.filter((p) => zoneOn(p, date) === zid);
  const giveDay = (p, date, z) => {
    const x = onDay(p.id, date, shifts, hours).shift;
    if (!x) return toast(`${p.name} chưa có ca ngày này (chỉ có lịch rảnh). Bấm ✅ Duyệt Phục vụ để tạo ca trước.`, true);
    return act(() => api('POST', '/api/shifts', { staff_id: p.id, date, team_id: x.team_id || undefined, label: x.label || 'Ca', template_id: x.template_id || undefined,
      segments: x.segments.map((sg) => ({ start: sg.start, end: sg.end })), zone_id: z.id, replace_group_id: x.group_id }), `Đã giao ${p.name} vào ${z.name} ngày ${date.slice(8)}/${date.slice(5, 7)}`);
  };
  if (!zones.length) return null;
  const cellOpen = open && zones.find((z) => z.id === open.z);
  return html`<div class="stack tight">
    <b>Mỗi ngày mỗi khu có mấy người</b>
    <div class="wk-wrap"><table class="zcov"><thead><tr><th></th>${days.map((d, i) => html`<th>${DOWS[i]}<br /><small>${d.slice(8)}/${d.slice(5, 7)}</small></th>`)}</tr></thead>
      <tbody>${zones.map((z) => html`<tr><th>${z.name.replace(/^Khu\s*/i, 'Khu ')}<br /><small class="muted">${z.table_count || 0} bàn · cần ${need(z)}</small></th>${days.map((d) => { const n = who(z.id, d).length; return html`<td class=${n < need(z) ? 'short' : 'ok'} onClick=${() => setOpen({ z: z.id, d })}>${n}</td>`; })}</tr>`)}
        <tr><th class="muted">Chưa khu</th>${days.map((d) => html`<td class="muted">${people.filter((p) => onDay(p.id, d, shifts, hours).on && !zoneOn(p, d)).length || ''}</td>`)}</tr></tbody></table></div>
    <small class="muted">Số trong ô = số bạn đi làm ở khu đó. Đỏ = ít hơn số cần. Muốn chuyển người riêng 1 ngày: bấm ô của khu CẦN THÊM người, rồi bấm tên bạn ở khu đang dư.</small>
    ${cellOpen ? html`<div class="card tight stack">
      <b>${cellOpen.name} · ${DOWS[days.indexOf(open.d)]} ${open.d.slice(8)}/${open.d.slice(5, 7)} (có ${who(cellOpen.id, open.d).length}/cần ${need(cellOpen)}): ${who(cellOpen.id, open.d).map((p) => p.name).join(', ') || 'chưa có ai'}</b>
      <span class="small">Người làm ngày này ở khu khác / chưa khu (bấm để chuyển vào ${cellOpen.name} riêng ngày này):</span>
      <div class="row wrap">${people.filter((p) => onDay(p.id, open.d, shifts, hours).on && zoneOn(p, open.d) !== cellOpen.id).map((p) => { const zz = zones.find((z) => z.id === zoneOn(p, open.d)); return html`<button class="chip" onClick=${() => giveDay(p, open.d, cellOpen)}>${p.name}${zz ? ` (${zz.name.replace(/^Khu\s*/i, '')})` : ' (chưa khu)'}</button>`; })}</div>
      <${SplitTables} zone=${cellOpen} date=${open.d} people=${who(cellOpen.id, open.d)} shifts=${shifts} hours=${hours} />
      <button class="small" onClick=${() => setOpen(null)}>Đóng</button></div>` : null}
  </div>`;
}

// "1,2,3,5,7,8" → "1-3, 5, 7-8"
const tableText = (nums) => {
  const out = [];
  for (let i = 0; i < nums.length; i++) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++; out.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`); i = j; }
  return out.join(', ');
};
// Gợi ý chia đều bàn của khu cho các bạn làm ngày đó (bàn liền nhau), bấm áp → ghi bàn vào ca từng bạn ngày đó
function SplitTables({ zone, date, people, shifts, hours }) {
  const nums = (zone.tables || []).map((t) => t.number).sort((a, b) => a - b);
  if (!nums.length) return html`<small class="muted">${zone.name} chưa có danh sách bàn (Cài đặt → Khu & bàn).</small>`;
  if (!people.length) return html`<small class="muted">${zone.name} có ${nums.length} bàn (${tableText(nums)}), chưa ai làm ngày này.</small>`;
  const k = people.length, base = Math.floor(nums.length / k), extra = nums.length % k;
  let at = 0;
  const plan = people.map((p, i) => { const n = base + (i < extra ? 1 : 0); const part = nums.slice(at, at + n); at += n; return { p, part }; });
  const apply = async () => {
    for (const { p, part } of plan) {
      const x = onDay(p.id, date, shifts, hours).shift;
      if (!x) continue;
      await api('POST', '/api/shifts', { staff_id: p.id, date, team_id: x.team_id || undefined, label: x.label || 'Ca', template_id: x.template_id || undefined,
        segments: x.segments.map((sg) => ({ start: sg.start, end: sg.end })), zone_id: zone.id, tables_text: tableText(part), replace_group_id: x.group_id });
    }
  };
  return html`<div class="stack tight">
    <span class="small"><b>${zone.name}: ${nums.length} bàn</b> (${tableText(nums)}) · ${k} bạn → mỗi bạn ~${Math.ceil(nums.length / k)} bàn</span>
    ${plan.map(({ p, part }) => html`<small>• ${p.name}: bàn ${tableText(part) || '—'} (${part.length})</small>`)}
    <button class="small" onClick=${() => act(apply, 'Đã chia bàn cho ngày này')}>Áp chia bàn này cho ngày này</button>
  </div>`;
}

// Duyệt lịch 1 bộ phận: máy chủ xếp ca theo lịch rảnh + báo từng người → máy này vẽ ảnh bảng → bot gửi ảnh vào nhóm Zalo
async function publishTeam(week, g) {
  const r = await act(() => api('POST', '/api/schedule/publish-team', { week, team_id: g.id, image: true }));
  if (!r) return;
  let data = '';
  try { data = drawScheduleImage(r.table); } catch { /* máy không vẽ được → gửi chữ */ }
  const s = await act(() => api('POST', '/api/schedule/team-image', { team_id: g.id, data, text: r.text }));
  toast(`Đã duyệt ${g.name}: ${r.sent} người có ca${r.made ? `, xếp thêm ${r.made} ca` : ''}${s?.groups ? (s.photo ? ', đã gửi ảnh lịch vào nhóm Zalo' : ', đã gửi nhóm Zalo (dạng chữ)') : s?.group_error ? `. Nhóm Zalo lỗi: ${s.group_error}` : '. Chưa có nhóm Zalo nào chọn bộ phận này'}`);
}

// Vẽ bảng lịch giống màn Bảng tuần thành ảnh PNG (canvas của trình duyệt có sẵn font tiếng Việt)
function drawScheduleImage(t) {
  const W0 = 230, CW = 128, HH = 64, TH = 70, PAD = 16;
  const RH = t.rows.some((r) => r.cells.some((x) => x.includes(' · ') && x.includes(' + '))) ? 72 : 58;
  const raw = t.rows.length ? t.rows : [{ name: '(chưa có ai có ca)', tags: [], cells: Array(7).fill('') }];
  // Xếp theo khu: chèn dòng tiêu đề "KHU A · 6 người" trước mỗi khu
  const rows = [];
  if (t.grouped) {
    let last = null;
    for (const r of raw) {
      const key = r.cells.some(Boolean) ? (r.zone || 'CHƯA PHÂN KHU') : 'KHÔNG CÓ CA TUẦN NÀY';
      if (key !== last) { rows.push({ header: key, n: raw.filter((x) => (x.cells.some(Boolean) ? (x.zone || 'CHƯA PHÂN KHU') : 'KHÔNG CÓ CA TUẦN NÀY') === key).length }); last = key; }
      rows.push(r);
    }
  } else rows.push(...raw);
  const GH = 40;
  const W = PAD * 2 + W0 + CW * 7, H = PAD * 2 + TH + HH + rows.reduce((a, r) => a + (r.header ? GH : RH), 0) + 30;
  const scale = 2;
  const cv = document.createElement('canvas');
  cv.width = W * scale; cv.height = H * scale;
  const c = cv.getContext('2d');
  c.scale(scale, scale);
  const F = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
  // Tiêu đề
  c.fillStyle = '#4caf50'; c.fillRect(PAD, PAD, W - PAD * 2, TH);
  c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.textAlign = 'center';
  c.font = `700 26px ${F}`; c.fillText(`${t.title}  ·  tuần ${t.week}`, W / 2, PAD + TH / 2);
  // Hàng ngày
  let y = PAD + TH;
  c.fillStyle = '#fff59d'; c.fillRect(PAD, y, W - PAD * 2, HH);
  c.fillStyle = '#333'; c.textAlign = 'left'; c.font = `600 18px ${F}`; c.fillText('Tên', PAD + 12, y + HH / 2);
  c.textAlign = 'center';
  t.days.forEach((d, i) => {
    const x = PAD + W0 + CW * i + CW / 2;
    c.font = `700 19px ${F}`; c.fillText(d.dow, x, y + 22);
    c.font = `15px ${F}`; c.fillText(d.date, x, y + 44);
  });
  y += HH;
  // Từng người
  const ZC = ['#1565c0', '#6a1b9a', '#00838f', '#ef6c00', '#2e7d32', '#ad1457'];
  let zi = -1;
  rows.forEach((r, k) => {
    if (r.header) {
      zi++;
      c.fillStyle = r.header.startsWith('KHU') ? ZC[zi % ZC.length] : '#9e9e9e'; c.fillRect(PAD, y, W - PAD * 2, GH);
      c.fillStyle = '#fff'; c.textAlign = 'left'; c.font = `800 19px ${F}`; c.fillText(`📍 ${r.header}  ·  ${r.n} người`, PAD + 12, y + GH / 2);
      y += GH;
      return;
    }
    c.fillStyle = k % 2 ? '#fafafa' : '#fff'; c.fillRect(PAD, y, W - PAD * 2, RH);
    c.textAlign = 'left'; c.fillStyle = '#222'; c.font = `700 17px ${F}`;
    c.fillText(r.name.length > 22 ? `${r.name.slice(0, 21)}…` : r.name, PAD + 12, y + (r.tags.length ? 21 : RH / 2));
    if (r.tags.length) { c.fillStyle = '#8a4b00'; c.font = `13px ${F}`; c.fillText(r.tags.join(' · ').slice(0, 30), PAD + 12, y + 42); }
    r.cells.forEach((txt, i) => {
      const x = PAD + W0 + CW * i;
      if (txt) { c.fillStyle = '#fde3d3'; c.fillRect(x + 2, y + 2, CW - 4, RH - 4); }
      c.fillStyle = '#b23c17'; c.textAlign = 'center'; c.font = `700 16px ${F}`;
      // "8–12 + 14–23 · A 1-10" → dòng giờ + dòng khu
      const [hrs, zone] = txt.split(' · ');
      const parts = hrs.split(' + ');
      const lines = parts.length > 1 ? [parts[0], parts.slice(1).join(' + ')] : [hrs];
      if (zone) lines.push(`📍${zone}`);
      const top = y + RH / 2 - ((lines.length - 1) * 19) / 2;
      lines.forEach((ln, j) => { c.font = ln.startsWith('📍') ? `600 14px ${F}` : `700 16px ${F}`; c.fillStyle = ln.startsWith('📍') ? '#1d4ed8' : '#b23c17'; c.fillText(ln, x + CW / 2, top + j * 19); });
    });
    c.strokeStyle = '#e8e2d8'; c.lineWidth = 1; c.beginPath(); c.moveTo(PAD, y + RH); c.lineTo(W - PAD, y + RH); c.stroke();
    for (let i = 0; i <= 7; i++) { const x = PAD + W0 + CW * i; c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + RH); c.stroke(); }
    y += RH;
  });
  // Đường dọc

  c.fillStyle = '#888'; c.textAlign = 'right'; c.font = `13px ${F}`; c.fillText('Ô tô màu = có ca · ô trống = nghỉ', W - PAD, y + 16);
  return cv.toDataURL('image/png');
}

// Nhãn sau tên ở Bảng tuần: cấp bậc (Tổ trưởng / Trưởng ca), loại ca (Full ca / Ca gãy / Part-time), vị trí
const ROLE_TAG = { team_lead: '⭐ Tổ trưởng', shift_lead: '⭐ Trưởng ca', manager: 'Quản lý' };
const WORK_TAG = { full: 'Full ca', gay: 'Ca gãy', part: 'Part-time' };
function staffTags(p, noWork = false) {
  const tags = [ROLE_TAG[p.role], noWork ? null : WORK_TAG[p.work_type], p.position_name].filter(Boolean);
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
  const [kind, setKind0] = useState(() => { try { return localStorage.getItem('wk-kind') || ''; } catch { return ''; } });
  const setKind = (k) => { setKind0(k); try { localStorage.setItem('wk-kind', k); } catch {} };
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
    ${(() => { const ok = (p) => p.active !== false && p.role !== 'owner' && (!team || p.team_id === Number(team)); const all = staffD.data.filter(ok), nf = all.filter(isFixedStaff).length;
      return html`<div class="chips"><button class=${`chip ${!kind ? 'on' : ''}`} onClick=${() => setKind('')}>Tất cả (${all.length})</button>
        <button class=${`chip ${kind === 'full' ? 'on' : ''}`} onClick=${() => setKind('full')}>Full ca 14–23 (${nf})</button>
        <button class=${`chip ${kind === 'part' ? 'on' : ''}`} onClick=${() => setKind('part')}>Ca gãy (${all.length - nf})</button></div>
        ${canManage ? html`<p class="small muted">Bấm <b>tên</b> để chọn Full ca / Ca gãy và khu.</p>` : null}`; })()}
    <${WeekTable} d=${d} shifts=${shifts} staff=${staffD.data} team=${team} kind=${kind} canManage=${canManage} onAdd=${(p, x, range) => setAdd({ p, range, date: x })} />
    <details class="card"><summary><b>Chưa báo lịch rảnh (${missing.length})</b> <small class="muted">hạn ${WEEKDAY[dowOf(d.deadline.date)]} ${fmtDate(d.deadline.date)} ${d.deadline.time}</small></summary>
      <div class="stack">${missing.length ? html`<div class="chips">${missing.map((p) => html`<span class="chip">${p.name}</span>`)}</div>` : html`<p class="muted">Mọi người đã báo.</p>`}
      ${missing.length && canManage ? html`<button onClick=${() => act(() => api('POST', '/api/availability/remind', { week: d.week_start })).then((r) => r && toast(r.group ? 'Đã nhắc trong app + nhóm Zalo' : r.group_error ? `Đã nhắc trong app. Nhóm Zalo lỗi: ${r.group_error}` : 'Đã nhắc trong app (chưa chọn nhóm Zalo nhân viên)'))}>🔔 Nhắc tất cả</button>` : null}</div>
    </details>
    ${zoning ? html`<${WeekZones} ws=${d.week_start} staff=${staffD.data} teams=${d.teams} map=${sc.data.week_zones} shifts=${shifts} hours=${d.hours || {}} onClose=${() => setZoning(false)} />` : null}
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
