#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from './server/db.js';
import { createApp } from './server/app.js';
import { runBackup } from './server/backup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(here, 'data');
const backupDir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');
fs.mkdirSync(dataDir, { recursive: true });

const db = openDb(path.join(dataDir, 'quanly.db'));
const photoDir = process.env.PHOTO_DIR || path.join(dataDir, 'photos');
const app = createApp({ db, publicDir: path.join(here, 'public'), backupDir, photoDir });
app.ctx.notifier.start();

// Sao lưu mỗi giờ, giữ 7 ngày; tự đóng ca quên chấm ra mỗi 5 phút
const backup = () => { try { runBackup(db, backupDir); } catch (e) { console.error('Sao lưu lỗi:', e.message); } };
backup();
try { app.ctx.cleanupPhotos(); app.ctx.promoTick(); } catch (e) { console.error(e); }
const timers = [
  setInterval(backup, 3600_000),
  setInterval(() => { try { app.ctx.printTick(); } catch (e) { console.error(e); } }, 60_000),
  setInterval(() => { try { app.ctx.autoCloseAttendance(); app.ctx.payTick(); app.ctx.reviewTick(); } catch (e) { console.error(e); } }, 5 * 60_000),
  setInterval(() => { try { app.ctx.cleanupPhotos(); app.ctx.promoTick(); } catch (e) { console.error(e); } }, 3600_000),
];

const server = http.createServer(app.handler);
server.listen(port, () => {
  console.log(`\nQuản lý quán đang chạy: http://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  Máy khác trong wifi quán mở: http://${a.address}:${port}`);
  }
  console.log(`  Dữ liệu: ${dataDir}`);
  const owner = db.prepare("SELECT must_change_pin FROM staff WHERE role = 'owner' ORDER BY id LIMIT 1").get();
  if (owner?.must_change_pin) console.log(`  Lần đầu đăng nhập bằng PIN chủ quán: ${DEFAULT_OWNER_PIN} (app sẽ yêu cầu đổi ngay)\n`);
});

function stop() {
  timers.forEach(clearInterval);
  app.close();
  server.close(() => { backup(); db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
