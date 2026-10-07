import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { database, transaction, type DB } from "./db.js";
import { config } from "./config.js";
import { loadEnv } from "./env.js";

// Explicit operator operation after deploying MFA-aware SUPERADMIN code.
// Never creates accounts or changes passwords; unknown/inactive accounts fail closed.
export async function promoteOwner(db: DB, target: string) {
  const email = z.email().parse(target).toLowerCase();
  return transaction(db, async (tx) => {
    // Same lock as user administration, so concurrent demotion cannot remove the last admin.
    await tx.query("SELECT pg_advisory_xact_lock(1109003)");
    const user = (
      await tx.query<{ id: string; role: string; active: boolean }>(
        "SELECT id,role,active FROM users WHERE email=$1 FOR UPDATE",
        [email],
      )
    ).rows[0];
    if (!user?.active)
      throw new Error("Active existing owner account required");
    const role = (
      await tx.query(
        "SELECT 1 FROM roles WHERE name='SUPERADMIN' AND requires_mfa",
      )
    ).rowCount;
    if (!role)
      throw new Error("SUPERADMIN migration with mandatory MFA required");
    if (user.role === "SUPERADMIN") return { changed: false };
    await tx.query("UPDATE users SET role='SUPERADMIN' WHERE id=$1", [user.id]);
    await tx.query(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [user.id],
    );
    await tx.query(
      "UPDATE auth_challenges SET used_at=now(),pending_secret=NULL WHERE user_id=$1 AND used_at IS NULL",
      [user.id],
    );
    await tx.query(
      `INSERT INTO audit_log(user_id,action,resource,resource_id,result,request_id,details)
      VALUES(NULL,'ROLE_CHANGED','users',$1,'SUCCESS',$2,$3)`,
      [
        user.id,
        randomUUID(),
        JSON.stringify({
          from: user.role,
          to: "SUPERADMIN",
          source: "operator:promote-owner",
          reason: "Owner-authorized role provisioning",
        }),
      ],
    );
    return { changed: true };
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [email, confirmation] = process.argv.slice(2);
  if (!email || confirmation !== "--apply" || process.argv.length !== 4)
    throw new Error(
      "Usage: db:promote-owner -- <confirmed-owner-email> --apply (after compatible deployment)",
    );
  loadEnv();
  const db = database(config());
  try {
    const result = await promoteOwner(db, email);
    process.stdout.write(
      result.changed
        ? "Owner promoted; previous sessions revoked. Login and MFA required.\n"
        : "Owner already SUPERADMIN; no changes.\n",
    );
  } finally {
    await db.end();
  }
}
