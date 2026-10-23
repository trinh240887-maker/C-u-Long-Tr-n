import { fail, v } from '../http.js';
import { isDate, parseHM } from '../lib/time.js';
import { TYPES, isBill, describe, status, validAt, tag, matches } from '../lib/promo.js';

// Khuyến mãi: chủ quán / quản lý tạo chương trình có ngày bắt đầu – kết thúc; hết hạn tự ngừng.
// Tạo xong app báo cho mọi nhân viên; chương trình đặt trước thì sáng ngày bắt đầu báo lại.
export default function (r, ctx) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,                     -- bogo | percent | amount | bill_percent | bill_amount
    buy_qty INTEGER NOT NULL DEFAULT 1,
    get_qty INTEGER NOT NULL DEFAULT 1,
    value INTEGER NOT NULL DEFAULT 0,       -- % hoặc VNĐ
    scope TEXT NOT NULL DEFAULT 'all',      -- all | items | categories
    item_ids TEXT NOT NULL DEFAULT '[]',
    category_ids TEXT NOT NULL DEFAULT '[]',
    min_bill INTEGER NOT NULL DEFAULT 0,
    stack INTEGER NOT NULL DEFAULT 0,       -- giảm bill cộng dồn lên món đã khuyến mãi
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    days TEXT NOT NULL DEFAULT '1234567',   -- 1 = T2 … 7 = CN
    time_from INTEGER,                      -- phút trong ngày, trống = cả ngày
    time_to INTEGER,
    note TEXT NOT NULL DEFAULT '',          -- dặn nhân viên, vd "mời khách khi order"
    active INTEGER NOT NULL DEFAULT 1,
    notified_start TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at INTEGER NOT NULL
  )`);

  for (const [c, d] of [['pair', "TEXT NOT NULL DEFAULT 'cheapest'"], ['gift_item_ids', "TEXT NOT NULL DEFAULT '[]'"]]) {
    if (!db.prepare('PRAGMA table_info(promotions)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE promotions ADD COLUMN ${c} ${d}`);
  }
  const parse = (p) => ({ ...p, active: !!p.active, stack: !!p.stack, item_ids: JSON.parse(p.item_ids || '[]'), category_ids: JSON.parse(p.category_ids || '[]'), gift_item_ids: JSON.parse(p.gift_item_ids || '[]') });
  const all = () => db.prepare('SELECT * FROM promotions ORDER BY start_date DESC, id DESC').all().map(parse);
  const names = () => ({
    items: Object.fromEntries(db.prepare('SELECT id, name FROM menu_items').all().map((x) => [x.id, x.name])),
    categories: Object.fromEntries(db.prepare('SELECT id, name FROM menu_categories').all().map((x) => [x.id, x.name])),
  });
  const view = (p, nm = names()) => ({ ...p, summary: describe(p, nm), status: status(p, ctx.now(), ctx.clock()), tag: isBill(p) ? '' : tag(p, nm) });

  // Dùng cho tính bill: mọi chương trình đang bật và còn hạn (giờ áp dụng do bộ tính kiểm tra theo lúc gọi món)
  ctx.promosFor = () => {
    const today = ctx.clock().dateOf(ctx.now());
    return all().filter((p) => p.active && p.end_date >= addDaysSafe(today, -2));
  };
  // Món đang có khuyến mãi ngay lúc này → nhãn trên màn gọi món
  ctx.promoTags = () => {
    const now = ctx.now();
    const clock = ctx.clock();
    const live = all().filter((p) => !isBill(p) && validAt(p, now, clock));
    // running: mọi chương trình đang chạy (cả giảm bill) → màn gọi món luôn hiện cho nhân viên biết
    const running = all().filter((p) => validAt(p, now, clock)).map((p) => `${p.name}${p.note ? ` (${p.note})` : ''}`);
    if (!live.length) return { tags: {}, bill: billNow(now, clock), running };
    const tags = {};
    const nm = names();
    for (const it of db.prepare('SELECT id, category_id FROM menu_items WHERE active = 1').all()) {
      const ps = live.filter((p) => matches(p, { menu_item_id: it.id, category_id: it.category_id }));
      if (ps.length) tags[it.id] = ps.map((p) => tag(p, nm)).join(' · ');
    }
    return { tags, bill: billNow(now, clock), running };
  };
  const billNow = (now, clock) => all().filter((p) => isBill(p) && validAt(p, now, clock)).map((p) => view(p).summary);

  const hmOrNull = (x, name) => {
    if (x === '' || x == null) return null;
    if (typeof x === 'number') return v.int(x, { min: 0, max: 1440, name });
    try { return parseHM(x); } catch { fail(400, `${name} không hợp lệ, vd 14:00`); }
  };
  function fields(body, cur = {}) {
    const get = (k, fn) => (body[k] === undefined ? cur[k] : fn(body[k]));
    const type = get('type', (x) => { if (!TYPES[x]) fail(400, 'Loại khuyến mãi không hợp lệ'); return x; });
    const f = {
      name: get('name', (x) => v.text(x, { name: 'Tên chương trình', required: true, max: 80 })),
      type,
      buy_qty: get('buy_qty', (x) => v.int(x, { min: 1, max: 20, name: 'Số phần mua' })) ?? 1,
      get_qty: get('get_qty', (x) => v.int(x, { min: 1, max: 20, name: 'Số phần tặng' })) ?? 1,
      value: get('value', (x) => v.int(Number(String(x ?? 0).replace(/[.,\s]/g, '')), { min: 0, max: 100_000_000, name: 'Mức giảm' })) ?? 0,
      scope: get('scope', (x) => { if (!['all', 'items', 'categories'].includes(x)) fail(400, 'Phạm vi không hợp lệ'); return x; }) ?? 'all',
      item_ids: get('item_ids', (x) => (Array.isArray(x) ? x.map((n) => v.int(n, { min: 1, name: 'Món' })) : fail(400, 'Danh sách món không hợp lệ'))) ?? [],
      category_ids: get('category_ids', (x) => (Array.isArray(x) ? x.map((n) => v.int(n, { min: 1, name: 'Nhóm' })) : fail(400, 'Danh sách nhóm không hợp lệ'))) ?? [],
      min_bill: get('min_bill', (x) => v.int(Number(String(x || 0).replace(/[.,\s]/g, '')), { min: 0, max: 1_000_000_000, name: 'Bill tối thiểu' })) ?? 0,
      stack: get('stack', (x) => v.bool(x)) ?? false,
      pair: get('pair', (x) => (x === 'same' ? 'same' : 'cheapest')) ?? 'cheapest',
      gift_item_ids: get('gift_item_ids', (x) => (Array.isArray(x) ? x.map((n) => v.int(n, { min: 1, name: 'Món tặng' })) : fail(400, 'Danh sách món tặng không hợp lệ'))) ?? [],
      start_date: get('start_date', (x) => { if (!isDate(x)) fail(400, 'Ngày bắt đầu không hợp lệ'); return x; }),
      end_date: get('end_date', (x) => { if (!isDate(x)) fail(400, 'Ngày kết thúc không hợp lệ'); return x; }),
      days: get('days', (x) => { const s = [...new Set(String(x).replace(/[^1-7]/g, ''))].sort().join(''); if (!s) fail(400, 'Chọn ít nhất 1 ngày trong tuần'); return s; }) ?? '1234567',
      time_from: get('time_from', (x) => hmOrNull(x, 'Giờ bắt đầu')) ?? null,
      time_to: get('time_to', (x) => hmOrNull(x, 'Giờ kết thúc')) ?? null,
      note: get('note', (x) => v.text(x, { name: 'Ghi chú', max: 300 })) ?? '',
      active: get('active', (x) => v.bool(x)) ?? true,
    };
    if (!f.type) fail(400, 'Chọn loại khuyến mãi');
    if (!f.start_date || !f.end_date) fail(400, 'Chọn ngày bắt đầu và kết thúc');
    if (f.end_date < f.start_date) fail(400, 'Ngày kết thúc phải sau ngày bắt đầu');
    if ((f.type === 'percent' || f.type === 'bill_percent') && (f.value < 1 || f.value > 100)) fail(400, 'Giảm % phải từ 1 đến 100');
    if ((f.type === 'amount' || f.type === 'bill_amount') && f.value < 1000) fail(400, 'Nhập số tiền giảm');
    if (!isBill(f) && f.scope === 'items' && !f.item_ids.length) fail(400, f.type === 'gift' ? 'Chọn món khách phải mua' : 'Chọn món áp dụng');
    if (f.type === 'gift' && !f.gift_item_ids.length) fail(400, 'Chọn món tặng');
    if (!isBill(f) && f.scope === 'categories' && !f.category_ids.length) fail(400, 'Chọn nhóm món áp dụng');
    if ((f.time_from == null) !== (f.time_to == null)) fail(400, 'Nhập đủ giờ bắt đầu và kết thúc, hoặc để trống cả hai');
    return f;
  }
  const save = (f, id) => {
    const cols = ['name', 'type', 'buy_qty', 'get_qty', 'value', 'scope', 'item_ids', 'category_ids', 'min_bill', 'stack', 'pair', 'gift_item_ids', 'start_date', 'end_date', 'days', 'time_from', 'time_to', 'note', 'active'];
    const vals = cols.map((c) => (Array.isArray(f[c]) ? JSON.stringify(f[c]) : typeof f[c] === 'boolean' ? Number(f[c]) : f[c]));
    if (id) { db.prepare(`UPDATE promotions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...vals, id); return id; }
    return Number(db.prepare(`INSERT INTO promotions (${cols.join(', ')}, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?)`).run(...vals, ctx.now()).lastInsertRowid);
  };
  const everyone = () => db.prepare('SELECT id FROM staff WHERE active = 1').all().map((x) => x.id);
  function announce(p, kind) {
    const s = describe(p, names());
    const title = kind === 'start' ? `Hôm nay bắt đầu khuyến mãi: ${p.name}` : kind === 'update' ? `Khuyến mãi thay đổi: ${p.name}` : `Khuyến mãi mới: ${p.name}`;
    const ids = everyone();
    ctx.notify(ids, { title, body: `${s}${p.note ? `. ${p.note}` : ''}`, link: '/khuyen-mai' });
    return ids.length;
  }

  r.get('/api/promotions', 'staff', () => {
    const nm = names();
    return { items: all().map((p) => view(p, nm)), types: TYPES };
  });

  r.post('/api/promotions', 'manager', ({ me, body }) => {
    const f = fields(body);
    const id = save(f);
    db.prepare('UPDATE promotions SET created_by = ? WHERE id = ?').run(me.id, id);
    const p = parse(db.prepare('SELECT * FROM promotions WHERE id = ?').get(id));
    const today = ctx.clock().dateOf(ctx.now());
    const notified = body.notify === false ? 0 : announce(p, 'new');
    if (p.start_date <= today) db.prepare('UPDATE promotions SET notified_start = ? WHERE id = ?').run(today, id);
    ctx.audit(me, 'promo.create', { id, name: f.name, type: f.type });
    ctx.broadcast('menu');
    return { id, notified };
  });

  r.patch('/api/promotions/:id', 'manager', ({ me, params, body }) => {
    const cur = db.prepare('SELECT * FROM promotions WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy chương trình');
    const f = fields(body, parse(cur));
    save(f, cur.id);
    const p = parse(db.prepare('SELECT * FROM promotions WHERE id = ?').get(cur.id));
    const notified = body.notify ? announce(p, 'update') : 0;
    ctx.audit(me, 'promo.update', { id: cur.id, ...(body.active !== undefined ? { active: f.active } : {}) });
    ctx.broadcast('menu');
    return { ok: true, notified };
  });

  r.delete('/api/promotions/:id', 'manager', ({ me, params }) => {
    const cur = db.prepare('SELECT * FROM promotions WHERE id = ?').get(params.id);
    if (!cur) fail(404, 'Không tìm thấy chương trình');
    db.prepare('DELETE FROM promotions WHERE id = ?').run(cur.id);
    ctx.audit(me, 'promo.delete', { id: cur.id, name: cur.name });
    ctx.broadcast('menu');
    return { ok: true };
  });

  // Chạy mỗi giờ: chương trình đặt trước, tới ngày bắt đầu thì báo nhân viên (sau 8h sáng)
  ctx.promoTick = () => {
    const now = ctx.now();
    const clock = ctx.clock();
    const today = clock.dateOf(now);
    if (clock.minuteOf(now) < 8 * 60) return 0;
    let n = 0;
    for (const p of all().filter((x) => x.active && x.start_date === today && x.notified_start !== today)) {
      announce(p, 'start');
      db.prepare('UPDATE promotions SET notified_start = ? WHERE id = ?').run(today, p.id);
      n++;
    }
    return n;
  };
}

function addDaysSafe(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
