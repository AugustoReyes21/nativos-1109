import type { DB } from "./db.js";

// Retention for auxiliary tables only. Business records (orders, payments,
// cash) and the append-only audit log are never purged here.
const statements: [string, string][] = [
  ["rate_limits", "DELETE FROM rate_limits WHERE expires_at < now()"],
  ["auth_challenges", "DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day'"],
  ["password_resets", "DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'"],
  // Used tokens are kept while their session can still be refreshed, so reuse detection keeps working.
  ["refresh_tokens", `DELETE FROM refresh_tokens r USING sessions s
    WHERE r.session_id = s.id AND s.expires_at < now() - interval '1 day'`],
  ["sessions", `DELETE FROM sessions s WHERE s.expires_at < now() - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.session_id = s.id)`],
  ["idempotency", "DELETE FROM idempotency WHERE created_at < now() - interval '7 days'"],
  // Keep the newest event: its id is the revision clients compare against.
  ["events", `DELETE FROM events WHERE created_at < now() - interval '1 day'
    AND id < (SELECT max(id) FROM events)`],
];

export async function purge(db: DB): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const [table, sql] of statements) removed[table] = (await db.query(sql)).rowCount ?? 0;
  return removed;
}
