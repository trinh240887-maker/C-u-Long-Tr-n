import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, fail, createRouter, readJson, readCookie, sendJson } from './http.js';
import { rank, ROLE_LABEL } from './db.js';
import { makeClock } from './lib/time.js';
import { createNotifier } from './notify/index.js';
import authRoutes from './routes/auth.js';
import staffRoutes from './routes/staff.js';
import scheduleRoutes from './routes/schedule.js';
import attendanceRoutes from './routes/attendance.js';
import leaveRoutes from './routes/leave.js';
import checklistRoutes from './routes/checklists.js';
import taskRoutes from './routes/tasks.js';
import homeRoutes from './routes/home.js';
import settingsRoutes from './routes/settings.js';
import stockRoutes from './routes/stock.js';

const SESSION_DAYS = 30;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

export function createApp({ db, publicDir, now = () => Date.now(), zaloTransport, backupDir } = {}) {
  const clients = new Set();
  const failedLogins = new Map();
  const qSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const qSetSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  const ctx = {
    db, now, backupDir,
    setting: (key) => qSetting.get(key)?.value ?? '',
    setSetting: (key, value) => qSetSetting.run(key, String(value)),
    clock: () => makeClock({ offset: ctx.setting('tz_offset') || '+07:00', cutoffHour: Number(ctx.setting('day_cutoff_hour') || 5) }),
    today: () => ctx.clock().businessDate(now()),
    broadcast(kind) {
      const msg = `event: change\ndata: ${JSON.stringify({ kind })}\n\n`;
      for (const c of clients) c.res.write(msg);
    },
    audit(me, action, detail = '') {
      db.prepare('INSERT INTO audit_log (staff_id, action, detail, at) VALUES (?, ?, ?, ?)')
        .run(me?.id ?? null, action, typeof detail === 'string' ? detail : JSON.stringify(detail), now());
    },
    staff: (id) => db.prepare('SELECT * FROM staff WHERE id = ?').get(id),
    need(me, role) {
      if (rank(me.role) < rank(role)) fail(403, `Chức năng này cần quyền ${ROLE_LABEL[role]} trở lên`);
    },
    // Ai đang quản lý một tổ: tổ trưởng của tổ đó, trưởng ca, quản lý, chủ
    leadsOf(teamId) {
      return db.prepare(`SELECT id FROM staff WHERE active = 1 AND (role IN ('shift_lead','manager','owner') OR (role = 'team_lead' AND team_id = ?))`)
        .all(teamId ?? -1).map((r) => r.id);
    },
    managers() {
      return db.prepare("SELECT id FROM staff WHERE active = 1 AND role IN ('manager','owner')").all().map((r) => r.id);
    },
  };
  ctx.notifier = createNotifier(ctx, { transport: zaloTransport });
  ctx.notify = (...args) => ctx.notifier.notify(...args);

  const router = createRouter();
  for (const register of [authRoutes, staffRoutes, scheduleRoutes, attendanceRoutes, leaveRoutes, checklistRoutes, taskRoutes, homeRoutes, settingsRoutes, stockRoutes]) {
    register(router, ctx);
  }

  function sessionOf(req) {
    const token = readCookie(req, 'sid');
    if (!token || !/^[a-f0-9]{48}$/.test(token)) return { token: null, me: null };
    const row = db.prepare(`SELECT s.created_at, st.* FROM sessions s JOIN staff st ON st.id = s.staff_id WHERE s.token = ?`).get(token);
    if (!row || !row.active || now() - row.created_at > SESSION_DAYS * 86_400_000) return { token, me: null };
    const { created_at, pin_lookup, ...me } = row;
    return { token, me };
  }

  function clientIp(req) {
    // Qua Cloudflare Tunnel: có header cf-connecting-ip → là truy cập từ xa
    const cf = req.headers['cf-connecting-ip'];
    // Chạy sau proxy của nhà cung cấp cloud (Railway, Render…): đặt TRUST_PROXY=1 để lấy IP thật của người dùng
    const fwd = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return { ip: String(cf || fwd || req.socket.remoteAddress || '').replace(/^::ffff:/, ''), remote: Boolean(cf) };
  }

  ctx.login = (req, res, staff) => {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, staff_id, created_at) VALUES (?, ?, ?)').run(token, staff.id, now());
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.headers['cf-connecting-ip'] ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  };
  ctx.loginGuard = {
    check(ip) {
      const f = failedLogins.get(ip);
      if (f && f.until > now()) fail(429, `Nhập sai quá nhiều lần. Thử lại sau ${Math.ceil((f.until - now()) / 60000)} phút`);
    },
    failed(ip) {
      const f = failedLogins.get(ip) || { count: 0, until: 0 };
      f.count++;
      if (f.count >= 5) { f.until = now() + 5 * 60_000; f.count = 0; }
      failedLogins.set(ip, f);
    },
    ok(ip) { failedLogins.delete(ip); },
  };

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const root = path.resolve(publicDir);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end('Not found'); }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      // Ứng dụng một trang: đường dẫn lạ trả về index.html
      if (!path.extname(file)) return serveStatic(res, '/');
      res.writeHead(404); res.end('Not found');
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      const { token, me } = sessionOf(req);
      const net = clientIp(req);

      if (pathname === '/api/events') {
        if (!me) fail(401, 'Chưa đăng nhập');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        const client = { res, staffId: me.id };
        clients.add(client);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(ping); clients.delete(client); });
        return;
      }

      if (pathname.startsWith('/webhooks/')) {
        const m = ctx.notifier.matchWebhook(req.method, pathname);
        if (!m) fail(404, 'Không tìm thấy');
        const body = await readJson(req);
        return sendJson(res, 200, m(body));
      }

      if (pathname.startsWith('/api/')) {
        const hit = router.match(req.method, pathname);
        if (!hit) fail(404, 'Không có chức năng này');
        const { route, params } = hit;
        if (route.role && !me) fail(401, 'Chưa đăng nhập');
        if (route.role) ctx.need(me, route.role);
        if (req.method !== 'GET') {
          // Chỉ nhận JSON để chặn trang web lạ gửi lệnh thay người dùng
          if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Cần gửi dữ liệu dạng JSON');
        }
        const body = req.method === 'GET' ? {} : await readJson(req);
        const out = await route.fn({ req, res, url, query: url.searchParams, params, body, me, token, net });
        return sendJson(res, 200, out ?? { ok: true });
      }

      if (req.method !== 'GET') fail(405, 'Không hỗ trợ');
      return serveStatic(res, pathname);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'Lỗi máy chủ, thử lại sau' });
    }
  }

  function close() {
    ctx.notifier.stop();
    for (const c of clients) c.res.end();
    clients.clear();
  }

  return { handler, close, ctx };
}
