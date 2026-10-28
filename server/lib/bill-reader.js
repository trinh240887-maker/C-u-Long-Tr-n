// Đọc ảnh bill nhà cung cấp (thường viết tay) bằng Claude → dòng hàng đã khớp với kho.
// Gọi thẳng HTTP (app không dùng thư viện ngoài). Theo tài liệu Claude API (tra 23/10/2026):
//   POST https://api.anthropic.com/v1/messages · header x-api-key, anthropic-version: 2026-10-21
//   output_config.format = { type: 'json_schema', schema } → câu trả lời là JSON đúng khuôn
//   fallbacks: 'default' (beta server-side-fallback-2026-07-01): model từ chối thì máy chủ tự chạy lại bằng model khác
// Mã: biến môi trường ANTHROPIC_API_KEY hoặc chủ quán dán trong app (Cài đặt → Kết nối). Không có thì nút "Đọc bill" báo chưa cài.
const URL_ = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.BILL_READER_MODEL || 'claude-opus-5-5';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['supplier_name', 'signer_name', 'total', 'lines', 'note'],
  properties: {
    supplier_name: { type: 'string', description: 'Tên nơi bán in / ghi trên bill, trống nếu không có' },
    signer_name: { type: 'string', description: 'Tên người ký nhận nếu đọc được, trống nếu không' },
    total: { type: 'integer', description: 'Tổng tiền ghi trên bill (VNĐ, số nguyên), 0 nếu không có' },
    note: { type: 'string', description: 'Chỗ khó đọc / nghi ngờ, viết ngắn bằng tiếng Việt; trống nếu rõ hết' },
    lines: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['ingredient_id', 'name', 'unit', 'qty', 'price', 'amount'],
        properties: {
          ingredient_id: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'id hàng trong kho nếu cùng loại hàng, null nếu không có trong danh sách' },
          name: { type: 'string', description: 'Tên hàng như trên bill' },
          unit: { type: 'string', description: 'Đơn vị trên bill (kg, bịch, thùng…)' },
          qty: { type: 'number', description: 'Số lượng theo đơn vị trên bill' },
          price: { type: 'integer', description: 'Đơn giá 1 đơn vị (VNĐ). Không có đơn giá thì thành tiền chia số lượng' },
          amount: { type: 'integer', description: 'Thành tiền của dòng ghi trên bill (VNĐ), 0 nếu bill không ghi' },
        },
      },
    },
  },
};

const SYSTEM = `Bạn đọc ảnh hoá đơn / phiếu giao hàng của nhà cung cấp cho một nhà hàng ở Việt Nam (lẩu bò, steak). Bill thường viết tay, có thể nhiều trang.
Nhiệm vụ: chép lại từng dòng hàng trên bill, không bỏ dòng, không bịa dòng.
- Số tiền là VNĐ số nguyên. Bill viết tay hay ghi tắt nghìn đồng (vd "280" hoặc "280k" = 280.000); dùng tổng tiền và thành tiền từng dòng để suy ra cho đúng.
- Số lượng giữ theo đơn vị ghi trên bill (vd 5,2 kg → 5.2). Bill Việt Nam viết số lẻ bằng DẤU PHẨY hoặc dấu chấm nhỏ ("28,1" / "28.1" = 28.1 kg), đừng bỏ dấu (28,1 KHÔNG phải 281).
- Kiểm tra lại: số lượng × đơn giá phải ≈ thành tiền từng dòng, và cộng các dòng ≈ tổng bill. Lệch khoảng 10 hay 100 lần thường là đọc sót dấu phẩy ở số lượng → sửa lại cho khớp.
- ingredient_id: chọn trong DANH SÁCH KHO bên dưới nếu dòng đó là cùng loại hàng (tên gần giống, viết tắt, không dấu đều được). Không chắc thì để null, đừng đoán bừa.
- Chỗ nào mờ / không chắc thì vẫn ghi số đọc được và nêu trong note.`;

// Mã lấy từ biến môi trường ANTHROPIC_API_KEY, hoặc chủ quán dán trong app (Cài đặt → Kết nối)
export const billReaderKey = (ctx) => process.env.ANTHROPIC_API_KEY || ctx?.setting?.('anthropic_api_key') || '';
export function billReaderReady(ctx) { return !!billReaderKey(ctx); }

/**
 * photos: ['data:image/jpeg;base64,...'] · ingredients: [{id, name, unit, purchase_unit}]
 * Trả { supplier_name, signer_name, total, note, lines: [...] } hoặc ném Error có thông điệp tiếng Việt.
 */
export async function readBill(photos, ingredients, { fetchImpl = globalThis.fetch, timeoutMs = 120_000, apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  const key = apiKey;
  if (!key) throw new Error('Chưa cài đọc bill tự động: chủ quán dán mã Claude ở Cài đặt → Kết nối');
  const images = photos.map((p) => /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(p || ''))).filter(Boolean);
  if (!images.length) throw new Error('Chưa có ảnh bill hợp lệ');
  const kho = ingredients.map((g) => `${g.id}: ${g.name} (${g.purchase_unit || g.unit})`).join('\n');
  const content = [
    ...images.map(([, media_type, data]) => ({ type: 'image', source: { type: 'base64', media_type, data } })),
    { type: 'text', text: `DANH SÁCH KHO (id: tên (đơn vị mua)):\n${kho}\n\nĐọc bill trong ảnh (${images.length} trang) và trả JSON.` },
  ];
  const body = {
    model: MODEL, max_tokens: 16000, system: SYSTEM,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    fallbacks: 'default',
  };
  const call = async (b, beta) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(URL_, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21', ...(beta ? { 'anthropic-beta': beta } : {}) },
        body: JSON.stringify(b),
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Đọc bill quá lâu, thử lại hoặc nhập tay' : `Không gọi được máy đọc bill: ${e.message}`);
    } finally { clearTimeout(t); }
  };
  let r = await call(body, 'server-side-fallback-2026-07-01');
  // Phòng khi tài khoản chưa có beta fallback: gửi lại không kèm
  if (r.status === 400 && /fallback/i.test(JSON.stringify(r.data))) { const { fallbacks, ...rest } = body; r = await call(rest); }
  if (r.status === 401) throw new Error('Mã Claude sai hoặc đã bị xoá: dán lại ở Cài đặt → Kết nối');
  if (r.status === 402 || (r.status === 400 && /credit|balance|billing/i.test(JSON.stringify(r.data)))) throw new Error('Tài khoản Claude hết tiền: nạp thêm ở console.anthropic.com');
  if (r.status === 429) throw new Error('Đọc bill đang quá tải, thử lại sau 1 phút');
  if (r.status >= 400) throw new Error(`Máy đọc bill báo lỗi ${r.status}: ${r.data?.error?.message || ''}`.trim());
  if (r.data.stop_reason === 'refusal') throw new Error('Máy đọc bill từ chối ảnh này, nhập tay giúp');
  if (r.data.stop_reason === 'max_tokens') throw new Error('Bill quá dài, chụp từng trang rồi đọc lại');
  const text = (r.data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('Không đọc được kết quả, thử lại'); }
  const ids = new Set(ingredients.map((g) => g.id));
  const fixed = [];
  out.lines = (out.lines || []).map((l) => {
    let qty = Number(l.qty) || 0;
    const price = Math.max(0, Math.round(Number(l.price) || 0)), amount = Math.max(0, Math.round(Number(l.amount) || 0));
    // Lưới an toàn: số lượng gấp 10 / 100 / 1000 lần so với thành tiền ÷ đơn giá → mất dấu phẩy thập phân, sửa theo thành tiền
    if (qty > 0 && price > 0 && amount > 0) {
      const q = amount / price;
      for (const k of [10, 100, 1000]) if (Math.abs(qty / (q * k) - 1) < 0.03) { fixed.push(`${l.name}: ${qty} → ${Math.round(q * 1000) / 1000}`); qty = Math.round(q * 1000) / 1000; break; }
    }
    return { ...l, ingredient_id: ids.has(l.ingredient_id) ? l.ingredient_id : null, qty, price, amount };
  });
  if (fixed.length) out.note = [out.note, `App sửa số lượng theo thành tiền (nghi mất dấu phẩy): ${fixed.join('; ')}`].filter(Boolean).join(' · ');
  out.usage = r.data.usage || null;
  return out;
}

// Đọc ảnh chấm công tay (chủ quán 28/10: nhân viên gửi ảnh sổ / tin nhắn ghi giờ làm) → mỗi ngày các khúc giờ vào–ra
const TS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['days', 'note'],
  properties: {
    note: { type: 'string', description: 'Chỗ khó đọc / nghi ngờ, ngắn, tiếng Việt; trống nếu rõ hết' },
    days: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['day', 'month', 'ranges'],
        properties: {
          day: { type: 'integer' }, month: { type: 'integer' },
          ranges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'string', description: 'HH:MM 24 giờ' }, end: { type: 'string', description: 'HH:MM 24 giờ' } } } },
        },
      },
    },
  },
};
const TS_SYSTEM = `Bạn đọc ảnh chấm công tay của nhân viên nhà hàng ở Việt Nam (sổ viết tay, ghi chú điện thoại, tin nhắn).
Mỗi dòng thường là: ngày/tháng : giờ vào - giờ ra, có thể nhiều khúc cách nhau bằng dấu phẩy (vd "16/10 : 8h - 12h , 14h - 22h30").
- Chép đúng từng ngày, từng khúc giờ, không bỏ, không bịa. Giờ đổi sang dạng HH:MM 24 giờ (8h → 08:00, 22h30 → 22:30, 5h30 → 05:30).
- Chép đúng giờ như ghi (kể cả khi trông vô lý, vd "8h - 1h30" thì ghi end 01:30), app sẽ tự hỏi lại người dùng.
- Không đọc được chỗ nào thì nêu trong note.`;

export async function readTimesheet(photos, { fetchImpl = globalThis.fetch, timeoutMs = 120_000, apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey) throw new Error('Chưa cài đọc ảnh tự động: chủ quán dán mã Claude ở Cài đặt → Kết nối');
  const images = photos.map((p) => /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(p || ''))).filter(Boolean);
  if (!images.length) throw new Error('Chưa có ảnh hợp lệ');
  const body = {
    model: MODEL, max_tokens: 8000, system: TS_SYSTEM,
    messages: [{ role: 'user', content: [...images.map(([, media_type, data]) => ({ type: 'image', source: { type: 'base64', media_type, data } })), { type: 'text', text: `Đọc chấm công trong ảnh (${images.length} ảnh) và trả JSON.` }] }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: TS_SCHEMA } },
  };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res, data;
  try {
    res = await fetchImpl(URL_, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' }, body: JSON.stringify(body) });
    data = await res.json().catch(() => ({}));
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'Đọc ảnh quá lâu, thử lại hoặc gõ tay' : `Không gọi được máy đọc ảnh: ${e.message}`); } finally { clearTimeout(t); }
  if (res.status === 401) throw new Error('Mã Claude sai hoặc đã bị xoá: dán lại ở Cài đặt → Kết nối');
  if (res.status === 402 || (res.status === 400 && /credit|balance|billing/i.test(JSON.stringify(data)))) throw new Error('Tài khoản Claude hết tiền: nạp thêm ở console.anthropic.com');
  if (res.status === 429) throw new Error('Máy đọc ảnh đang quá tải, thử lại sau 1 phút');
  if (res.status >= 400) throw new Error(`Máy đọc ảnh báo lỗi ${res.status}: ${data?.error?.message || ''}`.trim());
  if (data.stop_reason === 'refusal') throw new Error('Máy đọc ảnh từ chối ảnh này, gõ tay giúp');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('Không đọc được kết quả, thử lại'); }
  const hm = (x) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(x || '').trim()); return m ? `${Number(m[1])}h${m[2] === '00' ? '' : m[2]}` : String(x || ''); };
  const pad = (n) => String(n).padStart(2, '0');
  const lines = (out.days || []).filter((d) => d.day && d.month && d.ranges?.length).map((d) => `${pad(d.day)}/${pad(d.month)} : ${d.ranges.map((r) => `${hm(r.start)} - ${hm(r.end)}`).join(' , ')}`);
  return { text: lines.join('\n'), note: out.note || '', usage: data.usage || null };
}
