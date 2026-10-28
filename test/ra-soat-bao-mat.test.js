// Rà soát 28/10: giả IP, dò PIN, nâng quyền Nhân viên, tự sửa chấm công / lương, khoá máy, đơn nghỉ 1 khúc
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp, resolveClientIp, isCloudflareIp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (d, hm) => clock.toEpoch(d, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));

async function setup(t, { now } = {}) {
  const db = openDb(':memory:', now ? { now: now() } : {});
  const app = createApp({ db, ...(now ? { now } : {}), publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = (extra = {}) => { let cookie = ''; const c = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...extra, ...headers, ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const s = res.headers.get('set-cookie'); if (s && /sid=/.test(s)) cookie = /sid=[^;]*/.exec(s)[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }; return c; };
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const teams = (await o('GET', '/api/teams')).data;
  const add = async (name, role, pin, extra = {}) => (await o('POST', '/api/staff', { name, role, team_id: teams[0].id, pin, ...extra })).data.id;
  const login = async (pin, extra) => { const c = mk(extra); await c('POST', '/api/login', { pin }); return c; };
  return { db, app, o, mk, add, login, teams };
}

test('IP người dùng: không tin cf-connecting-ip / X-Forwarded-For do người dùng tự ghi', () => {
  // Không qua proxy: header cf-connecting-ip từ máy lạ bị bỏ qua
  assert.deepEqual(resolveClientIp({ 'cf-connecting-ip': '1.2.3.4' }, '::ffff:8.8.8.8', false), { ip: '8.8.8.8', remote: false });
  // Cloudflare gọi thẳng (IP trong dải Cloudflare) → tin
  assert.deepEqual(resolveClientIp({ 'cf-connecting-ip': '1.2.3.4' }, '162.158.1.1', false), { ip: '1.2.3.4', remote: true });
  // cloudflared chạy trên chính máy chủ quán
  assert.equal(resolveClientIp({ 'cf-connecting-ip': '1.2.3.4' }, '127.0.0.1', false).ip, '1.2.3.4');
  // Sau proxy Railway: lấy chặng do proxy ghi (phải nhất, bỏ qua mạng nội bộ), không lấy mục đầu người dùng tự ghi
  assert.equal(resolveClientIp({ 'x-forwarded-for': '6.6.6.6, 9.9.9.9, 10.0.0.2' }, '10.1.1.1', true).ip, '9.9.9.9');
  assert.equal(resolveClientIp({ 'x-forwarded-for': '6.6.6.6, 9.9.9.9', 'cf-connecting-ip': '7.7.7.7' }, '10.1.1.1', true).ip, '9.9.9.9');
  // Tên miền riêng sau Cloudflare → Railway: chặng cuối là Cloudflare → tin cf-connecting-ip
  assert.deepEqual(resolveClientIp({ 'x-forwarded-for': '6.6.6.6, 172.70.1.1', 'cf-connecting-ip': '7.7.7.7' }, '10.1.1.1', true), { ip: '7.7.7.7', remote: true });
  assert.equal(resolveClientIp({ 'x-forwarded-for': '2400:cb00::1', 'cf-connecting-ip': '2001:db8::5' }, '10.0.0.1', true).ip, '2001:db8::5');
  assert.ok(isCloudflareIp('104.16.5.5') && !isCloudflareIp('8.8.8.8'));
});

test('giả IP không né được khoá dò PIN; nhân viên không thấy IP wifi quán; Map lượt sai được dọn', async (t) => {
  const old = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  t.after(() => { if (old === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = old; });
  let now = Date.now();
  const { app, o, add, mk } = await setup(t, { now: () => now });
  await add('Nga', 'staff', '7365');
  const ip = '203.0.113.9';
  const c = mk();
  for (let i = 0; i < 5; i++) {
    const r = await c('POST', '/api/login', { pin: '1111', phone: '0901234567' }, { 'x-forwarded-for': `5.5.5.${i}, ${ip}`, 'cf-connecting-ip': `8.8.4.${i}` });
    assert.equal(r.status, 401);
  }
  const locked = await c('POST', '/api/login', { pin: '1111', phone: '0901234567' }, { 'x-forwarded-for': `5.5.5.99, ${ip}`, 'cf-connecting-ip': '8.8.4.99' });
  assert.equal(locked.status, 429, 'đổi header giả vẫn bị khoá theo IP thật');

  // Nhân viên: không có bridge_ip / dải IP; quản lý: có
  app.ctx.setSetting('shop_bridge_ip', '198.51.100.7'); app.ctx.setSetting('shop_bridge_ip_at', String(now));
  const nv = mk(); await nv('POST', '/api/login', { pin: '7365' }, { 'x-forwarded-for': '198.51.100.50' });
  const net = (await nv('GET', '/api/attendance/network', null, { 'x-forwarded-for': '198.51.100.50' })).data;
  assert.equal(net.bridge_ip, undefined); assert.equal(net.prefixes, undefined); assert.equal(net.on_shop_wifi, false);
  // Giả X-Forwarded-For = IP quán (đứng đầu) không thành wifi quán
  const fake = (await nv('GET', '/api/attendance/network', null, { 'x-forwarded-for': '198.51.100.7, 198.51.100.50' })).data;
  assert.equal(fake.on_shop_wifi, false);
  assert.equal((await nv('GET', '/api/attendance/network', null, { 'x-forwarded-for': '198.51.100.7' })).data.on_shop_wifi, true);
  assert.equal((await o('GET', '/api/attendance/network')).data.bridge_ip, '198.51.100.7');

  // Dọn lượt sai hết hạn
  for (let i = 0; i < 50; i++) app.ctx.loginGuard.failed(`192.0.2.${i}`, '');
  const n0 = app.ctx.loginGuard.size();
  assert.ok(n0 >= 50);
  now += 30 * 60_000;
  app.ctx.loginGuard.check('192.0.2.200', '');
  assert.ok(app.ctx.loginGuard.size() < 10, `đã dọn: còn ${app.ctx.loginGuard.size()}`);
});

test('dò PIN: đổi PIN báo chung chung + giới hạn 5 lần; đăng nhập thiếu SĐT báo như sai PIN; đổi PIN đăng xuất máy khác', async (t) => {
  const { o, add, login, mk } = await setup(t);
  await add('Nga', 'staff', '7365', { phone: '0901234567' });
  await add('Tài', 'staff', '4826');
  const tai = await login('4826');
  const taiOther = await login('4826');
  // PIN trùng người khác: không lộ "đã có người dùng"
  const dup = await tai('POST', '/api/me/pin', { current_pin: '4826', new_pin: '7365' });
  assert.equal(dup.status, 400); assert.doesNotMatch(dup.data.error, /người dùng/); assert.match(dup.data.error, /không dùng được/);
  // Đăng nhập không gõ SĐT: PIN đúng (tài khoản có SĐT) và PIN sai báo cùng câu
  const right = await mk()('POST', '/api/login', { pin: '7365' });
  const wrong = await mk()('POST', '/api/login', { pin: '9173' });
  assert.equal(right.status, 401); assert.equal(right.data.error, wrong.data.error);
  assert.match(right.data.error, /số điện thoại/);
  assert.equal((await mk()('POST', '/api/login', { pin: '7365', phone: '0901234567' })).status, 200);
  // Đổi PIN thành công: phiên này còn, phiên máy khác bị đăng xuất
  assert.equal((await tai('POST', '/api/me/pin', { current_pin: '4826', new_pin: '5927' })).status, 200);
  assert.equal((await tai('GET', '/api/me')).status, 200);
  assert.equal((await taiOther('GET', '/api/me')).status, 401);
  // Giới hạn: tổng 5 lần bị từ chối / 10 phút (1 lần trùng ở trên + 4 lần nữa) → lần sau 429
  for (let i = 0; i < 3; i++) assert.equal((await tai('POST', '/api/me/pin', { current_pin: '5927', new_pin: '7365' })).status, 400);
  assert.equal((await tai('POST', '/api/me/pin', { current_pin: '0000', new_pin: '8264' })).status, 400);
  const lim = await tai('POST', '/api/me/pin', { current_pin: '5927', new_pin: '7365' });
  assert.equal(lim.status, 429);
  void o;
});

test('lương: quản lý không tự đổi lương mình / lương quản lý khác; chủ quán đổi được', async (t) => {
  const { o, add, login } = await setup(t);
  const qlId = await add('Hậu', 'manager', '736511', { pay_rate: 40000 });
  const nvId = await add('Nga', 'staff', '7365', { pay_rate: 20000 });
  const ql = await login('736511');
  const self = await ql('PATCH', `/api/staff/${qlId}`, { pay_rate: 90000 });
  assert.equal(self.status, 403);
  assert.equal((await ql('PATCH', `/api/staff/${qlId}`, { pay_rate: 40000, name: 'Hậu QL' })).status, 200, 'sửa tên mình, lương giữ nguyên: được');
  assert.equal((await ql('PATCH', `/api/staff/${nvId}`, { pay_rate: 22000 })).status, 200);
  assert.equal((await o('PATCH', `/api/staff/${qlId}`, { pay_rate: 45000 })).status, 200);
  const list = (await o('GET', '/api/staff')).data;
  assert.equal(list.find((x) => x.id === qlId).pay_rate, 45000);
  assert.equal(list.find((x) => x.id === nvId).pay_rate, 22000);
});

test('cấp riêng mục Nhân viên chỉ nâng quyền xem; ghi cần tick việc riêng, vẫn không đụng người cấp cao / lương', async (t) => {
  const { o, add, login } = await setup(t);
  const tcId = await add('Phong', 'shift_lead', '736512');
  const qlId = await add('Hậu', 'manager', '736511');
  const nvId = await add('Nga', 'staff', '7365', { pay_rate: 20000 });
  const tc = await login('736512');
  const perm = (await o('GET', '/api/permissions')).data;
  const pages = Object.fromEntries(perm.pages.map((p) => [p.path, { roles: p.roles, allow: p.allow, deny: p.deny }]));
  pages['/nhan-vien'].allow = [tcId];
  assert.equal((await o('PUT', '/api/permissions', { pages })).status, 200);
  assert.equal((await tc('GET', '/api/staff')).status, 200);
  assert.equal((await tc('POST', '/api/staff', { name: 'X', role: 'staff', pin: '8264' })).status, 403);
  assert.equal((await tc('PATCH', `/api/staff/${nvId}`, { pin: '9264' })).status, 403);
  assert.equal((await tc('POST', '/api/staff/bulk-pin', { ids: [nvId] })).status, 403);
  // Chủ quán tick riêng "Sửa nhân viên" → sửa được người thấp hơn, không sửa quản lý, không đổi lương
  assert.equal((await o('PUT', '/api/permissions/acts', { staff_id: tcId, overrides: { 'nv.sua': true } })).status, 200);
  assert.equal((await tc('PATCH', `/api/staff/${nvId}`, { name: 'Nga B', pay_rate: 99000 })).status, 200);
  assert.equal((await tc('PATCH', `/api/staff/${qlId}`, { pin: '927351' })).status, 403);
  const nga = (await o('GET', '/api/staff')).data.find((x) => x.id === nvId);
  assert.equal(nga.name, 'Nga B'); assert.equal(nga.pay_rate, 20000, 'lương giữ nguyên');
});

test('chấm công: trưởng ca không tự sửa của mình / người cấp cao; đổi giờ thì tăng ca phải duyệt lại, tính lại phút trễ', async (t) => {
  let now = at('2026-10-27', '14:00');
  const { db, o, add, login } = await setup(t, { now: () => now });
  const tcId = await add('Phong', 'shift_lead', '736512');
  const qlId = await add('Hậu', 'manager', '736511');
  const nvId = await add('Nga', 'staff', '7365');
  db.prepare("INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at) VALUES ('g1', ?, NULL, '2026-10-27', 840, 1380, 0)").run(nvId);
  const tc = await login('736512');
  const nv = await login('7365');
  assert.equal((await tc('POST', '/api/attendance', { staff_id: tcId, clock_in: '2026-10-27T08:00', clock_out: '2026-10-27T12:00' })).status, 403);
  assert.equal((await tc('POST', '/api/attendance', { staff_id: qlId, clock_in: '2026-10-27T08:00', clock_out: '2026-10-27T12:00' })).status, 403);
  const own = (await o('POST', '/api/attendance', { staff_id: tcId, clock_in: '2026-10-27T08:00', clock_out: '2026-10-27T12:00' })).data.id;
  assert.equal((await tc('PATCH', `/api/attendance/${own}`, { clock_out: '2026-10-27T18:00' })).status, 403);

  assert.equal((await nv('POST', '/api/attendance/clock-in')).status, 200);
  now = at('2026-10-27', '23:40');
  assert.equal((await nv('POST', '/api/attendance/clock-out')).status, 200);
  const rec = db.prepare('SELECT * FROM attendance WHERE staff_id = ?').get(nvId);
  assert.equal(rec.late_minutes, 0);
  assert.equal((await o('POST', `/api/attendance/${rec.id}/overtime`, { approve: true })).status, 200);
  assert.equal(db.prepare('SELECT ot_status FROM attendance WHERE id = ?').get(rec.id).ot_status, 'approved');
  assert.equal((await tc('PATCH', `/api/attendance/${rec.id}`, { clock_in: '2026-10-27T14:20', clock_out: '2026-10-27T23:59' })).status, 200);
  const after = db.prepare('SELECT ot_status, late_minutes FROM attendance WHERE id = ?').get(rec.id);
  assert.equal(after.ot_status, '', 'phải duyệt lại tăng ca');
  assert.equal(after.late_minutes, 20);
  // Sửa ghi chú (không đổi giờ) → giữ nguyên
  await o('POST', `/api/attendance/${rec.id}/overtime`, { approve: true });
  assert.equal((await tc('PATCH', `/api/attendance/${rec.id}`, { note: 'ok' })).status, 200);
  assert.equal(db.prepare('SELECT ot_status FROM attendance WHERE id = ?').get(rec.id).ot_status, 'approved');
});

test('khoá máy chấm công: đã đăng ký máy mà gửi lên không có mã máy → coi như máy lạ; lần đầu không mã máy vẫn chấm được', async (t) => {
  const { app, add, mk } = await setup(t);
  app.ctx.setSetting('clock_require_shift', '0');
  await add('A', 'staff', '583920');
  await add('B', 'staff', '692031');
  const A = mk({ 'x-device': 'phoneA-123456' });
  await A('POST', '/api/login', { pin: '583920' });
  assert.equal((await A('POST', '/api/attendance/clock-in')).status, 200);
  await A('POST', '/api/attendance/clock-out', { confirm: true });
  const Anone = mk(); await Anone('POST', '/api/login', { pin: '583920' });
  const r = await Anone('POST', '/api/attendance/clock-in', { confirm: true });
  assert.equal(r.status, 403); assert.match(r.data.error, /không phải điện thoại đã đăng ký/);
  // B chưa đăng ký máy, trình duyệt không lưu được mã → không bị khoá
  const Bnone = mk(); await Bnone('POST', '/api/login', { pin: '692031' });
  assert.equal((await Bnone('POST', '/api/attendance/clock-in')).status, 200);
});

test('đơn nghỉ 1 khúc: huỷ thì gộp lại ca gốc; ca đã qua không bị tách; quản lý không tự duyệt đơn của mình', async (t) => {
  let now = at('2026-10-27', '07:00');
  const { db, app, o, add, login } = await setup(t, { now: () => now });
  const nvId = await add('Nga', 'staff', '7365');
  const qlId = await add('Hậu', 'manager', '736511');
  const ins = db.prepare("INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at) VALUES (?, ?, NULL, ?, ?, ?, 0)");
  ins.run('gA', nvId, '2026-10-27', 480, 720); ins.run('gA', nvId, '2026-10-27', 840, 1380);
  const nv = await login('7365');
  const l1 = app.ctx.createLeave(null, 'gA', 'bận sáng', { from: 480, to: 720 });
  assert.equal(db.prepare("SELECT COUNT(DISTINCT group_id) AS n FROM assignments WHERE staff_id = ?").get(nvId).n, 2);
  assert.equal((await nv('POST', `/api/leave/${l1.id}/cancel`)).status, 200);
  assert.deepEqual(db.prepare('SELECT DISTINCT group_id FROM assignments WHERE staff_id = ?').all(nvId).map((x) => x.group_id), ['gA']);

  // Khúc sáng đã qua → báo lỗi, ca không bị tách
  now = at('2026-10-27', '13:00');
  assert.throws(() => app.ctx.createLeave(null, 'gA', 'x', { from: 480, to: 720 }), /đã qua/);
  assert.deepEqual(db.prepare('SELECT DISTINCT group_id FROM assignments WHERE staff_id = ?').all(nvId).map((x) => x.group_id), ['gA']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE staff_id = ?').get(nvId).n, 2);

  // Quản lý tự xin nghỉ rồi tự duyệt → chặn; chủ quán duyệt được
  ins.run('gQ', qlId, '2026-10-28', 840, 1380);
  const ql = await login('736511');
  const lq = (await ql('POST', '/api/leave', { group_id: 'gQ', reason: 'ốm' })).data.id;
  assert.equal((await ql('POST', `/api/leave/${lq}/decide`, { approve: true })).status, 403);
  assert.equal((await o('POST', `/api/leave/${lq}/decide`, { approve: true })).status, 200);
});
