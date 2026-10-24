// CẦU IN - chạy trên máy tính ở quán (cùng wifi/mạng LAN với máy in).
// Cách chạy:
//   node cau-in.js --url https://<app> --token <ma>   chạy thật: lấy phiếu từ app, in ra máy bếp/bar
//   node cau-in.js --thu 192.168.1.234                in thử thẳng 1 máy (không cần app), xem máy có nhận không
//   node cau-in.js --quet                             dò mạng 192.168.1.x tìm máy in (cổng 9100)
// Không cần cài thêm gì ngoài Node.js 18+.
import net from 'node:net';
import os from 'node:os';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const POLL_MS = 2000;
const TIMEOUT_MS = 5000;
// Cửa sổ lệnh Windows hay hiện sai chữ có dấu → bỏ dấu cho dễ đọc
const plain = (x) => (process.platform === 'win32' ? String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[–⚠✓✗🟢🔴]/g, (c) => ({ '–': '-', '⚠': '!', '✓': 'OK', '✗': 'X' }[c] || '')) : x);
const log = (...m) => console.log(new Date().toLocaleTimeString('vi-VN'), ...m.map(plain));

function send(ip, port, data) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: ip, port: Number(port) || 9100 });
    const t = setTimeout(() => { sock.destroy(); reject(new Error(`${ip}: không phản hồi (máy tắt, hết giấy, sai IP?)`)); }, TIMEOUT_MS);
    sock.on('connect', () => sock.end(data));
    sock.on('close', (hadErr) => { clearTimeout(t); if (!hadErr) resolve(); });
    sock.on('error', (e) => { clearTimeout(t); reject(new Error(`${ip}: ${e.code === 'ECONNREFUSED' ? 'từ chối kết nối (sai cổng?)' : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? 'không thấy máy trong mạng' : e.message}`)); });
  });
}
const canReach = (ip, port = 9100, ms = 1500) => new Promise((resolve) => {
  const s = net.connect({ host: ip, port });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(ms, () => done(false));
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
});

// ---- In thử thẳng 1 máy ----
if (arg('--thu')) {
  const [ip, port = 9100] = arg('--thu').split(':');
  const E = (...b) => Buffer.from(b);
  const data = Buffer.concat([E(0x1b, 0x40), E(0x1b, 0x61, 1), E(0x1d, 0x21, 0x11), Buffer.from('IN THU\n'), E(0x1d, 0x21, 0),
    Buffer.from(`${ip}:${port}\n${new Date().toLocaleString('vi-VN')}\n\n`), E(0x1b, 0x61, 0),
    Buffer.from('1) KHONG DAU: Ban 20 - Combo 2 sot tieu den\n'), Buffer.from('2) CO DAU:  Bàn 20 - Combo 2 sốt tiêu đen\n', 'utf8'),
    E(0x1b, 0x64, 3), E(0x1d, 0x56, 66, 0)]);
  try { await send(ip, port, data); log(`✓ Đã gửi tới ${ip}:${port}. Máy có ra giấy không?`); }
  catch (e) { log(`✗ ${e.message}`); process.exitCode = 1; }
  process.exit();
}

// ---- Dò máy in trong mạng ----
if (args.includes('--quet')) {
  const mine = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
  if (!mine) { log('Máy tính chưa vào mạng'); process.exit(1); }
  const pre = mine.address.split('.').slice(0, 3).join('.');
  log(`Máy tính này: ${mine.address}. Đang dò ${pre}.1-254 cổng 9100...`);
  const found = [];
  for (let i = 1; i < 255; i += 32) {
    const batch = Array.from({ length: Math.min(32, 255 - i) }, (_, k) => `${pre}.${i + k}`);
    const res = await Promise.all(batch.map((ip) => canReach(ip, 9100, 800).then((ok) => ok && ip)));
    found.push(...res.filter(Boolean));
  }
  log(found.length ? `Tìm thấy ${found.length} máy in: ${found.join(', ')}` : 'Không thấy máy in nào mở cổng 9100');
  process.exit();
}

// ---- Chạy thật ----
const URL_ = (arg('--url') || process.env.CAU_IN_URL || '').replace(/\/$/, '');
const TOKEN = arg('--token') || process.env.CAU_IN_TOKEN || '';
if (!URL_ || !TOKEN) {
  console.log('Thiếu --url và --token. Tải file cau-in.bat trong app: Thêm → Máy in.');
  process.exit(1);
}
const api = async (method, path, body) => {
  const res = await fetch(URL_ + path, { method, headers: { 'x-print-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const busy = new Set(); // mỗi máy in 1 phiếu một lúc, máy này kẹt không làm chậm máy khác
const done = new Set();
let lastHealth = 0;
let offline = false;

async function printJob(job) {
  const data = Buffer.from(job.data, 'base64');
  const errs = [];
  for (const t of job.targets) {
    try {
      await send(t.ip, t.port, data);
      log(`✓ ${job.station}${t.station !== job.station ? ` (in sang máy dự phòng ${t.station})` : ''} · phiếu ${job.key}`);
      return { ok: true, ip: t.ip };
    } catch (e) { errs.push(e.message); }
  }
  log(`✗ ${job.station} · phiếu ${job.key}: ${errs.join('; ')}`);
  return { ok: false, error: errs.join('; ') };
}

async function tick() {
  let res;
  try {
    res = await api('GET', '/api/print/jobs');
    if (offline) { log('Đã kết nối lại app'); offline = false; }
  } catch (e) {
    if (!offline) log(`Mất kết nối app (${e.message}). Phiếu vẫn nằm trên app, có mạng lại sẽ in.`);
    offline = true;
    return;
  }
  for (const job of res.jobs) {
    const printer = `${job.targets[0].ip}:${job.targets[0].port}`;
    if (busy.has(printer) || done.has(job.key)) continue;
    busy.add(printer);
    printJob(job).then(async (r) => {
      if (r.ok) done.add(job.key);
      for (let i = 0; i < 5; i++) {
        try { await api('POST', '/api/print/result', { key: job.key, ...r }); break; } catch { await new Promise((ok) => setTimeout(ok, 2000)); }
      }
    }).finally(() => busy.delete(printer));
  }
  if (done.size > 500) done.clear();
  if (Date.now() - lastHealth > 60_000) {
    lastHealth = Date.now();
    const printers = await Promise.all(res.stations.map(async (s) => ({ id: s.id, ok: await canReach(s.ip, s.port) })));
    const bad = printers.filter((p) => !p.ok).map((p) => res.stations.find((s) => s.id === p.id));
    if (bad.length) log(`⚠ Không thấy máy: ${bad.map((s) => `${s.name} ${s.ip}`).join(', ')}`);
    api('POST', '/api/print/health', { printers }).catch(() => {});
  }
}

log(`Cầu in đang chạy, nối với ${URL_}. Để cửa sổ này mở suốt giờ bán.`);
for (;;) {
  await tick();
  await new Promise((ok) => setTimeout(ok, POLL_MS));
}
