import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Mở ca phục vụ: nạp 12 việc chung Phục vụ + Tiếp thực, giao từng người 14:00–15:30', () => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  try {
    const t = db.prepare("SELECT * FROM checklist_templates WHERE title LIKE 'Mở ca phục vụ%' AND active = 1").get();
    assert.ok(t);
    assert.equal(t.job_mode, 1);
    assert.equal(t.job_from, 840);
    assert.equal(t.job_to, 930);
    assert.ok(JSON.parse(t.job_teams).includes(-1));
    const items = db.prepare('SELECT * FROM checklist_items WHERE template_id = ? ORDER BY sort').all(t.id);
    assert.equal(items.length, 12);
    assert.equal(items[0].text, 'Lau dụng cụ ăn uống');
    assert.equal(items[0].job_scope, 'zone');
    assert.equal(items.find((i) => /chén để khách/.test(i.text)).job_scope, 'zone');
    assert.equal(items.find((i) => /combo/.test(i.text)).job_per_table, 1);
    assert.equal(items[0].job_with, items.find((i) => /combo/.test(i.text)).id); // người làm combo lau luôn
    assert.equal(app.ctx.setting('mo_ca_pv_v1'), '1');
  } finally { app.close(); }
});
