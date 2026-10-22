import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));

test('khách tự đặt bàn online: chờ xác nhận → nhân viên chọn bàn xác nhận / từ chối, khách xem & huỷ bằng mã, chống spam', async (t) => {
  let now = at('2026-10-24', '10:00');
  const db = openDb(':memory:', { now });
  const sent = [];
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  app.ctx.customerNotify = async (x, kind) => { sent.push({ kind, phone: x.phone, tables: x.tables }); return { ok: true }; };
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  // Trang công khai mở được không cần đăng nhập
  const page = await fetch(`${base}/datban`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Đặt bàn/);
  const info = (await call('GET', '/api/public/booking/info')).data;
  assert.equal(info.enabled, true);
  const slots = (await call('GET', '/api/public/booking/slots?date=2026-10-24&guests=4')).data.slots;
  assert.equal(slots.find((s) => s.time === '10:30').ok, false, 'đặt trước ít nhất 60 phút');
  assert.equal(slots.find((s) => s.time === '19:00').ok, true);
  // Sai số điện thoại / quá giờ
  assert.equal((await call('POST', '/api/public/booking', { name: 'Lan', phone: '123', guests: 4, date: '2026-10-24', time: '19:00' })).status, 400);
  assert.equal((await call('POST', '/api/public/booking', { name: 'Lan', phone: '0909123456', guests: 4, date: '2026-10-24', time: '23:30' })).status, 400);
  assert.equal((await call('POST', '/api/public/booking', { name: 'Lan', phone: '0909123456', guests: 60, date: '2026-10-24', time: '19:00' })).status, 400);
  // Đặt đúng
  const r = await call('POST', '/api/public/booking', { name: 'Chị Lan', phone: '+84 909 123 456', guests: 4, date: '2026-10-24', time: '19:00', note: 'Sinh nhật' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.code, /^[0-9A-F]{8}$/);
  const x = db.prepare('SELECT * FROM reservations WHERE code = ?').get(r.data.code);
  assert.equal(x.status, 'requested');
  assert.equal(x.phone, '0909123456');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE title LIKE 'Khách đặt online: Chị Lan%' AND urgent = 1").get());
  // Cùng SĐT đặt trùng ngày → chặn; ô bẫy → im lặng bỏ qua
  assert.equal((await call('POST', '/api/public/booking', { name: 'Lan', phone: '0909123456', guests: 2, date: '2026-10-24', time: '20:00' })).status, 409);
  const before = db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n;
  await call('POST', '/api/public/booking', { name: 'Bot', phone: '0911111111', guests: 2, date: '2026-10-24', time: '20:00', website: 'http://spam' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, before);
  // Đơn chờ xác nhận chưa giữ bàn trên sơ đồ
  const login = await call('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const cookie = login.res.headers.get('set-cookie').split(';')[0];
  // Khách xem trạng thái
  let st = (await call('GET', `/api/public/booking/status?code=${r.data.code}`)).data;
  assert.equal(st.status, 'requested');
  assert.equal(st.phone_tail, '456');
  assert.equal((await call('GET', '/api/public/booking/status?code=ZZZZZZZZ')).status, 404);
  // Nhân viên xác nhận, chọn bàn → báo khách qua Zalo
  assert.equal((await call('POST', `/api/reservations/${x.id}/confirm`, {}, cookie)).status, 400, 'phải chọn bàn');
  const ok = await call('POST', `/api/reservations/${x.id}/confirm`, { tables: '81' }, cookie);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.notified, true);
  assert.deepEqual(sent.at(-1), { kind: 'confirm', phone: '0909123456', tables: '81' });
  st = (await call('GET', `/api/public/booking/status?code=${r.data.code}`)).data;
  assert.equal(st.status, 'booked');
  assert.equal(st.tables, '81');
  // Đơn thứ 2 cùng giờ muốn bàn 81 → bàn đã giữ
  const r2 = await call('POST', '/api/public/booking', { name: 'Anh Minh', phone: '0912345678', guests: 2, date: '2026-10-24', time: '19:30' });
  const x2 = db.prepare('SELECT id FROM reservations WHERE code = ?').get(r2.data.code);
  assert.equal((await call('POST', `/api/reservations/${x2.id}/confirm`, { tables: '81' }, cookie)).status, 409);
  // Từ chối (bắt lý do) → báo khách
  assert.equal((await call('POST', `/api/reservations/${x2.id}/reject`, {}, cookie)).status, 400);
  await call('POST', `/api/reservations/${x2.id}/reject`, { reason: 'Khung giờ này kín bàn, mời anh đến 20:30' }, cookie);
  assert.equal(sent.at(-1).kind, 'reject');
  assert.match((await call('GET', `/api/public/booking/status?code=${r2.data.code}`)).data.reason, /kín bàn/);
  // Khách tự huỷ đơn đã xác nhận → bàn trả lại, nhân viên nhận báo
  assert.equal((await call('POST', '/api/public/booking/cancel', { code: r.data.code })).data.status, 'cancelled');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE title LIKE 'Khách huỷ đặt bàn: Chị Lan%'").get());
  // Đơn chờ quá 15′ → nhắc quản lý 1 lần
  const r3 = await call('POST', '/api/public/booking', { name: 'Cô Ba', phone: '0933333333', guests: 6, date: '2026-10-25', time: '18:30' });
  assert.equal(r3.status, 200);
  now += 16 * 60_000;
  assert.equal(await app.ctx.bookingTick(), 1);
  assert.equal(await app.ctx.bookingTick(), 0);
  // Chống spam: 1 máy tối đa 5 đơn / giờ
  let last;
  for (let i = 0; i < 4; i++) last = await call('POST', '/api/public/booking', { name: `K${i}`, phone: `094000000${i}`, guests: 2, date: '2026-10-26', time: '19:00' });
  assert.equal(last.status, 429);
});
