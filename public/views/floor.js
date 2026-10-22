import { useState, useEffect } from 'preact/hooks';
import { html, api, act, useData, Loading, Link, hm, atLeast, navigate, toast } from '../ui.js';

const mins = (from, now) => Math.max(0, Math.round((now - from) / 60_000));
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function FloorView({ me }) {
  const pos = useData('/api/pos/tables');
  const st = useData('/api/floor');
  const [view, setView] = useState(() => { try { return localStorage.getItem('floor-view') || 'ban'; } catch { return 'ban'; } });
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(id); }, []);
  if (!pos.data || !st.data) return html`<${Loading} state=${pos.data ? st : pos} />`;
  const setV = (x) => { setView(x); try { localStorage.setItem('floor-view', x); } catch { /* bỏ qua */ } };
  const now = Date.now();
  const people = new Map(st.data.zones.map((z) => [z.id, z]));
  const all = pos.data.zones.flatMap((z) => z.tables);
  const busy = all.filter((t) => t.session).length;
  // Bấm bàn trống là nhận khách và vào gọi món luôn (không hỏi số khách)
  const tap = async (z, t) => {
    if (t.session) return navigate(`/goi-mon?s=${t.session.id}`);
    // Bàn chờ dọn: bấm = đã dọn xong; app báo luôn nhóm chờ nào được mời vào bàn này
    if (t.dirty != null) {
      if (!confirm(`Bàn ${t.number} đã dọn xong?`)) return undefined;
      const r = await act(() => api('POST', `/api/pos/tables/${t.number}/clean`));
      if (r?.next) toast(`Mời ${r.next.name} (${r.next.guests} khách) vào bàn ${r.next.tables.join(', ')}`);
      return undefined;
    }
    // Đang đông mà bấm bàn lớn: hỏi số khách để gợi ý bàn vừa chỗ
    const sm = pos.data.summary;
    let guests;
    if (t.seats >= 6 && (sm.waiting > 0 || sm.free <= sm.total * 0.1)) {
      const x = prompt(`Bàn ${t.number} có ${t.seats} chỗ. Nhóm bao nhiêu người?`, '');
      if (x === null) return undefined;
      guests = Number(x) || undefined;
    }
    // Bàn có khách đặt: còn xa giờ đặt thì nhận khách bình thường; sát giờ (mặc định 15′) thì phải xác nhận
    if (t.reservation?.locked && !confirm(`Bàn ${t.number} đã khoá cho ${t.reservation.name} lúc ${fmtMin(t.reservation.time_min)}. Vẫn nhận khách khác vào bàn này?`)) return undefined;
    let r;
    try {
      r = await api('POST', '/api/pos/sessions', { tables: [t.number], guests, override_reserved: !!t.reservation?.locked });
    } catch (e) {
      if (e.status === 409 && /phí chỗ/.test(e.message)) {
        if (confirm(e.message)) r = await act(() => api('POST', '/api/pos/sessions', { tables: [t.number], guests, override_size: true, override_reserved: !!t.reservation?.locked }));
        if (r?.id) navigate(`/goi-mon?s=${r.id}`);
        return undefined;
      }
      // Bàn có khách đặt sắp tới: app gợi ý bàn khác, chủ động xác nhận mới nhận
      if (e.status === 409 && /có khách đặt/.test(e.message) && confirm(e.message)) r = await act(() => api('POST', '/api/pos/sessions', { tables: [t.number], override_soon: true }));
      else if (!(e.status === 409 && /có khách đặt/.test(e.message))) act(() => Promise.reject(e));
    }
    if (r?.id) navigate(`/goi-mon?s=${r.id}`);
    return undefined;
  };
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="tabs"><button class=${view === 'ban' ? 'on' : ''} onClick=${() => setV('ban')}>Bàn & gọi món</button><button class=${view === 'nguoi' ? 'on' : ''} onClick=${() => setV('nguoi')}>Ai phụ trách</button></div>
      <span class="muted small">${busy}/${all.length} bàn có khách</span>
    </div>
    <${Summary} s=${pos.data.summary} />
    ${view === 'nguoi' ? html`<${People} me=${me} data=${st.data} />` : html`
      <div class="legend small"><span class="tbl-l free">Trống</span><span class="tbl-l busy">Có khách</span><span class="tbl-l unsent">Chưa gửi bếp</span><span class="tbl-l paying">Xin thanh toán</span><span class="tbl-l held">Đã đặt</span><span class="tbl-l dirty">Chờ dọn</span>
        <${Link} href="/dat-ban" class="btn-link">Đặt bàn →<//></div>
      ${pos.data.zones.map((z) => {
        const pz = people.get(z.id);
        return html`<section class="card zone" style=${`--z:${z.color}`}>
          <div class="row between"><h3><i class="sw" style=${`background:${z.color}`}></i> ${z.name}</h3>
            <small class="muted">${pz?.on_now.length ? pz.on_now.map((s) => s.staff_name).join(', ') : 'chưa ai trực'}</small></div>
          <div class="tables pos">${z.tables.map((t) => {
            const s = t.session;
            const cls = s ? (s.status === 'paying' ? 'paying' : s.unsent ? 'unsent' : 'busy') : t.dirty != null ? 'dirty' : t.reservation ? 'held' : 'free';
            return html`<button class=${`tbl ${cls} ${s?.priority ? 'vip' : ''}`} onClick=${() => tap(z, t)}>
              <b>${t.number}</b>
              ${s?.late ? html`<span class="late-badge">⏰${s.late}</span>` : null}
              ${s ? html`<small>${mins(s.opened_at, now)}′</small>${s.total ? html`<small>${Math.round(s.total / 1000)}k</small>` : null}`
                : t.dirty != null ? html`<small>Dọn ${t.dirty}′</small>` : t.reservation ? html`<small>${fmtMin(t.reservation.time_min)}</small>` : null}
            </button>`;
          })}</div>
        </section>`;
      })}`}
  </div>`;
}

// 1 nhóm khách chờ: app gợi ý bàn vừa chỗ → "Mời vào" mở bàn luôn; khách bỏ đi → "Bỏ về"
function WaitRow({ w, k, eta }) {
  const seat = async () => {
    const r = await act(() => api('POST', `/api/reservations/${w.id}/arrive`, { tables: w.suggest.join(', ') }), `Đã mời ${w.name} vào bàn ${w.suggest.join(', ')}`);
    if (r?.session_id) navigate(`/goi-mon?s=${r.session_id}`);
  };
  return html`<div class="wait-row">
    <div class="row between"><span><b>${k + 1}. ${w.name}</b> · ${w.guests} khách · chờ ${w.waited}′${w.phone ? html` · <a href=${`tel:${w.phone}`}>${w.phone}</a>` : null}</span><b>${eta(w.eta)}</b></div>
    ${w.called_at ? html`<small class=${w.call_late ? 'warn' : 'muted'}>Đã mời vào bàn ${w.called_table} ${w.called_count > 1 ? `(lần ${w.called_count})` : ''}${w.call_late ? ' · quá giờ chưa vào' : ''}</small>` : null}
    ${w.protect ? html`<small class="muted">Đang giữ dồn bàn ${w.suggest.join(', ')} cho nhóm đông</small>` : null}
    ${!w.suggest && w.prep ? html`<small class="ok">Bàn ${w.prep.join(', ')} đang tính tiền → báo khách ra cửa chờ (~5′)</small>` : null}
    <div class="row">
      ${w.suggest && !w.protect ? html`<button class="primary" onClick=${seat}>Mời vào bàn ${w.suggest.join(', ')}${w.suggest_dirty.length ? ' (đang dọn)' : ''}</button>` : null}
      <button onClick=${() => confirm(`${w.name} bỏ về?`) && act(() => api('POST', `/api/waitlist/${w.id}/gone`), 'Đã ghi khách bỏ về')}>Bỏ về</button>
    </div>
  </div>`;
}

// Quản lý nhìn 1 dòng là biết còn đón được bao nhiêu khách
function Summary({ s }) {
  const [open, setOpen] = useState(false);
  if (!s) return null;
  const soon = s.paying + s.long_sitting;
  const eta = (m) => (m == null ? 'chưa ước được' : m === 0 ? 'có bàn ngay' : `~${m} phút`);
  return html`<div class="floor-sum">
    <div class="fs free"><b>${s.free}</b><small>bàn trống</small>${s.free_pairs ? html`<em>${s.free_pairs} cặp ghép được</em>` : null}${s.dirty ? html`<em>+${s.dirty} chờ dọn</em>` : null}</div>
    <div class="fs soon"><b>${soon}</b><small>sắp trống</small><em>${s.paying} xin tính tiền · ${s.long_sitting} ngồi ≥${s.long_minutes}′</em></div>
    <div class="fs held"><b>${s.held}</b><small>giữ khách đặt</small></div>
    <${Link} href="/dat-ban" class=${`fs wait ${s.waiting ? 'on' : ''}`}><b>${s.waiting}</b><small>nhóm đang chờ</small>${s.waiting ? html`<em>${s.waiting_guests} khách</em>` : null}<//>
  </div>
  <button class=${`card eta-bar ${s.next_eta ? 'busy' : ''}`} onClick=${() => setOpen(!open)}>
    <span>Khách mới tới lúc này: <b>${eta(s.next_eta)}</b></span><small class="muted">${open ? 'Ẩn' : 'Bàn sắp trống ›'}</small>
  </button>
  ${s.queue.length ? html`<section class="card stack small"><b>Danh sách chờ (${s.queue.length} nhóm)</b>${s.queue.map((w, k) => html`<${WaitRow} w=${w} k=${k} eta=${eta} />`)}</section>` : null}
  ${open ? html`<section class="card stack small">
    <b>Bàn sắp trống (ngồi trung bình hôm nay ${s.avg_dwell}′)</b>
    ${s.soon.length ? s.soon.map((x) => html`<div class="row between"><span>Bàn ${x.tables.join(', ')} · ${x.reason}</span><b>~${x.minutes}′</b></div>`) : html`<span class="muted">Chưa có bàn nào có khách.</span>`}
    <p class="muted">Ước tính: bàn xin tính tiền ~5′, bàn đã ra đủ món ~10′, còn lại theo thời gian ngồi trung bình. Báo khách "khoảng", đừng hứa chính xác.</p>
  </section>` : null}`;
}

// Ai đang phụ trách khu / bàn nào (từ lịch ca)
function People({ me, data }) {
  const [pick, setPick] = useState(null);
  const { zones } = data;
  const mineZones = zones.filter((z) => z.on_now.some((s) => s.staff_name === me.name));
  return html`<div class="stack">
    <div class="row between wrap">
      <span class="muted small">Đang phụ trách lúc ${hm(data.at)}. Ô có màu là bàn đã có người lo.</span>
      ${atLeast(me, 'manager') ? html`<${Link} href="/cai-dat?tab=khu" class="btn-link">Sửa khu & bàn<//>` : null}
    </div>
    ${mineZones.length ? html`<section class="card hint">Bạn đang phụ trách: ${mineZones.map((z) => {
      const s = z.on_now.find((x) => x.staff_name === me.name);
      return `${z.name}${s.tables_text ? ` (bàn ${s.tables_text})` : ' (cả khu)'}`;
    }).join(', ')}</section>` : null}
    ${zones.map((z) => html`<section class="card zone" style=${`--z:${z.color}`}>
      <div class="row between"><h3><i class="sw" style=${`background:${z.color}`}></i> ${z.name} <small class="muted">${z.table_count} bàn</small></h3>
        ${z.on_now.length ? html`<span class="pill ok">${z.on_now.length} người đang trực</span>` : html`<span class="pill warn">Chưa ai trực</span>`}</div>
      ${z.on_now.length ? html`<div class="people">${z.on_now.map((s) => html`<span class="person-chip"><b>${s.staff_name}</b> · ${s.tables_text ? `bàn ${s.tables_text}` : 'cả khu'} <small class="muted">${s.text}</small></span>`)}</div>` : null}
      <div class="tables">${z.tables.map((t) => html`<button class=${`tbl ${t.people.length ? 'on' : ''} ${t.mine ? 'mine' : ''}`} onClick=${() => setPick({ z, t })}>${t.number}</button>`)}</div>
    </section>`)}
    ${pick ? html`<div class="toast" onClick=${() => setPick(null)}>Bàn ${pick.t.number} · ${pick.z.name}: ${pick.t.people.length ? pick.t.people.join(', ') : 'chưa ai phụ trách'}</div>` : null}
    <p class="muted small">Phân người vào khu/bàn: <b>Lịch ca</b> → bấm vào ca → chọn <b>Khu phụ trách</b> và (tuỳ chọn) <b>bàn</b>.</p>
  </div>`;
}

