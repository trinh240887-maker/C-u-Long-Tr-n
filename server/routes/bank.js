import crypto from 'node:crypto';
import { fail, v } from '../http.js';
import { rank } from '../db.js';

// Nhận báo biến động số dư từ SePay (webhook). Techcombank không có API công khai nên đi qua SePay.
// Theo tài liệu SePay (developer.sepay.vn → Webhook): POST JSON, xác thực header "Authorization: Apikey <KEY>",
// các trường: id, gateway, transactionDate, accountNumber, code, content, transferType ("in"/"out"), transferAmount,
// accumulated, subAccount, referenceCode, description. SePay gửi lại nếu không nhận 2xx → chống trùng theo id.
// CHƯA kiểm với giao dịch thật: khi chủ quán nối SePay, chuyển thử 10.000đ để xác nhận tên trường.
export default function (r, ctx) {
  const { db } = ctx;
  if (!ctx.setting('sepay_api_key')) ctx.setSetting('sepay_api_key', crypto.randomBytes(20).toString('hex'));
  const isCashier = (me) => rank(me.role) >= rank('shift_lead') || !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id);
  const vnd = (n) => `${Number(n || 0).toLocaleString('vi-VN')}đ`;

  function store({ provider, extId, direction, amount, content = '', code = '', account = '', ref = '', txnAt = '', raw = {} }) {
    const exists = db.prepare('SELECT id FROM bank_txns WHERE provider = ? AND ext_id = ?').get(provider, String(extId));
    if (exists) return { id: exists.id, duplicate: true };
    const id = Number(db.prepare(`INSERT INTO bank_txns (provider, ext_id, direction, amount, content, code, account, ref, txn_at, date, received_at, status, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(provider, String(extId), direction, amount, String(content).slice(0, 500), String(code || '').slice(0, 60),
      String(account || '').slice(0, 40), String(ref || '').slice(0, 80), String(txnAt || '').slice(0, 40), ctx.clock().businessDate(ctx.now()), ctx.now(),
      direction === 'in' ? 'unmatched' : 'unassigned', JSON.stringify(raw).slice(0, 4000)).lastInsertRowid);
    if (direction === 'in') ctx.applyBankIn(id);
    else ctx.broadcast('bank');
    return { id, duplicate: false };
  }

  r.post('/api/bank/sepay', null, ({ req, body }) => {
    const want = Buffer.from(`Apikey ${ctx.setting('sepay_api_key')}`);
    const got = Buffer.from(String(req.headers.authorization || ''));
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) fail(401, 'Sai khoá');
    if (ctx.setting('sepay_enabled') !== '1') return { success: true, skipped: 'Chưa bật nhận SePay trong app' };
    const amount = Math.round(Number(body.transferAmount));
    if (!body.id || !Number.isFinite(amount) || amount <= 0) fail(400, 'Thiếu id / số tiền');
    const direction = body.transferType === 'out' ? 'out' : 'in';
    const out = store({ provider: 'sepay', extId: body.id, direction, amount, content: body.content || body.description || '', code: body.code || '', account: body.accountNumber || '', ref: body.referenceCode || '', txnAt: body.transactionDate || '', raw: body });
    return { success: true, ...out };
  });

  // ---------- Cài đặt (chủ quán) ----------
  r.get('/api/bank/settings', 'manager', ({ me, req }) => {
    const base = ctx.setting('public_url') || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    const last = db.prepare("SELECT received_at, amount, direction FROM bank_txns WHERE provider = 'sepay' ORDER BY id DESC LIMIT 1").get();
    return { enabled: ctx.setting('sepay_enabled') === '1', webhook_url: `${base}/api/bank/sepay`, ...(me.role === 'owner' ? { api_key: ctx.setting('sepay_api_key') } : {}), last: last || null };
  });
  r.post('/api/bank/settings', 'owner', ({ me, body }) => {
    if (body.enabled !== undefined) ctx.setSetting('sepay_enabled', v.bool(body.enabled) ? '1' : '0');
    if (body.reset_key) ctx.setSetting('sepay_api_key', crypto.randomBytes(20).toString('hex'));
    ctx.audit(me, 'bank.settings', { enabled: body.enabled, reset_key: !!body.reset_key });
    return { ok: true };
  });

  // Giả lập tiền về để chủ quán tập dùng trước khi nối SePay (ghi rõ là THỬ)
  r.post('/api/bank/test', 'owner', ({ me, body }) => {
    const amount = v.int(Number(String(body.amount ?? '').replace(/[.,\s]/g, '')), { min: 1000, max: 100_000_000, name: 'Số tiền' });
    const content = v.text(body.content, { name: 'Nội dung', max: 120 }) || 'THU';
    const out = store({ provider: 'test', extId: `t${ctx.now()}${Math.random().toString(36).slice(2, 6)}`, direction: body.direction === 'out' ? 'out' : 'in', amount, content: `${content} (THỬ)` });
    ctx.audit(me, 'bank.test', { amount, content });
    return out;
  });

  // ---------- Thu ngân xử lý tiền chưa khớp ----------
  const loadTxn = (id) => { const t = db.prepare('SELECT * FROM bank_txns WHERE id = ?').get(id); if (!t) fail(404, 'Không có giao dịch'); return t; };
  // Ghép khoản tiền vào bill (khách tự gõ số TK, không quét QR nên thiếu mã CLT)
  r.post('/api/bank/txns/:id/assign', 'staff', ({ me, params, body }) => {
    if (!isCashier(me)) fail(403, 'Chỉ thu ngân / trưởng ca trở lên');
    const t = loadTxn(params.id);
    if (t.direction !== 'in' || t.status !== 'unmatched') fail(400, 'Khoản này không cần ghép');
    const no = v.int(body.bill_no, { min: 1, name: 'Số bill' });
    const s = db.prepare("SELECT id FROM table_sessions WHERE bill_no = ? AND status != 'cancelled'").get(no);
    if (!s) fail(404, `Không có bill ${no}`);
    db.prepare('UPDATE bank_txns SET session_id = ?, handled_by = ?, note = ? WHERE id = ?').run(s.id, me.id, `Ghép tay bởi ${me.name}`, t.id);
    ctx.applyBankIn(t.id);
    ctx.audit(me, 'bank.assign', { txn: t.id, bill_no: no, amount: t.amount });
    return { ok: true };
  });
  // Khoản cần xem: bill trả tiền mặt mà có CK. Quản lý quyết: là tip, hay đã hoàn lại khách
  r.post('/api/bank/txns/:id/resolve', 'manager', ({ me, params, body }) => {
    const t = loadTxn(params.id);
    const action = v.oneOf(body.action, ['tip', 'refunded', 'ignore'], { name: 'Cách xử lý' });
    const note = v.text(body.note, { name: 'Ghi chú', max: 120 });
    if (t.direction !== 'in' || !['unmatched', 'review'].includes(t.status)) fail(400, 'Khoản này đã xử lý');
    if (action === 'tip') {
      if (!t.session_id) fail(400, 'Ghép bill trước rồi mới tính là tip');
      db.prepare('UPDATE table_sessions SET tip_transfer = tip_transfer + ? WHERE id = ?').run(t.amount, t.session_id);
      db.prepare("UPDATE bank_txns SET status = 'matched', note = ?, handled_by = ? WHERE id = ?").run(`Tip (${me.name}) ${note}`.trim(), me.id, t.id);
    } else {
      db.prepare("UPDATE bank_txns SET status = 'ignored', note = ?, handled_by = ? WHERE id = ?").run(`${action === 'refunded' ? 'Đã hoàn lại khách' : 'Không phải tiền bán hàng'} (${me.name}) ${note}`.trim(), me.id, t.id);
    }
    const owners = db.prepare("SELECT id FROM staff WHERE active = 1 AND role = 'owner'").all().map((x) => x.id).filter((x) => x !== me.id);
    ctx.notify(owners, { title: `Khoản CK ${vnd(t.amount)}: ${action === 'tip' ? 'tính là tip' : action === 'refunded' ? 'đã hoàn lại khách' : 'bỏ qua, không phải tiền bán hàng'}`, body: `"${t.content.slice(0, 60)}" · ${me.name} xử lý${note ? `: ${note}` : ''}`, link: '/thu-ngan' });
    ctx.audit(me, 'bank.resolve', { txn: t.id, action, amount: t.amount });
    ctx.broadcast('pos');
    return { ok: true };
  });
}
