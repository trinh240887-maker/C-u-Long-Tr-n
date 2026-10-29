import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, money, hm, dayLabel, addDays, Modal, Field, navigate, toast, can as canAct } from '../ui.js';
import { compressImage } from './checklists.js';
import { Conversions } from './stock.js';

// Mua hàng: khu nhận hàng chụp bill NCC (ký nhận) → thu ngân duyệt → công nợ NCC → trả NCC / tạm ứng đi chợ
const STATUS = { waiting: ['⏳ Chờ nhận hàng', 'warn'], received: ['Chờ thu ngân duyệt', 'warn'], approved: ['Đã duyệt', 'ok'], returned: ['Bị trả lại, cần sửa', 'bad'], void: ['Đã huỷ', 'muted'] };
const num = (s) => Number(String(s ?? '').replace(/[.\s]/g, '').replace(',', '.')) || 0; // tiền: dấu chấm = ngăn nghìn
// Số lượng: dấu chấm hay dấu phẩy đều là số lẻ (28.1 / 28,1 = 28,1 kg). Trước đây dùng num() → 28.1 thành 281 (lỗi 26/10)
const qtyNum = (s) => Number(String(s ?? '').replace(/\s/g, '').replace(',', '.')) || 0;

function Photos({ ids }) {
  const [view, setView] = useState(null);
  return html`<div class="thumbs">${ids.map((id) => html`<span class="thumb"><img src=${`/api/purchases/photo/${id}`} loading="lazy" alt="Ảnh bill" onClick=${() => setView(id)} /></span>`)}
    ${view ? html`<div class="viewer" onClick=${() => setView(null)}><img src=${`/api/purchases/photo/${view}`} alt="Ảnh bill" /></div>` : null}</div>`;
}

// gallery: cho chọn ảnh có sẵn (chỉ quản lý / chủ quán, hoặc ảnh chuyển khoản). Nhân viên nhận hàng phải chụp trực tiếp bill + hàng (chủ quán 26/10)
function PhotoPicker({ photos, setPhotos, first = '📷 Chụp bill NCC (bắt buộc, thấy rõ chữ ký người nhận)', more = '📷 Chụp thêm trang bill', onAdded = null, gallery = false }) {
  const [busy, setBusy] = useState(false);
  const add = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    setBusy(true);
    try { const out = []; for (const f of files.slice(0, 4 - photos.length)) out.push(await compressImage(f, 1600)); const next = [...photos, ...out]; setPhotos(next); onAdded?.(next); } catch (err) { act(() => Promise.reject(err)); } finally { setBusy(false); }
  };
  return html`<div class="stack">
    ${photos.length ? html`<div class="thumbs">${photos.map((p, i) => html`<span class="thumb"><img src=${p} alt="Ảnh" /><button class="x" aria-label="Xoá ảnh" onClick=${() => setPhotos(photos.filter((_, k) => k !== i))}>✕</button></span>`)}</div>` : null}
    ${photos.length < 4 ? html`<label class=${`btn-photo ${photos.length ? '' : 'need'}`}><input type="file" accept="image/*" capture="environment" multiple hidden onChange=${add} />
      ${busy ? 'Đang xử lý ảnh…' : photos.length ? more : first}</label>
      ${gallery ? html`<label class="button small" style="align-self:flex-start">🖼 Chọn ảnh có sẵn<input type="file" accept="image/*" multiple hidden onChange=${add} /></label>` : null}` : null}
  </div>`;
}

function Lines({ lines, setLines, ingredients }) {
  const set = (i, k, val) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: val } : l)));
  return html`<div class="stack">
    ${lines.map((l, i) => html`<div class=${`pline ${l.warn ? "pline-warn" : ""}`}>
      ${l.ingredient_id ? html`<b>${l.name}</b>` : html`<input placeholder="Tên hàng (vd Cải thìa)" value=${l.name} onInput=${(e) => set(i, 'name', e.target.value)} />`}
      <div class="row">
        <label>SL <input inputmode="decimal" style="width:5em" value=${l.qty} onInput=${(e) => set(i, 'qty', e.target.value)} /> ${l.unit || ''}</label>
        <label>Đơn giá <input inputmode="numeric" style="width:7em" value=${l.price} onInput=${(e) => set(i, 'price', e.target.value)} /></label>
        <button class="small icon" aria-label="Xoá dòng" onClick=${() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
      </div>
      ${l.unconv ? html`<small class="muted">Bill ghi ${l.bill_qty} ${l.bill_unit}: nhập đúng như bill, chủ quán quy đổi sau</small>`
        : l.ingredient_id && l.bill_unit && l.factor && l.factor !== 1 ? html`<small class="muted">Bill ghi ${l.bill_qty} ${l.bill_unit} → app tự quy đổi ${l.qty} ${l.unit}</small>` : null}
      <small class="muted">= ${money(Math.round(qtyNum(l.qty) * num(l.price)))}${l.ordered != null ? ` · đặt ${l.ordered}` : ''}${l.ai ? ' · 📖 máy đọc' : ''}</small>
      ${l.warn ? html`<small class="warn-text">⚠ ${l.warn}</small>` : null}
      ${num(l.price) >= 5_000_000 || Math.round(qtyNum(l.qty) * num(l.price)) >= 50_000_000 ? html`<small class="danger-text">⚠ Số tiền dòng này quá lớn (${money(Math.round(qtyNum(l.qty) * num(l.price)))}): máy đọc có thể thừa số 0, sửa SL / đơn giá</small>` : null}
      ${!l.ingredient_id && (l.name || '').trim() ? (l.create_new
        ? html`<small class="ok-text">✅ Lưu bill sẽ tạo mã mới trong kho: <b>${l.name}</b> (${l.unit || 'cái'}) · <button class="link small" onClick=${() => setLines(lines.map((x, j) => (j === i ? { ...x, create_new: false } : x)))}>bỏ</button></small>`
        : html`<div class="stack tight">
          <button class="primary small" onClick=${() => setLines(lines.map((x, j) => (j === i ? { ...x, create_new: true, warn: '' } : x)))}>✅ OK, tạo mã mới "${l.name}" trong kho</button>
          <select onChange=${(e) => { const g = ingredients.find((x) => x.id === Number(e.target.value)); if (g) setLines(lines.map((x, j) => (j === i ? { ...x, ingredient_id: g.id, name: g.name, unit: g.purchase_unit || g.unit, warn: '' } : x))); }}>
            <option value="">…hoặc là hàng có sẵn trong kho (tên khác)</option>${ingredients.map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select>
          <small class="muted">Hàng không cần theo dõi kho (ga, đá…) thì để nguyên.</small></div>`) : null}
    </div>`)}
    <div class="row wrap">
      <select onChange=${(e) => { const g = ingredients.find((x) => x.id === Number(e.target.value)); e.target.value = ''; if (g && !lines.some((l) => l.ingredient_id === g.id)) setLines([...lines, { ingredient_id: g.id, name: g.name, unit: g.purchase_unit || g.unit, qty: '', price: g.price || '' }]); }}>
        <option value="">+ Thêm hàng có trong kho…</option>${ingredients.map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select>
      <button class="small" onClick=${() => setLines([...lines, { name: '', unit: '', qty: '', price: '' }])}>+ Hàng khác (ga, đá, đồ dùng…)</button>
    </div>
  </div>`;
}

// Nhập kho 3 bước: 📷 bill + 📷 hàng → app đọc bill tự điền → ✓ Xác nhận (cộng kho ngay, thu ngân duyệt công nợ sau)
function Receive({ me, meta, advances, onDone, arriving = [] }) {
  const stores = meta.stores.filter((s) => s.can_count && (!meta.single || s.kind === 'main')); // kho chung: chỉ nhận vào Kho tổng
  const pos = useData('/api/stock/po?status=approved');
  const [f, setF] = useState({ store_id: stores[0]?.id || '', po_id: '', supplier_id: '', supplier_name: '', signer_name: me.name, total: '', paid_method: '', advance_id: '', note: '' });
  const [lines, setLines] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [goods, setGoods] = useState([]);
  const [more, setMore] = useState(false);
  // 📩 Bill NCC gửi trước qua Zalo, hàng chưa về (chủ quán 28/10): lưu bill chờ nhận, kho chưa cộng; bếp nhận hàng mới cộng
  const [pre, setPre] = useState(false);
  const set = (k, val) => setF({ ...f, [k]: val });
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState('');
  const readBill = async (pics = photos) => {
    setReading(true); setReadNote('');
    try {
      const r = await api('POST', '/api/purchases/read-bill', { photos: pics });
      const got = r.lines.map((l) => ({ ingredient_id: l.ingredient_id || undefined, name: l.name, unit: l.unit, qty: String(l.qty), price: String(l.price), ai: true,
        bill_qty: l.bill_qty, bill_unit: l.bill_unit, bill_price: l.bill_price, factor: l.factor,
        // Chưa biết quy đổi (bill ghi két, kho tính chai…): nhập đúng số trên bill, chủ quán quy đổi sau (chủ quán 28/10)
        ...(l.need_factor ? { unconv: true, unit: l.bill_unit, qty: String(l.bill_qty), price: String(l.bill_price) } : {}),
        warn: !l.ingredient_id ? 'Chưa có trong kho' : '' }));
      setLines((cur) => (f.po_id ? cur.map((l) => { const g = got.find((x) => x.ingredient_id && x.ingredient_id === l.ingredient_id); return g ? { ...l, qty: g.qty, price: g.price, ai: true, warn: g.warn } : l; }).concat(got.filter((g) => !cur.some((l) => l.ingredient_id && l.ingredient_id === g.ingredient_id))) : got));
      // Khu nhận tự chọn theo "khu chính" của các mặt hàng trên bill (vd nước ngọt → Bar, gas → Bếp) (chủ quán 26/10)
      const votes = new Map();
      for (const l of got) { const g = l.ingredient_id && meta.ingredients.find((x) => x.id === l.ingredient_id); if (g?.home_store_id && stores.some((s0) => s0.id === g.home_store_id)) votes.set(g.home_store_id, (votes.get(g.home_store_id) || 0) + 1); }
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      setF((x) => ({ ...x, ...(x.po_id ? {} : { supplier_id: r.supplier_id ? String(r.supplier_id) : '', supplier_name: r.supplier_id ? '' : r.supplier_name, ...(best ? { store_id: best } : {}) }), total: r.total ? String(r.total) : x.total }));
      setReadNote(r.note);
      toast(`Đã đọc ${got.length} dòng: xem lại số lượng, giá rồi bấm Xác nhận`);
    } catch (e) { act(() => Promise.reject(e)); } finally { setReading(false); }
  };
  // Chụp bill xong tự đọc luôn (khi đã cài mã Claude và chưa có dòng nào)
  const onBill = (next) => { if (meta.bill_reader && !lines.length && !reading) readBill(next); };
  const myAdv = (advances.data || []).filter((a) => a.status === 'open' && a.staff_id === me.id);
  const usePo = (id) => {
    const po = (pos.data || []).find((p) => p.id === Number(id));
    setF({ ...f, po_id: id, store_id: po?.store_id || f.store_id, supplier_id: po?.supplier_id || '' });
    setLines(po ? po.lines.map((l) => ({ ingredient_id: l.ingredient_id, name: l.name, unit: l.purchase_unit || l.unit, qty: String(l.qty), price: String(l.price), ordered: l.qty })) : []);
  };
  const sum = lines.reduce((n, l) => n + Math.round(qtyNum(l.qty) * num(l.price)), 0);
  const warns = lines.filter((l) => l.warn).length;
  const ready = photos.length && (pre || goods.length) && lines.length && (f.supplier_id || f.supplier_name || f.po_id) && f.signer_name;
  const totNow = f.total === '' ? sum : num(f.total);
  const mismatch = f.total !== '' && Math.abs(sum - totNow) > Math.max(50000, totNow * 0.05);
  const [okMismatch, setOkMismatch] = useState(false);
  const save = async () => {
    const tot = f.total === '' ? sum : num(f.total);
    const confirm_mismatch = mismatch ? okMismatch : false;
    if (mismatch && !okMismatch) { toast(`Cộng các dòng ${money(sum)} lệch tổng bill ${money(tot)}: sửa lại các dòng, hoặc tick "Đúng như bill" phía trên nút`, true); return; }
    // Bill giống bill đã lưu (cùng NCC, tổng, hàng) → hỏi có phải chụp trùng không (chủ quán 29/10)
    const postBill = (body) => api('POST', '/api/purchases', body).catch((e) => {
      if (e.code !== 'dup_bill') throw e;
      if (!confirm(`⚠ ${e.message}\n\nOK = đây là bill KHÁC, vẫn lưu.\nHuỷ = chụp trùng, không lưu.`)) throw new Error('Không lưu: bill trùng');
      return api('POST', '/api/purchases', { ...body, confirm_dup: true });
    });
    const r = await act(() => postBill({ confirm_mismatch, pre_bill: pre || undefined,
      ...f, store_id: Number(f.store_id), po_id: !pre && f.po_id ? Number(f.po_id) : undefined, // bill gửi trước: không theo đơn (rà soát 28/10) supplier_id: f.supplier_id ? Number(f.supplier_id) : undefined,
      advance_id: f.advance_id ? Number(f.advance_id) : undefined, paid_method: f.advance_id ? undefined : f.paid_method,
      total: f.total === '' ? undefined : num(f.total), photos, goods_photos: goods,
      lines: lines.map((l) => ({ ingredient_id: l.ingredient_id, name: l.name, unit: l.unit, qty: qtyNum(l.qty), price: num(l.price), create_new: !l.ingredient_id && !!l.create_new, unconv: !!l.unconv })),
    }), pre ? 'Đã lưu bill chờ nhận hàng. Bếp nhận hàng xong kho mới cộng' : 'Đã nhập kho. Thu ngân sẽ duyệt công nợ');
    const dupWarn = (r?.flags || []).filter((x) => /2 dòng khác giá/.test(x));
    if (dupWarn.length) toast(`⚠ ${dupWarn.join('\n')}`, true);
    if (r && pre) { setLines([]); setPhotos([]); setGoods([]); setF({ ...f, supplier_id: '', supplier_name: '', total: '', note: '', paid_method: '' }); navigate('/mua-hang?tab=cho'); return; }
    if (r) { setLines([]); setPhotos([]); setGoods([]); setF({ ...f, po_id: '', supplier_id: '', supplier_name: '', total: '', signer_name: me.name, note: '', advance_id: '', paid_method: '' }); onDone(); }
  };
  if (!stores.length) return html`<div class="empty">Bạn chưa phụ trách khu nào để nhận hàng.</div>`;
  const myPos = (pos.data || []).filter((p) => stores.some((s) => s.id === p.store_id));
  // Bill gửi trước: hỏi đã trả tiền chưa ngay dưới các dòng hàng (chủ quán 29/10: hay trả trước, chỉ chờ hàng về)
  const payField = html`<${Field} label=${pre ? 'Đã trả tiền cho NCC chưa?' : 'Thanh toán'}><div class="chips">
          ${[['', pre ? 'Chưa trả (ghi nợ)' : 'Ghi nợ'], ['transfer', pre ? '✅ Đã thanh toán (chuyển khoản)' : 'Đã CK tại chỗ'], ...(meta.is_cashier && !pre ? [['cash', 'Trả tiền mặt từ két']] : [])].map(([k, l]) => html`<button class=${`chip ${!f.advance_id && f.paid_method === k ? 'on' : ''}`} onClick=${() => setF({ ...f, paid_method: k, advance_id: '' })}>${l}</button>`)}
          ${(pre ? [] : myAdv).map((a) => html`<button class=${`chip ${Number(f.advance_id) === a.id ? 'on' : ''}`} onClick=${() => setF({ ...f, advance_id: String(a.id), paid_method: '' })}>Tiền tạm ứng ${money(a.amount)} (còn ${money(a.should_return)})</button>`)}
        </div><//>`;
  return html`<div class="stack">
    ${arriving.length && !pre ? html`<section class="card stack warn-card"><b>⏳ Hàng sắp về theo bill đã có (${arriving.length})</b>
      <small>Hàng về thuộc các bill này thì <b>không nhập lại ở đây</b>: bấm vào bill để kiểm & nhận.</small>
      ${arriving.map((b) => html`<button class="link-btn" style="text-align:left" onClick=${() => navigate('/mua-hang?tab=cho')}><b>${b.supplier_name}</b> · ${b.lines.map((l) => `${l.name} ${l.qty} ${l.unit}`).join(', ')}</button>`)}</section>` : null}
    ${canAct(me, 'mh.apbill') ? html`<div class="chips">
      <button class=${`chip ${!pre ? 'on' : ''}`} onClick=${() => setPre(false)}>📥 Hàng đã về, nhận ngay</button>
      <button class=${`chip ${pre ? 'on' : ''}`} onClick=${() => { setPre(true); setF({ ...f, po_id: '', ...(f.paid_method === 'cash' || f.advance_id ? { paid_method: '', advance_id: '' } : {}) }); }}>📩 Bill NCC gửi trước, hàng chưa về</button></div>` : null}
    ${pre ? html`<p class="hint card small">Lưu bill để <b>chờ nhận hàng</b>: kho chưa cộng. Bếp / khu nhận hàng kiểm, chụp ảnh hàng rồi bấm <b>Đã nhận hàng</b> thì kho mới cộng. Nhận đủ: bill tự duyệt. Nhận thiếu: chờ thu ngân duyệt.</p>` : null}
    <section class="card stack"><h3>1 · ${pre ? 'Ảnh bill NCC gửi' : 'Chụp ảnh'}</h3>
      <${PhotoPicker} photos=${photos} setPhotos=${setPhotos} onAdded=${onBill} first=${pre ? '📷 Chụp / chọn ảnh BILL' : '📷 Chụp BILL (bắt buộc)'} more="📷 Thêm trang bill" gallery=${pre || ['manager', 'owner'].includes(me.role)} />
      ${!pre ? html`<${PhotoPicker} photos=${goods} setPhotos=${setGoods} first="📷 Chụp HÀNG thực nhận (bắt buộc)" more="📷 Thêm ảnh hàng" />` : null}
    </section>
    <section class="card stack"><h3>2 · Hàng nhận ${lines.length ? html`<small class="muted">${lines.length} dòng · ${money(sum)}</small>` : null}</h3>
      ${reading ? html`<p class="hint card">📖 Đang đọc bill… (10–40 giây)</p>` : null}
      ${!meta.bill_reader ? html`<p class="small muted">Đọc bill tự động chưa bật (chủ quán dán mã Claude ở Cài đặt → Kết nối). Thêm hàng bằng tay bên dưới.</p>`
        : photos.length && !reading ? html`<button class="small" onClick=${() => readBill()}>📖 Đọc lại bill</button>` : null}
      ${readNote ? html`<p class="warn-text small">⚠ ${readNote}</p>` : null}
      ${warns ? html`<p class="warn-text small">⚠ ${warns} dòng cần xem lại (tô vàng)</p>` : null}
      ${myPos.length && !pre ? html`<${Field} label="Theo đơn đặt hàng đã duyệt"><select value=${f.po_id} onChange=${(e) => usePo(e.target.value)}>
        <option value="">Không theo đơn (mua lẻ)</option>${myPos.map((p) => html`<option value=${p.id}>#${p.id} · ${p.supplier_name || 'Chưa có NCC'} · ${money(p.total)}</option>`)}</select><//>` : null}
      ${!f.po_id ? html`<${Field} label="Nhà cung cấp"><select value=${f.supplier_id} onChange=${(e) => set('supplier_id', e.target.value)}>
          <option value="">Nơi khác (ghi tên) / đi chợ</option>${meta.suppliers.filter((s) => s.active).map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
        ${!f.supplier_id ? html`<${Field} label="Tên nơi bán"><input value=${f.supplier_name} placeholder="vd Vựa rau Bé Thùy" onInput=${(e) => set('supplier_name', e.target.value)} /><//>` : null}` : null}
      <${Lines} lines=${lines} setLines=${setLines} ingredients=${meta.ingredients} />
      ${pre ? payField : null}
      ${stores.length > 1 && !f.po_id ? html`<${Field} label="Khu nhận"><select value=${f.store_id} onChange=${(e) => set('store_id', e.target.value)}>${stores.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>` : null}
    </section>
    <section class="card stack">
      <button class="link-btn" onClick=${() => setMore(!more)}><b>${more ? '▾' : '▸'} Thêm</b> <small class="muted">(tổng bill, người ký, thanh toán, ghi chú)</small></button>
      ${more ? html`
        <${Field} label="Tổng tiền ghi trên bill" hint=${`Cộng các dòng: ${money(sum)}. Để trống = lấy số cộng.`}><input inputmode="numeric" value=${f.total} placeholder=${String(sum || '')} onInput=${(e) => set('total', e.target.value)} /><//>
        <${Field} label="Người ký nhận trên bill"><input value=${f.signer_name} onInput=${(e) => set('signer_name', e.target.value)} /><//>
        ${!pre ? payField : null}
        <${Field} label="Ghi chú"><input value=${f.note} onInput=${(e) => set('note', e.target.value)} /><//>` : null}
    </section>
    <div class="sum-bar stack">
      ${mismatch ? html`<div class="card tight stack" style="border:2px solid var(--danger, #c92a2a)"><b class="danger-text">⚠ Cộng các dòng ${money(sum)} ≠ tổng bill ${money(totNow)}${totNow && sum / totNow >= 8 ? ` (gấp ~${Math.round(sum / totNow)} lần: có dòng thừa số 0 hoặc mất dấu phẩy)` : ''}</b>
        <small>Sửa các dòng có cảnh báo đỏ. Nếu bill đúng như vậy thật thì tick ô dưới.</small>
        <label class="check-row"><input type="checkbox" checked=${okMismatch} onChange=${(e) => setOkMismatch(e.target.checked)} /> <span>Đúng như bill, vẫn lưu</span></label></div>` : null}
      ${!ready ? html`<b class="danger-text">⚠ ${!photos.length ? 'Thiếu ảnh bill' : !pre && !goods.length ? 'Thiếu ảnh hàng thực nhận' : !lines.length ? 'Chưa có dòng hàng' : 'Chọn nhà cung cấp'}</b>` : null}
      ${photos.length && !goods.length && !pre ? html`<${PhotoPicker} photos=${goods} setPhotos=${setGoods} first="📷 Chụp ảnh HÀNG ngay" more="📷 Thêm ảnh hàng" />` : null}
      <button class="primary big" disabled=${!ready || reading} onClick=${save}>${pre ? '📩 Lưu bill chờ nhận hàng' : '✓ Xác nhận nhập kho'}${lines.length ? ` · ${money(f.total === '' ? sum : num(f.total))}` : ''}</button>
    </div>
  </div>`;
}

function BillCard({ b, canApprove, me }) {
  const [reason, setReason] = useState(null);
  const [edit, setEdit] = useState(false);
  const [payBill, setPayBill] = useState(false);
  const [st, cls] = STATUS[b.status] || [b.status, ''];
  return html`<section class=${`card stack ${b.flags.length && b.status === 'received' ? 'warn-card' : ''}`}>
    <div class="row between wrap"><b>${b.supplier_name} · ${money(b.total)}</b><span class=${`pill ${cls}`}>${st}</span></div>
    <small class="muted">#${b.id} · ${b.store_name || ''} · ${dayLabel(b.date)} ${hm(b.received_at)} · nhận: ${b.received_by_name} · ký: <b>${b.signer_name}</b>
      · ${b.paid_method === 'cash' ? `trả TM ${money(b.paid_now)}` : b.paid_method === 'transfer' ? `đã CK ${money(b.paid_now)}` : b.paid_method === 'advance' ? 'tiền tạm ứng' : 'ghi nợ'}${b.po_id ? ` · đơn #${b.po_id}` : ''}</small>
    ${b.flags.length ? html`<ul class="small danger-text">${b.flags.map((x) => html`<li>${x}</li>`)}</ul>` : null}
    <${Photos} ids=${b.photos} />
    ${b.goods_photos?.length ? html`<small class="muted">Ảnh hàng nhận:</small><${Photos} ids=${b.goods_photos} />` : null}
    <details><summary class="small">${b.lines.length} dòng hàng · cộng ${money(b.lines_total)}</summary>
      <table class="list small"><tbody>${b.lines.map((l) => html`<tr><td>${l.name}</td><td class="r">${l.qty} ${l.unit}</td><td class="r">${money(l.price)}</td><td class="r">${money(l.amount)}</td></tr>`)}</tbody></table></details>
    ${b.status === 'returned' ? html`<p class="small danger-text">Trả lại: ${b.return_reason} (${b.returned_by_name})</p>` : null}
    ${b.paid_now ? html`<small class="muted">Trả tại chỗ ${money(b.paid_now)} (${b.paid_method === 'cash' ? 'tiền mặt' : b.paid_method === 'advance' ? 'tạm ứng' : 'CK'})</small>` : null}
    ${(b.payments || []).length ? html`<div class="stack tight"><small class="muted">Đã trả cho phiếu này:</small>
      ${b.payments.map((p) => html`<div class="row wrap tight pay-row">${p.has_photo ? html`<a href=${`/api/supplier-payments/${p.id}/photo`} target="_blank"><img src=${`/api/supplier-payments/${p.id}/photo`} style="width:56px;height:56px;object-fit:cover;border-radius:8px" /></a>` : null}
        <small><b>${money(p.amount)}</b> · ${p.date.split('-').reverse().join('/')} · ${p.method === 'cash' ? (p.source === 'manager' ? 'TM quản lý giữ' : 'TM từ két') : 'CK'}${p.bank_txn_id ? ' (khớp sao kê)' : ''} · ${p.by_name}${p.status === 'pending' ? ' · ⏳ chờ duyệt' : ''}</small></div>`)}</div>` : null}
    ${b.status === 'approved' && b.owed > 0 && canApprove ? html`<button class="small primary" onClick=${() => setPayBill(true)}>💵 Trả phiếu này (${money(b.owed)})</button>` : null}
    ${payBill ? html`<${BillPay} b=${b} onClose=${() => setPayBill(false)} />` : null}
    ${b.status === 'approved' ? html`<small class="muted">Duyệt: ${b.approved_by_name} · ${hm(b.approved_at)}${b.owed != null ? html` · ${b.owed > 0 ? html`<b class="danger-text">còn nợ ${money(b.owed)}</b>` : html`<b class="ok-text">đã trả đủ</b>`}` : ''}</small>` : null}
    ${b.status === 'received' && canApprove && canAct(me, 'mh.duyet') && (b.received_by !== me.id || me.role === 'owner') ? html`<div class="row">
      <button class="primary" onClick=${() => act(() => api('POST', `/api/purchases/${b.id}/approve`), 'Đã duyệt, cộng công nợ')}>✓ Đúng, duyệt</button>
      <button onClick=${() => setEdit(true)}>✏️ Sửa</button>
      <button onClick=${() => setReason('')}>Trả lại</button></div>` : null}
    ${b.status === 'returned' && (b.received_by === me.id || canApprove) ? html`<button class="small" onClick=${() => setEdit(true)}>✏️ Sửa từng dòng</button>` : null}
    ${b.status === 'approved' && (['manager', 'owner'].includes(me.role) || me.acts?.['mh.sua'] === true) && canAct(me, 'mh.sua') ? html`<button class="small" onClick=${() => setEdit(true)}>✏️ Sửa bill${b.lines.some((l) => !l.ingredient_id) ? ' / gắn hàng vào kho' : ''}</button>` : null}
    ${edit ? html`<${EditBill} b=${b} onClose=${() => setEdit(false)} />` : null}
    ${b.status === 'received' && b.received_by === me.id && me.role !== 'owner' ? html`<small class="muted">Chờ người khác duyệt (người nhận không tự duyệt).</small>` : null}
    ${b.status === 'returned' && b.received_by === me.id ? html`<${FixBill} b=${b} />` : null}
    ${b.status === 'void' ? html`<p class="small muted">🗑 ${b.return_reason} (${b.returned_by_name})</p>` : !canAct(me, 'mh.huy') ? null : (b.status === 'approved' ? me.role === 'owner' : (['manager', 'owner'].includes(me.role) || me.acts?.['mh.huy'] === true || b.received_by === me.id || canApprove)) ? html`<button class="link small danger-text" onClick=${() => { const r0 = prompt('Huỷ bill này? Hàng sẽ được trừ lại khỏi kho. Lý do:', 'Nhập sai'); if (r0) act(() => api('POST', `/api/purchases/${b.id}/void`, { reason: r0 }), 'Đã huỷ bill'); }}>🗑 Huỷ bill</button>` : null}
    ${reason != null ? html`<${Modal} title="Trả lại bill" onClose=${() => setReason(null)}>
      <${Field} label="Lý do (vd ảnh mờ, sai số lượng, sai tổng)"><input value=${reason} onInput=${(e) => setReason(e.target.value)} /><//>
      <button class="primary" disabled=${!reason} onClick=${async () => { if (await act(() => api('POST', `/api/purchases/${b.id}/return`, { reason }), 'Đã trả lại cho khu sửa')) setReason(null); }}>Trả lại</button><//>` : null}
  </section>`;
}

// Sửa bill: sửa từng dòng (số lượng, đơn giá) + tổng; kho tự cộng / trừ phần chênh
function EditBill({ b, onClose }) {
  const ings = useData('/api/stock/meta');
  const [lines, setLines] = useState(b.lines.map((l) => ({ ...l, qty: String(l.qty), price: String(l.price) })));
  const [total, setTotal] = useState(String(b.total));
  const set = (i, k, v0) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v0 } : l)));
  const sum = lines.reduce((n, l) => n + Math.round((Number(String(l.qty).replace(',', '.')) || 0) * (num(l.price) || 0)), 0);
  const save = async () => {
    const r = await act(() => api('PATCH', `/api/purchases/${b.id}`, { total: num(total), lines: lines.map((l) => ({ id: l.id, ingredient_id: l.ingredient_id, name: l.name, unit: l.unit, qty: String(l.qty).replace(',', '.'), price: num(l.price), create_new: !l.ingredient_id && !!l.create_new })) }), 'Đã sửa bill');
    if (r) onClose();
  };
  return html`<${Modal} title=${`Sửa bill ${b.supplier_name}`} onClose=${onClose} wide>
    <div class="stack">
      <small class="muted">Sửa tên hàng, số lượng, đơn giá cho đúng ảnh bill (số lẻ dùng dấu phẩy, vd 28,1). Kho tự trừ hàng cũ, cộng hàng đúng.</small>
      ${lines.map((l, i) => html`<div class="row wrap tight edit-line">${l.ingredient_id ? html`<div class="grow stack tight"><b>${l.name}</b>
          <select class="small" value="" onChange=${(e) => { const g = (ings.data?.ingredients || []).find((x) => x.id === Number(e.target.value)); if (g) setLines(lines.map((x, j) => (j === i ? { ...x, ingredient_id: g.id, name: g.name, unit: g.purchase_unit || g.unit } : x))); }}>
            <option value="">✏️ Sai tên? Đổi thành hàng khác…</option>${(ings.data?.ingredients || []).filter((g) => g.active !== 0 && g.id !== l.ingredient_id).map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select></div>` : html`<b class="grow">${l.name}</b>`}
        <label class="row tight small"><input class="num-in" inputmode="decimal" value=${l.qty} onInput=${(e) => set(i, 'qty', e.target.value)} /> ${l.unit}</label>
        <label class="row tight small">× <input class="num-in wide" inputmode="numeric" value=${l.price} onInput=${(e) => set(i, 'price', e.target.value)} />đ</label>
        <small class="muted">= ${money(Math.round((Number(String(l.qty).replace(',', '.')) || 0) * (num(l.price) || 0)))}</small>
        ${!l.ingredient_id ? (l.create_new
          ? html`<small class="ok-text" style="flex-basis:100%">✅ Lưu sẽ tạo mã mới trong kho: <b>${l.name}</b> (${l.unit || 'cái'}), cộng ${l.qty} vào kho · <button class="link small" onClick=${() => set(i, 'create_new', false)}>bỏ</button></small>`
          : html`<div class="stack tight" style="flex-basis:100%"><small class="warn-text">⚠ Chưa có trong kho</small>
            <button class="small primary" onClick=${() => set(i, 'create_new', true)}>✅ OK, tạo mã mới "${l.name}" trong kho</button>
            <select onChange=${(e) => { const g = (ings.data?.ingredients || []).find((x) => x.id === Number(e.target.value)); if (g) setLines(lines.map((x, j) => (j === i ? { ...x, ingredient_id: g.id, name: g.name, unit: g.purchase_unit || g.unit } : x))); }}>
              <option value="">…hoặc là hàng có sẵn trong kho</option>${(ings.data?.ingredients || []).filter((g) => g.active !== 0).map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select></div>`) : null}</div>`)}
      <div class="row between"><span>Cộng các dòng</span><b class="num">${money(sum)}</b></div>
      <${Field} label="Tổng tiền trên bill"><input inputmode="numeric" value=${total} onInput=${(e) => setTotal(e.target.value)} /><//>
      ${sum !== num(total) ? html`<small class="warn-text">Cộng các dòng khác tổng bill ${money(Math.abs(sum - num(total)))}</small>` : html`<small class="ok-text">✓ Khớp tổng bill</small>`}
      <button class="primary big" onClick=${save}>Lưu</button>
    </div><//>`;
}

function FixBill({ b }) {
  const [total, setTotal] = useState(String(b.total));
  const [photos, setPhotos] = useState([]);
  return html`<div class="stack"><b class="small">Sửa lại</b>
    <${Field} label="Tổng tiền trên bill"><input inputmode="numeric" value=${total} onInput=${(e) => setTotal(e.target.value)} /><//>
    <${PhotoPicker} photos=${photos} setPhotos=${setPhotos} />
    <button class="primary" onClick=${() => act(() => api('PATCH', `/api/purchases/${b.id}`, { total: num(total), photos }), 'Đã gửi duyệt lại')}>Gửi duyệt lại</button></div>`;
}

// Phiếu còn nợ: hiện luôn ảnh bill (bấm phóng to) + các món (chủ quán 28/10)
// Phiếu giống nhau (cùng tổng + cùng món, số lượng) trong danh sách nợ của 1 NCC → nghi chụp trùng (chủ quán 29/10)
const billSig = (b) => `${b.total}|${(b.lines || []).map((l) => `${l.name}:${l.qty}`).sort().join(',')}`;
function OpenBill({ b, check = null, me = null, twins = [] }) {
  const canVoid = me && me.role === 'owner' && b.remaining === b.total; // bill đã duyệt: chỉ chủ huỷ
  return html`<div class="card tight stack" style="padding:8px">
    <div class="row between wrap">${check || html`<b>Phiếu #${b.id}</b>`}<small>${b.date.split('-').reverse().join('/')} · tổng ${money(b.total)} · <b class="danger-text">còn ${money(b.remaining)}</b></small></div>
    ${twins.length ? html`<div class="row between wrap"><span class="pill warn">⚠ Có thể trùng phiếu ${twins.map((x) => `#${x.id}`).join(', ')}</span>
      ${canVoid ? html`<button class="small danger" onClick=${() => { const r0 = prompt(`Huỷ phiếu #${b.id} (${money(b.total)})? Kho trừ lại hàng của phiếu này, công nợ bỏ phiếu này.\nLý do:`, `Chụp trùng phiếu #${twins[0].id}`); if (r0) act(() => api('POST', `/api/purchases/${b.id}/void`, { reason: r0 }), `Đã huỷ phiếu #${b.id}`); }}>🗑 Huỷ phiếu này</button>` : null}</div>` : null}
    ${b.photos?.length ? html`<${Photos} ids=${b.photos} />` : html`<small class="muted">(không có ảnh bill)</small>`}
    ${b.lines?.length ? html`<details><summary class="small">${b.lines.length} món</summary><table class="list small"><tbody>${b.lines.map((l) => html`<tr><td>${l.name}</td><td class="r">${l.qty} ${l.unit}</td><td class="r">${money(l.amount)}</td></tr>`)}</tbody></table>
      ${b.goods_photos?.length ? html`<small class="muted">Ảnh hàng nhận:</small><${Photos} ids=${b.goods_photos} />` : null}</details>` : null}
  </div>`;
}

function Debts({ me }) {
  const st = useData('/api/suppliers/debts');
  const [pay, setPay] = useState(null);
  const [stmt, setStmt] = useState(null);
  const [q, setQ] = useState(''); // tìm NCC (chủ quán 28/10)
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  return html`<div class="stack">
    <section class="kpis"><div class="kpi main"><small>Tổng nợ NCC (bill đã duyệt)</small><b>${money(d.total)}</b><small class="muted">Chi trên ${money(d.approve_over)} cần chủ / quản lý duyệt</small></div></section>
    ${d.waiting.length ? html`<section class="card stack"><b>Khoản chi chờ duyệt</b>${d.waiting.map((p) => html`<div class="row between wrap">
      <span>${p.supplier_name} · <b>${money(p.amount)}</b> · ${p.method === 'cash' ? 'tiền mặt' : 'CK'} · ${p.created_by_name}</span>
      ${d.is_boss ? html`<div class="row"><button class="primary small" onClick=${() => act(() => api('POST', `/api/supplier-payments/${p.id}/approve`), 'Đã duyệt chi')}>Duyệt</button>
        <button class="small" onClick=${() => act(() => api('POST', `/api/supplier-payments/${p.id}/approve`, { reject: true }), 'Đã từ chối')}>Từ chối</button></div>` : html`<small class="muted">chờ chủ duyệt</small>`}</div>`)}</section>` : null}
    <input type="search" placeholder="🔍 Tìm nhà cung cấp" value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${q && !d.suppliers.some((s) => fold(s.name).includes(fold(q))) ? html`<p class="muted">Không thấy NCC nào tên "${q}".</p>` : null}
    ${[...d.suppliers].filter((s) => !q || fold(s.name).includes(fold(q))).sort((a, b) => b.debt - a.debt).map((s) => html`<section class="card stack">
      <div class="row between"><b>${s.name}</b><b class=${s.debt > 0 ? 'danger-text' : 'muted'}>${money(s.debt)}</b></div>
      <small class="muted">${s.last_bill ? `Lần mua cuối ${dayLabel(s.last_bill)}` : 'Chưa mua'}${s.pending.n ? ` · ${s.pending.n} bill chưa duyệt ${money(s.pending.t)}` : ''}</small>
      ${(s.open_bills || []).length ? html`<div class="stack tight"><small class="muted">Phiếu còn nợ (${s.open_bills.length}):</small>${s.open_bills.map((b) => html`<${OpenBill} b=${b} me=${me} twins=${s.open_bills.filter((x) => x.id !== b.id && billSig(x) === billSig(b))} />`)}</div>` : null}
      <div class="row">
        <button class="small" onClick=${() => setStmt(s)}>Sổ nợ</button>
        ${s.debt > 0 ? html`<button class="small primary" onClick=${() => setPay(s)}>Trả</button>` : null}</div></section>`)}
    ${pay ? html`<${PayModal} s=${pay} txns=${d.out_txns} boss=${d.is_boss} onClose=${() => setPay(null)} />` : null}
    ${stmt ? html`<${Statement} s=${stmt} onClose=${() => setStmt(null)} />` : null}
  </div>`;
}

// Trả đúng 1 phiếu ngay trên phiếu đó: lấy NCC + giao dịch ngân hàng chưa gán rồi mở form trả với phiếu đã chọn sẵn
function BillPay({ b, onClose }) {
  const d = useData('/api/suppliers/debts');
  if (!d.data) return html`<${Modal} title="Trả phiếu" onClose=${onClose}><${Loading} state=${d} /><//>`;
  const s = d.data.suppliers.find((x) => x.id === b.supplier_id);
  if (!s) return html`<${Modal} title="Trả phiếu" onClose=${onClose}><p class="muted">Không tìm thấy nhà cung cấp.</p><//>`;
  return html`<${PayModal} s=${s} txns=${d.data.out_txns} boss=${d.data.is_boss} preset=${b} onClose=${onClose} />`;
}

function PayModal({ s, txns, boss, preset, onClose }) {
  const [f, setF] = useState({ amount: String(preset ? preset.owed : s.debt), method: 'transfer', note: '', bank_txn_id: '', source: 'drawer' });
  const [photos, setPhotos] = useState([]);
  const [pick, setPick] = useState(preset ? [preset.id] : []);
  const open = s.open_bills || [];
  const toggle = (b) => { const nx = pick.includes(b.id) ? pick.filter((x) => x !== b.id) : [...pick, b.id]; setPick(nx); if (nx.length) setF({ ...f, amount: String(open.filter((x) => nx.includes(x.id)).reduce((n, x) => n + x.remaining, 0)) }); };
  return html`<${Modal} title=${`Trả ${s.name}`} onClose=${onClose}>
    <p class="small">Còn nợ <b>${money(s.debt)}</b>${open.length ? ` · ${open.length} phiếu chưa trả đủ` : ''}</p>
    ${open.length ? html`<div class="stack tight"><small class="muted">Trả cho phiếu nào (tick để tự cộng số tiền; không tick = trừ phiếu cũ nhất trước):</small>
      ${open.map((b) => html`<${OpenBill} b=${b} check=${html`<label class="check-row"><input type="checkbox" checked=${pick.includes(b.id)} onChange=${() => toggle(b)} /> <b>Phiếu #${b.id}</b></label>`} />`)}</div>` : null}
    <${Field} label="Số tiền"><input inputmode="numeric" value=${f.amount} onInput=${(e) => setF({ ...f, amount: e.target.value })} /><//>
    <div class="chips">${[['transfer', 'Chuyển khoản', 'drawer'], ['cash', 'Tiền mặt từ két', 'drawer'], ...(boss ? [['cash', 'Tiền mặt quản lý giữ', 'manager']] : [])].map(([k, l, src]) => html`<button class=${`chip ${f.method === k && (k === 'transfer' || f.source === src) ? 'on' : ''}`} onClick=${() => setF({ ...f, method: k, source: src })}>${l}</button>`)}</div>
    ${f.method === 'transfer' && txns.length ? html`<${Field} label="Giao dịch ngân hàng (tiền ra, SePay báo)"><select value=${f.bank_txn_id} onChange=${(e) => { const t = txns.find((x) => x.id === Number(e.target.value)); setF({ ...f, bank_txn_id: e.target.value, amount: t ? String(t.amount) : f.amount }); }}>
      <option value="">Chưa có / chụp màn hình CK</option>${txns.map((t) => html`<option value=${t.id}>${money(t.amount)} · ${t.content} · ${t.date}</option>`)}</select><//>` : null}
    ${!f.bank_txn_id ? html`<${PhotoPicker} photos=${photos} setPhotos=${setPhotos} gallery=${true} />` : null}
    <${Field} label="Ghi chú"><input value=${f.note} onInput=${(e) => setF({ ...f, note: e.target.value })} /><//>
    ${!f.bank_txn_id && !photos.length ? html`<small class="warn-text">Chụp ảnh chứng từ (ảnh CK / giấy nhận tiền) để đối chiếu trên phiếu.</small>` : null}
    <button class="primary" disabled=${!f.bank_txn_id && !photos.length} onClick=${async () => { const r = await act(() => api('POST', `/api/suppliers/${s.id}/pay`, { amount: num(f.amount), method: f.method, source: f.source, bill_ids: pick, note: [pick.length ? `Trả phiếu ${pick.map((x) => `#${x}`).join(', ')}` : '', f.note].filter(Boolean).join(' · '), bank_txn_id: f.bank_txn_id ? Number(f.bank_txn_id) : undefined, photo: photos[0] })); if (r) { onClose(); } }}>Ghi khoản trả</button>
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

// ⏳ Chờ nhận hàng (chủ quán 28/10): bill chủ quán áp trước → bếp kiểm hàng, chụp ảnh, sửa số thực nhận → Đã nhận hàng
function ArriveCard({ b, me }) {
  // Số nhận lưu theo "id dòng/số bill": sửa bill (đổi dòng / số) thì ô tự về số mới trên bill, không gửi "undefined" (rà soát 28/10)
  const [got, setGot] = useState({});
  const k = (l) => `${l.id}/${l.qty}`;
  const val = (l) => got[k(l)] ?? String(l.qty);
  const [goods, setGoods] = useState([]);
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const short = b.lines.filter((l) => qtyNum(val(l)) < l.qty - 1e-9);
  const boss = ['manager', 'owner'].includes(me.role) || me.role === 'shift_lead';
  return html`<section class="card stack warn-card">
    <div class="row between wrap"><b>${b.supplier_name} · ${money(b.total)}</b><span class="row tight">${b.paid_now ? html`<span class="pill ok">✅ Đã trả ${dayLabel(b.date)}</span>` : html`<span class="pill">Chưa trả</span>`}<span class="pill warn">⏳ Chờ nhận hàng</span></span></div>
    <small class="muted">#${b.id} · áp bill ${dayLabel(b.date)} ${hm(b.received_at)}${b.paid_method === 'transfer' ? ` · đã CK ${money(b.paid_now)}` : ' · ghi nợ'}${b.note ? ` · ${b.note}` : ''}</small>
    <${Photos} ids=${b.photos} />
    <small class="muted">Kiểm từng món, sửa số thực nhận nếu thiếu:</small>
    ${b.lines.map((l) => html`<div class="row wrap tight edit-line"><b class="grow">${l.name}</b>
      <small class="muted">bill ${l.qty} ${l.unit}</small>
      <label class="row tight small">nhận <input class="num-in" inputmode="decimal" value=${val(l)} onInput=${(e) => setGot({ ...got, [k(l)]: e.target.value })} /> ${l.unit}</label>
      ${qtyNum(val(l)) < l.qty - 1e-9 ? html`<small class="danger-text" style="flex-basis:100%">⚠ Thiếu ${Math.round((l.qty - qtyNum(val(l))) * 1000) / 1000} ${l.unit}</small>` : null}</div>`)}
    <${PhotoPicker} photos=${goods} setPhotos=${setGoods} first="📷 Chụp HÀNG thực nhận (bắt buộc)" more="📷 Thêm ảnh hàng" />
    ${short.length ? html`<small class="danger-text">Nhận thiếu ${short.length} món → bill chờ thu ngân duyệt</small>` : html`<small class="ok-text">Nhận đủ → bill tự duyệt, cộng công nợ (giá tăng / tổng lệch thì chờ thu ngân duyệt)</small>`}
    <button class="primary big" disabled=${!goods.length || busy} onClick=${async () => { setBusy(true); try { await act(() => api('POST', `/api/purchases/${b.id}/arrive`, { goods_photos: goods, lines: b.lines.map((l) => ({ id: l.id, qty: String(val(l)).replace(',', '.') })) }), short.length ? 'Đã nhận hàng (thiếu), chờ thu ngân duyệt' : 'Đã nhận hàng, kho đã cộng'); } finally { setBusy(false); } }}>${busy ? 'Đang lưu…' : '✓ Đã nhận hàng'}</button>
    ${boss ? html`<div class="row"><button class="small" onClick=${() => setEdit(true)}>✏️ Sửa bill</button>
      <button class="link small danger-text" onClick=${() => { const r0 = prompt('Huỷ bill chờ nhận này? Lý do:', 'NCC không giao'); if (r0) act(() => api('POST', `/api/purchases/${b.id}/void`, { reason: r0 }), 'Đã huỷ bill'); }}>🗑 Huỷ</button></div>` : null}
    ${edit ? html`<${EditBill} b=${b} onClose=${() => setEdit(false)} />` : null}
  </section>`;
}

// ⚖ Quy đổi ở Mua hàng (chủ quán 28/10): dòng bill nhập đúng như bill → nhập 1 mẹt = ? kg là app tự sửa kho + bill, nhớ cho lần sau
// 💰 So sánh giá NCC (chủ quán 29/10, chỉ chủ): giá thật đã mua theo từng NCC, rẻ nhất tô xanh
function CompareTab() {
  const [days, setDays] = useState(90);
  const [q, setQ] = useState('');
  const [multi, setMulti] = useState(true);
  const st = useData(`/api/purchases/compare?days=${days}`);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const key = q.trim().toLowerCase();
  const items = d.items.filter((i) => (!multi || i.suppliers.length > 1) && (!key || i.name.toLowerCase().includes(key) || i.suppliers.some((s) => s.name.toLowerCase().includes(key))));
  return html`<div class="stack">
    <section class="card stack tight">
      <div class="row wrap tight">${[30, 90, 180].map((n) => html`<button class=${`small ${days === n ? 'primary' : ''}`} onClick=${() => setDays(n)}>${n} ngày</button>`)}</div>
      <input placeholder="Tìm mặt hàng hoặc NCC…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <label class="row tight" style="align-items:center"><input type="checkbox" checked=${multi} onChange=${(e) => setMulti(e.target.checked)} /> Chỉ hàng mua từ 2 NCC trở lên</label>
      ${d.total_save ? html`<small>Nếu ${days} ngày qua mua hết ở NCC rẻ nhất (giá lần gần nhất): tiết kiệm khoảng <b class="ok-text">${money(d.total_save)}</b></small>` : null}
      <small class="muted">Giá theo đơn vị mua của từng mặt hàng, lấy từ bill đã nhận (bỏ bill huỷ / trả lại / chưa quy đổi).</small>
    </section>
    ${!items.length ? html`<div class="empty">${multi ? 'Chưa có mặt hàng nào mua từ 2 NCC trong khoảng này. Bỏ tick để xem tất cả.' : 'Chưa có dữ liệu mua hàng.'}</div>` : null}
    ${items.map((i) => html`<section class="card stack tight" key=${i.id}>
      <div class="row between wrap"><b>${i.name}</b><small class="muted">/${i.unit}${i.spread ? html` · chênh <b class=${i.spread >= 10 ? 'danger-text' : ''}>${i.spread}%</b>` : null}</small></div>
      ${i.default_supplier ? html`<small class="muted">NCC đang gán: ${i.default_supplier}</small>` : null}
      <table class="cmp-tbl small"><thead><tr><th>NCC</th><th class="r">Lần gần nhất</th><th class="r">Thấp–cao</th><th class="r">TB</th></tr></thead><tbody>
        ${i.suppliers.map((s, k) => html`<tr class=${k === 0 && i.suppliers.length > 1 ? 'best-row' : ''}>
          <td>${k === 0 && i.suppliers.length > 1 ? '✅ ' : ''}${s.name}<br /><small class="muted">${s.n} lần · ${s.qty} ${i.unit}</small></td>
          <td class="r"><b>${money(s.last_price)}</b><br /><small class="muted">${dayLabel(s.last_date)}</small></td>
          <td class="r">${s.min === s.max ? money(s.min) : html`${money(s.min)}<br />${money(s.max)}`}</td>
          <td class="r">${money(s.avg)}</td></tr>`)}
      </tbody></table>
      ${i.save ? html`<small>Mua hết ở <b>${i.best_name}</b> thì tiết kiệm ~<b class="ok-text">${money(i.save)}</b></small>` : null}
    </section>`)}
  </div>`;
}

function ConvTab({ meta }) {
  const st = useData('/api/purchases/unconverted');
  const [f, setF] = useState({});
  const rows = st.data || [];
  return html`<div class="stack">
    <section class="card stack"><h3>Bill chưa quy đổi ${rows.length ? html`<span class="pill warn">${rows.length}</span>` : null}</h3>
      ${!st.data ? html`<${Loading} state=${st} />` : !rows.length ? html`<p class="ok-text small">✓ Không còn dòng bill nào chưa quy đổi</p>`
        : html`<small class="muted">Nhập 1 đơn vị trên bill bằng bao nhiêu → app tự sửa số kho, đơn giá trên bill và nhớ cho các bill sau.</small>
        ${rows.map((l) => { const u = l.purchase_unit || l.use_unit; return html`<div class="stack tight" style="border-bottom:1px solid var(--line, #eee);padding-bottom:10px">
          <div class="row between wrap"><b>${l.name}</b><small class="muted">#${l.bill_id} · ${l.supplier_name} · ${dayLabel(l.date)}</small></div>
          <small>Bill ghi <b>${l.qty} ${l.bill_unit}</b> × ${money(l.price)} = ${money(l.amount)}</small>
          <div class="row wrap tight" style="align-items:center"><span class="small">1 ${l.bill_unit} =</span>
            <input inputmode="decimal" style="width:6em" placeholder="?" value=${f[l.id] || ''} onInput=${(e) => setF({ ...f, [l.id]: e.target.value })} /><span class="small">${u}</span>
            <button class="primary small" disabled=${!qtyNum(f[l.id])} onClick=${() => act(() => api('POST', `/api/purchases/lines/${l.id}/convert`, { factor: String(f[l.id]).replace(',', '.') }), `Đã quy đổi ${l.name}`)}>Lưu</button>
            <button class="small" onClick=${() => act(() => api('POST', `/api/purchases/lines/${l.id}/convert`, { factor: 1 }), 'Đã ghi: không quy đổi')}>1 ${l.bill_unit} = 1 ${u}</button></div>
          ${qtyNum(f[l.id]) ? html`<small class="ok-text">→ kho ${Math.round(l.qty * qtyNum(f[l.id]) * 1000) / 1000} ${u} · ${money(Math.round(l.price / qtyNum(f[l.id])))}/${u}</small>` : null}
        </div>`; })}`}
    </section>
    <h3>Quy đổi từng nguyên liệu</h3>
    <${Conversions} meta=${meta} />
  </div>`;
}

export function PurchasesView({ me, query }) {
  const meta0 = useData('/api/stock/meta');
  // Không có quyền "Xem bill đã nhận" → lấy bản rút gọn để vẫn nhập kho được (chủ quán 29/10)
  const canView = canAct(me, 'mh.xem');
  const list = useData(canView ? '/api/purchases' : '/api/purchases/info');
  const advances = useData('/api/advances');
  const tab = query.get('tab') || (canAct(me, 'mh.nhap') ? 'nhan' : 'lichsu');
  if (!meta0.data || !list.data) return html`<${Loading} state=${meta0.data ? list : meta0} />`;
  const L = list.data;
  const isCashier = L.can_approve && canAct(me, 'mh.duyet');
  const meta = { ...meta0.data, is_cashier: isCashier, bill_reader: !!L.bill_reader };
  const waiting = L.bills.filter((b) => b.status === 'received');
  const mineReturned = L.bills.filter((b) => b.status === 'returned' && b.received_by === me.id);
  // Công nợ NCC / Tạm ứng: theo Phân quyền (chủ quán tick từng người)
  const can = (k) => (Array.isArray(me.pages) ? me.pages.includes(`/mua-hang#${k}`) : k === 'congno' ? isCashier : true);
  const arriving = L.arriving || [];
  const tabs = [...(canAct(me, 'mh.nhap') ? [['nhan', '📥 Nhập kho']] : []), ...(arriving.length || isCashier ? [['cho', `⏳ Chờ nhận hàng (${arriving.length})`]] : []), ...(isCashier ? [['duyet', `Chờ duyệt (${L.pending})`]] : []), ...(L.limited ? [] : [['lichsu', 'Bill đã nhận']]), ...(can('congno') ? [['congno', 'Công nợ NCC']] : []), ...(can('tamung') ? [['tamung', 'Tạm ứng']] : []), ...(['manager', 'owner'].includes(me.role) ? [['quydoi', '⚖ Quy đổi']] : []), ...((me.real_role || me.role) === 'owner' ? [['sosanh', '💰 So sánh giá']] : [])];
  return html`<div class="stack">
    <div class="tabs scroll">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => navigate(`/mua-hang?tab=${k}`)}>${l}</button>`)}</div>
    ${mineReturned.length && tab !== 'lichsu' ? html`<section class="card warn-card small">${mineReturned.length} bill bạn nhận bị thu ngân trả lại. <button class="small" onClick=${() => navigate('/mua-hang?tab=lichsu')}>Xem & sửa</button></section>` : null}
    ${tab === 'nhan' && canAct(me, 'mh.nhap') ? html`<${Receive} me=${me} meta=${meta} advances=${advances} arriving=${arriving} onDone=${() => navigate(L.limited ? '/mua-hang?tab=nhan' : '/mua-hang?tab=lichsu')} />` : null}
    ${tab === 'duyet' ? (waiting.length ? html`<p class="small muted">So ảnh bill với số khu nhập: số lượng, đơn giá, tổng, chữ ký người nhận. Dòng đỏ = app thấy lệch.</p>${waiting.map((b) => html`<${BillCard} key=${b.id} b=${b} canApprove=${isCashier} me=${me} />`)}` : html`<div class="empty">Không có bill chờ duyệt.</div>`) : null}
    ${tab === 'lichsu' ? (L.bills.length ? L.bills.map((b) => html`<${BillCard} key=${b.id} b=${b} canApprove=${isCashier} me=${me} />`) : html`<div class="empty">Chưa có bill trong 30 ngày.</div>`) : null}
    ${tab === 'congno' && can('congno') ? html`<${Debts} me=${me} />` : null}
    ${tab === 'cho' ? (arriving.length ? arriving.map((b) => html`<${ArriveCard} key=${b.id} b=${b} me=${me} />`) : html`<div class="empty">Không có bill nào chờ nhận hàng.</div>`) : null}
    ${tab === 'quydoi' && ['manager', 'owner'].includes(me.role) ? html`<${ConvTab} meta=${meta} />` : null}
    ${tab === 'sosanh' && (me.real_role || me.role) === 'owner' ? html`<${CompareTab} />` : null}
    ${tab === 'tamung' && can('tamung') ? html`<${Advances} me=${me} isCashier=${isCashier} advances=${advances} />` : null}
  </div>`;
}
