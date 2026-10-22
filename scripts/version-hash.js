// In mã phiên bản của thư mục code (dùng cho GitHub kiểm tra app thật đã lên bản mới chưa)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeHash } from '../server/lib/version.js';
console.log(codeHash(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
