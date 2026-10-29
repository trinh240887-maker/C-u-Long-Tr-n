import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { readMenu, billReaderKey } from '../lib/bill-reader.js';

// Thực đơn (GĐ3A): danh mục, món, tuỳ chọn, phần in ra nhiều điểm, công thức trừ kho, điểm in
export default function (r, ctx) {
  const { db } = ctx;
  const price = (x, name = 'Giá') => {
    const n = Number(String(x ?? '').replace(/[.,\s]/g, ''));
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000) fail(400, `${name} không hợp lệ (số nguyên VNĐ)`);
    return n;
  };
  const optRef = (table, value, name) => {
    const id = v.optInt(value, { min: 1, name });
    if (id && !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) fail(400, `${name} không tồn tại`);
    return id;
  };

  function menu({ all = false } = {}) {
    const stations = db.prepare('SELECT * FROM kitchen_stations ORDER BY sort, id').all().map((s) => ({ ...s, active: !!s.active }));
    const cats = db.prepare(`SELECT * FROM menu_categories ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all().map((c) => ({ ...c, active: !!c.active }));
    const parts = db.prepare('SELECT * FROM menu_item_parts ORDER BY sort, id').all();
    // Nhóm tuỳ chọn tạm ẩn khi gọi món (chủ quán 24/10: chưa bắt chọn tinh bột). Bỏ khỏi setting hidden_option_groups là hiện lại.
    const hidden = new Set(JSON.parse(ctx.setting('hidden_option_groups') || '["Tinh bột"]'));
    const opts = db.prepare('SELECT * FROM menu_options ORDER BY sort, id').all().filter((o) => all || !hidden.has(o.group_name));
    const recipes = db.prepare('SELECT r.*, g.name AS ingredient_name, g.unit FROM menu_recipes r JOIN ingredients g ON g.id = r.ingredient_id').all();
    const left = ctx.portionsMap ? ctx.portionsMap() : new Map();
    const items = db.prepare(`SELECT * FROM menu_items ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all().map((i) => ({
      ...i, active: !!i.active, sold_out: !!i.sold_out, auto_sold_out: !!i.auto_sold_out, left: left.has(i.id) ? left.get(i.id) : null,
      parts: parts.filter((p) => p.item_id === i.id).map(({ label, station_id }) => ({ label, station_id })),
      options: opts.filter((o) => o.item_id === i.id).map(({ id, group_name, name, price: p, required }) => ({ id, group_name, name, price: p, required: !!required })),
      recipe: recipes.filter((x) => x.item_id === i.id).map(({ ingredient_id, qty, ingredient_name, unit }) => ({ ingredient_id, qty, ingredient_name, unit })),
    }));
    return { stations, categories: cats, items, promo: ctx.promoTags ? ctx.promoTags() : { tags: {}, bill: [] } };
  }
  ctx.menu = menu;

  r.get('/api/menu', 'staff', ({ query }) => menu({ all: query.get('all') === '1' }));

  // ---------- Danh mục ----------
  r.post('/api/menu/categories', 'manager', ({ me, body }) => {
    const name = v.text(body.name, { name: 'Tên danh mục', required: true, max: 40 });
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM menu_categories').get().s;
    const id = Number(db.prepare('INSERT INTO menu_categories (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid);
    ctx.audit(me, 'menu.category.create', name);
    ctx.broadcast('menu');
    return { id };
  });
  r.patch('/api/menu/categories/:id', 'manager', ({ me, params, body }) => {
    const c = db.prepare('SELECT * FROM menu_categories WHERE id = ?').get(params.id);
    if (!c) fail(404, 'Không tìm thấy danh mục');
    db.prepare('UPDATE menu_categories SET name = ?, sort = ?, active = ? WHERE id = ?').run(
      body.name === undefined ? c.name : v.text(body.name, { name: 'Tên danh mục', required: true, max: 40 }),
      body.sort === undefined ? c.sort : v.int(body.sort, { name: 'Thứ tự' }),
      body.active === undefined ? c.active : v.bool(body.active), c.id);
    ctx.audit(me, 'menu.category.update', { id: c.id });
    ctx.broadcast('menu');
    return { ok: true };
  });

  // ---------- Món ----------
  function saveExtras(itemId, body) {
    if (Array.isArray(body.parts)) {
      db.prepare('DELETE FROM menu_item_parts WHERE item_id = ?').run(itemId);
      const add = db.prepare('INSERT INTO menu_item_parts (item_id, label, station_id, sort) VALUES (?, ?, ?, ?)');
      body.parts.forEach((p, i) => {
        const label = v.text(p.label, { name: 'Tên phần', max: 80 });
        if (label) add.run(itemId, label, optRef('kitchen_stations', p.station_id, 'Điểm in'), i);
      });
    }
    if (Array.isArray(body.options)) {
      db.prepare('DELETE FROM menu_options WHERE item_id = ?').run(itemId);
      const add = db.prepare('INSERT INTO menu_options (item_id, group_name, name, price, required, sort) VALUES (?, ?, ?, ?, ?, ?)');
      body.options.forEach((o, i) => {
        const name = v.text(o.name, { name: 'Tên tuỳ chọn', max: 60 });
        if (name) add.run(itemId, v.text(o.group_name, { name: 'Nhóm tuỳ chọn', max: 30 }) || 'Tuỳ chọn', name, price(o.price ?? 0, 'Giá tuỳ chọn'), v.bool(o.required), i);
      });
    }
    if (Array.isArray(body.recipe)) {
      db.prepare('DELETE FROM menu_recipes WHERE item_id = ?').run(itemId);
      const add = db.prepare('INSERT OR REPLACE INTO menu_recipes (item_id, ingredient_id, qty) VALUES (?, ?, ?)');
      for (const x of body.recipe) {
        const ing = optRef('ingredients', x.ingredient_id, 'Nguyên liệu');
        const qty = Number(String(x.qty ?? '').replace(',', '.'));
        if (!ing) continue;
        if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) fail(400, 'Lượng nguyên liệu không hợp lệ');
        add.run(itemId, ing, qty);
      }
    }
  }

  function itemFields(body, cur = {}) {
    return {
      name: body.name === undefined ? cur.name : v.text(body.name, { name: 'Tên món', required: true, max: 80 }),
      description: body.description === undefined ? cur.description ?? '' : v.text(body.description, { name: 'Mô tả', max: 200 }),
      price: body.price === undefined ? cur.price ?? 0 : price(body.price),
      category_id: body.category_id === undefined ? cur.category_id ?? null : optRef('menu_categories', body.category_id, 'Danh mục'),
      station_id: body.station_id === undefined ? cur.station_id ?? null : optRef('kitchen_stations', body.station_id, 'Điểm in'),
      kit_id: body.kit_id === undefined ? cur.kit_id ?? null : optRef('service_kits', body.kit_id, 'Kiểu dụng cụ'),
      active: body.active === undefined ? cur.active ?? 1 : v.bool(body.active),
      sold_out: body.sold_out === undefined ? cur.sold_out ?? 0 : v.bool(body.sold_out),
    };
  }

  r.post('/api/menu/items', 'manager', ({ me, body }) => {
    const f = itemFields(body);
    const id = tx(db, () => {
      const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM menu_items WHERE category_id IS ?').get(f.category_id).s;
      const id = Number(db.prepare('INSERT INTO menu_items (category_id, name, description, price, station_id, kit_id, active, sold_out, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(f.category_id, f.name, f.description, f.price, f.station_id, f.kit_id, f.active, f.sold_out, sort).lastInsertRowid);
      saveExtras(id, body);
      return id;
    });
    ctx.audit(me, 'menu.item.create', { id, name: f.name, price: f.price });
    ctx.broadcast('menu');
    return { id };
  });

  // ---------- Nhập từ ảnh menu mới nhất (chủ quán 29/10) ----------
  // Đọc ảnh → so với món đang có: món cũ xếp lại đúng thứ tự menu (giữ danh mục, điểm in, công thức), món mới thêm vào, giá khác thì hỏi
  const fold = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '');
  r.post('/api/menu/import/read', 'manager', async ({ body }) => {
    const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, 8);
    if (!photos.length) fail(400, 'Chụp ít nhất 1 trang menu');
    const all = db.prepare('SELECT i.id, i.name, i.price, i.active, i.category_id, c.name AS cat FROM menu_items i LEFT JOIN menu_categories c ON c.id = i.category_id').all();
    const cats = db.prepare('SELECT id, name FROM menu_categories').all();
    let out;
    try { out = await (ctx.readMenu || readMenu)(photos, all.filter((i) => i.active), { apiKey: billReaderKey(ctx) }); } catch (e) { fail(502, e.message); }
    const byId = new Map(all.map((i) => [i.id, i]));
    const used = new Set();
    const rows = [];
    for (const sec of out.sections || []) {
      const secRows = [];
      for (const it of sec.items || []) {
        const name = String(it.name || '').trim().slice(0, 80);
        if (!name) continue;
        let m = it.item_id && byId.get(Number(it.item_id));
        if (!m) m = all.find((x) => !used.has(x.id) && fold(x.name) === fold(name));
        if (m && used.has(m.id)) m = null; // 1 món chỉ khớp 1 dòng
        if (m) used.add(m.id);
        secRows.push({ section: String(sec.name || '').trim().slice(0, 40), name, price: Math.max(0, Math.round(Number(it.price) || 0)), description: String(it.description || '').slice(0, 200),
          item_id: m?.id || null, old_name: m?.name || '', old_price: m?.price ?? null, old_active: m ? !!m.active : null, cat_id: m?.category_id ?? null, cat_name: m?.cat || '' });
      }
      // Món mới: danh mục trùng tên nhóm trên menu → danh mục của món cũ gần nhất trong nhóm → tạo danh mục mới theo tên nhóm
      const sameCat = cats.find((c) => fold(c.name) === fold(sec.name));
      secRows.forEach((x, k) => {
        if (x.item_id) return;
        const near = [...secRows.slice(0, k).reverse(), ...secRows.slice(k + 1)].find((y) => y.item_id && y.cat_id);
        const c = sameCat || (near ? { id: near.cat_id, name: near.cat_name } : null);
        x.cat_id = c?.id ?? null; x.cat_name = c?.name || x.section || 'Món mới';
      });
      rows.push(...secRows);
    }
    const missing = all.filter((i) => i.active && !used.has(i.id)).map((i) => ({ id: i.id, name: i.name, price: i.price, cat: i.cat || '' }));
    return { rows, missing, note: out.note || '' };
  });
  r.post('/api/menu/import/apply', 'manager', ({ me, body }) => {
    const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 400);
    const hide = (Array.isArray(body.hide_ids) ? body.hide_ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
    let added = 0, priced = 0, moved = 0;
    tx(db, () => {
      const catOrder = [], perCat = new Map(), placed = new Set();
      const catId = (x) => {
        if (x.cat_id && db.prepare('SELECT 1 FROM menu_categories WHERE id = ?').get(Number(x.cat_id))) return Number(x.cat_id);
        const nm = v.text(x.cat_name || x.section || 'Món mới', { name: 'Tên danh mục', max: 40 }) || 'Món mới';
        const ex = db.prepare('SELECT id, name FROM menu_categories').all().find((c) => fold(c.name) === fold(nm));
        if (ex) return ex.id;
        return Number(db.prepare('INSERT INTO menu_categories (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM menu_categories))').run(nm).lastInsertRowid);
      };
      for (const x of rows) {
        let id = x.item_id ? Number(x.item_id) : null, cid;
        if (id) {
          const cur = db.prepare('SELECT id, category_id, price FROM menu_items WHERE id = ?').get(id);
          if (!cur) continue;
          cid = cur.category_id;
          if (x.set_price && Number(x.price) > 0 && Number(x.price) !== cur.price) { db.prepare('UPDATE menu_items SET price = ? WHERE id = ?').run(price(x.price), id); priced++; }
          if (x.reactivate) db.prepare('UPDATE menu_items SET active = 1 WHERE id = ?').run(id);
        } else {
          if (!x.add) continue;
          cid = catId(x);
          const st = db.prepare('SELECT station_id, COUNT(*) AS n FROM menu_items WHERE category_id = ? AND station_id IS NOT NULL GROUP BY station_id ORDER BY n DESC LIMIT 1').get(cid)?.station_id ?? null;
          id = Number(db.prepare('INSERT INTO menu_items (category_id, name, description, price, station_id, active, sold_out, sort) VALUES (?, ?, ?, ?, ?, 1, 0, 0)')
            .run(cid, v.text(x.name, { name: 'Tên món', required: true, max: 80 }), v.text(x.description || '', { name: 'Mô tả', max: 200 }), price(x.price), st).lastInsertRowid);
          added++;
        }
        if (cid != null && !catOrder.includes(cid)) catOrder.push(cid);
        const n = perCat.get(cid) || 0; perCat.set(cid, n + 1);
        db.prepare('UPDATE menu_items SET sort = ? WHERE id = ?').run(n, id);
        placed.add(id);
        moved++;
      }
      // Món trong danh mục mà không có trên menu: xếp sau; danh mục theo thứ tự xuất hiện trên menu, danh mục khác xếp sau
      for (const [cid, n] of perCat) {
        const rest = db.prepare('SELECT id FROM menu_items WHERE category_id IS ? ORDER BY sort, id').all(cid).map((x) => x.id).filter((x) => !placed.has(x));
        rest.forEach((x, k) => db.prepare('UPDATE menu_items SET sort = ? WHERE id = ?').run(n + k, x));
      }
      const others = db.prepare('SELECT id FROM menu_categories ORDER BY sort, id').all().map((c) => c.id).filter((x) => !catOrder.includes(x));
      [...catOrder, ...others].forEach((cid, k) => db.prepare('UPDATE menu_categories SET sort = ? WHERE id = ?').run(k, cid));
      for (const id of hide) db.prepare('UPDATE menu_items SET active = 0 WHERE id = ?').run(id);
    });
    ctx.audit(me, 'menu.import', { rows: rows.length, added, priced, hidden: hide.length });
    ctx.broadcast('menu');
    return { ok: true, added, priced, hidden: hide.length, sorted: moved };
  });

  // Ai được bấm Hết món / Bán lại: quản lý / chủ, thu ngân (trừ khi chủ quán bỏ tick), hoặc người được tick "td.het"
  const canSoldOut = (me) => {
    if (rank(me.real_role || me.role) >= rank('manager')) return true;
    let actHet;
    try { actHet = JSON.parse(ctx.setting('perm_user') || '{}')[String(me.id)]?.['td.het']; } catch {}
    if (actHet === true) return true;
    const isCashier = !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
    return isCashier && actHet !== false;
  };
  ctx.canSoldOut = canSoldOut;

  r.patch('/api/menu/items/:id', 'staff', ({ me, params, body }) => {
    const cur = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy món');
    // Hết món / bán lại: chỉ quản lý / chủ, thu ngân, hoặc người chủ quán tick riêng "Báo hết món" (chủ quán 29/10: trưởng ca, tổ trưởng không bấm)
    if (!canSoldOut(me)) fail(403, 'Chỉ quản lý hoặc thu ngân báo hết món / bán lại');
    // Tổ trưởng / trưởng ca chỉ được bật tắt "Hết món"; sửa giá, công thức cần quản lý
    if (rank(me.role) < rank('manager') && Object.keys(body).some((k) => k !== 'sold_out')) fail(403, 'Chỉ quản lý mới sửa được món; bạn chỉ bật/tắt "Hết món"');
    const f = itemFields(body, cur);
    tx(db, () => {
      db.prepare('UPDATE menu_items SET category_id = ?, name = ?, description = ?, price = ?, station_id = ?, kit_id = ?, active = ?, sold_out = ? WHERE id = ?')
        .run(f.category_id, f.name, f.description, f.price, f.station_id, f.kit_id, f.active, f.sold_out, cur.id);
      saveExtras(cur.id, body);
    });
    // Bấm tay Hết món / Bán lại → báo phục vụ, thu ngân, trưởng ca đang trong ca (chủ quán 29/10)
    if (body.sold_out !== undefined && !!f.sold_out !== !!cur.sold_out) {
      const to = (ctx.soldOutAudience ? ctx.soldOutAudience() : []).filter((x) => x !== me.id);
      if (to.length) ctx.notify(to, f.sold_out
        ? { title: `⛔ Hết món: ${f.name}`, body: `${me.name} báo hết. Báo khách chọn món khác.`, link: '/thuc-don', urgent: true }
        : { title: `✅ Bán lại: ${f.name}`, body: `${me.name} mở bán lại.`, link: '/thuc-don' });
      if (!f.sold_out) db.prepare('UPDATE menu_items SET auto_sold_out = 0 WHERE id = ?').run(cur.id);
    }
    ctx.audit(me, body.sold_out !== undefined && Object.keys(body).length === 1 ? 'menu.item.soldout' : 'menu.item.update',
      { id: cur.id, name: f.name, ...(f.price !== cur.price ? { price: [cur.price, f.price] } : {}), ...(body.sold_out !== undefined ? { sold_out: f.sold_out } : {}) });
    ctx.broadcast('menu');
    return { ok: true };
  });

  // Chuyển nhiều món sang 1 điểm in (chủ quán 29/10: tách xiên nướng ra máy riêng)
  r.post('/api/menu/items/station', 'manager', ({ me, body }) => {
    const sid = body.station_id ? v.int(body.station_id, { min: 1, name: 'Điểm in' }) : null;
    if (sid && !db.prepare('SELECT 1 FROM kitchen_stations WHERE id = ?').get(sid)) fail(404, 'Không tìm thấy điểm in');
    const ids = (Array.isArray(body.item_ids) ? body.item_ids : []).map(Number).filter((x) => x > 0).slice(0, 500);
    if (!ids.length) fail(400, 'Chọn ít nhất 1 món');
    let n = 0;
    tx(db, () => { for (const id of ids) n += Number(db.prepare('UPDATE menu_items SET station_id = ? WHERE id = ?').run(sid, id).changes); });
    ctx.audit(me, 'menu.item.bulk_station', { station: sid, items: ids.length });
    ctx.broadcast('menu');
    return { ok: true, changed: n };
  });

  // Mở lại mọi món "hết" (đầu ngày)
  r.post('/api/menu/reset-sold-out', 'staff', ({ me }) => {
    if (!canSoldOut(me)) fail(403, 'Chỉ quản lý hoặc thu ngân mở bán lại');
    const n = db.prepare('UPDATE menu_items SET sold_out = 0 WHERE sold_out = 1').run().changes;
    ctx.audit(me, 'menu.soldout.reset', { n });
    ctx.broadcast('menu');
    return { n };
  });

  // ---------- Điểm in ----------
  r.post('/api/kitchen-stations', 'manager', ({ me, body }) => {
    const name = v.text(body.name, { name: 'Tên điểm in', required: true, max: 30 });
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM kitchen_stations').get().s;
    const id = Number(db.prepare('INSERT INTO kitchen_stations (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid);
    ctx.audit(me, 'station.create', name);
    ctx.broadcast('menu');
    return { id };
  });
  r.patch('/api/kitchen-stations/:id', 'manager', ({ me, params, body }) => {
    const s = db.prepare('SELECT * FROM kitchen_stations WHERE id = ?').get(params.id);
    if (!s) fail(404, 'Không tìm thấy điểm in');
    const ip = body.printer_ip === undefined ? s.printer_ip : v.text(body.printer_ip, { name: 'IP máy in', max: 40 });
    if (ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) fail(400, 'IP máy in không hợp lệ, vd 192.168.1.234');
    const fb = body.fallback_station_id === undefined ? s.fallback_station_id : optRef('kitchen_stations', body.fallback_station_id, 'Máy dự phòng');
    if (fb === s.id) fail(400, 'Máy dự phòng phải là máy khác');
    db.prepare('UPDATE kitchen_stations SET name = ?, printer_ip = ?, printer_port = ?, fallback_station_id = ?, active = ?, late_minutes = ? WHERE id = ?').run(
      body.name === undefined ? s.name : v.text(body.name, { name: 'Tên điểm in', required: true, max: 30 }), ip,
      body.printer_port === undefined ? s.printer_port : v.int(body.printer_port, { min: 1, max: 65535, name: 'Cổng máy in' }),
      fb, body.active === undefined ? s.active : v.bool(body.active),
      body.late_minutes === undefined ? s.late_minutes : v.int(body.late_minutes, { min: 1, max: 120, name: 'Số phút báo trễ' }), s.id);
    ctx.audit(me, 'station.update', { id: s.id, ip });
    ctx.broadcast('menu');
    return { ok: true };
  });
}
