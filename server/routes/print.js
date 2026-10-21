import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { ticketBytes, testBytes } from '../lib/escpos.js';
import { billQR } from '../lib/vietqr.js';

// Cầu in: chương trình nhỏ chạy trên máy tính ở quán (cùng wifi với máy in).
// Nó hỏi app mỗi 2 giây "có phiếu nào cần in?", nhận lệnh in đã dựng sẵn, gửi thẳng tới IP máy in (cổng 9100), rồi báo lại kết quả.
// Xác thực bằng mã khoá riêng (setting print_token), không dùng tài khoản nhân viên.
const MAX_ATTEMPTS = 3;
const EXPIRE_MIN = 60; // phiếu treo quá 60 phút thì bỏ, không in nữa (tránh bếp nhận phiếu cũ)

export default function (r, ctx) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS print_tests (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', printed_at INTEGER, error TEXT NOT NULL DEFAULT ''
  )`);
  const cols = db.prepare('PRAGMA table_info(kitchen_tickets)').all().map((c) => c.name);
  if (!cols.includes('print_error')) db.exec("ALTER TABLE kitchen_tickets ADD COLUMN print_error TEXT NOT NULL DEFAULT ''");
  const scols = db.prepare('PRAGMA table_info(kitchen_stations)').all().map((c) => c.name);
  if (!scols.includes('printer_ok')) db.exec('ALTER TABLE kitchen_stations ADD COLUMN printer_ok INTEGER');
  if (!scols.includes('printer_checked_at')) db.exec('ALTER TABLE kitchen_stations ADD COLUMN printer_checked_at INTEGER');
  if (!ctx.setting('print_token')) ctx.setSetting('print_token', crypto.randomBytes(16).toString('hex'));

  const auth = (req) => {
    const got = Buffer.from(String(req.headers['x-print-token'] || ''));
    const want = Buffer.from(ctx.setting('print_token'));
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) fail(401, 'Sai mã cầu in');
    ctx.setSetting('print_bridge_seen', ctx.now());
  };
  const stations = () => db.prepare('SELECT * FROM kitchen_stations ORDER BY sort, id').all();
  // Máy chính, rồi máy dự phòng; máy không có IP thì đi thẳng sang dự phòng
  function targets(stationId) {
    const all = new Map(stations().map((s) => [s.id, s]));
    const out = [];
    const seen = new Set();
    let s = all.get(stationId);
    while (s && !seen.has(s.id)) {
      seen.add(s.id);
      if (s.printer_ip && s.active) out.push({ ip: s.printer_ip, port: s.printer_port || 9100, station: s.name });
      s = all.get(s.fallback_station_id);
    }
    return out;
  }
  const mode = () => (ctx.setting('print_text_mode') === 'utf8' ? 'utf8' : 'khong_dau');
  const offsetMin = () => {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(ctx.setting('tz_offset') || '+07:00');
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 420;
  };
  const hm = (ts) => {
    const d = new Date(ts + offsetMin() * 60_000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  // ---------- Cầu in gọi ----------
  r.get('/api/print/jobs', null, ({ req }) => {
    auth(req);
    const now = ctx.now();
    db.prepare("UPDATE kitchen_tickets SET print_status = 'expired' WHERE print_status = 'pending' AND created_at < ?").run(now - EXPIRE_MIN * 60_000);
    const jobs = [];
    const tks = db.prepare(`SELECT k.*, st.name AS station_name, s.name AS by_name FROM kitchen_tickets k
      LEFT JOIN kitchen_stations st ON st.id = k.station_id LEFT JOIN staff s ON s.id = k.created_by
      WHERE k.print_status = 'pending' ORDER BY k.priority DESC, k.id LIMIT 30`).all();
    for (const k of tks) {
      const to = targets(k.station_id);
      if (!to.length) continue; // máy chưa có IP: chờ, màn quản lý báo "chưa cài máy in"
      const t = { ...k, lines: JSON.parse(k.lines || '[]') };
      const lateMin = Math.floor((now - k.created_at) / 60_000);
      jobs.push({ key: `t${k.id}`, station: k.station_name, targets: to, data: ticketBytes(t, { mode: mode(), time: hm(k.created_at), by: k.by_name || '', lateMin }).toString('base64') });
    }
    for (const p of db.prepare("SELECT p.*, st.name, st.printer_ip, st.printer_port FROM print_tests p JOIN kitchen_stations st ON st.id = p.station_id WHERE p.status = 'pending'").all()) {
      if (!p.printer_ip) { db.prepare("UPDATE print_tests SET status = 'failed', error = 'Chưa nhập IP' WHERE id = ?").run(p.id); continue; }
      const t = [{ ip: p.printer_ip, port: p.printer_port || 9100, station: p.name }]; // in thử đúng máy, không chuyển dự phòng
      jobs.push({ key: `p${p.id}`, station: p.name, targets: t, data: testBytes({ station: p.name, ip: p.printer_ip, time: hm(p.created_at), qr: ctx.setting('bank_qr') ? billQR(ctx.setting('bank_qr'), { amount: 1000, content: 'IN THU' }) : '' }).toString('base64') });
    }
    return { jobs, stations: stations().filter((s) => s.printer_ip).map((s) => ({ id: s.id, name: s.name, ip: s.printer_ip, port: s.printer_port || 9100 })) };
  });

  r.post('/api/print/result', null, ({ req, body }) => {
    auth(req);
    const m = /^([tp])(\d+)$/.exec(String(body.key || ''));
    if (!m) fail(400, 'Mã phiếu không hợp lệ');
    const ok = !!body.ok;
    const err = v.text(body.error, { name: 'Lỗi', max: 200 }) || '';
    const now = ctx.now();
    if (m[1] === 'p') {
      db.prepare('UPDATE print_tests SET status = ?, printed_at = ?, error = ? WHERE id = ?').run(ok ? 'printed' : 'failed', ok ? now : null, err, m[2]);
      ctx.broadcast('print');
      return { ok: true };
    }
    const k = db.prepare('SELECT k.*, st.name AS station_name FROM kitchen_tickets k LEFT JOIN kitchen_stations st ON st.id = k.station_id WHERE k.id = ?').get(m[2]);
    if (!k) fail(404, 'Không có phiếu');
    if (k.print_status !== 'pending') return { ok: true };
    if (ok) {
      db.prepare("UPDATE kitchen_tickets SET print_status = 'printed', printed_at = ?, attempts = attempts + 1, print_error = '' WHERE id = ?").run(now, k.id);
    } else {
      const attempts = k.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      db.prepare('UPDATE kitchen_tickets SET attempts = ?, print_status = ?, print_error = ? WHERE id = ?').run(attempts, failed ? 'failed' : 'pending', err, k.id);
      if (failed) {
        const head = db.prepare('SELECT header FROM kitchen_tickets WHERE id = ?').get(k.id).header;
        ctx.notify(ctx.managers(), { title: `Không in được phiếu ${k.station_name || ''}`, body: `${head}: ${err || 'máy in không phản hồi'}. Báo bếp bằng miệng, kiểm tra máy in rồi bấm In lại.`, link: '/may-in', urgent: true });
      }
    }
    ctx.broadcast('print');
    return { ok: true };
  });

  // Cầu in báo tình trạng từng máy (kết nối được cổng 9100 hay không)
  r.post('/api/print/health', null, ({ req, body }) => {
    auth(req);
    const now = ctx.now();
    const up = db.prepare('UPDATE kitchen_stations SET printer_ok = ?, printer_checked_at = ? WHERE id = ?');
    for (const h of Array.isArray(body.printers) ? body.printers.slice(0, 50) : []) up.run(h.ok ? 1 : 0, now, v.int(h.id, { min: 1, name: 'Máy' }));
    ctx.broadcast('print');
    return { ok: true };
  });

  // ---------- Quản lý xem ----------
  r.get('/api/print/status', 'shift_lead', ({ me }) => {
    const seen = Number(ctx.setting('print_bridge_seen') || 0);
    const now = ctx.now();
    const count = (st) => db.prepare('SELECT station_id, COUNT(*) AS n FROM kitchen_tickets WHERE print_status = ? GROUP BY station_id').all(st);
    const pend = new Map(count('pending').map((x) => [x.station_id, x.n]));
    const bad = new Map(count('failed').map((x) => [x.station_id, x.n]));
    return {
      bridge_online: !!seen && now - seen < 20_000,
      bridge_seen: seen || null,
      text_mode: mode(),
      ...(me.role === 'owner' || me.role === 'manager' ? { token: ctx.setting('print_token') } : {}),
      stations: stations().map((s) => ({
        id: s.id, name: s.name, ip: s.printer_ip, port: s.printer_port || 9100, active: !!s.active,
        fallback: s.fallback_station_id ? stations().find((x) => x.id === s.fallback_station_id)?.name || '' : '',
        ok: s.printer_ok == null ? null : !!s.printer_ok, checked_at: s.printer_checked_at,
        pending: pend.get(s.id) || 0, failed: bad.get(s.id) || 0,
      })),
      failed: db.prepare(`SELECT k.id, k.kind, k.header, k.created_at, k.print_error, st.name AS station_name FROM kitchen_tickets k
        LEFT JOIN kitchen_stations st ON st.id = k.station_id WHERE k.print_status = 'failed' AND k.created_at > ? ORDER BY k.id DESC LIMIT 30`).all(now - 12 * 3_600_000),
      tests: db.prepare('SELECT p.*, st.name AS station_name FROM print_tests p JOIN kitchen_stations st ON st.id = p.station_id ORDER BY p.id DESC LIMIT 10').all(),
    };
  });

  r.post('/api/print/test', 'manager', ({ me, body }) => {
    const ids = body.station_id === 'all' ? stations().filter((s) => s.printer_ip).map((s) => s.id) : [v.int(body.station_id, { min: 1, name: 'Máy in' })];
    if (!ids.length) fail(400, 'Chưa máy nào có IP');
    for (const id of ids) {
      if (!db.prepare('SELECT 1 FROM kitchen_stations WHERE id = ?').get(id)) fail(404, 'Không có máy in này');
      db.prepare('INSERT INTO print_tests (station_id, created_at) VALUES (?, ?)').run(id, ctx.now());
    }
    ctx.audit(me, 'print.test', { ids });
    ctx.broadcast('print');
    return { n: ids.length };
  });

  r.post('/api/print/retry', 'shift_lead', ({ me, body }) => {
    const n = body.id === 'all'
      ? db.prepare("UPDATE kitchen_tickets SET print_status = 'pending', attempts = 0 WHERE print_status = 'failed' AND created_at > ?").run(ctx.now() - EXPIRE_MIN * 60_000).changes
      : db.prepare("UPDATE kitchen_tickets SET print_status = 'pending', attempts = 0 WHERE id = ? AND print_status IN ('failed','expired')").run(v.int(body.id, { min: 1, name: 'Phiếu' })).changes;
    ctx.audit(me, 'print.retry', { id: body.id, n });
    ctx.broadcast('print');
    return { n };
  });

  r.post('/api/print/settings', 'manager', ({ me, body }) => {
    if (body.text_mode !== undefined) {
      if (!['utf8', 'khong_dau'].includes(body.text_mode)) fail(400, 'Chế độ chữ không hợp lệ');
      ctx.setSetting('print_text_mode', body.text_mode);
    }
    if (body.reset_token) {
      if (me.role !== 'owner') fail(403, 'Chỉ chủ quán đổi mã cầu in');
      ctx.setSetting('print_token', crypto.randomBytes(16).toString('hex'));
    }
    ctx.audit(me, 'print.settings', { text_mode: body.text_mode, reset_token: !!body.reset_token });
    ctx.broadcast('print');
    return { ok: true };
  });

  // File chạy trên máy tính quán (Windows): tự tải bản cầu in mới nhất rồi chạy, tắt thì tự bật lại
  r.get('/api/print/setup.bat', 'manager', ({ req }) => {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const url = `${proto}://${req.headers.host}`;
    const token = ctx.setting('print_token');
    const bat = [
      '@echo off', 'chcp 65001 >nul', 'title CAU IN - Cuu Long Tran (dung tat cua so nay)', 'cd /d "%~dp0"',
      'where node >nul 2>nul',
      'if errorlevel 1 (', '  echo Chua cai Node.js. Dang mo trang tai, cai xong bam lai file nay.', '  start https://nodejs.org/en/download', '  pause', '  exit /b', ')',
      ':loop',
      `powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing '${url}/cau-in/cau-in.js' -OutFile 'cau-in.js' } catch { Write-Host 'Khong tai duoc ban moi, dung ban cu' }"`,
      `node cau-in.js --url ${url} --token ${token}`,
      'echo Cau in dung, tu bat lai sau 5 giay...', 'timeout /t 5 >nul', 'goto loop', '',
    ].join('\r\n');
    return { __binary: Buffer.from(bat, 'utf8'), type: 'application/octet-stream', filename: 'cau-in.bat' };
  });
}
