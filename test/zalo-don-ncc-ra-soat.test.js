// Rà soát 28/10: đơn NCC qua Zalo — gắn NCC theo tên nhóm chặt hơn, người lạ → chờ duyệt, chat riêng không thành nhóm NCC, báo nhóm chưa gắn 1 lần
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { matchSupplierByGroupName } from '../server/routes/zalo-orders.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('Gắn NCC theo tên nhóm: tên NCC phải nằm trong tên nhóm, không khớp ngược, tên ngắn phải trùng nguyên từ', () => {
  const list = [{ id: 1, name: 'Sạp thịt Kim Thanh Ngọc' }, { id: 2, name: 'Ba' }, { id: 3, name: 'Rau Củ Quả Hoa' }, { id: 4, name: 'An' }];
  assert.equal(matchSupplierByGroupName('CLT - Sạp thịt Kim Thanh Ngọc', list)?.id, 1);
  assert.equal(matchSupplierByGroupName('Kim Thanh', list), null); // trước: "sạp thịt kim thanh ngọc".includes("kim thanh") → khớp sai
  assert.equal(matchSupplierByGroupName('Nhóm Bếp Ba Miền', list)?.id, 2); // trùng nguyên từ "ba"
  assert.equal(matchSupplierByGroupName('Bánh bao', list), null); // "ba" chỉ là một phần chữ
  assert.equal(matchSupplierByGroupName('Hoa', list), null);
  assert.equal(matchSupplierByGroupName('', list), null);
  assert.equal(matchSupplierByGroupName('Rau củ quả hoa - An', list)?.id, 3); // nhiều NCC khớp → tên dài nhất
});

test('Đơn Zalo: người nhắn chưa gắn → chờ duyệt; chat riêng bỏ qua; nhóm chưa gắn NCC báo 1 lần, không khẩn', () => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  try {
    const { ctx } = app;
    const sup = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('Sạp thịt Kim Thanh Ngọc')").run().lastInsertRowid);
    const store = db.prepare('SELECT id FROM stores ORDER BY id').get().id;
    db.prepare("INSERT INTO ingredients (name, unit, home_store_id, supplier_id, purchase_unit, purchase_factor) VALUES ('Thăn bò', 'kg', ?, ?, 'kg', 1)").run(store, sup);
    const ownerId = db.prepare("SELECT id FROM staff WHERE role = 'owner'").get().id;
    const msg = (chat, from, text) => ({ id: String(Math.random()), date: Date.now(), chat, from: { id: from, name: from }, text });
    const nNoti = () => db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;

    // Chat riêng 1:1 có chữ giống đơn → không tạo nhóm NCC, không trả lời
    assert.equal(ctx.zaloOrderMsg(msg({ id: 'p1', type: 'PRIVATE', name: 'Kim Thanh Ngọc' }, 'uX', 'thăn bò 10kg'), 'thăn bò 10kg'), null);
    assert.equal(ctx.supplierGroupOf('p1'), undefined);

    // Người lạ trong nhóm NCC → đơn CHỜ DUYỆT, không người duyệt
    const g = { id: 's1', type: 'GROUP', name: 'CLT - Sạp thịt Kim Thanh Ngọc' };
    const r1 = ctx.zaloOrderMsg(msg(g, 'uLa', 'thăn bò 10kg'), 'thăn bò 10kg');
    assert.match(r1, /CHỜ quản lý duyệt/);
    let po = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC').get();
    assert.equal(po.status, 'submitted');
    assert.equal(po.approved_by, null);
    assert.ok(db.prepare("SELECT 1 FROM notifications WHERE staff_id = ? AND title LIKE '%chờ duyệt%'").get(ownerId));

    // Chủ quán đã gắn Zalo → tự duyệt
    db.prepare('INSERT INTO zalo_bot_users (uid, staff_id) VALUES (?, ?)').run('uOwner', ownerId);
    ctx.zaloOrderMsg(msg(g, 'uOwner', 'thăn bò 5kg'), 'thăn bò 5kg');
    po = db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC').get();
    assert.equal(po.status, 'approved');
    assert.equal(po.approved_by, ownerId);

    // Nhóm chưa gắn NCC: báo 1 lần, không khẩn — kể cả khi chủ quán xoá nhóm rồi nhóm nhắn lại
    const g2 = { id: 's2', type: 'GROUP', name: 'Nhóm lạ' };
    const before = nNoti();
    assert.match(ctx.zaloOrderMsg(msg(g2, 'uLa', 'thăn bò 1kg'), 'thăn bò 1kg'), /chưa gắn nhà cung cấp/);
    const after1 = nNoti();
    assert.ok(after1 > before);
    assert.equal(db.prepare("SELECT MAX(urgent) AS u FROM notifications WHERE title LIKE '%chưa gắn nhà cung cấp%'").get().u, 0);
    ctx.setSetting('zalo_supplier_groups', JSON.stringify(JSON.parse(ctx.setting('zalo_supplier_groups')).filter((x) => x.id !== 's2')));
    ctx.zaloOrderMsg(msg(g2, 'uLa', 'thăn bò 2kg'), 'thăn bò 2kg');
    assert.equal(nNoti(), after1);
  } finally { app.close(); }
});
