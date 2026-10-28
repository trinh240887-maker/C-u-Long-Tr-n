import { useState, useEffect } from '../vendor/hooks.js';
import { html, api, act, useData, Field, ago, toast } from '../ui.js';

export function Profile({ me, reloadMe }) {
  const notes = useData('/api/notifications');
  const [code, setCode] = useState(null);
  const [pin, setPin] = useState({ current_pin: '', new_pin: '' });
  useEffect(() => {
    if (me.unread) api('POST', '/api/notifications/read').then(reloadMe).catch(() => {});
  }, [me.unread]);
  return html`<div class="stack">
    <section class="card">
      <h3>${me.name}</h3>
      <p class="muted">${me.role_label}${me.team ? ` · ${me.team.name}` : ''}${me.skills.length ? ` · làm thay được: ${me.skills.map((s) => s.name).join(', ')}` : ''}</p>
      <button onClick=${async () => { try { await api('POST', '/api/logout'); window.dispatchEvent(new Event('auth:lost')); } catch (e) { toast(e.message, true); } }}>Đăng xuất</button>
    </section>

    <section class="card">
      <h3>Nhận thông báo qua Zalo</h3>
      ${me.zalo_linked ? html`<p><span class="pill ok">Đã liên kết</span> Bạn sẽ nhận lịch ca, lời nhờ làm thay và việc được giao qua Zalo OA của quán.</p>`
        : html`<ol class="plain steps">
          <li>Mở Zalo, tìm và bấm <b>Quan tâm</b> Official Account của quán.</li>
          <li>Bấm nút dưới để lấy mã liên kết.</li>
          <li>Nhắn mã đó cho OA. Vài giây sau trang này sẽ báo đã liên kết.</li>
        </ol>
        ${code ? html`<div class="code-box"><span class="code">${code}</span>
          <button class="small" onClick=${() => navigator.clipboard?.writeText(code).then(() => toast('Đã chép mã')).catch(() => {})}>Chép mã</button></div>`
          : html`<button class="primary" onClick=${async () => { const r = await act(() => api('POST', '/api/me/zalo-code')); if (r) setCode(r.code); }}>Lấy mã liên kết</button>`}`}
    </section>

    <section class="card">
      <h3>Đổi mã PIN</h3>
      <div class="row">
        <${Field} label="PIN hiện tại"><input id="pf-cur" type="password" inputmode="numeric" maxlength="8" value=${pin.current_pin} onInput=${(e) => setPin({ ...pin, current_pin: e.target.value.replace(/\D/g, '') })} /><//>
        <${Field} label="PIN mới"><input id="pf-new" type="password" inputmode="numeric" maxlength="8" value=${pin.new_pin} onInput=${(e) => setPin({ ...pin, new_pin: e.target.value.replace(/\D/g, '') })} /><//>
      </div>
      <button disabled=${!pin.current_pin || !pin.new_pin} onClick=${async () => { if (await act(() => api('POST', '/api/me/pin', pin), 'Đã đổi mã PIN')) setPin({ current_pin: '', new_pin: '' }); }}>Đổi PIN</button>
    </section>

    <section class="card">
      <h3>Thông báo</h3>
      ${(notes.data || []).length ? notes.data.map((n) => html`<div class=${`note ${n.read_at ? '' : 'unread'}`}>
        <b>${n.urgent ? '⚑ ' : ''}${n.title}</b>
        ${n.body ? html`<div class="muted pre">${n.body}</div>` : null}
        <small class="muted">${ago(n.created_at)}${n.zalo_status === 'sent' ? ' · đã gửi Zalo' : n.zalo_status === 'failed' ? ' · gửi Zalo lỗi' : ''}</small>
      </div>`) : html`<p class="muted">Chưa có thông báo.</p>`}
    </section>
  </div>`;
}
