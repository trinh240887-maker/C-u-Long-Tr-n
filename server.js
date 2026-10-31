#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from './server/db.js';
import { createApp } from './server/app.js';
import { runBackup } from './server/backup.js';
import { fork } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));

// Chủ quán 26/10 22:29 "máy chủ dừng phản hồi": 1 lỗi bất ngờ (vd gọi Zalo / ngân hàng lỗi mạng) không được làm sập cả app → ghi log, chạy tiếp
process.on('unhandledRejection', (e) => console.error('[lỗi chưa bắt - promise]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[lỗi chưa bắt]', e?.stack || e));
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(here, 'data');
const backupDir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');
fs.mkdirSync(dataDir, { recursive: true });

const db = openDb(path.join(dataDir, 'quanly.db'));
const photoDir = process.env.PHOTO_DIR || path.join(dataDir, 'photos');
const app = createApp({ db, publicDir: path.join(here, 'public'), backupDir, photoDir });
app.ctx.notifier.start();

// Sao lưu mỗi giờ (dữ liệu không đổi thì bỏ qua), giữ 24 bản gần nhất + 1 bản / ngày 14 ngày; tự đóng ca quên chấm ra mỗi 5 phút
// BACKUP_COPY_DIR (vd thư mục Google Drive trên máy quán): mỗi lần sao lưu chép thêm 1 bản "quanly-moi-nhat.db" + giữ 1 bản / ngày 30 ngày
const copyDir = process.env.BACKUP_COPY_DIR;
const backup = () => {
  try {
    const file = runBackup(db, backupDir, { skipUnchanged: true });
    if (copyDir) {
      fs.mkdirSync(copyDir, { recursive: true });
      fs.copyFileSync(file, path.join(copyDir, 'quanly-moi-nhat.db'));
      const day = path.join(copyDir, `quanly-${new Date().toISOString().slice(0, 10)}.db`);
      if (!fs.existsSync(day)) fs.copyFileSync(file, day);
      for (const f of fs.readdirSync(copyDir)) if (/^quanly-\d{4}-\d{2}-\d{2}\.db$/.test(f) && Date.now() - fs.statSync(path.join(copyDir, f)).mtimeMs > 30 * 86_400_000) fs.rmSync(path.join(copyDir, f));
    }
  } catch (e) { console.error('Sao lưu lỗi:', e.message); }
};
backup();
// Rà soát 28/10: mỗi việc định kỳ chạy riêng — 1 việc lỗi (đồng bộ hay promise) không chặn các việc sau
const safe = (name) => {
  const fn = app.ctx[name];
  if (typeof fn !== 'function') return;
  try {
    const r = fn.call(app.ctx);
    if (r && typeof r.catch === 'function') r.catch((e) => console.error(`[${name}] lỗi:`, e?.stack || e));
  } catch (e) { console.error(`[${name}] lỗi:`, e?.stack || e); }
};
const runAll = (names) => () => names.forEach(safe);
const hourly = runAll(['cleanupPhotos', 'promoTick']);
hourly();
const timers = [
  setInterval(backup, 3600_000),
  setInterval(() => safe('zaloBotPoll'), 3_000), // bot đọc tin liên tục (mỗi lần chờ tới 25 giây, không chạy chồng)
  setInterval(runAll(['printTick', 'bookingGuardTick', 'waitTick', 'purchaseReportTick', 'availBotTick', 'stockCountRemindTick', 'utensilCountTick', 'jobsTick', 'openingTick', 'lossAlertTick', 'arriveRemindTick', 'jobsLeftTick', 'partPayTick']), 60_000),
  setInterval(runAll(['autoCloseAttendance', 'syncPay', 'payTick', 'reviewTick', 'laborWeeklyTick', 'bookingTick']), 5 * 60_000),
  setInterval(hourly, 3600_000),
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

// PRINT_LOCAL=1: máy chủ đặt ở quán (cùng mạng máy in) → tự chạy cầu in, không cần mở thêm cửa sổ nào
let bridge = null;
function startBridge() {
  if (process.env.PRINT_LOCAL !== '1') return;
  const token = db.prepare("SELECT value FROM settings WHERE key = 'print_token'").get()?.value;
  if (!token) return setTimeout(startBridge, 5000);
  bridge = fork(path.join(here, 'public', 'cau-in', 'cau-in.js'), ['--url', `http://127.0.0.1:${port}`, '--token', token], { stdio: 'inherit' });
  bridge.token = token;
  bridge.on('exit', () => { bridge = null; if (!stopping) setTimeout(startBridge, 5000); }); // cầu in lỗi thì tự chạy lại
}
let stopping = false;
// Chủ quán đổi mã cầu in → chạy lại cầu in với mã mới
timers.push(setInterval(() => { if (bridge && bridge.token !== db.prepare("SELECT value FROM settings WHERE key = 'print_token'").get()?.value) bridge.kill(); }, 60_000));
server.on('listening', () => setTimeout(startBridge, 1000));

function stop() {
  stopping = true;
  bridge?.kill();
  timers.forEach(clearInterval);
  app.close();
  server.close(() => { backup(); db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
