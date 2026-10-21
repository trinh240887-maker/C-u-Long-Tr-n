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
