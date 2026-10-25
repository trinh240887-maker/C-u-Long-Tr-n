import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { stockQty } from '../server/lib/stock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const JPG = `data:image/jpeg;base64,${Buffer.alloc(1200, 7).toString('base64')}`;

test('kho chứng từ end-to-end: khởi tạo → đề nghị mua → nhận hàng 2 người → xuất bù → sơ chế (yield) → bán 50 → huỷ, bể → kiểm kê mù → chặn tự duyệt', async (t) => {
  const db = openDb(':memory:', { now: Date.now() });
  const app = createApp({ db, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  t.after(() => new Promise((r) => { app.close(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined }); const c = res.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: res.status, data: await res.json().catch(() => null) }; }; };
  const O = mk();
  await O('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const teams = (await O('GET', '/api/teams')).data;
  const bep = teams.find((x) => /bếp/i.test(x.name)).id;
  const mkStaff = async (name, role, pin, team) => (await O('POST', '/api/staff', { name, role, pin, team_id: team })).data.id;
  const tk = await mkStaff('Thủ kho', 'staff', '481902', null), bt = await mkStaff('Bếp trưởng', 'team_lead', '593017', bep), ql = await mkStaff('Quản lý ca', 'shift_lead', '702913', null), nv = await mkStaff('NV bếp', 'staff', '815204', bep), mgr = await mkStaff('Quản lý', 'manager', '926315', null);
  assert.equal((await O('POST', '/api/wh/setup')).status, 200);
  await O('PUT', `/api/wh/staff/${tk}/roles`, { roles: ['thu_kho'] });
  await O('PUT', `/api/wh/staff/${bt}/roles`, { roles: ['bep_truong'] });
  const meta = (await O('GET', '/api/wh/meta')).data;
  const S = Object.fromEntries(meta.stores.map((s) => [s.code, s.id]));
  assert.deepEqual(Object.keys(S).sort(), ['BAR', 'BEP', 'CAP_PHAT', 'KHO_CHINH']);
  await O('PUT', `/api/wh/stores/${S.KHO_CHINH}/owner`, { owner_id: tk });
  await O('PUT', `/api/wh/stores/${S.BEP}/owner`, { owner_id: bt });
  await O('PUT', `/api/wh/stores/${S.BAR}/owner`, { owner_id: mgr });
  // Danh mục qua import CSV
  const csv = 'ma,ten,nhom_hang,don_vi_nhap,don_vi_kho,he_so_quy_doi,ton_min,ton_max,gia_nhap,kho_nha\nBO-THO,Bò thô,TUOI,kg,g,1000,5000,20000,280000,KHO_CHINH\nBO-SUAT,Bò thái tay suất,TUOI,suat,suat,1,0,0,0,BEP\nCHEN,Chén,CCDC,cai,cai,1,0,0,15000,BEP\nBIA,Bia lon,DO_UONG,thung,lon,24,48,240,380000,BAR';
  const imp = (await O('POST', '/api/wh/import', { kind: 'mat_hang', text: csv })).data;
  assert.equal(imp.ok, 4, JSON.stringify(imp));
  const items = (await O('GET', '/api/wh/meta')).data.items;
  const I = Object.fromEntries(items.filter((x) => x.code).map((x) => [x.code, x.id]));
  await O('PUT', '/api/wh/prep', { output_id: I['BO-SUAT'], input_id: I['BO-THO'], input_qty: 1000, output_qty: 6 });
  const menuItem = db.prepare('SELECT id, name FROM menu_items LIMIT 1').get();
  db.prepare('DELETE FROM menu_recipes WHERE item_id = ?').run(menuItem.id);
  db.prepare('INSERT INTO menu_recipes (item_id, ingredient_id, qty) VALUES (?, ?, 1)').run(menuItem.id, I['BO-SUAT']);

  const TK = mk(); await TK('POST', '/api/login', { pin: '481902' });
  const BT = mk(); await BT('POST', '/api/login', { pin: '593017' });
  const QL = mk(); await QL('POST', '/api/login', { pin: '702913' });
  const NV = mk(); await NV('POST', '/api/login', { pin: '815204' });
  const MG = mk(); await MG('POST', '/api/login', { pin: '926315' });

  // 1. Kiểm kê khởi tạo (người giữ kho không đếm kho mình) → chủ duyệt → chốt tồn đầu
  assert.equal((await TK('POST', '/api/wh/vouchers', { type: 'KK_DAU_KY', from_store: S.KHO_CHINH, lines: [{ ingredient_id: I['BO-THO'], qty: 2000 }] })).status, 403);
  for (const [st, lines] of [[S.KHO_CHINH, [{ ingredient_id: I['BO-THO'], qty: 2000 }]], [S.BEP, [{ ingredient_id: I.CHEN, qty: 50 }, { name_free: 'Nồi lẩu inox', qty: 30 }]], [S.BAR, [{ ingredient_id: I.BIA, qty: 48 }]]]) {
    const kk = (await QL('POST', '/api/wh/vouchers', { type: 'KK_DAU_KY', from_store: st, lines, submit: true })).data;
    assert.equal(kk.status, 'pending', JSON.stringify(kk));
    assert.equal((await O('POST', `/api/wh/vouchers/${kk.id}/approve`)).status, 200);
  }
  assert.equal((await O('GET', '/api/wh/meta')).data.live, true);
  assert.equal(stockQty(db, S.KHO_CHINH, I['BO-THO']), 2000);
  assert.equal(stockQty(db, S.BEP, I.CHEN), 50);
  assert.ok(db.prepare("SELECT 1 FROM ingredients WHERE name = 'Nồi lẩu inox' AND need_review = 1").get());

  // 2. Đề nghị mua 10kg bò → duyệt → nhận hàng (thủ kho lập + ảnh, bếp trưởng cân ký) → KHO_CHINH
  const sug = (await BT('GET', '/api/wh/suggest-purchase')).data;
  assert.ok(sug.some((x) => x.id === I['BO-THO']));
  const dnm = (await BT('POST', '/api/wh/vouchers', { type: 'DNM', lines: [{ ingredient_id: I['BO-THO'], qty: 10000, price: 280000 }], submit: true })).data;
  assert.equal((await BT('POST', `/api/wh/vouchers/${dnm.id}/approve`)).status, 403); // tự duyệt
  assert.equal((await MG('POST', `/api/wh/vouchers/${dnm.id}/approve`)).status, 200);
  const nm = (await TK('POST', '/api/wh/vouchers', { type: 'NM', ref_id: dnm.id, to_store: S.KHO_CHINH, lines: [{ ingredient_id: I['BO-THO'], qty: 10000, qty_expected: 10000, price: 280000 }] })).data;
  assert.equal((await TK('POST', `/api/wh/vouchers/${nm.id}/submit`)).status, 200);
  assert.equal((await BT('POST', `/api/wh/vouchers/${nm.id}/approve`)).status, 400); // chưa có ảnh cân
  await TK('POST', `/api/wh/vouchers/${nm.id}/photo`, { data: JPG });
  assert.equal((await TK('POST', `/api/wh/vouchers/${nm.id}/approve`)).status, 403); // người lập không tự ký nhận
  assert.equal((await BT('POST', `/api/wh/vouchers/${nm.id}/approve`)).status, 200);
  assert.equal(stockQty(db, S.KHO_CHINH, I['BO-THO']), 12000);
  // Đối chiếu 3 chứng từ: hoá đơn lệch → chưa được thanh toán; khớp → được thanh toán
  assert.equal((await MG('POST', `/api/wh/vouchers/${nm.id}/match`, { invoice_no: 'HD01', invoice_total: 2900000 })).data.ok, false);
  assert.equal((await MG('POST', `/api/wh/vouchers/${nm.id}/match`, { invoice_no: 'HD01', invoice_total: 2800000 })).data.ok, true);

  // 3. Xuất bù đầu ca lên mức chuẩn (9kg bò thô) → bếp trưởng ký nhận → sơ chế 9kg → 54 suất (đúng yield chuẩn 6 suất/kg)
  await MG('PUT', '/api/wh/par', { store: 'BEP', items: [{ ingredient_id: I['BO-THO'], qty: 9000 }] });
  const rs = (await TK('GET', '/api/wh/restock?store=BEP')).data;
  assert.equal(rs[0].give, 9000);
  const xb = (await TK('POST', '/api/wh/vouchers', { type: 'XB', to_store: S.BEP, lines: rs.map((x) => ({ ingredient_id: x.ingredient_id, qty: x.give })), submit: true })).data;
  assert.equal((await BT('POST', `/api/wh/vouchers/${xb.id}/approve`)).status, 200);
  assert.equal(stockQty(db, S.BEP, I['BO-THO']), 9000);
  assert.equal(stockQty(db, S.KHO_CHINH, I['BO-THO']), 3000);
  const sx = (await BT('POST', '/api/wh/vouchers', { type: 'NSX', lines: [{ ingredient_id: I['BO-THO'], kind: 'in', qty: 9000 }, { ingredient_id: I['BO-SUAT'], kind: 'out', qty: 54 }], submit: true })).data;
  assert.equal((await QL('POST', `/api/wh/vouchers/${sx.id}/approve`)).status, 200);
  assert.equal(stockQty(db, S.BEP, I['BO-SUAT']), 54);

  // 4. Bán 50 phần qua order → tự trừ kho bếp (không đụng kho chính)
  app.ctx.consumeSale({ id: nv }, [{ id: 999001, menu_item_id: menuItem.id, qty: 50, name: menuItem.name }]);
  assert.equal(stockQty(db, S.BEP, I['BO-SUAT']), 4);

  // 5. Huỷ 2 suất (ảnh bắt buộc, người khác duyệt) → bể 3 chén (ghi người làm bể)
  const xh = (await NV('POST', '/api/wh/vouchers', { type: 'XH', from_store: S.BEP, lines: [{ ingredient_id: I['BO-SUAT'], qty: 2, reason: 'HONG' }] })).data;
  assert.equal((await NV('POST', `/api/wh/vouchers/${xh.id}/submit`)).status, 400); // thiếu ảnh
  await NV('POST', `/api/wh/vouchers/${xh.id}/photo`, { data: JPG });
  assert.equal((await NV('POST', `/api/wh/vouchers/${xh.id}/submit`)).status, 200);
  assert.equal((await NV('POST', `/api/wh/vouchers/${xh.id}/approve`)).status, 403); // tự duyệt
  assert.equal((await QL('POST', `/api/wh/vouchers/${xh.id}/approve`)).status, 200);
  assert.equal(stockQty(db, S.BEP, I['BO-SUAT']), 2);
  assert.equal((await NV('POST', '/api/wh/vouchers', { type: 'XH', from_store: S.BEP, lines: [{ ingredient_id: I.CHEN, qty: 3, reason: 'BE_VO' }] })).status, 400); // thiếu người làm bể
  const be = (await QL('POST', '/api/wh/vouchers', { type: 'XH', from_store: S.BEP, lines: [{ ingredient_id: I.CHEN, qty: 3, reason: 'BE_VO', who_broke: nv }] })).data;
  await QL('POST', `/api/wh/vouchers/${be.id}/photo`, { data: JPG });
  await QL('POST', `/api/wh/vouchers/${be.id}/submit`);
  assert.equal((await MG('POST', `/api/wh/vouchers/${be.id}/approve`)).status, 200);
  assert.equal(stockQty(db, S.BEP, I.CHEN), 47);

  // 6. Kiểm kê mù cuối ca: bếp trưởng (người giữ) không được đếm; thủ kho đếm, không thấy số sổ; gửi xong mới có lệch + màu; đỏ phải giải trình
  assert.equal((await BT('POST', '/api/wh/vouchers', { type: 'KK_CA', from_store: S.BEP, lines: [{ ingredient_id: I['BO-SUAT'], qty: 1 }] })).status, 403);
  const kk = (await TK('POST', '/api/wh/vouchers', { type: 'KK_CA', from_store: S.BEP, lines: [{ ingredient_id: I['BO-SUAT'], qty: 1 }, { ingredient_id: I.CHEN, qty: 47 }] })).data;
  assert.equal(kk.lines[0].qty_expected, undefined); // mù
  const sent = (await TK('POST', `/api/wh/vouchers/${kk.id}/submit`)).data;
  assert.equal(sent.lines.find((l) => l.ingredient_id === I['BO-SUAT']).color, 'red'); // gửi xong mới thấy lệch + màu
  const full = (await MG('GET', `/api/wh/vouchers/${kk.id}`)).data;
  const ln = full.lines.find((l) => l.ingredient_id === I['BO-SUAT']);
  assert.equal(ln.qty_expected, 2); assert.equal(ln.diff, 1); assert.equal(ln.pct, 50); assert.equal(ln.color, 'red');
  assert.equal(full.lines.find((l) => l.ingredient_id === I.CHEN).color, 'green');
  assert.equal((await MG('POST', `/api/wh/vouchers/${kk.id}/approve`)).status, 400); // chưa giải trình
  assert.equal((await TK('POST', `/api/wh/lines/${ln.id}/explain`, { text: 'x' })).status, 403); // chỉ người phụ trách kho
  assert.equal((await BT('POST', `/api/wh/lines/${ln.id}/explain`, { text: 'Thái dư tay 1 suất cho bàn 12' })).status, 200);
  assert.equal((await MG('POST', `/api/wh/vouchers/${kk.id}/approve`)).status, 200);
  assert.equal(stockQty(db, S.BEP, I['BO-SUAT']), 1);
  const dash = (await MG('GET', '/api/wh/dashboard')).data;
  assert.ok(dash.variance.some((x) => x.color === 'red' && x.explain));
  assert.ok(dash.yields.some((y) => y.pct === 100));
  assert.ok(dash.breakage.some((b) => b.who === 'NV bếp' && b.qty === 3));

  // 7. Thử tự duyệt phiếu của mình → bị chặn (cả quản lý)
  const xtn = (await MG('POST', '/api/wh/vouchers', { type: 'XTN', lines: [{ ingredient_id: I['BO-THO'], qty: 500 }], submit: true })).data;
  const self = await MG('POST', `/api/wh/vouchers/${xtn.id}/approve`);
  assert.equal(self.status, 403);
  assert.match(self.data.error, /tự duyệt/);
  // Nhật ký có đủ thao tác
  assert.ok((await O('GET', '/api/wh/audit')).data.length > 20);
});
