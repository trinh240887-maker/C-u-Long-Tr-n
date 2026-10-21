import { fail, v } from '../http.js';
import { parseOffset, parseHM } from '../lib/time.js';
import { runBackup, listBackups } from '../backup.js';

const SECRET_KEYS = ['zalo_secret_key', 'zalo_access_token', 'zalo_refresh_token'];
const FIELDS = {
  shop_name: (x) => v.text(x, { name: 'Tên quán', required: true, max: 80 }),
  public_url: (x) => {
    const s = v.text(x, { name: 'Địa chỉ truy cập từ xa', max: 200 });
    if (s && !/^https:\/\/[^\s/]+/.test(s)) fail(400, 'Địa chỉ truy cập từ xa phải bắt đầu bằng https://');
    return s.replace(/\/$/, '');
  },
  tz_offset: (x) => { parseOffset(x); return String(x); },
  day_cutoff_hour: (x) => String(v.int(x, { min: 0, max: 12, name: 'Giờ chốt ngày' })),
  late_grace_minutes: (x) => String(v.int(x, { min: 0, max: 60, name: 'Số phút cho phép trễ' })),
  clock_early_minutes: (x) => String(v.int(x, { min: 0, max: 240, name: 'Số phút được chấm sớm' })),
  auto_close_after_minutes: (x) => String(v.int(x, { min: 15, max: 720, name: 'Thời gian tự đóng ca' })),
  clock_ip_prefixes: (x) => {
    const s = v.text(x, { name: 'Dải IP wifi quán', max: 200 });
    for (const p of s.split(',').map((y) => y.trim()).filter(Boolean)) if (!/^[0-9a-f.:]+$/i.test(p)) fail(400, `Dải IP không hợp lệ: ${p}`);
    return s;
  },
  night_bonus_pct: (x) => String(v.int(x, { min: 0, max: 300, name: 'Phụ cấp làm đêm' })),
  month_standard_days: (x) => String(v.int(x, { min: 0, max: 31, name: 'Ngày công chuẩn' })),
  quiet_from: (x) => { parseHM(x); return String(x); },
  quiet_to: (x) => { parseHM(x); return String(x); },
  zalo_enabled: (x) => String(v.bool(x)),
  zalo_app_id: (x) => v.text(x, { name: 'Zalo App ID', max: 64 }),
  zalo_secret_key: (x) => v.text(x, { name: 'Zalo Secret key', max: 200 }),
  zalo_access_token: (x) => v.text(x, { name: 'Access token', max: 2000 }),
  zalo_refresh_token: (x) => v.text(x, { name: 'Refresh token', max: 2000 }),
  reserve_hold_minutes: (x) => String(v.int(x, { min: 0, max: 120, name: 'Giữ bàn' })),
  wash_cycle_minutes: (x) => String(v.int(x, { min: 1, max: 240, name: 'Thời gian rửa 1 mẻ' })),
  dining_minutes: (x) => String(v.int(x, { min: 10, max: 300, name: 'Thời gian khách ngồi' })),
  utensil_reserve_pct: (x) => String(v.int(x, { min: 0, max: 100, name: 'Dự phòng' })),
  avail_deadline_dow: (x) => String(v.int(x, { min: 1, max: 7, name: 'Ngày hạn báo lịch rảnh' })),
  avail_deadline_time: (x) => { parseHM(x); return String(x); },
  avail_slots: (x) => {
    const list = typeof x === 'string' ? JSON.parse(x) : x;
    if (!Array.isArray(list) || !list.length || list.length > 6) fail(400, 'Buổi không hợp lệ');
    return JSON.stringify(list.map((s, i) => {
      const label = v.text(s.label, { name: 'Tên buổi', required: true, max: 20 });
      if (!/^\d\d:\d\d$/.test(s.start) || !/^\d\d:\d\d$/.test(s.end)) fail(400, `Giờ của buổi ${label} không hợp lệ`);
      return { key: String(s.key || `b${i}`).slice(0, 12), label, start: s.start, end: s.end };
    }));
  },
  kho_tong_staff_id: (x) => (x === '' || x === null ? '' : String(v.int(x, { min: 1, name: 'Người giữ kho tổng' }))),
};

export default function (r, ctx) {
  const { db } = ctx;

  function view() {
    const out = {};
    for (const k of Object.keys(FIELDS)) {
      const val = ctx.setting(k);
      out[k] = SECRET_KEYS.includes(k) ? (val ? `••••${val.slice(-4)}` : '') : val;
    }
    out.zalo_webhook_path = `/webhooks/zalo/${ctx.setting('zalo_webhook_key')}`;
    out.backups = listBackups(ctx.backupDir).slice(0, 10);
    return out;
  }

  r.get('/api/settings', 'manager', () => view());

  r.put('/api/settings', 'manager', ({ me, body }) => {
    const changes = {};
    for (const [k, parse] of Object.entries(FIELDS)) {
      if (body[k] === undefined) continue;
      if (SECRET_KEYS.includes(k) && (body[k] === '' || String(body[k]).startsWith('••••'))) continue; // giữ nguyên khoá cũ
      changes[k] = parse(body[k]);
    }
    if (changes.zalo_access_token) changes.zalo_token_expires_at = String(ctx.now() + 3600_000);
    for (const [k, val] of Object.entries(changes)) ctx.setSetting(k, val);
    ctx.audit(me, 'settings.update', Object.keys(changes).join(', '));
    ctx.broadcast('settings');
    return view();
  });

  r.post('/api/settings/zalo-test', 'manager', async ({ me }) => {
    const st = ctx.staff(me.id);
    if (!st.zalo_user_id) fail(400, 'Tài khoản của bạn chưa liên kết Zalo');
    try {
      await ctx.notifier.transport.send({ userId: st.zalo_user_id, text: `Thử gửi từ app ${ctx.setting('shop_name')}: kết nối Zalo OA hoạt động.` });
    } catch (e) {
      fail(502, e.message);
    }
    return { ok: true };
  });

  r.post('/api/backup', 'manager', ({ me }) => {
    if (!ctx.backupDir) fail(400, 'Chưa cấu hình thư mục sao lưu');
    const file = runBackup(db, ctx.backupDir, { now: ctx.now() });
    ctx.audit(me, 'backup', file);
    return { ok: true, backups: listBackups(ctx.backupDir).slice(0, 10) };
  });

  r.get('/api/audit', 'manager', () => db.prepare(`SELECT a.*, s.name AS staff_name FROM audit_log a LEFT JOIN staff s ON s.id = a.staff_id ORDER BY a.id DESC LIMIT 300`).all());
}
