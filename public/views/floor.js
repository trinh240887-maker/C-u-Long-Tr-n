import { useState, useEffect } from 'preact/hooks';
import { html, api, act, useData, Loading, Link, hm, atLeast, navigate } from '../ui.js';

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
    if (t.reservation && !confirm(`Bàn ${t.number} đang giữ cho ${t.reservation.name} lúc ${fmtMin(t.reservation.time_min)}. Vẫn nhận khách khác vào bàn này?`)) return undefined;
    const r = await act(() => api('POST', '/api/pos/sessions', { tables: [t.number] }));
    if (r?.id) navigate(`/goi-mon?s=${r.id}`);
    return undefined;
  };
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="tabs"><button class=${view === 'ban' ? 'on' : ''} onClick=${() => setV('ban')}>Bàn & gọi món</button><button class=${view === 'nguoi' ? 'on' : ''} onClick=${() => setV('nguoi')}>Ai phụ trách</button></div>
      <span class="muted small">${busy}/${all.length} bàn có khách</span>
    </div>
    ${view === 'nguoi' ? html`<${People} me=${me} data=${st.data} />` : html`
      <div class="legend small"><span class="tbl-l free">Trống</span><span class="tbl-l busy">Có khách</span><span class="tbl-l unsent">Chưa gửi bếp</span><span class="tbl-l paying">Xin thanh toán</span><span class="tbl-l held">Đã đặt</span>
        <${Link} href="/dat-ban" class="btn-link">Đặt bàn →<//></div>
      ${pos.data.zones.map((z) => {
        const pz = people.get(z.id);
        return html`<section class="card zone" style=${`--z:${z.color}`}>
          <div class="row between"><h3><i class="sw" style=${`background:${z.color}`}></i> ${z.name}</h3>
            <small class="muted">${pz?.on_now.length ? pz.on_now.map((s) => s.staff_name).join(', ') : 'chưa ai trực'}</small></div>
          <div class="tables pos">${z.tables.map((t) => {
            const s = t.session;
            const cls = s ? (s.status === 'paying' ? 'paying' : s.unsent ? 'unsent' : 'busy') : t.reservation ? 'held' : 'free';
            return html`<button class=${`tbl ${cls} ${s?.priority ? 'vip' : ''}`} onClick=${() => tap(z, t)}>
              <b>${t.number}</b>
              ${s ? html`<small>${mins(s.opened_at, now)}′</small>${s.total ? html`<small>${Math.round(s.total / 1000)}k</small>` : null}`
                : t.reservation ? html`<small>${fmtMin(t.reservation.time_min)}</small>` : null}
            </button>`;
          })}</div>
        </section>`;
      })}`}
  </div>`;
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

