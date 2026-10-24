// Đọc tin báo lịch rảnh nhân viên nhắn trong nhóm Zalo (chủ quán 24/10/2026).
// Ví dụ: "@bot Trần Kim (thu ngân) 24/10 14h-23h" · "Cẩm Tú 14-23" · "thanh đạt, thanh mẫn 14h - 23h30" · "T2 10-14, 17-22 / T3 nghỉ"
// Không ghi ngày → cả 7 ngày tuần tới. Có ngày → chỉ những ngày đó.
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

function datesOf(line, today) {
  const n = norm(line).replace(TIME, ' ');
  const out = new Set();
  const year = Number(today.slice(0, 4));
  for (const m of n.matchAll(/\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/g)) {
    const d = Number(m[1]), mo = Number(m[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : year;
    let iso = `${y}-${pad(mo)}-${pad(d)}`;
    if (!m[3] && iso < addDays(today, -60)) iso = `${y + 1}-${pad(mo)}-${pad(d)}`; // 3/1 nhắn cuối năm → năm sau
    out.add(iso);
  }
  if (/\bngay mai\b|\bmai\b/.test(n)) out.add(addDays(today, 1));
  if (/\bhom nay\b|\btoi nay\b/.test(n)) out.add(today);
  if (/\bngay mot\b/.test(n)) out.add(addDays(today, 2));
  // Thứ / CN: ngày đó của tuần tới (tuần đang báo lịch rảnh)
  const nw = addDays(weekStart(today), 7);
  if (/\b(?:cn|chu nhat)\b/.test(n)) out.add(addDays(nw, 6));
  for (const m of n.matchAll(/\b(?:t|thu|th)\s*([2-7])\b/g)) out.add(addDays(nw, Number(m[1]) - 2));
  return [...out].filter(Boolean).sort();
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
    for (const o of opts) keys.push({ key: o, s });
  }
  // Khớp chuỗi dài trước, mỗi đoạn chữ chỉ dùng 1 lần
  keys.sort((a, b) => b.key.length - a.key.length);
  let rest = t;
  const found = new Map();
  for (const { key, s } of keys) {
    if (found.has(s.id)) continue;
    const k = ` ${key} `;
    if (!rest.includes(k)) continue;
    const same = keys.filter((x) => x.key === key && !found.has(x.s.id));
    if (new Set(same.map((x) => x.s.id)).size > 1) continue; // trùng tên → không đoán
    found.set(s.id, s);
    rest = rest.replace(k, ' ');
  }
  // Tên 1 chữ (vd "Tú") chỉ nhận khi đúng 1 nhân viên có chữ cuối đó
  if (!found.size && single) {
    for (const s of staff) {
      const last = norm(s.name).trim().split(/\s+/).at(-1);
      if (!last || last.length < 2 || DATE_WORDS.has(last) || !rest.includes(` ${last} `)) continue;
      if (staff.filter((x) => norm(x.name).trim().split(/\s+/).at(-1) === last).length === 1) found.set(s.id, s);
    }
  }
  return [...found.values()];
}

// Kết quả: { people, picks: { date: [ranges] }, off: [date], week } — picks rỗng + off rỗng = không hiểu giờ
export function parseAvailMessage(text, { staff, today, sender }) {
  let people = findStaff(String(text || '').replace(/@\S+/g, ' '), staff, { single: !sender });
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
  // Theo từng dòng có cả ngày và giờ ("T2 10-14", "T3 nghỉ"); không có thì dùng cả tin
  const perLine = raw.split(/\n|;/).map((l) => ({ dates: datesOf(l, today), times: timesOf(l), off: /\bnghi\b|\bban\b|\bkhong di\b|\boff\b/.test(l) }));
  const paired = perLine.filter((l) => l.dates.length && (l.times.length || l.off));
  const allTimes = timesOf(raw), allDates = datesOf(raw, today);
  if (paired.length) {
    for (const l of paired) { if (l.times.length) add(l.dates, l.times); else l.dates.forEach((d) => off.add(d)); }
    // Giờ ghi riêng 1 dòng không kèm ngày ("24/10" dòng trên, "14h-23h" dòng dưới) đã gộp qua allDates bên dưới
  } else if (allTimes.length) {
    add(allDates.length ? allDates : week, allTimes);
  }
  return { people, picks, off: [...off], week: nextWeek };
}
