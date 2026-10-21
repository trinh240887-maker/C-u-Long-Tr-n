import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../scripts/scenarios.js';

test('Kịch bản bán hàng: tách/chuyển/gộp bàn, huỷ, trễ, nhắc bếp, đặt bàn', async () => {
  const res = await run({ quiet: true });
  const bad = res.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`);
  assert.deepEqual(bad, []);
  assert.ok(res.length >= 35);
});
