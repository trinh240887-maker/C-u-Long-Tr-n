import { fail, v } from '../http.js';
import { tx } from '../db.js';
import { addDays, isoWeekday } from '../lib/time.js';

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

  // Thêm nhiều đồ dùng 1 lần (chủ quán 26/10): mỗi dòng "Tên số đơn-vị", vd "Ly bia 120 cái", "Khay inox 30"
  // Món đã có mà sổ đang 0 → ghi số đang có; sổ đã có số thì giữ nguyên (đổi số qua Kiểm tuần để không che mất mát)
  r.post('/api/utensils/bulk', 'manager', ({ me, body }) => {
    const lines = String(body.text || '').split(/\r?\n/).map((x) => x.replace(/^[\s\-•*+\d.)]*(?=\D)/, '').trim()).filter(Boolean);
    if (!lines.length) fail(400, 'Nhập mỗi dòng 1 món, vd: Ly bia 120 cái');
    if (lines.length > 200) fail(400, 'Tối đa 200 dòng mỗi lần');
    const out = { added: [], updated: [], kept: [] };
    tx(db, () => {
      let sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM utensils').get().s;
      for (const line of lines) {
        const m = /^(.*?)[\s:,-]+(\d+)\s*([^\d\s][^\d]{0,11})?$/u.exec(line);
        const name = (m ? m[1] : line).trim().slice(0, 40);
        if (!name) continue;
        const qty = m ? Number(m[2]) : 0;
        const unit = (m?.[3] || '').trim().slice(0, 12) || 'cái';
        const cur = db.prepare('SELECT * FROM utensils WHERE lower(name) = lower(?)').get(name);
        if (!cur) {
          db.prepare('INSERT INTO utensils (name, unit, on_hand, sort) VALUES (?, ?, ?, ?)').run(name, unit, qty, sort++);
          out.added.push(name);
        } else if (!cur.on_hand && qty) {
          db.prepare('UPDATE utensils SET on_hand = ?, unit = ?, active = 1 WHERE id = ?').run(qty, m?.[3] ? unit : cur.unit, cur.id);
          out.updated.push(name);
        } else {
          if (!cur.active) db.prepare('UPDATE utensils SET active = 1 WHERE id = ?').run(cur.id);
          out.kept.push(name);
        }
      }
    });
    ctx.audit(me, 'utensil.bulk', out);
    ctx.broadcast('utensils');
    return out;
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

  // ---------- Đồ dùng: báo vỡ / mất + kiểm mỗi tuần (chủ quán 25/10) ----------
  db.exec(`CREATE TABLE IF NOT EXISTS utensil_moves (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, date TEXT NOT NULL, utensil_id INTEGER NOT NULL REFERENCES utensils(id) ON DELETE CASCADE,
    type TEXT NOT NULL, qty INTEGER NOT NULL, expected INTEGER, staff_id INTEGER, note TEXT NOT NULL DEFAULT '')`);
  const get = (id) => db.prepare('SELECT * FROM utensils WHERE id = ?').get(id);
  const nameOf = (id) => db.prepare('SELECT name FROM staff WHERE id = ?').get(id)?.name || '';

  // Báo vỡ / mất: ai cũng báo được; trừ số đang có, báo quản lý
  r.post('/api/utensils/:id/break', 'staff', ({ me, params: p, body }) => {
    const u = get(p.id);
    if (!u || !u.active) fail(404, 'Không tìm thấy đồ dùng');
    const qty = Math.round(num(body.qty, 'Số lượng', { min: 1, max: 1000 }));
    const kind = body.kind === 'lost' ? 'lost' : 'break';
    const note = v.text(body.note, { name: 'Ghi chú', max: 200 });
    const who = v.text(body.who, { name: 'Người làm vỡ', max: 60 });
    tx(db, () => {
      db.prepare('UPDATE utensils SET on_hand = MAX(0, on_hand - ?) WHERE id = ?').run(qty, u.id);
      db.prepare('INSERT INTO utensil_moves (at, date, utensil_id, type, qty, staff_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.now(), ctx.today(), u.id, kind, -qty, me.id, [who && `Người làm: ${who}`, note].filter(Boolean).join(' · '));
    });
    ctx.notify(ctx.managers().filter((x) => x !== me.id), { title: `${kind === 'lost' ? 'Mất' : 'Vỡ'} ${qty} ${u.unit} ${u.name}`, body: `${me.name || ''} báo${who ? ` · người làm: ${who}` : ''}${note ? ` · ${note}` : ''}`, link: '/kho?tab=dodung' });
    ctx.audit(me, 'utensil.break', { id: u.id, qty, kind });
    ctx.broadcast('utensils');
    return { ok: true };
  });

  // Kiểm tuần: nhập số đếm thực tế; thiếu so với sổ (đã trừ phần báo vỡ) = "mất không rõ"
  r.post('/api/utensils/count', 'team_lead', ({ me, body }) => {
    const lines = (Array.isArray(body.lines) ? body.lines : []).filter((l) => l.actual !== '' && l.actual != null);
    if (!lines.length) fail(400, 'Nhập số đếm cho ít nhất một món');
    const out = [];
    tx(db, () => {
      for (const l of lines) {
        const u = get(v.int(l.utensil_id, { min: 1, name: 'Đồ dùng' }));
        if (!u) fail(404, 'Không tìm thấy đồ dùng');
        const actual = Math.round(num(l.actual, `Số đếm ${u.name}`, { max: 100000 }));
        const diff = actual - u.on_hand;
        db.prepare('UPDATE utensils SET on_hand = ? WHERE id = ?').run(actual, u.id);
        db.prepare('INSERT INTO utensil_moves (at, date, utensil_id, type, qty, expected, staff_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(ctx.now(), ctx.today(), u.id, 'count', diff, u.on_hand, me.id, diff < 0 ? 'Mất không rõ (kiểm tuần)' : diff > 0 ? 'Thừa so với sổ' : '');
        out.push({ utensil_id: u.id, name: u.name, unit: u.unit, expected: u.on_hand, actual, diff });
      }
    });
    ctx.setSetting('utensil_count_at', String(ctx.now()));
    const missing = out.filter((x) => x.diff < 0);
    if (missing.length) {
      ctx.notify(ctx.managers().filter((x) => x !== me.id), {
        title: `Kiểm đồ dùng: thiếu ${missing.length} món không rõ lý do`,
        body: `${me.name || ''} kiểm:\n${missing.map((x) => `• ${x.name}: sổ ${x.expected}, đếm ${x.actual} (−${-x.diff})`).join('\n')}`, link: '/kho?tab=dodung',
      });
    }
    ctx.audit(me, 'utensil.count', { n: out.length, missing: missing.length });
    ctx.broadcast('utensils');
    return { lines: out };
  });

  // Tổng hợp: số đang có, vỡ/mất 4 tuần gần nhất, lần kiểm gần nhất
  r.get('/api/utensils/report', 'staff', () => {
    const from = addDays(ctx.today(), -28);
    const moves = db.prepare(`SELECT m.*, u.name, u.unit FROM utensil_moves m JOIN utensils u ON u.id = m.utensil_id WHERE m.date >= ? ORDER BY m.at DESC LIMIT 200`).all(from)
      .map((m) => ({ ...m, staff_name: nameOf(m.staff_id) }));
    const at = Number(ctx.setting('utensil_count_at') || 0);
    return {
      items: db.prepare('SELECT id, name, unit, on_hand FROM utensils WHERE active = 1 ORDER BY sort, id').all(),
      moves, last_count_at: at || null, due: !at || ctx.now() - at > 7 * 86_400_000,
    };
  });

  // Nhắc kiểm đồ dùng mỗi tuần: Chủ nhật 21:00 (cài được), quá 7 ngày chưa kiểm → nhắc quản lý / trưởng ca
  ctx.utensilCountTick = () => {
    const c = ctx.clock(), n = ctx.now();
    const date = c.dateOf(n);
    if (isoWeekday(date) !== Number(ctx.setting('utensil_count_dow') || 7) || c.minuteOf(n) < 21 * 60) return;
    const key = `utensil_remind:${date}`;
    if (ctx.setting(key)) return;
    ctx.setSetting(key, '1');
    const at = Number(ctx.setting('utensil_count_at') || 0);
    if (at && n - at < 6 * 86_400_000) return;
    if (!db.prepare('SELECT 1 FROM utensils WHERE active = 1').get()) return;
    const ids = db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((x) => x.id);
    ctx.notify(ids, { title: 'Đến hạn kiểm đồ dùng tuần này', body: 'Đếm chén, dĩa, ly, nồi… rồi nhập ở Kho → Đồ dùng → Kiểm tuần.', link: '/kho?tab=dodung', urgent: true });
  };
}
