// Gửi tin nhắn tư vấn qua Zalo Official Account (OA API v3).
// LƯU Ý: chưa được thử với OA thật. Cần kiểm tra lại với tài liệu tại developers.zalo.me
// trước khi bật (Cài đặt → Zalo OA). Mọi khoá bí mật chỉ nằm trên máy chủ.

const SEND_URL = 'https://openapi.zalo.me/v3.0/oa/message/cs';
const TOKEN_URL = 'https://oauth.zaloapp.com/v4/oa/access_token';

export function createZaloOaTransport(ctx, { fetchImpl = globalThis.fetch } = {}) {
  async function refreshToken() {
    const appId = ctx.setting('zalo_app_id');
    const secret = ctx.setting('zalo_secret_key');
    const refresh = ctx.setting('zalo_refresh_token');
    if (!appId || !secret || !refresh) throw Object.assign(new Error('Thiếu App ID, Secret key hoặc Refresh token của Zalo'), { permanent: true });
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: secret },
      body: new URLSearchParams({ refresh_token: refresh, app_id: appId, grant_type: 'refresh_token' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.access_token) throw new Error(`Không làm mới được token Zalo: ${data.error_description || data.message || res.status}`);
    ctx.setSetting('zalo_access_token', data.access_token);
    if (data.refresh_token) ctx.setSetting('zalo_refresh_token', data.refresh_token);
    ctx.setSetting('zalo_token_expires_at', String(ctx.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000));
    return data.access_token;
  }

  async function token() {
    const t = ctx.setting('zalo_access_token');
    if (t && Number(ctx.setting('zalo_token_expires_at') || 0) > ctx.now()) return t;
    return refreshToken();
  }

  async function send({ userId, text }) {
    if (!userId) throw Object.assign(new Error('Chưa liên kết Zalo'), { permanent: true });
    const res = await fetchImpl(SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', access_token: await token() },
      body: JSON.stringify({ recipient: { user_id: userId }, message: { text: text.slice(0, 2000) } }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error !== 0) throw new Error(`Zalo từ chối: ${data.message || res.status} (mã ${data.error})`);
    return data;
  }

  return { send, refreshToken };
}
