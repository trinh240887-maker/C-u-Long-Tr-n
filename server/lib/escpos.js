// Dựng lệnh ESC/POS cho máy in nhiệt 80mm (48 ký tự/dòng cỡ thường).
// Chữ tiếng Việt: máy in nhiệt rẻ thường không có bảng mã tiếng Việt, nên mặc định in KHÔNG DẤU (đọc được trên mọi máy).
// Chế độ 'utf8' gửi nguyên chữ có dấu, chỉ dùng khi phiếu in thử cho thấy máy đọc đúng.
const ESC = 0x1b, GS = 0x1d;
export const WIDTH = 48;

export function noAccent(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[–—]/g, '-').replace(/[^\x20-\x7e\n]/g, '');
}

export function doc({ mode = 'khong_dau' } = {}) {
  const parts = [Buffer.from([ESC, 0x40])];
  const enc = (s) => (mode === 'utf8' ? Buffer.from(String(s ?? ''), 'utf8') : Buffer.from(noAccent(s), 'ascii'));
  const cmd = (...b) => { parts.push(Buffer.from(b)); return api; };
  const api = {
    align: (a) => cmd(ESC, 0x61, { left: 0, center: 1, right: 2 }[a] ?? 0),
    size: (w = 1, h = 1) => cmd(GS, 0x21, ((w - 1) << 4) | (h - 1)),
    bold: (on) => cmd(ESC, 0x45, on ? 1 : 0),
    invert: (on) => cmd(GS, 0x42, on ? 1 : 0),
    text: (s) => { parts.push(enc(s)); return api; },
    line: (s = '') => api.text(`${s}\n`),
    rule: (ch = '-') => api.line(ch.repeat(WIDTH)),
    feed: (n = 1) => cmd(ESC, 0x64, n),
    beep: () => cmd(ESC, 0x42, 2, 2),
    cut: () => { api.feed(3); return cmd(GS, 0x56, 66, 0); },
    // Chia dòng dài theo bề rộng (cỡ chữ to thì ít ký tự hơn)
    wrap: (s, { indent = '', width = WIDTH } = {}) => {
      const words = String(s ?? '').split(/\s+/).filter(Boolean);
      let cur = indent;
      for (const w of words) {
        if (cur.trim() && (cur + w).length > width) { api.line(cur.trimEnd()); cur = indent + '  '; }
        cur += `${w} `;
      }
      if (cur.trim()) api.line(cur.trimEnd());
      return api;
    },
    // Mã QR in bằng lệnh của máy (GS ( k), không cần ảnh. size 1–16 (chấm/ô)
    qr: (data, size = 7) => {
      const d = Buffer.from(String(data), 'utf8');
      const n = d.length + 3;
      cmd(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0); // model 2
      cmd(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, size);
      cmd(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31); // sửa lỗi mức M
      parts.push(Buffer.from([GS, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30]), d);
      return cmd(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);
    },
    bytes: () => Buffer.concat(parts),
  };
  return api;
}

export const KIND_LABEL = { new: '', add: 'GỌI THÊM', cancel: '*** HUỶ MÓN ***', redo: 'LÀM LẠI', remind: 'NHẮC MÓN - KHÁCH CHỜ' };

// Phiếu bếp / bar
export function ticketBytes(t, { mode, time = '', by = '', lateMin = 0 } = {}) {
  const d = doc({ mode });
  d.align('center').size(2, 2).bold(true).line(t.station_name || 'BẾP');
  const label = KIND_LABEL[t.kind] || '';
  if (label || t.priority) {
    d.invert(true).line(` ${[label, t.priority && t.kind !== 'remind' ? 'ƯU TIÊN' : ''].filter(Boolean).join(' · ')} `).invert(false);
  }
  if (t.kind === 'cancel' || t.kind === 'remind' || t.priority) d.beep();
  d.line(t.header || '').bold(false).size(1, 1);
  if (t.reprint) d.bold(true).line(`BẢN IN LẠI lần ${t.reprint} (phiếu gốc ${String(t.time0 || '')}) - KIỂM TRA ĐÃ LÀM CHƯA`).bold(false);
  d.line([time, by, `#${t.id}`].filter(Boolean).join('  ·  '));
  d.align('left').rule();
  for (const l of t.lines || []) {
    d.size(1, 2).bold(true).wrap(`${l.qty} x ${l.name}${l.rush ? ' (GẤP)' : ''}`, { width: WIDTH }).bold(false).size(1, 1);
    if (l.label && l.label !== l.name) d.wrap(`> ${l.label}`, { indent: '   ' });
    for (const o of l.options || []) d.wrap(`- ${o}`, { indent: '   ' });
    if (l.note) d.bold(true).wrap(`* ${l.note}`, { indent: '   ' }).bold(false);
  }
  d.rule();
  if (lateMin >= 2) d.align('center').bold(true).line(`IN TRỄ ${lateMin} PHÚT (mất mạng / máy in lỗi)`).bold(false);
  return d.cut().bytes();
}

// Phiếu in thử: để chủ quán xem máy đọc được chữ có dấu không
export function testBytes({ station = '', ip = '', time = '', qr = '' } = {}) {
  const a = doc({ mode: 'khong_dau' });
  a.align('center').size(2, 2).bold(true).line('IN THU').size(1, 1).line(station).bold(false).line(`${ip}  ${time}`).rule();
  a.align('left').line('1) KHONG DAU: Ban 20 - 2 x Combo 2 - sot tieu den');
  const b = doc({ mode: 'utf8' });
  b.line('2) CO DAU:  Bàn 20 - 2 x Combo 2 - sốt tiêu đen');
  const c = doc({ mode: 'khong_dau' });
  c.rule().line('Dong 2 doc dung -> bat "In co dau" trong Cai dat.').line('Dong 2 ra ky tu la -> giu che do khong dau.');
  if (qr) c.rule().align('center').line('3) MA QR THU: quet bang app ngan hang').line('phai hien 1.000d, noi dung IN THU').qr(qr).line('').align('left');
  return Buffer.concat([a.bytes(), b.bytes().subarray(2), c.cut().bytes().subarray(2)]);
}

const vnd = (n) => Number(n || 0).toLocaleString('vi-VN');
const lr = (l, r, w = WIDTH) => {
  const L = String(l); const R = String(r);
  const space = w - L.length - R.length;
  return space >= 1 ? L + ' '.repeat(space) + R : `${L}\n${' '.repeat(Math.max(0, w - R.length))}${R}`;
};

// Bill khách (tạm tính trước khi trả, hoặc hoá đơn sau khi trả). b = dữ liệu từ payments.billData()
export function billBytes(b, { mode } = {}) {
  const d = doc({ mode });
  const t = (s) => (mode === 'utf8' ? String(s) : noAccent(s)); // độ dài để canh lề
  d.align('center').size(2, 2).bold(true).line(b.shop.name).size(1, 1).bold(false);
  if (b.shop.address) d.wrap(b.shop.address);
  if (b.shop.phone) d.line(`SĐT: ${b.shop.phone}`);
  d.bold(true).size(1, 2).line(b.paid ? 'HOÁ ĐƠN THANH TOÁN' : 'PHIẾU TẠM TÍNH').size(1, 1).bold(false);
  d.line(`Số: ${b.bill_no}`).align('left').rule();
  d.bold(true).line(t(`Bàn: ${b.header}`)).bold(false);
  d.line(t(lr(`Vào: ${b.opened}`, `In: ${b.printed}`)));
  if (b.staff) d.line(t(`Phục vụ: ${b.staff}`));
  if (b.cashier) d.line(t(`Thu ngân: ${b.cashier}`));
  d.rule();
  b.lines.forEach((l, k) => {
    d.bold(true).wrap(t(`${k + 1}. ${l.name}`)).bold(false);
    if (l.options) d.wrap(t(`   ${l.options}`));
    d.line(t(lr(`   ${l.qty} x ${vnd(l.unit_price)}`, vnd(l.total))));
    for (const p of l.promos) d.line(t(lr(`   KM ${p.name}${p.free_qty ? ` (tặng ${p.free_qty})` : ''}`.slice(0, 36), `-${vnd(p.amount)}`)));
  });
  d.rule();
  d.line(t(lr(`Tiền hàng (${b.count})`, vnd(b.subtotal))));
  if (b.item_discount) d.line(t(lr('Khuyến mãi món', `-${vnd(b.item_discount)}`)));
  for (const p of b.bill_promos) d.line(t(lr(`KM ${p.name}`.slice(0, 36), `-${vnd(p.amount)}`)));
  d.bold(true).size(1, 2).line(t(lr('TỔNG CỘNG', `${vnd(b.total)}đ`))).size(1, 1).bold(false);
  if (b.paid) {
    if (b.cash_amount) d.line(t(lr('Tiền mặt', vnd(b.cash_amount))));
    if (b.transfer_amount) d.line(t(lr('Chuyển khoản', vnd(b.transfer_amount))));
    if (b.cash_given) { d.line(t(lr('Khách đưa', vnd(b.cash_given)))); d.line(t(lr('Tiền thối', vnd(b.change)))); }
    for (const r of b.refunds || []) d.line(t(lr(`Hoàn tiền mặt (${r.reason})`.slice(0, 36), `-${vnd(r.amount)}`)));
  }
  if (b.qr) {
    d.rule().align('center').bold(true).line(t('QUÉT MÃ ĐỂ CHUYỂN KHOẢN')).bold(false);
    d.qr(b.qr, 6).line('');
    d.line(t(`${b.bank_name}  ·  ${vnd(b.qr_amount)}đ`)).bold(true).line(t(`Nội dung: ${b.transfer_note}`)).bold(false);
  }
  d.align('center').rule().line(t('Cảm ơn quý khách, hẹn gặp lại!'));
  return d.cut().bytes();
}

// Phiếu hoàn tiền: khách ký nhận, quản lý giữ lại
export function refundBytes(r, { mode } = {}) {
  const d = doc({ mode });
  const t = (s) => (mode === 'utf8' ? String(s) : noAccent(s));
  d.align('center').size(1, 2).bold(true).line('PHIẾU HOÀN TIỀN').size(1, 1).bold(false).line(`Bill ${r.bill_no} · ${r.header}`).line(r.time).align('left').rule();
  for (const l of r.lines) d.line(t(lr(`${l.qty} x ${l.name}`.slice(0, 36), vnd(l.amount))));
  d.rule().bold(true).line(t(lr('HOÀN TIỀN MẶT', `${vnd(r.amount)}đ`))).bold(false);
  d.line(t(`Lý do: ${r.reason}`)).line(t(`Người hoàn: ${r.by}`)).line(t(`Quản lý duyệt: ${r.approver}`));
  d.feed(2).line(t(lr('Khách ký nhận', 'Quản lý ký'))).feed(4);
  return d.cut().bytes();
}
