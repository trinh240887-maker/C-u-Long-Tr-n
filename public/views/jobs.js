// Việc ca: mỗi việc 1 thẻ, người được giao bấm Nhận → Xong (+ảnh); tổ trưởng khu kiểm Đạt / Làm lại (chủ quán 25/10)
import { useState, useEffect } from 'preact/hooks';
import { html, api, act, useData, Loading, hm, navigate, addDays } from '../ui.js';
import { compressImage } from './checklists.js';

const ST = { todo: ['Chưa nhận', ''], doing: ['Đang làm', 'warn'], done: ['Chờ kiểm', 'warn'], ok: ['Đạt', 'ok'], redo: ['Làm lại', 'bad'] };
const hmMin = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, []);
  return now;
}
async function pick(e) { const f = e.target.files?.[0]; e.target.value = ''; return f ? compressImage(f) : null; }

function Countdown({ due, now }) {
  if (!due) return null;
  const left = Math.round((due - now) / 60000);
  return left >= 0 ? html`<b class=${left <= 3 ? 'warn-text' : ''}>⏱ còn ${left} phút</b>` : html`<b class="warn-text">⏰ quá ${-left} phút</b>`;
}

function JobCard({ j, now, mine }) {
  const [busy, setBusy] = useState(false);
  const done = async (e) => {
    const data = e ? await pick(e) : null;
    if (e && !data) return;
    setBusy(true);
    try { await act(() => api('POST', `/api/jobs/${j.id}/done`, data ? { data } : {}), 'Đã báo xong').then((r) => r?.late && alert('Việc này trễ so với thời gian chuẩn, đã ghi lại.')); } finally { setBusy(false); }
  };
  const [label, cls] = ST[j.status];
  return html`<div class=${`card tight stack job ${j.overdue ? 'bad' : ''}`}>
    <div class="row"><b class="grow">${j.title}${j.qty ? html` · <span class="muted">${j.qty}</span>` : ''}</b><span class=${`pill ${cls}`}>${j.redo_count && j.status === 'doing' ? 'Làm lại' : label}</span></div>
    <small class="muted">${j.zone_name || ''}${j.minutes ? ` · chuẩn ${j.minutes} phút` : ''}${j.template_title ? ` · ${j.template_title}` : ''}${j.claimed_at ? ` · nhận ${hm(j.claimed_at)}` : ''}${j.done_at ? ` · xong ${hm(j.done_at)} (${j.minutes_used}′)` : ''}</small>
    ${j.fetch_where ? html`<small>📦 Hết thì lấy ở: <b>${j.fetch_where}</b></small>` : null}
    ${j.check_note && j.status === 'doing' ? html`<small class="warn-text">↩ ${j.checked_by_name}: ${j.check_note}</small>` : null}
    ${mine && j.status === 'doing' ? html`<div class="row"><${Countdown} due=${j.due_at} now=${now} /></div>` : null}
    ${mine ? html`<div class="row wrap">
      ${j.status === 'todo' ? html`<button class="primary big grow" onClick=${() => act(() => api('POST', `/api/jobs/${j.id}/claim`), 'Đã nhận, bắt đầu tính giờ')}>✋ Nhận việc</button>` : null}
      ${j.status === 'doing' ? (j.photo_required
        ? html`<label class=${`button primary big grow ${busy ? 'muted' : ''}`}>📷 ${busy ? 'Đang gửi…' : 'Chụp ảnh & báo xong'}<input type="file" accept="image/*" capture="environment" hidden onChange=${done} /></label>`
        : html`<button class="primary big grow" disabled=${busy} onClick=${() => done()}>✅ Xong</button>`) : null}
      ${['todo', 'doing'].includes(j.status) ? html`<button onClick=${() => act(() => api('POST', `/api/jobs/${j.id}/out`, {}), 'Đã báo tổ trưởng')}>Hết đồ</button>` : null}
    </div>` : null}
    ${!mine && j.status === 'todo' && !j.staff_id ? html`<button class="primary" onClick=${() => act(() => api('POST', `/api/jobs/${j.id}/claim`), 'Đã nhận việc')}>✋ Nhận việc này</button>` : null}
  </div>`;
}

function Mine() {
  const d = useData('/api/jobs/mine');
  const now = useNow();
  if (!d.data) return html`<${Loading} state=${d} />`;
  const { mine, open, to_check, on_shift } = d.data;
  const left = mine.filter((j) => ['todo', 'doing'].includes(j.status));
  return html`<div class="stack">
    ${to_check ? html`<button class="card hint" onClick=${() => navigate('/viec-ca?tab=khu')}>🔍 ${to_check} việc chờ bạn kiểm tra →</button>` : null}
    ${!on_shift && !mine.length ? html`<p class="muted">Hôm nay bạn không có ca nên chưa có việc.</p>` : null}
    ${mine.length ? html`<h3>Việc của tôi <small class="muted">${left.length ? `còn ${left.length}` : 'đã xong hết 👍'}</small></h3>` : on_shift ? html`<p class="muted">Chưa có việc nào giao cho bạn.</p>` : null}
    ${[...left, ...mine.filter((j) => !left.includes(j))].map((j) => html`<${JobCard} j=${j} now=${now} mine=${true} />`)}
    ${open.length ? html`<h3>Việc còn trống <small class="muted">nhận để hỗ trợ</small></h3>${open.map((j) => html`<${JobCard} j=${j} now=${now} />`)}` : null}
  </div>`;
}

function ZoneBoard({ t, z, now, today = true }) {
  const [note, setNote] = useState({});
  const upZone = async (e) => { const data = await pick(e); if (data) act(() => api('POST', '/api/jobs/zone-photo', { template_id: t.id, zone_id: z.zone_id, data }), 'Đã gửi ảnh tổng khu'); };
  return html`<section class="card stack">
    <div class="row"><i class="sw" style=${`background:${z.color}`}></i><b class="grow">${z.zone_name}${z.tables ? html` <small class="muted">${z.tables} bàn</small>` : ''}</b><span class=${`pill ${z.done === z.jobs.length ? 'ok' : ''}`}>${z.done}/${z.jobs.length}</span></div>
    <small class="muted">Kiểm tra: ${z.checkers.map((c) => c.name).join(', ') || '—'} · Người làm: ${z.people.map((p) => `${p.name.replace(/\(.*?\)/g, '').trim().split(' ').at(-1)} ${hmMin(p.start)}`).join(', ') || 'chưa có ai có ca'}</small>
    ${z.jobs.map((j) => { const [label, cls] = ST[j.status]; return html`<div class=${`job-row ${j.overdue ? 'bad' : ''}`}>
      <div class="row"><span class="grow"><b>${j.title}</b>${j.qty ? ` · ${j.qty}` : ''}${j.minutes ? html` <small class="muted">${j.minutes}′</small>` : ''}</span><span class=${`pill ${cls}`}>${label}</span></div>
      <div class="row wrap small">
        ${z.can_check && ['todo', 'doing'].includes(j.status) ? html`<select value=${j.staff_id || ''} onChange=${(e) => act(() => api('PATCH', `/api/jobs/${j.id}`, { staff_id: e.target.value || null }), 'Đã đổi người')}>
          <option value="">(chưa ai)</option>${z.people.map((p) => html`<option value=${p.id}>${p.name}</option>`)}${j.staff_id && !z.people.some((p) => p.id === j.staff_id) ? html`<option value=${j.staff_id}>${j.staff_name}</option>` : null}</select>` : html`<b>${j.staff_name || '(chưa ai)'}</b>`}
        <span class="muted">${j.claimed_at ? `nhận ${hm(j.claimed_at)}` : ''}${j.done_at ? ` · xong ${hm(j.done_at)} (${j.minutes_used}′)` : ''}${j.status === 'doing' && j.due_at ? ` · hạn ${hm(j.due_at)}` : ''}</span>
        ${j.late ? html`<span class="pill bad">trễ</span>` : null}${j.redo_count ? html`<span class="pill warn">làm lại ${j.redo_count}</span>` : null}
      </div>
      ${j.has_photo ? html`<a href=${`/api/jobs/${j.id}/photo`} target="_blank"><img class="job-photo" src=${`/api/jobs/${j.id}/photo`} /></a>` : null}
      ${z.can_check && j.status === 'done' ? html`<div class="row"><input class="grow" placeholder="Lý do nếu làm lại" value=${note[j.id] || ''} onInput=${(e) => setNote({ ...note, [j.id]: e.target.value })} />
        <button onClick=${() => act(() => api('POST', `/api/jobs/${j.id}/check`, { ok: false, note: note[j.id] || '' }), 'Đã trả lại')}>↩ Làm lại</button>
        <button class="primary" onClick=${() => act(() => api('POST', `/api/jobs/${j.id}/check`, { ok: true }), 'Đạt')}>✅ Đạt</button></div>` : null}
    </div>`; })}
    <div class="row wrap">${z.photos.map((p) => html`<a href=${`/api/jobs/zone-photo/${p.id}`} target="_blank"><img class="job-photo" src=${`/api/jobs/zone-photo/${p.id}`} title=${`${p.staff_name} ${hm(p.at)}`} /></a>`)}
      ${z.can_check && today ? html`<label class=${`button ${z.done === z.jobs.length && !z.photos.length ? 'primary' : ''}`}>📷 Ảnh tổng khu<input type="file" accept="image/*" capture="environment" hidden onChange=${upZone} /></label>` : null}</div>
  </section>`;
}

const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const dLabel = (d) => `${DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d.slice(8)}/${d.slice(5, 7)}`;

// Cả tuần: khu × ngày, mỗi ô = số người đầu ca trong khu (+ hỗ trợ) và ~phút việc / người. Bấm ô → xem phân việc ngày đó
function WeekGrid({ t, date, onPick, week }) {
  const w = week.templates.find((x) => x.id === t.id);
  if (!w) return null;
  return html`<div class="wk-jobs"><table class="tbl small">
    <thead><tr><th></th>${week.days.map((d) => html`<th class=${d === date ? 'on' : ''}>${dLabel(d)}</th>`)}</tr></thead>
    <tbody>${w.rows.map((r) => html`<tr><th><i class="sw" style=${`background:${r.color}`}></i>${r.zone_name.replace('Việc chung cả quán', 'Chung')}</th>
      ${r.cells.map((c) => html`<td class=${`${c.date === date ? 'on' : ''} ${c.unassigned ? 'bad' : ''}`} onClick=${() => onPick(c.date)}>
        <b>👥 ${c.people}</b>${c.helpers ? html`<small>+${c.helpers}</small>` : ''}<br /><small>${c.jobs ? (c.min_per != null ? `~${c.min_per}′/ng` : `${c.jobs} việc`) : '—'}</small>
        ${c.unassigned ? html`<br /><small class="warn-text">${c.unassigned} chưa ai</small>` : null}</td>`)}</tr>`)}</tbody>
  </table><small class="muted">👥 = số bạn có ca trong khu đúng khung giờ · +n = bạn chưa phân khu (vd tiếp thực) hỗ trợ · ~phút/ng = việc chia đều mỗi người. Bấm 1 ô để xem ai làm gì ngày đó.</small></div>`;
}

function Board({ me }) {
  const [date, setDate] = useState(me.today);
  const d = useData(`/api/jobs/board?date=${date}`);
  const week = useData(`/api/jobs/week?start=${date}`);
  const now = useNow();
  const [ph, setPh] = useState(null);
  if (!d.data) return html`<${Loading} state=${d} />`;
  const ts = d.data.templates;
  if (!ts.length) return html`<p class="muted">Chưa có checklist nào bật "Giao việc từng người". Trên màn Checklist, cuối thẻ checklist (vd Mở ca phục vụ) bấm <b>👥 Chuyển sang giao việc từng người</b>.</p>`;
  const cur = ts.find((t) => t.id === ph) || ts[0];
  const canAll = ['shift_lead', 'manager', 'owner'].includes(me.role) || cur.zones.some((z) => z.can_check);
  const future = date > me.today, past = date < me.today;
  return html`<div class="stack">
    <div class="row wrap">${ts.map((t) => html`<button class=${`chip ${t.id === cur.id ? 'on' : ''}`} onClick=${() => setPh(t.id)}>${t.title}${t.window ? ` · ${t.window}` : ''}</button>`)}</div>
    <div class="row"><button class="icon" onClick=${() => setDate(addDays(date, -7))}>«</button><b class="grow center">Tuần ${week.data ? `${dLabel(week.data.days[0])} – ${dLabel(week.data.days[6])}` : ''}</b><button class="icon" onClick=${() => setDate(addDays(date, 7))}>»</button></div>
    ${week.data ? html`<${WeekGrid} t=${cur} date=${date} week=${week.data} onPick=${setDate} />` : null}
    <h3>${dLabel(date)}${date === me.today ? ' (hôm nay)' : ''}</h3>
    ${future ? html`<p class="small muted">Ngày tới: app tự chia lại theo lịch ca / phân khu mới nhất. Việc anh chọn tay sẽ được giữ.</p>` : null}
    ${canAll && !past ? html`<button onClick=${() => confirm('Chia lại các việc chưa ai bắt đầu theo gợi ý của app (kể cả việc đã chọn tay)?') && act(() => api('POST', '/api/jobs/reassign', { date, template_id: cur.id }), 'Đã chia lại')}>🔄 Chia lại theo gợi ý</button>` : null}
    ${canAll ? html`<small class="muted">Đổi người: chọn tên ở từng việc. Thêm / sửa việc (phút, số lượng, chỗ lấy đồ): <a href="/cai-dat?tab=checklist" onClick=${(e) => { e.preventDefault(); navigate('/cai-dat?tab=checklist'); }}>Cài đặt → Checklist</a>; việc mới tự thêm vào các ngày.</small>` : null}
    ${cur.zones.length ? cur.zones.map((z) => html`<${ZoneBoard} t=${cur} z=${z} now=${now} today=${date === me.today} />`) : html`<p class="muted">Chưa có việc ngày này.</p>`}
  </div>`;
}

function Report() {
  const d = useData('/api/jobs/report');
  if (!d.data) return html`<${Loading} state=${d} />`;
  return html`<div class="stack"><h3>7 ngày qua (${d.data.from.slice(5)} → ${d.data.to.slice(5)})</h3>
    <p class="small muted">Trễ = quá thời gian chuẩn · Làm lại = tổ trưởng trả lại · Bỏ = được giao mà không làm. Tốc độ = phút thực tế / phút chuẩn (dưới 100% là nhanh).</p>
    <table class="tbl small"><thead><tr><th>Nhân viên</th><th>Xong</th><th>Trễ</th><th>Làm lại</th><th>Bỏ</th><th>Tốc độ</th></tr></thead><tbody>
      ${d.data.staff.map((x) => html`<tr><td>${x.name}</td><td>${x.done}/${x.total}</td><td class=${x.late ? 'warn-text' : ''}>${x.late}</td><td class=${x.redo ? 'warn-text' : ''}>${x.redo}</td><td class=${x.missed ? 'warn-text' : ''}>${x.missed}</td><td>${x.speed != null ? `${x.speed}%` : '—'}</td></tr>`)}
    </tbody></table>
    <h3>Khu xong lúc</h3>${d.data.zones.map((z) => html`<small>${z.date.slice(5)} · ${z.template_title} · ${z.zone_name}: ${z.d}/${z.n}${z.last_done && z.d === z.n ? ` · xong ${hm(z.last_done)}` : ''}</small>`)}
  </div>`;
}

export function JobsView({ me, query }) {
  const tab = query.get('tab') || 'toi';
  const tabs = [['toi', 'Việc của tôi'], ['khu', 'Bảng khu'], ...(['shift_lead', 'manager', 'owner'].includes(me.role) ? [['bc', 'Báo cáo']] : [])];
  return html`<div class="stack">
    <div class="row wrap">${tabs.map(([k, n]) => html`<button class=${`chip ${tab === k ? 'on' : ''}`} onClick=${() => navigate(`/viec-ca?tab=${k}`)}>${n}</button>`)}</div>
    ${tab === 'khu' ? html`<${Board} me=${me} />` : tab === 'bc' ? html`<${Report} />` : html`<${Mine} />`}
  </div>`;
}

// Thẻ trên trang Hôm nay
export function MyJobsCard() {
  const d = useData('/api/jobs/mine');
  if (!d.data) return null;
  const left = d.data.mine.filter((j) => ['todo', 'doing'].includes(j.status));
  const over = left.filter((j) => j.overdue).length;
  if (!left.length && !d.data.open.length && !d.data.to_check) return null;
  return html`<button class=${`card hint ${over ? 'bad' : ''}`} onClick=${() => navigate(d.data.to_check && !left.length ? '/viec-ca?tab=khu' : '/viec-ca')}>
    <span>📋 ${left.length ? html`<b>${left.length} việc của bạn</b>${over ? ` · ${over} quá giờ` : ''}: ${left.slice(0, 3).map((j) => j.title).join(', ')}${left.length > 3 ? '…' : ''}` : ''}
    ${!left.length && d.data.open.length ? `${d.data.open.length} việc còn trống, nhận để hỗ trợ` : ''}${d.data.to_check ? ` · ${d.data.to_check} việc chờ bạn kiểm` : ''} →</span></button>`;
}
