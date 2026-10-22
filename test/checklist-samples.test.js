import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMG = `data:image/jpeg;base64,${Buffer.alloc(2000, 7).toString('base64')}`;

test('checklist chính thức (bỏ chữ "mẫu") + ảnh mẫu khu / từng việc: tổ trưởng thêm, nhân viên xem, tổ khác không sửa được', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mau-'));
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), photoDir, zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie;
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') || '';
      return { status: res.status, data: type.includes('json') ? await res.json() : await res.arrayBuffer(), type };
    };
  };
  const o = client();
  await o('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  await o('POST', '/api/me/pin', { current_pin: DEFAULT_OWNER_PIN, new_pin: '582914' });

  const tpls = (await o('GET', '/api/checklist-templates')).data;
  assert.ok(tpls.length >= 6);
  assert.ok(tpls.every((x) => !x.title.includes('(mẫu)')), 'đã bỏ chữ (mẫu)');
  assert.ok(tpls.some((x) => x.title === 'Mở ca bếp steak'));

  const teams = (await o('GET', '/api/teams')).data;
  const tid = (n) => teams.find((x) => x.name === n).id;
  const steak = tpls.find((x) => x.title === 'Mở ca bếp steak');
  const bar = tpls.find((x) => x.title === 'Mở ca bar');
  // Tổ trưởng bếp steak + nhân viên bar
  await o('POST', '/api/staff', { name: 'Phát', role: 'team_lead', team_id: tid('Bếp steak'), pin: '736251' });
  await o('POST', '/api/staff', { name: 'Mai', role: 'staff', team_id: tid('Bar'), pin: '736252' });
  const lead = client();
  await lead('POST', '/api/login', { pin: '736251' });
  await lead('POST', '/api/me/pin', { current_pin: '736251', new_pin: '918273' });
  const nv = client();
  await nv('POST', '/api/login', { pin: '736252' });
  await nv('POST', '/api/me/pin', { current_pin: '736252', new_pin: '918274' });

  // Ảnh mẫu cả khu + ảnh mẫu 1 việc
  const a = await lead('POST', `/api/checklist-templates/${steak.id}/samples`, { data: IMG });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const b = await lead('POST', `/api/checklist-templates/${steak.id}/samples`, { data: IMG, item_id: steak.items[2].id });
  assert.equal(b.status, 200);
  // Tổ trưởng không sửa checklist tổ khác; nhân viên không thêm được
  assert.equal((await lead('POST', `/api/checklist-templates/${bar.id}/samples`, { data: IMG })).status, 403);
  assert.equal((await nv('POST', `/api/checklist-templates/${bar.id}/samples`, { data: IMG })).status, 403);
  // Ảnh sai / việc không thuộc checklist
  assert.equal((await lead('POST', `/api/checklist-templates/${steak.id}/samples`, { data: 'data:image/png;base64,AAAA' })).status, 400);
  assert.equal((await lead('POST', `/api/checklist-templates/${steak.id}/samples`, { data: IMG, item_id: bar.items[0].id })).status, 400);

  // Checklist trong ngày có ảnh mẫu
  const day = (await o('GET', '/api/checklists')).data.runs.find((r) => r.template_id === steak.id);
  assert.equal(day.samples.length, 1);
  assert.equal(day.items[2].samples.length, 1);
  assert.equal(day.items[0].samples.length, 0);
  // Nhân viên xem được ảnh
  const img = await nv('GET', `/api/checklist-samples/${a.data.id}`);
  assert.equal(img.status, 200);
  assert.match(img.type, /image\/jpeg/);
  // Ảnh mẫu không bị dọn sau 7 ngày
  app.ctx.cleanupPhotos();
  assert.equal((await nv('GET', `/api/checklist-samples/${a.data.id}`)).status, 200);
  // Xoá
  assert.equal((await lead('POST', `/api/checklist-samples/${b.data.id}/delete`)).status, 200);
  assert.equal((await nv('GET', `/api/checklist-samples/${b.data.id}`)).status, 404);
});
