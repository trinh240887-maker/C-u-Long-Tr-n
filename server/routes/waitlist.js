import { fail } from '../http.js';

// Lấp bàn nhanh lúc kín bàn:
// - Bàn vừa tính tiền = "chờ dọn" (table_clear_minutes, mặc định 0 = trống ngay; >0 mới có chờ dọn) → có khách chờ thì báo dọn ngay.
// - Xếp khách chờ VỪA CHỖ: nhóm 2 người không phải đứng sau nhóm 8 người; nhóm đông chờ lâu (≥ 15′) thì giữ dồn
//   các bàn liền nhau sắp trống cho họ.
// - Có bàn (kể cả đang dọn) → tự gọi nhóm hợp nhất: báo nhân viên "Bàn X → mời ...", nhắn Zalo ZNS cho khách.
//   Gọi quá wait_call_minutes (5′) chưa vào → nhắc nhân viên, nhả bàn cho nhóm sau; gọi 2 lần không thấy thì chờ nhân viên xử lý.
export default function (r, ctx) {
  const { db } = ctx;
  const addCol = (c, d) => { if (!db.prepare('PRAGMA table_info(reservations)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE reservations ADD COLUMN ${c} ${d}`); };
  addCol('called_at', 'INTEGER');
  addCol('called_table', "TEXT NOT NULL DEFAULT ''");
  addCol('called_count', 'INTEGER NOT NULL DEFAULT 0');
  addCol('call_expired_at', 'INTEGER');
  addCol('queue_notified', 'INTEGER NOT NULL DEFAULT 0');
  addCol('prep_table', "TEXT NOT NULL DEFAULT ''"); // bàn đang tính tiền đã báo nhóm này ra cửa chờ
  db.exec('CREATE TABLE IF NOT EXISTS table_clean (table_number INTEGER PRIMARY KEY, cleaned_at INTEGER NOT NULL)');

  const num = (k, d) => Number(ctx.setting(k) || d);
  const MIN = 60_000;

  // Bàn đã tính tiền, chưa ai bấm "Đã dọn", chưa quá thời gian dọn, chưa có khách mới
  // Chủ quán 25/10: thu ngân xác nhận thanh toán là bàn trống bán luôn, không có trạng thái "chờ dọn" (0 phút).
  if (!ctx.setting('table_clear_off_v1')) { ctx.setSetting('table_clear_minutes', '0'); ctx.setSetting('table_clear_off_v1', '1'); }
  ctx.dirtyTables = () => {
    const now = ctx.now();
    const clear = Number(ctx.setting('table_clear_minutes') || 0);
    const out = new Map();
    if (!clear) return out;
    const rows = db.prepare(`SELECT t.table_number AS n, MAX(s.closed_at) AS c FROM session_tables t JOIN table_sessions s ON s.id = t.session_id
      WHERE s.status = 'closed' AND s.closed_at > ? GROUP BY t.table_number`).all(now - clear * MIN);
    for (const x of rows) {
      const cleaned = db.prepare('SELECT cleaned_at FROM table_clean WHERE table_number = ?').get(x.n)?.cleaned_at || 0;
      if (cleaned >= x.c) continue;
      if (db.prepare("SELECT 1 FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE t.table_number = ? AND s.status IN ('open','paying')").get(x.n)) continue;
      out.set(x.n, { closed_at: x.c, minutes: Math.round((now - x.c) / MIN) });
    }
    return out;
  };

  const tableInfo = () => new Map(db.prepare('SELECT t.number, t.seats, t.zone_id FROM dining_tables t JOIN zones z ON z.id = t.zone_id WHERE z.active = 1').all().map((t) => [t.number, t]));

  // Tìm bàn cho 1 nhóm trong danh sách bàn: 1 bàn đủ chỗ nhỏ nhất, không thì ghép bàn liền số cùng khu ít bàn nhất
  function fit(guests, pool, info) {
    const list = [...pool].map((n) => info.get(n)).filter(Boolean).sort((a, b) => a.number - b.number);
    const single = list.filter((t) => t.seats >= guests).sort((a, b) => a.seats - b.seats || a.number - b.number)[0];
    if (single) return [single.number];
    let best = null;
    for (let i = 0; i < list.length; i++) {
      let seats = 0;
      const run = [];
      for (let j = i; j < list.length && (j === i || (list[j].number === list[j - 1].number + 1 && list[j].zone_id === list[i].zone_id)); j++) {
        run.push(list[j].number);
        seats += list[j].seats;
        if (seats >= guests) { if (!best || run.length < best.length) best = [...run]; break; }
      }
    }
    return best;
  }

  // Kế hoạch xếp khách chờ. soon = [{tables, minutes}] bàn sắp trống (từ sơ đồ) để ước thời gian chờ.
  ctx.waitPlan = ({ soon = [] } = {}) => {
    const now = ctx.now();
    const today = ctx.today();
    const dwell = num('dining_minutes', 70) + 15;
    const callMin = num('wait_call_minutes', 5);
    const info = tableInfo();
    const dirty = ctx.dirtyTables();
    const pool = new Set(ctx.freeTablesNow(dwell).map((t) => t.number));
    const queue = db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'walkin' AND status = 'waiting' ORDER BY created_at, id").all(today);
    const plan = new Map();
    // Nhóm đã gọi, còn trong thời gian chờ vào → giữ bàn đã gọi
    for (const g of queue) {
      if (!g.called_at || now - g.called_at > callMin * MIN || !g.called_table) continue;
      const t = g.called_table.split(',').map(Number);
      if (t.every((n) => pool.has(n))) { t.forEach((n) => pool.delete(n)); plan.set(g.id, { tables: t, called: true }); }
    }
    // Nhóm đông chờ lâu: giữ dồn dãy bàn liền nhau (trống / đang dọn / xin tính tiền) cho họ
    const paying = new Set(soon.filter((x) => x.minutes <= 5).flatMap((x) => x.tables));
    const longWait = num('wait_big_protect_minutes', 15);
    for (const g of queue) {
      if (plan.has(g.id) || g.call_expired_at) continue;
      if (fit(g.guests, pool, info)) continue; // xếp được ngay thì không cần giữ
      if (now - g.created_at < longWait * MIN) continue;
      const cand = new Set([...pool, ...paying]);
      const run = fit(g.guests, cand, info);
      if (run && run.some((n) => pool.has(n))) {
        run.forEach((n) => pool.delete(n));
        plan.set(g.id, { tables: run, waitingFor: run.filter((n) => !dirty.has(n) && paying.has(n)), protect: true });
      }
      break;
    }
    // Còn lại: theo thứ tự đến, nhóm nào vừa bàn thì xếp (nhóm nhỏ không phải chờ nhóm đông)
    // Nhóm đã mời mà không vào thì xếp sau các nhóm khác; mời 2 lần không thấy thì thôi tự mời
    const order = [...queue.filter((g) => !g.call_expired_at), ...queue.filter((g) => g.call_expired_at && g.called_count < 2)];
    for (const g of order) {
      if (plan.has(g.id)) continue;
      const t = fit(g.guests, pool, info);
      if (t) { t.forEach((n) => pool.delete(n)); plan.set(g.id, { tables: t }); }
    }
    // Bàn đang xin tính tiền (~5′ nữa trống) → nhóm chờ vừa chỗ tiếp theo ra cửa chuẩn bị
    const payingPool = new Set(db.prepare("SELECT t.table_number AS n FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE s.status = 'paying'").all().map((x) => x.n)
      .filter((n) => ![...plan.values()].some((p) => p.tables.includes(n))));
    const prep = new Map();
    for (const g of order) {
      if (plan.has(g.id)) continue;
      const t = fit(g.guests, payingPool, info);
      if (t) { t.forEach((n) => payingPool.delete(n)); prep.set(g.id, t); }
    }
    // Ước thời gian chờ cho nhóm chưa có bàn: lần lượt lấy bàn sắp trống đủ chỗ
    const taken = new Set([...plan.values(), ...[...prep.values()].map((t) => ({ tables: t }))].flatMap((p) => p.tables));
    const left = soon.filter((x) => !x.tables.some((n) => taken.has(n))).map((x) => ({ ...x, seats: x.tables.reduce((s, n) => s + (info.get(n)?.seats || 0), 0) }));
    let acc = 0;
    const res = queue.map((g, k) => {
      const p = plan.get(g.id);
      let eta = null;
      if (p) eta = p.waitingFor?.length ? 5 : p.tables.some((n) => dirty.has(n)) ? 3 : 0;
      else if (prep.has(g.id)) eta = 8; // bàn đang tính tiền ~5′ + dọn ~3′
      else {
        const i = left.findIndex((x) => x.seats >= g.guests);
        const j = i >= 0 ? i : left.length ? 0 : -1;
        if (j >= 0) { eta = left[j].minutes + (i >= 0 ? 3 : 15); acc = eta; left.splice(j, 1); } else eta = acc ? acc + 10 : null;
      }
      return {
        id: g.id, name: g.name, phone: g.phone, guests: g.guests, created_at: g.created_at, no: k + 1,
        waited: Math.round((now - g.created_at) / MIN), eta,
        suggest: p ? p.tables : null, suggest_dirty: p ? p.tables.filter((n) => dirty.has(n)) : [], protect: !!p?.protect,
        called_at: g.called_at || null, called_table: g.called_table || '', called_count: g.called_count || 0,
        call_late: !!(g.called_at && now - g.called_at > callMin * MIN),
        prep: prep.get(g.id) || null,
      };
    });
    return { queue: res, dirty };
  };

  function serviceTeam() {
    const today = ctx.today();
    const ids = db.prepare(`SELECT DISTINCT a.staff_id AS id FROM attendance a JOIN staff s ON s.id = a.staff_id LEFT JOIN teams t ON t.id = s.team_id
      WHERE a.date = ? AND a.clock_out IS NULL AND (t.name IN ('Phục vụ','Tiếp thực','Tạp vụ','Thu ngân') OR s.role IN ('shift_lead','manager'))`).all(today).map((x) => x.id);
    const mgr = db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('owner','manager','shift_lead')").all().map((x) => x.id);
    return [...new Set([...ids, ...mgr])];
  }

  const alerted = new Set();
  let running = false;
  ctx.waitTick = async () => {
    if (running) return 0;
    running = true;
    try { return await tick(); } finally { running = false; }
  };
  async function tick() {
    const now = ctx.now();
    const callMin = num('wait_call_minutes', 5);
    const { queue, dirty } = ctx.waitPlan();
    let n = 0;
    const rows = new Map(db.prepare("SELECT * FROM reservations WHERE date = ? AND kind = 'walkin' AND status = 'waiting'").all(ctx.today()).map((x) => [x.id, x]));
    // Có khách chờ mà bàn vừa tính tiền chưa dọn → báo dọn ngay
    if (queue.length) {
      for (const [t, d] of dirty) {
        const key = `${t}:${d.closed_at}`;
        if (alerted.has(key)) continue;
        alerted.add(key);
        ctx.notify(serviceTeam(), { title: `Dọn ngay bàn ${t}`, body: `Đang có ${queue.length} nhóm chờ. Dọn xong bấm "Đã dọn" trên sơ đồ.`, link: '/ban', urgent: true });
        n++;
      }
    }
    // Bàn xin tính tiền khi đang có khách chờ → người dọn chuẩn bị sẵn
    if (queue.length) {
      for (const x of db.prepare("SELECT s.id, GROUP_CONCAT(t.table_number, ', ') AS tables FROM table_sessions s JOIN session_tables t ON t.session_id = s.id WHERE s.status = 'paying' GROUP BY s.id").all()) {
        const key = `pay:${x.id}`;
        if (alerted.has(key)) continue;
        alerted.add(key);
        const who = queue.find((q) => q.prep && q.prep.join(', ') === x.tables);
        ctx.notify(serviceTeam(), { title: `Bàn ${x.tables} xin tính tiền: chuẩn bị dọn`, body: who ? `Báo ${who.name} (${who.guests} khách) ra cửa, ~5′ nữa vào bàn ${x.tables}.` : `Đang có ${queue.length} nhóm chờ.`, link: '/ban' });
        n++;
      }
    }
    for (const q of queue) {
      const g = rows.get(q.id);
      if (q.prep && g.prep_table !== q.prep.join(',')) db.prepare('UPDATE reservations SET prep_table = ? WHERE id = ?').run(q.prep.join(','), g.id);
      // Khách mới vào danh sách chờ: nhắn Zalo số thứ tự (nếu đã cài ZNS)
      if (g.phone && !g.queue_notified) {
        db.prepare('UPDATE reservations SET queue_notified = 1 WHERE id = ?').run(g.id);
        if (ctx.tellCustomer) await ctx.tellCustomer({ ...g, queue_no: q.no, wait_minutes: q.eta }, 'queue');
      }
      // Gọi quá hạn chưa vào
      if (g.called_at && now - g.called_at > callMin * MIN && !g.call_expired_at) {
        db.prepare('UPDATE reservations SET call_expired_at = ? WHERE id = ?').run(now, g.id);
        ctx.notify(serviceTeam(), { title: `Đã mời ${g.name} ${callMin}′ chưa vào bàn ${g.called_table}`, body: `${g.phone ? `Gọi ${g.phone}. ` : ''}${g.called_count >= 2 ? 'Đã mời 2 lần: không thấy khách thì bấm "Bỏ về".' : 'Bàn nhường cho nhóm sau, có bàn khác sẽ mời lại.'}`, link: '/ban', urgent: true });
        n++;
      }
      // Có bàn → mời
      if (q.suggest && !q.protect && !(g.called_at && now - g.called_at <= callMin * MIN)) {
        const tables = q.suggest.join(',');
        db.prepare('UPDATE reservations SET called_at = ?, called_table = ?, called_count = called_count + 1, call_expired_at = NULL WHERE id = ?').run(now, tables, g.id);
        const dirtyNote = q.suggest_dirty.length ? ` (đang dọn bàn ${q.suggest_dirty.join(', ')})` : '';
        ctx.notify(serviceTeam(), { title: `Bàn ${q.suggest.join(', ')} → mời ${g.name} (${g.guests} khách)`, body: `Đã chờ ${q.waited}′${dirtyNote}.${g.phone ? ` SĐT ${g.phone}.` : ''}`, link: '/ban', urgent: true });
        if (ctx.tellCustomer && g.phone) await ctx.tellCustomer({ ...g, tables: tables.replace(/,/g, ', '), hold_minutes: callMin }, 'ready');
        n++;
      }
    }
    if (n) ctx.broadcast('pos');
    return n;
  }

  // Nhân viên dọn xong bàn
  r.post('/api/pos/tables/:id/clean', 'staff', async ({ me, params }) => {
    if (!db.prepare('SELECT 1 FROM dining_tables WHERE number = ?').get(params.id)) fail(404, 'Không có bàn này');
    db.prepare('INSERT INTO table_clean (table_number, cleaned_at) VALUES (?, ?) ON CONFLICT(table_number) DO UPDATE SET cleaned_at = excluded.cleaned_at').run(params.id, ctx.now());
    ctx.audit(me, 'table.clean', { table: params.id });
    await ctx.waitTick();
    ctx.broadcast('pos');
    const q = ctx.waitPlan().queue.find((x) => x.suggest?.includes(Number(params.id)));
    return { ok: true, next: q ? { id: q.id, name: q.name, guests: q.guests, tables: q.suggest } : null };
  });

  // Khách chờ bỏ về
  r.post('/api/waitlist/:id/gone', 'staff', ({ me, params }) => {
    const g = db.prepare("SELECT * FROM reservations WHERE id = ? AND kind = 'walkin' AND status = 'waiting'").get(params.id);
    if (!g) fail(404, 'Không thấy nhóm chờ này');
    db.prepare("UPDATE reservations SET status = 'cancelled', reject_reason = 'Khách bỏ về khi chờ', updated_at = ? WHERE id = ?").run(ctx.now(), g.id);
    ctx.audit(me, 'waitlist.gone', { id: g.id, waited: Math.round((ctx.now() - g.created_at) / MIN), called: g.called_count });
    ctx.broadcast('reservations');
    ctx.broadcast('pos');
    return { ok: true };
  });
}
