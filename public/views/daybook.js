import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, money, hm, dayLabel, Field, navigate } from '../ui.js';
import { DenomForm, DenomView, CashPhotos } from './pay.js';

const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
const Check = ({ ok, children }) => html`<div class="row between check-line"><span>${children}</span><b class=${ok === true ? 'ok-text' : ok === false ? 'danger-text' : 'muted'}>${ok === true ? '✓ khớp' : ok === false ? '✗ lệch' : 'chờ kiểm'}</b></div>`;

// Chủ quán duyệt sổ buổi sáng: ngày thu ngân đã chốt đêm qua
export function DaybookView({ me, query }) {
  const date = query.get('date') || '';
  const st = useData(`/api/daybook${date ? `?date=${date}` : ''}`);
  const [manual, setManual] = useState('');
  const [bankTotal, setBankTotal] = useState('');
  const [recount, setRecount] = useState(null);
  const [note, setNote] = useState('');
  if (!st.data) return html`<${Loading} state=${st} />`;
  const b = st.data;
  if (!b.date) return html`<div class="empty">Chưa có ngày nào thu ngân chốt.</div>`;
  if (b.not_closed) return html`<div class="empty">Ngày ${dm(b.date)} thu ngân chưa chốt.</div>`;
  const d = b.day;
  const s = d.summary;
  const rv = b.review || {};
  const owner = me.role === 'owner';
  const done = rv.status === 'approved';
  const cashCheck = (body, msg) => act(() => api('POST', '/api/daybook/cash-check', { date: b.date, ...body }), msg);
  const manualBank = Number(String(bankTotal).replace(/\D/g, '')) || 0;
  return html`<div class="stack">
    <div class="row between wrap">
      <h2>Sổ ngày ${dayLabel(b.date, { long: true })}</h2>
      <span class=${`pill ${done ? 'ok' : rv.status === 'issue' ? 'bad' : 'warn'}`}>${done ? `Đã duyệt · ${rv.reviewed_by_name}` : rv.status === 'issue' ? 'Có vấn đề' : 'Chờ duyệt'}</span>
    </div>
    ${b.pending_days.length > 1 ? html`<div class="chips">${b.pending_days.map((x) => html`<button class=${`chip ${x === b.date ? 'on' : ''}`} onClick=${() => navigate(`/duyet-so?date=${x}`)}>${dm(x)}</button>`)}</div>` : null}
    <small class="muted">Thu ngân ${d.closing.by_name} chốt lúc ${hm(d.closing.confirmed_at)} · ${s.bills} bill</small>

    <div class="grid-2">
      <div class="card"><small class="muted">Doanh thu</small><h3 class="num">${money(s.net)}</h3><small class="muted">KM đã giảm ${money(s.discount)} · hoàn ${money(s.refund_cash)}</small></div>
      <div class="card"><small class="muted">Tip quỹ chung</small><h3 class="num">${money(s.tip_cash + s.tip_transfer)}</h3><small class="muted">TM ${money(s.tip_cash)} · CK ${money(s.tip_transfer)}</small></div>
    </div>

    <section class="card stack">
      <b>1. Chuyển khoản ${money(s.transfer_confirmed)}</b>
      ${b.checks.ck.sepay
        ? html`<${Check} ok=${b.checks.ck.ok}>Ngân hàng báo vào ${money(b.checks.ck.bank)} = CK bill ${money(s.transfer_confirmed)} + tip CK ${money(s.tip_transfer)}<//>`
        : html`<small>Chưa nối SePay: mở app Techcombank → lịch sử ngày ${dm(b.date)} → tổng tiền vào, gõ vào đây để so.</small>
          <input inputmode="numeric" placeholder="Tổng tiền vào theo sao kê" value=${bankTotal} onInput=${(e) => setBankTotal(e.target.value)} />
          ${manualBank ? html`<${Check} ok=${manualBank === s.transfer_confirmed + s.tip_transfer}>Sao kê ${money(manualBank)} / app ${money(s.transfer_confirmed + s.tip_transfer)}<//>` : null}`}
      ${s.transfer_missing ? html`<div class="danger-text small">Chưa thấy tiền: ${money(s.transfer_missing)} (thu ngân đã đánh dấu)</div>` : null}
    </section>

    <section class="card stack">
      <b>2. Tiền mặt</b>
      <div class="row between small"><span>Thu ngân đếm két</span><b class="num">${money(s.drawer_counted)}</b></div>
      ${b.denoms ? html`<${DenomView} denoms=${b.denoms} />` : null}
      <${CashPhotos} photos=${b.photos} />
      ${s.cash_out ? html`<div class="row between small"><span>Chi từ két (trả NCC, tạm ứng − hoàn ứng)</span><b class="num">−${money(s.cash_out)}</b></div>` : null}
      <div class="row between small"><span>Phải có theo bill</span><b class=${`num ${s.drawer_diff ? 'danger-text' : ''}`}>${money(s.drawer_expected)}${s.drawer_diff ? ` (két lệch ${money(s.drawer_diff)})` : ''}</b></div>
      <div class="row between small"><span>Để lại két cho hôm sau</span><b class="num">${money(b.keep_float)}</b></div>
      <div class="row between"><b>Phong bì phải nộp</b><b class="num">${money(b.envelope)}</b></div>
      <${Check} ok=${b.checks.cash.ok}>${b.checks.cash.method === 'deposit' ? `Nộp ngân hàng ${money(b.checks.cash.amount)}` : b.checks.cash.method === 'recount' ? `${rv.check_by_name} đếm lại ${money(b.checks.cash.amount)}` : 'Kiểm phong bì'}${b.checks.cash.diff ? ` (lệch ${money(b.checks.cash.diff)})` : ''}<//>
      <${Check} ok=${b.checks.float.ok}>Két đầu ngày hôm sau ${b.checks.float.next_opening == null ? 'chưa ghi' : money(b.checks.float.next_opening)} = để lại ${money(b.keep_float)}<//>
      ${!done ? html`<details class="stack" open=${!b.checks.cash.method}>
        <summary><b>Kiểm phong bì</b></summary>
        <div class="small"><b>A. Tiền nộp ngân hàng</b> (SePay báo về):</div>
        ${b.deposits.length ? b.deposits.map((t) => html`<div class="row between wrap small"><span>${t.txn_at || hm(t.received_at)} · "${t.content}"</span>
          <span><b class="num">${money(t.amount)}</b> ${t.status === 'deposit' ? html`<span class="ok-text">✓ đã chọn</span>` : html`<button class="small" onClick=${() => cashCheck({ method: 'deposit', txn_id: t.id }, 'Đã đối chiếu khoản nộp')}>Đây là tiền nộp</button>`}</span></div>`)
          : html`<small class="muted">Chưa thấy khoản tiền vào nào chưa khớp. Nộp xong đợi vài phút, hoặc nhập tay:</small>`}
        <div class="row wrap"><input inputmode="numeric" style="flex:1;min-width:9em" placeholder="Số tiền đã nộp" value=${manual} onInput=${(e) => setManual(e.target.value)} />
          <button disabled=${!manual} onClick=${() => cashCheck({ method: 'deposit', amount: manual }, 'Đã ghi')}>Ghi số nộp</button></div>
        <div class="small"><b>B. Đếm lại phong bì</b> (quản lý ca sáng / chủ quán):</div>
        ${recount ? html`<${DenomForm} value=${recount} onChange=${setRecount} /><button class="primary" onClick=${() => cashCheck({ method: 'recount', denoms: recount }, 'Đã ghi số đếm lại').then((ok) => ok && setRecount(null))}>Ghi số đếm lại</button>`
          : html`<button onClick=${() => setRecount({})}>Đếm lại theo mệnh giá</button>`}
      </details>` : null}
    </section>

    <section class="card stack">
      <b>3. Bất thường (${d.anomalies.length})</b>
      ${d.anomalies.length ? d.anomalies.map((a) => html`<div class=${`small ${a.level === 'bad' ? 'danger-text' : 'warn-text'}`}>• ${a.text}</div>`) : html`<span class="ok-text small">Không có bất thường.</span>`}
      <a class="small" href=${`/thu-ngan`} onClick=${(e) => { e.preventDefault(); navigate('/thu-ngan'); }}>Xem từng bill ở Thu ngân →</a>
    </section>

    ${rv.note ? html`<p class="small">Ghi chú: ${rv.note}</p>` : null}
    ${owner && !done ? html`<section class="card stack">
      <${Field} label="Ghi chú (bắt buộc khi có vấn đề)"><textarea rows="2" value=${note} onInput=${(e) => setNote(e.target.value)} placeholder="vd Phong bì thiếu 50k, Ngân giải trình"></textarea><//>
      <button class="primary big" onClick=${() => act(() => api('POST', '/api/daybook/review', { date: b.date, status: 'approved', note }), 'Đã duyệt sổ')}>✓ Đã duyệt sổ ${dm(b.date)}</button>
      <button class="danger" onClick=${() => act(() => api('POST', '/api/daybook/review', { date: b.date, status: 'issue', note }), 'Đã báo thu ngân + quản lý')}>Có vấn đề → báo thu ngân + quản lý</button>
      <button class="link danger-text" onClick=${() => { const r = prompt('Lý do mở lại ngày (thu ngân chốt nhầm…)'); if (r) act(() => api('POST', '/api/daybook/reopen', { date: b.date, reason: r }), 'Đã mở lại ngày'); }}>Mở lại ngày cho thu ngân sửa…</button>
    </section>` : null}
    ${!owner && !done ? html`<p class="muted small">Quản lý kiểm phong bì được; chỉ chủ quán bấm duyệt.</p>` : null}
  </div>`;
}

// Trang Hôm nay của chủ quán / quản lý: nhắc sổ chưa duyệt
export function PendingBookCard({ me }) {
  const st = useData(me.role === 'owner' || me.role === 'manager' ? '/api/daybook' : null);
  const b = st.data;
  if (!b?.date || b.not_closed || b.review?.status === 'approved') return null;
  const s = b.day.summary;
  const bad = b.day.anomalies.filter((a) => a.level === 'bad').length;
  return html`<a class="card warn-card stack" href=${`/duyet-so?date=${b.date}`} onClick=${(e) => { e.preventDefault(); navigate(`/duyet-so?date=${b.date}`); }} style="text-decoration:none;color:inherit">
    <b>✔ Sổ ngày ${dm(b.date)} chờ ${me.role === 'owner' ? 'anh' : 'chủ quán'} duyệt${b.pending_days.length > 1 ? ` (+${b.pending_days.length - 1} ngày)` : ''}</b>
    <span class="small">Doanh thu ${money(s.net)} · phong bì ${money(b.envelope)} ${b.checks.cash.ok === true ? '✓ đã kiểm' : b.checks.cash.ok === false ? '✗ LỆCH' : 'chưa kiểm'} · ${bad ? `${bad} điểm cần xem` : 'không bất thường lớn'} →</span>
  </a>`;
}
