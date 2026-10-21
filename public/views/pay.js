import { useState } from 'preact/hooks';
import { html, api, act, useData, Loading, Modal, Field, money, hm, atLeast, addDays, dayLabel } from '../ui.js';
import qrcode from '../vendor/qrcode.js';

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
export function PayModal({ id, onClose, onDone }) {
  const st = useData(`/api/pos/sessions/${id}/bill`);
  const [method, setMethod] = useState('transfer');
  const [given, setGiven] = useState('');
  const [cashPart, setCashPart] = useState('');
  if (!st.data) return html`<${Modal} title="Tính tiền" onClose=${onClose}><${Loading} state=${st} /><//>`;
  const b = st.data;
  const cash = num(given);
  const part = Math.min(num(cashPart), b.total);
  const pay = async (confirm = false) => {
    const body = { method, cash_given: method === 'cash' ? cash || '' : undefined, cash_amount: method === 'mixed' ? part : undefined, confirm_unserved: confirm };
    try {
      const r = await api('POST', `/api/pos/sessions/${id}/pay`, body);
      onDone(r);
    } catch (e) {
      if (e.status === 409 && confirm_(e.message)) return pay(true);
      if (e.status !== 409) act(() => Promise.reject(e));
    }
  };
  const printBill = () => act(() => api('POST', `/api/pos/sessions/${id}/print-bill`), 'Đã gửi in bill');
  const rounds = [...new Set([b.total, Math.ceil(b.total / 50000) * 50000, Math.ceil(b.total / 100000) * 100000, Math.ceil(b.total / 500000) * 500000, 1000000].filter((x) => x >= b.total))].slice(0, 4);
  const qrData = method === 'mixed' ? null : b.qr;
  return html`<${Modal} title=${`Tính tiền bàn ${b.header} · bill ${b.bill_no}`} onClose=${onClose}>
    <div class="stack">
      ${b.unsent ? html`<p class="warn-text">Còn ${b.unsent} món chưa gửi bếp. Gửi hoặc xoá trước khi tính tiền.</p>` : null}
      ${b.unserved ? html`<p class="warn-text small">Còn ${b.unserved} món chưa bấm "Đã ra": hỏi khách đã nhận đủ món chưa.</p>` : null}
      <${BillLines} b=${b} />
      <div class="tabs">${Object.entries(METHOD).map(([k, l]) => html`<button class=${method === k ? 'on' : ''} onClick=${() => setMethod(k)}>${l}</button>`)}</div>
      ${method === 'transfer' ? html`<div class="stack center">
        <${QR} data=${qrData} />
        <div><b>${b.bank_name} · ${money(b.total)}</b><br /><small>Nội dung: <b>${b.transfer_note}</b> (có sẵn trong mã)</small></div>
        <p class="muted small">Đưa khách quét mã trên màn hình hoặc bill in. Thấy khách chuyển xong (màn hình app ngân hàng của khách báo thành công) thì bấm nút dưới.</p>
        <button class="primary big" disabled=${b.unsent} onClick=${() => pay()}>✓ Khách đã CK · đóng bill</button>
      </div>` : null}
      ${method === 'cash' ? html`<div class="stack">
        <${Field} label="Khách đưa"><input inputmode="numeric" placeholder=${money(b.total)} value=${given} onInput=${(e) => setGiven(e.target.value)} /><//>
        <div class="chips">${rounds.map((x) => html`<button class="chip" onClick=${() => setGiven(String(x))}>${money(x)}</button>`)}</div>
        ${cash ? html`<div class="row between total"><b>Tiền thối</b><b class=${`num ${cash < b.total ? 'danger-text' : ''}`}>${cash < b.total ? `Thiếu ${money(b.total - cash)}` : money(cash - b.total)}</b></div>` : null}
        <button class="primary big" disabled=${b.unsent || (cash && cash < b.total)} onClick=${() => pay()}>✓ Đã thu tiền mặt · đóng bill</button>
      </div>` : null}
      ${method === 'mixed' ? html`<div class="stack">
        <${Field} label="Phần tiền mặt"><input inputmode="numeric" placeholder="vd 100000" value=${cashPart} onInput=${(e) => setCashPart(e.target.value)} /><//>
        ${part > 0 && part < b.total ? html`<div class="stack center"><div>Chuyển khoản phần còn lại: <b>${money(b.total - part)}</b></div>
          <${MixedQR} id=${id} amount=${b.total - part} b=${b} /></div>` : html`<p class="muted small">Nhập số tiền mặt khách đưa, phần còn lại khách chuyển khoản.</p>`}
        <button class="primary big" disabled=${b.unsent || !(part > 0 && part < b.total)} onClick=${() => pay()}>✓ Đã thu đủ · đóng bill</button>
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
  const est = chosen.reduce((n, l) => n + Math.round((l.net * pick[l.id]) / l.qty), 0);
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

export function PaidPanel({ me, id }) {
  const st = useData(`/api/pos/sessions/${id}/bill`);
  const [refund, setRefund] = useState(false);
  if (!st.data) return null;
  const b = st.data;
  return html`<section class="card stack">
    <div class="row between wrap"><b>✓ Đã thanh toán · bill ${b.bill_no}</b><span class="pill ok">${METHOD[b.pay_method] || ''}</span></div>
    <div class="small muted">${b.cashier ? `Thu: ${b.cashier} · ` : ''}${hm(b.closed_at)}${b.pay_method !== 'cash' ? ` · CK ${money(b.transfer_amount)} (${b.reconcile_status === 'confirmed' ? 'đã đối soát' : b.reconcile_status === 'missing' ? 'CHƯA THẤY TIỀN' : 'chờ đối soát'})` : ''}</div>
    <${BillLines} b=${b} />
    ${b.refunds.map((r) => html`<div class="row between small danger-text"><span>Hoàn tiền mặt ${hm(r.created_at)}: ${r.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')} (${r.reason}) · ${r.by_name}, duyệt ${r.approver_name}</span><span class="num">−${money(r.amount)}</span></div>`)}
    <div class="row wrap">
      <button onClick=${() => act(() => api('POST', `/api/pos/sessions/${id}/print-bill`), 'Đã gửi in lại bill')}>🖨 In lại bill</button>
      <button class="danger" onClick=${() => setRefund(true)}>Hoàn tiền…</button>
    </div>
    ${refund ? html`<${RefundModal} me=${me} id=${id} onClose=${() => setRefund(false)} />` : null}
  </section>`;
}

// ---------- Thu ngân: doanh thu ngày, đối soát CK, chốt ngày ----------
export function CashierView({ me }) {
  const [date, setDate] = useState(me.today);
  const [sel, setSel] = useState({});
  const st = useData(`/api/payments?date=${date}`);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const s = d.summary;
  const ck = d.bills.filter((b) => b.transfer_amount > 0);
  const pending = ck.filter((b) => b.reconcile_status === 'pending');
  const ids = Object.keys(sel).filter((k) => sel[k]).map(Number);
  const selTotal = ck.filter((b) => sel[b.id]).reduce((n, b) => n + b.transfer_amount, 0);
  const mark = (status, list = ids) => act(() => api('POST', '/api/payments/reconcile', { ids: list, status }), status === 'confirmed' ? 'Đã xác nhận' : status === 'missing' ? 'Đã báo chủ quán' : 'Đã bỏ đánh dấu').then((ok) => ok && setSel({}));
  const locked = !!d.closing;
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row"><button class="icon" onClick=${() => setDate(addDays(date, -1))}>‹</button><b>${dayLabel(date, { long: true })}</b><button class="icon" onClick=${() => setDate(addDays(date, 1))}>›</button></div>
      ${locked ? html`<span class="pill ok">Đã chốt · ${d.closing.by_name} ${hm(d.closing.confirmed_at)}</span>` : null}
    </div>
    ${d.open_tables ? html`<p class="warn-text small">Còn ${d.open_tables} bàn chưa thanh toán.</p>` : null}
    <div class="grid-2">
      <div class="card"><small class="muted">Doanh thu (${s.bills} bill)</small><h3 class="num">${money(s.net)}</h3><small class="muted">KM đã giảm ${money(s.discount)}</small></div>
      <div class="card"><small class="muted">Tiền mặt phải có trong két</small><h3 class="num">${money(s.cash_expected)}</h3><small class="muted">Thu ${money(s.cash_in)}${s.refund_cash ? ` − hoàn ${money(s.refund_cash)}` : ''}</small></div>
      <div class="card"><small class="muted">Chuyển khoản</small><h3 class="num">${money(s.transfer_in)}</h3><small class="muted">Đã khớp ${money(s.transfer_confirmed)}</small></div>
      <div class=${`card ${s.transfer_pending || s.transfer_missing ? 'warn-card' : ''}`}><small class="muted">CK chờ đối soát / chưa thấy</small><h3 class="num">${money(s.transfer_pending)}</h3>${s.transfer_missing ? html`<small class="danger-text">Chưa thấy tiền ${money(s.transfer_missing)}</small>` : null}</div>
    </div>

    <section class="card stack">
      <div class="row between wrap"><h3>Đối soát chuyển khoản (${ck.length})</h3>
        ${!locked && pending.length ? html`<button onClick=${() => setSel(Object.fromEntries(pending.map((b) => [b.id, true])))}>Chọn tất cả chờ đối soát</button>` : null}</div>
      <p class="muted small">Mở app Techcombank → sao kê ngày này → so tổng tiền vào với tổng bên dưới. Khớp thì chọn tất cả → Đã thấy tiền. Lệch thì tìm theo nội dung CLT… từng bill.</p>
      ${ck.map((b) => html`<label class="row between check-row">
        <span class="row">${!locked ? html`<input type="checkbox" checked=${!!sel[b.id]} onChange=${(e) => setSel({ ...sel, [b.id]: e.target.checked })} />` : null}
          <span><b>${b.transfer_note}</b> · ${b.header} · ${hm(b.closed_at)}<br /><small class="muted">đóng bởi ${b.closed_by_name}${b.pay_method === 'mixed' ? ' · TM + CK' : ''}</small></span></span>
        <span class="r"><b class="num">${money(b.transfer_amount)}</b><br /><small class=${b.reconcile_status === 'missing' ? 'danger-text' : b.reconcile_status === 'confirmed' ? 'ok-text' : 'muted'}>${b.reconcile_status === 'confirmed' ? '✓ đã thấy' : b.reconcile_status === 'missing' ? '✗ chưa thấy' : 'chờ'}</small></span>
      </label>`)}
      ${ids.length && !locked ? html`<div class="stack">
        <div class="row between total"><b>Đã chọn ${ids.length} bill</b><b class="num">${money(selTotal)}</b></div>
        <div class="row wrap"><button class="primary grow" onClick=${() => mark('confirmed')}>✓ Đã thấy tiền</button><button class="danger" onClick=${() => mark('missing')}>Chưa thấy tiền</button><button onClick=${() => mark('pending')}>Bỏ đánh dấu</button></div>
      </div>` : null}
    </section>

    ${d.refunds.length ? html`<section class="card stack"><h3>Hoàn tiền mặt (${d.refunds.length})</h3>
      ${d.refunds.map((r) => html`<div class="row between small"><span>Bill ${r.bill_no} · ${hm(r.created_at)} · ${r.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}<br /><span class="muted">${r.reason} · ${r.by_name}, duyệt ${r.approver_name}</span></span><b class="num danger-text">−${money(r.amount)}</b></div>`)}
    </section>` : null}

    <section class="card stack"><h3>Tất cả bill (${d.bills.length})</h3>
      ${d.bills.map((b) => html`<a class="row between small plain-link" href=${`/goi-mon?s=${b.id}`}><span>${b.bill_no} · ${b.header} · ${hm(b.closed_at)} · ${METHOD[b.pay_method]}</span><span class="num">${money(b.paid_total)}</span></a>`)}
    </section>

    ${!locked ? html`<button class="primary big" disabled=${!d.bills.length || pending.length > 0} onClick=${() => confirm(`Chốt doanh thu ${money(s.net)}? Sau khi chốt không sửa đối soát được nữa.`) && act(() => api('POST', '/api/payments/close-day', { date }), 'Đã chốt doanh thu, đã báo chủ quán')}>
      ${pending.length ? `Còn ${pending.length} bill CK chưa đối soát` : '✓ Xác nhận & chốt doanh thu ngày'}</button>` : null}
  </div>`;
}
