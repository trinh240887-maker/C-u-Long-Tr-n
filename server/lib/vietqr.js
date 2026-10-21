// VietQR (chuẩn EMVCo/NAPAS): từ mã QR tĩnh của tài khoản quán, tạo mã QR có sẵn SỐ TIỀN + NỘI DUNG cho từng bill.
// Giữ nguyên mọi trường gốc của ngân hàng, chỉ đổi: 01 = 12 (mã động), thêm 54 (số tiền), 62/08 (nội dung), tính lại CRC.
export function crc16(s) {
  let c = 0xffff;
  for (const b of Buffer.from(s, 'utf8')) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c.toString(16).toUpperCase().padStart(4, '0');
}
export function parseTLV(s) {
  const out = [];
  for (let i = 0; i < s.length;) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len)) throw new Error('Mã QR không đúng chuẩn VietQR');
    out.push({ id, value: s.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}
const tlv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;

// Đọc mã QR tĩnh → { bank_bin, account, valid }
export function readStatic(payload) {
  const p = String(payload || '').trim();
  const f = parseTLV(p);
  const crcOk = p.slice(-4).toUpperCase() === crc16(p.slice(0, -4));
  const m38 = f.find((x) => x.id === '38');
  if (!m38) throw new Error('Không phải mã VietQR chuyển khoản (thiếu trường 38)');
  const sub = parseTLV(m38.value);
  const bene = parseTLV(sub.find((x) => x.id === '01')?.value || '');
  return { valid: crcOk, bank_bin: bene.find((x) => x.id === '00')?.value || '', account: bene.find((x) => x.id === '01')?.value || '' };
}

// Mã động cho 1 bill. Nội dung chuyển khoản: chỉ chữ không dấu + số, tối đa 25 ký tự
export function billQR(staticPayload, { amount, content = '' }) {
  const f = parseTLV(String(staticPayload).trim()).filter((x) => !['54', '62', '63'].includes(x.id));
  const set = (id, value) => { const k = f.findIndex((x) => x.id === id); if (k >= 0) f[k].value = value; else f.push({ id, value }); };
  set('01', '12');
  if (amount > 0) set('54', String(Math.round(amount)));
  const note = String(content).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 25).trim();
  if (note) set('62', tlv('08', note));
  // Sắp lại theo mã trường (chuẩn yêu cầu tăng dần), CRC luôn cuối
  f.sort((a, b) => Number(a.id) - Number(b.id));
  const body = f.map((x) => tlv(x.id, x.value)).join('') + '6304';
  return body + crc16(body);
}
