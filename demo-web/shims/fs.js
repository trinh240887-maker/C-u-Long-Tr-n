const no = () => { throw new Error('Không hỗ trợ trong bản chạy thử'); };
export const existsSync = () => false;
export const mkdirSync = () => {};
export const readdirSync = () => [];
export const statSync = no;
export const rmSync = () => {};
export const readFile = async () => no();
export default { existsSync, mkdirSync, readdirSync, statSync, rmSync, readFile };
