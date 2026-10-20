import { createZaloOaTransport } from './zalo-oa.js';
import { parseHM } from '../lib/time.js';

const RETRY_MINUTES = [1, 5, 15, 60, 180];

// Thông báo: luôn lưu trong app, và (nếu bật) gửi qua Zalo OA với hàng đợi gửi lại khi lỗi.
export function createNotifier(ctx, { transport } = {}) {
  const { db } = ctx;
  const zalo = transport || createZaloOaTransport(ctx);
  let timer = null;
  let running = false;

  function inQuietHours(ms) {
    try {
      const clock = ctx.clock();
      const m = clock.minuteOf(ms);
      const from = parseHM(ctx.setting('quiet_from') || '23:00');
      const to = parseHM(ctx.setting('quiet_to') || '07:00');
      if (from === to) return null;
      const quiet = from < to ? m >= from && m < to : m >= from || m < to;
      if (!quiet) return null;
      // thời điểm hết giờ yên lặng
      let wait = to - m;
      if (wait <= 0) wait += 1440;
      return ms + wait * 60_000;
    } catch {
      return null;
    }
  }

  function notify(staffIds, { title, body = '', link = '', urgent = false }) {
    const ids = [...new Set((Array.isArray(staffIds) ? staffIds : [staffIds]).filter(Boolean))];
    if (!ids.length) return;
    const enabled = ctx.setting('zalo_enabled') === '1';
    const t = ctx.now();
    const insert = db.prepare(`INSERT INTO notifications (staff_id, title, body, link, urgent, created_at, zalo_status, zalo_next_at, zalo_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const id of ids) {
      const st = db.prepare('SELECT zalo_user_id, active FROM staff WHERE id = ?').get(id);
      if (!st || !st.active) continue;
      let status = 'pending';
      let error = '';
      if (!enabled) { status = 'skipped'; error = 'Chưa bật gửi Zalo'; }
      else if (!st.zalo_user_id) { status = 'skipped'; error = 'Nhân viên chưa liên kết Zalo'; }
      const next = urgent ? t : (inQuietHours(t) ?? t);
      insert.run(id, title, body, link, urgent ? 1 : 0, t, status, next, error);
    }
    ctx.broadcast('notifications');
    if (enabled) setImmediate(() => processQueue().catch(() => {}));
  }

  async function processQueue() {
    if (running) return;
    running = true;
    try {
      const due = db.prepare(`SELECT n.*, s.zalo_user_id FROM notifications n JOIN staff s ON s.id = n.staff_id
        WHERE n.zalo_status = 'pending' AND n.zalo_next_at <= ? ORDER BY n.id LIMIT 20`).all(ctx.now());
      for (const n of due) {
        const text = [n.title, n.body].filter(Boolean).join('\n') + (n.link ? `\n${publicLink(n.link)}` : '');
        try {
          await zalo.send({ userId: n.zalo_user_id, text });
          db.prepare("UPDATE notifications SET zalo_status = 'sent', zalo_attempts = zalo_attempts + 1, zalo_error = '' WHERE id = ?").run(n.id);
        } catch (err) {
          const attempts = n.zalo_attempts + 1;
          const done = attempts >= RETRY_MINUTES.length || err.permanent;
          db.prepare('UPDATE notifications SET zalo_status = ?, zalo_attempts = ?, zalo_next_at = ?, zalo_error = ? WHERE id = ?')
            .run(done ? 'failed' : 'pending', attempts, ctx.now() + RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length - 1)] * 60_000,
              String(err.message || err).slice(0, 300), n.id);
        }
      }
    } finally {
      running = false;
    }
  }

  function publicLink(link) {
    const base = (ctx.setting('public_url') || '').replace(/\/$/, '');
    return base ? `${base}${link}` : '';
  }

  // Nhân viên nhắn mã liên kết cho OA → Zalo gọi webhook này → ghi nhận user_id của họ.
  function matchWebhook(method, pathname) {
    const m = /^\/webhooks\/zalo\/([a-f0-9]{32})$/.exec(pathname);
    if (!m || method !== 'POST' || m[1] !== ctx.setting('zalo_webhook_key')) return null;
    return (event) => {
      const userId = String(event?.sender?.id || '');
      const text = String(event?.message?.text || '').toUpperCase();
      const code = /\b([A-Z0-9]{6})\b/.exec(text)?.[1];
      if (event?.event_name === 'user_send_text' && userId && code) {
        const st = db.prepare('SELECT id, name FROM staff WHERE zalo_link_code = ? AND active = 1').get(code);
        if (st) {
          db.prepare('UPDATE staff SET zalo_user_id = ?, zalo_link_code = NULL WHERE id = ?').run(userId, st.id);
          ctx.audit({ id: st.id }, 'zalo.linked', userId);
          ctx.broadcast('staff');
          zalo.send({ userId, text: `Đã liên kết Zalo cho ${st.name}. Bạn sẽ nhận thông báo ca làm qua đây.` }).catch(() => {});
        }
      }
      return { ok: true };
    };
  }

  function start() {
    if (!timer) timer = setInterval(() => processQueue().catch(() => {}), 30_000);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { notify, processQueue, matchWebhook, start, stop, transport: zalo };
}
