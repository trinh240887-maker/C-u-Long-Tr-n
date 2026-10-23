import { promoLine } from '../promo-line.js';
import { useState } from 'preact/hooks';
import { html, api, act, useData, Loading, hm } from '../ui.js';

const KIND = { new: '', add: 'GỌI THÊM', cancel: 'HUỶ MÓN', redo: 'LÀM LẠI', remind: 'NHẮC MÓN' };
const PRINT = { pending: ['bad', 'CHƯA IN'], printed: ['ok', 'đã in'], failed: ['bad', 'IN LỖI'], expired: ['muted', 'quá hạn'], skipped: ['ok', 'nhận trên màn hình'] };

// Phiếu bếp trên điện thoại: dùng khi máy in / wifi ở quán hỏng (điện thoại dùng 4G vẫn vào app được)
export function TicketsView({ me }) {
  const [station, setStation] = useState(() => { try { return localStorage.getItem('tk-station') || ''; } catch { return ''; } });
  const [all, setAll] = useState(false);
  const menu = useData('/api/menu');
  const st = useData(`/api/pos/tickets${station ? `?station=${station}` : ''}`);
  const pr = useData('/api/print/status');
  if (!st.data || !menu.data) return html`<${Loading} state=${st.data ? menu : st} />`;
  const pick = (x) => { setStation(x); try { localStorage.setItem('tk-station', x); } catch { /* bỏ qua */ } };
  const list = st.data.filter((k) => all || !k.done_at);
  const offline = pr.data && !pr.data.bridge_online;
  const waiting = st.data.filter((k) => ['pending', 'failed'].includes(k.print_status) && !k.done_at).length;
  return html`<div class="stack">
    ${offline || waiting ? html`<div class="card warn-card"><p style="margin:0"><b>${offline ? '🔴 Máy in ở quán đang mất kết nối.' : `${waiting} phiếu chưa in được.`}</b> Làm theo phiếu trên màn hình này, làm xong bấm <b>Đã nhận</b> (phiếu đó sẽ không in lại).</p></div>` : null}
    <div class="chips scroll-x">
      <button class=${`chip ${!station ? 'on' : ''}`} onClick=${() => pick('')}>Tất cả</button>
      ${menu.data.stations.map((s) => html`<button class=${`chip ${station === String(s.id) ? 'on' : ''}`} onClick=${() => pick(String(s.id))}>${s.name}</button>`)}
    </div>
    <label class="check-row"><input type="checkbox" checked=${all} onChange=${(e) => setAll(e.target.checked)} /> Hiện cả phiếu đã nhận</label>
    ${!list.length ? html`<div class="empty">Không có phiếu nào đang chờ.</div>` : null}
    ${list.map((k) => {
      const p = PRINT[k.print_status] || ['muted', k.print_status];
      return html`<section class=${`card stack ticket ${k.kind} ${k.done_at ? 'dim' : ''}`} key=${k.id}>
        <div class="row between wrap"><b>${k.header}</b><span class="small">${k.station_name} · ${hm(k.created_at)}</span></div>
        <div class="row wrap">${KIND[k.kind] ? html`<span class="pill bad">${KIND[k.kind]}</span>` : null}${k.priority ? html`<span class="pill warn">ƯU TIÊN</span>` : null}<span class=${`pill ${p[0]}`}>${p[1]}</span></div>
        ${k.lines.map((l) => html`<div><b class="big-line">${l.qty} × ${l.name}</b>${l.label && l.label !== l.name ? html`<br /><small>› ${l.label}</small>` : null}
          ${l.options?.length ? html`<br /><small>${l.options.join(', ')}</small>` : null}${l.note ? html`<br /><small class="warn-text">* ${l.note}</small>` : null}${l.promo ? html`<br /><small class="promo-line">🎁 ${promoLine(l)}</small>` : null}</div>`)}
        <div class="row wrap">
          ${!k.done_at ? html`<button class="primary grow" onClick=${() => act(() => api('POST', `/api/pos/tickets/${k.id}/done`), 'Đã nhận phiếu')}>Đã nhận</button>` : html`<small class="muted grow">Đã nhận ${hm(k.done_at)}</small>`}
          <button onClick=${() => { const r = prompt('In lại phiếu này? Lý do (vd mất phiếu, phiếu rách)', 'Mất phiếu'); if (r) act(() => api('POST', `/api/pos/tickets/${k.id}/reprint`, { reason: r }), 'Đã gửi in lại'); }}>🖨 In lại${k.reprint ? ` (${k.reprint})` : ''}</button>
        </div>
      </section>`;
    })}
  </div>`;
}
