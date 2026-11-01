/** Minimal Cloudflare D1 shim over node:sqlite (tests only). */
import { DatabaseSync } from 'node:sqlite';

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export function createD1(schemaSql) {
  const db = new DatabaseSync(':memory:');
  if (schemaSql) db.exec(schemaSql);
  const make = (sql, args = []) => ({
    _sql: sql, _args: args,
    bind: (...a) => make(sql, a.map(norm)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  // D1 batch(): all statements in one transaction (all-or-nothing).
  const batch = async (stmts) => {
    db.exec('BEGIN');
    try {
      const out = stmts.map((st) => { const r = db.prepare(st._sql).run(...st._args); return { meta: { changes: Number(r.changes) } }; });
      db.exec('COMMIT');
      return out;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return { prepare: (sql) => make(sql), batch, _raw: db };
}
