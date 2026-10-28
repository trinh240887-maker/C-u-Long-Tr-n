import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail, v } from '../http.js';
import { parseOffset, parseHM } from '../lib/time.js';
import { runBackup, listBackups } from '../backup.js';
import { readStatic } from '../lib/vietqr.js';
import { loadPerms, ROLES_EDITABLE, PAGES, actsOf } from '../lib/perms.js';
import { ACT_GROUPS, ACTS, loadUserActs } from '../lib/acts.js';

const SECRET_KEYS = ['zalo_secret_key', 'zalo_access_token', 'zalo_refresh_token', 'anthropic_api_key', 'zalo_bot_token'];
const OWNER_ONLY = ['anthropic_api_key', 'zalo_bot_token', 'zalo_bot_group_id', 'zalo_bot_group_name', 'zalo_bot_staff_group_id', 'zalo_bot_staff_group_name', 'avail_bot_on', 'avail_bot_teams']; // mã tốn tiền / điều khiển bot: chỉ chủ quán dán
const FIELDS = {
  shop_name: (x) => v.text(x, { name: 'Tên quán', required: true, max: 80 }),
  shop_address: (x) => v.text(x, { name: 'Địa chỉ quán', max: 160 }),
  zns_enabled: (x) => String(v.bool(x)),
  zns_mode: (x) => v.oneOf(x, ['development', 'production'], { name: 'Chế độ Zalo ZNS' }),
  zns_template_confirm: (x) => v.text(x, { name: 'Mã mẫu xác nhận', max: 20 }).replace(/\D/g, ''),
  zns_template_reject: (x) => v.text(x, { name: 'Mã mẫu từ chối', max: 20 }).replace(/\D/g, ''),
  zns_template_remind: (x) => v.text(x, { name: 'Mã mẫu nhắc', max: 20 }).replace(/\D/g, ''),
  zns_template_cancel: (x) => v.text(x, { name: 'Mã mẫu tự huỷ', max: 20 }).replace(/\D/g, ''),
  zns_template_queue: (x) => v.text(x, { name: 'Mã mẫu vào danh sách chờ', max: 20 }).replace(/\D/g, ''),
  zns_template_ready: (x) => v.text(x, { name: 'Mã mẫu đã có bàn', max: 20 }).replace(/\D/g, ''),
  labor_target_pct: (x) => String(v.int(x, { min: 5, max: 80, name: '% lương / doanh thu mục tiêu' })),
  idle_alert_minutes: (x) => String(v.int(x, { min: 15, max: 240, name: 'Phút không thao tác' })),
  sell_deducts_stock: (x) => String(v.bool(x)),
  low_portions_alert: (x) => String(v.int(x, { min: 0, max: 100, name: 'Báo sắp hết khi còn' })),
  purchase_report_time: (x) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x))) fail(400, 'Giờ tổng hợp dạng HH:MM'); return String(x); },
  supplier_pay_approve_over: (x) => String(v.int(Number(String(x).replace(/[.,\s]/g, '')), { min: 0, max: 1_000_000_000, name: 'Mức chi NCC cần duyệt' })),
  spot_photos_per_run: (x) => String(v.int(x, { min: 0, max: 5, name: 'Số việc kiểm tra ngẫu nhiên' })),
  count_tolerance_pct: (x) => String(v.int(x, { min: 0, max: 50, name: '% lệch kiểm kho cho phép' })),
  bill_reader_daily_max: (x) => String(v.int(x, { min: 0, max: 1000, name: 'Số bill đọc tự động / ngày' })),
  price_jump_pct: (x) => String(v.int(x, { min: 1, max: 200, name: '% giá tăng bất thường' })),
  table_clear_minutes: (x) => String(v.int(x, { min: 0, max: 60, name: 'Thời gian dọn bàn' })),
  wait_call_minutes: (x) => String(v.int(x, { min: 1, max: 30, name: 'Chờ khách vào sau khi mời' })),
  wait_big_protect_minutes: (x) => String(v.int(x, { min: 0, max: 120, name: 'Giữ bàn ghép cho nhóm đông sau' })),
  online_booking_enabled: (x) => String(v.bool(x)),
  online_open: (x) => { parseHM(x); return String(x); },
  online_last: (x) => { parseHM(x); return String(x); },
  online_max_guests: (x) => String(v.int(x, { min: 1, max: 200, name: 'Số khách tối đa' })),
  online_min_lead_minutes: (x) => String(v.int(x, { min: 0, max: 1440, name: 'Đặt trước tối thiểu' })),
  shop_phone: (x) => v.text(x, { name: 'SĐT quán', max: 20 }),
  bank_name: (x) => v.text(x, { name: 'Tên ngân hàng', max: 40 }),
  bank_qr: (x) => {
    const s = v.text(x, { name: 'Mã QR ngân hàng', max: 512 });
    if (!s) return '';
    let info;
    try { info = readStatic(s); } catch (e) { fail(400, e.message); }
    if (!info.valid) fail(400, 'Mã QR sai mã kiểm tra, quét lại');
    return s;
  },
  public_url: (x) => {
    const s = v.text(x, { name: 'Địa chỉ truy cập từ xa', max: 200 });
    if (s && !/^https:\/\/[^\s/]+/.test(s)) fail(400, 'Địa chỉ truy cập từ xa phải bắt đầu bằng https://');
    return s.replace(/\/$/, '');
  },
  tz_offset: (x) => { parseOffset(x); return String(x); },
  day_cutoff_hour: (x) => String(v.int(x, { min: 0, max: 12, name: 'Giờ chốt ngày' })),
  pos_need_shift: (x) => (x === true || x === '1' || x === 1 ? '1' : '0'), // chỉ người đang trong ca mới order (chủ quán 28/10)
  late_grace_minutes: (x) => String(v.int(x, { min: 0, max: 60, name: 'Số phút cho phép trễ' })),
  clock_early_minutes: (x) => String(v.int(x, { min: 0, max: 240, name: 'Số phút được chấm sớm' })),
  auto_close_after_minutes: (x) => String(v.int(x, { min: 15, max: 720, name: 'Thời gian tự đóng ca' })),
  clock_ip_prefixes: (x) => {
    const s = v.text(x, { name: 'Dải IP wifi quán', max: 200 });
    for (const p of s.split(',').map((y) => y.trim()).filter(Boolean)) if (!/^[0-9a-f.:]+$/i.test(p)) fail(400, `Dải IP không hợp lệ: ${p}`);
    return s;
  },
  shop_lat: (x) => { if (x === '' || x == null) return ''; const n = Number(x); if (!Number.isFinite(n) || n < -90 || n > 90) fail(400, 'Vĩ độ không hợp lệ'); return String(n); },
  shop_lng: (x) => { if (x === '' || x == null) return ''; const n = Number(x); if (!Number.isFinite(n) || n < -180 || n > 180) fail(400, 'Kinh độ không hợp lệ'); return String(n); },
  clock_radius_m: (x) => String(v.int(x, { min: 30, max: 2000, name: 'Bán kính chấm công' })),
  night_bonus_pct: (x) => String(v.int(x, { min: 0, max: 300, name: 'Phụ cấp làm đêm' })),
  month_standard_days: (x) => String(v.int(x, { min: 0, max: 31, name: 'Ngày công chuẩn' })),
  pay_period_start_day: (x) => String(v.int(x, { min: 1, max: 28, name: 'Ngày bắt đầu kỳ lương' })),
  month_paid_off_days: (x) => String(v.int(x, { min: 0, max: 15, name: 'Ngày nghỉ có lương' })),
  ot_daily_hours: (x) => String(v.int(x, { min: 0, max: 16, name: 'Giờ chuẩn / ngày' })),
  ot_rate: (x) => { const n = Number(String(x).replace(',', '.')); if (!(n >= 1 && n <= 4)) fail(400, 'Hệ số vượt giờ từ 1 đến 4'); return String(n); },
  quiet_from: (x) => { parseHM(x); return String(x); },
  quiet_to: (x) => { parseHM(x); return String(x); },
  zalo_enabled: (x) => String(v.bool(x)),
  zalo_app_id: (x) => v.text(x, { name: 'Zalo App ID', max: 64 }),
  zalo_secret_key: (x) => v.text(x, { name: 'Zalo Secret key', max: 200 }),
  anthropic_api_key: (x) => v.text(x, { name: 'Mã Claude (đọc bill)', max: 300 }).trim(),
  zalo_bot_token: (x) => v.text(x, { name: 'Token Zalo Bot', max: 300 }).trim(),
  zalo_bot_group_id: (x) => v.text(x, { name: 'Nhóm Zalo nhận đơn', max: 100 }).trim(),
  zalo_bot_group_name: (x) => v.text(x, { name: 'Tên nhóm', max: 120 }),
  zalo_bot_staff_group_id: (x) => v.text(x, { name: 'Nhóm Zalo nhân viên', max: 100 }).trim(),
  zalo_bot_staff_group_name: (x) => v.text(x, { name: 'Tên nhóm', max: 120 }),
  avail_bot_teams: (x) => JSON.stringify((Array.isArray(x) ? x : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 30)),
  avail_bot_on: (x) => (x === false || x === '0' || x === 0 ? '0' : '1'),
  zalo_access_token: (x) => v.text(x, { name: 'Access token', max: 2000 }),
  zalo_refresh_token: (x) => v.text(x, { name: 'Refresh token', max: 2000 }),
  reserve_hold_minutes: (x) => String(v.int(x, { min: 0, max: 120, name: 'Giữ bàn' })),
  booking_brief_time: (x) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x))) fail(400, 'Giờ tóm tắt đặt bàn dạng HH:MM'); return String(x); },
  reserve_block_minutes: (x) => String(v.int(x, { min: 0, max: 240, name: 'Khoá bàn trước giờ đặt' })),
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
    out.avail_bot_teams = ctx.availBotTeams?.() || [];
    out.zalo_webhook_path = `/webhooks/zalo/${ctx.setting('zalo_webhook_key')}`;
    out.backups = listBackups(ctx.backupDir).slice(0, 10);
    return out;
  }

  r.get('/api/settings', 'manager', () => view());

  // ---------- Phân quyền từng mục (chỉ chủ quán) ----------
  const permView = () => ({
    roles: ROLES_EDITABLE,
    pages: loadPerms(ctx),
    teams: db.prepare('SELECT id, name FROM teams WHERE active = 1 ORDER BY sort, id').all(),
    staff: db.prepare("SELECT s.id, s.name, s.role, s.team_id, t.name AS team_name FROM staff s LEFT JOIN teams t ON t.id = s.team_id WHERE s.active = 1 AND s.role != 'owner' ORDER BY s.name").all(),
  });
  r.get('/api/permissions', 'owner', () => permView());
  r.put('/api/permissions', 'owner', ({ me, body }) => {
    const ids = new Set(db.prepare('SELECT id FROM staff WHERE active = 1').all().map((x) => x.id));
    const out = {};
    for (const p of PAGES) {
      if (p.fixed) continue;
      const c = body.pages?.[p.path];
      if (!c) continue;
      out[p.path] = {
        roles: (Array.isArray(c.roles) ? c.roles : []).filter((x) => ROLES_EDITABLE.includes(x)),
        allow: [...new Set((c.allow || []).map(Number).filter((x) => ids.has(x)))],
        deny: [...new Set((c.deny || []).map(Number).filter((x) => ids.has(x)))],
        teams: Array.isArray(c.teams) ? [...new Set(c.teams.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : null,
      };
    }
    ctx.setSetting('perm_pages', JSON.stringify(out));
    ctx.audit(me, 'perm.update', Object.keys(out).length);
    ctx.broadcast('me');
    return permView();
  });

  // ---------- Quyền chi tiết từng người (chủ quán 26/10) ----------
  const actView = (staffId) => {
    const st = db.prepare('SELECT id, name, role, team_id FROM staff WHERE id = ? AND active = 1').get(staffId);
    if (!st) fail(404, 'Không tìm thấy nhân viên');
    const { acts, defaults, overrides } = actsOf(ctx, st);
    return {
      staff: { ...st, team_name: st.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(st.team_id)?.name || '' : '' },
      owner: st.role === 'owner',
      groups: ACT_GROUPS.map((g) => ({ name: g.name, acts: g.acts.map((a) => ({ key: a.key, label: a.label, on: acts[a.key], def: defaults[a.key], custom: typeof overrides[a.key] === 'boolean' })) })),
    };
  };
  r.get('/api/permissions/acts', 'owner', ({ query }) => actView(v.int(query.get('staff_id'), { min: 1, name: 'Nhân viên' })));
  r.put('/api/permissions/acts', 'owner', ({ me, body }) => {
    const staffId = v.int(body.staff_id, { min: 1, name: 'Nhân viên' });
    const st = db.prepare('SELECT id, role FROM staff WHERE id = ? AND active = 1').get(staffId);
    if (!st) fail(404, 'Không tìm thấy nhân viên');
    if (st.role === 'owner') fail(400, 'Chủ quán luôn có mọi quyền');
    const all = loadUserActs(ctx);
    const cur = { ...(all[String(staffId)] || {}) };
    const valid = new Set(ACTS.map((a) => a.key));
    for (const [k, val] of Object.entries(body.overrides || {})) {
      if (!valid.has(k)) continue;
      if (val === null) delete cur[k]; else cur[k] = !!val;
    }
    if (body.reset) for (const k of Object.keys(cur)) delete cur[k];
    if (Object.keys(cur).length) all[String(staffId)] = cur; else delete all[String(staffId)];
    ctx.setSetting('perm_user', JSON.stringify(all));
    ctx.audit(me, 'perm.user', { staff_id: staffId, n: Object.keys(cur).length });
    ctx.broadcast('me');
    return actView(staffId);
  });

  // ---------- Zalo Bot: kiểm tra, tìm nhóm, gửi thử (chủ quán) ----------
  const owner = (me) => { if (me.role !== 'owner') fail(403, 'Chỉ chủ quán'); };
  r.post('/api/zalo-bot/check', 'manager', async ({ me }) => {
    owner(me);
    try { const bot = await ctx.zaloBot.call('getMe'); ctx.saveBotNames?.(bot); return { ok: true, bot }; } catch (e) { fail(502, e.message); }
  });
  r.get('/api/zalo-bot/log', 'manager', ({ me }) => { owner(me); return ctx.zaloBotLog?.() || {}; });
  r.post('/api/zalo-bot/chats', 'manager', async ({ me }) => { owner(me); try { return { chats: await ctx.zaloBot.chats() }; } catch (e) { fail(502, e.message); } });
  r.post('/api/zalo-bot/test', 'manager', async ({ me }) => {
    owner(me);
    const gid = ctx.setting('zalo_bot_group_id');
    if (!gid) fail(400, 'Chưa chọn nhóm');
    try { await ctx.zaloBot.send(gid, `✅ ${ctx.setting('shop_name') || 'Quán'}: bot đã nối với nhóm, đơn đặt hàng duyệt xong sẽ tự gửi vào đây.`); } catch (e) { fail(502, e.message); }
    return { ok: true };
  });
  // Nhóm nhân viên: gửi thử = gửi ngay tin nhắc lịch rảnh tuần tới
  r.post('/api/zalo-bot/test-staff', 'manager', async ({ me, body }) => {
    owner(me);
    const g = ctx.staffGroups().find((x) => x.id === String(body.id || '')) || ctx.staffGroups()[0];
    if (!g) fail(400, 'Chưa chọn nhóm nhân viên');
    try { await ctx.zaloBot.send(g.id, ctx.availGroupText(null, g.id)); } catch (e) { fail(502, e.message); }
    return { ok: true };
  });
  // Danh sách nhóm nhân viên: mỗi nhóm chọn bộ phận được nhắc (vd nhóm chung: Phục vụ + Tiếp thực; nhóm Bếp: các tổ bếp)
  r.get('/api/zalo-bot/staff-groups', 'manager', ({ me }) => { owner(me); return { groups: ctx.staffGroups() }; });
  r.put('/api/zalo-bot/staff-groups', 'manager', ({ me, body }) => {
    owner(me);
    const list = (Array.isArray(body.groups) ? body.groups : []).map((g) => ({
      id: v.text(g.id, { name: 'Mã nhóm', required: true, max: 100 }).trim(),
      name: v.text(g.name, { name: 'Tên nhóm', max: 120 }) || 'Nhóm nhân viên',
      teams: (Array.isArray(g.teams) ? g.teams : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 30),
    }));
    if (new Set(list.map((g) => g.id)).size !== list.length) fail(400, 'Nhóm bị trùng');
    ctx.saveStaffGroups(list);
    ctx.audit(me, 'zalo_bot.staff_groups', { n: list.length });
    return { groups: ctx.staffGroups() };
  });
  r.put('/api/settings', 'manager', ({ me, body }) => {
    const changes = {};
    for (const [k, parse] of Object.entries(FIELDS)) {
      if (body[k] === undefined) continue;
      if (SECRET_KEYS.includes(k) && (body[k] === '' || String(body[k]).startsWith('••••'))) continue; // giữ nguyên khoá cũ
      if (OWNER_ONLY.includes(k) && me.role !== 'owner') fail(403, 'Chỉ chủ quán dán mã này');
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

  // Tải toàn bộ dữ liệu về 1 file (chủ quán): dùng để chuyển sang máy chủ ở quán / cất giữ
  r.get('/api/backup/download', 'owner', ({ me }) => {
    const file = runBackup(db, ctx.backupDir || path.join(os.tmpdir(), 'clt-backup'));
    ctx.audit(me, 'backup.download', path.basename(file));
    return { __binary: fs.readFileSync(file), type: 'application/octet-stream', filename: `cuu-long-tran-${ctx.today()}.db` };
  });

  r.get('/api/audit', 'manager', () => db.prepare(`SELECT a.*, s.name AS staff_name FROM audit_log a LEFT JOIN staff s ON s.id = a.staff_id ORDER BY a.id DESC LIMIT 300`).all());
}
