import { fail, v } from '../http.js';
import { tx } from '../db.js';

// Dụng cụ ăn uống và dự trù số bộ cần chuẩn bị theo số khách cao điểm
export default function (r, ctx) {
  const { db } = ctx;
  const num = (x, name, { min = 0, max = 1e6 } = {}) => {
    const n = Number(String(x ?? '').replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > max) fail(400, `${name} không hợp lệ`);
    return n;
  };
  const params = () => ({
    wash_cycle_minutes: Number(ctx.setting('wash_cycle_minutes') || 30),
    dining_minutes: Number(ctx.setting('dining_minutes') || 70),
    reserve_pct: Number(ctx.setting('utensil_reserve_pct') || 10),
  });

  function list() {
    const utensils = db.prepare('SELECT * FROM utensils ORDER BY active DESC, sort, id').all().map((u) => ({ ...u, active: !!u.active }));
    const items = db.prepare('SELECT * FROM kit_items').all();
    const kits = db.prepare('SELECT * FROM service_kits ORDER BY active DESC, sort, id').all()
      .map((k) => ({ ...k, active: !!k.active, items: items.filter((i) => i.kit_id === k.id).map(({ utensil_id, per_guest }) => ({ utensil_id, per_guest })) }));
    return { utensils, kits, params: params() };
  }

  r.get('/api/utensils', 'staff', () => list());

  r.post('/api/utensils', 'manager', ({ me, body }) => {
    const name = v.text(body.name, { name: 'Tên dụng cụ', required: true, max: 40 });
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM utensils').get().s;
    const id = Number(db.prepare('INSERT INTO utensils (name, unit, on_hand, sort) VALUES (?, ?, ?, ?)')
      .run(name, v.text(body.unit, { name: 'Đơn vị', max: 12 }) || 'cái', Math.round(num(body.on_hand ?? 0, 'Số đang có')), sort).lastInsertRowid);
    ctx.audit(me, 'utensil.create', name);
    ctx.broadcast('utensils');
    return { id };
  });

  r.patch('/api/utensils/:id', 'manager', ({ me, params: p, body }) => {
    const u = db.prepare('SELECT * FROM utensils WHERE id = ?').get(p.id);
    if (!u) fail(404, 'Không tìm thấy dụng cụ');
    db.prepare('UPDATE utensils SET name = ?, unit = ?, on_hand = ?, active = ? WHERE id = ?').run(
      body.name === undefined ? u.name : v.text(body.name, { name: 'Tên dụng cụ', required: true, max: 40 }),
      body.unit === undefined ? u.unit : v.text(body.unit, { name: 'Đơn vị', max: 12 }) || 'cái',
      body.on_hand === undefined ? u.on_hand : Math.round(num(body.on_hand, 'Số đang có')),
      body.active === undefined ? u.active : v.bool(body.active), u.id,
    );
    ctx.audit(me, 'utensil.update', { id: u.id });
    ctx.broadcast('utensils');
    return { ok: true };
  });

  function saveKitItems(kitId, items) {
    if (!Array.isArray(items)) return;
    db.prepare('DELETE FROM kit_items WHERE kit_id = ?').run(kitId);
    const add = db.prepare('INSERT OR REPLACE INTO kit_items (kit_id, utensil_id, per_guest) VALUES (?, ?, ?)');
    for (const it of items) {
      const uid = v.int(it.utensil_id, { min: 1, name: 'Dụng cụ' });
      if (!db.prepare('SELECT 1 FROM utensils WHERE id = ?').get(uid)) fail(400, 'Dụng cụ không tồn tại');
      const q = num(it.per_guest, 'Số cái mỗi khách', { max: 20 });
      if (q > 0) add.run(kitId, uid, q);
    }
  }

  r.post('/api/service-kits', 'manager', ({ me, body }) => {
    const name = v.text(body.name, { name: 'Tên kiểu phục vụ', required: true, max: 40 });
    const id = tx(db, () => {
      const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM service_kits').get().s;
      const id = Number(db.prepare('INSERT INTO service_kits (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid);
      saveKitItems(id, body.items);
      return id;
    });
    ctx.audit(me, 'kit.create', name);
    ctx.broadcast('utensils');
    return { id };
  });

  r.patch('/api/service-kits/:id', 'manager', ({ me, params: p, body }) => {
    const k = db.prepare('SELECT * FROM service_kits WHERE id = ?').get(p.id);
    if (!k) fail(404, 'Không tìm thấy kiểu phục vụ');
    tx(db, () => {
      db.prepare('UPDATE service_kits SET name = ?, active = ? WHERE id = ?').run(
        body.name === undefined ? k.name : v.text(body.name, { name: 'Tên kiểu phục vụ', required: true, max: 40 }),
        body.active === undefined ? k.active : v.bool(body.active), k.id,
      );
      saveKitItems(k.id, body.items);
    });
    ctx.audit(me, 'kit.update', { id: k.id });
    ctx.broadcast('utensils');
    return { ok: true };
  });

  // Dự trù: khách ngồi cùng lúc lúc đông nhất (theo kiểu phục vụ) → số cái mỗi dụng cụ cần có
  //   cần = khách × số cái/khách × (1 + thời gian rửa / thời gian ngồi) × (1 + dự phòng)
  //   phần (rửa / ngồi): bộ của khách vừa rời bàn còn đang chờ rửa khi khách mới vào
  ctx.utensilPlan = (guestsByKit) => {
    const { utensils, kits, params: pr } = list();
    const turn = pr.dining_minutes > 0 ? pr.wash_cycle_minutes / pr.dining_minutes : 0;
    const factor = (1 + turn) * (1 + pr.reserve_pct / 100);
    const need = new Map();
    for (const k of kits.filter((x) => x.active)) {
      const g = Number(guestsByKit[k.id] || 0);
      for (const it of k.items) need.set(it.utensil_id, (need.get(it.utensil_id) || 0) + g * it.per_guest);
    }
    const rows = utensils.filter((u) => u.active && need.has(u.id)).map((u) => {
      const base = need.get(u.id);
      const required = Math.ceil(Math.round(base * factor * 1e6) / 1e6);
      return { utensil_id: u.id, name: u.name, unit: u.unit, at_table: Math.ceil(base), required, on_hand: u.on_hand, short: Math.max(0, required - u.on_hand) };
    });
    return { params: pr, factor: Math.round(factor * 100) / 100, rows };
  };

  r.post('/api/utensils/plan', 'team_lead', ({ body }) => {
    const guests = {};
    for (const [k, val] of Object.entries(body.guests || {})) guests[Number(k)] = Math.round(num(val, 'Số khách', { max: 5000 }));
    return ctx.utensilPlan(guests);
  });
}
