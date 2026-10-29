export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message, code, extra) => { const e = new HttpError(status, message); if (code) e.code = code; if (extra) e.extra = extra; throw e; };

// Kiểm tra dữ liệu gửi lên
export const v = {
  int(value, { min = -Infinity, max = Infinity, name = 'Giá trị' } = {}) {
    const n = Number(value);
    if (value === '' || value === null || value === undefined || !Number.isInteger(n) || n < min || n > max) fail(400, `${name} không hợp lệ`);
    return n;
  },
  optInt(value, opts) {
    return value === undefined || value === null || value === '' ? null : v.int(value, opts);
  },
  text(value, { max = 200, name = 'Nội dung', required = false } = {}) {
    const s = String(value ?? '').trim();
    if (required && !s) fail(400, `Thiếu ${name.toLowerCase()}`);
    if (s.length > max) fail(400, `${name} quá dài (tối đa ${max} ký tự)`);
    return s;
  },
  oneOf(value, list, { name = 'Giá trị', fallback } = {}) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!list.includes(value)) fail(400, `${name} không hợp lệ`);
    return value;
  },
  bool(value) { return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0; },
};

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, role, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$');
    routes.push({ method, re, keys, role, fn });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])])) };
      }
      return null;
    },
  };
}

export async function readJson(req, limit = 2_000_000) {
  if (typeof req.rawBody === 'string') { // bản chạy thử trong trình duyệt
    try { const b = req.rawBody ? JSON.parse(req.rawBody) : {}; return b && typeof b === 'object' ? b : {}; } catch { fail(400, 'Dữ liệu gửi lên không đúng định dạng'); }
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) fail(413, 'Dữ liệu gửi lên quá lớn');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    fail(400, 'Dữ liệu gửi lên không đúng định dạng');
  }
}

export function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
