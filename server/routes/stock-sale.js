import { fail } from '../http.js';
import { stockQty, addLot, takeLots, recordMove, costOf } from '../lib/stock.js';

// Bán món tự trừ kho theo định lượng (công thức món ở Thực đơn):
// - Bấm "Gửi bếp" → trừ nguyên liệu ở kho khu của nguyên liệu (khu chính; không có thì kho tổng), hết hạn trước xuất trước.
// - Huỷ trong 2 phút sau khi gửi → trả lại kho; huỷ muộn hơn coi như đã làm (đã trừ, vào báo cáo huỷ).
// - Còn ≤ N phần (mặc định 5) → báo bếp + phục vụ "sắp hết"; hết → TỰ KHOÁ món, báo; nhập hàng / lĩnh hàng về → tự mở lại.
// - Gọi quá số phần còn lại → báo "chỉ còn N phần"; bếp kiểm thực tế còn thì vẫn gửi được (xác nhận).
// - 22:00 (cài được) tổng hợp hàng cần nhập ngày mai theo NCC → gửi người giữ kho, quản lý, tổ trưởng (Zalo OA nếu đã liên kết).
export default function (r, ctx) {
  const { db } = ctx;
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  addCol('menu_items', 'auto_sold_out', 'INTEGER NOT NULL DEFAULT 0');   // 1 = app tự khoá vì hết nguyên liệu
  addCol('menu_items', 'low_alert_date', "TEXT NOT NULL DEFAULT ''");    // đã báo "sắp hết" hôm nay

  const enabled = () => ctx.setting('sell_deducts_stock') !== '0';
  const lowN = () => Number(ctx.setting('low_portions_alert') || 5);
  const mainStore = () => db.prepare("SELECT * FROM stores WHERE kind = 'main' AND active = 1 ORDER BY id LIMIT 1").get();
  const storeOf = (ing) => ing.home_store_id || mainStore()?.id;
  const recipe = (menuItemId) => db.prepare(`SELECT r.qty, g.* FROM menu_recipes r JOIN ingredients g ON g.id = r.ingredient_id WHERE r.item_id = ?`).all(menuItemId);
  const kitchenAndService = () => db.prepare(`SELECT s.id FROM staff s LEFT JOIN teams t ON t.id = s.team_id WHERE s.active = 1
    AND (s.role IN ('owner','manager','shift_lead','team_lead') OR t.name IN ('Phục vụ','Tiếp thực'))`).all().map((x) => x.id);

  // Nguyên liệu "đang theo dõi" = đã từng nhập kho / kiểm kho; chưa theo dõi thì không khoá món (tránh khoá cả thực đơn khi mới nhập định lượng)
  const tracked = (ingId) => !!db.prepare("SELECT 1 FROM stock_moves WHERE ingredient_id = ? AND type IN ('receive','adjust','transfer') LIMIT 1").get(ingId)
    || !!db.prepare('SELECT 1 FROM stock_counts c JOIN stock_count_lines l ON l.count_id = c.id WHERE l.ingredient_id = ? LIMIT 1').get(ingId);
  // Tồn dùng được = kho khu của nguyên liệu + kho tổng (khu hết thì xuống kho tổng lấy)
  const usable = (g) => { const home = storeOf(g); const main = mainStore()?.id; return stockQty(db, home, g.id) + (main && main !== home ? stockQty(db, main, g.id) : 0); };
  // Số phần còn làm được = min(tồn dùng được / định lượng); null = món chưa có định lượng hoặc nguyên liệu chưa theo dõi
  ctx.portionsLeft = (menuItemId) => {
    const rs = recipe(menuItemId).filter((g) => tracked(g.id));
    if (!rs.length) return null;
    return Math.max(0, Math.min(...rs.map((g) => Math.floor((usable(g) + 1e-9) / g.qty))));
  };
  ctx.portionsMap = () => {
    const out = new Map();
    for (const { item_id: id } of db.prepare('SELECT DISTINCT item_id FROM menu_recipes').all()) out.set(id, ctx.portionsLeft(id));
    return out;
  };

  // Khi gọi món: hết thì chặn; gọi quá số còn thì cảnh báo (bếp kiểm thực tế còn thì xác nhận)
  ctx.portionsCheck = (item, qty, override) => {
    if (!enabled()) return;
    const left = ctx.portionsLeft(item.id);
    if (left == null || override) return;
    if (left < qty) fail(409, `${item.name}: kho chỉ còn đủ ${left} phần (theo định lượng). Hỏi bếp còn thực tế không, còn thì bấm xác nhận.`);
  };

  // Trừ kho khi gửi bếp
  ctx.consumeSale = (me, items) => {
    if (!enabled()) return [];
    const at = ctx.now();
    const date = ctx.today();
    const short = [];
    const touched = new Set();
    for (const i of items) {
      if (!i.menu_item_id) continue;
      for (const g of recipe(i.menu_item_id)) {
        const need = g.qty * i.qty;
        // Lấy ở kho khu trước, thiếu thì lấy tiếp kho tổng
        const main = mainStore()?.id;
        let left = need;
        for (const st of [...new Set([storeOf(g), main].filter(Boolean))]) {
          if (left <= 1e-9) break;
          const have = stockQty(db, st, g.id);
          const take = Math.min(left, have);
          if (take > 1e-9) {
            takeLots(db, { storeId: st, ingredientId: g.id, qty: take, allowShort: true });
            recordMove(db, { at, date, type: 'consume', ingredientId: g.id, fromStore: st, qty: take, cost: costOf(g, take), ref: `sale:${i.id}`, staffId: me?.id ?? null, note: `${i.name} ×${i.qty}` });
            left -= take;
          }
        }
        if (left > 1e-9 && tracked(g.id)) short.push({ ingredient: g.name, need: left, unit: g.unit, item: i.name });
      }
      touched.add(i.menu_item_id);
    }
    if (short.length) {
      ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead','team_lead')").all().map((x) => x.id), {
        title: 'Bán vượt tồn kho trên sổ', body: short.map((x) => `• ${x.item}: thiếu ${Math.round(x.need)} ${x.unit} ${x.ingredient}`).join('\n') + '\nKiểm kho thực tế, nhập bù nếu nhận hàng chưa ghi.', link: '/kho',
      });
    }
    ctx.refreshAvailability();
    return short;
  };

  // Huỷ trong thời gian ân hạn → trả lại kho
  ctx.restoreSale = (me, item) => {
    if (!enabled() || !item.menu_item_id) return;
    const moves = db.prepare("SELECT * FROM stock_moves WHERE ref = ? AND type = 'consume'").all(`sale:${item.id}`);
    for (const m of moves) {
      addLot(db, { storeId: m.from_store, ingredientId: m.ingredient_id, qty: m.qty, at: ctx.now() });
      recordMove(db, { at: ctx.now(), date: ctx.today(), type: 'adjust', ingredientId: m.ingredient_id, toStore: m.from_store, qty: m.qty, ref: `cancel:${item.id}`, staffId: me?.id ?? null, note: `Huỷ ${item.name} trước khi làm` });
    }
    ctx.refreshAvailability();
  };

  // Tự khoá / tự mở món theo tồn kho, báo "sắp hết" 1 lần mỗi ngày
  ctx.refreshAvailability = () => {
    if (!enabled()) return;
    const today = ctx.today();
    const changed = { out: [], back: [], low: [] };
    for (const [id, left] of ctx.portionsMap()) {
      const m = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
      if (!m || !m.active) continue;
      if (left === 0 && !m.sold_out) {
        db.prepare('UPDATE menu_items SET sold_out = 1, auto_sold_out = 1 WHERE id = ?').run(id);
        const miss = recipe(id).filter((g) => tracked(g.id) && usable(g) + 1e-9 < g.qty).map((g) => g.name);
        changed.out.push(`${m.name}${miss.length ? ` (hết ${miss.join(', ')})` : ''}`);
      }
      else if (left > 0 && m.sold_out && m.auto_sold_out) { db.prepare('UPDATE menu_items SET sold_out = 0, auto_sold_out = 0 WHERE id = ?').run(id); changed.back.push(`${m.name} (${left} phần)`); }
      else if (left > 0 && left <= lowN() && m.low_alert_date !== today) { db.prepare('UPDATE menu_items SET low_alert_date = ? WHERE id = ?').run(today, id); changed.low.push(`${m.name}: còn ${left} phần`); }
    }
    const to = kitchenAndService();
    if (changed.out.length) ctx.notify(to, { title: `HẾT MÓN (app tự khoá): ${changed.out.join(', ')}`, body: 'Nguyên liệu trong kho (khu + kho tổng) đã hết theo định lượng. Báo khách chọn món khác; nhập / lĩnh hàng về là app tự mở lại.', link: '/thuc-don', urgent: true });
    if (changed.low.length) ctx.notify(to, { title: `Sắp hết: ${changed.low.join(' · ')}`, body: 'Phục vụ báo khách sớm; bếp xem có lĩnh thêm từ kho tổng được không.', link: '/kho' });
    if (changed.back.length) ctx.notify(to, { title: `Có lại món: ${changed.back.join(', ')}`, link: '/thuc-don' });
    if (changed.out.length || changed.back.length) ctx.broadcast('menu');
    return changed;
  };
  // Mỗi lần kho thay đổi (nhận hàng, lĩnh hàng, kiểm kho) → xem lại món nào hết / có lại
  const orig = ctx.broadcast.bind(ctx);
  ctx.broadcast = (kind) => { if (kind === 'stock') { try { ctx.refreshAvailability(); } catch (e) { console.error(e); } } return orig(kind); };

  // ---------- 22:00 tổng hợp hàng cần nhập ----------
  ctx.purchaseReport = () => {
    const ids = ctx.generatePurchaseDrafts(null);
    const pos = ids.map((id) => ctx.loadPo(id));
    const vnd = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;
    const total = pos.reduce((n, p) => n + p.total, 0);
    const text = pos.map((p) => `【${p.supplier_name || 'Chưa có NCC'}】 ${vnd(p.total)}\n${p.lines.map((l) => `• ${l.name}: ${l.qty} ${l.purchase_unit || l.unit}`).join('\n')}`).join('\n\n');
    return { pos, total, text };
  };
  ctx.purchaseReportTick = () => {
    const now = ctx.now();
    const clock = ctx.clock();
    const [h, m] = String(ctx.setting('purchase_report_time') || '22:00').split(':').map(Number);
    const date = ctx.today();
    if (clock.minuteOf(now) < h * 60 + m || clock.dateOf(now) !== date || ctx.setting('purchase_report_date') === date) return null;
    ctx.setSetting('purchase_report_date', date);
    const rep = ctx.purchaseReport();
    const holder = Number(ctx.setting('kho_tong_staff_id') || 0);
    const to = [...new Set([...(holder ? [holder] : []), ...db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','team_lead')").all().map((x) => x.id)])];
    const outNow = db.prepare('SELECT name FROM menu_items WHERE sold_out = 1 AND active = 1').all().map((x) => x.name);
    ctx.notify(to, {
      title: rep.pos.length ? `Hàng cần nhập ngày mai: ${rep.pos.length} NCC · ${Number(rep.total).toLocaleString('vi-VN')}đ` : 'Hàng cần nhập ngày mai: kho đủ, không cần đặt',
      body: `${rep.text}${outNow.length ? `\n\nĐang hết món: ${outNow.join(', ')}` : ''}\n\nQuản lý duyệt đơn ở Kho → Đơn mua, bấm "Chép nội dung" gửi NCC.`,
      link: '/kho',
    });
    return rep;
  };

  r.get('/api/stock/portions', 'staff', () => Object.fromEntries(ctx.portionsMap()));
}
