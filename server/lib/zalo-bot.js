// Zalo Bot: gửi tin vào nhóm Zalo (đơn đặt hàng đã duyệt…).
// CHƯA có tài liệu chính thức trong tay (máy không mở được docs.zaloplatforms.com). Theo các nguồn ngoài (23–24/10/2026),
// Zalo Bot API giống kiểu Telegram: POST https://bot-api.zaloplatforms.com/bot<TOKEN>/<method> body JSON
//   getMe · getUpdates (lấy tin bot nhận, trong nhóm chỉ thấy tin @nhắc bot) · sendMessage { chat_id, text }
// → nút "Kiểm tra bot" trong app để chủ quán thử thật trước khi dùng.
const BASE = 'https://bot-api.zaloplatforms.com';

export function createZaloBot(ctx, { fetchImpl = globalThis.fetch } = {}) {
  const state = { lastRaw: '' };
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
  // Lấy tin bot nhận được (trong nhóm chỉ có tin @bot), chuẩn hoá về 1 dạng
  async function updates() {
    const r = await call('getUpdates', { timeout: 0 });
    const list = Array.isArray(r) ? r : r ? [r] : [];
    if (list.length) state.lastRaw = JSON.stringify(list[0]).slice(0, 600); // để chủ quán xem bot nhận gì (Cài đặt → Zalo Bot)
    const out = [];
    for (const u of list) {
      const m = u.message || u.result?.message || u;
      const c = m?.chat;
      if (!c?.id) continue;
      let date = Number(m.date || u.date || 0);
      if (date && date < 1e12) date *= 1000;
      out.push({
        id: String(m.message_id || m.msg_id || ''), date,
        chat: { id: String(c.id), type: c.chat_type || c.type || '', name: c.title || c.display_name || c.name || '' },
        from: { id: String(m.from?.id || ''), name: m.from?.display_name || m.from?.name || '', bot: !!m.from?.is_bot },
        text: String(m.text || ''),
      });
    }
    return out;
  }
  // Nhớ các nhóm đã thấy (máy tự đọc tin liên tục nên nút "Tìm nhóm" lấy từ đây)
  function remember(list) {
    let seen = [];
    try { seen = JSON.parse(ctx.setting('zalo_bot_seen_chats') || '[]'); } catch { /* rỗng */ }
    const map = new Map(seen.map((c) => [c.id, c]));
    for (const u of list) map.set(u.chat.id, { id: u.chat.id, type: u.chat.type, name: u.chat.name || map.get(u.chat.id)?.name || u.from.name, text: u.text.slice(0, 60) });
    const all = [...map.values()].slice(-20);
    if (list.length && ctx.setSetting) ctx.setSetting('zalo_bot_seen_chats', JSON.stringify(all));
    return all;
  }
  async function chats() {
    let list = [];
    try { list = await updates(); } catch (e) { if (!ctx.setting('zalo_bot_seen_chats')) throw e; }
    return remember(list).reverse();
  }
  const send = (chatId, text) => call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 2000) });
  return { call, chats, updates, remember, send, state, ready: () => !!token() };
}
