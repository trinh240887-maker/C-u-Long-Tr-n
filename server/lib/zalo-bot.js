// Zalo Bot: gửi tin vào nhóm Zalo (đơn đặt hàng đã duyệt…).
// CHƯA có tài liệu chính thức trong tay (máy không mở được docs.zaloplatforms.com). Theo các nguồn ngoài (23–24/10/2026),
// Zalo Bot API giống kiểu Telegram: POST https://bot-api.zaloplatforms.com/bot<TOKEN>/<method> body JSON
//   getMe · getUpdates (lấy tin bot nhận, trong nhóm chỉ thấy tin @nhắc bot) · sendMessage { chat_id, text }
// → nút "Kiểm tra bot" trong app để chủ quán thử thật trước khi dùng.
const BASE = 'https://bot-api.zaloplatforms.com';

export function createZaloBot(ctx, { fetchImpl = globalThis.fetch } = {}) {
  const token = () => ctx.setting('zalo_bot_token') || process.env.ZALO_BOT_TOKEN || '';
  async function call(method, body = {}) {
    const t = token();
    if (!t) throw new Error('Chưa dán token Zalo Bot (Cài đặt → Kết nối)');
    let res;
    try {
      res = await fetchImpl(`${BASE}/bot${t}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    } catch (e) { throw new Error(`Không gọi được Zalo Bot: ${e.message}`); }
    const j = await res.json().catch(() => ({}));
    if (res.status >= 400 || j.ok === false) throw new Error(`Zalo Bot báo lỗi ${j.error_code ?? res.status}: ${j.description || j.message || ''}`.trim());
    return j.result ?? j;
  }
  // Tìm các cuộc trò chuyện bot đã nhận tin (nhóm: nhắn @bot trong nhóm trước)
  async function chats() {
    const r = await call('getUpdates', { timeout: 0 });
    const list = Array.isArray(r) ? r : r ? [r] : [];
    const seen = new Map();
    for (const u of list) {
      const m = u.message || u.result?.message || u;
      const c = m?.chat;
      if (c?.id && !seen.has(String(c.id))) seen.set(String(c.id), { id: String(c.id), type: c.chat_type || c.type || '', name: c.title || c.display_name || c.name || m.from?.display_name || '', text: m.text || '' });
    }
    return [...seen.values()];
  }
  const send = (chatId, text) => call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 2000) });
  return { call, chats, send, ready: () => !!token() };
}
