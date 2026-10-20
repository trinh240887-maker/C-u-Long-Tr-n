import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock, addDays } from '../server/lib/time.js';
import { forecastDay, purchaseNeed, areaNeed, toPurchaseUnits, roundUp } from '../server/lib/forecast.js';
import { addLot, takeLots, stockQty } from '../server/lib/stock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));

test('dự báo: đủ dữ liệu cùng thứ thì lấy trung bình cùng thứ, không thì trung bình gần đây', () => {
  const usage = new Map();
  // 4 thứ Bảy trước dùng 10, các ngày khác dùng 5
  for (let k = 1; k <= 28; k++) {
    const d = addDays('2026-10-24', -k);
    usage.set(d, k % 7 === 0 ? 10 : 5);
  }
  const sat = forecastDay(usage, '2026-10-24');
  assert.equal(sat.basis, 'weekday');
  assert.equal(sat.qty, 10);
  const few = new Map([['2026-10-22', 4], ['2026-10-23', 6]]);
  const f = forecastDay(few, '2026-10-24');
  assert.equal(f.basis, 'recent');
  assert.equal(f.qty, 5);
  assert.equal(forecastDay(new Map(), '2026-10-24').basis, 'none');
});

test('gợi ý mua: đồ tươi theo ngày mai, đồ khô theo điểm đặt hàng', () => {
  // Bò thái: dự báo 9 kg, +10%, còn 2 kg → cần 7.9 kg
  assert.equal(purchaseNeed({ freshness: 'fresh', forecastTomorrow: 9000, safetyPct: 10, stock: 2000 }), 7900);
  // Tươi nhưng chưa có lịch sử: ít nhất đủ tồn tối thiểu
  assert.equal(purchaseNeed({ freshness: 'fresh', forecastTomorrow: 0, minStock: 1000, stock: 200 }), 800);
  // Thịt steak (mát): dùng 6.25 kg/ngày, giao sau 2 ngày, tối thiểu 3 kg → điểm đặt 15.5 kg
  const base = { freshness: 'chilled', avgDaily: 6250, leadDays: 2, cycleDays: 4, minStock: 3000, safetyPct: 0 };
  assert.equal(purchaseNeed({ ...base, stock: 20000 }), 0);
  assert.equal(purchaseNeed({ ...base, stock: 15000 }), 6250 * 6 + 3000 - 15000);
  assert.equal(toPurchaseUnits(7900, { factor: 1000, step: 0.5 }), 8);
  assert.equal(toPurchaseUnits(25, { factor: 24, step: 1 }), 2);
  assert.equal(roundUp(0, 1), 0);
  assert.equal(areaNeed({ forecast: 10, safetyPct: 10, stock: 4 }), 7);
});

test('xuất kho theo lô hết hạn trước', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO ingredients (name, unit) VALUES ('Sữa', 'ml')").run();
  addLot(db, { storeId: 1, ingredientId: 1, qty: 500, expiresOn: '2026-10-30', at: 1 });
  addLot(db, { storeId: 1, ingredientId: 1, qty: 300, expiresOn: '2026-10-25', at: 2 });
  addLot(db, { storeId: 1, ingredientId: 1, qty: 200, expiresOn: null, at: 0 });
  const taken = takeLots(db, { storeId: 1, ingredientId: 1, qty: 400 });
  assert.deepEqual(taken, [{ qty: 300, expires_on: '2026-10-25' }, { qty: 100, expires_on: '2026-10-30' }]);
  assert.equal(stockQty(db, 1, 1), 600);
  assert.throws(() => takeLots(db, { storeId: 1, ingredientId: 1, qty: 1000, name: 'Sữa' }), /chỉ còn 600/);
});

async function setup() {
  let now = at('2026-10-01', '09:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
        body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    return {
      get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), put: (u, b) => call('PUT', u, b),
      async login(pin) { const r = await call('POST', '/api/login', { pin }); assert.equal(r.status, 200, JSON.stringify(r.data)); },
    };
  };
  return { db, client, setNow: (ms) => { now = ms; }, close: () => new Promise((r) => { app.close(); server.close(r); }) };
}

test('luồng kho: nhập kho, lĩnh hàng, kiểm kho cuối ca, gợi ý đặt hàng, duyệt, nhận hàng', async (t) => {
  const env = await setup();
  t.after(env.close);
  const o = env.client();
  await o.login(DEFAULT_OWNER_PIN);
  const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };

  const meta = ok(await o.get('/api/stock/meta'));
  const main = meta.stores.find((s) => s.kind === 'main');
  const lau = meta.stores.find((s) => s.name === 'Kho Lẩu');
  const teamLau = (await o.get('/api/teams')).data.find((x) => x.name === 'Lẩu').id;

  // NCC của khu Lẩu, nguyên liệu bò thái (tươi, mua theo kg, dùng theo g)
  const ncc = ok(await o.post('/api/stock/suppliers', { name: 'Bò tươi Hưng Phát', phone: '0901234567' })).id;
  ok(await o.patch(`/api/stock/stores/${lau.id}`, { supplier_id: ncc }));
  const bo = ok(await o.post('/api/stock/ingredients', {
    name: 'Bò bắp', unit: 'g', freshness: 'fresh', home_store_id: lau.id, purchase_unit: 'kg', purchase_factor: 1000,
    order_step: 0.5, price: 280000, min_stock: 1000, shelf_days: 2, safety_pct: 10,
  })).id;

  // Tổ trưởng và nhân viên khu Lẩu
  ok(await o.post('/api/staff', { name: 'Dũng', role: 'team_lead', team_id: teamLau, pin: '5823' }));
  ok(await o.post('/api/staff', { name: 'Nga', role: 'staff', team_id: teamLau, pin: '5824' }));
  const dung = env.client(); await dung.login('5823');
  const nga = env.client(); await nga.login('5824');

  // Nhập kho lẻ 20 kg vào kho tổng
  ok(await o.post('/api/stock/receive', { lines: [{ ingredient_id: bo, qty: 20 }] }));
  let ov = ok(await o.get('/api/stock/overview'));
  let row = ov.items.find((x) => x.id === bo);
  assert.equal(row.stock[main.id], 20000);
  assert.equal(row.expiring.length, 0); // hạn 2 ngày, chưa tới ngưỡng cảnh báo 1 ngày

  // 10 ngày: mỗi sáng lĩnh 8 kg, cuối ngày kiểm còn lại → hệ thống ghi lượng dùng
  for (let d = 0; d < 10; d++) {
    const date = addDays('2026-10-01', d);
    env.setNow(at(date, '09:00'));
    const used = new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 7000 : 4000; // thứ Bảy dùng nhiều hơn
    ok(await o.post('/api/stock/receive', { lines: [{ ingredient_id: bo, qty: 8 }] }));
    const tr = ok(await nga.post('/api/stock/transfers', { to_store_id: lau.id, lines: [{ ingredient_id: bo, qty: 8000 }] })).id;
    assert.equal((await nga.post(`/api/stock/transfers/${tr}/send`, {})).status, 403); // nhân viên khu không tự xuất kho tổng
    ok(await o.post(`/api/stock/transfers/${tr}/send`, {}));
    ok(await nga.post(`/api/stock/transfers/${tr}/receive`, {}));
    env.setNow(at(date, '22:30'));
    const have = (await nga.get(`/api/stock/count-sheet?store=${lau.id}`)).data.lines.find((l) => l.ingredient_id === bo).expected;
    const c = ok(await nga.post('/api/stock/count', { store_id: lau.id, lines: [{ ingredient_id: bo, actual: have - used }] }));
    assert.equal(c.lines[0].diff, -used);
  }
  // Nhân viên khu khác không kiểm được kho Lẩu
  const moves = ok(await o.get('/api/stock/moves?from=2026-10-01&to=2026-10-10'));
  assert.equal(moves.filter((m) => m.type === 'consume').length, 10);

  // Ngày 11/10 (CN) tối: mới có 1 thứ Hai trong lịch sử → lấy TB 10 ngày (8 ngày × 4 kg + 2 thứ Bảy × 7 kg) = 4.6 kg
  env.setNow(at('2026-10-11', '22:00'));
  ov = ok(await o.get('/api/stock/overview'));
  row = ov.items.find((x) => x.id === bo);
  assert.equal(row.forecast_tomorrow, 4600);
  assert.equal(row.basis, 'recent');

  // Kiểm kho thực tế: khu Lẩu chỉ còn 0.5 kg, kho tổng hết (hàng quá hạn đã bỏ)
  ok(await nga.post('/api/stock/count', { store_id: lau.id, lines: [{ ingredient_id: bo, actual: 500 }] }));
  assert.equal((await nga.post('/api/stock/count', { store_id: main.id, lines: [{ ingredient_id: bo, actual: 0 }] })).status, 403);
  ok(await o.post('/api/stock/count', { store_id: main.id, lines: [{ ingredient_id: bo, actual: 0 }] }));
  // Gợi ý lĩnh hàng cho khu Lẩu: cần thêm cho mai, kho tổng không đủ → báo sắp hết
  const sug = ok(await nga.get(`/api/stock/suggest-transfer?store=${lau.id}`));
  const need = sug.lines.find((l) => l.ingredient_id === bo);
  assert.ok(need && need.need > 0 && need.short);

  // Đề xuất đặt hàng: tổ trưởng tạo, sửa, gửi; quản lý duyệt; kho tổng nhận
  const gen = ok(await dung.post('/api/stock/po/generate'));
  assert.equal(gen.orders.length, 1);
  const po = gen.orders[0];
  assert.equal(po.supplier_name, 'Bò tươi Hưng Phát');
  assert.equal(po.lines[0].purchase_unit, 'kg');
  ok(await dung.patch(`/api/stock/po/${po.id}`, { lines: [{ ingredient_id: bo, qty: 10 }], note: 'Giao trước 8h' }));
  ok(await dung.post(`/api/stock/po/${po.id}/submit`));
  assert.equal((await dung.post(`/api/stock/po/${po.id}/approve`)).status, 403);
  const approved = ok(await o.post(`/api/stock/po/${po.id}/approve`));
  assert.match(approved.text, /Bò bắp: 10 kg/);
  assert.match(approved.text, /Giao trước 8h/);
  const before = ok(await o.get('/api/stock/overview')).items.find((x) => x.id === bo).stock[main.id];
  ok(await o.post(`/api/stock/po/${po.id}/receive`, { lines: [{ ingredient_id: bo, qty: 9.5, price: 290000 }] }));
  const after = ok(await o.get('/api/stock/overview')).items.find((x) => x.id === bo);
  assert.equal(after.stock[main.id], before + 9500);
  assert.equal(after.price, 290000);

  // Cảnh báo: hàng sắp hết hạn
  env.setNow(at('2026-10-13', '10:00'));
  const al = ok(await o.get('/api/stock/alerts'));
  assert.ok(al.expiring.some((e) => e.name === 'Bò bắp'));

  // Nhận thiếu hàng ghi hao hụt
  env.setNow(at('2026-10-13', '11:00'));
  const tr = ok(await nga.post('/api/stock/transfers', { to_store_id: lau.id, lines: [{ ingredient_id: bo, qty: 1000 }] })).id;
  ok(await o.post(`/api/stock/transfers/${tr}/send`, {}));
  ok(await nga.post(`/api/stock/transfers/${tr}/receive`, { lines: [{ ingredient_id: bo, qty: 900 }] }));
  const w = ok(await o.get('/api/stock/moves?from=2026-10-13&to=2026-10-13')).filter((m) => m.type === 'waste');
  assert.equal(w[0].qty, 100);
});
