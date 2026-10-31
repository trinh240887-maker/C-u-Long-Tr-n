import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
const JPG = `data:image/jpeg;base64,${Buffer.alloc(900, 9).toString('base64')}`;

async function setup(t, start) {
  let now = start;
  const db = openDb(':memory:', { now });
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-photo-'));
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir, zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      return { status: res.status, type, data: type.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
  };
  return { db, app, mk, photoDir, setNow: (ms) => { now = ms; } };
}

test('lịch rảnh: nhân viên báo buổi rảnh tuần sau, quản lý thấy dư/thiếu và ai chưa nộp', async (t) => {
  const { db, mk, setNow } = await setup(t, at('2026-10-20', '10:00')); // Thứ Ba
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Bar');
  const lan = (await o('POST', '/api/staff', { name: 'Lan', team_id: pv.id, pin: '4821' })).data.id;
  await o('POST', '/api/staff', { name: 'Minh', team_id: pv.id, pin: '5932' });
  const L = mk();
  await L('POST', '/api/login', { pin: '4821' });

  const mine = (await L('GET', '/api/availability/me')).data;
  assert.equal(mine.week_start, '2026-10-26'); // mặc định tuần sau
  assert.equal(mine.deadline.date, '2026-10-22'); // hạn Thứ Năm tuần này
  assert.equal(mine.must, true);
  assert.deepEqual(mine.slots.map((s) => s.key), ['sang', 'chieu', 'toi']);
  const res = await L('POST', '/api/availability/me', { week: '2026-10-26', picks: { '2026-10-26': ['toi'], '2026-10-27': ['sang', 'toi', 'xx'], '2026-11-30': ['toi'] }, note: 'T7 bận' });
  assert.equal(res.status, 200);
  assert.deepEqual((await L('GET', '/api/availability/me?week=2026-10-26')).data.picks, { '2026-10-26': ['17:00-24:00'], '2026-10-27': ['06:00-12:00', '17:00-24:00'] }); // mã buổi cũ đổi ra khung giờ
  // Không sửa được tuần đã bắt đầu
  assert.equal((await L('POST', '/api/availability/me', { week: '2026-10-19', picks: {} })).status, 400);
  // Nhân viên không xem được bảng tổng
  assert.equal((await L('GET', '/api/availability?week=2026-10-26')).status, 403);

  // Đã xếp ca tối thứ Hai cho Lan
  await o('POST', '/api/shifts', { staff_id: lan, date: '2026-10-26', segments: [{ start: '17:00', end: '22:00' }] });
  const sum = (await o('GET', '/api/availability?week=2026-10-26')).data;
  const cell = sum.cells['2026-10-26:toi'];
  assert.deepEqual(cell.free, [lan]);
  assert.deepEqual(cell.by_team[pv.id], { free: 1, scheduled: 1, need: pv.min_staff });
  assert.ok(sum.busy.includes(`${lan}:2026-10-26:toi`));
  assert.deepEqual(sum.people.filter((p) => !p.submitted_at).map((p) => p.name), ['Minh']);
  assert.equal(sum.people.find((p) => p.id === lan).note, 'T7 bận');

  // Nhắc người chưa nộp
  assert.equal((await o('POST', '/api/availability/remind', { week: '2026-10-26' })).data.sent, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title = 'Báo lịch rảnh tuần sau'").get().n, 1);
  // Lịch ca tuần đó có kèm lịch rảnh để quản lý xếp
  const wk = (await o('GET', '/api/schedule?week=2026-10-26')).data;
  assert.deepEqual(wk.availability[lan]['2026-10-27'], ['06:00-12:00', '17:00-24:00']);
  assert.deepEqual(wk.avail_submitted, [lan]);
  // Quá hạn mà chưa nộp thì báo trễ
  setNow(at('2026-10-23', '08:00'));
  const M = mk();
  await M('POST', '/api/login', { pin: '5932' });
  assert.equal((await M('GET', '/api/availability/me?week=2026-10-26')).data.late, true);
});

test('checklist ảnh: bắt chụp ảnh, quản lý chấm Làm lại → báo chủ, làm lại thì chờ duyệt; ảnh tự xoá sau 7 ngày', async (t) => {
  const { db, mk, photoDir, app, setNow } = await setup(t, at('2026-10-20', '08:00'));
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const teams = (await o('GET', '/api/teams')).data;
  const pv = teams.find((x) => x.name === 'Phục vụ');
  const zoneA = (await o('GET', '/api/zones')).data[0];
  const lan = (await o('POST', '/api/staff', { name: 'Lan', team_id: pv.id, pin: '4821' })).data.id;
  const kim = (await o('POST', '/api/staff', { name: 'Kim', role: 'manager', pin: '730194' })).data.id;
  const tpl = await o('POST', '/api/checklist-templates', { title: 'Mở ca Khu A', team_id: pv.id, zone_id: zoneA.id, phase: 'open',
    items: [{ text: 'Bày muỗng đũa Khu A' }, { text: 'Số bộ đũa đã bày', kind: 'number', unit: 'bộ' }] });
  assert.equal(tpl.status, 200);
  const L = mk();
  await L('POST', '/api/login', { pin: '4821' });
  // Không có ca ở Khu A hôm nay thì không thấy checklist của khu
  const has = async () => (await L('GET', '/api/checklists')).data.runs.find((r) => r.title === 'Mở ca Khu A');
  assert.equal(await has(), undefined);
  await o('POST', '/api/shifts', { staff_id: lan, date: '2026-10-20', segments: [{ start: '07:00', end: '15:00' }], zone_id: zoneA.id });
  const run = await has();
  assert.ok(run);
  assert.equal(run.zone_name, 'Khu A');
  const [bay, so] = run.items;
  assert.equal(bay.photo_required, true);
  assert.equal(so.photo_required, false); // mục nhập số không bắt ảnh

  assert.equal((await L('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: bay.id })).status, 400);
  assert.equal((await L('POST', '/api/checklists/photo', { run_id: run.run_id, item_id: bay.id, data: 'data:text/html;base64,AAAA' })).status, 400);
  const ph = await L('POST', '/api/checklists/photo', { run_id: run.run_id, item_id: bay.id, data: JPG });
  assert.equal(ph.status, 200);
  assert.equal((await L('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: bay.id })).status, 200);
  assert.equal((await L('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: so.id, value: '120' })).status, 200);
  assert.ok((await has()).completed_at);
  // Đã bấm xong thì không xoá ảnh được
  assert.equal((await L('POST', '/api/checklists/photo/delete', { id: ph.data.id })).status, 400);
  // Xem ảnh
  const img = await o('GET', `/api/photos/${ph.data.id}`);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/jpeg');
  assert.equal(img.data.length, 900);

  // Quản lý Kim chấm Làm lại → Lan và chủ nhận thông báo, checklist chưa xong
  const K = mk();
  await K('POST', '/api/login', { pin: '730194' });
  const list = (await K('GET', '/api/checklists/review')).data;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].zone_name, 'Khu A');
  assert.equal(list.items[0].review_status, null);
  assert.equal((await K('POST', '/api/checklists/review', { run_id: run.run_id, item_id: bay.id, status: 'redo' })).status, 400); // phải ghi lý do
  assert.equal((await K('POST', '/api/checklists/review', { run_id: run.run_id, item_id: bay.id, status: 'redo', note: 'Bàn 12 thiếu nĩa' })).status, 200);
  const owner = db.prepare("SELECT id FROM staff WHERE role = 'owner'").get().id;
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE staff_id = ? AND title LIKE 'Chưa đạt:%'").get(owner));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE staff_id = ? AND title LIKE 'Làm lại:%'").get(lan));
  let mineRun = await has();
  assert.equal(mineRun.completed_at, null);
  assert.equal(mineRun.redo, 1);
  // Chưa chụp ảnh mới thì không bấm xong lại được
  setNow(at('2026-10-20', '08:05'));
  assert.equal((await L('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: bay.id })).status, 400);
  // Lan chụp ảnh mới, bấm xong lại → chờ duyệt, quản lý chấm Đạt
  assert.equal((await L('POST', '/api/checklists/photo', { run_id: run.run_id, item_id: bay.id, data: JPG })).status, 200);
  assert.equal((await L('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: bay.id })).status, 200);
  mineRun = await has();
  assert.equal(mineRun.items[0].entry.review_status, null);
  assert.ok(mineRun.completed_at);
  assert.equal((await K('POST', '/api/checklists/review', { run_id: run.run_id, item_id: bay.id, status: 'ok' })).status, 200);
  const score = (await K('GET', '/api/checklists/review')).data.score.people.find((p) => p.id === lan);
  assert.deepEqual({ ok: score.ok, redo: score.redo, pending: score.pending }, { ok: 1, redo: 0, pending: 0 });
  // Nhân viên không vào được trang duyệt
  assert.equal((await L('GET', '/api/checklists/review')).status, 403);

  // Sau 7 ngày ảnh tự xoá, kết quả chấm vẫn còn
  const files = () => fs.readdirSync(photoDir, { recursive: true }).filter((f) => f.endsWith('.jpg'));
  assert.equal(files().length, 2);
  setNow(at('2026-10-27', '09:00'));
  assert.equal(app.ctx.cleanupPhotos(), 2);
  assert.equal(files().length, 0);
  assert.equal((await o('GET', `/api/photos/${ph.data.id}`)).status, 410);
  assert.equal(db.prepare('SELECT review_status FROM checklist_entries WHERE run_id = ? AND item_id = ?').get(run.run_id, bay.id).review_status, 'ok');
  void kim;
});

test('dụng cụ: khai báo bộ cho Steak/Lẩu, dự trù theo khách cao điểm', async (t) => {
  const { mk } = await setup(t, at('2026-10-20', '08:00'));
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const d = (await o('GET', '/api/utensils')).data;
  assert.deepEqual(d.kits.map((k) => k.name), ['Steak', 'Lẩu']);
  const id = (n) => d.utensils.find((u) => u.name === n).id;
  const [steak, lau] = d.kits;
  // Quán sửa: steak thêm muỗng; nhập số đang có
  assert.equal((await o('PATCH', `/api/service-kits/${steak.id}`, { items: [...steak.items, { utensil_id: id('Muỗng'), per_guest: 1 }] })).status, 200);
  assert.equal((await o('PATCH', `/api/utensils/${id('Nĩa')}`, { on_hand: 100 })).status, 200);
  await o('PUT', '/api/settings', { wash_cycle_minutes: 35, dining_minutes: 70, utensil_reserve_pct: 10 });
  const plan = (await o('POST', '/api/utensils/plan', { guests: { [steak.id]: 80, [lau.id]: 120 } })).data;
  assert.equal(plan.factor, 1.65); // (1 + 35/70) × 1.1
  const row = (n) => plan.rows.find((x) => x.name === n);
  assert.deepEqual({ ...row('Nĩa') }, { utensil_id: id('Nĩa'), name: 'Nĩa', unit: 'cái', at_table: 80, required: 132, on_hand: 100, short: 32 });
  assert.equal(row('Muỗng').at_table, 200); // 80 steak + 120 lẩu
  assert.equal(row('Vá lẩu').at_table, 30); // 1 vá / 4 khách
  assert.equal(row('Ly').required, Math.ceil(200 * 1.65));
});

test('thực đơn: có sẵn menu quán, sửa giá/công thức, tổ trưởng chỉ bật Hết món, điểm in theo IP', async (t) => {
  const { mk } = await setup(t, at('2026-10-20', '08:00'));
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const m = (await o('GET', '/api/menu')).data;
  assert.equal(m.items.length, 54);
  const st = Object.fromEntries(m.stations.map((s) => [s.name, s]));
  assert.equal(st['Steak'].printer_ip, '192.168.1.234');
  assert.equal(st['Ưu tiên'].fallback_station_id, st['Steak'].id);
  const combo3 = m.items.find((i) => i.name === 'Combo 3');
  assert.equal(combo3.price, 89000);
  assert.equal(combo3.station_id, st['Steak'].id);
  assert.deepEqual(combo3.options.map((x) => [x.group_name, x.name, x.required]), [['Sốt', 'Tứ xuyên', true], ['Sốt', 'Kem phô mai', true], ['Sốt', 'Tiêu đen', true]]);
  const set1 = m.items.find((i) => i.name.startsWith('Set 1'));
  assert.deepEqual(set1.parts.map((p) => m.stations.find((s) => s.id === p.station_id).name), ['Nước lẩu', 'Bò', 'Topping – Nướng – Rau']);

  // Công thức trừ kho
  const ing = (await o('POST', '/api/stock/ingredients', { name: 'Thịt bò steak', unit: 'g' })).data.id;
  assert.equal((await o('PATCH', `/api/menu/items/${combo3.id}`, { price: '95.000', recipe: [{ ingredient_id: ing, qty: 100 }] })).status, 200);
  const after = (await o('GET', '/api/menu')).data.items.find((i) => i.id === combo3.id);
  assert.equal(after.price, 95000);
  assert.deepEqual(after.recipe.map((x) => [x.ingredient_name, x.qty]), [['Thịt bò steak', 100]]);
  assert.equal((await o('PATCH', `/api/menu/items/${combo3.id}`, { price: '-5' })).status, 400);

  // Tổ trưởng: bật Hết món được, sửa giá thì không
  const bep = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Bếp steak').id;
  await o('POST', '/api/staff', { name: 'Tài', role: 'team_lead', team_id: bep, pin: '6152' });
  const T = mk();
  await T('POST', '/api/login', { pin: '6152' });
  assert.equal((await T('PATCH', `/api/menu/items/${combo3.id}`, { sold_out: true })).status, 403); // chủ quán 29/10: tổ trưởng không bấm Hết món
  assert.equal((await o('PATCH', `/api/menu/items/${combo3.id}`, { sold_out: true })).status, 200);
  assert.equal((await T('PATCH', `/api/menu/items/${combo3.id}`, { price: 1000 })).status, 403);
  assert.equal((await o('GET', '/api/menu')).data.items.find((i) => i.id === combo3.id).sold_out, true);
  assert.equal((await T('POST', '/api/menu/reset-sold-out')).status, 403);
  assert.equal((await o('POST', '/api/menu/reset-sold-out')).data.n, 1);

  // Điểm in: nhập IP máy Ưu tiên
  assert.equal((await o('PATCH', `/api/kitchen-stations/${st['Ưu tiên'].id}`, { printer_ip: '192.168.1.9x' })).status, 400);
  assert.equal((await o('PATCH', `/api/kitchen-stations/${st['Ưu tiên'].id}`, { printer_ip: '192.168.1.236' })).status, 200);
});

test('lịch rảnh cố định: báo 1 lần "tuần nào cũng vậy" → tuần sau tự điền, coi như đã gửi; "giống tuần trước" có sẵn', async (t) => {
  const { openDb, DEFAULT_OWNER_PIN } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const http = await import('node:http');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const now = Date.parse('2026-10-24T03:00:00Z');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const team = (await o('GET', '/api/teams')).data[0].id;
  await o('POST', '/api/staff', { name: 'Nga', role: 'staff', team_id: team, pin: '7365' });
  const nv = mk();
  await nv('POST', '/api/login', { pin: '7365' });
  await nv('POST', '/api/me/pin', { current_pin: '7365', new_pin: '8365' });
  const w1 = (await nv('GET', '/api/availability/me')).data; // tuần 26/10
  assert.equal(w1.week_start, '2026-10-26');
  assert.equal((await nv('POST', '/api/availability/me', { week: w1.week_start, picks: { '2026-10-26': ['16:00-23:00'], '2026-10-31': ['10:30-22:00'], '2026-10-27': ['23:00-20:00'] }, fixed: true })).status, 200);
  const w2 = (await nv('GET', '/api/availability/me?week=2026-11-02')).data;
  assert.ok(w2.submitted_at && w2.auto);
  assert.deepEqual(w2.picks, { '2026-11-02': ['16:00-23:00'], '2026-11-07': ['10:30-22:00'] }); // giờ sai (23→20) bị bỏ
  assert.deepEqual(w2.prev_picks['2026-11-07'], ['10:30-22:00']);
  const s2 = (await o('GET', '/api/availability?week=2026-11-02')).data;
  const nga = s2.people.find((p) => p.name === 'Nga').id;
  assert.ok(s2.cells['2026-11-02:toi'].free.includes(nga) && s2.cells['2026-11-02:chieu'].free.includes(nga) && !s2.cells['2026-11-02:sang'].free.includes(nga));
  assert.deepEqual(s2.hours[`${nga}:2026-11-02`], ['16:00-23:00']);
  // Lịch rảnh = lịch làm: tuần tự điền theo lịch cố định đã thành ca (ô đậm), quản lý chỉ sửa / bỏ
  const sh = (await o('GET', '/api/schedule?week=2026-11-02')).data.shifts.filter((x) => x.staff_id === nga);
  assert.deepEqual(sh.map((x) => `${x.date} ${x.text}`), ['2026-11-02 16:00–23:00', '2026-11-07 10:30–22:00']);
  // Quản lý sửa 1 ca → nhân viên gửi lại lịch rảnh không đè ca đã sửa, ca tự tạo thì thay theo lịch mới
  await o('POST', '/api/shifts', { staff_id: nga, date: '2026-11-02', label: 'Ca', segments: [{ start: '17:00', end: '22:00' }], replace_group_id: sh[0].group_id });
  await nv('POST', '/api/availability/me', { week: '2026-11-02', picks: { '2026-11-02': ['06:00-14:00'], '2026-11-04': ['14:00-22:00'] } });
  const sh2 = (await o('GET', '/api/schedule?week=2026-11-02')).data.shifts.filter((x) => x.staff_id === nga).map((x) => `${x.date} ${x.text}`);
  assert.deepEqual(sh2, ['2026-11-02 17:00–22:00', '2026-11-04 14:00–22:00']);
  const sum = (await o('GET', '/api/availability?week=2026-11-09')).data;
  assert.ok(sum.people.find((p) => p.name === 'Nga').fixed);
  // Bỏ lịch cố định → tuần sau không tự điền nữa
  await nv('POST', '/api/availability/me', { week: '2026-11-02', picks: { '2026-11-03': ['sang'] }, fixed: false });
  assert.equal((await nv('GET', '/api/availability/me?week=2026-11-16')).data.submitted_at, null);
});
