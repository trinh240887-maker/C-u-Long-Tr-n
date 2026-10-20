import { addDays, weekStart } from './time.js';

// Các khúc ca "còn hiệu lực" = chưa bị nghỉ đã duyệt
const ACTIVE = `NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.group_id = a.group_id AND l.status = 'approved')`;

export function rangeOf(clock, a) {
  return { start: clock.toEpoch(a.date, a.start_min), end: clock.toEpoch(a.date, a.end_min) };
}

export function groupSegments(db, groupId) {
  return db.prepare('SELECT * FROM assignments WHERE group_id = ? ORDER BY start_min').all(groupId);
}

// Map<staff_id, [{start,end,group_id}]> các ca quanh ngày `date` (ngày trước, ngày đó, ngày sau)
export function busyAround(db, clock, date, { excludeGroup } = {}) {
  const rows = db.prepare(`SELECT a.* FROM assignments a WHERE a.date BETWEEN ? AND ? AND ${ACTIVE} AND a.group_id IS NOT ?`)
    .all(addDays(date, -1), addDays(date, 1), excludeGroup ?? null);
  const map = new Map();
  for (const a of rows) {
    const list = map.get(a.staff_id) || [];
    list.push({ ...rangeOf(clock, a), group_id: a.group_id });
    map.set(a.staff_id, list);
  }
  return map;
}

// Map<staff_id, phút đã xếp trong tuần chứa `date`>
export function weekMinutes(db, date, { excludeGroup } = {}) {
  const start = weekStart(date);
  const rows = db.prepare(`SELECT a.staff_id, SUM(a.end_min - a.start_min) AS m FROM assignments a
    WHERE a.date BETWEEN ? AND ? AND ${ACTIVE} AND a.group_id IS NOT ? GROUP BY a.staff_id`).all(start, addDays(start, 6), excludeGroup ?? null);
  return new Map(rows.map((r) => [r.staff_id, r.m]));
}

export function activeAssignmentsBetween(db, from, to) {
  return db.prepare(`SELECT a.* FROM assignments a WHERE a.date BETWEEN ? AND ? AND ${ACTIVE} ORDER BY a.date, a.start_min`).all(from, to);
}
