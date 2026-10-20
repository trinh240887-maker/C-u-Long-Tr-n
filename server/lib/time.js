// Xử lý giờ địa phương (mặc định giờ Việt Nam, không có giờ mùa hè).
// Ca làm được lưu theo "ngày làm việc" + phút tính từ 0h của ngày đó.
// Ca qua nửa đêm có phút kết thúc > 1440 (vd 17:00–00:30 → 1020–1470).

export const MIN = 60_000;
export const DAY_MIN = 1440;

export function parseOffset(text = '+07:00') {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(text));
  if (!m) throw new Error(`Múi giờ không hợp lệ: ${text}`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * MIN;
}

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 1 = thứ Hai … 7 = Chủ nhật
export function isoWeekday(date) {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

export function weekStart(date) {
  return addDays(date, 1 - isoWeekday(date));
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// "17:30" → 1050
export function parseHM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`Giờ không hợp lệ: ${text}`);
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (v > DAY_MIN) throw new Error(`Giờ không hợp lệ: ${text}`);
  return v;
}

export function fmtHM(minute) {
  const m = ((minute % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Một khúc ca "17:00"–"00:30": nếu giờ kết thúc ≤ giờ bắt đầu thì hiểu là sang ngày hôm sau.
export function segmentMinutes(start, end) {
  const s = parseHM(start);
  let e = parseHM(end);
  if (e <= s) e += DAY_MIN;
  if (e - s > 16 * 60) throw new Error('Một khúc ca không được dài quá 16 giờ');
  return { start_min: s, end_min: e };
}

export function makeClock({ offset = '+07:00', cutoffHour = 5 } = {}) {
  const offsetMs = typeof offset === 'number' ? offset : parseOffset(offset);
  const local = (ms) => new Date(ms + offsetMs);
  const clock = {
    offsetMs,
    cutoffHour,
    dateOf(ms) { return local(ms).toISOString().slice(0, 10); },
    minuteOf(ms) { const d = local(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); },
    // Ngày làm việc: trước giờ cắt (mặc định 5h sáng) vẫn tính là ngày hôm trước.
    businessDate(ms) { return clock.dateOf(ms - cutoffHour * 60 * MIN); },
    toEpoch(date, minute) { return Date.parse(`${date}T00:00:00Z`) - offsetMs + minute * MIN; },
    fmt(ms) {
      if (ms == null) return '';
      const d = local(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
    },
  };
  return clock;
}

// Số phút nằm trong khung giờ đêm (mặc định 22:00–06:00) của khoảng [startMs, endMs).
export function nightMinutes(startMs, endMs, clock, { from = 22 * 60, to = 6 * 60 } = {}) {
  if (!(endMs > startMs)) return 0;
  let total = 0;
  const first = addDays(clock.dateOf(startMs), -1);
  const last = clock.dateOf(endMs);
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const ws = clock.toEpoch(d, from);
    const we = clock.toEpoch(d, to <= from ? DAY_MIN + to : to);
    const overlap = Math.min(endMs, we) - Math.max(startMs, ws);
    if (overlap > 0) total += overlap;
  }
  return Math.round(total / MIN);
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}
