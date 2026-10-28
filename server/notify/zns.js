// Gửi tin Zalo cho KHÁCH theo số điện thoại: Zalo ZNS (từ 2026 gọi là ZBS Template Message).
// Theo tài liệu Zalo (developers.zalo.me / zalo.solutions, tra cứu 22/10/2026, CHƯA thử với OA thật):
//   POST https://business.openapi.zalo.me/message/template, header access_token = token OA của cùng App
//   body { phone: "84xxxxxxxxx", template_id, template_data: {...}, tracking_id, mode?: "development" }
//   thành công: { error: 0, data: { msg_id, sent_time, quota } }. Chế độ development chỉ gửi tới quản trị viên App / OA, không tính phí.
// Điều kiện phía chủ quán: OA đã xác thực, nối tài khoản Zalo Cloud (ZCA) + nạp ví, App được cấp quyền ZNS,
// tạo mẫu tin "Giao dịch" và chờ duyệt; tham số mẫu phải đúng tên bên dưới. Zalo chỉ gửi trong khung 6:00–22:00.
import { createZaloOaTransport, ZALO_TIMEOUT_MS } from './zalo-oa.js';

const URL_ = 'https://business.openapi.zalo.me/message/template';
export const ZNS_PARAMS = {
  confirm: ['customer_name', 'booking_code', 'booking_date', 'booking_time', 'guests', 'table_no'],
  reject: ['customer_name', 'booking_code', 'booking_date', 'booking_time', 'reason'],
  remind: ['customer_name', 'booking_code', 'booking_date', 'booking_time', 'table_no'],
  cancel: ['customer_name', 'booking_code', 'booking_date', 'booking_time', 'hold_minutes'], // quá giờ giữ bàn, quán tự huỷ
  queue: ['customer_name', 'queue_no', 'guests', 'wait_minutes'],   // khách vào danh sách chờ
  ready: ['customer_name', 'table_no', 'hold_minutes'],             // đã có bàn, mời vào trong X phút
};
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function phone84(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d)) return `84${d.slice(1)}`;
  if (/^84\d{9}$/.test(d)) return d;
  return null;
}

export function createZns(ctx, { fetchImpl = globalThis.fetch, oa } = {}) {
  const tok = () => (oa || createZaloOaTransport(ctx, { fetchImpl })).token();
  async function sendTemplate({ phone, templateId, data, tracking }) {
    const p = phone84(phone);
    if (!p) return { ok: false, error: 'Số điện thoại không hợp lệ' };
    const m = ctx.clock().minuteOf(ctx.now());
    if (m < 6 * 60 || m >= 22 * 60) return { ok: false, error: 'Ngoài giờ Zalo cho gửi (6:00–22:00): gọi điện báo khách' };
    const body = { phone: p, template_id: String(templateId), template_data: data, tracking_id: String(tracking).replace(/[^A-Za-z0-9_]/g, '').slice(0, 48) };
    if (ctx.setting('zns_mode') !== 'production') body.mode = 'development';
    let res;
    try {
      res = await fetchImpl(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', access_token: await tok() }, body: JSON.stringify(body), signal: AbortSignal.timeout(ZALO_TIMEOUT_MS) }); // rà soát 28/10: không chờ Zalo treo
    } catch (e) { return { ok: false, error: `Không gọi được Zalo: ${e.message}` }; }
    const j = await res.json().catch(() => ({}));
    if (j.error === 0) return { ok: true, msg_id: j.data?.msg_id || '' };
    return { ok: false, error: `Zalo từ chối (mã ${j.error ?? res.status}): ${j.message || ''}`.trim() };
  }

  // Báo khách: kind = confirm | reject | remind | cancel (đặt bàn) · queue | ready (danh sách chờ)
  return async function customerNotify(x, kind) {
    if (ctx.setting('zns_enabled') !== '1') return { ok: false, skipped: true };
    const templateId = ctx.setting(`zns_template_${kind}`);
    if (!templateId) return { ok: false, skipped: true };
    const d = x.date;
    const data = {
      customer_name: x.name, booking_code: x.code || `B${x.id}`, booking_date: `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`,
      booking_time: hm(x.time_min), guests: String(x.guests), table_no: x.tables || 'Quán sắp xếp', reason: x.reject_reason || '',
      queue_no: String(x.queue_no ?? ''), wait_minutes: x.wait_minutes == null ? 'đang ước tính' : String(x.wait_minutes), hold_minutes: String(x.hold_minutes ?? 5),
    };
    const want = ZNS_PARAMS[kind];
    return sendTemplate({ phone: x.phone, templateId, data: Object.fromEntries(want.map((k) => [k, data[k]])), tracking: `res${x.id}${kind}` });
  };
}
