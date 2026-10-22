#!/usr/bin/env node
// Giả lập tối thứ Bảy KÍN BÀN (17:30–22:30, 100 bàn 4 chỗ, nhóm 5+ người ghép bàn liền nhau).
// Chạy cùng 1 dòng khách cho 2 cách làm rồi so sánh:
//   CŨ  : danh sách chờ ghi giấy, tiếp thực 5′ mới nhìn sơ đồ 1 lần, mời theo thứ tự (nhóm đầu chưa có bàn thì cả hàng chờ),
//         bàn tính tiền xong 3–10′ mới có người để ý dọn.
//   MỚI : app báo "Dọn ngay bàn X" khi có khách chờ (dọn 1,5–4′), tự mời nhóm VỪA CHỖ mỗi phút (nhóm nhỏ không chờ nhóm đông),
//         nhắn Zalo khách "đã có bàn", giữ dồn bàn liền nhau cho nhóm đông chờ ≥ 15′; bàn xin tính tiền → báo dọn chuẩn bị
//         và báo nhóm chờ vừa chỗ ra cửa.
// Khách chờ quá sức chịu (20–60′) thì bỏ về. Chạy: node --disable-warning=ExperimentalWarning scripts/simulate-peak.js
// Biến môi trường: GUESTS (mặc định 900), SEED.
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
const at = (hm) => clock.toEpoch(DAY, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
const MIN = 60_000;
const hmOf = (ms) => clock.fmt(ms).slice(0, 5);
const f = (n) => Number(n).toLocaleString('vi-VN');
const TARGET = Number(process.env.GUESTS || 900);
const AVG_CHECK = 280_000; // tiền trung bình 1 khách (ước)

function rng(seed) {
  let s = seed;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return { r, between: (a, b) => a + r() * (b - a), chance: (p) => r() < p, pick: (a) => a[Math.floor(r() * a.length)] };
}

// Dòng khách cố định (giống nhau cho 2 cách)
function makeGuests(seed) {
  const R = rng(seed);
  const SIZES = [[2, 0.33], [3, 0.2], [4, 0.25], [5, 0.08], [6, 0.08], [8, 0.06]];
  const size = () => { let x = R.r(); for (const [s, p] of SIZES) { if ((x -= p) <= 0) return s; } return 2; };
  const out = [];
  let total = 0;
  while (total < TARGET) {
    const sz = Math.min(size(), TARGET - total);
    // Dồn 18:00–20:30, đỉnh ~19:15; 15% đến muộn 20:30–21:30
    const arrive = R.chance(0.85) ? at('17:45') + ((R.r() + R.r() + R.r()) / 3) * 165 * MIN : at('20:30') + R.r() * 60 * MIN;
    out.push({ id: out.length + 1, size: sz, arrive, dwell: R.between(60, 100) * MIN, patience: R.between(20, 60) * MIN, phone: R.chance(0.7) ? `09${String(10000000 + out.length).slice(-8)}` : '', wander: R.chance(0.1), late: R.between(1, 3) * MIN });
    total += sz;
  }
  return out.sort((a, b) => a.arrive - b.arrive);
}

async function run(mode, guests, seed) {
  const R = rng(seed + 7);
  let now = at('17:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pk-')), zaloTransport: { send: async () => {} } });
  const zalo = { queue: 0, ready: 0 };
  app.ctx.customerNotify = async (x, kind) => { zalo[kind] = (zalo[kind] || 0) + 1; return { ok: true }; };
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const api = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (res.status >= 500) throw new Error(`${method} ${url}: ${data?.error}`);
    return { status: res.status, data };
  };
  await api('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const item = (await api('GET', '/api/menu')).data.items.find((i) => !i.options.length && i.price > 0);
  const info = new Map(db.prepare('SELECT number, seats, zone_id FROM dining_tables').all().map((t) => [t.number, t]));

  const events = [];
  let seq = 0;
  const at_ = (t, fn) => events.push({ t, fn, s: seq++ });
  const st = { served: 0, servedGuests: 0, lost: 0, lostGuests: 0, waits: [], idle: [], peakBusy: 0, calls: 0, wanderGone: 0 };
  const byRes = new Map();
  const queue = []; // cách cũ: danh sách giấy theo thứ tự

  const tables = async () => (await api('GET', '/api/pos/tables')).data;
  const freeClean = (d) => d.zones.flatMap((z) => z.tables).filter((t) => !t.session && t.dirty == null).map((t) => t.number);
  // Cách cũ: lấy bàn trống bất kỳ, nhóm 5+ ghép 2 bàn liền nhau
  const pickOld = (free, size) => {
    if (size <= 4) return free.length ? [R.pick(free)] : null;
    const need = Math.ceil(size / 4);
    for (const a of free) { const run = Array.from({ length: need }, (_, k) => a + k); if (run.every((n) => free.includes(n) && info.get(n)?.zone_id === info.get(a).zone_id)) return run; }
    return null;
  };
  const lastClose = new Map();

  async function open(g, tbls, resId) {
    const r = resId ? await api('POST', `/api/reservations/${resId}/arrive`, { tables: tbls.join(', ') })
      : await api('POST', '/api/pos/sessions', { tables: tbls, guests: g.size, override_soon: true, override_size: true });
    if (r.status !== 200) return false;
    const sid = r.data.session_id || r.data.id;
    for (const n of tbls) if (lastClose.has(n) && now >= at('18:30') && now <= at('21:30')) st.idle.push((now - lastClose.get(n)) / MIN);
    g.sid = sid;
    g.tables = tbls;
    st.served++;
    st.servedGuests += g.size;
    if (g.waitFrom) st.waits.push((now - g.waitFrom) / MIN);
    await api('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item.id, qty: g.size });
    await api('POST', `/api/pos/sessions/${sid}/send`);
    at_(now + g.dwell - 6 * MIN, () => api('POST', `/api/pos/sessions/${sid}/request-bill`));
    at_(now + g.dwell, async () => {
      await api('POST', `/api/pos/sessions/${sid}/pay`, { method: 'transfer', confirm_unserved: true });
      for (const n of tbls) lastClose.set(n, now);
      // Dọn bàn: cách mới có khách chờ thì app báo dọn ngay
      const waiting = mode === 'moi' ? db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE kind = 'walkin' AND status = 'waiting'").get().n : queue.length;
      const d = mode === 'moi' && waiting ? R.between(1, 2.5) : R.between(3, 10) + 2; // cách mới: người dọn đã được báo từ lúc khách xin tính tiền
      at_(now + d * MIN, () => Promise.all(tbls.map((n) => api('POST', `/api/pos/tables/${n}/clean`))));
    });
    return true;
  }

  async function arrive(g) {
    const d = await tables();
    const free = freeClean(d);
    const hasQueue = mode === 'moi' ? d.summary.waiting > 0 : queue.length > 0;
    if (!hasQueue) {
      let t = null;
      if (mode === 'moi') {
        // App gợi ý bàn vừa chỗ: 1 bàn nếu ≤ 4 người, không thì bàn liền nhau
        const need = Math.ceil(g.size / 4);
        t = need === 1 ? (free.length ? [free[0]] : null) : pickOld(free.sort((a, b) => a - b), g.size);
      } else t = pickOld(free, g.size);
      if (t && await open(g, t)) return;
    }
    // Hết bàn → vào danh sách chờ
    g.waitFrom = now;
    const r = await api('POST', '/api/reservations', { kind: 'walkin', name: `Khách ${g.id}`, phone: g.phone, guests: g.size, date: DAY });
    g.res = r.data.id;
    byRes.set(g.res, g);
    queue.push(g);
    at_(now + g.patience, async () => {
      if (g.sid || g.gone) return;
      g.gone = true;
      st.lost++;
      st.lostGuests += g.size;
      queue.splice(queue.indexOf(g), 1);
      await api('POST', `/api/waitlist/${g.res}/gone`);
    });
  }

  // Cách cũ: 5′ tiếp thực nhìn sơ đồ 1 lần, mời theo thứ tự
  const pending = new Set(); // bàn đã mời, khách đang đi vào
  async function hostOld() {
    let free = freeClean(await tables()).filter((n) => !pending.has(n));
    for (;;) {
      const g = queue[0];
      if (!g) return;
      const t = pickOld(free, g.size);
      if (!t) return; // nhóm đầu chưa có bàn → cả hàng chờ
      queue.shift();
      t.forEach((n) => pending.add(n));
      free = free.filter((n) => !t.includes(n));
      at_(now + g.late, async () => { t.forEach((n) => pending.delete(n)); if (!g.gone && !(await open(g, t, g.res))) queue.unshift(g); });
    }
  }
  // Cách mới: app tự mời mỗi phút; khách đi vào trong 1–3′ (10% đi lòng vòng, 6–9′ mới quay lại)
  const seen = new Map();
  async function tickNew() {
    await app.ctx.waitTick();
    // Mọi lời mời mới (từ lượt kiểm tra mỗi phút hoặc lúc nhân viên bấm "Đã dọn")
    const called = db.prepare("SELECT id, called_table, called_at FROM reservations WHERE kind = 'walkin' AND status = 'waiting' AND called_at IS NOT NULL").all().filter((x) => seen.get(x.id) !== x.called_at);
    for (const c of called) seen.set(c.id, c.called_at);
    for (const c of called) {
      const g = byRes.get(c.id);
      if (!g || g.gone) continue;
      st.calls++;
      // Đã được báo ra cửa chờ (bàn đang tính tiền) thì vào gần như ngay
      const ready = db.prepare('SELECT prep_table FROM reservations WHERE id = ?').get(g.res)?.prep_table;
      const delay = g.wander && !g.wandered && !ready ? R.between(6, 9) * MIN : ready ? R.between(0.3, 1) * MIN : g.late;
      g.wandered = true;
      const go = async () => {
        if (g.gone || g.sid) return;
        const s = (await tables()).summary.queue.find((x) => x.id === g.res);
        // Khách tới: vào bàn đang mời (đã dọn) hoặc bàn app đang gợi ý
        if (s?.suggest_dirty?.length && !s.protect) { at_(now + MIN, go); return; } // đứng chờ dọn xong
        const tbl = (s?.suggest && !s.protect ? s.suggest : null) || null;
        if (tbl && await open(g, tbl, g.res)) { queue.splice(queue.indexOf(g), 1); return; }
        if (!s) return;
        // Bàn đã nhường cho nhóm khác: chờ app mời lại
      };
      at_(now + delay, go);
    }
    // Bàn đang dọn mà khách đã tới: dọn xong là mời vào ngay (ở tick sau)
  }

  for (const g of guests) at_(g.arrive, () => arrive(g));
  for (let t = at('17:30'); t <= at('23:30'); t += MIN) {
    const m = Math.round((t - at('17:30')) / MIN);
    if (mode === 'moi') at_(t, tickNew);
    else if (m % 5 === 0) at_(t, hostOld);
    if (m % 10 === 0) at_(t, async () => { const d = await tables(); st.peakBusy = Math.max(st.peakBusy, d.summary.busy); if (mode === 'moi') st.maxQueue = Math.max(st.maxQueue || 0, d.summary.waiting); else st.maxQueue = Math.max(st.maxQueue || 0, queue.length); });
  }
  while (events.length) {
    events.sort((a, b) => a.t - b.t || a.s - b.s);
    const ev = events.shift();
    if (ev.t > at('23:59')) break;
    now = Math.max(now, ev.t);
    await ev.fn();
  }
  // Khách đang chờ khi đóng cửa = mất
  for (const g of queue) if (!g.sid && !g.gone) { st.lost++; st.lostGuests += g.size; }
  st.zalo = zalo;
  app.close();
  server.close();
  return st;
}

const seed = Number(process.env.SEED || 24102026);
const guests = makeGuests(seed);
const t0 = Date.now();
const clone = () => guests.map((g) => ({ ...g }));
const A = await run('cu', clone(), seed);
const B = await run('moi', clone(), seed);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const p90 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.9)] : 0; };
const P = (s) => console.log(s);
const row = (label, a, b, unit = '', better = 'low') => {
  const d = b - a;
  const good = better === 'low' ? d < 0 : d > 0;
  P(`| ${label} | ${typeof a === 'number' ? f(Math.round(a * 10) / 10) : a}${unit} | ${typeof b === 'number' ? f(Math.round(b * 10) / 10) : b}${unit} | ${d === 0 ? '=' : `${good ? '✅' : '⚠️'} ${d > 0 ? '+' : ''}${f(Math.round(d * 10) / 10)}${unit}`} |`);
};
P(`# Giả lập tối thứ Bảy kín bàn · ${guests.length} nhóm, ${guests.reduce((s, g) => s + g.size, 0)} khách đến 17:45–21:30 · 100 bàn 4 chỗ`);
P('');
P('| | Cách cũ (giấy) | Cách mới (app) | Chênh |');
P('|---|---|---|---|');
row('Nhóm được phục vụ', A.served, B.served, '', 'high');
row('Khách được phục vụ', A.servedGuests, B.servedGuests, '', 'high');
row('Nhóm bỏ về (chờ lâu)', A.lost, B.lost);
row('Khách bỏ về', A.lostGuests, B.lostGuests);
row('Chờ trung bình', avg(A.waits), avg(B.waits), '′');
row('Chờ lâu (90% nhóm dưới)', p90(A.waits), p90(B.waits), '′');
row('Chờ lâu nhất', Math.max(0, ...A.waits), Math.max(0, ...B.waits), '′');
row('Bàn trống chờ khách mới (18:30–21:30)', avg(A.idle), avg(B.idle), '′');
row('Hàng chờ dài nhất', A.maxQueue, B.maxQueue, ' nhóm');
P('');
P(`- Doanh thu giữ được thêm ≈ **${f((B.servedGuests - A.servedGuests) * AVG_CHECK)}đ** (${B.servedGuests - A.servedGuests} khách × ${f(AVG_CHECK)}đ trung bình).`);
P(`- Cách mới: app mời ${B.calls} lượt, Zalo báo số thứ tự ${B.zalo.queue || 0} tin, báo có bàn ${B.zalo.ready || 0} tin (≈ ${f(((B.zalo.queue || 0) + (B.zalo.ready || 0)) * 300)}đ phí ZNS).`);
P(`- Chạy ${((Date.now() - t0) / 1000).toFixed(1)} giây.`);
