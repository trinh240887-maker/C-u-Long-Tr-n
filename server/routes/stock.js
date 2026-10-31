import { fail, v } from '../http.js';
import { tx, rank } from '../db.js';
import { addDays, isDate } from '../lib/time.js';
import { makeXlsx } from '../lib/xlsx.js';
import { forecastDay, areaNeed, purchaseNeed, toPurchaseUnits, r3 } from '../lib/forecast.js';
import { stockQty, addLot, takeLots, setActual, recordMove, costOf, assertOpen } from '../lib/stock.js';

const FRESHNESS = ['fresh', 'chilled', 'dry'];
const FRESH_LABEL = { fresh: 'Đồ tươi', chilled: 'Đồ mát', dry: 'Đồ khô/đông' };

export default function (r, ctx) {
  const { db } = ctx;
  const today = () => ctx.today();
  const num = (value, name, { min = 0, max = 1e9 } = {}) => {
    const n = Number(String(value ?? '').replace(',', '.'));
    if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n < min || n > max) fail(400, `${name} không hợp lệ`);
    return r3(n);
  };

  // ---------- Dữ liệu nền ----------
  const stores = () => db.prepare(`SELECT s.*, t.name AS team_name, p.name AS supplier_name FROM stores s
    LEFT JOIN teams t ON t.id = s.team_id LEFT JOIN suppliers p ON p.id = s.supplier_id WHERE s.active = 1 ORDER BY s.sort, s.id`).all();
  const storeById = (id) => db.prepare('SELECT * FROM stores WHERE id = ? AND active = 1').get(id);
  const mainStore = () => db.prepare("SELECT * FROM stores WHERE kind = 'main' AND active = 1 ORDER BY id LIMIT 1").get();
  // Chế độ 1 kho (chủ quán 24/10): mọi nhập / bán / cân kiểm tính vào Kho tổng.
  //  - Hàng có định lượng: bán tự trừ Kho tổng. Xuất kho cho khu chỉ để ghi (không trừ thêm).
  //  - Hàng không có định lượng (gas, đá, khăn giấy…): trừ Kho tổng mỗi lần xuất kho.
  const single = () => ctx.setting('single_store') === '1';
  const hasRecipe = (id) => !!db.prepare('SELECT 1 FROM menu_recipes WHERE ingredient_id = ? LIMIT 1').get(id);
  ctx.singleStore = single;
  ctx.effectiveStore = (id) => (single() ? mainStore()?.id ?? id : id);

  // ---------- 3 loại hàng + kho chung (chủ quán 28/10) ----------
  // Thành phẩm: mua về bán nguyên (bia, nước ngọt…), lệch là mất · Vật liệu: chế biến món theo định lượng (cả ly nhựa, ống hút có trong định lượng)
  // Đồ dùng: không nằm trong định lượng (ga, khăn giấy…), kiểm mỗi tuần. kind '' = app tự xếp
  const addColI = (c, d) => { if (!db.prepare('PRAGMA table_info(ingredients)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE ingredients ADD COLUMN ${c} ${d}`); };
  addColI('kind', "TEXT NOT NULL DEFAULT ''");   // '' | finished | material | supply
  addColI('loss_pct', 'REAL');                    // định mức hao hụt riêng (%), trống = theo mặc định
  const FIN_RE = /(^|\s)(bia|heineken|heniken|tiger|sài gòn|saigon|333|larue|budweiser|coca|pepsi|sprite|fanta|7 ?up|sting|red ?bull|bò húc|nước suối|aquafina|lavie|dasani|c2|number ?1|revive|nước ngọt|nước tăng lực|soda|schweppes|trà xanh 0)/i;
  const SUP_RE = /(^|\s)(ga|gas|bình ga|khăn|giấy|túi|bao rác|bao tay|găng|nước rửa|xà phòng|xà bông|nước lau|bột giặt|nước tẩy|chổi|cây lau|màng bọc|giấy bạc|than|cồn|đũa|muỗng|tăm|ống hút|ly nhựa|ly giấy|hộp|nắp ly|băng keo|pin|bóng đèn|bao bì)/i;
  const KIND_LABEL = { finished: 'Thành phẩm', material: 'Vật liệu', supply: 'Tiêu hao' }; // chủ quán 28/10: ga, khăn giấy, túi… = Tiêu hao (đồ dùng = chén dĩa, không tiêu hao)
  // Kiểm kho mỗi tối chia 4 khung (chủ quán 28/10); count_group '' = app tự xếp theo khu chính cũ / loại hàng
  addColI('count_group', "TEXT NOT NULL DEFAULT ''");
  const GROUP_LABEL = { topping: 'Topping', bep: 'Bếp', bar: 'Bar & pha chế', tieuhao: 'Tiêu hao' };
  const storeName = (id) => (id ? db.prepare('SELECT name FROM stores WHERE id = ?').get(id)?.name || '' : '');
  // Khung theo điểm chế biến của các món dùng nguyên liệu (chủ quán 28/10: kho Lẩu đã gộp nên không dựa kho khu được nữa)
  // Lẩu / Bò / Topping – Nướng – Rau → Topping · Steak / Ưu tiên → Bếp · Pha chế / Bar → Bar. Nhớ 3 giây (đủ cho 1 lần mở phiếu kiểm).
  let stationVote = { at: 0, map: new Map() };
  const groupByStation = (ingId) => {
    if (Date.now() - stationVote.at > 3_000) {
      const map = new Map();
      for (const r of db.prepare('SELECT r.ingredient_id AS id, k.name AS st FROM menu_recipes r JOIN menu_items m ON m.id = r.item_id JOIN kitchen_stations k ON k.id = m.station_id WHERE m.active = 1').all()) {
        const g = /pha chế|pha che|bar/i.test(r.st) ? 'bar' : /lẩu|lau|bò|topping|nướng|rau/i.test(r.st) ? 'topping' : /steak|ưu tiên|bếp/i.test(r.st) ? 'bep' : null;
        if (!g) continue;
        const v = map.get(r.id) || {}; v[g] = (v[g] || 0) + 1; map.set(r.id, v);
      }
      stationVote = { at: Date.now(), map };
    }
    const v = stationVote.map.get(ingId);
    return v ? Object.entries(v).sort((a, b) => b[1] - a[1])[0][0] : null;
  };
  const ingGroupOf = (i) => {
    if (GROUP_LABEL[i.count_group]) return i.count_group;
    if (ingKindOf(i) === 'supply') return 'tieuhao';
    const bySt = groupByStation(i.id);
    if (bySt) return bySt;
    const sn = storeName(i.home_store_id);
    if (/lẩu|lau/i.test(sn)) return 'topping';
    if (/bar/i.test(sn) || ingKindOf(i) === 'finished') return 'bar';
    return 'bep';
  };
  // Rau củ (chủ quán 28/10: chỉ rau củ mới tính "đã dùng trong ngày" khi kiểm tối)
  const VEG_RE = /(^|\s)(rau|củ|cải|hành|hẹ|ngò|mùi|giá|nấm|cà chua|cà rốt|cà tím|chanh|ớt|tỏi|gừng|sả|riềng|xà lách|xà lách|bắp cải|bắp chuối|bắp non|khoai|dưa leo|dưa chuột|bí|mướp|đậu bắp|đậu que|đậu đũa|măng|me|tắc|quất|thơm|dứa|húng|tía tô|kinh giới|lá|bông|ngó|su su|su hào|củ cải|rau muống|cần|tần ô|mồng tơi|cải thảo)(?=\s|$|[,.()/-])/i;
  // rà soát 28/10: hết từ mới khớp ("bí" ≠ "bít tết", "me" ≠ "Men bia"); đồ đã chế biến (sốt, hành phi, ớt bột…) không phải rau củ
  const NOT_VEG_RE = /^(sốt|tương|bột|hành phi|tỏi phi|nước sốt|dầu|giăm bông)|(^|\s)(phi|bột|sấy)(?=\s|$|[,.()/-])/i;
  const isVeg = (i) => { const n = String(i.name || '').normalize('NFC').trim(); return VEG_RE.test(` ${n}`) && !NOT_VEG_RE.test(n) && ingKindOf(i) !== 'finished' && ingKindOf(i) !== 'supply'; };
  ctx.isVegName = (name) => isVeg({ name, kind: 'material' });
  const groupStaff = () => { try { return JSON.parse(ctx.setting('count_group_staff') || '{}') || {}; } catch { return {}; } };
  const myGroups = (me) => Object.keys(GROUP_LABEL).filter((g) => (groupStaff()[g] || []).includes(me.id));
  ctx.ingCountGroup = (i) => ingGroupOf(i);
  function autoKind(ingId, name) {
    const uses = db.prepare('SELECT r.item_id, r.qty, (SELECT COUNT(*) FROM menu_recipes x WHERE x.item_id = r.item_id) AS n FROM menu_recipes r WHERE r.ingredient_id = ?').all(ingId);
    if (FIN_RE.test(` ${name}`)) return 'finished';
    if (uses.length && uses.every((u) => u.n === 1 && Math.abs(u.qty - 1) < 1e-9)) return 'finished'; // món = đúng 1 cái của hàng này
    if (uses.length) return 'material';
    // Chưa có trong định lượng: chỉ hàng rõ là đồ dùng mới xếp Đồ dùng; nguyên liệu chưa nhập định lượng vẫn là Vật liệu
    return SUP_RE.test(` ${name}`) ? 'supply' : 'material';
  }
  const ingKindOf = (i) => (['finished', 'material', 'supply'].includes(i.kind) ? i.kind : autoKind(i.id, i.name));
  ctx.ingKind = ingKindOf;

  // ---------- Nhóm kho theo LOẠI HÀNG (chủ quán 30/10) ----------
  // Hàng dùng chung (bò cho cả steak lẫn lẩu) xếp theo loại hàng; ai dùng thì xem "Dùng cho". Danh sách nhóm sửa được (setting ing_cats)
  const CATS_DEFAULT = [['bo_nk', 'Bò nhập khẩu'], ['bo_tuoi', 'Bò tươi'], ['thit', 'Thịt khác & hải sản'], ['steak', 'Nguyên liệu steak'], ['lau', 'Nguyên liệu lẩu'],
    ['topping', 'Topping lẩu'], ['nuong', 'Nguyên liệu xiên nướng'], ['rau', 'Rau củ'], ['phache', 'Nguyên liệu pha chế'], ['douong', 'Đồ uống đóng chai'], ['kho', 'Gia vị & đồ khô chung'], ['dodung', 'Đồ dùng / vật tư']]
    .map(([key, label]) => ({ key, label }));
  if (!db.prepare('PRAGMA table_info(ingredients)').all().some((c) => c.name === 'cat')) db.exec('ALTER TABLE ingredients ADD COLUMN cat TEXT');
  const cats = () => { try { const x = JSON.parse(ctx.setting('ing_cats') || 'null'); if (Array.isArray(x) && x.length) return x; } catch { /* mặc định */ } return CATS_DEFAULT; };
  const BO_NK_RE = /(aukobe|wagyu|kobe|angus|ribeye|striploin|tomahawk|t-bone|tenderloin|(bò|bo)\s.*(mỹ|úc|nhật|nhập|canada|new zealand|nz))/i;
  const BO_RE = /(^|\s)(bò|gầu|gù|nạm|thăn|đùi bò|bắp bò|lõi|nạc vai|diềm)(?=\s|$|[,.()/-])/i;
  const THIT_RE = /(^|\s)(heo|lợn|gà|vịt|ngan|tôm|mực|cá|ngao|nghêu|sò|hàu|ốc|cua|ghẹ|sườn|ba rọi|chân giò|xương|mỡ|lòng|dồi|xúc xích|thịt)(?=\s|$|[,.()/-])/i;
  const TOPPING_RE = /(viên|đậu hũ|đậu phụ|tàu hũ|tàu hủ|váng đậu|mì|miến|bún|phở|hủ tiếu|há cảo|sủi cảo|chả|phô mai|trứng|bánh|khoai môn|nấm kim|nấm)/i;
  const DRINK_RE = /(bia|heineken|tiger|sài gòn|saigon|333|larue|budweiser|coca|pepsi|7 ?up|sprite|fanta|sting|redbull|red bull|nước suối|nước ngọt|soju|rượu|vang|trà xanh 0|c2|number one|aquafina|lavie|nước ép đóng|\slon\s|\slon$|chai \d+ ?ml)/i;
  const PHACHE_RE = /(cà phê|cafe|coffee|trà|syrup|siro|sữa|kem béo|whipping|bột pha|đá viên|chanh dây|matcha|cacao|topping trà)/i;
  const SUPPLY_RE = /(ly nhựa|ống hút|nắp ly|túi |túi$|que xiên|vật tư|hộp xốp|khăn|giấy|găng|màng bọc|bao tay|than |gas)/i;
  const LAU_RE = /(ngăn nước lẩu|cốt lẩu|nước lẩu|nước dùng|chén nước chấm|nước chấm)/i;
  const NUONG_RE = /(xiên|sốt ướp|bột rắc|bột chấm|dầu quét)/i;
  const autoCat = (i) => {
    const n = ` ${String(i.name || '').normalize('NFC')}`;
    if (ingKindOf(i) === 'supply' || SUPPLY_RE.test(n)) return 'dodung';
    if (BO_NK_RE.test(n)) return 'bo_nk';
    if (LAU_RE.test(n)) return 'lau';
    if (NUONG_RE.test(n)) return 'nuong';
    if (BO_RE.test(n) && !/viên/i.test(n)) return 'bo_tuoi';
    if (DRINK_RE.test(n) && !/vật tư/i.test(n)) return 'douong';
    const st = groupByStation(i.id);
    if (st === 'bar' || /siro|syrup|sirup/i.test(n)) return 'phache';
    if (isVeg(i) || /bắp mỹ|bắp ngọt|bắp hoa/i.test(n)) return 'rau';
    if (THIT_RE.test(n) && !/viên|chả/i.test(n)) return 'thit';
    if (PHACHE_RE.test(n) && !st) return 'phache';
    if (st === 'topping') return TOPPING_RE.test(n) ? 'topping' : 'lau';
    if (st === 'bep') return 'steak';
    if (TOPPING_RE.test(n)) return 'topping';
    return 'kho';
  };
  const ingCatOf = (i) => (i.cat && cats().some((c) => c.key === i.cat) ? i.cat : autoCat(i));
  ctx.ingCat = ingCatOf;
  r.put('/api/stock/cats', 'manager', ({ me, body }) => {
    const list = (Array.isArray(body.cats) ? body.cats : []).slice(0, 40).map((c, k) => ({ key: String(c.key || '').trim().slice(0, 20) || `nhom${Date.now().toString(36)}${k}`, label: v.text(c.label, { name: 'Tên nhóm', required: true, max: 40 }) }));
    if (!list.length) fail(400, 'Cần ít nhất 1 nhóm');
    if (new Set(list.map((c) => c.key)).size !== list.length) fail(400, 'Mã nhóm trùng');
    ctx.setSetting('ing_cats', JSON.stringify(list));
    ctx.audit(me, 'stock.cats', list.map((c) => c.label).join(', '));
    ctx.broadcast('stock');
    return { ok: true, cats: list };
  });
  // Đổi nhóm 1 hoặc nhiều nguyên liệu (cat = null → app tự xếp)
  r.post('/api/stock/ingredients/cat', 'manager', ({ me, body }) => {
    const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 500);
    const cat = body.cat ? String(body.cat) : null;
    if (cat && !cats().some((c) => c.key === cat)) fail(400, 'Nhóm không tồn tại');
    const n = ids.reduce((k, id) => k + db.prepare('UPDATE ingredients SET cat = ? WHERE id = ?').run(cat, id).changes, 0);
    ctx.audit(me, 'ingredient.cat', { ids, cat });
    ctx.broadcast('stock');
    return { ok: true, n };
  });
  ctx.lossPct = (i) => (i.loss_pct != null ? i.loss_pct : ingKindOf(i) === 'finished' ? 0 : Number(ctx.setting('loss_pct_default') || 2));
  // Gộp 1 kho chung (chủ quán 28/10: bỏ chia khu, bỏ xin lĩnh): chuyển hàng các kho khu về Kho tổng, bật chế độ 1 kho
  if (!ctx.setting('kho_chung_v1') && ctx.setting('wh_live') !== '1') {
    const main = mainStore();
    const inUse = !!db.prepare('SELECT 1 FROM stock_moves LIMIT 1').get(); // DB đang dùng thật (DB mới / thử nghiệm giữ nguyên nhiều kho)
    if (main && inUse) {
      tx(db, () => {
        const at = ctx.now(), date = today();
        for (const x of db.prepare('SELECT store_id, ingredient_id, SUM(qty) AS q FROM stock_lots WHERE store_id != ? GROUP BY store_id, ingredient_id').all(main.id)) {
          if (Math.abs(x.q) > 1e-9) recordMove(db, { at, date, type: 'transfer', ingredientId: x.ingredient_id, fromStore: x.store_id, toStore: main.id, qty: x.q, ref: 'kho_chung', note: 'Gộp về kho chung (28/10)' });
        }
        db.prepare('UPDATE stock_lots SET store_id = ? WHERE store_id != ?').run(main.id, main.id);
      });
      ctx.setSetting('single_store', '1');
    }
    ctx.setSetting('kho_chung_v1', '1');
  }
  const ingredients = ({ all = false } = {}) => db.prepare(`SELECT i.*, hs.name AS home_name, hs.supplier_id AS home_supplier_id,
      COALESCE(i.supplier_id, hs.supplier_id) AS eff_supplier_id, p.name AS supplier_name
    FROM ingredients i LEFT JOIN stores hs ON hs.id = i.home_store_id
    LEFT JOIN suppliers p ON p.id = COALESCE(i.supplier_id, hs.supplier_id)
    ${all ? '' : 'WHERE i.active = 1'} ORDER BY COALESCE(hs.sort, 99), i.name`).all();
  const ingById = (id) => db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);

  const holderId = () => Number(ctx.setting('kho_tong_staff_id') || 0);
  const isHolder = (me) => me.id === holderId() || rank(me.role) >= rank('shift_lead');
  // Kho chung: ai trước đây nhận / kiểm kho khu (Bếp, Bar…) giờ nhận / kiểm kho chung
  const canStore = (me, st) => rank(me.role) >= rank('shift_lead') || (st.kind === 'main' ? isHolder(me) || (single() && (rank(me.role) >= rank('team_lead') || !!db.prepare('SELECT 1 FROM stores WHERE active = 1 AND team_id = ? LIMIT 1').get(me.team_id || -1))) : st.team_id && st.team_id === me.team_id);
  const isLeadOf = (me, st) => rank(me.role) >= rank('shift_lead') || (me.role === 'team_lead' && st.team_id && st.team_id === me.team_id);
  const holderTargets = () => (holderId() ? [holderId(), ...ctx.managers()] : ctx.managers());
  const leadsOfStore = (st) => ctx.leadsOf(st.team_id);

  // Lượng dùng thực tế theo ngày (từ kiểm kho cuối ca, sau này thêm từ bán hàng)
  function usageMaps(days = 35) {
    const rows = db.prepare(`SELECT ingredient_id, from_store, date, SUM(qty) AS q FROM stock_moves
      WHERE type = 'consume' AND date >= ? GROUP BY ingredient_id, from_store, date`).all(addDays(today(), -days));
    const total = new Map();
    const perStore = new Map();
    for (const x of rows) {
      const t = total.get(x.ingredient_id) || new Map();
      t.set(x.date, r3((t.get(x.date) || 0) + x.q));
      total.set(x.ingredient_id, t);
      const k = `${x.from_store}:${x.ingredient_id}`;
      const p = perStore.get(k) || new Map();
      p.set(x.date, r3((p.get(x.date) || 0) + x.q));
      perStore.set(k, p);
    }
    return { total, perStore };
  }

  function stockMap() {
    const m = new Map();
    for (const x of db.prepare('SELECT store_id, ingredient_id, SUM(qty) AS q FROM stock_lots GROUP BY store_id, ingredient_id').all()) {
      m.set(`${x.store_id}:${x.ingredient_id}`, r3(x.q));
    }
    return m;
  }

  // ---------- Tổng quan tồn kho ----------
  const usedForMap = () => {
    const use = new Map();
    for (const x of db.prepare('SELECT DISTINCT r.ingredient_id, m.name FROM menu_recipes r JOIN menu_items m ON m.id = r.item_id WHERE m.active = 1 ORDER BY m.name').all()) use.set(x.ingredient_id, [...(use.get(x.ingredient_id) || []), x.name]);
    return use;
  };
  ctx.usedForMap = usedForMap;
  function overview() {
    const t = today();
    const tomorrow = addDays(t, 1);
    const warnTo = addDays(t, Number(ctx.setting('expiry_warn_days') || 1));
    const sts = stores();
    const stock = stockMap();
    const usage = usageMaps();
    const lots = db.prepare('SELECT store_id, ingredient_id, qty, expires_on FROM stock_lots WHERE expires_on IS NOT NULL AND expires_on <= ? ORDER BY expires_on').all(warnTo);
    const use = usedForMap();
    const items = ingredients().map((i) => {
      const per = Object.fromEntries(sts.map((s) => [s.id, stock.get(`${s.id}:${i.id}`) || 0]));
      const total = r3(Object.values(per).reduce((a, b) => a + b, 0));
      const exp = lots.filter((l) => l.ingredient_id === i.id).map((l) => ({ ...l, expired: l.expires_on < t }));
      const expired = r3(exp.filter((e) => e.expired).reduce((a, e) => a + e.qty, 0));
      const f = forecastDay(usage.total.get(i.id) || new Map(), tomorrow);
      const available = r3(total - expired);
      let status = 'ok';
      if (available <= 1e-9) status = 'out';
      else if (available < i.min_stock || available < f.qty) status = 'low';
      return {
        id: i.id, name: i.name, unit: i.unit, freshness: i.freshness, freshness_label: FRESH_LABEL[i.freshness],
        home_store_id: i.home_store_id, home_name: i.home_name || 'Kho chung', supplier_id: i.eff_supplier_id, supplier_name: i.supplier_name || '',
        purchase_unit: i.purchase_unit, purchase_factor: i.purchase_factor, price: i.price, min_stock: i.min_stock,
        stock: per, total, available, expiring: exp, forecast_tomorrow: f.qty, avg_daily: f.avg, basis: f.basis,
        days_left: f.avg > 0 ? r3(available / f.avg) : null, status, used_for: use.get(i.id) || [], cat: ingCatOf(i),
      };
    });
    return { today: t, tomorrow, stores: sts, items, cats: cats() };
  }

  r.get('/api/stock/overview', 'staff', () => overview());

  r.get('/api/stock/meta', 'staff', ({ me }) => {
    const sts = stores();
    return {
      stores: sts.map((s) => ({ ...s, can_count: !!canStore(me, s) || (single() && s.kind === 'main' && myGroups(me).length > 0), is_lead: !!isLeadOf(me, s) })),
      suppliers: db.prepare('SELECT * FROM suppliers ORDER BY active DESC, name').all(),
      // "Dùng cho" (chủ quán 30/10): nguyên liệu này nằm trong định lượng món nào → hiện lúc nhập hàng / tồn kho
      ingredients: (() => {
        const use = usedForMap();
        return ingredients({ all: rank(me.role) >= rank('manager') }).map((i) => ({ ...i, kind_eff: ingKindOf(i), kind_auto: !i.kind, group_eff: ingGroupOf(i), group_auto: !GROUP_LABEL[i.count_group], used_for: use.get(i.id) || [], cat_eff: ingCatOf(i), cat_auto: !i.cat || !cats().some((c) => c.key === i.cat) }));
      })(),
      groups: GROUP_LABEL, group_staff: groupStaff(), my_groups: myGroups(me), cats: cats(),
      staff_names: Object.fromEntries([...new Set(Object.values(groupStaff()).flat())].map((id) => [id, db.prepare('SELECT name FROM staff WHERE id = ?').get(id)?.name || ''])),
      is_holder: isHolder(me),
      holder_id: holderId() || null,
      freshness: FRESH_LABEL,
      single: single(), kinds: KIND_LABEL, loss_default: Number(ctx.setting('loss_pct_default') || 2), supply_dow: Number(ctx.setting('supply_count_dow') || 1),
    };
  });

  // ---------- Báo cáo Nhập – Xuất – Tồn chung (cả quán), chia Đồ tươi / Đồ bình thường ----------
  // Tồn đầu + Nhập − Bán theo định lượng − Xuất dùng (hàng không định lượng) − Huỷ ± Lệch kiểm = Tồn cuối.
  // Tồn sổ = tồn cuối nếu không cân kiểm; Lệch = cân thực tế − sổ (âm = thiếu). Số theo đơn vị dùng (g, ml, cái…).
  const kindOf = (m) => {
    // Huỷ / sửa phiếu nhập (trừ lại hoặc cộng thêm hàng) → cột riêng, cột Nhập chỉ còn hàng nhập thật (chủ quán 30/10)
    if (m.type === 'receive') return /^(void-bill|fix-bill):/.test(m.ref || '') ? 'dcnhap' : 'nhap';
    if (m.type === 'consume') return /^sale:/.test(m.ref) ? 'ban' : 'xuat';
    // rà soát 28/10: bù "kiểm kho trước khi úp Sapo" (recount:) và huỷ bù đó (cancel:recount:) bù vào cột Lệch (kiểm đã ghi thiếu cả phần bán) → không thổi phồng Nhập / Huỷ
    if (m.type === 'adjust') return /^cancel:/.test(m.ref) ? 'ban' : /^(count|recount):/.test(m.ref) ? 'lech' : 'nhap';
    if (m.type === 'waste') return /^Lệch định lượng/.test(m.note) || /^cancel:recount:/.test(m.ref || '') ? 'lech' : 'huy';
    return null; // chuyển kho trong quán: không đổi tồn chung
  };
  const sign = (m) => (m.type === 'receive' || m.type === 'adjust' ? 1 : m.type === 'transfer' ? 0 : -1);
  function nxt(from, to) {
    const ings = db.prepare('SELECT * FROM ingredients ORDER BY name').all();
    const nowQty = new Map(db.prepare('SELECT ingredient_id, SUM(qty) AS q FROM stock_lots GROUP BY ingredient_id').all().map((x) => [x.ingredient_id, x.q]));
    const after = new Map(db.prepare("SELECT ingredient_id, SUM(CASE WHEN type IN ('receive','adjust') THEN qty WHEN type = 'transfer' THEN 0 ELSE -qty END) AS n FROM stock_moves WHERE date > ? GROUP BY ingredient_id").all(to).map((x) => [x.ingredient_id, x.n]));
    const moves = db.prepare('SELECT * FROM stock_moves WHERE date BETWEEN ? AND ? ORDER BY at').all(from, to);
    const tol = Number(ctx.setting('count_tolerance_pct') || 3);
    const rows = new Map();
    for (const g of ings) rows.set(g.id, { id: g.id, name: g.name, unit: g.unit, group: ingCatOf(g), nhap: 0, dcnhap: 0, ban: 0, xuat: 0, huy: 0, lech: 0, lech_tien: 0, nhap_tien: 0, recipe: hasRecipe(g.id), active: !!g.active, ing: g });
    for (const m of moves) {
      const r = rows.get(m.ingredient_id); const k = kindOf(m);
      if (!r || !k) continue;
      const q = m.qty * sign(m);
      if (k === 'nhap') { r.nhap += q; r.nhap_tien += m.type === 'receive' ? m.cost : 0; }
      else if (k === 'dcnhap') { r.dcnhap += q; r.nhap_tien += m.cost || 0; }
      else if (k === 'ban') r.ban -= q;
      else if (k === 'xuat') r.xuat -= q;
      else if (k === 'huy') r.huy -= q;
      else { r.lech += q; r.lech_tien += q < 0 ? -(m.cost || costOf(r.ing, -q)) : costOf(r.ing, q); }
    }
    const out = [];
    for (const r of rows.values()) {
      const cuoi = r3((nowQty.get(r.id) || 0) - (after.get(r.id) || 0));
      const dau = r3(cuoi - r.nhap - r.dcnhap + r.ban + r.xuat + r.huy - r.lech);
      if (!r.active && !dau && !cuoi && !r.nhap && !r.dcnhap && !r.ban && !r.xuat) continue;
      if (!dau && !cuoi && !r.nhap && !r.dcnhap && !r.ban && !r.xuat && !r.huy && !r.lech) continue;
      const dung = r.ban + r.xuat;
      const pct = dung > 0 ? Math.round((r.lech / dung) * 1000) / 10 : null;
      const { ing, ...rest } = r;
      out.push({ ...rest, dau, cuoi, so: r3(cuoi - r.lech), nhap: r3(r.nhap), dcnhap: r3(r.dcnhap), ban: r3(r.ban), xuat: r3(r.xuat), huy: r3(r.huy), lech: r3(r.lech), lech_pct: pct, over: pct != null && Math.abs(pct) > tol, gia_tri_cuoi: costOf(ing, Math.max(0, cuoi)) });
    }
    const sortRows = (a, b) => Number(b.over) - Number(a.over) || Math.abs(b.lech_tien) - Math.abs(a.lech_tien) || a.name.localeCompare(b.name);
    const group = (k) => out.filter((x) => x.group === k).sort(sortRows);
    const sum = (list) => ({ nhap_tien: list.reduce((n, x) => n + x.nhap_tien, 0), lech_tien: list.reduce((n, x) => n + x.lech_tien, 0), gia_tri_cuoi: list.reduce((n, x) => n + x.gia_tri_cuoi, 0), over: list.filter((x) => x.over).length });
    // Chia theo nhóm kho (loại hàng), nhóm không có phát sinh thì ẩn
    const gs = cats().map((c) => ({ key: c.key, name: c.label, rows: group(c.key) })).filter((g) => g.rows.length).map((g) => ({ ...g, total: sum(g.rows) }));
    // Lệch theo tiền (thiếu nhiều tiền nhất lên đầu) — chỗ cần kiểm tra trước (lộ trình NXT bước 3)
    const top = out.filter((x) => x.lech_tien < 0).sort((a, b) => a.lech_tien - b.lech_tien).slice(0, 10).map((x) => ({ id: x.id, name: x.name, unit: x.unit, lech: x.lech, lech_pct: x.lech_pct, lech_tien: x.lech_tien, group: x.group }));
    return { from, to, tolerance: tol, groups: gs, top, lech_thieu: out.filter((x) => x.lech_tien < 0).reduce((n, x) => n + x.lech_tien, 0), lech_thua: out.filter((x) => x.lech_tien > 0).reduce((n, x) => n + x.lech_tien, 0),
      lock_until: ctx.setting('stock_lock_until') || null };
  }
  // 🔒 Khoá sổ kho (chủ quán): mọi phát sinh / xoá phát sinh có ngày ≤ ngày khoá bị chặn; khoá thì lưu lại bảng NXT tháng đó
  db.exec('CREATE TABLE IF NOT EXISTS stock_month_close (month TEXT PRIMARY KEY, until TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL, staff_id INTEGER)');
  r.put('/api/stock/lock', 'owner', ({ me, body }) => {
    const until = body.until ? String(body.until) : null;
    if (until && (!isDate(until) || until >= today())) fail(400, 'Chỉ khoá được đến hôm qua trở về trước');
    if (until) {
      const month = until.slice(0, 7);
      const snap = nxt(`${month}-01`, until);
      db.prepare('INSERT OR REPLACE INTO stock_month_close (month, until, data, at, staff_id) VALUES (?, ?, ?, ?, ?)').run(month, until, JSON.stringify(snap), ctx.now(), me.id);
    }
    ctx.setSetting('stock_lock_until', until || '');
    ctx.audit(me, until ? 'stock.lock' : 'stock.unlock', { until });
    ctx.broadcast('stock');
    return { ok: true, lock_until: until };
  });
  r.get('/api/stock/month-close', 'manager', () => db.prepare('SELECT month, until, at FROM stock_month_close ORDER BY month DESC').all());
  const nxtRange = (query) => {
    const to = query.get('to') || today();
    const from = query.get('from') || to;
    if (!isDate(from) || !isDate(to) || from > to) fail(400, 'Khoảng ngày không hợp lệ');
    return [from, to];
  };
  r.get('/api/stock/nxt', 'manager', ({ query }) => nxt(...nxtRange(query)));
  r.get('/api/stock/nxt/:id', 'manager', ({ params, query }) => {
    const [from, to] = nxtRange(query);
    return db.prepare(`SELECT m.*, s.name AS staff_name FROM stock_moves m LEFT JOIN staff s ON s.id = m.staff_id WHERE m.ingredient_id = ? AND m.date BETWEEN ? AND ? AND m.type != 'transfer' ORDER BY m.at`).all(Number(params.id), from, to)
      .map((m) => ({ at: m.at, date: m.date, kind: kindOf(m), qty: r3(m.qty * sign(m)), cost: m.cost, note: m.note, staff_name: m.staff_name }));
  });
  r.get('/api/stock/nxt.xlsx', 'manager', ({ me, query }) => {
    const x = nxt(...nxtRange(query));
    const head = ['Nguyên liệu', 'Đơn vị', 'Tồn đầu', 'Nhập', 'Huỷ/sửa phiếu nhập', 'Bán theo định lượng', 'Xuất dùng', 'Huỷ', 'Tồn sổ', 'Tồn thực tế', 'Lệch', 'Lệch %', 'Tiền lệch', 'Giá trị tồn'];
    const sheets = x.groups.map((g) => ({ name: g.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), rows: [head, ...g.rows.map((r) => [r.name, r.unit, r.dau, r.nhap, r.dcnhap, r.ban, r.xuat, r.huy, r.so, r.cuoi, r.lech, r.lech_pct ?? '', r.lech_tien, r.gia_tri_cuoi]), ['Tổng', '', '', '', '', '', '', '', '', '', '', '', g.total.lech_tien, g.total.gia_tri_cuoi]] }));
    ctx.audit(me, 'stock.nxt.xlsx', `${x.from}..${x.to}`);
    return { __binary: makeXlsx(sheets), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `nhap-xuat-ton_${x.from}_${x.to}.xlsx` };
  });

  r.get('/api/stock/alerts', 'staff', () => {
    const o = overview();
    const pick = (st) => o.items.filter((x) => x.status === st).map((x) => ({ id: x.id, name: x.name, available: x.available, unit: x.unit, forecast: x.forecast_tomorrow }));
    const count = (sql) => db.prepare(sql).get().n;
    return {
      out: pick('out'), low: pick('low'),
      expiring: o.items.flatMap((x) => x.expiring.map((e) => ({ name: x.name, unit: x.unit, ...e, store: o.stores.find((s) => s.id === e.store_id)?.name || '' }))),
      po_submitted: count("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'submitted'"),
      po_approved: count("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'approved'"),
      po_draft: count("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'draft'"),
      transfers_requested: count("SELECT COUNT(*) AS n FROM transfers WHERE status = 'requested'"),
      transfers_sent: count("SELECT COUNT(*) AS n FROM transfers WHERE status = 'sent'"),
    };
  });

  // ---------- Nhà cung cấp, kho, nguyên liệu (quản lý) ----------
  r.post('/api/stock/suppliers', 'manager', ({ me, body }) => {
    const id = Number(db.prepare('INSERT INTO suppliers (name, phone, note) VALUES (?, ?, ?)').run(
      v.text(body.name, { name: 'Tên NCC', required: true, max: 300 }), v.text(body.phone, { name: 'Số điện thoại', max: 30 }), v.text(body.note, { name: 'Ghi chú', max: 300 }),
    ).lastInsertRowid);
    ctx.audit(me, 'supplier.create', body.name);
    ctx.broadcast('stock');
    return { id };
  });

  r.patch('/api/stock/suppliers/:id', 'manager', ({ me, params, body }) => {
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(params.id);
    if (!s) fail(404, 'Không tìm thấy NCC');
    db.prepare('UPDATE suppliers SET name = ?, phone = ?, note = ?, active = ? WHERE id = ?').run(
      body.name === undefined ? s.name : v.text(body.name, { name: 'Tên NCC', required: true, max: 300 }),
      body.phone === undefined ? s.phone : v.text(body.phone, { name: 'Số điện thoại', max: 30 }),
      body.note === undefined ? s.note : v.text(body.note, { name: 'Ghi chú', max: 300 }),
      body.active === undefined ? s.active : v.bool(body.active), s.id,
    );
    ctx.audit(me, 'supplier.update', s.id);
    ctx.broadcast('stock');
    return { ok: true };
  });

  r.patch('/api/stock/stores/:id', 'manager', ({ me, params, body }) => {
    const s = storeById(params.id);
    if (!s) fail(404, 'Không tìm thấy kho');
    const supplier = body.supplier_id === undefined ? s.supplier_id : v.optInt(body.supplier_id, { min: 1, name: 'NCC' });
    if (supplier && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplier)) fail(400, 'NCC không tồn tại');
    const team = body.team_id === undefined ? s.team_id : v.optInt(body.team_id, { min: 1, name: 'Tổ' });
    db.prepare('UPDATE stores SET name = ?, supplier_id = ?, team_id = ? WHERE id = ?').run(
      body.name === undefined ? s.name : v.text(body.name, { name: 'Tên kho', required: true, max: 60 }), supplier, s.kind === 'main' ? null : team, s.id,
    );
    ctx.audit(me, 'store.update', s.id);
    ctx.broadcast('stock');
    return { ok: true };
  });

  function ingFields(body, cur = {}) {
    const pick = (k, fn) => (body[k] === undefined ? cur[k] : fn(body[k]));
    const f = {
      name: pick('name', (x) => v.text(x, { name: 'Tên nguyên liệu', required: true, max: 80 })),
      unit: pick('unit', (x) => v.text(x, { name: 'Đơn vị dùng', required: true, max: 12 })),
      freshness: pick('freshness', (x) => v.oneOf(x, FRESHNESS, { name: 'Nhóm hàng' })) ?? 'dry',
      home_store_id: pick('home_store_id', (x) => v.optInt(x, { min: 1, name: 'Khu chính' })) ?? null,
      supplier_id: pick('supplier_id', (x) => v.optInt(x, { min: 1, name: 'NCC' })) ?? null,
      purchase_unit: pick('purchase_unit', (x) => v.text(x, { name: 'Đơn vị mua', max: 12 })) ?? '',
      purchase_factor: pick('purchase_factor', (x) => num(x, 'Quy đổi', { min: 0.001 })) ?? 1,
      order_step: pick('order_step', (x) => num(x, 'Bước làm tròn', { min: 0.001 })) ?? 1,
      price: pick('price', (x) => v.int(x, { min: 0, max: 1e9, name: 'Giá nhập' })) ?? 0,
      min_stock: pick('min_stock', (x) => num(x, 'Tồn tối thiểu')) ?? 0,
      shelf_days: pick('shelf_days', (x) => v.int(x, { min: 0, max: 3650, name: 'Hạn dùng' })) ?? 0,
      lead_days: pick('lead_days', (x) => v.int(x, { min: 0, max: 60, name: 'Số ngày giao' })) ?? 1,
      cycle_days: pick('cycle_days', (x) => v.int(x, { min: 1, max: 90, name: 'Chu kỳ đặt' })) ?? 1,
      safety_pct: pick('safety_pct', (x) => v.int(x, { min: 0, max: 200, name: 'Dự phòng' })) ?? 10,
      active: body.active === undefined ? (cur.active ?? 1) : v.bool(body.active),
    };
    if (!f.name || !f.unit) fail(400, 'Thiếu tên hoặc đơn vị');
    if (f.home_store_id && !storeById(f.home_store_id)) fail(400, 'Khu chính không tồn tại');
    if (f.supplier_id && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(f.supplier_id)) fail(400, 'NCC không tồn tại');
    if (!f.purchase_unit) { f.purchase_unit = f.unit; f.purchase_factor = 1; }
    return f;
  }
  const ING_COLS = ['name', 'unit', 'freshness', 'home_store_id', 'supplier_id', 'purchase_unit', 'purchase_factor', 'order_step', 'price', 'min_stock', 'shelf_days', 'lead_days', 'cycle_days', 'safety_pct', 'active'];

  r.post('/api/stock/ingredients', 'manager', ({ me, body }) => {
    const f = ingFields(body);
    const id = Number(db.prepare(`INSERT INTO ingredients (${ING_COLS.join(', ')}) VALUES (${ING_COLS.map(() => '?').join(', ')})`).run(...ING_COLS.map((k) => f[k])).lastInsertRowid);
    ctx.audit(me, 'ingredient.create', f.name);
    ctx.broadcast('stock');
    return { id };
  });

  // Nguyên liệu không cần quy đổi (chủ quán 30/10: gạo theo bao, nước mắm theo chai… dùng nguyên đơn vị) + ghi chú lý do
  if (!db.prepare('PRAGMA table_info(ingredients)').all().some((c) => c.name === 'conv_ok')) {
    db.exec("ALTER TABLE ingredients ADD COLUMN conv_ok INTEGER NOT NULL DEFAULT 0; ALTER TABLE ingredients ADD COLUMN conv_note TEXT NOT NULL DEFAULT ''");
  }
  ctx.ingConvOk = (me, id, body) => { const cur = ingById(id); if (!cur) fail(404, 'Không tìm thấy nguyên liệu'); const ok = v.bool(body.ok) ? 1 : 0;
    db.prepare('UPDATE ingredients SET conv_ok = ?, conv_note = ? WHERE id = ?').run(ok, ok ? v.text(body.note || '', { name: 'Ghi chú', max: 120 }) : '', cur.id);
    ctx.audit(me, 'ingredient.conv_ok', { id: cur.id, ok, note: body.note || '' }); ctx.broadcast('stock'); return { ok: true }; };
  ctx.ingConvSet = (me, id, body0) => { const cur = ingById(id); if (!cur) fail(404, 'Không tìm thấy nguyên liệu');
    const body = { ...cur, unit: body0.unit ?? cur.unit, purchase_unit: body0.purchase_unit ?? cur.purchase_unit, purchase_factor: body0.purchase_factor ?? cur.purchase_factor };
    const f = ingFields(body, cur);
    db.prepare(`UPDATE ingredients SET ${ING_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...ING_COLS.map((k) => f[k]), cur.id);
    ctx.audit(me, 'ingredient.conv', { id: cur.id, unit: f.unit, purchase_unit: f.purchase_unit, purchase_factor: f.purchase_factor }); ctx.broadcast('stock'); return { ok: true }; };
  r.post('/api/stock/ingredients/:id/conv-ok', 'staff', ({ me, params, body }) => {
    if (rank(me.role) < rank('manager') && !(rank(me.role) >= rank('shift_lead') || db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id || -1))) fail(403, 'Chỉ thu ngân, quản lý, chủ quán');
    const cur = ingById(params.id);
    if (!cur) fail(404, 'Không tìm thấy nguyên liệu');
    const ok = v.bool(body.ok) ? 1 : 0;
    db.prepare('UPDATE ingredients SET conv_ok = ?, conv_note = ? WHERE id = ?').run(ok, ok ? v.text(body.note || '', { name: 'Ghi chú', max: 120 }) : '', cur.id);
    ctx.audit(me, 'ingredient.conv_ok', { id: cur.id, ok, note: body.note || '' });
    ctx.broadcast('stock');
    return { ok: true };
  });
  // Thu ngân (chủ quán 31/10): chỉ sửa quy đổi (đơn vị dùng, đơn vị mua, 1 đơn vị mua = bao nhiêu); thông tin khác quản lý / chủ
  const cashierOf = (me) => rank(me.role) >= rank('shift_lead') || !!db.prepare("SELECT 1 FROM teams WHERE id = ? AND name = 'Thu ngân'").get(me.team_id || -1);
  r.patch('/api/stock/ingredients/:id', 'staff', ({ me, params, body: body0 }) => {
    const cur = ingById(params.id);
    if (!cur) fail(404, 'Không tìm thấy nguyên liệu');
    let body = body0;
    if (rank(me.role) < rank('manager')) {
      if (!cashierOf(me)) fail(403, 'Chỉ quản lý / chủ quán sửa nguyên liệu');
      body = { ...cur, unit: body0.unit ?? cur.unit, purchase_unit: body0.purchase_unit ?? cur.purchase_unit, purchase_factor: body0.purchase_factor ?? cur.purchase_factor };
    }
    const f = ingFields(body, cur);
    db.prepare(`UPDATE ingredients SET ${ING_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...ING_COLS.map((k) => f[k]), cur.id);
    ctx.audit(me, 'ingredient.update', { id: cur.id, name: f.name });
    ctx.broadcast('stock');
    return { ok: true };
  });

  // ---------- Kiểm kho ----------
  function sheetFor(st) {
    const all = ingredients();
    if (st.kind === 'main') return all;
    const used = new Set(db.prepare('SELECT DISTINCT ingredient_id AS id FROM stock_moves WHERE to_store = ? OR from_store = ?').all(st.id, st.id).map((x) => x.id));
    for (const x of db.prepare('SELECT DISTINCT ingredient_id AS id FROM stock_lots WHERE store_id = ?').all(st.id)) used.add(x.id);
    return all.filter((i) => i.home_store_id === st.id || (i.home_store_id === null && used.has(i.id)) || used.has(i.id));
  }

  // ---------- Báo cáo hao hụt (chủ quán 28/10, định mức mặc định 2%) ----------
  // Chuẩn = lượng bán theo định lượng (sale:…) · Hụt = thiếu khi kiểm kho − thừa khi kiểm − phần bù do úp Sapo sau khi kiểm
  // Thành phẩm: định mức 0 (thiếu là mất) · Vật liệu: so định mức % · Đồ dùng: phần "hụt" khi kiểm = đã dùng
  function lossReport(from, to) {
    const rows = db.prepare(`WITH cx AS MATERIALIZED (SELECT DISTINCT type, ingredient_id, ref FROM stock_moves WHERE ref LIKE 'cancel:%')
      SELECT ingredient_id,
        SUM(CASE WHEN type = 'consume' AND ref LIKE 'sale:%' AND NOT EXISTS (SELECT 1 FROM cx c WHERE c.type = 'adjust' AND c.ref = 'cancel:' || substr(m.ref, 6) AND c.ingredient_id = m.ingredient_id) THEN qty ELSE 0 END) AS std,
        SUM(CASE WHEN type = 'waste' AND ref LIKE 'count:%' THEN qty ELSE 0 END) AS short,
        SUM(CASE WHEN type = 'adjust' AND ref LIKE 'count:%' THEN qty ELSE 0 END) AS surplus,
        SUM(CASE WHEN type = 'adjust' AND ref LIKE 'recount:%' AND NOT EXISTS (SELECT 1 FROM cx c WHERE c.type = 'waste' AND c.ref = 'cancel:' || m.ref AND c.ingredient_id = m.ingredient_id) THEN qty ELSE 0 END) AS recount,
        SUM(CASE WHEN type = 'receive' THEN qty ELSE 0 END) AS received
      FROM stock_moves m WHERE date BETWEEN ? AND ? GROUP BY ingredient_id`).all(from, to); // rà soát 28/10: bỏ dòng bán / bù đã huỷ (bỏ nhập Sapo)
    // Chuẩn lấy từ lượng dùng theo định lượng của món đã bán (đủ số, không phụ thuộc kho trên sổ còn hay hết)
    let stdBy = new Map();
    try { stdBy = new Map(db.prepare('SELECT ingredient_id, SUM(qty) AS q FROM sale_usage WHERE date BETWEEN ? AND ? GROUP BY ingredient_id').all(from, to).map((x) => [x.ingredient_id, x.q])); } catch { /* chưa có bảng */ }
    for (const [id, q] of stdBy) { const r = rows.find((x) => x.ingredient_id === id); if (r) r.std = q; else rows.push({ ingredient_id: id, std: q, short: 0, surplus: 0, recount: 0, received: 0 }); }
    const counted = new Set(db.prepare('SELECT DISTINCT l.ingredient_id AS id FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id WHERE c.date BETWEEN ? AND ?').all(from, to).map((x) => x.id));
    const out = [];
    for (const r of rows) {
      const g = ingById(r.ingredient_id);
      if (!g) continue;
      const kind = ingKindOf(g);
      const loss = r3(r.short - r.surplus - r.recount);
      const pct = r.std > 0 ? Math.round((loss / r.std) * 1000) / 10 : null;
      const limit = ctx.lossPct(g);
      const over = counted.has(g.id) && (kind === 'finished' ? loss > 1e-9 : kind === 'material' ? (r.std > 0 ? pct > limit : loss > 1e-9) : false);
      if (!counted.has(g.id) && !(r.std > 0)) continue;
      out.push({ ingredient_id: g.id, name: g.name, unit: g.unit, kind, std: r3(r.std), loss, pct, limit, over, counted: counted.has(g.id), cost: Math.round(costOf(g, Math.abs(loss))) * Math.sign(loss) });
    }
    out.sort((a, b) => Number(b.over) - Number(a.over) || b.cost - a.cost);
    const sum = (k) => out.filter((x) => x.kind === k && x.loss > 0).reduce((a, x) => a + x.cost, 0);
    return { from, to, rows: out, total: { finished: sum('finished'), material: sum('material'), supply: sum('supply') }, loss_default: Number(ctx.setting('loss_pct_default') || 2), sapo_days: db.prepare("SELECT date FROM sapo_imports WHERE date BETWEEN ? AND ?").all(from, to).map((x) => x.date) };
  }
  ctx.lossReport = lossReport;
  r.get('/api/stock/loss', 'manager', ({ query }) => {
    const to = query.get('to') || addDays(today(), -1), from = query.get('from') || to;
    if (!isDate(from) || !isDate(to)) fail(400, 'Ngày không hợp lệ');
    return lossReport(from, to);
  });
  // 10:30 sáng: báo chủ quán / quản lý hàng hụt vượt định mức của hôm qua (sau khi đã úp Sapo + kiểm kho), 1 lần / ngày
  ctx.lossAlertTick = () => {
    const c = ctx.clock(), n = ctx.now(), d0 = today();
    if (c.minuteOf(n) < 10 * 60 + 30 || ctx.setting(`loss_alert:${d0}`)) return;
    ctx.setSetting(`loss_alert:${d0}`, '1');
    const y = addDays(d0, -1);
    const rep = lossReport(y, y);
    const over = rep.rows.filter((x) => x.over);
    if (!over.length) return;
    const fmt = (x) => `${Math.round(x).toLocaleString('vi-VN')}đ`;
    ctx.notify(ctx.managers(), { title: `📉 Hao hụt vượt định mức ${y.slice(8)}/${y.slice(5, 7)}: ${over.length} món hàng`,
      body: over.slice(0, 8).map((x) => `• ${x.name}: hụt ${x.loss} ${x.unit}${x.pct != null ? ` = ${x.pct}% (định mức ${x.limit}%)` : ''} ≈ ${fmt(x.cost)}`).join('\n'), link: '/kho?tab=hh', urgent: true });
  };

  // Xếp loại hàng (Thành phẩm / Vật liệu / Đồ dùng) và định mức hao hụt riêng
  r.put('/api/stock/ingredients/:id/kind', 'manager', ({ me, params, body }) => {
    const g = ingById(params.id);
    if (!g) fail(404, 'Không tìm thấy nguyên liệu');
    const kind = body.kind === undefined ? g.kind : v.oneOf(body.kind || '', ['', 'finished', 'material', 'supply'], { name: 'Loại hàng' });
    const loss = body.loss_pct === undefined ? g.loss_pct : (body.loss_pct === '' || body.loss_pct === null ? null : num(body.loss_pct, 'Định mức hao hụt', { max: 100 }));
    const grp = body.count_group === undefined ? g.count_group : v.oneOf(body.count_group || '', ['', ...Object.keys(GROUP_LABEL)], { name: 'Khung kiểm' });
    db.prepare('UPDATE ingredients SET kind = ?, loss_pct = ?, count_group = ? WHERE id = ?').run(kind, loss, grp, g.id);
    ctx.audit(me, 'ingredient.kind', { id: g.id, kind, loss });
    ctx.broadcast('stock');
    return { ok: true, kind_eff: ingKindOf({ ...g, kind }) };
  });
  // Chọn nhân sự kiểm từng khung (chủ quán 28/10)
  r.put('/api/stock/count-groups/staff', 'manager', ({ me, body }) => {
    const g = v.oneOf(body.group, Object.keys(GROUP_LABEL), { name: 'Khung kiểm' });
    const ids = (Array.isArray(body.staff_ids) ? body.staff_ids : []).map(Number).filter((x) => db.prepare('SELECT 1 FROM staff WHERE id = ? AND active = 1').get(x));
    const m = groupStaff(); m[g] = [...new Set(ids)];
    ctx.setSetting('count_group_staff', JSON.stringify(m));
    ctx.audit(me, 'stock.count_group_staff', { group: g, ids: m[g] });
    ctx.broadcast('stock');
    return { ok: true, group_staff: m };
  });

  r.get('/api/stock/count-sheet', 'staff', ({ me, query }) => {
    const st = storeById(Number(query.get('store')));
    if (!st) fail(404, 'Không tìm thấy kho');
    const last = db.prepare('SELECT c.*, s.name AS staff_name FROM stock_counts c LEFT JOIN staff s ON s.id = c.staff_id WHERE c.store_id = ? ORDER BY c.at DESC LIMIT 1').get(st.id);
    return {
      store: st, can_count: !!canStore(me, st), last_count: last || null,
      // Đầu ngày = số đếm lần kiểm gần nhất trước hôm nay; Nhập = hàng nhập hôm nay → dùng trong ngày = đầu + nhập − còn (chủ quán 28/10)
      // rà soát 28/10: Nhập = mọi lần nhập SAU lần kiểm làm "đầu ngày" (có thể vài hôm trước); bill huỷ (dòng âm) tự trừ ra
      lines: sheetFor(st).map((i) => {
        const open = db.prepare('SELECT l.actual, c.at FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id WHERE l.ingredient_id = ? AND c.date < ? ORDER BY c.at DESC LIMIT 1').get(i.id, today());
        const dayIn = open ? db.prepare("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE ingredient_id = ? AND at > ? AND type = 'receive'").get(i.id, open.at).q
          : db.prepare("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE ingredient_id = ? AND date = ? AND type = 'receive'").get(i.id, today()).q;
        return { ingredient_id: i.id, name: i.name, unit: i.unit, freshness: i.freshness, kind: ingKindOf(i), group: ingGroupOf(i), veg: isVeg(i), expected: stockQty(db, st.id, i.id), day_open: open?.actual ?? null, day_in: dayIn };
      }),
      shared: ingredients().filter((i) => i.home_store_id === null).map((i) => ({ ingredient_id: i.id, name: i.name, unit: i.unit })),
    };
  });

  // Gợi ý khu lĩnh thêm từ kho tổng cho ngày mai
  function transferSuggestion(st) {
    const main = mainStore();
    const usage = usageMaps();
    const tomorrow = addDays(today(), 1);
    return sheetFor(st).map((i) => {
      const f = forecastDay(usage.perStore.get(`${st.id}:${i.id}`) || new Map(), tomorrow);
      const have = stockQty(db, st.id, i.id);
      const need = areaNeed({ forecast: f.qty, safetyPct: i.safety_pct, stock: have });
      const inMain = main ? stockQty(db, main.id, i.id) : 0;
      return { ingredient_id: i.id, name: i.name, unit: i.unit, forecast: f.qty, basis: f.basis, have, need, main_stock: inMain, short: need > inMain + 1e-9 };
    }).filter((x) => x.need > 0);
  }

  r.get('/api/stock/suggest-transfer', 'staff', ({ query }) => {
    const st = storeById(Number(query.get('store')));
    if (!st || st.kind !== 'area') fail(404, 'Chọn kho của khu');
    return { store: st, lines: transferSuggestion(st) };
  });

  // Kiểm kho (dùng chung cho màn Kiểm kho và việc "cân tồn" trong checklist)
  function doCount(me, st, lines, note = '') {
    if (single()) st = mainStore() || st;
    const usageMode = st.kind === 'area' && ctx.setting('area_count_is_usage') === '1';
    const t = ctx.now();
    const date = today();
    const result = tx(db, () => {
      const countId = Number(db.prepare('INSERT INTO stock_counts (store_id, date, staff_id, at, note) VALUES (?, ?, ?, ?, ?)')
        .run(st.id, date, me.id, t, note).lastInsertRowid);
      const out = [];
      for (const l of lines) {
        const ing = ingById(v.int(l.ingredient_id, { min: 1, name: 'Nguyên liệu' }));
        if (!ing) fail(404, 'Không tìm thấy nguyên liệu');
        const actual = num(l.actual, `Số thực tế của ${ing.name}`);
        const { before, diff } = setActual(db, { storeId: st.id, ingredientId: ing.id, actual, at: t });
        db.prepare('INSERT INTO stock_count_lines (count_id, ingredient_id, expected, actual) VALUES (?, ?, ?, ?)').run(countId, ing.id, before, actual);
        // Nguyên liệu có định lượng và đang bật bán tự trừ kho: lượng dùng đã trừ khi bán → phần thiếu khi kiểm = lệch định lượng / hao hụt
        const sold = ctx.setting('sell_deducts_stock') !== '0' && !!db.prepare('SELECT 1 FROM menu_recipes WHERE ingredient_id = ? LIMIT 1').get(ing.id);
        const asUse = usageMode && !sold;
        if (diff < 0) {
          recordMove(db, { at: t, date, type: asUse ? 'consume' : 'waste', ingredientId: ing.id, fromStore: st.id, qty: -diff, cost: costOf(ing, -diff), ref: `count:${countId}`, staffId: me.id, note: asUse ? 'Dùng trong ngày (kiểm kho cuối ca)' : sold ? 'Lệch định lượng: kiểm kho thiếu so với số đã bán' : 'Hao hụt khi kiểm kho' });
        } else if (diff > 0) {
          recordMove(db, { at: t, date, type: 'adjust', ingredientId: ing.id, toStore: st.id, qty: diff, ref: `count:${countId}`, staffId: me.id, note: 'Kiểm kho thừa so với sổ' });
        }
        out.push({ ingredient_id: ing.id, name: ing.name, unit: ing.unit, before, actual, diff, lech_cost: diff < 0 && sold ? costOf(ing, -diff) : 0 });
      }
      return { countId, out };
    });
    // Lệch so với định lượng đã bán quá ngưỡng (mặc định 200.000đ / lần kiểm) → báo chủ + quản lý (chủ quán 25/10)
    const lech = result.out.filter((x) => x.lech_cost > 0).sort((a, b) => b.lech_cost - a.lech_cost);
    const lechTotal = lech.reduce((a, x) => a + x.lech_cost, 0);
    const limit = Number(ctx.setting('stock_diff_alert_vnd') || 200000);
    if (lech.length && lechTotal >= limit && !/^Checklist:/.test(note)) { // checklist cân tồn tự báo theo % riêng
      const fmt = (n) => `${Math.round(n).toLocaleString('vi-VN')}đ`;
      ctx.notify(ctx.managers().filter((x) => x !== me.id), {
        title: `⚠ Lệch kho ${st.name}: −${fmt(lechTotal)}`,
        body: `${me.name || "Người kiểm"} kiểm lúc ${ctx.clock().fmt(t)}. Thiếu so với số đã bán theo định lượng:\n${lech.slice(0, 6).map((x) => `• ${x.name}: −${Math.round(-x.diff * 1000) / 1000} ${x.unit} ≈ ${fmt(x.lech_cost)}`).join('\n')}`,
        link: '/kho?tab=ls', urgent: true,
      });
    }
    const suggestion = st.kind === 'area' ? transferSuggestion(st) : [];
    const short = suggestion.filter((x) => x.short);
    if (short.length) {
      ctx.notify([...leadsOfStore(st), ...holderTargets()].filter((x) => x !== me.id), {
        title: `Sắp hết ở ${st.name}`,
        body: short.map((x) => `• ${x.name}: cần ${x.need} ${x.unit}, kho tổng còn ${x.main_stock}`).join('\n'),
        link: '/kho', urgent: true,
      });
    }
    ctx.audit(me, 'stock.count', { store: st.id, count: result.countId, lines: result.out.length });
    ctx.broadcast('stock');
    return { count_id: result.countId, lines: result.out, suggestion, lech_total: lechTotal };
  }
  // Cuối ngày (mặc định 22:30) khu nào có bán theo định lượng mà chưa kiểm hôm nay → nhắc tổ trưởng / trưởng ca 1 lần
  ctx.stockCountRemindTick = () => {
    const c = ctx.clock(), n = ctx.now();
    const at = ctx.setting('stock_count_remind_time') || '22:30';
    const [h, m] = at.split(':').map(Number);
    if (c.minuteOf(n) < h * 60 + (m || 0)) return;
    const date = today();
    // Khung có người được chọn kiểm mà hôm nay chưa kiểm → nhắc đúng người đó (1 lần / ngày / khung)
    try {
      if (single()) {
        const gs = groupStaff();
        const counted = new Set(db.prepare('SELECT DISTINCT l.ingredient_id AS id FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id WHERE c.date = ?').all(date).map((x) => x.id));
        for (const g of Object.keys(GROUP_LABEL)) {
          const ids = gs[g] || [];
          if (!ids.length || ctx.setting(`count_remind:${date}:g:${g}`)) continue;
          ctx.setSetting(`count_remind:${date}:g:${g}`, '1');
          const items = ingredients().filter((i) => ingGroupOf(i) === g);
          if (items.length && !items.some((i) => counted.has(i.id))) ctx.notify(ids, { title: `Chưa kiểm kho khung ${GROUP_LABEL[g]}`, body: 'Đếm hàng còn lại rồi nhập ở Kho → Kiểm kho.', link: '/kho?tab=kiem', urgent: true });
        }
      }
    } catch { /* không chặn nhắc theo kho */ }
    const stores = single() ? [mainStore()].filter(Boolean)
      : db.prepare(`SELECT * FROM stores WHERE active = 1 AND kind = 'area' AND id IN (SELECT DISTINCT COALESCE(i.home_store_id, -1) FROM menu_recipes r JOIN ingredients i ON i.id = r.ingredient_id)`).all();
    for (const st of stores) {
      const key = `count_remind:${date}:${st.id}`;
      if (ctx.setting(key)) continue;
      ctx.setSetting(key, '1');
      if (db.prepare('SELECT 1 FROM stock_counts WHERE store_id = ? AND date = ?').get(st.id, date)) continue;
      ctx.notify(leadsOfStore(st), { title: `Chưa kiểm nguyên liệu cuối ngày: ${st.name}`, body: 'Cân / đếm nguyên liệu còn lại rồi nhập ở Kho → Kiểm kho (hoặc checklist Đóng ca).', link: '/kho?tab=kiem', urgent: true });
    }
  };
  ctx.stockCount = (me, storeId, lines, note) => { const st = storeById(ctx.effectiveStore(storeId)); if (!st) fail(404, 'Không tìm thấy kho'); return doCount(me, st, lines, note); };
  // Huỷ một lần kiểm (nhân viên sửa lại số cân): trả tồn về như chưa kiểm, xoá ghi nhận lệch
  ctx.undoCount = (countId) => {
    const c = db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(countId);
    if (!c) return;
    assertOpen(db, c.date);
    tx(db, () => {
      for (const l of db.prepare('SELECT * FROM stock_count_lines WHERE count_id = ?').all(countId)) {
        setActual(db, { storeId: c.store_id, ingredientId: l.ingredient_id, actual: Math.max(0, stockQty(db, c.store_id, l.ingredient_id) + (l.expected - l.actual)), at: ctx.now() });
      }
      db.prepare('DELETE FROM stock_moves WHERE ref = ?').run(`count:${countId}`);
      db.prepare('DELETE FROM stock_count_lines WHERE count_id = ?').run(countId);
      db.prepare('DELETE FROM stock_counts WHERE id = ?').run(countId);
    });
  };

  r.post('/api/stock/count', 'staff', ({ me, body }) => {
    const st = storeById(v.int(body.store_id, { min: 1, name: 'Kho' }));
    if (!st) fail(404, 'Không tìm thấy kho');
    const lines = Array.isArray(body.lines) ? body.lines.filter((l) => l.actual !== '' && l.actual !== null && l.actual !== undefined) : [];
    if (!canStore(me, st)) {
      // Người được chọn kiểm khung: chỉ kiểm hàng thuộc khung của mình
      const mg = single() ? myGroups(me) : [];
      if (!mg.length || lines.some((l) => { const g0 = ingById(Number(l.ingredient_id)); return !g0 || !mg.includes(ingGroupOf(g0)); })) fail(403, 'Bạn không kiểm được kho / khung này');
    }
    if (!lines.length) fail(400, 'Nhập số thực tế cho ít nhất một nguyên liệu');
    return doCount(me, st, lines, v.text(body.note, { name: 'Ghi chú', max: 300 }));
  });

  // ---------- Phiếu lĩnh hàng (kho tổng → khu) ----------
  function loadTransfer(id) {
    const t = db.prepare(`SELECT t.*, fs.name AS from_name, ts.name AS to_name, ts.team_id AS to_team, c.name AS created_by_name, sb.name AS sent_by_name, rb.name AS received_by_name
      FROM transfers t JOIN stores fs ON fs.id = t.from_store JOIN stores ts ON ts.id = t.to_store
      LEFT JOIN staff c ON c.id = t.created_by LEFT JOIN staff sb ON sb.id = t.sent_by LEFT JOIN staff rb ON rb.id = t.received_by WHERE t.id = ?`).get(id);
    if (!t) fail(404, 'Không tìm thấy phiếu lĩnh');
    t.lines = db.prepare(`SELECT l.*, i.name, i.unit FROM transfer_lines l JOIN ingredients i ON i.id = l.ingredient_id WHERE l.transfer_id = ? ORDER BY i.name`).all(id)
      .map((l) => ({ ...l, from_stock: stockQty(db, t.from_store, l.ingredient_id) }));
    return t;
  }

  r.get('/api/stock/transfers', 'staff', ({ query }) => {
    const status = query.get('status');
    const ids = db.prepare(`SELECT id FROM transfers ${status ? 'WHERE status = ?' : ''} ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END, id DESC LIMIT 100`)
      .all(...(status ? [status] : []));
    return ids.map((x) => loadTransfer(x.id));
  });

  const readLines = (lines, key = 'qty') => {
    if (!Array.isArray(lines) || !lines.length) fail(400, 'Phiếu cần ít nhất một dòng');
    const seen = new Set();
    return lines.map((l) => {
      const id = v.int(l.ingredient_id, { min: 1, name: 'Nguyên liệu' });
      if (seen.has(id)) fail(400, 'Một nguyên liệu bị nhập 2 lần');
      seen.add(id);
      const ing = ingById(id);
      if (!ing) fail(404, 'Không tìm thấy nguyên liệu');
      return { ing, qty: num(l[key] ?? l.qty, `Số lượng ${ing.name}`), raw: l };
    });
  };

  r.post('/api/stock/transfers', 'staff', ({ me, body }) => {
    const to = storeById(v.int(body.to_store_id, { min: 1, name: 'Kho nhận' }));
    if (!to || to.kind !== 'area') fail(400, 'Chọn kho của khu');
    if (!canStore(me, to)) fail(403, 'Bạn chỉ xin lĩnh hàng cho khu của mình');
    const main = mainStore();
    const lines = readLines(body.lines).filter((l) => l.qty > 0);
    if (!lines.length) fail(400, 'Nhập số lượng cần lĩnh');
    const id = tx(db, () => {
      const id = Number(db.prepare('INSERT INTO transfers (from_store, to_store, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(main.id, to.id, v.text(body.note, { name: 'Ghi chú', max: 300 }), me.id, ctx.now()).lastInsertRowid);
      for (const l of lines) db.prepare('INSERT INTO transfer_lines (transfer_id, ingredient_id, qty_requested) VALUES (?, ?, ?)').run(id, l.ing.id, l.qty);
      return id;
    });
    ctx.notify(holderTargets().filter((x) => x !== me.id), { title: `${to.name} xin lĩnh hàng (phiếu #${id})`, body: lines.map((l) => `• ${l.ing.name}: ${l.qty} ${l.ing.unit}`).join('\n'), link: '/kho?tab=linh' });
    ctx.audit(me, 'transfer.create', id);
    ctx.broadcast('stock');
    return { id };
  });

  r.post('/api/stock/transfers/:id/send', 'staff', ({ me, params, body }) => {
    const t = loadTransfer(params.id);
    if (!isHolder(me)) fail(403, 'Chỉ người giữ kho tổng hoặc trưởng ca trở lên mới xuất kho');
    if (t.status !== 'requested') fail(409, 'Phiếu này đã được xử lý');
    const given = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [Number(l.ingredient_id), l.qty]));
    const at = ctx.now();
    tx(db, () => {
      for (const l of t.lines) {
        const ing = ingById(l.ingredient_id);
        const qty = given.has(l.ingredient_id) ? num(given.get(l.ingredient_id), `Số xuất ${l.name}`) : l.qty_requested;
        if (single()) {
          // 1 kho: hàng có định lượng để nguyên (bán tự trừ); hàng không định lượng trừ ngay = đã dùng
          if (qty > 0 && !hasRecipe(l.ingredient_id)) {
            takeLots(db, { storeId: t.from_store, ingredientId: l.ingredient_id, qty, allowShort: true });
            recordMove(db, { at, date: today(), type: 'consume', ingredientId: l.ingredient_id, fromStore: t.from_store, qty, cost: costOf(ing, qty), ref: `transfer:${t.id}`, staffId: me.id, note: `Xuất dùng cho ${t.to_name}` });
          }
          db.prepare('UPDATE transfer_lines SET qty_sent = ? WHERE transfer_id = ? AND ingredient_id = ?').run(qty, t.id, l.ingredient_id);
          continue;
        }
        const taken = qty > 0 ? takeLots(db, { storeId: t.from_store, ingredientId: l.ingredient_id, qty, name: l.name }) : [];
        const exp = taken.map((x) => x.expires_on).filter(Boolean).sort()[0] || null;
        db.prepare('UPDATE transfer_lines SET qty_sent = ?, expires_on = ? WHERE transfer_id = ? AND ingredient_id = ?').run(qty, exp, t.id, l.ingredient_id);
        recordMove(db, { at, date: today(), type: 'transfer', ingredientId: l.ingredient_id, fromStore: t.from_store, toStore: t.to_store, qty, cost: costOf(ing, qty), ref: `transfer:${t.id}`, staffId: me.id, note: 'Xuất kho tổng' });
      }
      db.prepare("UPDATE transfers SET status = 'sent', sent_by = ?, sent_at = ? WHERE id = ?").run(me.id, at, t.id);
    });
    ctx.notify([t.created_by, ...ctx.leadsOf(t.to_team)].filter((x) => x && x !== me.id), { title: `Kho tổng đã xuất phiếu #${t.id} cho ${t.to_name}`, body: 'Kiểm đếm và bấm "Đã nhận" trong app.', link: '/kho?tab=linh' });
    ctx.audit(me, 'transfer.send', t.id);
    ctx.broadcast('stock');
    return loadTransfer(t.id);
  });

  r.post('/api/stock/transfers/:id/receive', 'staff', ({ me, params, body }) => {
    const t = loadTransfer(params.id);
    const to = storeById(t.to_store);
    if (!canStore(me, to)) fail(403, 'Chỉ người của khu nhận mới xác nhận được');
    if (t.status !== 'sent') fail(409, 'Phiếu chưa được xuất hoặc đã nhận rồi');
    const given = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [Number(l.ingredient_id), l.qty]));
    const at = ctx.now();
    const missing = [];
    tx(db, () => {
      for (const l of t.lines) {
        const ing = ingById(l.ingredient_id);
        const got = given.has(l.ingredient_id) ? num(given.get(l.ingredient_id), `Số nhận ${l.name}`, { max: l.qty_sent }) : l.qty_sent;
        if (single()) { db.prepare('UPDATE transfer_lines SET qty_received = ? WHERE transfer_id = ? AND ingredient_id = ?').run(got, t.id, l.ingredient_id); if (got < l.qty_sent) missing.push(`${l.name}: thiếu ${r3(l.qty_sent - got)} ${l.unit}`); continue; }
        addLot(db, { storeId: t.to_store, ingredientId: l.ingredient_id, qty: got, expiresOn: l.expires_on, at });
        db.prepare('UPDATE transfer_lines SET qty_received = ? WHERE transfer_id = ? AND ingredient_id = ?').run(got, t.id, l.ingredient_id);
        const lost = r3(l.qty_sent - got);
        if (lost > 0) {
          missing.push(`${l.name}: thiếu ${lost} ${l.unit}`);
          recordMove(db, { at, date: today(), type: 'waste', ingredientId: l.ingredient_id, fromStore: t.to_store, qty: lost, cost: costOf(ing, lost), ref: `transfer:${t.id}`, staffId: me.id, note: 'Thiếu khi nhận hàng từ kho tổng' });
        }
      }
      db.prepare("UPDATE transfers SET status = 'received', received_by = ?, received_at = ? WHERE id = ?").run(me.id, at, t.id);
    });
    if (missing.length) ctx.notify(holderTargets().filter((x) => x !== me.id), { title: `Phiếu #${t.id}: nhận thiếu hàng`, body: missing.join('\n'), link: '/kho?tab=linh' });
    ctx.audit(me, 'transfer.receive', t.id);
    ctx.broadcast('stock');
    return loadTransfer(t.id);
  });

  r.post('/api/stock/transfers/:id/cancel', 'staff', ({ me, params }) => {
    const t = loadTransfer(params.id);
    if (t.status !== 'requested') fail(409, 'Chỉ huỷ được phiếu chưa xuất');
    if (t.created_by !== me.id && !isHolder(me)) fail(403, 'Bạn không huỷ được phiếu này');
    db.prepare("UPDATE transfers SET status = 'cancelled' WHERE id = ?").run(t.id);
    ctx.broadcast('stock');
    return { ok: true };
  });

  // ---------- Đơn đặt hàng NCC ----------
  function poText(po) {
    const dd = (d) => (d ? `${d.slice(8)}/${d.slice(5, 7)}` : '');
    const lines = po.lines.filter((l) => l.qty > 0).map((l) => `• ${l.name}: ${l.qty} ${l.purchase_unit}`);
    return [
      `🛒 ĐƠN ĐẶT HÀNG #${po.id}${po.supplier_name ? ` – ${po.supplier_name}` : ''}`,
      `Quán: ${ctx.setting('shop_name')}${po.deliver_on ? ` · Giao ngày ${dd(po.deliver_on)}` : ''} · Nhận tại: ${po.store_name}`,
      ...lines,
      po.note ? `Ghi chú: ${po.note}` : '',
      po.approved_by_name ? `Người duyệt: ${po.approved_by_name}` : '',
    ].filter(Boolean).join('\n');
  }

  function loadPo(id) {
    const po = db.prepare(`SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, st.name AS store_name,
      c.name AS created_by_name, sb.name AS submitted_by_name, a.name AS approved_by_name, rb.name AS received_by_name
      FROM purchase_orders p LEFT JOIN suppliers s ON s.id = p.supplier_id JOIN stores st ON st.id = p.store_id
      LEFT JOIN staff c ON c.id = p.created_by LEFT JOIN staff sb ON sb.id = p.submitted_by LEFT JOIN staff a ON a.id = p.approved_by LEFT JOIN staff rb ON rb.id = p.received_by
      WHERE p.id = ?`).get(id);
    if (!po) fail(404, 'Không tìm thấy đơn đặt hàng');
    po.lines = db.prepare(`SELECT l.*, i.name, i.unit, i.purchase_unit, i.purchase_factor, i.shelf_days FROM po_lines l JOIN ingredients i ON i.id = l.ingredient_id
      WHERE l.po_id = ? ORDER BY i.name`).all(id);
    po.total = po.lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0);
    po.text = poText(po);
    po.lead_store_ids = db.prepare('SELECT id FROM stores WHERE supplier_id IS ? AND kind = ?').all(po.supplier_id, 'area').map((x) => x.id);
    return po;
  }

  const canEditPo = (me, po) => rank(me.role) >= rank('shift_lead')
    || (me.role === 'team_lead' && po.lead_store_ids.some((sid) => storeById(sid)?.team_id === me.team_id));

  r.get('/api/stock/po', 'staff', ({ query }) => {
    const status = query.get('status');
    const ids = db.prepare(`SELECT id FROM purchase_orders ${status ? 'WHERE status = ?' : "WHERE status != 'cancelled'"}
      ORDER BY CASE status WHEN 'submitted' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, id DESC LIMIT 100`).all(...(status ? [status] : []));
    return ids.map((x) => loadPo(x.id));
  });

  // Tạo/làm mới đề xuất đặt hàng cho từng NCC từ tồn kho và tốc độ dùng
  ctx.generatePurchaseDrafts = (me) => {
    const main = mainStore();
    const o = overview();
    const incoming = new Map(db.prepare(`SELECT l.ingredient_id, SUM(l.qty * i.purchase_factor) AS q FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id
      JOIN ingredients i ON i.id = l.ingredient_id WHERE p.status IN ('submitted','approved') GROUP BY l.ingredient_id`).all().map((x) => [x.ingredient_id, x.q]));
    const bySupplier = new Map();
    for (const it of o.items) {
      const ing = ingById(it.id);
      const need = purchaseNeed({
        freshness: ing.freshness, forecastTomorrow: it.forecast_tomorrow, avgDaily: it.avg_daily, leadDays: ing.lead_days,
        cycleDays: ing.cycle_days, minStock: ing.min_stock, safetyPct: ing.safety_pct, stock: it.available + (incoming.get(ing.id) || 0),
      });
      const units = toPurchaseUnits(need, { factor: ing.purchase_factor, step: ing.order_step });
      if (units <= 0) continue;
      const key = it.supplier_id ?? 0;
      bySupplier.set(key, [...(bySupplier.get(key) || []), { ing, units }]);
    }
    const t = ctx.now();
    const touched = [];
    tx(db, () => {
      const drafts = db.prepare("SELECT * FROM purchase_orders WHERE status = 'draft'").all();
      for (const d of drafts) if (!bySupplier.has(d.supplier_id ?? 0)) db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(d.id);
      for (const [sid, lines] of bySupplier) {
        let po = drafts.find((d) => (d.supplier_id ?? 0) === sid);
        const ld = Math.max(...lines.map((l) => l.ing.lead_days), 1);
        if (!po) {
          const id = Number(db.prepare('INSERT INTO purchase_orders (supplier_id, store_id, deliver_on, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(sid || null, main.id, addDays(today(), ld), me?.id ?? null, t).lastInsertRowid);
          po = { id };
        } else {
          db.prepare('UPDATE purchase_orders SET deliver_on = ? WHERE id = ?').run(addDays(today(), ld), po.id);
        }
        db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(po.id);
        for (const l of lines) db.prepare('INSERT INTO po_lines (po_id, ingredient_id, qty, suggested, price) VALUES (?, ?, ?, ?, ?)').run(po.id, l.ing.id, l.units, l.units, l.ing.price);
        touched.push(po.id);
      }
    });
    return touched;
  };

  r.post('/api/stock/po/generate', 'team_lead', ({ me }) => {
    const ids = ctx.generatePurchaseDrafts(me);
    ctx.audit(me, 'po.generate', ids.join(','));
    ctx.broadcast('stock');
    return { ids, orders: ids.map(loadPo) };
  });

  r.patch('/api/stock/po/:id', 'team_lead', ({ me, params, body }) => {
    const po = loadPo(params.id);
    if (po.status !== 'draft') fail(409, 'Chỉ sửa được đơn nháp');
    if (!canEditPo(me, po)) fail(403, 'Bạn chỉ sửa được đơn của NCC khu mình');
    tx(db, () => {
      if (body.lines !== undefined) {
        const lines = readLines(body.lines);
        const old = new Map(po.lines.map((l) => [l.ingredient_id, l]));
        db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(po.id);
        for (const l of lines) {
          if (l.qty <= 0) continue;
          const price = l.raw.price === undefined ? (old.get(l.ing.id)?.price ?? l.ing.price) : v.int(l.raw.price, { min: 0, max: 1e9, name: `Giá ${l.ing.name}` });
          db.prepare('INSERT INTO po_lines (po_id, ingredient_id, qty, suggested, price) VALUES (?, ?, ?, ?, ?)').run(po.id, l.ing.id, l.qty, old.get(l.ing.id)?.suggested ?? 0, price);
        }
      }
      const deliver = body.deliver_on === undefined ? po.deliver_on : body.deliver_on;
      if (deliver && !isDate(deliver)) fail(400, 'Ngày giao không hợp lệ');
      db.prepare('UPDATE purchase_orders SET deliver_on = ?, note = ? WHERE id = ?').run(deliver || null, body.note === undefined ? po.note : v.text(body.note, { name: 'Ghi chú', max: 300 }), po.id);
    });
    ctx.broadcast('stock');
    return loadPo(po.id);
  });

  r.post('/api/stock/po/:id/submit', 'team_lead', ({ me, params }) => {
    const po = loadPo(params.id);
    if (po.status !== 'draft') fail(409, 'Đơn này đã gửi duyệt rồi');
    if (!canEditPo(me, po)) fail(403, 'Bạn chỉ gửi được đơn của NCC khu mình');
    if (!po.lines.some((l) => l.qty > 0)) fail(400, 'Đơn chưa có hàng');
    db.prepare("UPDATE purchase_orders SET status = 'submitted', submitted_by = ?, submitted_at = ? WHERE id = ?").run(me.id, ctx.now(), po.id);
    ctx.notify(ctx.managers().filter((x) => x !== me.id), { title: `Đơn đặt hàng #${po.id} chờ duyệt`, body: `${po.supplier_name || 'Chưa chọn NCC'} · ${po.lines.length} mặt hàng · khoảng ${po.total.toLocaleString('vi-VN')}đ`, link: '/kho?tab=dat' });
    ctx.audit(me, 'po.submit', po.id);
    ctx.broadcast('stock');
    return loadPo(po.id);
  });

  r.post('/api/stock/po/:id/approve', 'manager', ({ me, params }) => {
    const po = loadPo(params.id);
    if (!['draft', 'submitted'].includes(po.status)) fail(409, 'Đơn này đã được duyệt hoặc đã nhận');
    if (!po.supplier_id) fail(400, 'Đơn chưa có NCC. Gán NCC cho kho khu hoặc nguyên liệu trước');
    db.prepare("UPDATE purchase_orders SET status = 'approved', approved_by = ?, approved_at = ?, submitted_by = COALESCE(submitted_by, ?), submitted_at = COALESCE(submitted_at, ?) WHERE id = ?")
      .run(me.id, ctx.now(), me.id, ctx.now(), po.id);
    const done = loadPo(po.id);
    // Gửi nội dung đơn cho người giữ kho và người lập/gửi đơn; có nhóm Zalo Bot thì tự gửi vào nhóm (lỗi thì báo, vẫn còn nút sao chép)
    // Gửi vào nhóm Zalo riêng của NCC nếu đã gắn (bot báo đủ / thiếu lại đúng nhóm này khi nhận), không thì nhóm đặt hàng chung
    const gid = ctx.supplierGroupFor?.(po.supplier_id)?.id || ctx.setting('zalo_bot_group_id');
    if (gid) db.prepare('UPDATE purchase_orders SET zalo_chat = ? WHERE id = ?').run(String(gid), po.id);
    if (gid && ctx.zaloBot?.ready()) {
      ctx.zaloBot.send(gid, `${done.text}\n⏳ Hàng CHƯA nhận. Khi nhận, bot báo đủ / thiếu ở đây; công nợ ghi theo số thực nhận.`)
        .then(() => ctx.audit(me, 'po.zalo_group', po.id))
        .catch((e) => ctx.notify([me.id], { title: `Chưa gửi được đơn #${po.id} vào nhóm Zalo`, body: `${e.message}. Bấm "Chép nội dung gửi Zalo" để gửi tay.`, link: '/kho?tab=dat' }));
    }
    ctx.notify([...holderTargets(), po.created_by, po.submitted_by].filter((x) => x && x !== me.id), { title: `Đã duyệt đơn #${po.id} – gửi NCC`, body: done.text, link: '/kho?tab=dat' });
    ctx.audit(me, 'po.approve', po.id);
    ctx.broadcast('stock');
    return done;
  });

  r.post('/api/stock/po/:id/reject', 'manager', ({ me, params, body }) => {
    const po = loadPo(params.id);
    if (po.status !== 'submitted') fail(409, 'Chỉ trả lại được đơn đang chờ duyệt');
    const note = v.text(body.note, { name: 'Lý do', max: 300 });
    db.prepare("UPDATE purchase_orders SET status = 'draft', note = ? WHERE id = ?").run(note || po.note, po.id);
    ctx.notify([po.submitted_by].filter((x) => x && x !== me.id), { title: `Đơn #${po.id} bị trả lại`, body: note, link: '/kho?tab=dat' });
    ctx.broadcast('stock');
    return loadPo(po.id);
  });

  r.post('/api/stock/po/:id/cancel', 'team_lead', ({ me, params }) => {
    const po = loadPo(params.id);
    if (po.status === 'received') fail(409, 'Đơn đã nhận hàng, không huỷ được');
    if (po.status === 'approved' && rank(me.role) < rank('manager')) fail(403, 'Đơn đã duyệt chỉ quản lý mới huỷ được');
    if (!canEditPo(me, po)) fail(403, 'Bạn không huỷ được đơn này');
    db.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").run(po.id);
    ctx.audit(me, 'po.cancel', po.id);
    ctx.broadcast('stock');
    return { ok: true };
  });

  function receiveInto(me, { po, storeId, lines }) {
    storeId = ctx.effectiveStore(storeId);
    const at = ctx.now();
    const t = today();
    for (const l of lines) {
      const ing = l.ing;
      const qty = l.qty;
      if (qty <= 0) continue;
      const price = l.raw.price === undefined || l.raw.price === '' ? (l.defaultPrice ?? ing.price) : v.int(l.raw.price, { min: 0, max: 1e9, name: `Giá ${ing.name}` });
      let exp = l.raw.expires_on || null;
      if (exp && !isDate(exp)) fail(400, `Hạn dùng của ${ing.name} không hợp lệ`);
      if (!exp && ing.shelf_days > 0) exp = addDays(t, ing.shelf_days);
      const useQty = r3(qty * (ing.purchase_factor || 1));
      addLot(db, { storeId, ingredientId: ing.id, qty: useQty, expiresOn: exp, at });
      recordMove(db, { at, date: t, type: 'receive', ingredientId: ing.id, toStore: storeId, qty: useQty, cost: qty * price, ref: po ? `po:${po.id}` : 'nhap-le', staffId: me.id, note: po?.supplier_name || '' });
      if (price > 0) db.prepare('UPDATE ingredients SET price = ? WHERE id = ?').run(price, ing.id);
      if (po) db.prepare('UPDATE po_lines SET qty_received = ?, price_received = ? WHERE po_id = ? AND ingredient_id = ?').run(qty, price, po.id, ing.id);
    }
  }

  r.post('/api/stock/po/:id/receive', 'staff', ({ me, params, body }) => {
    const po = loadPo(params.id);
    if (!isHolder(me)) fail(403, 'Chỉ người giữ kho tổng hoặc trưởng ca trở lên mới nhập kho');
    if (po.status !== 'approved') fail(409, 'Chỉ nhận hàng cho đơn đã duyệt');
    const given = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [Number(l.ingredient_id), l]));
    tx(db, () => {
      const lines = po.lines.map((pl) => {
        const raw = given.get(pl.ingredient_id) || {};
        return { ing: ingById(pl.ingredient_id), qty: raw.qty === undefined ? pl.qty : num(raw.qty, `Số nhận ${pl.name}`), raw, defaultPrice: pl.price };
      });
      receiveInto(me, { po, storeId: po.store_id, lines });
      db.prepare("UPDATE purchase_orders SET status = 'received', received_by = ?, received_at = ? WHERE id = ?").run(me.id, ctx.now(), po.id);
    });
    ctx.audit(me, 'po.receive', po.id);
    ctx.broadcast('stock');
    return loadPo(po.id);
  });

  // Nhập kho lẻ (không qua đơn), vd mua ngoài chợ
  r.post('/api/stock/receive', 'staff', ({ me, body }) => {
    if (!isHolder(me)) fail(403, 'Chỉ người giữ kho tổng hoặc trưởng ca trở lên mới nhập kho');
    const st = storeById(v.optInt(body.store_id, { min: 1, name: 'Kho' }) ?? mainStore().id);
    if (!st) fail(404, 'Không tìm thấy kho');
    const lines = readLines(body.lines);
    tx(db, () => receiveInto(me, { po: null, storeId: st.id, lines }));
    ctx.audit(me, 'stock.receive', { store: st.id, lines: lines.length });
    ctx.broadcast('stock');
    return { ok: true };
  });

  // Dùng cho hoá đơn mua hàng (purchases.js): khu tự nhận hàng → vào kho ngay (bếp dùng liền), tiền tính khi thu ngân duyệt.
  // poId: nhận theo đơn đã duyệt; không có thì nhập lẻ vào storeId. Trả về giá cũ từng nguyên liệu để so giá bất thường.
  ctx.canReceiveStore = (me, storeId) => { const st = storeById(storeId); return !!st && (canStore(me, st) || isHolder(me)); };
  ctx.stockReceive = (me, { poId = null, storeId, lines }) => {
    const oldPrice = new Map();
    if (poId) {
      const po = loadPo(poId);
      if (po.status !== 'approved') fail(409, 'Chỉ nhận hàng cho đơn đã duyệt');
      const given = new Map((lines || []).filter((l) => l.ingredient_id).map((l) => [Number(l.ingredient_id), l]));
      const ls = po.lines.map((pl) => {
        const raw = given.get(pl.ingredient_id) || {};
        const ing = ingById(pl.ingredient_id);
        oldPrice.set(ing.id, ing.price);
        return { ing, qty: raw.qty === undefined ? pl.qty : num(raw.qty, `Số nhận ${pl.name}`), raw, defaultPrice: pl.price };
      });
      receiveInto(me, { po, storeId: po.store_id, lines: ls });
      db.prepare("UPDATE purchase_orders SET status = 'received', received_by = ?, received_at = ? WHERE id = ?").run(me.id, ctx.now(), po.id);
      ctx.broadcast('stock');
      return { oldPrice, po };
    }
    const withIng = (lines || []).filter((l) => l.ingredient_id);
    if (withIng.length) {
      const ls = readLines(withIng);
      for (const l of ls) oldPrice.set(l.ing.id, l.ing.price);
      receiveInto(me, { po: null, storeId, lines: ls });
      ctx.broadcast('stock');
    }
    return { oldPrice, po: null };
  };
  ctx.loadPo = loadPo;

  // ---------- Lịch sử ----------
  r.get('/api/stock/moves', 'staff', ({ query }) => {
    const from = query.get('from') || addDays(today(), -7);
    const to = query.get('to') || today();
    if (!isDate(from) || !isDate(to)) fail(400, 'Ngày không hợp lệ');
    const ing = query.get('ingredient');
    return db.prepare(`SELECT m.*, i.name, i.unit, fs.name AS from_name, ts.name AS to_name, s.name AS staff_name FROM stock_moves m
      JOIN ingredients i ON i.id = m.ingredient_id LEFT JOIN stores fs ON fs.id = m.from_store LEFT JOIN stores ts ON ts.id = m.to_store
      LEFT JOIN staff s ON s.id = m.staff_id WHERE m.date BETWEEN ? AND ? ${ing ? 'AND m.ingredient_id = ?' : ''} ORDER BY m.at DESC, m.id DESC LIMIT 500`)
      .all(...[from, to, ...(ing ? [Number(ing)] : [])]);
  });
}
