// Phân quyền từng mục menu. Chủ quán chỉnh ở Cài đặt → Phân quyền (setting `perm_pages`).
// Mỗi mục: vai trò được thấy + người được cấp riêng (allow) + người bị chặn riêng (deny). Chủ quán luôn thấy hết.
// api: các đường API riêng của mục đó (w = chỉ lệnh ghi, all = cả xem) → bị chặn nếu không có quyền,
// và được nâng quyền (tối đa Quản lý) khi chủ quán cấp riêng cho người thấp hơn.
import { rank } from '../db.js';

export const ROLES_EDITABLE = ['staff', 'team_lead', 'shift_lead', 'manager'];
export const PAGES = [
  { path: '/', label: 'Hôm nay', role: 'staff', fixed: true },
  { path: '/quan-ly', label: 'Quản lý', role: 'shift_lead' },
  // Xếp ca là quyền riêng: chủ quán cấp cho ai thì người đó xếp được (màn Lịch rảnh → Xếp ca). Đặt TRƯỚC /lich
  { path: '/lich#xep', label: 'Lịch ca › Xếp ca, công bố lịch', role: 'manager', sub: true, api: [['/api/shifts', 'all'], ['/api/schedule/copy', 'all'], ['/api/schedule/publish', 'all'], ['/api/availability/remind', 'all']] },
  { path: '/lich', label: 'Lịch ca (xem)', role: 'staff' },
  { path: '/ban', label: 'Sơ đồ bàn', role: 'staff' },
  { path: '/kho', label: 'Kho', role: 'staff', api: [['/api/stock/receive', 'w'], ['/api/stock/transfers', 'w'], ['/api/stock/po', 'w'], ['/api/stock/ingredients', 'w'], ['/api/stock/stores', 'w'], ['/api/stock/suppliers', 'w'], ['/api/stock/nxt', 'all']] },
  { path: '/checklist', label: 'Checklist', role: 'staff' },
  { path: '/viec', label: 'Việc', role: 'staff', api: [['/api/tasks', 'all']] },
  { path: '/dat-ban', label: 'Đặt bàn', role: 'staff', api: [['/api/reservations', 'all'], ['/api/waitlist', 'all']] },
  { path: '/phieu-bep', label: 'Phiếu bếp (máy in hỏng)', role: 'staff' },
  { path: '/thuc-don', label: 'Thực đơn', role: 'team_lead', api: [['/api/menu/items', 'w'], ['/api/menu/categories', 'w']] },
  { path: '/ranh', label: 'Lịch rảnh', role: 'staff', api: [['/api/availability', 'all']] },
  { path: '/duyet-anh', label: 'Duyệt ảnh', role: 'team_lead', api: [['/api/checklists/review', 'all']] },
  { path: '/thu-ngan', label: 'Thu ngân & doanh thu', role: 'shift_lead', team: 'Thu ngân', api: [['/api/payments/close-day', 'all'], ['/api/payments/drawer', 'all'], ['/api/payments/reconcile', 'all'], ['/api/payments/bank-balance', 'all']] },
  { path: '/duyet-so', label: 'Duyệt sổ', role: 'manager', api: [['/api/daybook', 'all']] },
  // Mục con của Mua hàng (chủ quán 24/10): nhân viên chỉ nhập kho; công nợ NCC / tạm ứng chỉ người được cấp. Đặt TRƯỚC /mua-hang để khớp API trước
  { path: '/mua-hang#congno', label: 'Mua hàng › Công nợ NCC (xem nợ, trả NCC)', role: 'shift_lead', team: 'Thu ngân', sub: true, api: [['/api/suppliers', 'all'], ['/api/supplier-payments', 'all']] },
  { path: '/mua-hang#tamung', label: 'Mua hàng › Tạm ứng tiền đi chợ', role: 'shift_lead', team: 'Thu ngân', sub: true, api: [['/api/advances', 'w']] }, // xem: ai cũng chỉ thấy khoản của mình (để gắn bill đi chợ)
  { path: '/mua-hang', label: 'Mua hàng › Nhập kho, bill đã nhận', role: 'staff', api: [['/api/purchases', 'all']] },
  { path: '/bao-cao', label: 'Báo cáo doanh thu & nhân sự', role: 'manager', api: [['/api/reports', 'all']] },
  { path: '/khuyen-mai', label: 'Khuyến mãi', role: 'staff', api: [['/api/promotions', 'w']] },
  { path: '/may-in', label: 'Máy in', role: 'shift_lead', api: [['/api/print/settings', 'all'], ['/api/print/test', 'all'], ['/api/print/retry', 'all'], ['/api/print/status', 'all'], ['/api/kitchen-stations', 'w']] },
  { path: '/nghi', label: 'Nghỉ & thay ca', role: 'staff', api: [['/api/leave', 'all'], ['/api/offers', 'all']] },
  { path: '/cham-cong', label: 'Chấm công', role: 'shift_lead', api: [['/api/timesheet', 'all']] },
  { path: '/nhan-vien', label: 'Nhân viên', role: 'manager', api: [['/api/staff', 'w']] },
  { path: '/so-do', label: 'Sơ đồ tổ chức', role: 'staff', api: [['/api/org', 'all']] },
  { path: '/cai-dat', label: 'Cài đặt', role: 'manager', api: [['/api/settings', 'w'], ['/api/backup', 'all'], ['/api/audit', 'all'], ['/api/zones', 'w'], ['/api/teams', 'w'], ['/api/positions', 'w'], ['/api/shift-templates', 'w'], ['/api/bank/settings', 'all'], ['/api/zalo-bot', 'all']] },
  { path: '/ho-so', label: 'Tài khoản', role: 'staff', fixed: true },
];

const defaultRoles = (p) => ROLES_EDITABLE.filter((r) => rank(r) >= rank(p.role));

export function loadPerms(ctx) {
  let cfg = {};
  try { cfg = JSON.parse(ctx.setting('perm_pages') || '{}') || {}; } catch { cfg = {}; }
  return PAGES.map((p) => {
    const c = cfg[p.path] || {};
    return { ...p, roles: p.fixed ? [...ROLES_EDITABLE] : Array.isArray(c.roles) ? c.roles.filter((r) => ROLES_EDITABLE.includes(r)) : defaultRoles(p), allow: (c.allow || []).map(Number), deny: p.fixed ? [] : (c.deny || []).map(Number), custom: !!cfg[p.path] };
  });
}

export function canSee(page, me, teamName) {
  if (me.role === 'owner' || page.fixed) return true;
  if (page.deny.includes(me.id)) return false;
  if (page.allow.includes(me.id) || page.roles.includes(me.role)) return true;
  return !!(page.team && teamName === page.team);
}

export function allowedPages(ctx, me) {
  const team = me.team_id ? ctx.db.prepare('SELECT name FROM teams WHERE id = ?').get(me.team_id)?.name : null;
  return loadPerms(ctx).filter((p) => canSee(p, me, team)).map((p) => p.path);
}

// Kiểm 1 lệnh API: trả 'deny' (chặn), tên vai trò để nâng quyền (người thấp hơn mặc định của mục được chủ quán cấp) hoặc null (như cũ)
export function apiGate(ctx, me, method, pathname) {
  if (!me || me.role === 'owner') return null;
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
