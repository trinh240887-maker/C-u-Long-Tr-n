// Kho & Tài sản theo chứng từ (spec chủ quán 25/10). Mỗi vai trò chỉ thấy nút của mình; dùng tốt trên điện thoại ~380px.
import { useState, useEffect, useRef } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, Modal, Field, navigate, toast, dt, money, atLeast } from '../ui.js';
import { compressImage } from './checklists.js';
import qrcode from '../vendor/qrcode.js';

const COLOR = { green: '🟢', yellow: '🟡', red: '🔴', new: '🆕' };
const FREQ = { shift: 'Mỗi ca', day: 'Mỗi ngày', week: 'Hằng tuần', month: 'Hằng tháng', halfyear: '6–12 tháng' };
const go = (tab, extra = '') => navigate(`/kho-tx?tab=${tab}${extra}`);

// Ô chọn mặt hàng có tìm kiếm (danh sách dài)
function ItemPick({ items, value, onChange, filter }) {
  const [q, setQ] = useState('');
  const list = items.filter((x) => (!filter || filter(x)) && (!q || x.name.toLowerCase().includes(q.toLowerCase()) || (x.code || '').toLowerCase().includes(q.toLowerCase()))).slice(0, 40);
  const cur = items.find((x) => x.id === value);
  if (cur) return html`<button class="tpl-row" onClick=${() => onChange(null)}><b class="grow">${cur.name}</b><small class="muted">${cur.unit} · đổi</small></button>`;
  return html`<div class="stack tight"><input placeholder="Tìm mặt hàng…" value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${q ? list.map((x) => html`<button class="tpl-row" onClick=${() => { onChange(x.id); setQ(''); }}><span class="grow">${x.name}</span><small class="muted">${x.code || ''} · ${x.unit}</small></button>`) : null}</div>`;
}
const StorePick = ({ stores, value, onChange, codes }) => html`<div class="row wrap">${stores.filter((s) => !codes || codes.includes(s.code)).map((s) => html`<button class=${`chip ${value === s.id ? 'on' : ''}`} onClick=${() => onChange(s.id)}>${s.name}</button>`)}</div>`;

// Danh sách dòng chứng từ (thêm / xoá dòng)
function Lines({ meta, lines, setLines, opts = {} }) {
  const set = (i, patch) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return html`<div class="stack">
    ${lines.map((l, i) => { const it = meta.items.find((x) => x.id === l.ingredient_id); return html`<div class="card tight stack">
      ${opts.free && !l.ingredient_id ? html`<input placeholder="Tên mặt hàng (nếu chưa có trong danh mục)" value=${l.name_free || ''} onInput=${(e) => set(i, { name_free: e.target.value })} />` : null}
      <${ItemPick} items=${meta.items} value=${l.ingredient_id} filter=${opts.filter} onChange=${(id) => set(i, { ingredient_id: id })} />
      <div class="row wrap">
        <label class="row grow">${opts.qtyLabel || 'Số lượng'} <input class="num-in" type="number" inputmode="decimal" value=${l.qty ?? ''} onInput=${(e) => set(i, { qty: e.target.value })} /> ${it?.unit || ''}</label>
        ${l.qty_expected != null && opts.showExpected ? html`<small class="muted">đặt ${l.qty_expected}</small>` : null}
        ${opts.price ? html`<label class="row">Giá / ${it?.purchase_unit || 'đv mua'} <input class="num-in" type="number" inputmode="numeric" value=${l.price ?? ''} onInput=${(e) => set(i, { price: e.target.value })} /></label>` : null}
      </div>
      ${opts.reason ? html`<div class="row wrap">${Object.entries(meta.reasons).map(([k, n]) => html`<button class=${`chip ${l.reason === k ? 'on' : ''}`} onClick=${() => set(i, { reason: k })}>${n}</button>`)}</div>` : null}
      ${opts.reason && l.reason === 'BE_VO' ? html`<label class="row">Người làm bể <select value=${l.who_broke || ''} onChange=${(e) => set(i, { who_broke: e.target.value })}><option value="">(khách / không rõ: ghi chú)</option>${meta.staff.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select></label>` : null}
      ${opts.cold && it?.group_code === 'LANH' ? html`<div class="row wrap"><label class="row">Nhiệt độ °C <input class="num-in" type="number" value=${l.temp ?? ''} onInput=${(e) => set(i, { temp: e.target.value })} /></label><label class="row">Hạn dùng <input type="date" value=${l.expires_on || ''} onInput=${(e) => set(i, { expires_on: e.target.value })} /></label></div>` : null}
      ${opts.kind ? html`<div class="row">${['in', 'out'].map((k) => html`<button class=${`chip ${l.kind === k ? 'on' : ''}`} onClick=${() => set(i, { kind: k })}>${k === 'in' ? 'Nguyên liệu thô (lấy ra)' : 'Thành phẩm (nhập vào)'}</button>`)}</div>` : null}
      <div class="row"><input class="grow" placeholder=${opts.notePh || 'Ghi chú / lý do'} value=${l.note || ''} onInput=${(e) => set(i, { note: e.target.value })} /><button class="small" onClick=${() => setLines(lines.filter((_, k) => k !== i))}>Xoá</button></div>
    </div>`; })}
    <button onClick=${() => setLines([...lines, { ingredient_id: null, qty: '', ...(opts.newLine || {}) }])}>+ Thêm dòng</button>
  </div>`;
}

// Chụp ảnh gắn chứng từ (giữ ảnh tạm ở máy tới khi lưu)
function Photos({ photos, setPhotos, need }) {
  const add = async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setPhotos([...photos, await compressImage(f)]); };
  return html`<div class="row wrap"><label class=${`button ${need && !photos.length ? 'primary' : ''}`}>📷 Chụp ảnh${need ? ' (bắt buộc)' : ''}<input type="file" accept="image/*" capture="environment" hidden onChange=${add} /></label>
    ${photos.map((p, i) => html`<img src=${p} style="width:56px;height:56px;object-fit:cover;border-radius:8px" onClick=${() => setPhotos(photos.filter((_, k) => k !== i))} />`)}</div>`;
}
// Lưu chứng từ: tạo nháp → gửi ảnh → gửi duyệt.
// Chống bấm 2 lần + gửi lại không tạo trùng (rà soát 28/10): lỗi giữa chừng thì giữ nháp đã tạo; bấm lại (cùng nội dung) chỉ gửi tiếp ảnh còn thiếu rồi gửi duyệt
function useSaver() {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const draft = useRef(null); // { key, id, v, sent: Set ảnh đã gửi }
  const once = async (fn) => {
    if (lock.current) return undefined;
    lock.current = true; setBusy(true);
    try { return await fn(); } finally { lock.current = false; setBusy(false); }
  };
  const saveVoucher = async (body, photos = [], { submit = true } = {}) => {
    const key = JSON.stringify(body);
    let d = draft.current;
    if (!d || d.key !== key) { const v = await api('POST', '/api/wh/vouchers', { ...body, submit: false }); d = draft.current = { key, id: v.id, v, sent: new Set() }; }
    for (const p of photos) if (!d.sent.has(p)) { await api('POST', `/api/wh/vouchers/${d.id}/photo`, { data: p }); d.sent.add(p); }
    const out = submit ? await api('POST', `/api/wh/vouchers/${d.id}/submit`) : d.v;
    draft.current = null;
    return out;
  };
  return { busy, once, run: (body, photos, msg) => once(() => act(() => saveVoucher(body, photos), msg)) };
}
const clean = (lines) => lines.filter((l) => l.ingredient_id || l.name_free).map((l) => ({ ...l, qty: l.qty === '' ? null : l.qty }));

// ---------- Màn hình từng việc ----------
function WasteForm({ meta }) {
  const [store, setStore] = useState(meta.stores.find((s) => s.code === 'BEP')?.id);
  const [lines, setLines] = useState([{ ingredient_id: null, qty: '', reason: '' }]);
  const [photos, setPhotos] = useState([]);
  const sv = useSaver();
  const save = () => sv.run({ type: 'XH', from_store: store, lines: clean(lines) }, photos, 'Đã ghi, chờ quản lý ca duyệt').then((r) => r && (setLines([{ ingredient_id: null, qty: '', reason: '' }]), setPhotos([])));
  return html`<div class="stack"><h3>🗑 Ghi huỷ / bể vỡ</h3><p class="small muted">Ghi ngay khi phát hiện. Ảnh bắt buộc. Bể vỡ ghi người làm bể. Người khác (quản lý ca) duyệt.</p>
    <${StorePick} stores=${meta.stores} value=${store} onChange=${setStore} />
    <${Lines} meta=${meta} lines=${lines} setLines=${setLines} opts=${{ reason: true }} />
    <${Photos} photos=${photos} setPhotos=${setPhotos} need />
    <button class="primary big" disabled=${!photos.length || sv.busy} onClick=${save}>${sv.busy ? 'Đang gửi…' : 'Gửi duyệt'}</button></div>`;
}

function IssueForm() {
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');
  const [photos, setPhotos] = useState([]);
  const scan = async () => {
    if (!('BarcodeDetector' in window)) return toast('Máy này không quét QR trong app được: gõ mã trên tem (vd BAN-012)', true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const v = document.createElement('video'); v.srcObject = stream; await v.play();
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      for (let i = 0; i < 60; i++) { const r = await det.detect(v); if (r[0]) { setCode(r[0].rawValue); break; } await new Promise((ok) => setTimeout(ok, 250)); }
      stream.getTracks().forEach((t) => t.stop());
    } catch { toast('Không mở được camera', true); }
  };
  const sv = useSaver();
  const save = () => sv.once(() => act(() => api('POST', '/api/wh/assets/issue', { code, description: desc, photo: photos[0] }), 'Đã báo hỏng')).then((r) => r && (setCode(''), setDesc(''), setPhotos([])));
  return html`<div class="stack"><h3>🔧 Báo hỏng tài sản</h3>
    <div class="row"><input class="grow" placeholder="Mã trên tem (vd BAN-012)" value=${code} onInput=${(e) => setCode(e.target.value.toUpperCase())} /><button onClick=${scan}>📷 Quét QR</button></div>
    <textarea placeholder="Hỏng gì? (vd chân bàn lung lay)" value=${desc} onInput=${(e) => setDesc(e.target.value)}></textarea>
    <${Photos} photos=${photos} setPhotos=${setPhotos} />
    <button class="primary big" disabled=${!code || !desc || sv.busy} onClick=${save}>Báo hỏng</button></div>`;
}

function MyItems() {
  const d = useData('/api/wh/my-items');
  if (!d.data) return html`<${Loading} state=${d} />`;
  return html`<div class="stack"><h3>👕 Đồ tôi đang giữ</h3>
    ${d.data.to_confirm.map((x) => html`<div class="card row"><span class="grow">Phiếu cấp đồ <b>${x.no}</b> chờ bạn xác nhận đã nhận</span><button class="primary" onClick=${() => go('ct', `&v=${x.id}`)}>Xem & xác nhận</button></div>`)}
    ${d.data.holding.length ? d.data.holding.map((x) => html`<div class="row"><span class="grow">${x.name}${x.size ? ` (size ${x.size})` : ''}</span><b>${x.qty}</b></div>`) : html`<p class="muted">Chưa giữ đồ nào của quán.</p>`}</div>`;
}

function Inbox() {
  const d = useData('/api/wh/inbox');
  if (!d.data) return html`<${Loading} state=${d} />`;
  const { vouchers, explain, asset_issues } = d.data;
  return html`<div class="stack"><h3>✅ Chờ tôi duyệt / ký nhận</h3>
    ${!vouchers.length && !explain.length && !asset_issues.length ? html`<p class="muted">Không có việc nào chờ bạn.</p>` : null}
    ${vouchers.map((x) => html`<button class="tpl-row" onClick=${() => go('ct', `&v=${x.id}`)}><b class="grow">${x.type_name} · ${x.no}</b><small class="muted">${x.created_by_name} · ${dt(x.created_at)}</small></button>`)}
    ${explain.length ? html`<h4>🔴 Dòng lệch đỏ chờ bạn giải trình</h4>${explain.map((x) => html`<button class="tpl-row" onClick=${() => go('ct', `&v=${x.voucher_id}`)}><b class="grow">${x.name}</b><small>${x.no} · lệch ${x.diff} (${x.pct}%)</small></button>`)}` : null}
    ${asset_issues.length ? html`<h4>🔧 Báo hỏng mới</h4>${asset_issues.map((x) => html`<button class="tpl-row" onClick=${() => go('ts')}><b class="grow">${x.code} · ${x.name}</b><small>${x.description}</small></button>`)}` : null}</div>`;
}

function VoucherDetail({ id, me }) {
  const d = useData(`/api/wh/vouchers/${id}`);
  const [why, setWhy] = useState({});
  if (!d.data) return html`<${Loading} state=${d} />`;
  const x = d.data;
  const mine = x.created_by === me.id;
  return html`<div class="stack">
    <div class="row"><button class="small" onClick=${() => history.back()}>←</button><h3 class="grow">${x.type_name} · ${x.no}</h3><span class=${`pill ${x.status === 'approved' ? 'ok' : x.status === 'pending' ? 'warn' : ''}`}>${x.status_name}</span></div>
    <p class="small muted">${x.from_name ? `Từ ${x.from_name}` : ''}${x.to_name ? ` → ${x.to_name}` : ''}${x.target_name ? ` · cho ${x.target_name}` : ''} · lập bởi ${x.created_by_name} ${dt(x.created_at)}${x.approved_by_name ? ` · duyệt: ${x.approved_by_name}` : ''}${x.note ? ` · ${x.note}` : ''}</p>
    ${x.lines.map((l) => html`<div class="card tight stack">
      <div class="row"><b class="grow">${l.color ? COLOR[l.color] : ''} ${l.name}${l.kind ? ` (${l.kind === 'in' ? 'thô' : 'thành phẩm'})` : ''}</b><b>${l.qty} ${l.unit || ''}</b></div>
      ${l.qty_expected != null ? html`<small class="muted">Lý thuyết ${l.qty_expected} · lệch ${l.diff ?? '—'}${l.pct != null ? ` (${l.pct}%)` : ''}</small>` : null}
      ${l.reason ? html`<small>Lý do: ${l.reason}${l.who_broke_name ? ` · người làm bể: ${l.who_broke_name}` : ''}</small>` : null}
      ${l.note ? html`<small class="muted">${l.note}</small>` : null}
      ${l.color === 'red' ? (l.explain ? html`<small>📝 Giải trình (${l.explain_by_name}): ${l.explain}</small>` : html`<div class="row"><input class="grow" placeholder="Giải trình (người phụ trách kho)" value=${why[l.id] || ''} onInput=${(e) => setWhy({ ...why, [l.id]: e.target.value })} /><button class="small" onClick=${() => act(() => api('POST', `/api/wh/lines/${l.id}/explain`, { text: why[l.id] }), 'Đã giải trình')}>Gửi</button></div>`) : null}
    </div>`)}
    ${x.photos.length ? html`<div class="row wrap">${x.photos.map((p) => html`<a href=${`/api/wh/photos/${p.id}`} target="_blank"><img src=${`/api/wh/photos/${p.id}`} style="width:72px;height:72px;object-fit:cover;border-radius:8px" /></a>`)}</div>` : null}
    ${x.status === 'pending' && !mine ? html`<div class="row"><button onClick=${() => { const n = prompt('Lý do trả lại?'); if (n != null) act(() => api('POST', `/api/wh/vouchers/${x.id}/reject`, { note: n }), 'Đã trả lại'); }}>Trả lại</button>
      <button class="primary grow" onClick=${() => act(() => api('POST', `/api/wh/vouchers/${x.id}/approve`), 'Đã duyệt')}>${['NM', 'XB'].includes(x.type) ? '✍ Ký nhận' : x.type === 'XCP' ? '✍ Tôi đã nhận đồ' : '✅ Duyệt'}</button></div>` : null}
    ${x.status === 'pending' && mine ? html`<p class="small muted">Chờ người khác duyệt (không ai tự duyệt chứng từ mình lập).</p>` : null}
    ${x.status === 'draft' && mine ? html`<button class="primary" onClick=${() => act(() => api('POST', `/api/wh/vouchers/${x.id}/submit`), 'Đã gửi')}>Gửi duyệt</button>` : null}
  </div>`;
}

function Receive({ meta, me }) {
  const dnm = useData('/api/wh/vouchers?type=DNM&status=approved');
  const [ref, setRef] = useState(null);
  const [store, setStore] = useState(meta.stores.find((s) => s.code === 'KHO_CHINH')?.id);
  const [supplier, setSupplier] = useState('');
  const [lines, setLines] = useState([]);
  const [photos, setPhotos] = useState([]);
  // Lỗi mạng khi chọn đề nghị → báo lỗi, không văng (rà soát 28/10)
  const pickRef = (id) => act(async () => { const v = await api('GET', `/api/wh/vouchers/${id}`); setRef(v); setLines(v.lines.map((l) => ({ ingredient_id: l.ingredient_id, qty: l.qty, qty_expected: l.qty, price: l.price }))); setSupplier(v.supplier_id || ''); });
  const sv = useSaver();
  const save = () => sv.run({ type: 'NM', ref_id: ref?.id, to_store: store, supplier_id: supplier || undefined, lines: clean(lines) }, photos, 'Đã lưu, chờ người dùng hàng cân / đếm ký nhận').then((r) => r && (setLines([]), setPhotos([]), setRef(null)));
  return html`<div class="stack"><h3>📥 Nhận hàng (nhập mua)</h3>
    <p class="small muted">2 người: thủ kho lập phiếu + chụp ảnh số cân / hàng; bếp / bar cân đếm lại rồi ký nhận trên máy họ. Nhận khác số đặt phải ghi lý do. Hàng lạnh nhập nhiệt độ + hạn dùng.</p>
    <b class="small">Theo đề nghị mua đã duyệt:</b>
    <div class="row wrap">${(dnm.data || []).filter((x) => x.created_by !== me.id).map((x) => html`<button class=${`chip ${ref?.id === x.id ? 'on' : ''}`} onClick=${() => pickRef(x.id)}>${x.no}</button>`)}${dnm.data && !dnm.data.length ? html`<small class="muted">không có</small>` : null}</div>
    <b class="small">Nhập vào kho:</b><${StorePick} stores=${meta.stores} value=${store} onChange=${setStore} />
    <select value=${supplier} onChange=${(e) => setSupplier(e.target.value)}><option value="">(nhà cung cấp)</option>${meta.suppliers.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select>
    <${Lines} meta=${meta} lines=${lines} setLines=${setLines} opts=${{ price: true, cold: true, showExpected: true, qtyLabel: 'Thực nhận', notePh: 'Lý do nếu khác số đặt' }} />
    <${Photos} photos=${photos} setPhotos=${setPhotos} need />
    <button class="primary big" disabled=${!lines.length || !photos.length || sv.busy} onClick=${save}>${sv.busy ? 'Đang lưu…' : 'Lưu & gửi ký nhận'}</button></div>`;
}

function Restock({ meta }) {
  const [store, setStore] = useState(meta.stores.find((s) => s.code === 'BEP')?.id);
  const d = useData(store ? `/api/wh/restock?store=${store}` : null);
  const [lines, setLines] = useState(null);
  useEffect(() => { if (d.data) setLines(d.data.map((x) => ({ ingredient_id: x.ingredient_id, qty: x.give, note: `mức chuẩn ${x.par}, đang có ${x.have}` }))); }, [d.data]);
  const sv = useSaver();
  const save = () => sv.run({ type: 'XB', to_store: store, lines: clean(lines) }, [], 'Đã xuất, chờ bếp trưởng / trưởng quầy ký nhận');
  return html`<div class="stack"><h3>📤 Xuất bù đầu ca</h3><p class="small muted">App tự tính = mức chuẩn − tồn hiện tại (không vượt tồn kho chính).</p>
    <${StorePick} stores=${meta.stores} value=${store} onChange=${setStore} codes=${['BEP', 'BAR']} />
    ${!lines ? html`<${Loading} state=${d} />` : html`${lines.length ? null : html`<p class="muted">Đã đủ mức chuẩn (hoặc chưa đặt mức chuẩn).</p>`}<${Lines} meta=${meta} lines=${lines} setLines=${setLines} />
      <button class="primary big" disabled=${!lines.length || sv.busy} onClick=${save}>Xuất kho</button>`}</div>`;
}

function Prep({ meta }) {
  const d = useData('/api/wh/prep');
  const [pick, setPick] = useState(null);
  const [inQty, setInQty] = useState('');
  const [outQty, setOutQty] = useState('');
  const recipes = d.data || [];
  const p = recipes.find((x) => x.id === pick);
  const std = p && inQty ? Math.round((Number(inQty) * p.output_qty / p.input_qty) * 100) / 100 : null;
  const sv = useSaver();
  const save = () => sv.run({ type: 'NSX', lines: [{ ingredient_id: p.input_id, kind: 'in', qty: inQty }, { ingredient_id: p.output_id, kind: 'out', qty: outQty || std }] }, [], 'Đã ghi sơ chế, chờ quản lý ca duyệt').then((r) => r && (setInQty(''), setOutQty('')));
  return html`<div class="stack"><h3>🔪 Sơ chế / nấu mẻ</h3>
    ${!recipes.length ? html`<p class="muted">Chưa có công thức bán thành phẩm (quản lý vào Cấu hình → Bán thành phẩm).</p>` : null}
    <div class="row wrap">${recipes.map((x) => html`<button class=${`chip ${pick === x.id ? 'on' : ''}`} onClick=${() => setPick(x.id)}>${x.output_name}</button>`)}</div>
    ${p ? html`<p class="small">Chuẩn: ${p.input_qty} ${p.input_unit} ${p.input_name} → ${p.output_qty} ${p.output_unit}</p>
      <label class="row">${p.input_name} dùng <input class="num-in" type="number" inputmode="decimal" value=${inQty} onInput=${(e) => setInQty(e.target.value)} /> ${p.input_unit}</label>
      <label class="row">Ra được thực tế <input class="num-in" type="number" inputmode="decimal" placeholder=${std ?? ''} value=${outQty} onInput=${(e) => setOutQty(e.target.value)} /> ${p.output_unit}</label>
      ${std != null ? html`<small class=${outQty && Number(outQty) < std * 0.97 ? 'warn-text' : 'muted'}>Chuẩn ra ${std} ${p.output_unit}${outQty ? ` · thực tế ${Math.round((Number(outQty) / std) * 1000) / 10}% chuẩn` : ''}</small>` : null}
      <button class="primary big" disabled=${!inQty || sv.busy} onClick=${save}>Gửi</button>` : null}</div>`;
}

function Count({ meta, me, query }) {
  const types = [['KK_CA', 'Cuối ca'], ...(meta.is_mgr ? [['KK_TUAN', 'Tuần'], ['KK_THANG', 'Tháng']] : []), ...(meta.is_owner ? [['KK_DX', 'Đột xuất'], ['KK_DAU_KY', 'Khởi tạo (đầu kỳ)']] : [])];
  const [type, setType] = useState(query.get('kk') || 'KK_CA');
  const [store, setStore] = useState(meta.stores.find((s) => s.code === 'BEP')?.id);
  const freq = { KK_CA: 'shift', KK_TUAN: 'week', KK_THANG: 'month', KK_DX: 'all', KK_DAU_KY: 'all' }[type];
  const d = useData(store ? `/api/wh/count-hint?store=${store}&freq=${freq}` : null);
  const [qty, setQty] = useState({});
  const [extra, setExtra] = useState([]);
  useEffect(() => setQty({}), [store, type]);
  const sv = useSaver();
  if (!d.data) return html`<${Loading} state=${d} />`;
  const h = d.data;
  const items = h.items;
  const save = () => sv.run({ type, from_store: store, lines: [...items.filter((x) => qty[x.id] !== undefined && qty[x.id] !== '').map((x) => ({ ingredient_id: x.id, qty: qty[x.id] })), ...extra.filter((x) => x.name_free && x.qty !== '')] }, [], 'Đã gửi kiểm kê').then((r) => r && go('ct', `&v=${r.id}`));
  return html`<div class="stack"><h3>🔢 Kiểm kê</h3>
    <div class="row wrap">${types.map(([k, n]) => html`<button class=${`chip ${type === k ? 'on' : ''}`} onClick=${() => setType(k)}>${n}</button>`)}</div>
    <${StorePick} stores=${meta.stores} value=${store} onChange=${setStore} />
    ${h.is_owner ? html`<p class="warn-text">Bạn đang giữ kho này nên không được đếm. Nhờ: ${h.suggest.map((s) => s.name).join(', ')}</p>` : html`
      ${h.streak ? html`<p class="warn-text small">⚠ Bạn đã đếm kho này ${h.streak_n} lần liền. Nên đổi người: ${h.suggest.map((s) => s.name).join(', ')}</p>` : null}
      <p class="small muted">Đếm thực tế, gõ số. Màn hình không hiện số sổ. Gửi xong app mới tính lệch.</p>
      ${!items.length ? html`<p class="muted small">Chưa có mặt hàng cần đếm ở mức này (gán nhóm hàng cho mặt hàng trong Cấu hình, hoặc chọn Đột xuất để đếm tất cả).</p>` : null}
      ${items.map((x) => html`<div class="row"><span class="grow">${x.name}</span><input class="num-in" type="number" inputmode="decimal" value=${qty[x.id] ?? ''} onInput=${(e) => setQty({ ...qty, [x.id]: e.target.value })} /><small style="width:36px">${x.unit}</small></div>`)}
      ${type === 'KK_DAU_KY' ? html`<b class="small">Hàng chưa có trong danh mục</b>${extra.map((x, i) => html`<div class="row"><input class="grow" placeholder="Tên" value=${x.name_free} onInput=${(e) => setExtra(extra.map((y, k) => (k === i ? { ...y, name_free: e.target.value } : y)))} /><input class="num-in" type="number" value=${x.qty} onInput=${(e) => setExtra(extra.map((y, k) => (k === i ? { ...y, qty: e.target.value } : y)))} /></div>`)}
        <button class="small" onClick=${() => setExtra([...extra, { name_free: '', qty: '' }])}>+ Mặt hàng mới</button><small class="muted">Hàng hỏng / hết hạn phát hiện khi đếm: vào "Ghi huỷ" tạo phiếu huỷ.</small>` : null}
      <button class="primary big" disabled=${sv.busy} onClick=${save}>${sv.busy ? 'Đang gửi…' : 'Gửi kết quả đếm'}</button>`}</div>`;
}

function SimpleVoucher({ meta, type, title, hint, storeFrom, storeTo, extraFields, opts }) {
  const [from, setFrom] = useState(storeFrom ? meta.stores.find((s) => s.code === storeFrom)?.id : null);
  const [to, setTo] = useState(storeTo ? meta.stores.find((s) => s.code === storeTo)?.id : null);
  const [lines, setLines] = useState([{ ingredient_id: null, qty: '' }]);
  const [f, setF] = useState({});
  const sv = useSaver();
  const save = () => sv.run({ type, from_store: from, to_store: to, lines: clean(lines), ...f }, [], 'Đã gửi').then((r) => r && setLines([{ ingredient_id: null, qty: '' }]));
  return html`<div class="stack"><h3>${title}</h3>${hint ? html`<p class="small muted">${hint}</p>` : null}
    ${storeFrom !== undefined ? html`<b class="small">Từ kho</b><${StorePick} stores=${meta.stores} value=${from} onChange=${setFrom} />` : null}
    ${storeTo !== undefined ? html`<b class="small">Đến kho</b><${StorePick} stores=${meta.stores} value=${to} onChange=${setTo} />` : null}
    ${extraFields ? extraFields(f, setF) : null}
    <${Lines} meta=${meta} lines=${lines} setLines=${setLines} opts=${opts || {}} />
    <button class="primary big" disabled=${sv.busy} onClick=${save}>Gửi</button></div>`;
}

function Purchase({ meta }) {
  const sug = useData('/api/wh/suggest-purchase');
  const [lines, setLines] = useState([]);
  useEffect(() => { if (sug.data && !lines.length) setLines(sug.data.map((x) => ({ ingredient_id: x.id, qty: x.suggest, price: x.price, note: `còn ${x.have}, tối thiểu ${x.min_stock}` }))); }, [sug.data]);
  const sv = useSaver();
  const save = () => sv.run({ type: 'DNM', lines: clean(lines) }, [], 'Đã gửi đề nghị, chờ quản lý duyệt').then((r) => r && setLines([]));
  return html`<div class="stack"><h3>🛒 Đề nghị mua</h3><p class="small muted">App gợi ý sẵn hàng dưới tồn tối thiểu. Duyệt xong thủ kho nhận hàng theo đề nghị này (người đề nghị không tự nhận).</p>
    <${Lines} meta=${meta} lines=${lines} setLines=${setLines} opts=${{ price: true }} />
    <button class="primary big" disabled=${!lines.length || sv.busy} onClick=${save}>Gửi đề nghị</button></div>`;
}

function Issue({ meta }) {
  const [staff, setStaff] = useState('');
  const [kind, setKind] = useState('CAP_MOI');
  const [lines, setLines] = useState([{ ingredient_id: null, qty: 1 }]);
  const [note, setNote] = useState('');
  const sv = useSaver();
  const save = () => sv.run({ type: 'XCP', target_staff_id: staff, kind, note, lines: clean(lines) }, [], 'Đã cấp, chờ nhân viên xác nhận trên máy của họ');
  const back = () => sv.run({ type: 'NTL', kind: 'staff', target_staff_id: staff, note: note || 'Thu hồi đồ nhân viên', lines: clean(lines) }, [], 'Đã ghi thu hồi, chờ người giữ kho nhận');
  return html`<div class="stack"><h3>👕 Cấp phát / đổi / thu hồi đồ nhân viên</h3>
    <select value=${staff} onChange=${(e) => setStaff(e.target.value)}><option value="">(chọn nhân viên)</option>${meta.staff.map((s) => html`<option value=${s.id}>${s.name}${s.team_name ? ` · ${s.team_name}` : ''}</option>`)}</select>
    <div class="row wrap">${[['CAP_MOI', 'Cấp mới'], ['DOI_CU_LAY_MOI', 'Đổi cũ lấy mới'], ['BU_MAT', 'Bù mất']].map(([k, n]) => html`<button class=${`chip ${kind === k ? 'on' : ''}`} onClick=${() => setKind(k)}>${n}</button>`)}</div>
    <${Lines} meta=${meta} lines=${lines} setLines=${setLines} opts=${{ filter: (x) => ['NHAN_SU', ''].includes(x.group_code || '') }} />
    <input placeholder=${kind === 'DOI_CU_LAY_MOI' ? 'Đã thu món cũ nào (bắt buộc)' : 'Ghi chú'} value=${note} onInput=${(e) => setNote(e.target.value)} />
    <div class="row"><button disabled=${!staff || sv.busy} onClick=${back}>↩ Thu hồi</button><button class="primary grow" disabled=${!staff || sv.busy} onClick=${save}>Cấp phát</button></div></div>`;
}

function Towels() {
  const d = useData('/api/wh/towels');
  const [f, setF] = useState({ issued: '', returned: '', to_laundry: '', from_laundry: '', explain: '' });
  const diff = (Number(f.issued) || 0) - (Number(f.returned) || 0);
  const sv = useSaver();
  const save = () => sv.once(() => act(() => api('POST', '/api/wh/towels', f), 'Đã ghi')).then((r) => r && setF({ issued: '', returned: '', to_laundry: '', from_laundry: '', explain: '' }));
  return html`<div class="stack"><h3>🧺 Khăn luân chuyển</h3>
    ${[['issued', 'Phát đầu ca'], ['returned', 'Thu về cuối ca'], ['to_laundry', 'Gửi giặt'], ['from_laundry', 'Nhận về từ giặt']].map(([k, n]) => html`<label class="row"><span class="grow">${n}</span><input class="num-in" type="number" inputmode="numeric" value=${f[k]} onInput=${(e) => setF({ ...f, [k]: e.target.value })} /></label>`)}
    ${diff ? html`<p class=${diff > 0 ? 'warn-text' : 'muted'}>Chênh lệch: ${diff}</p><input placeholder="Giải trình" value=${f.explain} onInput=${(e) => setF({ ...f, explain: e.target.value })} />` : null}
    <button class="primary" disabled=${sv.busy} onClick=${save}>Lưu</button>
    ${(d.data || []).slice(0, 14).map((x) => html`<small class=${x.diff ? 'warn-text' : 'muted'}>${x.date} ${x.shift}: phát ${x.issued}, thu ${x.returned}${x.diff ? `, lệch ${x.diff} · ${x.explain}` : ''} (${x.staff_name})</small>`)}</div>`;
}

function Assets({ meta }) {
  const d = useData('/api/wh/assets');
  const mins = useData('/api/wh/asset-minutes');
  const [add, setAdd] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [print, setPrint] = useState(false);
  if (!d.data) return html`<${Loading} state=${d} />`;
  if (print) return html`<${QrSheet} assets=${d.data} onClose=${() => setPrint(false)} />`;
  return html`<div class="stack"><h3>🪑 Tài sản</h3>
    <div class="row wrap"><button onClick=${() => setAdd({})}>+ Thêm</button><button onClick=${() => setBulk({ prefix: 'BAN', name: 'Bàn', from: 1, to: 100, is_table: true })}>+ Sinh mã hàng loạt</button><button onClick=${() => setPrint(true)}>🖨 In tem QR</button></div>
    ${d.data.map((a) => html`<div class="card tight stack"><div class="row"><b class="grow">${a.code} · ${a.name}</b><span class=${`pill ${a.status === 'DANG_DUNG' ? 'ok' : 'warn'}`}>${a.status_name}</span></div>
      <small class="muted">${a.location || ''}${a.owner_name ? ` · phụ trách ${a.owner_name}` : ''}${a.next_on ? ` · bảo trì ${a.maint_due ? '⚠ đến hạn' : ''} ${a.next_on}` : ''}${a.warranty_over ? ' · hết bảo hành' : ''}</small>
      <div class="row wrap">${a.status !== 'DANG_DUNG' ? html`<button class="small" onClick=${() => act(() => api('PATCH', `/api/wh/assets/${a.id}`, { status: 'DANG_DUNG' }), 'Đã cập nhật')}>Đã sửa xong</button>` : null}
        ${a.next_on ? html`<button class="small" onClick=${() => { const c = prompt('Nội dung bảo trì?'); if (c) act(() => api('POST', `/api/wh/assets/${a.id}/maint`, { content: c }), 'Đã ghi bảo trì'); }}>Ghi bảo trì</button>` : null}
        <button class="small" onClick=${() => { const t = prompt('Biên bản: DIEU_CHUYEN / HU_HONG / THANH_LY ?', 'DIEU_CHUYEN'); if (!t) return; const c = prompt('Nội dung'); if (!c) return; const loc = t.toUpperCase() === 'DIEU_CHUYEN' ? prompt('Chuyển đến vị trí') : ''; act(() => api('POST', '/api/wh/asset-minutes', { type: t.toUpperCase(), asset_id: a.id, content: c, to_location: loc }), 'Đã lập biên bản, chờ quản lý duyệt'); }}>Lập biên bản</button></div></div>`)}
    ${(mins.data || []).filter((m) => m.status === 'pending').length ? html`<h4>Biên bản chờ duyệt</h4>${mins.data.filter((m) => m.status === 'pending').map((m) => html`<div class="row"><span class="grow">${m.type} ${m.code}: ${m.content} (${m.created_by_name})</span>${meta.is_mgr ? html`<button class="small primary" onClick=${() => act(() => api('POST', `/api/wh/asset-minutes/${m.id}/approve`), 'Đã duyệt')}>Duyệt</button>` : null}</div>`)}` : null}
    ${add ? html`<${Modal} title="Thêm tài sản" onClose=${() => setAdd(null)}><div class="stack">
      ${[['code', 'Mã (vd TUDONG-01)'], ['name', 'Tên'], ['kind', 'Loại'], ['location', 'Vị trí'], ['price', 'Giá mua'], ['bought_on', 'Ngày mua (YYYY-MM-DD)'], ['warranty_to', 'Bảo hành đến'], ['cycle_days', 'Chu kỳ bảo trì (ngày)']].map(([k, n]) => html`<${Field} label=${n}><input value=${add[k] || ''} onInput=${(e) => setAdd({ ...add, [k]: e.target.value })} /><//>`)}
      <${Field} label="Người phụ trách"><select value=${add.owner_id || ''} onChange=${(e) => setAdd({ ...add, owner_id: e.target.value })}><option value="">(chưa)</option>${meta.staff.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
      <button class="primary" onClick=${() => act(() => api('POST', '/api/wh/assets', add), 'Đã thêm').then((r) => r && setAdd(null))}>Lưu</button></div><//>` : null}
    ${bulk ? html`<${Modal} title="Sinh mã hàng loạt" onClose=${() => setBulk(null)}><div class="stack">
      ${[['prefix', 'Tiền tố (vd BAN, GHE)'], ['name', 'Tên (vd Bàn)'], ['from', 'Từ số'], ['to', 'Đến số'], ['location', 'Vị trí']].map(([k, n]) => html`<${Field} label=${n}><input value=${bulk[k] ?? ''} onInput=${(e) => setBulk({ ...bulk, [k]: e.target.value })} /><//>`)}
      <label class="check-row"><input type="checkbox" checked=${bulk.is_table} onChange=${(e) => setBulk({ ...bulk, is_table: e.target.checked })} /> Là bàn (gắn số bàn của sơ đồ)</label>
      <button class="primary" onClick=${() => act(() => api('POST', '/api/wh/assets/bulk', bulk)).then((r) => r && (toast(`Đã tạo ${r.created} mã`), setBulk(null)))}>Tạo</button></div><//>` : null}</div>`;
}
// Tem QR: lưới tem dán (mã + tên), in từ trình duyệt
function qrSvg(text, size = 110) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), c = size / n;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${(x * c).toFixed(2)},${(y * c).toFixed(2)}h${c.toFixed(2)}v${c.toFixed(2)}h-${c.toFixed(2)}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><path d="${d}" fill="#000"/></svg>`;
}
function QrSheet({ assets, onClose }) {
  return html`<div class="stack"><div class="row noprint"><button onClick=${onClose}>← Quay lại</button><button class="primary" onClick=${() => window.print()}>🖨 In</button></div>
    <div class="qr-sheet">${assets.filter((a) => a.status !== 'THANH_LY').map((a) => html`<div class="qr-tag"><div dangerouslySetInnerHTML=${{ __html: qrSvg(a.code) }}></div><b>${a.code}</b><small>${a.name}</small></div>`)}</div></div>`;
}

function Dashboard() {
  const d = useData('/api/wh/dashboard');
  if (!d.data) return html`<${Loading} state=${d} />`;
  const x = d.data;
  return html`<div class="stack"><h3>📊 Dashboard kho (${x.from} → ${x.to})</h3>
    <div class="row wrap"><span class="pill ${x.red_unexplained ? 'bad' : 'ok'}">🔴 chưa giải trình: ${x.red_unexplained}</span><span class="pill warn">Chờ duyệt: ${x.pending}</span>${x.food_cost.pct != null ? html`<span class="pill">Food cost ${x.food_cost.pct}%</span>` : null}</div>
    ${x.no_owner.length ? html`<p class="warn-text small">Kho chưa có người chịu trách nhiệm: ${x.no_owner.map((s) => s.name).join(', ')}</p>` : null}
    <h4>Chênh lệch kiểm kê</h4>${x.variance.length ? x.variance.map((l) => html`<button class="tpl-row" onClick=${() => go('ct', `&v=${l.voucher_id}`)}><span class="grow">${COLOR[l.color]} ${l.name} · ${l.store_name} ${l.shift}</span><small>${l.diff} (${l.pct}%) · ${l.owner_name}${l.explain ? ' · đã giải trình' : ''}</small></button>`) : html`<small class="muted">Không có lệch vàng / đỏ.</small>`}
    <h4>Huỷ theo lý do</h4>${Object.entries(x.waste_by_reason).map(([k, c]) => html`<div class="row"><span class="grow">${k}</span><b>${money(c)}</b></div>`)}
    ${Object.keys(x.veg_waste_by_day).length ? html`<h4>Rau bỏ theo ngày</h4>${Object.entries(x.veg_waste_by_day).map(([dd, q]) => html`<div class="row"><span style="width:90px">${dd}</span><div style=${`height:12px;background:#7cb342;width:${Math.min(100, q / 50)}%`}></div><small>${q}</small></div>`)}` : null}
    ${x.yields.length ? html`<h4>Yield sơ chế</h4>${x.yields.map((y) => html`<div class="row"><span class="grow">${y.date} ${y.input} → ${y.output}</span><b class=${y.pct != null && y.pct < 97 ? 'warn-text' : ''}>${y.pct != null ? `${y.pct}% chuẩn` : `${y.actual}`}</b></div>`)}` : null}
    ${x.reorder.length ? html`<h4>Cần đặt hàng (dưới tối thiểu)</h4>${x.reorder.map((r) => html`<small>• ${r.name}: còn ${Math.round(r.have)} / tối thiểu ${r.min_stock} ${r.unit}</small>`)}` : null}
    ${x.expiring.length ? html`<h4>Sắp hết hạn</h4>${x.expiring.map((r) => html`<small>• ${r.name} (${r.store_name}): ${r.qty} · hạn ${r.expires_on}</small>`)}` : null}
    ${x.breakage.length ? html`<h4>Bể vỡ 30 ngày</h4>${x.breakage.map((b) => html`<small>• ${b.date} ${b.name} ×${b.qty} · ${b.who || 'không rõ'}</small>`)}` : null}
    ${x.towels.length ? html`<h4>Khăn lệch</h4>${x.towels.map((t) => html`<small>• ${t.date} ${t.shift}: lệch ${t.diff} · ${t.explain}</small>`)}` : null}
    ${x.assets.maint_due.length || x.assets.broken.length ? html`<h4>Tài sản</h4>${x.assets.broken.map((a) => html`<small>• 🔧 ${a.code} ${a.name}</small>`)}${x.assets.maint_due.map((a) => html`<small>• 🛠 đến hạn bảo trì ${a.code} (${a.next_on})</small>`)}${x.assets.warranty_over.map((a) => html`<small>• hết bảo hành ${a.code}</small>`)}` : null}
    ${x.offboarding.length ? html`<h4>Nghỉ việc chưa thu hồi đồ</h4>${x.offboarding.map((s) => html`<small>• ${s.name}: ${s.items.map((i) => `${i.name} ×${i.qty}`).join(', ')}</small>`)}` : null}
    ${x.by_owner.length ? html`<h4>Chênh lệch theo người phụ trách (30 ngày)</h4>${x.by_owner.map((o) => html`<div class="row"><span class="grow">${o.owner_name}</span><small>${o.n} dòng lệch · ${o.red} đỏ</small></div>`)}` : null}</div>`;
}

function StockList({ meta }) {
  const [store, setStore] = useState(meta.stores.find((s) => s.code === 'KHO_CHINH')?.id);
  const d = useData(store ? `/api/wh/stock?store=${store}` : null);
  return html`<div class="stack"><h3>📦 Tồn kho</h3><${StorePick} stores=${meta.stores} value=${store} onChange=${setStore} />
    ${!d.data ? html`<${Loading} state=${d} />` : d.data.rows.map((x) => html`<div class="row"><span class="grow">${x.name}${x.low ? ' ⚠ dưới tối thiểu' : ''}${x.expiring ? ' ⏰ sắp hết hạn' : ''}</span><b>${x.qty}</b><small style="width:40px">${x.unit}</small></div>`)}</div>`;
}

function Match() {
  const d = useData('/api/wh/vouchers?type=NM&status=approved');
  const [f, setF] = useState({});
  return html`<div class="stack"><h3>🧾 Đối chiếu 3 chứng từ</h3><p class="small muted">Đề nghị đã duyệt – phiếu nhập – hoá đơn NCC. Khớp mới được thanh toán.</p>
    ${(d.data || []).map((x) => html`<div class="card tight stack"><div class="row"><b class="grow">${x.no}</b>${x.paid_ok ? html`<span class="pill ok">Được thanh toán</span>` : html`<span class="pill warn">Chưa khớp</span>`}</div>
      ${x.paid_ok ? null : html`<div class="row wrap"><input placeholder="Số hoá đơn" value=${f[x.id]?.no || ''} onInput=${(e) => setF({ ...f, [x.id]: { ...f[x.id], no: e.target.value } })} /><input class="num-in" type="number" placeholder="Tổng tiền" value=${f[x.id]?.total || ''} onInput=${(e) => setF({ ...f, [x.id]: { ...f[x.id], total: e.target.value } })} />
        <button class="small primary" onClick=${() => act(() => api('POST', `/api/wh/vouchers/${x.id}/match`, { invoice_no: f[x.id]?.no, invoice_total: f[x.id]?.total })).then((r) => r && toast(r.ok ? 'Khớp, được thanh toán' : r.issues.join(' · '), !r.ok))}>Đối chiếu</button></div>`}</div>`)}</div>`;
}

function Config({ meta }) {
  const [store, setStore] = useState(meta.stores.find((s) => s.code === 'BEP')?.id);
  const par = useData(store ? `/api/wh/par?store=${store}` : null);
  const prep = useData('/api/wh/prep');
  const [np, setNp] = useState({ ingredient_id: null, qty: '' });
  const [pr, setPr] = useState({ output_id: null, input_id: null, input_qty: '', output_qty: '' });
  return html`<div class="stack"><h3>⚙ Cấu hình kho</h3>
    ${meta.is_owner ? html`<section class="card stack"><h4>Người chịu trách nhiệm từng kho</h4>${meta.stores.map((s) => html`<label class="row"><span class="grow">${s.name}</span><select value=${s.owner_id || ''} onChange=${(e) => act(() => api('PUT', `/api/wh/stores/${s.id}/owner`, { owner_id: e.target.value }), 'Đã lưu')}><option value="">(chưa gán)</option>${meta.staff.map((x) => html`<option value=${x.id}>${x.name}</option>`)}</select></label>`)}</section>
      <section class="card stack"><h4>Vai trò kho của nhân viên</h4>${meta.staff.filter((s) => s.role !== 'owner').map((s) => { const cur = (s.wh_roles || '').split(',').filter(Boolean); return html`<div class="stack tight"><b class="small">${s.name}</b><div class="row wrap">${Object.entries(meta.role_names).map(([k, n]) => html`<button class=${`chip ${cur.includes(k) ? 'on' : ''}`} onClick=${() => act(() => api('PUT', `/api/wh/staff/${s.id}/roles`, { roles: cur.includes(k) ? cur.filter((y) => y !== k) : [...cur, k] }), 'Đã lưu')}>${n}</button>`)}</div></div>`; })}</section>
      <section class="card stack"><h4>Nhóm hàng: tần suất kiểm & ngưỡng lệch</h4>${meta.groups.map((g) => html`<div class="stack tight"><b class="small">${g.code} · ${g.name}</b><div class="row wrap">
        <select value=${g.count_freq} onChange=${(e) => act(() => api('PUT', `/api/wh/groups/${g.code}`, { count_freq: e.target.value }), 'Đã lưu')}>${Object.entries(FREQ).map(([k, n]) => html`<option value=${k}>${n}</option>`)}</select>
        <label class="row">Vàng > <input class="num-in" type="number" value=${g.warn_pct} onChange=${(e) => act(() => api('PUT', `/api/wh/groups/${g.code}`, { warn_pct: e.target.value }), 'Đã lưu')} />%</label>
        <label class="row">Đỏ > <input class="num-in" type="number" value=${g.red_pct} onChange=${(e) => act(() => api('PUT', `/api/wh/groups/${g.code}`, { red_pct: e.target.value }), 'Đã lưu')} />%</label></div></div>`)}</section>` : html`<p class="small muted">Ngưỡng, người phụ trách, vai trò: chỉ chủ quán sửa.</p>`}
    <section class="card stack"><h4>Mức chuẩn mỗi ca (par)</h4><${StorePick} stores=${meta.stores} value=${store} onChange=${setStore} codes=${['BEP', 'BAR']} />
      ${(par.data || []).map((p) => html`<div class="row"><span class="grow">${p.name}</span><input class="num-in" type="number" value=${p.qty} onChange=${(e) => act(() => api('PUT', '/api/wh/par', { store, items: [{ ingredient_id: p.ingredient_id, qty: e.target.value }] }), 'Đã lưu')} /><small>${p.unit}</small></div>`)}
      <${ItemPick} items=${meta.items} value=${np.ingredient_id} onChange=${(id) => setNp({ ...np, ingredient_id: id })} />
      <div class="row"><input class="num-in" type="number" placeholder="Mức chuẩn" value=${np.qty} onInput=${(e) => setNp({ ...np, qty: e.target.value })} /><button class="small" disabled=${!np.ingredient_id} onClick=${() => act(() => api('PUT', '/api/wh/par', { store, items: [np] }), 'Đã thêm').then((r) => r && setNp({ ingredient_id: null, qty: '' }))}>Thêm</button></div></section>
    <section class="card stack"><h4>Bán thành phẩm (yield chuẩn)</h4>${(prep.data || []).map((p) => html`<small>• ${p.input_qty} ${p.input_unit} ${p.input_name} → ${p.output_qty} ${p.output_unit} ${p.output_name}</small>`)}
      <b class="small">Thành phẩm</b><${ItemPick} items=${meta.items} value=${pr.output_id} onChange=${(id) => setPr({ ...pr, output_id: id })} />
      <b class="small">Nguyên liệu thô</b><${ItemPick} items=${meta.items} value=${pr.input_id} onChange=${(id) => setPr({ ...pr, input_id: id })} />
      <div class="row"><input class="num-in" type="number" placeholder="Lượng thô" value=${pr.input_qty} onInput=${(e) => setPr({ ...pr, input_qty: e.target.value })} /> → <input class="num-in" type="number" placeholder="Ra được" value=${pr.output_qty} onInput=${(e) => setPr({ ...pr, output_qty: e.target.value })} /><button class="small" onClick=${() => act(() => api('PUT', '/api/wh/prep', pr), 'Đã lưu')}>Lưu</button></div></section>
    <${ItemsEdit} meta=${meta} /></div>`;
}
function ItemsEdit({ meta }) {
  const [q, setQ] = useState('');
  const list = meta.items.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()) || x.need_review);
  const upd = (id, patch) => act(() => api('PUT', `/api/wh/items/${id}`, patch), 'Đã lưu');
  return html`<section class="card stack"><h4>Mặt hàng (nhóm, tối thiểu / tối đa)</h4><input placeholder="Tìm…" value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${list.slice(0, 30).map((x) => html`<div class="stack tight"><b class="small">${x.name}${x.need_review ? html` <span class="pill warn">mới từ kiểm kê, cần bổ sung</span>` : ''}</b><div class="row wrap">
      <select value=${x.group_code || ''} onChange=${(e) => upd(x.id, { group_code: e.target.value })}><option value="">(nhóm)</option>${meta.groups.map((g) => html`<option value=${g.code}>${g.code}</option>`)}</select>
      <input class="num-in" type="number" placeholder="tối thiểu" value=${x.min_stock || ''} onChange=${(e) => upd(x.id, { min_stock: e.target.value })} />
      <input class="num-in" type="number" placeholder="tối đa" value=${x.max_stock || ''} onChange=${(e) => upd(x.id, { max_stock: e.target.value })} />
      ${x.need_review ? html`<button class="small" onClick=${() => upd(x.id, { need_review: false })}>Đã bổ sung</button>` : null}</div></div>`)}</section>`;
}

function Setup({ meta }) {
  const [kind, setKind] = useState('mat_hang');
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  const file = async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setText(await f.text()); };
  const KINDS = { mat_hang: 'Mặt hàng', nha_cung_cap: 'Nhà cung cấp', dinh_muc_cap_phat: 'Định mức cấp phát', muc_chuan: 'Mức chuẩn', tai_san: 'Tài sản' };
  return html`<div class="stack"><h3>🚀 Khởi tạo kho</h3>
    <ol class="small"><li>Tải file mẫu, điền trong Excel, <b>Lưu thành CSV</b> rồi tải lên dưới đây (theo thứ tự: nhà cung cấp → mặt hàng → mức chuẩn → định mức → tài sản).</li>
      <li>Gán người chịu trách nhiệm từng kho + vai trò (Cấu hình).</li>
      <li>Kiểm kê khởi tạo từng kho (nhiều tổ đếm song song) → chủ duyệt → <b>chốt tồn đầu kỳ</b>. Đủ Kho chính, Kho bếp, Bar là app bật chế độ chứng từ.</li>
      <li>Nhập đồ nhân sự đang giữ: Cấp phát cho từng nhân viên (họ xác nhận). In tem QR tài sản.</li></ol>
    <p class=${meta.live ? 'ok-text' : 'warn-text'}>${meta.live ? '✓ Đã chốt tồn đầu kỳ, đang chạy theo chứng từ' : 'Chưa chốt tồn đầu kỳ'}</p>
    <div class="row wrap">${Object.entries(KINDS).map(([k, n]) => html`<button class=${`chip ${kind === k ? 'on' : ''}`} onClick=${() => setKind(k)}>${n}</button>`)}</div>
    <a class="button" href=${`/api/wh/template?kind=${kind}`}>⬇ Tải file mẫu ${KINDS[kind]}</a>
    <label class="button">📂 Chọn file CSV<input type="file" accept=".csv,text/csv,text/plain" hidden onChange=${file} /></label>
    <textarea rows="5" placeholder="…hoặc dán nội dung CSV vào đây" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    <button class="primary" disabled=${!text} onClick=${() => act(() => api('POST', '/api/wh/import', { kind, text })).then((r) => r && setRes(r))}>Nhập</button>
    ${res ? html`<p class=${res.errors.length ? 'warn-text' : 'ok-text'}>Đã nhập ${res.ok} dòng${res.errors.length ? `, lỗi ${res.errors.length}` : ''}</p>${res.errors.map((e) => html`<small class="warn-text">${e}</small>`)}` : null}
    <button onClick=${() => go('dem', '&kk=KK_DAU_KY')}>🔢 Kiểm kê khởi tạo</button></div>`;
}

function Vouchers() {
  const [type, setType] = useState('');
  const d = useData(`/api/wh/vouchers${type ? `?type=${type}` : ''}`);
  const meta = useData('/api/wh/meta');
  return html`<div class="stack"><h3>📄 Chứng từ</h3><select value=${type} onChange=${(e) => setType(e.target.value)}><option value="">Tất cả loại</option>${Object.entries(meta.data?.types || {}).map(([k, n]) => html`<option value=${k}>${n}</option>`)}</select>
    ${(d.data || []).map((x) => html`<button class="tpl-row" onClick=${() => go('ct', `&v=${x.id}`)}><b class="grow">${x.no}</b><small class="muted">${x.type_name} · ${x.status_name} · ${x.created_by_name}</small></button>`)}</div>`;
}
function Audit() {
  const d = useData('/api/wh/audit');
  return html`<div class="stack"><h3>🕵 Nhật ký kho</h3>${(d.data || []).map((a) => html`<small>${dt(a.at)} · <b>${a.staff_name || 'hệ thống'}</b> · ${a.action.replace('wh.', '')} · <span class="muted">${a.detail.slice(0, 120)}</span></small>`)}</div>`;
}
function Offboarding() {
  const d = useData('/api/wh/offboarding');
  return html`<div class="stack"><h3>🚪 Nghỉ việc chưa thu hồi đồ</h3>${d.data && !d.data.length ? html`<p class="muted">Không có ai.</p>` : null}${(d.data || []).map((s) => html`<div class="card tight"><b>${s.name}</b><br /><small>${s.items.map((i) => `${i.name} ×${i.qty}`).join(', ')}</small><br /><small class="muted">Thu hồi: vào Cấp phát → chọn ${s.name} → ↩ Thu hồi</small></div>`)}</div>`;
}

// ---------- Trang chính: nút theo vai trò ----------
export function WarehouseView({ me, query }) {
  const m = useData('/api/wh/meta');
  if (!m.data) return html`<${Loading} state=${m} />`;
  const meta = m.data;
  const tab = query.get('tab') || '';
  const vid = query.get('v');
  if (!meta.setup) return html`<div class="stack"><h2>Kho & Tài sản (chứng từ)</h2>
    <p>Kho mới: 4 vị trí (Kho chính, Kho bếp, Tồn quầy bar, Kho cấp phát), mọi biến động qua chứng từ, không ai tự duyệt phiếu mình lập.</p>
    ${meta.is_owner ? html`<p class="small muted">Bấm bắt đầu: Kho tổng → Kho chính, gộp kho Bếp steak + Lẩu thành Kho bếp, Bar → Tồn quầy bar, thêm Kho cấp phát. Tồn hiện tại giữ nguyên tới khi kiểm kê khởi tạo.</p>
      <button class="primary big" onClick=${() => confirm('Bắt đầu kho mới? Kho Bếp steak + Lẩu sẽ gộp thành Kho bếp.') && act(() => api('POST', '/api/wh/setup'), 'Đã bật kho mới')}>🚀 Bắt đầu kho mới</button>` : html`<p class="muted">Chủ quán chưa bật kho mới.</p>`}</div>`;
  if (vid) return html`<${VoucherDetail} id=${vid} me=${me} />`;
  const R = new Set(meta.my_roles);
  const lead = meta.is_lead, mgr = meta.is_mgr, owner = meta.is_owner;
  const T = (k, icon, label, show = true) => (show ? { k, icon, label } : null);
  const groups = [
    ['Mọi người', [T('huy', '🗑', 'Ghi huỷ / bể vỡ'), T('hong', '🔧', 'Báo hỏng'), T('cua-toi', '👕', 'Đồ tôi giữ'), T('duyet', '✅', 'Chờ tôi duyệt / ký')]],
    ['Bếp / Bar', [T('yeu-cau', '🙋', 'Yêu cầu bổ sung', R.has('bep_truong') || R.has('truong_quay') || lead), T('so-che', '🔪', 'Sơ chế / nấu mẻ', R.has('bep_truong') || lead)]],
    ['Thủ kho', [T('nhan-hang', '📥', 'Nhận hàng', R.has('thu_kho') || lead), T('xuat-bu', '📤', 'Xuất bù đầu ca', R.has('thu_kho') || lead), T('dem', '🔢', 'Đếm cuối ca', R.has('thu_kho') || lead), T('tra-ncc', '↩', 'Trả NCC', R.has('thu_kho') || mgr), T('ton', '📦', 'Tồn kho', R.has('thu_kho') || lead || R.has('ke_toan'))]],
    ['Cấp phát & tài sản', [T('cap-phat', '👕', 'Cấp / đổi / thu hồi', R.has('cap_phat') || mgr), T('ccdc', '🍽', 'Xuất thay CCDC', R.has('cap_phat') || mgr), T('ts', '🪑', 'Tài sản & tem QR', R.has('cap_phat') || mgr), T('khan', '🧺', 'Khăn', R.has('cap_phat') || lead), T('nghi-viec', '🚪', 'Nghỉ việc chưa thu', R.has('cap_phat') || mgr)]],
    ['Quản lý', [T('dash', '📊', 'Dashboard', lead || R.has('ke_toan')), T('dnm', '🛒', 'Đề nghị mua', R.has('bep_truong') || R.has('truong_quay') || R.has('thu_kho') || mgr), T('chung-tu', '📄', 'Chứng từ', lead), T('cau-hinh', '⚙', 'Cấu hình', mgr)]],
    ['Chủ / Kế toán', [T('khoi-tao', '🚀', 'Khởi tạo', owner), T('doi-chieu', '🧾', 'Đối chiếu 3 chứng từ', R.has('ke_toan') || mgr), T('nhat-ky', '🕵', 'Nhật ký', owner)]],
  ].map(([g, list]) => [g, list.filter(Boolean)]).filter(([, l]) => l.length);
  const screen = {
    huy: () => html`<${WasteForm} meta=${meta} />`, hong: () => html`<${IssueForm} />`, 'cua-toi': () => html`<${MyItems} />`, duyet: () => html`<${Inbox} />`,
    'yeu-cau': () => html`<${SimpleVoucher} meta=${meta} type="YC" title="🙋 Yêu cầu bổ sung (ngoài mức chuẩn)" hint="Quản lý duyệt rồi thủ kho xuất." />`,
    'so-che': () => html`<${Prep} meta=${meta} />`, 'nhan-hang': () => html`<${Receive} meta=${meta} me=${me} />`, 'xuat-bu': () => html`<${Restock} meta=${meta} />`,
    dem: () => html`<${Count} meta=${meta} me=${me} query=${query} />`,
    'tra-ncc': () => html`<${SimpleVoucher} meta=${meta} type="XTN" title="↩ Xuất trả nhà cung cấp" hint="Quản lý duyệt." storeFrom="KHO_CHINH" extraFields=${(f, setF) => html`<select value=${f.supplier_id || ''} onChange=${(e) => setF({ ...f, supplier_id: e.target.value })}><option value="">(nhà cung cấp)</option>${meta.suppliers.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select>`} />`,
    ton: () => html`<${StockList} meta=${meta} />`, 'cap-phat': () => html`<${Issue} meta=${meta} />`,
    ccdc: () => html`<${SimpleVoucher} meta=${meta} type="XCC" title="🍽 Xuất thay CCDC" hint="Ghi số phiếu bể vỡ tương ứng; bổ sung số chuẩn (không có phiếu bể) thì cần quản lý duyệt." storeFrom="CAP_PHAT" storeTo="BEP" extraFields=${(f, setF) => html`<input placeholder="Mã phiếu bể vỡ (id), nếu có" value=${f.ref_id || ''} onInput=${(e) => setF({ ...f, ref_id: e.target.value })} />`} />`,
    ts: () => html`<${Assets} meta=${meta} />`, khan: () => html`<${Towels} />`, 'nghi-viec': () => html`<${Offboarding} />`, dash: () => html`<${Dashboard} />`,
    dnm: () => html`<${Purchase} meta=${meta} />`, 'chung-tu': () => html`<${Vouchers} />`, 'cau-hinh': () => html`<${Config} meta=${meta} />`, 'khoi-tao': () => html`<${Setup} meta=${meta} />`,
    'doi-chieu': () => html`<${Match} />`, 'nhat-ky': () => html`<${Audit} />`, ct: () => null,
  }[tab];
  if (screen) return html`<div class="stack wh"><button class="small" onClick=${() => go('')}>← Kho</button>${screen()}</div>`;
  return html`<div class="stack wh">
    ${!meta.live ? html`<p class="warn-text small">Chưa chốt tồn đầu kỳ. ${owner ? 'Vào 🚀 Khởi tạo.' : 'Chờ chủ quán khởi tạo.'}</p>` : null}
    ${groups.map(([g, list]) => html`<section class="stack tight"><b class="small muted">${g}</b><div class="wh-tiles">${list.map((x) => html`<button class="wh-tile" onClick=${() => go(x.k)}><span>${x.icon}</span>${x.label}</button>`)}</div></section>`)}
  </div>`;
}
