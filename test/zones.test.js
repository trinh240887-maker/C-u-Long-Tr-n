import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';
import { parseTableList, formatTableList } from '../server/lib/tables.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));


async function setup(t, now) {
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
}

test('gộp tổ Bếp steak + Lẩu thành bộ phận Bếp, xếp ca theo vị trí', async (t) => {
  const now = at('2026-10-19', '09:00');
  const mk = await setup(t, now);
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const teams = (await o('GET', '/api/teams')).data;
  const steak = teams.find((x) => x.name === 'Bếp steak').id;
  const lau = teams.find((x) => x.name === 'Lẩu').id;
  const bar = teams.find((x) => x.name === 'Bar').id;
  const phat = (await o('POST', '/api/staff', { name: 'Phát', team_id: lau, pin: '4821', skills: [{ team_id: steak, level: 2 }] })).data.id;
  const dat = (await o('POST', '/api/staff', { name: 'Đạt', team_id: steak, pin: '5932' })).data.id;
  const tu = (await o('POST', '/api/staff', { name: 'Tú', team_id: bar, pin: '6143', skills: [{ team_id: lau, level: 1 }] })).data.id;
  const seg = [{ start: '17:00', end: '22:00' }];
  assert.equal((await o('POST', '/api/shifts', { staff_id: phat, date: '2026-10-20', segments: seg })).status, 200);

  const res = await o('POST', '/api/teams/combine', { name: 'Bếp', team_ids: [steak, lau] });
  assert.equal(res.status, 200);
  const after = (await o('GET', '/api/teams')).data;
  const bep = after.find((x) => x.name === 'Bếp' && x.active);
  assert.equal(bep.id, steak);
  assert.deepEqual(bep.positions.map((p) => p.name), ['Bếp steak', 'Lẩu']);
  assert.equal(after.find((x) => x.id === lau).active, 0);
  const posLau = bep.positions.find((p) => p.name === 'Lẩu').id;
  const posSteak = bep.positions.find((p) => p.name === 'Bếp steak').id;
  // Đổi tên vị trí cho gọn, thêm vị trí Nướng
  assert.equal((await o('PATCH', `/api/positions/${posSteak}`, { name: 'Steak', min_staff: 2 })).status, 200);
  const nuong = (await o('POST', '/api/positions', { team_id: bep.id, name: 'Nướng' })).data.id;

  const staff = (await o('GET', '/api/staff')).data;
  const P = staff.find((s) => s.id === phat);
  assert.equal(P.team_id, bep.id);
  assert.equal(P.position_id, posLau);
  assert.deepEqual(P.skills, []); // đã thuộc Bếp, kỹ năng phụ Bếp steak thành kỹ năng vị trí
  assert.deepEqual(P.pskills, [{ position_id: posSteak, level: 2 }]);
  assert.deepEqual(staff.find((s) => s.id === tu).pskills, [{ position_id: posLau, level: 1 }]);
  assert.equal(staff.find((s) => s.id === dat).position_id, posSteak);

  // Ca cũ chuyển theo; ca mới không chọn vị trí thì lấy vị trí chính, chọn được vị trí khác trong bộ phận
  let wk = (await o('GET', '/api/schedule?week=2026-10-19')).data;
  assert.equal(wk.shifts[0].team_id, bep.id);
  assert.equal(wk.shifts[0].position_name, 'Lẩu');
  assert.equal((await o('POST', '/api/shifts', { staff_id: dat, date: '2026-10-20', segments: seg, position_id: nuong })).status, 200);
  assert.equal((await o('POST', '/api/shifts', { staff_id: dat, date: '2026-10-21', segments: seg })).status, 200);
  assert.equal((await o('POST', '/api/shifts', { staff_id: tu, date: '2026-10-21', segments: seg, team_id: bep.id, position_id: posLau })).status, 200);
  const other = (await o('GET', '/api/positions')).data.find((p) => p.team_id !== bep.id);
  if (other) assert.equal((await o('POST', '/api/shifts', { staff_id: dat, date: '2026-10-22', segments: seg, position_id: other.id })).status, 400);
  wk = (await o('GET', '/api/schedule?week=2026-10-19')).data;
  const shiftOf = (id, d) => wk.shifts.find((s) => s.staff_id === id && s.date === d);
  assert.equal(shiftOf(dat, '2026-10-20').position_name, 'Nướng');
  assert.equal(shiftOf(dat, '2026-10-21').position_name, 'Steak');
  assert.equal(wk.coverage['2026-10-21'][`p${posLau}`], 1);
  assert.equal(wk.coverage['2026-10-21'][bep.id], 2);
  assert.ok(wk.warnings.some((w) => w.position_id === posSteak && w.date === '2026-10-20')); // Steak cần 2, ngày 20 không có ai
});

test('lần đầu chạy: tự gộp các tổ bếp (Bếp steak, Lẩu, topping, tiếp thực) thành bộ phận Bếp', async (t) => {
  const now = at('2026-10-19', '09:00');
  const db = openDb(':memory:', { now });
  db.prepare("INSERT INTO teams (name, sort) VALUES ('topping', 7), ('tiếp thực', 8)").run();
  const lau = db.prepare("SELECT id FROM teams WHERE name = 'Lẩu'").get().id;
  db.prepare("INSERT INTO staff (name, role, team_id, created_at) VALUES ('Phát', 'team_lead', (SELECT id FROM teams WHERE name = 'tiếp thực'), 0), ('Dũng', 'staff', ?, 0)").run(lau);
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  t.after(() => app.close());
  const active = db.prepare('SELECT name FROM teams WHERE active = 1 ORDER BY sort, id').all().map((x) => x.name);
  assert.deepEqual(active, ['Bếp', 'Bar', 'Phục vụ', 'Thu ngân', 'Tạp vụ']);
  const bep = db.prepare("SELECT id FROM teams WHERE name = 'Bếp' AND active = 1").get().id;
  const pos = db.prepare('SELECT name FROM positions WHERE team_id = ? AND active = 1 ORDER BY sort, id').all(bep).map((x) => x.name);
  assert.deepEqual(pos, ['Steak', 'Lẩu', 'Topping', 'Tiếp thực', 'Nướng']);
  const phat = db.prepare("SELECT s.team_id, p.name FROM staff s JOIN positions p ON p.id = s.position_id WHERE s.name = 'Phát'").get();
  assert.equal(phat.team_id, bep);
  assert.equal(phat.name, 'Tiếp thực');
  // Chỉ gộp một lần: tạo lại tổ "Lẩu" sau đó thì không tự gộp nữa
  db.prepare("INSERT INTO teams (name) VALUES ('Lẩu'), ('topping'), ('tiếp thực')").run();
  createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } }).close();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM teams WHERE name = 'Lẩu' AND active = 1").get().n, 1);
});

test('đọc và viết danh sách bàn', () => {
  assert.deepEqual(parseTableList('1-3, 5 7-8'), [1, 2, 3, 5, 7, 8]);
  assert.equal(formatTableList([8, 1, 2, 3, 5, 7]), '1-3, 5, 7-8');
  assert.deepEqual(parseTableList(''), []);
  assert.throws(() => parseTableList('a-b'), /Không hiểu/);
  assert.throws(() => parseTableList('5-2'), /không hợp lệ/);
});

test('khu A/B/C, xếp người phụ trách khu & bàn, sơ đồ bàn hiện đúng người', async (t) => {
  let now = at('2026-10-19', '18:00');
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
  const o = mk();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const zones = (await o('GET', '/api/zones')).data;
  assert.deepEqual(zones.map((z) => [z.name, z.tables_text]), [['Khu A', '1-40'], ['Khu B', '41-80'], ['Khu C', '81-100']]);
  const [A, B] = zones;
  // Khu A chỉ có 20 bàn; không lấy được bàn đang thuộc khu B
  assert.equal((await o('PATCH', `/api/zones/${A.id}`, { tables: '1-20' })).status, 200);
  assert.equal((await o('PATCH', `/api/zones/${A.id}`, { tables: '1-20, 45' })).status, 409);

  const team = (await o('GET', '/api/teams')).data.find((x) => x.name === 'Phục vụ').id;
  const lan = (await o('POST', '/api/staff', { name: 'Lan', team_id: team, pin: '4821' })).data.id;
  const minh = (await o('POST', '/api/staff', { name: 'Minh', team_id: team, pin: '5932' })).data.id;
  const seg = [{ start: '17:00', end: '22:00' }];
  assert.equal((await o('POST', '/api/shifts', { staff_id: lan, date: '2026-10-19', segments: seg, zone_id: A.id, tables_text: '1-10' })).status, 200);
  assert.equal((await o('POST', '/api/shifts', { staff_id: minh, date: '2026-10-19', segments: seg, zone_id: A.id, tables_text: '30' })).status, 400); // bàn 30 không còn ở khu A
  assert.equal((await o('POST', '/api/shifts', { staff_id: minh, date: '2026-10-19', segments: seg, zone_id: B.id })).status, 200);

  const lanC = mk();
  await lanC('POST', '/api/login', { pin: '4821' });
  const floor = (await lanC('GET', '/api/floor')).data;
  const zA = floor.zones.find((z) => z.id === A.id);
  const zB = floor.zones.find((z) => z.id === B.id);
  assert.deepEqual(zA.tables.find((x) => x.number === 5).people, ['Lan']);
  assert.equal(zA.tables.find((x) => x.number === 5).mine, true);
  assert.deepEqual(zA.tables.find((x) => x.number === 15).people, []);
  assert.deepEqual(zB.tables.find((x) => x.number === 60).people, ['Minh']);
  assert.equal(zA.on_now[0].tables_text, '1-10');
  const my = (await lanC('GET', '/api/my-shifts')).data[0];
  assert.equal(my.zone_name, 'Khu A');
  assert.equal(my.tables_text, '1-10');
  // Hết ca thì không còn ai phụ trách
  now = at('2026-10-19', '23:00');
  assert.deepEqual((await lanC('GET', '/api/floor')).data.zones.find((z) => z.id === A.id).tables.find((x) => x.number === 5).people, []);
});
