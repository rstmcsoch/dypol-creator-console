/** Minimal Cloudflare D1 shim over node:sqlite (tests only). */
import { DatabaseSync } from 'node:sqlite';

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export function createD1(schemaSql) {
  const db = new DatabaseSync(':memory:');
  if (schemaSql) db.exec(schemaSql);
  const make = (sql, args = []) => ({
    bind: (...a) => make(sql, a.map(norm)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => make(sql), _raw: db };
}
