import pg from "pg";
import type { Config } from "./config.js";
export type DB = pg.Pool;
export type TX = pg.PoolClient;
export function database(c: Config): DB {
  return new pg.Pool({
    connectionString: c.DATABASE_URL,
    max: 15,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
    lock_timeout: 5000,
    ssl: c.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false,
  });
}
export async function transaction<T>(
  db: DB,
  operation: (tx: TX) => Promise<T>,
): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await operation(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
