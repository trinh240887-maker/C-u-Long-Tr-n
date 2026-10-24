import { useState } from 'preact/hooks';
import { html, api, act, useData, Loading, money, hm, dayLabel, addDays, Modal, Field, navigate, toast } from '../ui.js';
import { compressImage } from './checklists.js';

// Mua hàng: khu nhận hàng chụp bill NCC (ký nhận) → thu ngân duyệt → công nợ NCC → trả NCC / tạm ứng đi chợ
const STATUS = { received: ['Chờ thu ngân duyệt', 'warn'], approved: ['Đã duyệt', 'ok'], returned: ['Bị trả lại, cần sửa', 'bad'] };
const num = (s) => Number(String(s ?? '').replace(/[.\s]/g, '').replace(',', '.')) || 0;

function Photos({ ids }) {
  const [view, setView] = useState(null);
  return html`<div class="thumbs">${ids.map((id) => html`<span class="thumb"><img src=${`/api/purchases/photo/${id}`} loading="lazy" alt="Ảnh bill" onClick=${() => setView(id)} /></span>`)}
    ${view ? html`<div class="viewer" onClick=${() => setView(null)}><img src=${`/api/purchases/photo/${view}`} alt="Ảnh bill" /></div>` : null}</div>`;
}

function PhotoPicker({ photos, setPhotos }) {
  const [busy, setBusy] = useState(false);
  const add = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    setBusy(true);
    try { const out = []; for (const f of files.slice(0, 4 - photos.length)) out.push(await compressImage(f, 1600)); setPhotos([...photos, ...out]); } catch (err) { act(() => Promise.reject(err)); } finally { setBusy(false); }
  };
  return html`<div class="stack">
    <div class="thumbs">${photos.map((p, i) => html`<span class="thumb"><img src=${p} alt="Ảnh bill" /><button class="x" aria-label="Xoá ảnh" onClick=${() => setPhotos(photos.filter((_, k) => k !== i))}>✕</button></span>`)}</div>
    ${photos.length < 4 ? html`<label class=${`btn-photo ${photos.length ? '' : 'need'}`}><input type="file" accept="image/*" capture="environment" multiple hidden onChange=${add} />
      ${busy ? 'Đang xử lý ảnh…' : photos.length ? '📷 Chụp thêm trang bill' : '📷 Chụp bill NCC (bắt buộc, thấy rõ chữ ký người nhận)'}</label>` : null}
  </div>`;
}

function Lines({ lines, setLines, ingredients }) {
  const set = (i, k, val) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: val } : l)));
  return html`<div class="stack">
    ${lines.map((l, i) => html`<div class="pline">
      ${l.ingredient_id ? html`<b>${l.name}</b>` : html`<input placeholder="Tên hàng (vd Cải thìa)" value=${l.name} onInput=${(e) => set(i, 'name', e.target.value)} />`}
      <div class="row">
        <label>SL <input inputmode="decimal" style="width:5em" value=${l.qty} onInput=${(e) => set(i, 'qty', e.target.value)} /> ${l.unit || ''}</label>
        <label>Đơn giá <input inputmode="numeric" style="width:7em" value=${l.price} onInput=${(e) => set(i, 'price', e.target.value)} /></label>
        <button class="small icon" aria-label="Xoá dòng" onClick=${() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
      </div>
      <small class="muted">= ${money(Math.round(num(l.qty) * num(l.price)))}${l.ordered != null ? ` · đặt ${l.ordered}` : ''}${l.ai ? ' · 📖 máy đọc' : ''}</small>
      ${l.warn ? html`<small class="warn-text">⚠ ${l.warn}</small>` : null}
      ${l.ai && !l.ingredient_id ? html`<select onChange=${(e) => { const g = ingredients.find((x) => x.id === Number(e.target.value)); if (g) setLines(lines.map((x, j) => (j === i ? { ...x, ingredient_id: g.id, name: g.name, unit: g.purchase_unit || g.unit, warn: '' } : x))); }}>
        <option value="">Là hàng trong kho… (bỏ qua nếu là hàng khác)</option>${ingredients.map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select>` : null}
    </div>`)}
    <div class="row wrap">
      <select onChange=${(e) => { const g = ingredients.find((x) => x.id === Number(e.target.value)); e.target.value = ''; if (g && !lines.some((l) => l.ingredient_id === g.id)) setLines([...lines, { ingredient_id: g.id, name: g.name, unit: g.purchase_unit || g.unit, qty: '', price: g.price || '' }]); }}>
        <option value="">+ Thêm hàng có trong kho…</option>${ingredients.map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select>
      <button class="small" onClick=${() => setLines([...lines, { name: '', unit: '', qty: '', price: '' }])}>+ Hàng khác (ga, đá, đồ dùng…)</button>
    </div>
  </div>`;
}

function Receive({ me, meta, advances, onDone }) {
  const stores = meta.stores.filter((s) => s.can_count);
  const pos = useData('/api/stock/po?status=approved');
  const [f, setF] = useState({ store_id: stores[0]?.id || '', po_id: '', supplier_id: '', supplier_name: '', signer_name: '', total: '', paid_method: '', advance_id: '', note: '' });
  const [lines, setLines] = useState([]);
  const [photos, setPhotos] = useState([]);
  const set = (k, val) => setF({ ...f, [k]: val });
  // 📖 Đọc bill: AI đọc ảnh → điền nơi bán, dòng hàng, tổng, người ký; nhân viên kiểm lại rồi mới lưu
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState('');
  const readBill = async () => {
    setReading(true); setReadNote('');
    try {
      const r = await api('POST', '/api/purchases/read-bill', { photos });
      const got = r.lines.map((l) => ({ ingredient_id: l.ingredient_id || undefined, name: l.name, unit: l.unit, qty: String(l.qty), price: String(l.price), ai: true, warn: !l.ingredient_id ? 'Không có trong kho: chọn hàng hoặc để là hàng khác' : l.unit_mismatch ? `Bill ghi "${l.bill_unit}", kho tính "${l.unit}": đổi số lượng cho đúng` : '' }));
      // Theo đơn đặt: giữ dòng của đơn, cập nhật số đọc được; mua lẻ: thay bằng dòng đọc được
      setLines(f.po_id ? lines.map((l) => { const g = got.find((x) => x.ingredient_id && x.ingredient_id === l.ingredient_id); return g ? { ...l, qty: g.qty, price: g.price, ai: true, warn: g.warn } : l; }).concat(got.filter((g) => !lines.some((l) => l.ingredient_id && l.ingredient_id === g.ingredient_id))) : got);
      setF({ ...f, ...(f.po_id ? {} : { supplier_id: r.supplier_id ? String(r.supplier_id) : '', supplier_name: r.supplier_id ? '' : r.supplier_name }), total: r.total ? String(r.total) : f.total, signer_name: f.signer_name || r.signer_name });
      setReadNote(r.note);
      toast(`Đã đọc ${got.length} dòng: kiểm lại số lượng, đơn giá trước khi lưu`);
    } catch (e) { act(() => Promise.reject(e)); } finally { setReading(false); }
  };
  const myAdv = (advances.data || []).filter((a) => a.status === 'open' && a.staff_id === me.id);
  const usePo = (id) => {
    const po = (pos.data || []).find((p) => p.id === Number(id));
    setF({ ...f, po_id: id, store_id: po?.store_id || f.store_id, supplier_id: po?.supplier_id || '' });
    setLines(po ? po.lines.map((l) => ({ ingredient_id: l.ingredient_id, name: l.name, unit: l.purchase_unit || l.unit, qty: String(l.qty), price: String(l.price), ordered: l.qty })) : []);
  };
  const sum = lines.reduce((n, l) => n + Math.round(num(l.qty) * num(l.price)), 0);
  const save = async () => {
    const r = await act(() => api('POST', '/api/purchases', {
      ...f, store_id: Number(f.store_id), po_id: f.po_id ? Number(f.po_id) : undefined, supplier_id: f.supplier_id ? Number(f.supplier_id) : undefined,
      advance_id: f.advance_id ? Number(f.advance_id) : undefined, paid_method: f.advance_id ? undefined : f.paid_method,
      total: f.total === '' ? undefined : num(f.total), photos,
      lines: lines.map((l) => ({ ingredient_id: l.ingredient_id, name: l.name, unit: l.unit, qty: num(l.qty), price: num(l.price) })),
    }), 'Đã gửi bill cho thu ngân duyệt');
    if (r) { setLines([]); setPhotos([]); setF({ ...f, po_id: '', total: '', signer_name: '', note: '', advance_id: '', paid_method: '' }); onDone(); }
  };
  if (!stores.length) return html`<div class="empty">Bạn chưa phụ trách khu nào để nhận hàng.</div>`;
  const myPos = (pos.data || []).filter((p) => stores.some((s) => s.id === p.store_id));
  return html`<section class="card stack">
    <p class="small muted">Nhận hàng: cân / đếm thực tế, nhập số thực nhận, <b>chụp bill có chữ ký người nhận</b>. Hàng vào kho ngay; thu ngân duyệt xong mới tính công nợ.</p>
    ${myPos.length ? html`<${Field} label="Theo đơn đặt hàng đã duyệt"><select value=${f.po_id} onChange=${(e) => usePo(e.target.value)}>
      <option value="">Không theo đơn (mua lẻ)</option>${myPos.map((p) => html`<option value=${p.id}>#${p.id} · ${p.supplier_name || 'Chưa có NCC'} · ${p.store_name} · ${money(p.total)}</option>`)}</select><//>` : null}
    ${!f.po_id ? html`
      <${Field} label="Khu nhận"><select value=${f.store_id} onChange=${(e) => set('store_id', e.target.value)}>${stores.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
      <${Field} label="Nhà cung cấp"><select value=${f.supplier_id} onChange=${(e) => set('supplier_id', e.target.value)}>
        <option value="">Nơi khác (ghi tên) / đi chợ</option>${meta.suppliers.filter((s) => s.active).map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
      ${!f.supplier_id ? html`<${Field} label="Tên nơi bán"><input value=${f.supplier_name} placeholder="vd Vựa rau Bé Thùy" onInput=${(e) => set('supplier_name', e.target.value)} /><//>` : null}` : null}
    <b>Hàng nhận</b>
    <${Lines} lines=${lines} setLines=${setLines} ingredients=${meta.ingredients} />
    <${Field} label="Tổng tiền ghi trên bill" hint=${`Cộng các dòng: ${money(sum)}. Để trống = lấy số cộng.`}><input inputmode="numeric" value=${f.total} placeholder=${String(sum || '')} onInput=${(e) => set('total', e.target.value)} /><//>
    <${Field} label="Tên người ký nhận trên bill"><input value=${f.signer_name} placeholder="Họ tên như chữ ký trên bill" onInput=${(e) => set('signer_name', e.target.value)} /><//>
    <${PhotoPicker} photos=${photos} setPhotos=${setPhotos} />
    ${photos.length ? (meta.bill_reader ? html`<button class="primary big" disabled=${reading} onClick=${readBill}>${reading ? '📖 Đang đọc bill… (10–40 giây)' : '📖 Đọc bill: tự điền hàng, số lượng, giá'}</button>`
      : html`<p class="small muted">📖 Đọc bill tự động: chưa cài (chủ quán dán mã Claude ở Cài đặt → Kết nối).</p>`) : null}
    ${readNote ? html`<p class="warn-text small">⚠ Máy đọc ghi chú: ${readNote}</p>` : null}
    <${Field} label="Thanh toán"><div class="chips">
      ${[['', 'Ghi nợ'], ['transfer', 'Đã CK tại chỗ'], ...(meta.is_cashier ? [['cash', 'Trả tiền mặt từ két']] : [])].map(([k, l]) => html`<button class=${`chip ${!f.advance_id && f.paid_method === k ? 'on' : ''}`} onClick=${() => setF({ ...f, paid_method: k, advance_id: '' })}>${l}</button>`)}
      ${myAdv.map((a) => html`<button class=${`chip ${Number(f.advance_id) === a.id ? 'on' : ''}`} onClick=${() => setF({ ...f, advance_id: String(a.id), paid_method: '' })}>Tiền tạm ứng ${money(a.amount)} (còn ${money(a.should_return)})</button>`)}
    </div><//>
    <${Field} label="Ghi chú"><input value=${f.note} onInput=${(e) => set('note', e.target.value)} /><//>
    <button class="primary" disabled=${!photos.length || !f.signer_name} onClick=${save}>Lưu & gửi thu ngân duyệt</button>
  </section>`;
}

function BillCard({ b, canApprove, me }) {
  const [reason, setReason] = useState(null);
  const [st, cls] = STATUS[b.status] || [b.status, ''];
  return html`<section class=${`card stack ${b.flags.length && b.status === 'received' ? 'warn-card' : ''}`}>
    <div class="row between wrap"><b>${b.supplier_name} · ${money(b.total)}</b><span class=${`pill ${cls}`}>${st}</span></div>
    <small class="muted">#${b.id} · ${b.store_name || ''} · ${dayLabel(b.date)} ${hm(b.received_at)} · nhận: ${b.received_by_name} · ký: <b>${b.signer_name}</b>
      · ${b.paid_method === 'cash' ? `trả TM ${money(b.paid_now)}` : b.paid_method === 'transfer' ? `đã CK ${money(b.paid_now)}` : b.paid_method === 'advance' ? 'tiền tạm ứng' : 'ghi nợ'}${b.po_id ? ` · đơn #${b.po_id}` : ''}</small>
    ${b.flags.length ? html`<ul class="small danger-text">${b.flags.map((x) => html`<li>${x}</li>`)}</ul>` : null}
    <${Photos} ids=${b.photos} />
    <details><summary class="small">${b.lines.length} dòng hàng · cộng ${money(b.lines_total)}</summary>
      <table class="list small"><tbody>${b.lines.map((l) => html`<tr><td>${l.name}</td><td class="r">${l.qty} ${l.unit}</td><td class="r">${money(l.price)}</td><td class="r">${money(l.amount)}</td></tr>`)}</tbody></table></details>
    ${b.status === 'returned' ? html`<p class="small danger-text">Trả lại: ${b.return_reason} (${b.returned_by_name})</p>` : null}
    ${b.status === 'approved' ? html`<small class="muted">Duyệt: ${b.approved_by_name} · ${hm(b.approved_at)}</small>` : null}
    ${b.status === 'received' && canApprove && (b.received_by !== me.id || me.role === 'owner') ? html`<div class="row">
      <button class="primary" onClick=${() => act(() => api('POST', `/api/purchases/${b.id}/approve`), 'Đã duyệt, cộng công nợ')}>✓ Đúng, duyệt</button>
      <button onClick=${() => setReason('')}>Trả lại</button></div>` : null}
    ${b.status === 'received' && b.received_by === me.id && me.role !== 'owner' ? html`<small class="muted">Chờ người khác duyệt (người nhận không tự duyệt).</small>` : null}
    ${b.status === 'returned' && b.received_by === me.id ? html`<${FixBill} b=${b} />` : null}
    ${reason != null ? html`<${Modal} title="Trả lại bill" onClose=${() => setReason(null)}>
      <${Field} label="Lý do (vd ảnh mờ, sai số lượng, sai tổng)"><input value=${reason} onInput=${(e) => setReason(e.target.value)} /><//>
      <button class="primary" disabled=${!reason} onClick=${async () => { if (await act(() => api('POST', `/api/purchases/${b.id}/return`, { reason }), 'Đã trả lại cho khu sửa')) setReason(null); }}>Trả lại</button><//>` : null}
  </section>`;
}

function FixBill({ b }) {
  const [total, setTotal] = useState(String(b.total));
  const [photos, setPhotos] = useState([]);
  return html`<div class="stack"><b class="small">Sửa lại</b>
    <${Field} label="Tổng tiền trên bill"><input inputmode="numeric" value=${total} onInput=${(e) => setTotal(e.target.value)} /><//>
    <${PhotoPicker} photos=${photos} setPhotos=${setPhotos} />
    <button class="primary" onClick=${() => act(() => api('PATCH', `/api/purchases/${b.id}`, { total: num(total), photos }), 'Đã gửi duyệt lại')}>Gửi duyệt lại</button></div>`;
}

function Debts({ me }) {
  const st = useData('/api/suppliers/debts');
  const [pay, setPay] = useState(null);
  const [stmt, setStmt] = useState(null);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  return html`<div class="stack">
    <section class="kpis"><div class="kpi main"><small>Tổng nợ NCC (bill đã duyệt)</small><b>${money(d.total)}</b><small class="muted">Chi trên ${money(d.approve_over)} cần chủ / quản lý duyệt</small></div></section>
    ${d.waiting.length ? html`<section class="card stack"><b>Khoản chi chờ duyệt</b>${d.waiting.map((p) => html`<div class="row between wrap">
      <span>${p.supplier_name} · <b>${money(p.amount)}</b> · ${p.method === 'cash' ? 'tiền mặt' : 'CK'} · ${p.created_by_name}</span>
      ${d.is_boss ? html`<div class="row"><button class="primary small" onClick=${() => act(() => api('POST', `/api/supplier-payments/${p.id}/approve`), 'Đã duyệt chi')}>Duyệt</button>
        <button class="small" onClick=${() => act(() => api('POST', `/api/supplier-payments/${p.id}/approve`, { reject: true }), 'Đã từ chối')}>Từ chối</button></div>` : html`<small class="muted">chờ chủ duyệt</small>`}</div>`)}</section>` : null}
    ${[...d.suppliers].sort((a, b) => b.debt - a.debt).map((s) => html`<section class="card stack">
      <div class="row between"><b>${s.name}</b><b class=${s.debt > 0 ? 'danger-text' : 'muted'}>${money(s.debt)}</b></div>
      <small class="muted">${s.last_bill ? `Lần mua cuối ${dayLabel(s.last_bill)}` : 'Chưa mua'}${s.pending.n ? ` · ${s.pending.n} bill chưa duyệt ${money(s.pending.t)}` : ''}</small>
      <div class="row">
        <button class="small" onClick=${() => setStmt(s)}>Sổ nợ</button>
        ${s.debt > 0 ? html`<button class="small primary" onClick=${() => setPay(s)}>Trả</button>` : null}</div></section>`)}
    ${pay ? html`<${PayModal} s=${pay} txns=${d.out_txns} onClose=${() => setPay(null)} />` : null}
    ${stmt ? html`<${Statement} s=${stmt} onClose=${() => setStmt(null)} />` : null}
  </div>`;
}

function PayModal({ s, txns, onClose }) {
  const [f, setF] = useState({ amount: String(s.debt), method: 'transfer', note: '', bank_txn_id: '' });
  const [photos, setPhotos] = useState([]);
  return html`<${Modal} title=${`Trả ${s.name}`} onClose=${onClose}>
    <p class="small">Còn nợ <b>${money(s.debt)}</b></p>
    <${Field} label="Số tiền"><input inputmode="numeric" value=${f.amount} onInput=${(e) => setF({ ...f, amount: e.target.value })} /><//>
    <div class="chips">${[['transfer', 'Chuyển khoản'], ['cash', 'Tiền mặt từ két']].map(([k, l]) => html`<button class=${`chip ${f.method === k ? 'on' : ''}`} onClick=${() => setF({ ...f, method: k })}>${l}</button>`)}</div>
    ${f.method === 'transfer' && txns.length ? html`<${Field} label="Giao dịch ngân hàng (tiền ra, SePay báo)"><select value=${f.bank_txn_id} onChange=${(e) => { const t = txns.find((x) => x.id === Number(e.target.value)); setF({ ...f, bank_txn_id: e.target.value, amount: t ? String(t.amount) : f.amount }); }}>
      <option value="">Chưa có / chụp màn hình CK</option>${txns.map((t) => html`<option value=${t.id}>${money(t.amount)} · ${t.content} · ${t.date}</option>`)}</select><//>` : null}
    ${!f.bank_txn_id ? html`<${PhotoPicker} photos=${photos} setPhotos=${setPhotos} />` : null}
    <${Field} label="Ghi chú"><input value=${f.note} onInput=${(e) => setF({ ...f, note: e.target.value })} /><//>
    <button class="primary" onClick=${async () => { const r = await act(() => api('POST', `/api/suppliers/${s.id}/pay`, { amount: num(f.amount), method: f.method, note: f.note, bank_txn_id: f.bank_txn_id ? Number(f.bank_txn_id) : undefined, photo: photos[0] })); if (r) { onClose(); } }}>Ghi khoản trả</button>
  <//>`;
}

function Statement({ s, onClose }) {
  const [to] = useState(() => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10));
  const [from, setFrom] = useState(`${to.slice(0, 8)}01`);
  const st = useData(`/api/suppliers/${s.id}/statement?from=${from}&to=${to}`);
  const x = st.data;
  return html`<${Modal} title=${`Sổ công nợ · ${s.name}`} onClose=${onClose} wide>
    <div class="row wrap"><label>Từ <input type="date" value=${from} onChange=${(e) => setFrom(e.target.value)} /></label>
      <a class="button" href=${`/api/suppliers/${s.id}/statement.xlsx?from=${from}&to=${to}`} download>⬇ Excel gửi NCC đối chiếu</a></div>
    ${!x ? html`<${Loading} state=${st} />` : html`<div class="table-wrap"><table class="list small"><thead><tr><th>Ngày</th><th>Chứng từ</th><th class="r">Mua</th><th class="r">Trả</th><th class="r">Còn nợ</th></tr></thead><tbody>
      <tr><td colspan="4">Nợ đầu kỳ</td><td class="r">${money(x.opening)}</td></tr>
      ${x.rows.map((r) => html`<tr><td>${r.date.slice(8)}/${r.date.slice(5, 7)}</td><td>${r.ref}<br /><small class="muted">${r.note}</small></td><td class="r">${r.plus ? money(r.plus) : ''}</td><td class="r">${r.minus ? money(r.minus) : ''}</td><td class="r">${money(r.balance)}</td></tr>`)}
      <tr><td colspan="2"><b>Cuối kỳ</b></td><td class="r"><b>${money(x.bought)}</b></td><td class="r"><b>${money(x.paid)}</b></td><td class="r"><b>${money(x.closing)}</b></td></tr>
    </tbody></table></div>`}<//>`;
}

function Advances({ me, isCashier, advances }) {
  const staff = useData(isCashier ? '/api/advances/staff' : null);
  const [f, setF] = useState({ staff_id: '', amount: '', note: '' });
  const [settle, setSettle] = useState(null);
  const list = advances.data || [];
  return html`<div class="stack">
    ${isCashier ? html`<section class="card stack"><b>Đưa tạm ứng đi chợ</b>
      <select value=${f.staff_id} onChange=${(e) => setF({ ...f, staff_id: e.target.value })}><option value="">Chọn người đi chợ…</option>${(staff.data || []).map((s) => html`<option value=${s.id}>${s.name} · ${s.team_name || ''}</option>`)}</select>
      <input inputmode="numeric" placeholder="Số tiền" value=${f.amount} onInput=${(e) => setF({ ...f, amount: e.target.value })} />
      <input placeholder="Ghi chú (mua gì)" value=${f.note} onInput=${(e) => setF({ ...f, note: e.target.value })} />
      <button class="primary" disabled=${!f.staff_id || !f.amount} onClick=${async () => { if (await act(() => api('POST', '/api/advances', { staff_id: Number(f.staff_id), amount: num(f.amount), note: f.note }), 'Đã ghi tạm ứng (tiền mặt ra khỏi két)')) setF({ staff_id: '', amount: '', note: '' }); }}>Ghi tạm ứng</button></section>` : null}
    ${list.length ? list.map((a) => html`<section class="card row between wrap">
      <div><b>${a.staff_name}</b> · ứng ${money(a.amount)}<br /><small class="muted">${dayLabel(a.date)} · ${a.bills} bill ${money(a.spent)}${a.note ? ` · ${a.note}` : ''}</small></div>
      ${a.status === 'open' ? html`<div class="row"><span>Phải trả lại <b>${money(a.should_return)}</b></span>${isCashier && (a.staff_id !== me.id || me.role === 'owner') ? html`<button class="small primary" onClick=${() => setSettle(a)}>Hoàn ứng</button>` : null}</div>`
        : html`<span class=${`pill ${a.diff ? 'bad' : 'ok'}`}>${a.diff ? `Lệch ${money(a.diff)}` : 'Đã quyết toán'}</span>`}</section>`) : html`<div class="empty">Chưa có tạm ứng nào.</div>`}
    ${settle ? html`<${SettleModal} a=${settle} onClose=${() => setSettle(null)} />` : null}
  </div>`;
}

function SettleModal({ a, onClose }) {
  const [v, setV] = useState(String(a.should_return));
  return html`<${Modal} title=${`Hoàn ứng · ${a.staff_name}`} onClose=${onClose}>
    <p class="small">Ứng ${money(a.amount)} · ${a.bills} bill ${money(a.spent)} → phải trả lại <b>${money(a.should_return)}</b></p>
    <${Field} label="Tiền thừa thực nhận lại (đếm)"><input inputmode="numeric" value=${v} onInput=${(e) => setV(e.target.value)} /><//>
    <button class="primary" onClick=${async () => { if (await act(() => api('POST', `/api/advances/${a.id}/settle`, { returned: num(v) }), 'Đã quyết toán')) onClose(); }}>Xác nhận</button><//>`;
}

export function PurchasesView({ me, query }) {
  const meta0 = useData('/api/stock/meta');
  const list = useData('/api/purchases');
  const advances = useData('/api/advances');
  const tab = query.get('tab') || 'nhan';
  if (!meta0.data || !list.data) return html`<${Loading} state=${meta0.data ? list : meta0} />`;
  const L = list.data;
  const isCashier = L.can_approve;
  const meta = { ...meta0.data, is_cashier: isCashier, bill_reader: !!L.bill_reader };
  const waiting = L.bills.filter((b) => b.status === 'received');
  const mineReturned = L.bills.filter((b) => b.status === 'returned' && b.received_by === me.id);
  const tabs = [['nhan', 'Nhận hàng'], ...(isCashier ? [['duyet', `Chờ duyệt (${L.pending})`]] : []), ['lichsu', 'Bill đã nhận'], ...(isCashier ? [['congno', 'Công nợ NCC']] : []), ['tamung', 'Tạm ứng']];
  return html`<div class="stack">
    <div class="tabs scroll">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => navigate(`/mua-hang?tab=${k}`)}>${l}</button>`)}</div>
    ${mineReturned.length && tab !== 'lichsu' ? html`<section class="card warn-card small">${mineReturned.length} bill bạn nhận bị thu ngân trả lại. <button class="small" onClick=${() => navigate('/mua-hang?tab=lichsu')}>Xem & sửa</button></section>` : null}
    ${tab === 'nhan' ? html`<${Receive} me=${me} meta=${meta} advances=${advances} onDone=${() => navigate('/mua-hang?tab=lichsu')} />` : null}
    ${tab === 'duyet' ? (waiting.length ? html`<p class="small muted">So ảnh bill với số khu nhập: số lượng, đơn giá, tổng, chữ ký người nhận. Dòng đỏ = app thấy lệch.</p>${waiting.map((b) => html`<${BillCard} key=${b.id} b=${b} canApprove=${isCashier} me=${me} />`)}` : html`<div class="empty">Không có bill chờ duyệt.</div>`) : null}
    ${tab === 'lichsu' ? (L.bills.length ? L.bills.map((b) => html`<${BillCard} key=${b.id} b=${b} canApprove=${isCashier} me=${me} />`) : html`<div class="empty">Chưa có bill trong 30 ngày.</div>`) : null}
    ${tab === 'congno' ? html`<${Debts} me=${me} />` : null}
    ${tab === 'tamung' ? html`<${Advances} me=${me} isCashier=${isCashier} advances=${advances} />` : null}
  </div>`;
}
