import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Checklist: gom Phục vụ + Tiếp thực 1 mục; đầu ca 14:00–15:30 đếm người, ghi chú ca ngắn về ≤ 18h; báo trước giờ mở ca', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const sent = [];
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  app.ctx.notify = (ids, msg) => { sent.push(msg); };
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const O = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const pv = db.prepare("SELECT id FROM teams WHERE name = 'Phục vụ'").get().id;
  const tt = Number(db.prepare("INSERT INTO teams (name) VALUES ('Tiếp thực')").run().lastInsertRowid);
  const date = app.ctx.today();
  const mk = (name, team, segs) => { const id = db.prepare("INSERT INTO staff (name, role, team_id, created_at) VALUES (?, 'staff', ?, 1)").run(name, team).lastInsertRowid; segs.forEach(([a, b], i) => db.prepare('INSERT INTO assignments (group_id, staff_id, team_id, date, start_min, end_min, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)').run(`g${id}`, id, team, date, a * 60, b * 60)); return id; };
  mk('PV Một', pv, [[14, 23]]);
  mk('PV Hai', pv, [[14, 18], [21, 23]]);
  mk('TT Ba', tt, [[14, 18]]);
  mk('PV Tối', pv, [[17, 23]]);
  db.prepare("INSERT INTO checklist_templates (team_id, phase, title) VALUES (?, 'open', 'Mở ca tiếp thực')").run(tt);
  const d = (await O('GET', `/api/checklists?date=${date}`)).data;
  assert.equal(d.opening.total, 3);
  assert.equal(d.opening.pv, 2);
  assert.equal(d.opening.tt, 1);
  assert.deepEqual(d.opening.short.map((x) => x.name).sort(), ['PV Hai', 'TT Ba']);
  assert.equal(d.opening.short.find((x) => x.name === 'PV Hai').shift, '14h–18h + 21h–23h');
  assert.ok(d.runs.some((r) => r.section === 'Phục vụ & Tiếp thực'));
  assert.ok(d.opening.zones.length >= 1);
  assert.equal(d.opening.zones.reduce((n, z) => n + z.people.length, 0), 3);
  assert.ok(!d.runs.some((r) => r.section === 'Tiếp thực'));
  // Báo trước giờ mở ca (gọi lúc đã qua 13:50)
  app.ctx.clock().minuteOf(Date.now()) >= 830 ? app.ctx.openingTick() : null;
  if (app.ctx.clock().minuteOf(Date.now()) >= 830) assert.ok(sent.some((x) => /Đầu ca 14h–15h30: 3 người \(PV 2 · TT 1\)/.test(x.title)));
});
