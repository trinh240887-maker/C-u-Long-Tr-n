import { readFile, stat } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import path from 'node:path';
import crypto from 'node:crypto';
import nodeNet from 'node:net';
import { HttpError, fail, createRouter, readJson, readCookie, sendJson } from './http.js';
import { rank, ROLE_LABEL } from './db.js';
import { makeClock } from './lib/time.js';
import { createNotifier } from './notify/index.js';
import authRoutes from './routes/auth.js';
import printRoutes from './routes/print.js';
import promoRoutes from './routes/promotions.js';
import paymentRoutes from './routes/payments.js';
import { codeHash } from './lib/version.js';
import { createZaloBot } from './lib/zalo-bot.js';
import { apiGate } from './lib/perms.js';
import { matchAct } from './lib/acts.js';
import { createZns } from './notify/zns.js';
import bankRoutes from './routes/bank.js';
import daybookRoutes from './routes/daybook.js';
import bookingOnlineRoutes from './routes/booking-online.js';
import bookingGuardRoutes from './routes/booking-guard.js';
import waitlistRoutes from './routes/waitlist.js';
import reportRoutes from './routes/reports.js';
import purchaseRoutes from './routes/purchases.js';
import stockSaleRoutes from './routes/stock-sale.js';
import laborRoutes from './routes/labor.js';
import tipBoxRoutes from './routes/tipbox.js';
import staffRoutes from './routes/staff.js';
import scheduleRoutes from './routes/schedule.js';
import attendanceRoutes from './routes/attendance.js';
import leaveRoutes from './routes/leave.js';
import checklistRoutes from './routes/checklists.js';
import taskRoutes from './routes/tasks.js';
import homeRoutes from './routes/home.js';
import settingsRoutes from './routes/settings.js';
import stockRoutes from './routes/stock.js';
import zoneRoutes from './routes/zones.js';
import positionRoutes from './routes/positions.js';
import availabilityRoutes from './routes/availability.js';
import utensilRoutes from './routes/utensils.js';
import warehouseRoutes from './routes/warehouse.js';
import jobRoutes from './routes/jobs.js';
import sapoRoutes from './routes/sapo.js';
import zaloOrderRoutes from './routes/zalo-orders.js';
import expenseRoutes from './routes/expenses.js';
import menuRoutes from './routes/menu.js';
import posRoutes from './routes/pos.js';
import reservationRoutes from './routes/reservations.js';

const SESSION_DAYS = 30;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

export function createApp({ db, publicDir, now = () => Date.now(), zaloTransport, zaloBot, backupDir, photoDir } = {}) {
  const clients = new Set();
  const failedLogins = new Map();
  const qSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const qSetSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  const ctx = {
    db, now, backupDir, photoDir,
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
  ctx.clientIp = (req) => clientIp(req);
  ctx.notifier = createNotifier(ctx, { transport: zaloTransport });
  ctx.notify = (...args) => ctx.notifier.notify(...args);

  // Zalo cho khách (ZNS): chỉ chạy khi chủ quán bật trong Cài đặt; test có thể thay ctx.customerNotify
  ctx.customerNotify = createZns(ctx);
  const router = createRouter();
  // Phiên bản đang chạy (công khai, không lộ dữ liệu): GitHub kiểm tra 30′/lần, Cài đặt hiện cho chủ quán
  const startedAt = now();
  let version = 'unknown';
  try { version = codeHash(path.resolve(publicDir, '..')); } catch { /* bỏ qua */ }
  ctx.version = () => ({ version, started_at: startedAt });
  ctx.zaloBot = zaloBot || createZaloBot(ctx);
  router.get('/api/version', null, () => {
    // Tình trạng cầu in (không lộ IP / mã): để kiểm tra từ xa máy tính ở quán có đang chạy cầu in không
    const seen = Number(ctx.setting('print_bridge_seen') || 0);
    let printers = [];
    try { printers = db.prepare('SELECT name, printer_ip IS NOT NULL AND printer_ip != \'\' AS has_ip, printer_ok AS ok FROM kitchen_stations WHERE active = 1 ORDER BY sort, id').all().map((x) => ({ name: x.name, has_ip: !!x.has_ip, ok: x.ok == null ? null : !!x.ok })); } catch { /* bảng chưa có */ }
    let waiting = 0;
    try { waiting = db.prepare("SELECT COUNT(*) AS n FROM kitchen_tickets WHERE print_status = 'pending'").get().n; } catch { /* bỏ qua */ }
    return { ...ctx.version(), uptime_min: Math.round((now() - startedAt) / 60000), print_bridge: { online: !!seen && now() - seen < 20_000, seen_min_ago: seen ? Math.round((now() - seen) / 60000) : null, waiting, printers } };
  });

  for (const register of [authRoutes, staffRoutes, scheduleRoutes, attendanceRoutes, leaveRoutes, checklistRoutes, taskRoutes, homeRoutes, settingsRoutes, stockRoutes, zoneRoutes, positionRoutes, availabilityRoutes, utensilRoutes, menuRoutes, posRoutes, reservationRoutes, printRoutes, promoRoutes, paymentRoutes, bankRoutes, daybookRoutes, bookingOnlineRoutes, bookingGuardRoutes, waitlistRoutes, reportRoutes, purchaseRoutes, expenseRoutes, stockSaleRoutes, warehouseRoutes, jobRoutes, laborRoutes, tipBoxRoutes, zaloOrderRoutes, sapoRoutes]) {
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
    return resolveClientIp(req.headers, req.socket.remoteAddress, process.env.TRUST_PROXY === '1');
  }

  ctx.login = (req, res, staff) => {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, staff_id, created_at) VALUES (?, ?, ?)').run(token, staff.id, now());
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.headers['cf-connecting-ip'] ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  };
  // Chặn đoán PIN. Cả quán dùng chung wifi (chung IP) nên khoá theo IP + SỐ ĐIỆN THOẠI: 1 bạn nhập sai 5 lần chỉ khoá
  // số của bạn đó 2 phút; cả IP chỉ bị khoá khi sai rất nhiều (30 lần / 10 phút, dấu hiệu dò mã)
  // Dọn các lượt sai đã hết hạn để Map không phình mãi (rà soát 28/10)
  let lastPrune = 0;
  const pruneFailed = () => {
    const t = now();
    if (t - lastPrune < 60_000 && failedLogins.size < 5000) return;
    lastPrune = t;
    for (const [k, f] of failedLogins) if (f.until <= t && t - (f.first || 0) > 15 * 60_000) failedLogins.delete(k);
  };
  ctx.loginGuard = {
    key: (ip, phone) => `${ip}|${phone || ''}`,
    check(ip, phone) {
      pruneFailed();
      for (const k of [ctx.loginGuard.key(ip, phone), `${ip}|*`]) {
        const f = failedLogins.get(k);
        if (f && f.until > now()) fail(429, `Nhập sai quá nhiều lần. Thử lại sau ${Math.ceil((f.until - now()) / 60000)} phút`);
      }
    },
    failed(ip, phone) {
      pruneFailed();
      const bump = (k, max, lockMs, windowMs) => {
        let f = failedLogins.get(k);
        if (!f || (f.first && now() - f.first > windowMs)) f = { count: 0, until: 0, first: now() };
        f.count++;
        if (f.count >= max) { f.until = now() + lockMs; f.count = 0; f.first = now(); }
        failedLogins.set(k, f);
      };
      bump(ctx.loginGuard.key(ip, phone), 5, 2 * 60_000, 15 * 60_000);
      bump(`${ip}|*`, 30, 5 * 60_000, 10 * 60_000);
    },
    ok(ip, phone) { failedLogins.delete(ctx.loginGuard.key(ip, phone)); },
    size: () => failedLogins.size,
  };

  // File giao diện: nén (brotli / gzip) + ETag → lần sau điện thoại chỉ hỏi "có đổi không" (304), không tải lại.
  // index.html báo trước mọi file JS (modulepreload) để trình duyệt tải song song, không phải chờ từng lớp import.
  const staticCache = new Map();
  const preloadTags = (() => {
    try {
      const root = path.resolve(publicDir);
      const list = [];
      const walk = (dir) => { for (const n of readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, n.name); if (n.isDirectory()) walk(f); else if (n.name.endsWith('.js')) list.push('/' + path.relative(root, f).split(path.sep).join('/')); } };
      walk(root);
      return list.filter((x) => !/datban|sw\.js$|^\/cau-in\//.test(x)).map((x) => `<link rel="modulepreload" href="${x}">`).join('\n  ');
    } catch { return ''; }
  })();
  async function loadStatic(file) {
    const st = await stat(file);
    const hit = staticCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    let data = await readFile(file);
    if (path.basename(file) === 'index.html') {
      // Mỗi bản code có tiền tố /v/<mã>/ riêng: điện thoại (Safari) không dùng lại file giao diện cũ.
      // Import tương đối (không dùng importmap: Safari iOS < 16.4 không hỗ trợ) tự đi theo tiền tố; css + modulepreload sửa ở đây.
      const V = `/v/${version}`;
      const html = String(data)
        .replace('src="/app.js"', `src="${V}/app.js"`).replace('href="/style.css"', `href="${V}/style.css"`)
        .replace(/"\/vendor\//g, `"${V}/vendor/`)
        .replace('</head>', `  ${preloadTags.replace(/href="\//g, `href="${V}/`)}\n</head>`);
      data = Buffer.from(html);
    }
    const text = /\.(js|css|html|svg|json|webmanifest)$/.test(file);
    const entry = {
      mtime: st.mtimeMs, data, type: MIME[path.extname(file)] || 'application/octet-stream',
      etag: `"${createHash('sha1').update(data).digest('base64url').slice(0, 16)}"`,
      br: text && data.length > 1024 ? brotliCompressSync(data, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }) : null,
      gz: text && data.length > 1024 ? gzipSync(data, { level: 9 }) : null,
    };
    staticCache.set(file, entry);
    return entry;
  }
  async function serveStatic(res, pathname, req) {
    // /datban: trang khách tự đặt bàn (công khai, không cần đăng nhập)
    // /v/<mã bản>/... = file giao diện của 1 bản cố định → cho trình duyệt giữ lâu (đổi bản thì đổi đường dẫn)
    const ver = /^\/v\/[\w-]+\//.exec(pathname);
    if (ver) pathname = pathname.slice(ver[0].length - 1);
    const rel = pathname === '/' ? 'index.html' : pathname === '/datban' ? 'datban.html' : decodeURIComponent(pathname.slice(1));
    const root = path.resolve(publicDir);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end('Not found'); }
    try {
      const f = await loadStatic(file);
      const head = { 'Content-Type': f.type, 'Cache-Control': ver && !/\.html$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding' };
      if (req?.headers['if-none-match'] === f.etag) { res.writeHead(304, head); return res.end(); }
      const ae = String(req?.headers['accept-encoding'] || '');
      if (f.br && /\bbr\b/.test(ae)) { res.writeHead(200, { ...head, 'Content-Encoding': 'br', 'Content-Length': f.br.length }); return res.end(f.br); }
      if (f.gz && /gzip/.test(ae)) { res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', 'Content-Length': f.gz.length }); return res.end(f.gz); }
      res.writeHead(200, { ...head, 'Content-Length': f.data.length });
      res.end(f.data);
    } catch {
      // Ứng dụng một trang: đường dẫn lạ trả về index.html
      if (!path.extname(file)) return serveStatic(res, '/', req);
      res.writeHead(404); res.end('Not found');
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      let { token, me } = sessionOf(req);
      const net = clientIp(req);

      if (pathname === '/api/events') {
        if (!me) fail(401, 'Chưa đăng nhập');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
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
        if (route.role && me) {
          // Phân quyền từng mục (Cài đặt → Phân quyền): chặn mục bị bỏ, nâng quyền cho người được cấp riêng (không bao giờ thành chủ)
          const gate = apiGate(ctx, me, req.method, pathname);
          if (gate === 'deny') { const a = matchAct(req.method, pathname); fail(403, a ? `Bạn chưa được cấp quyền "${a.label}". Nhờ chủ quán bật ở Cài đặt → Phân quyền.` : 'Bạn chưa được cấp quyền mục này'); }
          // real_role = chức vụ thật (rà soát 28/10): lệnh nhạy cảm (đặt PIN, lương, sửa người cấp cao) xét theo chức vụ thật, không theo quyền được nâng
          if (gate && route.role !== 'owner') me = { ...me, role: gate, real_role: me.role };
        }
        if (route.role) ctx.need(me, route.role);
        // Chủ quán 28/10: chỉ người ĐANG TRONG CA (đã chấm công vào, chưa chấm ra) mới gọi món / gửi bếp / huỷ / tính tiền.
        // Chủ quán + quản lý không bị chặn. Bật / tắt ở Cài đặt → Chấm công (pos_need_shift)
        if (me && req.method !== 'GET' && /^\/api\/(pos|payments)\//.test(pathname) && rank(me.real_role || me.role) < rank('manager')
          && ctx.setting('pos_need_shift') === '1' && !db.prepare('SELECT 1 FROM attendance WHERE staff_id = ? AND clock_out IS NULL').get(me.id)) {
          fail(403, 'Bạn chưa chấm công vào ca (hoặc đã chấm ra) nên chưa thao tác order / tính tiền được. Chấm công vào ở trang Hôm nay.');
        }
        try { ctx.seenAtShop?.(me, net); } catch { /* không chặn lệnh */ }
        // Chủ quán 29/10: chấm công rồi về nhà vẫn order được → order / tính tiền phải đang ở quán (wifi quán hoặc GPS trong 10 phút).
        // Chủ + quản lý không bị chặn. Tắt ở Cài đặt → Chấm công (pos_need_at_shop = 0). Quán chưa cài GPS / wifi thì không kiểm được, bỏ qua
        if (me && req.method !== 'GET' && /^\/api\/(pos|payments)\//.test(pathname) && rank(me.real_role || me.role) < rank('manager')
          && ctx.setting('pos_need_at_shop') !== '0' && ctx.shopCheckable?.() && !ctx.onShopWifi?.(net) && !ctx.atShopRecently?.(me.id)) {
          fail(403, '📍 Bạn đang ở ngoài quán nên chưa order / tính tiền được. Bật định vị cho app (hoặc vào wifi quán) rồi bấm lại.', 'need_location');
        }
        if (req.method !== 'GET') {
          // Chỉ nhận JSON để chặn trang web lạ gửi lệnh thay người dùng
          if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Cần gửi dữ liệu dạng JSON');
        }
        // Bill mua hàng gửi kèm tới 8 ảnh (bill + hàng, mỗi ảnh ~1 MB) → cho phép 16 MB khi đã đăng nhập (chủ quán 26/10: "Dữ liệu gửi lên quá lớn")
        const big = me && /^\/api\/(purchases|supplier-payments|suppliers\/\d+\/pay|sapo|jobs|checklists|checklist-|attendance|expenses)/.test(pathname); // việc ca báo xong nhiều ảnh (chủ quán 28/10)
        const body = req.method === 'GET' ? {} : await readJson(req, big ? 16_000_000 : 2_000_000);
        const out = await route.fn({ req, res, url, query: url.searchParams, params, body, me, token, net });
        if (out && out.__binary) {
          res.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': out.filename ? 'no-store' : 'private, max-age=86400', 'Content-Length': out.__binary.length, ...(out.filename ? { 'Content-Disposition': `attachment; filename="${out.filename}"` } : {}) });
          return res.end(out.__binary);
        }
        return sendJson(res, 200, out ?? { ok: true });
      }

      if (req.method !== 'GET') fail(405, 'Không hỗ trợ');
      return serveStatic(res, pathname, req);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.extra || {}) });
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

// IP thật của người dùng (rà soát 28/10). Trước đây tin thẳng header cf-connecting-ip / X-Forwarded-For đầu tiên → ai cũng giả được IP
// (vượt khoá dò PIN, giả wifi quán khi chấm công). Giờ:
// - Sau proxy cloud (TRUST_PROXY=1, Railway): lấy X-Forwarded-For từ PHẢI sang, bỏ qua các chặng mạng nội bộ của proxy → địa chỉ do proxy ghi thêm.
// - Chỉ tin cf-connecting-ip khi chặng ngay trước là máy của Cloudflare (dải IP công bố bên dưới), hoặc cloudflared chạy ngay trên máy này (127.0.0.1, máy chủ ở quán).
// Dải IP Cloudflare: https://www.cloudflare.com/ips-v4 và /ips-v6 (cập nhật khi Cloudflare đổi).
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', 'fc00::/7', 'fe80::/10', '::1/128'];
const mkList = (ranges) => {
  const bl = new nodeNet.BlockList();
  for (const r of ranges) { const [a, n] = r.split('/'); bl.addSubnet(a, Number(n), nodeNet.isIPv6(a) ? 'ipv6' : 'ipv4'); }
  return bl;
};
const CF_LIST = mkList(CLOUDFLARE_RANGES);
const PRIVATE_LIST = mkList(PRIVATE_RANGES);
const normIp = (x) => String(x || '').trim().replace(/^::ffff:(?=\d+\.)/i, '');
const inList = (bl, ip) => { const f = nodeNet.isIP(ip); return f ? bl.check(ip, f === 6 ? 'ipv6' : 'ipv4') : false; };
export const isCloudflareIp = (ip) => inList(CF_LIST, normIp(ip));

export function resolveClientIp(headers, socketAddr, trustProxy) {
  const sock = normIp(socketAddr);
  let peer = sock;
  // Railway (tài liệu public-networking): IP thật của khách nằm ở X-Real-IP do edge Railway đặt → ưu tiên
  const realIp = trustProxy ? normIp(Array.isArray(headers['x-real-ip']) ? headers['x-real-ip'][0] : headers['x-real-ip']) : '';
  if (realIp && nodeNet.isIP(realIp)) peer = realIp;
  else if (trustProxy) {
    const hops = String(headers['x-forwarded-for'] || '').split(',').map(normIp).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!nodeNet.isIP(hops[i])) break; // giá trị lạ: dừng, không đi tiếp vào phần người dùng tự ghi
      peer = hops[i];
      if (!inList(PRIVATE_LIST, hops[i])) break;
    }
  }
  const cf = normIp(Array.isArray(headers['cf-connecting-ip']) ? headers['cf-connecting-ip'][0] : headers['cf-connecting-ip']);
  const viaCf = Boolean(cf && nodeNet.isIP(cf) && (isCloudflareIp(peer) || (!trustProxy && /^(127\.|::1$)/.test(sock))));
  return { ip: viaCf ? cf : peer, remote: viaCf };
}
