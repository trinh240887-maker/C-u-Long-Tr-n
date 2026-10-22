#!/usr/bin/env node
// Giả lập TOÀN BỘ 1 ngày vận hành theo từng vai, KHÔNG dùng SePay (chuyển khoản: phục vụ bấm "khách đã CK",
// thu ngân nhìn app ngân hàng xác nhận cuối ngày):
//   Sáng: NCC giao → khu nhận + chụp bill → thu ngân duyệt; két đầu ngày; khách đặt bàn (gọi điện + online).
//   Trưa + tối: khách vào / đặt bàn đến / hết bàn → danh sách chờ (app tự mời nhóm vừa chỗ) → gọi món (trừ kho theo
//   định lượng MẪU) → bếp làm → ra món → xin tính tiền → CK / tiền mặt (phục vụ giao thu ngân) → bàn chờ dọn → dọn.
//   Sự cố: bàn đặt còn khách lúc T−20′ (app tự chuyển bàn), khách đặt không đến, hết nguyên liệu (app tự khoá món),
//   1 bill "khách đã CK" mà tiền không về.
//   Cuối ngày: kiểm kho (lệch định lượng), 22:00 tổng hợp hàng cần nhập, thu ngân đối soát CK + đếm két + chốt ngày.
//   Sáng hôm sau: 7h chủ quán nhận tóm tắt, duyệt sổ; quản lý duyệt đơn mua; báo cáo năng suất nhân sự.
// Chạy: node --disable-warning=ExperimentalWarning scripts/simulate-full.js [file-báo-cáo.md]
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const DAY = '2026-10-24';
const NEXT = '2026-10-25';
const at = (hm, d = DAY) => clock.toEpoch(d, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
const MIN = 60_000;
let seed = Number(process.env.SEED || 2410);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);
const f = (n) => Math.round(n || 0).toLocaleString('vi-VN');
const hmOf = (ms) => clock.fmt(ms).slice(0, 5);
const IMG = `data:image/jpeg;base64,${Buffer.alloc(4000, 7).toString('base64')}`;

let now = at('07:00');
const db = openDb(':memory:', { now });
const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')), zaloTransport: { send: async () => {} } });
const server = http.createServer(app.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const issues = [];
const log = [];
const say = (m) => log.push(`${hmOf(now)} ${m}`);
const client = (label) => {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (res.status >= 500) issues.push(`LỖI MÁY CHỦ ${res.status} ${method} ${url} (${label}): ${data?.error}`);
    return { status: res.status, data };
  };
};
const ok = (r, what) => { if (r.status !== 200) issues.push(`${what}: ${r.status} ${r.data?.error}`); return r.data; };
const login = async (label, pin, np) => { const c = client(label); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };

// ---------- Dựng quán ----------
const o = await login('Chủ quán', DEFAULT_OWNER_PIN, '582914');
const teams = (await o('GET', '/api/teams')).data;
const tid = (n) => teams.find((x) => x.name === n).id;
let pinN = 736500;
const staffRows = [];
const hire = async (name, role, team, rate = 25000) => {
  const pin = String(++pinN);
  const r = await o('POST', '/api/staff', { name, role, team_id: tid(team), pin, pay_type: 'hour', pay_rate: rate });
  const c = await login(name, pin, String(pinN + 100000));
  c.id = r.data.id; Object.defineProperty(c, "name", { value: name }); c.team = team;
  staffRows.push(c);
  return c;
};
const quan = await hire('Quân (QL)', 'manager', 'Phục vụ', 40000);
const bao = await hire('Bảo (TC)', 'shift_lead', 'Phục vụ', 32000);
const waiters = [];
for (const n of ['Hậu', 'Thương', 'Vy', 'Nhi', 'Tú', 'Khang', 'Linh', 'Trâm']) waiters.push(await hire(n, 'staff', 'Phục vụ'));
const phat = await hire('Phát (bếp)', 'team_lead', 'Bếp steak', 35000);
const cooks = [phat, await hire('Lộc (bếp)', 'staff', 'Bếp steak', 28000)];
const tai = await hire('Tài (lẩu)', 'team_lead', 'Lẩu', 35000);
await hire('Hoà (lẩu)', 'staff', 'Lẩu', 27000);
const mai = await hire('Mai (bar)', 'team_lead', 'Bar', 30000);
const ngan = await hire('Ngân (TN)', 'staff', 'Thu ngân', 30000);
const lan = await hire('Lan (TV)', 'staff', 'Tạp vụ', 23000);
await o('PUT', '/api/settings', { kho_tong_staff_id: quan.id });
// Chấm công giả lập (ghi thẳng): ca trưa 10:00–14:30 một nửa phục vụ, ca tối 16:00–23:00 tất cả
const addAtt = db.prepare('INSERT INTO attendance (staff_id, date, clock_in, clock_out, late_minutes) VALUES (?, ?, ?, ?, ?)');
staffRows.forEach((c, k) => {
  const lateMin = c.name === 'Vy' ? 18 : 0;
  if (c.team !== 'Phục vụ' || k % 2 === 0) addAtt.run(c.id, DAY, at('10:00') + lateMin * MIN, at('14:30'), lateMin);
  addAtt.run(c.id, DAY, at('16:00') + lateMin * MIN, at('23:00'), lateMin);
});

// Kho + định lượng MẪU
const meta = (await o('GET', '/api/stock/meta')).data;
const S = Object.fromEntries(meta.stores.map((s) => [s.name, s.id]));
const sup = async (name) => (await o('POST', '/api/stock/suppliers', { name })).data.id;
const nThit = await sup('Sạp thịt Kim Thanh Ngọc');
const nRau = await sup('Vựa rau Bé Thùy');
const nBia = await sup('Đại lý bia Hưng Thịnh');
for (const [st, n] of [['Kho Bếp steak', nThit], ['Kho Lẩu', nThit], ['Kho Bar', nBia]]) await o('PATCH', `/api/stock/stores/${S[st]}`, { supplier_id: n });
const ing = async (name, store, unit, pu, factor, price, min, extra = {}) => (await o('POST', '/api/stock/ingredients', { name, unit, home_store_id: S[store], purchase_unit: pu, purchase_factor: factor, price, min_stock: min, freshness: 'fresh', shelf_days: 3, lead_days: 1, order_step: 1, ...extra })).data.id;
const I = {
  than: await ing('Thăn bò steak', 'Kho Bếp steak', 'g', 'kg', 1000, 420000, 4000),
  khoai: await ing('Khoai tây', 'Kho Bếp steak', 'g', 'kg', 1000, 30000, 3000),
  bap: await ing('Bắp bò', 'Kho Lẩu', 'g', 'kg', 1000, 260000, 4000),
  rau: await ing('Rau tổng hợp', 'Kho Lẩu', 'g', 'kg', 1000, 25000, 4000),
  cot: await ing('Cốt lẩu', 'Kho Lẩu', 'phần', 'phần', 1, 30000, 20),
  bia: await ing('Heineken lùn', 'Kho Bar', 'lon', 'thùng', 24, 420000, 48, { freshness: 'dry', shelf_days: 0 }),
};
const menu = (await o('GET', '/api/menu')).data;
const M = (n) => menu.items.find((x) => x.name === n);
const recipe = async (name, lines) => ok(await o('PATCH', `/api/menu/items/${M(name).id}`, { recipe: lines.map(([i, q]) => ({ ingredient_id: I[i], qty: q })) }), `Định lượng ${name}`);
for (const n of ['Steak Âu', 'Combo 1', 'Combo 2', 'Combo 3']) await recipe(n, [['than', 180], ['khoai', 120]]);
for (const n of ['Set 1 Thảo mộc Triều Châu', 'Set 2 Mala Tứ Xuyên', 'Set 3 Cà chua Quý Châu']) await recipe(n, [['bap', 200], ['rau', 300], ['cot', 1]]);
await recipe('Heineken lùn', [['bia', 1]]);
const stock = (i) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(I[i]).q;
const kg = (g) => `${(g / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}kg`;

const st = { groups: 0, guests: 0, walkins: 0, waitlisted: 0, waitSeated: 0, waitGone: 0, waits: [], calls: 0, bookings: 0, bookArrive: 0, noShow: 0, autoMove: 0,
  items: 0, swaps: 0, served: 0, late: 0, pay: { transfer: 0, cash: 0, cashier: 0 }, handovers: 0, ghost: 0, cleaned: 0, dirtyWait: [], revenue: 0 };

// ---------- Sáng ----------
now = at('08:30');
const receive = async (who, body, label) => {
  const r = await who('POST', '/api/purchases', { photos: [IMG], ...body });
  if (r.status !== 200) { issues.push(`Nhận hàng ${label}: ${r.data?.error}`); return null; }
  say(`[Bếp/khu] ${label}: nhận ${f(r.data.total)}đ, chụp bill, ký "${r.data.signer_name}"${r.data.flags.length ? ` · app đánh dấu: ${r.data.flags.join('; ')}` : ''}`);
  return r.data;
};
const bills0 = [
  await receive(phat, { store_id: S['Kho Bếp steak'], supplier_id: nThit, signer_name: 'Phát', lines: [{ ingredient_id: I.than, qty: 40, price: 420000 }, { ingredient_id: I.khoai, qty: 30, price: 30000 }] }, 'Sạp thịt → Bếp steak (thăn 40kg, khoai 30kg)'),
  await receive(tai, { store_id: S['Kho Lẩu'], supplier_id: nThit, signer_name: 'Tài', lines: [{ ingredient_id: I.bap, qty: 30, price: 260000 }, { ingredient_id: I.cot, qty: 130, price: 30000 }] }, 'Sạp thịt → Lẩu (bắp 30kg, cốt 130 phần)'),
  await receive(tai, { store_id: S['Kho Lẩu'], supplier_id: nRau, signer_name: 'Tài', total: 1_400_000, lines: [{ ingredient_id: I.rau, qty: 48, price: 29000 }] }, 'Vựa rau → Lẩu (rau 48kg, giá 29k)'),
  await receive(mai, { store_id: S['Kho Bar'], supplier_id: nBia, signer_name: 'Mai', lines: [{ ingredient_id: I.bia, qty: 12, price: 420000 }] }, 'Đại lý bia → Bar (12 thùng Heineken)'),
].filter(Boolean);
now = at('09:15');
for (const b of bills0) ok(await ngan('POST', `/api/purchases/${b.id}/approve`), `Duyệt bill mua ${b.id}`);
say(`[Thu ngân] so ảnh bill, duyệt ${bills0.length} hoá đơn mua → công nợ NCC ${f(bills0.reduce((n, b) => n + b.total, 0))}đ`);
ok(await ngan('POST', '/api/payments/drawer', { date: DAY, opening: 3_000_000 }), 'Két đầu ngày');
say('[Thu ngân] ghi két đầu ngày 3.000.000đ');

// Khách đặt bàn: 4 cuộc gọi + 1 đơn online
const bookings = [];
const book = async (name, phone, guests, time, tables) => { const r = await quan('POST', '/api/reservations', { name, phone, guests, date: DAY, time, tables }); bookings.push({ id: r.data.id, name, guests, time, tables }); st.bookings++; return r.data.id; };
await book('Anh Hùng', '0901000001', 4, '19:00', '50');
await book('Chị Lan', '0901000002', 6, '19:30', '61, 62');
await book('Anh Tuấn', '0901000003', 2, '19:00', '95');
await book('Cô Hạnh', '0901000004', 4, '18:30', '30');
now = at('10:05');
const ob = await fetch(`${base}/api/public/booking`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Chị Mai (online)', phone: '0909555666', guests: 4, date: DAY, time: '19:00', note: 'Sinh nhật' }) }).then((r) => r.json());
const obRow = db.prepare('SELECT id FROM reservations WHERE code = ?').get(ob.code);
now = at('10:12');
ok(await bao('POST', `/api/reservations/${obRow.id}/confirm`, { tables: '40' }), 'Xác nhận đặt online');
bookings.push({ id: obRow.id, name: 'Chị Mai (online)', guests: 4, time: '19:00', tables: '40' }); st.bookings++;
say(`[Khách] Chị Mai tự đặt online (mã ${ob.code}) → [Trưởng ca] Bảo xác nhận bàn 40 sau 7′ (chưa cài Zalo ZNS → gọi điện báo khách)`);

// ---------- Bán hàng: hàng sự kiện theo phút ----------
const events = [];
let seq = 0;
const schedule = (t, fn) => events.push({ t, fn, s: seq++ });
const DISH = { steak: ['Steak Âu', 'Combo 1', 'Combo 2', 'Combo 3'], lau: ['Set 1 Thảo mộc Triều Châu', 'Set 2 Mala Tứ Xuyên', 'Set 3 Cà chua Quý Châu'], drink: ['Heineken lùn', 'Heineken lùn', 'Trà vải', 'Trà đào', 'Coca', 'Nước suối'], side: ['Rau tổng hợp', 'Nấm kim châm', 'Bò viên (4 viên)'] };
const byRes = new Map();
const queue = [];
const lastClose = new Map();
const tablesNow = async () => (await bao('GET', '/api/pos/tables')).data;

async function order(g) {
  const w = g.w;
  const want = [];
  const steaks = Math.round(g.size * between(0.3, 0.7));
  for (let k = 0; k < steaks; k++) want.push('steak');
  if (g.size - steaks >= 2) { want.push('lau'); if (rnd() < 0.6) want.push('side'); }
  for (let k = 0; k < g.size; k++) want.push('drink');
  for (const kind of want) {
    let name = pick(DISH[kind]);
    for (let tries = 0; tries < 4; tries++) {
      const it = M(name);
      const r = await w('POST', `/api/pos/sessions/${g.sid}/items`, { menu_item_id: it.id, qty: 1, option_ids: it.options.length ? [it.options[0].id] : [] });
      if (r.status === 200) { st.items++; if (tries) st.swaps++; break; }
      if ((r.status === 400 && /đã hết/.test(r.data?.error || '')) || (r.status === 409 && /kho chỉ còn/.test(r.data?.error || ''))) { name = pick(kind === 'steak' ? DISH.lau : kind === 'lau' ? DISH.steak : DISH[kind]); continue; }
      issues.push(`Gọi ${name}: ${r.status} ${r.data?.error}`); break;
    }
  }
  ok(await w('POST', `/api/pos/sessions/${g.sid}/send`), `Gửi bếp bàn ${g.tables}`);
  // Bếp làm 8–22′; quá 20′ là trễ (app báo, phục vụ nhắc bếp)
  const cook = between(8, 22);
  if (cook > 20) st.late++;
  schedule(now + cook * MIN, async () => {
    const s = (await w('GET', `/api/pos/sessions/${g.sid}`)).data;
    for (const i of s.items.filter((x) => x.status === 'sent')) { await w('POST', `/api/pos/items/${i.id}/served`); st.served++; }
  });
  schedule(now + (g.dwell - 6) * MIN, () => w('POST', `/api/pos/sessions/${g.sid}/request-bill`));
  schedule(now + g.dwell * MIN, () => pay(g));
}

async function pay(g) {
  const w = g.w;
  const b = (await w('GET', `/api/pos/sessions/${g.sid}/bill`)).data;
  if (!b || b.status === 'closed') return;
  const x = rnd();
  if (x < 0.62) {
    // Khách quét QR trên bill → phục vụ bấm "khách đã CK" (không SePay: thu ngân xác nhận cuối ngày theo app ngân hàng)
    ok(await w('POST', `/api/pos/sessions/${g.sid}/pay`, { method: 'transfer', confirm_unserved: true }), 'Thanh toán CK');
    st.pay.transfer++;
    if (!st.ghost && rnd() < 0.05) { st.ghost = b.bill_no; g.ghost = true; }
  } else if (x < 0.9) {
    // Phục vụ thu tiền mặt → bàn mở bán ngay, tiền "chờ thu ngân" → 1–3′ sau giao thu ngân
    const r = ok(await w('POST', `/api/pos/sessions/${g.sid}/pay`, { method: 'cash', cash_given: Math.ceil(b.total / 50000) * 50000, confirm_unserved: true }), 'Thanh toán TM');
    st.pay.cash++;
    schedule(now + between(1, 3) * MIN, async () => { if (ok(await ngan('POST', '/api/payments/handover', { ids: [g.sid], counted: r?.hand_over }), 'Giao tiền')) st.handovers++; });
  } else {
    ok(await ngan('POST', `/api/pos/sessions/${g.sid}/pay`, { method: 'cash', cash_given: b.total, confirm_unserved: true }), 'Thanh toán tại quầy');
    st.pay.cashier++;
  }
  st.revenue += b.total;
  for (const n of g.tables) lastClose.set(n, now);
  // Có khách chờ thì app báo dọn ngay (1,5–4′), không thì dọn thong thả
  const waiting = db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE kind = 'walkin' AND status = 'waiting'").get().n;
  schedule(now + (waiting ? between(1.5, 4) : between(4, 10)) * MIN, async () => { for (const n of g.tables) await lan('POST', `/api/pos/tables/${n}/clean`); st.cleaned++; });
}

async function seatWith(g, tables, resId) {
  const r = resId ? await g.w('POST', `/api/reservations/${resId}/arrive`, { tables: tables.join(', ') })
    : await g.w('POST', '/api/pos/sessions', { tables, guests: g.size, override_soon: true, override_size: true });
  if (r.status !== 200) return false;
  g.sid = r.data.session_id || r.data.id;
  g.tables = tables;
  st.groups++; st.guests += g.size;
  if (g.waitFrom) { st.waits.push((now - g.waitFrom) / MIN); st.waitSeated++; }
  if (g.waitFrom) for (const n of tables) if (lastClose.get(n) >= g.waitFrom) st.dirtyWait.push((now - lastClose.get(n)) / MIN);
  await order(g);
  return true;
}

// Khách vãng lai đến
async function walkIn(g) {
  const d = await tablesNow();
  const free = d.zones.flatMap((z) => z.tables).filter((t) => !t.session && t.dirty == null && !t.reservation?.locked).map((t) => t.number);
  if (!d.summary.waiting) {
    const need = Math.ceil(g.size / 4);
    let t = null;
    if (need === 1 && free.length) t = [free[Math.floor(rnd() * free.length)]];
    else for (const a of free.sort((x, y) => x - y)) { const run = Array.from({ length: need }, (_, k) => a + k); if (run.every((n) => free.includes(n))) { t = run; break; } }
    if (t) {
      const r = await g.w('POST', '/api/pos/sessions', { tables: t, guests: g.size, override_size: true });
      if (r.status === 409 && /có khách đặt/.test(r.data?.error || '')) { st.warnBooked = (st.warnBooked || 0) + 1; }
      else if (r.status === 200) { g.sid = r.data.id; g.tables = t; st.groups++; st.guests += g.size; st.walkins++; await order(g); return; }
    }
  }
  // Hết bàn → danh sách chờ (khách để SĐT)
  g.waitFrom = now;
  g.res = (await bao('POST', '/api/reservations', { kind: 'walkin', name: `Khách ${g.id}`, phone: `09${String(20000000 + g.id)}`, guests: g.size, date: DAY })).data.id;
  byRes.set(g.res, g);
  queue.push(g);
  st.waitlisted++;
  schedule(now + g.patience * MIN, async () => {
    if (g.sid || g.gone) return;
    g.gone = true; st.waitGone++;
    await bao('POST', `/api/waitlist/${g.res}/gone`);
  });
}

// Mỗi phút: app tự mời khách chờ, chống quên đặt bàn
const seen = new Map();
async function minuteTick() {
  await app.ctx.waitTick();
  const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.auto_move'").get().n;
  app.ctx.bookingGuardTick();
  st.autoMove += db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.auto_move'").get().n - before;
  for (const c of db.prepare("SELECT id, called_at FROM reservations WHERE kind = 'walkin' AND status = 'waiting' AND called_at IS NOT NULL").all()) {
    if (seen.get(c.id) === c.called_at) continue;
    seen.set(c.id, c.called_at);
    const g = byRes.get(c.id);
    if (!g || g.gone) continue;
    st.calls++;
    const go = async () => {
      if (g.gone || g.sid) return;
      const s = (await tablesNow()).summary.queue.find((x) => x.id === g.res);
      if (!s?.suggest || s.protect) return;
      if (s.suggest_dirty?.length) { schedule(now + MIN, go); return; }
      await seatWith(g, s.suggest, g.res);
    };
    schedule(now + between(0.5, 3) * MIN, go);
  }
}

// Khách đặt bàn đến (Anh Tuấn không đến); 18:00 cố ý cho khách vãng lai ngồi bàn 50 (đặt 19:00) để thấy app xử lý
for (const b of bookings) {
  if (b.name === 'Anh Tuấn') continue;
  const g = { id: 1000 + b.id, size: b.guests, w: pick(waiters), dwell: between(70, 95), res: b.id };
  schedule(at(b.time) + between(-5, 12) * MIN, async () => {
    const r = await g.w('POST', `/api/reservations/${b.id}/arrive`, {});
    if (r.status === 200) { g.sid = r.data.session_id; g.tables = db.prepare('SELECT table_number FROM session_tables WHERE session_id = ?').all(g.sid).map((x) => x.table_number); st.groups++; st.guests += g.size; st.bookArrive++; await order(g); say(`[Khách đặt] ${b.name} đến, vào bàn ${g.tables.join(', ')}`); }
    else issues.push(`Khách đặt ${b.name} đến: ${r.data?.error}`);
  });
}
schedule(at('18:00'), async () => {
  const w = waiters[0];
  const r = await w('POST', '/api/pos/sessions', { tables: [50], guests: 4 });
  say(`[Phục vụ] Hậu nhận khách vãng lai vào bàn 50 → app: "${r.data?.error?.slice(0, 90)}…"`);
  const r2 = await w('POST', '/api/pos/sessions', { tables: [50], guests: 4, override_soon: true });
  if (r2.status === 200) { const g = { id: 9000, size: 4, w, dwell: 95, sid: r2.data.id, tables: [50] }; st.groups++; st.guests += 4; await order(g); say('[Phục vụ] Hậu vẫn bấm xác nhận cho ngồi (giả lập quên) → 18:40 app sẽ tự chuyển đơn Anh Hùng'); }
});
schedule(at('19:16'), async () => {
  const n = db.prepare("SELECT title FROM notifications WHERE title LIKE 'Khách đặt trễ%Anh Tuấn%' LIMIT 1").get();
  await bao('PATCH', `/api/reservations/${bookings.find((b) => b.name === 'Anh Tuấn').id}`, { status: 'no_show' });
  st.noShow++;
  say(`[Trưởng ca] ${n ? `app nhắc "${n.title}"` : 'không có nhắc'} → gọi không được → bấm "Không đến", bàn 95 mở bán`);
});

// Khách vãng lai: trưa 18 nhóm, tối 125 nhóm dồn 18:00–20:30
const SIZES = [[2, 0.33], [3, 0.2], [4, 0.27], [5, 0.08], [6, 0.08], [8, 0.04]];
const size = () => { let x = rnd(); for (const [s, p] of SIZES) { if ((x -= p) <= 0) return s; } return 2; };
let gid = 0;
for (let k = 0; k < 18; k++) { const g = { id: ++gid, size: size(), w: pick(waiters), dwell: between(45, 70), patience: between(15, 30) }; schedule(at('11:00') + between(0, 150) * MIN, () => walkIn(g)); }
for (let k = 0; k < 125; k++) { const g = { id: ++gid, size: size(), w: pick(waiters), dwell: between(65, 100), patience: between(20, 55) }; schedule(at('17:45') + ((rnd() + rnd() + rnd()) / 3) * 165 * MIN, () => walkIn(g)); }
for (let t = at('10:30'); t <= at('23:00'); t += MIN) schedule(t, minuteTick);
schedule(at('21:45'), async () => {
  const exp = stock('bap');
  const r = ok(await tai('POST', '/api/stock/count', { store_id: S['Kho Lẩu'], lines: [{ ingredient_id: I.bap, actual: Math.max(0, exp - 380) }] }), 'Kiểm kho Lẩu');
  const mv = db.prepare('SELECT qty, note FROM stock_moves WHERE ref = ? AND ingredient_id = ?').get(`count:${r?.count_id}`, I.bap);
  say(`[Bếp lẩu] kiểm kho cuối ca: bắp bò sổ ${kg(exp)}, thực tế ${kg(Math.max(0, exp - 380))} → "${mv?.note}" ${kg(mv?.qty || 0)}`);
});
schedule(at('22:00'), async () => { const rep = app.ctx.purchaseReportTick(); say(`[App → Zalo OA] 22:00 gửi "Hàng cần nhập ngày mai": ${rep?.pos.length || 0} NCC, ${f(rep?.total)}đ`); });

while (events.length) {
  events.sort((a, b) => a.t - b.t || a.s - b.s);
  const ev = events.shift();
  now = Math.max(now, ev.t);
  await ev.fn();
}

// ---------- Cuối ngày: thu ngân, không SePay ----------
now = at('23:30');
let day = (await ngan('GET', `/api/payments?date=${DAY}`)).data;
const pendingCK = day.bills.filter((b) => b.reconcile_status === 'pending');
// Thu ngân mở app ngân hàng: thấy tiền của mọi bill, trừ bill "ma" (khách chưa chuyển) → đánh dấu "không thấy tiền"
const ghostIds = pendingCK.filter((b) => b.bill_no === st.ghost).map((b) => b.id);
const okCk = pendingCK.filter((b) => b.bill_no !== st.ghost).map((b) => b.id);
if (okCk.length) ok(await ngan('POST', '/api/payments/reconcile', { ids: okCk, status: 'confirmed' }), 'Xác nhận CK');
if (ghostIds.length) ok(await ngan('POST', '/api/payments/reconcile', { ids: ghostIds, status: 'missing', note: 'App ngân hàng không có giao dịch này' }), 'Bill CK không thấy tiền');
say(`[Thu ngân] mở app Techcombank so ${pendingCK.length} bill CK: xác nhận ${okCk.length}, ${ghostIds.length} bill không thấy tiền → ghi "thiếu", báo quản lý`);
day = (await ngan('GET', `/api/payments?date=${DAY}`)).data;
const toDenoms = (amount) => { const d = {}; let rest = amount; for (const x of [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000]) { d[x] = Math.floor(rest / x); rest -= d[x] * x; } return d; };
ok(await ngan('POST', '/api/payments/drawer', { date: DAY, denoms: toDenoms(day.summary.drawer_expected), keep_float: 3_000_000 }), 'Đếm két');
ok(await ngan('POST', '/api/payments/drawer-photo', { date: DAY, data: IMG }), 'Ảnh két');
const close = await ngan('POST', '/api/payments/close-day', { date: DAY });
if (close.status !== 200) issues.push(`Chốt ngày: ${close.data?.error}`);
day = (await ngan('GET', `/api/payments?date=${DAY}`)).data;
say(`[Thu ngân] đếm két theo mệnh giá ${f(day.summary.drawer_counted)}đ (phải có ${f(day.summary.drawer_expected)}đ), chụp ảnh, để lại 3.000.000đ, chốt ngày ${close.status === 200 ? '✓' : '✗'}`);

// ---------- Sáng hôm sau ----------
now = at('07:05', NEXT);
app.ctx.reviewTick();
const morning = db.prepare("SELECT n.title, n.body FROM notifications n JOIN staff s ON s.id = n.staff_id WHERE s.role = 'owner' AND n.title LIKE 'Duyệt sổ%' ORDER BY n.id DESC").get();
now = at('07:20', NEXT);
const rv = await o('POST', '/api/daybook/review', { date: DAY, status: ghostIds.length ? 'issue' : 'approved', note: ghostIds.length ? 'Bill CK không thấy tiền: Bảo kiểm camera, gọi lại khách' : '' });
now = at('08:00', NEXT);
const pos = (await quan('GET', '/api/stock/po?status=draft')).data;
for (const p of pos) { ok(await quan('POST', `/api/stock/po/${p.id}/submit`), `Gửi đơn #${p.id}`); ok(await quan('POST', `/api/stock/po/${p.id}/approve`), `Duyệt đơn #${p.id}`); }
const labor = app.ctx.laborReport(DAY, DAY);
const sales = app.ctx.salesReport(DAY, DAY);
const debts = (await ngan('GET', '/api/suppliers/debts')).data;

// ---------- Báo cáo ----------
const out = [];
const P = (s = '') => out.push(s);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const note = (re) => [...new Set(db.prepare('SELECT title, created_at FROM notifications ORDER BY id').all().filter((x) => re.test(x.title)).map((x) => `${hmOf(x.created_at)} ${x.title}`))];
P('# Giả lập toàn bộ 1 ngày vận hành · Thứ Bảy 24/10 · không dùng SePay');
P();
P(`Kết quả: **${issues.length ? `${issues.length} lỗi` : 'không lỗi'}** · ${staffRows.length} nhân sự, 100 bàn, định lượng MẪU`);
for (const x of issues.slice(0, 15)) P(`- ✗ ${x}`);
P();
P('## Khách hàng');
P(`- ${st.groups} nhóm / ${st.guests} khách được phục vụ (vãng lai ${st.walkins}, khách đặt ${st.bookArrive}/${st.bookings}, mời từ danh sách chờ ${st.waitSeated})`);
P(`- Hết bàn phải chờ: ${st.waitlisted} nhóm · chờ TB ${avg(st.waits).toFixed(1)}′ · bỏ về ${st.waitGone} nhóm`);
P(`- Khách gọi món đã hết → phục vụ mời món khác ${st.swaps} lần`);
P(`- Đặt online: Chị Mai tự đặt, quán xác nhận sau 7′ · Anh Tuấn đặt không đến → app nhắc, trưởng ca bấm "Không đến"`);
P();
P('## Phục vụ / quản lý');
P(`- App tự mời khách chờ ${st.calls} lượt (bàn trống / đang dọn, nhóm vừa chỗ)`);
P(`- Lúc có khách chờ: bàn từ lúc khách cũ trả tiền đến khách mới ngồi TB ${avg(st.dirtyWait).toFixed(1)}′ (gồm dọn bàn) · ${st.cleaned} lượt dọn`);
P(`- Chống quên đặt bàn: app tự chuyển ${st.autoMove} đơn đặt sang bàn trống khi bàn đặt còn khách lúc T−20′`);
for (const x of note(/^(Đã chuyển bàn đặt|Khách đặt trễ|30′ nữa có khách đặt|Hôm nay \d+ bàn đặt|GẤP)/).slice(0, 8)) P(`  - ${x}`);
P();
P('## Bếp');
P(`- ${st.items} phần gọi, ${st.served} lần bấm "đã ra", ~${st.late} bàn ra món trễ > 20′`);
for (const x of note(/^(Sắp hết|HẾT MÓN|Có lại món|Bán vượt)/).slice(0, 10)) P(`- ${x}`);
P(`- Tồn cuối ngày: thăn ${kg(stock('than'))} · bắp ${kg(stock('bap'))} · rau ${kg(stock('rau'))} · cốt ${Math.round(stock('cot'))} · bia ${Math.round(stock('bia'))} lon`);
P();
P('## Thu ngân');
P(`- Thanh toán: CK ${st.pay.transfer} bill · tiền mặt phục vụ thu ${st.pay.cash} bill (giao thu ngân ${st.handovers} lần) · tại quầy ${st.pay.cashier}`);
P(`- Doanh thu ${f(day.summary.net)}đ · CK ${f(day.summary.transfer_in)}đ · TM ${f(day.summary.cash_in)}đ · két ${f(day.summary.drawer_counted)}đ`);
P(`- Không SePay: cuối ngày so app ngân hàng, xác nhận ${okCk.length} bill CK, ${ghostIds.length} bill không thấy tiền${st.ghost ? ` (bill ${st.ghost})` : ''}`);
P(`- Hoá đơn mua: duyệt ${bills0.length} bill sáng; công nợ NCC còn ${f(debts.total)}đ`);
P();
P('## Chủ quán (sáng hôm sau)');
P(`- 07:05 nhận: **${morning?.title || '(không có)'}**`);
if (morning) P(`  - ${morning.body}`);
P(`- 07:20 duyệt sổ: ${ghostIds.length ? '"Có vấn đề" (bill CK không thấy tiền) → thu ngân + quản lý nhận báo' : 'Đạt'} (${rv.status === 200 ? '✓' : '✗'})`);
P(`- Doanh thu ${f(sales.summary.net)}đ, ${sales.summary.bills} bill, TB ${f(sales.summary.avg_bill)}đ/bill`);
P(`- Nhân sự: lương ${f(labor.summary.labor_cost)}đ = ${labor.summary.pct}% doanh thu${labor.over.length ? ` · giờ thừa người: ${labor.over.map((x) => `${x.hour}h bớt ${x.cut}`).join(', ')}` : ''}`);
if (labor.flagged.length) P(`- Cần nhắc: ${labor.flagged.slice(0, 4).map((x) => `${x.name} (${x.flags[0]})`).join(' · ')}`);
P(`- 08:00 quản lý duyệt ${pos.length} đơn mua từ bản tổng hợp 22h, gửi NCC`);
P();
P('## Dòng thời gian');
for (const x of log) P(`- ${x}`);
const report = out.join('\n');
console.log(report);
if (process.argv[2]) fs.writeFileSync(process.argv[2], report);
app.close();
server.close();
process.exit(issues.length ? 1 : 0);
