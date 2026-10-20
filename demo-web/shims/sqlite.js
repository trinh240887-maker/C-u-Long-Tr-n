// Thay node:sqlite bằng sql.js (SQLite chạy trong trình duyệt) cho bản chạy thử.
class StatementSync {
  constructor(raw, sql) { this.raw = raw; this.sql = sql; }
  open(params) {
    const s = this.raw.prepare(this.sql);
    if (params.length) s.bind(params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)));
    return s;
  }
  run(...params) {
    const s = this.open(params);
    try { s.step(); } finally { s.free(); }
    const id = this.raw.exec('SELECT last_insert_rowid()')[0].values[0][0];
    return { changes: this.raw.getRowsModified(), lastInsertRowid: Number(id) };
  }
  get(...params) {
    const s = this.open(params);
    try { return s.step() ? s.getAsObject() : undefined; } finally { s.free(); }
  }
  all(...params) {
    const s = this.open(params);
    const out = [];
    try { while (s.step()) out.push(s.getAsObject()); } finally { s.free(); }
    return out;
  }
}

export class DatabaseSync {
  constructor() {
    const SQL = globalThis.__SQL;
    this.raw = globalThis.__DEMO_DB_BYTES ? new SQL.Database(globalThis.__DEMO_DB_BYTES) : new SQL.Database();
    globalThis.__DEMO_RAW = this.raw;
  }
  exec(sql) { this.raw.exec(sql); }
  prepare(sql) { return new StatementSync(this.raw, sql); }
  close() {}
}
export default { DatabaseSync };
