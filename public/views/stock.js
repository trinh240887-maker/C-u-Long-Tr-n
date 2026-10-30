import { useState, useEffect } from '../vendor/hooks.js';
import { html, api, act, useData, Modal, Field, Loading, Confirm, navigate, dt, dayLabel, money, atLeast, toast, addDays, can, SaveInput } from '../ui.js';

const TABS = [['ton', 'Tồn kho'], ['nxt', 'Nhập – Xuất – Tồn', 'manager'], ['kiem', 'Kiểm kho'], ['hh', '📉 Hao hụt', 'manager'], ['linh', '📤 Xuất dùng'], ['dodung', '🍽 Đồ dùng'], ['dat', 'Đặt hàng'], ['nl', 'Nguyên liệu & NCC', 'manager'], ['quydoi', '⚖ Quy đổi', 'manager'], ['btp', '🍲 Bán thành phẩm', 'manager'], ['ls', 'Lịch sử']];
// 5 nhóm tab (chủ quán 30/10: 11 tab rối) — giữ mã tab cũ để link /kho?tab=… vẫn chạy
const GROUPS = [['ton', 'Tồn kho', ['ton']], ['kiem', 'Kiểm kho', ['kiem', 'dodung']], ['nhap', 'Nhập hàng', ['dat', 'linh']], ['bc', 'Báo cáo', ['nxt', 'hh', 'ls']], ['tl', 'Thiết lập', ['nl', 'quydoi', 'btp']]];
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
// "Dùng cho" món nào (tối đa 4 tên + còn lại)
export const usedText = (list) => (list.length > 4 ? `${list.slice(0, 4).join(', ')} +${list.length - 4} món` : list.join(', '));

function Overview() {
  const st = useData('/api/stock/overview');
  const [store, setStore] = useState('all');
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [open, setOpen] = useState(null);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const catName = (k) => (d.cats || []).find((c) => c.key === k)?.label || 'Khác';
  const multi = d.stores.length > 1;
  let items = d.items;
  if (cat) items = items.filter((i) => i.cat === cat);
  if (store !== 'all') items = items.filter((i) => (i.stock[store] || 0) > 0 || String(i.home_store_id) === store || (store === String(d.stores.find((s) => s.kind === 'main')?.id)));
  if (filter === 'warn') items = items.filter((i) => i.status !== 'ok');
  if (filter === 'exp') items = items.filter((i) => i.expiring.length);
  if (q) items = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  const nWarn = d.items.filter((i) => i.status !== 'ok').length;
  const nExp = d.items.filter((i) => i.expiring.length).length;
  const order = (k) => { const n = (d.cats || []).findIndex((c) => c.key === k); return n < 0 ? 999 : n; };
  const groups = [...new Set([...items].sort((a, b) => order(a.cat) - order(b.cat)).map((i) => i.cat))].map((c) => [c, items.filter((i) => i.cat === c).sort((a, b) => ({ out: 0, low: 1, ok: 2 }[a.status] - { out: 0, low: 1, ok: 2 }[b.status]) || a.name.localeCompare(b.name, 'vi'))]);
  // Hạn gần nhất gộp 1 dòng: "31/10 · 15 kg" (cộng mọi lô cùng ngày)
  const nearExp = (i) => { if (!i.expiring.length) return null; const day = [...i.expiring].sort((a, b) => (a.expires_on < b.expires_on ? -1 : 1))[0].expires_on; return { day, qty: i.expiring.filter((e) => e.expires_on === day).reduce((n, e) => n + e.qty, 0), expired: i.expiring.some((e) => e.expired), more: new Set(i.expiring.map((e) => e.expires_on)).size - 1 }; };
  const ddmm = (x) => x.slice(8, 10) + '/' + x.slice(5, 7);
  const DOT = { out: '#dc2626', low: '#f59e0b', ok: '#16a34a' };
  return html`<div class="stack">
    <div class="row wrap tight">
      <input id="ov-q" type="search" style="flex:1 1 100%" placeholder="🔍 Tìm nguyên liệu" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <select class="grow" value=${cat} onChange=${(e) => setCat(e.target.value)}><option value="">Mọi nhóm kho (${d.items.length})</option>
        ${(d.cats || []).filter((c) => d.items.some((i) => i.cat === c.key)).map((c) => html`<option value=${c.key}>${c.label} (${d.items.filter((i) => i.cat === c.key).length})</option>`)}</select>
      ${multi ? html`<select id="ov-store" class="auto" value=${store} onChange=${(e) => setStore(e.target.value)}><option value="all">Tất cả kho</option>${d.stores.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select>` : null}
    </div>
    <div class="chips">
      <button class=${`chip ${filter === 'warn' ? 'on' : ''}`} onClick=${() => setFilter(filter === 'warn' ? '' : 'warn')}>🔴 Hết / sắp hết (${nWarn})</button>
      <button class=${`chip ${filter === 'exp' ? 'on' : ''}`} onClick=${() => setFilter(filter === 'exp' ? '' : 'exp')}>⏰ Sắp hết hạn (${nExp})</button>
    </div>
    ${items.length ? groups.map(([c, list]) => html`<section class="card" style="padding:8px 10px">
      <div class="row between"><b>${catName(c)}</b><small class="muted">${list.length} hàng${list.some((i) => i.status !== 'ok') ? html` · <span class="warn-text">${list.filter((i) => i.status !== 'ok').length} cần nhập</span>` : ''}</small></div>
      <table class="list small" style="width:100%"><tbody>${list.map((i) => { const e = nearExp(i); return html`<tr style="cursor:pointer" onClick=${() => setOpen(i)}>
        <td style="width:14px"><span style=${`display:inline-block;width:10px;height:10px;border-radius:50%;background:${DOT[i.status]}`}></span></td>
        <td>${i.name}</td>
        <td class="r" style="white-space:nowrap"><b>${qty(i.available, i.unit)}</b></td>
        <td class="r" style="white-space:nowrap;width:5.5em">${e ? html`<span class=${e.expired ? 'bad-text' : 'warn-text'}>⏰ ${ddmm(e.day)}</span>` : ''}</td></tr>`; })}</tbody></table>
    </section>`) : html`<div class="empty">${d.items.length ? 'Không có nguyên liệu nào khớp.' : 'Chưa có nguyên liệu. Quản lý thêm ở Thiết lập → Nguyên liệu & NCC.'}</div>`}
    <p class="muted small">🔴 hết · 🟡 sắp hết · 🟢 đủ. Bấm 1 dòng để xem chi tiết (hạn từng lô, dùng cho món nào, NCC).</p>
    ${open ? html`<${Modal} title=${open.name} onClose=${() => setOpen(null)}><div class="stack tight">
      <div class="row between"><span>Còn <b>${qty(open.available, open.unit)}</b>${open.days_left !== null ? html` <span class="muted">· đủ ~${Math.floor(open.days_left * 10) / 10} ngày</span>` : null}</span><span class=${`pill ${STATUS[open.status][1]}`}>${STATUS[open.status][0]}</span></div>
      <small>Mai cần ~${qty(open.forecast_tomorrow, open.unit)}${open.min_stock ? ` · tối thiểu ${qty(open.min_stock, open.unit)}` : ''}</small>
      ${multi ? html`<small class="muted">${d.stores.filter((s) => open.stock[s.id]).map((s) => `${s.name}: ${qty(open.stock[s.id], open.unit)}`).join(' · ') || 'Không còn trong kho nào'}</small>` : null}
      <small class="muted">${catName(open.cat)} · ${FRESH[open.freshness]} · NCC: ${open.supplier_name || 'chưa có'}</small>
      ${open.used_for?.length ? html`<small>🍽 Dùng cho: ${usedText(open.used_for)}</small>` : null}
      ${open.expiring.length ? html`<b class="small">Hạn dùng từng lô</b>${open.expiring.map((e) => html`<small class=${e.expired ? 'bad-text' : 'warn-text'}>${e.expired ? 'Đã hết hạn' : 'Hết hạn'} ${dayLabel(e.expires_on)}: ${qty(e.qty, open.unit)}${multi ? ` ở ${d.stores.find((s) => s.id === e.store_id)?.name || ''}` : ''}</small>`)}` : null}
      <a class="btn small" style="align-self:flex-start" href=${`/kho?tab=nxt`}>Xem Nhập – Xuất – Tồn →</a>
    </div><//>` : null}
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

// Danh sách nhóm kho: đổi tên, thêm, bớt (chủ quán 30/10)
function CatEditor({ cats }) {
  const [list, setList] = useState(null);
  const cur = list || cats;
  const set = (k, label) => setList(cur.map((c, j) => (j === k ? { ...c, label } : c)));
  return html`<section class="card stack tight"><details><summary><b>📦 Nhóm kho (${cats.length})</b> <small class="muted">bò nhập khẩu, bò tươi, topping… · bấm để sửa</small></summary>
    ${cur.map((c, k) => html`<div class="row tight" style="margin-top:4px"><input class="grow" value=${c.label} onInput=${(e) => set(k, e.target.value)} />
      <button class="small" onClick=${() => confirm(`Bỏ nhóm "${c.label}"? Hàng trong nhóm sẽ để app tự xếp lại.`) && setList(cur.filter((_, j) => j !== k))}>✕</button></div>`)}
    <div class="row tight" style="margin-top:6px"><button class="small" onClick=${() => setList([...cur, { key: '', label: 'Nhóm mới' }])}>+ Thêm nhóm</button>
      ${list ? html`<button class="primary small" onClick=${async () => { if (await act(() => api('PUT', '/api/stock/cats', { cats: cur }), 'Đã lưu nhóm kho')) setList(null); }}>Lưu</button><button class="small" onClick=${() => setList(null)}>Huỷ</button>` : null}</div>
  </details></section>`;
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
    <${CatEditor} cats=${meta.cats || []} />
    <section class="card">
      <div class="row between"><h3>Nguyên liệu (${meta.ingredients.length})</h3><button class="primary" onClick=${() => setEdit({})}>+ Thêm</button></div>
      <small class="muted">Nhóm kho chọn ở ô bên phải mỗi dòng. <i>(tự)</i> = app tự xếp theo tên / món dùng, chọn lại nếu sai.</small>
      ${(meta.cats || []).map((c) => { const list = meta.ingredients.filter((i) => i.cat_eff === c.key); return list.length ? html`<h4 class="stock-cat">📦 ${c.label} <small class="muted">${list.length}</small></h4>
        ${list.map((i) => html`<div class=${`row tight ${i.active ? '' : 'off'}`} style="align-items:center;border-top:1px solid var(--line);padding:4px 0">
          <button class="link grow" style="text-align:left" onClick=${() => setEdit(i)}><b>${i.name}</b><br /><span class="muted small">${FRESH[i.freshness]} · ${money(i.price)}/${i.purchase_unit}${i.used_for?.length ? ` · 🍽 ${usedText(i.used_for)}` : ''}</span></button>
          <select class="auto small" value=${i.cat_auto ? '' : i.cat_eff} onChange=${(e) => act(() => api('POST', '/api/stock/ingredients/cat', { id: i.id, cat: e.target.value || null }), 'Đã đổi nhóm')}>
            <option value="">(tự) ${c.label}</option>${(meta.cats || []).map((x) => html`<option value=${x.key}>${x.label}</option>`)}</select></div>`)}` : null; })}
    </section>
    ${edit ? html`<${IngForm} init=${edit} meta=${meta} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}

// ---------- 🍲 Bán thành phẩm (chủ quán 30/10): cốt lẩu, nước dùng, nước chấm, sốt steak, sốt xiên ----------
const mm = (n) => (n >= 60 ? `${Math.floor(n / 60)} giờ${n % 60 ? ` ${n % 60} phút` : ''}` : `${n} phút`);
function Preps({ me, meta }) {
  const st = useData('/api/preps');
  const [book, setBook] = useState('');
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);
  const [kind, setKind] = useState('plan');
  const [cook, setCook] = useState(null);
  if (!st.data) return html`<${Loading} state=${st} />`;
  const d = st.data;
  const manager = atLeast(me, 'manager');
  if (!d.preps.length) return html`<div class="empty stack">Chưa nạp sổ công thức.${manager ? html`<button class="primary" onClick=${() => act(() => api('POST', '/api/preps/import'), 'Đã nạp 4 sổ')}>Nạp 4 sổ công thức</button>` : null}</div>`;
  const books = [...new Set(d.preps.map((p) => p.book))];
  const list = d.preps.filter((p) => (!book || p.book === book) && p.kind === kind);
  const ings = (meta?.ingredients || []).filter((g) => g.active !== 0);
  return html`<div class="stack">
    <p class="small muted">Từ 4 sổ công thức (bản ${d.version || '?'}). Mỗi món: nguyên liệu theo mẻ, thành phẩm, hạn dùng, cỡ túi, các bước có <b>phút đứng bếp</b> và <b>phút chờ</b> (ninh, ngâm đá… không cần người đứng).${manager && d.seed_version && d.seed_version !== d.version ? html` <button class="small" onClick=${() => act(() => api('POST', '/api/preps/import'), 'Đã nạp bản mới')}>Nạp bản ${d.seed_version}</button>` : null}</p>
    ${manager && d.preps.some((p) => p.unmatched) ? html`<section class="card warn-card stack tight"><small>⚠ ${d.preps.reduce((n, p) => n + p.unmatched, 0)} dòng nguyên liệu trong sổ chưa có mã kho (thường là gia vị khô: hoa tiêu, thảo quả…). Cần có mã kho thì nấu mới trừ kho được.</small>
      <button class="small" style="align-self:flex-start" onClick=${() => confirm('Tạo mã kho cho mọi nguyên liệu trong sổ chưa có trong kho? (đơn vị g / ml, giá theo sổ — dòng giá ước tính nhớ sửa sau)') && act(async () => { const r = await api('POST', '/api/preps/create-missing'); toast(`Đã tạo ${r.made} mã kho`); return r; })}>＋ Tạo mã kho cho nguyên liệu chưa có</button></section>` : null}
    <div class="chips"><button class=${`chip ${kind === 'plan' ? 'on' : ''}`} onClick=${() => setKind('plan')}>📋 Kế hoạch nấu hôm nay</button><button class=${`chip ${kind === 'batch' ? 'on' : ''}`} onClick=${() => setKind('batch')}>🍲 Nấu theo mẻ</button><button class=${`chip ${kind === 'serving' ? 'on' : ''}`} onClick=${() => setKind('serving')}>🥣 Pha 1 phần / xiên</button><button class=${`chip ${kind === 'done' ? 'on' : ''}`} onClick=${() => setKind('done')}>🧾 Mẻ đã nấu</button></div>
    ${kind === 'plan' ? html`<${CookPlan} me=${me} />` : kind === 'done' ? html`<${CookedList} me=${me} />` : html`
    <div class="chips small-chips"><button class=${`chip ${!book ? 'on' : ''}`} onClick=${() => setBook('')}>Tất cả</button>${books.map((b) => html`<button class=${`chip ${book === b ? 'on' : ''}`} onClick=${() => setBook(b)}>${b} <small>${d.preps.filter((p) => p.book === b && p.kind === kind).length}</small></button>`)}</div>
    ${list.map((p) => html`<section class="card stack tight" key=${p.id}>
      <button class="link" style="text-align:left" onClick=${() => setOpen(open === p.id ? null : p.id)}>
        <div class="row between wrap"><b>${p.name}</b><small class="muted">${p.book}</small></div>
        <small>${p.out_qty ? `Mẻ ra ${Number(p.out_qty).toLocaleString('vi-VN')} ${p.out_unit}` : p.batch_col || ''}${p.active_min || p.wait_min ? ` · ⏱ đứng bếp ${mm(p.active_min)}${p.wait_min ? ` + chờ ${mm(p.wait_min)}` : ''}` : ''}${p.shelf_text ? ` · ${p.shelf_text}` : ''}${p.cost ? ` · cost mẻ ${money(p.cost)}` : ''}</small>
        ${p.unmatched ? html`<br /><small class="warn-text">⚠ ${p.unmatched} nguyên liệu chưa khớp mã kho</small>` : null}
      </button>
      ${open === p.id ? html`
        ${p.packs ? html`<small>📦 Chia túi: ${p.packs}</small>` : null}
        <table class="list small"><tbody>${p.lines.map((l) => html`<tr><td>${l.name}${l.note ? html`<br /><small class="muted">${l.note}</small>` : null}</td>
          <td class="r">${Number(l.qty).toLocaleString('vi-VN')} ${l.unit}${manager && l.qty > 0 ? html`<br /><button class=${`small ${l.secret ? 'primary' : ''}`} title="Bí mật: bếp chỉ thấy Gói" onClick=${() => act(() => api('PATCH', `/api/preps/lines/${l.id}`, { secret: !l.secret }), l.secret ? 'Đã bỏ bí mật' : 'Đã đánh dấu bí mật')}>${l.secret ? '🔒 bí mật' : '🔓'}</button>` : null}</td>
          <td>${l.ingredient_id ? html`<small class="ok-text">✓ ${l.ing_name}</small>${manager ? html` <button class=${`small ${l.ing_pre_done ? 'primary' : ''}`} title="Mua sẵn đã sơ chế: không thành việc sơ chế" onClick=${() => act(() => api('PATCH', `/api/preps/ingredients/${l.ingredient_id}`, { pre_done: !l.ing_pre_done }), l.ing_pre_done ? 'Đã bỏ: bếp tự sơ chế' : 'Đã ghi: mua sẵn đã sơ chế')}>${l.ing_pre_done ? '✂ mua sẵn' : '✂'}</button>` : null}` : (l.unit_price || 0) > 0 ? (manager ? html`<select class="auto small" onChange=${(e) => e.target.value && act(() => api('PATCH', `/api/preps/lines/${l.id}`, e.target.value === 'new' ? { create: true } : { ingredient_id: Number(e.target.value) }), 'Đã gắn mã kho')}>
              <option value="">⚠ chọn mã kho…</option><option value="new">＋ Tạo mã kho "${l.code || l.name}"</option>${ings.map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select>` : html`<small class="warn-text">chưa khớp kho</small>`) : html`<small class="muted">—</small>`}</td></tr>`)}</tbody></table>
        <b class="small">Các bước</b>
        <ol class="small" style="padding-left:18px;margin:0">${(edit?.id === p.id ? edit.steps : p.steps).map((s, k) => html`<li style="margin-bottom:6px">${s.text}
          ${edit?.id === p.id ? html`<div class="row tight" style="align-items:center;margin-top:2px">đứng bếp <input inputmode="numeric" style="width:4.5em" value=${s.min} onInput=${(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === k ? { ...x, min: e.target.value } : x)) })} /> phút · chờ <input inputmode="numeric" style="width:4.5em" value=${s.wait} onInput=${(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === k ? { ...x, wait: e.target.value } : x)) })} /> phút</div>`
            : s.min || s.wait ? html` <small class="muted">· ${s.min ? `⏱ ${s.min}′` : ''}${s.wait ? ` ⏳ chờ ${mm(s.wait)}` : ''}</small>` : null}</li>`)}</ol>
        ${manager ? (edit?.id === p.id ? html`<div class="row tight"><button class="primary small" onClick=${async () => { if (await act(() => api('PATCH', `/api/preps/${p.id}/steps`, { steps: edit.steps.map((s) => ({ ...s, min: Number(s.min) || 0, wait: Number(s.wait) || 0 })) }), 'Đã lưu thời gian')) setEdit(null); }}>Lưu thời gian</button><button class="small" onClick=${() => setEdit(null)}>Huỷ</button></div>`
          : html`<button class="small" style="align-self:flex-start" onClick=${() => setEdit({ id: p.id, steps: p.steps.map((s) => ({ ...s })) })}>✎ Sửa phút từng bước</button>`) : null}` : null}
      ${p.kind === 'batch' ? html`<div class="row wrap tight" style="align-items:center">
        ${manager ? html`<small>Thành phẩm vào kho:</small><select class="auto small" value=${p.output_ingredient_id || ''} onChange=${(e) => e.target.value && act(() => api('PATCH', `/api/preps/${p.id}/output`, e.target.value === 'new' ? { create: true, name: prompt('Tên mã kho thành phẩm', p.name.replace(/\s*\(.*?\)\s*/g, ' ').trim()) || undefined } : { ingredient_id: Number(e.target.value) }), 'Đã gắn mã thành phẩm')}>
          <option value="">⚠ chưa gắn…</option><option value="new">＋ Tạo mã mới</option>${ings.map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select>`
          : p.output_ingredient_id ? null : html`<small class="warn-text">Chưa gắn mã thành phẩm</small>`}
        ${p.output_ingredient_id ? html`<button class="primary small" onClick=${() => setCook({ p })}>✅ Ghi mẻ đã nấu</button>` : null}</div>` : null}
    </section>`)}`}
    ${cook ? html`<${CookModal} p=${cook.p} plan=${cook.plan} onClose=${() => setCook(null)} />` : null}
  </div>`;
}

// Ghi 1 lần nấu: số mẻ, cân thật, số phút → trừ nguyên liệu sống, cộng thành phẩm vào kho (3b, chủ quán duyệt 30/10)
function CookModal({ p, plan, onClose }) {
  const left = plan ? Math.max(1, plan.batches - plan.done_batches) : 1;
  const [f, setF] = useState({ batches: String(left), out_qty: '', minutes: '', note: '' });
  const [res, setRes] = useState(null);
  const expect = p.out_qty ? p.out_qty * (Number(f.batches) || 0) : null;
  const save = async () => {
    const r = await act(() => api('POST', `/api/preps/${p.id}/cook`, { batches: Number(f.batches) || 1, out_qty: f.out_qty === '' ? null : Number(f.out_qty), minutes: f.minutes === '' ? null : Number(f.minutes), note: f.note, plan_id: plan?.id }));
    if (r) setRes(r);
  };
  return html`<${Modal} title=${`Ghi mẻ: ${p.name}`} onClose=${onClose}>${res ? html`<div class="stack">
      <p>✅ Đã cộng <b>${qty(res.out_qty, res.unit)}</b> vào kho${res.expires_on ? html` · hạn dùng <b>${res.expires_on.split('-').reverse().join('/')}</b>` : null} · cost ${money(res.cost)}.</p>
      ${res.expected && Math.abs(res.out_qty - res.expected) / res.expected > 0.05 ? html`<p class="warn-text small">Ra ${Math.round((res.out_qty / res.expected) * 100)}% so với sổ (${qty(res.expected, res.unit)}).</p>` : null}
      ${res.short.length ? html`<p class="warn-text small">⚠ Kho trên sổ không đủ: ${res.short.map((x) => `${x.ingredient} thiếu ${qty(x.need, x.unit)}`).join(', ')}. Kiểm kho / nhập bù.</p>` : null}
      ${res.skipped.length ? html`<p class="muted small">Chưa trừ (chưa có mã kho): ${res.skipped.join(', ')}</p>` : null}
      <button class="primary" onClick=${onClose}>Xong</button></div>`
    : html`<div class="stack">
      <${Field} label="Số mẻ"><input inputmode="decimal" value=${f.batches} onInput=${(e) => setF({ ...f, batches: e.target.value })} /><//>
      <${Field} label=${`Cân thực tế (${p.out_unit})`}><input inputmode="decimal" placeholder=${expect ? `theo sổ ${expect.toLocaleString('vi-VN')}` : 'bắt buộc'} value=${f.out_qty} onInput=${(e) => setF({ ...f, out_qty: e.target.value })} /><//>
      <${Field} label="Số phút đứng bếp thật"><input inputmode="numeric" placeholder=${p.active_min ? `sổ ước ${p.active_min * (Number(f.batches) || 1)} phút` : ''} value=${f.minutes} onInput=${(e) => setF({ ...f, minutes: e.target.value })} /><//>
      <${Field} label="Ghi chú"><input value=${f.note} onInput=${(e) => setF({ ...f, note: e.target.value })} /><//>
      <small class="muted">App trừ nguyên liệu sống theo sổ × số mẻ, cộng thành phẩm theo số cân thật (để trống = theo sổ), hạn dùng theo sổ.</small>
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu mẻ</button></div></div>`}<//>`;
}

const STATIONS = ['Lẩu', 'Steak', 'Nướng', 'Bar', 'Bếp'];
// Kế hoạch nấu hôm nay = checklist bếp: dự báo 3 ngày − tồn sáng nay → số mẻ; chia theo điểm làm, tổng phút (3c)
// Dùng chung: Kho → Bán thành phẩm và trang Checklist (mục Bếp). compact = trong Checklist (bỏ giải thích dài)
export function CookPlan({ me, compact = false, only = null }) {
  const pl = useData('/api/preps/plan');
  const lead = atLeast(me, 'team_lead');
  const staff = useData(lead ? '/api/staff?mine=1' : null);
  const [open, setOpen] = useState(null);
  const [shut, setShut] = useState({}); // trong Checklist: mở sẵn, bấm tên để thu gọn
  const [add, setAdd] = useState(null);
  const [cook, setCook] = useState(null);
  const isOpen = (x) => (compact ? !shut[x.id] : open === x.id);
  const toggle = (x) => (compact ? setShut({ ...shut, [x.id]: !shut[x.id] }) : setOpen(open === x.id ? null : x.id));
  const pr = useData(add ? '/api/preps/names' : null);
  if (!pl.data) return html`<${Loading} state=${pl} />`;
  const d0 = pl.data;
  const d = only ? { ...d0, items: d0.items.filter((x) => only.includes(x.station)) } : d0;
  const preps = pr.data || [];
  const tick = (x, k, done) => act(() => api('POST', `/api/preps/plan/${x.id}/tick`, { step: k, done }));
  const mine = (x) => x.staff_id === me.id;
  const staffList = Array.isArray(staff.data) ? staff.data : staff.data?.staff || [];
  const setRow = (prep_id, patch) => act(() => api('PUT', '/api/preps/plan', { prep_id, ...patch }));
  const byStation = STATIONS.concat(d.items.map((x) => x.station).filter((x) => !STATIONS.includes(x))).map((s) => [s, d.items.filter((x) => (x.station || 'Bếp') === s).sort((a, b) => mine(b) - mine(a))]).filter(([, l]) => l.length);
  return html`<div class="stack">
    ${compact ? null : html`<p class="small muted">App tự lập mỗi sáng: <b>dự báo dùng ${d.days} ngày</b> (theo món đã bán, không quá hạn dùng) − <b>tồn kho lúc lập</b> → số mẻ làm tròn lên. Bếp làm xong bấm <b>Ghi mẻ</b> (cân thật + phút thật) → kho tự trừ nguyên liệu, cộng thành phẩm.</p>`}
    ${d.no_output && !compact ? html`<small class="warn-text">⚠ ${d.no_output} món nấu theo mẻ chưa gắn mã thành phẩm nên chưa vào kế hoạch (gắn ở mục 🍲 Nấu theo mẻ).</small>` : null}
    <section class="card row wrap between"><span>Tổng hôm nay: <b>${d.items.length}</b> việc · ⏱ kế hoạch <b>${mm(d.items.reduce((n, x) => n + x.plan_min, 0))}</b> · thật <b>${mm(only ? d.items.reduce((n, x) => n + (x.done_min || 0), 0) : d.total_done_min)}</b></span>
      ${lead ? html`<div class="row tight"><button class="small" onClick=${() => setAdd({ prep_id: '', batches: '1' })}>＋ Thêm việc</button><button class="small" onClick=${() => confirm('Lập lại theo số bán + tồn hiện tại? (dòng đã sửa tay giữ nguyên)') && act(() => api('POST', '/api/preps/plan/regen'), 'Đã lập lại')}>↻ Lập lại</button></div>` : null}</section>
    ${d.boss && d.packs?.length ? html`<section class="card stack tight" style="border:2px dashed #b45309"><b>🔒 Gói bí mật cần pha hôm nay (chỉ quản lý thấy)</b>
      <small class="muted">Cân sẵn, dán mã gói, giao bếp. Bếp chỉ thấy "Gói Gxx", không thấy bên trong.</small>
      ${d.packs.map((k) => html`<div class="stack tight" style="border-top:1px solid #ddd;padding-top:6px"><label class="row tight" style="align-items:center"><input type="checkbox" checked=${!!k.done} onChange=${() => tick({ id: k.plan_id }, 300, !k.done)} /><b>Gói ${k.code}</b> × ${k.batches} — ${k.name}${k.done ? html` <small class="ok-text">✓ ${k.done.by || ''}</small>` : ''}</label>
        <small>${k.lines.map((l) => `${Number(l.qty).toLocaleString('vi-VN')} ${l.unit} ${l.name.split(/[,(]/)[0].trim()}`).join(' · ')}</small></div>`)}
    </section>` : null}
    ${!d.items.length ? html`<div class="empty">Hôm nay chưa cần nấu mẻ nào (tồn đủ cho ${d.days} ngày, hoặc chưa có số bán của thành phẩm).</div>` : null}
    ${byStation.map(([s, list]) => { const st = d.stations.find((x) => x.station === s) || {}; return html`<section class="card stack tight">
      <div class="row between wrap"><b>🔥 ${s}</b><small>${st.done || 0}/${list.length} xong · ⏱ ${mm(st.plan_min || 0)}${st.done_min ? ` · thật ${mm(st.done_min)}` : ''}${st.wait_max ? ` · chờ dài nhất ${mm(st.wait_max)}` : ''}</small></div>
      ${list.map((x) => { const done = x.done_batches >= x.batches; return html`<div class="stack tight" style=${`border-top:1px solid #ddd;padding-top:6px${mine(x) ? ';background:#fff7e6' : ''}`} key=${x.id}>
        <div class="row between wrap" style="align-items:center"><button class="link" style="text-align:left" onClick=${() => toggle(x)}><b>${done ? '✅ ' : ''}${isOpen(x) ? '▾' : '▸'} ${x.name}</b> × ${x.batches} mẻ${mine(x) ? html` <span class="pill warn">của bạn</span>` : ''}${x.ticks.some((y) => y.step < 100) ? html` <small class="muted">· ${x.ticks.filter((y) => y.step < 100).length}/${x.steps.length} bước</small>` : ''}<br />
          <small class="muted">${x.out_qty ? `ra ${qty(x.out_qty * x.batches, x.out_unit)} · ` : ''}⏱ ${mm(x.plan_min)}${x.wait_min ? ` + chờ ${mm(x.wait_min)}` : ''}${x.need != null && !x.manual ? ` · cần ${qty(x.need, x.out_unit_stock)} (${x.forecast ? `bán ${qty(x.forecast, x.out_unit_stock)}` : ''}${x.extra ? `${x.forecast ? ' + ' : ''}làm nền ${qty(x.extra, x.out_unit_stock)}` : ''} − tồn ${qty(x.stock, x.out_unit_stock)})` : x.manual ? ' · sửa tay' : ''}${x.staff_name ? ` · 👤 ${x.staff_name}` : ''}</small>
          ${x.done_batches ? html`<br /><small class="ok-text">Đã nấu ${x.done_batches}/${x.batches} mẻ · ${qty(x.done_qty, x.out_unit_stock)}${x.done_min != null ? ` · ${mm(x.done_min)} thật` : ''}</small>` : null}</button>
          ${!done ? html`<button class="primary small" onClick=${() => setCook({ p: { ...x, id: x.prep_id }, plan: x })}>Ghi mẻ</button>` : null}</div>
        ${d.boss && x.views?.length ? html`<small class="muted">👁 Đã mở xem: ${x.views.map((v) => `${v.name || '?'} ${dt(v.at).slice(-5)}`).join(', ')}</small>` : null}
        ${x.locked ? (done ? html`<small class="muted">Đã nấu xong — công thức đã ẩn.</small>` : html`<div class="row wrap tight" style="align-items:center"><button class="primary small" onClick=${() => act(() => api('POST', `/api/preps/plan/${x.id}/start`))}>▶ Bắt đầu nấu</button><small class="muted">để xem nguyên liệu & các bước (app ghi lại người xem)</small></div>`)
        : html`${!isOpen(x) ? html`<button class="small" style="align-self:flex-start" onClick=${() => toggle(x)}>📋 Xem nguyên liệu & các bước</button>` : null}
        ${isOpen(x) ? html`
          ${x.packs ? html`<small>📦 ${x.packs}</small>` : null}
          ${x.lines?.length ? html`<b class="small">🧺 Nguyên liệu cần lấy (${x.batches} mẻ)</b>
          <div class="stack tight">${x.lines.map((l) => { const t = x.ticks.find((y) => y.step === 100 + l.pos); return html`<label class="row tight" style="align-items:flex-start"><input type="checkbox" checked=${!!t} disabled=${d.date !== me.today} onChange=${() => tick(x, 100 + l.pos, !t)} /><small class=${t ? 'muted' : ''} style=${l.pack ? 'color:#b45309' : ''}>${l.secret ? '🔒 ' : ''}<b>${Number(l.qty).toLocaleString('vi-VN')} ${l.unit}</b> ${l.name}${l.note ? html` <span class="muted">· ${l.note}</span>` : ''}</small></label>`; })}</div>` : null}
          <b class="small">👩‍🍳 Các bước${x.batches > 1 ? html` <span class="warn-text">(số trong chữ là cho 1 mẻ, số cân tô đậm đã nhân ${x.batches} mẻ)</span>` : ''}</b>
          <div class="stack tight">${x.steps.map((st2, k) => { const t = x.ticks.find((y) => y.step === k); return html`<label class="row tight" style="align-items:flex-start"><input type="checkbox" checked=${!!t} disabled=${d.date !== me.today} onChange=${() => tick(x, k, !t)} /><small class=${t ? 'muted' : ''}>${k + 1}. ${st2.text}${st2.min ? ` · ⏱ ${st2.min * x.batches}′` : ''}${st2.wait ? ` · ⏳ ${mm(st2.wait)}` : ''}${t ? html` <i>✓ ${t.by || ''} ${dt(t.at).slice(-5)}</i>` : ''}
            ${st2.uses?.length ? html`<br /><span style="color:#9a3412">↳ ${st2.uses.map((u) => html`<b>${Number(u.qty).toLocaleString('vi-VN')} ${u.unit}</b> ${u.name.split(/[,(]/)[0].trim()}`).reduce((a, b) => [...a, a.length ? ' · ' : '', b], [])}</span>` : ''}</small></label>`; })}</div>
          ${lead ? html`<div class="row wrap tight" style="align-items:center">
            <label class="small">Số mẻ <input inputmode="decimal" style="width:4em" value=${x.batches} onChange=${(e) => setRow(x.prep_id, { batches: Number(e.target.value) || 0 })} /></label>
            <select class="auto small" value=${x.station} onChange=${(e) => setRow(x.prep_id, { batches: x.batches, station: e.target.value })}>${STATIONS.map((o) => html`<option>${o}</option>`)}</select>
            ${staffList.length ? html`<select class="auto small" value=${x.staff_id || ''} onChange=${(e) => setRow(x.prep_id, { batches: x.batches, staff_id: e.target.value ? Number(e.target.value) : null })}><option value="">— người làm —</option>${staffList.filter((s2) => s2.active !== 0).map((s2) => html`<option value=${s2.id}>${s2.name}</option>`)}</select>` : null}
            <button class="small danger" onClick=${() => confirm('Bỏ việc này khỏi kế hoạch hôm nay?') && setRow(x.prep_id, { batches: 0 })}>Bỏ</button></div>` : null}` : null}`}
      </div>`; })}
    </section>`; })}
    ${d.extra.length ? html`<section class="card stack tight"><b>Nấu thêm ngoài kế hoạch</b>${d.extra.map((x) => html`<small>${x.name} × ${x.n} mẻ${x.m ? ` · ${mm(x.m)}` : ''}</small>`)}</section>` : null}
    ${add ? html`<${Modal} title="＋ Thêm việc nấu hôm nay" onClose=${() => setAdd(null)}><div class="stack">
      <select value=${add.prep_id} onChange=${(e) => setAdd({ ...add, prep_id: e.target.value })}><option value="">— chọn bán thành phẩm —</option>${preps.filter((p) => p.kind === 'batch').map((p) => html`<option value=${p.id}>${p.book} · ${p.name}</option>`)}</select>
      <${Field} label="Số mẻ"><input inputmode="decimal" value=${add.batches} onInput=${(e) => setAdd({ ...add, batches: e.target.value })} /><//>
      <div class="row end"><button class="primary" disabled=${!add.prep_id} onClick=${async () => { if (await setRow(Number(add.prep_id), { batches: Number(add.batches) || 1 })) setAdd(null); }}>Thêm</button></div></div><//>` : null}
    ${cook ? html`<${CookModal} p=${cook.p} plan=${cook.plan} onClose=${() => setCook(null)} />` : null}
  </div>`;
}

function CookedList({ me }) {
  const today = me.today;
  const [date, setDate] = useState(today);
  const l = useData(`/api/preps/batches?date=${date}`);
  return html`<div class="stack">
    <input type="date" class="auto" value=${date} onInput=${(e) => e.target.value && setDate(e.target.value)} />
    ${!l.data ? html`<${Loading} state=${l} />` : !l.data.length ? html`<div class="empty">Chưa ghi mẻ nào ngày này.</div>` : html`<section class="card stack tight">
      ${l.data.map((b) => html`<div class="row between wrap" style="align-items:center"><span class=${b.voided_at ? 'muted' : ''} style=${b.voided_at ? 'text-decoration:line-through' : ''}><b>${b.name}</b> × ${b.batches} mẻ · ${qty(b.out_qty, b.out_unit)}${b.minutes != null ? ` · ${mm(b.minutes)}` : ''} · ${money(b.cost)}<br /><small class="muted">${dt(b.at)} · ${b.staff_name || ''}${b.note ? ` · ${b.note}` : ''}</small></span>
        ${!b.voided_at && date === today && atLeast(me, 'manager') ? html`<button class="small danger" onClick=${() => confirm('Huỷ mẻ ghi nhầm? Nguyên liệu trả lại kho, thành phẩm bị trừ.') && act(() => api('POST', `/api/preps/batches/${b.id}/void`), 'Đã huỷ mẻ')}>Huỷ</button>` : null}</div>`)}
    </section>`}
  </div>`;
}

// ---------- Lịch sử ----------
// Nhập – Xuất – Tồn chung cả quán: Đồ tươi / Đồ bình thường; dòng lệch quá ngưỡng tô đỏ, xếp lên đầu
const KIND_NXT = { nhap: 'Nhập', dcnhap: 'Huỷ / sửa phiếu nhập', ban: 'Bán (định lượng)', xuat: 'Xuất dùng', huy: 'Huỷ / hao hụt', lech: 'Lệch khi cân' };
const qtyU = (q, unit) => (q == null ? '' : unit === 'g' && Math.abs(q) >= 1000 ? `${(q / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} kg` : unit === 'ml' && Math.abs(q) >= 1000 ? `${(q / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} l` : `${Number(q).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} ${unit}`);
function Nxt({ me }) {
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
    <p class="small muted">Tồn đầu + Nhập ± Huỷ/sửa phiếu nhập − Bán theo định lượng − Xuất dùng − Huỷ ± Lệch = Tồn cuối. <b>Lệch</b> = cân thực tế − sổ (âm là thiếu). Đỏ = lệch quá ${d.data?.tolerance ?? 3}% so với lượng dùng.</p>
    ${d.data ? html`<${LockBar} me=${me} d=${d.data} />` : null}
    ${d.data?.top?.length ? html`<section class="card stack tight"><div class="row between wrap"><b>💸 Thiếu nhiều tiền nhất</b><small>Thiếu <b class="warn-text">${money(d.data.lech_thieu)}</b>${d.data.lech_thua ? ` · thừa ${money(d.data.lech_thua)}` : ''}</small></div>
      <small class="muted">Kiểm tra mấy hàng này trước: cân lại, xem định lượng món, xem có nhập thiếu bill / huỷ không ghi.</small>
      <table class="list small"><tbody>${d.data.top.map((r, k) => html`<tr style="cursor:pointer" onClick=${() => setOpen(r)}><td>${k + 1}. <b>${r.name}</b></td><td class="r">${qtyU(r.lech, r.unit)}${r.lech_pct != null ? ` (${r.lech_pct}%)` : ''}</td><td class="r"><b class="warn-text">${money(r.lech_tien)}</b></td></tr>`)}</tbody></table></section>` : null}
    ${!d.data ? html`<${Loading} state=${d} />` : d.data.groups.map((g) => html`<section class="card stack">
      <div class="row between wrap"><b>${g.name}</b><span class="small">Lệch: <b class=${g.total.lech_tien < 0 ? 'warn-text' : ''}>${money(g.total.lech_tien)}</b> · Tồn: ${money(g.total.gia_tri_cuoi)}${g.total.over ? html` · <span class="pill bad">${g.total.over} dòng lệch nhiều</span>` : null}</span></div>
      ${g.rows.length ? html`<div class="table-wrap"><table class="list small nxt"><thead><tr><th>Hàng</th><th class="r">Đầu</th><th class="r">Nhập</th><th class="r" title="Huỷ hoặc sửa phiếu nhập (trừ lại / cộng thêm)">Huỷ/sửa nhập</th><th class="r">Bán</th><th class="r">Xuất</th><th class="r">Huỷ</th><th class="r">Sổ</th><th class="r">Thực tế</th><th class="r">Lệch</th></tr></thead>
        <tbody>${g.rows.map((r) => html`<tr class=${r.over ? 'bad-row' : ''} onClick=${() => setOpen(r)}><td><b>${r.name}</b>${r.recipe ? '' : html` <small class="muted">· trừ khi xuất</small>`}</td>
          <td class="r">${qtyU(r.dau, r.unit)}</td><td class="r">${r.nhap ? qtyU(r.nhap, r.unit) : ''}</td><td class="r">${r.dcnhap ? html`<span class="warn-text">${qtyU(r.dcnhap, r.unit)}</span>` : ''}</td><td class="r">${r.ban ? qtyU(r.ban, r.unit) : ''}</td><td class="r">${r.xuat ? qtyU(r.xuat, r.unit) : ''}</td><td class="r">${r.huy ? qtyU(r.huy, r.unit) : ''}</td>
          <td class="r">${qtyU(r.so, r.unit)}</td><td class="r"><b>${qtyU(r.cuoi, r.unit)}</b></td><td class="r">${r.lech ? html`<b class=${r.lech < 0 ? 'warn-text' : ''}>${qtyU(r.lech, r.unit)}${r.lech_pct != null ? ` (${r.lech_pct}%)` : ''}</b><br /><small>${money(r.lech_tien)}</small>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">Không có phát sinh.</p>`}
    </section>`)}
    ${open ? html`<${Modal} title=${open.name} onClose=${() => setOpen(null)}>${!det.data ? html`<${Loading} state=${det} />` : html`<table class="list small"><tbody>${det.data.map((m) => html`<tr><td>${dt(m.at)}</td><td>${KIND_NXT[m.kind] || 'Chuyển'}</td><td class="r"><b>${qtyU(m.qty, open.unit)}</b></td><td><small>${m.note}${m.staff_name ? ` · ${m.staff_name}` : ''}</small></td></tr>`)}</tbody></table>${!det.data.length ? html`<p class="muted">Không có phát sinh.</p>` : null}`}<//>` : null}
  </div>`;
}

// 🔒 Khoá sổ tháng (chủ quán): đã khoá thì không ai ghi / sửa phát sinh kho ngày cũ
function LockBar({ me, d }) {
  const owner = me.role === 'owner';
  const today = me.today;
  const lastMonthEnd = addDays(`${today.slice(0, 8)}01`, -1);
  const dm = (x) => x.split('-').reverse().join('/');
  if (!owner && !d.lock_until) return null;
  return html`<section class="card row between wrap" style="align-items:center">
    <span class="small">${d.lock_until ? html`🔒 Sổ kho đã khoá đến <b>${dm(d.lock_until)}</b>` : html`🔓 Sổ kho chưa khoá`}</span>
    ${owner ? html`<div class="row tight">
      ${d.lock_until !== lastMonthEnd ? html`<button class="small" onClick=${() => confirm(`Khoá sổ kho đến hết ${dm(lastMonthEnd)}?\nSau khi khoá: không ai nhập / huỷ / kiểm / úp Sapo cho ngày ≤ ${dm(lastMonthEnd)}. App lưu lại bảng Nhập – Xuất – Tồn tháng đó.`) && act(() => api('PUT', '/api/stock/lock', { until: lastMonthEnd }), 'Đã khoá sổ')}>🔒 Khoá hết tháng ${lastMonthEnd.slice(5, 7)}</button>` : null}
      ${d.lock_until ? html`<button class="small" onClick=${() => confirm('Mở khoá sổ kho? (để sửa số tháng cũ, sửa xong nhớ khoá lại)') && act(() => api('PUT', '/api/stock/lock', { until: null }), 'Đã mở khoá')}>Mở khoá</button>` : null}</div>` : null}
  </section>`;
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
    // Ngày đã có món bán trên app trừ kho → hỏi lại (tránh trừ 2 lần)
    const allow = dates.filter((x) => pv.dates.find((d) => d.date === x)?.app_sales);
    if (allow.length && !confirm(`Ngày ${allow.map(ddmm).join(', ')} app đã trừ kho theo món bán (gửi bếp). Úp Sapo nữa sẽ trừ 2 lần.\n\nChỉ bấm OK nếu món bán trên app những ngày đó chỉ là thử.`)) { setBusy(false); return; }
    try { const r = await act(() => api('POST', '/api/sapo/import', { data: file, dates, map, allow_app_days: allow }), 'Đã trừ kho theo bán hàng Sapo'); if (r) { setDone(r); setPv(null); } } finally { setBusy(false); }
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
        <span><b>${ddmm(d.date)}</b> · ${d.invoices} hoá đơn · ${d.qty} món · ${money(d.revenue)}${d.imported ? html` <span class="pill ok">đã nhập</span>` : ''}${d.app_sales && !d.imported ? html` <span class="pill warn">app đã trừ ${d.app_sales} món</span>` : ''}</span></label>`)}</div>
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
  const [menu, setMenu] = useState(false);
  const TAB_ACT = { ton: 'kho.xem', nxt: 'kho.nxt', kiem: 'kho.kiem', linh: 'kho.linh', dat: 'kho.dathang', nl: 'kho.nguyenlieu', quydoi: 'kho.nguyenlieu', ls: 'kho.xem' };
  const tabs = TABS.filter(([k]) => !(meta.data?.single && k === 'linh')).filter(([k, , role]) => (TAB_ACT[k] && me.acts?.[TAB_ACT[k]] === true) || ((!role || atLeast(me, role)) && (!TAB_ACT[k] || can(me, TAB_ACT[k]))));
  const chefOk = me.role === 'owner' || /bếp|lẩu|steak|nướng/i.test(me.team?.name || ''); // sổ công thức: chủ + quản lý bếp (bếp tách riêng phục vụ)
  const ok = new Set(tabs.map(([k]) => k).filter((k) => k !== 'btp' || chefOk));
  const groups = GROUPS.map(([g, l, ks]) => [g, l, ks.filter((k) => ok.has(k))]).filter(([, , ks]) => ks.length);
  const curG = groups.find(([, , ks]) => ks.includes(tab)) || groups[0];
  const more = atLeast(me, 'manager') || (me.role === 'owner' && !me.wh_live);
  return html`<div class="stack">
    <div class="row tight" style="align-items:center"><div class="chips grow">${groups.map(([g, l, ks]) => html`<button class=${`chip ${curG?.[0] === g ? 'on' : ''}`} onClick=${() => navigate(`/kho?tab=${ks[0]}`)}>${l}</button>`)}</div>
      ${more ? html`<button class="small icon" style="align-self:flex-start" aria-label="Thêm" onClick=${() => setMenu(!menu)}>⋯</button>` : null}</div>
    ${curG && curG[2].length > 1 ? html`<div class="chips small-chips">${curG[2].map((k) => html`<button class=${`chip ${tab === k ? 'on' : ''}`} onClick=${() => navigate(`/kho?tab=${k}`)}>${TABS.find((t) => t[0] === k)[1]}</button>`)}</div>` : null}
    ${menu ? html`<section class="card stack tight">
      ${atLeast(me, 'manager') ? html`<button onClick=${() => { setMenu(false); setSapo(true); }}>📊 Nhập bán hàng từ Sapo (trừ kho)</button>` : null}
      ${me.role === 'owner' && !me.wh_live ? html`<button class="link small" onClick=${() => navigate('/kho-tx')}>🚀 Kho mới theo chứng từ (Kho & Tài sản) →</button>` : null}</section>` : null}
    ${sapo ? html`<${SapoImport} onClose=${() => setSapo(false)} />` : null}
    ${!meta.data ? html`<${Loading} state=${meta} />`
      : tab === 'kiem' ? html`<${Count} meta=${meta.data} me=${me} />`
      : tab === 'hh' ? html`<${LossReport} me=${me} />`
      : tab === 'linh' ? html`<${Transfers} me=${me} meta=${meta.data} />`
      : tab === 'dodung' ? html`<${Utensils} me=${me} />`
      : tab === 'dat' ? html`<${Orders} me=${me} meta=${meta.data} />`
      : tab === 'btp' && chefOk ? html`<${Preps} me=${me} meta=${meta.data} />`
      : tab === 'nl' && atLeast(me, 'manager') ? html`<${Setup} meta=${meta.data} />`
      : tab === 'quydoi' && atLeast(me, 'manager') ? html`<${Conversions} meta=${meta.data} />`
      : tab === 'ls' ? html`<${History} me=${me} />`
      : tab === 'nxt' && atLeast(me, 'manager') ? html`<${Nxt} me=${me} />`
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
    if (g.conv_ok || !same(g)) return null; // chủ quán đã ghi "không cần quy đổi"
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
        ${g.why && !dirty ? html`<div class="row between wrap"><small class="warn-text">${g.why}</small>
          <button class="small" onClick=${() => { const n = prompt(`${g.name}: không cần quy đổi, dùng luôn đơn vị "${g.unit}".\nGhi chú để lần sau hiểu (tuỳ chọn):`, `Dùng nguyên ${g.unit}, không bán lẻ`); if (n !== null) act(() => api('POST', `/api/stock/ingredients/${g.id}/conv-ok`, { ok: true, note: n }), `Đã ghi: ${g.name} không cần quy đổi`); }}>✓ Không cần quy đổi</button></div>` : null}
        ${g.conv_ok ? html`<div class="row between wrap"><small class="ok-text">✓ Không cần quy đổi${g.conv_note ? ` · 📝 ${g.conv_note}` : ''}</small>
          <button class="link small" onClick=${() => act(() => api('POST', `/api/stock/ingredients/${g.id}/conv-ok`, { ok: false }), 'Đã bỏ ghi chú')}>Bỏ</button></div>` : null}
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

// Bảng việc bếp theo công đoạn (chủ quán 30/10): sơ chế chung → cân khay → nấu → đóng gói; mỗi thẻ 1 người làm
const LAYER_ORDER = ['secret', 'early', 'prep', 'weigh', 'cook', 'pack'];
export function KitchenTasks({ me }) {
  const d0 = useData('/api/preps/tasks');
  const staff = useData(atLeast(me, 'team_lead') ? '/api/staff?mine=1' : null);
  const [view, setView] = useState(null);
  const [open, setOpen] = useState({});
  const [cook, setCook] = useState(null);
  if (!d0.data) return html`<${Loading} state=${d0} />`;
  const d = d0.data;
  const mode = view || (d.lead ? 'all' : 'mine');
  const staffList = (Array.isArray(staff.data) ? staff.data : staff.data?.staff || []).filter((s) => s.active !== 0 && (s.role === 'owner' || /bếp|lẩu|steak|nướng/i.test(s.team_name || '')));
  const call = (path, body) => act(() => api('POST', `/api/preps/tasks/${path}`, body));
  const list = d.tasks.filter((t) => mode === 'all' || t.mine || (!t.staff_id && !t.done));
  const layerOf = (t) => (t.layer === 'cook' && t.early ? 'early' : t.layer);
  const LBL = { ...d.layers, early: '⏰ Bắt đầu sớm (ninh lâu)' };
  const tickStep = (t, k, on) => act(() => api('POST', `/api/preps/plan/${t.plan_id}/tick`, { step: k, done: on }));
  const card = (t) => {
    const isOpen = open[t.key] ?? (t.mine && !t.done);
    return html`<div class="stack tight" style=${`border-top:1px solid #ddd;padding-top:6px${t.mine ? ';background:#fff7e6' : ''}`} key=${t.key}>
      <div class="row between wrap" style="align-items:center">
        <button class="link" style="text-align:left" onClick=${() => setOpen({ ...open, [t.key]: !isOpen })}><b>${t.done ? '✅ ' : ''}${t.title}</b>${t.layer === 'prep' && t.qty ? html` — <b>${qty(t.qty, t.unit)}</b>` : ''}<br />
          <small class="muted">⏱ ~${mm(t.est)}${t.wait ? ` + chờ ${mm(t.wait)}` : ''}${t.station ? ` · ${t.station}` : ''}${t.staff_name ? ` · 👤 ${t.staff_name}` : ' · chưa giao'}${t.done ? ` · xong${t.minutes != null ? ` ${mm(t.minutes)}` : ''}` : t.started_at ? ' · đang làm' : ''}</small>
          ${t.waiting?.length && !t.done ? html`<br /><small class="warn-text">⏳ Chờ: ${t.waiting.join(' · ')}</small>` : null}</button>
        <div class="row tight">
          ${!t.done && !t.staff_id ? html`<button class="small" onClick=${() => call('claim', { key: t.key })}>✋ Nhận</button>` : null}
          ${!t.done && t.mine && !t.started_at && t.layer !== 'cook' ? html`<button class="small" onClick=${() => call('start', { key: t.key })}>▶ Bắt đầu</button>` : null}
          ${!t.done && t.mine && t.layer === 'cook' && !t.started_at ? html`<button class="small" onClick=${() => call('start', { key: t.key })}>▶ Bắt đầu nấu</button>` : null}
          ${!t.done && (t.mine || d.boss) && t.layer !== 'cook' ? html`<button class="primary small" onClick=${() => call('done', { key: t.key })}>✅ Xong</button>` : null}
          ${!t.done && (t.mine || d.boss) && t.layer === 'cook' ? html`<button class="primary small" onClick=${() => setCook({ p: { id: t.prep_id, name: t.title.replace(/^Nấu /, '').replace(/ × .*$/, ''), out_qty: t.out_qty, out_unit: t.out_unit, active_min: t.active_min }, plan: { id: t.plan_id, batches: t.batches, done_batches: 0 } })}>Ghi mẻ</button>` : null}
          ${t.done && (t.mine || d.lead) && t.layer !== 'cook' ? html`<button class="small" onClick=${() => call('done', { key: t.key, undo: true })}>↩</button>` : null}
        </div></div>
      ${d.lead && !t.done ? html`<select class="auto small" style="align-self:flex-start" value=${t.staff_id || ''} onChange=${(e) => call('assign', { key: t.key, staff_id: e.target.value ? Number(e.target.value) : null })}><option value="">— giao cho —</option>${staffList.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select>` : null}
      ${isOpen ? html`
        ${t.uses ? html`<small class="muted">Dùng cho: ${t.uses.map((u) => `${u.name.split(/[(—]/)[0].trim()} ${qty(u.qty, u.unit)}`).join(' · ')}</small>` : null}
        ${t.lines ? html`<div class="stack tight">${t.lines.map((l) => html`<small style=${l.pack ? 'color:#b45309' : ''}>☐ <b>${Number(l.qty).toLocaleString('vi-VN')} ${l.unit}</b> ${l.name}${l.from ? html` <span class="muted">· ${l.from}</span>` : ''}</small>`)}</div>` : null}
        ${t.packs ? html`<small>📦 ${t.packs}</small>` : null}
        ${t.steps ? html`<div class="stack tight">${t.steps.map((st) => { const tk = (t.ticks || []).find((y) => y.step === st.k); return html`<label class="row tight" style="align-items:flex-start"><input type="checkbox" checked=${!!tk} onChange=${() => tickStep(t, st.k, !tk)} /><small class=${tk ? 'muted' : ''}>${st.text}${st.min ? ` · ⏱ ${st.min * (t.batches || 1)}′` : ''}${st.wait ? ` · ⏳ ${mm(st.wait)}` : ''}</small></label>`; })}</div>`
          : (t.layer === 'cook' || t.layer === 'pack' || t.layer === 'weigh') && !t.mine && !d.boss ? html`<small class="muted">🔒 Chi tiết chỉ người nhận việc thấy.</small>` : t.layer === 'cook' && t.mine && !t.started_at ? html`<small class="muted">Bấm ▶ Bắt đầu nấu để xem các bước.</small>` : null}` : null}
    </div>`;
  };
  return html`<div class="stack">
    <div class="row wrap between" style="align-items:center"><span class="small">Tổng ⏱ ~<b>${mm(d.total_est)}</b> · ${d.tasks.length} việc${d.unassigned ? html` · <span class="warn-text">${d.unassigned} chưa giao</span>` : ''}</span>
      <div class="chips"><button class=${`chip ${mode === 'mine' ? 'on' : ''}`} onClick=${() => setView('mine')}>👤 Việc của tôi</button><button class=${`chip ${mode === 'all' ? 'on' : ''}`} onClick=${() => setView('all')}>👥 Cả bếp</button></div></div>
    ${d.people.length && mode === 'all' ? html`<small class="muted">${d.people.map((p) => `${p.name}: ${p.n} việc ~${mm(p.est)}`).join(' · ')}</small>` : null}
    ${!list.length ? html`<div class="empty">${mode === 'mine' ? 'Chưa có việc nào giao cho bạn. Xem "Cả bếp" để nhận việc.' : 'Hôm nay chưa có việc nấu.'}</div>` : null}
    ${LAYER_ORDER.map((L) => { const ls = list.filter((t) => layerOf(t) === L); return ls.length ? html`<section class="card stack tight"><div class="row between"><b>${LBL[L]}</b><small class="muted">${ls.filter((t) => t.done).length}/${ls.length} xong · ⏱ ~${mm(ls.reduce((n, t) => n + t.est, 0))}</small></div>${ls.map(card)}</section>` : null; })}
    ${cook ? html`<${CookModal} p=${cook.p} plan=${cook.plan} onClose=${() => setCook(null)} />` : null}
  </div>`;
}
