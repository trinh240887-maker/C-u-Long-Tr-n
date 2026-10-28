import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('phân quyền: chủ quán bỏ tick → ẩn menu + máy chủ chặn; cấp riêng → người thấp hơn dùng được; mặc định giữ như cũ', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const team = (await o('GET', '/api/teams')).data[0].id;
  const qlId = (await o('POST', '/api/staff', { name: 'Hậu', role: 'manager', team_id: team, pin: '736511' })).data.id;
  const nvId = (await o('POST', '/api/staff', { name: 'Nga', role: 'staff', team_id: team, pin: '7365' })).data.id;
  const login = async (pin, np) => { const c = mk(); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
  const ql = await login('736511', '836512');
  const nv = await login('7365', '8365');

  // Mặc định như cũ
  assert.ok((await ql('GET', '/api/me')).data.pages.includes('/bao-cao'));
  assert.ok(!(await nv('GET', '/api/me')).data.pages.includes('/bao-cao'));
  assert.equal((await ql('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 200);
  assert.equal((await nv('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 403);
  assert.equal((await ql('GET', '/api/permissions')).status, 403); // chỉ chủ

  const perm = (await o('GET', '/api/permissions')).data;
  const pages = Object.fromEntries(perm.pages.map((p) => [p.path, { roles: p.roles, allow: p.allow, deny: p.deny }]));
  // Báo cáo + Cài đặt: chỉ chủ; cấp riêng Báo cáo cho Nga (nhân viên)
  pages['/bao-cao'] = { roles: [], allow: [nvId], deny: [] };
  pages['/cai-dat'] = { roles: [], allow: [], deny: [] };
  pages['/kho'].deny = [qlId];
  assert.equal((await o('PUT', '/api/permissions', { pages })).status, 200);

  const mq = (await ql('GET', '/api/me')).data.pages;
  assert.ok(!mq.includes('/bao-cao') && !mq.includes('/cai-dat') && !mq.includes('/kho'));
  assert.ok(mq.includes('/nhan-vien') && mq.includes('/'));
  assert.equal((await ql('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 403);
  assert.equal((await ql('PUT', '/api/settings', { shop_name: 'X' })).status, 403);
  assert.equal((await ql('POST', '/api/stock/receive', { lines: [] })).status, 403);
  assert.ok((await nv('GET', '/api/me')).data.pages.includes('/bao-cao'));
  assert.equal((await nv('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 200);
  // Cấp riêng không mở mục khác
  assert.equal((await nv('GET', '/api/daybook')).status, 403);
  // Chủ quán luôn dùng được
  assert.equal((await o('GET', '/api/reports/sales?from=2026-10-01&to=2026-10-02')).status, 200);
});

test('phân quyền mục con Mua hàng: nhân viên không có Công nợ NCC / Tạm ứng; cấp riêng thì có', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const team = (await o('GET', '/api/teams')).data.find((x) => x.name !== 'Thu ngân').id;
  const nvId = (await o('POST', '/api/staff', { name: 'Tài', role: 'staff', team_id: team, pin: '7365' })).data.id;
  const nv = mk();
  await nv('POST', '/api/login', { pin: '7365' });
  await nv('POST', '/api/me/pin', { current_pin: '7365', new_pin: '8365' });
  let pages = (await nv('GET', '/api/me')).data.pages;
  assert.ok(pages.includes('/mua-hang') && !pages.includes('/mua-hang#congno') && !pages.includes('/mua-hang#tamung'));
  assert.equal((await nv('GET', '/api/suppliers/debts')).status, 403);
  assert.equal((await nv('POST', '/api/advances', { staff_id: nvId, amount: 100000 })).status, 403);
  assert.equal((await nv('GET', '/api/advances')).status, 200); // khoản của mình vẫn xem được để gắn bill
  const perm = (await o('GET', '/api/permissions')).data;
  const cfg = Object.fromEntries(perm.pages.map((p) => [p.path, { roles: p.roles, allow: p.allow, deny: p.deny }]));
  cfg['/mua-hang#congno'].allow = [nvId];
  await o('PUT', '/api/permissions', { pages: cfg });
  pages = (await nv('GET', '/api/me')).data.pages;
  assert.ok(pages.includes('/mua-hang#congno'));
  assert.equal((await nv('GET', '/api/suppliers/debts')).status, 200);
});

test('xếp ca: người được cấp quyền "Xếp ca" xem lịch rảnh cả quán, xếp ca, công bố; người không có quyền bị chặn', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const team = (await o('GET', '/api/teams')).data[0].id;
  const aId = (await o('POST', '/api/staff', { name: 'Hậu', role: 'staff', team_id: team, pin: '7365' })).data.id;
  const bId = (await o('POST', '/api/staff', { name: 'Nga', role: 'staff', team_id: team, pin: '7366' })).data.id;
  const login = async (pin, np) => { const c = mk(); await c('POST', '/api/login', { pin }); await c('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return c; };
  const a = await login('7365', '8365');
  const b = await login('7366', '8366');
  const shift = { staff_id: bId, date: '2026-11-02', team_id: team, label: 'Ca', segments: [{ start: '17:00', end: '00:00' }] };
  assert.equal((await a('GET', '/api/availability?week=2026-11-02')).status, 403);
  assert.equal((await a('POST', '/api/shifts', shift)).status, 403);
  const perm = (await o('GET', '/api/permissions')).data;
  const cfg = Object.fromEntries(perm.pages.map((p) => [p.path, { roles: p.roles, allow: p.allow, deny: p.deny }]));
  cfg['/lich#xep'].allow = [aId];
  await o('PUT', '/api/permissions', { pages: cfg });
  assert.equal((await a('GET', '/api/availability?week=2026-11-02')).status, 200);
  const r = await a('POST', '/api/shifts', shift);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await a('POST', '/api/schedule/publish', { week: '2026-11-02' })).status, 200);
  assert.ok(db.prepare("SELECT n.title FROM notifications n JOIN staff s ON s.id = n.staff_id WHERE s.role = 'owner'").all().some((n) => /Hậu đã duyệt lịch tuần 02\/11/.test(n.title))); // duyệt → chủ nhận
  const x = await fetch(`${base}/api/schedule.xlsx?week=2026-11-02`, { headers: { cookie: (await (async () => { const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '582914' }) }); return res.headers.get('set-cookie').split(';')[0]; })()) } });
  assert.equal(x.status, 200);
  assert.ok((await x.arrayBuffer()).byteLength > 500); // bảng Excel lịch ca tuần
  assert.equal((await b('POST', '/api/shifts', { ...shift, staff_id: aId })).status, 403);
});

test('lịch ca: nhân viên chỉ thấy ca của mình, tổ trưởng thấy tổ mình, quản lý thấy hết', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const [t1, t2] = (await o('GET', '/api/teams')).data;
  const mkS = async (name, role, team, pin) => (await o('POST', '/api/staff', { name, role, team_id: team, pin })).data.id;
  const a = await mkS('An', 'staff', t1.id, '7365');
  const b = await mkS('Bình', 'staff', t1.id, '7366');
  const c = await mkS('Cúc', 'staff', t2.id, '7367');
  await mkS('Lead', 'team_lead', t1.id, '7368');
  for (const id of [a, b, c]) await o('POST', '/api/shifts', { staff_id: id, date: '2026-11-02', label: 'Ca', segments: [{ start: '06:00', end: '14:00' }] });
  const login = async (pin, np) => { const x = mk(); await x('POST', '/api/login', { pin }); await x('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return x; };
  const names = async (cl) => (await cl('GET', '/api/schedule?week=2026-11-02')).data.shifts.map((s) => s.staff_name).sort();
  assert.deepEqual(await names(await login('7365', '8365')), ['An']);
  assert.deepEqual(await names(await login('7368', '8368')), ['An', 'Bình']);
  assert.deepEqual(await names(o), ['An', 'Bình', 'Cúc']);
  // Quản lý có bộ phận (chủ quán 28/10): chỉ xem / xếp ca bộ phận mình; quản lý không bộ phận thấy cả quán
  await mkS('QL bộ phận', 'manager', t1.id, '736911');
  const ql = await login('736911', '836911');
  assert.deepEqual(await names(ql), ['An', 'Bình']);
  assert.equal((await ql('POST', '/api/shifts', { staff_id: c, date: '2026-11-03', label: 'Ca', segments: [{ start: '06:00', end: '14:00' }] })).status, 403);
  assert.equal((await ql('POST', '/api/shifts', { staff_id: a, date: '2026-11-03', label: 'Ca', segments: [{ start: '06:00', end: '14:00' }] })).status, 200);
  const gC = (await o('GET', '/api/schedule?week=2026-11-02')).data.shifts.find((x) => x.staff_id === c).group_id;
  assert.equal((await ql('POST', '/api/shifts/delete', { group_id: gC })).status, 403);
  assert.ok((await ql('GET', '/api/availability?week=2026-11-02')).data.people.every((p) => p.team_id === t1.id || p.team_id == null));
  const qlAll = (await o('POST', '/api/staff', { name: 'QL chung', role: 'manager', pin: '737012' })).data.id;
  assert.ok(qlAll);
  assert.deepEqual(await names(await login('737012', '837012')), ['An', 'An', 'Bình', 'Cúc']);
});

test('ca xếp theo giờ trùng loại ca → tự gắn loại ca (checklist theo ca hiện đúng)', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  await o('POST', '/api/shift-templates', { name: 'Ca gãy', segments: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '22:00' }] });
  const team = (await o('GET', '/api/teams')).data[0].id;
  const a = (await o('POST', '/api/staff', { name: 'An', role: 'staff', team_id: team, pin: '7365' })).data.id;
  await o('POST', '/api/shifts', { staff_id: a, date: '2026-11-02', label: 'Ca', segments: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '22:00' }] });
  const sh = (await o('GET', '/api/schedule?week=2026-11-02')).data.shifts[0];
  assert.equal(sh.label, 'Ca gãy');
  assert.ok(sh.template_id);
});

test('phân khu theo tuần: 1 lần cho cả tuần, ca có sẵn + ca mới trong tuần đều nhận khu', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const team = (await o('GET', '/api/teams')).data[0].id;
  const a = (await o('POST', '/api/staff', { name: 'An', role: 'staff', team_id: team, pin: '7365' })).data.id;
  const zA = (await o('GET', '/api/zones')).data[0];
  await o('POST', '/api/shifts', { staff_id: a, date: '2026-11-02', label: 'Ca', segments: [{ start: '06:00', end: '14:00' }] });
  assert.equal((await o('POST', '/api/schedule/week-zones', { week: '2026-11-04', staff_id: a, zone_id: zA.id })).status, 200);
  await o('POST', '/api/shifts', { staff_id: a, date: '2026-11-05', label: 'Ca', segments: [{ start: '14:00', end: '22:00' }] });
  const d = (await o('GET', '/api/schedule?week=2026-11-02')).data;
  assert.deepEqual(d.shifts.map((x) => x.zone_name), [zA.name, zA.name]);
  assert.equal(Number(d.week_zones[a]), zA.id);
  // Giao thêm bàn phụ trách trong khu (vd 2 bàn đầu khu A) → mọi ca trong tuần ghi bàn
  const two = zA.tables.slice(0, 2).map((x) => x.number).join(', ');
  assert.equal((await o('POST', '/api/schedule/week-zones', { week: '2026-11-02', staff_id: a, zone_id: zA.id, tables_text: two })).status, 200);
  const d2 = (await o('GET', '/api/schedule?week=2026-11-02')).data;
  assert.ok(d2.shifts.every((x) => x.tables_text && x.zone_id === zA.id));
  // bàn không thuộc khu → chặn
  assert.equal((await o('POST', '/api/schedule/week-zones', { week: '2026-11-02', staff_id: a, zone_id: zA.id, tables_text: '999' })).status, 400);
  // tuần sau không bị ảnh hưởng
  await o('POST', '/api/shifts', { staff_id: a, date: '2026-11-10', label: 'Ca', segments: [{ start: '06:00', end: '14:00' }] });
  assert.equal((await o('GET', '/api/schedule?week=2026-11-09')).data.shifts[0].zone_id, null);
});

test('checklist "Ai làm": giao 1 người cụ thể / trưởng ca → chỉ đúng người thấy', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const team = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Tạp vụ').id;
  const a = (await o('POST', '/api/staff', { name: 'An', role: 'staff', team_id: team, pin: '7365' })).data.id;
  const b = (await o('POST', '/api/staff', { name: 'Bình', role: 'staff', team_id: team, pin: '7366' })).data.id;
  const today = (await o('GET', '/api/me')).data.today;
  for (const id of [a, b]) await o('POST', '/api/shifts', { staff_id: id, date: today, label: 'Ca', segments: [{ start: '08:00', end: '20:00' }] });
  await o('POST', '/api/checklist-templates', { title: 'Lối đi (giao An)', team_id: team, phase: 'close', doer: `staff:${a}`, items: [{ text: 'Quét lối đi', kind: 'check' }] });
  await o('POST', '/api/checklist-templates', { title: 'Trưởng ca kiểm khu', team_id: null, phase: 'close', doer: 'lead', items: [{ text: 'Đi 1 vòng', kind: 'check' }] });
  const login = async (pin, np) => { const x = mk(); await x('POST', '/api/login', { pin }); await x('POST', '/api/me/pin', { current_pin: pin, new_pin: np }); return x; };
  const titles = async (cl) => (await cl('GET', '/api/checklists')).data.runs.map((r) => r.title);
  const ta = await titles(await login('7365', '8365'));
  const tb = await titles(await login('7366', '8366'));
  assert.ok(ta.includes('Lối đi (giao An)') && !ta.includes('Trưởng ca kiểm khu'));
  assert.ok(!tb.includes('Lối đi (giao An)') && !tb.includes('Trưởng ca kiểm khu'));
  const tpl = (await o('GET', '/api/checklist-templates')).data.find((x) => x.title === 'Lối đi (giao An)');
  assert.equal(tpl.doer_name, 'An');
});
