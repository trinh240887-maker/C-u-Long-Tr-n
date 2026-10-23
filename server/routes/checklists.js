import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDate, addDays } from '../lib/time.js';

const PHASES = ['open', 'during', 'close'];

// Đổi số nhân viên nhập (theo đơn vị của việc) sang đơn vị dùng của nguyên liệu
const UNIT_CONV = { 'kg>g': 1000, 'g>kg': 0.001, 'lít>ml': 1000, 'l>ml': 1000, 'ml>lít': 0.001, 'ml>l': 0.001 };
export function unitFactor(unit, ing) {
  const u = String(unit || '').trim().toLowerCase();
  const base = String(ing.unit || '').trim().toLowerCase();
  if (!u || u === base) return 1;
  if (ing.purchase_unit && u === String(ing.purchase_unit).trim().toLowerCase()) return ing.purchase_factor || 1;
  return UNIT_CONV[`${u}>${base}`] ?? null;
}

// Đếm theo bao bì: đơn vị của việc = đơn vị mua (bịch, gói, thùng…) của nguyên liệu tính theo cái (viên, cái, lon…)
// → nhân viên nhập số bịch nguyên + số lẻ; cân theo khối lượng (g, ml) thì vẫn 1 ô
export function packMode(unit, ing) {
  if (!ing || ['g', 'ml'].includes(String(ing.unit || '').toLowerCase())) return false;
  const u = String(unit || '').trim().toLowerCase();
  return !!ing.purchase_unit && u === String(ing.purchase_unit).trim().toLowerCase() && (ing.purchase_factor || 1) > 1;
}

export default function (r, ctx) {
  const { db } = ctx;
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  // Việc "Nhập số" nối kho: số nhân viên cân = tồn thực tế của nguyên liệu ở kho đó → app tự kiểm kho, tính lệch định lượng
  addCol('checklist_items', 'ingredient_id', 'INTEGER');
  addCol('checklist_items', 'extra_ingredient_ids', "TEXT NOT NULL DEFAULT '[]'"); // cân chung nhiều loại (vd thịt tươi: thăn, bắp hoa, gù, gầu)
  addCol('checklist_items', 'store_id', 'INTEGER');
  addCol('checklist_entries', 'count_id', 'INTEGER');

  function templates({ activeOnly = true } = {}) {
    const tpls = db.prepare(`SELECT c.*, t.name AS team_name, st.name AS shift_name, p.name AS position_name, z.name AS zone_name FROM checklist_templates c LEFT JOIN teams t ON t.id = c.team_id
      LEFT JOIN shift_templates st ON st.id = c.shift_template_id LEFT JOIN positions p ON p.id = c.position_id LEFT JOIN zones z ON z.id = c.zone_id
      ${activeOnly ? 'WHERE c.active = 1' : ''} ORDER BY t.sort, CASE c.phase WHEN 'open' THEN 0 WHEN 'during' THEN 1 ELSE 2 END, c.sort, c.id`).all();
    const items = db.prepare(`SELECT i.*, g.name AS ingredient_name, g.unit AS ingredient_unit, g.purchase_unit AS ingredient_pack, g.purchase_factor AS ingredient_factor, st.name AS store_name FROM checklist_items i
      LEFT JOIN ingredients g ON g.id = i.ingredient_id LEFT JOIN stores st ON st.id = i.store_id ORDER BY i.sort, i.id`).all();
    const samples = db.prepare('SELECT id, template_id, item_id, note FROM checklist_samples ORDER BY id').all();
    return tpls.map((c) => ({
      ...c, active: !!c.active,
      samples: samples.filter((x) => x.template_id === c.id && !x.item_id),
      items: items.filter((i) => i.template_id === c.id).map((i) => ({ ...i, extra_ingredient_ids: JSON.parse(i.extra_ingredient_ids || '[]'),
        group_names: JSON.parse(i.extra_ingredient_ids || '[]').length ? [i.ingredient_id, ...JSON.parse(i.extra_ingredient_ids)].map((id) => db.prepare('SELECT name FROM ingredients WHERE id = ?').get(id)?.name).filter(Boolean) : [], pack_mode: !!i.ingredient_id && packMode(i.unit, { unit: i.ingredient_unit, purchase_unit: i.ingredient_pack, purchase_factor: i.ingredient_factor }), required: !!i.required, photo_required: !!i.photo_required, samples: samples.filter((x) => x.item_id === i.id) })),
    }));
  }

  r.get('/api/checklist-templates', 'staff', ({ query }) => templates({ activeOnly: query.get('all') !== '1' }));

  function saveItems(templateId, items) {
    if (!Array.isArray(items) || !items.length) fail(400, 'Checklist cần ít nhất một việc');
    if (items.length > 60) fail(400, 'Tối đa 60 việc trong một checklist');
    const existing = new Set(db.prepare('SELECT id FROM checklist_items WHERE template_id = ?').all(templateId).map((x) => x.id));
    const keep = new Set();
    items.forEach((it, i) => {
      const text = v.text(it.text, { name: 'Tên việc', required: true, max: 120 });
      const kind = v.oneOf(it.kind ?? 'check', ['check', 'number', 'text'], { name: 'Kiểu việc' });
      const unit = v.text(it.unit, { name: 'Đơn vị', max: 12 });
      const required = it.required === undefined ? 1 : v.bool(it.required);
      const photo = it.photo_required === undefined ? (kind === 'check' ? 1 : 0) : v.bool(it.photo_required);
      let extra = [];
      let ingId = kind === 'number' ? v.optInt(it.ingredient_id || null, { min: 1, name: 'Nguyên liệu' }) : null;
      let storeId = null;
      if (ingId) {
        const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ingId);
        if (!ing) fail(400, 'Nguyên liệu không tồn tại');
        if (unitFactor(unit, ing) == null) fail(400, `"${text}": đơn vị "${unit}" không đổi được sang ${ing.unit} của ${ing.name}. Dùng ${[ing.unit, ing.purchase_unit, ing.unit === 'g' ? 'kg' : ''].filter(Boolean).join(' / ')}`);
        storeId = v.optInt(it.store_id || null, { min: 1, name: 'Kho' }) || ing.home_store_id
          || db.prepare("SELECT id FROM stores WHERE kind = 'main' AND active = 1 ORDER BY id LIMIT 1").get()?.id || null;
        if (!storeId || !db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) fail(400, `"${text}": chọn kho để nối`);
        extra = (Array.isArray(it.extra_ingredient_ids) ? it.extra_ingredient_ids : []).map(Number).filter((x) => x && x !== ingId);
        for (const x of extra) {
          const g2 = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(x);
          if (!g2) fail(400, 'Nguyên liệu cân chung không tồn tại');
          if (g2.unit !== ing.unit) fail(400, `"${text}": ${g2.name} khác đơn vị (${g2.unit}), không cân chung với ${ing.name} (${ing.unit}) được`);
        }
      } else ingId = null;
      if (it.id && existing.has(Number(it.id))) {
        db.prepare('UPDATE checklist_items SET text = ?, kind = ?, unit = ?, required = ?, photo_required = ?, ingredient_id = ?, store_id = ?, extra_ingredient_ids = ?, sort = ? WHERE id = ?').run(text, kind, unit, required, photo, ingId, storeId, JSON.stringify(extra), i, Number(it.id));
        keep.add(Number(it.id));
      } else {
        db.prepare('INSERT INTO checklist_items (template_id, text, kind, unit, required, photo_required, ingredient_id, store_id, extra_ingredient_ids, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(templateId, text, kind, unit, required, photo, ingId, storeId, JSON.stringify(extra), i);
      }
    });
    for (const id of existing) if (!keep.has(id)) db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id);
  }

  function tplFields(body, cur = {}) {
    const title = body.title === undefined ? cur.title : v.text(body.title, { name: 'Tên checklist', required: true, max: 80 });
    const teamId = body.team_id === undefined ? cur.team_id ?? null : v.optInt(body.team_id, { min: 1, name: 'Tổ' });
    if (teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) fail(400, 'Tổ không tồn tại');
    const phase = body.phase === undefined ? cur.phase ?? 'open' : v.oneOf(body.phase, PHASES, { name: 'Thời điểm' });
    const shiftId = body.shift_template_id === undefined ? cur.shift_template_id ?? null : v.optInt(body.shift_template_id, { min: 1, name: 'Ca' });
    if (shiftId && !db.prepare('SELECT 1 FROM shift_templates WHERE id = ?').get(shiftId)) fail(400, 'Loại ca không tồn tại');
    const positionId = !teamId ? null : body.position_id === undefined && body.team_id === undefined ? cur.position_id ?? null
      : ctx.readPosition(body.position_id === undefined ? cur.position_id : body.position_id, teamId);
    const zoneId = body.zone_id === undefined ? cur.zone_id ?? null : v.optInt(body.zone_id, { min: 1, name: 'Khu' });
    if (zoneId && !db.prepare('SELECT 1 FROM zones WHERE id = ?').get(zoneId)) fail(400, 'Khu không tồn tại');
    return { title, teamId, phase, shiftId, positionId, zoneId };
  }

  // Tổ trưởng chỉ tạo/sửa checklist của tổ mình; trưởng ca trở lên sửa mọi tổ và checklist "Cả quán"
  function canEditTpl(me, teamId) {
    if (rank(me.role) >= rank('shift_lead')) return;
    if (me.role === 'team_lead' && teamId && teamId === me.team_id) return;
    fail(403, me.role === 'team_lead' ? 'Tổ trưởng chỉ tạo và sửa checklist của tổ mình' : 'Bạn không có quyền sửa checklist');
  }

  r.post('/api/checklist-templates', 'team_lead', ({ me, body }) => {
    const f = tplFields(body);
    canEditTpl(me, f.teamId);
    const id = tx(db, () => {
      const id = Number(db.prepare('INSERT INTO checklist_templates (team_id, phase, title, shift_template_id, position_id, zone_id) VALUES (?, ?, ?, ?, ?, ?)').run(f.teamId, f.phase, f.title, f.shiftId, f.positionId, f.zoneId).lastInsertRowid);
      saveItems(id, body.items);
      return id;
    });
    ctx.audit(me, 'checklist.create', f.title);
    ctx.broadcast('checklists');
    return { id };
  });

  r.patch('/api/checklist-templates/:id', 'team_lead', ({ me, params, body }) => {
    const cur = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, cur.team_id);
    const f = tplFields(body, cur);
    canEditTpl(me, f.teamId);
    const active = body.active === undefined ? cur.active : v.bool(body.active);
    tx(db, () => {
      db.prepare('UPDATE checklist_templates SET team_id = ?, phase = ?, title = ?, shift_template_id = ?, position_id = ?, zone_id = ?, active = ? WHERE id = ?').run(f.teamId, f.phase, f.title, f.shiftId, f.positionId, f.zoneId, active, cur.id);
      if (body.items !== undefined) saveItems(cur.id, body.items);
    });
    ctx.audit(me, 'checklist.update', { id: cur.id, title: f.title });
    ctx.broadcast('checklists');
    return { ok: true };
  });

  // ---------- Checklist trong ngày ----------
  // Nhân viên chỉ thấy checklist của tổ mình và của loại ca mình làm hôm đó; trưởng ca trở lên thấy hết
  function myScope(me, date) {
    if (rank(me.role) >= rank('shift_lead')) return null;
    const teams = new Set(me.team_id ? [me.team_id] : []);
    const shifts = new Set();
    const positions = new Set(me.position_id ? [me.position_id] : []);
    const zones = new Set();
    const rows = db.prepare(`SELECT a.team_id, a.template_id, a.label, a.position_id, a.zone_id FROM assignments a WHERE a.staff_id = ? AND a.date = ?
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')`).all(me.id, date);
    const byName = new Map(db.prepare('SELECT id, name FROM shift_templates').all().map((t) => [t.name, t.id]));
    for (const a of rows) {
      if (a.team_id) teams.add(a.team_id);
      if (a.position_id) positions.add(a.position_id);
      if (a.zone_id) zones.add(a.zone_id);
      if (a.template_id) shifts.add(a.template_id);
      else if (byName.has(a.label)) shifts.add(byName.get(a.label));
    }
    return { teams, shifts, positions, zones };
  }
  const inScope = (scope, t) => !scope || ((t.team_id === null || scope.teams.has(t.team_id))
    && (t.shift_template_id === null || scope.shifts.has(t.shift_template_id))
    && (!t.position_id || scope.positions.has(t.position_id))
    && (!t.zone_id || scope.zones.has(t.zone_id)));
  ctx.checklistScope = myScope;
  ctx.checklistInScope = inScope;

  // Kiểm tra ngẫu nhiên: mỗi lượt checklist (mở / đóng ca, ≥ 4 việc tick không ảnh) app chọn N việc bắt chụp thêm.
  // Chọn theo mã bí mật của quán + ngày + lượt → cả ngày cố định, nhân viên không biết trước việc nào.
  const spotN = () => Math.max(0, Number(ctx.setting('spot_photos_per_run') ?? 1));
  function spotIds(runId, templateId, phase) {
    const n = spotN();
    if (!n || phase === 'during') return new Set();
    const pool = db.prepare("SELECT id FROM checklist_items WHERE template_id = ? AND kind = 'check' AND photo_required = 0 ORDER BY id").all(templateId).map((x) => x.id);
    if (pool.length < 3) return new Set();
    const key = String(ctx.setting('pin_secret') || 'clt');
    const score = (id) => crypto.createHash('sha256').update(`${key}:${runId}:${id}`).digest().readUInt32BE(0);
    return new Set(pool.sort((a, b) => score(a) - score(b)).slice(0, n));
  }
  ctx.checklistSpot = spotIds;

  function dayView(date, scope) {
    const tpls = templates().filter((t) => inScope(scope, t));
    const ensure = db.prepare('INSERT OR IGNORE INTO checklist_runs (template_id, date) VALUES (?, ?)');
    const getRun = db.prepare('SELECT * FROM checklist_runs WHERE template_id = ? AND date = ?');
    const entries = db.prepare(`SELECT e.*, s.name AS done_by_name, rv.name AS reviewed_by_name FROM checklist_entries e LEFT JOIN staff s ON s.id = e.done_by LEFT JOIN staff rv ON rv.id = e.reviewed_by WHERE e.run_id = ?`);
    const photos = db.prepare('SELECT p.id, p.item_id, p.created_at, p.deleted_at, p.staff_id, s.name AS staff_name FROM checklist_photos p LEFT JOIN staff s ON s.id = p.staff_id WHERE p.run_id = ? ORDER BY p.id');
    return tpls.map((t) => {
      ensure.run(t.id, date);
      const run = getRun.get(t.id, date);
      const byItem = new Map(entries.all(run.id).map((e) => [e.item_id, e]));
      const ph = photos.all(run.id);
      const spot = spotIds(run.id, t.id, t.phase);
      const items = t.items.map((i) => ({ ...i, spot: spot.has(i.id), photo_required: i.photo_required || spot.has(i.id), entry: byItem.get(i.id) || null, photos: ph.filter((p) => p.item_id === i.id) }));
      const required = items.filter((i) => i.required);
      return {
        run_id: run.id, template_id: t.id, title: t.title, phase: t.phase, team_id: t.team_id, team_name: t.team_name || 'Cả quán',
        shift_template_id: t.shift_template_id, shift_name: t.shift_name || '', position_id: t.position_id ?? null, position_name: t.position_name || '', zone_id: t.zone_id ?? null, zone_name: t.zone_name || '',
        completed_at: run.completed_at, items, samples: t.samples,
        done: required.filter((i) => i.entry && i.entry.review_status !== 'redo').length, total: required.length,
        redo: items.filter((i) => i.entry?.review_status === 'redo').length,
      };
    });
  }
  ctx.checklistDay = (date) => dayView(date, null);

  r.get('/api/checklists', 'staff', ({ me, query }) => {
    const date = query.get('date') || ctx.today();
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    return { date, runs: dayView(date, myScope(me, date)) };
  });

  // Lượt checklist xong khi mọi việc bắt buộc đã làm và không có việc nào bị chấm "Làm lại"
  function updateRun(run, by) {
    const left = db.prepare(`SELECT COUNT(*) AS n FROM checklist_items i WHERE i.template_id = ? AND i.required = 1
      AND NOT EXISTS (SELECT 1 FROM checklist_entries e WHERE e.run_id = ? AND e.item_id = i.id AND COALESCE(e.review_status, '') != 'redo')`).get(run.template_id, run.id).n;
    const cur = db.prepare('SELECT completed_at FROM checklist_runs WHERE id = ?').get(run.id);
    if (left === 0 && !cur.completed_at) db.prepare('UPDATE checklist_runs SET completed_at = ?, completed_by = ? WHERE id = ?').run(ctx.now(), by, run.id);
    if (left > 0 && cur.completed_at) db.prepare('UPDATE checklist_runs SET completed_at = NULL, completed_by = NULL WHERE id = ?').run(run.id);
  }

  function loadRunItem(me, runId, itemId) {
    const run = db.prepare('SELECT r.*, t.team_id, t.shift_template_id, t.position_id, t.zone_id, t.title FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id WHERE r.id = ?').get(runId);
    if (!run) fail(404, 'Không tìm thấy checklist');
    const item = db.prepare('SELECT * FROM checklist_items WHERE id = ? AND template_id = ?').get(itemId, run.template_id);
    if (!item) fail(404, 'Không tìm thấy việc');
    if (!inScope(myScope(me, run.date), run)) fail(403, 'Checklist này không thuộc tổ hoặc ca của bạn hôm nay');
    if (run.date < ctx.today() && rank(me.role) < rank('shift_lead')) fail(403, 'Checklist ngày cũ chỉ trưởng ca trở lên mới sửa được');
    return { run, item };
  }

  // ---------- Ảnh báo cáo ----------
  const photoDir = ctx.photoDir || path.join(os.tmpdir(), 'quanly-photos');
  const KEEP_DAYS = 7;

  r.post('/api/checklists/photo', 'staff', ({ me, body }) => {
    const { run, item } = loadRunItem(me, v.int(body.run_id, { min: 1, name: 'Checklist' }), v.int(body.item_id, { min: 1, name: 'Việc' }));
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) fail(400, 'Ảnh không hợp lệ');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500) fail(400, 'Ảnh không hợp lệ');
    if (buf.length > 1_500_000) fail(413, 'Ảnh quá lớn, chụp lại giúp');
    const n = db.prepare('SELECT COUNT(*) AS n FROM checklist_photos WHERE run_id = ? AND item_id = ? AND deleted_at IS NULL').get(run.id, item.id).n;
    if (n >= 4) fail(400, 'Tối đa 4 ảnh cho mỗi việc');
    const rel = path.join(run.date, `${run.id}-${item.id}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.mkdirSync(path.join(photoDir, run.date), { recursive: true });
    fs.writeFileSync(path.join(photoDir, rel), buf);
    const id = Number(db.prepare('INSERT INTO checklist_photos (run_id, item_id, staff_id, file, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(run.id, item.id, me.id, rel, buf.length, ctx.now()).lastInsertRowid);
    ctx.broadcast('checklists');
    return { id };
  });

  r.post('/api/checklists/photo/delete', 'staff', ({ me, body }) => {
    const p = db.prepare('SELECT * FROM checklist_photos WHERE id = ?').get(v.int(body.id, { min: 1, name: 'Ảnh' }));
    if (!p || p.deleted_at) fail(404, 'Không tìm thấy ảnh');
    if (p.staff_id !== me.id && rank(me.role) < rank('shift_lead')) fail(403, 'Chỉ xoá được ảnh của mình');
    const e = db.prepare('SELECT review_status FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(p.run_id, p.item_id);
    if (e && e.review_status !== 'redo') fail(400, 'Việc đã bấm xong; bỏ dấu xong trước rồi mới xoá ảnh');
    try { fs.unlinkSync(path.join(photoDir, p.file)); } catch { /* đã mất */ }
    db.prepare('UPDATE checklist_photos SET deleted_at = ? WHERE id = ?').run(ctx.now(), p.id);
    ctx.broadcast('checklists');
    return { ok: true };
  });

  r.get('/api/photos/:id', 'staff', ({ me, params }) => {
    const p = db.prepare(`SELECT p.*, r.date, t.team_id, t.shift_template_id, t.position_id, t.zone_id FROM checklist_photos p
      JOIN checklist_runs r ON r.id = p.run_id JOIN checklist_templates t ON t.id = r.template_id WHERE p.id = ?`).get(params.id);
    if (!p) fail(404, 'Không tìm thấy ảnh');
    if (p.deleted_at) fail(410, `Ảnh đã tự xoá sau ${KEEP_DAYS} ngày`);
    if (p.staff_id !== me.id && rank(me.role) < rank('team_lead') && !inScope(myScope(me, p.date), p)) fail(403, 'Không xem được ảnh này');
    let buf;
    try { buf = fs.readFileSync(path.join(photoDir, p.file)); } catch { fail(410, 'Ảnh không còn'); }
    const ext = path.extname(p.file);
    return { __binary: buf, type: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
  });

  // ---------- Ảnh mẫu: tổ trưởng / quản lý chụp ảnh chuẩn cho checklist (khu) hoặc từng việc ----------
  const sampleDir = path.join(photoDir, 'mau');
  r.post('/api/checklist-templates/:id/samples', 'team_lead', ({ me, params, body }) => {
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(params.id);
    if (!t) fail(404, 'Không tìm thấy checklist');
    canEditTpl(me, t.team_id);
    const itemId = body.item_id ? v.int(body.item_id, { min: 1, name: 'Việc' }) : null;
    if (itemId && !db.prepare('SELECT 1 FROM checklist_items WHERE id = ? AND template_id = ?').get(itemId, t.id)) fail(400, 'Việc không thuộc checklist này');
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) fail(400, 'Ảnh không hợp lệ');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 500) fail(400, 'Ảnh không hợp lệ');
    if (buf.length > 1_500_000) fail(413, 'Ảnh quá lớn, chụp lại giúp');
    const n = db.prepare(`SELECT COUNT(*) AS n FROM checklist_samples WHERE template_id = ? AND ${itemId ? 'item_id = ?' : 'item_id IS NULL'}`).get(...(itemId ? [t.id, itemId] : [t.id])).n;
    if (n >= (itemId ? 3 : 6)) fail(400, itemId ? 'Tối đa 3 ảnh mẫu cho mỗi việc' : 'Tối đa 6 ảnh mẫu cho mỗi checklist');
    const file = `${t.id}-${itemId || 0}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.mkdirSync(sampleDir, { recursive: true });
    fs.writeFileSync(path.join(sampleDir, file), buf);
    const note = v.text(body.note, { name: 'Ghi chú', max: 120 });
    const id = Number(db.prepare('INSERT INTO checklist_samples (template_id, item_id, file, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(t.id, itemId, file, note, me.id, ctx.now()).lastInsertRowid);
    ctx.audit(me, 'checklist.sample.add', { template: t.id, item: itemId });
    ctx.broadcast('checklists');
    return { id };
  });
  r.post('/api/checklist-samples/:id/delete', 'team_lead', ({ me, params }) => {
    const x = db.prepare('SELECT s.*, t.team_id FROM checklist_samples s JOIN checklist_templates t ON t.id = s.template_id WHERE s.id = ?').get(params.id);
    if (!x) fail(404, 'Không tìm thấy ảnh mẫu');
    canEditTpl(me, x.team_id);
    try { fs.unlinkSync(path.join(sampleDir, x.file)); } catch { /* đã mất */ }
    db.prepare('DELETE FROM checklist_samples WHERE id = ?').run(x.id);
    ctx.audit(me, 'checklist.sample.delete', { id: x.id });
    ctx.broadcast('checklists');
    return { ok: true };
  });
  r.get('/api/checklist-samples/:id', 'staff', ({ params }) => {
    const x = db.prepare('SELECT * FROM checklist_samples WHERE id = ?').get(params.id);
    if (!x) fail(404, 'Không tìm thấy ảnh mẫu');
    let buf;
    try { buf = fs.readFileSync(path.join(sampleDir, x.file)); } catch { fail(410, 'Ảnh mẫu không còn, chụp lại giúp'); }
    const ext = path.extname(x.file);
    return { __binary: buf, type: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' };
  });

  ctx.cleanupPhotos = () => {
    const before = ctx.now() - KEEP_DAYS * 86_400_000;
    const old = db.prepare('SELECT id, file FROM checklist_photos WHERE deleted_at IS NULL AND created_at < ?').all(before);
    for (const p of old) {
      try { fs.unlinkSync(path.join(photoDir, p.file)); } catch { /* đã mất */ }
      db.prepare('UPDATE checklist_photos SET deleted_at = ? WHERE id = ?').run(ctx.now(), p.id);
    }
    // Dọn thư mục ngày trống
    try {
      for (const d of fs.readdirSync(photoDir)) {
        const full = path.join(photoDir, d);
        if (fs.statSync(full).isDirectory() && !fs.readdirSync(full).length) fs.rmdirSync(full);
      }
    } catch { /* chưa có thư mục */ }
    return old.length;
  };

  // ---------- Duyệt ảnh: Đạt / Làm lại ----------
  const canReview = (me, teamId) => rank(me.role) >= rank('shift_lead') || (me.role === 'team_lead' && teamId && teamId === me.team_id);

  r.get('/api/checklists/review', 'team_lead', ({ me, query }) => {
    const date = query.get('date') || ctx.today();
    if (!isDate(date)) fail(400, 'Ngày không hợp lệ');
    const rows = db.prepare(`SELECT e.run_id, e.item_id, e.value, e.done_at, e.review_status, e.review_note, e.reviewed_at,
        d.name AS done_by_name, rv.name AS reviewed_by_name, i.text AS item_text, t.title, t.team_id, tm.name AS team_name,
        t.zone_id, z.name AS zone_name, t.position_id, p.name AS position_name, r.date
      FROM checklist_entries e JOIN checklist_runs r ON r.id = e.run_id JOIN checklist_templates t ON t.id = r.template_id
      JOIN checklist_items i ON i.id = e.item_id LEFT JOIN staff d ON d.id = e.done_by LEFT JOIN staff rv ON rv.id = e.reviewed_by
      LEFT JOIN teams tm ON tm.id = t.team_id LEFT JOIN zones z ON z.id = t.zone_id LEFT JOIN positions p ON p.id = t.position_id
      WHERE r.date = ? AND (i.photo_required = 1 OR EXISTS (SELECT 1 FROM checklist_photos ph WHERE ph.run_id = e.run_id AND ph.item_id = e.item_id))
      ORDER BY e.done_at DESC`).all(date).filter((x) => canReview(me, x.team_id));
    const photos = db.prepare('SELECT id, deleted_at FROM checklist_photos WHERE run_id = ? AND item_id = ? ORDER BY id');
    const items = rows.map((x) => ({ ...x, photos: photos.all(x.run_id, x.item_id) }));
    // Bảng điểm 7 ngày gần nhất (tính theo người làm)
    const from = addDays(date, -6);
    const score = db.prepare(`SELECT s.id, s.name, SUM(CASE WHEN e.review_status = 'ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN e.review_status = 'redo' THEN 1 ELSE 0 END) AS redo,
        SUM(CASE WHEN e.review_status IS NULL THEN 1 ELSE 0 END) AS pending, COUNT(*) AS total
      FROM checklist_entries e JOIN checklist_runs r ON r.id = e.run_id JOIN checklist_items i ON i.id = e.item_id JOIN staff s ON s.id = e.done_by
      WHERE r.date BETWEEN ? AND ? AND i.photo_required = 1 GROUP BY s.id ORDER BY redo DESC, s.name`).all(from, date);
    return { date, items, score: { from, to: date, people: score } };
  });

  r.post('/api/checklists/review', 'team_lead', ({ me, body }) => {
    const runId = v.int(body.run_id, { min: 1, name: 'Checklist' });
    const itemId = v.int(body.item_id, { min: 1, name: 'Việc' });
    const status = v.oneOf(body.status, ['ok', 'redo'], { name: 'Kết quả' });
    const note = v.text(body.note, { name: 'Ghi chú', max: 300 });
    if (status === 'redo' && !note) fail(400, 'Ghi rõ chỗ chưa đạt để bạn làm lại');
    const e = db.prepare(`SELECT e.*, r.date, r.template_id, t.team_id, t.title, i.text AS item_text FROM checklist_entries e
      JOIN checklist_runs r ON r.id = e.run_id JOIN checklist_templates t ON t.id = r.template_id JOIN checklist_items i ON i.id = e.item_id
      WHERE e.run_id = ? AND e.item_id = ?`).get(runId, itemId);
    if (!e) fail(404, 'Việc này chưa được báo xong');
    if (!canReview(me, e.team_id)) fail(403, 'Bạn không duyệt được checklist của tổ này');
    tx(db, () => {
      db.prepare('UPDATE checklist_entries SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE run_id = ? AND item_id = ?')
        .run(status, note, me.id, ctx.now(), runId, itemId);
      updateRun({ id: runId, template_id: e.template_id }, e.done_by);
    });
    if (status === 'redo') {
      const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id);
      const doer = ctx.staff(e.done_by);
      ctx.notify([e.done_by].filter((x) => x && x !== me.id), { title: `Làm lại: ${e.item_text}`, body: `${e.title}\n${note}\nChụp ảnh mới rồi bấm xong lại.`, link: '/checklist', urgent: true });
      ctx.notify(owners.filter((x) => x !== me.id), { title: `Chưa đạt: ${e.item_text} (${doer?.name || ''})`, body: `${e.title} · ${me.name} chấm: ${note}`, link: `/duyet-anh?date=${e.date}` });
    }
    ctx.audit(me, status === 'redo' ? 'checklist.redo' : 'checklist.ok', { run_id: runId, item_id: itemId, note });
    ctx.broadcast('checklists');
    return { ok: true };
  });

  r.post('/api/checklists/entry', 'staff', ({ me, body }) => {
    const runId = v.int(body.run_id, { min: 1, name: 'Checklist' });
    const itemId = v.int(body.item_id, { min: 1, name: 'Việc' });
    const { run, item } = loadRunItem(me, runId, itemId);
    const done = body.done === undefined ? true : v.bool(body.done);
    const prevEntry = db.prepare('SELECT count_id, value FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(runId, itemId);
    const prevCount = prevEntry?.count_id;
    let stockActual = null;
    tx(db, () => {
      if (!done) {
        db.prepare('DELETE FROM checklist_entries WHERE run_id = ? AND item_id = ?').run(runId, itemId);
      } else {
        let value = v.text(body.value, { name: 'Giá trị', max: 300 });
        const ing = item.ingredient_id ? db.prepare('SELECT * FROM ingredients WHERE id = ?').get(item.ingredient_id) : null;
        const numOf = (x, label) => { const t = String(x ?? '').trim().replace(',', '.') || '0'; if (!/^\d+(\.\d+)?$/.test(t)) fail(400, `Nhập số ${label} cho "${item.text}"`); return Number(t); };
        if (item.kind === 'number' && packMode(item.unit, ing)) {
          // Nhập số bịch nguyên + số lẻ → tổng theo đơn vị dùng
          const packs = numOf(body.value, item.unit);
          const loose = numOf(body.loose, `${ing.unit} lẻ`);
          if (!String(body.value ?? '').trim() && !String(body.loose ?? '').trim()) fail(400, `Nhập số ${item.unit} và ${ing.unit} lẻ cho "${item.text}" (không còn thì nhập 0)`);
          stockActual = packs * (ing.purchase_factor || 1) + loose;
          value = `${packs} ${item.unit} + ${loose} ${ing.unit}`;
        } else if (item.kind === 'number') {
          value = value.replace(',', '.');
          if (!/^-?\d+(\.\d+)?$/.test(value)) fail(400, `Nhập số cho "${item.text}"`);
          if (ing) stockActual = Math.round(Number(value) * (unitFactor(item.unit, ing) || 1) * 1000) / 1000;
        }
        if (item.kind === 'text' && item.required && !value) fail(400, `Nhập nội dung cho "${item.text}"`);
        // Bị chấm "Làm lại" thì phải có ảnh MỚI chụp sau lúc chấm
        const prev = db.prepare('SELECT review_status, reviewed_at FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(runId, itemId);
        const since = prev?.review_status === 'redo' ? prev.reviewed_at : 0;
        const tplPhase = db.prepare('SELECT phase FROM checklist_templates WHERE id = ?').get(run.template_id)?.phase;
        if ((item.photo_required || spotIds(run.id, run.template_id, tplPhase).has(item.id)) && !db.prepare('SELECT 1 FROM checklist_photos WHERE run_id = ? AND item_id = ? AND deleted_at IS NULL AND created_at > ?').get(runId, itemId, since)) {
          fail(400, since ? `Chụp ảnh mới cho "${item.text}" sau khi sửa rồi bấm xong lại` : `Chụp ảnh cho "${item.text}" trước khi bấm xong`);
        }
        // Làm lại sau khi bị chấm "Làm lại": về trạng thái chờ duyệt
        db.prepare(`INSERT INTO checklist_entries (run_id, item_id, value, done_by, done_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (run_id, item_id) DO UPDATE SET value = excluded.value, done_by = excluded.done_by, done_at = excluded.done_at,
            review_status = NULL, review_note = '', reviewed_by = NULL, reviewed_at = NULL`)
          .run(runId, itemId, value, me.id, ctx.now());
      }
      updateRun(run, me.id);
    });
    // Việc nối kho: sửa số / bỏ tick → huỷ lần kiểm cũ; nhập số → kiểm kho mới, báo nếu lệch quá mức cho phép
    let count = null;
    if (item.ingredient_id && ctx.stockCount) {
      if (prevCount) {
        ctx.undoCount(prevCount);
        db.prepare('UPDATE checklist_entries SET count_id = NULL WHERE run_id = ? AND item_id = ?').run(runId, itemId);
        const now = db.prepare('SELECT value FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(runId, itemId)?.value ?? '(bỏ)';
        ctx.audit(me, 'checklist.recount', { item: item.id, from: prevEntry.value, to: now });
        // Nhân viên sửa số cân → báo quản lý (chống sửa cho khớp sổ)
        if (rank(me.role) < rank('shift_lead') && now !== prevEntry.value) {
          ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id), {
            title: `${me.name} sửa số cân "${item.text}"`, body: `Từ ${prevEntry.value} → ${now} ${item.unit}. Kiểm tra lại nếu thấy lạ.`, link: '/checklist',
          });
        }
      }
      if (done && stockActual != null) count = countFromEntry(me, run, item, stockActual);
      // Nhân viên không xem số trên sổ (tránh cân cho khớp); trưởng ca trở lên xem đủ
      if (count && rank(me.role) < rank('shift_lead')) count = { name: count.name, text: 'Đã ghi tồn, app đã tự kiểm kho', over: false };
    }
    // Đầu ca đồng phục: "Số bạn đủ …" ít hơn "Số bạn … đi làm" → báo trưởng ca / quản lý
    if (done && item.kind === 'number' && /^Số bạn đủ/i.test(item.text)) {
      const total = db.prepare("SELECT e.value FROM checklist_entries e JOIN checklist_items i ON i.id = e.item_id WHERE e.run_id = ? AND i.text LIKE 'Số bạn % đi làm%'").get(run.id)?.value;
      const okN = Number(body.value);
      if (total != null && okN < Number(total)) {
        const tpl = db.prepare('SELECT title FROM checklist_templates WHERE id = ?').get(run.template_id);
        ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((x) => x.id).filter((x) => x !== me.id),
          { title: `${tpl?.title}: ${Number(total) - okN}/${total} bạn thiếu đồ`, body: `${me.name} ghi: ${okN}/${total} bạn đủ. Xem dòng "Bạn nào thiếu" trong checklist.`, link: '/checklist' });
      }
    }
    // Nhiệt độ tủ ngoài mức an toàn (tủ mát > 5°C, tủ đông > −15°C) → báo quản lý + tổ trưởng ngay
    if (done && item.kind === 'number' && /°c/i.test(item.unit)) {
      const val = Number(String(body.value).replace(',', '.'));
      const freezer = /đông/i.test(item.text);
      const limit = freezer ? Number(ctx.setting('freezer_max_c') || -15) : Number(ctx.setting('fridge_max_c') || 5);
      if (Number.isFinite(val) && val > limit) {
        const tpl = db.prepare('SELECT title, team_id FROM checklist_templates WHERE id = ?').get(run.template_id);
        const to = db.prepare("SELECT id FROM staff WHERE active = 1 AND (role IN ('owner','manager') OR (role = 'team_lead' AND team_id = ?))").all(tpl?.team_id ?? -1).map((x) => x.id).filter((x) => x !== me.id);
        ctx.notify(to, { title: `Tủ ${freezer ? 'đông' : 'mát'} ${val}°C (chuẩn ≤ ${limit}°C): ${tpl?.title || ''}`, body: `${me.name} ghi "${item.text}" = ${val}°C. Kiểm tra cửa tủ, đá bám, gioăng; đồ tươi chuyển tủ khác nếu tủ hỏng.`, link: '/checklist', urgent: true });
      }
    }
    ctx.broadcast('checklists');
    return { ok: true, count };
  });

  function countFromEntry(me, run, item, actual) {
    const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(item.ingredient_id);
    const e = db.prepare('SELECT * FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(run.id, item.id);
    if (!ing || !e) return null;
    const tpl = db.prepare('SELECT title FROM checklist_templates WHERE id = ?').get(run.template_id);
    // Cân chung nhiều loại: chia số cân theo tỉ lệ tồn trên sổ từng loại; lệch tính cho cả nhóm
    const ids = [ing.id, ...JSON.parse(item.extra_ingredient_ids || '[]').filter((x) => x !== ing.id)];
    const sid = ctx.effectiveStore ? ctx.effectiveStore(item.store_id) : item.store_id;
    const book = ids.map((id) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE store_id = ? AND ingredient_id = ?').get(sid, id).q);
    const sumBook = book.reduce((n, x) => n + x, 0);
    const parts = ids.map((id, k) => ({ ingredient_id: id, actual: ids.length === 1 ? actual : sumBook > 0 ? Math.round((actual * book[k] / sumBook) * 1000) / 1000 : k === 0 ? actual : 0 }));
    const res = ctx.stockCount(me, item.store_id, parts, `Checklist: ${tpl?.title || ''} · ${item.text}${ids.length > 1 ? ' (cân chung)' : ''}`);
    db.prepare('UPDATE checklist_entries SET count_id = ? WHERE run_id = ? AND item_id = ?').run(res.count_id, run.id, item.id);
    const l = res.lines.reduce((a, x) => ({ before: a.before + x.before, actual: a.actual + x.actual, diff: Math.round((a.diff + x.diff) * 1000) / 1000 }), { before: 0, actual: 0, diff: 0 });
    if (ids.length > 1) ing.name = `${item.text.replace(/\s*còn.*$/i, '') || 'Nhóm'} (${res.lines.map((x) => x.name).join(', ')})`;
    const pct = l.before > 0 ? Math.round((l.diff / l.before) * 1000) / 10 : null;
    const tol = Number(ctx.setting('count_tolerance_pct') || 3);
    const pk = packMode(item.unit, ing) ? ing.purchase_factor : 0;
    const show = (q) => (ing.unit === 'g' && Math.abs(q) >= 1000 ? `${(q / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} kg`
      : pk && Math.abs(q) >= pk ? `${Math.round(q * 100) / 100} ${ing.unit} (${Math.floor(Math.abs(q) / pk)} ${item.unit} + ${Math.round((Math.abs(q) % pk) * 100) / 100} lẻ)` : `${Math.round(q * 100) / 100} ${ing.unit}`);
    const over = l.diff !== 0 && (pct === null || Math.abs(pct) > tol);
    if (over) {
      const recipeQty = ids.length > 1 ? 100 : db.prepare('SELECT MIN(qty) AS q FROM menu_recipes WHERE ingredient_id = ? AND qty > 0').get(ing.id)?.q;
      const portions = recipeQty && l.diff < 0 ? ` ≈ ${Math.round(-l.diff / recipeQty)} phần` : '';
      ctx.notify(db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager')").all().map((x) => x.id).filter((x) => x !== me.id), {
        title: `Lệch ${ing.name} ${l.diff < 0 ? 'THIẾU' : 'DƯ'} ${show(Math.abs(l.diff))}${pct !== null ? ` (${Math.abs(pct)}%)` : ''}${portions}`,
        body: `${me.name} cân ${show(l.actual)}, sổ phải còn ${show(l.before)} (đầu ca + nhập − đã bán × định lượng). ${l.diff < 0 ? 'Thiếu: thái dư tay, hư, hoặc lấy không ghi.' : 'Dư: thái thiếu tay (khách thiệt) hoặc nhập hàng chưa ghi.'} Mức cho phép ${tol}%.`,
        link: '/kho', urgent: Math.abs(pct ?? 100) > tol * 2,
      });
    }
    return { name: ing.name, unit: ing.unit, expected: l.before, actual: l.actual, diff: l.diff, pct, over, text: `Sổ ${show(l.before)} · cân ${show(l.actual)} · ${l.diff === 0 ? 'khớp' : `${l.diff < 0 ? 'thiếu' : 'dư'} ${show(Math.abs(l.diff))}${pct !== null ? ` (${Math.abs(pct)}%)` : ''}`}` };
  }
}
