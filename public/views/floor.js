import { useState, useEffect } from 'preact/hooks';
import { html, useData, Loading, Link, hm, atLeast } from '../ui.js';

export function FloorView({ me }) {
  const st = useData('/api/floor');
  const [pick, setPick] = useState(null);
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(id); }, []);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const { zones } = st.data;
  const mineZones = zones.filter((z) => z.on_now.some((s) => s.staff_name === me.name));
  return html`<div class="stack">
    <div class="row between wrap">
      <span class="muted small">Đang phụ trách lúc ${hm(st.data.at)}. Ô có màu là bàn đã có người lo, ô xám là chưa ai.</span>
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
      ${z.today.length > z.on_now.length ? html`<details><summary class="muted small">Lịch cả ngày của khu (${z.today.length} lượt)</summary>
        <ul class="plain small">${z.today.map((s) => html`<li><b>${s.staff_name}</b> ${s.text} · ${s.tables_text ? `bàn ${s.tables_text}` : 'cả khu'}${s.on_now ? ' · đang trực' : ''}</li>`)}</ul></details>` : null}
    </section>`)}
    ${pick ? html`<div class="toast" onClick=${() => setPick(null)}>Bàn ${pick.t.number} · ${pick.z.name}: ${pick.t.people.length ? pick.t.people.join(', ') : 'chưa ai phụ trách'}</div>` : null}
    <p class="muted small">Phân người vào khu/bàn: <b>Lịch ca</b> → bấm vào ca → chọn <b>Khu phụ trách</b> và (tuỳ chọn) <b>bàn</b>.</p>
  </div>`;
}
