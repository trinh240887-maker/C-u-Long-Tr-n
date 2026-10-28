import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^quanly-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;
const VN_OFFSET = 7 * 3600_000; // Asia/Ho_Chi_Minh, không đổi giờ mùa hè

// Giờ sao lưu lấy từ tên file (UTC); tên lạ → null (không bao giờ xoá)
export function backupTime(name) {
  const m = NAME_RE.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// Rà soát 28/10: trước giữ mọi bản mỗi giờ 7 ngày (~168 bản, đầy ổ /data). Nay giữ 24 bản mới nhất
// + bản mới nhất của mỗi ngày (giờ VN) trong 14 ngày gần nhất. Trả về danh sách tên file CẦN XOÁ (hàm thuần, dễ test).
export function backupsToDelete(names, now, { keepLast = 24, keepDays = 14 } = {}) {
  const items = names.map((name) => ({ name, at: backupTime(name) })).filter((x) => x.at !== null).sort((a, b) => b.at - a.at);
  const keep = new Set(items.slice(0, keepLast).map((x) => x.name));
  const dayKey = (t) => new Date(t + VN_OFFSET).toISOString().slice(0, 10);
  const today = dayKey(now), oldest = dayKey(now - (keepDays - 1) * 86_400_000);
  const seenDay = new Set();
  for (const x of items) {
    const d = dayKey(x.at);
    if (d > today || d < oldest || seenDay.has(d)) continue;
    seenDay.add(d);
    keep.add(x.name);
  }
  return items.filter((x) => !keep.has(x.name)).map((x) => x.name);
}

// Dấu hiệu dữ liệu đã đổi: số lệnh ghi của kết nối + kích thước / giờ sửa file .db và -wal
function dbSignature(db) {
  try {
    const file = db.prepare('PRAGMA database_list').all().find((x) => x.name === 'main')?.file;
    if (!file) return null; // DB trong bộ nhớ → luôn sao lưu
    const st = (f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; } };
    return `${db.prepare('SELECT total_changes() AS n').get().n}|${st(file)}|${st(`${file}-wal`)}`;
  } catch { return null; }
}
const lastSig = new Map(); // thư mục → { sig, file }

// Sao lưu toàn bộ dữ liệu ra một file .db (an toàn khi app đang chạy).
// skipUnchanged: dữ liệu chưa đổi từ lần trước → không tạo bản mới, trả về bản cũ (chỉ dùng cho sao lưu tự động mỗi giờ)
export function runBackup(db, dir, { now = Date.now(), keepLast = 24, keepDays = 14, skipUnchanged = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const sig = skipUnchanged ? dbSignature(db) : null;
  const prev = lastSig.get(dir);
  if (sig && prev && prev.sig === sig && fs.existsSync(prev.file)) return prev.file;
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `quanly-${stamp}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const after = dbSignature(db);
  if (after) lastSig.set(dir, { sig: after, file });
  // Chỉ xoá file đúng mẫu tên sao lưu trong thư mục sao lưu
  for (const f of backupsToDelete(fs.readdirSync(dir), now, { keepLast, keepDays })) {
    if (f === path.basename(file)) continue;
    try { fs.rmSync(path.join(dir, f)); } catch (e) { console.error('Xoá bản sao lưu cũ lỗi:', e.message); }
  }
  return file;
}

export function listBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}
