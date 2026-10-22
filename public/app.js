import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { html, api, bump, useRoute, Link, Toaster, toast, atLeast, useLive } from './ui.js';
import { Home } from './views/home.js';
import { Dashboard } from './views/dashboard.js';
import { Schedule } from './views/schedule.js';
import { StaffView } from './views/staff.js';
import { AttendanceView } from './views/attendance.js';
import { LeaveView } from './views/leave.js';
import { ChecklistView } from './views/checklists.js';
import { TasksView } from './views/tasks.js';
import { OrgView } from './views/org.js';
import { SettingsView } from './views/settings.js';
import { Profile } from './views/profile.js';
import { StockView } from './views/stock.js';
import { FloorView } from './views/floor.js';
import { AvailabilityView } from './views/availability.js';
import { ReviewView } from './views/review.js';
import { MenuView } from './views/menu.js';
import { OrderView } from './views/order.js';
import { ReservationsView } from './views/reservations.js';
import { PrintersView } from './views/printers.js';
import { PromotionsView } from './views/promotions.js';
import { CashierView } from './views/pay.js';
import { DaybookView } from './views/daybook.js';
import { TicketsView } from './views/tickets.js';

const NAV = [
  { path: '/', label: 'Hôm nay', icon: '◉', role: 'staff', main: true },
  { path: '/quan-ly', label: 'Quản lý', icon: '▦', role: 'shift_lead', main: true },
  { path: '/lich', label: 'Lịch ca', icon: '▤', role: 'staff', main: true },
  { path: '/ban', label: 'Sơ đồ bàn', icon: '▚', role: 'staff', main: true },
  { path: '/kho', label: 'Kho', icon: '▣', role: 'staff', main: true },
  { path: '/checklist', label: 'Checklist', icon: '☑', role: 'staff', main: true },
  { path: '/viec', label: 'Việc', icon: '✎', role: 'staff', main: true },
  { path: '/dat-ban', label: 'Đặt bàn', icon: '☏', role: 'staff' },
  { path: '/phieu-bep', label: 'Phiếu bếp (máy in hỏng)', icon: '🧾', role: 'staff' },
  { path: '/thuc-don', label: 'Thực đơn', icon: '☰', role: 'team_lead' },
  { path: '/ranh', label: 'Lịch rảnh', icon: '◷', role: 'staff' },
  { path: '/duyet-anh', label: 'Duyệt ảnh', icon: '▣', role: 'team_lead' },
  { path: '/thu-ngan', label: 'Thu ngân & doanh thu', icon: '₫', role: 'staff', show: (me) => atLeast(me, 'shift_lead') || me.team?.name === 'Thu ngân' },
  { path: '/duyet-so', label: 'Duyệt sổ', icon: '✔', role: 'manager' },
  { path: '/khuyen-mai', label: 'Khuyến mãi', icon: '🎁', role: 'staff' },
  { path: '/may-in', label: 'Máy in', icon: '⎙', role: 'shift_lead' },
  { path: '/nghi', label: 'Nghỉ & thay ca', icon: '⇄', role: 'staff' },
  { path: '/cham-cong', label: 'Chấm công', icon: '⏱', role: 'shift_lead' },
  { path: '/nhan-vien', label: 'Nhân viên', icon: '☺', role: 'manager' },
  { path: '/so-do', label: 'Sơ đồ tổ chức', icon: '⌗', role: 'staff' },
  { path: '/cai-dat', label: 'Cài đặt', icon: '⚙', role: 'manager' },
  { path: '/ho-so', label: 'Tài khoản', icon: '◎', role: 'staff' },
];

function Login({ onDone }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e?.preventDefault();
    if (pin.length < 4 || busy) return;
    setBusy(true);
    try {
      await api('POST', '/api/login', { pin });
      onDone();
    } catch (err) {
      toast(err.message, true);
      setPin('');
    } finally {
      setBusy(false);
    }
  };
  const press = (k) => setPin((p) => (k === '⌫' ? p.slice(0, -1) : p.length < 8 ? p + k : p));
  useEffect(() => { if (pin.length === 8) submit(); }, [pin]);
  return html`<div class="login">
    <div class="login-mark">CLT</div>
    <h1>Đăng nhập</h1>
    <p class="muted">Nhập mã PIN của bạn</p>
    <form onSubmit=${submit}>
      <input id="pin" class="pin" type="password" inputmode="numeric" autocomplete="off" value=${pin} maxlength="8"
        onInput=${(e) => setPin(e.target.value.replace(/\D/g, ''))} aria-label="Mã PIN" />
      <div class="keypad">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '→'].map((k) => html`<button type=${k === '→' ? 'submit' : 'button'}
          class=${k === '→' ? 'primary' : ''} disabled=${busy} onClick=${k === '→' ? undefined : () => press(k)}>${k}</button>`)}
      </div>
    </form>
    ${window.__DEMO__ ? html`<div class="demo-accounts">
      <p><b>Bản chạy thử</b>: bấm một tài khoản mẫu để vào xem theo vai trò đó.</p>
      ${window.__DEMO__.accounts.map((a) => html`<button type="button" onClick=${async () => {
        try { await api('POST', '/api/login', { pin: a.pin }); onDone(); } catch (err) { toast(err.message, true); }
      }}><b>${a.name}</b><span>${a.role}${a.team ? ` · ${a.team}` : ''}</span><small>PIN ${a.pin}</small></button>`)}
    </div>` : null}
  </div>`;
}

function ChangePin({ me, onDone }) {
  const [f, setF] = useState({ current_pin: '', new_pin: '', again: '' });
  const need = atLeast(me, 'manager') ? 6 : 4;
  const submit = async (e) => {
    e.preventDefault();
    if (f.new_pin !== f.again) return toast('Hai lần nhập PIN mới không khớp', true);
    try {
      await api('POST', '/api/me/pin', { current_pin: f.current_pin, new_pin: f.new_pin });
      toast('Đã đổi mã PIN');
      onDone();
    } catch (err) { toast(err.message, true); }
  };
  const inp = (k, label) => html`<label class="field"><span>${label}</span><input id=${k} type="password" inputmode="numeric" value=${f[k]}
    onInput=${(e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, '') })} maxlength="8" /></label>`;
  return html`<div class="login">
    <h1>Đổi mã PIN</h1>
    <p class="muted">Lần đầu đăng nhập, bạn cần đặt mã PIN riêng (${need}–8 chữ số, không dùng số lặp như 1111 hay liên tiếp như 1234).</p>
    <form class="stack" onSubmit=${submit}>
      ${inp('current_pin', 'PIN hiện tại')}${inp('new_pin', 'PIN mới')}${inp('again', 'Nhập lại PIN mới')}
      <button class="primary big">Lưu mã PIN</button>
    </form>
  </div>`;
}

function Shell({ me, children, path, online }) {
  const items = NAV.filter((n) => (n.show ? n.show(me) : atLeast(me, n.role)));
  const main = items.filter((n) => n.main).slice(0, 4);
  const [more, setMore] = useState(false);
  const active = (p) => (p === '/' ? path === '/' : path.startsWith(p));
  useEffect(() => setMore(false), [path]);
  return html`<div class="shell">
    <aside class="side">
      <div class="brand"><span class="mark">CLT</span><span>${me.shop_name}</span></div>
      <nav>${items.map((n) => html`<${Link} href=${n.path} class=${active(n.path) ? 'on' : ''}><i>${n.icon}</i>${n.label}
        ${n.path === '/ho-so' && me.unread ? html`<b class="dotn">${me.unread}</b>` : null}<//>`)}</nav>
      <div class="side-foot"><span class=${`conn ${online ? '' : 'off'}`}></span>${online ? 'Đang đồng bộ' : 'Mất kết nối'}</div>
    </aside>
    <div class="main">
      <header class="top">
        <span class="mark">CLT</span>
        <b class="grow">${items.find((n) => active(n.path))?.label || ''}</b>
        <span class=${`conn ${online ? '' : 'off'}`} title=${online ? 'Đang đồng bộ' : 'Mất kết nối'}></span>
        <${Link} href="/ho-so" class="who">${me.name}${me.unread ? html`<b class="dotn">${me.unread}</b>` : null}<//>
      </header>
      ${window.__DEMO__ ? html`<div class="banner demo">Bản chạy thử · dữ liệu mẫu chỉ lưu trên máy này
        <button class="small" onClick=${() => window.__DEMO__.reset()}>Làm lại từ đầu</button>
        <button class="small" onClick=${async () => { await api('POST', '/api/logout'); window.dispatchEvent(new Event('auth:lost')); }}>Đổi tài khoản</button></div>` : null}
      ${!online ? html`<div class="banner">Mất kết nối tới máy chủ của quán. Đang thử kết nối lại…</div>` : null}
      <main class="content">${children}</main>
    </div>
    <nav class="tabbar">
      ${main.map((n) => html`<${Link} href=${n.path} class=${active(n.path) ? 'on' : ''}><i>${n.icon}</i><span>${n.label}</span><//>`)}
      <button class=${more ? 'on' : ''} onClick=${() => setMore(!more)}><i>☰</i><span>Thêm</span>${me.unread ? html`<b class="dotn">${me.unread}</b>` : null}</button>
    </nav>
    ${more ? html`<div class="sheet" onClick=${(e) => e.target === e.currentTarget && setMore(false)}>
      <div class="sheet-body">${items.filter((n) => !main.includes(n)).map((n) => html`<${Link} href=${n.path} class=${active(n.path) ? 'on' : ''}><i>${n.icon}</i>${n.label}<//>`)}</div>
    </div>` : null}
  </div>`;
}

function App() {
  const [me, setMe] = useState(undefined);
  const [online, setOnline] = useState(true);
  const path = useRoute();
  const live = useLive();

  const loadMe = () => api('GET', '/api/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { loadMe(); }, [live]);
  useEffect(() => {
    const lost = () => setMe(null);
    window.addEventListener('auth:lost', lost);
    return () => window.removeEventListener('auth:lost', lost);
  }, []);

  useEffect(() => {
    if (!me) return undefined;
    const es = new EventSource('/api/events');
    es.addEventListener('change', () => bump());
    es.onopen = () => { setOnline(true); bump(); };
    es.onerror = () => setOnline(false);
    return () => es.close();
  }, [me?.id]);

  if (me === undefined) return html`<div class="empty">Đang tải…</div>`;
  if (!me) return html`<${Login} onDone=${loadMe} />`;
  if (me.must_change_pin) return html`<${ChangePin} me=${me} onDone=${loadMe} />`;

  const base = path.split('?')[0];
  const query = new URLSearchParams(path.split('?')[1] || '');
  const routes = {
    '/': Home, '/quan-ly': Dashboard, '/lich': Schedule, '/nhan-vien': StaffView, '/cham-cong': AttendanceView,
    '/nghi': LeaveView, '/checklist': ChecklistView, '/viec': TasksView, '/so-do': OrgView, '/kho': StockView, '/ban': FloorView, '/ranh': AvailabilityView, '/duyet-anh': ReviewView, '/thuc-don': MenuView, '/goi-mon': OrderView, '/dat-ban': ReservationsView, '/may-in': PrintersView, '/khuyen-mai': PromotionsView, '/thu-ngan': CashierView, '/duyet-so': DaybookView, '/phieu-bep': TicketsView, '/cai-dat': SettingsView, '/ho-so': Profile,
  };
  const nav = NAV.find((n) => n.path === base);
  const View = routes[base] && (!nav || atLeast(me, nav.role)) ? routes[base] : Home;
  return html`<${Shell} me=${me} path=${base} online=${online}><${View} me=${me} query=${query} reloadMe=${loadMe} /><//>`;
}

render(html`<${App} /><${Toaster} />`, document.getElementById('root'));
