#!/usr/bin/env node
// Giả lập 1 ngày làm checklist ở TẤT CẢ khu (thực đơn + định lượng thật, bộ checklist theo khu):
//   mỗi người mở app → làm checklist mở ca / trong ca / đóng ca của tổ & vị trí mình (tick, gõ số, chụp ảnh, cân tồn);
//   có tình huống: người quên việc giữa ca, ảnh bị chấm "Làm lại", cân thịt tươi lệch, tủ mát nóng.
//   Cuối ngày chủ quán / quản lý duyệt ảnh. Báo cáo: mỗi khu bao nhiêu việc, ảnh, thời gian thao tác, sót gì, và nếu gọn còn 2 ảnh/ca thì đỡ bao nhiêu.
// Chạy: node --disable-warning=ExperimentalWarning scripts/simulate-checklists.js [file-báo-cáo.md]
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
const clock = makeClock({ offset: '+07:00' });
const DAY = '2026-10-24';
const at = (hm) => clock.toEpoch(DAY, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
let now = at('09:00');
const db = openDb(path.join(tmp, 'quanly.db'), { now });
const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: path.join(tmp, 'photos'), zaloTransport: { send: async () => {} } });
const server = http.createServer(app.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let seed = 2410;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const IMG = `data:image/jpeg;base64,${Buffer.alloc(3000, 7).toString('base64')}`;
const issues = [];
const client = (label) => {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (res.status >= 500) issues.push(`LỖI MÁY CHỦ ${method} ${url} (${label}): ${data?.error}`);
    return { status: res.status, data };
  };
};
const login = async (pin, np, label) => { const c = client(label); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };

// ---------- Dựng quán: tổ, vị trí, người ----------
const o = await login(DEFAULT_OWNER_PIN, '582914', 'Chủ quán');
await o('POST', '/api/teams', { name: 'Tiếp thực', min_staff: 2 });
let teams = (await o('GET', '/api/teams')).data;
const tid = (n) => teams.find((t) => t.name === n).id;
// Vị trí trong tổ Lẩu (đúng như quán chia khu)
const posId = {};
for (const n of ['Thái tay', 'Topping', 'Nước lẩu']) posId[n] = (await o('POST', '/api/positions', { team_id: tid('Lẩu'), name: n })).data.id;
// Gắn checklist theo khu vào đúng vị trí / tổ (bản đầu chưa có vị trí nên đang chung cả tổ Lẩu)
const setTpl = db.prepare('UPDATE checklist_templates SET position_id = ?, team_id = ?, active = 1, title = ? WHERE title = ?');
for (const [p, ts] of [['Thái tay', ['Mở ca Thái tay', 'Đóng ca Thái tay']], ['Topping', ['Mở ca Topping', 'Đóng ca Topping']], ['Nước lẩu', ['Mở ca Nước lẩu', 'Đóng ca Nước lẩu']]]) {
  for (const t of ts) setTpl.run(posId[p], tid('Lẩu'), t, t);
}
for (const t of ['Mở ca Tiếp thực', 'Đóng ca Tiếp thực']) setTpl.run(null, tid('Tiếp thực'), t, `${t} (chọn tổ)`);
// Checklist chung cũ đã có bản chi tiết → tắt (chủ quán sẽ tự tắt trên app thật)
db.prepare("UPDATE checklist_templates SET active = 0 WHERE title IN ('Mở ca lẩu', 'Mở ca bar', 'Mở ca bếp steak', 'Đóng ca bếp steak')").run();

let pinN = 736700;
const people = [];
const hire = async (name, team, pos = null, role = 'staff') => {
  const pin = String(++pinN);
  const r = await o('POST', '/api/staff', { name, role, team_id: tid(team), pin, pay_type: 'hour', pay_rate: 25000 });
  if (pos) db.prepare('UPDATE staff SET position_id = ? WHERE id = ?').run(posId[pos], r.data.id);
  const c = await login(pin, String(pinN + 100000), name);
  const p = { id: r.data.id, name, team, pos, c, area: pos || team };
  people.push(p);
  return p;
};
const quan = await hire('Quân (QL)', 'Phục vụ', null, 'manager');
await hire('Phát', 'Bếp steak', null, 'team_lead');
await hire('Tài', 'Lẩu', 'Thái tay', 'team_lead');
await hire('Hoà', 'Lẩu', 'Topping');
await hire('Sang', 'Lẩu', 'Nước lẩu');
await hire('Mai', 'Bar', null, 'team_lead');
await hire('Hậu', 'Phục vụ');
await hire('Bình', 'Tiếp thực');
await hire('Lan', 'Tạp vụ');
await hire('Ngân', 'Thu ngân');
const addAtt = db.prepare('INSERT INTO attendance (staff_id, date, clock_in, clock_out, late_minutes) VALUES (?, ?, ?, ?, 0)');
for (const p of people) addAtt.run(p.id, DAY, at('15:30'), at('23:30'));

// Kho: nhập thịt tươi theo bill Sạp thịt 23/10 (nhận hàng cân riêng từng loại) + bò nhập
const meta = (await o('GET', '/api/stock/meta')).data;
const ingId = (n) => meta.ingredients.find((g) => g.name === n)?.id;
const kho = meta.stores.find((s) => s.name === 'Kho Lẩu').id;
const recv = [['Thăn bò tươi', 22], ['Đùi bò tươi', 10.75], ['Bắp hoa tươi', 6.6], ['Gù bò tươi', 3.35], ['Bắp sau bò', 3.1], ['Gầu giòn', 4], ['Aukobe bông tuyết', 8], ['Lõi vai bò Úc', 5], ['Gù hoa bò Úc', 4], ['Ba chỉ bò Mỹ', 5]];
const rr = await o('POST', '/api/stock/receive', { store_id: kho, lines: recv.map(([n, q]) => ({ ingredient_id: ingId(n), qty: q })) });
if (rr.status !== 200) issues.push(`Nhận hàng: ${rr.data?.error}`);
// Bán trong ngày (trừ kho theo định lượng) để cuối ca cân có số sổ: 40 set lẩu + 25 phần bò gọi thêm
const menu = (await o('GET', '/api/menu')).data;
const M = (n) => menu.items.find((x) => x.name === n);
now = at('18:00');
const sid = (await quan.c('POST', '/api/pos/sessions', { tables: [30], guests: 40, override_size: true })).data.id;
for (const [n, q] of [['Set 1 Thảo mộc Triều Châu', 12], ['Set 2 Mala Tứ Xuyên', 16], ['Set 4 Cà chua Quý Châu', 12], ['Thăn bò tươi 100g', 10], ['Bắp hoa tươi 100g', 6], ['Gù bò tươi 100g', 5], ['Ba chỉ bò Mỹ 100g', 4]]) {
  const r = await quan.c('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: M(n).id, qty: q, override_stock: true });
  if (r.status !== 200) issues.push(`Gọi ${n}: ${r.data?.error}`);
}
await quan.c('POST', `/api/pos/sessions/${sid}/send`);
const book = (n) => db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock_lots WHERE ingredient_id = ?').get(ingId(n)).q;
const THIT = ['Thăn bò tươi', 'Đùi bò tươi', 'Bắp hoa tươi', 'Gù bò tươi', 'Bắp sau bò', 'Gầu giòn'];

// ---------- Làm checklist ----------
const SEC = { check: 5, number: 8, text: 10, photo: 25 }; // giây thao tác ước tính / việc
const stats = new Map(); // tiêu đề → {area, items, photos, sec, done, missed, who}
const stat = (run, who) => {
  if (!stats.has(run.title)) stats.set(run.title, { title: run.title, phase: run.phase, area: who.area, items: 0, photos: 0, sec: 0, done: 0, missed: [], who: who.name, at: '' });
  return stats.get(run.title);
};
const valueFor = (p, it) => {
  if (/Nhiệt độ tủ đông/.test(it.text)) return String(-18 + Math.round(rnd() * 3));
  if (/Nhiệt độ/.test(it.text)) return p.name === 'Hoà' && /Mở ca/.test(it.title) ? '9' : String(2 + Math.round(rnd() * 3)); // Hoà: tủ topping 9°C
  if (/Thịt tươi còn/.test(it.text)) { const exp = THIT.reduce((n, x) => n + book(x), 0) / 1000; return String(Math.round((exp - 2.1) * 100) / 100); } // thiếu 2,1kg
  if (/còn \(cân riêng\)/.test(it.text)) { const n = it.text.replace(/ còn.*/, ''); return String(Math.round(book(n) / 10) / 100); }
  if (/Chia sẵn bò.*100g/.test(it.text)) return '30';
  if (/Chia sẵn bò.*120g/.test(it.text)) return '15';
  if (/Chia sẵn bò.*150g/.test(it.text)) return '8';
  if (/phần còn lại/.test(it.text)) return '6';
  if (/Đếm xe/.test(it.text)) return '4';
  if (/Đếm ly/.test(it.text)) return /Đóng/.test(it.title) ? '118' : '120';
  if (/bình/.test(it.unit)) return '2';
  if (it.kind === 'text') return /Hàng thiếu/.test(it.text) ? (rnd() < 0.5 ? '' : 'Giấy thấm dầu còn 1 cuộn') : 'Thăn 3,2kg; Gù 1kg; Bắp hoa 1,5kg';
  return '1';
};
async function doPhase(p, phase, hm, { skip = [] } = {}) {
  now = at(hm);
  const runs = (await p.c('GET', `/api/checklists?date=${DAY}`)).data.runs.filter((r) => r.phase === phase);
  for (const run of runs) {
    const s = stat({ ...run, phase }, p);
    s.at = hm;
    for (const it0 of run.items) {
      const it = { ...it0, title: run.title };
      if (it.entry && it.entry.review_status !== 'redo') continue;
      s.items++;
      if (skip.some((re) => re.test(it.text))) { s.missed.push(it.text); continue; }
      if (it.photo_required) {
        const ph = await p.c('POST', '/api/checklists/photo', { run_id: run.run_id, item_id: it.id, data: IMG });
        if (ph.status !== 200) issues.push(`${p.name} chụp "${it.text}": ${ph.data?.error}`);
        s.photos++; s.sec += SEC.photo;
      }
      const v = it.kind === 'check' ? '' : valueFor(p, it);
      if (it.kind === 'text' && !v && !it.required) { s.sec += 2; continue; }
      const r = await p.c('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: it.id, value: v });
      if (r.status !== 200) issues.push(`${p.name} "${it.text}": ${r.data?.error}`);
      else s.done++;
      s.sec += SEC[it.kind] || 5;
      now += 30_000;
    }
  }
}
const lan = people.find((p) => p.name === 'Lan');
for (const p of people.filter((x) => x !== quan)) await doPhase(p, 'open', p.team === 'Tạp vụ' ? '15:35' : '15:45');
// Trong ca: Lan quên vòng 21:00
await doPhase(lan, 'during', '19:00', { skip: [/21:00/] });
await doPhase(people.find((p) => p.name === 'Phát'), 'during', '18:00');
for (const p of people.filter((x) => x !== quan)) await doPhase(p, 'close', '22:45');

// ---------- Duyệt ảnh ----------
now = at('23:10');
const rv = (await quan.c('GET', `/api/checklists/review?date=${DAY}`)).data;
const list = (rv.items || rv.rows || rv || []).filter?.((x) => !x.review_status) || [];
let ok = 0;
let redo = null;
for (const x of list) {
  if (!redo && /máy thái/i.test(x.item_text)) { redo = x; await quan.c('POST', '/api/checklists/review', { run_id: x.run_id, item_id: x.item_id, status: 'redo', note: 'Lưỡi máy thái còn dính thịt, lau lại' }); continue; }
  await quan.c('POST', '/api/checklists/review', { run_id: x.run_id, item_id: x.item_id, status: 'ok' }); ok++;
}
// Tài làm lại việc bị chấm
const tai = people.find((p) => p.name === 'Tài');
if (redo) { await doPhase(tai, 'close', '23:20'); stats.get(redo.title).redo = redo.item_text; }

// ---------- Báo cáo ----------
const notes = (re) => [...new Set(db.prepare('SELECT title FROM notifications ORDER BY id').all().map((x) => x.title).filter((t) => re.test(t)))];
const runsDb = db.prepare(`SELECT t.title, r.completed_at FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id WHERE r.date = ? AND t.active = 1`).all(DAY);
const out = [];
const P = (s = '') => out.push(s);
const mmss = (sec) => `${Math.floor(sec / 60)}′${String(Math.round(sec % 60)).padStart(2, '0')}″`;
P(`# Giả lập checklist toàn bộ khu · ${DAY.slice(8)}/${DAY.slice(5, 7)} · ${people.length - 1} nhân viên`);
P(`Kết quả: **${issues.length ? `${issues.length} lỗi` : 'không lỗi'}**`);
for (const x of issues.slice(0, 10)) P(`- ✗ ${x}`);
P('\n| Khu | Checklist | Người | Việc | Ảnh | Thao tác | Xong |');
P('|---|---|---|---|---|---|---|');
const order = { open: 0, during: 1, close: 2 };
const rows = [...stats.values()].sort((a, b) => a.area.localeCompare(b.area, 'vi') || order[a.phase] - order[b.phase]);
for (const s of rows) {
  const r = runsDb.find((x) => x.title === s.title);
  P(`| ${s.area} | ${s.title} | ${s.who} | ${s.items} | ${s.photos} | ${mmss(s.sec)} | ${r?.completed_at ? `✓ ${clock.fmt(r.completed_at).slice(0, 5)}` : `✗ thiếu: ${s.missed.join(', ') || '…'}`} |`);
}
const tot = rows.reduce((a, s) => ({ items: a.items + s.items, photos: a.photos + s.photos, sec: a.sec + s.sec }), { items: 0, photos: 0, sec: 0 });
P(`\n**Tổng:** ${tot.items} việc, ${tot.photos} ảnh, ${mmss(tot.sec)} thao tác cả quán (trung bình ${mmss(tot.sec / (people.length - 1))}/người/ngày)`);
P(`**Chủ quán duyệt ảnh:** ${list.length} ảnh (Đạt ${ok}, Làm lại ${redo ? 1 : 0}) ≈ ${mmss(list.length * 4)}`);
// Nếu gọn mọi khu còn 2 ảnh / ca như Bếp steak
const areas = new Map();
for (const s of rows) { const a = areas.get(s.area) || { photos: 0, shifts: 0 }; a.photos += s.photos; if (s.phase !== 'during') a.shifts++; areas.set(s.area, a); }
const after = [...areas.values()].reduce((n, a) => n + Math.min(a.photos, a.shifts), 0);
P(`**Nếu mọi khu gọn còn 1 ảnh mỗi lần mở / đóng ca (như Bếp steak):** ${tot.photos} → ${after} ảnh/ngày, bớt ≈ ${mmss((tot.photos - after) * (SEC.photo - SEC.check))} thao tác nhân viên và ${mmss((tot.photos - after) * 4)} duyệt của chủ quán`);
P('\n**App tự báo trong ngày:**');
for (const t of [...notes(/^Lệch|^Làm lại|^Chưa đạt|^Tủ /)].slice(0, 10)) P(`- ${t}`);
P(`- Lan quên "21:00 đi 1 vòng" → checklist "Trong ca Lối đi" chưa xong, quản lý thấy ở mục Checklist (đỏ)`);
const report = out.join('\n');
console.log(report);
if (process.argv[2]) fs.writeFileSync(process.argv[2], report);
app.close(); server.close();
process.exit(issues.length ? 1 : 0);
