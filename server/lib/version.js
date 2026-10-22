// Mã phiên bản = băm nội dung code (server.js, server/, public/). Máy chủ và GitHub tính cùng cách,
// nên so 2 mã là biết Railway đã chạy đúng bản mới nhất trên nhánh main chưa (không cần biến của Railway).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function codeHash(root) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) for (const f of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, f));
    else files.push(rel);
  };
  for (const x of ['server.js', 'server', 'public']) if (fs.existsSync(path.join(root, x))) walk(x);
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) { h.update(f); h.update('\0'); h.update(fs.readFileSync(path.join(root, f))); h.update('\0'); }
  return h.digest('hex').slice(0, 12);
}
