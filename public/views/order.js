import { useState } from 'preact/hooks';
import { html, api, act, useData, Loading, Modal, Field, money, hm, navigate, atLeast, toast, bump } from '../ui.js';
import { PayModal, PaidPanel } from './pay.js';

const STATUS = { new: 'Chưa gửi', sent: 'Đã gửi bếp', done: 'Đã ra', cancelled: 'Đã huỷ' };

// Ghi chú nhanh theo nhóm món (bếp chỉ thấy cái liên quan)
const QUICK_NOTES = [
  [/steak|món xào/i, ['Chín vừa', 'Chín kỹ']],
  [/lẩu|bò tươi|topping|rau|xiên/i, ['Ít cay', 'Không cay', 'Không hành']],
  [/cà phê|trà|nước|bia|soju/i, ['Ít đá', 'Không đá', 'Ít ngọt']],
];
const notesFor = (catName) => QUICK_NOTES.find(([re]) => re.test(catName || ''))?.[1] || [];

function AddItem({ item, onAdd, onClose, catName = '' }) {
  const groups = [...new Set(item.options.map((o) => o.group_name))];
  const [pick, setPick] = useState({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [rush, setRush] = useState(false);
  const [warn, setWarn] = useState(false);
  const missing = groups.filter((g) => item.options.some((o) => o.group_name === g && o.required) && !pick[g]);
  const unit = item.price + item.options.filter((o) => pick[o.group_name] === o.id).reduce((n, o) => n + o.price, 0);
  return html`<${Modal} title=${item.name} onClose=${onClose}>
    <div class="stack">
      ${item.description ? html`<p class="muted small">${item.description}</p>` : null}
      ${groups.map((g) => html`<div class=${`field ${warn && missing.includes(g) ? 'need-pick' : ''}`}><span>${g}${item.options.some((o) => o.group_name === g && o.required) ? html` <b class="req">bấm chọn 1 loại</b>` : ''}</span>
        <div class="chips">${item.options.filter((o) => o.group_name === g).map((o) => html`<button class=${`chip big ${pick[g] === o.id ? 'on' : ''}`}
          onClick=${() => setPick({ ...pick, [g]: pick[g] === o.id ? undefined : o.id })}>${o.name}${o.price ? ` +${money(o.price)}` : ''}</button>`)}</div></div>`)}
      <div class="row">
        <button class="icon big" onClick=${() => setQty(Math.max(1, qty - 1))}>−</button><b class="big-num">${qty}</b><button class="icon big" onClick=${() => setQty(qty + 1)}>+</button>
        <span class="grow r"><b>${money(unit * qty)}</b></span>
      </div>
      <${Field} label="Ghi chú cho bếp"><input id="ai-note" value=${note} placeholder=${notesFor(catName).length ? `vd ${notesFor(catName).join(', ').toLowerCase()}` : 'ghi chú cho bếp'} onInput=${(e) => setNote(e.target.value)} /><//>
      <div class="chips">${notesFor(catName).map((x) => html`<button class="chip" onClick=${() => setNote(note ? `${note}, ${x.toLowerCase()}` : x)}>${x}</button>`)}</div>
      <label class="check-row"><input type="checkbox" checked=${rush} onChange=${(e) => setRush(e.target.checked)} /> Gấp (in máy Ưu tiên, bếp làm trước)</label>
      <button class=${`primary big ${missing.length ? 'soft' : ''}`} onClick=${() => (missing.length ? setWarn(true) : onAdd({ menu_item_id: item.id, option_ids: Object.values(pick).filter(Boolean), qty, note, rush }))}>
        ${missing.length ? `Chưa chọn ${missing[0].toLowerCase()} ↑` : `Thêm ${qty} món · ${money(unit * qty)}`}</button>
      ${warn && missing.length ? html`<p class="warn-text r">Bấm 1 loại ${missing[0].toLowerCase()} ở trên rồi bấm lại.</p>` : null}
    </div>
  <//>`;
}

function Reason({ title, chips, onOk, onClose, soldOutOption = false }) {
  const [txt, setTxt] = useState('');
  const [soldOut, setSoldOut] = useState(false);
  return html`<${Modal} title=${title} onClose=${onClose}><div class="stack">
    <input id="rs-text" value=${txt} placeholder="Lý do" onInput=${(e) => setTxt(e.target.value)} />
    <div class="chips">${chips.map((x) => html`<button class="chip" onClick=${() => setTxt(x)}>${x}</button>`)}</div>
    ${soldOutOption ? html`<label class="check-row"><input type="checkbox" checked=${soldOut} onChange=${(e) => { setSoldOut(e.target.checked); if (e.target.checked && !txt) setTxt('Hết nguyên liệu'); }} /> Báo <b>hết món</b> luôn (không ai gọi được nữa)</label>` : null}
    <div class="row end"><button onClick=${onClose}>Thôi</button><button class="danger" disabled=${!txt.trim()} onClick=${() => onOk(txt, soldOut)}>Xác nhận</button></div>
  </div><//>`;
}

function Split({ items, onOk, onClose }) {
  const [qty, setQty] = useState({});
  const [table, setTable] = useState('');
  const chosen = Object.entries(qty).filter(([, n]) => n > 0);
  const total = items.reduce((n, i) => n + (qty[i.id] || 0) * i.unit_price, 0);
  return html`<${Modal} title="Tách bàn" onClose=${onClose}><div class="stack">
    <p class="muted small">Chọn món (và số lượng) chuyển sang bàn khác để tính tiền riêng. Không in phiếu bếp.</p>
    <ul class="plain order-lines">${items.map((i) => html`<li class="ol">
      <div class="grow"><b>${i.name}</b><br /><small class="muted">đang có ${i.qty} · ${money(i.unit_price)}/phần</small></div>
      <div class="row tight">
        <button class="icon" onClick=${() => setQty({ ...qty, [i.id]: Math.max(0, (qty[i.id] || 0) - 1) })}>−</button>
        <b>${qty[i.id] || 0}</b>
        <button class="icon" onClick=${() => setQty({ ...qty, [i.id]: Math.min(i.qty, (qty[i.id] || 0) + 1) })}>+</button></div>
    </li>`)}</ul>
    <${Field} label="Sang bàn" hint="Bàn trống thì tự nhận khách"><input id="sp-table" inputmode="numeric" value=${table} onInput=${(e) => setTable(e.target.value.replace(/\D/g, ''))} /><//>
    <div class="row end"><button onClick=${onClose}>Thôi</button>
      <button class="primary" disabled=${!chosen.length || !table} onClick=${() => onOk(Number(table), chosen.map(([id, n]) => ({ id: Number(id), qty: n })))}>Tách ${chosen.reduce((n, [, q]) => n + q, 0)} món · ${money(total)}</button></div>
  </div><//>`;
}

function TablePrompt({ title, hint, onOk, onClose, items = null }) {
  const [txt, setTxt] = useState('');
  const [pick, setPick] = useState(() => new Set((items || []).map((i) => i.id)));
  return html`<${Modal} title=${title} onClose=${onClose}><div class="stack">
    <${Field} label="Bàn" hint=${hint}><input id="tp-text" inputmode="numeric" value=${txt} onInput=${(e) => setTxt(e.target.value)} /><//>
    ${items?.length ? html`<div class="field"><span>Báo bếp giao sang bàn mới: chỉ tick món <b>CHƯA RA</b></span>
      ${items.map((i) => html`<label class="check-row"><input type="checkbox" checked=${pick.has(i.id)} onChange=${(e) => { const n = new Set(pick); if (e.target.checked) n.add(i.id); else n.delete(i.id); setPick(n); }} /> ${i.qty} × ${i.name}</label>`)}
      <small class="muted">Món đã ra bàn thì bỏ tick, bếp không nhận phiếu.</small></div>` : null}
    <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" disabled=${!txt.trim()} onClick=${() => onOk(txt, [...pick])}>Xong</button></div>
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
  const [paying, setPaying] = useState(false);
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
  const add = async (body) => {
    try {
      await api('POST', `/api/pos/sessions/${id}/items`, body);
      toast('Đã thêm'); bump(); setAdding(null);
    } catch (e) {
      // Kho theo định lượng không đủ: hỏi bếp còn thực tế không, còn thì xác nhận gọi
      if (e.status === 409 && /kho chỉ còn/.test(e.message)) {
        if (confirm(e.message) && await act(() => api('POST', `/api/pos/sessions/${id}/items`, { ...body, override_stock: true }), 'Đã thêm (bếp xác nhận còn hàng)')) setAdding(null);
      } else act(() => Promise.reject(e));
    }
  };
  const quick = (item) => (item.options.length ? setAdding(item) : add({ menu_item_id: item.id, qty: 1 }));
  const send = () => act(() => api('POST', `/api/pos/sessions/${id}/send`), 'Đã gửi bếp');
  const sessions = (tablesD.data?.zones || []).flatMap((z) => z.tables).filter((t) => t.session && t.session.id !== id)
    .map((t) => t.session).filter((x, k, a) => a.findIndex((y) => y.id === x.id) === k);
  return html`<div class="stack order">
    <div class="row between wrap">
      <div><h2>Bàn ${s.header}</h2><small class="muted">Vào lúc ${hm(s.opened_at)} bởi ${s.opened_by_name || ''}${s.status === 'paying' ? ' · đang chờ thanh toán' : ''}</small></div>
      <button onClick=${async () => { if (!closed && !s.items.length) await api('POST', `/api/pos/sessions/${id}/cancel`, { reason: 'Nhận nhầm bàn, chưa gọi món' }).catch(() => {}); navigate('/ban'); }}>← Sơ đồ bàn</button>
    </div>
    ${s.status === 'closed' ? html`<${PaidPanel} me=${me} id=${id} />` : null}
    ${s.status === 'cancelled' ? html`<p class="warn-text">Bàn này đã huỷ.</p>` : null}
    ${closed ? null : html`
    <div class="row wrap">
      <label class="check-row"><input type="checkbox" checked=${s.priority} onChange=${(e) => act(() => api('PATCH', `/api/pos/sessions/${id}`, { priority: e.target.checked }))} /> Ưu tiên</label>
      <button onClick=${() => { const g = prompt_(s.guests); if (g) act(() => api('PATCH', `/api/pos/sessions/${id}`, { guests: g }), 'Đã sửa số khách'); }}>Số khách${s.guests > 1 ? `: ${s.guests}` : ''}</button>
      <button onClick=${() => setPrompt('move')}>Chuyển bàn</button>
      <button onClick=${() => setPrompt('split')}>Tách bàn</button>
      <button onClick=${() => setPrompt('merge')}>Gộp bàn</button>
    </div>
    <div class="tabs"><button class=${tab === 'menu' ? 'on' : ''} onClick=${() => setTab('menu')}>Thực đơn</button>
      <button class=${tab === 'bill' ? 'on' : ''} onClick=${() => setTab('bill')}>Đã gọi (${s.items.filter((i) => i.status !== 'cancelled').length})</button></div>`}

    ${!closed ? (s.gifts || []).filter((g) => g.left > 0).map((g) => html`<div class="gift-bar">
      <div>🎁 <b>${g.name}</b>: bàn còn được tặng <b>${g.left} phần</b>. Bấm món khách chọn để thêm, app tự trừ tiền.</div>
      <div class="chips">${g.items.map((it) => html`<button class="chip big" disabled=${it.sold_out} onClick=${() => add({ menu_item_id: it.id, qty: 1, note: 'KM tặng' })}>+ ${it.name}${it.sold_out ? ' (hết)' : ''}</button>`)}</div>
    </div>`) : null}
    ${!closed && (m.promo?.running || m.promo?.bill || []).length ? html`<div class="promo-bar">🎁 <b>Quán đang có khuyến mãi:</b>${(m.promo.running || m.promo.bill).map((x) => html`<div>• ${x}</div>`)}</div>` : null}
    ${!closed ? (s.promo_hints || []).map((h) => { const mi = m.items.find((x) => x.id === h.menu_item_id); return html`<div class="gift-bar">
      <div>🎁 <b>${h.name}</b>: gọi thêm <b>${h.need} phần${h.item_name ? ` ${h.item_name}` : ''}</b> là được tặng. Mời khách nhé!</div>
      ${mi && !mi.sold_out ? html`<div class="chips"><button class="chip big" onClick=${() => quick(mi)}>+ ${mi.name} (phần tặng)</button></div>` : null}
    </div>`; }) : null}
    ${tab === 'menu' && !closed ? html`
      <input id="om-q" type="search" placeholder="Tìm món" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="chips scroll-x"><button class=${`chip ${!cat ? 'on' : ''}`} onClick=${() => setCat('')}>Tất cả</button>
        ${m.categories.map((c) => html`<button class=${`chip ${cat === String(c.id) ? 'on' : ''}`} onClick=${() => setCat(String(c.id))}>${c.name}</button>`)}</div>
      <div class="menu-grid">${items.map((i) => html`<button class=${`menu-btn ${i.sold_out ? 'soldout' : ''}`} disabled=${i.sold_out} onClick=${() => quick(i)}>
        <b>${i.name}</b><small>${i.sold_out ? (i.auto_sold_out ? 'Hết nguyên liệu' : 'Hết món') : money(i.price)}</small>${!i.sold_out && i.left != null && i.left <= 5 ? html`<span class="left-tag">còn ${i.left} phần</span>` : null}${!i.sold_out && m.promo?.tags?.[i.id] ? html`<span class="promo-tag">🎁 ${m.promo.tags[i.id]}</span>` : null}</button>`)}</div>` : null}

    ${tab === 'bill' || s.status === 'cancelled' ? html`<section class="card">
      ${sent.length ? html`<ul class="plain order-lines">${sent.map((i) => html`<li class=${`ol ${i.status}`}>
        <div class="grow"><b>${i.qty} × ${i.name}</b>${i.rush ? html` <span class="pill bad">Gấp</span>` : null}
          ${i.options.length ? html`<br /><small>${i.options.map((o) => o.name).join(', ')}</small>` : null}${i.note ? html`<br /><small class="muted">${i.note}</small>` : null}
          <br /><small class="muted">${STATUS[i.status]}${i.status === 'cancelled' ? `: ${i.cancel_reason}` : ` · ${hm(i.sent_at)}`}${i.status === 'sent' && i.wait_min !== null ? ` · chờ ${i.wait_min}′` : ''}</small>
          ${i.late_min > 0 ? html`<br /><span class="pill bad">TRỄ ${i.late_min}′</span> <button class="small primary" onClick=${() => act(() => api('POST', `/api/pos/items/${i.id}/remind`), 'Đã nhắc bếp')}>Nhắc bếp</button>` : null}</div>
        <div class="r"><span class="num">${money(i.total)}</span>${(i.promos || []).map((p) => html`<br /><small class="promo-line">−${money(p.amount)}</small>`)}</div>
        ${i.promos?.length ? html`<div class="promo-note">🎁 ${i.promos.map((p) => `${p.name}${p.free_qty ? ` (tặng ${p.free_qty})` : ''}`).join(', ')}</div>` : null}
          ${!closed && i.status !== 'cancelled' ? html`<div class="row tight acts"><button class=${`small ${i.status === 'done' ? 'primary' : ''}`} onClick=${() => act(() => api('POST', `/api/pos/items/${i.id}/served`, { done: i.status !== 'done' }))}>${i.status === 'done' ? '✓ Đã ra' : 'Đã ra'}</button><button class="small" onClick=${() => setPrompt({ kind: 'item', item: i })}>Chuyển</button><button class="small" onClick=${() => setReason({ kind: 'redo', item: i })}>Làm lại</button><button class="small danger" onClick=${() => setReason({ kind: 'cancel', item: i })}>Huỷ</button></div>` : null}
      </li>`)}</ul>` : html`<p class="muted">Chưa gửi món nào.</p>`}
      <${Totals} s=${s} />
    </section>` : null}

    ${!closed ? html`<div class="cart-bar">
      ${drafts.length ? html`<section class="card cart">
        <b>Chưa gửi bếp (${drafts.length})</b>
        <ul class="plain order-lines">${drafts.map((i) => html`<li class="ol new">
          <div class="grow"><b>${i.name}</b>${i.rush ? html` <span class="pill bad">Gấp</span>` : null}${i.options.length ? html`<br /><small>${i.options.map((o) => o.name).join(', ')}</small>` : null}${i.note ? html`<br /><small class="muted">${i.note}</small>` : null}${i.promos?.length ? html`<br /><small class="promo-line">🎁 ${i.promos.map((p) => `${p.name} −${money(p.amount)}`).join(', ')}</small>` : null}</div>
          <div class="row tight">
            <button class="icon" onClick=${() => (i.qty > 1 ? act(() => api('PATCH', `/api/pos/items/${i.id}`, { qty: i.qty - 1 })) : act(() => api('POST', `/api/pos/items/${i.id}/cancel`, {})))}>−</button>
            <b>${i.qty}</b>
            <button class="icon" onClick=${() => act(() => api('PATCH', `/api/pos/items/${i.id}`, { qty: i.qty + 1 }))}>+</button></div>
        </li>`)}</ul>
      </section>` : null}
      <div class="row">
        <button class="primary big grow" disabled=${!drafts.length} onClick=${send}>${drafts.length ? `Gửi bếp (${drafts.reduce((n, i) => n + i.qty, 0)} món)` : 'Chọn món để gửi bếp'}</button>
        ${!drafts.length && sent.length ? html`<button class="big" onClick=${() => setPaying(true)}>₫ Tính tiền</button>` : null}
      </div>
      ${!sent.length ? html`<button class="link danger-text" onClick=${() => act(() => api('POST', `/api/pos/sessions/${id}/cancel`, {}), 'Đã huỷ bàn').then((ok) => ok && navigate('/ban'))}>Huỷ bàn (mở nhầm / khách về)</button>`
        : atLeast(me, 'shift_lead') ? html`<button class="link danger-text" onClick=${() => setReason({ kind: 'close' })}>Huỷ cả bàn…</button>` : null}
    </div>` : null}

    ${paying ? html`<${PayModal} me=${me} id=${id} onClose=${() => setPaying(false)} onDone=${(r) => { setPaying(false); toast(r.requested ? 'Đã báo thu ngân thu tiền mặt' : r.auto ? 'Đã nhận tiền, bàn trống' : r.hand_over ? `Đã đóng bill.${r.change ? ` Thối khách ${money(r.change)}.` : ''} Giao ${money(r.hand_over)} + bill cho thu ngân` : 'Đã đóng bill, bàn trống'); bump(); navigate('/ban'); }} />` : null}
    ${adding ? html`<${AddItem} item=${adding} catName=${m.categories.find((c) => c.id === adding.category_id)?.name} onAdd=${add} onClose=${() => setAdding(null)} />` : null}
    ${reason ? html`<${Reason} title=${reason.kind === 'redo' ? `Làm lại: ${reason.item.name}` : reason.kind === 'cancel' ? `Huỷ: ${reason.item.name}` : 'Huỷ cả bàn'}
      chips=${reason.kind === 'redo' ? ['Khách chê', 'Làm hỏng', 'Sai món', 'Rơi đổ'] : ['Khách đổi ý', 'Gọi nhầm', 'Ra lâu, khách huỷ', 'Hết nguyên liệu']}
      onClose=${() => setReason(null)}
      soldOutOption=${reason.kind === 'cancel' && atLeast(me, 'team_lead')}
      onOk=${async (txt, soldOut) => {
        const url = reason.kind === 'close' ? `/api/pos/sessions/${id}/cancel` : `/api/pos/items/${reason.item.id}/${reason.kind === 'redo' ? 'redo' : 'cancel'}`;
        if (await act(() => api('POST', url, { reason: txt, sold_out: !!soldOut }), reason.kind === 'redo' ? 'Đã báo làm lại' : 'Đã huỷ')) { setReason(null); if (reason.kind === 'close') navigate('/ban'); }
      }} />` : null}
    ${prompt === 'split' ? html`<${Split} items=${s.items.filter((i) => i.status !== 'cancelled')} onClose=${() => setPrompt(null)}
      onOk=${async (table, items) => { const r = await act(() => api('POST', `/api/pos/sessions/${id}/split`, { table, items }), 'Đã tách bàn'); if (r) setPrompt(null); }} />` : null}
    ${prompt === 'move' ? html`<${TablePrompt} title="Chuyển sang bàn" hint="vd 25, hoặc 25, 26 nếu ngồi 2 bàn" onClose=${() => setPrompt(null)}
      onOk=${async (txt, ids) => { if (await act(() => api('POST', `/api/pos/sessions/${id}/move`, { tables: txt, notify_item_ids: ids }), 'Đã chuyển bàn')) setPrompt(null); }} />` : null}
    ${prompt?.kind === 'item' ? html`<${TablePrompt} title=${`Chuyển "${prompt.item.name}" sang bàn`} hint="Gọi nhầm bàn: món và tiền chuyển sang bàn đúng (không in phiếu, báo bếp bằng bộ đàm)" onClose=${() => setPrompt(null)}
      onOk=${async (txt, ids) => { if (await act(() => api('POST', `/api/pos/items/${prompt.item.id}/move`, { table: Number(txt) }), 'Đã chuyển món')) setPrompt(null); }} />` : null}
    ${prompt === 'merge' ? html`<${Modal} title="Gộp bàn khác vào bàn này" onClose=${() => setPrompt(null)}><div class="stack">
      <p class="muted small">Món và khách của bàn được chọn sẽ chuyển sang bàn ${s.header}.</p>
      ${sessions.length ? html`<div class="chips">${sessions.map((x) => html`<button class="chip big" onClick=${async () => { if (await act(() => api('POST', `/api/pos/sessions/${id}/merge`, { from_session_id: x.id }), 'Đã gộp bàn')) setPrompt(null); }}>Bàn ${x.tables.join(', ')}</button>`)}</div>` : html`<p class="muted">Không có bàn nào khác đang mở.</p>`}
    </div><//>` : null}
  </div>`;
}

// Tổng bill: tạm tính, khuyến mãi (chỉ hiện cho phục vụ / thu ngân, không in phiếu bếp), còn lại
function Totals({ s }) {
  return html`<div class="totals">
    <div class="row between"><span>Tạm tính</span><span class="num">${money(s.subtotal)}</span></div>
    ${s.item_discount ? html`<div class="row between promo-line"><span>Khuyến mãi món</span><span class="num">−${money(s.item_discount)}</span></div>` : null}
    ${(s.bill_promos || []).map((p) => html`<div class="row between promo-line"><span>🎁 ${p.name}</span><span class="num">−${money(p.amount)}</span></div>`)}
    <div class="row between total"><b>${s.discount ? 'Còn lại' : 'Tạm tính'}</b><b class="num">${money(s.total ?? s.subtotal)}</b></div>
  </div>`;
}

function prompt_(cur) {
  const x = window.prompt('Số khách', String(cur));
  const n = Number(x);
  return Number.isInteger(n) && n > 0 ? n : null;
}
