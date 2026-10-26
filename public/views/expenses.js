// Phiếu chi: thu ngân chi từ két · quản lý chi tiền đã kết · chi chuyển khoản (chủ quán 26/10)
import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, Modal, Field, money, dt, navigate, addDays } from '../ui.js';
import { compressImage } from './checklists.js';

const first = (d) => `${d.slice(0, 8)}01`;
const ST = { done: ['Đã chi', 'ok'], pending: ['Chờ duyệt', 'warn'], rejected: ['Từ chối', 'bad'], void: ['Đã huỷ', 'muted'] };

export function ExpenseForm({ source: fixed, title, onClose }) {
  const meta = useData('/api/expenses/meta');
  const [f, setF] = useState({ source: fixed || 'drawer', amount: '', category: '', note: '', photo: '' });
  const [busy, setBusy] = useState(false);
  if (!meta.data) return html`<${Modal} title="Phiếu chi" onClose=${onClose}><${Loading} state=${meta} /><//>`;
  const m = meta.data;
  const pick = async (e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) setF({ ...f, photo: await compressImage(file) }); };
  const amt = Number(String(f.amount).replace(/\D/g, '')) || 0;
  const save = async () => { setBusy(true); try { if (await act(() => api('POST', '/api/expenses', { ...f, amount: amt }), 'Đã ghi phiếu chi')) onClose(); } finally { setBusy(false); } };
  return html`<${Modal} title=${title || (fixed === 'drawer' ? '➖ Chi từ két' : 'Phiếu chi')} onClose=${onClose}>
    <div class="stack">
      ${!fixed ? html`<div class="field"><span>Chi từ đâu</span><div class="stack tight">${m.sources.map((s) => html`<button class=${`chip ${f.source === s.key ? 'on' : ''}`} onClick=${() => setF({ ...f, source: s.key })}>${s.name}</button>`)}</div></div>` : null}
      <${Field} label="Số tiền (đ)"><input inputmode="numeric" value=${f.amount} placeholder="vd 150.000" onInput=${(e) => setF({ ...f, amount: e.target.value.replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.') })} /><//>
      ${f.source === 'drawer' && amt > m.approve_over && !m.is_boss ? html`<small class="warn-text">Trên ${money(m.approve_over)}: trưởng ca / quản lý phải duyệt.</small>` : null}
      <div class="field"><span>Loại chi</span><div class="row wrap">${m.categories.map((c) => html`<button class=${`chip ${f.category === c ? 'on' : ''}`} onClick=${() => setF({ ...f, category: c })}>${c}</button>`)}</div></div>
      <${Field} label="Nội dung"><input value=${f.note} placeholder="vd Mua 5 bao đá, ship rau" onInput=${(e) => setF({ ...f, note: e.target.value })} /><//>
      <div class="row wrap"><label class=${`button ${f.photo ? '' : 'primary'}`}>📷 ${f.photo ? 'Chụp lại' : 'Chụp hoá đơn / chứng từ (bắt buộc)'}<input type="file" accept="image/*" capture="environment" hidden onChange=${pick} /></label>
        ${f.photo ? html`<img src=${f.photo} style="width:64px;height:64px;object-fit:cover;border-radius:8px" />` : null}</div>
      <small class="muted">Trả nhà cung cấp: dùng Mua hàng → Công nợ để trừ đúng công nợ NCC.</small>
      <button class="primary big" disabled=${busy || !amt || !f.note.trim() || !f.photo || !f.category} onClick=${save}>Ghi chi ${amt ? money(amt) : ''}</button>
    </div>
  <//>`;
}

export function ExpensesView({ me }) {
  const [to, setTo] = useState(me.today);
  const boss = ['manager', 'owner'].includes(me.role);
  const from = boss ? `${to.slice(0, 8)}01` : to;
  const d = useData(`/api/expenses?from=${from}&to=${to}`);
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState('');
  if (!d.data) return html`<${Loading} state=${d} />`;
  const x = d.data;
  const h = x.holding;
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row"><button class="icon" onClick=${() => setTo(boss ? addDays(first(to), -1) : addDays(to, -1))}>‹</button>
        <b>${boss ? `Tháng ${to.slice(5, 7)}/${to.slice(0, 4)}` : to.split('-').reverse().join('/')}</b>
        <button class="icon" disabled=${to >= me.today} onClick=${() => { const n = boss ? addDays(first(addDays(first(to), 62)), -1) : addDays(to, 1); setTo(n > me.today ? me.today : n); }}>›</button></div>
      <button class="primary" onClick=${() => setForm(true)}>➕ Phiếu chi</button>
    </div>
    ${h && boss ? html`<button class="card row between" onClick=${() => navigate('/bao-cao?tab=tien')}><span>💼 Tiền mặt đang giữ: <b class="num">${money(h.total)}</b></span><small class="muted">Tiền hiện có →</small></button>` : null}
    <div class="grid-2">
      <div class="card"><small class="muted">Tổng chi ${boss ? 'tháng' : 'hôm nay'}</small><h3 class="num">${money(x.total)}</h3>${x.pending ? html`<small class="warn-text">${x.pending} phiếu chờ duyệt</small>` : null}</div>
      ${x.by_source.map((s) => html`<div class="card"><small class="muted">${s.name}</small><h3 class="num">${money(s.total)}</h3></div>`)}
      ${boss ? html`<div class="card" onClick=${() => navigate('/mua-hang?tab=congno')}><small class="muted">Trả nhà cung cấp →</small><h3 class="num">${money(x.ncc_total)}</h3><small class="muted">xem Công nợ NCC</small></div>` : null}
    </div>
    ${x.by_category.length ? html`<section class="card stack"><b>Theo loại chi</b>${x.by_category.map((c) => html`<div class="row between"><span>${c.name}</span><b class="num">${money(c.total)}</b></div>`)}</section>` : null}
    <section class="stack"><b>Phiếu chi</b>
      ${x.list.length ? x.list.map((e) => { const [l, cls] = ST[e.status]; return html`<div class="card tight stack">
        <div class="row between" onClick=${() => setOpen(open === e.id ? '' : e.id)}><span><b>${money(e.amount)}</b> · ${e.category}</span><span class=${`pill ${cls}`}>${l}</span></div>
        <small class="muted">${e.date.split('-').reverse().join('/')} · ${e.source_name} · ${e.created_by_name}${e.approved_by_name && e.status !== 'done' ? '' : ''} · ${e.note}</small>
        ${open === e.id ? html`<a href=${`/api/expenses/${e.id}/photo`} target="_blank"><img src=${`/api/expenses/${e.id}/photo`} style="max-width:100%;max-height:260px;border-radius:8px" /></a>
          <small class="muted">Ghi lúc ${dt(e.created_at)}${e.approved_by_name ? ` · duyệt: ${e.approved_by_name}` : ''}${e.decision_note ? ` · ${e.decision_note}` : ''}</small>` : null}
        <div class="row wrap">
          ${e.status === 'pending' && ['shift_lead', 'manager', 'owner'].includes(me.role) && e.created_by !== me.id ? html`<button class="small primary" onClick=${() => act(() => api('POST', `/api/expenses/${e.id}/approve`, {}), 'Đã duyệt')}>✅ Duyệt</button>
            <button class="small" onClick=${() => { const n = prompt('Lý do từ chối?'); if (n != null) act(() => api('POST', `/api/expenses/${e.id}/approve`, { reject: true, note: n }), 'Đã từ chối'); }}>Từ chối</button>` : null}
          ${['done', 'pending'].includes(e.status) && (boss || (e.created_by === me.id && e.date === me.today)) ? html`<button class="small link" onClick=${() => { const n = prompt('Huỷ phiếu chi này? Lý do:', 'Ghi nhầm'); if (n != null) act(() => api('POST', `/api/expenses/${e.id}/void`, { note: n }), 'Đã huỷ'); }}>Huỷ phiếu</button>` : null}
        </div></div>`; }) : html`<p class="muted">Chưa có phiếu chi.</p>`}
    </section>
    ${form ? html`<${ExpenseForm} onClose=${() => setForm(false)} />` : null}
  </div>`;
}

// Tiền hiện có (Báo cáo → 💰 Tiền hiện có): tiền mặt đang giữ + số dư tài khoản; cổ đông chi từ đây
export function MoneyNow({ me }) {
  const d = useData('/api/money/now');
  const [form, setForm] = useState('');
  if (!d.data) return html`<${Loading} state=${d} />`;
  const { holding: h, bank: b, total, recent } = d.data;
  const day = (x) => x.split('-').reverse().slice(0, 2).join('/');
  return html`<div class="stack">
    <section class="card stack">
      <small class="muted">Tổng tiền quán đang có</small>
      <h2 class="num" style="margin:0">${money(total)}</h2>
      <small class="muted">= tiền mặt đang giữ + số dư tài khoản${b.balance == null ? ' (chưa có số dư tài khoản)' : ''}</small>
    </section>
    <div class="grid-2">
      <section class="card stack">
        <b>💵 Tiền mặt đang giữ</b><h3 class="num" style="margin:0">${money(h.total)}</h3>
        <small class="muted">Từ ${h.start.split('-').reverse().join('/')}: đầu ${money(h.opening)} + thu ngân nộp các ngày đã chốt ${money(h.envelopes)} − chi ${money(h.spent)} − trả NCC ${money(h.ncc)} − nộp ngân hàng ${money(h.deposits)}</small>
        <button class="primary" onClick=${() => setForm('manager')}>➖ Chi tiền mặt</button>
        ${me.role === 'owner' ? html`<button class="link small" onClick=${() => { const v0 = prompt('Số tiền mặt đang giữ hiện tại (tính từ hôm nay):', ''); if (v0 != null) act(() => api('PUT', '/api/expenses/settings', { opening: v0 }), 'Đã đặt số đang giữ'); }}>Đặt lại số đang giữ</button>` : null}
      </section>
      <section class="card stack">
        <b>🏦 Số dư tài khoản</b><h3 class="num" style="margin:0">${b.balance == null ? '—' : money(b.balance)}</h3>
        <small class="muted">${b.balance == null ? 'Nhập số dư đầu kỳ ở Thu ngân → Số dư tài khoản (chỉ 1 lần, các ngày sau tự gối đầu).'
          : `${b.entered ? 'Số dư thật đã ghi hôm nay' : `Tính tới giờ: đầu ngày ${money(b.opening)} + CK vào ${money(b.ck_in)} − chi CK ${money(b.ck_out)}`}`}</small>
        <button class="primary" onClick=${() => setForm('bank')}>➖ Chi CK</button>
      </section>
    </div>
    <section class="stack"><b>Tiền ra 30 ngày gần đây</b>
      ${recent.length ? recent.map((x) => html`<div class="card tight row between">
        <span style="min-width:0"><b>${x.what}</b><br /><small class="muted">${day(x.date)} · ${x.from === 'bank' ? '🏦 chuyển khoản' : '💵 tiền mặt'}${x.by ? ` · ${x.by}` : ''}${x.status === 'pending' ? ' · chờ duyệt' : ''}</small></span>
        <b class="num">−${money(x.amount)}</b></div>`) : html`<p class="muted">Chưa có khoản chi.</p>`}
      <button class="link small" onClick=${() => navigate('/chi')}>Xem tất cả phiếu chi →</button>
    </section>
    ${form ? html`<${ExpenseForm} source=${form} title=${form === 'bank' ? '➖ Chi chuyển khoản' : '➖ Chi tiền mặt đang giữ'} onClose=${() => setForm('')} />` : null}
  </div>`;
}
