#!/usr/bin/env node
// Giả lập 1 ngày bán hàng: 500 khách, 100 bàn, 12 phục vụ, 2 quản lý, bếp / lẩu / bar, 1 thu ngân.
// Mỗi nhóm khách: vào bàn → gọi món → gửi bếp (in phiếu qua cầu in ra máy in giả) → bếp làm (có hàng chờ, có trễ)
// → phục vụ bưng (Đã ra) → gọi thêm → thanh toán CK / tiền mặt / kết hợp. Kèm sự cố: huỷ, làm lại, hết món, chuyển / tách / gộp bàn,
// khách bỏ về, đặt bàn & không đến, hoàn tiền, 1 bill CK "ma". Cuối ngày thu ngân đối soát sao kê và chốt doanh thu.
// Chạy: node --disable-warning=ExperimentalWarning scripts/simulate-day.js
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const DAY = '2026-10-24'; // Thứ Bảy
const at = (hm) => clock.toEpoch(DAY, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
const MIN = 60_000;
let seed = 24102026;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const between = (a, b) => a + rnd() * (b - a);
const f = (n) => Number(n).toLocaleString('vi-VN');
const hmOf = (ms) => clock.fmt(ms).slice(0, 5);

const issues = [];
const log = [];
const issue = (m) => { issues.push(m); console.log('✗', m); };
const say = (m) => { log.push(`${hmOf(now)} ${m}`); };

let now = at('09:30');
const db = openDb(':memory:', { now });
const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sd-')), zaloTransport: { send: async () => {} } });
const server = http.createServer(app.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const lat = [];
const client = (label) => {
  let cookie = '';
  return async (method, url, body, { token } = {}) => {
    const t0 = performance.now();
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(token ? { 'x-print-token': token } : {}), 'content-type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    lat.push({ url: `${method} ${url.split('?')[0].replace(/\d+/g, ':id')}`, ms: performance.now() - t0 });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (res.status >= 500) issue(`LỖI MÁY CHỦ ${res.status} ${method} ${url} (${label}): ${data?.error}`);
    return { status: res.status, data };
  };
};

// ---------- Máy in giả (cổng TCP như máy in thật) ----------
const printers = {};
async function fakePrinter(name) {
  const p = { name, jobs: 0, bytes: 0 };
  const srv = net.createServer((s) => { let n = 0; s.on('data', (c) => { n += c.length; }); s.on('end', () => { if (n) { p.jobs++; p.bytes += n; } }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  p.port = srv.address().port;
  p.close = () => srv.close();
  printers[name] = p;
  return p;
}

// ---------- Dựng quán ----------
const o = client('Chủ quán');
await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
const teams = (await o('GET', '/api/teams')).data;
const team = (n) => teams.find((t) => t.name === n)?.id;
const usedPins = new Set();
const newPin = () => { for (;;) { const p = String(Math.floor(between(200000, 989999))); if (!usedPins.has(p) && !/(\d)\1\1/.test(p)) { usedPins.add(p); return p; } } };
async function hire(name, role, teamName) {
  for (let k = 0; k < 5; k++) {
    const pin = newPin();
    const r = await o('POST', '/api/staff', { name, role, team_id: team(teamName), pin });
    if (r.status === 200) { const c = client(name); await c('POST', '/api/login', { pin }); c.pin = pin; c.staffName = name; return c; }
  }
  throw new Error(`không tạo được ${name}`);
}
const waiters = [];
for (const n of ['Hậu', 'Thương', 'Vy', 'Nhi', 'Tú', 'Khang', 'Phúc', 'Linh', 'Trâm', 'Duy', 'Như', 'Tín']) waiters.push(await hire(n, 'staff', 'Phục vụ'));
const quan = await hire('Quân (QL)', 'manager', 'Phục vụ');
const long = await hire('Long (QL)', 'manager', 'Phục vụ');
const truongCa = await hire('Bảo (TC)', 'shift_lead', 'Phục vụ');
const thuNgan = await hire('Ngân (TN)', 'staff', 'Thu ngân');
const bepSteak = await hire('Phát (bếp)', 'team_lead', 'Bếp steak');
const bepLau = await hire('Tài (lẩu)', 'team_lead', 'Lẩu');
const bar = await hire('Mai (bar)', 'team_lead', 'Bar');

// Máy in: mỗi điểm 1 máy giả; Ưu tiên chưa có IP → in sang Steak (đúng như quán hiện tại)
const menu0 = (await o('GET', '/api/menu')).data;
const S = Object.fromEntries(menu0.stations.map((s) => [s.name, s.id]));
for (const name of ['Steak', 'Nước lẩu', 'Bò', 'Topping – Nướng – Rau', 'Pha chế']) {
  const p = await fakePrinter(name);
  await o('PATCH', `/api/kitchen-stations/${S[name]}`, { printer_ip: '127.0.0.1', printer_port: p.port });
}
await o('PATCH', `/api/kitchen-stations/${S['Ưu tiên']}`, { printer_ip: '' });
const token = (await o('GET', '/api/print/status')).data.token;
// Nối SePay (ngân hàng báo tiền về), thu ngân ghi két đầu ngày
await o('POST', '/api/bank/settings', { enabled: true });
const sepayKey = (await o('GET', '/api/bank/settings')).data.api_key;

// Khuyến mãi đang chạy
const catId = (n) => menu0.categories.find((c) => c.name === n).id;
await o('POST', '/api/promotions', { name: 'Mua 1 tặng 1 trà trái cây', type: 'bogo', buy_qty: 1, get_qty: 1, scope: 'categories', category_ids: [catId('Trà trái cây')], start_date: '2026-10-20', end_date: '2026-10-31' });
await o('POST', '/api/promotions', { name: 'Happy hour steak -20%', type: 'percent', value: 20, scope: 'categories', category_ids: [catId('Steak')], start_date: '2026-10-20', end_date: '2026-10-31', time_from: '14:00', time_to: '17:00' });
await o('POST', '/api/promotions', { name: 'Bill từ 1 triệu giảm 5%', type: 'bill_percent', value: 5, min_bill: 1000000, start_date: '2026-10-20', end_date: '2026-10-31' });

const items = menu0.items;
const byCat = (n) => items.filter((i) => i.category_id === catId(n));
const STEAK = byCat('Steak');
const LAU = byCat('Combo lẩu');
const EXTRA = [...byCat('Bò tươi'), ...byCat('Topping'), ...byCat('Rau – Nấm – Mì')];
const TRA = byCat('Trà trái cây');
const NUOC = byCat('Nước khác');
const CAFE = byCat('Cà phê');

// ---------- Mô hình bếp: mỗi điểm có số người làm và thời gian làm 1 món ----------
// cooks = số phần làm song song (bếp nướng steak nướng nhiều chảo cùng lúc)
const KITCHEN = {
  Steak: { cooks: 10, prep: [7, 12] }, 'Nước lẩu': { cooks: 6, prep: [2, 4] }, Bò: { cooks: 4, prep: [2, 5] },
  'Topping – Nướng – Rau': { cooks: 5, prep: [3, 6] }, 'Pha chế': { cooks: 3, prep: [1, 3] },
};
const cookFree = Object.fromEntries(Object.entries(KITCHEN).map(([k, v]) => [k, Array(v.cooks).fill(0)]));
// Mỗi phần của món in ra máy nào (set lẩu có 2 phần cùng ra máy Topping)
const partsOf = (menuItemId) => {
  const it = items.find((i) => i.id === menuItemId);
  if (!it) return [];
  return (it.parts.length ? it.parts.map((p) => p.station_id) : [it.station_id]).map((id) => menu0.stations.find((s) => s.id === id)?.name).filter(Boolean);
};
const stationsOf = (menuItemId) => {
  const it = items.find((i) => i.id === menuItemId);
  if (!it) return [];
  const st = it.parts.length ? it.parts.map((p) => p.station_id) : [it.station_id];
  return [...new Set(st)].map((id) => menu0.stations.find((s) => s.id === id)?.name).filter(Boolean);
};
// Thời điểm món làm xong (món nhiều phần thì chờ phần chậm nhất); món gấp / làm lại được chen hàng
function cookTime(menuItemId, qty, sentAt, urgent) {
  let ready = sentAt;
  for (const st of stationsOf(menuItemId)) {
    const k = KITCHEN[st];
    const free = cookFree[st];
    const idx = free.indexOf(Math.min(...free));
    const start = urgent ? sentAt : Math.max(sentAt, free[idx]);
    const end = start + between(...k.prep) * MIN * (1 + (qty - 1) * 0.25);
    if (!urgent) free[idx] = end;
    ready = Math.max(ready, end);
  }
  return ready;
}

// ---------- Hàng sự kiện theo giờ ----------
const queue = [];
const schedule = (t, fn, label = '') => { queue.push({ t, fn, label, seq: queue.length }); };
const stats = { ck: { auto: 0, delayed: 0, manual: 0, partial: 0, ghost: 0, tip: 0 }, handovers: 0, payAlerts: 0, groups: 0, guests: 0, walkout: 0, waitlist: 0, waitMax: 0, soldOutBlocked: 0, unservedConfirm: 0, reminds: 0, redo: 0, cancelItem: 0, moves: 0, splits: 0, merges: 0, itemMoves: 0, tableCancels: 0, refunds: 0, refundAmount: 0, booking: 0, noShow: 0, pay: { cash: 0, transfer: 0, mixed: 0 }, peak: 0 };
const served = new Map(); // order_item id → thời điểm làm xong
const groups = [];
const waiting = [];
const reservedTables = new Set();

const tablesNow = async (c) => (await c('GET', '/api/pos/tables')).data.zones.flatMap((z) => z.tables);
async function freeTables(n, c) {
  const all = await tablesNow(c);
  // Phục vụ không nhận khách vãng lai vào bàn đang giữ cho khách đặt (app tô màu + chặn)
  const free = all.filter((t) => !t.session && !t.reservation && !reservedTables.has(t.number)).map((t) => t.number);
  if (n === 1) return free.length ? [pick(free)] : null;
  for (const a of free) if (free.includes(a + 1) && Math.ceil(a / 40) === Math.ceil((a + 1) / 40)) return [a, a + 1];
  return null;
}

async function addItem(g, it, qty = 1, extra = {}) {
  if (g.merged || g.gone || g.paid) return null;
  let item = it;
  for (let k = 0; k < 3; k++) {
    const body = { menu_item_id: item.id, qty, option_ids: item.options.length ? [pick(item.options).id] : [], ...extra };
    const r = await g.w('POST', `/api/pos/sessions/${g.sid}/items`, body);
    if (r.status === 200) return r.data.id;
    if (/hết/.test(r.data?.error || '')) { stats.soldOutBlocked++; item = pick(item.category_id === catId('Bò tươi') ? byCat('Bò tươi') : EXTRA); continue; }
    issue(`Gọi ${item.name} bàn ${g.tables}: ${r.data?.error}`);
    return null;
  }
  return null;
}

async function sendAndCook(g) {
  if (g.merged || g.gone || g.paid) return;
  const s0 = (await g.w('GET', `/api/pos/sessions/${g.sid}`)).data;
  const drafts = s0.items.filter((i) => i.status === 'new');
  if (!drafts.length) return;
  const r = await g.w('POST', `/api/pos/sessions/${g.sid}/send`);
  if (r.status !== 200) { issue(`Gửi bếp bàn ${g.tables}: ${r.data?.error}`); return; }
  for (const i of drafts) {
    const ready = cookTime(i.menu_item_id, i.qty, now, i.rush || s0.priority);
    served.set(i.id, ready);
    // Phục vụ bưng ra 1 phút sau khi bếp xong
    schedule(ready + MIN, async () => {
      const cur = (await g.w('GET', `/api/pos/sessions/${g.sid}`)).data;
      const it = cur.items.find((x) => x.id === i.id) || null;
      if (it && it.status === 'sent' && cur.status !== 'closed') await g.w('POST', `/api/pos/items/${i.id}/served`);
    });
  }
}

function makeOrder(g) {
  const steak = Math.round(g.size * between(0.35, 0.75));
  const lauPeople = g.size - steak;
  const list = [];
  for (let k = 0; k < steak; k++) list.push([pick(STEAK), 1]);
  if (lauPeople >= 2) for (let k = 0; k < Math.ceil(lauPeople / 3); k++) list.push([pick(LAU), 1]);
  else if (lauPeople === 1) list.push([pick(STEAK), 1]);
  if (lauPeople >= 2) for (let k = 0; k < Math.floor(between(1, 4)); k++) list.push([pick(EXTRA), 1]);
  for (let k = 0; k < g.size; k++) {
    const x = rnd();
    list.push([x < 0.45 ? pick(TRA) : x < 0.7 ? pick(NUOC) : x < 0.85 ? pick(NUOC.filter((n) => /Heineken|Tiger/.test(n.name))) : pick(CAFE), 1]);
  }
  return list;
}

async function seat(g) {
  const tables = g.reservation ? null : await freeTables(g.size >= 6 ? 2 : 1, g.w);
  if (!g.reservation && !tables) {
    if (!g.waitId) {
      const r = await g.w('POST', '/api/reservations', { kind: 'walkin', name: `Khách ${g.id}`, guests: g.size, date: DAY });
      g.waitId = r.data?.id;
      g.waitFrom = now;
      stats.waitlist++;
      waiting.push(g);
    }
    return;
  }
  if (g.reservation) {
    let r = await g.w('POST', `/api/reservations/${g.reservation}/arrive`, {});
    if (r.status === 409) {
      // Bàn giữ còn khách cũ ngồi lâu → app gợi ý bàn trống gần nhất, phục vụ chọn bàn đầu tiên
      const alt = /gần nhất: ([\d, ]+)/.exec(r.data.error)?.[1]?.split(',')[0]?.trim();
      say(`Khách đặt ${g.id}: ${r.data.error} → xếp bàn ${alt}`);
      stats.resMoved = (stats.resMoved || 0) + 1;
      if (alt) { r = await g.w('POST', `/api/reservations/${g.reservation}/arrive`, { tables: alt }); g.resTables = [Number(alt)]; }
    }
    if (r.status !== 200) { issue(`Khách đặt ${g.id} đến: ${r.data?.error}`); return; }
    g.sid = r.data.session_id;
    g.tables = g.resTables.join(',');
    g.resTables.forEach((t) => reservedTables.delete(t));
  } else if (g.waitId) {
    const r = await g.w('POST', `/api/reservations/${g.waitId}/arrive`, { tables: tables.join(', ') });
    if (r.status !== 200) { issue(`Mời khách chờ ${g.id}: ${r.data?.error}`); return; }
    g.sid = r.data.session_id;
    g.tables = tables.join(',');
    stats.waitMax = Math.max(stats.waitMax, Math.round((now - g.waitFrom) / MIN));
  } else {
    const r = await g.w('POST', '/api/pos/sessions', { tables });
    if (r.status !== 200) { issue(`Mở bàn ${tables}: ${r.data?.error}`); return; }
    g.sid = r.data.id;
    g.tables = tables.join(',');
  }
  stats.groups++;
  stats.guests += g.size;
  g.seatedAt = now;
  // Sự cố: nhận bàn rồi khách bỏ về trước khi gọi
  if (g.walkoutEarly) {
    schedule(now + 2 * MIN, async () => { await g.w('POST', `/api/pos/sessions/${g.sid}/cancel`, {}); stats.walkout++; say(`Bàn ${g.tables}: khách bỏ về trước khi gọi, huỷ bàn`); await seatWaiting(); });
    return;
  }
  schedule(now + between(3, 7) * MIN, async () => {
    for (const [it, q] of makeOrder(g)) await addItem(g, it, q, chance(0.03) ? { rush: true } : chance(0.05) ? { note: pick(['ít cay', 'chín kỹ', 'không hành', 'ra sau']) } : {});
    await sendAndCook(g);
    afterOrder(g);
  });
}

function afterOrder(g) {
  const dwell = (g.lunch ? between(45, 70) : between(65, 100)) * MIN;
  // Gọi thêm
  if (chance(0.55)) schedule(g.seatedAt + between(20, 40) * MIN, async () => {
    const n = Math.floor(between(1, 4));
    for (let k = 0; k < n; k++) await addItem(g, chance(0.6) ? pick([...TRA, ...NUOC]) : pick(EXTRA));
    await sendAndCook(g);
  });
  // Gọi nhầm nước, huỷ ngay trong 2 phút
  if (chance(0.05)) schedule(now + 30_000, async () => {
    const s = (await g.w('GET', `/api/pos/sessions/${g.sid}`)).data;
    const d = s.items.find((i) => i.status === 'sent' && stationsOf(i.menu_item_id).includes('Pha chế'));
    if (d) { const r = await g.w('POST', `/api/pos/items/${d.id}/cancel`, { reason: 'Gọi nhầm' }); if (r.status === 200) stats.cancelItem++; else issue(`Huỷ món: ${r.data?.error}`); }
  });
  // Khách chê → làm lại
  if (chance(0.03)) schedule(g.seatedAt + between(25, 35) * MIN, async () => {
    const s = (await g.w('GET', `/api/pos/sessions/${g.sid}`)).data;
    const d = s.items.find((i) => i.status === 'done' && stationsOf(i.menu_item_id).includes('Steak'));
    if (d) { const r = await g.w('POST', `/api/pos/items/${d.id}/redo`, { reason: 'Khách chê dai' }); if (r.status === 200) { stats.redo++; served.set(d.id, now + 8 * MIN); } }
  });
  // Khách bỏ về sau khi đã gửi món (trưởng ca huỷ bàn)
  if (g.walkoutLate) {
    schedule(now + 10 * MIN, async () => {
      const r = await truongCa('POST', `/api/pos/sessions/${g.sid}/cancel`, { reason: 'Khách bỏ về, chờ lâu' });
      if (r.status === 200) { stats.tableCancels++; say(`Bàn ${g.tables}: khách bỏ về sau khi gửi món → trưởng ca huỷ bàn, bếp nhận phiếu HUỶ`); g.gone = true; await seatWaiting(); } else issue(`Huỷ bàn: ${r.data?.error}`);
    });
    return;
  }
  if (g.incident === 'move') schedule(g.seatedAt + 15 * MIN, async () => {
    const t = await freeTables(1, g.w);
    if (!t) return;
    const r = await g.w('POST', `/api/pos/sessions/${g.sid}/move`, { tables: t });
    if (r.status === 200) { stats.moves++; say(`Bàn ${g.tables} → ${t}: khách xin đổi bàn (không in phiếu)`); g.tables = String(t); } else issue(`Chuyển bàn: ${r.data?.error}`);
  });
  if (g.incident === 'itemMove') schedule(g.seatedAt + 12 * MIN, async () => {
    const s = (await g.w('GET', `/api/pos/sessions/${g.sid}`)).data;
    const other = groups.find((x) => x !== g && x.sid && !x.paid && !x.gone);
    const d = s.items.find((i) => i.status !== 'cancelled' && stationsOf(i.menu_item_id).includes('Pha chế'));
    if (!other || !d) return;
    const r = await g.w('POST', `/api/pos/items/${d.id}/move`, { table: Number(String(other.tables).split(',')[0]) });
    if (r.status === 200) { stats.itemMoves++; say(`Gọi nhầm ${d.name} vào bàn ${g.tables}, chuyển sang bàn ${other.tables}`); } else issue(`Chuyển món: ${r.data?.error}`);
  });
  if (g.incident === 'merge') schedule(g.seatedAt + 20 * MIN, async () => {
    const other = groups.find((x) => x !== g && x.sid && !x.paid && !x.gone && !x.merged && x.incident !== 'merge' && !x.reservation);
    if (!other) return;
    const r = await g.w('POST', `/api/pos/sessions/${g.sid}/merge`, { from_session_id: other.sid });
    if (r.status === 200) { stats.merges++; other.merged = true; g.size += other.size; say(`Gộp bàn ${other.tables} vào ${g.tables} (2 nhóm quen nhau, tính chung)`); await seatWaiting(); } else issue(`Gộp bàn: ${r.data?.error}`);
  });
  // Thanh toán (tách bàn: 1 người trả riêng phần mình)
  schedule(g.seatedAt + dwell, () => pay(g));
}

async function pay(g) {
  if (g.gone || g.merged || g.paid) return;
  if (g.incident === 'split') {
    const s = (await g.w('GET', `/api/pos/sessions/${g.sid}`)).data;
    const mine = s.items.filter((i) => i.status !== 'cancelled').slice(0, 2);
    const t = await freeTables(1, g.w);
    if (t && mine.length === 2) {
      const r = await g.w('POST', `/api/pos/sessions/${g.sid}/split`, { table: t[0], items: mine.map((i) => ({ id: i.id, qty: 1 })) });
      if (r.status === 200) {
        stats.splits++;
        say(`Bàn ${g.tables}: 1 khách trả riêng → tách 2 món sang bàn ${t[0]}`);
        await payOne(g, r.data.session_id, 'cash');
      } else issue(`Tách bàn: ${r.data?.error}`);
    }
  }
  await payOne(g, g.sid);
  g.paid = true;
  await seatWaiting();
}

const transferBills = [];
// Ngân hàng (SePay) báo tiền về app
let bankSeq = 0;
const bankLog = [];
async function bankIn(amount, content) {
  bankLog.push(amount);
  const r = await fetch(`${base}/api/bank/sepay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Apikey ${sepayKey}` },
    body: JSON.stringify({ id: `sim${++bankSeq}`, gateway: 'Techcombank', transactionDate: clock.fmt(now), accountNumber: '19031234567', code: null, content, transferType: 'in', transferAmount: amount, referenceCode: `FT${bankSeq}` }) });
  if (r.status !== 200) issue(`SePay báo tiền về lỗi ${r.status}`);
  return (await r.json()).id;
}
let ghostDone = false;
let shortDone = false;
async function payOne(g, sid, force) {
  const b = (await g.w('GET', `/api/pos/sessions/${sid}/bill`)).data;
  if (b.unsent) issue(`Bàn ${g.tables} còn món chưa gửi lúc tính tiền`);
  const x = rnd();
  const method = force || (x < 0.6 ? 'transfer' : x < 0.93 ? 'cash' : 'mixed');
  const pay = async (body) => {
    let r = await g.w('POST', `/api/pos/sessions/${sid}/pay`, body);
    if (r.status === 409) { stats.unservedConfirm++; r = await g.w('POST', `/api/pos/sessions/${sid}/pay`, { ...body, confirm_unserved: true }); }
    if (r.status !== 200) issue(`Thanh toán bàn ${g.tables}: ${r.data?.error}`);
    return r;
  };
  stats.pay[method]++;
  if (method === 'transfer') {
    const y = rnd();
    if (!ghostDone && y < 0.04) {
      // Phục vụ bấm "khách đã CK" nhưng tiền không bao giờ về
      ghostDone = true;
      await pay({ method: 'transfer' });
      stats.ck.ghost++;
      say(`Bill ${b.bill_no} (bàn ${g.tables}): phục vụ bấm "khách đã CK" nhưng tiền không về → 30′ sau app báo quản lý`);
    } else if (y < 0.1) {
      // Khách tự gõ số tài khoản, quên nội dung → tiền vào "chưa khớp"; khách đưa màn hình chuyển thành công
      await bankIn(b.total, 'CHUYEN TIEN AN UONG');
      await pay({ method: 'transfer' });
      stats.ck.manual++;
      schedule(now + between(5, 20) * MIN, async () => {
        const t = db.prepare("SELECT id FROM bank_txns WHERE status = 'unmatched' AND amount = ? ORDER BY id LIMIT 1").get(b.total);
        if (t) { const r = await thuNgan('POST', `/api/bank/txns/${t.id}/assign`, { bill_no: b.bill_no }); if (r.status !== 200) issue(`Ghép bill: ${r.data?.error}`); }
      });
    } else if (y < 0.2) {
      // Ngân hàng chậm: phục vụ bấm "chờ tiền về", 2–10′ sau tiền mới về
      await pay({ method: 'transfer' });
      stats.ck.delayed++;
      schedule(now + between(2, 10) * MIN, () => bankIn(b.total, `MBVCB.${bankSeq}.CLT${b.bill_no}.Ck`));
    } else if (y < 0.24) {
      // Khách chuyển thiếu (gõ nhầm số) rồi chuyển bù
      await bankIn(b.total - 50000, `CLT${b.bill_no}`);
      const mid = (await g.w('GET', `/api/pos/sessions/${sid}/bill`)).data;
      if (mid.status !== 'open' || mid.qr_amount !== 50000) issue(`CK thiếu: bill ${b.bill_no} lẽ ra còn mở, QR 50.000đ`);
      await bankIn(50000, `CLT${b.bill_no} bu`);
      stats.ck.partial++;
    } else {
      // Bình thường: khách quét QR, tiền về, app tự đóng bill (thỉnh thoảng CK dư làm tip)
      const tip = chance(0.08) ? 1000 * Math.round(between(10, 60)) : 0;
      await bankIn(b.total + tip, `${pick(['MBVCB', 'ACB', 'VCB', 'TCB'])}.${bankSeq}.CLT${b.bill_no}.thanh toan`);
      stats.ck.auto++;
      if (tip) stats.ck.tip += tip;
    }
    const after = (await g.w('GET', `/api/pos/sessions/${sid}/bill`)).data;
    if (after.status !== 'closed') issue(`Bill ${b.bill_no} CK xong mà bàn chưa đóng`);
    transferBills.push({ sid, g, amount: b.total, note: b.transfer_note });
  } else {
    const body = { method, print: chance(0.7) };
    if (method === 'cash') { body.cash_given = Math.ceil(b.total / 50000) * 50000 + (chance(0.3) ? 50000 : 0); body.keep_change = chance(0.12) && body.cash_given > b.total; }
    if (method === 'mixed') body.cash_amount = Math.min(b.total - 1000, 100000 * Math.ceil(between(1, 3)));
    const r = await pay(body);
    if (r.status !== 200) return;
    if (method === 'cash' && !body.keep_change && r.data.change !== body.cash_given - b.total) issue(`Tiền thối sai bàn ${g.tables}`);
    if (method === 'mixed') await bankIn(b.total - body.cash_amount, `CLT${b.bill_no}`);
    // Phục vụ mang tiền + bill giao thu ngân ngay (1–3 phút)
    schedule(now + between(1, 3) * MIN, async () => {
      const short = !shortDone && chance(0.05);
      if (short) shortDone = true;
      const hr = await thuNgan('POST', '/api/payments/handover', { ids: [sid], counted: r.data.hand_over - (short ? 20000 : 0) });
      if (hr.status !== 200) issue(`Giao tiền bill ${b.bill_no}: ${hr.data?.error}`);
      stats.handovers++;
      if (short) say(`Bill ${b.bill_no}: ${g.w.staffName} giao thiếu 20.000đ → app ghi tên, báo chủ quán`);
    });
  }
  // Khách về rồi mới báo thiếu món → quản lý hoàn tiền mặt
  if (g.refund) schedule(now + 3 * MIN, async () => {
    const bb = (await g.w('GET', `/api/pos/sessions/${sid}/bill`)).data;
    const line = bb.lines.find((l) => l.status === 'sent') || bb.lines.find((l) => l.qty - l.refunded_qty > 0);
    if (!line) return;
    const rr = await g.w('POST', `/api/pos/sessions/${sid}/refund`, { items: [{ id: line.id, qty: 1 }], reason: line.status === 'sent' ? 'Chưa ra món' : 'Món lỗi', approver_pin: quan.pin });
    if (rr.status === 200) { stats.refunds++; stats.refundAmount += rr.data.amount; say(`Bill ${bb.bill_no}: khách báo thiếu "${line.name}" → hoàn ${f(rr.data.amount)}đ tiền mặt (Quân duyệt)`); } else issue(`Hoàn tiền: ${rr.data?.error}`);
  });
}

let seatingBusy = false;
async function seatWaiting() {
  if (seatingBusy) return;
  seatingBusy = true;
  try { await seatWaitingInner(); } finally { seatingBusy = false; }
}
async function seatWaitingInner() {
  while (waiting.length) {
    const g = waiting[0];
    const t = await freeTables(g.size >= 6 ? 2 : 1, g.w);
    if (!t) return;
    waiting.shift();
    await seat(g);
  }
}

// ---------- Tạo 500 khách ----------
const SIZES = [[2, 0.33], [3, 0.2], [4, 0.25], [5, 0.08], [6, 0.08], [8, 0.06]];
const size = () => { let x = rnd(); for (const [s, p] of SIZES) { if ((x -= p) <= 0) return s; } return 2; };
const arrival = () => {
  const x = rnd();
  if (x < 0.22) return at('10:45') + between(0, 150) * MIN; // trưa
  if (x < 0.32) return at('14:00') + between(0, 180) * MIN; // chiều (happy hour)
  if (x < 0.5) return at('19:00') + between(0, 25) * MIN; // đợt dồn 19:00–19:25 (thử cảnh hết bàn)
  // tối: dồn 18:00–20:30, đỉnh khoảng 19:15
  return at('18:00') + ((between(0, 1) + between(0, 1) + between(0, 1)) / 3) * 150 * MIN;
};
let total = 0;
let gid = 0;
const TARGET = Number(process.env.GUESTS || 500);
while (total < TARGET) {
  const sz = Math.min(size(), TARGET - total);
  const g = { id: ++gid, size: sz, w: waiters[gid % waiters.length], arrive: arrival() };
  g.lunch = g.arrive < at('14:00');
  total += sz;
  groups.push(g);
}
// Sự cố rải đều
const dinner = groups.filter((g) => !g.lunch);
const tag = (n, k, fn) => { for (let i = 0; i < n; i++) fn(dinner[(k + i * 17) % dinner.length]); };
tag(3, 3, (g) => { g.incident = 'move'; });
tag(3, 5, (g) => { g.incident = 'split'; });
tag(2, 7, (g) => { g.incident = 'merge'; });
tag(2, 9, (g) => { g.incident = 'itemMove'; });
tag(1, 11, (g) => { g.walkoutEarly = true; });
tag(1, 13, (g) => { g.walkoutLate = true; });
tag(3, 15, (g) => { g.refund = true; });
// Đặt bàn: 10 nhóm đặt trước bàn Khu C, 1 nhóm không đến
const bookers = dinner.filter((g) => !g.incident && !g.walkoutEarly && !g.walkoutLate && g.size <= 5).slice(0, 10);

schedule(at('10:00'), async () => {
  let t = 81;
  for (const g of bookers) {
    const time = hmOf(Math.round(g.arrive / (15 * MIN)) * 15 * MIN);
    const r = await quan('POST', '/api/reservations', { name: `Khách đặt ${g.id}`, phone: `09${String(10000000 + g.id * 7919).slice(0, 8)}`, guests: g.size, date: DAY, time, tables: String(t) });
    if (r.status !== 200) { issue(`Đặt bàn: ${r.data?.error}`); continue; }
    stats.booking++;
    g.reservation = r.data.id;
    g.resTables = [t];
    schedule(at(time) - 20 * MIN, async () => { reservedTables.add(g.resTables[0]); });
    t++;
  }
  // 1 khách đặt không đến
  const r = await quan('POST', '/api/reservations', { name: 'Anh Tuấn', phone: '0909000111', guests: 4, date: DAY, time: '19:00', tables: '95' });
  schedule(at('19:15'), async () => { await quan('PATCH', `/api/reservations/${r.data.id}`, { status: 'no_show' }); stats.noShow++; say('Anh Tuấn đặt 19:00 không đến → đánh dấu bỏ đặt, bàn 95 trả lại'); });
  for (const g of bookers) if (g.reservation) g.w = waiters[(g.id + 3) % waiters.length];
});
for (const g of groups) schedule(g.arrive, () => seat(g));

// 19:30 bếp báo hết Bò ướp mala
schedule(at('19:30'), async () => {
  const id = items.find((i) => i.name === 'Bò ướp mala 100g').id;
  const pend = db.prepare("SELECT i.id FROM order_items i JOIN table_sessions s ON s.id = i.session_id WHERE i.menu_item_id = ? AND i.status = 'sent' AND s.status IN ('open','paying') LIMIT 1").get(id);
  if (pend) {
    const r = await bepLau('POST', `/api/pos/items/${pend.id}/cancel`, { reason: 'Hết nguyên liệu', sold_out: true });
    if (r.status !== 200) issue(`Bếp báo hết món: ${r.data?.error}`);
  } else await bepLau('PATCH', `/api/menu/items/${id}`, { sold_out: true });
  say('Tổ lẩu báo HẾT "Bò ướp mala 100g": huỷ 1 phần đang chờ + khoá món, phục vụ gọi món khác');
});

// Mỗi phút: cầu in lấy phiếu in ra máy giả; mỗi 2 phút quản lý xem món trễ và nhắc bếp
const reminded = new Set();
const bridge = client('Cầu in');
schedule(at('09:45'), async () => { const r = await thuNgan('POST', '/api/payments/drawer', { date: DAY, opening: 3000000 }); if (r.status !== 200) issue(`Két đầu ngày: ${r.data?.error}`); });
async function bridgeTick() {
  const r = await bridge('GET', '/api/print/jobs', null, { token });
  for (const j of r.data?.jobs || []) {
    const t = j.targets[0];
    const ok = await new Promise((res) => { const s = net.connect({ host: t.ip, port: t.port }, () => s.end(Buffer.from(j.data, 'base64'))); s.on('close', () => res(true)); s.on('error', () => res(false)); });
    await bridge('POST', '/api/print/result', { key: j.key, ok }, { token });
  }
}
for (let t = at('10:00'); t <= at('23:59'); t += MIN) {
  schedule(t, async () => {
    await bridgeTick();
    await seatWaiting();
    const open = db.prepare("SELECT COUNT(*) AS n FROM table_sessions WHERE status IN ('open','paying')").get().n;
    stats.peak = Math.max(stats.peak, open);
    if ((t / MIN) % 5 === 0) stats.payAlerts += app.ctx.payTick();
    if ((t / MIN) % 2) return;
    const late = (await quan('GET', '/api/pos/late')).data || [];
    for (const i of late) {
      if (reminded.has(i.id)) continue;
      const r = await quan('POST', `/api/pos/items/${i.id}/remind`);
      if (r.status === 200) { reminded.add(i.id); stats.reminds++; }
    }
  });
}

// Quản lý xem "bàn sắp trống" lúc cao điểm → so với thực tế để biết ước tính đúng tới đâu
const predictions = [];
const etaChecks = [];
for (const hm of ['19:10', '19:30', '19:50', '20:10', '20:30']) {
  schedule(at(hm), async () => {
    const sm = (await quan('GET', '/api/pos/tables')).data.summary;
    for (const x of sm.soon.slice(0, 5)) predictions.push({ at: now, sid: x.session_id, minutes: x.minutes, reason: x.reason });
    if (sm.queue.length || sm.next_eta) etaChecks.push({ at: now, hm, queue: sm.queue.length, next: sm.next_eta, free: sm.free, waiting: sm.waiting });
  });
}

// ---------- Chạy ----------
const t0 = performance.now();
while (queue.length) {
  queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
  const ev = queue.shift();
  now = Math.max(now, ev.t);
  await ev.fn();
}
now = at('23:59');
await bridgeTick();
const runSec = ((performance.now() - t0) / 1000).toFixed(1);

// ---------- Kiểm tra bếp: số lượng trên phiếu khớp số lượng món ----------
const sessions = db.prepare('SELECT * FROM table_sessions').all();
const openLeft = sessions.filter((s) => ['open', 'paying'].includes(s.status));
if (openLeft.length) issue(`${openLeft.length} bàn chưa đóng cuối ngày`);
const ticketQty = {};
const addQ = (st, q) => { ticketQty[st] = (ticketQty[st] || 0) + q; };
for (const k of db.prepare('SELECT k.kind, k.lines, s.name AS st FROM kitchen_tickets k JOIN kitchen_stations s ON s.id = k.station_id').all()) {
  const st = k.st === 'Ưu tiên' ? 'Steak' : k.st;
  for (const l of JSON.parse(k.lines)) {
    if (k.kind === 'new' || k.kind === 'add') addQ(st, l.qty);
    if (k.kind === 'cancel') addQ(st, -l.qty);
    if (/tặng|TẶNG|khuyến mãi/i.test(`${l.name} ${l.note} ${(l.options || []).join(' ')}`)) issue('Phiếu bếp có chữ tặng / khuyến mãi');
  }
}
const itemQty = {};
for (const i of db.prepare("SELECT menu_item_id, qty, refunded_qty, status FROM order_items WHERE status IN ('sent','done','cancelled')").all()) {
  for (const st of partsOf(i.menu_item_id)) {
    const live = i.status === 'cancelled' ? 0 : i.qty;
    itemQty[st] = (itemQty[st] || 0) + live;
  }
}
// Hoàn tiền món chưa ra có phiếu HUỶ riêng → trừ thêm
for (const rf of db.prepare('SELECT lines FROM refunds').all()) for (const l of JSON.parse(rf.lines)) if (l.kitchen === 'cancelled') {
  const mi = db.prepare('SELECT menu_item_id FROM order_items WHERE id = ?').get(l.id).menu_item_id;
  for (const st of partsOf(mi)) itemQty[st] -= l.qty;
}
const kitchenRows = Object.keys(KITCHEN).map((st) => {
  const ok = (ticketQty[st] || 0) === (itemQty[st] || 0);
  if (!ok) issue(`Số lượng phiếu ${st} (${ticketQty[st]}) ≠ số món (${itemQty[st]})`);
  return { st, qty: itemQty[st] || 0, ok };
});
const tk = db.prepare('SELECT s.name, k.kind, COUNT(*) AS n FROM kitchen_tickets k JOIN kitchen_stations s ON s.id = k.station_id GROUP BY s.name, k.kind').all();
const printStatus = db.prepare('SELECT print_status, COUNT(*) AS n FROM kitchen_tickets GROUP BY print_status').all();
const notPrinted = printStatus.filter((x) => x.print_status !== 'printed').reduce((n, x) => n + x.n, 0);
if (notPrinted) issue(`${notPrinted} phiếu bếp chưa in`);

// Thời gian chờ món
const waits = {};
for (const i of db.prepare("SELECT id, menu_item_id, sent_at FROM order_items WHERE status = 'done'").all()) {
  const ready = served.get(i.id);
  if (!ready) continue;
  for (const st of stationsOf(i.menu_item_id)) (waits[st] ||= []).push((ready - i.sent_at) / MIN);
}
const lateLimit = Object.fromEntries(menu0.stations.map((s) => [s.name, s.late_minutes]));

// ---------- Cuối ngày: thu ngân ----------
now = at('23:40');
let day = (await thuNgan('GET', `/api/payments?date=${DAY}`)).data;
const before = { ...day.summary, anomalies: day.anomalies.length };
const bankTotal = bankLog.reduce((n, a) => n + a, 0);
if (day.summary.bank_in !== bankTotal) issue(`App ghi tiền ngân hàng ${day.summary.bank_in} ≠ tổng SePay báo ${bankTotal}`);
// Bill "chờ tiền về" mà sao kê không có → chưa thấy tiền; còn lại (ngân hàng đã báo) → xác nhận
const ghostBills = day.bills.filter((b) => b.reconcile_status === 'pending');
await thuNgan('POST', '/api/payments/reconcile', { ids: ghostBills.map((b) => b.id), status: 'missing', note: 'Không có trong sao kê' });
const okIds = day.bills.filter((b) => b.reconcile_status === 'matched').map((b) => b.id);
await thuNgan('POST', '/api/payments/reconcile', { ids: okIds, status: 'confirmed' });
day = (await thuNgan('GET', `/api/payments?date=${DAY}`)).data;
// Đếm két: thu ngân đếm thấy đúng số phải có
await thuNgan('POST', '/api/payments/drawer', { date: DAY, counted: day.summary.drawer_expected });
const close = await thuNgan('POST', '/api/payments/close-day', { date: DAY });
if (close.status !== 200) issue(`Chốt ngày: ${close.data?.error}`);
day = (await thuNgan('GET', `/api/payments?date=${DAY}`)).data;
const sm = day.summary;
const appCK = sm.transfer_in;
const diff = sm.transfer_missing;
const found = day.bills.filter((b) => b.reconcile_status === 'missing');
// Kiểm tra lại tổng tiền độc lập
const sumPaid = db.prepare("SELECT SUM(paid_total) AS n FROM table_sessions WHERE status = 'closed'").get().n;
if (sumPaid !== sm.gross) issue('Tổng bill không khớp');
if (sm.cash_in + sm.transfer_in !== sm.gross) issue('Tiền mặt + CK ≠ tổng bill');
const promoBreak = {};
for (const s of db.prepare("SELECT bill_snapshot FROM table_sessions WHERE status = 'closed'").all()) {
  const snap = JSON.parse(s.bill_snapshot);
  for (const [, ps] of snap.lines) for (const p of ps) promoBreak[p.name] = (promoBreak[p.name] || 0) + p.amount;
  for (const p of snap.bill) promoBreak[p.name] = (promoBreak[p.name] || 0) + p.amount;
}

// Sai số ước tính bàn sắp trống
const errs = [];
for (const p of predictions) {
  const s = db.prepare('SELECT closed_at, status FROM table_sessions WHERE id = ?').get(p.sid);
  if (s?.closed_at) errs.push(Math.abs((s.closed_at - p.at) / MIN - p.minutes));
}
const avgErr = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0;
const within10 = errs.filter((e) => e <= 10).length;

// Độ trễ máy chủ
const byUrl = {};
for (const l of lat) (byUrl[l.url] ||= []).push(l.ms);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const allMs = lat.map((l) => l.ms);

// ---------- Báo cáo ----------
const out = [];
const P = (s = '') => out.push(s);
P(`# Giả lập 1 ngày bán hàng · Thứ Bảy ${DAY.slice(8)}/${DAY.slice(5, 7)}`);
P();
P(`Kết quả: ${issues.length ? `**${issues.length} lỗi**` : '**không lỗi**'} · chạy ${runSec} giây, ${lat.length} lần gọi app`);
P();
P('## Khách & bàn');
P(`- ${stats.guests} khách, ${stats.groups} lượt bàn, cao điểm ${stats.peak}/100 bàn cùng lúc`);
P(`- Hết bàn phải chờ: ${stats.waitlist} nhóm, chờ lâu nhất ${stats.waitMax} phút`);
P(`- Ước tính "bàn sắp trống": ${errs.length} lần dự đoán, lệch trung bình ${avgErr.toFixed(0)} phút, ${within10}/${errs.length} lần lệch ≤ 10 phút`);
for (const c of etaChecks) P(`  - ${c.hm}: ${c.free} bàn trống, ${c.waiting} nhóm chờ → app báo khách mới chờ ${c.next == null ? '?' : c.next === 0 ? '0' : `~${c.next}`} phút`);
P(`- Đặt bàn: ${stats.booking} nhóm đến đúng hẹn (${stats.resMoved || 0} nhóm bàn giữ còn khách cũ → app gợi ý bàn khác), ${stats.noShow} nhóm không đến`);
P(`- Sự cố: ${stats.moves} chuyển bàn, ${stats.splits} tách bàn, ${stats.merges} gộp bàn, ${stats.itemMoves} chuyển món gọi nhầm bàn, ${stats.walkout} nhận bàn rồi về, ${stats.tableCancels} bỏ về sau khi gửi món`);
P();
P('## Bếp & bar (số lượng trên phiếu so với số món)');
P('| Điểm | Phần (dòng phiếu) | Phiếu (mới / thêm / huỷ / làm lại / nhắc) | Chờ TB | Chờ lâu nhất | Ngưỡng trễ | Khớp |');
P('|---|---|---|---|---|---|---|');
for (const r of kitchenRows) {
  const k = (kind) => tk.filter((x) => (x.name === r.st || (r.st === 'Steak' && x.name === 'Ưu tiên')) && x.kind === kind).reduce((n, x) => n + x.n, 0);
  const w = waits[r.st] || [0];
  P(`| ${r.st} | ${r.qty} | ${k('new')} / ${k('add')} / ${k('cancel')} / ${k('redo')} / ${k('remind')} | ${(w.reduce((a, b) => a + b, 0) / w.length).toFixed(1)}′ | ${Math.max(...w).toFixed(0)}′ | ${lateLimit[r.st]}′ | ${r.ok ? '✓' : '✗'} |`);
}
P(`- Phiếu in: ${printStatus.map((x) => `${x.print_status} ${x.n}`).join(', ')}; máy in giả nhận: ${Object.values(printers).map((p) => `${p.name} ${p.jobs}`).join(', ')} (Ưu tiên chưa có IP → in sang Steak)`);
P(`- Món trễ được nhắc bếp: ${stats.reminds} · làm lại: ${stats.redo} · huỷ gọi nhầm: ${stats.cancelItem} · hết món "Bò ướp mala" chặn ${stats.soldOutBlocked} lần gọi`);
P(`- Tính tiền khi còn món chưa bấm "Đã ra" (app hỏi lại): ${stats.unservedConfirm} bàn`);
P();
P('## Thu ngân & cuối ngày');
P(`- ${sm.bills} bill: CK ${stats.pay.transfer}, tiền mặt ${stats.pay.cash}, TM + CK ${stats.pay.mixed}`);
P(`- Tổng bill ${f(sm.gross)}đ · khuyến mãi đã giảm ${f(sm.discount)}đ (${Object.entries(promoBreak).map(([k, v]) => `${k}: ${f(v)}đ`).join('; ')})`);
P(`- Hoàn tiền mặt: ${stats.refunds} lần, ${f(stats.refundAmount)}đ (quản lý duyệt PIN, chủ quán nhận báo)`);
P(`- CK: ${stats.ck.auto} bill tiền về là **tự đóng**, ${stats.ck.delayed} ngân hàng chậm (bấm chờ, tiền về tự khớp), ${stats.ck.partial} khách CK thiếu rồi bù, ${stats.ck.manual} khách tự gõ số TK (tiền "chưa khớp" → thu ngân ghép bill), ${stats.ck.ghost} bill "khách đã CK" mà tiền không về (app báo quản lý ${stats.payAlerts} lần)`);
P(`- Tiền mặt: ${stats.handovers} lần phục vụ giao thu ngân ngay sau bill · lệch ${f(sm.handover_diff)}đ`);
P(`- **Két: đầu ngày ${f(sm.opening)}đ + nhận từ phục vụ ${f(sm.handed_in)}đ − hoàn ${f(sm.refund_cash)}đ = phải có ${f(sm.drawer_expected)}đ** · đếm ${f(sm.drawer_counted)}đ`);
P(`- **Tip quỹ chung: ${f(sm.tip_cash + sm.tip_transfer)}đ** (tiền mặt ${f(sm.tip_cash)}đ, CK dư ${f(sm.tip_transfer)}đ) · không tính vào doanh thu`);
P(`- Ngân hàng báo tiền vào ${f(bankTotal)}đ = app ghi ${f(sm.bank_in)}đ ${sm.bank_in === bankTotal ? '✓' : '✗'} · CK theo bill ${f(appCK)}đ, chưa thấy tiền ${f(diff)}đ (${found.map((b) => `${b.transfer_note} bàn ${b.header}, ${b.closed_by_name} đóng`).join(', ') || 'không'})`);
P(`- Chốt doanh thu: ${close.status === 200 ? `✓ ${f(sm.net)}đ` : `✗ ${close.data?.error}`}`);
P(`- Bất thường gửi chủ quán (${day.anomalies.length}):`);
for (const a of day.anomalies) P(`  - ${a.text}`);
P();
P('## Tốc độ app');
P(`- Trung bình ${pct(allMs, 0.5).toFixed(1)} ms, 95% dưới ${pct(allMs, 0.95).toFixed(1)} ms, chậm nhất ${Math.max(...allMs).toFixed(0)} ms`);
for (const u of ['POST /api/pos/sessions/:id/send', 'POST /api/pos/sessions/:id/pay', 'GET /api/pos/tables', 'GET /api/print/jobs']) if (byUrl[u]) P(`- ${u}: TB ${pct(byUrl[u], 0.5).toFixed(1)} ms, 95% ${pct(byUrl[u], 0.95).toFixed(1)} ms`);
P();
P('## Nhật ký sự cố');
for (const l of log) P(`- ${l}`);
if (issues.length) { P(); P('## Lỗi'); for (const i of issues) P(`- ${i}`); }

const report = out.join('\n');
console.log(report);
const outFile = process.argv[2];
if (outFile) fs.writeFileSync(outFile, report);
for (const p of Object.values(printers)) p.close();
app.close();
server.close();
process.exit(issues.length ? 1 : 0);
