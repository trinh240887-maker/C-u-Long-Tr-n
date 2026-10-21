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
  const [keep, setKeep] = useState(false);
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
  const pay = async (confirm = false) => {
    const body = { method, cash_given: method === 'cash' ? cash || '' : undefined, keep_change: method === 'cash' && keep && cash > b.total, cash_amount: method === 'mixed' ? part : undefined, confirm_unserved: confirm };
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
        ${b.bank_received ? html`<div class="warn-text">Đã nhận ${money(b.bank_received)} · còn thiếu <b>${money(b.qr_amount)}</b> (mã đã đổi theo số còn thiếu)</div>` : null}
        <div><b>${b.bank_name} · ${money(b.qr_amount)}</b><br /><small>Nội dung: <b>${b.transfer_note}</b> (có sẵn trong mã)</small></div>
        ${b.sepay ? html`<p class="small ok-text">● Đang nối ngân hàng: khách chuyển xong, tiền về là bill <b>tự đóng</b>, không cần bấm.</p>
          <p class="muted small">Khách báo đã chuyển mà chưa thấy app đóng (ngân hàng chậm) thì bấm nút dưới để mở bàn trước; tiền về app tự khớp, quá 30′ chưa về app báo quản lý.</p>`
          : html`<p class="muted small">Khách quét mã trên màn hình hoặc bill in. Thấy màn hình app ngân hàng của khách báo chuyển thành công thì bấm nút dưới. Thu ngân đối soát với sao kê sau.</p>`}
        <button class=${`${b.sepay ? '' : 'primary'} big`} disabled=${b.unsent} onClick=${() => pay()}>${b.sepay ? 'Khách đã CK, chờ tiền về · mở bàn' : '✓ Khách đã CK · đóng bill'}</button>
      </div>` : null}
      ${method === 'cash' ? html`<div class="stack">
        <${Field} label="Khách đưa"><input inputmode="numeric" placeholder=${money(b.total)} value=${given} onInput=${(e) => setGiven(e.target.value)} /><//>
        <div class="chips">${rounds.map((x) => html`<button class="chip" onClick=${() => setGiven(String(x))}>${money(x)}</button>`)}</div>
        ${cash ? html`<div class="row between total"><b>Tiền thối</b><b class=${`num ${cash < b.total ? 'danger-text' : ''}`}>${cash < b.total ? `Thiếu ${money(b.total - cash)}` : keep ? '0đ (tip)' : money(cash - b.total)}</b></div>` : null}
        ${cash > b.total ? html`<label class="check-row"><input type="checkbox" checked=${keep} onChange=${(e) => setKeep(e.target.checked)} /> Khách không lấy tiền thối → ${money(cash - b.total)} vào tip quỹ chung</label>` : null}
        <p class="muted small">Thu xong mang <b>tiền + bill</b> giao thu ngân ngay.</p>
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
  if (!st.data) return null;
  const b = st.data;
  const ck = CK_LABEL[b.reconcile_status];
  return html`<section class="card stack">
    <div class="row between wrap"><b>✓ Đã thanh toán · bill ${b.bill_no}</b><span class="pill ok">${METHOD[b.pay_method] || ''}</span></div>
    <div class="small">${b.closed_auto ? 'Tự đóng khi tiền về' : `Đóng bởi ${b.cashier}`} · ${hm(b.closed_at)}</div>
    <div class="row wrap small">
      ${b.cash_amount + b.tip_cash ? html`<span class=${`pill ${b.cash_status === 'received' ? 'ok' : 'warn'}`}>Tiền mặt ${money(b.cash_amount + b.tip_cash)}: ${b.cash_status === 'received' ? 'thu ngân đã nhận' : 'phục vụ đang giữ'}</span>` : null}
      ${ck ? html`<span class=${`pill ${ck[0]}`}>CK ${money(b.transfer_amount)}: ${ck[1]}</span>` : null}
      ${b.tip_cash + b.tip_transfer ? html`<span class="pill">Tip ${money(b.tip_cash + b.tip_transfer)}</span>` : null}
    </div>
    <${BillLines} b=${b} />
    ${b.refunds.map((r) => html`<div class="row between small danger-text"><span>Hoàn tiền mặt ${hm(r.created_at)}: ${r.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')} (${r.reason}) · ${r.by_name}, duyệt ${r.approver_name}</span><span class="num">−${money(r.amount)}</span></div>`)}
    <div class="row wrap">
      <button onClick=${() => act(() => api('POST', `/api/pos/sessions/${id}/print-bill`), 'Đã gửi in lại bill')}>🖨 In lại bill</button>
      <button class="danger" onClick=${() => setRefund(true)}>Hoàn tiền…</button>
    </div>
    ${refund ? html`<${RefundModal} me=${me} id=${id} onClose=${() => setRefund(false)} />` : null}
  </section>`;
}

// Phục vụ: tiền mặt mình đang giữ (chưa giao thu ngân) — hiện ở trang Hôm nay
export function MyCashCard() {
  const st = useData('/api/payments/my-cash');
  if (!st.data?.amount) return null;
  return html`<section class="card warn-card stack">
    <b>💵 Bạn đang giữ ${money(st.data.amount)} tiền mặt</b>
    <span class="small">${st.data.bills.map((x) => `bill ${x.bill_no} (${x.header}) ${money(x.amount)}`).join(' · ')}</span>
    <span class="small">Mang tiền + bill giao thu ngân ngay. Chưa giao thì không chấm ra ca được.</span>
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
      <button class="primary" onClick=${() => act(() => api('POST', '/api/payments/handover', { ids: group.bills.map((x) => x.id), counted: c, note: c !== expected ? 'Đếm lệch khi nhận' : '' }), c === expected ? 'Đã nhận đủ' : `Đã ghi lệch ${money(c - expected)}`)}>Nhận ${money(c)}</button>
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
    ${t.status === 'review' ? html`<div class="warn-text">Bill ${t.bill_no} đã trả tiền mặt mà vẫn có CK: khách trả 2 lần (hoàn lại) hay tip?</div>` : null}
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
  const blockers = [
    s.opening == null && 'nhập tiền két đầu ngày',
    groups.length && `nhận tiền mặt của ${groups.length} người`,
    unmatched.length && `xử lý ${unmatched.length} khoản CK chưa khớp`,
    toConfirm.length && `xác nhận ${toConfirm.length} bill CK`,
    s.drawer_counted == null && 'đếm két cuối ngày',
  ].filter(Boolean);
  return html`<div class="stack">
    <div class="row between wrap">
      <div class="row"><button class="icon" onClick=${() => setDate(addDays(date, -1))}>‹</button><b>${dayLabel(date, { long: true })}</b><button class="icon" onClick=${() => setDate(addDays(date, 1))}>›</button></div>
      ${locked ? html`<span class="pill ok">Đã chốt · ${d.closing.by_name} ${hm(d.closing.confirmed_at)}</span>` : null}
    </div>
    ${d.open_tables ? html`<p class="muted small">Đang còn ${d.open_tables} bàn chưa tính tiền.</p>` : null}

    <section class=${`card stack ${s.opening == null && !locked ? 'warn-card' : ''}`}>
      <div class="row between"><b>1. Két đầu ngày</b>${s.opening != null ? html`<b class="num">${money(s.opening)}</b>` : null}</div>
      ${s.opening != null ? html`<small class="muted">${d.drawer.opening_by_name} ghi lúc ${hm(d.drawer.opening_at)}</small>` : null}
      ${!locked ? html`<${Amount} value=${s.opening} label=${s.opening == null ? 'Ghi' : 'Sửa'} placeholder="Tiền lẻ để thối, vd 2.000.000" onSave=${(x) => act(() => api('POST', '/api/payments/drawer', { date, opening: x }), 'Đã ghi két đầu ngày')} />` : null}
    </section>

    <section class="stack">
      <b>2. Tiền mặt phục vụ đang giữ ${s.cash_held ? html`<span class="danger-text">${money(s.cash_held)}</span>` : html`<span class="ok-text">· đã nhận hết</span>`}</b>
      ${groups.map((g) => html`<${Handover} key=${g.name} group=${g} locked=${locked} />`)}
      ${d.handovers.length ? html`<details class="card small"><summary>Đã nhận ${d.handovers.length} lần · ${money(s.handed_in)}${s.handover_diff ? html` · <span class="danger-text">lệch ${money(s.handover_diff)}</span>` : ''}</summary>
        ${d.handovers.map((h) => html`<div class="row between"><span>${hm(h.created_at)} ${h.staff_name} → ${h.received_by_name}</span><span>${money(h.counted)}${h.diff ? html` <b class="danger-text">(${h.diff > 0 ? '+' : ''}${money(h.diff)})</b>` : ''}</span></div>`)}</details>` : null}
    </section>

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
      <b>5. Đếm két cuối ngày</b>
      <div class="row between"><span>Phải có = đầu ngày ${money(s.opening ?? 0)} + nhận từ phục vụ ${money(s.handed_in)} − hoàn ${money(s.refund_cash)}</span><b class="num">${s.drawer_expected == null ? '—' : money(s.drawer_expected)}</b></div>
      ${s.drawer_counted != null ? html`<div class="row between"><span>Đếm được</span><b class=${`num ${s.drawer_diff ? 'danger-text' : 'ok-text'}`}>${money(s.drawer_counted)}${s.drawer_diff ? ` (lệch ${money(s.drawer_diff)})` : ' ✓ khớp'}</b></div>` : null}
      ${!locked ? html`<${Amount} value=${s.drawer_counted} label="Ghi số đếm" placeholder="Tổng tiền đếm trong két" onSave=${(x) => act(() => api('POST', '/api/payments/drawer', { date, counted: x }), 'Đã ghi')} />` : null}
    </section>

    <div class="grid-2">
      <div class="card"><small class="muted">Doanh thu (${s.bills} bill)</small><h3 class="num">${money(s.net)}</h3><small class="muted">Đã xác nhận ${money(s.confirmed)} · chưa ${money(s.unconfirmed)}</small></div>
      <div class="card"><small class="muted">Tip quỹ chung</small><h3 class="num">${money(s.tip_cash + s.tip_transfer)}</h3><small class="muted">TM ${money(s.tip_cash)} · CK ${money(s.tip_transfer)}</small></div>
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
      <button class="primary big" disabled=${blockers.length > 0} onClick=${() => confirm(`Chốt doanh thu ${money(s.net)}? Sau khi chốt không sửa được nữa, chủ quán nhận báo cáo.`) && act(() => api('POST', '/api/payments/close-day', { date }), 'Đã chốt doanh thu, đã báo chủ quán')}>✓ Xác nhận & chốt doanh thu ngày</button>
    </section>` : null}

    <section class="card stack"><h3>Tất cả bill (${d.bills.length})</h3>
      ${d.bills.map((b) => html`<a class="row between small plain-link" href=${`/goi-mon?s=${b.id}`}><span>${b.bill_no} · ${b.header} · ${hm(b.closed_at)} · ${METHOD[b.pay_method]}</span><span class="num">${money(b.paid_total)}</span></a>`)}
    </section>
    ${me.role === 'owner' || me.role === 'manager' ? html`<${SepayCard} />` : null}
  </div>`;
}

function refundsBlock(d) {
  if (!d.refunds.length) return null;
  return html`<section class="card stack"><b>Hoàn tiền mặt (${d.refunds.length})</b>
    ${d.refunds.map((r) => html`<div class="row between small"><span>Bill ${r.bill_no} · ${hm(r.created_at)} · ${r.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}<br /><span class="muted">${r.reason} · ${r.by_name}, duyệt ${r.approver_name}</span></span><b class="num danger-text">−${money(r.amount)}</b></div>`)}
  </section>`;
}
