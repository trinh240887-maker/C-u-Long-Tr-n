// Bản chạy thử: không có ổ đĩa. Ảnh checklist giữ tạm trong bộ nhớ (mất khi tải lại trang).
const no = () => { throw new Error('Không hỗ trợ trong bản chạy thử'); };
const mem = new Map();
export const existsSync = (p) => mem.has(p);
export const mkdirSync = () => {};
export const readdirSync = () => [];
export const statSync = no;
export const rmSync = () => {};
export const rmdirSync = () => {};
export const writeFileSync = (p, data) => { mem.set(p, data); };
export const readFileSync = (p) => { if (!mem.has(p)) no(); return mem.get(p); };
export const unlinkSync = (p) => { mem.delete(p); };
export const readFile = async () => no();
export default { existsSync, mkdirSync, readdirSync, statSync, rmSync, rmdirSync, writeFileSync, readFileSync, unlinkSync, readFile };
