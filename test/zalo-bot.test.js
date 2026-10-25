import test from 'node:test';
import assert from 'node:assert/strict';
import { createZaloBot } from '../server/lib/zalo-bot.js';

test('zalo bot: gọi đúng địa chỉ, gửi chat_id + text, lấy nhóm từ getUpdates, báo lỗi rõ', async () => {
  const st = { zalo_bot_token: '' };
  const ctx = { setting: (k) => st[k], setSetting: (k, v) => { st[k] = v; } };
  const calls = [];
  let reply = { ok: true, result: { message_id: 1 } };
  const fetchImpl = async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return { status: 200, json: async () => reply }; };
  const bot = createZaloBot(ctx, { fetchImpl });
  delete process.env.ZALO_BOT_TOKEN;
  await assert.rejects(bot.send('g1', 'x'), /Chưa dán token/);
  st.zalo_bot_token = '123:abc';
  await bot.send('g1', 'Đơn #1');
  assert.equal(calls[0].url, 'https://bot-api.zaloplatforms.com/bot123:abc/sendMessage');
  assert.deepEqual(calls[0].body, { chat_id: 'g1', text: 'Đơn #1' });
  reply = { ok: true, result: [
    { event_name: 'message.text.received', message: { chat: { id: 'grp9', chat_type: 'GROUP' }, from: { display_name: 'Anh Diễn' }, text: '@bot chào' } },
    { message: { chat: { id: 'grp9', chat_type: 'GROUP' }, text: 'lần 2' } },
  ] };
  bot.remember(await bot.updates()); // vòng đọc tin nhớ nhóm
  assert.deepEqual(calls.at(-1).body, { timeout: 25 }); // chờ dài, không ngắt sớm
  const list = await bot.chats();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'grp9');
  // Hết giờ chờ mà không có tin mới → không phải lỗi
  const slow = createZaloBot(ctx, { fetchImpl: async () => { throw new Error('The operation was aborted due to timeout'); } });
  assert.deepEqual(await slow.updates(), []);
  reply = { ok: false, error_code: 401, description: 'Unauthorized' };
  await assert.rejects(bot.call('getMe'), /401: Unauthorized/);
});
