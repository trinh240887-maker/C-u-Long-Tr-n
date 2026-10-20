import fs from 'node:fs';
import path from 'node:path';

// Sao lưu toàn bộ dữ liệu ra một file .db (an toàn khi app đang chạy).
export function runBackup(db, dir, { now = Date.now(), keepDays = 7 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `quanly-${stamp}.db`);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  for (const f of fs.readdirSync(dir)) {
    if (!/^quanly-\d{8}-\d{6}\.db$/.test(f)) continue;
    const full = path.join(dir, f);
    if (now - fs.statSync(full).mtimeMs > keepDays * 86_400_000) fs.rmSync(full);
  }
  return file;
}

export function listBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^quanly-\d{8}-\d{6}\.db$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}
