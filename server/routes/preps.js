// Bán thành phẩm (chủ quán 30/10): cốt lẩu, nước dùng, nước chấm, sốt steak, sốt xiên, bột… nấu theo mẻ từ 4 sổ công thức.
// Mỗi bán thành phẩm: nguyên liệu theo mẻ (khớp mã kho nếu có), thành phẩm, hạn dùng, cỡ túi, các bước có phút đứng bếp / phút chờ.
// Nguồn: server/data/so-cong-thuc.json (trích từ 4 file Excel chủ quán gửi 30/10, bản 11/10/2026). Nạp lại thì giữ phút đã sửa tay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, v } from '../http.js';
import { tx } from '../db.js';

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
}
