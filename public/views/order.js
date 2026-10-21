import { useState } from 'preact/hooks';
import { html, api, act, useData, Loading, Modal, Field, money, hm, navigate, atLeast } from '../ui.js';

const STATUS = { new: 'Chưa gửi', sent: 'Đã gửi bếp', done: 'Đã ra', cancelled: 'Đã huỷ' };

function AddItem({ item, onAdd, onClose }) {
  const groups = [...new Set(item.options.map((o) => o.group_name))];
  const [pick, setPick] = useState({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [rush, setRush] = useState(false);
  const missing = groups.filter((g) => item.options.some((o) => o.group_name === g && o.required) && !pick[g]);
  const unit = item.price + item.options.filter((o) => pick[o.group_name] === o.id).reduce((n, o) => n + o.price, 0);
  return html`<${Modal} title=${item.name} onClose=${onClose}>
    <div class="stack">
      ${item.description ? html`<p class="muted small">${item.description}</p>` : null}
      ${groups.map((g) => html`<div class="field"><span>${g}${item.options.some((o) => o.group_name === g && o.required) ? ' (bắt buộc)' : ''}</span>
        <div class="chips">${item.options.filter((o) => o.group_name === g).map((o) => html`<button class=${`chip big ${pick[g] === o.id ? 'on' : ''}`}
          onClick=${() => setPick({ ...pick, [g]: pick[g] === o.id ? undefined : o.id })}>${o.name}${o.price ? ` +${money(o.price)}` : ''}</button>`)}</div></div>`)}
      <div class="row">
        <button class="icon big" onClick=${() => setQty(Math.max(1, qty - 1))}>−</button><b class="big-num">${qty}</b><button class="icon big" onClick=${() => setQty(qty + 1)}>+</button>
        <span class="grow r"><b>${money(unit * qty)}</b></span>
      </div>
      <${Field} label="Ghi chú cho bếp"><input id="ai-note" value=${note} placeholder="vd chín kỹ, ít cay, không hành" onInput=${(e) => setNote(e.target.value)} /><//>
      <div class="chips">${['Chín vừa', 'Chín kỹ', 'Ít cay', 'Không hành', 'Ít đá'].map((x) => html`<button class="chip" onClick=${() => setNote(note ? `${note}, ${x.toLowerCase()}` : x)}>${x}</button>`)}</div>
      <label class="check-row"><input type="checkbox" checked=${rush} onChange=${(e) => setRush(e.target.checked)} /> Gấp (in máy Ưu tiên, bếp làm trước)</label>
      <button class="primary big" disabled=${missing.length > 0} onClick=${() => onAdd({ menu_item_id: item.id, option_ids: Object.values(pick).filter(Boolean), qty, note, rush })}>
        ${missing.length ? `Chọn ${missing[0].toLowerCase()}` : `Thêm ${qty} món`}</button>
    </div>
  <//>`;
}

function Reason({ title, chips, onOk, onClose }) {
  const [txt, setTxt] = useState('');
  return html`<${Modal} title=${title} onClose=${onClose}><div class="stack">
    <input id="rs-text" value=${txt} placeholder="Lý do" onInput=${(e) => setTxt(e.target.value)} />
    <div class="chips">${chips.map((x) => html`<button class="chip" onClick=${() => setTxt(x)}>${x}</button>`)}</div>
    <div class="row end"><button onClick=${onClose}>Thôi</button><button class="danger" disabled=${!txt.trim()} onClick=${() => onOk(txt)}>Xác nhận</button></div>
  </div><//>`;
}

function TablePrompt({ title, hint, onOk, onClose }) {
  const [txt, setTxt] = useState('');
  return html`<${Modal} title=${title} onClose=${onClose}><div class="stack">
    <${Field} label="Bàn" hint=${hint}><input id="tp-text" inputmode="numeric" value=${txt} onInput=${(e) => setTxt(e.target.value)} /><//>
    <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" disabled=${!txt.trim()} onClick=${() => onOk(txt)}>Xong</button></div>
  </div><//>`;
}

export function OrderView({ me, query }) {
  const id = Number(query.get('s'));
  const st = useData(id ? `/api/pos/sessions/${id}` : null);
  const menuD = useData('/api/menu');
  const tablesD = useData('/api/pos/tables');
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(null);
  const [reason, setReason] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [tab, setTab] = useState('menu');
  if (!id) return html`<div class="empty">Chọn bàn ở Sơ đồ bàn.</div>`;
  if (!st.data || !menuD.data) return html`<${Loading} state=${st.data ? menuD : st} />`;
  const s = st.data;
  const m = menuD.data;
  const closed = !['open', 'paying'].includes(s.status);
  const catOrder = (cid) => { const k = m.categories.findIndex((c) => c.id === cid); return k < 0 ? 999 : k; };
  const items = m.items.filter((i) => (!cat || i.category_id === Number(cat)) && (!q || i.name.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => catOrder(a.category_id) - catOrder(b.category_id) || a.sort - b.sort || a.id - b.id);
  const drafts = s.items.filter((i) => i.status === 'new');
  const sent = s.items.filter((i) => i.status !== 'new');
  const add = async (body) => { if (await act(() => api('POST', `/api/pos/sessions/${id}/items`, body), 'Đã thêm')) setAdding(null); };
  const quick = (item) => (item.options.length ? setAdding(item) : add({ menu_item_id: item.id, qty: 1 }));
  const send = () => act(() => api('POST', `/api/pos/sessions/${id}/send`), 'Đã gửi bếp');
  const sessions = (tablesD.data?.zones || []).flatMap((z) => z.tables).filter((t) => t.session && t.session.id !== id)
    .map((t) => t.session).filter((x, k, a) => a.findIndex((y) => y.id === x.id) === k);
  return html`<div class="stack order">
    <div class="row between wrap">
      <div><h2>Bàn ${s.header}</h2><small class="muted">Vào lúc ${hm(s.opened_at)} bởi ${s.opened_by_name || ''}${s.status === 'paying' ? ' · đang chờ thanh toán' : ''}</small></div>
      <button onClick=${async () => { if (!closed && !s.items.length) await api('POST', `/api/pos/sessions/${id}/cancel`, { reason: 'Nhận nhầm bàn, chưa gọi món' }).catch(() => {}); navigate('/ban'); }}>← Sơ đồ bàn</button>
    </div>
    ${closed ? html`<p class="warn-text">Bàn này đã đóng (${s.status === 'cancelled' ? 'huỷ' : 'đã thanh toán'}).</p>` : html`
    <div class="row wrap">
      <label class="check-row"><input type="checkbox" checked=${s.priority} onChange=${(e) => act(() => api('PATCH', `/api/pos/sessions/${id}`, { priority: e.target.checked }))} /> Ưu tiên</label>
      <button onClick=${() => { const g = prompt_(s.guests); if (g) act(() => api('PATCH', `/api/pos/sessions/${id}`, { guests: g }), 'Đã sửa số khách'); }}>Số khách${s.guests > 1 ? `: ${s.guests}` : ''}</button>
      <button onClick=${() => setPrompt('move')}>Chuyển bàn</button>
      <button onClick=${() => setPrompt('merge')}>Gộp bàn</button>
    </div>
    <div class="tabs"><button class=${tab === 'menu' ? 'on' : ''} onClick=${() => setTab('menu')}>Thực đơn</button>
      <button class=${tab === 'bill' ? 'on' : ''} onClick=${() => setTab('bill')}>Đã gọi (${s.items.filter((i) => i.status !== 'cancelled').length})</button></div>`}

    ${tab === 'menu' && !closed ? html`
      <input id="om-q" type="search" placeholder="Tìm món" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="chips scroll-x"><button class=${`chip ${!cat ? 'on' : ''}`} onClick=${() => setCat('')}>Tất cả</button>
        ${m.categories.map((c) => html`<button class=${`chip ${cat === String(c.id) ? 'on' : ''}`} onClick=${() => setCat(String(c.id))}>${c.name}</button>`)}</div>
      <div class="menu-grid">${items.map((i) => html`<button class=${`menu-btn ${i.sold_out ? 'soldout' : ''}`} disabled=${i.sold_out} onClick=${() => quick(i)}>
        <b>${i.name}</b><small>${i.sold_out ? 'Hết món' : money(i.price)}</small></button>`)}</div>` : null}

    ${tab === 'bill' || closed ? html`<section class="card">
      ${sent.length ? html`<ul class="plain order-lines">${sent.map((i) => html`<li class=${`ol ${i.status}`}>
        <div class="grow"><b>${i.qty} × ${i.name}</b>${i.rush ? html` <span class="pill bad">Gấp</span>` : null}
          ${i.options.length ? html`<br /><small>${i.options.map((o) => o.name).join(', ')}</small>` : null}${i.note ? html`<br /><small class="muted">${i.note}</small>` : null}
          <br /><small class="muted">${STATUS[i.status]}${i.status === 'cancelled' ? `: ${i.cancel_reason}` : ` · ${hm(i.sent_at)}`}</small></div>
        <div class="r"><span class="num">${money(i.total)}</span>
          ${!closed && i.status !== 'cancelled' ? html`<div class="row tight"><button class="small" onClick=${() => setReason({ kind: 'redo', item: i })}>Làm lại</button><button class="small danger" onClick=${() => setReason({ kind: 'cancel', item: i })}>Huỷ</button></div>` : null}</div>
      </li>`)}</ul>` : html`<p class="muted">Chưa gửi món nào.</p>`}
      <div class="row between total"><b>Tạm tính</b><b class="num">${money(s.subtotal)}</b></div>
    </section>` : null}

    ${!closed ? html`<div class="cart-bar">
      ${drafts.length ? html`<section class="card cart">
        <b>Chưa gửi bếp (${drafts.length})</b>
        <ul class="plain order-lines">${drafts.map((i) => html`<li class="ol new">
          <div class="grow"><b>${i.name}</b>${i.rush ? html` <span class="pill bad">Gấp</span>` : null}${i.options.length ? html`<br /><small>${i.options.map((o) => o.name).join(', ')}</small>` : null}${i.note ? html`<br /><small class="muted">${i.note}</small>` : null}</div>
          <div class="row tight">
            <button class="icon" onClick=${() => (i.qty > 1 ? act(() => api('PATCH', `/api/pos/items/${i.id}`, { qty: i.qty - 1 })) : act(() => api('POST', `/api/pos/items/${i.id}/cancel`, {})))}>−</button>
            <b>${i.qty}</b>
            <button class="icon" onClick=${() => act(() => api('PATCH', `/api/pos/items/${i.id}`, { qty: i.qty + 1 }))}>+</button></div>
        </li>`)}</ul>
      </section>` : null}
      <div class="row">
        <button class="primary big grow" disabled=${!drafts.length} onClick=${send}>${drafts.length ? `Gửi bếp (${drafts.reduce((n, i) => n + i.qty, 0)} món)` : 'Chọn món để gửi bếp'}</button>
        ${s.status === 'open' && !drafts.length && sent.length ? html`<button class="big" onClick=${() => act(() => api('POST', `/api/pos/sessions/${id}/request-bill`), 'Đã báo thu ngân')}>Xin thanh toán</button>` : null}
      </div>
      ${!sent.length ? html`<button class="link danger-text" onClick=${() => act(() => api('POST', `/api/pos/sessions/${id}/cancel`, {}), 'Đã huỷ bàn').then((ok) => ok && navigate('/ban'))}>Huỷ bàn (mở nhầm / khách về)</button>`
        : atLeast(me, 'shift_lead') ? html`<button class="link danger-text" onClick=${() => setReason({ kind: 'close' })}>Huỷ cả bàn…</button>` : null}
    </div>` : null}

    ${adding ? html`<${AddItem} item=${adding} onAdd=${add} onClose=${() => setAdding(null)} />` : null}
    ${reason ? html`<${Reason} title=${reason.kind === 'redo' ? `Làm lại: ${reason.item.name}` : reason.kind === 'cancel' ? `Huỷ: ${reason.item.name}` : 'Huỷ cả bàn'}
      chips=${reason.kind === 'redo' ? ['Khách chê', 'Làm hỏng', 'Sai món', 'Rơi đổ'] : ['Khách đổi ý', 'Gọi nhầm', 'Ra lâu, khách huỷ', 'Hết nguyên liệu']}
      onClose=${() => setReason(null)}
      onOk=${async (txt) => {
        const url = reason.kind === 'close' ? `/api/pos/sessions/${id}/cancel` : `/api/pos/items/${reason.item.id}/${reason.kind === 'redo' ? 'redo' : 'cancel'}`;
        if (await act(() => api('POST', url, { reason: txt }), reason.kind === 'redo' ? 'Đã báo làm lại' : 'Đã huỷ')) { setReason(null); if (reason.kind === 'close') navigate('/ban'); }
      }} />` : null}
    ${prompt === 'move' ? html`<${TablePrompt} title="Chuyển sang bàn" hint="vd 25, hoặc 25, 26 nếu ngồi 2 bàn" onClose=${() => setPrompt(null)}
      onOk=${async (txt) => { if (await act(() => api('POST', `/api/pos/sessions/${id}/move`, { tables: txt }), 'Đã chuyển bàn')) setPrompt(null); }} />` : null}
    ${prompt === 'merge' ? html`<${Modal} title="Gộp bàn khác vào bàn này" onClose=${() => setPrompt(null)}><div class="stack">
      <p class="muted small">Món và khách của bàn được chọn sẽ chuyển sang bàn ${s.header}.</p>
      ${sessions.length ? html`<div class="chips">${sessions.map((x) => html`<button class="chip big" onClick=${async () => { if (await act(() => api('POST', `/api/pos/sessions/${id}/merge`, { from_session_id: x.id }), 'Đã gộp bàn')) setPrompt(null); }}>Bàn ${x.tables.join(', ')}</button>`)}</div>` : html`<p class="muted">Không có bàn nào khác đang mở.</p>`}
    </div><//>` : null}
  </div>`;
}

function prompt_(cur) {
  const x = window.prompt('Số khách', String(cur));
  const n = Number(x);
  return Number.isInteger(n) && n > 0 ? n : null;
}
