export const sep = '/';
export const join = (...a) => a.join('/');
export const resolve = (...a) => a.join('/');
export const extname = (p) => (/\.[^./]+$/.exec(p) || [''])[0];
export const dirname = (p) => p.split('/').slice(0, -1).join('/');
export default { sep, join, resolve, extname, dirname };
