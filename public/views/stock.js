import { useState, useEffect } from '../vendor/hooks.js';
import { html, api, act, useData, Modal, Field, Loading, Confirm, navigate, dt, dayLabel, money, atLeast, toast, addDays, can, SaveInput } from '../ui.js';

const TABS = [['ton', 'Tồn kho'], ['nxt', 'Nhập – Xuất – Tồn', 'manager'], ['kiem', 'Kiểm kho'], ['hh', '📉 Hao hụt', 'manager'], ['linh', '📤 Xuất dùng'], ['dodung', '🍽 Đồ dùng'], ['dat', 'Đặt hàng'], ['nl', 'Nguyên liệu & NCC', 'manager'], ['quydoi', '⚖ Quy đổi', 'manager'], ['ls', 'Lịch sử']];
const STATUS = { out: ['Hết', 'bad'], low: ['Sắp hết', 'warn'], ok: ['Đủ', 'ok'] };
const FRESH = { fresh: 'Đồ tươi', chilled: 'Đồ mát', dry: 'Đồ khô/đông' };
const TR = { requested: ['Chờ kho tổng xuất', 'warn'], sent: ['Đã xuất, chờ khu nhận', 'warn'], received: ['Đã nhận', 'ok'], cancelled: ['Đã huỷ', 'muted'] };
const PO = { draft: ['Nháp', ''], submitted: ['Chờ duyệt', 'warn'], approved: ['Đã duyệt, chờ hàng về', 'ok'], received: ['Đã nhận hàng', 'muted'], cancelled: ['Đã huỷ', 'muted'] };
const MOVE = { receive: 'Nhập NCC', transfer: 'Xuất cho khu', consume: 'Dùng', waste: 'Hao hụt', adjust: 'Kiểm thừa' };

// 4500 g → "4,5 kg"; 1200 ml → "1,2 lít"
export function qty(n, unit) {
  const v = Number(n) || 0;
  const f = (x, d = 2) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('vi-VN');
  if ((unit === 'g' || unit === 'ml') && Math.abs(v) >= 1000) return `${f(v / 1000, 2)} ${unit === 'g' ? 'kg' : 'lít'}`;
  if (unit === 'g' || unit === 'ml' || ['quả', 'lon', 'chai', 'phần', 'cái', 'gói', 'bó'].includes(unit)) return `${f(v, 0)} ${unit}`;
  return `${f(v, 1)} ${unit}`;
}
const numIn = (v) => (v === '' || v === null || v === undefined ? '' : String(v));

// ---------- Tồn kho ----------
function Overview() {
  const st = useData('/api/stock/overview');
  const [store, setStore] = useState('all');
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  let items = d.items;
  if (store !== 'all') items = items.filter((i) => (i.stock[store] || 0) > 0 || String(i.home_store_id) === store || (store === String(d.stores.find((s) => s.kind === 'main')?.id)));
  if (filter === 'warn') items = items.filter((i) => i.status !== 'ok');
  if (filter === 'exp') items = items.filter((i) => i.expiring.length);
  if (q) items = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  const nWarn = d.items.filter((i) => i.status !== 'ok').length;
  const nExp = d.items.filter((i) => i.expiring.length).length;
  return html`<div class="stack">
    <div class="row wrap">
      <select id="ov-store" class="auto" value=${store} onChange=${(e) => setStore(e.target.value)}>
        <option value="all">Tất cả kho</option>${d.stores.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select>
      <input id="ov-q" type="search" class="auto" placeholder="Tìm nguyên liệu" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>
    <div class="chips">
      <button class=${`chip ${filter === '' ? 'on' : ''}`} onClick=${() => setFilter('')}>Tất cả (${d.items.length})</button>
      <button class=${`chip ${filter === 'warn' ? 'on' : ''}`} onClick=${() => setFilter('warn')}>Hết / sắp hết (${nWarn})</button>
      <button class=${`chip ${filter === 'exp' ? 'on' : ''}`} onClick=${() => setFilter('exp')}>Sắp hết hạn (${nExp})</button>
    </div>
    ${items.length ? html`<div class="stock-list">${items.map((i) => html`<section class=${`card stock-row ${i.status}`}>
      <div class="row between"><b>${i.name}</b><span class=${`pill ${STATUS[i.status][1]}`}>${STATUS[i.status][0]}</span></div>
      <div class="row between small">
        <span>Còn <b>${qty(i.available, i.unit)}</b>${i.days_left !== null ? html` <span class="muted">· đủ ~${Math.floor(i.days_left * 10) / 10} ngày</span>` : null}</span>
        <span class="muted">Mai cần ~${qty(i.forecast_tomorrow, i.unit)}</span>
      </div>
      <div class="muted small">${d.stores.filter((s) => i.stock[s.id]).map((s) => `${s.name.replace('Kho ', '')}: ${qty(i.stock[s.id], i.unit)}`).join(' · ') || 'Không còn trong kho nào'}</div>
      <div class="muted small">${FRESH[i.freshness]} · ${i.home_name} · ${i.supplier_name || 'chưa có NCC'}${i.min_stock ? ` · tối thiểu ${qty(i.min_stock, i.unit)}` : ''}</div>
      ${i.expiring.map((e) => html`<div class=${`small ${e.expired ? 'bad-text' : 'warn-text'}`}>${e.expired ? 'Đã hết hạn' : 'Sắp hết hạn'} ${dayLabel(e.expires_on)}: ${qty(e.qty, i.unit)} ở ${d.stores.find((s) => s.id === e.store_id)?.name || ''}</div>`)}
    </section>`)}</div>` : html`<div class="empty">${d.items.length ? 'Không có nguyên liệu nào khớp.' : 'Chưa có nguyên liệu. Quản lý thêm ở tab "Nguyên liệu & NCC".'}</div>`}
    <p class="muted small">"Mai cần" tính từ lượng dùng thực tế các ngày trước (ưu tiên các ngày cùng thứ trong 4 tuần gần nhất). Càng kiểm kho đều, gợi ý càng chính xác.</p>
  </div>`;
}

// ---------- Kiểm kho ----------
function TransferForm({ store, lines: initLines, onClose, addOptions = [] }) {
  const [lines, setLines] = useState(initLines.map((l) => ({ ...l, qty: l.need ?? l.qty ?? '' })));
  const canAdd = addOptions.filter((i) => !lines.some((l) => l.ingredient_id === i.id));
  const [note, setNote] = useState('');
  return html`<${Modal} title=${`Xin lĩnh hàng cho ${store.name}`} onClose=${onClose}>
    <div class="stack">
      ${lines.map((l, i) => html`<div class="line-in">
        <span class="grow"><b>${l.name}</b><br /><small class="muted">Kho tổng còn ${qty(l.main_stock ?? 0, l.unit)}${l.forecast !== undefined ? ` · mai cần ~${qty(l.forecast, l.unit)}` : ''}</small></span>
        <input inputmode="decimal" class="num-in" value=${numIn(l.qty)} aria-label=${`Số lượng ${l.name}`}
          onInput=${(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /><span class="muted">${l.unit}</span>
      </div>`)}
      ${!lines.length ? html`<p class="muted small">Chưa có dòng nào. Chọn nguyên liệu cần lĩnh bên dưới.</p>` : null}
      ${canAdd.length ? html`<select id="tf-add" onChange=${(e) => {
        const i = addOptions.find((x) => x.id === Number(e.target.value));
        if (i) setLines([...lines, { ingredient_id: i.id, name: i.name, unit: i.unit, qty: '' }]);
        e.target.value = '';
      }}><option value="">+ Thêm nguyên liệu vào phiếu</option>${canAdd.map((i) => html`<option value=${i.id}>${i.name}</option>`)}</select>` : null}
      <${Field} label="Ghi chú"><input id="tf-note" value=${note} onInput=${(e) => setNote(e.target.value)} /><//>
      <div class="row end"><button onClick=${onClose}>Thôi</button>
        <button class="primary" disabled=${!lines.length} onClick=${async () => {
          const body = { to_store_id: store.id, note, lines: lines.filter((l) => Number(String(l.qty).replace(',', '.')) > 0).map((l) => ({ ingredient_id: l.ingredient_id, qty: String(l.qty).replace(',', '.') })) };
          if (await act(() => api('POST', '/api/stock/transfers', body), 'Đã gửi phiếu lĩnh cho kho tổng')) onClose();
        }}>Gửi phiếu lĩnh</button></div>
    </div>
  <//>`;
}

// Tạo nguyên liệu mới ngay khi kiểm kho (vd phát hiện hàng chưa có mã): vào kho đang kiểm
function NewIng({ store, onAdded }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', unit: 'g' });
  if (!open) return html`<button class="link small" style="align-self:flex-start" onClick=${() => setOpen(true)}>➕ Tạo nguyên liệu mới</button>`;
  const save = async () => {
    const r = await act(() => api('POST', '/api/stock/ingredients', { name: f.name, unit: f.unit, home_store_id: store.kind === 'area' ? store.id : null }), `Đã tạo ${f.name}`);
    if (r) { onAdded({ ingredient_id: r.id, name: f.name.trim(), unit: f.unit }); setF({ name: '', unit: f.unit }); setOpen(false); }
  };
  return html`<div class="row wrap"><input class="grow" placeholder="Tên nguyên liệu (vd Tương ớt)" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} />
    <select class="auto" value=${f.unit} onChange=${(e) => setF({ ...f, unit: e.target.value })}>${['g', 'ml', 'cái', 'gói', 'chai', 'hộp', 'kg', 'lít', 'ổ', 'vắt'].map((u) => html`<option value=${u}>${u}</option>`)}</select>
    <button class="primary" disabled=${!f.name.trim()} onClick=${save}>Tạo</button><button onClick=${() => setOpen(false)}>Thôi</button></div>`;
}

// Báo cáo hao hụt (chủ quán 28/10): theo Thành phẩm / Vật liệu / Đồ dùng, so định mức (mặc định 2%)
function LossReport({ me }) {
  const y = addDays(me.today, -1);
  const [range, setRange] = useState({ from: y, to: y, k: 'y' });
  const d = useData(`/api/stock/loss?from=${range.from}&to=${range.to}`);
  const pick = (k) => setRange(k === 'y' ? { from: y, to: y, k } : k === 't' ? { from: me.today, to: me.today, k } : k === 'w' ? { from: addDays(me.today, -7), to: y, k } : { from: `${me.today.slice(0, 7)}-01`, to: me.today, k });
  const ddmm = (x) => `${x.slice(8)}/${x.slice(5, 7)}`;
  const KIND = [['finished', '🥤 Thành phẩm', 'định mức 0: thiếu là mất'], ['material', '🥩 Vật liệu', ''], ['supply', '🔥 Tiêu hao', 'phần hụt khi kiểm = đã dùng']];
  return html`<div class="stack">
    <div class="chips">${[['y', 'Hôm qua'], ['t', 'Hôm nay'], ['w', '7 ngày'], ['m', 'Tháng này']].map(([k, l]) => html`<button class=${`chip ${range.k === k ? 'on' : ''}`} onClick=${() => pick(k)}>${l}</button>`)}</div>
    ${!d.data ? html`<${Loading} state=${d} />` : html`
      <small class="muted">${ddmm(d.data.from)}${d.data.from !== d.data.to ? ` – ${ddmm(d.data.to)}` : ''} · Chuẩn = số bán × định lượng · Hụt = thiếu khi kiểm kho · Vật liệu định mức mặc định <b>${d.data.loss_default}%</b> (sửa riêng ở Kiểm kho → ⚙ Xếp loại hàng)
        ${d.data.sapo_days.length ? '' : html`<br /><b class="warn-text">Chưa úp file Sapo cho ngày này: số "chuẩn" chưa đủ, % sẽ sai.</b>`}</small>
      <div class="row wrap">${KIND.map(([k, l]) => html`<span class="pill ${d.data.total[k] ? 'bad' : 'ok'}">${l}: ${money(d.data.total[k])}</span>`)}</div>
      ${KIND.map(([k, l, hint]) => { const rows = d.data.rows.filter((x) => x.kind === k); return rows.length ? html`<section class="card stack tight"><b>${l} <small class="muted">${hint}</small></b>
        <div class="table-wrap"><table class="list small"><thead><tr><th>Hàng</th>${k !== 'supply' ? html`<th class="r">Chuẩn</th>` : null}<th class="r">${k === 'supply' ? 'Đã dùng' : 'Hụt'}</th>${k === 'material' ? html`<th class="r">%</th>` : null}<th class="r">Tiền</th></tr></thead><tbody>
          ${rows.map((x) => html`<tr class=${x.over ? 'loss-over' : ''}><td>${x.over ? '🔴 ' : ''}${x.name}${!x.counted ? html` <small class="muted">(chưa kiểm)</small>` : ''}</td>
            ${k !== 'supply' ? html`<td class="r">${qty(x.std, x.unit)}</td>` : null}
            <td class="r">${x.counted ? (x.loss < 0 ? html`<span class="ok-text">thừa ${qty(-x.loss, x.unit)}</span>` : qty(x.loss, x.unit)) : '—'}</td>
            ${k === 'material' ? html`<td class="r">${x.pct != null && x.counted ? html`<b class=${x.over ? 'bad-text' : ''}>${x.pct}%</b><small class="muted">/${x.limit}%</small>` : '—'}</td>` : null}
            <td class="r">${x.counted && x.cost ? money(x.cost) : '—'}</td></tr>`)}
        </tbody></table></div></section>` : null; })}
      ${!d.data.rows.length ? html`<div class="empty">Chưa có số bán hoặc kiểm kho trong khoảng này.</div>` : null}`}
  </div>`;
}

// Xếp loại hàng: Thành phẩm / Vật liệu / Đồ dùng + định mức hao hụt riêng (chủ quán 28/10)
const KIND_ICON = { finished: '🥤', material: '🥩', supply: '🔥' };
const GROUP_ICON = { topping: '🍲', bep: '🥩', bar: '🍹', tieuhao: '🔥' };
// Chọn nhân sự kiểm từng khung (chủ quán 28/10)
function GroupStaff({ meta, g, onClose }) {
  const st = useData('/api/staff');
  const [sel, setSel] = useState(meta.group_staff?.[g] || []);
  const [q, setQ] = useState('');
  if (!st.data) return html`<${Modal} title="Chọn người kiểm" onClose=${onClose}><${Loading} state=${st} /><//>`;
  const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  const list = st.data.filter((x) => x.active && x.role !== 'owner' && (!q || fold(x.name).includes(fold(q)))).sort((a, b) => (sel.includes(b.id) ? 1 : 0) - (sel.includes(a.id) ? 1 : 0) || (a.team_name || '').localeCompare(b.team_name || '', 'vi') || a.name.localeCompare(b.name, 'vi'));
  return html`<${Modal} title=${`Người kiểm khung ${GROUP_ICON[g]} ${meta.groups[g]}`} onClose=${onClose}><div class="stack">
    <small class="muted">Người được chọn thấy khung này ở Kiểm kho, kiểm được dù không phải tổ trưởng, và được nhắc lúc 22:30 nếu chưa kiểm.</small>
    <input placeholder="🔍 Tìm tên" value=${q} onInput=${(e) => setQ(e.target.value)} />
    <div class="sapo-list">${list.map((x) => html`<label class="check-row"><input type="checkbox" checked=${sel.includes(x.id)} onChange=${(e) => setSel(e.target.checked ? [...sel, x.id] : sel.filter((y) => y !== x.id))} /> <span>${x.name} <small class="muted">${x.team_name || ''}</small></span></label>`)}</div>
    <button class="primary" onClick=${async () => { if (await act(() => api('PUT', '/api/stock/count-groups/staff', { group: g, staff_ids: sel }), 'Đã lưu người kiểm')) onClose(); }}>Lưu (${sel.length} người)</button>
  </div><//>`;
}
function KindSetup({ meta, onClose }) {
  const [q, setQ] = useState('');
  const list = (meta.ingredients || []).filter((i) => i.active !== false && i.active !== 0 && (!q || i.name.toLowerCase().includes(q.toLowerCase())));
  const save = (i, body) => act(() => api('PUT', `/api/stock/ingredients/${i.id}/kind`, body));
  return html`<${Modal} title="⚙ Xếp loại hàng" onClose=${onClose}><div class="stack">
    <small class="muted">🥤 <b>Thành phẩm</b>: mua về bán nguyên (bia, nước ngọt), lệch là mất. 🥩 <b>Vật liệu</b>: chế biến món theo định lượng (cả ly, ống hút có trong định lượng), hao hụt cho phép <b>${meta.loss_default}%</b>. 🔥 <b>Tiêu hao</b>: dùng hết đi, không nằm trong định lượng (ga, khăn giấy, túi…). Cột cuối = <b>khung kiểm</b> mỗi tối (Topping / Bếp / Bar & pha chế / Tiêu hao). "tự xếp" = app đoán, bấm để sửa.</small>
    <input placeholder="🔍 Tìm hàng" value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${['finished', 'material', 'supply'].map((k) => { const rows = list.filter((i) => i.kind_eff === k); return rows.length ? html`<b>${KIND_ICON[k]} ${meta.kinds[k]} (${rows.length})</b>
      <div class="sapo-list">${rows.map((i) => html`<div class="sapo-row"><span class="grow">${i.name} <small class="muted">${i.unit}${i.kind_auto ? ' · tự xếp' : ''}</small></span>
        ${k === 'material' ? html`<${SaveInput} class="num-in" style="width:4.5em" inputmode="decimal" placeholder=${`${meta.loss_default}%`} value=${i.loss_pct ?? ''} title="Định mức hao hụt riêng (%)" onSave=${(val) => save(i, { loss_pct: val })} />` : null}
        <select value=${i.kind || ''} onChange=${(e) => save(i, { kind: e.target.value })}><option value="">Tự xếp (${meta.kinds[i.kind_eff]})</option><option value="finished">🥤 Thành phẩm</option><option value="material">🥩 Vật liệu</option><option value="supply">🔥 Tiêu hao</option></select>
        ${meta.groups ? html`<select value=${i.count_group || ''} title="Khung kiểm" onChange=${(e) => save(i, { count_group: e.target.value })}><option value="">Tự xếp (${GROUP_ICON[i.group_eff]} ${meta.groups[i.group_eff]})</option>${Object.entries(meta.groups).map(([k, l]) => html`<option value=${k}>${GROUP_ICON[k]} ${l}</option>`)}</select>` : null}</div>`)}</div>` : null; })}
  </div><//>`;
}

function Count({ meta, me }) {
  const mine = meta.stores.filter((s) => s.can_count && (!meta.single || s.kind === 'main'));
  const [storeId, setStoreId] = useState(mine.find((s) => s.kind === 'area')?.id || mine[0]?.id || '');
  const sheet = useData(storeId ? `/api/stock/count-sheet?store=${storeId}` : null);
  const [vals, setVals] = useState({});
  const [extra, setExtra] = useState([]);
  const [result, setResult] = useState(null);
  const [transfer, setTransfer] = useState(null);
  const groupKeys = Object.keys(meta.groups || {});
  const visGroups = atLeast(me, 'team_lead') || !meta.my_groups?.length ? groupKeys : meta.my_groups;
  const [kindTab, setKindTab] = useState(visGroups[0] || 'bep');
  const [pickG, setPickG] = useState(null);
  const [setup, setSetup] = useState(false);
  useEffect(() => { setVals({}); setExtra([]); setResult(null); }, [storeId]);
  if (!mine.length) return html`<div class="empty">Bạn chưa được giao kiểm kho nào. Nhân viên kiểm kho của tổ mình; trưởng ca trở lên kiểm mọi kho.</div>`;
  const store = meta.stores.find((s) => s.id === Number(storeId));
  const allLines = sheet.data ? [...sheet.data.lines, ...extra.filter((x) => !sheet.data.lines.some((l) => l.ingredient_id === x.ingredient_id)).map((x) => ({ ...x, expected: 0 }))] : [];
  // Kho chung: kiểm theo loại hàng · mỗi tối Thành phẩm + Vật liệu, mỗi tuần Đồ dùng
  // Kho chung: kiểm mỗi tối theo 4 khung Topping / Bếp / Bar & pha chế / Tiêu hao (chủ quán 28/10)
  const lines = meta.single ? allLines.filter((l) => (l.group || 'bep') === kindTab).sort((a, b) => a.name.localeCompare(b.name, 'vi')) : allLines;
  const nm = (id) => meta.staff_names?.[id];
  const filled = Object.values(vals).filter((x) => x !== '').length;
  return html`<div class="stack">
    ${meta.single ? html`<div class="row wrap"><div class="tabs scroll">${visGroups.map((k) => html`<button class=${kindTab === k ? 'on' : ''} onClick=${() => setKindTab(k)}>${GROUP_ICON[k]} ${meta.groups[k]}</button>`)}</div>
      ${atLeast(me, 'manager') ? html`<button class="small" onClick=${() => setSetup(true)}>⚙ Xếp loại hàng</button>` : null}</div>
      <div class="row wrap tight"><small class="muted">👤 Người kiểm khung ${meta.groups[kindTab]}: <b>${(meta.group_staff?.[kindTab] || []).map((id) => nm(id) || `#${id}`).join(', ') || 'chưa chọn (tổ trưởng / trưởng ca kiểm)'}</b></small>
        ${atLeast(me, 'manager') ? html`<button class="link small" onClick=${() => setPickG(kindTab)}>✎ Chọn người</button>` : null}</div>` : null}
    ${pickG ? html`<${GroupStaff} meta=${meta} g=${pickG} onClose=${() => setPickG(null)} />` : null}
    ${setup ? html`<${KindSetup} meta=${meta} onClose=${() => setSetup(false)} />` : null}
    <div class="row wrap">
      ${mine.length > 1 ? html`<select id="ck-store" class="auto" value=${storeId} onChange=${(e) => setStoreId(Number(e.target.value))}>${mine.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select>` : null}
      ${sheet.data?.last_count ? html`<span class="muted small">Lần kiểm trước: ${dt(sheet.data.last_count.at)} · ${sheet.data.last_count.staff_name || ''}</span>` : null}
    </div>
    ${meta.single ? html`<p class="muted small">Mỗi tối đếm số <b>còn lại thực tế</b> rồi nhập vào ô "còn". Riêng 🥬 <b>rau củ</b>: app tính luôn <b>đã dùng trong ngày = đầu ngày + nhập − còn</b>.</p>` : store?.kind === 'area' ? html`<p class="muted small">Cuối ca đếm số <b>còn lại thực tế</b>. Phần chênh lệch so với sổ được tính là lượng đã dùng trong ngày, dùng để gợi ý lĩnh và đặt hàng.</p>`
      : html`<p class="muted small">Kiểm kho tổng: phần thiếu so với sổ được ghi là hao hụt.</p>`}
    ${!sheet.data ? html`<${Loading} state=${sheet} />` : html`<section class="card">
      ${lines.length ? lines.map((l) => html`<div class="line-in" key=${l.ingredient_id}>
        <span class="grow"><b>${l.veg ? '🥬 ' : ''}${l.name}</b><br /><small class="muted">${l.veg && l.day_open != null ? `Đầu ngày ${qty(l.day_open, l.unit)} · ` : ''}${l.veg && l.day_in ? `nhập +${qty(l.day_in, l.unit)} · ` : ''}sổ ${qty(l.expected, l.unit)}</small>
          ${l.veg && vals[l.ingredient_id] !== undefined && vals[l.ingredient_id] !== '' ? (() => { const a = Number(String(vals[l.ingredient_id]).replace(',', '.')); if (!Number.isFinite(a)) return null; const base = l.day_open != null ? l.day_open + (l.day_in || 0) : l.expected; const used = Math.round((base - a) * 1000) / 1000; return html`<br /><small class=${used < 0 ? 'warn-text' : 'ok-text'}>→ ${used >= 0 ? `dùng trong ngày ${qty(used, l.unit)}` : `thừa ${qty(-used, l.unit)} so với đầu ngày + nhập`}</small>`; })() : null}</span>
        <input inputmode="decimal" class="num-in" placeholder="còn" value=${vals[l.ingredient_id] ?? ''} aria-label=${`Còn thực tế ${l.name}`}
          onInput=${(e) => setVals({ ...vals, [l.ingredient_id]: e.target.value })} /><span class="muted unit-l">${l.unit}</span>
      </div>`) : html`<p class="muted">${meta.single ? 'Chưa có hàng loại này. Chủ quán / quản lý bấm ⚙ Xếp loại hàng để chọn.' : 'Kho này chưa có nguyên liệu nào.'}</p>`}
      ${(() => {
        // Thêm nguyên liệu chưa có trong phiếu: dùng chung trước, rồi mọi nguyên liệu khác (chủ quán 27/10)
        // rà soát 28/10: "đã có" tính trên cả phiếu (mọi khung), hàng thêm vào khung đang mở; người kiểm khung chỉ thêm hàng thuộc khung mình
        const have = new Set(allLines.map((l) => l.ingredient_id));
        const onlyMine = meta.single && !atLeast(me, 'team_lead') && meta.my_groups?.length ? new Set(meta.my_groups) : null;
        const gOf = (id) => (meta.ingredients || []).find((i) => i.id === id)?.group_eff;
        const okG = (id) => !onlyMine || onlyMine.has(gOf(id));
        const shared = sheet.data.shared.filter((x) => !have.has(x.ingredient_id) && okG(x.ingredient_id));
        const others = (meta.ingredients || []).filter((i) => i.active !== false && i.active !== 0 && !have.has(i.id) && okG(i.id) && !shared.some((x) => x.ingredient_id === i.id)).map((i) => ({ ingredient_id: i.id, name: i.name, unit: i.unit }));
        const add = (id) => { const it = [...shared, ...others].find((x) => x.ingredient_id === id); if (it) setExtra([...extra, meta.single ? { ...it, group: kindTab } : it]); };
        return shared.length || others.length ? html`<div class="row"><select id="ck-add" class="auto" onChange=${(e) => { add(Number(e.target.value)); e.target.value = ''; }}>
          <option value="">+ Thêm nguyên liệu khác vào phiếu kiểm</option>
          ${shared.length ? html`<optgroup label="Dùng chung (đá, chanh…)">${shared.map((x) => html`<option value=${x.ingredient_id}>${x.name}</option>`)}</optgroup>` : null}
          ${others.length ? html`<optgroup label="Nguyên liệu khác">${others.sort((a, b) => a.name.localeCompare(b.name, 'vi')).map((x) => html`<option value=${x.ingredient_id}>${x.name} (${x.unit})</option>`)}</optgroup>` : null}
        </select></div>` : null; })()}
      ${atLeast(me, 'manager') && store ? html`<${NewIng} store=${store} onAdded=${(it) => setExtra([...extra, meta.single ? { ...it, group: kindTab } : it])} />` : null}
      <div class="row end"><button class="primary" disabled=${!filled || !store} onClick=${async () => {
        const body = { store_id: store.id, lines: Object.entries(vals).filter(([, x]) => x !== '').map(([id, x]) => ({ ingredient_id: Number(id), actual: String(x).replace(',', '.') })) };
        const r = await act(() => api('POST', '/api/stock/count', body), 'Đã lưu kiểm kho');
        if (r) { setResult(r); setVals({}); }
      }}>Lưu kiểm kho (${filled})</button></div>
    </section>`}
    ${result ? html`<section class="card attn">
      <h3>Kết quả kiểm kho</h3>
      ${result.lines.map((l) => html`<div class="row between small"><span>${l.name}</span><span class=${l.diff < 0 ? '' : 'muted'}>${l.diff < 0 ? (store.kind === 'area' ? 'dùng ' : 'hao hụt ') : l.diff > 0 ? 'thừa ' : 'khớp '}${l.diff ? qty(Math.abs(l.diff), l.unit) : ''}</span></div>`)}
      ${result.suggestion?.length ? html`<h4>Gợi ý lĩnh cho ngày mai</h4>
        ${result.suggestion.map((s) => html`<div class="row between small"><span>${s.name}</span><span class=${s.short ? 'bad-text' : ''}>${qty(s.need, s.unit)}${s.short ? ` (kho tổng chỉ còn ${qty(s.main_stock, s.unit)})` : ''}</span></div>`)}
        ${meta.single ? null : html`<div class="row end"><button class="primary" onClick=${() => setTransfer(result.suggestion)}>Tạo phiếu lĩnh theo gợi ý</button></div>`}`
        : store.kind === 'area' ? html`<p class="muted small">Tồn hiện tại đủ dùng cho ngày mai.</p>` : null}
    </section>` : null}
    ${transfer ? html`<${TransferForm} store=${store} lines=${transfer} onClose=${() => { setTransfer(null); setResult(null); }}
      addOptions=${meta.ingredients.filter((i) => i.active && (i.home_store_id === store.id || i.home_store_id === null))} />` : null}
  </div>`;
}

// ---------- Lĩnh hàng ----------
function QtyEdit({ title, lines, field, okLabel, onSave, onClose, hint }) {
  const [vals, setVals] = useState(Object.fromEntries(lines.map((l) => [l.ingredient_id, l[field] ?? ''])));
  return html`<${Modal} title=${title} onClose=${onClose}>
    <div class="stack">
      ${hint ? html`<p class="muted small">${hint}</p>` : null}
      ${lines.map((l) => html`<div class="line-in"><span class="grow"><b>${l.name}</b><br /><small class="muted">Xin ${qty(l.qty_requested, l.unit)}${field === 'qty_sent' ? html` · <span class=${l.from_stock < l.qty_requested ? 'bad-text' : ''}>kho tổng còn ${qty(l.from_stock, l.unit)}</span>` : ''}${field === 'qty_received' ? ` · đã xuất ${qty(l.qty_sent, l.unit)}` : ''}</small></span>
        <input inputmode="decimal" class="num-in" value=${numIn(vals[l.ingredient_id])} aria-label=${l.name} onInput=${(e) => setVals({ ...vals, [l.ingredient_id]: e.target.value })} /><span class="muted unit-l">${l.unit}</span></div>`)}
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${async () => {
        if (await onSave(Object.entries(vals).map(([id, x]) => ({ ingredient_id: Number(id), qty: String(x).replace(',', '.') })))) onClose();
      }}>${okLabel}</button></div>
    </div>
  <//>`;
}

function Transfers({ me, meta }) {
  const st = useData('/api/stock/transfers');
  const [dlg, setDlg] = useState(null);
  const areas = meta.stores.filter((s) => s.kind === 'area' && s.can_count);
  const [newFor, setNewFor] = useState(null);
  const startNew = async (store) => {
    const r = await act(() => api('GET', `/api/stock/suggest-transfer?store=${store.id}`));
    if (!r) return;
    const lines = r.lines.length ? r.lines : [];
    if (!lines.length) toast('Theo tồn hiện tại khu này đủ dùng cho mai. Vẫn thêm tay được.');
    setNewFor({ store, lines });
  };
  if (!st.data) return html`<${Loading} state=${st} />`;
  return html`<div class="stack">
    ${areas.length ? html`<div class="row wrap">${areas.map((s) => html`<button onClick=${() => startNew(s)}>+ Xin lĩnh cho ${s.name.replace('Kho ', '')}</button>`)}</div>` : null}
    ${st.data.length ? st.data.map((t) => {
      const toStore = meta.stores.find((s) => s.id === t.to_store);
      return html`<section class="card">
        <div class="row between"><b>Phiếu #${t.id} · ${t.to_name}</b><span class=${`pill ${TR[t.status][1]}`}>${TR[t.status][0]}</span></div>
        <div class="muted small">${t.created_by_name || ''} xin lúc ${dt(t.created_at)}${t.sent_by_name ? ` · ${t.sent_by_name} xuất ${dt(t.sent_at)}` : ''}${t.received_by_name ? ` · ${t.received_by_name} nhận ${dt(t.received_at)}` : ''}${t.note ? ` · ${t.note}` : ''}</div>
        ${t.lines.map((l) => html`<div class="row between small"><span>${l.name}</span><span>${qty(l.qty_requested, l.unit)}${l.qty_sent != null && l.qty_sent !== l.qty_requested ? ` → xuất ${qty(l.qty_sent, l.unit)}` : ''}${l.qty_received != null && l.qty_received !== l.qty_sent ? html` → <span class="bad-text">nhận ${qty(l.qty_received, l.unit)}</span>` : ''}</span></div>`)}
        <div class="row end">
          ${t.status === 'requested' && (t.created_by === me.id || meta.is_holder) ? html`<button class="small" onClick=${() => act(() => api('POST', `/api/stock/transfers/${t.id}/cancel`), 'Đã huỷ phiếu')}>Huỷ</button>` : null}
          ${t.status === 'requested' && meta.is_holder ? html`<button class="primary" onClick=${() => setDlg({ t, mode: 'send' })}>Xuất kho</button>` : null}
          ${t.status === 'sent' && toStore?.can_count ? html`<button class="primary" onClick=${() => setDlg({ t, mode: 'receive' })}>Đã nhận hàng</button>` : null}
        </div>
      </section>`;
    }) : html`<div class="empty">Chưa có phiếu lĩnh nào. Kiểm kho cuối ca rồi bấm "Tạo phiếu lĩnh theo gợi ý".</div>`}
    ${dlg?.mode === 'send' ? html`<${QtyEdit} title=${`Xuất kho tổng · phiếu #${dlg.t.id}`} lines=${dlg.t.lines.map((l) => ({ ...l, qty_sent: Math.min(l.qty_requested, Math.max(0, l.from_stock)) }))} field="qty_sent" okLabel="Xác nhận xuất"
      hint="Sửa nếu kho tổng xuất ít hơn số xin. Hàng xuất theo lô hết hạn trước." onClose=${() => setDlg(null)}
      onSave=${(lines) => act(() => api('POST', `/api/stock/transfers/${dlg.t.id}/send`, { lines }), 'Đã xuất kho')} />` : null}
    ${dlg?.mode === 'receive' ? html`<${QtyEdit} title=${`Nhận hàng · phiếu #${dlg.t.id}`} lines=${dlg.t.lines.map((l) => ({ ...l, qty_received: l.qty_sent }))} field="qty_received" okLabel="Xác nhận đã nhận"
      hint="Đếm lại khi nhận. Nhận thiếu thì sửa số, phần thiếu được ghi hao hụt và báo kho tổng." onClose=${() => setDlg(null)}
      onSave=${(lines) => act(() => api('POST', `/api/stock/transfers/${dlg.t.id}/receive`, { lines }), 'Đã nhận hàng vào khu')} />` : null}
    ${newFor ? html`<${TransferForm} store=${newFor.store} lines=${newFor.lines} onClose=${() => setNewFor(null)}
      addOptions=${meta.ingredients.filter((i) => i.active && (i.home_store_id === newFor.store.id || i.home_store_id === null))} />` : null}
  </div>`;
}

// ---------- Đặt hàng ----------
function PoCard({ me, meta, po }) {
  const [edit, setEdit] = useState(null);
  const [recv, setRecv] = useState(null);
  const [ask, setAsk] = useState(false);
  const isManager = atLeast(me, 'manager');
  const lead = atLeast(me, 'shift_lead') || (me.role === 'team_lead' && po.lead_store_ids.some((id) => meta.stores.find((s) => s.id === id)?.team_id === me.team?.id));
  const copy = () => navigator.clipboard?.writeText(po.text).then(() => toast('Đã chép nội dung đơn, dán vào nhóm Zalo "Mua đồ"')).catch(() => toast('Không chép được, hãy chọn và sao chép nội dung bên dưới', true));
  return html`<section class="card">
    <div class="row between"><b>Đơn #${po.id} · ${po.supplier_name || 'Chưa chọn NCC'}</b><span class=${`pill ${PO[po.status][1]}`}>${PO[po.status][0]}</span></div>
    <div class="muted small">Giao ${po.deliver_on ? dayLabel(po.deliver_on) : '—'} tới ${po.store_name} · khoảng <b>${money(po.total)}</b>${po.supplier_phone ? ` · NCC: ${po.supplier_phone}` : ''}</div>
    ${edit ? html`<div class="stack">
        ${edit.map((l, i) => html`<div class="line-in"><span class="grow"><b>${l.name}</b><br /><small class="muted">Gợi ý ${l.suggested} ${l.purchase_unit} · ${money(l.price)}/${l.purchase_unit}</small></span>
          <input inputmode="decimal" class="num-in" value=${numIn(l.qty)} aria-label=${l.name} onInput=${(e) => setEdit(edit.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /><span class="muted unit-l">${l.purchase_unit}</span></div>`)}
        <div class="row end"><button onClick=${() => setEdit(null)}>Thôi</button><button class="primary" onClick=${async () => {
          if (await act(() => api('PATCH', `/api/stock/po/${po.id}`, { lines: edit.map((l) => ({ ingredient_id: l.ingredient_id, qty: String(l.qty || 0).replace(',', '.') })) }), 'Đã lưu đơn')) setEdit(null);
        }}>Lưu</button></div></div>`
      : po.lines.map((l) => html`<div class="row between small"><span>${l.name}</span><span>${l.qty} ${l.purchase_unit}${l.qty_received != null ? ` · nhận ${l.qty_received}` : ''}${l.suggested && l.suggested !== l.qty ? html` <small class="muted">(gợi ý ${l.suggested})</small>` : ''}</span></div>`)}
    ${po.status === 'approved' ? html`<pre class="po-text">${po.text}</pre>` : null}
    ${po.note && po.status !== 'approved' ? html`<div class="small">Ghi chú: ${po.note}</div>` : null}
    <div class="row end wrap">
      ${po.status === 'draft' && lead && !edit ? html`<button onClick=${() => setEdit(po.lines.map((l) => ({ ...l })))}>Sửa số lượng</button>
        <button class="small" onClick=${() => setAsk(true)}>Huỷ</button>
        <button class="primary" onClick=${() => act(() => api('POST', `/api/stock/po/${po.id}/submit`), 'Đã gửi quản lý duyệt')}>Gửi duyệt</button>` : null}
      ${['draft', 'submitted'].includes(po.status) && isManager && !edit ? html`${po.status === 'submitted' ? html`<button onClick=${() => act(() => api('POST', `/api/stock/po/${po.id}/reject`, { note: 'Cần sửa lại' }), 'Đã trả lại đơn')}>Trả lại</button>` : null}
        <button class="primary" onClick=${() => act(() => api('POST', `/api/stock/po/${po.id}/approve`), 'Đã duyệt. Chép nội dung gửi nhóm Zalo')}>Duyệt</button>` : null}
      ${po.status === 'approved' ? html`<button onClick=${copy}>Chép nội dung gửi Zalo</button>
        ${meta.is_holder ? html`<button class="primary" onClick=${() => setRecv(po.lines.map((l) => ({ ...l, qty_in: l.qty, price_in: l.price, exp: '' })))}>Nhận hàng</button>` : null}` : null}
    </div>
    ${recv ? html`<${Modal} title=${`Nhận hàng · đơn #${po.id}`} onClose=${() => setRecv(null)}>
      <div class="stack">
        <p class="muted small">Đếm, cân thực tế khi hàng về. Hạn dùng để trống thì app tự tính theo số ngày dùng được của nguyên liệu.</p>
        ${recv.map((l, i) => html`<div class="recv-line">
          <b>${l.name}</b>
          <div class="row">
            <label class="field"><span>Số nhận (${l.purchase_unit})</span><input inputmode="decimal" value=${numIn(l.qty_in)} onInput=${(e) => setRecv(recv.map((x, j) => (j === i ? { ...x, qty_in: e.target.value } : x)))} /></label>
            <label class="field"><span>Giá / ${l.purchase_unit}</span><input inputmode="numeric" value=${numIn(l.price_in)} onInput=${(e) => setRecv(recv.map((x, j) => (j === i ? { ...x, price_in: e.target.value } : x)))} /></label>
            <label class="field"><span>Hạn dùng</span><input type="date" value=${l.exp} onInput=${(e) => setRecv(recv.map((x, j) => (j === i ? { ...x, exp: e.target.value } : x)))} /></label>
          </div></div>`)}
        <div class="row end"><button onClick=${() => setRecv(null)}>Thôi</button><button class="primary" onClick=${async () => {
          const lines = recv.map((l) => ({ ingredient_id: l.ingredient_id, qty: String(l.qty_in || 0).replace(',', '.'), price: l.price_in === '' ? undefined : Number(l.price_in), expires_on: l.exp || undefined }));
          if (await act(() => api('POST', `/api/stock/po/${po.id}/receive`, { lines }), 'Đã nhập hàng vào kho')) setRecv(null);
        }}>Nhập kho</button></div>
      </div>
    <//>` : null}
    ${ask ? html`<${Confirm} text=${`Huỷ đơn #${po.id}?`} danger yes="Huỷ đơn" onClose=${() => setAsk(false)} onYes=${() => act(() => api('POST', `/api/stock/po/${po.id}/cancel`), 'Đã huỷ đơn')} />` : null}
  </section>`;
}

function Orders({ me, meta }) {
  const st = useData('/api/stock/po');
  const [loose, setLoose] = useState(false);
  if (!st.data) return html`<${Loading} state=${st} />`;
  return html`<div class="stack">
    <div class="row wrap">
      ${atLeast(me, 'team_lead') ? html`<button class="primary" onClick=${() => act(() => api('POST', '/api/stock/po/generate'), 'Đã tạo đề xuất từ tồn kho và tốc độ dùng')}>Tạo đề xuất đặt hàng</button>` : null}
      ${meta.is_holder ? html`<button onClick=${() => setLoose(true)}>Nhập kho lẻ</button>` : null}
    </div>
    <p class="muted small">Quy trình: tạo đề xuất (app tự tính từ tồn và tốc độ dùng, mỗi NCC một đơn) → tổ trưởng sửa → <b>Gửi duyệt</b> → quản lý <b>Duyệt</b> → chép nội dung gửi nhóm Zalo "Mua đồ" → hàng về bấm <b>Nhận hàng</b>.
      <br />Đồ tươi: đặt đủ dùng ngày mai. Đồ mát, đồ khô/đông: chỉ đặt khi tồn chạm điểm đặt hàng, và đặt đủ dùng một chu kỳ.</p>
    ${st.data.length ? st.data.map((po) => html`<${PoCard} key=${po.id} me=${me} meta=${meta} po=${po} />`) : html`<div class="empty">Chưa có đơn đặt hàng.</div>`}
    ${loose ? html`<${LooseReceive} meta=${meta} onClose=${() => setLoose(false)} />` : null}
  </div>`;
}

function LooseReceive({ meta, onClose }) {
  const [lines, setLines] = useState([]);
  const [store, setStore] = useState(meta.stores.find((s) => s.kind === 'main')?.id);
  const ings = meta.ingredients.filter((i) => i.active);
  return html`<${Modal} title="Nhập kho lẻ (mua ngoài)" onClose=${onClose}>
    <div class="stack">
      <${Field} label="Nhập vào"><select id="lr-store" value=${store} onChange=${(e) => setStore(Number(e.target.value))}>${meta.stores.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
      ${lines.map((l, i) => {
        const ing = ings.find((x) => x.id === l.ingredient_id);
        return html`<div class="line-in"><span class="grow"><b>${ing.name}</b></span>
          <input inputmode="decimal" class="num-in" placeholder="SL" value=${l.qty} onInput=${(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /><span class="muted unit-l">${ing.purchase_unit}</span>
          <input inputmode="numeric" class="num-in" placeholder="giá" value=${l.price} onInput=${(e) => setLines(lines.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} /></div>`;
      })}
      <select id="lr-add" onChange=${(e) => { const id = Number(e.target.value); if (id) setLines([...lines, { ingredient_id: id, qty: '', price: '' }]); e.target.value = ''; }}>
        <option value="">+ Thêm nguyên liệu</option>${ings.filter((i) => !lines.some((l) => l.ingredient_id === i.id)).map((i) => html`<option value=${i.id}>${i.name}</option>`)}</select>
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" disabled=${!lines.length} onClick=${async () => {
        const body = { store_id: store, lines: lines.map((l) => ({ ingredient_id: l.ingredient_id, qty: String(l.qty || 0).replace(',', '.'), price: l.price === '' ? undefined : Number(l.price) })) };
        if (await act(() => api('POST', '/api/stock/receive', body), 'Đã nhập kho')) onClose();
      }}>Nhập kho</button></div>
    </div>
  <//>`;
}

// ---------- Nguyên liệu & NCC ----------
function IngForm({ init, meta, onClose }) {
  const [f, setF] = useState({
    name: '', unit: 'g', freshness: 'fresh', home_store_id: '', supplier_id: '', purchase_unit: 'kg', purchase_factor: 1000, order_step: 0.5,
    price: 0, min_stock: 0, shelf_days: 0, lead_days: 1, cycle_days: 1, safety_pct: 10, active: true, ...init,
  });
  const set = (k, v) => setF({ ...f, [k]: v });
  const inp = (k, label, props = {}, hint) => html`<${Field} label=${label} hint=${hint}><input id=${`ig-${k}`} value=${numIn(f[k])} onInput=${(e) => set(k, e.target.value)} ...${props} /><//>`;
  const save = async () => {
    const body = { ...f, home_store_id: f.home_store_id || null, supplier_id: f.supplier_id || null };
    if (await act(() => (init.id ? api('PATCH', `/api/stock/ingredients/${init.id}`, body) : api('POST', '/api/stock/ingredients', body)), 'Đã lưu nguyên liệu')) onClose();
  };
  return html`<${Modal} title=${init.id ? `Sửa: ${init.name}` : 'Thêm nguyên liệu'} onClose=${onClose} wide>
    <div class="form-grid">
      ${inp('name', 'Tên nguyên liệu', { placeholder: 'vd Bò bắp' })}
      <${Field} label="Nhóm hàng"><select id="ig-fresh" value=${f.freshness} onChange=${(e) => set('freshness', e.target.value)}>
        <option value="fresh">Đồ tươi (đặt hằng ngày)</option><option value="chilled">Đồ mát (trữ vài ngày)</option><option value="dry">Đồ khô/đông (trữ lâu)</option></select><//>
      <${Field} label="Khu chính" hint="Kho chung = để ở kho tổng, khu nào cần thì lĩnh"><select id="ig-home" value=${f.home_store_id ?? ''} onChange=${(e) => set('home_store_id', e.target.value)}>
        <option value="">Kho chung</option>${meta.stores.filter((s) => s.kind === 'area').map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
      <${Field} label="Nhà cung cấp" hint="Để trống = NCC của khu chính"><select id="ig-sup" value=${f.supplier_id ?? ''} onChange=${(e) => set('supplier_id', e.target.value)}>
        <option value="">(theo khu chính)</option>${meta.suppliers.filter((s) => s.active).map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select><//>
      ${inp('unit', 'Đơn vị dùng', { placeholder: 'g, ml, quả, lon…' }, 'Đơn vị đếm khi kiểm kho')}
      ${inp('purchase_unit', 'Đơn vị mua', { placeholder: 'kg, thùng…' })}
      ${inp('purchase_factor', `1 ${f.purchase_unit || 'đơn vị mua'} = ? ${f.unit}`, { inputmode: 'decimal' }, 'vd 1 kg = 1000 g, 1 thùng = 24 lon')}
      ${inp('price', `Giá nhập / ${f.purchase_unit || 'đơn vị mua'} (đ)`, { inputmode: 'numeric' })}
      ${inp('min_stock', `Tồn tối thiểu (${f.unit})`, { inputmode: 'decimal' })}
      ${inp('order_step', `Làm tròn khi đặt (${f.purchase_unit})`, { inputmode: 'decimal' }, 'vd 0,5 kg; 1 thùng')}
      ${inp('shelf_days', 'Dùng được bao nhiêu ngày', { inputmode: 'numeric' }, '0 = không theo dõi hạn')}
      ${inp('lead_days', 'NCC giao sau (ngày)', { inputmode: 'numeric' })}
      ${inp('cycle_days', 'Mỗi lần đặt đủ dùng (ngày)', { inputmode: 'numeric' }, 'Dùng cho đồ mát/khô')}
      ${inp('safety_pct', 'Dự phòng (%)', { inputmode: 'numeric' })}
    </div>
    ${init.id ? html`<label class="check-row"><input type="checkbox" checked=${!!f.active} onChange=${(e) => set('active', e.target.checked)} /> Đang dùng</label>` : null}
    <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu</button></div>
  <//>`;
}

function Setup({ meta }) {
  const [edit, setEdit] = useState(null);
  const [sup, setSup] = useState({ name: '', phone: '' });
  return html`<div class="stack">
    <section class="card">
      <h3>Kho & nhà cung cấp của từng khu</h3>
      <p class="muted small">Mỗi khu 1 NCC. Đơn đặt hàng tự tách theo NCC.</p>
      ${meta.stores.map((s) => html`<div class="row team-row">
        <b class="grow">${s.name}</b><small class="muted">${s.kind === 'main' ? 'Kho tổng' : s.team_name || ''}</small>
        ${s.kind === 'area' ? html`<select class="auto" value=${s.supplier_id ?? ''} onChange=${(e) => act(() => api('PATCH', `/api/stock/stores/${s.id}`, { supplier_id: e.target.value || null }), 'Đã gán NCC')}>
          <option value="">(chưa có NCC)</option>${meta.suppliers.filter((x) => x.active).map((x) => html`<option value=${x.id}>${x.name}</option>`)}</select>` : null}
      </div>`)}
      <h4>Nhà cung cấp</h4>
      ${meta.suppliers.map((x) => html`<div class="row team-row"><b class="grow">${x.name}</b><span class="muted small">${x.phone}</span>
        <label class="check-row small"><input type="checkbox" checked=${!!x.active} onChange=${(e) => act(() => api('PATCH', `/api/stock/suppliers/${x.id}`, { active: e.target.checked }), 'Đã lưu')} /> Dùng</label></div>`)}
      <div class="row"><input id="sp-name" class="grow" placeholder="Tên NCC mới" value=${sup.name} onInput=${(e) => setSup({ ...sup, name: e.target.value })} />
        <input id="sp-phone" class="auto" placeholder="SĐT / Zalo" value=${sup.phone} onInput=${(e) => setSup({ ...sup, phone: e.target.value })} />
        <button class="primary" disabled=${!sup.name.trim()} onClick=${async () => { if (await act(() => api('POST', '/api/stock/suppliers', sup), 'Đã thêm NCC')) setSup({ name: '', phone: '' }); }}>Thêm</button></div>
    </section>
    <section class="card">
      <div class="row between"><h3>Nguyên liệu (${meta.ingredients.length})</h3><button class="primary" onClick=${() => setEdit({})}>+ Thêm</button></div>
      ${meta.ingredients.map((i) => html`<button class=${`tpl-row ${i.active ? '' : 'off'}`} onClick=${() => setEdit(i)}>
        <b class="grow">${i.name}</b><span class="muted small">${FRESH[i.freshness]} · ${i.home_name || 'Kho chung'} · ${money(i.price)}/${i.purchase_unit}</span></button>`)}
    </section>
    ${edit ? html`<${IngForm} init=${edit} meta=${meta} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}

// ---------- Lịch sử ----------
// Nhập – Xuất – Tồn chung cả quán: Đồ tươi / Đồ bình thường; dòng lệch quá ngưỡng tô đỏ, xếp lên đầu
const KIND_NXT = { nhap: 'Nhập', ban: 'Bán (định lượng)', xuat: 'Xuất dùng', huy: 'Huỷ / hao hụt', lech: 'Lệch khi cân' };
const qtyU = (q, unit) => (q == null ? '' : unit === 'g' && Math.abs(q) >= 1000 ? `${(q / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} kg` : unit === 'ml' && Math.abs(q) >= 1000 ? `${(q / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} l` : `${Number(q).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} ${unit}`);
function Nxt() {
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: today, to: today });
  const [open, setOpen] = useState(null);
  const d = useData(`/api/stock/nxt?from=${range.from}&to=${range.to}`);
  const det = useData(open ? `/api/stock/nxt/${open.id}?from=${range.from}&to=${range.to}` : null);
  const preset = [['Hôm nay', today, today], ['Hôm qua', addDays(today, -1), addDays(today, -1)], ['7 ngày', addDays(today, -6), today], ['Tháng này', `${today.slice(0, 8)}01`, today]];
  return html`<div class="stack">
    <div class="chips">${preset.map(([l, f, t]) => html`<button class=${`chip ${range.from === f && range.to === t ? 'on' : ''}`} onClick=${() => setRange({ from: f, to: t })}>${l}</button>`)}</div>
    <div class="row wrap"><label>Từ <input type="date" value=${range.from} onInput=${(e) => setRange({ ...range, from: e.target.value })} /></label>
      <label>đến <input type="date" value=${range.to} onInput=${(e) => setRange({ ...range, to: e.target.value })} /></label>
      <a class="btn small" href=${`/api/stock/nxt.xlsx?from=${range.from}&to=${range.to}`} download>⬇ Excel</a></div>
    <p class="small muted">Tồn đầu + Nhập − Bán theo định lượng − Xuất dùng − Huỷ ± Lệch = Tồn cuối. <b>Lệch</b> = cân thực tế − sổ (âm là thiếu). Đỏ = lệch quá ${d.data?.tolerance ?? 3}% so với lượng dùng.</p>
    ${!d.data ? html`<${Loading} state=${d} />` : d.data.groups.map((g) => html`<section class="card stack">
      <div class="row between wrap"><b>${g.name}</b><span class="small">Lệch: <b class=${g.total.lech_tien < 0 ? 'warn-text' : ''}>${money(g.total.lech_tien)}</b> · Tồn: ${money(g.total.gia_tri_cuoi)}${g.total.over ? html` · <span class="pill bad">${g.total.over} dòng lệch nhiều</span>` : null}</span></div>
      ${g.rows.length ? html`<div class="table-wrap"><table class="list small nxt"><thead><tr><th>Hàng</th><th class="r">Đầu</th><th class="r">Nhập</th><th class="r">Bán</th><th class="r">Xuất</th><th class="r">Huỷ</th><th class="r">Sổ</th><th class="r">Thực tế</th><th class="r">Lệch</th></tr></thead>
        <tbody>${g.rows.map((r) => html`<tr class=${r.over ? 'bad-row' : ''} onClick=${() => setOpen(r)}><td><b>${r.name}</b>${r.recipe ? '' : html` <small class="muted">· trừ khi xuất</small>`}</td>
          <td class="r">${qtyU(r.dau, r.unit)}</td><td class="r">${r.nhap ? qtyU(r.nhap, r.unit) : ''}</td><td class="r">${r.ban ? qtyU(r.ban, r.unit) : ''}</td><td class="r">${r.xuat ? qtyU(r.xuat, r.unit) : ''}</td><td class="r">${r.huy ? qtyU(r.huy, r.unit) : ''}</td>
          <td class="r">${qtyU(r.so, r.unit)}</td><td class="r"><b>${qtyU(r.cuoi, r.unit)}</b></td><td class="r">${r.lech ? html`<b class=${r.lech < 0 ? 'warn-text' : ''}>${qtyU(r.lech, r.unit)}${r.lech_pct != null ? ` (${r.lech_pct}%)` : ''}</b><br /><small>${money(r.lech_tien)}</small>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">Không có phát sinh.</p>`}
    </section>`)}
    ${open ? html`<${Modal} title=${open.name} onClose=${() => setOpen(null)}>${!det.data ? html`<${Loading} state=${det} />` : html`<table class="list small"><tbody>${det.data.map((m) => html`<tr><td>${dt(m.at)}</td><td>${KIND_NXT[m.kind] || 'Chuyển'}</td><td class="r"><b>${qtyU(m.qty, open.unit)}</b></td><td><small>${m.note}${m.staff_name ? ` · ${m.staff_name}` : ''}</small></td></tr>`)}</tbody></table>${!det.data.length ? html`<p class="muted">Không có phát sinh.</p>` : null}`}<//>` : null}
  </div>`;
}

function History({ me }) {
  const [from, setFrom] = useState(addDays(me.today, -7));
  const [to, setTo] = useState(me.today);
  const st = useData(`/api/stock/moves?from=${from}&to=${to}`);
  return html`<div class="stack">
    <div class="row"><input id="h-from" type="date" class="auto" value=${from} onInput=${(e) => e.target.value && setFrom(e.target.value)} /><span>đến</span>
      <input id="h-to" type="date" class="auto" value=${to} onInput=${(e) => e.target.value && setTo(e.target.value)} /></div>
    ${!st.data ? html`<${Loading} state=${st} />` : st.data.length ? html`<div class="table-wrap"><table class="list">
      <thead><tr><th>Lúc</th><th>Loại</th><th>Nguyên liệu</th><th class="r">Số lượng</th><th>Kho</th><th>Ai</th></tr></thead>
      <tbody>${st.data.map((m) => html`<tr><td>${dt(m.at)}</td><td>${MOVE[m.type] || m.type}</td><td>${m.name}${m.note ? html`<br /><small class="muted">${m.note}</small>` : null}</td>
        <td class="r num">${qty(m.qty, m.unit)}${m.cost ? html`<br /><small class="muted">${money(m.cost)}</small>` : null}</td>
        <td><small>${[m.from_name, m.to_name].filter(Boolean).join(' → ')}</small></td><td><small>${m.staff_name || ''}</small></td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">Không có biến động kho trong khoảng này.</div>`}
  </div>`;
}

// Đồ dùng (chén, dĩa, ly, nồi…): báo vỡ / mất bất cứ lúc nào, kiểm mỗi tuần
function Utensils({ me }) {
  const d = useData('/api/utensils/report');
  const [brk, setBrk] = useState(null);
  const [counting, setCounting] = useState(null);
  const [res, setRes] = useState(null);
  const [adding, setAdding] = useState(null);
  const [edit, setEdit] = useState(null);
  if (!d.data) return html`<${Loading} state=${d} />`;
  const { items, moves, last_count_at, due } = d.data;
  const boss = atLeast(me, 'manager');
  const addAll = async () => {
    const r = await act(() => api('POST', '/api/utensils/bulk', { text: adding }));
    if (r) { setAdding(null); toast(`Thêm ${r.added.length} món${r.updated.length ? ` · ghi số ${r.updated.length} món` : ''}${r.kept.length ? ` · ${r.kept.length} món đã có, giữ số cũ` : ''}`); }
  };
  const canCount = atLeast(me, 'team_lead');
  const save = async () => {
    const r = await act(() => api('POST', '/api/utensils/count', { lines: Object.entries(counting).map(([id, actual]) => ({ utensil_id: Number(id), actual })) }), 'Đã lưu kiểm tuần');
    if (r) { setRes(r.lines); setCounting(null); }
  };
  const label = { break: 'Vỡ', lost: 'Mất', count: 'Kiểm tuần' };
  return html`<div class="stack">
    <section class="card stack">
      <div class="row wrap"><b class="grow">Lần kiểm gần nhất: ${last_count_at ? dt(last_count_at) : 'chưa kiểm'}</b>
        ${due ? html`<span class="warn-text small">⚠ Đến hạn kiểm tuần</span>` : null}</div>
      ${canCount && !counting ? html`<button class="primary" onClick=${() => { setRes(null); setCounting({}); }}>📋 Kiểm tuần: đếm đồ dùng</button>` : null}
      <p class="small muted">Vỡ / mất thì bấm "Báo vỡ" ngay ở món đó. Cuối tuần đếm lại: thiếu mà không ai báo thì app ghi "mất không rõ" và báo chủ.</p>
    </section>
    ${boss ? html`<button class="primary big" onClick=${() => setAdding('')}>➕ Thêm đồ dùng</button>` : null}
    ${!items.length ? html`<p class="muted">Chưa có đồ dùng.${boss ? ' Bấm ➕ Thêm đồ dùng.' : ''}</p>` : null}
    ${res ? html`<section class="card stack"><h3>Kết quả kiểm</h3>${res.map((x) => html`<div class="row"><span class="grow">${x.name}</span><span class=${x.diff < 0 ? 'warn-text' : 'muted'}>sổ ${x.expected} → đếm ${x.actual}${x.diff ? ` (${x.diff > 0 ? '+' : ''}${x.diff})` : ' ✓'}</span></div>`)}</section>` : null}
    <section class="card stack">
      ${items.map((u) => html`<div class="row">
        <span class="grow"><b>${u.name}</b> <span class="muted small">sổ: ${u.on_hand} ${u.unit}</span></span>
        ${counting ? html`<input class="num-in" type="number" min="0" inputmode="numeric" placeholder="đếm" value=${counting[u.id] ?? ''} onInput=${(e) => setCounting({ ...counting, [u.id]: e.target.value })} />`
          : html`${boss ? html`<button class="small icon" aria-label="Sửa" onClick=${() => setEdit({ ...u })}>✏️</button>` : null}<button class="small" onClick=${() => setBrk({ u, qty: 1, kind: 'break', who: '', note: '' })}>Báo vỡ / mất</button>`}
      </div>`)}
      ${counting ? html`<div class="row end"><button onClick=${() => setCounting(null)}>Huỷ</button><button class="primary" disabled=${!Object.values(counting).some((x) => x !== '')} onClick=${save}>Lưu kiểm tuần</button></div>` : null}
    </section>
    ${moves.length ? html`<section class="card stack"><h3>4 tuần gần đây</h3>
      ${moves.filter((m) => m.type !== 'count' || m.qty).map((m) => html`<div class="small"><b>${label[m.type] || m.type}</b> ${m.name} ${m.qty > 0 ? '+' : ''}${m.qty} ${m.unit} · ${dt(m.at)} · ${m.staff_name}${m.note ? html`<span class="muted"> · ${m.note}</span>` : null}</div>`)}
    </section>` : null}
    ${adding != null ? html`<${Modal} title="➕ Thêm đồ dùng" onClose=${() => setAdding(null)}>
      <div class="stack">
        <p class="small muted">Mỗi dòng 1 món: <b>tên, số đang có, đơn vị</b>. Dán cả danh sách được.</p>
        <textarea id="ut-bulk" rows="9" placeholder=${'Ly bia 120 cái\nKhay inox 30\nBếp gas mini 100 cái\nKẹp gắp 40 cái\nThớt 6 cái'} value=${adding} onInput=${(e) => setAdding(e.target.value)}></textarea>
        <small class="muted">Món đã có mà sổ đang 0 thì ghi số mới; món đã có số thì giữ nguyên (đổi số bằng Kiểm tuần hoặc ✏️).</small>
        <div class="row end"><button onClick=${() => setAdding(null)}>Thôi</button><button class="primary" disabled=${!adding.trim()} onClick=${addAll}>Thêm ${adding.split('\n').filter((x) => x.trim()).length || ''} món</button></div>
      </div><//>` : null}
    ${edit ? html`<${Modal} title=${`Sửa: ${edit.name}`} onClose=${() => setEdit(null)}>
      <div class="stack">
        <${Field} label="Tên"><input id="ut-name" value=${edit.name} onInput=${(e) => setEdit({ ...edit, name: e.target.value })} /><//>
        <div class="row"><${Field} label="Số đang có"><input id="ut-qty" type="number" min="0" inputmode="numeric" value=${edit.on_hand} onInput=${(e) => setEdit({ ...edit, on_hand: e.target.value })} /><//>
          <${Field} label="Đơn vị"><input id="ut-unit" value=${edit.unit} onInput=${(e) => setEdit({ ...edit, unit: e.target.value })} /><//></div>
        <div class="row between"><button class="danger" onClick=${async () => { if (await act(() => api('PATCH', `/api/utensils/${edit.id}`, { active: false }), 'Đã ẩn món')) setEdit(null); }}>Bỏ món này</button>
          <button class="primary" onClick=${async () => { if (await act(() => api('PATCH', `/api/utensils/${edit.id}`, { name: edit.name, unit: edit.unit, on_hand: edit.on_hand }), 'Đã lưu')) setEdit(null); }}>Lưu</button></div>
      </div><//>` : null}
    ${brk ? html`<${Modal} title=${`Báo vỡ / mất: ${brk.u.name}`} onClose=${() => setBrk(null)}>
      <div class="stack">
        <div class="row wrap tight">${[['break', 'Vỡ'], ['lost', 'Mất']].map(([k, l]) => html`<button class=${`chip ${brk.kind === k ? 'on' : ''}`} onClick=${() => setBrk({ ...brk, kind: k })}>${l}</button>`)}</div>
        <${Field} label="Số lượng"><input type="number" min="1" inputmode="numeric" value=${brk.qty} onInput=${(e) => setBrk({ ...brk, qty: e.target.value })} /><//>
        <${Field} label="Ai làm vỡ (nếu biết)"><input value=${brk.who} onInput=${(e) => setBrk({ ...brk, who: e.target.value })} /><//>
        <${Field} label="Ghi chú"><input value=${brk.note} placeholder="vd rơi khi bưng, khách làm vỡ…" onInput=${(e) => setBrk({ ...brk, note: e.target.value })} /><//>
        <div class="row end"><button class="primary" onClick=${async () => { if (await act(() => api('POST', `/api/utensils/${brk.u.id}/break`, brk), 'Đã báo')) setBrk(null); }}>Báo</button></div>
      </div><//>` : null}
  </div>`;
}

// Nhập bán hàng từ file Excel Sapo (chủ quán 28/10, tạm thời): chọn file "Doanh thu theo danh sách mặt hàng" → chọn ngày → ghép món → trừ kho
function SapoImport({ onClose }) {
  const [file, setFile] = useState(null);
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dates, setDates] = useState([]);
  const [map, setMap] = useState({});
  const [done, setDone] = useState(null);
  const hist = useData('/api/sapo/imports');
  const pick = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setBusy(true); setPv(null); setDone(null);
    try {
      const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f); });
      const res = await act(() => api('POST', '/api/sapo/preview', { data }));
      if (res) { setFile(data); setPv(res); const fresh = res.dates.filter((d) => !d.imported); setDates(fresh.length ? [fresh[fresh.length - 1].date] : []); setMap({}); }
    } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true);
    try { const r = await act(() => api('POST', '/api/sapo/import', { data: file, dates, map }), 'Đã trừ kho theo bán hàng Sapo'); if (r) { setDone(r); setPv(null); } } finally { setBusy(false); }
  };
  const idOf = (it) => (map[it.key] !== undefined ? map[it.key] : it.menu_item_id);
  const ddmm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
  const unmatched = pv ? pv.items.filter((it) => idOf(it) == null || idOf(it) === '') : [];
  return html`<${Modal} title="📊 Nhập bán hàng từ Sapo" onClose=${onClose}><div class="stack">
    <small class="muted">Trên Sapo: Báo cáo → <b>Doanh thu theo danh sách mặt hàng</b> → xuất Excel → chọn file đó ở đây. App trừ kho theo định lượng như bán trên app. Mỗi ngày chỉ nhập 1 lần.</small>
    <label class=${`button primary big ${busy ? 'muted' : ''}`}>📂 ${busy ? 'Đang đọc file…' : pv ? 'Chọn file khác' : 'Chọn file Excel Sapo'}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange=${pick} /></label>
    ${done ? html`<section class="card attn stack tight"><b>✅ Đã trừ kho ${done.dates.length} ngày: ${done.dates.map(ddmm).join(', ') || '(không có ngày mới)'}</b>
      <small>${done.deducted} món có định lượng đã trừ.</small>
      ${done.no_recipe.length ? html`<small class="warn-text">Chưa có định lượng nên chưa trừ (${done.no_recipe.length}): ${done.no_recipe.map((x) => `${x.name} ×${x.qty}`).join(', ')}. Nhập định lượng ở Thực đơn.</small>` : null}
      ${done.unmatched.length ? html`<small class="warn-text">Chưa ghép món: ${done.unmatched.map((x) => `${x.name} ×${x.qty}`).join(', ')}</small>` : null}
      ${done.short.length ? html`<small class="warn-text">Bán vượt tồn sổ (${done.short.length} dòng), vd ${done.short.slice(0, 5).map((x) => `${x.item}: thiếu ${Math.round(x.need)} ${x.unit} ${x.ingredient}`).join('; ')}. Kiểm kho để chỉnh.</small>` : null}
      <a class="link small" href="/kho?tab=nxt">Xem Nhập – Xuất – Tồn →</a></section>` : null}
    ${pv ? html`
      <b>1. Chọn ngày trừ kho</b>
      <small class="muted">Mặc định chỉ chọn <b>ngày mới nhất</b>. Ngày cũ chỉ chọn nếu kho <b>chưa kiểm</b> sau ngày đó${pv.last_count ? ` (lần kiểm kho gần nhất ${dt(pv.last_count)})` : ''}, kẻo trừ 2 lần.</small>
      <div class="stack tight">${pv.dates.map((d) => html`<label class="check-row"><input type="checkbox" disabled=${d.imported} checked=${dates.includes(d.date)} onChange=${(e) => setDates(e.target.checked ? [...dates, d.date] : dates.filter((x) => x !== d.date))} />
        <span><b>${ddmm(d.date)}</b> · ${d.invoices} hoá đơn · ${d.qty} món · ${money(d.revenue)}${d.imported ? html` <span class="pill ok">đã nhập</span>` : ''}</span></label>`)}</div>
      <b>2. Ghép món Sapo với Thực đơn</b> <small class="muted">${pv.items.length} món · ${unmatched.length ? html`<span class="warn-text">${unmatched.length} món chưa ghép</span>` : 'đã ghép hết'} · ghép 1 lần, lần sau tự nhận</small>
      <div class="sapo-list">${pv.items.map((it) => { const id = idOf(it); const m = pv.menu.find((x) => x.id === Number(id)); return html`<div class=${`sapo-row ${id == null || id === '' ? 'bad' : ''}`}>
        <span class="grow"><b>${it.name}</b> <small class="muted">${it.code || ''} · ×${it.qty}</small>${m && !m.has_recipe ? html`<br /><small class="warn-text">chưa có định lượng</small>` : null}</span>
        <select value=${id == null ? '' : String(id)} onChange=${(e) => setMap({ ...map, [it.key]: e.target.value === '' ? null : Number(e.target.value) })}>
          <option value="">— chưa ghép —</option><option value="0">Bỏ qua (không trừ kho)</option>
          ${pv.menu.map((x) => html`<option value=${x.id}>${x.name}${x.has_recipe ? '' : ' (chưa ĐL)'}</option>`)}</select></div>`; })}</div>
      <button class="primary big" disabled=${busy || !dates.length} onClick=${run}>${busy ? 'Đang trừ kho…' : `✓ Trừ kho ${dates.length} ngày`}</button>` : null}
    ${hist.data?.length ? html`<details><summary class="small muted">Đã nhập (${hist.data.length} ngày)</summary>
      ${hist.data.map((h) => html`<div class="row between small"><span>${ddmm(h.date)} · ${h.invoices} hđ · ${h.qty} món · ${money(h.revenue || 0)} <span class="muted">(${h.by_name || ''})</span></span>
        <button class="link small" onClick=${() => confirm(`Bỏ nhập ngày ${ddmm(h.date)}? Kho được cộng lại những gì đã trừ.`) && act(() => api('POST', '/api/sapo/undo', { date: h.date }), 'Đã bỏ, kho đã cộng lại')}>↩ Bỏ</button></div>`)}</details>` : null}
  </div><//>`;
}

export function StockView({ me, query }) {
  const tab = query.get('tab') || 'ton';
  const meta = useData('/api/stock/meta');
  const [sapo, setSapo] = useState(false);
  const TAB_ACT = { ton: 'kho.xem', nxt: 'kho.nxt', kiem: 'kho.kiem', linh: 'kho.linh', dat: 'kho.dathang', nl: 'kho.nguyenlieu', quydoi: 'kho.nguyenlieu', ls: 'kho.xem' };
  const tabs = TABS.filter(([k]) => !(meta.data?.single && k === 'linh')).filter(([k, , role]) => (TAB_ACT[k] && me.acts?.[TAB_ACT[k]] === true) || ((!role || atLeast(me, role)) && (!TAB_ACT[k] || can(me, TAB_ACT[k]))));
  return html`<div class="stack">
    <div class="tabs scroll">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => navigate(`/kho?tab=${k}`)}>${l}</button>`)}</div>
    ${atLeast(me, 'manager') ? html`<button onClick=${() => setSapo(true)}>📊 Nhập bán hàng từ Sapo (trừ kho)</button>` : null}
    ${sapo ? html`<${SapoImport} onClose=${() => setSapo(false)} />` : null}
    ${me.role === 'owner' && !me.wh_live ? html`<button class="link small" onClick=${() => navigate('/kho-tx')}>🚀 Kho mới theo chứng từ (Kho & Tài sản): xem / bắt đầu khi sẵn sàng →</button>` : null}
    ${!meta.data ? html`<${Loading} state=${meta} />`
      : tab === 'kiem' ? html`<${Count} meta=${meta.data} me=${me} />`
      : tab === 'hh' ? html`<${LossReport} me=${me} />`
      : tab === 'linh' ? html`<${Transfers} me=${me} meta=${meta.data} />`
      : tab === 'dodung' ? html`<${Utensils} me=${me} />`
      : tab === 'dat' ? html`<${Orders} me=${me} meta=${meta.data} />`
      : tab === 'nl' && atLeast(me, 'manager') ? html`<${Setup} meta=${meta.data} />`
      : tab === 'quydoi' && atLeast(me, 'manager') ? html`<${Conversions} meta=${meta.data} />`
      : tab === 'ls' ? html`<${History} me=${me} />`
      : tab === 'nxt' && atLeast(me, 'manager') ? html`<${Nxt} />`
      : html`<${Overview} />`}
  </div>`;
}

// ⚖ Quy đổi (chủ quán 26/10): 1 bảng mọi nguyên liệu — mua theo gì (trên bill) → dùng / bán theo gì (định lượng, kiểm kho)
const PACK_UNITS = /^(gói|goi|thùng|thung|bao|hộp|hop|chai|lốc|loc|két|ket|túi|tui|can|hũ|hu|bịch|bich|xô|xo|khay|bó|bo|vỉ|vi|cuộn|cuon|bình|binh|keg|block|lô|lo)$/i;
// ⚖ Quy đổi (chủ quán 26/10): mua theo gì → dùng theo gì; app chỉ ra món cần quy đổi
export function Conversions({ meta }) {
  const al = useData('/api/stock/unit-aliases');
  const ru = useData('/api/stock/recipe-use');
  const [q, setQ] = useState('');
  const [only, setOnly] = useState(true);
  const [draft, setDraft] = useState({});
  const same = (g) => !g.purchase_unit || g.purchase_unit === g.unit;
  const uses = (id) => (ru.data || []).filter((x) => x.ingredient_id === id);
  // Lý do cần quy đổi (null = không cần)
  const need = (g) => {
    if (!same(g)) return null;
    const frac = !/^(kg|g|gr|gram|lạng|lit|lít|l|ml|cl)$/i.test((g.unit || '').trim()) && uses(g.id).find((x) => x.qty % 1 !== 0);
    if (frac) return `món "${frac.item}" trừ ${String(frac.qty).replace('.', ',')} ${g.unit}/phần`;
    if (PACK_UNITS.test((g.unit || '').trim())) return `đang tính theo ${g.unit}: bán lẻ thì nhập 1 ${g.unit} = bao nhiêu`;
    return null;
  };
  const ings = meta.ingredients.filter((g) => g.active !== 0 && g.active !== false).map((g) => ({ ...g, why: need(g) }))
    .sort((a, b) => (a.why ? 0 : 1) - (b.why ? 0 : 1) || a.name.localeCompare(b.name, 'vi'));
  const nNeed = ings.filter((g) => g.why).length;
  const list = ings.filter((g) => (!only || !nNeed || g.why || draft[g.id]) && (!q || g.name.toLowerCase().includes(q.toLowerCase())));
  const val = (g, k) => draft[g.id]?.[k] ?? g[k] ?? '';
  const set = (g, k, x) => setDraft({ ...draft, [g.id]: { ...draft[g.id], [k]: x } });
  const save = async (g) => {
    const body = { unit: String(val(g, 'unit')).trim(), purchase_unit: String(val(g, 'purchase_unit')).trim(), purchase_factor: String(val(g, 'purchase_factor')).replace(',', '.') };
    if (await act(() => api('PATCH', `/api/stock/ingredients/${g.id}`, body), `Đã lưu ${g.name}`)) { const n = { ...draft }; delete n[g.id]; setDraft(n); }
  };
  const aliases = (id) => (al.data || []).filter((a) => a.ingredient_id === id);
  return html`<div class="stack">
    <div class="row wrap"><input id="qd-q" class="grow" placeholder="Tìm nguyên liệu" value=${q} onInput=${(e) => setQ(e.target.value)} />
      ${nNeed ? html`<button class=${`chip ${only ? 'on' : ''}`} onClick=${() => setOnly(!only)}>⚠ Cần quy đổi (${nNeed})${only ? ' · xem tất cả' : ''}</button>` : html`<span class="pill ok">✓ Không còn món cần quy đổi</span>`}</div>
    <section class="card stack">
      ${list.map((g) => { const dirty = !!draft[g.id]; const f = Number(String(val(g, 'purchase_factor')).replace(',', '.')) || 1; return html`<div class="stack tight" style="border-bottom:1px solid var(--line, #eee);padding-bottom:10px">
        <div class="row between"><b>${g.name}</b>${g.why && !dirty ? html`<span class="pill warn">⚠ Cần quy đổi</span>` : same(g) && !dirty ? html`<span class="pill muted">cùng đơn vị</span>` : html`<small class="ok-text">1 ${val(g, 'purchase_unit') || '?'} = ${f.toLocaleString('vi-VN')} ${val(g, 'unit')}</small>`}</div>
        ${g.why && !dirty ? html`<small class="warn-text">${g.why}</small>` : null}
        <div class="row wrap tight" style="align-items:center">
          <span class="small">1</span>
          <input id=${`qd-pu-${g.id}`} style="width:6em" placeholder="gói" aria-label="Đơn vị mua" value=${val(g, 'purchase_unit')} onInput=${(e) => set(g, 'purchase_unit', e.target.value)} />
          <span class="small">=</span>
          <input id=${`qd-f-${g.id}`} style="width:6em" inputmode="decimal" aria-label="Bằng bao nhiêu" value=${val(g, 'purchase_factor')} onInput=${(e) => set(g, 'purchase_factor', e.target.value)} />
          <input id=${`qd-u-${g.id}`} style="width:6em" placeholder="vắt" aria-label="Đơn vị dùng" value=${val(g, 'unit')} onInput=${(e) => set(g, 'unit', e.target.value)} />
          ${dirty ? html`<button class="primary small" onClick=${() => save(g)}>Lưu</button>` : null}
        </div>
        ${aliases(g.id).length ? html`<small class="muted">Bill ghi khác đã học: ${aliases(g.id).map((a) => html`<span class="pill muted" style="margin-right:4px">${a.keep ? `${a.bill_unit}: không quy đổi` : `1 ${a.bill_unit} = ${a.factor} ${g.unit}`}${a.note ? ` · 📝 ${a.note}` : ''} <button class="link small" aria-label="Xoá" onClick=${() => act(() => api('DELETE', `/api/stock/unit-aliases?ingredient_id=${g.id}&bill_unit=${encodeURIComponent(a.bill_unit)}`), 'Đã xoá')}>✕</button></span>`)}</small>` : null}
      </div>`; })}
      ${!list.length ? html`<p class="muted">Không có nguyên liệu.</p>` : null}
    </section>
  </div>`;
}
