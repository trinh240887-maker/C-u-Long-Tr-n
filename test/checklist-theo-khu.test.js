import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('checklist: khu nào thấy khu đó — trưởng ca / tổ trưởng chỉ thấy checklist bộ phận mình, quản lý thấy hết', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const o = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; };
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const team = (n) => db.prepare('SELECT id FROM teams WHERE name = ?').get(n)?.id ?? Number(db.prepare('INSERT INTO teams (name) VALUES (?)').run(n).lastInsertRowid);
  const bep = team('Bếp steak'), pv = team('Phục vụ');
  db.prepare('UPDATE checklist_templates SET active = 0').run();
  const tpl = (title, teamId) => { const id = Number(db.prepare("INSERT INTO checklist_templates (team_id, phase, title) VALUES (?, 'open', ?)").run(teamId, title).lastInsertRowid); db.prepare("INSERT INTO checklist_items (template_id, text) VALUES (?, 'Việc 1')").run(id); };
  tpl('CK bếp', bep); tpl('CK phục vụ', pv);
  const today = (await o('GET', '/api/me')).data.today;
  const titles = async () => ((await o('GET', `/api/checklists?date=${today}`)).data.runs || []).map((r) => r.title).sort();
  assert.deepEqual(await titles(), ['CK bếp', 'CK phục vụ'], 'chủ thấy hết');
  const mk = async (name, teamId, role, pin) => { const id = (await o('POST', '/api/staff', { name, team_id: teamId, role, pin })).data.id; db.prepare('INSERT INTO attendance (staff_id, date, clock_in) VALUES (?, ?, ?)').run(id, today, Date.now()); };
  await mk('Trưởng ca PV', pv, 'shift_lead', '7364');
  await mk('Tổ trưởng bếp', bep, 'team_lead', '8475');
  cookie = null; await o('POST', '/api/login', { pin: '7364' });
  assert.deepEqual(await titles(), ['CK phục vụ']);
  cookie = null; await o('POST', '/api/login', { pin: '8475' });
  assert.deepEqual(await titles(), ['CK bếp']);
  // Quản lý phục vụ / quản lý không bộ phận: không thấy bếp (2 bên tách biệt); quản lý bếp chỉ thấy bếp
  cookie = null; await o('POST', '/api/login', { pin: '582914' });
  await o('POST', '/api/staff', { name: 'QL PV', team_id: pv, role: 'manager', pin: '736451' });
  await o('POST', '/api/staff', { name: 'QL chung', role: 'manager', pin: '847562' });
  await o('POST', '/api/staff', { name: 'QL bếp', team_id: bep, role: 'manager', pin: '958673' });
  const want = { 736451: ['CK phục vụ'], 847562: ['CK phục vụ'], 958673: ['CK bếp'] };
  for (const [pin, w] of Object.entries(want)) {
    cookie = null; const lg = await o('POST', '/api/login', { pin });
    assert.equal(lg.status, 200, JSON.stringify(lg.data));
    assert.deepEqual(await titles(), w, `quản lý ${pin}`);
    const tp = (await o('GET', '/api/checklist-templates')).data.map((x) => x.title);
    assert.equal(tp.includes('CK bếp'), pin === '958673', `mẫu checklist ${pin}`);
    assert.equal((await o('GET', '/api/preps')).status, pin === '958673' ? 200 : 403, `sổ công thức ${pin}`);
    assert.equal((await o('GET', '/api/preps/plan')).status, pin === '958673' ? 200 : 403, `việc nấu ${pin}`);
  }
});
