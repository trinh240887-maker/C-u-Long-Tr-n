// "1-10, 15, 20-22" → [1..10, 15, 20, 21, 22]
export function parseTableList(text, { max = 999 } = {}) {
  const out = new Set();
  const s = String(text ?? '').trim();
  if (!s) return [];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!m) throw new Error(`Không hiểu "${part}". Ghi kiểu 1-10, 15, 20-22`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > max) throw new Error(`Số bàn không hợp lệ: ${part}`);
    if (b - a > 500) throw new Error('Khoảng bàn quá lớn');
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

// [1,2,3,5,7,8] → "1-3, 5, 7-8"
export function formatTableList(nums) {
  const a = [...new Set(nums)].sort((x, y) => x - y);
  const parts = [];
  for (let i = 0; i < a.length; i++) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    parts.push(i === j ? `${a[i]}` : `${a[i]}-${a[j]}`);
    i = j;
  }
  return parts.join(', ');
}
