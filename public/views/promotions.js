import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, Modal, Field, money, atLeast } from '../ui.js';

const STATUS = { running: ['ok', 'Đang chạy'], upcoming: ['warn', 'Sắp tới'], ended: ['muted', 'Đã hết'], off: ['muted', 'Đã tắt'] };
const DOW = [['1', 'T2'], ['2', 'T3'], ['3', 'T4'], ['4', 'T5'], ['5', 'T6'], ['6', 'T7'], ['7', 'CN']];
const hmOf = (m) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const isBill = (t) => t === 'bill_percent' || t === 'bill_amount';

// Chọn món gọn: hàng chip tên nhóm (bấm = cả nhóm); "Chọn từng món" mở 1 nhóm để chọn món lẻ
function Picker({ menu, items, cats, onItems, onCats, allowCats = true, openRe }) {
  const groups = menu.categories.filter((c) => menu.items.some((i) => i.category_id === c.id));
  const first = groups.find((c) => items.some((id) => menu.items.find((i) => i.id === id)?.category_id === c.id)) || (openRe && groups.find((c) => openRe.test(c.name)));
  const [open, setOpen] = useState(allowCats ? null : first?.id ?? null);
  const its = open ? menu.items.filter((i) => i.category_id === open) : [];
  const picked = items.map((id) => menu.items.find((i) => i.id === id)).filter(Boolean);
  return html`<div class="stack small">
    ${allowCats ? html`<div class="chips">${groups.map((c) => html`<button class=${`chip big ${cats.includes(c.id) ? 'on' : ''}`} onClick=${() => onCats(cats.includes(c.id) ? cats.filter((x) => x !== c.id) : [...cats, c.id])}>${cats.includes(c.id) ? '✓ ' : ''}${c.name}</button>`)}</div>
      <span class="muted">Bấm tên nhóm = áp dụng cả nhóm. Chỉ vài món thì chọn từng món:</span>` : null}
    <select value=${open || ''} onChange=${(e) => setOpen(Number(e.target.value) || null)}>
      <option value="">${allowCats ? '— Chọn từng món: chọn nhóm —' : '— Chọn nhóm món —'}</option>${groups.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select>
    ${its.length ? html`<div class="chips">${its.map((i) => html`<button class=${`chip ${items.includes(i.id) ? 'on' : ''}`} onClick=${() => onItems(items.includes(i.id) ? items.filter((x) => x !== i.id) : [...items, i.id])}>${items.includes(i.id) ? '✓ ' : ''}${i.name}</button>`)}</div>` : null}
    ${picked.length ? html`<div>Đã chọn: ${picked.map((i) => html`<span class="pill">${i.name} <button class="link" aria-label="Bỏ" onClick=${() => onItems(items.filter((x) => x !== i.id))}>✕</button></span> `)}</div>` : null}
  </div>`;
}

const KIND = { give: 'Mua tặng', item: 'Giảm giá món', bill: 'Giảm cả bill' };
const kindOf = (t) => (t === 'bogo' || t === 'gift' ? 'give' : t === 'percent' || t === 'amount' ? 'item' : 'bill');

function Form({ cur, menu, today, onClose }) {
  const [f, setF] = useState(cur ? { gift_item_ids: [], pair: 'cheapest', ...cur, time_from: hmOf(cur.time_from), time_to: hmOf(cur.time_to) }
    : { name: '', type: 'bogo', pair: 'same', gift_item_ids: [], buy_qty: 1, get_qty: 1, value: '', scope: 'items', item_ids: [], category_ids: [], min_bill: '', stack: false, start_date: today, end_date: today, days: '1234567', time_from: '', time_to: '', note: '', active: true });
  const [notify, setNotify] = useState(!cur);
  const set = (k, val) => setF({ ...f, [k]: val });
  const kind = kindOf(f.type);
  const sameGift = f.type === 'bogo';
  const nameOf = (id) => menu.items.find((i) => i.id === id)?.name;
  const buyText = [...f.category_ids.map((id) => `cả nhóm ${menu.categories.find((c) => c.id === id)?.name}`), ...f.item_ids.map(nameOf)].filter(Boolean).join(', ');
  const giftText = f.gift_item_ids.map(nameOf).filter(Boolean).join(' / ');
  const save = async () => {
    // Phạm vi: chọn cả nhóm → theo nhóm; có cả món lẻ thì gộp thành danh sách món
    const cats = f.category_ids;
    const items = cats.length && f.item_ids.length ? [...new Set([...f.item_ids, ...menu.items.filter((i) => cats.includes(i.category_id)).map((i) => i.id)])] : f.item_ids;
    const scope = kind === 'bill' ? 'all' : cats.length && !f.item_ids.length ? 'categories' : 'items';
    const body = { ...f, scope, item_ids: scope === 'items' ? items : [], category_ids: scope === 'categories' ? cats : [], notify };
    const r = await act(() => (cur ? api('PATCH', `/api/promotions/${cur.id}`, body) : api('POST', '/api/promotions', body)), cur ? 'Đã lưu' : 'Đã tạo');
    if (r) { if (r.notified) alert(`Đã báo cho ${r.notified} nhân viên`); onClose(); }
  };
  const preview = kind === 'give'
    ? (buyText ? `Khách gọi ${f.buy_qty} phần ${buyText.split(', ')[0]}${sameGift ? ` + thêm ${f.get_qty} phần y vậy → tính tiền ${f.buy_qty} phần` : ` → được tặng ${f.get_qty} phần ${giftText || '(chưa chọn món tặng)'}`}` : 'Chọn món khách mua ở bước 1')
    : '';
  return html`<${Modal} title=${cur ? 'Sửa khuyến mãi' : 'Thêm khuyến mãi'} onClose=${onClose}>
    <div class="stack">
      <${Field} label="Tên chương trình"><input placeholder="vd Mua 1 tặng 1 steak" value=${f.name} onInput=${(e) => set('name', e.target.value)} /><//>
      <div class="tabs">${Object.entries(KIND).map(([k, l]) => html`<button class=${kind === k ? 'on' : ''} onClick=${() => set('type', k === 'give' ? 'bogo' : k === 'item' ? 'percent' : 'bill_percent')}>${l}</button>`)}</div>

      ${kind === 'give' ? html`
        <div class="promo-step"><b>① Khách mua món gì?</b>
          <${Picker} menu=${menu} items=${f.item_ids} cats=${f.category_ids} onItems=${(x) => set('item_ids', x)} onCats=${(x) => set('category_ids', x)} openRe=${/steak|lẩu/i} /></div>
        <div class="promo-step"><b>② Mua mấy tặng mấy?</b>
          <div class="row"><${Field} label="Mua (phần)"><input type="number" min="1" value=${f.buy_qty} onInput=${(e) => set('buy_qty', Number(e.target.value))} /><//>
          <${Field} label="Tặng (phần)"><input type="number" min="1" value=${f.get_qty} onInput=${(e) => set('get_qty', Number(e.target.value))} /><//></div></div>
        <div class="promo-step"><b>③ Tặng món gì?</b>
          <div class="chips"><button class=${`chip big ${sameGift ? 'on' : ''}`} onClick=${() => setF({ ...f, type: 'bogo', pair: 'same' })}>Đúng món khách mua</button>
            <button class=${`chip big ${!sameGift ? 'on' : ''}`} onClick=${() => set('type', 'gift')}>Món khác</button></div>
          ${!sameGift ? html`<${Picker} menu=${menu} items=${f.gift_item_ids} cats=${[]} allowCats=${false} onItems=${(x) => set('gift_item_ids', x)} onCats=${() => {}} openRe=${/bò tươi/i} />` : null}
        </div>
        <div class="promo-preview">🎁 ${preview}</div>
        <p class="muted small">${sameGift ? 'Phục vụ gọi đủ số phần (cả phần tặng), bill tự trừ. Phiếu bếp in bình thường.' : 'Gọi món ở ① xong, màn gọi món hiện nút xanh "Thêm món tặng"; phục vụ bấm là món tặng ra bếp, bill tự trừ.'}</p>`
      : kind === 'item' ? html`
        <div class="promo-step"><b>① Giảm món nào?</b>
          <${Picker} menu=${menu} items=${f.item_ids} cats=${f.category_ids} onItems=${(x) => set('item_ids', x)} onCats=${(x) => set('category_ids', x)} /></div>
        <div class="promo-step"><b>② Giảm bao nhiêu?</b>
          <div class="chips"><button class=${`chip ${f.type === 'percent' ? 'on' : ''}`} onClick=${() => set('type', 'percent')}>Theo %</button><button class=${`chip ${f.type === 'amount' ? 'on' : ''}`} onClick=${() => set('type', 'amount')}>Theo số tiền / phần</button></div>
          <input inputmode="numeric" placeholder=${f.type === 'percent' ? 'vd 20 (%)' : 'vd 10000 (đ)'} value=${f.value} onInput=${(e) => set('value', e.target.value)} /></div>`
      : html`
        <div class="promo-step"><b>① Giảm bao nhiêu?</b>
          <div class="chips"><button class=${`chip ${f.type === 'bill_percent' ? 'on' : ''}`} onClick=${() => set('type', 'bill_percent')}>Theo %</button><button class=${`chip ${f.type === 'bill_amount' ? 'on' : ''}`} onClick=${() => set('type', 'bill_amount')}>Theo số tiền</button></div>
          <input inputmode="numeric" placeholder=${f.type === 'bill_percent' ? 'vd 10 (%)' : 'vd 50000 (đ)'} value=${f.value} onInput=${(e) => set('value', e.target.value)} /></div>
        <${Field} label="Bill tối thiểu (để trống = mọi bill)"><input inputmode="numeric" placeholder="vd 500000" value=${f.min_bill || ''} onInput=${(e) => set('min_bill', e.target.value)} /><//>
        <label class="check-row"><input type="checkbox" checked=${f.stack} onChange=${(e) => set('stack', e.target.checked)} /> Giảm cả món đang khuyến mãi khác (cộng dồn)</label>`}

      <div class="promo-step"><b>${kind === 'give' ? '④' : kind === 'item' ? '③' : '②'} Thời gian</b>
        <div class="row">
          <${Field} label="Từ ngày"><input type="date" value=${f.start_date} onInput=${(e) => set('start_date', e.target.value)} /><//>
          <${Field} label="Đến ngày"><input type="date" value=${f.end_date} onInput=${(e) => set('end_date', e.target.value)} /><//>
        </div>
        <details><summary class="small">Chỉ một số ngày / giờ (không bắt buộc)</summary>
          <div class="chips">${DOW.map(([k, l]) => html`<button class=${`chip ${f.days.includes(k) ? 'on' : ''}`} onClick=${() => set('days', f.days.includes(k) ? f.days.replace(k, '') : [...f.days + k].sort().join(''))}>${l}</button>`)}</div>
          <div class="row">
            <${Field} label="Giờ từ"><input type="time" value=${f.time_from} onInput=${(e) => set('time_from', e.target.value)} /><//>
            <${Field} label="Đến"><input type="time" value=${f.time_to} onInput=${(e) => set('time_to', e.target.value)} /><//>
          </div></details>
      </div>
      <${Field} label="Dặn nhân viên"><textarea rows="2" placeholder="vd Mời khách khi order steak" value=${f.note} onInput=${(e) => set('note', e.target.value)}></textarea><//>
      <label class="check-row"><input type="checkbox" checked=${notify} onChange=${(e) => setNotify(e.target.checked)} /> Gửi thông báo cho mọi nhân viên</label>
      <div class="row end">
        ${cur ? html`<button class="danger" onClick=${() => confirm('Xoá chương trình này?') && act(() => api('DELETE', `/api/promotions/${cur.id}`), 'Đã xoá').then((ok) => ok && onClose())}>Xoá</button>` : null}
        <button onClick=${onClose}>Thôi</button><button class="primary" onClick=${save}>${cur ? 'Lưu' : 'Tạo & báo nhân viên'}</button>
      </div>
    </div>
  <//>`;
}

export function PromotionsView({ me }) {
  const st = useData('/api/promotions');
  const menuD = useData('/api/menu');
  const [edit, setEdit] = useState(null);
  if (!st.data || !menuD.data) return html`<${Loading} state=${st.data ? menuD : st} />`;
  const manager = atLeast(me, 'manager');
  const order = { running: 0, upcoming: 1, off: 2, ended: 3 };
  const list = [...st.data.items].sort((a, b) => order[a.status] - order[b.status]);
  return html`<div class="stack">
    <div class="row between wrap"><h2>Khuyến mãi</h2>${manager ? html`<button class="primary" onClick=${() => setEdit('new')}>+ Thêm chương trình</button>` : null}</div>
    <p class="muted small">Chỉ đổi tiền trên bill; menu và phiếu bếp không đổi. Hết ngày kết thúc app tự ngừng.</p>
    ${!list.length ? html`<div class="empty">Chưa có chương trình nào.</div>` : null}
    ${list.map((p) => html`<div class=${`card stack promo-card ${p.status === 'ended' || p.status === 'off' ? 'dim' : ''}`}>
      <div class="row between wrap"><b>🎁 ${p.name}</b><span class=${`pill ${STATUS[p.status][0]}`}>${STATUS[p.status][1]}</span></div>
      <div>${p.summary}</div>
      ${p.note ? html`<div class="muted small">Dặn: ${p.note}</div>` : null}
      ${manager ? html`<div class="row wrap">
        <button class="small" onClick=${() => setEdit(p)}>Sửa</button>
        ${p.status !== 'ended' ? html`<button class="small" onClick=${() => act(() => api('PATCH', `/api/promotions/${p.id}`, { active: !p.active }), p.active ? 'Đã tắt' : 'Đã bật')}>${p.active ? 'Tắt ngay' : 'Bật lại'}</button>` : null}
      </div>` : null}
    </div>`)}
    ${edit ? html`<${Form} cur=${edit === 'new' ? null : edit} menu=${menuD.data} today=${me.today} onClose=${() => setEdit(null)} />` : null}
  </div>`;
}

export { money };
