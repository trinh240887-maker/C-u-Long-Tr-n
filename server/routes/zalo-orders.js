// Đặt hàng NCC qua Zalo (chủ quán 26/10): mỗi NCC 1 nhóm Zalo có bot.
// - Trong nhóm NCC, chủ quán nhắn "@bot thăn bò 10kg, bắp hoa 5kg" → bot tạo đơn CHỜ NHẬN (đã duyệt) trong app, trả lời trong nhóm.
// - Nhân viên Nhập kho "theo đơn" → kiểm số thực nhận → bot báo đủ / thiếu vào đúng nhóm đó. Công nợ theo số thực nhận (sau khi thu ngân duyệt bill).
// - Đơn duyệt trong app cũng gửi vào nhóm của NCC (nếu đã gắn), không thì nhóm đặt hàng chung.
import { fail, v } from '../http.js';
import { tx } from '../db.js';
import { norm } from '../lib/avail-parse.js';

const UNIT_RE = '(kg|ký|kí|g|gr|gram|lạng|thùng|gói|bó|con|cái|lon|chai|két|hộp|bao|lít|lit|l|ml|vỉ|bịch|túi|khay|cây|trái|quả|miếng|vắt|phần|bình|can|xô|hũ|lốc|bì|tảng|ổ|hủ)';
const ORDER_LINE = new RegExp(`\\d+(?:[.,]\\d+)?\\s*${UNIT_RE}(?![\\p{L}])`, 'iu');
const UNIT_ALIAS = { 'ký': 'kg', 'kí': 'kg', gr: 'g', gram: 'g', lit: 'lít', l: 'lít', 'hủ': 'hũ' };
const u0 = (x) => { const k = String(x || '').trim().toLowerCase(); return UNIT_ALIAS[k] || k; };

// Gắn NCC theo tên nhóm Zalo (rà soát 28/10): tên NCC (bỏ dấu) phải nằm TRONG tên nhóm, ≥ 4 ký tự hoặc trùng nguyên từ; không khớp ngược.
// Nhiều NCC khớp → lấy tên dài nhất; dài bằng nhau → không gắn (để chủ quán chọn)
export function matchSupplierByGroupName(groupName, list) {
  const gn = norm(groupName || '').replace(/\s+/g, ' ').trim();
  if (!gn) return null;
  const words = ` ${gn.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const hits = [];
  for (const s of list) {
    const sn = norm(s.name || '').replace(/\s+/g, ' ').trim();
    if (!sn) continue;
    const snw = sn.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if ((sn.length >= 4 && gn.includes(sn)) || (snw && words.includes(` ${snw} `))) hits.push({ s, n: sn.length });
  }
  hits.sort((a, b) => b.n - a.n);
  if (!hits.length || (hits[1] && hits[1].n === hits[0].n)) return null;
  return hits[0].s;
}

export default function (r, ctx) {
  const { db } = ctx;
  if (!db.prepare('PRAGMA table_info(purchase_orders)').all().some((c) => c.name === 'zalo_chat')) db.exec("ALTER TABLE purchase_orders ADD COLUMN zalo_chat TEXT NOT NULL DEFAULT ''");

  const groups = () => { try { return JSON.parse(ctx.setting('zalo_supplier_groups') || '[]') || []; } catch { return []; } };
  const saveGroups = (g) => ctx.setSetting('zalo_supplier_groups', JSON.stringify(g));
  ctx.supplierGroupOf = (chatId) => groups().find((g) => g.id === String(chatId));
  ctx.supplierGroupFor = (supplierId) => groups().find((g) => g.supplier_id && g.supplier_id === Number(supplierId));
  const suppliers = () => db.prepare('SELECT id, name FROM suppliers WHERE active = 1').all();

  // Tách "thăn bò 10kg, bắp hoa 5 kg\n2 thùng coca" → [{ name, qty, unit }]
  function parseOrder(text) {
    const out = [];
    for (let part of String(text).split(/[\n,;+]|\s-\s/)) {
      part = part.replace(/^\s*(\d+[.)]\s+|[-•*]\s*)/, '').replace(/^\s*(đặt hàng|đặt|order|lấy|giao)\s*:?\s*/i, '').trim();
      if (!part) continue;
      let m = new RegExp(`^(.+?)\\s*[:x×]?\\s*(\\d+(?:[.,]\\d+)?)\\s*${UNIT_RE}?\\s*$`, 'iu').exec(part);
      if (m) { out.push({ name: m[1].trim(), qty: Number(m[2].replace(',', '.')), unit: u0(m[3]) }); continue; }
      m = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*${UNIT_RE}?\\s+(.+)$`, 'iu').exec(part);
      if (m) out.push({ name: m[3].trim(), qty: Number(m[1].replace(',', '.')), unit: u0(m[2]) });
    }
    return out.filter((x) => x.name && x.qty > 0);
  }

  // Tìm nguyên liệu khớp tên (ưu tiên hàng của NCC này)
  function matchIng(name, supplierId) {
    const n = norm(name);
    const all = db.prepare(`SELECT i.*, COALESCE(i.supplier_id, s.supplier_id) AS sup FROM ingredients i LEFT JOIN stores s ON s.id = i.home_store_id WHERE i.active = 1`).all();
    const score = (g) => {
      const gn = norm(g.name);
      if (gn === n) return 100;
      if (gn.includes(n) || n.includes(gn)) return 60 + Math.min(n.length, gn.length);
      const words = n.split(' ').filter((w) => w.length > 1);
      return words.length && words.every((w) => gn.includes(w)) ? 40 + words.length : 0;
    };
    const ranked = all.map((g) => ({ g, s: score(g) + (supplierId && g.sup === supplierId ? 15 : 0) })).filter((x) => x.s >= 40).sort((a, b) => b.s - a.s);
    if (!ranked.length || (ranked[1] && ranked[1].s === ranked[0].s && ranked[1].g.id !== ranked[0].g.id)) return null;
    return ranked[0].g;
  }
  // Số theo đơn vị mua của nguyên liệu (vd đặt "500 g" mà mua theo kg → 0,5)
  function toPurchaseQty(g, qty, unit) {
    const pu = u0(g.purchase_unit || g.unit), use = u0(g.unit), f = g.purchase_factor || 1;
    if (!unit || unit === pu) return { qty, ok: true };
    if (unit === use && pu !== use) return { qty: Math.round((qty / f) * 1000) / 1000, ok: true };
    if (unit === 'g' && pu === 'kg') return { qty: qty / 1000, ok: true };
    if (unit === 'kg' && pu === 'g') return { qty: qty * 1000, ok: true };
    if (unit === 'kg' && use === 'g') return { qty: Math.round(((qty * 1000) / f) * 1000) / 1000, ok: true };
    return { qty, ok: false };
  }
  const fmt = (n) => Number(n).toLocaleString('vi-VN', { maximumFractionDigits: 3 });

  // Tin @bot trong nhóm NCC → tạo đơn chờ nhận. Trả về câu trả lời, hoặc null nếu không phải tin đặt hàng
  ctx.zaloOrderMsg = (u, cleanText) => {
    const text = String(cleanText || '').replace(/^\s*@\S+\s*/, '').trim();
    let g = ctx.supplierGroupOf(u.chat.id);
    if (!ORDER_LINE.test(text)) return g ? (/^\s*(đơn|don)\s*$/i.test(text) ? lastOrders(g) : null) : null;
    if (!g) {
      // Chat riêng 1:1 không bao giờ tự thành nhóm NCC (rà soát 28/10); không rõ loại chat thì giữ như cũ
      if (u.chat.type && !/group/i.test(u.chat.type)) return null;
      // Nhóm mới: tự gắn NCC theo tên nhóm Zalo
      const sup = matchSupplierByGroupName(u.chat.name, suppliers());
      g = { id: String(u.chat.id), name: u.chat.name || 'Nhóm NCC', supplier_id: sup?.id || null };
      saveGroups([...groups().filter((x) => x.id !== g.id), g]);
      if (!sup) {
        // Báo 1 lần / nhóm, không khẩn (rà soát 28/10: trước báo khẩn mỗi lần)
        const key = `zalo_unmatched_notified:${g.id}`;
        if (!ctx.setting(key)) {
          ctx.setSetting(key, String(ctx.now()));
          const owners = db.prepare("SELECT id FROM staff WHERE role IN ('owner','manager') AND active = 1").all().map((x) => x.id);
          ctx.notify(owners, { title: `Nhóm Zalo "${g.name}" chưa gắn nhà cung cấp`, body: 'Vào Cài đặt → Zalo Bot → Nhóm nhà cung cấp, chọn NCC cho nhóm này rồi nhắn lại đơn.', link: '/cai-dat?tab=bot' });
        }
        return `Nhóm này chưa gắn nhà cung cấp trong app. Chủ quán vào Cài đặt → Zalo Bot chọn NCC cho nhóm "${g.name}", rồi nhắn lại đơn.`;
      }
    }
    if (!g.supplier_id) return `Nhóm này chưa gắn nhà cung cấp trong app. Chủ quán vào Cài đặt → Zalo Bot chọn NCC cho nhóm "${g.name}", rồi nhắn lại đơn.`;
    const sup = db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(g.supplier_id);
    const items = parseOrder(text.replace(new RegExp(norm(sup?.name || '@@'), 'i'), ''));
    if (!items.length) return null;
    const lines = new Map(), miss = [], unitWarn = [];
    for (const it of items) {
      const ing = matchIng(it.name, g.supplier_id);
      if (!ing) { miss.push(`${it.name} ${fmt(it.qty)}${it.unit ? ` ${it.unit}` : ''}`); continue; }
      const q = toPurchaseQty(ing, it.qty, it.unit);
      if (!q.ok) unitWarn.push(`${ing.name}: đặt ${fmt(it.qty)} ${it.unit}, app tính theo ${ing.purchase_unit || ing.unit}`);
      const cur = lines.get(ing.id);
      lines.set(ing.id, { ing, qty: (cur?.qty || 0) + q.qty });
    }
    if (!lines.size) return `Chưa nhận ra món nào trong kho: ${miss.join(', ')}. Thêm hàng ở Kho → Nguyên liệu & NCC (đúng tên) rồi nhắn lại.`;
    // Khu nhận: khu chính nhiều món nhất → khu có NCC này → kho tổng
    const votes = new Map();
    for (const { ing } of lines.values()) if (ing.home_store_id) votes.set(ing.home_store_id, (votes.get(ing.home_store_id) || 0) + 1);
    const storeId = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      || db.prepare("SELECT id FROM stores WHERE supplier_id = ? AND active = 1 ORDER BY id").get(g.supplier_id)?.id
      || db.prepare("SELECT id FROM stores WHERE kind = 'main' ORDER BY id").get()?.id
      || db.prepare('SELECT id FROM stores ORDER BY id').get()?.id;
    if (!storeId) return 'App chưa có kho để nhận hàng.';
    // Người nhắn: tài khoản Zalo đã gắn nhân viên đang làm. Chỉ chủ quán / quản lý mới tự duyệt đơn; còn lại (kể cả NCC trong nhóm) → chờ duyệt (rà soát 28/10)
    const sender = u.from.id ? db.prepare("SELECT s.id, s.role FROM zalo_bot_users z JOIN staff s ON s.id = z.staff_id WHERE z.uid = ? AND s.active = 1").get(u.from.id) : null;
    const by = sender?.id || null;
    const auto = !!sender && ['owner', 'manager'].includes(sender.role);
    const now = ctx.now();
    const poId = tx(db, () => {
      const id = Number(db.prepare("INSERT INTO purchase_orders (supplier_id, store_id, status, note, created_by, created_at, submitted_by, submitted_at, approved_by, approved_at, zalo_chat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(g.supplier_id, storeId, auto ? 'approved' : 'submitted', `Đặt qua Zalo (${u.from.name || ''} · nhóm ${g.name})`.slice(0, 200), by, now, by, now, auto ? by : null, auto ? now : null, String(u.chat.id)).lastInsertRowid);
      const add = db.prepare('INSERT INTO po_lines (po_id, ingredient_id, qty, suggested, price) VALUES (?, ?, ?, 0, ?)');
      for (const { ing, qty } of lines.values()) add.run(id, ing.id, qty, ing.price || 0);
      return id;
    });
    const po = ctx.loadPo(poId);
    ctx.audit({ id: by, role: 'staff', name: u.from.name }, 'po.zalo_order', { po: poId, chat: g.name });
    const body = po.lines.map((l) => `• ${l.name}: ${fmt(l.qty)} ${l.purchase_unit || l.unit}`).join('\n');
    if (auto) {
      const holder = Number(ctx.setting('kho_tong_staff_id') || 0);
      const to = [...new Set([...(holder ? [holder] : []), ...db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((x) => x.id)])];
      ctx.notify(to, { title: `Đơn chờ nhận #${poId}: ${sup.name}`, body, link: '/mua-hang' });
    } else {
      ctx.notify(ctx.managers(), { title: `Đơn Zalo #${poId} chờ duyệt: ${sup.name}`, body: `Người nhắn: ${u.from.name || 'chưa rõ'} (Zalo chưa gắn quản lý)\n${body}`, link: '/kho?tab=dat' });
    }
    ctx.broadcast('stock');
    return [`📝 Đơn #${poId} · ${sup.name} · nhận tại ${po.store_name}`,
      ...po.lines.map((l) => `• ${l.name}: ${fmt(l.qty)} ${l.purchase_unit || l.unit}`),
      miss.length ? `⚠ Chưa có trong kho (không ghi vào đơn): ${miss.join(', ')}` : '',
      unitWarn.length ? `⚠ Kiểm đơn vị: ${unitWarn.join('; ')}` : '',
      auto ? '⏳ Hàng CHƯA nhận. Khi nhận, nhân viên kiểm thiếu / đủ và bot báo lại ở đây. Công nợ ghi theo số thực nhận.'
        : '🕒 Đơn CHỜ quản lý duyệt trong app. Duyệt xong bot gửi lại đơn vào nhóm này.'].filter(Boolean).join('\n');
  };

  function lastOrders(g) {
    const rows = db.prepare("SELECT id, status, created_at FROM purchase_orders WHERE zalo_chat = ? ORDER BY id DESC LIMIT 3").all(g.id);
    if (!rows.length) return 'Chưa có đơn nào từ nhóm này.';
    const st = { approved: '⏳ chờ nhận', received: '✅ đã nhận', cancelled: '✖ đã huỷ', draft: 'nháp', submitted: 'chờ duyệt' };
    return rows.map((x) => { const po = ctx.loadPo(x.id); return `Đơn #${x.id} (${st[x.status] || x.status}): ${po.lines.map((l) => `${l.name} ${fmt(l.qty)} ${l.purchase_unit || l.unit}`).join(', ')}`; }).join('\n');
  }

  // Nhận hàng theo đơn xong → báo đủ / thiếu vào nhóm Zalo của đơn
  ctx.poReceivedReport = async (po, lines, me) => {
    const chat = po.zalo_chat || ctx.supplierGroupFor(po.supplier_id)?.id;
    if (!chat || !ctx.zaloBot?.ready()) return;
    const got = new Map();
    for (const l of lines) if (l.ingredient_id) got.set(l.ingredient_id, (got.get(l.ingredient_id) || 0) + Number(l.qty || 0));
    const rows = po.lines.map((pl) => {
      const n = got.get(pl.ingredient_id) || 0, u = pl.purchase_unit || pl.unit;
      if (Math.abs(n - pl.qty) < 1e-6) return `✓ ${pl.name}: đủ ${fmt(n)} ${u}`;
      return n < pl.qty ? `⚠ ${pl.name}: THIẾU ${fmt(pl.qty - n)} ${u} (đặt ${fmt(pl.qty)}, nhận ${fmt(n)})` : `➕ ${pl.name}: DƯ ${fmt(n - pl.qty)} ${u} (đặt ${fmt(pl.qty)}, nhận ${fmt(n)})`;
    });
    const extra = lines.filter((l) => !po.lines.some((pl) => pl.ingredient_id === l.ingredient_id)).map((l) => `➕ ngoài đơn: ${l.name} ${fmt(l.qty)} ${l.unit || ''}`);
    const ok = rows.every((x) => x.startsWith('✓')) && !extra.length;
    const text = [`📦 Đơn #${po.id} · ${po.supplier_name || ''} đã nhận (${me.name}, ${ctx.clock().fmt(ctx.now()).slice(0, 5)})`, ...rows, ...extra,
      ok ? '✅ Đủ hàng.' : '⚠ Có chênh lệch: công nợ ghi theo số thực nhận.'].join('\n');
    await ctx.zaloBot.send(chat, text).catch((e) => console.error('Bot báo nhận hàng lỗi:', e.message));
  };

  // Cài đặt: nhóm NCC ↔ nhà cung cấp
  r.get('/api/zalo-bot/supplier-groups', 'manager', () => ({ groups: groups().map((g) => ({ ...g, supplier_name: g.supplier_id ? db.prepare('SELECT name FROM suppliers WHERE id = ?').get(g.supplier_id)?.name || '' : '' })), suppliers: suppliers() }));
  r.put('/api/zalo-bot/supplier-groups', 'manager', ({ me, body }) => {
    const id = v.text(body.id, { name: 'Nhóm', max: 100, required: true });
    const list = groups();
    const g = list.find((x) => x.id === id);
    if (!g) fail(404, 'Không tìm thấy nhóm');
    if (body.remove) saveGroups(list.filter((x) => x.id !== id));
    else {
      const sid = body.supplier_id ? v.int(body.supplier_id, { min: 1, name: 'NCC' }) : null;
      if (sid && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(sid)) fail(404, 'Không tìm thấy NCC');
      g.supplier_id = sid;
      saveGroups(list);
    }
    ctx.audit(me, 'zalo.supplier_group', { id, supplier_id: body.supplier_id, remove: !!body.remove });
    return { ok: true };
  });
}
