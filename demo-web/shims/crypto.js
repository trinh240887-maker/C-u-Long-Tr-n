import { sha256 } from 'js-sha256';
class Bytes extends Uint8Array {
  toString(enc) {
    if (enc === 'hex') return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('');
    return super.toString();
  }
}
export function randomBytes(n) {
  const b = new Bytes(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}
export function createHmac(_alg, key) {
  let data = '';
  const h = { update(s) { data += String(s); return h; }, digest() { return sha256.hmac(key, data); } };
  return h;
}
export function timingSafeEqual(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
export default { randomBytes, createHmac, timingSafeEqual };
