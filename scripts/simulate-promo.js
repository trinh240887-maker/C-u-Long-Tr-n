#!/usr/bin/env node
// Giả lập khuyến mãi theo thực đơn thật (Sổ 5): chủ quán tạo 2 chương trình 18/10–27/10, phục vụ gọi món, bếp nhận phiếu, thu ngân in bill.
//   1. "Mua 1 tặng 1 steak cùng món": mua 1 phần steak nào tặng 1 phần y như vậy.
//   2. "Lẩu bò tặng 100g bò thái tay": mỗi set lẩu tặng 1 phần bò 100g (khách chọn thăn / bắp hoa / gù / gầu giòn).
// Chạy: node --disable-warning=ExperimentalWarning scripts/simulate-promo.js [thư-mục-xuất]  (giữ app chạy nếu có KEEP=1 để chụp màn hình)
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';
import { billBytes, ticketBytes } from '../server/lib/escpos.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'km-'));
fs.mkdirSync(outDir, { recursive: true });
const clock = makeClock({ offset: '+07:00' });
const DAY = '2026-10-23';
let now = clock.toEpoch(DAY, 18 * 60 + 30);
const dbFile = path.join(outDir, 'quanly.db');
fs.rmSync(dbFile, { force: true });
const db = openDb(dbFile, { now }); // DB file → nạp thực đơn thật theo Sổ 5
const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'km-p-')), zaloTransport: { send: async () => {} } });
const server = http.createServer(app.handler);
const port = Number(process.env.PORT || 0);
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const client = () => {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (res.status >= 400) throw new Error(`${method} ${url}: ${data?.error}`);
    return data;
  };
};
// Bỏ lệnh máy in ESC/POS, giữ chữ → xem bill như in ra giấy
function receipt(buf) {
  let out = '';
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b === 0x1b) { const c = buf[i + 1]; i += c === 0x40 ? 2 : c === 0x42 ? 4 : 3; continue; }
    if (b === 0x1d) {
      const c = buf[i + 1];
      if (c === 0x28) { const n = buf[i + 3] | (buf[i + 4] << 8); if (buf[i + 6] === 0x50) out += '[ MÃ QR CHUYỂN KHOẢN ]\n'; i += 5 + n; continue; }
      i += c === 0x56 ? 4 : 3; continue;
    }
    let j = i; while (j < buf.length && buf[j] !== 0x1b && buf[j] !== 0x1d) j++;
    out += buf.subarray(i, j).toString('utf8'); i = j;
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

const o = client();
await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
await o('PUT', '/api/settings', { shop_name: 'CỬU LONG TRẤN', bank_qr: '', bank_name: 'Techcombank' });
const teams = await o('GET', '/api/teams');
const waiter = client();
await o('POST', '/api/staff', { name: 'Hậu', role: 'staff', team_id: teams.find((t) => t.name === 'Phục vụ').id, pin: '736511', pay_type: 'hour', pay_rate: 25000 });
await waiter('POST', '/api/login', { pin: '736511' });
await waiter('POST', '/api/me/pin', { current_pin: '736511', new_pin: '836511' });
const menu = await o('GET', '/api/menu');
const M = (n) => menu.items.find((x) => x.name === n);
const cat = (n) => menu.categories.find((c) => c.name === n).id;
const log = [];
const P = (s = '') => log.push(s);

// ---------- 1. Chủ quán tạo khuyến mãi ----------
await o('POST', '/api/promotions', {
  name: 'Mua 1 tặng 1 steak', type: 'bogo', buy_qty: 1, get_qty: 1, pair: 'same', scope: 'categories', category_ids: [cat('Steak')],
  start_date: '2026-10-18', end_date: '2026-10-27', note: 'Mời khách khi order steak: gọi 2 phần giống nhau, tính tiền 1',
});
const giftItems = [M('Thịt tươi tặng 100g').id];
await o('POST', '/api/promotions', {
  name: 'Lẩu bò tặng 100g bò thái tay', type: 'gift', buy_qty: 1, get_qty: 1, scope: 'categories', category_ids: [cat('Combo lẩu')], gift_item_ids: giftItems,
  start_date: '2026-10-18', end_date: '2026-10-27', note: 'Mỗi set lẩu tặng 100g thịt tươi (bếp xếp chung các loại); bấm nút xanh "Thêm món tặng"',
});
const promos = (await o('GET', '/api/promotions')).items;
P('## 1. Chủ quán tạo khuyến mãi (Khuyến mãi → + Thêm chương trình)');
for (const p of promos) P(`- 🎁 **${p.name}** · ${p.summary} · ${p.status === 'running' ? 'Đang chạy' : p.status}`);
const notes = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE 'Khuyến mãi mới%'").get().n;
P(`- Không gửi thông báo riêng (${notes}): chương trình hiện ở thẻ 🎁 trang Hôm nay và thanh hồng màn gọi món`);

// ---------- 2. Phục vụ gọi món bàn 12 ----------
now = clock.toEpoch(DAY, 18 * 60 + 45);
const sid = (await waiter('POST', '/api/pos/sessions', { tables: [12], guests: 6 })).id;
const pick = (item, names) => names.map((n) => item.options.find((x) => x.name === n).id);
const add = (name, qty, opts = [], note = '') => waiter('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: M(name).id, qty, option_ids: opts.length ? pick(M(name), opts) : [], note });
await add('Combo 3', 2, ['Tiêu đen', 'Bánh mì'], 'chín vừa');
await add('Steak Âu', 1, ['Kem phô mai', 'Mì Ý']);
await add('Steak Âu', 1, ['Hoàng kim', 'Mì Ý']); // phần tặng khách chọn sốt khác, bấm cùng lúc
await add('Set 2 Mala Tứ Xuyên', 1);
await add('Nước lẩu Cà chua Quý Châu', 1); // khách lấy lẩu 2 ngăn
await add('Set 4 Cà chua Quý Châu', 1);
await add('Trà đào', 2);
let s = await waiter('GET', `/api/pos/sessions/${sid}`);
const tags = (await waiter('GET', '/api/menu')).promo?.tags || {};
P('\n## 2. Phục vụ gọi món · bàn 12, 6 khách');
P(`- Màn gọi món hiện nhãn 🎁 trên món: Combo 3 "${tags[M('Combo 3').id]}", Set lẩu "${tags[M('Set 2 Mala Tứ Xuyên').id]}"`);
P('- Khách gọi 1 Combo 3 (tiêu đen, bánh mì): phục vụ bấm Combo 3, chọn sốt → khung "🎁 Mua 1 tặng 1 steak: khách gọi 1 → bếp làm 2 phần" → nút [Thêm 1 + tặng 1 · 139.000đ] → app ghi 2 Combo 3');
P('- Khách gọi 1 Steak Âu kem phô mai, phần tặng muốn sốt Hoàng kim → bấm "Phần tặng chọn khác", chọn Hoàng kim ngay trong khung → [Thêm 1 + tặng 1 · 79.000đ] → app ghi 2 dòng, ra chung 1 phiếu');
P('- Thêm: 1 Set 2 Mala + 1 ngăn thêm Cà chua (lẩu 2 ngăn) · 1 Set 4 Cà chua (1 ngăn) · 2 Trà đào');
for (const g of s.gifts.filter((x) => x.left)) P(`- Màn hình hiện khung xanh: "🎁 ${g.name}: bàn còn được tặng ${g.left} phần" + nút ${g.items.map((i) => `[+ ${i.name}]`).join(' ')}`);
await add('Thịt tươi tặng 100g', 2);
s = await waiter('GET', `/api/pos/sessions/${sid}`);
P('- Phục vụ bấm nút [+ Thịt tươi tặng 100g] 2 lần (2 set) → khung xanh biến mất; khách không chọn loại');
const run = (await waiter('GET', '/api/menu')).promo?.running || [];
P(`- Đầu màn gọi món luôn có thanh hồng: "🎁 Quán đang có khuyến mãi: ${run.join(' · ')}"`);
if ((s.promo_hints || []).length) P(`- ⚠ LỖI: còn nhắc gọi thêm: ${s.promo_hints.map((h) => h.item_name).join(', ')}`);

// ---------- 3. Gửi bếp ----------
await waiter('POST', `/api/pos/sessions/${sid}/send`);

const tickets = db.prepare('SELECT t.*, st.name AS station_name FROM kitchen_tickets t LEFT JOIN kitchen_stations st ON st.id = t.station_id WHERE t.session_id = ? ORDER BY t.id').all(sid);
P('\n## 3. Phiếu bếp in ra từng điểm (chỉ tổng số phần phải làm, không ghi tặng)');
const ticketTxt = tickets.map((t) => receipt(ticketBytes({ ...t, lines: JSON.parse(t.lines) }, { mode: 'utf8', time: `${clock.fmt(t.created_at).slice(0, 5)} 23/10`, by: 'Hậu' }))).join('\n');
P('```'); P(ticketTxt.trim()); P('```');

// ---------- 4. Bill ----------
now = clock.toEpoch(DAY, 20 * 60 + 10);
const b = app.ctx.billData(sid);
const billTxt = receipt(billBytes(b, { mode: 'utf8' }));
P('\n## 4. Khách xin tính tiền: phiếu tạm tính in ra');
P('```'); P(billTxt.trim()); P('```');
P(`\nTiền hàng ${b.subtotal.toLocaleString('vi-VN')}đ · khuyến mãi −${b.discount.toLocaleString('vi-VN')}đ · khách trả **${b.total.toLocaleString('vi-VN')}đ**`);

// Giá vốn phần tặng (chủ quán xem chương trình tốn bao nhiêu)
const costOf = (name) => Math.round(db.prepare('SELECT SUM(r.qty * g.price / g.purchase_factor) AS c FROM menu_recipes r JOIN ingredients g ON g.id = r.ingredient_id JOIN menu_items m ON m.id = r.item_id WHERE m.name = ?').get(name).c || 0);
P(`\nGiá vốn phần tặng: 1 Combo 3 ${costOf('Combo 3').toLocaleString('vi-VN')}đ + 100g thịt tươi tặng ${costOf('Thịt tươi tặng 100g').toLocaleString('vi-VN')}đ/phần`);
const report = log.join('\n');
fs.writeFileSync(path.join(outDir, 'gia-lap-khuyen-mai.md'), report);
console.log(report);
// Bàn 15 chỉ gọi 1 set lẩu (để chụp màn hình khung xanh "còn được tặng")
const sid2 = (await waiter('POST', '/api/pos/sessions', { tables: [15], guests: 2 })).id;
await waiter('POST', `/api/pos/sessions/${sid2}/items`, { menu_item_id: M('Set 1 Thảo mộc Triều Châu').id, qty: 1 });
await waiter('POST', `/api/pos/sessions/${sid2}/items`, { menu_item_id: M('Combo 1').id, qty: 2, option_ids: pick(M('Combo 1'), ['Hoàng kim', 'Nui']) });
console.log(`\nSESSION=${sid} SESSION2=${sid2} URL=${base}`);
if (process.env.KEEP !== '1') { app.close(); server.close(); }
