import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const shim = (f) => path.join(here, 'shims', f);
const out = await build({
  entryPoints: [path.join(here, 'entry.js')],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, write: false,
  loader: { '.wasm': 'binary' },
  define: { 'process.env.TRUST_PROXY': '""' },
  alias: {
    'node:sqlite': shim('sqlite.js'), 'node:crypto': shim('crypto.js'), crypto: shim('crypto.js'),
    'node:fs': shim('fs.js'), 'node:fs/promises': shim('fs.js'), fs: shim('fs.js'),
    'node:path': shim('path.js'), path: shim('path.js'),
    preact: path.join(pub, 'vendor', 'preact.js'), 'preact/hooks': path.join(pub, 'vendor', 'hooks.js'), htm: path.join(pub, 'vendor', 'htm.js'),
  },
  logLevel: 'warning',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const html = `<title>Cửu Long Trấn</title>
<meta name="theme-color" content="#7c2d12">
<style>${css}</style>
<div id="root"><div style="padding:32px;text-align:center;font-family:system-ui;color:#74675d">Đang mở bản chạy thử…</div></div>
<script>${js}</script>
`;
fs.mkdirSync(path.join(here, 'dist'), { recursive: true });
const file = path.join(here, 'dist', 'quanly-chay-thu.html');
fs.writeFileSync(file, html);
console.log(`${file} (${Math.round(html.length / 1024)} KB)`);
