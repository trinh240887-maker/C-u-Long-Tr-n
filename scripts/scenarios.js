// Kịch bản bán hàng "tất cả tần tật": mỗi tình huống chạy trên app thật (máy chủ trong máy), ghi Đạt / Lỗi.
// Chạy riêng: node --disable-warning=ExperimentalWarning scripts/scenarios.js
// Bộ test cũng chạy file này (test/pos-scenarios.test.js), lỗi là test đỏ.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_OWNER_PIN } from '../server/db.js';
import { createApp } from '../server/app.js';
import { makeClock } from '../server/lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clock = makeClock({ offset: '+07:00' });
const at = (date, hm) => clock.toEpoch(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)));
const DAY = '2026-10-24'; // Thứ Bảy

export async function run({ quiet = false } = {}) {
  let now = at(DAY, '17:00');
  const db = openDb(':memory:', { now });
  const app = createApp({ db, now: () => now, publicDir: path.join(here, '..', 'public'), photoDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')), zaloTransport: { send: async () => {} } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  const results = [];
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || '' });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
    if (!quiet) { const r = results.at(-1); console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`); }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

  // Người dùng: chủ, trưởng ca, 2 phục vụ, tổ trưởng bếp
  const owner = client();
  await owner('POST', '/api/login', { pin: DEFAULT_OWNER_PIN });
  const teams = (await owner('GET', '/api/teams')).data;
  const team = (n) => teams.find((t) => t.name === n).id;
  const mk = async (name, role, teamName, pin) => {
    await owner('POST', '/api/staff', { name, role, team_id: teamName ? team(teamName) : null, pin });
    const c = client();
    await c('POST', '/api/login', { pin });
    return c;
  };
  const lead = await mk('Long', 'shift_lead', 'Phục vụ', '730194');
  const pv1 = await mk('Hậu', 'staff', 'Phục vụ', '4821');
  const pv2 = await mk('Thương', 'staff', 'Phục vụ', '5932');
  const bep = await mk('Phát', 'team_lead', 'Bếp steak', '6143');
  const menu = (await pv1('GET', '/api/menu')).data;
  const M = (n) => menu.items.find((i) => i.name === n);
  const sot = (n, s = 'Tiêu đen') => M(n).options.find((o) => o.name === s).id;
  const st = Object.fromEntries(menu.stations.map((s) => [s.id, s.name]));
  const tickets = async () => (await owner('GET', '/api/pos/tickets')).data;
  const lastTicket = async () => (await tickets())[0];
  const sess = async (id) => (await pv1('GET', `/api/pos/sessions/${id}`)).data;
  const open = async (c, n) => { const r = await c('POST', '/api/pos/sessions', { tables: [n] }); expect(r.status === 200, `mở bàn ${n}: ${r.data?.error}`); return r.data.id; };
  const add = async (c, sid, name, extra = {}) => {
    const it = M(name);
    const r = await c('POST', `/api/pos/sessions/${sid}/items`, { menu_item_id: it.id, option_ids: it.options.length ? [it.options[0].id] : [], ...extra });
    expect(r.status === 200, `gọi ${name}: ${r.data?.error}`);
    return r.data.id;
  };
  const send = async (c, sid) => { const r = await c('POST', `/api/pos/sessions/${sid}/send`); expect(r.status === 200, `gửi bếp: ${r.data?.error}`); return r.data; };

  // ---- Nhận bàn & gọi món ----
  let A;
  await step('Nhận bàn trống → vào order luôn', async () => { A = await open(pv1, 10); return 'bàn 10'; });
  await step('Hai phục vụ cùng bấm 1 bàn trống một lúc → chỉ 1 người nhận được', async () => {
    const [r1, r2] = await Promise.all([pv1('POST', '/api/pos/sessions', { tables: [11] }), pv2('POST', '/api/pos/sessions', { tables: [11] })]);
    const okN = [r1, r2].filter((r) => r.status === 200).length;
    expect(okN === 1 && [r1, r2].some((r) => r.status === 409), `${okN} người nhận được`);
    const won = [r1, r2].find((r) => r.status === 200).data.id;
    await pv1('POST', `/api/pos/sessions/${won}/cancel`, {});
    return 'người thứ 2 thấy "Bàn 11 đang có khách"';
  });
  await step('Món bắt chọn sốt mà chưa chọn → chặn', async () => {
    const r = await pv1('POST', `/api/pos/sessions/${A}/items`, { menu_item_id: M('Combo 2').id });
    expect(r.status === 400, `status ${r.status}`);
    return r.data.error;
  });
  await step('Gọi Combo 2 ×2 sốt tiêu đen + Set lẩu Mala + Trà đào ×3, gửi bếp → tách đúng máy', async () => {
    await add(pv1, A, 'Combo 2', { option_ids: [sot('Combo 2')], qty: 2, note: 'chín vừa' });
    await add(pv1, A, 'Set 2 Mala Tứ Xuyên');
    await add(pv1, A, 'Trà đào', { qty: 3 });
    const r = await send(pv1, A);
    const names = (await tickets()).slice(0, r.tickets).map((k) => st[k.station_id]).sort();
    expect(JSON.stringify(names) === JSON.stringify(['Bò', 'Nước lẩu', 'Pha chế', 'Steak', 'Topping – Nướng – Rau']), names.join(','));
    return `${r.tickets} phiếu: ${names.join(', ')}`;
  });
  await step('Bấm "Gửi bếp" 2 lần liền (lỡ tay) → không in trùng', async () => {
    const before = (await tickets()).length;
    const r = await pv1('POST', `/api/pos/sessions/${A}/send`);
    expect(r.status === 400 && (await tickets()).length === before, 'in trùng phiếu');
    return 'lần 2 báo "Chưa có món mới để gửi"';
  });
  await step('Khách gọi thêm → phiếu ghi GỌI THÊM, chỉ món mới', async () => {
    await add(pv1, A, 'Nước suối', { qty: 2 });
    await send(pv1, A);
    const k = await lastTicket();
    expect(k.kind === 'add' && k.lines.length === 1 && k.lines[0].name === 'Nước suối', JSON.stringify(k));
    return `${st[k.station_id]}: 2 × Nước suối (GỌI THÊM)`;
  });
  await step('Gọi món GẤP → in máy Ưu tiên', async () => {
    await add(pv1, A, 'Steak Âu', { rush: true });
    await send(pv1, A);
    const k = await lastTicket();
    expect(st[k.station_id] === 'Ưu tiên' && k.priority, st[k.station_id]);
    return 'Steak Âu → máy Ưu tiên';
  });
  await step('Bàn ưu tiên (VIP) → mọi steak ra máy Ưu tiên, nước vẫn ra Pha chế', async () => {
    const V = await open(pv2, 12);
    await pv2('PATCH', `/api/pos/sessions/${V}`, { priority: true });
    await add(pv2, V, 'Combo 1', { option_ids: [sot('Combo 1')] });
    await add(pv2, V, 'Coca');
    const r = await send(pv2, V);
    const ks = (await tickets()).slice(0, r.tickets).map((k) => st[k.station_id]).sort();
    expect(JSON.stringify(ks) === JSON.stringify(['Pha chế', 'Ưu tiên']), ks.join(','));
    return ks.join(' + ');
  });
  await step('Sửa giá món trong Thực đơn khi bàn đang mở → món đã gọi giữ giá cũ', async () => {
    const before = (await sess(A)).subtotal;
    await owner('PATCH', `/api/menu/items/${M('Trà đào').id}`, { price: 30000 });
    const after = (await sess(A)).subtotal;
    await owner('PATCH', `/api/menu/items/${M('Trà đào').id}`, { price: 25000 });
    expect(before === after, `${before} → ${after}`);
    return `tạm tính giữ ${after.toLocaleString('vi-VN')}đ`;
  });

  // ---- Huỷ ----
  await step('Huỷ món chưa gửi bếp → xoá luôn, không in', async () => {
    const before = (await tickets()).length;
    const id = await add(pv1, A, 'Coca');
    const r = await pv1('POST', `/api/pos/items/${id}/cancel`, {});
    expect(r.data?.deleted && (await tickets()).length === before, 'vẫn in phiếu');
    return 'không phiếu';
  });
  await step('Huỷ món đã gửi trong 2 phút (phục vụ tự huỷ) → phiếu HUỶ', async () => {
    const id = await add(pv1, A, 'Sprite');
    await send(pv1, A);
    now += 60_000;
    expect((await pv1('POST', `/api/pos/items/${id}/cancel`)).status === 400, 'không bắt lý do');
    const r = await pv1('POST', `/api/pos/items/${id}/cancel`, { reason: 'Gọi nhầm' });
    const k = await lastTicket();
    expect(r.status === 200 && k.kind === 'cancel', `${r.status} ${k.kind}`);
    return `${st[k.station_id]}: HUỶ Sprite (Gọi nhầm)`;
  });
  await step('Phục vụ huỷ món đã gửi quá 2 phút → bị chặn; trưởng ca huỷ được', async () => {
    const id = (await sess(A)).items.find((i) => i.name === 'Trà đào').id;
    now += 5 * 60_000;
    const r1 = await pv1('POST', `/api/pos/items/${id}/cancel`, { reason: 'Khách đổi ý' });
    const r2 = await lead('POST', `/api/pos/items/${id}/cancel`, { reason: 'Khách đổi ý' });
    expect(r1.status === 403 && r2.status === 200, `${r1.status}/${r2.status}`);
    return r1.data.error;
  });
  await step('Bếp huỷ vì hết nguyên liệu + báo HẾT MÓN → không ai gọi được nữa', async () => {
    const B = await open(pv2, 13);
    const id = await add(pv2, B, 'Bò ướp mala 100g');
    await send(pv2, B);
    now += 3 * 60_000;
    const r = await bep('POST', `/api/pos/items/${id}/cancel`, { reason: 'Hết nguyên liệu', sold_out: true });
    expect(r.status === 200, r.data?.error);
    const again = await pv1('POST', `/api/pos/sessions/${A}/items`, { menu_item_id: M('Bò ướp mala 100g').id });
    expect(again.status === 400, `vẫn gọi được (${again.status})`);
    expect((await pv1('POST', `/api/pos/items/${id}/cancel`, { reason: 'x', sold_out: true })).status !== 200, 'phục vụ báo hết món được');
    await owner('POST', '/api/menu/reset-sold-out');
    return `${again.data.error}; phiếu HUỶ in ra máy Bò`;
  });
  await step('Huỷ cả bàn khi đã gửi món: phục vụ bị chặn, trưởng ca huỷ → phiếu HUỶ mọi món', async () => {
    const C = await open(pv2, 14);
    await add(pv2, C, 'Combo 3', { option_ids: [sot('Combo 3')] });
    await add(pv2, C, 'Trà vải');
    await send(pv2, C);
    const before = (await tickets()).length;
    const r1 = await pv2('POST', `/api/pos/sessions/${C}/cancel`, { reason: 'Khách bỏ về' });
    const r2 = await lead('POST', `/api/pos/sessions/${C}/cancel`, { reason: 'Khách bỏ về' });
    const cancels = (await tickets()).slice(0, (await tickets()).length - before);
    expect(r1.status === 403 && r2.status === 200 && cancels.every((k) => k.kind === 'cancel') && cancels.length === 2, `${r1.status}/${r2.status}/${cancels.length}`);
    return 'Steak + Pha chế nhận phiếu HUỶ; bàn 14 trống lại';
  });
  await step('Nhận nhầm bàn, chưa gọi gì → huỷ bàn, bàn trống lại', async () => {
    const D = await open(pv1, 15);
    const r = await pv1('POST', `/api/pos/sessions/${D}/cancel`, {});
    const t = (await pv1('GET', '/api/pos/tables')).data.zones.flatMap((z) => z.tables).find((x) => x.number === 15);
    expect(r.status === 200 && !t.session, 'bàn vẫn có khách');
    return 'bàn 15 trống';
  });

  // ---- Làm lại, trễ, nhắc bếp ----
  await step('Khách chê → Làm lại: in máy Ưu tiên, không tính thêm tiền', async () => {
    const s0 = await sess(A);
    const id = s0.items.find((i) => i.name === 'Combo 2').id;
    await pv1('POST', `/api/pos/items/${id}/redo`, { reason: 'Khách chê dai' });
    const k = await lastTicket();
    expect(k.kind === 'redo' && st[k.station_id] === 'Ưu tiên' && (await sess(A)).subtotal === s0.subtotal, `${k.kind} ${st[k.station_id]}`);
    return 'LÀM LẠI Combo 2 → Ưu tiên';
  });
  await step('Pha chế ra món trễ (quá 7′) → báo TRỄ ở bàn, sơ đồ bàn và màn Quản lý', async () => {
    const E = await open(pv2, 20);
    await add(pv2, E, 'Cam vắt');
    await send(pv2, E);
    now += 9 * 60_000;
    const s = await sess(E);
    const tbl = (await pv2('GET', '/api/pos/tables')).data.zones.flatMap((z) => z.tables).find((x) => x.number === 20);
    const late = (await lead('GET', '/api/pos/late')).data.find((x) => x.session_id === E);
    expect(s.items[0].late_min === 2 && tbl.session.late === 1 && late?.stations[0] === 'Pha chế', JSON.stringify({ l: s.items[0].late_min, t: tbl.session.late }));
    return `Cam vắt chờ 9′, trễ 2′, sơ đồ bàn 20 có ⏰1`;
  });
  await step('Bếp steak ra món trễ (quá 15′) → nhắc bếp: in phiếu NHẮC ra máy Ưu tiên', async () => {
    const F = await open(pv1, 21);
    const id = await add(pv1, F, 'Combo 1', { option_ids: [sot('Combo 1')] });
    await send(pv1, F);
    now += 10 * 60_000;
    expect(!(await lead('GET', '/api/pos/late')).data.some((x) => x.id === id), '10′ đã báo trễ (ngưỡng steak 15′)');
    now += 8 * 60_000;
    const r = await pv1('POST', `/api/pos/items/${id}/remind`);
    const k = await lastTicket();
    expect(r.status === 200 && k.kind === 'remind' && st[k.station_id] === 'Ưu tiên' && k.lines[0].note === 'Khách chờ 18 phút', `${k.kind} ${st[k.station_id]} ${k.lines[0].note}`);
    const r2 = await pv1('POST', `/api/pos/items/${id}/remind`);
    expect(r2.status === 429, 'nhắc liên tục được');
    return 'NHẮC "Khách chờ 18 phút"; nhắc lại ngay bị chặn (đợi 3′)';
  });
  await step('Bấm "Đã ra" → hết báo trễ', async () => {
    const late = (await lead('GET', '/api/pos/late')).data;
    for (const i of late) await pv1('POST', `/api/pos/items/${i.id}/served`);
    expect(!(await lead('GET', '/api/pos/late')).data.length, 'còn báo trễ');
    return `${late.length} món đã ra`;
  });
  await step('Ngưỡng trễ chỉnh được theo từng máy (Pha chế 7′ → 5′)', async () => {
    const pc = menu.stations.find((s) => s.name === 'Pha chế');
    const r = await owner('PATCH', `/api/kitchen-stations/${pc.id}`, { late_minutes: 5 });
    const G = await open(pv1, 22);
    await add(pv1, G, 'Trà dâu');
    await send(pv1, G);
    now += 6 * 60_000;
    expect(r.status === 200 && (await lead('GET', '/api/pos/late')).data.some((x) => x.session_id === G), 'chưa báo trễ');
    return 'Trà dâu chờ 6′ đã báo trễ';
  });

  // ---- Chuyển, tách, gộp ----
  await step('Chuyển bàn 10 → 30: món & tiền theo sang, không in phiếu', async () => {
    const before = (await tickets()).length;
    const sub = (await sess(A)).subtotal;
    const r = await pv1('POST', `/api/pos/sessions/${A}/move`, { tables: [30] });
    const s = await sess(A);
    expect(r.status === 200 && s.tables[0] === 30 && s.subtotal === sub && (await tickets()).length === before, 'sai');
    return `bàn 30, tạm tính ${sub.toLocaleString('vi-VN')}đ`;
  });
  await step('Chuyển sang bàn đang có khách → chặn (phải dùng Gộp)', async () => {
    const r = await pv1('POST', `/api/pos/sessions/${A}/move`, { tables: [12] });
    expect(r.status === 409, `status ${r.status}`);
    return r.data.error;
  });
  await step('Gọi nhầm 1 món vào bàn này → Chuyển món sang bàn 31 (bàn trống tự nhận)', async () => {
    const s0 = await sess(A);
    const it = s0.items.find((i) => i.name === 'Nước suối');
    const r = await pv1('POST', `/api/pos/items/${it.id}/move`, { table: 31 });
    const to = await sess(r.data.session_id);
    expect(r.status === 200 && to.tables[0] === 31 && to.subtotal === it.total && (await sess(A)).subtotal === s0.subtotal - it.total, 'sai tiền');
    return `${it.qty} × Nước suối sang bàn 31`;
  });
  let S2;
  await step('Tách bàn: 1 trong 2 phần Combo 2 + Set lẩu sang bàn 32 tính riêng', async () => {
    const s0 = await sess(A);
    const c2 = s0.items.find((i) => i.name === 'Combo 2');
    const lau = s0.items.find((i) => i.name.startsWith('Set 2'));
    const r = await pv1('POST', `/api/pos/sessions/${A}/split`, { table: 32, items: [{ id: c2.id, qty: 1 }, { id: lau.id }] });
    expect(r.status === 200, r.data?.error);
    S2 = r.data.session_id;
    const a = await sess(A);
    const b = await sess(S2);
    expect(a.items.find((i) => i.name === 'Combo 2').qty === 1 && b.items.length === 2 && a.subtotal + b.subtotal === s0.subtotal, `${a.subtotal}+${b.subtotal}≠${s0.subtotal}`);
    return `bàn 30: ${a.subtotal.toLocaleString('vi-VN')}đ · bàn 32: ${b.subtotal.toLocaleString('vi-VN')}đ · tổng không đổi`;
  });
  await step('Tách quá số lượng đang có → chặn', async () => {
    const it = (await sess(A)).items.find((i) => i.name === 'Combo 2');
    const r = await pv1('POST', `/api/pos/sessions/${A}/split`, { table: 33, items: [{ id: it.id, qty: 5 }] });
    expect(r.status === 400, `status ${r.status}`);
    return r.data.error;
  });
  await step('Gộp bàn 32 vào bàn 30 → tính chung 1 bill, bàn 32 trống', async () => {
    const a0 = (await sess(A)).subtotal;
    const b0 = (await sess(S2)).subtotal;
    const r = await pv1('POST', `/api/pos/sessions/${A}/merge`, { from_session_id: S2 });
    const a = await sess(A);
    const t32 = (await pv1('GET', '/api/pos/tables')).data.zones.flatMap((z) => z.tables).find((t) => t.number === 32);
    expect(r.status === 200 && a.subtotal === a0 + b0 && a.tables.join(',') === '30' && !t32.session, `${a.subtotal} ${a.tables} ${t32.session?.id}`);
    return `bàn 30: ${a.subtotal.toLocaleString('vi-VN')}đ (cả 2 bill) · bàn 32 trống`;
  });
  await step('Tách hết món sang bàn khác → bàn cũ tự trống', async () => {
    const H = await open(pv2, 40);
    const id = await add(pv2, H, 'Coca');
    const r = await pv2('POST', `/api/pos/sessions/${H}/split`, { table: 41, items: [{ id }] });
    const old = await sess(H);
    expect(r.status === 200 && old.status === 'cancelled', old.status);
    return 'bàn 40 trống, Coca ở bàn 41';
  });

  // ---- Thanh toán ----
  await step('Xin thanh toán khi còn món chưa gửi bếp → chặn', async () => {
    await add(pv1, A, 'Coca');
    const r = await pv1('POST', `/api/pos/sessions/${A}/request-bill`);
    expect(r.status === 400, `status ${r.status}`);
    await send(pv1, A);
    return r.data.error;
  });
  await step('Xin thanh toán → bàn chuyển "chờ thanh toán", quản lý nhận báo', async () => {
    const r = await pv1('POST', `/api/pos/sessions/${A}/request-bill`);
    const t = (await pv1('GET', '/api/pos/tables')).data.zones.flatMap((z) => z.tables).find((x) => x.number === 30);
    const n = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE 'Bàn % xin thanh toán'").get().n;
    expect(r.status === 200 && t.session.status === 'paying' && n > 0, `${r.status} ${t.session.status} ${n}`);
    return `${n} người nhận báo`;
  });

  // ---- Đặt bàn ----
  await step('Đặt bàn trùng giờ, trùng bàn → chặn; khác giờ → được', async () => {
    const a = await lead('POST', '/api/reservations', { name: 'Anh Hùng', phone: '0909123456', guests: 8, date: DAY, time: '20:00', tables: '50-51', priority: true });
    const b = await lead('POST', '/api/reservations', { name: 'Chị Mai', phone: '0911', guests: 4, date: DAY, time: '20:30', tables: '51' });
    const c = await lead('POST', '/api/reservations', { name: 'Chị Mai', phone: '0911', guests: 4, date: DAY, time: '22:30', tables: '51' });
    expect(a.status === 200 && b.status === 409 && c.status === 200, `${a.status}/${b.status}/${c.status}`);
    return b.data.error;
  });
  await step('Phục vụ bấm vào bàn đang giữ cho khách đặt → app biết bàn đã giữ', async () => {
    now = at(DAY, '19:40');
    const t = (await pv1('GET', '/api/pos/tables')).data.zones.flatMap((z) => z.tables).find((x) => x.number === 50);
    expect(t.reservation?.name === 'Anh Hùng', 'không thấy giữ bàn');
    return 'bàn 50: "Đặt 20:00 · Anh Hùng"';
  });
  await step('Bàn có khách đặt sắp tới: nhận vãng lai → cảnh báo + gợi ý bàn khác; trong 15′ trước giờ đặt phải xác nhận', async () => {
    await lead('POST', '/api/reservations', { name: 'Chị Lan', phone: '0912', guests: 4, date: DAY, time: '20:00', tables: '70' });
    const r0 = await pv1('POST', '/api/pos/sessions', { tables: [70] }); // 19:40, còn 20′
    expect(r0.status === 409 && /Bàn trống nên dùng/.test(r0.data?.error), `không cảnh báo: ${r0.status}`);
    const r1 = await pv1('POST', '/api/pos/sessions', { tables: [70], override_soon: true });
    expect(r1.status === 200, `xác nhận rồi vẫn bị chặn: ${r1.data?.error}`);
    await pv1('POST', `/api/pos/sessions/${r1.data.id}/cancel`, {});
    now = at(DAY, '19:46');
    const r2 = await pv1('POST', '/api/pos/sessions', { tables: [70] });
    const r3 = await pv1('POST', '/api/pos/sessions', { tables: [70], override_reserved: true });
    expect(r2.status === 409 && r3.status === 200, `${r2.status}/${r3.status}`);
    await pv1('POST', `/api/pos/sessions/${r3.data.id}/cancel`, {});
    const sm = (await pv1('GET', '/api/pos/tables')).data.summary;
    expect(sm.held >= 1, 'không đếm bàn khoá');
    now = at(DAY, '19:40');
    return r2.data.error;
  });
  await step('Khách đặt đến → mở bàn 50-51, tự đánh dấu ưu tiên', async () => {
    const list = (await lead('GET', `/api/reservations?date=${DAY}`)).data.items;
    const hung = list.find((x) => x.name === 'Anh Hùng');
    const r = await lead('POST', `/api/reservations/${hung.id}/arrive`, {});
    const s = await sess(r.data.session_id);
    expect(r.status === 200 && s.priority && s.tables.join(',') === '50,51', JSON.stringify(s.tables));
    return 'bàn 50,51 ưu tiên';
  });
  await step('Khách không đến → lần sau đặt app cảnh báo đã bỏ đặt', async () => {
    const mai = (await lead('GET', `/api/reservations?date=${DAY}`)).data.items.find((x) => x.name === 'Chị Mai' && x.status === 'booked');
    await lead('PATCH', `/api/reservations/${mai.id}`, { status: 'no_show' });
    const r = await lead('POST', '/api/reservations', { name: 'Chị Mai', phone: '0911', guests: 2, date: '2026-10-25', time: '19:00' });
    expect(r.data.history.no_show === 1, JSON.stringify(r.data.history));
    return 'Khách cũ: bỏ đặt 1 lần';
  });
  await step('Hết bàn → khách vào danh sách chờ → có bàn thì mời vào', async () => {
    const w = await lead('POST', '/api/reservations', { kind: 'walkin', name: 'Áo xanh', guests: 3, date: DAY });
    const r = await lead('POST', `/api/reservations/${w.data.id}/arrive`, { tables: '60' });
    expect(w.status === 200 && r.status === 200, `${w.status}/${r.status}`);
    return 'Áo xanh vào bàn 60';
  });

  // ---- Tổng kết sổ sách ----
  await step('Nhật ký ghi lại mọi lần huỷ / chuyển / tách / gộp (ai, lúc nào, lý do)', async () => {
    const acts = db.prepare("SELECT action, COUNT(*) AS n FROM audit_log WHERE action LIKE 'pos.%' GROUP BY action").all();
    const got = Object.fromEntries(acts.map((a) => [a.action, a.n]));
    for (const k of ['pos.item.cancel', 'pos.session.cancel', 'pos.move', 'pos.item.move', 'pos.split', 'pos.merge', 'pos.item.redo', 'pos.item.remind']) expect(got[k], `thiếu ${k}`);
    return acts.map((a) => `${a.action.replace('pos.', '')} ${a.n}`).join(', ');
  });

  app.close();
  await new Promise((r) => server.close(r));
  return results;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const res = await run();
  const bad = res.filter((r) => !r.ok);
  console.log(`\n${res.length - bad.length}/${res.length} tình huống đạt`);
  process.exit(bad.length ? 1 : 0);
}
