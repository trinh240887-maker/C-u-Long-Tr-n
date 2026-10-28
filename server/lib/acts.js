// Quyền chi tiết từng người (chủ quán 26/10): mỗi mục chia thành nhiều việc nhỏ (xem / tạo / sửa / duyệt / huỷ…),
// chủ quán tick bật / tắt cho TỪNG NGƯỜI ở Cài đặt → Phân quyền → Theo từng người.
// - Không tick riêng = giữ quyền mặc định như cũ (theo chức vụ + bộ phận + mục).
// - Tắt riêng → server chặn mọi lệnh của việc đó (kể cả quản lý).
// - Bật riêng → được làm việc đó dù chức vụ thấp hơn (app nâng quyền lệnh đó lên mức cần, tối đa Quản lý).
// Mỗi việc: key, mục (page trong perms.js), nhãn, role = mức chức vụ cần để làm, rules = [phương thức, mẫu đường dẫn API].
// R = xem (GET), W = ghi (POST/PUT/PATCH/DELETE), * = cả hai. Việc đứng trước khớp trước.
import { rank } from '../db.js';

const A = (key, page, label, role, rules, extra = {}) => ({ key, page, label, role, rules: rules.map(([m, re]) => [m, new RegExp(`^${re}$`)]), ...extra });
const ID = '\\d+';

export const ACT_GROUPS = [
  { name: 'Lịch ca', acts: [
    A('lich.xem', '/lich', 'Xem lịch ca', 'staff', [['R', '/api/schedule(\\.xlsx)?'], ['R', '/api/shift-templates']]),
    A('lich.xep', '/lich#xep', 'Xếp ca, chép tuần, phân khu tuần', 'manager', [['W', '/api/shifts(/delete)?'], ['W', '/api/schedule/copy'], ['W', '/api/schedule/week-zones']]),
    A('lich.congbo', '/lich#xep', 'Công bố lịch, gửi ảnh lịch', 'manager', [['W', '/api/schedule/publish(-team)?'], ['W', '/api/schedule/team-image']]),
    A('lich.loaica', '/cai-dat', 'Tạo / sửa loại ca', 'manager', [['W', `/api/shift-templates(/${ID})?`]]),
  ] },
  { name: 'Lịch rảnh', acts: [
    A('ranh.bao', '/ranh', 'Báo lịch rảnh của mình', 'staff', [['*', '/api/availability/me']]),
    A('ranh.xem', '/ranh', 'Xem lịch rảnh mọi người', 'staff', [['R', '/api/availability']]),
    A('ranh.nhac', '/lich#xep', 'Nhắc báo lịch rảnh', 'manager', [['W', '/api/availability/remind']]),
    A('ranh.nvmoi', '/nhan-vien', 'Duyệt nhân viên mới đăng ký qua bot', 'manager', [['*', `/api/staff-requests(/${ID}/(done|reject))?`]]),
  ] },
  { name: 'Báo nghỉ & thay ca', acts: [
    A('nghi.bao', '/nghi', 'Báo nghỉ, huỷ báo nghỉ', 'staff', [['*', '/api/leave'], ['W', `/api/leave/${ID}/cancel`]]),
    A('nghi.thay', '/nghi', 'Nhận lời nhờ làm thay', 'staff', [['*', `/api/offers(/me|/${ID}/respond)?`]]),
    A('nghi.tim', '/nghi', 'Tìm và mời người làm thay', 'team_lead', [['*', `/api/leave/${ID}/(suggestions|invite)`]]),
    A('nghi.duyet', '/nghi', 'Duyệt / từ chối báo nghỉ', 'manager', [['W', `/api/leave/${ID}/decide`]]),
  ] },
  { name: 'Chấm công', acts: [
    A('cc.cham', '/', 'Tự chấm công vào / ra', 'staff', [['W', '/api/attendance/(clock-in|clock-out|undo-out|late-photo)']]),
    A('cc.xem', '/cham-cong', 'Xem chấm công mọi người', 'shift_lead', [['R', '/api/attendance'], ['R', `/api/attendance/${ID}/late-photo`]]),
    A('cc.xoa', '/cham-cong', 'Xoá lượt chấm công', 'manager', [['W', `/api/attendance/${ID}`]], { methods: ['DELETE'] }),
    A('cc.sua', '/cham-cong', 'Thêm tay / sửa giờ chấm công', 'shift_lead', [['W', '/api/attendance'], ['W', `/api/attendance/${ID}`]]),
    A('cc.bangcong', '/cham-cong', 'Xem bảng công & lương', 'manager', [['R', '/api/timesheet']]),
  ] },
  { name: 'Nhân viên', acts: [
    A('nv.them', '/nhan-vien', 'Thêm nhân viên, tạo PIN hàng loạt', 'manager', [['W', '/api/staff'], ['W', '/api/staff/bulk-pin']]),
    A('nv.sua', '/nhan-vien', 'Sửa nhân viên, đổi / gỡ máy chấm công', 'manager', [['W', `/api/staff/${ID}(/device)?`]]),
    A('nv.bophan', '/nhan-vien', 'Sửa bộ phận, vị trí', 'manager', [['W', `/api/teams(/${ID}|/combine)?`], ['W', `/api/positions(/${ID})?`]]),
  ] },
  { name: 'Việc ca', acts: [
    A('vc.lam', '/viec-ca', 'Nhận việc, bấm xong, chụp ảnh', 'staff', [['W', `/api/jobs/${ID}/(claim|done|out)`], ['W', '/api/jobs/zone-photo']]),
    A('vc.kiem', '/viec-ca', 'Kiểm tra việc (đạt / làm lại)', 'staff', [['W', `/api/jobs/${ID}/check`]]),
    A('vc.giao', '/viec-ca', 'Giao lại việc, chia lại, đổi người kiểm', 'shift_lead', [['W', `/api/jobs/${ID}`], ['W', '/api/jobs/reassign'], ['W', '/api/jobs/checker']]),
    A('vc.baocao', '/viec-ca', 'Xem báo cáo việc ca', 'shift_lead', [['R', '/api/jobs/report']]),
  ] },
  { name: 'Checklist & việc', acts: [
    A('cl.lam', '/checklist', 'Làm checklist (chụp ảnh, nhập số)', 'staff', [['W', '/api/checklists/(photo|photo/delete|entry)']]),
    A('cl.sua', '/checklist', 'Tạo / sửa checklist, ảnh mẫu', 'team_lead', [['W', `/api/checklist-templates(/${ID}(/items|/samples)?)?`], ['W', `/api/checklist-samples/${ID}/delete`]]),
    A('cl.duyet', '/duyet-anh', 'Duyệt ảnh checklist', 'team_lead', [['*', '/api/checklists/review']]),
    A('viec.xem', '/viec', 'Xem việc được giao', 'staff', [['R', '/api/tasks']]),
    A('viec.giao', '/viec', 'Giao / xoá việc', 'team_lead', [['W', '/api/tasks'], ['W', `/api/tasks/${ID}`]], { methods: ['POST', 'DELETE'] }),
  ] },
  { name: 'Bán hàng (sơ đồ bàn, gọi món)', acts: [
    A('ban.goimon', '/ban', 'Mở bàn, gọi món, gửi bếp', 'staff', [['W', '/api/pos/sessions'], ['W', `/api/pos/sessions/${ID}(/items|/send)?`], ['W', `/api/pos/items/${ID}(/served|/remind|/redo)?`]]),
    A('ban.huy', '/ban', 'Huỷ món, huỷ bàn', 'staff', [['W', `/api/pos/items/${ID}/cancel`], ['W', `/api/pos/sessions/${ID}/cancel`]]),
    A('ban.chuyen', '/ban', 'Chuyển / gộp / tách bàn', 'staff', [['W', `/api/pos/(sessions|items)/${ID}/(move|merge|split)`]]),
    A('ban.tinhtien', '/ban', 'Tính tiền, in bill, đổi cách trả', 'staff', [['W', `/api/pos/sessions/${ID}/(request-bill|print-bill|pay|change-method|request-cash)`]]),
    A('ban.hoan', '/ban', 'Hoàn tiền / xử lý khách trả dư', 'staff', [['W', `/api/pos/sessions/${ID}/(refund|overpay)`]]),
    A('ban.don', '/ban', 'Dọn bàn, khách chờ', 'staff', [['W', `/api/pos/tables/${ID}/clean`], ['W', `/api/waitlist/${ID}/gone`]]),
    A('bep.phieu', '/phieu-bep', 'Phiếu bếp: in lại, xong món', 'staff', [['W', `/api/pos/tickets/${ID}/(reprint|done)`]]),
    A('datban.xem', '/dat-ban', 'Xem đặt bàn', 'shift_lead', [['R', '/api/reservations(/suggest)?'], ['R', '/api/waitlist']]),
    A('datban.tao', '/dat-ban', 'Tạo / sửa / xác nhận đặt bàn', 'shift_lead', [['W', `/api/reservations(/${ID}(/arrive|/confirm|/reject)?)?`]]),
  ] },
  { name: 'Thực đơn & khuyến mãi', acts: [
    A('td.het', '/thuc-don', 'Báo hết món / mở bán lại', 'team_lead', [['W', '/api/menu/reset-sold-out']]),
    A('td.sua', '/thuc-don', 'Thêm / sửa món, định lượng, danh mục', 'manager', [['W', `/api/menu/(items|categories)(/${ID})?`], ['W', `/api/kitchen-stations(/${ID})?`]]),
    A('km.sua', '/khuyen-mai', 'Tạo / sửa khuyến mãi', 'manager', [['W', `/api/promotions(/${ID})?`]]),
  ] },
  { name: 'Thu ngân', acts: [
    A('tn.xem', '/thu-ngan', 'Xem thu ngân & doanh thu ngày', 'shift_lead', [['R', '/api/payments'], ['R', '/api/payments/waiting']], { team: 'Thu ngân' }),
    A('tn.nhan', '/thu-ngan', 'Nhận tiền phục vụ giao, đối soát CK', 'shift_lead', [['W', '/api/payments/(handover|reconcile)'], ['W', `/api/bank/txns/${ID}/assign`]], { team: 'Thu ngân' }),
    A('tn.ket', '/thu-ngan', 'Đếm két, chốt ngày', 'shift_lead', [['W', '/api/payments/(drawer|drawer-photo|close-day)']], { team: 'Thu ngân' }),
    A('tn.sodu', '/thu-ngan', 'Ghi số dư tài khoản', 'shift_lead', [['W', '/api/payments/bank-balance']], { team: 'Thu ngân' }),
    A('tn.tip', '/thu-ngan', 'Thùng tip: đếm, chia', 'shift_lead', [['W', '/api/tip-box/(count|payout)']], { team: 'Thu ngân' }),
    A('tn.duyetso', '/duyet-so', 'Duyệt sổ ngày', 'manager', [['*', '/api/daybook'], ['W', '/api/daybook/cash-check']]),
  ] },
  { name: 'Phiếu chi & tiền', acts: [
    A('chi.xem', '/chi', 'Xem phiếu chi', 'shift_lead', [['R', '/api/expenses'], ['R', `/api/expenses/${ID}/photo`]], { team: 'Thu ngân' }),
    A('chi.ket', '/chi', 'Chi từ két', 'shift_lead', [['W', '/api/expenses']], { team: 'Thu ngân' }),
    A('chi.quanly', '/chi', 'Chi tiền mặt quản lý giữ / chuyển khoản', 'manager', []),
    A('chi.duyet', '/chi', 'Duyệt / từ chối phiếu chi', 'shift_lead', [['W', `/api/expenses/${ID}/approve`]]),
    A('chi.huy', '/chi', 'Huỷ phiếu chi', 'staff', [['W', `/api/expenses/${ID}/void`]]),
    A('tien.xem', '/bao-cao', 'Xem Tiền hiện có (tiền mặt + tài khoản)', 'manager', [['R', '/api/money/now']]),
  ] },
  { name: 'Mua hàng & công nợ', acts: [
    A('mh.nhap', '/mua-hang', 'Nhập kho: chụp bill + hàng', 'staff', [['W', '/api/purchases'], ['W', '/api/purchases/read-bill']]),
    A('mh.xem', '/mua-hang', 'Xem bill đã nhận', 'staff', [['R', '/api/purchases'], ['R', `/api/purchases/photo/${ID}`]]),
    A('mh.apbill', '/mua-hang', 'Áp bill NCC gửi trước (hàng chưa về)', 'owner', []), // chủ quán 28/10: chỉ người được chỉ định
    A('mh.duyet', '/mua-hang', 'Duyệt / trả lại bill', 'shift_lead', [['W', `/api/purchases/${ID}/(approve|return)`]], { team: 'Thu ngân' }),
    A('mh.sua', '/mua-hang', 'Sửa bill', 'shift_lead', [['W', `/api/purchases/${ID}`]], { team: 'Thu ngân' }),
    A('mh.huy', '/mua-hang', 'Huỷ bill', 'manager', [['W', `/api/purchases/${ID}/void`]]),
    A('mh.congno', '/mua-hang#congno', 'Xem công nợ nhà cung cấp', 'shift_lead', [['R', '/api/suppliers/debts'], ['R', `/api/suppliers/${ID}/statement(\\.xlsx)?`], ['R', `/api/supplier-payments/${ID}/photo`]], { team: 'Thu ngân' }),
    A('mh.tra', '/mua-hang#congno', 'Trả tiền nhà cung cấp', 'shift_lead', [['W', `/api/suppliers/${ID}/pay`], ['W', `/api/supplier-payments/${ID}/approve`]], { team: 'Thu ngân' }),
    A('mh.tamung', '/mua-hang#tamung', 'Tạm ứng tiền đi chợ (đưa / quyết toán)', 'shift_lead', [['W', '/api/advances'], ['W', `/api/advances/${ID}/settle`], ['R', '/api/advances/staff']], { team: 'Thu ngân' }),
  ] },
  { name: 'Kho', acts: [
    A('kho.xem', '/kho', 'Xem tồn kho, lịch sử', 'staff', [['R', '/api/stock/(overview|alerts|moves)']]),
    A('kho.kiem', '/kho', 'Kiểm kho (cân / đếm cuối ngày)', 'staff', [['*', '/api/stock/count(-sheet)?']]),
    A('kho.linh', '/kho', 'Xin lĩnh / xuất kho / nhận hàng', 'staff', [['*', `/api/stock/transfers(/${ID}/(send|receive|cancel))?`], ['R', '/api/stock/suggest-transfer']]),
    A('kho.dathang', '/kho', 'Đặt hàng nhà cung cấp', 'team_lead', [['*', `/api/stock/po(/generate|/${ID}(/submit|/cancel|/receive)?)?`], ['W', '/api/stock/receive']]),
    A('kho.duyetdat', '/kho', 'Duyệt đơn đặt hàng', 'manager', [['W', `/api/stock/po/${ID}/(approve|reject)`]]),
    A('kho.nguyenlieu', '/kho', 'Thêm / sửa nguyên liệu, NCC, quy đổi', 'manager', [['W', `/api/stock/(ingredients|suppliers|stores)(/${ID})?`], ['*', '/api/stock/(unit-aliases|recipe-use)']]),
    A('kho.nxt', '/kho', 'Xem Nhập – Xuất – Tồn (tiền)', 'manager', [['R', `/api/stock/nxt(/${ID}|\\.xlsx)?`]]),
    A('dd.bao', '/kho', 'Đồ dùng: báo vỡ / mất', 'staff', [['W', `/api/utensils/${ID}/break`]]),
    A('dd.kiem', '/kho', 'Đồ dùng: kiểm tuần', 'team_lead', [['W', '/api/utensils/(count|plan)']]),
    A('dd.them', '/kho', 'Đồ dùng: thêm / sửa món', 'manager', [['W', `/api/utensils(/bulk|/${ID})?`], ['W', `/api/service-kits(/${ID})?`]]),
    A('wh.xem', '/kho-tx', 'Kho & Tài sản: xem', 'staff', [['R', '/api/wh/.*']]),
    A('wh.lam', '/kho-tx', 'Kho & Tài sản: lập / duyệt chứng từ, tài sản', 'staff', [['W', '/api/wh/.*']]),
  ] },
  { name: 'Báo cáo & quản lý', acts: [
    A('bc.tongquan', '/quan-ly', 'Xem trang Quản lý (tổng quan)', 'shift_lead', [['R', '/api/dashboard']]),
    A('bc.doanhthu', '/bao-cao', 'Báo cáo doanh thu', 'manager', [['R', '/api/reports/sales(\\.xlsx)?']]),
    A('bc.nhansu', '/bao-cao', 'Báo cáo nhân sự (lương / giờ)', 'manager', [['R', '/api/reports/labor(\\.xlsx)?']]),
    A('in.xem', '/may-in', 'Máy in: xem, in lại', 'shift_lead', [['R', '/api/print/status'], ['W', '/api/print/retry']]),
    A('in.sua', '/may-in', 'Máy in: cài đặt, in thử', 'manager', [['*', '/api/print/(settings|test|setup\\.bat)']]),
    A('cd.sua', '/cai-dat', 'Cài đặt chung, khu & bàn, Zalo, sao lưu', 'manager', [['*', '/api/settings(/zalo-test)?'], ['W', `/api/zones(/${ID})?`], ['*', '/api/zalo-bot/.*'], ['W', '/api/backup'], ['R', '/api/bank/settings']]),
    A('cd.nhatky', '/cai-dat', 'Xem nhật ký thao tác', 'manager', [['R', '/api/audit']]),
  ] },
];

export const ACTS = ACT_GROUPS.flatMap((g) => g.acts.map((a) => ({ ...a, group: g.name })));
const BY_KEY = new Map(ACTS.map((a) => [a.key, a]));
export const actByKey = (k) => BY_KEY.get(k);

export function loadUserActs(ctx) {
  try { return JSON.parse(ctx.setting('perm_user') || '{}') || {}; } catch { return {}; }
}
export const overridesOf = (ctx, staffId, all = loadUserActs(ctx)) => all[String(staffId)] || {};

// Việc nào khớp lệnh API này
export function matchAct(method, pathname) {
  const write = method !== 'GET';
  for (const a of ACTS) {
    if (a.methods && !a.methods.includes(method)) continue;
    for (const [m, re] of a.rules) {
      if ((m === 'R' && write) || (m === 'W' && !write)) continue;
      if (re.test(pathname)) return a;
    }
  }
  return null;
}

// Quyền mặc định (khi chủ quán chưa tick riêng): thấy mục + đủ chức vụ
export function defaultAct(a, me, seePage, teamName) {
  if (me.role === 'owner') return true;
  return !!seePage && (rank(me.role) >= rank(a.role) || (!!a.team && teamName === a.team));
}
