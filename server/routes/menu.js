import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';

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

  r.patch('/api/menu/items/:id', 'staff', ({ me, params, body }) => {
    const cur = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy món');
    // Hết món / bán lại: tổ trưởng trở lên, thu ngân, hoặc người chủ quán tick riêng "Báo hết món" (chủ quán 29/10)
    const isCashier = !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
    const actHet = (() => { try { return JSON.parse(ctx.setting('perm_user') || '{}')[String(me.id)]?.['td.het']; } catch { return undefined; } })();
    if (rank(me.role) < rank('team_lead') && !((isCashier && actHet !== false) || actHet === true)) fail(403, 'Chỉ tổ trưởng / thu ngân trở lên báo hết món');
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
  r.post('/api/menu/reset-sold-out', 'shift_lead', ({ me }) => {
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
