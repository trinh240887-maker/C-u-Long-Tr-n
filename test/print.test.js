import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { ticketBytes, noAccent } from '../server/lib/escpos.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(200); }
  throw new Error('quá thời gian chờ');
}
// Máy in giả: nhận byte qua TCP như máy in thật cổng 9100
async function fakePrinter() {
  const got = [];
  const srv = net.createServer((s) => { const chunks = []; s.on('data', (c) => chunks.push(c)); s.on('end', () => { const b = Buffer.concat(chunks); if (b.length) got.push(b); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, got, close: () => srv.close() };
}

test('phiếu in: không dấu, có tiêu đề HUỶ / ƯU TIÊN, cắt giấy', () => {
  assert.equal(noAccent('Bàn 20 – Sốt tiêu đen, Đậu'), 'Ban 20 - Sot tieu den, Dau');
  const b = ticketBytes({ id: 7, station_name: 'Steak', kind: 'cancel', priority: 0, header: 'KHU A - 20', lines: [{ qty: 2, name: 'Combo 2', options: ['Tiêu đen'], note: 'Gọi nhầm' }] }, { time: '19:42 24/10', by: 'Hậu' });
  const s = b.toString('latin1');
  for (const x of ['Steak', 'HUY MON', 'KHU A - 20', '2 x Combo 2', '- Tieu den', '* Goi nham', 'Hau', '#7']) assert.ok(s.includes(x), x);
  assert.deepEqual([...b.subarray(-4)], [0x1d, 0x56, 66, 0]);
  assert.ok(ticketBytes({ id: 1, station_name: 'Bò', kind: 'add', lines: [{ qty: 1, name: 'Bò' }] }, { mode: 'utf8' }).toString('utf8').includes('GỌI THÊM'));
});

test('cầu in: lấy phiếu, in đúng máy, máy chưa có IP in sang dự phòng, máy hỏng báo quản lý, in lại', async (t) => {
  const now = Date.now();
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => Date.now(), publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const steak = await fakePrinter();
  const bar = await fakePrinter();
  let bridge;
  t.after(() => { bridge?.kill(); steak.close(); bar.close(); app.close(); server.close(); });
  let cookie = '';
  const o = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const menu = (await o('GET', '/api/menu')).data;
  const S = Object.fromEntries(menu.stations.map((s) => [s.name, s.id]));
  // Steak + Pha chế là máy giả; Topping trỏ vào cổng chết; Ưu tiên chưa có IP → in sang Steak
  await o('PATCH', `/api/kitchen-stations/${S.Steak}`, { printer_ip: '127.0.0.1', printer_port: steak.port });
  await o('PATCH', `/api/kitchen-stations/${S['Pha chế']}`, { printer_ip: '127.0.0.1', printer_port: bar.port });
  await o('PATCH', `/api/kitchen-stations/${S['Topping – Nướng – Rau']}`, { printer_ip: '127.0.0.1', printer_port: 1 });

  // Chưa có mã → bị chặn
  assert.equal((await fetch(`${base}/api/print/jobs`)).status, 401);
  const st0 = (await o('GET', '/api/print/status')).data;
  assert.equal(st0.bridge_online, false);
  const bat = await o('GET', '/api/print/setup.bat');
  assert.ok(bat.data.includes(`--token ${st0.token}`) && bat.data.includes('cau-in/cau-in.js'));

  const item = (n) => menu.items.find((i) => i.name === n);
  const sid = (await o('POST', '/api/pos/sessions', { tables: [20] })).data.id;
  await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item('Combo 2').id, option_ids: [item('Combo 2').options[0].id], qty: 2 });
  await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item('Trà đào').id });
  await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item('Steak Âu').id, option_ids: [item('Steak Âu').options[0].id], rush: true });
  await o('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: item('Mì trứng 2 vắt').id });
  await o('POST', `/api/pos/sessions/${sid}/send`);
  await o('POST', '/api/print/test', { station_id: S['Pha chế'] });

  bridge = spawn(process.execPath, [path.join(here, '..', 'public', 'cau-in', 'cau-in.js'), '--url', base, '--token', st0.token], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  bridge.stdout.on('data', (c) => { out += c; });
  bridge.stderr.on('data', (c) => { out += c; });

  // Steak nhận 2 phiếu (Steak + Ưu tiên in sang), Pha chế nhận phiếu Trà đào + phiếu in thử
  await until(() => steak.got.length >= 2 && bar.got.length >= 2).catch((e) => { throw new Error(out + JSON.stringify(db.prepare('SELECT id, station_id, print_status, attempts, print_error FROM kitchen_tickets').all()) + steak.got.length + '/' + bar.got.length); });
  const sTxt = steak.got.map((b) => b.toString('latin1')).join('\n');
  assert.ok(sTxt.includes('2 x Combo 2') && sTxt.includes('UU TIEN') && sTxt.includes('Steak Au'), sTxt);
  const bTxt = bar.got.map((b) => b.toString('latin1')).join('\n');
  assert.ok(bTxt.includes('Tra dao') && bTxt.includes('IN THU'));
  // Topping hỏng: thử 3 lần rồi báo lỗi, quản lý nhận thông báo
  await until(() => db.prepare("SELECT 1 FROM kitchen_tickets WHERE print_status = 'failed'").get(), 20000);
  const st = (await o('GET', '/api/print/status')).data;
  assert.equal(st.bridge_online, true);
  assert.equal(st.failed.length, 1);
  assert.ok(st.failed[0].station_name.startsWith('Topping'));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE title LIKE 'Không in được phiếu%' AND urgent = 1").get());
  assert.equal(st.tests[0].status, 'printed');
  // Sửa máy (trỏ sang máy giả) rồi bấm In lại
  await o('PATCH', `/api/kitchen-stations/${S['Topping – Nướng – Rau']}`, { printer_port: bar.port });
  await o('POST', '/api/print/retry', { id: 'all' });
  await until(() => bar.got.some((b) => b.toString('latin1').includes('Mi trung')));
  await until(() => !db.prepare("SELECT 1 FROM kitchen_tickets WHERE print_status != 'printed'").get());
  // Tình trạng máy: cầu in đã kiểm tra kết nối
  await until(async () => (await o('GET', '/api/print/status')).data.stations.find((s) => s.name === 'Steak').ok === true);
  assert.ok(out.includes('Cầu in đang chạy'), out);
});

test('theo dõi từ xa: /api/version đúng mã code; máy in ở quán mất kết nối thì báo quản lý 1 lần, kết nối lại thì báo', async (t) => {
  const { codeHash } = await import('../server/lib/version.js');
  let now = Date.now();
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { app.close(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const v = await (await fetch(`${base}/api/version`)).json();
  assert.equal(v.version, codeHash(path.join(here, '..')));
  // Chưa cài cầu in lần nào → không báo
  assert.equal(app.ctx.printTick(), 0);
  app.ctx.setSetting('print_bridge_seen', now - 5 * 60_000);
  const sid = Number(db.prepare('INSERT INTO table_sessions (opened_at) VALUES (?)').run(now).lastInsertRowid);
  db.prepare("INSERT INTO kitchen_tickets (session_id, station_id, kind, header, lines, created_at) VALUES (?, 1, 'new', 'KHU A - 1', '[]', ?)").run(sid, now - 3 * 60_000);
  assert.equal(app.ctx.printTick(), 1);
  assert.equal(app.ctx.printTick(), 0, 'không báo lặp');
  app.ctx.setSetting('print_bridge_seen', now);
  app.ctx.printTick();
  const titles = db.prepare("SELECT n.title FROM notifications n JOIN staff s ON s.id = n.staff_id WHERE s.role = 'owner' ORDER BY n.id").all().map((x) => x.title);
  assert.ok(titles.some((x) => x.startsWith('Máy in phiếu ở quán mất kết nối: 1 phiếu')));
  assert.ok(titles.includes('Máy in phiếu ở quán đã kết nối lại'));
});
