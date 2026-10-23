import { useState } from 'preact/hooks';
import { html, api, act, useData, Loading, Modal, Field, money, atLeast } from '../ui.js';

const STATUS = { running: ['ok', 'Đang chạy'], upcoming: ['warn', 'Sắp tới'], ended: ['muted', 'Đã hết'], off: ['muted', 'Đã tắt'] };
const DOW = [['1', 'T2'], ['2', 'T3'], ['3', 'T4'], ['4', 'T5'], ['5', 'T6'], ['6', 'T7'], ['7', 'CN']];
const hmOf = (m) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const isBill = (t) => t === 'bill_percent' || t === 'bill_amount';

function Form({ cur, menu, today, onClose }) {
  const [f, setF] = useState(cur ? { gift_item_ids: [], pair: 'cheapest', ...cur, time_from: hmOf(cur.time_from), time_to: hmOf(cur.time_to) }
    : { name: '', type: 'bogo', pair: 'same', gift_item_ids: [], buy_qty: 1, get_qty: 1, value: '', scope: 'items', item_ids: [], category_ids: [], min_bill: '', stack: false, start_date: today, end_date: today, days: '1234567', time_from: '', time_to: '', note: '', active: true });
  const [notify, setNotify] = useState(!cur);
  const set = (k, val) => setF({ ...f, [k]: val });
  const toggle = (k, id) => set(k, f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id]);
  const save = async () => {
    const body = { ...f, notify };
    const r = await act(() => (cur ? api('PATCH', `/api/promotions/${cur.id}`, body) : api('POST', '/api/promotions', body)), cur ? 'Đã lưu' : 'Đã tạo');
    if (r) { if (r.notified) alert(`Đã báo cho ${r.notified} nhân viên`); onClose(); }
  };
  const bill = isBill(f.type);
  return html`<${Modal} title=${cur ? 'Sửa khuyến mãi' : 'Thêm khuyến mãi'} onClose=${onClose}>
    <div class="stack">
      <${Field} label="Tên chương trình"><input placeholder="vd Mua 1 tặng 1 trà trái cây" value=${f.name} onInput=${(e) => set('name', e.target.value)} /><//>
      <${Field} label="Loại">
        <div class="chips">${[['bogo', 'Mua X tặng Y'], ['gift', 'Mua món A tặng món B'], ['percent', 'Giảm % món'], ['amount', 'Giảm tiền món'], ['bill_percent', 'Giảm % bill'], ['bill_amount', 'Giảm tiền bill']].map(([k, l]) => html`
          <button class=${`chip ${f.type === k ? 'on' : ''}`} onClick=${() => set('type', k)}>${l}</button>`)}</div>
      <//>
      ${f.type === 'bogo' ? html`<div class="row">
        <${Field} label="Mua"><input type="number" min="1" value=${f.buy_qty} onInput=${(e) => set('buy_qty', Number(e.target.value))} /><//>
        <${Field} label="Tặng"><input type="number" min="1" value=${f.get_qty} onInput=${(e) => set('get_qty', Number(e.target.value))} /><//>
      </div>
      <div class="chips"><button class=${`chip ${f.pair === 'same' ? 'on' : ''}`} onClick=${() => set('pair', 'same')}>Tặng đúng món đã mua</button>
        <button class=${`chip ${f.pair !== 'same' ? 'on' : ''}`} onClick=${() => set('pair', 'cheapest')}>Tặng món rẻ nhất trong nhóm</button></div>
      <p class="muted small">${f.pair === 'same' ? 'Vd mua 1 Combo 3 tặng 1 Combo 3; gọi 1 Combo 3 + 1 Steak Âu thì không tặng.' : 'Vd gọi 1 Combo 3 + 1 Steak Âu thì tặng Steak Âu (phần rẻ hơn).'} Phục vụ gọi đủ số phần (cả phần tặng), app tự trừ tiền. Phiếu bếp không ghi "tặng".</p>`
      : f.type === 'gift' ? html`<div class="row">
        <${Field} label="Mua (phần)"><input type="number" min="1" value=${f.buy_qty} onInput=${(e) => set('buy_qty', Number(e.target.value))} /><//>
        <${Field} label="Tặng (phần)"><input type="number" min="1" value=${f.get_qty} onInput=${(e) => set('get_qty', Number(e.target.value))} /><//>
      </div>
      <${Field} label="Món tặng (khách chọn 1 trong các món này)"><div class="stack small">${menu.categories.map((c) => {
        const its = menu.items.filter((i) => i.category_id === c.id);
        const n = its.filter((i) => f.gift_item_ids.includes(i.id)).length;
        return its.length ? html`<details open=${n > 0 || /bò|topping/i.test(c.name)}><summary><b>${c.name}</b>${n ? ` · đã chọn ${n}` : ''}</summary><div class="chips">${its.map((i) => html`<button class=${`chip ${f.gift_item_ids.includes(i.id) ? 'on gift' : ''}`} onClick=${() => toggle('gift_item_ids', i.id)}>${i.name}</button>`)}</div></details>` : null;
      })}</div><//>
      <p class="muted small">Bàn gọi món A là màn gọi món hiện nút xanh "🎁 còn được tặng N phần", phục vụ bấm món khách chọn, món ra bếp bình thường, bill tự trừ tiền.</p>` : html`
        <${Field} label=${f.type.endsWith('percent') ? 'Giảm bao nhiêu %' : 'Giảm bao nhiêu tiền'}><input inputmode="numeric" placeholder=${f.type.endsWith('percent') ? 'vd 30' : 'vd 50000'} value=${f.value} onInput=${(e) => set('value', e.target.value)} /><//>`}
      ${bill ? html`
        <${Field} label="Bill tối thiểu (để trống = mọi bill)"><input inputmode="numeric" placeholder="vd 500000" value=${f.min_bill || ''} onInput=${(e) => set('min_bill', e.target.value)} /><//>
        <label class="check-row"><input type="checkbox" checked=${f.stack} onChange=${(e) => set('stack', e.target.checked)} /> Giảm cả món đang khuyến mãi khác (cộng dồn)</label>` : html`
        <${Field} label=${f.type === 'gift' ? 'Món khách phải mua (món A)' : 'Áp dụng cho'}>
          <div class="chips">${[['items', 'Chọn món'], ['categories', 'Chọn nhóm'], ['all', 'Mọi món']].map(([k, l]) => html`<button class=${`chip ${f.scope === k ? 'on' : ''}`} onClick=${() => set('scope', k)}>${l}</button>`)}</div>
        <//>
        ${f.scope === 'categories' ? html`<div class="chips">${menu.categories.map((c) => html`<button class=${`chip ${f.category_ids.includes(c.id) ? 'on' : ''}`} onClick=${() => toggle('category_ids', c.id)}>${c.name}</button>`)}</div>` : null}
        ${f.scope === 'items' ? html`<div class="stack small">${menu.categories.map((c) => {
          const its = menu.items.filter((i) => i.category_id === c.id);
          return its.length ? html`<div><b>${c.name}</b><div class="chips">${its.map((i) => html`<button class=${`chip ${f.item_ids.includes(i.id) ? 'on' : ''}`} onClick=${() => toggle('item_ids', i.id)}>${i.name}</button>`)}</div></div>` : null;
        })}</div>` : null}`}
      <div class="row">
        <${Field} label="Từ ngày"><input type="date" value=${f.start_date} onInput=${(e) => set('start_date', e.target.value)} /><//>
        <${Field} label="Đến ngày"><input type="date" value=${f.end_date} onInput=${(e) => set('end_date', e.target.value)} /><//>
      </div>
      <${Field} label="Ngày trong tuần">
        <div class="chips">${DOW.map(([k, l]) => html`<button class=${`chip ${f.days.includes(k) ? 'on' : ''}`} onClick=${() => set('days', f.days.includes(k) ? f.days.replace(k, '') : [...f.days + k].sort().join(''))}>${l}</button>`)}</div>
      <//>
      <div class="row">
        <${Field} label="Giờ từ (trống = cả ngày)"><input type="time" value=${f.time_from} onInput=${(e) => set('time_from', e.target.value)} /><//>
        <${Field} label="Đến"><input type="time" value=${f.time_to} onInput=${(e) => set('time_to', e.target.value)} /><//>
      </div>
      <${Field} label="Dặn nhân viên"><textarea rows="2" placeholder="vd Mời khách khi order nước; chỉ áp tại bàn" value=${f.note} onInput=${(e) => set('note', e.target.value)}></textarea><//>
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
