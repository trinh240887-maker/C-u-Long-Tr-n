// Bản chạy thử: chạy cả máy chủ (dữ liệu SQLite) lẫn giao diện ngay trong trình duyệt.
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import wasmBinary from 'sql.js/dist/sql-wasm.wasm';

const KEY = 'quanly-demo-db-v1';
const OWNER_PIN = '135790';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* bộ nhớ trình duyệt bị chặn: vẫn chạy, chỉ không giữ dữ liệu */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* bỏ qua */ } },
};
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

async function main() {
  globalThis.setImmediate ||= (fn) => setTimeout(fn, 0);
  globalThis.__SQL = await initSqlJs({ wasmBinary });
  const saved = store.get(KEY);
  try { globalThis.__DEMO_DB_BYTES = saved ? fromB64(saved) : null; } catch { globalThis.__DEMO_DB_BYTES = null; }

  const { openDb, pinLookup, ROLE_LABEL } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const { loadDemoData, hasOtherStaff, DEMO_PEOPLE } = await import('../server/demo.js');

  const db = openDb(':memory:');
  if (!hasOtherStaff(db)) {
    loadDemoData(db, { weeks: 2 });
    db.prepare("UPDATE staff SET pin_lookup = ?, must_change_pin = 0, name = 'Chủ quán (mẫu)' WHERE role = 'owner'").run(pinLookup(db, OWNER_PIN));
  }
  const app = createApp({ db, publicDir: '/', now: () => Date.now() });

  let timer = null;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => store.set(KEY, toB64(globalThis.__DEMO_RAW.export())), 400); };

  let cookie = store.get(KEY + ':sid') || '';
  function call(method, url, body, onWrite) {
    return new Promise((resolve) => {
      let status = 200;
      const headers = {};
      const closers = [];
      const req = {
        method, url, rawBody: body || '', socket: { remoteAddress: '192.168.1.50' },
        headers: { 'content-type': method === 'GET' ? '' : 'application/json', cookie },
        on(ev, fn) { if (ev === 'close') closers.push(fn); },
      };
      const res = {
        setHeader(k, v) { if (k.toLowerCase() === 'set-cookie') { cookie = String(v).split(';')[0]; store.set(KEY + ':sid', cookie); } },
        writeHead(s, h) { status = s; Object.assign(headers, h || {}); },
        write(chunk) { onWrite?.(String(chunk)); },
        end(data) { resolve({ status, headers, data: data ?? '', close: () => closers.forEach((f) => f()) }); },
      };
      Promise.resolve(app.handler(req, res)).then(() => onWrite && resolve({ status, headers, close: () => closers.forEach((f) => f()) }));
    });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, opts);
    const method = (opts.method || 'GET').toUpperCase();
    const r = await call(method, url, opts.body);
    if (method !== 'GET') save();
    return new Response(r.data, { status: r.status, headers: r.headers });
  };

  // Đồng bộ thời gian thực giả lập (trong cùng trang)
  window.EventSource = class {
    constructor(url) {
      this.listeners = {};
      call('GET', url, null, (text) => {
        if (text.includes('event: change')) (this.listeners.change || []).forEach((f) => f({ data: '{}' }));
      }).then((r) => { this.handle = r; if (r.status === 200) setTimeout(() => this.onopen?.(), 0); else setTimeout(() => this.onerror?.(), 0); });
    }
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
    close() { this.handle?.close?.(); }
  };

  window.__DEMO__ = {
    accounts: [
      { name: 'Chủ quán (mẫu)', role: ROLE_LABEL.owner, pin: OWNER_PIN },
      ...DEMO_PEOPLE.map(([name, role, team, pin]) => ({ name, role: ROLE_LABEL[role], team, pin })),
    ],
    reset() { store.del(KEY); store.del(KEY + ':sid'); location.reload(); },
  };
  await import('../public/app.js');
}

main().catch((e) => {
  document.getElementById('root').innerHTML = `<div style="padding:24px;font-family:system-ui">Không mở được bản chạy thử: ${String(e.message || e).replace(/</g, '&lt;')}</div>`;
});
