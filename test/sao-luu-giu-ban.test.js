// Rà soát 28/10: giữ 24 bản sao lưu gần nhất + 1 bản / ngày trong 14 ngày; dữ liệu không đổi thì không tạo bản mới; Zalo có hẹn giờ
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { backupsToDelete, backupTime, runBackup } from '../server/backup.js';
import { createZaloOaTransport } from '../server/notify/zalo-oa.js';

const name = (t) => `quanly-${new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.db`;

test('backupsToDelete: 24 bản mới nhất + bản mới nhất mỗi ngày (giờ VN) trong 14 ngày', () => {
  const now = Date.UTC(2026, 9, 28, 5, 0, 0); // 12:00 giờ VN 28/10
  const names = [];
  for (let h = 0; h < 30 * 24; h++) names.push(name(now - h * 3600_000)); // 30 ngày, mỗi giờ 1 bản
  names.push('ghi-chu.txt', 'quanly-moi-nhat.db', 'quanly-2026-10-01.db'); // file lạ: không bao giờ xoá
  const del = new Set(backupsToDelete(names, now));
  const keep = names.filter((n) => !del.has(n) && backupTime(n) !== null);
  for (let h = 0; h < 24; h++) assert.ok(keep.includes(name(now - h * 3600_000)), `giữ bản ${h} giờ trước`);
  const days = new Set(keep.map((n) => new Date(backupTime(n) + 7 * 3600_000).toISOString().slice(0, 10)));
  assert.equal(days.size, 14);
  assert.ok(!days.has('2026-10-14'));
  // Mỗi ngày cũ giữ đúng bản cuối ngày (23:00 giờ VN = 16:00 UTC)
  assert.ok(keep.includes(name(Date.UTC(2026, 9, 20, 16, 0, 0))));
  assert.ok(keep.length <= 24 + 14);
  assert.ok(!del.has('ghi-chu.txt') && !del.has('quanly-moi-nhat.db') && !del.has('quanly-2026-10-01.db'));
  // Ít bản → không xoá gì
  assert.deepEqual(backupsToDelete([name(now), name(now - 86_400_000 * 20)], now), []);
});

test('runBackup: bỏ qua khi dữ liệu chưa đổi (tự động), chỉ xoá file đúng mẫu trong thư mục sao lưu', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clt-bk-'));
  try {
    const db = openDb(path.join(dir, 'quanly.db'), { now: Date.now() });
    const bdir = path.join(dir, 'backups');
    fs.mkdirSync(bdir);
    fs.writeFileSync(path.join(bdir, 'ghi-chu.txt'), 'x');
    const t0 = Date.UTC(2026, 9, 28, 5, 0, 0);
    const old = path.join(bdir, name(t0 - 40 * 86_400_000));
    fs.writeFileSync(old, 'cũ');
    const f1 = runBackup(db, bdir, { now: t0, skipUnchanged: true });
    assert.ok(fs.existsSync(f1));
    assert.ok(fs.existsSync(old)); // còn nằm trong 24 bản gần nhất → giữ
    const f2 = runBackup(db, bdir, { now: t0 + 3600_000, skipUnchanged: true });
    assert.equal(f2, f1); // không đổi → không tạo bản mới
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_x', '1')").run();
    const f3 = runBackup(db, bdir, { now: t0 + 2 * 3600_000, skipUnchanged: true });
    assert.notEqual(f3, f1);
    const f4 = runBackup(db, bdir, { now: t0 + 3 * 3600_000 }); // sao lưu tay luôn tạo bản mới
    assert.notEqual(f4, f3);
    assert.ok(fs.existsSync(path.join(bdir, 'ghi-chu.txt')));
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Zalo OA: mọi lệnh gọi có hẹn giờ (không kẹt hàng đợi khi Zalo treo)', async () => {
  const calls = [];
  const settings = { zalo_app_id: 'a', zalo_secret_key: 's', zalo_refresh_token: 'r' };
  const ctx = { setting: (k) => settings[k], setSetting: (k, v) => { settings[k] = v; }, now: () => Date.now() };
  const fetchImpl = async (url, opts) => { calls.push(opts); return { status: 200, json: async () => (/oauth/.test(url) ? { access_token: 't', expires_in: 3600 } : { error: 0 }) }; };
  await createZaloOaTransport(ctx, { fetchImpl }).send({ userId: 'u', text: 'hi' });
  assert.equal(calls.length, 2);
  for (const c of calls) assert.ok(c.signal instanceof AbortSignal);
});
