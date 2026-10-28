import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, Modal, Field, money, hm, atLeast, addDays, dayLabel, toast, bump } from '../ui.js';
import qrcode from '../vendor/qrcode.js';
import { compressImage } from './checklists.js';
import { ExpenseForm } from './expenses.js';

const num = (s) => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;
const METHOD = { cash: 'Tiền mặt', transfer: 'Chuyển khoản', mixed: 'TM + CK' };

export function QR({ data, size = 240 }) {
  if (!data) return null;
  const q = qrcode(0, 'M');
  q.addData(data);
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
  return html`<svg class="qr" viewBox=${`-4 -4 ${n + 8} ${n + 8}`} width=${size} height=${size} shape-rendering="crispEdges"><rect x="-4" y="-4" width=${n + 8} height=${n + 8} fill="#fff" /><path d=${d} fill="#000" /></svg>`;
}

function BillLines({ b }) {
  return html`<div class="stack small">
    ${b.lines.map((l) => html`<div class="row between"><span>${l.qty} × ${l.name}${l.options ? html`<br /><small class="muted">${l.options}</small>` : null}
      ${l.promos.map((p) => html`<br /><small class="promo-line">🎁 ${p.name}${p.free_qty ? ` (tặng ${p.free_qty})` : ''} −${money(p.amount)}</small>`)}</span><span class="num">${money(l.total)}</span></div>`)}
    <div class="totals">
      <div class="row between"><span>Tiền hàng (${b.count})</span><span class="num">${money(b.subtotal)}</span></div>
      ${b.item_discount ? html`<div class="row between promo-line"><span>Khuyến mãi món</span><span class="num">−${money(b.item_discount)}</span></div>` : null}
      ${b.bill_promos.map((p) => html`<div class="row between promo-line"><span>🎁 ${p.name}</span><span class="num">−${money(p.amount)}</span></div>`)}
      <div class="row between total"><b>TỔNG CỘNG</b><b class="num">${money(b.total)}</b></div>
    </div>
  </div>`;
}

// Tính tiền: phục vụ / thu ngân. CK: khách quét QR → bấm "Khách đã CK" → bill đóng, bàn trống.
export const isCashier = (me) => atLeast(me, 'shift_lead') || me?.team?.name === 'Thu ngân';
// Đóng bill / thu tiền: chỉ chủ quán + tổ Thu ngân (chủ quán 24/10)
export const canCollect = (me) => me?.role === 'owner' || me?.team?.name === 'Thu ngân';

export function PayModal({ me, id, onClose, onDone, defaultMethod = 'transfer' }) {
  const st = useData(`/api/pos/sessions/${id}/bill`);
  const [method, setMethod] = useState(defaultMethod);
  const cashier = canCollect(me);
  const [given, setGiven] = useState('');
  const [cashPart, setCashPart] = useState('');
  const [keep, setKeep] = useState(false);
  const [tipCk, setTipCk] = useState('');
  const [busy, setBusy] = useState(false); // chống bấm 2 lần khi đang gửi (rà soát 28/10)
  if (!st.data) return html`<${Modal} title="Tính tiền" onClose=${onClose}><${Loading} state=${st} /><//>`;
  const b = st.data;
  // Ngân hàng báo tiền về trong lúc đang mở bảng này → bill tự đóng
  if (b.status === 'closed') {
    return html`<${Modal} title=${`Bàn ${b.header} · bill ${b.bill_no}`} onClose=${() => onDone({ auto: true })}>
      <div class="stack center">
        <div class="paid-ok">✓</div>
        <h3>Đã nhận ${money(b.bank_received || b.total)}</h3>
        <p>${b.closed_auto ? 'Ngân hàng báo tiền về, bill tự đóng.' : 'Bill đã đóng.'} Bàn đã trống.${b.tip_transfer ? ` Khách CK dư ${money(b.tip_transfer)} → tip quỹ chung.` : ''}</p>
        <button class="primary big" onClick=${() => onDone({ auto: true })}>Xong</button>
      </div>
    <//>`;
  }
  const cash = num(given);
  const part = Math.min(num(cashPart), b.total);
  // Đã nhận CK một phần (ngân hàng báo về): tiền mặt chỉ thu phần còn lại (rà soát 28/10)
  const due = Math.max(0, b.total - (b.bank_received || 0));
  const pay = async (confirm = false) => {
    if (busy && !confirm) return;
    const body = { method, cash_given: method === 'cash' ? cash || '' : undefined, keep_change: method === 'cash' && keep && cash > due, cash_amount: method === 'mixed' ? part : undefined, confirm_unserved: confirm, tip_transfer: method !== 'cash' && num(tipCk) ? num(tipCk) : undefined, print: cashier && method !== 'transfer' };
    setBusy(true);
    try {
      const r = await api('POST', `/api/pos/sessions/${id}/pay`, body);
      if (r.waiting) { toast('Đã báo thu ngân, chờ xác nhận tiền về'); onClose(); return; }
      onDone(r);
    } catch (e) {
      if (e.status === 409 && /chưa bấm/.test(e.message)) { if (confirm_(e.message)) return pay(true); return; }
      act(() => Promise.reject(e));
    } finally { setBusy(false); }
  };
  const printBill = () => act(() => api('POST', `/api/pos/sessions/${id}/print-bill`), 'Đã gửi in bill');
  const rounds = [...new Set([due, Math.ceil(due / 50000) * 50000, Math.ceil(due / 100000) * 100000, Math.ceil(due / 500000) * 500000, 1000000].filter((x) => x >= due))].slice(0, 4);
  const qrData = method === 'mixed' ? null : b.qr;
  return html`<${Modal} title=${`Tính tiền bàn ${b.header} · bill ${b.bill_no}`} onClose=${onClose}>
    <div class="stack">
      ${b.unsent ? html`<p class="warn-text">Còn ${b.unsent} món chưa gửi bếp. Gửi hoặc xoá trước khi tính tiền.</p>` : null}
      ${b.unserved ? html`<p class="warn-text small">Còn ${b.unserved} món chưa bấm "Đã ra": hỏi khách đã nhận đủ món chưa.</p>` : null}
      <${BillLines} b=${b} />
      <div class="tabs">${Object.entries(METHOD).filter(([k]) => cashier || k !== 'mixed').map(([k, l]) => html`<button class=${method === k ? 'on' : ''} onClick=${() => setMethod(k)}>${l}</button>`)}</div>
      ${method === 'transfer' ? html`<div class="stack center">
        <${QR} data=${qrData} />
        ${b.bank_received ? html`<div class="warn-text">Đã nhận ${money(b.bank_received)} · còn thiếu <b>${money(b.qr_amount)}</b> (mã đã đổi theo số còn thiếu)</div>` : null}
        <div><b>${b.bank_name} · ${money(b.qr_amount)}</b><br /><small>Nội dung: <b>${b.transfer_note}</b> (có sẵn trong mã)</small></div>
        ${b.sepay ? html`<p class="small ok-text">● Đang nối ngân hàng: khách chuyển xong, tiền về là bill <b>tự đóng</b>, không cần bấm.</p>
          <p class="muted small">Khách báo đã chuyển mà chưa thấy app đóng (ngân hàng chậm) thì bấm nút dưới để mở bàn trước; tiền về app tự khớp, quá 30′ chưa về app báo quản lý.</p>`
          : html`<p class="muted small">Khách quét mã trên màn hình hoặc bill in. Thấy màn hình app ngân hàng của khách báo chuyển thành công thì bấm nút dưới. Thu ngân đối soát với sao kê sau.</p>`}
        ${!b.sepay ? html`<${Field} label="Khách CK thêm tip (nếu có)" hint="Thu ngân lấy đúng số này tiền mặt trong két bỏ thùng tip. App tự trừ khỏi két phải có.">
          <input inputmode="numeric" placeholder="0" value=${tipCk} onInput=${(e) => setTipCk(e.target.value)} /><//>` : null}
        ${cashier ? html`<button class=${`${b.sepay ? '' : 'primary'} big`} disabled=${b.unsent || busy} onClick=${() => pay()}>${b.sepay ? 'Khách đã CK, chờ tiền về · mở bàn' : '✓ Đã nhận CK · đóng bill'}</button>`
          : html`<p class="hint card small">Khách CK xong: <b>chụp màn hình chuyển khoản gửi nhóm thu ngân</b>. Thu ngân duyệt là bill đóng, bàn trống.</p>`}
      </div>` : null}
      ${method === 'cash' && !cashier ? html`<div class="stack center">
        <div class="total-big">Báo khách: <b>${money(due)}</b></div>
        ${b.bank_received ? html`<p class="warn-text small">Ngân hàng đã báo nhận CK ${money(b.bank_received)}: chỉ thu tiền mặt phần còn lại.</p>` : null}
        <p class="hint card small">Nhận tiền của khách, <b>đem lại quầy cho thu ngân</b>. Thu ngân xác nhận là in bill đưa khách, bàn trống.</p>
      </div>` : null}
      ${method === 'cash' && cashier ? html`<div class="stack">
        ${b.bank_received ? html`<p class="warn-text small">Ngân hàng đã báo nhận CK ${money(b.bank_received)}: chỉ thu tiền mặt <b>${money(due)}</b>.</p>` : null}
        <${Field} label="Khách đưa"><input inputmode="numeric" placeholder=${money(due)} value=${given} onInput=${(e) => setGiven(e.target.value)} /><//>
        <div class="chips">${rounds.map((x) => html`<button class="chip" onClick=${() => setGiven(String(x))}>${money(x)}</button>`)}</div>
        ${cash ? html`<div class="row between total"><b>Tiền thối</b><b class=${`num ${cash < due ? 'danger-text' : ''}`}>${cash < due ? `Thiếu ${money(due - cash)}` : keep ? '0đ (tip)' : money(cash - due)}</b></div>` : null}
        ${cash > due ? html`<label class="check-row"><input type="checkbox" checked=${keep} onChange=${(e) => setKeep(e.target.checked)} /> Khách không lấy tiền thối → ${money(cash - due)} vào tip quỹ chung</label>` : null}
        <p class="muted small">Tiền vào thẳng két. Bấm xong máy <b>tự in bill</b> đưa khách.</p>
        <button class="primary big" disabled=${b.unsent || busy || (cash && cash < due)} onClick=${() => pay()}>✓ Đã thu tiền mặt · đóng bill + in bill</button>
      </div>` : null}
      ${method === 'mixed' && cashier ? html`<div class="stack">
        <${Field} label="Phần tiền mặt"><input inputmode="numeric" placeholder="vd 100000" value=${cashPart} onInput=${(e) => setCashPart(e.target.value)} /><//>
        ${part > 0 && part < b.total ? html`<div class="stack center"><div>Chuyển khoản phần còn lại: <b>${money(b.total - part)}</b></div>
          <${MixedQR} id=${id} amount=${b.total - part} b=${b} /></div>` : html`<p class="muted small">Nhập số tiền mặt khách đưa, phần còn lại khách chuyển khoản.</p>`}
        <button class="primary big" disabled=${b.unsent || busy || !(part > 0 && part < b.total)} onClick=${() => pay()}>✓ Đã thu đủ · đóng bill</button>
      </div>` : null}
      <div class="row between"><button onClick=${printBill}>🖨 In bill${method === 'transfer' ? ' (có QR)' : ''}</button><button onClick=${onClose}>Thôi</button></div>
    </div>
  <//>`;
}

// QR cho phần CK của bill kết hợp: tạo ở trình duyệt từ mã gốc (đổi số tiền) qua máy chủ để đúng chuẩn
function MixedQR({ amount, b }) {
  const st = useData(`/api/payments/qr?amount=${amount}&note=${encodeURIComponent(b.transfer_note)}`);
  return st.data ? html`<${QR} data=${st.data.qr} size=${200} />` : null;
}

function confirm_(msg) { return window.confirm(`${msg}\n\nBấm OK nếu khách xác nhận đã nhận đủ món.`); }

// Hoàn tiền mặt cho bill đã trả (khách báo thiếu / lỗi món). Quản lý duyệt bằng PIN.
export function RefundModal({ me, id, onClose }) {
  const st = useData(`/api/pos/sessions/${id}/bill`);
  const [pick, setPick] = useState({});
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  if (!st.data) return html`<${Modal} title="Hoàn tiền" onClose=${onClose}><${Loading} state=${st} /><//>`;
  const b = st.data;
  const manager = atLeast(me, 'manager');
  const chosen = b.lines.filter((l) => pick[l.id] > 0);
  const est = chosen.reduce((n, l) => n + Math.round((l.net * pick[l.id]) / l.qty / 1000) * 1000, 0);
  const send = async () => {
    const r = await act(() => api('POST', `/api/pos/sessions/${id}/refund`, { items: chosen.map((l) => ({ id: l.id, qty: pick[l.id] })), reason, approver_pin: manager ? undefined : pin }), 'Đã hoàn tiền, đang in phiếu');
    if (r) { alert(`Đưa khách ${money(r.amount)} tiền mặt, nhờ khách ký phiếu hoàn tiền.`); onClose(); }
  };
  return html`<${Modal} title=${`Hoàn tiền · bill ${b.bill_no} · bàn ${b.header}`} onClose=${onClose}>
    <div class="stack">
      <p class="muted small">Bill đã trả không sửa được. Chọn món thiếu / lỗi, app tính số tiền khách đã trả cho phần đó (đã trừ khuyến mãi) và in phiếu hoàn tiền. Món bếp chưa làm sẽ có phiếu HUỶ.</p>
      ${b.lines.map((l) => {
        const left = l.qty - l.refunded_qty;
        const q = pick[l.id] || 0;
        return html`<div class="row between"><span class="grow"><b>${l.name}</b><br /><small class="muted">${l.qty} phần · đã trả ${money(l.net)}${l.refunded_qty ? ` · đã hoàn ${l.refunded_qty}` : ''}${l.status === 'sent' ? ' · bếp chưa ra' : ''}</small></span>
          ${left > 0 ? html`<div class="row tight"><button class="icon" onClick=${() => setPick({ ...pick, [l.id]: Math.max(0, q - 1) })}>−</button><b>${q}</b><button class="icon" onClick=${() => setPick({ ...pick, [l.id]: Math.min(left, q + 1) })}>+</button></div>` : html`<small class="muted">đã hoàn hết</small>`}</div>`;
      })}
      <${Field} label="Lý do"><input value=${reason} onInput=${(e) => setReason(e.target.value)} placeholder="vd Chưa ra món" /><//>
      <div class="chips">${['Chưa ra món', 'Món lỗi', 'Tính nhầm', 'Khách đổi ý'].map((x) => html`<button class=${`chip ${reason === x ? 'on' : ''}`} onClick=${() => setReason(x)}>${x}</button>`)}</div>
      ${manager ? null : html`<${Field} label="Quản lý nhập PIN để duyệt"><input type="password" inputmode="numeric" autocomplete="off" value=${pin} onInput=${(e) => setPin(e.target.value)} /><//>`}
      ${chosen.length ? html`<div class="row between total"><b>Hoàn tiền mặt (ước tính)</b><b class="num">${money(est)}</b></div>` : null}
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="danger" disabled=${!chosen.length || !reason.trim() || (!manager && pin.length < 4)} onClick=${send}>Hoàn tiền</button></div>
    </div>
  <//>`;
}

const CK_LABEL = { pending: ['warn', 'chờ tiền về'], matched: ['ok', 'ngân hàng đã báo tiền về'], confirmed: ['ok', 'thu ngân đã xác nhận'], missing: ['bad', 'CHƯA THẤY TIỀN'] };

export function PaidPanel({ me, id }) {
  const st = useData(`/api/pos/sessions/${id}/bill`);
  const [refund, setRefund] = useState(false);
  const [change, setChange] = useState(false);
  if (!st.data) return null;
  const b = st.data;
  const ck = CK_LABEL[b.reconcile_status];
  return html`<section class="card stack">
    <div class="row between wrap"><b>✓ Đã thanh toán · bill ${b.bill_no}</b><span class="pill ok">${METHOD[b.pay_method] || ''}</span></div>
    <div class="small">${b.closed_auto ? 'Tự đóng khi tiền về' : `Đóng bởi ${b.cashier}`} · ${hm(b.closed_at)}</div>
    <div class="row wrap small">
      ${b.cash_amount + b.tip_cash ? html`<span class=${`pill ${b.cash_status === 'received' ? 'ok' : 'warn'}`}>Tiền mặt ${money(b.cash_amount + b.tip_cash)}: ${b.cash_status === 'received' ? 'thu ngân đã xác nhận' : 'chờ thu ngân xác nhận'}</span>` : null}
      ${ck ? html`<span class=${`pill ${ck[0]}`}>CK ${money(b.transfer_amount)}: ${ck[1]}</span>` : null}
      ${b.tip_cash + b.tip_transfer ? html`<span class="pill">Tip ${money(b.tip_cash + b.tip_transfer)}</span>` : null}
    </div>
    <${BillLines} b=${b} />
    ${b.refunds.map((r) => html`<div class="row between small danger-text"><span>Hoàn tiền mặt ${hm(r.created_at)}: ${r.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')} (${r.reason}) · ${r.by_name}, duyệt ${r.approver_name}</span><span class="num">−${money(r.amount)}</span></div>`)}
    <div class="row wrap">
      <button onClick=${() => act(() => api('POST', `/api/pos/sessions/${id}/print-bill`), 'Đã gửi in lại bill')}>🖨 In lại bill</button>
      ${isCashier(me) ? html`<button onClick=${() => setChange(true)}>Đổi cách thanh toán…</button>` : null}
      <button class="danger" onClick=${() => setRefund(true)}>Hoàn tiền…</button>
    </div>
    ${b.changes?.map((c) => html`<div class="small warn-text">Đổi ${hm(c.created_at)}: ${METHOD[c.from_method]} → ${METHOD[c.to_method]} · ${c.reason} · ${c.by_name}</div>`)}
    ${refund ? html`<${RefundModal} me=${me} id=${id} onClose=${() => setRefund(false)} />` : null}
    ${change ? html`<${ChangeMethod} b=${b} onClose=${() => setChange(false)} />` : null}
  </section>`;
}

// Phục vụ: tiền mặt mình đang giữ (chưa giao thu ngân) — hiện ở trang Hôm nay
export function MyCashCard() {
  const st = useData('/api/payments/my-cash');
  if (!st.data?.amount) return null;
  return html`<section class="card warn-card stack">
    <b>💵 ${money(st.data.amount)} tiền mặt chờ thu ngân xác nhận</b>
    <span class="small">${st.data.bills.map((x) => `bill ${x.bill_no} (${x.header}) ${money(x.amount)}`).join(' · ')}</span>
    <span class="small">Đưa tiền + bill cho thu ngân bấm xác nhận. Chưa xác nhận thì không chấm ra ca được.</span>
  </section>`;
}

function Amount({ value, onSave, label, placeholder }) {
  const [v, setV] = useState(value == null ? '' : String(value));
  return html`<div class="row wrap">
    <input inputmode="numeric" style="flex:1;min-width:9em" placeholder=${placeholder} value=${v} onInput=${(e) => setV(e.target.value)} />
    <button class="primary" disabled=${!String(v).trim()} onClick=${() => onSave(num(v))}>${label}</button>
  </div>`;
}

function Handover({ group, locked }) {
  const expected = group.bills.reduce((n, x) => n + x.amount, 0);
  const [counted, setCounted] = useState('');
  const c = counted === '' ? expected : num(counted);
  return html`<div class="card stack">
    <div class="row between"><b>${group.name}</b><b class="num">${money(expected)}</b></div>
    <div class="small muted">${group.bills.map((x) => `bill ${x.bill_no} · ${x.header} · ${hm(x.closed_at)} · ${money(x.amount)}${x.tip_cash ? ` (gồm tip ${money(x.tip_cash)})` : ''}`).join('\n')}</div>
    ${locked ? null : html`<div class="row wrap">
      <input inputmode="numeric" style="flex:1;min-width:9em" placeholder=${`Đếm được (mặc định ${money(expected)})`} value=${counted} onInput=${(e) => setCounted(e.target.value)} />
      <button class="primary" onClick=${() => act(() => api('POST', '/api/payments/handover', { ids: group.bills.map((x) => x.id), counted: c, note: c !== expected ? 'Đếm lệch khi nhận' : '' }), c === expected ? 'Đã xác nhận nhận đủ' : `Đã ghi lệch ${money(c - expected)}`)}>✓ Xác nhận đã nhận ${money(c)}</button>
    </div>`}
    ${c !== expected ? html`<small class="danger-text">Lệch ${money(c - expected)}: app ghi tên ${group.name} và báo chủ quán</small>` : null}
  </div>`;
}

function Unmatched({ t, me, locked }) {
  const [no, setNo] = useState('');
  const manager = atLeast(me, 'manager');
  return html`<div class="card stack small">
    <div class="row between"><b>${money(t.amount)}</b><span class="muted">${t.txn_at || hm(t.received_at)}${t.provider === 'test' ? ' · THỬ' : ''}</span></div>
    <div>"${t.content}"</div>
    ${t.status === 'review' ? html`<div class="warn-text">Bill ${t.bill_no} ghi trả tiền mặt mà vẫn có CK: phục vụ bấm nhầm, khách trả 2 lần (hoàn lại), hay tip?</div>
      ${!locked ? html`<button class="primary" onClick=${() => act(() => api('POST', `/api/pos/sessions/${t.session_id}/change-method`, { method: 'transfer', reason: 'Bấm nhầm tiền mặt, khách đã CK' }), 'Đã đổi bill sang CK')}>Bấm nhầm tiền mặt → đổi bill sang CK</button>` : null}` : null}
    ${locked ? null : html`<div class="row wrap">
      ${t.status === 'unmatched' ? html`<input inputmode="numeric" style="width:7em" placeholder="Số bill" value=${no} onInput=${(e) => setNo(e.target.value)} />
        <button class="primary" disabled=${!no} onClick=${() => act(() => api('POST', `/api/bank/txns/${t.id}/assign`, { bill_no: Number(no) }), 'Đã ghép bill')}>Ghép bill</button>` : null}
      ${manager ? html`${t.status === 'review' ? html`<button onClick=${() => act(() => api('POST', `/api/bank/txns/${t.id}/resolve`, { action: 'tip' }), 'Đã tính là tip')}>Là tip</button>` : null}
        <button onClick=${() => act(() => api('POST', `/api/bank/txns/${t.id}/resolve`, { action: 'refunded' }), 'Đã ghi hoàn lại khách')}>Đã hoàn lại khách</button>
        <button onClick=${() => confirm('Khoản này không phải tiền bán hàng (vd tiền chủ chuyển vào)?') && act(() => api('POST', `/api/bank/txns/${t.id}/resolve`, { action: 'ignore' }), 'Đã bỏ qua')}>Không phải tiền bán</button>` : html`<small class="muted">Khoản lạ: nhờ quản lý xử lý</small>`}
    </div>`}
  </div>`;
}

function SepayCard() {
  const st = useData('/api/bank/settings');
  const [amt, setAmt] = useState('');
  const [content, setContent] = useState('');
  if (!st.data) return null;
  const s = st.data;
  return html`<details class="card stack small">
    <summary><b>Nối ngân hàng (SePay)</b> · ${s.enabled ? html`<span class="ok-text">đang bật</span>` : 'chưa bật'}${s.last ? ` · giao dịch cuối ${hm(s.last.received_at)}` : ''}</summary>
    <ol style="padding-left:1.2em" class="stack">
      <li>Techcombank Business → Mở rộng → Quản lý Doanh nghiệp Bán lẻ: tìm <b>số tài khoản thanh toán thật</b> đứng sau mã cửa hàng MS00P….</li>
      <li>Đăng ký my.sepay.vn → Ngân hàng → Kết nối tài khoản → Techcombank → nhập số tài khoản đó (chọn kết nối API nếu có).</li>
      <li>SePay → Webhook → Thêm: URL <code>${s.webhook_url}</code>, sự kiện <b>Tất cả</b> (tiền vào + tiền ra), xác thực <b>API Key</b>: <code>${s.api_key || '(chủ quán xem)'}</code></li>
      <li>Bật nút dưới, rồi chuyển thử 10.000đ nội dung "CLT1" để kiểm tra.</li>
    </ol>
    ${s.api_key !== undefined ? html`<div class="row wrap">
      <button class=${s.enabled ? '' : 'primary'} onClick=${() => act(() => api('POST', '/api/bank/settings', { enabled: !s.enabled }), s.enabled ? 'Đã tắt' : 'Đã bật nhận tiền tự động')}>${s.enabled ? 'Tắt nhận tự động' : 'Bật nhận tiền tự động'}</button>
      <button onClick=${() => confirm('Đổi khoá? Phải dán khoá mới vào SePay.') && act(() => api('POST', '/api/bank/settings', { reset_key: true }), 'Đã đổi khoá')}>Đổi khoá</button>
    </div>
    <b>Tập dùng: giả lập tiền về</b>
    <div class="row wrap"><input inputmode="numeric" style="width:8em" placeholder="Số tiền" value=${amt} onInput=${(e) => setAmt(e.target.value)} />
      <input style="flex:1;min-width:8em" placeholder="Nội dung, vd CLT12" value=${content} onInput=${(e) => setContent(e.target.value)} />
      <button disabled=${!amt} onClick=${() => act(() => api('POST', '/api/bank/test', { amount: num(amt), content }), 'Đã giả lập tiền về')}>Giả lập</button></div>
    <p class="muted">Giao dịch giả lập ghi chữ THỬ. Chỉ chủ quán dùng được.</p>` : null}
  </details>`;
}

// ---------- Thu ngân: két, nhận tiền phục vụ, đối soát CK, bất thường, chốt ngày ----------
export function CashierView({ me }) {
  const [date, setDate] = useState(me.today);
  const [sel, setSel] = useState({});
  const [chi, setChi] = useState(false);
  const st = useData(`/api/payments?date=${date}`);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const s = d.summary;
  const locked = !!d.closing;
  const ck = d.bills.filter((b) => b.transfer_amount > 0);
  const toConfirm = ck.filter((b) => ['pending', 'matched'].includes(b.reconcile_status));
  const ids = Object.keys(sel).filter((k) => sel[k]).map(Number);
  const selTotal = ck.filter((b) => sel[b.id]).reduce((n, b) => n + b.transfer_amount, 0);
  const mark = (status) => act(() => api('POST', '/api/payments/reconcile', { ids, status }), status === 'confirmed' ? 'Đã xác nhận' : status === 'missing' ? 'Đã báo chủ quán' : 'Đã bỏ đánh dấu').then((ok) => ok && setSel({}));
  const groups = Object.values(d.held.reduce((g, x) => { (g[x.closed_by] ||= { name: x.staff_name, bills: [] }).bills.push(x); return g; }, {}));
  const unmatched = d.txns.filter((t) => t.direction === 'in' && ['unmatched', 'review'].includes(t.status));
  const outs = d.txns.filter((t) => t.direction === 'out');
  // Còn bàn đang mở: máy chủ chặn (409); chủ quán được chọn vẫn chốt, tiền bàn trả sau ghi sang ngày mai (rà soát 28/10)
  const closeDay = async () => {
    try { await api('POST', '/api/payments/close-day', { date }); toast('Đã chốt doanh thu, đã báo chủ quán'); bump(); } catch (e) {
      if (e.status === 409 && me.role === 'owner' && window.confirm(`${e.message}\n\nVẫn chốt ngày?`)) return act(() => api('POST', '/api/payments/close-day', { date, force: true }), 'Đã chốt doanh thu');
      toast(e.message, true);
    }
  };
  const blockers = [
    s.opening == null && 'nhập tiền két đầu ngày',
    groups.length && `xác nhận tiền mặt của ${groups.length} người`,
    unmatched.length && `xử lý ${unmatched.length} khoản CK chưa khớp`,
    s.overpay_pending && `xử lý ${s.overpay_pending} bill khách CK dư bất thường`,
    toConfirm.length && `xác nhận ${toConfirm.length} bill CK`,
    s.drawer_counted == null && 'đếm két cuối ngày',
    !d.photos?.length && 'chụp ảnh tiền đã đếm',
    d.drawer?.keep_float == null && 'ghi số tiền để lại két',
  ].filter(Boolean);
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row"><button class="icon" onClick=${() => setDate(addDays(date, -1))}>‹</button><b>${dayLabel(date, { long: true })}</b><button class="icon" onClick=${() => setDate(addDays(date, 1))}>›</button></div>
      ${locked ? html`<span class="pill ok">Đã chốt · ${d.closing.by_name} ${hm(d.closing.confirmed_at)}</span>` : null}
    </div>
    <div class="card row wrap between tip-strip"><span>Doanh thu <b class="num">${money(s.net)}</b> <small class="muted">(${s.bills} bill)</small></span>
      <span>💰 Tip hôm nay <b class="num">${money((s.tip_cash || 0) + (s.tip_transfer || 0))}</b> <small class="muted">TM ${money(s.tip_cash || 0)} · CK ${money(s.tip_transfer || 0)}</small></span></div>
    ${d.open_tables ? html`<p class="muted small">Đang còn ${d.open_tables} bàn chưa tính tiền.</p>` : null}
    ${locked && date === me.today ? html`<button class="link small" onClick=${() => setDate(addDays(date, 1))}>Ngày này đã chốt: bill / hoàn tiền / nhận tiền sau giờ chốt ghi sang ngày ${dayLabel(addDays(date, 1))} › xem</button>` : null}
    ${!locked ? html`<${WaitingTables} me=${me} />` : null}

    <section class=${`card stack ${s.opening == null && !locked ? 'warn-card' : ''}`}>
      <div class="row between"><b>1. Két đầu ngày</b>${s.opening != null ? html`<b class="num">${money(s.opening)}</b>` : null}</div>
      ${s.opening != null ? html`<small class="muted">${d.drawer.opening_by_name} ghi lúc ${hm(d.drawer.opening_at)}</small>` : null}
      ${!locked ? html`<${Amount} value=${s.opening ?? d.suggested_opening} label=${s.opening == null ? 'Ghi' : 'Sửa'} placeholder="Tiền lẻ để thối, vd 2.000.000" onSave=${(x) => act(() => api('POST', '/api/payments/drawer', { date, opening: x }), 'Đã ghi két đầu ngày')} />` : null}
      ${s.opening == null && d.suggested_opening != null ? html`<small class="muted">Hôm trước thu ngân để lại két ${money(d.suggested_opening)}. Đếm lại, đúng thì bấm Ghi; lệch thì ghi số thật (chủ quán sẽ thấy).</small>` : null}
    </section>

    <section class="stack">
      <b>2. Tiền mặt chờ thu ngân xác nhận ${s.cash_held ? html`<span class="danger-text">${money(s.cash_held)}</span>` : html`<span class="ok-text">· đã xác nhận hết</span>`}</b>
      ${groups.map((g) => html`<${Handover} key=${g.name} group=${g} locked=${locked} />`)}
      ${d.handovers.length ? html`<details class="card small"><summary>Đã nhận ${d.handovers.length} lần · ${money(s.handed_in)}${s.handover_diff ? html` · <span class="danger-text">lệch ${money(s.handover_diff)}</span>` : ''}</summary>
        ${d.handovers.map((h) => html`<div class="row between"><span>${hm(h.created_at)} ${h.staff_name} → ${h.received_by_name}</span><span>${money(h.counted)}${h.diff ? html` <b class="danger-text">(${h.diff > 0 ? '+' : ''}${money(h.diff)})</b>` : ''}</span></div>`)}</details>` : null}
    </section>

    ${d.bills.some((b) => b.overpay_status === 'pending') ? html`<section class="card stack warn-card"><b class="danger-text">Khách CK dư bất thường</b>
      <p class="muted small">Có thể khách chuyển 2 lần hoặc gõ thừa số 0. Gọi khách xác nhận: hoàn lại (chủ quán chuyển trả) hay khách cho tip.</p>
      ${d.bills.filter((b) => b.overpay_status === 'pending').map((b) => html`<div class="row between wrap"><span>${b.transfer_note} · ${b.header} · dư <b>${money(b.overpay)}</b></span>
        ${atLeast(me, 'manager') && !locked ? html`<span class="row"><button class="small" onClick=${() => act(() => api('POST', `/api/pos/sessions/${b.id}/overpay`, { action: 'refunded' }), 'Đã ghi hoàn lại khách')}>Đã hoàn lại khách</button><button class="small" onClick=${() => act(() => api('POST', `/api/pos/sessions/${b.id}/overpay`, { action: 'tip' }), 'Đã tính tip')}>Là tip</button></span>` : html`<small class="muted">nhờ quản lý</small>`}</div>`)}
    </section>` : null}
    ${unmatched.length ? html`<section class="stack"><b class="danger-text">3. Tiền CK chưa khớp bill (${unmatched.length})</b>
      <p class="muted small">Khách tự gõ số tài khoản nên thiếu mã CLT. Xem số tiền + giờ để tìm bill, nhập số bill để ghép.</p>
      ${unmatched.map((t) => html`<${Unmatched} key=${t.id} t=${t} me=${me} locked=${locked} />`)}</section>` : null}

    <section class="card stack">
      <div class="row between wrap"><b>4. Chuyển khoản (${ck.length} bill · ${money(s.transfer_in)})</b>
        ${!locked && toConfirm.length ? html`<button onClick=${() => setSel(Object.fromEntries(toConfirm.map((b) => [b.id, true])))}>Chọn tất cả chờ xác nhận</button>` : null}</div>
      <p class="muted small">${d.sepay ? 'Bill có ✓ ngân hàng đã báo tiền về. Bill "chờ tiền về" thì so với sao kê Techcombank.' : 'So tổng với sao kê Techcombank; lệch thì tìm theo nội dung CLT… từng bill.'} Ngân hàng báo tiền vào hôm nay: <b>${money(s.bank_in)}</b>.</p>
      ${ck.map((b) => {
        const l = CK_LABEL[b.reconcile_status] || ['muted', ''];
        return html`<label class="row between check-row">
          <span class="row">${!locked && b.reconcile_status !== 'confirmed' ? html`<input type="checkbox" checked=${!!sel[b.id]} onChange=${(e) => setSel({ ...sel, [b.id]: e.target.checked })} />` : null}
            <span><b>${b.transfer_note}</b> · ${b.header} · ${hm(b.closed_at)}<br /><small class="muted">${b.closed_by_name}${b.pay_method === 'mixed' ? ' · TM + CK' : ''}${b.tip_transfer ? ` · tip ${money(b.tip_transfer)}` : ''}</small></span></span>
          <span class="r"><b class="num">${money(b.transfer_amount)}</b><br /><small class=${l[0] === 'bad' ? 'danger-text' : l[0] === 'ok' ? 'ok-text' : 'muted'}>${l[1]}</small></span>
        </label>`;
      })}
      ${ids.length && !locked ? html`<div class="stack">
        <div class="row between total"><b>Đã chọn ${ids.length} bill</b><b class="num">${money(selTotal)}</b></div>
        <button class="primary big" onClick=${() => mark('confirmed')}>✓ Xác nhận đã thấy tiền (${ids.length} bill)</button>
        <div class="row wrap"><button class="danger grow" onClick=${() => mark('missing')}>Chưa thấy tiền</button><button class="grow" onClick=${() => mark('pending')}>Bỏ đánh dấu</button></div>
      </div>` : null}
    </section>

    <section class="card stack">
      <div class="row between"><b>5. Đếm két cuối ngày</b>${!locked ? html`<button class="small" onClick=${() => setChi(true)}>➖ Chi từ két</button>` : null}</div>
      ${chi ? html`<${ExpenseForm} source="drawer" onClose=${() => setChi(false)} />` : null}
      <div class="row between"><span>Phải có = đầu ngày ${money(s.opening ?? 0)} + thu tiền mặt ${money(s.cash_direct + s.handed_in)} − hoàn ${money(s.refund_cash)}${s.cash_out ? ` − chi từ két (phiếu chi, NCC, tạm ứng) ${money(s.cash_out)}` : ''}${s.tip_to_box ? ` − tip bỏ thùng ${money(s.tip_to_box)}` : ''}</span><b class="num">${s.drawer_expected == null ? '—' : money(s.drawer_expected)}</b></div>
      ${s.tip_to_box ? html`<div class="warn-text small">Trước khi đếm két: bỏ <b>${money(s.tip_to_box)}</b> vào thùng tip (tip TM ${money(s.tip_box_cash)} + tip CK ${money(s.tip_box_ck)} lấy tiền mặt bỏ vào). Chốt ngày app tự ghi phiếu chi két → thùng tip.</div>` : null}
      ${s.drawer_counted != null ? html`<div class="row between"><span>Đếm được</span><b class=${`num ${s.drawer_diff ? 'danger-text' : 'ok-text'}`}>${money(s.drawer_counted)}${s.drawer_diff ? ` (lệch ${money(s.drawer_diff)})` : ' ✓ khớp'}</b></div>` : null}
      ${!locked ? html`<${DrawerClose} date=${date} d=${d} />` : d.drawer?.denoms ? html`<${DenomView} denoms=${JSON.parse(d.drawer.denoms)} />` : null}
    </section>

    <${BankBalance} date=${date} bank=${d.bank} locked=${locked && me.role !== 'owner'} />

    <div class="grid-2">
      <div class="card"><small class="muted">Doanh thu (${s.bills} bill)</small><h3 class="num">${money(s.net)}</h3><small class="muted">Đã xác nhận ${money(s.confirmed)} · chưa ${money(s.unconfirmed)}</small></div>
      <div class="card"><small class="muted">Tip bỏ thùng hôm nay</small><h3 class="num">${money(s.tip_to_box)}</h3><small class="muted">TM ${money(s.tip_box_cash)} · CK ${money(s.tip_box_ck)}</small></div>
      <div class="card"><small class="muted">Tiền mặt bán hàng</small><h3 class="num">${money(s.cash_in)}</h3><small class="muted">Hoàn ${money(s.refund_cash)}</small></div>
      <div class="card"><small class="muted">Chuyển khoản</small><h3 class="num">${money(s.transfer_in)}</h3><small class="muted">KM đã giảm ${money(s.discount)}</small></div>
    </div>

    ${d.anomalies.length ? html`<section class="card stack"><b>⚠ Bất thường hôm nay (${d.anomalies.length})</b>
      ${d.anomalies.map((a) => html`<div class=${`small ${a.level === 'bad' ? 'danger-text' : 'warn-text'}`}>• ${a.text}</div>`)}</section>` : html`<p class="ok-text small">Không có bất thường.</p>`}

    ${outs.length ? html`<details class="card small"><summary>Tiền chi ra từ tài khoản (${outs.length} khoản · ${money(outs.reduce((n, t) => n + t.amount, 0))}) · chờ gán công nợ nhà cung cấp</summary>
      ${outs.map((t) => html`<div class="row between"><span>${t.txn_at || hm(t.received_at)} · "${t.content}"</span><b class="num">${money(t.amount)}</b></div>`)}</details>` : null}

    ${refundsBlock(d)}

    ${!locked ? html`<section class="card stack">
      ${blockers.length ? html`<b>Trước khi chốt ngày còn phải:</b>${blockers.map((x) => html`<div class="small warn-text">• ${x}</div>`)}` : html`<span class="ok-text small">Đủ điều kiện chốt ngày.</span>`}
      <button class="primary big" disabled=${blockers.length > 0} onClick=${() => confirm(`Chốt doanh thu ${money(s.net)}? Sau khi chốt không sửa được nữa, chủ quán nhận báo cáo.`) && closeDay()}>✓ Xác nhận & chốt doanh thu ngày</button>
    </section>` : null}

    <section class="card stack"><h3>Tất cả bill (${d.bills.length})</h3>
      ${d.bills.map((b) => html`<a class="row between small plain-link" href=${`/goi-mon?s=${b.id}`}><span>${b.bill_no} · ${b.header} · ${hm(b.closed_at)} · ${METHOD[b.pay_method]}</span><span class="num">${money(b.paid_total)}</span></a>`)}
    </section>
    <${TipBox} me=${me} />
    ${me.role === 'owner' || me.role === 'manager' ? html`<${SepayCard} />` : null}
  </div>`;
}

// Đối soát số dư tài khoản ngân hàng: đầu ngày + CK vào − chi CK ± khác = phải có, so với số dư thật trên app ngân hàng
function BankBalance({ date, bank: b, locked }) {
  const [f, setF] = useState({ opening: b.carried ? '' : b.opening ?? '', closing: b.closing ?? '', other_in: b.other_in || '', other_out: b.other_out || '', note: b.note || '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => act(() => api('POST', '/api/payments/bank-balance', { date, ...f }), 'Đã ghi số dư');
  return html`<section class=${`card stack ${b.diff ? 'warn-card' : ''}`}>
    <b>6. Số dư tài khoản ngân hàng</b>
    <p class="muted small">Mở app ngân hàng xem số dư lúc mở ca và lúc chốt. App tự cộng tiền CK đã nhận, trừ tiền trả NCC bằng CK.</p>
    <div class="row between"><span>Số dư đầu ngày${b.carried ? html` <small class="muted">(gối đầu từ cuối ngày hôm trước)</small>` : ''}</span><b class="num">${b.opening == null ? '—' : money(b.opening)}</b></div>
    <div class="row between"><span>+ CK vào (bill + tip CK + CK dư)</span><b class="num">${money(b.ck_in)}</b></div>
    <div class="row between"><span>− Chi bằng CK (trả NCC${b.ck_out > b.ck_out_ncc ? ', hoàn khách' : ''})</span><b class="num">${money(b.ck_out)}</b></div>
    ${b.other_in || b.other_out ? html`<div class="row between"><span>± Khác (nộp tiền mặt, lãi, phí…)${b.note ? ` · ${b.note}` : ''}</span><b class="num">${money((b.other_in || 0) - (b.other_out || 0))}</b></div>` : null}
    <div class="row between total"><b>Phải có</b><b class="num">${b.expected == null ? '—' : money(b.expected)}</b></div>
    ${b.closing != null ? html`<div class="row between"><span>Số dư thật</span><b class=${`num ${b.diff ? 'danger-text' : 'ok-text'}`}>${money(b.closing)}${b.diff ? ` (lệch ${b.diff > 0 ? '+' : ''}${money(b.diff)})` : ' ✓ khớp'}</b></div>` : null}
    ${!locked ? html`<div class="form-grid">
      ${b.opening == null || !b.carried ? html`<${Field} label="Số dư đầu ngày" hint="Chỉ nhập lần đầu; các ngày sau app tự lấy số dư cuối ngày hôm trước"><input inputmode="numeric" value=${f.opening} onInput=${set('opening')} /><//>` : null}
      <${Field} label="Số dư cuối ngày (thật)"><input inputmode="numeric" value=${f.closing} onInput=${set('closing')} /><//>
    </div>
    <details open=${!!(b.other_in || b.other_out || b.diff)}><summary class="small">Có khoản khác (nộp tiền mặt vào TK, lãi, phí, rút tiền…)</summary><div class="form-grid">
      <${Field} label="Thu khác vào TK" hint="vd nộp tiền mặt vào TK, lãi"><input inputmode="numeric" value=${f.other_in} onInput=${set('other_in')} /><//>
      <${Field} label="Chi khác từ TK" hint="vd phí ngân hàng, rút tiền"><input inputmode="numeric" value=${f.other_out} onInput=${set('other_out')} /><//>
      <${Field} label="Ghi chú khoản khác"><input value=${f.note} onInput=${set('note')} /><//>
    </div></details><button class="primary" onClick=${save}>Ghi số dư</button>` : null}
  </section>`;
}

// Thùng tip: số dư, đếm thùng, chia tip cuối tháng theo giờ công → phiếu chi
function TipBox({ me }) {
  const st = useData('/api/tip-box');
  const [count, setCount] = useState('');
  const [payout, setPayout] = useState(false);
  const [slip, setSlip] = useState(null);
  if (!st.data) return null;
  const t = st.data;
  const KIND = { in_cash: 'Tip TM vào thùng', in_ck: 'Tip CK (lấy TM bỏ thùng)', payout: 'Chia tip', count: 'Đếm thùng', adjust: 'Chủ quán chỉnh' };
  return html`<section class="card stack">
    <div class="row between"><b>🫙 Thùng tip (quỹ chung)</b><b class="num">${money(t.balance)}</b></div>
    <small class="muted">Tip TM + tip CK đều bỏ thùng; thu ngân giữ, cuối tháng chia. ${t.last_payout ? `Lần chia gần nhất ${dayLabel(t.last_payout.date)} · ${money(-t.last_payout.amount)}.` : 'Chưa chia lần nào.'}${t.last_count ? ` Đếm gần nhất ${dayLabel(t.last_count.date)}: ${money(t.last_count.counted)} (${t.last_count.note}).` : ''}</small>
    <div class="row wrap"><input class="grow" inputmode="numeric" placeholder="Đếm thùng được bao nhiêu" value=${count} onInput=${(e) => setCount(e.target.value)} />
      <button disabled=${!count} onClick=${() => act(() => api('POST', '/api/tip-box/count', { counted: count }), 'Đã ghi số đếm').then((r) => { if (r) { setCount(''); toast(r.diff ? `Lệch ${money(r.diff)} so với sổ ${money(r.balance)}: đã báo chủ quán` : 'Khớp sổ', !!r.diff); } })}>Ghi đếm</button>
      <button class="primary" disabled=${t.balance <= 0} onClick=${() => setPayout(true)}>Chia tip</button></div>
    <details class="small"><summary>Sổ thùng tip (${t.moves.length})</summary>
      ${t.moves.map((m) => html`<div class="row between"><span>${dayLabel(m.date)} · ${KIND[m.kind] || m.kind}${m.kind === 'count' ? ` ${money(m.counted)} · ${m.note}` : ''}${m.kind === 'payout' ? html` · <button class="link small" onClick=${() => setSlip(m)}>Phiếu chi #${m.id}</button>` : ''}</span>
        ${m.kind !== 'count' ? html`<b class=${`num ${m.amount < 0 ? 'danger-text' : ''}`}>${m.amount > 0 ? '+' : ''}${money(m.amount)}</b>` : null}</div>`)}</details>
    ${payout ? html`<${TipPayout} me=${me} balance=${t.balance} onClose=${() => setPayout(false)} onDone=${(m) => { setPayout(false); setSlip(m); }} />` : null}
    ${slip ? html`<${TipSlip} m=${slip} onClose=${() => setSlip(null)} />` : null}
  </section>`;
}

function TipPayout({ me, balance, onClose, onDone }) {
  const today = me.today;
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const sg = useData(`/api/tip-box/suggest?from=${from}&to=${to}&amount=${balance}`);
  const [lines, setLines] = useState(null);
  const ls = lines || sg.data?.lines || [];
  const total = ls.reduce((n, l) => n + (Number(l.amount) || 0), 0);
  const save = async () => {
    const r = await act(() => api('POST', '/api/tip-box/payout', { from, to, lines: ls.map((l) => ({ ...l, amount: Number(l.amount) || 0 })) }), 'Đã lập phiếu chi tip, đã báo chủ quán');
    if (r) onDone({ id: r.id, date: today, amount: -r.total, period_from: from, period_to: to, lines: ls.filter((l) => Number(l.amount) > 0), by_name: me.name });
  };
  return html`<${Modal} title=${`Chia tip · thùng có ${money(balance)}`} onClose=${onClose} wide>
    <div class="stack">
      <div class="row wrap"><${Field} label="Từ ngày"><input type="date" value=${from} onChange=${(e) => { setFrom(e.target.value); setLines(null); }} /><//>
        <${Field} label="Đến ngày"><input type="date" value=${to} onChange=${(e) => { setTo(e.target.value); setLines(null); }} /><//></div>
      <p class="muted small">App gợi ý chia theo giờ công (chấm công) trong kỳ. Sửa số tiền từng người nếu quán chia cách khác; để 0 là không nhận.</p>
      ${!sg.data ? html`<${Loading} state=${sg} />` : ls.map((l, i) => html`<div class="row between"><span>${l.name} <small class="muted">${l.team || ''} · ${l.hours ?? '—'} giờ</small></span>
        <input class="unit" inputmode="numeric" value=${l.amount} onInput=${(e) => setLines(ls.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/\D/g, '') } : x)))} /></div>`)}
      <div class="row between total"><b>Tổng chia</b><b class=${`num ${total > balance ? 'danger-text' : ''}`}>${money(total)}${total < balance ? ` · còn lại thùng ${money(balance - total)}` : ''}</b></div>
      <button class="primary big" disabled=${!total || total > balance} onClick=${save}>Lập phiếu chi tip ${money(total)}</button>
    </div>
  <//>`;
}

// Phiếu chi tip in ra cho từng người ký nhận
function TipSlip({ m, onClose }) {
  return html`<${Modal} title=${`Phiếu chi tip #${m.id}`} onClose=${onClose} wide>
    <div class="stack print-area">
      <h3 class="center">PHIẾU CHI TIP #${m.id}</h3>
      <div class="center small">Ngày ${dayLabel(m.date, { long: true })}${m.period_from ? ` · kỳ ${dayLabel(m.period_from)} → ${dayLabel(m.period_to)}` : ''} · người chi: ${m.by_name || ''}</div>
      <table class="slip-table"><thead><tr><th>Họ tên</th><th>Giờ</th><th class="r">Số tiền</th><th>Ký nhận</th></tr></thead>
        <tbody>${(m.lines || []).map((l) => html`<tr><td>${l.name}</td><td>${l.hours ?? ''}</td><td class="r num">${money(l.amount)}</td><td style="min-width:90px"></td></tr>`)}</tbody>
        <tfoot><tr><td colspan="2"><b>Tổng</b></td><td class="r num"><b>${money(-m.amount)}</b></td><td></td></tr></tfoot></table>
      <div class="row between small"><span>Thu ngân ký</span><span>Quản lý ký</span></div>
      <button class="primary no-print" onClick=${() => window.print()}>🖨 In phiếu chi</button>
    </div>
  <//>`;
}

function refundsBlock(d) {
  if (!d.refunds.length) return null;
  return html`<section class="card stack"><b>Hoàn tiền mặt (${d.refunds.length})</b>
    ${d.refunds.map((r) => html`<div class="row between small"><span>Bill ${r.bill_no} · ${hm(r.created_at)} · ${r.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}<br /><span class="muted">${r.reason} · ${r.by_name}, duyệt ${r.approver_name}</span></span><b class="num danger-text">−${money(r.amount)}</b></div>`)}
  </section>`;
}

// Bàn phục vụ báo "trả tiền mặt" / xin thanh toán: thu ngân bấm vào thu
function WaitingTables({ me }) {
  const st = useData('/api/payments/waiting');
  const [open, setOpen] = useState(null);
  if (!st.data?.length) return null;
  return html`<section class="card stack warn-card">
    <b>💵 Bàn đang mở · bấm để thu tiền (${st.data.length})</b>
    <small class="muted">Khách CK: đối chiếu ảnh chụp màn hình phục vụ gửi nhóm thu ngân rồi bấm "Đã nhận CK". Tiền mặt: phục vụ đem tiền lại, nhập số khách đưa.</small>
    ${st.data.map((x) => html`<div class="row between wrap">
      <span><b>${x.header}</b> · bill ${x.bill_no || '—'}${x.cash ? ' · 💵 tiền mặt' : x.ck ? ' · 🏦 khách báo đã CK' : x.asking ? ' · xin tính tiền' : ''}<br /><small class="muted">${x.opened_by || ''}${x.unserved ? ` · còn ${x.unserved} món chưa ra` : ''}</small></span>
      <button class="primary" onClick=${() => setOpen(x)}>Thu ${money(x.total)}</button></div>`)}
    ${open ? html`<${PayModal} me=${me} id=${open.id} defaultMethod=${open.cash ? 'cash' : 'transfer'} onClose=${() => setOpen(null)} onDone=${(r) => { setOpen(null); toast(r.change ? `Đã thu. Thối khách ${money(r.change)}` : 'Đã thu, bàn trống'); bump(); }} />` : null}
  </section>`;
}

export const DENOMS = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000];
const dk = (x) => (x >= 1000 ? `${x / 1000}k` : String(x));

// Đếm tiền theo mệnh giá: gõ số tờ, app tự nhân & cộng
export function DenomForm({ value, onChange }) {
  const total = DENOMS.reduce((n, x) => n + x * (Number(value[x]) || 0), 0);
  return html`<div class="denoms">
    ${DENOMS.map((x) => html`<label class="denom"><span>${dk(x)}</span><input inputmode="numeric" placeholder="0" value=${value[x] || ''} onInput=${(e) => onChange({ ...value, [x]: e.target.value.replace(/\D/g, '') })} /><small class="muted">${value[x] ? money(x * Number(value[x])) : ''}</small></label>`)}
    <div class="row between total" style="grid-column:1/-1"><b>Tổng đếm</b><b class="num">${money(total)}</b></div>
  </div>`;
}
export function DenomView({ denoms }) {
  const rows = DENOMS.filter((x) => denoms[x]);
  return html`<div class="small muted">${rows.map((x) => `${dk(x)} × ${denoms[x]}`).join(' · ')}</div>`;
}
export function CashPhotos({ photos }) {
  const [view, setView] = useState(null);
  if (!photos?.length) return null;
  return html`<div class="row wrap">${photos.map((p) => html`<img class="thumb" src=${`/api/payments/drawer-photo/${p.id}`} alt="Ảnh tiền" onClick=${() => setView(p)} />`)}
    ${view ? html`<div class="viewer" onClick=${() => setView(null)}><img src=${`/api/payments/drawer-photo/${view.id}`} alt="Ảnh tiền" /></div>` : null}</div>`;
}

// Thu ngân chốt két: đếm theo mệnh giá, chụp ảnh tiền, ghi số để lại két ngày mai, phần còn lại bỏ phong bì
function DrawerClose({ date, d }) {
  const [den, setDen] = useState(() => (d.drawer?.denoms ? JSON.parse(d.drawer.denoms) : {}));
  const [keep, setKeep] = useState(d.drawer?.keep_float != null ? String(d.drawer.keep_float) : '');
  const [busy, setBusy] = useState(false);
  const total = DENOMS.reduce((n, x) => n + x * (Number(den[x]) || 0), 0);
  const k = num(keep);
  const photo = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    try { const data = await compressImage(f); await act(() => api('POST', '/api/payments/drawer-photo', { date, data }), 'Đã lưu ảnh'); } finally { setBusy(false); }
  };
  return html`<div class="stack">
    <${DenomForm} value=${den} onChange=${setDen} />
    <${Field} label="Để lại két làm tiền lẻ ngày mai"><input inputmode="numeric" placeholder="vd 2.000.000" value=${keep} onInput=${(e) => setKeep(e.target.value)} /><//>
    ${total ? html`<div class="row between"><span>Bỏ phong bì (đi nộp ngân hàng)</span><b class="num">${money(Math.max(0, total - k))}</b></div>` : null}
    <button class="primary" disabled=${!total} onClick=${() => act(() => api('POST', '/api/payments/drawer', { date, denoms: den, keep_float: k }), 'Đã ghi số đếm')}>Ghi số đếm ${money(total)}</button>
    <label class=${`button ${busy ? 'muted' : ''}`}>📷 Chụp ảnh tiền đã đếm (${d.photos?.length || 0})<input type="file" accept="image/*" capture="environment" hidden onChange=${photo} /></label>
    <${CashPhotos} photos=${d.photos} />
    <small class="muted">Ghi số tờ từng loại, chụp ảnh xấp tiền, bỏ phong bì ghi số tiền + ngày. Sáng mai chủ quán đối chiếu với số nộp ngân hàng.</small>
  </div>`;
}

// Thu ngân sửa bill bấm nhầm cách trả (tiền mặt ↔ CK). Bắt lý do, chủ quán nhận báo, ghi vào bất thường cuối ngày
function ChangeMethod({ b, onClose }) {
  const [method, setMethod] = useState(b.pay_method === 'cash' ? 'transfer' : 'cash');
  const [cash, setCash] = useState('');
  const [reason, setReason] = useState('');
  const save = async () => {
    const r = await act(() => api('POST', `/api/pos/sessions/${b.id}/change-method`, { method, cash_amount: method === 'mixed' ? num(cash) : undefined, reason }), 'Đã đổi cách thanh toán');
    if (r) { if (r.cash_status === 'held') alert('Tiền mặt bill này chờ thu ngân xác nhận: nhận tiền từ phục vụ rồi bấm xác nhận ở Thu ngân.'); onClose(); }
  };
  return html`<${Modal} title=${`Đổi cách thanh toán · bill ${b.bill_no}`} onClose=${onClose}>
    <div class="stack">
      <p class="small">Đang ghi: <b>${METHOD[b.pay_method]}</b> · ${money(b.total)}${b.bank_received ? ` · ngân hàng đã báo nhận ${money(b.bank_received)}` : ''}</p>
      <div class="tabs">${Object.entries(METHOD).map(([k, l]) => html`<button class=${method === k ? 'on' : ''} onClick=${() => setMethod(k)}>${l}</button>`)}</div>
      ${method === 'mixed' ? html`<${Field} label="Phần tiền mặt"><input inputmode="numeric" value=${cash} onInput=${(e) => setCash(e.target.value)} /><//>` : null}
      <p class="muted small">${method === 'transfer' ? 'Đổi sang CK: nếu tiền đã về app tự khớp; chưa về thì chờ tiền về như bill CK thường.' : method === 'cash' ? 'Đổi sang tiền mặt: tiền nằm ở người đã thu, thu ngân phải bấm xác nhận nhận tiền.' : ''}</p>
      <${Field} label="Lý do"><input value=${reason} onInput=${(e) => setReason(e.target.value)} placeholder="vd Bấm nhầm, khách đã CK" /><//>
      <div class="chips">${['Bấm nhầm', 'Khách đổi cách trả', 'Khách trả một phần tiền mặt'].map((x) => html`<button class=${`chip ${reason === x ? 'on' : ''}`} onClick=${() => setReason(x)}>${x}</button>`)}</div>
      <p class="muted small">Chủ quán nhận báo mỗi lần đổi; cuối ngày ghi vào mục bất thường.</p>
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" disabled=${!reason.trim() || (method === 'mixed' && !num(cash))} onClick=${save}>Đổi</button></div>
    </div>
  <//>`;
}
