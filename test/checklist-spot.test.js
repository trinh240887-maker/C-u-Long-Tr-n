import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('kiểm tra ngẫu nhiên: mỗi checklist mở/đóng ca có 1 việc tick bị bắt chụp, cố định trong ngày, không chụp thì không xong', async (t) => {
  const db = openDb(':memory:');
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const o = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });
  const runs = (await o('GET', '/api/checklists')).data.runs;
  const run = runs.find((r) => r.title === 'Đóng ca Pha chế');
  const spots = run.items.filter((i) => i.spot);
  assert.equal(spots.length, 1);
  assert.equal(spots[0].kind, 'check');
  // Xem lại vẫn đúng việc đó
  const again = (await o('GET', '/api/checklists')).data.runs.find((r) => r.title === 'Đóng ca Pha chế').items.filter((i) => i.spot).map((i) => i.id);
  assert.deepEqual(again, [spots[0].id]);
  // Tick mà không chụp → chặn; chụp rồi → được
  assert.equal((await o('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: spots[0].id })).status, 400);
  await o('POST', '/api/checklists/photo', { run_id: run.run_id, item_id: spots[0].id, data: `data:image/jpeg;base64,${Buffer.alloc(3000, 7).toString('base64')}` });
  assert.equal((await o('POST', '/api/checklists/entry', { run_id: run.run_id, item_id: spots[0].id })).status, 200);
  // Trong ca không kiểm ngẫu nhiên; tắt (0) thì không còn
  assert.equal(runs.find((r) => r.title === 'Trong ca Lối đi').items.filter((i) => i.spot).length, 0);
  await o('PUT', '/api/settings', { spot_photos_per_run: 0 });
  assert.equal((await o('GET', '/api/checklists')).data.runs.find((r) => r.title === 'Mở ca Pha chế').items.filter((i) => i.spot).length, 0);
});
