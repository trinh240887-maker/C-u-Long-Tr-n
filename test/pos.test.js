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

async function setup(t, start) {
  let now = start;
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
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
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  return { db, mk, setNow: (ms) => { now = ms; } };
}

test('gọi món: mở bàn, bắt chọn sốt, gửi bếp tách phiếu theo máy, bàn ưu tiên ra máy Ưu tiên, huỷ, chuyển & gộp bàn', async (t) => {
  const { db, mk, setNow } = await setup(t, at('2026-10-24', '18:00'));
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Phục vụ').id;
  await o('POST', '/api/staff', { name: 'Hậu', team_id: pv, pin: '4821' });
  const H = mk();
  await H('POST', '/api/login', { pin: '4821' });
  const menu = (await H('GET', '/api/menu')).data;
  const item = (n) => menu.items.find((i) => i.name === n);
  const st = Object.fromEntries(menu.stations.map((s) => [s.id, s.name]));

  const sid = (await H('POST', '/api/pos/sessions', { tables: [20], guests: 4 })).data.id;
  assert.equal((await H('POST', '/api/pos/sessions', { tables: [20], guests: 2 })).status, 409); // bàn đang có khách
  const combo2 = item('Combo 2');
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: combo2.id })).status, 400); // chưa chọn sốt
  const tieuden = combo2.options.find((x) => x.name === 'Tiêu đen').id;
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: combo2.id, option_ids: [tieuden], qty: 2, note: 'chín vừa' })).status, 200);
  await H('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item('Set 2 Mala Tứ Xuyên').id });
  await H('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item('Trà đào').id, qty: 3 });
  let s = (await H('GET', `/api/pos/sessions/${sid}`)).data;
  assert.equal(s.unsent, 3);
  assert.equal(s.subtotal, 79000 * 2 + 150000 + 25000 * 3);
  assert.equal(s.header, 'KHU A - 20');

  assert.equal((await H('POST', `/api/pos/sessions/${sid}/send`)).data.tickets, 5); // Steak, Nước lẩu, Bò, Topping–Nướng–Rau, Pha chế
  const tickets = (await o('GET', '/api/pos/tickets')).data;
  const byStation = Object.fromEntries(tickets.map((k) => [st[k.station_id], k]));
  assert.deepEqual(Object.keys(byStation).sort(), ['Bò', 'Nước lẩu', 'Pha chế', 'Steak', 'Topping – Nướng – Rau']);
  assert.deepEqual(byStation['Steak'].lines[0], { item_id: byStation['Steak'].lines[0].item_id, name: 'Combo 2', qty: 2, options: ['Tiêu đen'], note: 'chín vừa', label: '', rush: false });
  assert.deepEqual(byStation['Topping – Nướng – Rau'].lines.map((l) => l.label), ['Rau tổng hợp', 'Mì trứng 2 vắt']);
  assert.ok(tickets.every((k) => k.kind === 'new' && k.print_status === 'pending' && k.header === 'KHU A - 20'));
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/send`)).status, 400); // không còn món mới

  // Bàn ưu tiên: steak gọi thêm ra máy Ưu tiên, có chữ "add"
  await H('PATCH', `/api/pos/sessions/${sid}`, { priority: true });
  await H('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item('Steak Âu').id, option_ids: [item('Steak Âu').options[0].id] });
  await H('POST', `/api/pos/sessions/${sid}/send`);
  const add = (await o('GET', '/api/pos/tickets')).data[0];
  assert.equal(st[add.station_id], 'Ưu tiên');
  assert.equal(add.kind, 'add');
  assert.equal(add.priority, true);

  // Huỷ: món chưa gửi xoá luôn; món đã gửi cần lý do, quá 2 phút nhân viên không tự huỷ được
  const draft = (await H('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item('Coca').id })).data.id;
  assert.equal((await H('POST', `/api/pos/items/${draft}/cancel`)).data.deleted, true);
  const tra = s.items.find((i) => i.name === 'Trà đào').id;
  assert.equal((await H('POST', `/api/pos/items/${tra}/cancel`)).status, 400);
  setNow(at('2026-10-24', '18:10'));
  assert.equal((await H('POST', `/api/pos/items/${tra}/cancel`, { reason: 'Khách đổi ý' })).status, 403);
  assert.equal((await o('POST', `/api/pos/items/${tra}/cancel`, { reason: 'Khách đổi ý' })).status, 200);
  const cancel = (await o('GET', '/api/pos/tickets')).data[0];
  assert.equal(cancel.kind, 'cancel');
  assert.equal(cancel.lines[0].note, 'Khách đổi ý');
  // Làm lại: in ra máy ưu tiên
  assert.equal((await H('POST', `/api/pos/items/${s.items[0].id}/redo`, { reason: 'Khách chê dai' })).status, 200);
  const redo = (await o('GET', '/api/pos/tickets')).data[0];
  assert.deepEqual([redo.kind, st[redo.station_id]], ['redo', 'Ưu tiên']);
  s = (await H('GET', `/api/pos/sessions/${sid}`)).data;
  assert.equal(s.subtotal, 79000 * 2 + 150000 + 69000);

  // Chuyển bàn 20 → 21, rồi gộp bàn 22 vào
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/move`, { tables: [21] })).status, 200);
  const sid2 = (await H('POST', '/api/pos/sessions', { tables: [22], guests: 2 })).data.id;
  await H('POST', `/api/pos/sessions/${sid2}/items`, { menu_item_id: item('Coca').id });
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/move`, { tables: [22] })).status, 409);
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/merge`, { from_session_id: sid2 })).status, 200);
  s = (await H('GET', `/api/pos/sessions/${sid}`)).data;
  assert.deepEqual(s.tables, [21, 22]);
  assert.equal(s.guests, 6);
  assert.equal(s.unsent, 1);
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/request-bill`)).status, 400); // còn món chưa gửi
  await H('POST', `/api/pos/sessions/${sid}/send`);
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/request-bill`)).status, 200);
  const map = (await H('GET', '/api/pos/tables')).data;
  const t21 = map.zones.flatMap((z) => z.tables).find((x) => x.number === 21);
  assert.equal(t21.session.status, 'paying');
  assert.equal(map.zones.flatMap((z) => z.tables).find((x) => x.number === 20).session, null);
  // Hết món thì không gọi được
  await o('PATCH', `/api/menu/items/${item('Coca').id}`, { sold_out: true });
  assert.equal((await H('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item('Coca').id })).status, 400);
  void db;
});

test('đặt bàn: giữ bàn không trùng giờ, gợi ý bàn, khách đến thì mở bàn, không đến, danh sách chờ', async (t) => {
  const { mk, setNow } = await setup(t, at('2026-10-24', '10:00'));
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  assert.equal((await o('POST', '/api/reservations', { name: 'Anh Hùng', guests: 8, date: '2026-10-24', time: '19:00' })).status, 400); // thiếu SĐT
  const a = await o('POST', '/api/reservations', { name: 'Anh Hùng', phone: '0909 123 456', guests: 8, date: '2026-10-24', time: '19:00', tables: '12-13', priority: true, note: 'Sinh nhật' });
  assert.equal(a.status, 200);
  const clash = await o('POST', '/api/reservations', { name: 'Chị Lan', phone: '0911', guests: 4, date: '2026-10-24', time: '19:30', tables: '13' });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /Anh Hùng lúc 19:00/);
  assert.equal((await o('POST', '/api/reservations', { name: 'Chị Lan', phone: '0911', guests: 4, date: '2026-10-24', time: '21:30', tables: '13' })).status, 200); // giờ khác thì được
  const sug = (await o('GET', '/api/reservations/suggest?date=2026-10-24&time=19:15&guests=6')).data;
  assert.ok(sug.length);
  assert.ok(sug.every((x) => !x.tables.includes(12) && !x.tables.includes(13)));
  assert.ok(sug[0].seats >= 6 && sug[0].tables.length === 2); // bàn 4 chỗ → gộp 2 bàn

  // 18:50 sơ đồ bàn báo bàn 12 sắp có khách đặt
  setNow(at('2026-10-24', '18:50'));
  const t12 = (await o('GET', '/api/pos/tables')).data.zones.flatMap((z) => z.tables).find((x) => x.number === 12);
  assert.equal(t12.reservation.name, 'Anh Hùng');
  const arrive = await o('POST', `/api/reservations/${a.data.id}/arrive`, { guests: 9 });
  assert.equal(arrive.status, 200);
  const s = (await o('GET', `/api/pos/sessions/${arrive.data.session_id}`)).data;
  assert.deepEqual([s.tables, s.guests, s.priority, s.note], [[12, 13], 9, true, 'Sinh nhật']);
  const list = (await o('GET', '/api/reservations?date=2026-10-24')).data;
  assert.equal(list.items.find((x) => x.id === a.data.id).status, 'arrived');
  // Không đến → lịch sử khách
  const lan = list.items.find((x) => x.name === 'Chị Lan');
  assert.equal((await o('PATCH', `/api/reservations/${lan.id}`, { status: 'no_show' })).status, 200);
  const again = await o('POST', '/api/reservations', { name: 'Chị Lan', phone: '0911', guests: 2, date: '2026-10-25', time: '19:00' });
  assert.deepEqual(again.data.history, { arrived: 0, no_show: 1, cancelled: 0 });
  // Danh sách chờ (khách vãng lai, không cần SĐT)
  const w = await o('POST', '/api/reservations', { kind: 'walkin', name: 'Khách áo xanh', guests: 3, date: '2026-10-24' });
  assert.equal(w.status, 200);
  assert.equal((await o('POST', `/api/reservations/${w.data.id}/arrive`, { tables: '30' })).status, 200);
});
