// Đọc file Excel .xlsx (sheet đầu) không dùng thư viện ngoài: giải nén zip bằng zlib có sẵn, đọc XML bằng biểu thức.
// Trả mảng hàng, mỗi hàng là { A: 'giá trị', B: ... } (chữ / số dạng chuỗi). Dùng cho file Sapo xuất ra (chủ quán 28/10).
import zlib from 'node:zlib';

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('File không phải Excel (.xlsx)');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) return null;
    const lp = f.local, start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const raw = buf.subarray(start, start + f.csize);
    return (f.method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
  };
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

export function readXlsx(buf) {
  const get = unzip(buf);
  const shared = [];
  const ssx = get('xl/sharedStrings.xml');
  if (ssx) for (const m of ssx.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(texts(m[1]));
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (!get(sheetPath)) { const wb = get('xl/workbook.xml') || ''; const rel = get('xl/_rels/workbook.xml.rels') || ''; const rid = /<sheet[^>]*r:id="([^"]+)"/.exec(wb)?.[1]; const tgt = rid && new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rel)?.[1]; if (tgt) sheetPath = `xl/${tgt.replace(/^\/?xl\//, '')}`; }
  const sheet = get(sheetPath);
  if (!sheet) throw new Error('Không thấy trang tính trong file');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = {};
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      if (!ref) continue;
      const t = /t="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      row[ref] = t === 's' ? (shared[Number(v)] ?? '') : t === 'inlineStr' ? texts(inner) : v != null ? decode(v) : '';
    }
    rows.push(row);
  }
  return rows;
}

// Ngày giờ Excel (số ngày từ 1899-12-30, giờ địa phương) → { date: 'YYYY-MM-DD', minute }
export function excelDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = Math.round((n - 25569) * 86_400_000);
  const d = new Date(ms);
  return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes(), localMs: ms };
}
