import { useState } from '../vendor/hooks.js';
import { html, api, act, useData, Loading, Modal, Field, money, hm, navigate, atLeast, toast, bump } from '../ui.js';
import { PayModal, PaidPanel } from './pay.js';

const STATUS = { new: 'Chưa gửi', sent: 'Đã gửi bếp', done: 'Đã ra', cancelled: 'Đã huỷ' };

// Ghi chú nhanh theo nhóm món (bếp chỉ thấy cái liên quan)
const QUICK_NOTES = [
  [/steak|món xào/i, ['Chín vừa', 'Chín kỹ']],
  [/cà phê|trà|nước|bia|soju/i, ['Ít đá', 'Không đá', 'Ít ngọt']],
];
const notesFor = (catName) => QUICK_NOTES.find(([re]) => re.test(catName || ''))?.[1] || [];

// Mua X tặng Y cùng món: khách gọi X phần → bếp làm X + Y (app tự cộng phần tặng, bill tự trừ)
export const withGift = (qty, b) => (b ? qty + Math.floor(qty / b.buy) * b.get : qty);

const BROTH = /^Ngăn nước lẩu /;
const isLau = (item) => (item.parts || []).some((p) => BROTH.test(p.label));

function AddItem({ item, onAdd, onClose, catName = '', bogo = null, addons = [] }) {
  // Lẩu: chọn 1 ngăn / 2 ngăn; ngăn 1 = nước của món, ngăn 2 chọn trong nhóm "Ngăn nước lẩu thêm"
  const broth = (item.parts || []).find((p) => BROTH.test(p.label))?.label.replace(BROTH, '');
  const [ngan, setNgan] = useState(1);
  const [n2, setN2] = useState(null);
  const groups = [...new Set(item.options.map((o) => o.group_name))];
  const [pick, setPick] = useState({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [rush, setRush] = useState(false);
  const [warn, setWarn] = useState(false);
  const [giftOther, setGiftOther] = useState(false); // phần tặng khách muốn sốt khác → chọn ngay bên dưới, ra chung 1 phiếu
  const [pick2, setPick2] = useState({});
  const free = bogo ? withGift(qty, bogo) - qty : 0;
  const total = qty + free;
  const missing2 = giftOther && free ? groups.filter((g) => item.options.some((o) => o.group_name === g && o.required) && !pick2[g]) : [];
  const missing = groups.filter((g) => item.options.some((o) => o.group_name === g && o.required) && !pick[g]);
  const addon = ngan === 2 ? addons.find((a) => a.id === n2) : null;
  const needN2 = broth && ngan === 2 && !addon;
  const unit = item.price + item.options.filter((o) => pick[o.group_name] === o.id).reduce((n, o) => n + o.price, 0) + (addon?.price || 0);
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
      ${bogo ? html`<div class="gift-bar">
        <div>🎁 <b>${bogo.name}</b>: ${free ? html`khách gọi <b>${qty}</b> → bếp làm <b>${total} phần</b> (tặng ${free}), bill tự trừ.` : `gọi đủ ${bogo.buy} phần để được tặng.`}</div>
        ${free && groups.length ? html`<div class="chips"><button class=${`chip ${!giftOther ? 'on' : ''}`} onClick=${() => setGiftOther(false)}>Phần tặng giống y</button>
          <button class=${`chip ${giftOther ? 'on' : ''}`} onClick=${() => setGiftOther(true)}>Phần tặng chọn khác</button></div>` : null}
        ${free && giftOther ? groups.map((g) => html`<div class=${`field ${warn && missing2.includes(g) ? 'need-pick' : ''}`}><span>${g} phần tặng</span>
          <div class="chips">${item.options.filter((o) => o.group_name === g).map((o) => html`<button class=${`chip ${pick2[g] === o.id ? 'on' : ''}`}
            onClick=${() => setPick2({ ...pick2, [g]: pick2[g] === o.id ? undefined : o.id })}>${o.name}</button>`)}</div></div>`) : null}
      </div>` : null}
      <${Field} label="Ghi chú cho bếp"><input id="ai-note" value=${note} placeholder=${notesFor(catName).length ? `vd ${notesFor(catName).join(', ').toLowerCase()}` : 'ghi chú cho bếp'} onInput=${(e) => setNote(e.target.value)} /><//>
      <div class="chips">${notesFor(catName).map((x) => html`<button class="chip" onClick=${() => setNote(note ? `${note}, ${x.toLowerCase()}` : x)}>${x}</button>`)}</div>
      <label class="check-row"><input type="checkbox" checked=${rush} onChange=${(e) => setRush(e.target.checked)} /> Gấp (in máy Ưu tiên, bếp làm trước)</label>
      <button class=${`primary big ${missing.length || missing2.length ? 'soft' : ''}`} onClick=${() => {
        if (missing.length || missing2.length || needN2) return setWarn(true);
        const body = { menu_item_id: item.id, option_ids: Object.values(pick).filter(Boolean), note, rush };
        // Lẩu 2 ngăn: thêm món ngăn 2 ngay sau nồi lẩu → phiếu Nước lẩu ghép "Ngăn 1 / Ngăn 2"
        if (addon) return onAdd([{ ...body, qty }, { menu_item_id: addon.id, qty, note, rush }]);
        // Giống y: 1 dòng "2 x"; chọn khác: 2 dòng (phần mua + phần tặng), cùng ra 1 phiếu khi gửi bếp
        onAdd(giftOther && free ? [{ ...body, qty }, { ...body, option_ids: Object.values(pick2).filter(Boolean), qty: free }] : [{ ...body, qty: total }]);
      }}>
        ${missing.length ? `Chưa chọn ${missing[0].toLowerCase()} ↑` : needN2 ? 'Chưa chọn nước ngăn 2 ↑' : missing2.length ? `Chưa chọn ${missing2[0].toLowerCase()} phần tặng ↑` : free ? `Thêm ${qty} + tặng ${free} · ${money(unit * qty)}` : `Thêm ${qty} món · ${money(unit * qty)}`}</button>
      ${warn && (missing.length || missing2.length) ? html`<p class="warn-text r">Bấm 1 loại ${(missing[0] || `${missing2[0]} phần tặng`).toLowerCase()} rồi bấm lại.</p>` : null}
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

function Split({ items, zones = [], onOk, onClose }) {
  const [qty, setQty] = useState({});
  const [table, setTable] = useState('');
  const chosen = Object.entries(qty).filter(([, n]) => n > 0);
  const total = items.reduce((n, i) => n + (qty[i.id] || 0) * i.unit_price, 0);
  return html`<${Modal} title="Tách bàn" onClose=${onClose}><div class="stack">
    <p class="muted small"><b>1.</b> Bấm 1 bàn trống để tách sang. <b>2.</b> Hỏi khách món nào tách, bấm + số lượng. Không in phiếu bếp.</p>
    ${zones.map((z) => html`<div class="field"><span>${z.name}</span><div class="tbl-pick">${z.tables.map((t) => html`<button class=${`chip ${Number(table) === t.number ? 'on' : ''} ${t.session ? 'busy' : ''}`} disabled=${!!t.session} onClick=${() => setTable(String(t.number))}>${t.number}${t.reservation ? ' 📅' : ''}</button>`)}</div></div>`)}
    <ul class="plain order-lines">${items.map((i) => html`<li class="ol">
      <div class="grow"><b>${i.name}</b><br /><small class="muted">đang có ${i.qty} · ${money(i.unit_price)}/phần</small></div>
      <div class="row tight">
        <button class="icon" onClick=${() => setQty({ ...qty, [i.id]: Math.max(0, (qty[i.id] || 0) - 1) })}>−</button>
        <b>${qty[i.id] || 0}</b>
        <button class="icon" onClick=${() => setQty({ ...qty, [i.id]: Math.min(i.qty, (qty[i.id] || 0) + 1) })}>+</button></div>
    </li>`)}</ul>
    <div class="row end"><button onClick=${onClose}>Thôi</button>
      <button class="primary" disabled=${!chosen.length || !table} onClick=${() => onOk(Number(table), chosen.map(([id, n]) => ({ id: Number(id), qty: n })))}>${table ? `Tách ${chosen.reduce((n, [, q]) => n + q, 0)} món sang bàn ${table} · ${money(total)}` : 'Bấm chọn bàn trống'}</button></div>
  </div><//>`;
}

// Chọn bàn bằng cách bấm (theo khu). busyOk: được chọn bàn đang có khách (chuyển món gọi nhầm sang bàn đúng)
function TablePrompt({ title, hint, onOk, onClose, items = null, zones = [], selfId = null, busyOk = false, multi = true }) {
  const [sel, setSel] = useState([]);
  const [pick, setPick] = useState(() => new Set((items || []).map((i) => i.id)));
  const toggle = (n) => setSel(sel.includes(n) ? sel.filter((x) => x !== n) : multi ? [...sel, n] : [n]);
  return html`<${Modal} title=${title} onClose=${onClose}><div class="stack">
    <small class="muted">${hint}</small>
    ${zones.map((z) => html`<div class="field"><span>${z.name}</span><div class="tbl-pick">${z.tables.map((t) => {
      const busy = t.session && t.session.id !== selfId;
      const mine = t.session && t.session.id === selfId;
      return html`<button class=${`chip ${sel.includes(t.number) ? 'on' : ''} ${busy ? 'busy' : ''}`} disabled=${mine || (busy && !busyOk)} onClick=${() => toggle(t.number)}>${t.number}${t.reservation ? ' 📅' : ''}</button>`;
    })}</div></div>`)}
    ${items?.length ? html`<div class="field"><span>Báo bếp giao sang bàn mới: chỉ tick món <b>CHƯA RA</b></span>
      ${items.map((i) => html`<label class="check-row"><input type="checkbox" checked=${pick.has(i.id)} onChange=${(e) => { const n = new Set(pick); if (e.target.checked) n.add(i.id); else n.delete(i.id); setPick(n); }} /> ${i.qty} × ${i.name}</label>`)}
      <small class="muted">Món đã ra bàn thì bỏ tick, bếp không nhận phiếu.</small></div>` : null}
    <div class="row end"><button onClick=${onClose}>Thôi</button><button class="primary" disabled=${!sel.length} onClick=${() => onOk(sel.join(', '), [...pick])}>${sel.length ? `Chuyển sang bàn ${sel.join(', ')}` : 'Bấm chọn bàn'}</button></div>
  </div><//>`;
}

export function OrderView({ me, query }) {
  const id = Number(query.get('s'));
  const st = useData(id ? `/api/pos/sessions/${id}` : null);
  const menuD = useData('/api/menu');
  const tablesD = useData('/api/pos/tables');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(null);
  const [reason, setReason] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [tab, setTab] = useState('menu');
  const [paying, setPaying] = useState(false);
  const [sending, setSending] = useState(false); // chống bấm 2 lần "Gửi bếp" (rà soát 28/10)
  if (!id) return html`<div class="empty">Chọn bàn ở Sơ đồ bàn.</div>`;
  if (!st.data || !menuD.data) return html`<${Loading} state=${st.data ? menuD : st} />`;
  const s = st.data;
  const m = menuD.data;
  const closed = !['open', 'paying'].includes(s.status);
  const catOrder = (cid) => { const k = m.categories.findIndex((c) => c.id === cid); return k < 0 ? 999 : k; };
  const plain = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const catName = (id) => m.categories.find((c) => c.id === id)?.name || '';
  // Tìm rộng: mọi chữ gõ vào phải có trong tên / nhóm / mô tả món (không dấu cũng được)
  const words = plain(q).split(/\s+/).filter(Boolean);
  // Món chỉ dùng để tặng (vd "Thịt tươi tặng 100g") không hiện ở thực đơn: thêm bằng nút xanh "Còn tặng N phần"
  const items = m.items.filter((i) => { if (/tặng/i.test(i.name)) return false; if (!words.length) return true; const hay = plain(`${i.name} ${catName(i.category_id)} ${i.description || ''}`); return words.every((w) => hay.includes(w)); })
    .sort((a, b) => catOrder(a.category_id) - catOrder(b.category_id) || a.sort - b.sort || a.id - b.id);
  // Nhóm hiển thị trên màn gọi món (chủ quán 24/10): Steak = steak + món thêm; Lẩu = set lẩu, ngăn thêm, bò, topping, rau…; Nướng riêng; Đồ uống = cà phê + trà + nước khác.
  // Chỉ gom để hiển thị; nhóm món trong dữ liệu giữ nguyên (khuyến mãi theo nhóm không đổi).
  const BIG = [['Steak', /^(steak|món thêm steak)$/i], ['Lẩu', /^(combo lẩu|ngăn nước lẩu thêm|bò tươi|bò nhập|topping|rau|thịt)/i], ['Nướng', /nướng/i], ['Đồ uống', /cà phê|cafe|trà|nước khác|nước uống|bia|soju|rượu|sinh tố|nước ép/i]];
  const bigOf = (c) => BIG.find(([, re]) => re.test(c.name))?.[0] || null;
  const groups = [];
  for (const c of m.categories) {
    const list = items.filter((i) => i.category_id === c.id);
    if (!list.length) continue;
    const big = bigOf(c);
    let g = groups.find((x) => x.key === (big || `c${c.id}`));
    if (!g) groups.push(g = { key: big || `c${c.id}`, c: { id: big ? `g-${big}` : c.id, name: big || c.name }, list: [], subs: [] });
    g.subs.push({ name: c.name, list });
    g.list.push(...list);
  }
  groups.sort((x, y) => (BIG.findIndex(([n]) => n === x.key) + 1 || 99) - (BIG.findIndex(([n]) => n === y.key) + 1 || 99));
  const drafts = s.items.filter((i) => i.status === 'new');
  const sent = s.items.filter((i) => i.status !== 'new');
  // Chia theo lần gửi bếp (chủ quán 29/10): cùng 1 lần bấm Gửi bếp = cùng giờ gửi → Lần 1, Lần 2… (chỉ trên màn phục vụ, phiếu in giữ nguyên)
  const sendTimes = [...new Set(sent.filter((i) => i.sent_at).map((i) => i.sent_at))].sort((a, b) => a - b);
  const rounds = sendTimes.map((at, k) => ({ no: k + 1, at, items: sent.filter((i) => i.sent_at === at) }));
  const noSent = sent.filter((i) => !i.sent_at);
  const agoMin = (at) => Math.max(0, Math.floor((Date.now() - at) / 60_000));
  const add = async (bodies) => {
    const list = Array.isArray(bodies) ? [...bodies] : [bodies];
    for (const b0 of [...list]) {
      const g = m.promo?.gift?.[b0.menu_item_id];
      const gi = g && m.items.find((x) => x.id === g.item_id);
      const n = g ? Math.floor(b0.qty / g.buy) * g.get : 0;
      if (gi && !gi.sold_out && n) list.push({ menu_item_id: gi.id, qty: n });
    }
    const body = list[list.length - 1];
    try {
      for (const b of list.slice(0, -1)) await api('POST', `/api/pos/sessions/${id}/items`, b);
      await api('POST', `/api/pos/sessions/${id}/items`, body);
      toast('Đã thêm'); bump(); setAdding(null);
    } catch (e) {
      // Kho theo định lượng không đủ: hỏi bếp còn thực tế không, còn thì xác nhận gọi
      if (e.status === 409 && /kho chỉ còn/.test(e.message)) {
        if (confirm(e.message) && await act(() => api('POST', `/api/pos/sessions/${id}/items`, { ...body, override_stock: true }), 'Đã thêm (bếp xác nhận còn hàng)')) setAdding(null);
      } else act(() => Promise.reject(e));
    }
  };
  const bogoOf = (item, gift) => (gift ? null : m.promo?.bogo?.[item.id] || null);
  const addonCat = m.categories.find((c) => c.name === 'Ngăn nước lẩu thêm')?.id;
  const addons = m.items.filter((x) => x.category_id === addonCat);
  const quick = (item, gift = false) => (item.options.length ? setAdding({ ...item, gift }) : add({ menu_item_id: item.id, qty: withGift(1, bogoOf(item, gift)) }));
  const send = async () => {
    if (sending) return;
    setSending(true);
    try { await act(() => api('POST', `/api/pos/sessions/${id}/send`), 'Đã gửi bếp'); } finally { setSending(false); }
  };
  const sessions = (tablesD.data?.zones || []).flatMap((z) => z.tables).filter((t) => t.session && t.session.id !== id)
    .map((t) => t.session).filter((x, k, a) => a.findIndex((y) => y.id === x.id) === k);
  return html`<div class="stack order">
    <div class="row between order-head">
      <div><h2>Bàn ${s.header}</h2><small class="muted">${hm(s.opened_at)} · ${s.opened_by_name || ''} · <b class="ink">${money(s.total)}</b>${s.discount ? ` (KM −${money(s.discount)})` : ''}${s.status === 'paying' ? ' · đang chờ thanh toán' : ''}</small></div>
      <button class="small" onClick=${async () => { if (!closed && !s.items.length) await api('POST', `/api/pos/sessions/${id}/cancel`, { reason: 'Nhận nhầm bàn, chưa gọi món' }).catch(() => {}); navigate('/ban'); }}>← Sơ đồ</button>
    </div>
    ${s.status === 'closed' ? html`<${PaidPanel} me=${me} id=${id} />` : null}
    ${s.status === 'cancelled' ? html`<p class="warn-text">Bàn này đã huỷ.</p>` : null}
    ${closed ? null : html`
    <div class="chips scroll-x tbl-acts">
      <label class="check-row"><input type="checkbox" checked=${s.priority} onChange=${(e) => act(() => api('PATCH', `/api/pos/sessions/${id}`, { priority: e.target.checked }))} /> Ưu tiên</label>
      <button onClick=${() => setPrompt('move')}>Chuyển bàn</button>
      <button onClick=${() => setPrompt('split')}>Tách bàn</button>
      <button onClick=${() => setPrompt('merge')}>Gộp bàn</button>
    </div>
    <div class="tabs"><button class=${tab === 'menu' ? 'on' : ''} onClick=${() => setTab('menu')}>Thực đơn</button>
      <button class=${tab === 'bill' ? 'on' : ''} onClick=${() => setTab('bill')}>Đã gọi (${s.items.filter((i) => i.status !== 'cancelled').length})</button></div>`}

    ${!closed ? (s.gifts || []).filter((g) => g.left > 0).map((g) => html`<div class="gift-bar gift-inline">
      <div>🎁 <b>Còn tặng ${g.left} phần</b> (${g.name}):</div>
      <div class="chips">${g.items.map((it) => html`<button class="chip big" disabled=${it.sold_out} onClick=${() => add({ menu_item_id: it.id, qty: 1 })}>+ ${it.name}${it.sold_out ? ' (hết)' : ''}</button>`)}</div>
    </div>`) : null}
    ${!closed && (m.promo?.running || m.promo?.bill || []).length ? html`<details class="promo-bar"><summary>🎁 <b>Đang có ${(m.promo.running || m.promo.bill).length} khuyến mãi</b> (bấm xem)</summary>${(m.promo.running || m.promo.bill).map((x) => html`<div>• ${x}</div>`)}</details>` : null}
    ${!closed ? (s.promo_hints || []).map((h) => { const mi = m.items.find((x) => x.id === h.menu_item_id); return html`<div class="gift-bar">
      <div>🎁 <b>${h.name}</b>: gọi thêm <b>${h.need} phần${h.item_name ? ` ${h.item_name}` : ''}</b> là được tặng. Mời khách nhé!</div>
      ${mi && !mi.sold_out ? html`<div class="chips"><button class="chip big" onClick=${() => quick(mi, true)}>+ ${mi.name} (phần tặng)</button></div>` : null}
    </div>`; }) : null}
    ${tab === 'menu' && !closed ? html`
      <div class="order-find">
        <input id="om-q" type="search" placeholder="🔍 Tìm món: tên, nhóm, mô tả (vd bò, mala, nướng)" value=${q} onInput=${(e) => setQ(e.target.value)} />
        ${!q ? html`<div class="chips cat-jump">${groups.filter((g) => g.list.length).map(({ c }) => html`<button class="chip" onClick=${() => document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>${c.name}</button>`)}</div>` : html`<button class="small" onClick=${() => setQ('')}>✕ Xoá tìm</button>`}
      </div>
      ${(q ? [{ c: { id: 0, name: `Kết quả tìm "${q}"` }, list: items, subs: [{ name: '', list: items }] }] : groups).map(({ c, subs }) => html`<div class="cat-head" id=${`cat-${c.id}`}>${c.name}</div>
      ${subs.map((sub) => html`${subs.length > 1 ? html`<div class="cat-sub">${sub.name}</div>` : null}<div class="menu-grid">${sub.list.map((i) => html`<button class=${`menu-btn ${i.sold_out ? 'soldout' : ''}`} disabled=${i.sold_out} onClick=${() => quick(i)}>
        <b>${i.name}</b><small>${i.sold_out ? (i.auto_sold_out ? 'Hết nguyên liệu' : 'Hết món') : money(i.price)}</small>${!i.sold_out && i.left != null && i.left <= 5 ? html`<span class="left-tag">còn ${i.left} phần</span>` : null}${!i.sold_out && m.promo?.tags?.[i.id] ? html`<span class="promo-tag" title=${m.promo.tags[i.id]}>🎁 KM</span>` : null}</button>`)}</div>`)}`)}
      ${q && !items.length ? html`<div class="empty">Không thấy món "${q}".</div>` : null}` : null}

    ${tab === 'bill' && !closed && drafts.length ? html`<section class="card cart"><b>Lần ${rounds.length + 1} · chưa gửi bếp</b> <small class="muted">đọc lại cho khách xác nhận, bấm − / + để sửa, rồi bấm Gửi bếp</small>
        <ul class="plain order-lines">${drafts.map((i) => html`<li class="ol new">
          <div class="grow"><b>${i.name}</b>${i.rush ? html` <span class="pill bad">Gấp</span>` : null}${i.options.length ? html`<br /><small>${i.options.map((o) => o.name).join(', ')}</small>` : null}${i.note ? html`<br /><small class="muted">${i.note}</small>` : null}${i.promos?.length ? html`<br /><small class="promo-line">🎁 ${i.promos.map((p) => `${p.name} −${money(p.amount)}`).join(', ')}</small>` : null}</div>
          <div class="row tight">
            <button class="icon" onClick=${() => (i.qty > 1 ? act(() => api('PATCH', `/api/pos/items/${i.id}`, { qty: i.qty - 1 })) : act(() => api('POST', `/api/pos/items/${i.id}/cancel`, {})))}>−</button>
            <b>${i.qty}</b>
            <button class="icon" onClick=${() => act(() => api('PATCH', `/api/pos/items/${i.id}`, { qty: i.qty + 1 }))}>+</button></div>
        </li>`)}</ul>
      </section>` : null}
    ${tab === 'bill' || s.status === 'cancelled' ? html`<section class="card">
      ${sent.length ? [...rounds.slice().reverse().map((r) => ({ title: html`<b>Lần ${r.no}</b> <small class="muted">· gửi ${hm(r.at)} · ${agoMin(r.at)} phút trước · ${r.items.filter((i) => i.status !== 'cancelled').reduce((n, i) => n + i.qty, 0)} món</small>`, list: r.items })),
        ...(noSent.length ? [{ title: html`<b>Khác</b>`, list: noSent }] : [])].map((g) => html`<div class="round-head">${g.title}</div><ul class="plain order-lines">${g.list.map((i) => html`<li class=${`ol ${i.status}`}>
        <div class="grow"><b>${i.qty} × ${i.name}</b>${i.rush ? html` <span class="pill bad">Gấp</span>` : null}
          ${i.options.length ? html`<br /><small>${i.options.map((o) => o.name).join(', ')}</small>` : null}${i.note ? html`<br /><small class="muted">${i.note}</small>` : null}
          <br /><small class="muted">${STATUS[i.status]}${i.status === 'cancelled' ? `: ${i.cancel_reason}` : ` · ${hm(i.sent_at)}`}${i.status === 'sent' && i.wait_min !== null ? ` · chờ ${i.wait_min}′` : ''}</small>
          ${i.late_min > 0 ? html`<br /><span class="pill bad">TRỄ ${i.late_min}′</span> <button class="small primary" onClick=${() => act(() => api('POST', `/api/pos/items/${i.id}/remind`), 'Đã nhắc bếp')}>Nhắc bếp</button>` : null}</div>
        <div class="r"><span class="num">${money(i.total)}</span>${(i.promos || []).map((p) => html`<br /><small class="promo-line">−${money(p.amount)}</small>`)}</div>
        ${i.promos?.length ? html`<div class="promo-note">🎁 ${i.promos.map((p) => `${p.name}${p.free_qty ? ` (tặng ${p.free_qty})` : ''}`).join(', ')}</div>` : null}
          ${!closed && i.status !== 'cancelled' ? html`<div class="row tight acts"><button class=${`small ${i.status === 'done' ? 'primary' : ''}`} onClick=${() => act(() => api('POST', `/api/pos/items/${i.id}/served`, { done: i.status !== 'done' }))}>${i.status === 'done' ? '✓ Đã ra' : 'Đã ra'}</button><button class="small" onClick=${() => setPrompt({ kind: 'item', item: i })}>Chuyển</button><button class="small" onClick=${() => setReason({ kind: 'redo', item: i })}>Làm lại</button><button class="small danger" onClick=${() => setReason({ kind: 'cancel', item: i })}>Huỷ</button></div>` : null}
      </li>`)}</ul>`) : html`<p class="muted">Chưa gửi món nào.</p>`}
      <${Totals} s=${s} />
    </section>` : null}

    ${!closed ? html`<div class="cart-bar">

      <div class="row">
        ${tab === 'menu'
          ? html`<button class="primary big grow" disabled=${!drafts.length} onClick=${() => { setTab('bill'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>${drafts.length ? `Xác nhận với khách (${drafts.reduce((n, i) => n + i.qty, 0)} món) →` : 'Chọn món'}</button>`
          : html`<button class="primary big grow" disabled=${!drafts.length || sending} onClick=${send}>${sending ? 'Đang gửi…' : drafts.length ? `Gửi bếp lần ${rounds.length + 1} (${drafts.reduce((n, i) => n + i.qty, 0)} món)` : 'Không có món mới để gửi'}</button>`}
        ${sent.length ? html`<button class="big" onClick=${() => setPaying(true)}>₫ Thanh toán</button>` : null}
      </div>
    </div>` : null}
    ${!closed ? (!sent.length ? html`<button class="link danger-text" onClick=${() => act(() => api('POST', `/api/pos/sessions/${id}/cancel`, {}), 'Đã huỷ bàn').then((ok) => ok && navigate('/ban'))}>Huỷ bàn (mở nhầm / khách về)</button>`
      : atLeast(me, 'shift_lead') ? html`<button class="link danger-text" onClick=${() => setReason({ kind: 'close' })}>Huỷ cả bàn…</button>` : null) : null}

    ${paying ? html`<${PayModal} me=${me} id=${id} onClose=${() => setPaying(false)} onDone=${(r) => { setPaying(false); toast(r.requested ? 'Đã báo thu ngân thu tiền mặt' : r.auto ? 'Đã nhận tiền, bàn trống' : r.hand_over ? `Đã đóng bill.${r.change ? ` Thối khách ${money(r.change)}.` : ''} Giao ${money(r.hand_over)} + bill cho thu ngân` : 'Đã đóng bill, bàn trống'); bump(); navigate('/ban'); }} />` : null}
    ${adding ? html`<${AddItem} item=${adding} addons=${addons} bogo=${bogoOf(adding, adding.gift)} catName=${m.categories.find((c) => c.id === adding.category_id)?.name} onAdd=${add} onClose=${() => setAdding(null)} />` : null}
    ${reason ? html`<${Reason} title=${reason.kind === 'redo' ? `Làm lại: ${reason.item.name}` : reason.kind === 'cancel' ? `Huỷ: ${reason.item.name}` : 'Huỷ cả bàn'}
      chips=${reason.kind === 'redo' ? ['Khách chê', 'Làm hỏng', 'Sai món', 'Rơi đổ'] : ['Khách đổi ý', 'Gọi nhầm', 'Ra lâu, khách huỷ', 'Hết nguyên liệu']}
      onClose=${() => setReason(null)}
      soldOutOption=${reason.kind === 'cancel' && atLeast(me, 'team_lead')}
      onOk=${async (txt, soldOut) => {
        const url = reason.kind === 'close' ? `/api/pos/sessions/${id}/cancel` : `/api/pos/items/${reason.item.id}/${reason.kind === 'redo' ? 'redo' : 'cancel'}`;
        if (await act(() => api('POST', url, { reason: txt, sold_out: !!soldOut }), reason.kind === 'redo' ? 'Đã báo làm lại' : 'Đã huỷ')) { setReason(null); if (reason.kind === 'close') navigate('/ban'); }
      }} />` : null}
    ${prompt === 'split' ? html`<${Split} items=${s.items.filter((i) => i.status !== 'cancelled')} zones=${tablesD.data?.zones || []} onClose=${() => setPrompt(null)}
      onOk=${async (table, items) => { const r = await act(() => api('POST', `/api/pos/sessions/${id}/split`, { table, items }), `Đã tách sang bàn ${table}`); if (r) setPrompt(null); }} />` : null}
    ${prompt === 'move' ? html`<${TablePrompt} title="Chuyển sang bàn" hint="Bấm 1 bàn trống. Cả bill chuyển sang bàn mới, bàn này thành bàn trống. Bàn mờ = đang có khách, 📅 = có khách đặt" zones=${tablesD.data?.zones || []} selfId=${id} multi=${false} onClose=${() => setPrompt(null)}
      onOk=${async (txt, ids) => { if (await act(() => api('POST', `/api/pos/sessions/${id}/move`, { tables: txt, notify_item_ids: ids }), 'Đã chuyển bàn')) setPrompt(null); }} />` : null}
    ${prompt?.kind === 'item' ? html`<${TablePrompt} title=${`Chuyển "${prompt.item.name}" sang bàn`} hint="Gọi nhầm bàn: bấm bàn đúng, món và tiền chuyển sang đó (không in phiếu, báo bếp bằng bộ đàm)" zones=${tablesD.data?.zones || []} selfId=${id} busyOk=${true} multi=${false} onClose=${() => setPrompt(null)}
      onOk=${async (txt, ids) => { if (await act(() => api('POST', `/api/pos/items/${prompt.item.id}/move`, { table: Number(txt) }), 'Đã chuyển món')) setPrompt(null); }} />` : null}
    ${prompt === 'merge' ? html`<${Modal} title=${`Gộp bàn ${s.tables.join(', ')} sang bàn…`} onClose=${() => setPrompt(null)}><div class="stack">
      <p class="muted small">Bấm bàn đang có khách muốn gộp tới. Cả bill bàn ${s.tables.join(', ')} cộng vào bàn đó, bàn ${s.tables.join(', ')} thành bàn trống (gọi mới là bill riêng).</p>
      ${sessions.length ? html`<div class="chips">${sessions.map((x) => html`<button class="chip big" onClick=${async () => { if (await act(() => api('POST', `/api/pos/sessions/${x.id}/merge`, { from_session_id: id }), `Đã gộp sang bàn ${x.tables.join(', ')}`)) { setPrompt(null); navigate(`/goi-mon?s=${x.id}`); } }}>Bàn ${x.tables.join(', ')}</button>`)}</div>` : html`<p class="muted">Không có bàn nào khác đang mở.</p>`}
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
