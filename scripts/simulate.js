#!/usr/bin/env node
// Mô phỏng 1 tuần vận hành với 40 nhân sự ảo: báo lịch rảnh → xếp ca → 1 tối làm việc
// (chấm công, checklist ảnh, duyệt) → giờ cao điểm 2 quản lý order 30 bàn, bếp nhận phiếu.
// Chạy: node --disable-warning=ExperimentalWarning scripts/simulate.js
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock, addDays } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
let seed = 20261021;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pickN = (arr, n) => [...arr].sort(() => rnd() - 0.5).slice(0, n);
const JPG = `data:image/jpeg;base64,${Buffer.alloc(60_000, 7).toString('base64')}`; // ~60KB như ảnh đã nén

const issues = [];
const notes = [];
const issue = (msg) => { issues.push(msg); };
const note = (msg) => { notes.push(msg); console.log('·', msg); };

let now = at('2026-10-21', '09:00'); // Thứ Tư tuần này
const db = openDb(':memory:', { now });
const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-photo-'));
const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir, zaloTransport: { send: async () => {} } });
const server = http.createServer(app.handler);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const lat = [];
const client = (label) => {
  let cookie = '';
  return async (method, url, body) => {
    const t0 = performance.now();
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    lat.push({ url: url.split('?')[0].replace(/\d+/g, ':id'), ms: performance.now() - t0 });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (res.status >= 500) issue(`LỖI MÁY CHỦ ${res.status} ${method} ${url} (${label})`);
    return { status: res.status, data };
  };
};

// ---------- 1. Chủ quán dựng bộ phận, vị trí, loại ca ----------
const o = client('Chủ');
await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
let teams = (await o('GET', '/api/teams')).data;
const T = (n) => teams.find((x) => x.name === n && x.active);
await o('POST', '/api/teams/combine', { name: 'Bếp', team_ids: [T('Bếp steak').id, T('Lẩu').id] });
await o('POST', '/api/teams', { name: 'Tiếp thực', min_staff: 2 });
teams = (await o('GET', '/api/teams')).data;
const bep = T('Bếp');
for (const p of bep.positions) await o('PATCH', `/api/positions/${p.id}`, { name: p.name === 'Bếp steak' ? 'Steak' : p.name, min_staff: 2 });
for (const n of ['Bò', 'Topping', 'Nướng']) await o('POST', '/api/positions', { team_id: bep.id, name: n, min_staff: 1 });
await o('PATCH', `/api/teams/${T('Phục vụ').id}`, { min_staff: 12 });
await o('PATCH', `/api/teams/${bep.id}`, { min_staff: 8 });
teams = (await o('GET', '/api/teams')).data;
const positions = (await o('GET', '/api/positions')).data.filter((p) => p.team_id === bep.id);
const zones = (await o('GET', '/api/zones')).data;
// (chưa có số người tối thiểu theo khu)
const sang = (await o('POST', '/api/shift-templates', { name: 'Sáng', color: '#0e7490', segments: [{ start: '09:00', end: '15:00' }] })).data.id;
const toi = (await o('POST', '/api/shift-templates', { name: 'Tối', color: '#9a3412', segments: [{ start: '16:00', end: '23:00' }] })).data.id;

// ---------- 2. Thêm 40 người ----------
const plan = [
  ['manager', null, 2], ['shift_lead', 'Phục vụ', 2], ['staff', 'Phục vụ', 16], ['team_lead', 'Bếp', 1], ['staff', 'Bếp', 9],
  ['staff', 'Bar', 3], ['staff', 'Tiếp thực', 3], ['staff', 'Thu ngân', 2], ['staff', 'Tạp vụ', 2],
];
const people = [];
let pinN = 271800;
for (const [role, team, n] of plan) {
  for (let i = 0; i < n; i++) {
    const pin = String(pinN += 37);
    const name = `${team || 'Quản lý'} ${people.filter((p) => p.team === team).length + 1}`;
    const t = team ? T(team) : null;
    const pos = team === 'Bếp' ? positions[people.filter((p) => p.team === 'Bếp').length % positions.length] : null;
    const r = await o('POST', '/api/staff', { name, role, team_id: t?.id ?? null, position_id: pos?.id ?? null, pin, pay_type: 'hour', pay_rate: 25000 });
    if (r.status !== 200) issue(`Không thêm được ${name}: ${r.data?.error}`);
    people.push({ id: r.data.id, name, role, team, pin, pos: pos?.name || '', api: client(name) });
  }
}
note(`Đã thêm ${people.length} nhân sự (${plan.map(([, t, n]) => `${t || 'Quản lý'} ${n}`).join(', ')})`);
for (const p of people) await p.api('POST', '/api/login', { pin: p.pin });

// ---------- 3. Báo lịch rảnh tuần sau ----------
const ws = addDays('2026-10-19', 7); // Thứ Hai 26/10
const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
const must = people.filter((p) => p.role !== 'manager');
const lazy = pickN(must.filter((p) => p.role === 'staff'), 4);
let sent = 0;
for (const p of must) {
  if (lazy.includes(p)) continue;
  const picks = {};
  for (const d of days) {
    const r = rnd();
    picks[d] = r < 0.15 ? [] : r < 0.45 ? ['toi'] : r < 0.6 ? ['sang'] : ['sang', 'chieu', 'toi'];
  }
  p.picks = picks;
  const res = await p.api('POST', '/api/availability/me', { week: ws, picks, note: rnd() < 0.1 ? 'Thứ 7 chỉ rảnh sau 19h' : '' });
  if (res.status === 200) sent++; else issue(`${p.name} không gửi được lịch rảnh: ${res.data?.error}`);
}
const m1 = people.find((p) => p.role === 'manager');
const m2 = people.filter((p) => p.role === 'manager')[1];
let sum = (await m1.api('GET', `/api/availability?week=${ws}`)).data;
note(`Lịch rảnh: ${sent}/${must.length} người gửi; quản lý thấy ${sum.people.filter((x) => !x.submitted_at).length} người chưa gửi`);
const remind = (await m1.api('POST', '/api/availability/remind', { week: ws })).data;
note(`Quản lý bấm "Nhắc tất cả": gửi ${remind.sent} lời nhắc`);
const pv = T('Phục vụ');
const thieu = [];
for (const d of days) for (const s of ['sang', 'toi']) {
  const c = sum.cells[`${d}:${s}`].by_team[pv.id];
  if (c.free < (s === 'toi' ? 12 : 6)) thieu.push(`${d.slice(8)}/${d.slice(5, 7)} ${s === 'toi' ? 'tối' : 'sáng'} ${c.free} rảnh`);
}
note(`Bảng rảnh Phục vụ: ${thieu.length ? `thiếu người: ${thieu.slice(0, 5).join(', ')}${thieu.length > 5 ? '…' : ''}` : 'đủ người mọi buổi'}`);

// ---------- 4. Quản lý xếp ca cả tuần theo lịch rảnh ----------
let placed = 0;
let skipped = 0;
let rejected = 0;
const freeOf = (p, d, s) => (p.picks?.[d] || []).includes(s);
for (const d of days) {
  for (const [slot, tpl, needPv, needBep] of [['sang', sang, 6, 4], ['toi', toi, 12, 8]]) {
    const pvFree = must.filter((p) => p.team === 'Phục vụ' && freeOf(p, d, slot));
    pvFree.slice(0, needPv).forEach((p, i) => { p.plan = p.plan || []; p.plan.push({ d, tpl, zone: zones[i % zones.length].id }); });
    const bepFree = must.filter((p) => p.team === 'Bếp' && freeOf(p, d, slot));
    bepFree.slice(0, needBep).forEach((p, i) => { p.plan = p.plan || []; p.plan.push({ d, tpl, pos: positions[i % positions.length].id }); });
    for (const t of ['Bar', 'Tiếp thực', 'Thu ngân', 'Tạp vụ']) {
      must.filter((p) => p.team === t && freeOf(p, d, slot)).slice(0, 1).forEach((p) => { p.plan = p.plan || []; p.plan.push({ d, tpl }); });
    }
  }
}
const t0 = performance.now();
for (const p of must) {
  for (const x of p.plan || []) {
    if (x.done?.has?.(x.d)) continue;
    const r = await m1.api('POST', '/api/shifts', { staff_id: p.id, date: x.d, template_id: x.tpl, zone_id: x.zone ?? null, position_id: x.pos ?? null });
    if (r.status === 200) placed++;
    else if (r.status === 409) skipped++; // trùng giờ (người làm cả sáng lẫn tối thì không trùng)
    else { rejected++; if (rejected < 4) issue(`Xếp ca lỗi ${p.name} ${x.d}: ${r.data?.error}`); }
  }
}
note(`Xếp ${placed} ca trong ${Math.round((performance.now() - t0) / 1000 * 10) / 10}s (bỏ qua ${skipped} ca trùng giờ, lỗi ${rejected})`);
const week = (await m1.api('GET', `/api/schedule?week=${ws}`)).data;
note(`Lịch tuần: ${week.shifts.length} ca, ${week.warnings.length} cảnh báo thiếu người (vd: ${week.warnings.slice(0, 3).map((w) => w.text).join(' | ') || 'không'})`);
const notFree = week.shifts.filter((s) => { const p = must.find((x) => x.id === s.staff_id); const k = s.segments[0].start_min < 720 ? 'sang' : 'toi'; return p && !freeOf(p, s.date, k); }).length;
if (notFree) issue(`${notFree} ca xếp vào người không báo rảnh`);
const pub = await m1.api('POST', '/api/schedule/publish', { week: ws });
note(`Gửi lịch: ${pub.status === 200 ? `đã gửi cho ${pub.data.sent} người` : pub.data?.error}`);

// ---------- 5. Tối Thứ Hai: chấm công, checklist ảnh, duyệt ----------
const day = ws;
now = at(day, '15:50');
const onShift = must.filter((p) => week.shifts.some((s) => s.staff_id === p.id && s.date === day && s.segments[0].start_min >= 900));
let inOk = 0; let late = 0;
for (const p of onShift) {
  now = at(day, rnd() < 0.15 ? '16:12' : '15:55');
  const r = await p.api('POST', '/api/attendance/clock-in');
  if (r.status === 200) { inOk++; if (r.data?.late_minutes) late++; } else issue(`${p.name} không chấm vào được: ${r.data?.error}`);
}
note(`Chấm công tối: ${inOk}/${onShift.length} người chấm vào, ${late} người trễ`);
now = at(day, '16:30');
let ticks = 0; let blocked = 0; let photos = 0;
for (const p of onShift) {
  const cl = (await p.api('GET', '/api/checklists')).data;
  for (const run of cl.runs.slice(0, 2)) {
    for (const it of run.items) {
      if (it.entry) continue;
      if (it.photo_required) {
        const noPhoto = await p.api('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: it.id });
        if (noPhoto.status === 400) blocked++;
        const up = await p.api('POST', '/api/checklists/photo', { run_id: run.run_id, item_id: it.id, data: JPG });
        if (up.status === 200) photos++; else issue(`Gửi ảnh lỗi: ${up.data?.error}`);
      }
      const r = await p.api('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: it.id, value: it.kind === 'number' ? '4' : 'ok' });
      if (r.status === 200) ticks++;
    }
  }
}
note(`Checklist: ${ticks} việc xong, ${photos} ảnh gửi lên (${Math.round(photos * 60 / 1024)} MB), ${blocked} lần app chặn vì chưa chụp ảnh`);
const rv = (await m2.api('GET', '/api/checklists/review')).data;
let ok = 0; let redo = 0;
for (const x of rv.items) {
  const r = await m2.api('POST', '/api/checklists/review', rnd() < 0.15 ? { run_id: x.run_id, item_id: x.item_id, status: 'redo', note: 'Thiếu muỗng đũa' } : { run_id: x.run_id, item_id: x.item_id, status: 'ok' });
  if (r.status === 200) (r && rnd() < 2) && (rnd() < 0.15 ? redo++ : ok++);
}
const owner = db.prepare("SELECT id FROM staff WHERE role = 'owner'").get().id;
const ownerAlerts = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE staff_id = ? AND title LIKE 'Chưa đạt:%'").get(owner).n;
note(`Duyệt ảnh: quản lý chấm ${rv.items.length} việc; chủ nhận ${ownerAlerts} báo "Chưa đạt"`);

// ---------- 6. Giờ cao điểm: 2 quản lý order 30 bàn ----------
now = at(day, '18:30');
const menu = (await m1.api('GET', '/api/menu')).data;
const items = menu.items.filter((i) => !i.sold_out);
const pickItem = () => items[Math.floor(rnd() * items.length)];
const optIds = (it) => { const gs = [...new Set(it.options.filter((x) => x.required).map((x) => x.group_name))]; return gs.map((g) => it.options.find((x) => x.group_name === g).id); };
const tables = pickN(Array.from({ length: 100 }, (_, i) => i + 1), 30);
const waiters = [m1, m2];
const tOrder = performance.now();
const sessions = await Promise.all(tables.map(async (n, i) => {
  const w = waiters[i % 2].api;
  const s = await w('POST', '/api/pos/sessions', { tables: [n] });
  if (s.status !== 200) { issue(`Mở bàn ${n} lỗi: ${s.data?.error}`); return null; }
  const k = 3 + Math.floor(rnd() * 5);
  for (let j = 0; j < k; j++) {
    const it = pickItem();
    const r = await w('POST', `/api/pos/sessions/${s.data.id}/items`, { menu_item_id: it.id, option_ids: optIds(it), qty: 1 + Math.floor(rnd() * 2) });
    if (r.status !== 200) issue(`Gọi ${it.name} lỗi: ${r.data?.error}`);
  }
  const send = await w('POST', `/api/pos/sessions/${s.data.id}/send`);
  if (send.status !== 200) issue(`Gửi bếp bàn ${n} lỗi: ${send.data?.error}`);
  return { n, id: s.data.id, w };
}));
const orderSec = (performance.now() - tOrder) / 1000;
const open = sessions.filter(Boolean);
// Gọi thêm, huỷ, chuyển bàn
now = at(day, '19:10');
for (const s of open.slice(0, 10)) {
  const it = pickItem();
  await s.w('POST', `/api/pos/sessions/${s.id}/items`, { menu_item_id: it.id, option_ids: optIds(it) });
  await s.w('POST', `/api/pos/sessions/${s.id}/send`);
}
const d1 = (await m1.api('GET', `/api/pos/sessions/${open[0].id}`)).data;
const cancelLate = await people.find((p) => p.team === 'Phục vụ' && p.role === 'staff').api('POST', `/api/pos/items/${d1.items[0].id}/cancel`, { reason: 'Khách đổi ý' });
const cancelLead = await m1.api('POST', `/api/pos/items/${d1.items[0].id}/cancel`, { reason: 'Khách đổi ý' });
const freeTable = Array.from({ length: 100 }, (_, i) => i + 1).find((n) => !tables.includes(n));
const mv = await m2.api('POST', `/api/pos/sessions/${open[1].id}/move`, { tables: [freeTable] });
const twice = await m1.api('POST', '/api/pos/sessions', { tables: [open[2].n] });
note(`Order: 2 quản lý mở ${open.length} bàn cùng lúc trong ${Math.round(orderSec * 10) / 10}s; 10 bàn gọi thêm; nhân viên huỷ món sau 40′ → ${cancelLate.status === 403 ? 'bị chặn (đúng)' : cancelLate.status}; quản lý huỷ → ${cancelLead.status === 200 ? 'được' : cancelLead.status}; chuyển bàn → ${mv.status === 200 ? 'được' : mv.data?.error}; mở trùng bàn đang có khách → ${twice.status === 409 ? 'bị chặn (đúng)' : twice.status}`);
const tickets = (await m1.api('GET', '/api/pos/tickets')).data;
const byStation = {};
for (const k of tickets) byStation[k.station_name] = (byStation[k.station_name] || 0) + 1;
note(`Phiếu bếp: ${tickets.length} phiếu → ${Object.entries(byStation).map(([k, v]) => `${k} ${v}`).join(', ')}`);
// 10 người bếp xem phiếu
const cooks = people.filter((p) => p.team === 'Bếp');
const cookView = await Promise.all(cooks.map((c) => c.api('GET', '/api/pos/tickets')));
const canSee = cookView.filter((r) => r.status === 200).length;
if (canSee < cooks.length) issue(`Chỉ ${canSee}/${cooks.length} người bếp xem được phiếu (nhân viên bếp chưa có màn hình bếp — làm ở 3C)`);
const unprinted = tickets.filter((k) => k.print_status === 'pending').length;
if (unprinted) issue(`${unprinted} phiếu đang chờ in: chưa có cầu nối in (3C)`);
// Xin thanh toán
let bills = 0;
for (const s of open.slice(0, 5)) { const r = await s.w('POST', `/api/pos/sessions/${s.id}/request-bill`); if (r.status === 200) bills++; }
note(`Xin thanh toán: ${bills} bàn báo thu ngân. Chưa có màn thanh toán / đóng bàn (3D) nên bàn vẫn giữ trạng thái "xin thanh toán"`);
const map = (await m1.api('GET', '/api/pos/tables')).data;
const busy = map.zones.flatMap((z) => z.tables).filter((t) => t.session).length;
note(`Sơ đồ bàn: ${busy} bàn có khách; doanh thu tạm tính ${map.zones.flatMap((z) => z.tables).reduce((n, t) => n + (t.session?.total || 0), 0).toLocaleString('vi-VN')}đ`);

// ---------- Tốc độ ----------
const byUrl = {};
for (const l of lat) (byUrl[l.url] ||= []).push(l.ms);
const slow = Object.entries(byUrl).map(([u, a]) => [u, a.sort((x, y) => x - y)[Math.floor(a.length * 0.95)], a.length]).sort((a, b) => b[1] - a[1]).slice(0, 5);
note(`Tốc độ (95% yêu cầu nhanh hơn): ${slow.map(([u, ms, n]) => `${u} ${Math.round(ms)}ms×${n}`).join(' · ')}`);
note(`Tổng ${lat.length} lượt gọi máy chủ`);

console.log('\n=== VẤN ĐỀ ===');
console.log(issues.length ? issues.map((x) => `✗ ${x}`).join('\n') : 'Không có');
app.close();
server.close();
