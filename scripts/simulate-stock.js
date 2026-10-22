#!/usr/bin/env node
// Giả lập 2 ngày chuỗi kho: NCC giao hàng → khu nhận + chụp bill → thu ngân duyệt → bán món tự trừ kho theo định lượng
// → sắp hết (báo) → hết (app tự khoá món, phục vụ gọi bị chặn) → kiểm kho cuối ca (lệch định lượng) → 22:00 tổng hợp hàng cần nhập
// gửi Zalo OA → sáng duyệt đơn → NCC giao → nhận hàng → app tự mở lại món → thu ngân duyệt → trả NCC.
// Định lượng dùng số MẪU (chờ bảng định lượng thật). Chạy: node --disable-warning=ExperimentalWarning scripts/simulate-stock.js
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
const D1 = '2026-10-23';
const D2 = '2026-10-24';
const at = (d, hm) => clock.toEpoch(d, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
const MIN = 60_000;
let seed = 2310;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const f = (n) => Math.round(n).toLocaleString('vi-VN');
const hmOf = (ms) => clock.fmt(ms).slice(0, 5);
const IMG = `data:image/jpeg;base64,${Buffer.alloc(4000, 7).toString('base64')}`;

let now = at(D1, '07:00');
const db = openDb(':memory:', { now });
const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sk-')), zaloTransport: { send: async () => {} } });
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
const login = async (label, pin, np) => { const c = client(label); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
const ok = (r, what) => { if (r.status !== 200) issues.push(`${what}: ${r.status} ${r.data?.error}`); return r.data; };

// ---------- Dựng quán ----------
const o = await login('Chủ quán', DEFAULT_OWNER_PIN, '582914');
const teams = (await o('GET', '/api/teams')).data;
const tid = (n) => teams.find((x) => x.name === n).id;
let pinN = 736200;
const hire = async (name, role, team) => { const pin = String(++pinN); const r = await o('POST', '/api/staff', { name, role, team_id: tid(team), pin }); const c = await login(name, pin, String(pinN + 100000)); c.id = r.data.id; return c; };
const quan = await hire('Quân (QL)', 'manager', 'Phục vụ');
const phat = await hire('Phát (bếp)', 'team_lead', 'Bếp steak');
const tai = await hire('Tài (lẩu)', 'team_lead', 'Lẩu');
const mai = await hire('Mai (bar)', 'team_lead', 'Bar');
const ngan = await hire('Ngân (TN)', 'staff', 'Thu ngân');
const hau = await hire('Hậu (PV)', 'staff', 'Phục vụ');
await o('PUT', '/api/settings', { kho_tong_staff_id: quan.id });
const meta = (await o('GET', '/api/stock/meta')).data;
const S = Object.fromEntries(meta.stores.map((s) => [s.name, s.id]));
const sup = async (name) => (await o('POST', '/api/stock/suppliers', { name })).data.id;
const nThit = await sup('Sạp thịt Kim Thanh Ngọc');
const nRau = await sup('Vựa rau Bé Thùy');
const nBia = await sup('Đại lý bia Hưng Thịnh');
await o('PATCH', `/api/stock/stores/${S['Kho Bếp steak']}`, { supplier_id: nThit });
await o('PATCH', `/api/stock/stores/${S['Kho Lẩu']}`, { supplier_id: nThit });
await o('PATCH', `/api/stock/stores/${S['Kho Bar']}`, { supplier_id: nBia });
const ing = async (name, store, unit, pu, factor, price, min, extra = {}) => (await o('POST', '/api/stock/ingredients', { name, unit, home_store_id: S[store], purchase_unit: pu, purchase_factor: factor, price, min_stock: min, freshness: 'fresh', shelf_days: 3, lead_days: 1, order_step: 1, ...extra })).data.id;
const I = {
  than: await ing('Thăn bò steak', 'Kho Bếp steak', 'g', 'kg', 1000, 420000, 4000),
  khoai: await ing('Khoai tây', 'Kho Bếp steak', 'g', 'kg', 1000, 30000, 3000),
  bap: await ing('Bắp bò', 'Kho Lẩu', 'g', 'kg', 1000, 260000, 4000),
  rau: await ing('Rau tổng hợp', 'Kho Lẩu', 'g', 'kg', 1000, 25000, 4000),
  cot: await ing('Cốt lẩu', 'Kho Lẩu', 'phần', 'phần', 1, 30000, 20),
  bia: await ing('Heineken lùn', 'Kho Bar', 'lon', 'thùng', 24, 420000, 48, { freshness: 'dry', shelf_days: 0 }),
  dao: await ing('Đào ngâm', 'Kho Bar', 'g', 'hộp', 820, 65000, 1000),
};
// Định lượng MẪU
const menu = (await o('GET', '/api/menu')).data;
const M = (n) => menu.items.find((x) => x.name === n);
const recipe = async (name, lines) => ok(await o('PATCH', `/api/menu/items/${M(name).id}`, { recipe: lines.map(([i, q]) => ({ ingredient_id: I[i], qty: q })) }), `Định lượng ${name}`);
for (const n of ['Steak Âu', 'Combo 1', 'Combo 2', 'Combo 3']) await recipe(n, [['than', 180], ['khoai', 120]]);
for (const n of ['Set 1 Thảo mộc Triều Châu', 'Set 2 Mala Tứ Xuyên', 'Set 3 Cà chua Quý Châu']) await recipe(n, [['bap', 200], ['rau', 300], ['cot', 1]]);
await recipe('Bắp hoa tươi 100g', [['bap', 100]]);
await recipe('Rau tổng hợp', [['rau', 200]]);
await recipe('Heineken lùn', [['bia', 1]]);
await recipe('Trà đào', [['dao', 60]]);

const stock = (i) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(I[i]).q;
const kg = (g) => `${(g / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}kg`;

// ---------- Ngày 1 sáng: NCC giao hàng, khu nhận + chụp bill, thu ngân duyệt ----------
const stats = { orders: 0, items: 0, blocked: 0, overConfirm: 0, overAlt: 0, swapped: 0, revenue: 0, soldOutAt: {}, backAt: {}, lowAt: {} };
const receive = async (who, body, label) => {
  const r = await who('POST', '/api/purchases', { photos: [IMG], ...body });
  if (r.status !== 200) { issues.push(`Nhận hàng ${label}: ${r.data?.error}`); return null; }
  say(`${label}: khu nhận ${f(r.data.total)}đ, ký "${r.data.signer_name}"${r.data.flags.length ? ` · app đánh dấu: ${r.data.flags.join('; ')}` : ''}`);
  return r.data;
};
now = at(D1, '08:30');
const b1 = await receive(phat, { store_id: S['Kho Bếp steak'], supplier_id: nThit, signer_name: 'Phát', total: 2_520_000 + 300_000, lines: [{ ingredient_id: I.than, qty: 6, price: 420000 }, { ingredient_id: I.khoai, qty: 10, price: 30000 }] }, 'Sạp thịt → Bếp steak (thăn 6kg, khoai 10kg)');
const b2 = await receive(tai, { store_id: S['Kho Lẩu'], supplier_id: nThit, signer_name: 'Tài', total: 3_640_000 + 900_000, lines: [{ ingredient_id: I.bap, qty: 14, price: 260000 }, { ingredient_id: I.cot, qty: 30, price: 30000 }] }, 'Sạp thịt → Lẩu (bắp 14kg, cốt 30 phần)');
const b3 = await receive(tai, { store_id: S['Kho Lẩu'], supplier_id: nRau, signer_name: 'Tài', total: 350_000, lines: [{ ingredient_id: I.rau, qty: 12, price: 29000 }] }, 'Vựa rau → Lẩu (rau 12kg, giá 29k vs 25k lần trước)');
const b4 = await receive(mai, { store_id: S['Kho Bar'], supplier_id: nBia, signer_name: 'Mai', total: 840_000 + 130_000, lines: [{ ingredient_id: I.bia, qty: 2, price: 420000 }, { ingredient_id: I.dao, qty: 2, price: 65000 }] }, 'Đại lý bia → Bar (2 thùng Heineken, 2 hộp đào)');
now = at(D1, '09:30');
for (const b of [b1, b2, b3, b4].filter(Boolean)) {
  const r = await ngan('POST', `/api/purchases/${b.id}/approve`);
  ok(r, `Duyệt bill ${b.id}`);
}
const selfApprove = await phat('POST', `/api/purchases/${b1.id}/approve`);
say(`Thu ngân Ngân so ảnh bill, duyệt 4 bill → công nợ NCC tăng. (Phát thử tự duyệt bill mình nhận: ${selfApprove.status === 403 ? 'bị chặn' : 'LỌT'})`);
const startStock = Object.fromEntries(Object.keys(I).map((k) => [k, stock(k)]));

// ---------- Bán hàng ----------
const DISH = {
  steak: ['Steak Âu', 'Combo 1', 'Combo 2', 'Combo 3'], lau: ['Set 1 Thảo mộc Triều Châu', 'Set 2 Mala Tứ Xuyên', 'Set 3 Cà chua Quý Châu'],
  side: ['Bắp hoa tươi 100g', 'Rau tổng hợp'], drink: ['Heineken lùn', 'Trà đào', 'Coca', 'Trà vải'],
};
const fresh = async () => (await hau('GET', '/api/menu')).data;
async function orderTable(table, guests) {
  const s = (await hau('POST', '/api/pos/sessions', { tables: [table], guests, override_soon: true, override_reserved: true })).data?.id;
  if (!s) return;
  const want = [];
  const steaks = Math.round(guests * (0.3 + rnd() * 0.5));
  for (let k = 0; k < steaks; k++) want.push(['steak', 1]);
  if (guests - steaks >= 2) { want.push(['lau', 1]); if (rnd() < 0.6) want.push(['side', 1]); }
  for (let k = 0; k < guests; k++) want.push(['drink', 1]);
  for (const [kind, qty] of want) {
    let name = pick(DISH[kind]);
    for (let tries = 0; tries < 4; tries++) {
      const opt = M(name).options.length ? [M(name).options[0].id] : [];
      const r = await hau('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M(name).id, qty, option_ids: opt });
      if (r.status === 200) { stats.items += qty; break; }
      if (r.status === 400 && /đã hết/.test(r.data?.error || '')) { stats.blocked++; name = kind === 'steak' ? pick([...DISH.lau, 'Bắp hoa tươi 100g']) : pick(DISH[kind]); stats.swapped++; continue; }
      if (r.status === 409 && /kho chỉ còn/.test(r.data?.error || '')) {
        // Phục vụ hỏi bếp: 1/3 bếp còn hàng thực tế (sổ lệch) → xác nhận; còn lại khách đổi món
        if (rnd() < 0.33) { const r2 = await hau('POST', `/api/pos/sessions/${s}/items`, { menu_item_id: M(name).id, qty, option_ids: opt, override_stock: true }); if (r2.status === 200) { stats.overConfirm++; stats.items += qty; break; } }
        stats.overAlt++; name = pick(kind === 'steak' ? DISH.lau : DISH[kind]); continue;
      }
      issues.push(`Gọi ${name}: ${r.status} ${r.data?.error}`); break;
    }
  }
  const send = await hau('POST', `/api/pos/sessions/${s}/send`);
  if (send.status !== 200) return;
  stats.orders++;
  // Ghi lại lúc app báo sắp hết / tự khoá
  const m = await fresh();
  for (const n of [...DISH.steak, ...DISH.lau, ...DISH.side, 'Heineken lùn', 'Trà đào']) {
    const it = m.items.find((x) => x.name === n);
    if (it.left != null && it.left <= 5 && !stats.lowAt[n] && !it.sold_out) { stats.lowAt[n] = hmOf(now); }
    if (it.sold_out && !stats.soldOutAt[n]) { stats.soldOutAt[n] = hmOf(now); say(`APP TỰ KHOÁ "${n}" (hết nguyên liệu theo định lượng)`); }
  }
  // Tính tiền ngay (đủ cho giả lập kho)
  const bill = (await hau('GET', `/api/pos/sessions/${s}/bill`)).data;
  await ngan('POST', `/api/pos/sessions/${s}/pay`, { method: 'transfer', confirm_unserved: true });
  stats.revenue += bill?.total || 0;
}
async function service(date, from, to, tables) {
  const t0 = at(date, from);
  const span = at(date, to) - t0;
  for (let k = 0; k < tables; k++) {
    now = t0 + Math.round((k / tables) * span);
    await orderTable(1 + (k % 100), 2 + Math.floor(rnd() * 4));
  }
}
await service(D1, '11:00', '13:30', 18);
say(`Hết ca trưa: thăn bò còn ${kg(stock('than'))}, bắp bò ${kg(stock('bap'))}, bia ${stock('bia')} lon`);
await service(D1, '17:30', '21:30', 46);

// Bếp lẩu thái tay dư tay: kiểm kho cuối ca thấy bắp bò thiếu 450g so với số đã bán
now = at(D1, '21:45');
const bookBap = (await tai('GET', `/api/stock/count-sheet?store_id=${S['Kho Lẩu']}`)).data;
const exp = stock('bap');
const cnt = await tai('POST', '/api/stock/count', { store_id: S['Kho Lẩu'], lines: [{ ingredient_id: I.bap, actual: Math.max(0, exp - 450) }, { ingredient_id: I.rau, actual: stock('rau') }, { ingredient_id: I.cot, actual: stock('cot') }] });
ok(cnt, 'Kiểm kho Lẩu');
const lech = db.prepare("SELECT qty, note FROM stock_moves WHERE ref = ? AND ingredient_id = ?").get(`count:${cnt.data?.count_id}`, I.bap);
say(`Kiểm kho Lẩu cuối ca: bắp bò sổ ${kg(exp)}, thực tế ${kg(Math.max(0, exp - 450))} → ghi "${lech?.note}" ${kg(lech?.qty || 0)}`);

// ---------- 22:00 tổng hợp hàng cần nhập ----------
now = at(D1, '22:00');
const rep = app.ctx.purchaseReportTick();
const repNote = db.prepare('SELECT title, body FROM notifications WHERE staff_id = ? ORDER BY id DESC LIMIT 1').get(quan.id);
const again = app.ctx.purchaseReportTick();
say(`22:00 app gửi tổng hợp hàng cần nhập cho người giữ kho + quản lý + tổ trưởng (${rep?.pos.length || 0} đơn, gửi lại lần 2: ${again ? 'CÓ (lỗi)' : 'không'})`);
const zaloRows = db.prepare("SELECT zalo_status, COUNT(*) AS n FROM notifications WHERE title LIKE 'Hàng cần nhập%' GROUP BY zalo_status").all();

// ---------- Ngày 2: duyệt đơn, NCC giao, nhận hàng, app tự mở lại món ----------
now = at(D2, '08:00');
const pos = (await quan('GET', '/api/stock/po?status=draft')).data;
for (const p of pos) {
  if (p.status === 'draft') ok(await quan('POST', `/api/stock/po/${p.id}/submit`), `Gửi đơn #${p.id}`);
  ok(await quan('POST', `/api/stock/po/${p.id}/approve`), `Duyệt đơn #${p.id}`);
}
say(`Quản lý Quân duyệt ${pos.length} đơn mua, bấm "Chép nội dung" gửi NCC qua Zalo`);
now = at(D2, '09:30');
const receivedBills = [];
for (const p of pos) {
  const st = meta.stores.find((s) => s.id === p.store_id);
  const who = st?.name === 'Kho Bar' ? mai : st?.name === 'Kho Lẩu' ? tai : st?.name === 'Kho Bếp steak' ? phat : quan;
  // NCC giao thiếu 1 dòng đầu 10% để thấy app soi lệch đơn
  const lines = p.lines.map((l, k) => ({ ingredient_id: l.ingredient_id, qty: k === 0 ? Math.round(l.qty * 0.9 * 10) / 10 : l.qty, price: l.price }));
  const b = await receive(who, { po_id: p.id, signer_name: who === quan ? 'Quân' : 'Người nhận khu', lines }, `Giao theo đơn #${p.id} (${p.supplier_name}) → ${p.store_name}`);
  if (b) receivedBills.push(b);
}
const backNote = db.prepare("SELECT title FROM notifications WHERE title LIKE 'Có lại món%' ORDER BY id DESC LIMIT 1").get();
say(backNote ? `APP TỰ MỞ LẠI: ${backNote.title}` : 'Không có món nào cần mở lại');
now = at(D2, '10:00');
for (const b of receivedBills) ok(await ngan('POST', `/api/purchases/${b.id}/approve`), `Duyệt bill ${b.id}`);
const debts0 = (await ngan('GET', '/api/suppliers/debts')).data;
const thit = debts0.suppliers.find((s) => s.id === nThit);
const payR = await ngan('POST', `/api/suppliers/${nThit}/pay`, { amount: thit.debt, method: 'transfer', note: 'Trả hết công nợ' });
say(`Thu ngân duyệt bill giao sáng nay; trả Sạp thịt ${f(thit.debt)}đ → ${payR.data?.status === 'pending' ? 'trên 5 triệu: CHỜ CHỦ DUYỆT' : 'xong'}`);
if (payR.data?.status === 'pending') { await o('POST', `/api/supplier-payments/${payR.data.id}/approve`); say('Chủ quán duyệt khoản chi trên điện thoại'); }

await service(D2, '11:00', '13:30', 12);

// ---------- Báo cáo ----------
const P = (s) => console.log(s);
const notes = (re) => [...new Set(db.prepare('SELECT title, created_at FROM notifications ORDER BY id').all().filter((x) => re.test(x.title)).map((x) => `${hmOf(x.created_at)} ${x.title}`))];
P('# Giả lập chuỗi kho 2 ngày: nhập hàng → bán trừ kho → hết món → 22h tổng hợp → nhập lại');
P('');
P(`Kết quả: **${issues.length ? `${issues.length} lỗi` : 'không lỗi'}** · định lượng MẪU (steak 180g thăn + 120g khoai; set lẩu 200g bắp + 300g rau + 1 cốt; bia 1 lon; trà đào 60g đào)`);
if (issues.length) { P(''); for (const x of issues.slice(0, 20)) P(`- ✗ ${x}`); }
P('');
P('## Ngày 1');
P(`- ${stats.orders} bàn gửi bếp, ${stats.items} phần, doanh thu ${f(stats.revenue)}đ (gồm ngày 2 trưa)`);
P(`- Tồn sau khi nhận sáng: thăn ${kg(startStock.than)}, bắp ${kg(startStock.bap)}, rau ${kg(startStock.rau)}, bia ${startStock.bia} lon, đào ${kg(startStock.dao)}`);
P(`- App báo **sắp hết** (≤ 5 phần): ${Object.entries(stats.lowAt).map(([n, t]) => `${n} ${t}`).join(' · ') || 'không'}`);
P(`- App **tự khoá món** khi hết nguyên liệu: ${Object.entries(stats.soldOutAt).map(([n, t]) => `${n} ${t}`).join(' · ') || 'không'}`);
P(`- Khách gọi trúng món đã hết: trên app nút món xám "Hết nguyên liệu" (bấm cũng bị chặn) → phục vụ mời món khác ${stats.swapped} lần`);
P(`- Gọi quá số phần còn → app hỏi: bếp xác nhận còn thực tế ${stats.overConfirm} lần · khách đổi món ${stats.overAlt} lần`);
P('');
P('## Thông báo app gửi (theo giờ)');
for (const x of notes(/^(Sắp hết|HẾT MÓN|Có lại món|Bán vượt|Hàng cần nhập|Hoá đơn mua chờ|Duyệt chi NCC)/).slice(0, 40)) P(`- ${x}`);
P('');
P('## 22:00 · Tin "Hàng cần nhập ngày mai" (gửi qua Zalo OA cho ai đã liên kết; chưa liên kết thì hiện trong app)');
P('```');
P(repNote ? `${repNote.title}\n\n${repNote.body}` : '(không có)');
P('```');
P(`Trạng thái gửi Zalo: ${zaloRows.map((z) => `${z.zalo_status} ${z.n}`).join(', ') || '—'} (giả lập chưa nối OA thật)`);
P('');
P('## Dòng thời gian');
for (const x of log) P(`- ${x}`);
P('');
P('## Tồn kho cuối giả lập');
for (const [k, id] of Object.entries(I)) { const g = db.prepare('SELECT name, unit FROM ingredients WHERE id = ?').get(id); P(`- ${g.name}: ${g.unit === 'g' ? kg(stock(k)) : `${Math.round(stock(k))} ${g.unit}`}`); }
const debts = (await ngan('GET', '/api/suppliers/debts')).data;
P(`- Công nợ NCC còn: ${debts.suppliers.filter((s) => s.debt).map((s) => `${s.name} ${f(s.debt)}đ`).join(' · ') || '0đ'}`);
app.close();
server.close();
