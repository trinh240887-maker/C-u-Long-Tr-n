// Phân quyền từng mục menu. Chủ quán chỉnh ở Cài đặt → Phân quyền (setting `perm_pages`).
// Mỗi mục: vai trò được thấy + người được cấp riêng (allow) + người bị chặn riêng (deny). Chủ quán luôn thấy hết.
// api: các đường API riêng của mục đó (w = chỉ lệnh ghi, all = cả xem) → bị chặn nếu không có quyền,
// và được nâng quyền (tối đa Quản lý) khi chủ quán cấp riêng cho người thấp hơn.
import { rank } from '../db.js';
import { ACTS, matchAct, overridesOf, defaultAct, actByKey } from './acts.js';

export const ROLES_EDITABLE = ['staff', 'team_lead', 'shift_lead', 'manager'];
export const PAGES = [
  { path: '/', label: 'Hôm nay', role: 'staff', fixed: true },
  { path: '/quan-ly', label: 'Quản lý', role: 'shift_lead' },
  // Xếp ca là quyền riêng: chủ quán cấp cho ai thì người đó xếp được (màn Lịch rảnh → Xếp ca). Đặt TRƯỚC /lich
  { path: '/lich#xep', label: 'Lịch ca › Xếp ca, công bố lịch', role: 'manager', sub: true, api: [['/api/shifts', 'all'], ['/api/schedule/copy', 'all'], ['/api/schedule/week-zones', 'all'], ['/api/schedule/publish', 'all'], ['/api/schedule/publish-team', 'all'], ['/api/schedule/team-image', 'all'], ['/api/availability/remind', 'all']] },
  { path: '/lich', label: 'Lịch ca (xem)', role: 'staff' },
  { path: '/ban', label: 'Sơ đồ bàn + Gọi món', role: 'staff', teamsDefault: /^(phục vụ|phuc vu|thu ngân|thu ngan)$/i, api: [['/api/pos/sessions', 'w'], ['/api/pos/tables', 'w']] },
  { path: '/kho', label: 'Kho', role: 'staff', teamsDefault: /bếp|bep|bar|lẩu|lau|tạp vụ|tap vu/i, api: [['/api/stock/receive', 'w'], ['/api/stock/transfers', 'w'], ['/api/stock/po', 'w'], ['/api/stock/ingredients', 'w'], ['/api/stock/stores', 'w'], ['/api/stock/suppliers', 'w'], ['/api/stock/nxt', 'all']] },
  { path: '/kho-tx', label: 'Kho & Tài sản (chứng từ: ghi huỷ, báo hỏng, đồ đang giữ…)', role: 'staff' },
  { path: '/checklist', label: 'Checklist', role: 'staff' },
  { path: '/viec-ca', label: 'Việc ca (nhận việc, bảng khu, kiểm tra)', role: 'staff' },
  { path: '/chi', label: 'Phiếu chi (chi từ két, tiền quản lý, chuyển khoản)', role: 'staff', teamsDefault: /^(thu ngân|thu ngan)$/i },
  { path: '/viec', label: 'Việc', role: 'staff', api: [['/api/tasks', 'all']] },
  { path: '/dat-ban', label: 'Đặt bàn', role: 'shift_lead', api: [['/api/reservations', 'all'], ['/api/waitlist', 'all']] },
  { path: '/phieu-bep', label: 'Phiếu bếp (máy in hỏng)', role: 'staff', teamsDefault: /bếp|bep|bar|lẩu|lau|nướng/i },
  { path: '/thuc-don', label: 'Thực đơn', role: 'team_lead', api: [['/api/menu/items', 'w'], ['/api/menu/categories', 'w']] },
  { path: '/ranh', label: 'Lịch rảnh', role: 'staff', api: [['/api/availability', 'all']] },
  { path: '/duyet-anh', label: 'Duyệt ảnh', role: 'team_lead', api: [['/api/checklists/review', 'all']] },
  { path: '/thu-ngan', label: 'Thu ngân & doanh thu', role: 'shift_lead', team: 'Thu ngân', api: [['/api/payments/close-day', 'all'], ['/api/payments/drawer', 'all'], ['/api/payments/reconcile', 'all'], ['/api/payments/bank-balance', 'all']] },
  { path: '/duyet-so', label: 'Duyệt sổ', role: 'manager', api: [['/api/daybook', 'all']] },
  // Mục con của Mua hàng (chủ quán 24/10): nhân viên chỉ nhập kho; công nợ NCC / tạm ứng chỉ người được cấp. Đặt TRƯỚC /mua-hang để khớp API trước
  { path: '/mua-hang#congno', label: 'Mua hàng › Công nợ NCC (xem nợ, trả NCC)', role: 'shift_lead', team: 'Thu ngân', sub: true, api: [['/api/suppliers', 'all'], ['/api/supplier-payments', 'all']] },
  { path: '/mua-hang#tamung', label: 'Mua hàng › Tạm ứng tiền đi chợ', role: 'shift_lead', team: 'Thu ngân', sub: true, api: [['/api/advances', 'w']] }, // xem: ai cũng chỉ thấy khoản của mình (để gắn bill đi chợ)
  { path: '/mua-hang', label: 'Mua hàng › Nhập kho, bill đã nhận', role: 'staff', teamsDefault: /bếp|bep|bar|lẩu|lau|thu ngân|thu ngan/i, api: [['/api/purchases', 'all']] },
  { path: '/bao-cao', label: 'Báo cáo doanh thu & nhân sự', role: 'manager', api: [['/api/reports', 'all']] },
  { path: '/khuyen-mai', label: 'Khuyến mãi', role: 'staff', teamsDefault: /^(phục vụ|phuc vu|thu ngân|thu ngan)$/i, api: [['/api/promotions', 'w']] },
  { path: '/may-in', label: 'Máy in', role: 'shift_lead', api: [['/api/print/settings', 'all'], ['/api/print/test', 'all'], ['/api/print/retry', 'all'], ['/api/print/status', 'all'], ['/api/kitchen-stations', 'w']] },
  { path: '/nghi', label: 'Báo nghỉ', role: 'staff', api: [['/api/leave', 'all'], ['/api/offers', 'all']] },
  { path: '/cham-cong', label: 'Chấm công', role: 'shift_lead', api: [['/api/timesheet', 'all']] },
  { path: '/nhan-vien', label: 'Nhân viên', role: 'manager', api: [['/api/staff', 'w']] },
  { path: '/so-do', label: 'Sơ đồ tổ chức', role: 'staff', api: [['/api/org', 'all']] },
  { path: '/cai-dat', label: 'Cài đặt', role: 'manager', api: [['/api/settings', 'w'], ['/api/backup', 'all'], ['/api/audit', 'all'], ['/api/zones', 'w'], ['/api/teams', 'w'], ['/api/positions', 'w'], ['/api/shift-templates', 'w'], ['/api/bank/settings', 'all'], ['/api/zalo-bot', 'all']] },
  { path: '/ho-so', label: 'Tài khoản', role: 'staff', fixed: true },
];

const defaultRoles = (p) => ROLES_EDITABLE.filter((r) => rank(r) >= rank(p.role));

// Bộ phận (chủ quán 25/10): mục có danh sách bộ phận thì Nhân viên / Tổ trưởng chỉ thấy khi thuộc bộ phận đó.
// Trưởng ca trở lên không bị giới hạn bộ phận. teams = null → mọi bộ phận.
export function loadPerms(ctx) {
  let cfg = {};
  try { cfg = JSON.parse(ctx.setting('perm_pages') || '{}') || {}; } catch { cfg = {}; }
  let allTeams = [];
  try { allTeams = ctx.db.prepare('SELECT id, name FROM teams').all(); } catch { /* chưa có bảng */ }
  return PAGES.map((p) => {
    const c = cfg[p.path] || {};
    const teams = p.fixed ? null : Array.isArray(c.teams) ? c.teams.map(Number) : c.teams === null ? null : p.teamsDefault ? allTeams.filter((t) => p.teamsDefault.test(t.name.trim())).map((t) => t.id) : null;
    const { teamsDefault, ...rest } = p;
    return { ...rest, roles: p.fixed ? [...ROLES_EDITABLE] : Array.isArray(c.roles) ? c.roles.filter((r) => ROLES_EDITABLE.includes(r)) : defaultRoles(p), teams, allow: (c.allow || []).map(Number), deny: p.fixed ? [] : (c.deny || []).map(Number), custom: !!cfg[p.path] };
  });
}

export function canSee(page, me, teamName) {
  if (me.role === 'owner' || page.fixed) return true;
  if (page.deny.includes(me.id)) return false;
  if (page.allow.includes(me.id)) return true;
  if (page.roles.includes(me.role)) {
    if (rank(me.role) >= rank('shift_lead') || !Array.isArray(page.teams)) return true;
    if (page.teams.includes(me.team_id)) return true;
  }
  return !!(page.team && teamName === page.team);
}

const teamOf = (ctx, me) => (me.team_id ? ctx.db.prepare('SELECT name FROM teams WHERE id = ?').get(me.team_id)?.name : null);

// Quyền chi tiết của 1 người: { key: true/false } (mặc định + phần chủ quán tick riêng)
export function actsOf(ctx, me, pages = loadPerms(ctx)) {
  const team = teamOf(ctx, me);
  const ov = me.role === 'owner' ? {} : overridesOf(ctx, me.id);
  const see = new Map(pages.map((p) => [p.path, canSee(p, me, team)]));
  const out = {}, def = {};
  for (const a of ACTS) { def[a.key] = defaultAct(a, me, see.get(a.page), team); out[a.key] = typeof ov[a.key] === 'boolean' ? ov[a.key] : def[a.key]; }
  return { acts: out, defaults: def, overrides: ov };
}
export function can(ctx, me, key) {
  if (!me) return false;
  if (me.role === 'owner') return true;
  const ov = overridesOf(ctx, me.id)[key];
  if (typeof ov === 'boolean') return ov;
  const a = actByKey(key);
  if (!a) return true;
  const page = loadPerms(ctx).find((p) => p.path === a.page);
  const team = teamOf(ctx, me);
  return defaultAct(a, me, page ? canSee(page, me, team) : true, team);
}

export function allowedPages(ctx, me) {
  const team = teamOf(ctx, me);
  const ov = me.role === 'owner' ? {} : overridesOf(ctx, me.id);
  return loadPerms(ctx).filter((p) => {
    if (p.fixed || me.role === 'owner') return true;
    const acts = ACTS.filter((a) => a.page === p.path);
    if (acts.some((a) => ov[a.key] === true)) return true; // được cấp riêng 1 việc trong mục → thấy mục
    if (!canSee(p, me, team)) return false;
    return !(acts.length && acts.every((a) => ov[a.key] === false)); // tắt hết mọi việc trong mục → ẩn mục
  }).map((p) => p.path);
}

// Kiểm 1 lệnh API: trả 'deny' (chặn), tên vai trò để nâng quyền (người thấp hơn mặc định của mục được chủ quán cấp) hoặc null (như cũ)
export function apiGate(ctx, me, method, pathname) {
  if (!me || me.role === 'owner') return null;
  // Quyền chi tiết từng người (chủ quán tick riêng) thắng quy định theo mục
  const act = matchAct(method, pathname);
  if (act) {
    const ov = overridesOf(ctx, me.id)[act.key];
    if (ov === false) return 'deny';
    if (ov === true) return rank(me.role) < rank(act.role) ? act.role : null;
  }
  const write = method !== 'GET';
  let pages = null;
  for (const p of PAGES) {
    if (!p.api) continue;
    for (const [pre, m] of p.api) {
      if (!(pathname === pre || pathname.startsWith(pre + '/'))) continue;
      pages ||= loadPerms(ctx);
      const page = pages.find((x) => x.path === p.path);
      const team = me.team_id ? ctx.db.prepare('SELECT name FROM teams WHERE id = ?').get(me.team_id)?.name : null;
      const ok = canSee(page, me, team);
      if (!ok && (m === 'all' || write)) return 'deny';
      if (ok && rank(me.role) < rank(p.role) && (page.allow.includes(me.id) || page.roles.includes(me.role))) return p.role;
      return null;
    }
  }
  return null;
}
