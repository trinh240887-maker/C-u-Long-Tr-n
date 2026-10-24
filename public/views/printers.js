import { useState } from 'preact/hooks';
import { html, api, act, useData, Loading, hm, atLeast } from '../ui.js';

const KIND = { new: 'Phiếu mới', add: 'Gọi thêm', cancel: 'Huỷ món', redo: 'Làm lại', remind: 'Nhắc món' };
const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'vừa xong' : m < 60 ? `${m} phút trước` : hm(ts); };

function StationRow({ s, canEdit }) {
  const [ip, setIp] = useState(s.ip || '');
  const dot = !s.ip ? ['muted', 'Chưa có IP'] : s.ok == null ? ['muted', 'Chưa kiểm tra'] : s.ok ? ['ok', 'Kết nối được'] : ['bad', 'Không thấy máy'];
  return html`<div class="card stack">
    <div class="row between wrap">
      <b>${s.name}</b>
      <span class=${`pill ${dot[0]}`}>${dot[1]}</span>
    </div>
    ${canEdit ? html`<div class="row wrap">
      <input inputmode="decimal" placeholder=${s.fallback ? `Trống = in sang ${s.fallback}` : 'vd 192.168.1.234'} value=${ip} onInput=${(e) => setIp(e.target.value.trim())} style="flex:1;min-width:10em" />
      ${ip !== (s.ip || '') ? html`<button class="primary" onClick=${() => act(() => api('PATCH', `/api/kitchen-stations/${s.id}`, { printer_ip: ip }), 'Đã lưu IP')}>Lưu</button>` : ''}
      <button disabled=${!s.ip} onClick=${() => act(() => api('POST', '/api/print/test', { station_id: s.id }), 'Đã gửi in thử')}>In thử</button>
    </div>` : html`<div class="muted">${s.ip ? `${s.ip}:${s.port}` : 'Chưa có IP'}</div>`}
    <div class="muted small">
      ${s.fallback ? `Máy lỗi / chưa có IP → in sang ${s.fallback}. ` : ''}
      ${s.pending ? html`<b>${s.pending} phiếu đang chờ in. </b>` : ''}
      ${s.failed ? html`<b class="danger-text">${s.failed} phiếu in lỗi.</b>` : ''}
    </div>
  </div>`;
}

export function PrintersView({ me }) {
  const st = useData('/api/print/status');
  const [showToken, setShowToken] = useState(false);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const manager = atLeast(me, 'manager');
  return html`<div class="stack">
    <div class=${`card stack ${d.bridge_online ? '' : 'warn-card'}`}>
      <div class="row between wrap">
        <b>${d.bridge_online ? '🟢 Cầu in đang chạy' : '🔴 Cầu in chưa chạy'}</b>
        <span class="muted small">${d.bridge_seen ? `Lần cuối: ${ago(d.bridge_seen)}` : 'Chưa kết nối lần nào'}</span>
      </div>
      ${!d.bridge_online ? html`<p class="small">Phiếu gọi món vẫn lưu trên app; khi cầu in chạy lại sẽ tự in (phiếu treo quá 60 phút thì bỏ).</p>` : ''}
    </div>

    ${manager ? html`<details class="card" open=${!d.bridge_seen}>
      <summary><b>Cài cầu in trên máy tính ở quán</b></summary>
      <ol class="stack small" style="padding-left:1.2em">
        <li>Dùng 1 máy tính Windows <b>cắm cùng mạng (wifi/dây) với máy in</b>, bật suốt giờ bán.</li>
        <li>Cài Node.js (bản LTS) từ <b>nodejs.org</b>: bấm Next đến hết.</li>
        <li>Trên máy tính đó, mở app, đăng nhập quản lý, vào trang này, bấm nút dưới để tải <b>cau-in.bat</b>.</li>
        <li>Bấm đúp <b>cau-in.bat</b>. Cửa sổ đen hiện "Cầu in đang chạy" là xong. <b>Đừng tắt cửa sổ đó.</b></li>
        <li>Muốn bật máy tính là tự chạy: nhấn Windows+R, gõ <code>shell:startup</code>, chép file cau-in.bat vào thư mục mở ra.</li>
      </ol>
      <div class="row wrap">
        <a class="button primary" href="/api/print/setup.bat" download="cau-in.bat">⬇ Tải cau-in.bat</a>
        <button onClick=${() => setShowToken(!showToken)}>${showToken ? 'Ẩn mã' : 'Xem mã cầu in'}</button>
      </div>
      ${showToken ? html`<p class="small">Mã: <code>${d.token}</code>. Lỡ lộ mã thì chủ quán bấm đổi mã, rồi tải lại file .bat.
        ${me.role === 'owner' ? html` <button class="small" onClick=${() => confirm('Đổi mã? Cầu in đang chạy sẽ ngừng cho đến khi tải lại file .bat') && act(() => api('POST', '/api/print/settings', { reset_token: true }), 'Đã đổi mã')}>Đổi mã</button>` : ''}</p>` : ''}
      <p class="muted small">Thử nhanh 1 máy in không cần app: mở cửa sổ lệnh trong thư mục có cau-in.js, gõ <code>node cau-in.js --thu 192.168.1.234</code>. Tìm IP máy in: <code>node cau-in.js --quet</code>.</p>
    </details>` : ''}

    <div class="row between wrap">
      <h3>Máy in (${d.stations.length})</h3>
      ${manager ? html`<button onClick=${() => act(() => api('POST', '/api/print/test', { station_id: 'all' }), 'Đã gửi in thử mọi máy')}>In thử tất cả</button>` : ''}
    </div>
    ${manager ? html`<p class="small muted">Mỗi khu 1 máy: bấm vào ô số dưới tên khu, gõ <b>IP dán trên máy in</b> (vd 192.168.1.240) → <b>Lưu</b> → <b>In thử</b>.</p>` : ''}
    ${d.stations.map((s) => html`<${StationRow} key=${s.id} s=${s} canEdit=${manager} />`)}
    ${manager ? html`<button onClick=${() => { const n = prompt('Tên máy in / khu mới (vd Thu ngân, Bar 2)'); if (n && n.trim()) act(() => api('POST', '/api/kitchen-stations', { name: n.trim() }), 'Đã thêm máy in'); }}>+ Thêm máy in</button>` : ''}

    ${manager ? html`<div class="card stack">
      <b>Chữ trên phiếu</b>
      <div class="row wrap">
        ${[['khong_dau', 'Không dấu (an toàn)'], ['utf8', 'Có dấu']].map(([k, label]) => html`<button class=${d.text_mode === k ? 'primary' : ''} onClick=${() => act(() => api('POST', '/api/print/settings', { text_mode: k }), 'Đã lưu')}>${label}</button>`)}
      </div>
      <p class="muted small">In thử xong: dòng "CÓ DẤU" đọc đúng thì chọn Có dấu; ra ký tự lạ thì giữ Không dấu.</p>
    </div>` : ''}

    ${d.tests.length ? html`<div class="card stack small">
      <b>In thử gần đây</b>
      ${d.tests.map((t) => html`<div class="row between"><span>${t.station_name} · ${hm(t.created_at)}</span>
        <span>${t.status === 'printed' ? '✓ đã gửi tới máy' : t.status === 'failed' ? html`<span class="danger-text">✗ ${t.error}</span>` : 'đang chờ cầu in…'}</span></div>`)}
    </div>` : ''}

    ${d.failed.length ? html`<div class="card stack">
      <div class="row between wrap"><b class="danger-text">Phiếu in lỗi (${d.failed.length})</b>
        <button class="primary" onClick=${() => act(() => api('POST', '/api/print/retry', { id: 'all' }), 'Đã gửi in lại')}>In lại tất cả</button></div>
      ${d.failed.map((k) => html`<div class="row between wrap small">
        <span><b>${k.header}</b> · ${k.station_name} · ${KIND[k.kind] || k.kind} · ${hm(k.created_at)}<br /><span class="muted">${k.print_error}</span></span>
        <button onClick=${() => act(() => api('POST', '/api/print/retry', { id: k.id }), 'Đã gửi in lại')}>In lại</button>
      </div>`)}
    </div>` : ''}
  </div>`;
}
