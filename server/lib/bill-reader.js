// Đọc ảnh bill nhà cung cấp (thường viết tay) bằng Claude → dòng hàng đã khớp với kho.
// Gọi thẳng HTTP (app không dùng thư viện ngoài). Theo tài liệu Claude API (tra 23/10/2026):
//   POST https://api.anthropic.com/v1/messages · header x-api-key, anthropic-version: 2026-10-21
//   output_config.format = { type: 'json_schema', schema } → câu trả lời là JSON đúng khuôn
//   fallbacks: 'default' (beta server-side-fallback-2026-07-01): model từ chối thì máy chủ tự chạy lại bằng model khác
// Cần biến môi trường ANTHROPIC_API_KEY (Railway → Variables). Không có thì nút "Đọc bill" báo chưa cài.
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
        required: ['ingredient_id', 'name', 'unit', 'qty', 'price'],
        properties: {
          ingredient_id: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'id hàng trong kho nếu cùng loại hàng, null nếu không có trong danh sách' },
          name: { type: 'string', description: 'Tên hàng như trên bill' },
          unit: { type: 'string', description: 'Đơn vị trên bill (kg, bịch, thùng…)' },
          qty: { type: 'number', description: 'Số lượng theo đơn vị trên bill' },
          price: { type: 'integer', description: 'Đơn giá 1 đơn vị (VNĐ). Không có đơn giá thì thành tiền chia số lượng' },
        },
      },
    },
  },
};

const SYSTEM = `Bạn đọc ảnh hoá đơn / phiếu giao hàng của nhà cung cấp cho một nhà hàng ở Việt Nam (lẩu bò, steak). Bill thường viết tay, có thể nhiều trang.
Nhiệm vụ: chép lại từng dòng hàng trên bill, không bỏ dòng, không bịa dòng.
- Số tiền là VNĐ số nguyên. Bill viết tay hay ghi tắt nghìn đồng (vd "280" hoặc "280k" = 280.000); dùng tổng tiền và thành tiền từng dòng để suy ra cho đúng.
- Số lượng giữ theo đơn vị ghi trên bill (vd 5,2 kg → 5.2).
- ingredient_id: chọn trong DANH SÁCH KHO bên dưới nếu dòng đó là cùng loại hàng (tên gần giống, viết tắt, không dấu đều được). Không chắc thì để null, đừng đoán bừa.
- Chỗ nào mờ / không chắc thì vẫn ghi số đọc được và nêu trong note.`;

export function billReaderReady() { return !!process.env.ANTHROPIC_API_KEY; }

/**
 * photos: ['data:image/jpeg;base64,...'] · ingredients: [{id, name, unit, purchase_unit}]
 * Trả { supplier_name, signer_name, total, note, lines: [...] } hoặc ném Error có thông điệp tiếng Việt.
 */
export async function readBill(photos, ingredients, { fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Chưa cài đọc bill tự động (thiếu ANTHROPIC_API_KEY trên máy chủ)');
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
  if (r.status === 401) throw new Error('Mã ANTHROPIC_API_KEY sai hoặc đã bị xoá');
  if (r.status === 402 || (r.status === 400 && /credit|balance|billing/i.test(JSON.stringify(r.data)))) throw new Error('Tài khoản Claude hết tiền: nạp thêm ở console.anthropic.com');
  if (r.status === 429) throw new Error('Đọc bill đang quá tải, thử lại sau 1 phút');
  if (r.status >= 400) throw new Error(`Máy đọc bill báo lỗi ${r.status}: ${r.data?.error?.message || ''}`.trim());
  if (r.data.stop_reason === 'refusal') throw new Error('Máy đọc bill từ chối ảnh này, nhập tay giúp');
  if (r.data.stop_reason === 'max_tokens') throw new Error('Bill quá dài, chụp từng trang rồi đọc lại');
  const text = (r.data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('Không đọc được kết quả, thử lại'); }
  const ids = new Set(ingredients.map((g) => g.id));
  out.lines = (out.lines || []).map((l) => ({ ...l, ingredient_id: ids.has(l.ingredient_id) ? l.ingredient_id : null, qty: Number(l.qty) || 0, price: Math.max(0, Math.round(Number(l.price) || 0)) }));
  out.usage = r.data.usage || null;
  return out;
}
