import type { DB, TX } from "./db.js";
export async function requiresMfa(db: DB | TX, role: string): Promise<boolean> {
  const result = await db.query<{ requires_mfa: boolean }>(
    "SELECT requires_mfa FROM roles WHERE name=$1",
    [role],
  );
  return result.rows[0]?.requires_mfa ?? true;
}
