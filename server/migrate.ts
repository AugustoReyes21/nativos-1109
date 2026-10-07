import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { database, transaction, type DB } from './db.js';
import { config } from './config.js';
import { loadEnv } from './env.js';
export async function migrate(db: DB) {
  await transaction(db, async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(1109001)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) {
      const sql = await readFile(`migrations/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const { rows } = await tx.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (rows[0]) { if (rows[0].checksum !== checksum) throw new Error(`Changed migration: ${name}`); continue; }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [name, checksum]);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const db = database(config());
  try { await migrate(db); } finally { await db.end(); }
}
