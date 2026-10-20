import { overlaps, MIN } from './time.js';

// Gợi ý người làm thay cho một ca.
//  shift:      { team_id, ranges: [{ start, end }] }  (mốc thời gian ms, đã gồm ca qua nửa đêm)
//  candidates: [{ id, name, team_id, skills: { [team_id]: level }, weekly_limit_hours }]
//  busy:       Map<staff_id, [{ start, end }]>   các ca/khúc ca đã có quanh thời điểm đó
//  onLeave:    Set<staff_id>                    đang nghỉ trong ngày đó
//  weekMinutes: Map<staff_id, number>           số phút đã xếp trong tuần
// Trả về tất cả ứng viên, người phù hợp đứng trước; người không phù hợp có lý do.
export function suggestReplacements({ shift, candidates, busy = new Map(), onLeave = new Set(), weekMinutes = new Map(), excludeId }) {
  const shiftMinutes = shift.ranges.reduce((s, r) => s + (r.end - r.start) / MIN, 0);
  const out = [];
  for (const c of candidates) {
    if (c.id === excludeId) continue;
    const reasons = [];
    const primary = c.team_id === shift.team_id;
    const level = primary ? 3 : Number(c.skills?.[shift.team_id] || 0);
    if (!level) reasons.push('Chưa được đào tạo vị trí này');
    if (onLeave.has(c.id)) reasons.push('Đang xin nghỉ ngày này');
    const clash = (busy.get(c.id) || []).some((b) => shift.ranges.some((r) => overlaps(r, b)));
    if (clash) reasons.push('Trùng giờ với ca khác');
    const week = weekMinutes.get(c.id) || 0;
    const limit = (c.weekly_limit_hours || 48) * 60;
    if (week + shiftMinutes > limit) reasons.push(`Vượt giới hạn ${c.weekly_limit_hours || 48} giờ/tuần`);
    out.push({
      staff_id: c.id,
      name: c.name,
      eligible: reasons.length === 0,
      primary,
      level,
      week_hours: Math.round((week / 60) * 10) / 10,
      reasons,
    });
  }
  // Ưu tiên: phù hợp → cùng tổ → kỹ năng cao → ít giờ trong tuần hơn
  out.sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) ||
    Number(b.primary) - Number(a.primary) ||
    b.level - a.level ||
    a.week_hours - b.week_hours ||
    a.name.localeCompare(b.name, 'vi'));
  return out;
}
