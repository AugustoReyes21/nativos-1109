import type { Express, Request } from "express";
import { z } from "zod";
import { transaction, type DB, type TX } from "./db.js";
import { audit, changed, fail, identity, idSchema } from "./common.js";
import type { auth } from "./auth.js";
const claimInput = z.object({ claimId: idSchema }).strict();
const acquireInput = claimInput.extend({
  previous: z
    .object({ tableId: idSchema, claimId: idSchema })
    .strict()
    .optional(),
});
type Claim = {
  claim_id: string;
  user_id: string;
  session_id: string;
  expires_at: Date;
  live: boolean;
};
export async function lockTables(tx: TX, ids: string[]) {
  const result = await tx.query<{ id: string }>(
    "SELECT id FROM restaurant_tables WHERE id=ANY($1::uuid[]) AND active ORDER BY id FOR UPDATE",
    [ids],
  );
  if (result.rowCount !== new Set(ids).size)
    fail(400, "INVALID_TABLE", "Mesa no disponible");
}
async function current(tx: TX, id: string) {
  return (
    await tx.query<Claim>(
      `SELECT c.*, (c.expires_at>clock_timestamp() AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) AS live
    FROM table_claims c JOIN sessions s ON s.id=c.session_id WHERE c.table_id=$1`,
      [id],
    )
  ).rows[0];
}
async function foreignOrders(tx: TX, id: string, userId: string) {
  return (
    await tx.query(
      `SELECT 1 FROM orders WHERE table_id=$1 AND user_id<>$2 AND
    (status IN ('PENDIENTE','EN_PREPARACION','LISTO') OR (status='ENTREGADO' AND paid_at IS NULL)) LIMIT 1`,
      [id, userId],
    )
  ).rowCount;
}
const occupied = () =>
  fail(
    409,
    "TABLE_IN_USE",
    "Esta mesa está siendo atendida por otro mesero o en otra sesión",
  );
const expired = () =>
  fail(
    409,
    "TABLE_CLAIM_EXPIRED",
    "La reserva de la mesa venció. Vuelve a seleccionarla antes de enviar",
  );
// Caller holds table row lock. Legacy order clients cannot bypass foreign leases.
export async function assertTableAccess(
  tx: TX,
  req: Request,
  id: string,
  claimId?: string,
) {
  const me = identity(req);
  const claim = await current(tx, id);
  if (
    claim?.live &&
    (claim.user_id !== me.id || claim.session_id !== me.sessionId)
  )
    occupied();
  if (await foreignOrders(tx, id, me.id)) occupied();
  if (
    claimId &&
    (!claim?.live || claim.claim_id !== claimId || claim.user_id !== me.id)
  )
    expired();
}
export async function releaseAfterOrder(
  tx: TX,
  req: Request,
  id: string,
  claimId?: string,
) {
  if (!claimId) return;
  await tx.query(
    "UPDATE table_claims SET expires_at=clock_timestamp() WHERE table_id=$1 AND claim_id=$2 AND user_id=$3 AND session_id=$4",
    [id, claimId, identity(req).id, identity(req).sessionId],
  );
}
export function tableClaims(
  app: Express,
  db: DB,
  security: ReturnType<typeof auth>,
) {
  app.post(
    "/api/tables/:id/claim",
    security.permit("orders.create"),
    async (req, res) => {
      const id = idSchema.parse(req.params.id);
      const input = acquireInput.parse(req.body);
      const me = identity(req);
      const result = await transaction(db, async (tx) => {
        // Sorted table locks prevent deadlocks when two users change tables.
        await lockTables(
          tx,
          input.previous ? [id, input.previous.tableId] : [id],
        );
        const old = await current(tx, id);
        if (
          old?.live &&
          (old.user_id !== me.id ||
            old.session_id !== me.sessionId ||
            old.claim_id !== input.claimId)
        )
          occupied();
        if (old && !old.live && old.claim_id === input.claimId) expired();
        if (await foreignOrders(tx, id, me.id)) occupied();
        if (input.previous && input.previous.tableId !== id) {
          await tx.query(
            "UPDATE table_claims SET expires_at=clock_timestamp() WHERE table_id=$1 AND claim_id=$2 AND user_id=$3 AND session_id=$4",
            [
              input.previous.tableId,
              input.previous.claimId,
              me.id,
              me.sessionId,
            ],
          );
        }
        const r = (
          await tx.query<{ expires_at: Date }>(
            `INSERT INTO table_claims(table_id,claim_id,user_id,session_id,expires_at)
        VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes') ON CONFLICT(table_id) DO UPDATE SET
        claim_id=EXCLUDED.claim_id,user_id=EXCLUDED.user_id,session_id=EXCLUDED.session_id,
        expires_at=EXCLUDED.expires_at,created_at=CASE WHEN table_claims.claim_id=EXCLUDED.claim_id THEN table_claims.created_at ELSE clock_timestamp() END RETURNING expires_at`,
            [id, input.claimId, me.id, me.sessionId],
          )
        ).rows[0]!;
        if (!old?.live) await audit(tx, req, "TABLE_CLAIMED", "tables", id);
        await changed(tx);
        return { claimId: input.claimId, expiresAt: r.expires_at };
      });
      res.json(result);
    },
  );
  app.post(
    "/api/tables/:id/claim/renew",
    security.permit("orders.create"),
    async (req, res) => {
      const id = idSchema.parse(req.params.id);
      const input = claimInput.parse(req.body);
      const result = await transaction(db, async (tx) => {
        await lockTables(tx, [id]);
        await assertTableAccess(tx, req, id, input.claimId);
        const r = await tx.query<{ expires_at: Date }>(
          "UPDATE table_claims SET expires_at=clock_timestamp()+interval '5 minutes' WHERE table_id=$1 AND claim_id=$2 RETURNING expires_at",
          [id, input.claimId],
        );
        return { claimId: input.claimId, expiresAt: r.rows[0]!.expires_at };
      });
      res.json(result);
    },
  );
  app.post(
    "/api/tables/:id/claim/release",
    security.permit("orders.create"),
    async (req, res) => {
      const id = idSchema.parse(req.params.id);
      const input = claimInput.parse(req.body);
      await transaction(db, async (tx) => {
        await lockTables(tx, [id]);
        const r = await tx.query(
          "UPDATE table_claims SET expires_at=clock_timestamp() WHERE table_id=$1 AND claim_id=$2 AND user_id=$3 AND session_id=$4 AND expires_at>clock_timestamp() RETURNING table_id",
          [id, input.claimId, identity(req).id, identity(req).sessionId],
        );
        if (r.rowCount) {
          await audit(tx, req, "TABLE_RELEASED", "tables", id);
          await changed(tx);
        }
      });
      res.json({ ok: true });
    },
  );
}
