// Đọc tin báo lịch rảnh nhân viên nhắn trong nhóm Zalo (chủ quán 24/10/2026).
// Ví dụ: "@bot Trần Kim (thu ngân) 24/10 14h-23h" · "Cẩm Tú 14-23" · "thanh đạt, thanh mẫn 14h - 23h30" · "T2 10-14, 17-22 / T3 nghỉ"
// Không ghi ngày → cả 7 ngày tuần tới. Có ngày → ngày đó ghi riêng ("14-23, T7 nghỉ, CN 10-23").
import { addDays, isoWeekday, weekStart } from './time.js';

export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const hm = (h, m) => `${pad(h)}:${pad(m)}`;

// Giờ: 14h-23h · 14-23 · 14h - 23h30 · 14:00-23:00 · 10g-14g · 14h đến 23h
const TIME = /(\d{1,2})\s*(?:[h:g](\d{2})?|giờ|gio)?\s*(?:-|–|—|~|đến|den|tới|toi|>)\s*(\d{1,2})\s*(?:[h:g](\d{2})?|giờ|gio)?/gi;

function timesOf(line) {
  const out = [];
  for (const m of line.matchAll(TIME)) {
    const sh = Number(m[1]), sm = Number(m[2] || 0), eh = Number(m[3]), em = Number(m[4] || 0);
    if (sh > 24 || eh > 24 || sm > 59 || em > 59) continue;
    let start = sh * 60 + sm, end = eh * 60 + em;
    if (end <= start) end = 1440; // qua nửa đêm: ghi tới 24:00, quản lý chỉnh thêm
    if (start >= 1440 || end - start < 60) continue;
    out.push(`${hm(Math.floor(start / 60), start % 60)}-${end === 1440 ? '24:00' : hm(Math.floor(end / 60), end % 60)}`);
  }
  return out;
}

// Các mốc ngày trong tin, kèm vị trí: 24/10 · mai · hôm nay · ngày mốt · T2…T7, CN (của tuần tới) · T2-T6 / T2 đến T6
// Ngày dạng số, đọc TRƯỚC giờ để "26/10-30/10" không bị hiểu là giờ 10-30:
// 26/10 · 26/10/2026 · khoảng 26/10-30/10 · 26-30/10 · 31/10-1/11 (gõ nhầm tháng như 26/10-30/11 → hiểu 26/10-30/10)
function numericDates(n, today) {
  const out = [];
  const year = Number(today.slice(0, 4));
  const iso = (d, mo) => {
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    let x = `${year}-${pad(mo)}-${pad(d)}`;
    if (x < addDays(today, -60)) x = `${year + 1}-${pad(mo)}-${pad(d)}`;
    return x;
  };
  let text = n;
  const blankOut = (m) => { text = text.slice(0, m.index) + ' '.repeat(m[0].length) + text.slice(m.index + m[0].length); };
  const RANGE = /\b(\d{1,2})(?:\s*\/\s*(\d{1,2}))?\s*(?:-|–|—|~|den|toi|>)\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/g;
  for (const m of [...n.matchAll(RANGE)]) {
    const from = iso(Number(m[1]), Number(m[2] || m[4]));
    let to = iso(Number(m[3]), Number(m[4]));
    if (!from || !to) continue;
    if (to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 13) { const alt = iso(Number(m[3]), Number(m[2] || m[4])); if (alt && alt >= from && (Date.parse(alt) - Date.parse(from)) / 86400000 <= 13) to = alt; }
    const days = [];
    for (let d = from; d <= to && days.length < 14; d = addDays(d, 1)) days.push(d);
    if (!days.length) continue;
    out.push({ pos: m.index, kind: 'date', dates: days });
    blankOut(m);
  }
  for (const m of [...text.matchAll(/\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/g)]) {
    let x = iso(Number(m[1]), Number(m[2]));
    if (m[3]) x = `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
    if (!x) continue;
    out.push({ pos: m.index, kind: 'date', dates: [x] });
    blankOut(m);
  }
  return { tokens: out, text };
}

function dateTokens(n, today) {
  const out = [];
  const year = Number(today.slice(0, 4));
  const nw = addDays(weekStart(today), 7);
  const dowDate = (k) => addDays(nw, k === 'cn' ? 6 : Number(k) - 2);
  const RE = /\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b|\b(ngay mai|mai|hom nay|toi nay|ngay mot)\b/g;
  for (const m of n.matchAll(RE)) {
    let dates = [];
    if (m[1]) {
      const d = Number(m[1]), mo = Number(m[2]);
      if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
      const y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : year;
      let iso = `${y}-${pad(mo)}-${pad(d)}`;
      if (!m[3] && iso < addDays(today, -60)) iso = `${y + 1}-${pad(mo)}-${pad(d)}`; // 3/1 nhắn cuối năm → năm sau
      dates = [iso];
    } else if (m[4]) {
      dates = [{ 'ngay mai': 1, mai: 1, 'hom nay': 0, 'toi nay': 0, 'ngay mot': 2 }[m[4]]].map((k) => addDays(today, k));
    }
    out.push({ pos: m.index, kind: 'date', dates });
  }
  // Thứ: "T3 T6 CN", "T2-T6" (khoảng), "T2-T4-T5" (3 thứ trở lên nối gạch = liệt kê).
  // "T3-T6" mà trong tin có ghi riêng T4 / T5 thì hiểu là liệt kê T3, T6 (không phải khoảng)
  const DOW = /\b(?:(?:t|thu|th)\s*([2-7])|(cn|chu nhat))\b(?:\s*(?:-|–|den|toi)\s*(?:(?:t|thu|th)\s*[2-7]|cn|chu nhat)\b)*/g;
  const dowTok = [];
  for (const m of n.matchAll(DOW)) {
    const items = [...m[0].matchAll(/(?:(?:t|thu|th)\s*([2-7])|(cn|chu nhat))/g)].map((x) => dowDate(x[1] || 'cn'));
    dowTok.push({ pos: m.index, items, range: items.length === 2 && items[1] > items[0] });
  }
  const single = new Set(dowTok.filter((x) => !x.range).flatMap((x) => x.items));
  for (const x of dowTok) {
    let dates = x.items;
    if (x.range) {
      const span = [];
      for (let d = x.items[0]; d <= x.items[1]; d = addDays(d, 1)) span.push(d);
      dates = span.slice(1, -1).some((d) => single.has(d)) ? x.items : span;
    }
    out.push({ pos: x.pos, kind: 'date', dates });
  }
  return out;
}

// Tìm tên nhân viên trong tin: cả họ tên, hoặc 2 / 3 chữ cuối (vd "Hồng Phúc" khớp "Nguyễn Hồng Phúc"), hoặc tên 1 chữ nếu chỉ 1 người có tên đó
const DATE_WORDS = new Set(['mai', 'nay', 'mot', 'cn', 'thu', 'ca', 'gio']);
export function findStaff(text, staff, { single = true } = {}) {
  const t = ` ${norm(text).replace(/[^a-z0-9]+/g, ' ')} `;
  const keys = [];
  for (const s of staff) {
    const w = norm(s.name).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    if (!w.length) continue;
    const opts = new Set([w.join(' ')]);
    if (w.length >= 3) opts.add(w.slice(-2).join(' '));
    if (w.length >= 4) opts.add(w.slice(-3).join(' '));
    for (const o of opts) keys.push({ key: o, s, partial: o !== w.join(' ') });
  }
  // Khớp chuỗi dài trước, mỗi đoạn chữ chỉ dùng 1 lần
  keys.sort((a, b) => b.key.length - a.key.length);
  let rest = t;
  const found = new Map();
  for (const { key, s, partial } of keys) {
    if (found.has(s.id)) continue;
    const k = ` ${key} `;
    if (!rest.includes(k)) continue;
    const same = keys.filter((x) => x.key === key && !found.has(x.s.id));
    if (new Set(same.map((x) => x.s.id)).size > 1) continue; // trùng tên → không đoán
    found.set(s.id, partial ? { ...s, _partial: true } : s);
    rest = rest.replace(k, ' ');
  }
  // Tên 1 chữ (vd "Tú") chỉ nhận khi đúng 1 nhân viên có chữ cuối đó
  if (!found.size && single) {
    for (const s of staff) {
      const last = norm(s.name).trim().split(/\s+/).at(-1);
      if (!last || last.length < 2 || DATE_WORDS.has(last) || !rest.includes(` ${last} `)) continue;
      if (staff.filter((x) => norm(x.name).trim().split(/\s+/).at(-1) === last).length === 1) found.set(s.id, { ...s, _single: true });
    }
  }
  return [...found.values()];
}

// Kết quả: { people, picks: { date: [ranges] }, off: [date], week } — picks rỗng + off rỗng = không hiểu giờ
export function parseAvailMessage(text, { staff, today, sender }) {
  let people = findStaff(String(text || '').replace(/@\S+/g, ' '), staff, { single: !sender });
  const named = people.length > 0;
  if (!people.length && sender) people = staff.filter((s) => s.id === sender);
  // Bỏ @bot và tên người (tên "Mai" không bị hiểu là "ngày mai")
  let raw = norm(text).replace(/@\S+/g, ' ');
  for (const p of people) {
    const w = norm(p.name).replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
    for (const k of [w.join(' '), w.slice(-3).join(' '), w.slice(-2).join(' '), w.at(-1)]) raw = raw.replace(new RegExp(`(^|[^a-z0-9])${k.replace(/ /g, '[^a-z0-9\\n]+')}(?=$|[^a-z0-9])`, 'g'), '$1 ');
  }
  const picks = {}, off = new Set();
  const nextWeek = addDays(weekStart(today), 7);
  const week = Array.from({ length: 7 }, (_, i) => addDays(nextWeek, i));
  const add = (dates, times) => { for (const d of dates) for (const r of times) (picks[d] ||= []).includes(r) || picks[d].push(r); };
  // Đọc lần lượt: giờ ghi trước mọi thứ = cả tuần; "T7 nghỉ", "CN 10-23" = ghi riêng ngày đó (chủ quán 25/10)
  const nd = numericDates(raw, today);
  const tokens = [...nd.tokens];
  for (const m of nd.text.matchAll(TIME)) { const t = timesOf(m[0]); if (t.length) tokens.push({ pos: m.index, kind: 'time', times: t }); }
  let blank = nd.text.replace(TIME, (x) => ' '.repeat(x.length));
  // "14h,23h" / "14h , 23h" (gõ dấu phẩy thay gạch) → hiểu là 14h-23h
  for (const m of [...blank.matchAll(/\b(\d{1,2})\s*h\s*,\s*(\d{1,2})\s*h\b(?!\s*[-–])/g)]) {
    const t = timesOf(`${m[1]}h-${m[2]}h`);
    if (!t.length) continue;
    tokens.push({ pos: m.index, kind: 'time', times: t });
    blank = blank.slice(0, m.index) + ' '.repeat(m[0].length) + blank.slice(m.index + m[0].length);
  }
  tokens.push(...dateTokens(blank, today));
  for (const m of blank.matchAll(/\b(nghi|ban|khong di|khong lam|off)\b/g)) tokens.push({ pos: m.index, kind: 'off' });
  for (const m of blank.matchAll(/\b(con lai|ngay khac|cac ngay khac|ca tuan)\b/g)) tokens.push({ pos: m.index, kind: 'rest' });
  tokens.sort((x, y) => x.pos - y.pos);
  let cur = { dates: [], times: [], off: false };
  const segs = [cur];
  for (const t of tokens) {
    if (t.kind === 'date') {
      if (cur.times.length || cur.off) { cur = { dates: [], times: [], off: false }; segs.push(cur); }
      cur.dates.push(...t.dates);
    } else if (t.kind === 'rest') { cur = { dates: [], times: [], off: false }; segs.push(cur); }
    else if (t.kind === 'time') cur.times.push(...t.times);
    else cur.off = true;
  }
  const base = { times: segs.filter((x) => !x.dates.length).flatMap((x) => x.times) };
  const dated = segs.filter((x) => x.dates.length);
  const done = new Set();
  for (const sg of dated) {
    if (sg.times.length) { add(sg.dates, sg.times); sg.dates.forEach((d) => done.add(d)); }
    else if (sg.off) sg.dates.forEach((d) => { off.add(d); done.add(d); });
  }
  if (base.times.length) {
    const bare = dated.filter((x) => !x.times.length && !x.off).flatMap((x) => x.dates);
    // "14-23 T2 T3" → chỉ T2, T3; còn lại: cả tuần trừ những ngày đã ghi riêng
    if (bare.length && !done.size) add(bare, base.times);
    else add(week.filter((d) => !done.has(d)), base.times);
  }
  // Chữ còn lại sau khi bỏ giờ, ngày, từ khoá: có ≥ 2 chữ mà không khớp ai = có thể là tên người chưa có trong app
  const STOP = new Set(['nghi', 'ban', 'off', 'khong', 'di', 'lam', 'con', 'lai', 'ngay', 'khac', 'cac', 'ca', 'tuan', 'thu', 'cn', 'chu', 'nhat', 'mai', 'hom', 'nay', 'toi', 'mot', 'den', 'h', 'g', 'gio', 'va', 'tu', 'full', 'gay', 'chinh', 'sang', 'chieu', 'dem', 'phuc', 'vu', 'tiep', 'thuc', 'bep', 'bar', 'thu', 'ngan', 'tap', 'truong', 'to', 'nhan', 'vien', 'pv', 'tt', 'nv', 'oi', 'a', 'e', 'em', 'anh', 'chi', 'nhe', 'nha', 'xin', 'bao', 'lich', 'ranh']);
  const left = blank.replace(/\b(?:t|thu|th)\s*[2-7]\b/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  // Ngày ghi "nghỉ" riêng thắng khoảng ngày ("T4 nghỉ, T5 nghỉ, T3-T6 14-23" → T4, T5 nghỉ)
  for (const d of off) delete picks[d];
  // Khớp chỉ bằng 1 chữ cuối ("Hậu") mà trong tin còn chữ tên khác ("Trần Trung Hậu") → là người khác, không đoán (chủ quán 25/10)
  if (people.length && people.every((x) => x._single) && left.length >= 1) {
    return { people: [], picks, off: [...off], week: nextWeek, unknownName: [...left, ...people.map((x) => norm(x.name).trim().split(/\s+/).at(-1))].join(' '), bySender: false };
  }
  // Khớp thiếu họ ("Thành Phát" ↔ Lê Thành Phát) mà tin ghi họ KHÁC ("Phan Thành Phát") → người khác, không đoán; hỏi lại (chủ quán 25/10)
  const SURNAMES = new Set(['nguyen', 'tran', 'le', 'pham', 'hoang', 'huynh', 'phan', 'vu', 'vo', 'dang', 'bui', 'do', 'ho', 'ngo', 'duong', 'ly', 'truong', 'dinh', 'cao', 'lam', 'luong', 'ta', 'trinh', 'quach', 'la', 'thai', 'kieu', 'ton', 'chau', 'tang', 'ha', 'mac', 'tieu', 'doan', 'au', 'luu', 'khuu', 'lai', 'giang', 'tong', 'van']);
  const otherSurname = (x) => left.some((w) => SURNAMES.has(w) && !norm(x.name).split(/\s+/).includes(w));
  if (people.length && people.every((x) => x._partial || x._single) && people.some(otherSurname)) {
    return { people: [], picks, off: [...off], week: nextWeek, near: people.map(({ _single, _partial, ...x }) => x),
      unknownName: [...left, ...people.map((x) => norm(x.name).trim().split(/\s+/).slice(-2).join(' '))].join(' '), bySender: false };
  }
  people = people.map(({ _single, _partial, ...x }) => x);
  return { people, picks, off: [...off], week: nextWeek, unknownName: !named && left.length >= 2 ? left.join(' ') : '', bySender: !named && people.length > 0 };
}

// Tin đăng ký nhân viên mới: "NV mới: Trần Trung Hậu, 0901234567, Phục vụ, nhân viên"
const NEW_KEY = /\b(nv moi|nhan vien moi|nguoi moi|ban moi|moi vao|dang ky nv|dang ky nhan vien)\b/;
export function isNewStaffMsg(text) { return NEW_KEY.test(norm(String(text || '').replace(/@\S+/g, ' '))); }
export function parseNewStaff(text, { teams = [], positions = [] } = {}) {
  const raw = String(text || '').replace(/@\S+/g, ' ');
  const phoneM = raw.replace(/[.\s]/g, '').match(/(?:\+?84|0)\d{9,10}/);
  const phone = phoneM ? phoneM[0].replace(/^\+?84/, '0') : '';
  const parts = raw.replace(/(?:\+?84|0)[\d.\s]{9,14}/, ' ').split(/[,;|\n\-–:]+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => x.replace(/\b(nv|nhân viên|người|bạn)\s+mới\b|\bmới vào\b|\bđăng ký( nv| nhân viên)?\b|\bsđt\b|\bsdt\b|\bvị trí\b|\bchức vụ\b|\bbộ phận\b/gi, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const lc = (x) => norm(x).trim();
  let team = null, position = null, role = 'staff', name = '';
  for (const p of parts) {
    const n = lc(p);
    if (/truong ca/.test(n)) { role = 'shift_lead'; continue; }
    if (/to truong/.test(n)) { role = 'team_lead'; continue; }
    if (/^(nhan vien|nv|part ?time|full ?ca|ca gay)$/.test(n)) continue;
    const t = teams.find((x) => lc(x.name) === n) || teams.find((x) => n.includes(lc(x.name)));
    if (t && !team) {
      team = t;
      // "Lê Văn A tiếp thực" → bỏ tên bộ phận, phần còn lại là tên
      const rest = p.split(/\s+/).slice(0, Math.max(0, p.split(/\s+/).length - t.name.split(/\s+/).length)).join(' ');
      if (!name && lc(rest) && !lc(rest).includes(lc(t.name)) && rest.split(/\s+/).length >= 2 && n.endsWith(lc(t.name))) name = rest;
      continue;
    }
    const ps = positions.find((x) => lc(x.name) === n);
    if (ps && !position) { position = ps; if (!team) team = teams.find((x) => x.id === ps.team_id) || null; continue; }
    if (!name && /[a-zà-ỹđ]/i.test(p) && p.split(/\s+/).length >= 2) name = p.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (name) name = name.split(/\s+/).map((w) => w.charAt(0).toLocaleUpperCase('vi') + w.slice(1).toLocaleLowerCase('vi')).join(' ');
  return { name, phone, team_id: team?.id || null, team_name: team?.name || '', position_id: position?.id || null, role };
}
