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
const D = '2026-10-24';
const at = (hm) => clock.toEpoch(D, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));

test('chống quên đơn đặt: cảnh báo nhận vãng lai, báo 30′, tự chuyển bàn, nhắc khách trễ, tóm tắt đầu ca', async (t) => {
  let now = at('15:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  const login = await call('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  cookie = login.res.headers.get('set-cookie').split(';')[0];
  const tables = db.prepare('SELECT number, seats, zone_id FROM dining_tables ORDER BY number').all();
  assert.ok(tables.length > 5, 'có sơ đồ bàn');
  const T = tables.find((x) => x.seats >= 4).number;
  const note = (re) => db.prepare('SELECT title, body, urgent FROM notifications ORDER BY id').all().filter((x) => re.test(x.title));

  const rv = (await call('POST', '/api/reservations', { name: 'Anh Tuấn', phone: '0909000111', guests: 4, date: D, time: '19:00', tables: String(T) })).data;
  assert.ok(rv.id, 'tạo đơn');

  // 16:00: tóm tắt đầu ca, chỉ gửi 1 lần
  now = at('16:01');
  app.ctx.bookingGuardTick(); app.ctx.bookingGuardTick();
  assert.equal(note(/^Hôm nay 1 bàn đặt/).length, 1);

  // 18:00 nhận khách vãng lai vào bàn đã đặt 19:00 → cảnh báo kèm bàn gợi ý
  now = at('18:00');
  const w = await call('POST', '/api/pos/sessions', { tables: [T] });
  assert.equal(w.status, 409);
  assert.match(w.data.error, /có khách đặt 19:00.*Bàn trống nên dùng/);
  // Nhân viên vẫn bấm nhận (quên / cố tình)
  const s = await call('POST', '/api/pos/sessions', { tables: [T], override_soon: true });
  assert.equal(s.status, 200);

  // 18:30: báo cả ca 30′ trước
  now = at('18:30');
  app.ctx.bookingGuardTick();
  assert.equal(note(/^30′ nữa có khách đặt: Anh Tuấn/).length, 1);

  // 18:40: bàn vẫn còn khách → tự chuyển đơn sang bàn trống khác
  now = at('18:40');
  app.ctx.bookingGuardTick(); app.ctx.bookingGuardTick();
  const moved = db.prepare('SELECT tables FROM reservations WHERE id = ?').get(rv.id).tables;
  assert.notEqual(moved, String(T));
  const m = note(/^Đã chuyển bàn đặt: Anh Tuấn/);
  assert.equal(m.length, 1);
  assert.equal(m[0].urgent, 1);
  // Bàn mới không phải bàn đang có khách
  assert.ok(!db.prepare("SELECT 1 FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE s.status IN ('open','paying') AND t.table_number = ?").get(Number(moved)));

  // Đơn "khách chọn bàn này" → không tự đổi, báo gấp quản lý
  const busyT = new Set(db.prepare("SELECT t.table_number AS n FROM session_tables t JOIN table_sessions s ON s.id = t.session_id WHERE s.status IN ('open','paying')").all().map((x) => x.n));
  const T2 = tables.find((x) => !busyT.has(x.number) && x.number !== T && !String(moved).split(/\D+/).map(Number).includes(x.number)).number;
  const rvF = (await call('POST', '/api/reservations', { name: 'Chị Vân', phone: '0909000333', guests: 2, date: D, time: '19:00', tables: String(T2), fixed_table: true })).data;
  assert.equal((await call('GET', `/api/reservations?date=${D}`)).data.items.find((x) => x.id === rvF.id).fixed_table, true);
  db.prepare('UPDATE reservations SET pre_notified_at = 1 WHERE id = ?').run(rvF.id);
  const sF = await call('POST', '/api/pos/sessions', { tables: [T2], override_soon: true, override_size: true, override_reserved: true });
  assert.equal(sF.status, 200, sF.data?.error);
  app.ctx.bookingGuardTick();
  assert.equal(db.prepare('SELECT tables FROM reservations WHERE id = ?').get(rvF.id).tables, String(T2));
  assert.equal(note(/^GẤP: bàn đặt của Chị Vân còn khách \(khách chọn bàn này\)/).length, 1);
  assert.equal(note(/^Đã chuyển bàn đặt: Chị Vân/).length, 0);

  // 19:15 khách chưa đến → tự huỷ (Không đến), nhả bàn, báo ca (chưa bật Zalo → nhắc gọi khách)
  now = at('19:15');
  app.ctx.bookingGuardTick(); app.ctx.bookingGuardTick();
  await new Promise((r) => setTimeout(r, 20));
  const late = note(/^Tự huỷ bàn đặt: Anh Tuấn trễ 15′/);
  assert.equal(late.length, 1);
  assert.match(late[0].body, /gọi 0909000111/);
  assert.equal(db.prepare("SELECT status FROM reservations WHERE name = 'Anh Tuấn'").get().status, 'no_show');

  // Hết bàn trống → báo gấp quản lý
  const all = db.prepare('SELECT number FROM dining_tables').all().map((x) => x.number).filter((n) => n !== T && n !== T2);
  now = at('20:00');
  const rv2 = (await call('POST', '/api/reservations', { name: 'Chị Mai', phone: '0909000222', guests: 2, date: D, time: '20:30', tables: String(all[0]) })).data;
  for (const n of all) { const r = await call('POST', '/api/pos/sessions', { tables: [n], override_soon: true, override_reserved: true }); assert.equal(r.status, 200, `bàn ${n}: ${r.data?.error}`); }
  now = at('20:12');
  app.ctx.bookingGuardTick();
  assert.equal(note(/^GẤP: bàn đặt của Chị Mai còn khách/).length, 1);
  assert.equal(db.prepare('SELECT tables FROM reservations WHERE id = ?').get(rv2.id).tables, String(all[0]));
});
