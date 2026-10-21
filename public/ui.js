import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);
export const TZ = 'Asia/Ho_Chi_Minh';

// ---------- Gọi máy chủ ----------
export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError('Mất kết nối tới máy chủ của quán');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    window.dispatchEvent(new Event('auth:lost'));
  }
  if (!res.ok) throw new ApiError(data.error || `Lỗi ${res.status}`, res.status);
  return data;
}

// ---------- Cập nhật thời gian thực ----------
let version = 0;
const listeners = new Set();
let pending = null;
export function bump() {
  clearTimeout(pending);
  pending = setTimeout(() => { version++; for (const f of listeners) f(version); }, 250);
}
export function useLive() {
  const [v, setV] = useState(version);
  useEffect(() => { listeners.add(setV); return () => listeners.delete(setV); }, []);
  return v;
}
export function useData(url) {
  const v = useLive();
  const [state, set] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    api('GET', url)
      .then((data) => alive && set({ data, error: null, loading: false }))
      .catch((e) => alive && set((s) => ({ ...s, error: e.message, loading: false })));
    return () => { alive = false; };
  }, [url, v]);
  return state;
}

// Gọi API rồi báo kết quả
export async function act(fn, okMessage) {
  try {
    const out = await fn();
    if (okMessage) toast(okMessage);
    bump();
    return out;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  }
}

// ---------- Điều hướng ----------
// Bản chạy thử (window.__DEMO__) giữ đường dẫn trong bộ nhớ thay vì thanh địa chỉ
let memPath = '/';
const currentPath = () => (window.__DEMO__ ? memPath : location.pathname + location.search);
export function navigate(path) {
  if (currentPath() === path) return;
  if (window.__DEMO__) memPath = path;
  else history.pushState(null, '', path);
  window.dispatchEvent(new Event('route'));
  window.scrollTo(0, 0);
}
export function useRoute() {
  const [p, setP] = useState(currentPath());
  useEffect(() => {
    const on = () => setP(currentPath());
    window.addEventListener('popstate', on);
    window.addEventListener('route', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('route', on); };
  }, []);
  return p;
}
export function Link({ href, children, ...rest }) {
  return html`<a href=${href} onClick=${(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(href); }} ...${rest}>${children}</a>`;
}

// ---------- Thông báo nhỏ ----------
let toastSet = null;
export function toast(text, error = false) { toastSet?.({ text, error, id: Math.random() }); }
export function Toaster() {
  const [t, set] = useState(null);
  toastSet = set;
  useEffect(() => { if (!t) return undefined; const id = setTimeout(() => set(null), t.error ? 4500 : 2200); return () => clearTimeout(id); }, [t]);
  return t ? html`<div class=${`toast ${t.error ? 'err' : ''}`} role="status">${t.text}</div>` : null;
}

// ---------- Hộp thoại ----------
export function Modal({ title, onClose, children, wide }) {
  const ref = useRef();
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('noscroll');
    // Điện thoại: không tự bật bàn phím (bàn phím che màn hình, bấm nút bên dưới bị trượt)
    const touch = window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!touch) ref.current?.querySelector('input,select,textarea')?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('noscroll'); };
  }, []);
  return html`<div class="overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label=${title} ref=${ref}>
      <div class="modal-head"><h3>${title}</h3><button class="icon" aria-label="Đóng" onClick=${onClose}>✕</button></div>
      ${children}
    </div>
  </div>`;
}

export function Confirm({ text, onYes, onClose, yes = 'Đồng ý', danger }) {
  return html`<${Modal} title="Xác nhận" onClose=${onClose}>
    <p>${text}</p>
    <div class="row end"><button onClick=${onClose}>Thôi</button><button class=${danger ? 'danger solid' : 'primary'} onClick=${async () => { await onYes(); onClose(); }}>${yes}</button></div>
  <//>`;
}

export function Field({ label, hint, children }) {
  return html`<label class="field"><span>${label}</span>${children}${hint ? html`<small class="muted">${hint}</small>` : null}</label>`;
}

export function Empty({ children }) { return html`<div class="empty">${children}</div>`; }
export function Loading({ state }) {
  if (state.error && !state.data) return html`<div class="empty err">${state.error}</div>`;
  return html`<div class="empty">Đang tải…</div>`;
}

// ---------- Định dạng ----------
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const money = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
export function hm(ms) { if (!ms) return '—'; const p = parts(ms); return `${p.hour}:${p.minute}`; }
export function dt(ms) { if (!ms) return '—'; const p = parts(ms); return `${p.hour}:${p.minute} ${p.day}/${p.month}`; }
export function localInput(ms) { const p = parts(ms); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }
export function dayLabel(date, { long = false } = {}) {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = WD[d.getUTCDay()];
  return `${long ? ({ CN: 'Chủ nhật', T2: 'Thứ Hai', T3: 'Thứ Ba', T4: 'Thứ Tư', T5: 'Thứ Năm', T6: 'Thứ Sáu', T7: 'Thứ Bảy' })[wd] : wd} ${date.slice(8)}/${date.slice(5, 7)}`;
}
export function addDays(date, n) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function hours(minutes) { const h = Math.floor(minutes / 60); const m = minutes % 60; return m ? `${h}g${String(m).padStart(2, '0')}` : `${h}g`; }
export function ago(ms, now = Date.now()) {
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  if (m < 1440) return `${Math.round(m / 60)} giờ trước`;
  return dt(ms);
}

export const ROLE_LABEL = { owner: 'Chủ', manager: 'Quản lý', shift_lead: 'Trưởng ca', team_lead: 'Tổ trưởng', staff: 'Nhân viên' };
const RANK = ['staff', 'team_lead', 'shift_lead', 'manager', 'owner'];
export const atLeast = (me, role) => RANK.indexOf(me?.role) >= RANK.indexOf(role);
export const PHASE_LABEL = { open: 'Mở ca', during: 'Trong ca', close: 'Đóng ca' };
