import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, Modal, Field, money, atLeast, SaveInput } from '../ui.js';

const vnd = (n) => money(n);

function ItemForm({ init, menu, kits, ingredients, onClose }) {
  const [f, setF] = useState({
    name: init.name || '', description: init.description || '', price: init.price ?? '', category_id: init.category_id ?? '',
    station_id: init.station_id ?? '', kit_id: init.kit_id ?? '', active: init.active ?? true,
    parts: (init.parts || []).map((p) => ({ ...p })), options: (init.options || []).map((o) => ({ ...o })), recipe: (init.recipe || []).map((r) => ({ ...r })),
  });
  const set = (k, val) => setF({ ...f, [k]: val });
  const row = (k, i, key, val) => set(k, f[k].map((x, j) => (j === i ? { ...x, [key]: val } : x)));
  const drop = (k, i) => set(k, f[k].filter((_, j) => j !== i));
  const save = async () => {
    const body = { ...f, category_id: f.category_id || null, station_id: f.station_id || null, kit_id: f.kit_id || null };
    const ok = await act(() => (init.id ? api('PATCH', `/api/menu/items/${init.id}`, body) : api('POST', '/api/menu/items', body)), 'Đã lưu món');
    if (ok) onClose();
  };
  const stationSel = (val, onChange, label = 'Điểm in') => html`<select value=${val ?? ''} aria-label=${label} onChange=${(e) => onChange(e.target.value)}>
    <option value="">(không in)</option>${menu.stations.filter((s) => s.active).map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select>`;
  return html`<${Modal} title=${init.id ? `Sửa: ${init.name}` : 'Thêm món'} onClose=${onClose} wide>
    <div class="stack">
      <div class="form-grid">
        <${Field} label="Tên món"><input id="mi-name" value=${f.name} onInput=${(e) => set('name', e.target.value)} /><//>
        <${Field} label="Giá (đ)"><input id="mi-price" inputmode="numeric" value=${f.price} onInput=${(e) => set('price', e.target.value.replace(/\D/g, ''))} /><//>
        <${Field} label="Danh mục"><select id="mi-cat" value=${f.category_id} onChange=${(e) => set('category_id', e.target.value)}>
          <option value="">(chưa chọn)</option>${menu.categories.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select><//>
        <${Field} label="In ra máy" hint="Combo in nhiều máy thì thêm ở mục Phần bên dưới">${stationSel(f.station_id, (x) => set('station_id', x))}<//>
        <${Field} label="Bộ dụng cụ" hint="Để dự trù dao, nĩa, đũa…"><select value=${f.kit_id} onChange=${(e) => set('kit_id', e.target.value)}>
          <option value="">(không tính)</option>${kits.map((k) => html`<option value=${k.id}>${k.name}</option>`)}</select><//>
        <${Field} label="Mô tả"><input value=${f.description} placeholder="vd 100g bò, 1 trứng" onInput=${(e) => set('description', e.target.value)} /><//>
      </div>

      <div class="field"><span>Tuỳ chọn (vd Sốt: Tứ xuyên / Kem phô mai / Tiêu đen)</span>
        ${f.options.map((o, i) => html`<div class="item-row">
          <input class="unit" value=${o.group_name} placeholder="Nhóm" aria-label="Nhóm" onInput=${(e) => row('options', i, 'group_name', e.target.value)} />
          <input class="grow" value=${o.name} placeholder="Tên" aria-label="Tên tuỳ chọn" onInput=${(e) => row('options', i, 'name', e.target.value)} />
          <input class="num-in" inputmode="numeric" value=${o.price || ''} placeholder="+0đ" aria-label="Giá thêm" onInput=${(e) => row('options', i, 'price', e.target.value.replace(/\D/g, ''))} />
          <label class="check-row small"><input type="checkbox" checked=${o.required} onChange=${(e) => row('options', i, 'required', e.target.checked)} />Bắt chọn</label>
          <button class="icon" aria-label="Bỏ" onClick=${() => drop('options', i)}>✕</button></div>`)}
        <button class="link" onClick=${() => set('options', [...f.options, { group_name: f.options.at(-1)?.group_name || 'Sốt', name: '', price: 0, required: true }])}>+ Thêm tuỳ chọn</button>
      </div>

      <div class="field"><span>Phần in ra nhiều máy (combo). Để trống = cả món in ra máy ở trên</span>
        ${f.parts.map((p, i) => html`<div class="item-row">
          <input class="grow" value=${p.label} placeholder="vd Ngăn nước lẩu Mala" aria-label="Tên phần" onInput=${(e) => row('parts', i, 'label', e.target.value)} />
          ${stationSel(p.station_id, (x) => row('parts', i, 'station_id', x))}
          <button class="icon" aria-label="Bỏ" onClick=${() => drop('parts', i)}>✕</button></div>`)}
        <button class="link" onClick=${() => set('parts', [...f.parts, { label: '', station_id: f.station_id }])}>+ Thêm phần</button>
      </div>

      <div class="field"><span>Công thức trừ kho (1 phần món dùng bao nhiêu)</span>
        ${!ingredients.length ? html`<p class="muted small">Chưa có nguyên liệu. Thêm ở Kho → Nguyên liệu & NCC rồi quay lại.</p>` : null}
        ${f.recipe.map((x, i) => html`<div class="item-row">
          <select class="grow" value=${x.ingredient_id} aria-label="Nguyên liệu" onChange=${(e) => row('recipe', i, 'ingredient_id', Number(e.target.value))}>
            ${ingredients.map((g) => html`<option value=${g.id}>${g.name} (${g.unit})</option>`)}</select>
          <input class="num-in" inputmode="decimal" value=${x.qty} aria-label="Lượng" onInput=${(e) => row('recipe', i, 'qty', e.target.value)} />
          <span class="muted small">${ingredients.find((g) => g.id === Number(x.ingredient_id))?.unit || ''}</span>
          <button class="icon" aria-label="Bỏ" onClick=${() => drop('recipe', i)}>✕</button></div>`)}
        ${ingredients.length ? html`<button class="link" onClick=${() => set('recipe', [...f.recipe, { ingredient_id: ingredients[0].id, qty: '' }])}>+ Thêm nguyên liệu</button>` : null}
      </div>

      ${init.id ? html`<label class="check-row"><input type="checkbox" checked=${f.active} onChange=${(e) => set('active', e.target.checked)} /> Đang bán (bỏ chọn để ẩn khỏi thực đơn)</label>` : null}
      <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>Lưu</button></div>
    </div>
  <//>`;
}

// Chuyển nhiều món sang 1 điểm in: chọn nhóm (hoặc tìm tên) → tick món → chọn điểm in → Chuyển (chủ quán 29/10)
function MoveToStation({ menu }) {
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [to, setTo] = useState('');
  const [off, setOff] = useState({}); // món bỏ tick
  const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const stName = (id) => menu.stations.find((s) => s.id === id)?.name || 'không in';
  const list = (cat || q) ? menu.items.filter((i) => (!cat || i.category_id === Number(cat)) && (!q || fold(i.name).includes(fold(q)))) : [];
  const picked = list.filter((i) => !off[i.id] && !i.parts?.length);
  return html`<section class="card stack">
    <h3>🔀 Chuyển món sang điểm in khác</h3>
    <small class="muted">Chọn nhóm món (hoặc gõ tên), bỏ tick món không chuyển, chọn điểm in rồi bấm Chuyển. Món combo in nhiều máy thì sửa riêng trong món.</small>
    <div class="row wrap">
      <select value=${cat} onChange=${(e) => { setCat(e.target.value); setOff({}); }}><option value="">— Chọn nhóm món —</option>${menu.categories.map((c) => html`<option value=${c.id}>${c.name} (${menu.items.filter((i) => i.category_id === c.id).length})</option>`)}</select>
      <input type="search" class="grow" placeholder="…hoặc gõ tên, vd nướng" value=${q} onInput=${(e) => { setQ(e.target.value); setOff({}); }} />
    </div>
    ${list.length ? html`<div class="sapo-list">${list.map((i) => html`<label class="check-row"><input type="checkbox" disabled=${!!i.parts?.length} checked=${!off[i.id] && !i.parts?.length} onChange=${(e) => setOff({ ...off, [i.id]: !e.target.checked })} />
      <span>${i.name} <small class="muted">· đang in: ${i.parts?.length ? 'combo nhiều máy (sửa riêng)' : stName(i.station_id)}</small></span></label>`)}</div>` : (cat || q) ? html`<small class="muted">Không có món nào.</small>` : null}
    ${list.length ? html`<div class="row wrap">
      <select value=${to} onChange=${(e) => setTo(e.target.value)}><option value="">— Chuyển sang điểm in —</option>${menu.stations.map((s) => html`<option value=${s.id}>${s.name}${s.printer_ip ? ` (${s.printer_ip})` : ' (chưa có IP)'}</option>`)}</select>
      <button class="primary" disabled=${!to || !picked.length} onClick=${async () => { const r = await act(() => api('POST', '/api/menu/items/station', { station_id: Number(to), item_ids: picked.map((i) => i.id) }), `Đã chuyển ${picked.length} món sang ${stName(Number(to))}`); if (r) setOff({}); }}>Chuyển ${picked.length} món</button></div>` : null}
  </section>`;
}

function Stations({ menu }) {
  const [nn, setNn] = useState('');
  return html`<section class="card stack">
    <h3>Điểm in & máy in</h3>
    <p class="muted small">Mỗi điểm 1 máy in LAN (IP dán trên máy). Máy lỗi hoặc hết giấy thì in sang <b>máy dự phòng</b>. Cầu nối in ở quán sẽ dùng các IP này.</p>
    ${menu.stations.map((s) => html`<div class="row wrap st-row" key=${s.id}>
      <${SaveInput} class="grow" value=${s.name} aria-label="Tên điểm in" onSave=${(val) => act(() => api('PATCH', `/api/kitchen-stations/${s.id}`, { name: val }), 'Đã lưu')} />
      <${SaveInput} class="ip-in" value=${s.printer_ip} placeholder="IP, vd 192.168.1.234" aria-label="IP máy in" onSave=${(val) => act(() => api('PATCH', `/api/kitchen-stations/${s.id}`, { printer_ip: val.trim() }), 'Đã lưu IP')} />
      <select value=${s.fallback_station_id ?? ''} aria-label="Máy dự phòng" onChange=${(e) => act(() => api('PATCH', `/api/kitchen-stations/${s.id}`, { fallback_station_id: e.target.value || null }), 'Đã lưu')}>
        <option value="">Không dự phòng</option>${menu.stations.filter((x) => x.id !== s.id).map((x) => html`<option value=${x.id}>Lỗi → in ${x.name}</option>`)}</select>
      <label class="row small">Báo trễ sau <${SaveInput} class="num-in" type="number" min="1" value=${s.late_minutes ?? 10} onSave=${(val) => act(() => api('PATCH', `/api/kitchen-stations/${s.id}`, { late_minutes: val }), 'Đã lưu')} /> phút</label>
      ${!s.printer_ip ? html`<span class="pill warn">Chưa có IP</span>` : null}
    </div>`)}
    <div class="row"><input class="grow" placeholder="Điểm in mới, vd Nướng" value=${nn} onInput=${(e) => setNn(e.target.value)} />
      <button disabled=${!nn.trim()} onClick=${async () => { if (await act(() => api('POST', '/api/kitchen-stations', { name: nn }), 'Đã thêm')) setNn(''); }}>Thêm</button></div>
  </section>`;
}

export function MenuView({ me }) {
  const st = useData('/api/menu?all=1');
  const kitsD = useData('/api/utensils');
  const ingD = useData(atLeast(me, 'manager') ? '/api/stock/meta' : null);
  const [cat, setCat] = useState('');
  const [noRecipe, setNoRecipe] = useState(false); // lọc món chưa có định lượng (chủ quán 26/10)
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const [tab, setTab] = useState('mon');
  const [newCat, setNewCat] = useState('');
  if (!st.data) return html`<${Loading} state=${st} />`;
  const m = st.data;
  const manager = atLeast(me, 'manager');
  const stName = (id) => m.stations.find((s) => s.id === id)?.name || '';
  const catOrder = (id) => { const k = m.categories.findIndex((c) => c.id === id); return k < 0 ? 999 : k; };
  const missing = m.items.filter((i) => i.active && !i.recipe.length);
  const items = m.items.filter((i) => (!noRecipe || (i.active && !i.recipe.length)) && (!cat || i.category_id === Number(cat)) && (!q || i.name.toLowerCase().includes(q.toLowerCase())) && (manager || i.active))
    .sort((a, b) => catOrder(a.category_id) - catOrder(b.category_id) || a.sort - b.sort || a.id - b.id);
  const catName = (id) => m.categories.find((c) => c.id === id)?.name || 'Chưa có danh mục';
  const soldOut = m.items.filter((i) => i.sold_out && i.active);
  const ingredients = (ingD.data?.ingredients || []).filter((g) => g.active !== false);
  return html`<div class="stack">
    ${manager ? html`<div class="tabs"><button class=${tab === 'mon' ? 'on' : ''} onClick=${() => setTab('mon')}>Món</button><button class=${tab === 'in' ? 'on' : ''} onClick=${() => setTab('in')}>Điểm in</button></div>` : null}
    ${tab === 'in' && manager ? html`<${Stations} menu=${m} /><${MoveToStation} menu=${m} />` : html`
    <div class="row between wrap">
      <input id="menu-q" type="search" placeholder="Tìm món" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="row">
        ${soldOut.length && atLeast(me, 'shift_lead') ? html`<button onClick=${() => act(() => api('POST', '/api/menu/reset-sold-out'), 'Đã mở bán lại')}>Mở bán lại ${soldOut.length} món hết</button>` : null}
        ${manager ? html`<button class="primary" onClick=${() => setEdit({ category_id: cat ? Number(cat) : '' })}>+ Thêm món</button>` : null}
      </div>
    </div>
    ${manager && missing.length ? html`<button class=${`chip ${noRecipe ? 'on' : ''}`} style="align-self:flex-start" onClick=${() => setNoRecipe(!noRecipe)}>⚠ ${missing.length} món chưa có định lượng${noRecipe ? ' · bỏ lọc' : ' · xem'}</button>` : null}
    <div class="chips"><button class=${`chip ${!cat ? 'on' : ''}`} onClick=${() => setCat('')}>Tất cả <small>${m.items.filter((i) => i.active).length}</small></button>
      ${m.categories.map((c) => html`<button class=${`chip ${cat === String(c.id) ? 'on' : ''} ${c.active ? '' : 'off'}`} onClick=${() => setCat(String(c.id))}>${c.name} <small>${m.items.filter((i) => i.category_id === c.id && i.active).length}</small></button>`)}</div>
    ${manager ? html`<div class="row"><input class="grow" placeholder="Danh mục mới" value=${newCat} onInput=${(e) => setNewCat(e.target.value)} />
      <button disabled=${!newCat.trim()} onClick=${async () => { if (await act(() => api('POST', '/api/menu/categories', { name: newCat }), 'Đã thêm danh mục')) setNewCat(''); }}>Thêm danh mục</button></div>` : null}
    <section class="card menu-list">
      ${items.map((i, k) => html`${!cat && (k === 0 || items[k - 1].category_id !== i.category_id) ? html`<div class="menu-cat">${catName(i.category_id)}</div>` : null}<div class=${`menu-row ${i.active ? '' : 'off'} ${i.sold_out ? 'soldout' : ''}`} key=${i.id}>
        <button class="grow menu-main" disabled=${!manager} onClick=${() => setEdit(i)}>
          <b>${i.name}</b> ${!i.active ? html`<span class="pill muted">Ẩn</span>` : null}${manager && i.active && !i.recipe.length ? html`<span class="pill warn">chưa định lượng</span>` : null}${i.sold_out ? html`<span class="pill bad">Hết</span>` : null}
          <br /><small class="muted">${i.description}${i.description ? ' · ' : ''}${i.parts.length ? i.parts.map((p) => stName(p.station_id)).filter((x, k, a) => a.indexOf(x) === k).join(' + ') : stName(i.station_id) || 'không in'}${i.options.length ? ` · ${[...new Set(i.options.map((o) => o.group_name))].join(', ')}` : ''}${i.recipe.length ? ` · ${i.recipe.length} NL` : ''}</small>
        </button>
        <b class="num">${vnd(i.price)}</b>
        ${atLeast(me, 'team_lead') && i.active ? html`<button class=${`small ${i.sold_out ? 'primary' : ''}`} onClick=${() => act(() => api('PATCH', `/api/menu/items/${i.id}`, { sold_out: !i.sold_out }), i.sold_out ? 'Đã bán lại' : 'Đã báo hết món')}>${i.sold_out ? 'Bán lại' : 'Hết'}</button>` : null}
      </div>`)}
      ${!items.length ? html`<div class="empty">Không có món nào.</div>` : null}
    </section>`}
    ${edit ? html`<${ItemForm} init=${edit} menu=${m} kits=${(kitsD.data?.kits || []).filter((k) => k.active)} ingredients=${ingredients} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}
