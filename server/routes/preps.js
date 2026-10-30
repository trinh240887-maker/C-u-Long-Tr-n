// Bán thành phẩm (chủ quán 30/10): cốt lẩu, nước dùng, nước chấm, sốt steak, sốt xiên, bột… nấu theo mẻ từ 4 sổ công thức.
// Mỗi bán thành phẩm: nguyên liệu theo mẻ (khớp mã kho nếu có), thành phẩm, hạn dùng, cỡ túi, các bước có phút đứng bếp / phút chờ.
// Nguồn: server/data/so-cong-thuc.json (trích từ 4 file Excel chủ quán gửi 30/10, bản 11/10/2026). Nạp lại thì giữ phút đã sửa tay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { addDays } from '../lib/time.js';
import { forecastDay, r3 } from '../lib/forecast.js';
import { stockQty, addLot, takeLots, recordMove, costOf } from '../lib/stock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(here, '..', 'data', 'so-cong-thuc.json');
const fold = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

export default function (r, ctx) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS preps (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, book TEXT NOT NULL DEFAULT '', sheet TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'batch', batch_col TEXT NOT NULL DEFAULT '', out_qty REAL, out_unit TEXT NOT NULL DEFAULT 'g',
      shelf_text TEXT NOT NULL DEFAULT '', shelf_days INTEGER, packs TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]', steps_edited INTEGER NOT NULL DEFAULT 0,
      output_ingredient_id INTEGER, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS prep_lines (
      id INTEGER PRIMARY KEY, prep_id INTEGER NOT NULL REFERENCES preps(id) ON DELETE CASCADE, pos INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'g',
      qty REAL NOT NULL DEFAULT 0, unit_price REAL, note TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '', kl REAL, ingredient_id INTEGER);`);

  const seed = () => JSON.parse(fs.readFileSync(SEED, 'utf8'));
  // Khớp tên trong sổ ("Mã NL") với nguyên liệu trong kho: trùng tên bỏ dấu, hoặc tên này chứa trọn tên kia
  const matcher = () => {
    const ings = db.prepare('SELECT id, name FROM ingredients WHERE active = 1').all().map((g) => ({ ...g, f: fold(g.name) })).filter((g) => g.f.length >= 3);
    return (name) => {
      const f = fold(name);
      if (!f) return null;
      return ings.find((g) => g.f === f) || ings.filter((g) => (f.includes(g.f) && g.f.length >= 4) || (g.f.includes(f) && f.length >= 4)).sort((a, b) => b.f.length - a.f.length)[0] || null;
    };
  };
  // Cốt lẩu có chia túi: thêm bước rót túi + ngâm đá (sổ Vận hành: 60 phút nấu + 10 phút rót túi + 20 phút ngâm đá)
  const withPackSteps = (p) => {
    if (!p.packs) return p.steps;
    let steps = p.steps.map((s) => (/rót túi|chia túi/i.test(s.text) && !(s.min > 0) ? { ...s, min: 10 } : s)); // bước rót túi: ít nhất 10 phút
    if (!steps.some((s) => /rót túi|chia túi/i.test(s.text))) steps = [...steps, { text: `Chia túi + dán nhãn (tên vị, cỡ túi, ngày nấu, số mẻ): ${p.packs}`, min: 10, wait: 0 }];
    if (!steps.some((s) => /đá/i.test(s.text) && s.wait > 0)) steps = [...steps, { text: 'Ngâm nước đá 1 lớp đến tâm túi < 10°C rồi cất tủ mát', min: 0, wait: 20 }];
    return steps;
  };

  function importSeed(me) {
    const d = seed();
    const match = matcher();
    // Mã kho đã gắn tay trước đó (theo Mã NL / tên) → giữ khi nạp lại
    const kept = new Map(db.prepare("SELECT code, name, ingredient_id FROM prep_lines WHERE ingredient_id IS NOT NULL").all().flatMap((l) => [[`c:${l.code}`, l.ingredient_id], [`n:${l.name}`, l.ingredient_id]]));
    let added = 0, updated = 0;
    tx(db, () => {
      for (const p of d.preps) {
        const cur = db.prepare('SELECT id, steps_edited FROM preps WHERE code = ?').get(p.code);
        const steps = JSON.stringify(withPackSteps(p));
        let id;
        if (cur) {
          id = cur.id;
          db.prepare(`UPDATE preps SET book = ?, sheet = ?, name = ?, title = ?, kind = ?, batch_col = ?, out_qty = ?, out_unit = ?, shelf_text = ?, shelf_days = ?, packs = ?, updated_at = ?${cur.steps_edited ? '' : ', steps = ?'} WHERE id = ?`)
            .run(...[p.book, p.sheet, p.name, p.title, p.kind, p.batch_col, p.out_qty, p.out_unit, p.shelf_text, p.shelf_days, p.packs, ctx.now(), ...(cur.steps_edited ? [] : [steps]), id]);
          db.prepare('DELETE FROM prep_lines WHERE prep_id = ?').run(id);
          updated++;
        } else {
          id = Number(db.prepare(`INSERT INTO preps (code, book, sheet, name, title, kind, batch_col, out_qty, out_unit, shelf_text, shelf_days, packs, steps, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(p.code, p.book, p.sheet, p.name, p.title, p.kind, p.batch_col, p.out_qty, p.out_unit, p.shelf_text, p.shelf_days, p.packs, steps, ctx.now()).lastInsertRowid);
          added++;
        }
        p.lines.forEach((l, k) => {
          const keep = (l.code && kept.get(`c:${l.code}`)) || kept.get(`n:${l.name}`);
          const g = keep ? { id: keep } : l.code ? match(l.code) || match(l.name) : match(l.name);
          db.prepare('INSERT INTO prep_lines (prep_id, pos, name, unit, qty, unit_price, note, code, kl, ingredient_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, k, l.name, l.unit, l.qty, l.unit_price, l.note, l.code, l.kl, g?.id ?? null);
        });
      }
    });
    ctx.setSetting('preps_version', d.version);
    ctx.audit(me, 'preps.import', { added, updated, version: d.version });
    return { added, updated, version: d.version };
  }
  ctx.importPreps = importSeed;
  // Lần đầu (chưa có bán thành phẩm nào): tự nạp 4 sổ
  if (!ctx.setting('preps_auto_v1')) {
    try { if (!db.prepare('SELECT 1 FROM preps LIMIT 1').get()) importSeed(null); } catch (e) { console.error('Nạp sổ công thức lỗi:', e.message); }
    ctx.setSetting('preps_auto_v1', '1');
  }

  const load = (p) => {
    const lines = db.prepare('SELECT l.*, g.name AS ing_name, g.unit AS ing_unit FROM prep_lines l LEFT JOIN ingredients g ON g.id = l.ingredient_id WHERE l.prep_id = ? ORDER BY l.pos').all(p.id);
    const steps = JSON.parse(p.steps || '[]');
    return { ...p, steps, lines, cost: Math.round(lines.reduce((n, l) => n + (l.qty || 0) * (l.unit_price || 0), 0)),
      active_min: steps.reduce((n, s) => n + (Number(s.min) || 0), 0), wait_min: steps.reduce((n, s) => n + (Number(s.wait) || 0), 0),
      unmatched: lines.filter((l) => !l.ingredient_id && (l.unit_price || 0) > 0).length };
  };
  r.get('/api/preps', 'staff', () => ({
    version: ctx.setting('preps_version') || null, seed_version: (() => { try { return seed().version; } catch { return null; } })(),
    preps: db.prepare('SELECT * FROM preps WHERE active = 1 ORDER BY id').all().map(load),
  }));
  r.post('/api/preps/import', 'manager', ({ me }) => importSeed(me));
  // Sửa phút đứng bếp / phút chờ từng bước (bếp trưởng chỉnh theo thực tế) → nạp lại sổ không ghi đè
  r.patch('/api/preps/:id/steps', 'manager', ({ me, params, body }) => {
    const p = db.prepare('SELECT * FROM preps WHERE id = ?').get(params.id);
    if (!p) fail(404, 'Không tìm thấy bán thành phẩm');
    const steps = (Array.isArray(body.steps) ? body.steps : []).slice(0, 40).map((s) => ({ text: v.text(s.text, { name: 'Bước', required: true, max: 600 }), min: v.int(s.min || 0, { min: 0, max: 1440, name: 'Phút' }), wait: v.int(s.wait || 0, { min: 0, max: 2880, name: 'Phút chờ' }) }));
    db.prepare('UPDATE preps SET steps = ?, steps_edited = 1, updated_at = ? WHERE id = ?').run(JSON.stringify(steps), ctx.now(), p.id);
    ctx.audit(me, 'preps.steps', { id: p.id, name: p.name });
    ctx.broadcast('stock');
    return load(db.prepare('SELECT * FROM preps WHERE id = ?').get(p.id));
  });
  // Tạo mã kho hàng loạt cho nguyên liệu trong sổ chưa có trong kho (giá = đơn giá trong sổ, đơn vị g / ml)
  r.post('/api/preps/create-missing', 'manager', ({ me }) => {
    const miss = db.prepare("SELECT code, name, unit, MAX(unit_price) AS price FROM prep_lines WHERE ingredient_id IS NULL AND unit_price > 0 GROUP BY CASE WHEN code != '' THEN code ELSE name END").all();
    let made = 0;
    tx(db, () => {
      for (const l of miss) {
        const name = String(l.code || l.name).slice(0, 80);
        const unit = ['g', 'ml'].includes(l.unit) ? l.unit : 'g';
        const ex = db.prepare('SELECT id FROM ingredients WHERE lower(name) = lower(?)').get(name);
        const id = ex ? ex.id : Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price, freshness) VALUES (?, ?, ?, 1, ?, 'dry')").run(name, unit, unit, Math.round(l.price * 100) / 100).lastInsertRowid);
        if (!ex) made++;
        if (l.code) db.prepare('UPDATE prep_lines SET ingredient_id = ? WHERE ingredient_id IS NULL AND code = ?').run(id, l.code);
        else db.prepare('UPDATE prep_lines SET ingredient_id = ? WHERE ingredient_id IS NULL AND name = ?').run(id, l.name);
      }
    });
    ctx.audit(me, 'preps.create_missing', { made, groups: miss.length });
    ctx.broadcast('stock');
    return { ok: true, made };
  });
  // Gắn tay 1 dòng nguyên liệu với mã kho (hoặc tạo mã kho mới theo đơn giá trong sổ)
  r.patch('/api/preps/lines/:id', 'manager', ({ me, params, body }) => {
    const l = db.prepare('SELECT * FROM prep_lines WHERE id = ?').get(params.id);
    if (!l) fail(404, 'Không tìm thấy dòng');
    let ingId = body.ingredient_id ? v.int(body.ingredient_id, { min: 1, name: 'Nguyên liệu' }) : null;
    if (body.create) {
      const name = v.text(l.code || l.name, { name: 'Tên', required: true, max: 80 });
      const ex = db.prepare('SELECT id FROM ingredients WHERE lower(name) = lower(?)').get(name);
      const unit = ['g', 'ml', 'kg', 'l'].includes(l.unit) ? l.unit : 'g';
      ingId = ex ? ex.id : Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price, freshness) VALUES (?, ?, ?, 1, ?, 'dry')").run(name, unit, unit, Math.round(l.unit_price || 0)).lastInsertRowid);
    }
    if (ingId && !db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(ingId)) fail(404, 'Không tìm thấy nguyên liệu');
    // Cùng tên trong các sổ khác cũng gắn luôn
    db.prepare("UPDATE prep_lines SET ingredient_id = ? WHERE (id = ? OR (code != '' AND code = ?)) ").run(ingId, l.id, l.code);
    ctx.audit(me, 'preps.line', { line: l.id, ingredient_id: ingId, create: !!body.create });
    ctx.broadcast('stock');
    return { ok: true, ingredient_id: ingId };
  });

  // ================= 3b: Ghi mẻ nấu (chủ quán duyệt 30/10) =================
  // Nấu 1 mẻ: trừ nguyên liệu sống theo sổ × số mẻ (ref prep:<id>, cột Xuất dùng) → cộng thành phẩm (cốt, sốt…) vào kho theo số cân thật, hạn dùng theo sổ.
  // Món bán vẫn trừ mã thành phẩm như cũ (định lượng món). Huỷ mẻ ghi nhầm: trong ngày, quản lý.
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('preps').includes('station')) db.exec("ALTER TABLE preps ADD COLUMN station TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS prep_batches (
      id INTEGER PRIMARY KEY, prep_id INTEGER NOT NULL REFERENCES preps(id) ON DELETE CASCADE, date TEXT NOT NULL, at INTEGER NOT NULL, staff_id INTEGER,
      batches REAL NOT NULL DEFAULT 1, out_qty REAL NOT NULL DEFAULT 0, out_unit TEXT NOT NULL DEFAULT 'g', minutes INTEGER, cost INTEGER NOT NULL DEFAULT 0,
      store_id INTEGER, ingredient_id INTEGER, plan_id INTEGER, note TEXT NOT NULL DEFAULT '', voided_at INTEGER, voided_by INTEGER);
    CREATE INDEX IF NOT EXISTS prep_batches_by_date ON prep_batches(date);
    CREATE TABLE IF NOT EXISTS prep_plan (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, prep_id INTEGER NOT NULL REFERENCES preps(id) ON DELETE CASCADE, batches REAL NOT NULL DEFAULT 0,
      station TEXT NOT NULL DEFAULT '', staff_id INTEGER, forecast REAL, stock REAL, need REAL, basis TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0, UNIQUE (date, prep_id));
    CREATE TABLE IF NOT EXISTS prep_plan_ticks (plan_id INTEGER NOT NULL REFERENCES prep_plan(id) ON DELETE CASCADE, step INTEGER NOT NULL, staff_id INTEGER, at INTEGER NOT NULL, PRIMARY KEY (plan_id, step));`);

  const STATION_OF_BOOK = { 'Lẩu': 'Lẩu', 'Nước chấm': 'Lẩu', 'Sốt steak': 'Steak', 'Xiên nướng': 'Nướng' };
  const stationOf = (p) => p.station || STATION_OF_BOOK[p.book] || 'Bếp';
  // Đổi đơn vị sổ → đơn vị kho (g↔kg, ml↔lít; g ≈ ml cho nước sốt). Không đổi được → null
  const BASE = { g: ['m', 1], gr: ['m', 1], gram: ['m', 1], kg: ['m', 1000], ml: ['m', 1], l: ['m', 1000], lit: ['m', 1000], 'lít': ['m', 1000] };
  const conv = (from, to) => {
    const a = String(from || '').toLowerCase().trim(), b = String(to || '').toLowerCase().trim();
    if (a === b) return 1;
    if (BASE[a] && BASE[b]) return BASE[a][1] / BASE[b][1];
    return null;
  };
  const mainStore = () => db.prepare("SELECT * FROM stores WHERE kind = 'main' AND active = 1 ORDER BY id LIMIT 1").get();
  const storeFor = (ing) => (ctx.setting('single_store') === '1' ? mainStore()?.id : ing.home_store_id || mainStore()?.id);
  const totalStock = (ingId) => r3(db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(ingId).q);
  const canCook = (me) => {
    if (rank(me.role) >= rank('team_lead')) return true;
    const t = me.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(me.team_id) : null;
    return !!t && /bếp|bep|lẩu|lau|nướng|steak/i.test(t.name);
  };
  const ingOf = (id) => (id ? db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id) : null);
  const outPerBatch = (p, ing) => { const f = conv(p.out_unit, ing.unit); return p.out_qty && f ? r3(p.out_qty * f) : null; };

  // Gắn mã kho thành phẩm (vd "Cốt lẩu Tứ Xuyên") cho bán thành phẩm, hoặc tạo mới
  r.patch('/api/preps/:id/output', 'manager', ({ me, params, body }) => {
    const p = db.prepare('SELECT * FROM preps WHERE id = ?').get(params.id);
    if (!p) fail(404, 'Không tìm thấy bán thành phẩm');
    let ingId = body.ingredient_id ? v.int(body.ingredient_id, { min: 1, name: 'Mã thành phẩm' }) : null;
    if (body.create) {
      const name = v.text(body.name || p.name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/[^\p{L}\p{N}\s—–-]/gu, '').trim(), { name: 'Tên', required: true, max: 80 });
      const ex = db.prepare('SELECT id FROM ingredients WHERE lower(name) = lower(?)').get(name);
      const c = load(p).cost;
      const unit = ['g', 'ml'].includes(p.out_unit) ? p.out_unit : 'g';
      ingId = ex ? ex.id : Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price, freshness) VALUES (?, ?, ?, 1, ?, 'chilled')").run(name, unit, unit, p.out_qty ? Math.round((c / p.out_qty) * 100) / 100 : 0).lastInsertRowid);
    }
    if (ingId && !ingOf(ingId)) fail(404, 'Không tìm thấy nguyên liệu');
    db.prepare('UPDATE preps SET output_ingredient_id = ?, updated_at = ? WHERE id = ?').run(ingId, ctx.now(), p.id);
    ctx.audit(me, 'preps.output', { id: p.id, ingredient_id: ingId });
    ctx.broadcast('stock');
    return { ok: true, ingredient_id: ingId };
  });
  // Đổi điểm làm (Lẩu / Steak / Nướng…) mặc định của bán thành phẩm
  r.patch('/api/preps/:id/station', 'manager', ({ me, params, body }) => {
    const p = db.prepare('SELECT id FROM preps WHERE id = ?').get(params.id);
    if (!p) fail(404, 'Không tìm thấy bán thành phẩm');
    db.prepare('UPDATE preps SET station = ? WHERE id = ?').run(v.text(body.station || '', { name: 'Điểm làm', max: 30 }), p.id);
    ctx.audit(me, 'preps.station', { id: p.id, station: body.station });
    ctx.broadcast('stock');
    return { ok: true };
  });

  function cook(me, p, { batches = 1, outQty = null, minutes = null, note = '', planId = null }) {
    const out = ingOf(p.output_ingredient_id);
    if (!out) fail(409, `${p.name}: chưa gắn mã kho thành phẩm. Quản lý vào Kho → Bán thành phẩm → chọn mã thành phẩm trước.`, 'no_output');
    const per = outPerBatch(p, out);
    const outU = outQty != null ? outQty : per != null ? per * batches : null;
    if (!(outU > 0)) fail(400, 'Nhập khối lượng thành phẩm thực tế');
    const at = ctx.now(), date = ctx.today();
    const short = [], skipped = [];
    let cost = 0;
    const bid = Number(db.prepare('INSERT INTO prep_batches (prep_id, date, at, staff_id, batches, out_qty, out_unit, minutes, store_id, ingredient_id, plan_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, date, at, me.id, batches, r3(outU), out.unit, minutes, storeFor(out), out.id, planId, note).lastInsertRowid);
    const ref = `prep:${bid}`;
    const lines = db.prepare('SELECT * FROM prep_lines WHERE prep_id = ? ORDER BY pos').all(p.id);
    for (const l of lines) {
      if (!(l.qty > 0)) continue;
      const g = ingOf(l.ingredient_id);
      if (!g) { if ((l.unit_price || 0) > 0) skipped.push(l.name); continue; }
      if (g.id === out.id) continue;
      const f = conv(l.unit, g.unit);
      if (f == null) { skipped.push(`${l.name} (${l.unit} ≠ ${g.unit})`); continue; }
      const need = r3(l.qty * batches * f);
      let left = need;
      for (const st of [...new Set([storeFor(g), mainStore()?.id].filter(Boolean))]) {
        if (left <= 1e-9) break;
        const take = Math.min(left, stockQty(db, st, g.id));
        if (take > 1e-9) {
          takeLots(db, { storeId: st, ingredientId: g.id, qty: take, allowShort: true });
          const c = costOf(g, take);
          cost += c;
          recordMove(db, { at, date, type: 'consume', ingredientId: g.id, fromStore: st, qty: take, cost: c, ref, staffId: me.id, note: `Nấu ${p.name} ×${batches}` });
          left = r3(left - take);
        }
      }
      if (left > 1e-9) { cost += costOf(g, left); short.push({ ingredient: g.name, need: left, unit: g.unit }); }
    }
    const st = storeFor(out);
    const exp = p.shelf_days ? addDays(date, p.shelf_days) : null;
    addLot(db, { storeId: st, ingredientId: out.id, qty: outU, expiresOn: exp, at });
    recordMove(db, { at, date, type: 'receive', ingredientId: out.id, toStore: st, qty: outU, cost, ref, staffId: me.id, note: `Nấu ${p.name} ×${batches}${minutes ? ` · ${minutes} phút` : ''}` });
    // Giá vốn thành phẩm = cost mẻ thật / khối lượng ra (để món bán tính đúng giá vốn)
    if (outU > 0 && cost > 0) db.prepare('UPDATE ingredients SET price = ? WHERE id = ?').run(Math.round((cost / outU) * (out.purchase_factor || 1) * 100) / 100, out.id);
    db.prepare('UPDATE prep_batches SET cost = ? WHERE id = ?').run(Math.round(cost), bid);
    return { id: bid, out_qty: r3(outU), unit: out.unit, expected: per != null ? r3(per * batches) : null, cost: Math.round(cost), expires_on: exp, short, skipped };
  }
  r.post('/api/preps/:id/cook', 'staff', ({ me, params, body }) => {
    if (!canCook(me)) fail(403, 'Chỉ nhân viên bếp hoặc tổ trưởng trở lên mới ghi mẻ nấu');
    const p = db.prepare('SELECT * FROM preps WHERE id = ? AND active = 1').get(params.id);
    if (!p) fail(404, 'Không tìm thấy bán thành phẩm');
    const batches = body.batches == null || body.batches === '' ? 1 : Number(body.batches);
    if (!(batches > 0 && batches <= 50)) fail(400, 'Số mẻ không hợp lệ');
    const outQty = body.out_qty == null || body.out_qty === '' ? null : Number(body.out_qty);
    if (outQty != null && !(outQty > 0)) fail(400, 'Khối lượng thành phẩm không hợp lệ');
    const minutes = body.minutes == null || body.minutes === '' ? null : v.int(body.minutes, { min: 0, max: 1440, name: 'Số phút' });
    const planId = body.plan_id ? Number(body.plan_id) : null;
    const res = tx(db, () => cook(me, p, { batches, outQty, minutes, note: v.text(body.note || '', { name: 'Ghi chú', max: 200 }), planId }));
    ctx.audit(me, 'preps.cook', { id: p.id, name: p.name, batch: res.id, batches, out: res.out_qty });
    ctx.broadcast('stock');
    return res;
  });
  r.get('/api/preps/batches', 'staff', ({ query }) => {
    const date = query.get('date') || ctx.today();
    return db.prepare(`SELECT b.*, p.name, p.book, s.name AS staff_name FROM prep_batches b JOIN preps p ON p.id = b.prep_id LEFT JOIN staff s ON s.id = b.staff_id WHERE b.date = ? ORDER BY b.at DESC`).all(date);
  });
  // Huỷ mẻ ghi nhầm (trong ngày): trả nguyên liệu sống về kho, bỏ thành phẩm đã cộng
  r.post('/api/preps/batches/:id/void', 'manager', ({ me, params }) => {
    const b = db.prepare('SELECT * FROM prep_batches WHERE id = ?').get(params.id);
    if (!b) fail(404, 'Không tìm thấy mẻ');
    if (b.voided_at) fail(409, 'Mẻ này đã huỷ');
    if (b.date !== ctx.today()) fail(409, 'Chỉ huỷ được mẻ ghi trong hôm nay. Mẻ cũ thì kiểm kho lại.');
    tx(db, () => {
      const ref = `prep:${b.id}`;
      for (const m of db.prepare('SELECT * FROM stock_moves WHERE ref = ?').all(ref)) {
        if (m.type === 'consume') addLot(db, { storeId: m.from_store, ingredientId: m.ingredient_id, qty: m.qty, at: ctx.now() });
        if (m.type === 'receive') takeLots(db, { storeId: m.to_store, ingredientId: m.ingredient_id, qty: m.qty, allowShort: true });
      }
      db.prepare('DELETE FROM stock_moves WHERE ref = ?').run(ref);
      db.prepare('UPDATE prep_batches SET voided_at = ?, voided_by = ? WHERE id = ?').run(ctx.now(), me.id, b.id);
    });
    ctx.audit(me, 'preps.cook_void', { batch: b.id, prep: b.prep_id });
    ctx.broadcast('stock');
    return { ok: true };
  });

  // ================= 3c: Kế hoạch nấu 3 ngày + checklist bếp mỗi sáng =================
  // Cần = dự báo dùng thành phẩm (theo món đã bán + dùng làm nền cho mẻ khác) trong min(3 ngày, hạn dùng) − tồn kho lúc lập
  // → số mẻ làm tròn lên. Lập tự động lần đầu mở trong ngày; quản lý / tổ trưởng sửa số mẻ, điểm làm, người làm.
  // Tự gắn mã thành phẩm đã có trong kho: "Cốt Tứ Xuyên" ↔ "Cốt lẩu Tứ Xuyên" (chỉ khi khớp đúng 1 mã)
  const autoOutputs = () => {
    const ings = db.prepare('SELECT id, name FROM ingredients WHERE active = 1').all().map((g) => ({ ...g, f: fold(g.name).replace(/\bcot lau\b/, 'cot') }));
    let n = 0;
    for (const p of db.prepare("SELECT id, name FROM preps WHERE active = 1 AND kind = 'batch' AND output_ingredient_id IS NULL").all()) {
      const f = fold(p.name).replace(/\bcot lau\b/, 'cot');
      const sx = /^S(\d) — SỐT/i.exec(p.name); // xiên: "S1 — SỐT ƯỚP TÂN CƯƠNG…" ↔ "Sốt ướp S1 Tân Cương"
      const hit = sx ? ings.filter((g) => g.f.startsWith(`sot uop s${sx[1]} `)) : ings.filter((g) => g.f === f);
      if (hit.length === 1) { db.prepare('UPDATE preps SET output_ingredient_id = ? WHERE id = ?').run(hit[0].id, p.id); n++; }
    }
    return n;
  };
  if (!ctx.setting('preps_output_auto_v1')) { try { autoOutputs(); } catch (e) { console.error(e.message); } ctx.setSetting('preps_output_auto_v1', '1'); }

  const PLAN_DAYS = 3;
  const usageOf = (ingId, before) => {
    const from = addDays(before, -35);
    const rows = db.prepare(`SELECT date, SUM(q) AS q FROM (
        SELECT date, qty AS q FROM sale_usage WHERE ingredient_id = ? AND date >= ? AND date < ?
        UNION ALL SELECT date, qty AS q FROM stock_moves WHERE ingredient_id = ? AND type = 'consume' AND ref LIKE 'prep:%' AND date >= ? AND date < ?
      ) GROUP BY date`).all(ingId, from, before, ingId, from, before);
    return new Map(rows.map((x) => [x.date, x.q]));
  };
  function buildPlan(date) {
    const preps = db.prepare("SELECT * FROM preps WHERE active = 1 AND kind = 'batch' AND output_ingredient_id IS NOT NULL").all();
    const rows = new Map();
    for (const p of preps) {
      const out = ingOf(p.output_ingredient_id);
      if (!out) continue;
      const per = outPerBatch(p, out);
      const cover = Math.max(1, Math.min(PLAN_DAYS, p.shelf_days || PLAN_DAYS));
      let usage; try { usage = usageOf(out.id, date); } catch { usage = new Map(); }
      let fc = 0, basis = 'none';
      for (let k = 0; k < cover; k++) { const f = forecastDay(usage, addDays(date, k)); fc += f.qty; if (f.basis !== 'none') basis = f.basis; }
      rows.set(p.id, { p, out, per, cover, forecast: r3(fc), stock: totalStock(out.id), basis, extra: 0 });
    }
    // Nền dùng cho mẻ khác trong kế hoạch (vd nước dùng cho cốt) cộng thêm vào cần — tính 2 lượt
    const calc = (x) => (x.per ? Math.max(0, Math.ceil(r3((x.forecast + x.extra - x.stock) / x.per) - 1e-9)) : 0);
    for (let pass = 0; pass < 2; pass++) {
      for (const x of rows.values()) x.extra = 0;
      for (const x of rows.values()) {
        const n = calc(x);
        if (!n) continue;
        for (const l of db.prepare('SELECT * FROM prep_lines WHERE prep_id = ? AND ingredient_id IS NOT NULL').all(x.p.id)) {
          for (const y of rows.values()) if (y.out.id === l.ingredient_id && y !== x) { const f = conv(l.unit, y.out.unit); if (f) y.extra += l.qty * n * f; }
        }
      }
    }
    return [...rows.values()].map((x) => ({ ...x, need: r3(Math.max(0, x.forecast + x.extra - x.stock)), batches: calc(x) }));
  }
  function ensurePlan(date, { regen = false } = {}) {
    const has = db.prepare('SELECT 1 FROM prep_plan WHERE date = ? LIMIT 1').get(date);
    if (has && !regen) return;
    const plan = buildPlan(date);
    tx(db, () => {
      if (regen) db.prepare('DELETE FROM prep_plan WHERE date = ? AND manual = 0').run(date);
      for (const x of plan) {
        if (!x.batches) continue;
        db.prepare(`INSERT INTO prep_plan (date, prep_id, batches, station, forecast, stock, need, basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (date, prep_id) DO NOTHING`).run(date, x.p.id, x.batches, stationOf(x.p), x.forecast, x.stock, x.need, x.basis);
      }
      // Đánh dấu đã lập (kể cả không cần nấu gì) để không lập lại mỗi lần mở
      ctx.setSetting(`prep_plan_made:${date}`, '1');
    });
  }
  const planMade = (date) => !!ctx.setting(`prep_plan_made:${date}`);
  function planView(date) {
    const rows = db.prepare(`SELECT pl.*, s.name AS staff_name FROM prep_plan pl LEFT JOIN staff s ON s.id = pl.staff_id WHERE pl.date = ? ORDER BY pl.station, pl.id`).all(date);
    const done = db.prepare('SELECT prep_id, SUM(batches) AS n, SUM(minutes) AS m, COUNT(minutes) AS cm, SUM(out_qty) AS q FROM prep_batches WHERE date = ? AND voided_at IS NULL GROUP BY prep_id').all(date);
    const doneBy = new Map(done.map((x) => [x.prep_id, x]));
    const items = rows.map((pl) => {
      const p = load(db.prepare('SELECT * FROM preps WHERE id = ?').get(pl.prep_id));
      const dn = doneBy.get(pl.prep_id);
      const out = ingOf(p.output_ingredient_id);
      return { ...pl, name: p.name, book: p.book, steps: p.steps, active_min: p.active_min, wait_min: p.wait_min, shelf_text: p.shelf_text, packs: p.packs,
        out_qty: p.out_qty, out_unit: p.out_unit, out_name: out?.name || '', out_unit_stock: out?.unit || '',
        ticks: db.prepare('SELECT t.step, t.at, s.name AS by FROM prep_plan_ticks t LEFT JOIN staff s ON s.id = t.staff_id WHERE t.plan_id = ? ORDER BY t.step').all(pl.id),
        plan_min: Math.round(p.active_min * pl.batches), done_batches: dn?.n || 0, done_min: dn?.cm ? dn.m : null, done_qty: dn?.q || 0 };
    });
    const stations = {};
    for (const x of items) {
      const s = (stations[x.station || 'Bếp'] ||= { station: x.station || 'Bếp', plan_min: 0, done_min: 0, wait_max: 0, items: 0, done: 0 });
      s.plan_min += x.plan_min; s.done_min += x.done_min || 0; s.wait_max = Math.max(s.wait_max, x.wait_min); s.items++; if (x.done_batches >= x.batches) s.done++;
    }
    const extra = db.prepare(`SELECT b.prep_id, p.name, SUM(b.batches) AS n, SUM(b.minutes) AS m FROM prep_batches b JOIN preps p ON p.id = b.prep_id WHERE b.date = ? AND b.voided_at IS NULL AND b.prep_id NOT IN (SELECT prep_id FROM prep_plan WHERE date = ?) GROUP BY b.prep_id`).all(date, date);
    const noOutput = db.prepare("SELECT COUNT(*) AS n FROM preps WHERE active = 1 AND kind = 'batch' AND output_ingredient_id IS NULL").get().n;
    return { date, days: PLAN_DAYS, items, stations: Object.values(stations), extra, no_output: noOutput,
      total_plan_min: items.reduce((n, x) => n + x.plan_min, 0), total_done_min: items.reduce((n, x) => n + (x.done_min || 0), 0) + extra.reduce((n, x) => n + (x.m || 0), 0) };
  }
  // Tick từng bước của 1 việc nấu (checklist bếp, lưu lại + ai tick)
  r.post('/api/preps/plan/:id/tick', 'staff', ({ me, params, body }) => {
    const pl = db.prepare('SELECT * FROM prep_plan WHERE id = ?').get(params.id);
    if (!pl) fail(404, 'Không tìm thấy việc nấu');
    if (!canCook(me)) fail(403, 'Chỉ nhân viên bếp hoặc tổ trưởng trở lên');
    if (pl.date !== ctx.today()) fail(409, 'Chỉ tick việc của hôm nay');
    const step = v.int(body.step, { min: 0, max: 60, name: 'Bước' });
    if (body.done === false) db.prepare('DELETE FROM prep_plan_ticks WHERE plan_id = ? AND step = ?').run(pl.id, step);
    else db.prepare('INSERT OR REPLACE INTO prep_plan_ticks (plan_id, step, staff_id, at) VALUES (?, ?, ?, ?)').run(pl.id, step, me.id, ctx.now());
    ctx.broadcast('stock');
    return { ok: true };
  });
  r.get('/api/preps/plan', 'staff', ({ query }) => {
    const date = query.get('date') || ctx.today();
    if (date >= ctx.today() && !planMade(date)) ensurePlan(date);
    return planView(date);
  });
  // Xem trước cần bao nhiêu (mọi bán thành phẩm đã gắn mã thành phẩm), kể cả món không cần nấu
  r.get('/api/preps/plan/preview', 'manager', ({ query }) => {
    const date = query.get('date') || ctx.today();
    return buildPlan(date).map((x) => ({ prep_id: x.p.id, name: x.p.name, out_name: x.out.name, unit: x.out.unit, per: x.per, cover: x.cover, forecast: x.forecast, extra: r3(x.extra), stock: x.stock, need: x.need, batches: x.batches, basis: x.basis }));
  });
  r.post('/api/preps/plan/regen', 'team_lead', ({ me, body }) => {
    const date = body.date || ctx.today();
    ensurePlan(date, { regen: true });
    ctx.audit(me, 'preps.plan_regen', { date });
    ctx.broadcast('stock');
    return planView(date);
  });
  // Thêm / sửa 1 dòng kế hoạch (số mẻ, điểm làm, người làm). batches = 0 → bỏ khỏi kế hoạch
  r.put('/api/preps/plan', 'team_lead', ({ me, body }) => {
    const date = body.date || ctx.today();
    const p = db.prepare('SELECT * FROM preps WHERE id = ? AND active = 1').get(Number(body.prep_id));
    if (!p) fail(404, 'Không tìm thấy bán thành phẩm');
    const batches = Number(body.batches);
    if (!(batches >= 0 && batches <= 50)) fail(400, 'Số mẻ không hợp lệ');
    const cur = db.prepare('SELECT * FROM prep_plan WHERE date = ? AND prep_id = ?').get(date, p.id);
    const station = body.station === undefined ? cur?.station || stationOf(p) : v.text(body.station || '', { name: 'Điểm làm', max: 30 });
    const staffId = body.staff_id === undefined ? cur?.staff_id ?? null : body.staff_id ? Number(body.staff_id) : null;
    if (!batches) db.prepare('DELETE FROM prep_plan WHERE date = ? AND prep_id = ?').run(date, p.id);
    else db.prepare(`INSERT INTO prep_plan (date, prep_id, batches, station, staff_id, manual) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (date, prep_id) DO UPDATE SET batches = excluded.batches, station = excluded.station, staff_id = excluded.staff_id, manual = 1`).run(date, p.id, batches, station, staffId);
    if (staffId && staffId !== cur?.staff_id) ctx.notify?.([staffId], { title: 'Việc bếp hôm nay', body: `Nấu ${p.name} × ${batches} mẻ`, link: '/checklist' });
    ctx.audit(me, 'preps.plan_set', { date, prep: p.id, batches, station, staff_id: staffId });
    ctx.broadcast('stock');
    return planView(date);
  });
}
