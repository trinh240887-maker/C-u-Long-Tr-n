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
  const pv = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Phục vụ');
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
  assert.deepEqual((await L('GET', '/api/availability/me?week=2026-10-26')).data.picks, { '2026-10-26': ['toi'], '2026-10-27': ['sang', 'toi'] });
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
  assert.deepEqual(wk.availability[lan]['2026-10-27'], ['sang', 'toi']);
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
