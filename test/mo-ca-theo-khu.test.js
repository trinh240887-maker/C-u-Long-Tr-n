import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Mở ca phục vụ theo khu: việc riêng từng khu chỉ sinh thẻ cho khu đó; nhân sự khung 14–15h30 theo khu (cả người chưa có bộ phận)', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const tpl = db.prepare("SELECT id FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get().id;
  const [za, zb] = db.prepare('SELECT id FROM zones WHERE active = 1 ORDER BY sort, id').all().map((z) => z.id);
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const a = (await O('POST', '/api/staff', { name: 'Phát', team_id: pv, pin: '5821' })).data.id;
  const lead = (await O('POST', '/api/staff', { name: 'Thiện', pin: '5822' })).data.id; // chưa có bộ phận
  await O('PATCH', `/api/staff/${lead}`, { home_zone_id: za });
  const today = app.ctx.today();
  const ins = (sid, zone) => db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at, zone_id) VALUES (?, ?, ?, ?, 840, 1380, 0, ?)').run(`g${sid}`, sid, pv, today, zone);
  ins(a, za); ins(lead, null);
  const add = await O('POST', `/api/checklist-templates/${tpl}/items`, { text: 'Lau kính khu A', zone_id: za });
  assert.equal(add.status, 200);
  const day = (await O('GET', '/api/checklists')).data;
  const card = day.jobs.find((j) => j.template_id === tpl);
  assert.equal(card.opening_tpl, true);
  assert.equal(card.item_list.find((i) => i.id === add.data.id).job_zone_id, za);
  const inA = day.opening.people.filter((x) => x.zone_id === za).map((x) => x.name).sort();
  assert.deepEqual(inA, ['Phát', 'Thiện']);
  await O('GET', '/api/jobs/board');
  const zonesOf = db.prepare('SELECT DISTINCT zone_id FROM jobs WHERE item_id = ?').all(add.data.id).map((x) => x.zone_id);
  assert.deepEqual(zonesOf, [za]);
  assert.ok(!zonesOf.includes(zb));
  assert.equal((await O('POST', `/api/checklist-items/${add.data.id}/delete`, {})).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE id = ?').get(add.data.id).n, 0);
});
