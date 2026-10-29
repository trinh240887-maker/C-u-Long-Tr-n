import { fail, v } from '../http.js';
import { tx } from '../db.js';
import { addDays, fmtHM } from '../lib/time.js';
import { parseTableList, formatTableList } from '../lib/tables.js';

export default function (r, ctx) {
  const { db } = ctx;

  function zones({ all = false } = {}) {
    const zs = db.prepare(`SELECT * FROM zones ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();
    const tables = db.prepare('SELECT * FROM dining_tables ORDER BY number').all();
    return zs.map((z) => {
      const t = tables.filter((x) => x.zone_id === z.id);
      return { ...z, active: !!z.active, tables: t, tables_text: formatTableList(t.map((x) => x.number)), table_count: t.length };
    });
  }
  ctx.zones = zones;

  r.get('/api/zones', 'staff', ({ query }) => zones({ all: query.get('all') === '1' }));

  function setTables(zoneId, text) {
    let nums;
    try { nums = parseTableList(text); } catch (e) { fail(400, e.message); }
    const clash = nums.map((n) => db.prepare('SELECT t.number, z.name FROM dining_tables t JOIN zones z ON z.id = t.zone_id WHERE t.number = ? AND t.zone_id != ?').get(n, zoneId)).filter(Boolean);
    if (clash.length) fail(409, `Bàn ${formatTableList(clash.map((c) => c.number))} đang thuộc ${clash[0].name}. Bỏ ở khu đó trước`);
    db.prepare('DELETE FROM dining_tables WHERE zone_id = ?').run(zoneId);
    const add = db.prepare('INSERT INTO dining_tables (number, zone_id) VALUES (?, ?)');
    for (const n of nums) add.run(n, zoneId);
  }

  r.post('/api/zones', 'manager', ({ me, body }) => {
    const name = v.text(body.name, { name: 'Tên khu', required: true, max: 40 });
    const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#9a3412';
    const id = tx(db, () => {
      const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM zones').get().s;
      const id = Number(db.prepare('INSERT INTO zones (name, color, sort) VALUES (?, ?, ?)').run(name, color, sort).lastInsertRowid);
      if (body.tables) setTables(id, body.tables);
      return id;
    });
    ctx.audit(me, 'zone.create', name);
    ctx.broadcast('zones');
    return { id };
  });

  r.patch('/api/zones/:id', 'manager', ({ me, params, body }) => {
    const z = db.prepare('SELECT * FROM zones WHERE id = ?').get(params.id);
    if (!z) fail(404, 'Không tìm thấy khu');
    tx(db, () => {
      db.prepare('UPDATE zones SET name = ?, color = ?, active = ? WHERE id = ?').run(
        body.name === undefined ? z.name : v.text(body.name, { name: 'Tên khu', required: true, max: 40 }),
        /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : z.color,
        body.active === undefined ? z.active : v.bool(body.active), z.id,
      );
      if (body.tables !== undefined) setTables(z.id, body.tables);
    });
    ctx.audit(me, 'zone.update', { id: z.id, tables: body.tables });
    ctx.broadcast('zones');
    return { ok: true };
  });

  // Kiểm tra khu + bàn phụ trách khi xếp ca
  ctx.readZone = (body) => {
    const zoneId = v.optInt(body.zone_id, { min: 1, name: 'Khu' });
    if (!zoneId) return { zoneId: null, tablesText: '' };
    if (!db.prepare('SELECT 1 FROM zones WHERE id = ? AND active = 1').get(zoneId)) fail(400, 'Khu không tồn tại');
    let nums;
    try { nums = parseTableList(body.tables_text); } catch (e) { fail(400, e.message); }
    if (nums.length) {
      const inZone = new Set(db.prepare('SELECT number FROM dining_tables WHERE zone_id = ?').all(zoneId).map((x) => x.number));
      const out = nums.filter((n) => !inZone.has(n));
      if (out.length) fail(400, `Bàn ${formatTableList(out)} không thuộc khu này`);
    }
    return { zoneId, tablesText: formatTableList(nums) };
  };

  // Sơ đồ bàn: ai đang phụ trách khu/bàn nào ở thời điểm `at` (mặc định bây giờ) và lịch cả ngày
  r.get('/api/floor', 'staff', ({ me, query }) => {
    const clock = ctx.clock();
    const at = Number(query.get('at')) || ctx.now();
    const date = clock.businessDate(at);
    const rows = db.prepare(`SELECT a.*, s.name AS staff_name FROM assignments a JOIN staff s ON s.id = a.staff_id
      WHERE a.date BETWEEN ? AND ? AND a.zone_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')
      ORDER BY a.start_min`).all(addDays(date, -1), date);
    const groups = new Map();
    for (const a of rows) groups.set(a.group_id, [...(groups.get(a.group_id) || []), a]);
    // Đang làm thật (đã chấm công vào, chưa chấm ra) → chấm xanh; chưa vào / đã về → xám (chủ quán 29/10: điều phối người)
    const working = new Map(db.prepare('SELECT staff_id, MIN(clock_in) AS t FROM attendance WHERE clock_out IS NULL GROUP BY staff_id').all().map((x) => [x.staff_id, x.t]));
    const shifts = [...groups.values()].map((segs) => {
      const f = segs[0];
      const ranges = segs.map((s) => ({ start: clock.toEpoch(s.date, s.start_min), end: clock.toEpoch(s.date, s.end_min) }));
      return {
        staff_id: f.staff_id, staff_name: f.staff_name, zone_id: f.zone_id, tables_text: f.tables_text, date: f.date, label: f.label,
        text: segs.map((s) => `${fmtHM(s.start_min)}–${fmtHM(s.end_min)}`).join(' + '),
        tables: parseTableList(f.tables_text), on_now: ranges.some((x) => x.start <= at && at < x.end),
        start: ranges[0].start, end: ranges.at(-1).end,
        working: working.has(f.staff_id), clock_in: working.get(f.staff_id) || null,
      };
    }).filter((s) => s.date === date || s.on_now);
    const zs = zones().map((z) => {
      const mine = shifts.filter((s) => s.zone_id === z.id);
      const now = mine.filter((s) => s.on_now);
      return {
        ...z,
        tables: z.tables.map((t) => {
          const who = now.filter((s) => !s.tables.length || s.tables.includes(t.number));
          return { ...t, people: who.map((s) => s.staff_name), mine: who.some((s) => s.staff_id === me.id) };
        }),
        on_now: now.map(({ tables, ...s }) => s),
        today: mine.map(({ tables, ...s }) => s),
      };
    });
    return { at, date, zones: zs };
  });
}
