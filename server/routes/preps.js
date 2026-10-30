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
// Giữ dấu khi so chữ trong bước (tỏi ≠ tới)
const soft = (x) => String(x || '').normalize('NFC').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const fold = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

export default function (r, ctx) {
  const { db } = ctx;
  // Bếp tách riêng phục vụ (chủ quán 30/10): công thức chỉ chủ + người thuộc bộ phận bếp (Bếp steak / Lẩu / Nướng…); quản lý bên phục vụ không xem
  const KITCHEN_RE = /bếp|bep|lẩu|lau|nướng|nuong|steak/i;
  const isKitchen = (me) => { const t = me?.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(me.team_id) : null; return !!t && KITCHEN_RE.test(t.name); };
  const chef = (me) => !!me && (me.role === 'owner' || (rank(me.role) >= rank('manager') && isKitchen(me)));
  const needChef = (me) => { if (!chef(me)) fail(403, 'Chỉ chủ quán hoặc quản lý bếp xem / sửa công thức'); };
  db.exec(`CREATE TABLE IF NOT EXISTS preps (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, book TEXT NOT NULL DEFAULT '', sheet TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'batch', batch_col TEXT NOT NULL DEFAULT '', out_qty REAL, out_unit TEXT NOT NULL DEFAULT 'g',
      shelf_text TEXT NOT NULL DEFAULT '', shelf_days INTEGER, packs TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]', steps_edited INTEGER NOT NULL DEFAULT 0,
      output_ingredient_id INTEGER, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS prep_lines (
      id INTEGER PRIMARY KEY, prep_id INTEGER NOT NULL REFERENCES preps(id) ON DELETE CASCADE, pos INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'g',
      qty REAL NOT NULL DEFAULT 0, unit_price REAL, note TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '', kl REAL, ingredient_id INTEGER);`);

  // 🔒 dòng bí mật (chủ quán 30/10): bếp chỉ thấy "Gói G<mã>", quản lý pha sẵn
  if (!db.prepare('PRAGMA table_info(prep_lines)').all().some((c) => c.name === 'secret')) db.exec('ALTER TABLE prep_lines ADD COLUMN secret INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(ingredients)').all().some((c) => c.name === 'pre_done')) {
    db.exec('ALTER TABLE ingredients ADD COLUMN pre_done INTEGER NOT NULL DEFAULT 0');
    // Mua sẵn đã sơ chế — chủ quán 30/10: tỏi băm, hành băm mua sẵn bên ngoài
    for (const g of db.prepare('SELECT id, name FROM ingredients').all()) if (['toi', 'toi bam', 'hanh bam', 'hanh tim', 'hanh tim bam'].includes(fold(g.name))) db.prepare('UPDATE ingredients SET pre_done = 1 WHERE id = ?').run(g.id);
  }
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
    const keptSecret = new Set(db.prepare('SELECT p.code AS pc, l.code, l.name FROM prep_lines l JOIN preps p ON p.id = l.prep_id WHERE l.secret = 1').all().map((l) => `${l.pc}|${l.code}|${l.name}`));
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
          db.prepare('INSERT INTO prep_lines (prep_id, pos, name, unit, qty, unit_price, note, code, kl, ingredient_id, secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, k, l.name, l.unit, l.qty, l.unit_price, l.note, l.code, l.kl, g?.id ?? null, keptSecret.has(`${p.code}|${l.code}|${l.name}`) ? 1 : 0);
        });
      }
    });
    ctx.setSetting('preps_version', d.version);
    try { ctx.linkPrepChain?.(); } catch (e) { console.error('Nối chuỗi bán thành phẩm lỗi:', e.message); }
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
    const lines = db.prepare('SELECT l.*, g.name AS ing_name, g.unit AS ing_unit, g.pre_done AS ing_pre_done FROM prep_lines l LEFT JOIN ingredients g ON g.id = l.ingredient_id WHERE l.prep_id = ? ORDER BY l.pos').all(p.id);
    const steps = JSON.parse(p.steps || '[]');
    return { ...p, steps, lines, cost: Math.round(lines.reduce((n, l) => n + (l.qty || 0) * (l.unit_price || 0), 0)),
      active_min: steps.reduce((n, s) => n + (Number(s.min) || 0), 0), wait_min: steps.reduce((n, s) => n + (Number(s.wait) || 0), 0),
      unmatched: lines.filter((l) => !l.ingredient_id && (l.unit_price || 0) > 0).length };
  };
  // Sổ công thức đầy đủ: chỉ quản lý trở lên (chủ quán 30/10: sợ lộ công thức). Bếp xem việc được giao qua /api/preps/plan
  r.get('/api/preps', 'manager', ({ me }) => (needChef(me), me.role !== 'owner' && ctx.audit(me, 'preps.view_book', {}), {
    version: ctx.setting('preps_version') || null, seed_version: (() => { try { return seed().version; } catch { return null; } })(),
    preps: db.prepare('SELECT * FROM preps WHERE active = 1 ORDER BY id').all().map(load),
  }));
  // Chỉ tên món (để tổ trưởng thêm việc nấu), không có công thức
  r.get('/api/preps/names', 'team_lead', ({ me }) => {
    if (!canCook(me)) fail(403, 'Chỉ tổ trưởng bếp hoặc quản lý');
    return db.prepare("SELECT id, book, name, kind FROM preps WHERE active = 1 ORDER BY id").all();
  });
  r.post('/api/preps/import', 'manager', ({ me }) => { needChef(me); return importSeed(me); });
  // Sửa phút đứng bếp / phút chờ từng bước (bếp trưởng chỉnh theo thực tế) → nạp lại sổ không ghi đè
  r.patch('/api/preps/:id/steps', 'manager', ({ me, params, body }) => {
    needChef(me);
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
    needChef(me);
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
    needChef(me);
    const l = db.prepare('SELECT * FROM prep_lines WHERE id = ?').get(params.id);
    if (!l) fail(404, 'Không tìm thấy dòng');
    if (body.secret !== undefined) {
      db.prepare('UPDATE prep_lines SET secret = ? WHERE id = ?').run(body.secret ? 1 : 0, l.id);
      ctx.audit(me, 'preps.secret', { line: l.id, name: l.name, secret: !!body.secret });
      ctx.broadcast('stock');
      return { ok: true };
    }
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
  if (!cols('prep_lines').includes('sub_prep_id')) db.exec('ALTER TABLE prep_lines ADD COLUMN sub_prep_id INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS prep_batches (
      id INTEGER PRIMARY KEY, prep_id INTEGER NOT NULL REFERENCES preps(id) ON DELETE CASCADE, date TEXT NOT NULL, at INTEGER NOT NULL, staff_id INTEGER,
      batches REAL NOT NULL DEFAULT 1, out_qty REAL NOT NULL DEFAULT 0, out_unit TEXT NOT NULL DEFAULT 'g', minutes INTEGER, cost INTEGER NOT NULL DEFAULT 0,
      store_id INTEGER, ingredient_id INTEGER, plan_id INTEGER, note TEXT NOT NULL DEFAULT '', voided_at INTEGER, voided_by INTEGER);
    CREATE INDEX IF NOT EXISTS prep_batches_by_date ON prep_batches(date);
    CREATE TABLE IF NOT EXISTS prep_plan (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, prep_id INTEGER NOT NULL REFERENCES preps(id) ON DELETE CASCADE, batches REAL NOT NULL DEFAULT 0,
      station TEXT NOT NULL DEFAULT '', staff_id INTEGER, forecast REAL, stock REAL, need REAL, basis TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0, UNIQUE (date, prep_id));
    CREATE TABLE IF NOT EXISTS prep_plan_ticks (plan_id INTEGER NOT NULL REFERENCES prep_plan(id) ON DELETE CASCADE, step INTEGER NOT NULL, staff_id INTEGER, at INTEGER NOT NULL, PRIMARY KEY (plan_id, step));`);
  if (!cols('prep_plan').includes('extra')) db.exec('ALTER TABLE prep_plan ADD COLUMN extra REAL');
  db.exec('CREATE TABLE IF NOT EXISTS prep_plan_views (plan_id INTEGER NOT NULL REFERENCES prep_plan(id) ON DELETE CASCADE, staff_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (plan_id, staff_id))');

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
  // Chỉ nhân sự bếp (Bếp steak, Lẩu, Nướng…) + quản lý / chủ (chủ quán 30/10: tổ trưởng, trưởng ca bộ phận khác không xem công thức)
  const canCook = (me) => {
    return me.role === 'owner' || isKitchen(me);
  };
  const ingOf = (id) => (id ? db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id) : null);
  const outPerBatch = (p, ing) => { const f = conv(p.out_unit, ing.unit); return p.out_qty && f ? r3(p.out_qty * f) : null; };

  // Gắn mã kho thành phẩm (vd "Cốt lẩu Tứ Xuyên") cho bán thành phẩm, hoặc tạo mới
  r.patch('/api/preps/:id/output', 'manager', ({ me, params, body }) => {
    needChef(me);
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
    needChef(me);
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
  r.get('/api/preps/batches', 'staff', ({ me, query }) => {
    if (!canCook(me)) fail(403, 'Chỉ bếp mới xem mẻ nấu');
    const date = query.get('date') || ctx.today();
    return db.prepare(`SELECT b.*, p.name, p.book, s.name AS staff_name FROM prep_batches b JOIN preps p ON p.id = b.prep_id LEFT JOIN staff s ON s.id = b.staff_id WHERE b.date = ? ORDER BY b.at DESC`).all(date);
  });
  // Huỷ mẻ ghi nhầm (trong ngày): trả nguyên liệu sống về kho, bỏ thành phẩm đã cộng
  r.post('/api/preps/batches/:id/void', 'manager', ({ me, params }) => {
    needChef(me);
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

  // Nối chuỗi (chủ quán 30/10: "sao không thấy các loại lẩu, steak"):
  //  · mọi món nấu theo mẻ có mã thành phẩm (chưa có thì tạo); sốt steak pha mỗi ngày → chung mã "Sốt steak bình quân" (món steak đang trừ mã này)
  //  · "Pha 1 nồi — X" → mã "Ngăn nước lẩu … X" (món lẩu đang trừ) → dự báo số nồi bán kéo ra cốt + nước dùng cần nấu
  //  · dòng nguyên liệu là bán thành phẩm khác (Cốt Tứ Xuyên, Nước dùng bò MS-K, CỐT GIA VỊ…) → gắn mã thành phẩm của món đó
  const clean = (n) => fold(n).replace(/^nen \d+ /, '').replace(/\b(nong|chi xuong)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const nice = (n) => String(n).replace(/\([^)]*\)/g, ' ').replace(/^NỀN\s*\d+\s*[—–-]\s*/i, '').replace(/[㐀-鿿]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  function linkChain() {
    const ings = () => db.prepare('SELECT id, name, unit FROM ingredients WHERE active = 1').all().map((g) => ({ ...g, f: fold(g.name) }));
    let made = 0, linked = 0;
    tx(db, () => {
      const preps = db.prepare('SELECT * FROM preps WHERE active = 1').all();
      for (const p of preps.filter((x) => x.kind === 'batch' && !x.output_ingredient_id)) {
        let id = null;
        if (p.book === 'Sốt steak' && /sốt pha/i.test(p.name)) id = ings().find((g) => g.f.startsWith('sot steak binh quan'))?.id || null;
        if (!id) {
          const name = nice(p.name);
          id = db.prepare('SELECT id FROM ingredients WHERE lower(name) = lower(?)').get(name)?.id;
          if (!id) {
            const c = load(p).cost, unit = ['g', 'ml'].includes(p.out_unit) ? p.out_unit : 'g';
            id = Number(db.prepare("INSERT INTO ingredients (name, unit, purchase_unit, purchase_factor, price, freshness) VALUES (?, ?, ?, 1, ?, 'chilled')").run(name, unit, unit, p.out_qty ? Math.round((c / p.out_qty) * 100) / 100 : 0).lastInsertRowid);
            made++;
          }
        }
        db.prepare('UPDATE preps SET output_ingredient_id = ? WHERE id = ?').run(id, p.id);
        p.output_ingredient_id = id;
      }
      const ngan = ings().filter((g) => g.f.startsWith('ngan nuoc lau'));
      for (const p of preps.filter((x) => x.kind === 'serving' && !x.output_ingredient_id && /^Pha 1 nồi/i.test(x.name))) {
        const key = fold(p.name.split(/[—–-]/).pop());
        const hit = ngan.filter((g) => key && g.f.includes(key));
        if (hit.length === 1) { db.prepare('UPDATE preps SET output_ingredient_id = ? WHERE id = ?').run(hit[0].id, p.id); p.output_ingredient_id = hit[0].id; }
      }
      const cl = preps.map((q) => ({ q, c: clean(q.name) }));
      for (const l of db.prepare('SELECT l.*, p.sheet FROM prep_lines l JOIN preps p ON p.id = l.prep_id').all()) {
        const lc = clean(l.name);
        let t = cl.find(({ q, c }) => q.id !== l.prep_id && c.length >= 5 && (lc === c || lc.startsWith(c + ' ')))?.q;
        const ms = /\bMS-[A-Z]\b/.exec(l.name); // nước dùng gọi theo mã: "Nước dùng heo MS-H" = "Nước hầm xương heo MS-H"
        if (!t && ms) t = preps.find((q) => q.id !== l.prep_id && q.kind === 'batch' && q.name.includes(ms[0]));
        if (!t && /cốt gia vị/i.test(l.name)) t = preps.find((q) => q.sheet === l.sheet && q.id !== l.prep_id && /cốt gia vị/i.test(q.name));
        if (!t || !t.output_ingredient_id) continue;
        if (l.ingredient_id !== t.output_ingredient_id || l.sub_prep_id !== t.id) { db.prepare('UPDATE prep_lines SET ingredient_id = ?, sub_prep_id = ? WHERE id = ?').run(t.output_ingredient_id, t.id, l.id); linked++; }
      }
    });
    return { made, linked };
  }
  ctx.linkPrepChain = linkChain;
  // Mã "pha 1 phần" bán ra → phần trừ kho thật: dòng có mã kho, bỏ Topping (đã có trong định lượng món), đổi đơn vị sổ → đơn vị kho
  const partsCache = { at: 0, map: new Map() };
  ctx.servingParts = (ingId) => {
    if (ctx.setting('sale_expand_preps') === '0') return null;
    if (Date.now() - partsCache.at > 5000) { partsCache.map = new Map(); partsCache.at = Date.now(); }
    if (partsCache.map.has(ingId)) return partsCache.map.get(ingId);
    const p = db.prepare("SELECT * FROM preps WHERE active = 1 AND kind = 'serving' AND output_ingredient_id = ? ORDER BY id LIMIT 1").get(ingId);
    let parts = null;
    if (p) {
      parts = db.prepare('SELECT l.*, g.id AS gid FROM prep_lines l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.prep_id = ? AND l.qty > 0 AND (l.unit_price > 0 OR l.sub_prep_id IS NOT NULL)').all(p.id)
        .filter((l) => !/^\s*topping/i.test(l.name) && l.gid !== ingId)
        .map((l) => { const g = ingOf(l.gid); const f = conv(l.unit, g.unit); return f == null ? null : { ...g, qty: r3(l.qty * f) }; }).filter(Boolean);
      if (!parts.length) parts = null;
    }
    partsCache.map.set(ingId, parts);
    return parts;
  };
  if (!ctx.setting('preps_chain_v1')) { try { linkChain(); } catch (e) { console.error('Nối chuỗi bán thành phẩm lỗi:', e.message); } ctx.setSetting('preps_chain_v1', '1'); }

  const PLAN_DAYS = 3;
  const PLAN_VER = '2'; // tăng khi đổi cách tính kế hoạch → kế hoạch hôm nay tự lập lại 1 lần
  const usageOf = (ingId, before) => {
    const from = addDays(before, -35);
    const rows = db.prepare(`SELECT date, SUM(q) AS q FROM (
        SELECT date, qty AS q FROM sale_usage WHERE ingredient_id = ? AND date >= ? AND date < ? AND via IS NULL
        UNION ALL SELECT date, qty AS q FROM stock_moves WHERE ingredient_id = ? AND type = 'consume' AND ref LIKE 'prep:%' AND date >= ? AND date < ?
      ) GROUP BY date`).all(ingId, from, before, ingId, from, before);
    return new Map(rows.map((x) => [x.date, x.q]));
  };
  function buildPlan(date) {
    // Món nấu theo mẻ + món pha 1 phần (nồi lẩu) có mã thành phẩm; pha 1 phần chỉ để kéo nhu cầu xuống cốt / nước dùng, không hiện trong kế hoạch
    const preps = db.prepare("SELECT * FROM preps WHERE active = 1 AND output_ingredient_id IS NOT NULL").all();
    const rows = new Map();
    const fcOf = new Map();
    for (const p of preps) {
      const out = ingOf(p.output_ingredient_id);
      if (!out) continue;
      const serving = p.kind !== 'batch';
      const per = serving ? 1 : outPerBatch(p, out);
      const cover = Math.max(1, Math.min(PLAN_DAYS, p.shelf_days || PLAN_DAYS));
      const key = `${out.id}:${cover}`;
      if (!fcOf.has(key)) {
        let usage; try { usage = usageOf(out.id, date); } catch { usage = new Map(); }
        let fc = 0, basis = 'none';
        for (let k = 0; k < cover; k++) { const f = forecastDay(usage, addDays(date, k)); fc += f.qty; if (f.basis !== 'none') basis = f.basis; }
        fcOf.set(key, { fc: r3(fc), basis });
      }
      const f = fcOf.get(key);
      rows.set(p.id, { p, out, per, cover, serving, forecast: f.fc, stock: totalStock(out.id), basis: f.basis, extra: 0, share: 1,
        lines: db.prepare('SELECT * FROM prep_lines WHERE prep_id = ? AND ingredient_id IS NOT NULL AND qty > 0').all(p.id) });
    }
    // Nhiều món đổ chung 1 mã (vd 5 sốt steak → "Sốt steak bình quân"): chia đều phần cần
    const byOut = new Map();
    for (const x of rows.values()) if (!x.serving) byOut.set(x.out.id, [...(byOut.get(x.out.id) || []), x]);
    for (const list of byOut.values()) for (const x of list) x.share = list.length;
    const need = (x) => Math.max(0, (x.forecast + x.extra - x.stock) / x.share);
    const calc = (x) => (x.per ? Math.max(0, Math.ceil(r3(need(x) / x.per) - 1e-9)) : 0);
    // Kéo nhu cầu xuống món nền: nồi lẩu → cốt + nước dùng; sốt pha → cốt gia vị; cốt → nước dùng… (4 lượt đủ 3 tầng)
    for (let pass = 0; pass < 4; pass++) {
      for (const x of rows.values()) x.extra = 0;
      for (const x of rows.values()) {
        const n = x.serving ? Math.ceil(need(x) - 1e-9) : calc(x);
        if (!n) continue;
        for (const l of x.lines) {
          for (const y of rows.values()) {
            if (y === x || y.serving || y.out.id !== l.ingredient_id) continue;
            const f = conv(l.unit, y.out.unit);
            if (f) y.extra += l.qty * n * f; // cả nhóm chung mã cùng cộng, need() chia đều sau
          }
        }
      }
    }
    return [...rows.values()].filter((x) => !x.serving).map((x) => ({ ...x, forecast: r3(x.forecast / x.share), stock: r3(x.stock / x.share), extra: r3(x.extra), need: r3(need(x)), batches: calc(x) }));
  }
  function ensurePlan(date, { regen = false } = {}) {
    const has = db.prepare('SELECT 1 FROM prep_plan WHERE date = ? LIMIT 1').get(date);
    if (has && !regen) return;
    const plan = buildPlan(date);
    tx(db, () => {
      if (regen) db.prepare('DELETE FROM prep_plan WHERE date = ? AND manual = 0').run(date);
      for (const x of plan) {
        if (!x.batches) continue;
        db.prepare(`INSERT INTO prep_plan (date, prep_id, batches, station, forecast, stock, need, basis, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (date, prep_id) DO NOTHING`).run(date, x.p.id, x.batches, stationOf(x.p), x.forecast, x.stock, x.need, x.basis, x.share > 1 ? r3(x.extra / x.share) : x.extra);
      }
      // Đánh dấu đã lập (kể cả không cần nấu gì) để không lập lại mỗi lần mở
      ctx.setSetting(`prep_plan_made:${date}`, PLAN_VER);
    });
  }
  const planMade = (date) => !!ctx.setting(`prep_plan_made:${date}`);
  const planOld = (date) => { const v = ctx.setting(`prep_plan_made:${date}`); return !!v && v !== PLAN_VER; };
  // Gắn nguyên liệu (số cân × số mẻ) vào từng bước có nhắc tên (chủ quán 30/10: "xay bao nhiêu hành với nước?")
  const STOP = new Set(['bam', 'nhuyen', 'tho', 'dap', 'xay', 'hat', 'tinh', 'cat', 'tuoi', 'loai', 'phan', 'giu', 'lai', 'chia', 'lan']);
  // Khoá tên: bỏ chữ "băm, xay, hạt…"; tên nhiều chữ cần ≥ 2 chữ liền; "Ciba • Ớt khô" lấy phần sau dấu •
  const keysOf = (name) => {
    const base = String(name).split(/[,(:—]/)[0].split('•').pop();
    const w = soft(base).split(' ').filter((x) => x && !STOP.has(fold(x)));
    const out = [];
    for (let n = Math.min(w.length, 4); n >= (w.length >= 2 ? 2 : 1); n--) { const k = w.slice(0, n).join(' '); if (k.length >= 2) out.push(k); }
    return out;
  };
  const withUses = (steps, lines, batches) => {
    const ls = lines.filter((l) => l.qty > 0).map((l) => ({ l, keys: keysOf(l.name) }));
    const cnt = new Map();
    for (const x of ls) for (const k of x.keys) cnt.set(k, (cnt.get(k) || 0) + 1);
    for (const x of ls) x.keys = x.keys.filter((k, idx) => idx === 0 || cnt.get(k) === 1); // khoá ngắn chỉ dùng khi không trùng dòng khác (hoa tiêu xanh / đỏ)
    return steps.map((st) => {
      const f = ` ${soft(st.text)} `;
      const uses = ls.filter(({ keys }) => keys.some((k) => f.includes(` ${k} `))).map(({ l }) => ({ name: l.name, qty: r3(l.qty * batches), unit: l.unit }));
      return { ...st, uses };
    });
  };
  // Che dòng bí mật trong chữ của bước: "luộc 275 g ớt khô" → "luộc Gói G12"
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const maskText = (text, secretLines, code) => {
    let t = text;
    for (const l of secretLines) for (const k of keysOf(l.name)) {
      const re = new RegExp(`(?:(?<![\\p{L}\\d])\\d+(?:[.,]\\d+)?\\s*(?:g|gr|ml|kg|lá|quả|trái)?\\s+)?${k.split(' ').map(esc).join('\\s+')}`, 'giu');
      t = t.replace(re, `Gói ${code}`);
    }
    return t.replace(/(Gói G\d+)(\s*(?:,|và|\+)\s*\1)+/g, '$1');
  };
  function planView(date, me) {
    const boss = chef(me);
    const rows = db.prepare(`SELECT pl.*, s.name AS staff_name FROM prep_plan pl LEFT JOIN staff s ON s.id = pl.staff_id WHERE pl.date = ? ORDER BY pl.station, pl.id`).all(date);
    const done = db.prepare('SELECT prep_id, SUM(batches) AS n, SUM(minutes) AS m, COUNT(minutes) AS cm, SUM(out_qty) AS q FROM prep_batches WHERE date = ? AND voided_at IS NULL GROUP BY prep_id').all(date);
    const doneBy = new Map(done.map((x) => [x.prep_id, x]));
    const packs = [];
    const items = rows.map((pl) => {
      const p = load(db.prepare('SELECT * FROM preps WHERE id = ?').get(pl.prep_id));
      const dn = doneBy.get(pl.prep_id);
      const out = ingOf(p.output_ingredient_id);
      const ticks = db.prepare('SELECT t.step, t.at, s.name AS by FROM prep_plan_ticks t LEFT JOIN staff s ON s.id = t.staff_id WHERE t.plan_id = ? ORDER BY t.step').all(pl.id);
      const views = db.prepare('SELECT v.at, s.name FROM prep_plan_views v LEFT JOIN staff s ON s.id = v.staff_id WHERE v.plan_id = ? ORDER BY v.at').all(pl.id);
      const lines = p.lines.filter((l) => l.qty > 0);
      const secret = lines.filter((l) => l.secret);
      const code = `G${p.id}`;
      const scale = (l) => ({ pos: l.pos, name: l.name, qty: r3(l.qty * pl.batches), unit: l.unit, note: l.note, secret: !!l.secret });
      if (secret.length) packs.push({ plan_id: pl.id, code, name: p.name, batches: pl.batches, lines: boss ? secret.map(scale) : [], total: r3(secret.reduce((n, l) => n + (['g', 'ml'].includes(l.unit) ? l.qty : 0), 0) * pl.batches), done: ticks.find((t) => t.step === 300) || null });
      const isDone = (dn?.n || 0) >= pl.batches;
      const seen = !!me && views.length && db.prepare('SELECT 1 FROM prep_plan_views WHERE plan_id = ? AND staff_id = ?').get(pl.id, me.id);
      const locked = !boss && (!seen || isDone);
      let showLines, showSteps;
      if (boss) { showLines = lines.map(scale); showSteps = withUses(p.steps, lines, pl.batches); }
      else if (locked) { showLines = []; showSteps = p.steps.map((s) => ({ text: '', min: s.min, wait: s.wait, uses: [] })); }
      else {
        const open = lines.filter((l) => !l.secret);
        showLines = [...(secret.length ? [{ pos: 290, name: `📦 Gói ${code} — gia vị pha sẵn (quản lý giao)`, qty: packs[packs.length - 1].total, unit: 'g', note: `${pl.batches} gói`, pack: true }] : []), ...open.map(scale)];
        showSteps = withUses(p.steps, lines, pl.batches).map((s) => ({ ...s, text: secret.length ? maskText(s.text, secret, code) : s.text,
          uses: [...(s.uses.some((u) => secret.some((l) => l.name === u.name)) ? [{ name: `Gói ${code}`, qty: pl.batches, unit: 'gói' }] : []), ...s.uses.filter((u) => !secret.some((l) => l.name === u.name))] }));
      }
      return { ...pl, name: p.name, book: p.book, steps: showSteps, lines: showLines, locked, pack_code: secret.length ? code : null, views: boss ? views : [],
        active_min: p.active_min, wait_min: p.wait_min, shelf_text: p.shelf_text, packs: p.packs,
        out_qty: p.out_qty, out_unit: p.out_unit, out_name: out?.name || '', out_unit_stock: out?.unit || '', ticks,
        plan_min: Math.round(p.active_min * pl.batches), done_batches: dn?.n || 0, done_min: dn?.cm ? dn.m : null, done_qty: dn?.q || 0 };
    });
    const stations = {};
    for (const x of items) {
      const s = (stations[x.station || 'Bếp'] ||= { station: x.station || 'Bếp', plan_min: 0, done_min: 0, wait_max: 0, items: 0, done: 0 });
      s.plan_min += x.plan_min; s.done_min += x.done_min || 0; s.wait_max = Math.max(s.wait_max, x.wait_min); s.items++; if (x.done_batches >= x.batches) s.done++;
    }
    const extra = db.prepare(`SELECT b.prep_id, p.name, SUM(b.batches) AS n, SUM(b.minutes) AS m FROM prep_batches b JOIN preps p ON p.id = b.prep_id WHERE b.date = ? AND b.voided_at IS NULL AND b.prep_id NOT IN (SELECT prep_id FROM prep_plan WHERE date = ?) GROUP BY b.prep_id`).all(date, date);
    const noOutput = db.prepare("SELECT COUNT(*) AS n FROM preps WHERE active = 1 AND kind = 'batch' AND output_ingredient_id IS NULL").get().n;
    return { date, days: PLAN_DAYS, boss, items, packs, stations: Object.values(stations), extra, no_output: noOutput,
      total_plan_min: items.reduce((n, x) => n + x.plan_min, 0), total_done_min: items.reduce((n, x) => n + (x.done_min || 0), 0) + extra.reduce((n, x) => n + (x.m || 0), 0) };
  }
  // ▶ Bắt đầu nấu: mở nguyên liệu + bước cho người bấm (ghi nhật ký ai xem lúc nào); ghi mẻ xong tự ẩn lại
  r.post('/api/preps/plan/:id/start', 'staff', ({ me, params }) => {
    const pl = db.prepare('SELECT * FROM prep_plan WHERE id = ?').get(params.id);
    if (!pl) fail(404, 'Không tìm thấy việc nấu');
    if (!canCook(me)) fail(403, 'Chỉ nhân viên bếp');
    if (pl.date !== ctx.today()) fail(409, 'Chỉ mở việc của hôm nay');
    if (pl.staff_id && pl.staff_id !== me.id && rank(me.role) < rank('team_lead')) fail(403, 'Việc này đã giao cho người khác');
    db.prepare('INSERT OR IGNORE INTO prep_plan_views (plan_id, staff_id, at) VALUES (?, ?, ?)').run(pl.id, me.id, ctx.now());
    ctx.audit(me, 'preps.start', { plan: pl.id, prep: pl.prep_id });
    return planView(pl.date, me);
  });
  // Tick từng bước của 1 việc nấu (checklist bếp, lưu lại + ai tick)
  r.post('/api/preps/plan/:id/tick', 'staff', ({ me, params, body }) => {
    const pl = db.prepare('SELECT * FROM prep_plan WHERE id = ?').get(params.id);
    if (!pl) fail(404, 'Không tìm thấy việc nấu');
    if (!canCook(me)) fail(403, 'Chỉ nhân viên bếp hoặc tổ trưởng trở lên');
    if (pl.date !== ctx.today()) fail(409, 'Chỉ tick việc của hôm nay');
    const step = v.int(body.step, { min: 0, max: 400, name: 'Bước' }); // 0–99 bước làm, 100+ = đã lấy nguyên liệu dòng (pos), 300 = gói bí mật đã pha (quản lý)
    if (step === 300 && !chef(me)) fail(403, 'Chỉ chủ / quản lý bếp đánh dấu đã pha gói');
    if (body.done === false) db.prepare('DELETE FROM prep_plan_ticks WHERE plan_id = ? AND step = ?').run(pl.id, step);
    else db.prepare('INSERT OR REPLACE INTO prep_plan_ticks (plan_id, step, staff_id, at) VALUES (?, ?, ?, ?)').run(pl.id, step, me.id, ctx.now());
    ctx.broadcast('stock');
    return { ok: true };
  });
  r.get('/api/preps/plan', 'staff', ({ me, query }) => {
    if (!canCook(me)) fail(403, 'Chỉ bếp mới xem việc nấu');
    const date = query.get('date') || ctx.today();
    if (date >= ctx.today() && !planMade(date)) ensurePlan(date);
    else if (date >= ctx.today() && planOld(date)) ensurePlan(date, { regen: true }); // cách tính mới (nối chuỗi lẩu / steak) → lập lại 1 lần, giữ dòng sửa tay
    return planView(date, me);
  });
  // Xem trước cần bao nhiêu (mọi bán thành phẩm đã gắn mã thành phẩm), kể cả món không cần nấu
  r.get('/api/preps/plan/preview', 'manager', ({ me, query }) => {
    needChef(me);
    const date = query.get('date') || ctx.today();
    return buildPlan(date).map((x) => ({ prep_id: x.p.id, name: x.p.name, out_name: x.out.name, unit: x.out.unit, per: x.per, cover: x.cover, forecast: x.forecast, extra: r3(x.extra), stock: x.stock, need: x.need, batches: x.batches, basis: x.basis }));
  });
  r.post('/api/preps/plan/regen', 'team_lead', ({ me, body }) => {
    if (!canCook(me)) fail(403, 'Chỉ tổ trưởng bếp hoặc quản lý');
    const date = body.date || ctx.today();
    ensurePlan(date, { regen: true });
    ctx.audit(me, 'preps.plan_regen', { date });
    ctx.broadcast('stock');
    return planView(date, me);
  });
  // Thêm / sửa 1 dòng kế hoạch (số mẻ, điểm làm, người làm). batches = 0 → bỏ khỏi kế hoạch
  r.put('/api/preps/plan', 'team_lead', ({ me, body }) => {
    if (!canCook(me)) fail(403, 'Chỉ tổ trưởng bếp hoặc quản lý');
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
    return planView(date, me);
  });

  // ================= Bảng việc bếp theo công đoạn (chủ quán 30/10) =================
  // Sơ chế chung (gộp mọi mẻ hôm nay, sáng cùng ngày) → cân khay theo mẻ (+ Gói bí mật quản lý bếp pha) → đứng bếp nấu → đóng gói / làm lạnh / dán nhãn.
  // Mỗi việc 1 thẻ: số lượng, phút ước tính, người làm. Nguyên liệu "mua sẵn đã sơ chế" (tỏi băm, hành băm…) không thành việc sơ chế.
  db.exec(`CREATE TABLE IF NOT EXISTS prep_tasks (date TEXT NOT NULL, key TEXT NOT NULL, staff_id INTEGER, started_at INTEGER, done_at INTEGER, done_by INTEGER, minutes INTEGER, PRIMARY KEY (date, key));
    CREATE TABLE IF NOT EXISTS prep_rates (action TEXT PRIMARY KEY, rate REAL NOT NULL);`);
  // Thao tác sơ chế: chữ nhận diện, nhãn, phút / kg ước tính ban đầu (học dần theo phút thật)
  const ACTIONS = [
    { k: 'luoc', words: ['luộc'], label: 'Luộc', rate: 20 }, { k: 'rang', words: ['rang'], label: 'Rang', rate: 15 },
    { k: 'xay', words: ['xay'], label: 'Xay', rate: 12 }, { k: 'bam', words: ['băm'], label: 'Băm', rate: 20 },
    { k: 'dap', words: ['đập dập', 'đập nứt', 'đập'], label: 'Đập dập', rate: 8 }, { k: 'cat', words: ['cắt', 'thái', 'bổ', 'hạt lựu', 'xắt'], label: 'Cắt / thái', rate: 15 },
    { k: 'got', words: ['gọt', 'lột', 'bóc'], label: 'Gọt / bóc', rate: 25 },
  ];
  const rateOf = (a) => db.prepare('SELECT rate FROM prep_rates WHERE action = ?').get(a.k)?.rate ?? a.rate;
  const actionOf = (l) => {
    const name = ` ${soft(String(l.name).split('•').pop())} `;
    const note = ` ${soft(l.note || '').split(' ').slice(0, 1).join(' ')} `; // ghi chú chỉ xét chữ đầu ("Xay với nước…")
    if (/^\s*nước lọc\s*$/.test(name)) return null;
    if (/^\s*nước /.test(name)) return ACTIONS.find((a) => a.words.some((w) => note.includes(` ${w} `))) || null; // "nước luộc ớt", "nước hành đã lọc" là thành phẩm, không phải việc
    return ACTIONS.find((a) => a.words.some((w) => name.includes(` ${w} `))) || ACTIONS.find((a) => a.words.some((w) => note.includes(` ${w} `))) || null;
  };
  const PACK_STEP = /rót túi|chia túi|ngâm.{0,20}đá|dán nhãn|làm nguội|rót chai|rót hũ|cất tủ/i;
  // Tên mua sẵn đã sơ chế (kể cả dòng sổ chưa gắn mã kho): mã kho đã bật + mặc định tỏi / hành tím
  const preDone = () => new Set(['toi', 'toi bam', 'hanh tim', 'hanh tim bam', 'hanh bam', ...db.prepare('SELECT name FROM ingredients WHERE pre_done = 1').all().map((g) => fold(g.name))]);
  const canLead = (me) => chef(me) || (canCook(me) && rank(me.role) >= rank('team_lead'));
  const kgOf = (qty, unit) => { const f = conv(unit, 'kg'); return f == null ? null : qty * f; };

  function buildTasks(date) {
    const plan = db.prepare('SELECT * FROM prep_plan WHERE date = ? AND batches > 0 ORDER BY id').all(date);
    const prepGroups = new Map();
    const tasks = [];
    const outOf = new Map(); // ingredient thành phẩm → plan item (để thẻ nấu chờ nền / cốt nấu trước)
    const items = plan.map((pl) => {
      const p = load(db.prepare('SELECT * FROM preps WHERE id = ?').get(pl.prep_id));
      if (p.output_ingredient_id) outOf.set(p.output_ingredient_id, pl.id);
      return { pl, p };
    });
    for (const { pl, p } of items) {
      const lines = p.lines.filter((l) => l.qty > 0);
      for (const l of lines) {
        if (l.secret || l.sub_prep_id) continue;
        const g = l.ingredient_id ? ingOf(l.ingredient_id) : null;
        if (g?.pre_done || (!g && preDone().has(fold(String(l.code || l.name).split(/[,(]/)[0].split('•').pop())))) continue;
        const a = actionOf(l);
        if (!a) continue;
        const base = g?.name || String(l.code || l.name).split(/[,(]/)[0].replace(/^[•\s]+/, '').trim();
        const key = `prep:${a.k}:${g ? g.id : fold(base)}`;
        const x = prepGroups.get(key) || { key, layer: 'prep', action: a, title: `${a.label} ${base}`, unit: l.unit, qty: 0, uses: [], plan_ids: new Set() };
        const q = r3(l.qty * pl.batches);
        x.qty = r3(x.qty + q); x.uses.push({ name: p.name, qty: q, unit: l.unit }); x.plan_ids.add(pl.id);
        prepGroups.set(key, x);
      }
    }
    for (const x of prepGroups.values()) {
      const kg = kgOf(x.qty, x.unit);
      tasks.push({ ...x, plan_ids: [...x.plan_ids], est: Math.max(3, Math.round((kg ?? 0.2) * rateOf(x.action))), kg, order: 1, action: x.action.k });
    }
    for (const { pl, p } of items) {
      const lines = p.lines.filter((l) => l.qty > 0);
      const secret = lines.filter((l) => l.secret);
      const open = lines.filter((l) => !l.secret);
      const code = `G${p.id}`;
      const preIds = tasks.filter((t) => t.layer === 'prep' && t.plan_ids.includes(pl.id)).map((t) => t.key);
      if (secret.length) tasks.push({ key: `secret:${pl.id}`, layer: 'secret', title: `Pha Gói ${code} × ${pl.batches} — ${p.name}`, plan_id: pl.id, code, est: Math.round(3 + 0.5 * secret.length * pl.batches), order: 0,
        lines: secret.map((l) => ({ name: l.name, qty: r3(l.qty * pl.batches), unit: l.unit })) });
      tasks.push({ key: `weigh:${pl.id}`, layer: 'weigh', title: `Cân khay: ${p.name} × ${pl.batches} mẻ`, plan_id: pl.id, est: Math.round(2 + 0.5 * open.length * pl.batches), order: 2, needs: preIds,
        lines: [...(secret.length ? [{ name: `📦 Gói ${code} (quản lý bếp giao)`, qty: pl.batches, unit: 'gói', pack: true }] : []),
          ...open.map((l) => { const g = l.ingredient_id ? ingOf(l.ingredient_id) : null; const a = !g?.pre_done && !l.sub_prep_id ? actionOf(l) : null; return { name: l.name, qty: r3(l.qty * pl.batches), unit: l.unit, from: l.sub_prep_id ? 'bán thành phẩm' : a ? `đã ${a.label.toLowerCase()} ở bước sơ chế` : g?.pre_done ? 'mua sẵn' : '' }; })] });
      const cookSteps = p.steps.map((st, k) => ({ ...st, k })).filter((st) => !PACK_STEP.test(st.text));
      const packSteps = p.steps.map((st, k) => ({ ...st, k })).filter((st) => PACK_STEP.test(st.text));
      const subs = [...new Set(lines.filter((l) => l.sub_prep_id && outOf.has(l.ingredient_id)).map((l) => `cook:${outOf.get(l.ingredient_id)}`))];
      tasks.push({ key: `cook:${pl.id}`, layer: 'cook', title: `Nấu ${p.name} × ${pl.batches} mẻ`, plan_id: pl.id, prep_id: p.id, est: Math.round(cookSteps.reduce((n, st) => n + (Number(st.min) || 0), 0) * pl.batches),
        wait: p.wait_min, early: p.wait_min >= 120, order: p.wait_min >= 120 ? 0.5 : 3, needs: [`weigh:${pl.id}`, ...(secret.length ? [`secret:${pl.id}`] : []), ...subs], steps: cookSteps, station: pl.station });
      if (packSteps.length) tasks.push({ key: `pack:${pl.id}`, layer: 'pack', title: `Đóng gói / làm lạnh: ${p.name}`, plan_id: pl.id, est: Math.max(3, Math.round(packSteps.reduce((n, st) => n + (Number(st.min) || 0), 0) * pl.batches)), order: 4, needs: [`cook:${pl.id}`], steps: packSteps, packs: p.packs });
    }
    return { tasks: tasks.sort((a, b) => a.order - b.order), items };
  }

  function tasksView(date, me) {
    const { tasks, items } = buildTasks(date);
    const st = new Map(db.prepare('SELECT t.*, s.name AS staff_name, d.name AS done_name FROM prep_tasks t LEFT JOIN staff s ON s.id = t.staff_id LEFT JOIN staff d ON d.id = t.done_by WHERE t.date = ?').all(date).map((x) => [x.key, x]));
    const doneBy = new Map(db.prepare('SELECT prep_id, SUM(batches) AS n, SUM(minutes) AS m FROM prep_batches WHERE date = ? AND voided_at IS NULL GROUP BY prep_id').all(date).map((x) => [x.prep_id, x]));
    const boss = chef(me), lead = canLead(me);
    const isDone = (t) => { if (t.layer === 'cook') { const it = items.find((i) => i.pl.id === t.plan_id); return (doneBy.get(it.p.id)?.n || 0) >= it.pl.batches; } return !!st.get(t.key)?.done_at; };
    const out = [];
    for (const t of tasks) {
      if (t.layer === 'secret' && !boss) continue;
      const s0 = st.get(t.key) || {};
      const done = isDone(t);
      const waiting = (t.needs || []).filter((k) => { const d = tasks.find((x) => x.key === k); return d && !isDone(d); }).map((k) => tasks.find((x) => x.key === k).title);
      const mine = s0.staff_id === me.id;
      const seeAll = boss || mine; // chi tiết chỉ người làm việc đó (và chủ / quản lý bếp) — không ai nắm trọn công thức
      const it = t.plan_id ? items.find((i) => i.pl.id === t.plan_id) : null;
      const row = { key: t.key, layer: t.layer, title: t.title, est: t.est, early: !!t.early, wait: t.wait || 0, station: t.station || it?.pl.station || '', plan_id: t.plan_id || null, prep_id: t.prep_id || it?.p.id || null,
        staff_id: s0.staff_id || null, staff_name: s0.staff_name || '', started_at: s0.started_at || null, done, done_at: s0.done_at || null, done_name: s0.done_name || '', minutes: t.layer === 'cook' ? (doneBy.get(it?.p.id)?.m ?? null) : s0.minutes ?? null,
        waiting, mine, qty: t.qty ?? null, unit: t.unit || '', batches: it?.pl.batches || null, out_qty: it?.p.out_qty || null, out_unit: it?.p.out_unit || '', active_min: it?.p.active_min || 0 };
      if (t.layer === 'prep') { row.uses = t.uses; row.kg = t.kg; } // việc sơ chế: ai cũng xem (chỉ là băm / xay bao nhiêu)
      if (seeAll) {
        if (t.lines) row.lines = t.lines;
        if (t.layer === 'cook' || t.layer === 'pack') {
          const secret = it.p.lines.filter((l) => l.secret && l.qty > 0);
          row.steps = t.steps.map((x) => ({ k: x.k, text: !boss && secret.length ? maskText(x.text, secret, `G${it.p.id}`) : x.text, min: x.min, wait: x.wait }));
          if (t.packs) row.packs = t.packs;
          row.ticks = db.prepare('SELECT step, at FROM prep_plan_ticks WHERE plan_id = ?').all(t.plan_id);
        }
      }
      out.push(row);
    }
    const people = new Map();
    for (const t of out) if (t.staff_id) { const x = people.get(t.staff_id) || { staff_id: t.staff_id, name: t.staff_name, est: 0, done: 0, n: 0 }; x.est += t.est; x.n++; if (t.done) x.done += t.minutes ?? t.est; people.set(t.staff_id, x); }
    const LAYER = { secret: '🔒 Gói bí mật (quản lý bếp)', prep: '🔪 Sơ chế chung', weigh: '⚖ Cân khay theo mẻ', cook: '🔥 Đứng bếp nấu', pack: '📦 Đóng gói / làm lạnh / dán nhãn' };
    return { date, boss, lead, layers: LAYER, tasks: out, people: [...people.values()], total_est: out.reduce((n, t) => n + t.est, 0), unassigned: out.filter((t) => !t.staff_id && !t.done).length };
  }
  const taskOf = (date, key) => buildTasks(date).tasks.find((t) => t.key === key) || fail(404, 'Không tìm thấy việc');
  r.get('/api/preps/tasks', 'staff', ({ me, query }) => {
    if (!canCook(me)) fail(403, 'Chỉ bếp mới xem việc bếp');
    const date = query.get('date') || ctx.today();
    if (date >= ctx.today() && !planMade(date)) ensurePlan(date);
    return tasksView(date, me);
  });
  r.post('/api/preps/tasks/assign', 'staff', ({ me, body }) => {
    if (!canLead(me)) fail(403, 'Chỉ tổ trưởng bếp / quản lý bếp giao việc');
    const date = body.date || ctx.today();
    const t = taskOf(date, String(body.key));
    if (t.layer === 'secret' && body.staff_id) { const s = db.prepare('SELECT * FROM staff WHERE id = ?').get(Number(body.staff_id)); if (!s || !chef(s)) fail(400, 'Gói bí mật chỉ giao cho chủ / quản lý bếp'); }
    const sid = body.staff_id ? Number(body.staff_id) : null;
    db.prepare('INSERT INTO prep_tasks (date, key, staff_id) VALUES (?, ?, ?) ON CONFLICT (date, key) DO UPDATE SET staff_id = excluded.staff_id').run(date, t.key, sid);
    if (sid && sid !== me.id) ctx.notify?.([sid], { title: 'Việc bếp giao cho bạn', body: t.title, link: '/checklist' });
    ctx.audit(me, 'preps.task_assign', { date, key: t.key, staff_id: sid });
    ctx.broadcast('stock');
    return tasksView(date, me);
  });
  r.post('/api/preps/tasks/claim', 'staff', ({ me, body }) => {
    if (!canCook(me)) fail(403, 'Chỉ bếp');
    const date = ctx.today();
    const t = taskOf(date, String(body.key));
    if (t.layer === 'secret' && !chef(me)) fail(403, 'Gói bí mật chỉ quản lý bếp pha');
    const cur = db.prepare('SELECT staff_id FROM prep_tasks WHERE date = ? AND key = ?').get(date, t.key);
    if (cur?.staff_id && cur.staff_id !== me.id) fail(409, 'Việc này đã có người nhận');
    db.prepare('INSERT INTO prep_tasks (date, key, staff_id) VALUES (?, ?, ?) ON CONFLICT (date, key) DO UPDATE SET staff_id = excluded.staff_id').run(date, t.key, me.id);
    ctx.audit(me, 'preps.task_claim', { key: t.key });
    ctx.broadcast('stock');
    return tasksView(date, me);
  });
  const mustOwn = (me, date, key) => { const cur = db.prepare('SELECT * FROM prep_tasks WHERE date = ? AND key = ?').get(date, key); if (!chef(me) && !canLead(me) && cur?.staff_id !== me.id) fail(403, 'Bấm "Nhận việc" trước'); if (!chef(me) && cur?.staff_id && cur.staff_id !== me.id) fail(403, 'Việc này giao cho người khác'); return cur; };
  r.post('/api/preps/tasks/start', 'staff', ({ me, body }) => {
    if (!canCook(me)) fail(403, 'Chỉ bếp');
    const date = ctx.today();
    const t = taskOf(date, String(body.key));
    mustOwn(me, date, t.key);
    db.prepare('INSERT INTO prep_tasks (date, key, staff_id, started_at) VALUES (?, ?, ?, ?) ON CONFLICT (date, key) DO UPDATE SET started_at = COALESCE(prep_tasks.started_at, excluded.started_at), staff_id = COALESCE(prep_tasks.staff_id, excluded.staff_id)').run(date, t.key, me.id, ctx.now());
    if (t.plan_id && (t.layer === 'cook' || t.layer === 'weigh' || t.layer === 'pack')) db.prepare('INSERT OR IGNORE INTO prep_plan_views (plan_id, staff_id, at) VALUES (?, ?, ?)').run(t.plan_id, me.id, ctx.now());
    ctx.audit(me, 'preps.task_start', { key: t.key });
    return tasksView(date, me);
  });
  r.post('/api/preps/tasks/done', 'staff', ({ me, body }) => {
    if (!canCook(me)) fail(403, 'Chỉ bếp');
    const date = ctx.today();
    const t = taskOf(date, String(body.key));
    if (t.layer === 'cook') fail(400, 'Việc nấu: bấm Ghi mẻ để xong');
    const cur = mustOwn(me, date, t.key);
    if (body.undo) { db.prepare('UPDATE prep_tasks SET done_at = NULL, done_by = NULL, minutes = NULL WHERE date = ? AND key = ?').run(date, t.key); ctx.broadcast('stock'); return tasksView(date, me); }
    const minutes = body.minutes != null && body.minutes !== '' ? v.int(body.minutes, { min: 0, max: 600, name: 'Số phút' }) : cur?.started_at ? Math.max(1, Math.round((ctx.now() - cur.started_at) / 60000)) : null;
    db.prepare('INSERT INTO prep_tasks (date, key, staff_id, done_at, done_by, minutes) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (date, key) DO UPDATE SET done_at = excluded.done_at, done_by = excluded.done_by, minutes = excluded.minutes, staff_id = COALESCE(prep_tasks.staff_id, excluded.staff_id)').run(date, t.key, me.id, ctx.now(), me.id, minutes);
    // Học phút / kg cho thao tác sơ chế (70% cũ + 30% lần này)
    if (t.layer === 'prep' && minutes && t.kg >= 0.05) { const a = ACTIONS.find((x) => x.k === t.action); const nr = Math.round((0.7 * rateOf(a) + 0.3 * (minutes / t.kg)) * 10) / 10; db.prepare('INSERT OR REPLACE INTO prep_rates (action, rate) VALUES (?, ?)').run(a.k, Math.min(240, Math.max(1, nr))); }
    ctx.audit(me, 'preps.task_done', { key: t.key, minutes });
    ctx.broadcast('stock');
    return tasksView(date, me);
  });
  r.patch('/api/preps/ingredients/:id', 'manager', ({ me, params, body }) => {
    needChef(me);
    const g = ingOf(Number(params.id));
    if (!g) fail(404, 'Không tìm thấy nguyên liệu');
    db.prepare('UPDATE ingredients SET pre_done = ? WHERE id = ?').run(body.pre_done ? 1 : 0, g.id);
    ctx.audit(me, 'preps.pre_done', { id: g.id, name: g.name, pre_done: !!body.pre_done });
    ctx.broadcast('stock');
    return { ok: true };
  });
}
