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

test('kín bàn: chờ dọn, mời nhóm vừa chỗ (nhóm nhỏ không chờ nhóm đông), Zalo báo có bàn, mời quá hạn, giữ bàn ghép cho nhóm đông, cảnh báo bàn lớn', async (t) => {
  let now = at('19:00');
  const db = openDb(':memory:', { now });
  const sent = [];
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  app.ctx.customerNotify = async (x, kind) => { sent.push({ kind, name: x.name, tables: x.tables, queue_no: x.queue_no }); return { ok: true }; };
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  cookie = (await call('POST', '/api/login', { pin: DEFAULT_OWNER_PIN })).res.headers.get('set-cookie').split(';')[0];
  const tables = db.prepare('SELECT number, seats, zone_id FROM dining_tables ORDER BY number').all();
  const sid = new Map();
  for (const x of tables) sid.set(x.number, (await call('POST', '/api/pos/sessions', { tables: [x.number], override_soon: true })).data.id);
  const note = (re) => db.prepare('SELECT title, body FROM notifications ORDER BY id').all().filter((x) => re.test(x.title));
  const close = (n) => db.prepare("UPDATE table_sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(now, sid.get(n));
  const summary = async () => (await call('GET', '/api/pos/tables')).data.summary;

  // Hết bàn: nhóm 8 người đến trước, nhóm 2 người (có SĐT) đến sau
  const big = (await call('POST', '/api/reservations', { kind: 'walkin', name: 'Nhóm 8', guests: 8, date: D })).data.id;
  now += 60_000;
  const small = (await call('POST', '/api/reservations', { kind: 'walkin', name: 'Chị Hoa', phone: '0909111222', guests: 2, date: D })).data.id;
  await app.ctx.waitTick();
  assert.equal(sent.filter((x) => x.kind === 'queue' && x.name === 'Chị Hoa').length, 1, 'Zalo báo số thứ tự');

  // 1 bàn 4 chỗ vừa tính tiền → chờ dọn; nhóm 2 người được mời ngay (không phải chờ nhóm 8)
  const four = tables.find((x) => x.seats === 4 && x.seats < 8);
  close(four.number);
  let s = await summary();
  assert.equal(s.dirty, 1);
  const tbl = (await call('GET', '/api/pos/tables')).data.zones.flatMap((z) => z.tables).find((x) => x.number === four.number);
  assert.equal(tbl.dirty, 0);
  await app.ctx.waitTick();
  assert.equal(note(new RegExp(`^Dọn ngay bàn ${four.number}$`)).length, 1);
  assert.equal(note(new RegExp(`^Bàn ${four.number} → mời Chị Hoa`)).length, 1);
  assert.equal(sent.filter((x) => x.kind === 'ready' && x.name === 'Chị Hoa').length, 1, 'Zalo báo có bàn');
  s = await summary();
  const q = s.queue.find((x) => x.id === small);
  assert.deepEqual(q.suggest, [four.number]);
  assert.equal(s.queue.find((x) => x.id === big).suggest, null);
  // Tick lại không mời trùng
  await app.ctx.waitTick();
  assert.equal(note(/→ mời Chị Hoa/).length, 1);
  // Dọn xong
  assert.equal((await call('POST', `/api/pos/tables/${four.number}/clean`)).status, 200);
  assert.equal((await summary()).dirty, 0);

  // Mời 6′ chưa vào → nhắc nhân viên, nhả bàn
  now += 6 * 60_000;
  await app.ctx.waitTick();
  assert.equal(note(/^Đã mời Chị Hoa 5′ chưa vào/).length, 1);
  // Khách đến → mời vào bàn gợi ý
  const r = await call('POST', `/api/reservations/${small}/arrive`, { tables: String(four.number) });
  assert.equal(r.status, 200);

  // Nhóm 8 chờ ≥ 15′: 2 bàn liền nhau xin tính tiền / trống → giữ dồn cho nhóm 8, không cho nhóm 2 mới lấy
  now = at('19:20');
  const pair = tables.find((x, i) => tables[i + 1] && tables[i + 1].number === x.number + 1 && tables[i + 1].zone_id === x.zone_id && x.seats + tables[i + 1].seats >= 8 && x.number !== four.number && tables[i + 1].number !== four.number);
  close(pair.number);
  db.prepare("UPDATE table_sessions SET status = 'paying' WHERE id = ?").run(sid.get(pair.number + 1));
  const late2 = (await call('POST', '/api/reservations', { kind: 'walkin', name: 'Anh Nam', guests: 2, date: D })).data.id;
  s = await summary();
  const bq = s.queue.find((x) => x.id === big);
  assert.equal(bq.protect, true, JSON.stringify(bq));
  assert.ok(bq.suggest.includes(pair.number));
  assert.equal(s.queue.find((x) => x.id === late2).suggest, null, 'không lấy bàn đang giữ cho nhóm 8');

  // Bàn kia tính tiền xong → mời nhóm 8 vào 2 bàn ghép
  close(pair.number + 1);
  now += 60_000;
  await app.ctx.waitTick();
  assert.equal(note(new RegExp(`^Bàn ${pair.number}, ${pair.number + 1} → mời Nhóm 8`)).length, 1);

  // Bàn xin tính tiền khi có khách chờ → báo dọn chuẩn bị + nhóm vừa chỗ ra cửa
  const payT = tables.find((x) => ![four.number, pair.number, pair.number + 1].includes(x.number));
  db.prepare("UPDATE table_sessions SET status = 'paying' WHERE id = ?").run(sid.get(payT.number));
  await app.ctx.waitTick();
  assert.equal(note(new RegExp(`^Bàn ${payT.number} xin tính tiền: chuẩn bị dọn`)).length, 1);
  assert.deepEqual((await summary()).queue.find((x) => x.id === late2).prep, [payT.number]);

  // Khách chờ bỏ về
  assert.equal((await call('POST', `/api/waitlist/${late2}/gone`)).status, 200);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(late2).status, 'cancelled');

  // Đang có nhóm chờ: nhóm 2 người bấm bàn 6+ chỗ → gợi ý bàn nhỏ
  const bigT = tables.find((x) => ![four.number, pair.number, pair.number + 1].includes(x.number));
  db.prepare('UPDATE dining_tables SET seats = 8 WHERE number = ?').run(bigT.number);
  const smallT = tables.find((x) => x.seats <= 4 && ![four.number, pair.number, pair.number + 1, bigT.number].includes(x.number));
  {
    db.prepare("UPDATE table_sessions SET status = 'closed', closed_at = ? WHERE id IN (?, ?)").run(now - 3600_000, sid.get(bigT.number), sid.get(smallT.number));
    await call('POST', '/api/reservations', { kind: 'walkin', name: 'Chờ thêm', guests: 10, date: D });
    const w = await call('POST', '/api/pos/sessions', { tables: [bigT.number], guests: 2, override_soon: true });
    assert.equal(w.status, 409, JSON.stringify(w.data));
    assert.match(w.data.error, /phí chỗ/);
    assert.equal((await call('POST', '/api/pos/sessions', { tables: [bigT.number], guests: 2, override_soon: true, override_size: true })).status, 200);
  }
});
