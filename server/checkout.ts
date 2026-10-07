import type { Express } from "express";
import { z } from "zod";
import type { auth } from "./auth.js";
import { transaction, type DB } from "./db.js";
import {
  audit,
  changed,
  fail,
  idempotent,
  identity,
  idSchema,
} from "./common.js";

export const centsSchema = z.number().int().min(0).max(1000000000);
export const receiverSchema = z
  .object({
    type: z.enum(["CF", "NIT", "CUI"]),
    id: z
      .string()
      .trim()
      .max(20)
      .transform((value) => value.toUpperCase().replace(/[\s/-]/g, "")),
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(300).default(""),
  })
  .strict()
  .superRefine((receiver, ctx) => {
    const valid =
      receiver.type === "CF"
        ? receiver.id === "CF"
        : receiver.type === "CUI"
          ? /^\d{13}$/.test(receiver.id)
          : /^\d{1,12}[\dK]$/.test(receiver.id);
    if (!valid)
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: "Identificación no válida para el tipo de receptor",
      });
  });
export const paymentSchema = z
  .object({
    orderId: idSchema,
    method: z.enum(["EFECTIVO", "TARJETA", "TRANSFERENCIA", "MIXTO"]),
    tenderedCents: centsSchema,
    cardCents: centsSchema.default(0),
    receiver: receiverSchema.default({
      type: "CF",
      id: "CF",
      name: "CONSUMIDOR FINAL",
      address: "",
    }),
    documentKind: z.enum(["COMPROBANTE", "FACTURA"]).default("COMPROBANTE"),
  })
  .strict();
export function paymentParts(
  due: number,
  input: z.infer<typeof paymentSchema>,
) {
  const mixed = input.method === "MIXTO";
  if (
    (mixed && (input.cardCents <= 0 || input.cardCents >= due)) ||
    (!mixed && input.cardCents !== 0)
  )
    fail(
      400,
      "INVALID_PAYMENT_SPLIT",
      "El pago mixto requiere efectivo y tarjeta mayores que cero y que sumen el total",
    );
  if (
    input.tenderedCents < due ||
    (!["EFECTIVO", "MIXTO"].includes(input.method) &&
      input.tenderedCents !== due)
  )
    fail(400, "INVALID_AMOUNT", "El importe no corresponde al total");
  return {
    mixedCard: mixed ? input.cardCents : 0,
    change: input.tenderedCents - due,
  };
}
const rangeSchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine(
    (v) =>
      v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400000,
    "El rango máximo es de 366 días",
  );

export function checkout(
  app: Express,
  db: DB,
  security: ReturnType<typeof auth>,
) {
  const p = security.permit;
  app.post(
    "/api/orders/:id/send-to-cash",
    p("orders.send_cash"),
    async (req, res) => {
      const id = idSchema.parse(req.params.id);
      const input = z
        .object({ version: z.number().int().positive() })
        .strict()
        .parse(req.body);
      const result = await transaction(db, (tx) =>
        idempotent(tx, req, `send-to-cash:${id}`, input, async () => {
          const o = (
            await tx.query<{
              id: string;
              user_id: string;
              paid_at: Date | null;
              status: string;
              version: number;
              sent_to_cash_at: Date | null;
            }>("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
          ).rows[0];
          if (!o) return fail(404, "NOT_FOUND", "Orden no encontrada");
          if (
            o.user_id !== identity(req).id &&
            !identity(req).permissions.includes("payments.create")
          )
            fail(403, "FORBIDDEN", "Solo puedes enviar tus órdenes a caja");
          if (o.paid_at || o.status === "CANCELADO")
            fail(
              409,
              "INVALID_ORDER_STATE",
              "La orden no puede enviarse a caja",
            );
          if (o.sent_to_cash_at) return o;
          if (o.version !== input.version)
            fail(409, "STALE_VERSION", "La orden cambió; revisa la cuenta");
          const updated = (
            await tx.query(
              "UPDATE orders SET sent_to_cash_at=now(),sent_to_cash_by=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
              [id, identity(req).id],
            )
          ).rows[0];
          await audit(tx, req, "ORDER_SENT_TO_CASH", "orders", id);
          await changed(tx);
          return updated;
        }),
      );
      res.json(result);
    },
  );
  app.post("/api/cash/close-request", p("cash.close"), async (req, res) => {
    const input = z
      .object({ shiftId: idSchema, countedCents: centsSchema })
      .strict()
      .parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "cash-close-request", input, async () => {
        const s = (
          await tx.query<{
            id: string;
            user_id: string;
            closed_at: Date | null;
            closure_requested_at: Date | null;
          }>("SELECT * FROM cash_shifts WHERE id=$1 FOR UPDATE", [
            input.shiftId,
          ])
        ).rows[0];
        if (!s || s.closed_at)
          return fail(409, "CASH_CLOSED", "La caja no está abierta");
        if (
          s.user_id !== identity(req).id &&
          !identity(req).permissions.includes("cash.close.approve")
        )
          fail(403, "FORBIDDEN", "La caja pertenece a otro usuario");
        if (s.closure_requested_at)
          fail(409, "CLOSURE_PENDING", "Ya hay una solicitud pendiente");
        const updated = (
          await tx.query(
            "UPDATE cash_shifts SET closure_request_id=gen_random_uuid(),closure_requested_by=$2,closure_requested_at=now(),closure_counted_cents=$3 WHERE id=$1 RETURNING *",
            [s.id, identity(req).id, input.countedCents],
          )
        ).rows[0];
        await audit(
          tx,
          req,
          "CASH_CLOSE_REQUESTED",
          "cash",
          s.id,
          "SUCCESS",
          undefined,
          { countedCents: input.countedCents },
        );
        await changed(tx);
        return updated;
      }),
    );
    res.status(201).json(result);
  });
  app.post(
    "/api/cash/reject-close",
    p("cash.close.approve"),
    async (req, res) => {
      const input = z
        .object({
          shiftId: idSchema,
          requestId: idSchema,
          reason: z.string().trim().min(3).max(300),
        })
        .strict()
        .parse(req.body);
      const result = await transaction(db, (tx) =>
        idempotent(tx, req, "cash-reject-close", input, async () => {
          const s = (
            await tx.query(
              "SELECT * FROM cash_shifts WHERE id=$1 AND closed_at IS NULL FOR UPDATE",
              [input.shiftId],
            )
          ).rows[0];
          if (!s?.closure_requested_at)
            return fail(
              409,
              "NO_CLOSURE_REQUEST",
              "No hay solicitud pendiente",
            );
          if (s.closure_request_id !== input.requestId)
            fail(409, "STALE_CLOSE_REQUEST", "La solicitud de cierre cambió");
          await tx.query(
            "UPDATE cash_shifts SET closure_request_id=NULL,closure_requested_by=NULL,closure_requested_at=NULL,closure_counted_cents=NULL WHERE id=$1",
            [input.shiftId],
          );
          await audit(
            tx,
            req,
            "CASH_CLOSE_REJECTED",
            "cash",
            input.shiftId,
            "SUCCESS",
            undefined,
            {
              reason: input.reason,
              requestedBy: String(s.closure_requested_by),
              countedCents: Number(s.closure_counted_cents),
            },
          );
          await changed(tx);
          return { ok: true };
        }),
      );
      res.json(result);
    },
  );
  app.get("/api/sales", p("payments.create"), async (req, res) => {
    const { before, limit } = z
      .object({
        before: idSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .strict()
      .parse(req.query);
    // Stable keyset; UUID is tie breaker, not chronological order by itself.
    const rows = (
      await db.query(
        `SELECT p.*,o.number,o.table_name,o.table_floor,u.name AS cashier
      FROM payments p JOIN orders o ON o.id=p.order_id JOIN users u ON u.id=p.user_id
      WHERE ($1::uuid IS NULL OR (p.created_at,p.id)<(SELECT created_at,id FROM payments WHERE id=$1))
      ORDER BY p.created_at DESC,p.id DESC LIMIT $2`,
        [before ?? null, limit + 1],
      )
    ).rows;
    res.json({
      items: rows.slice(0, limit),
      next: rows.length > limit ? rows[limit - 1].id : null,
    });
  });
  app.post("/api/orders/:id/print", p("payments.create"), async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = z.object({ copy: z.boolean() }).strict().parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, `receipt-print:${id}`, input, async () => {
        // Serialize print claims independently of immutable payment row updates.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `receipt:${id}`,
        ]);
        const payment = (
          await tx.query<{ id: string }>(
            "SELECT id FROM payments WHERE order_id=$1",
            [id],
          )
        ).rows[0];
        if (!payment)
          return fail(404, "NOT_FOUND", "Comprobante no disponible");
        const prior = (
          await tx.query(
            "SELECT 1 FROM receipt_prints WHERE payment_id=$1 LIMIT 1",
            [payment.id],
          )
        ).rowCount;
        const reprint = input.copy || !!prior;
        const record = (
          await tx.query(
            "INSERT INTO receipt_prints(payment_id,user_id,reprint) VALUES($1,$2,$3) RETURNING id,created_at,reprint",
            [payment.id, identity(req).id, reprint],
          )
        ).rows[0];
        await audit(
          tx,
          req,
          reprint ? "RECEIPT_REPRINT_REQUESTED" : "RECEIPT_PRINT_REQUESTED",
          "payments",
          payment.id,
        );
        return record;
      }),
    );
    res.json(result);
  });
  app.get("/api/fel/status", p("payments.create"), (_req, res) =>
    res.json({
      ready: false,
      status: "PENDING_CONFIGURATION",
      missing: [
        "CERTIFIER_ADAPTER",
        "ISSUER_TAX_CONFIGURATION",
        "SANDBOX_APPROVAL",
      ],
      message:
        "FEL requiere certificador, datos del emisor y validación en sandbox. No se emiten facturas fiscales todavía.",
    }),
  );
  app.post("/api/expenses", p("finance.write"), async (req, res) => {
    const input = z
      .object({
        kind: z.enum(["GASTO", "MERMA"]),
        amountCents: centsSchema.refine((n) => n > 0),
        description: z.string().trim().min(3).max(300),
        occurredOn: z.iso.date(),
      })
      .strict()
      .parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "expense", input, async () => {
        const entry = (
          await tx.query<{ id: string }>(
            "INSERT INTO expense_entries(user_id,kind,amount_cents,description,occurred_on) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [
              identity(req).id,
              input.kind,
              input.amountCents,
              input.description,
              input.occurredOn,
            ],
          )
        ).rows[0]!;
        await audit(
          tx,
          req,
          "EXPENSE_RECORDED",
          "expenses",
          entry.id,
          "SUCCESS",
          undefined,
          { kind: input.kind, amountCents: input.amountCents },
        );
        return entry;
      }),
    );
    res.status(201).json(result);
  });
  app.get("/api/finance/summary", p("reports.read"), async (req, res) => {
    const { from, to } = rangeSchema.parse(req.query);
    const result = await transaction(db, async (tx) => {
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const sales = await tx.query(
        `SELECT coalesce(sum(p.amount_cents),0) AS income_cents,coalesce(sum(p.cash_cents),0) AS cash_cents,
        coalesce(sum(p.card_cents),0) AS card_cents,coalesce(sum(p.transfer_cents),0) AS transfer_cents,
        coalesce(sum(o.courtesy_cents),0) AS courtesy_cents,count(*) AS transactions
        FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.created_at >= $1::date::timestamp AT TIME ZONE 'America/Guatemala' AND p.created_at < ($2::date+1)::timestamp AT TIME ZONE 'America/Guatemala'`,
        [from, to],
      );
      const expenses = await tx.query(
        "SELECT coalesce(sum(amount_cents) FILTER(WHERE kind='GASTO'),0) AS expense_cents,coalesce(sum(amount_cents) FILTER(WHERE kind='MERMA'),0) AS loss_cents FROM expense_entries WHERE occurred_on BETWEEN $1 AND $2",
        [from, to],
      );
      const entries = await tx.query(
        "SELECT e.*,u.name AS author FROM expense_entries e JOIN users u ON u.id=e.user_id WHERE occurred_on BETWEEN $1 AND $2 ORDER BY occurred_on DESC,e.created_at DESC LIMIT 100",
        [from, to],
      );
      const daily = await tx.query(
        "SELECT (created_at AT TIME ZONE 'America/Guatemala')::date::text AS day,sum(amount_cents) AS income_cents,count(*) AS transactions FROM payments WHERE created_at >= $1::date::timestamp AT TIME ZONE 'America/Guatemala' AND created_at < ($2::date+1)::timestamp AT TIME ZONE 'America/Guatemala' GROUP BY day ORDER BY day",
        [from, to],
      );
      const values = { ...sales.rows[0], ...expenses.rows[0] } as Record<
        string,
        string
      >;
      return {
        from,
        to,
        ...values,
        recorded_balance_cents:
          Number(values.income_cents) -
          Number(values.expense_cents) -
          Number(values.loss_cents),
        accountingComplete: false,
        entries: entries.rows,
        daily: daily.rows,
      };
    });
    res.json(result);
  });
}
