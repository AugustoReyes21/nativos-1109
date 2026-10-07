import type { Express, Request } from "express";
import { z } from "zod";
import { transaction, type DB, type TX } from "./db.js";
import {
  audit,
  changed,
  fail,
  idempotent,
  identity,
  idSchema,
} from "./common.js";
import { passwordHash, passwordSchema, total } from "./security.js";
import type { auth } from "./auth.js";
import {
  tableClaims,
  lockTables,
  assertTableAccess,
  releaseAfterOrder,
} from "./table-claims.js";

type Product = {
  id: string;
  name: string;
  price_cents: number;
  stock: number;
  active: boolean;
  version: number;
};
type Order = {
  id: string;
  user_id: string;
  status: string;
  total_cents: number;
  version: number;
};
type Shift = {
  id: string;
  user_id: string;
  opening_cents: number;
  closed_at: Date | null;
};
const name = z.string().trim().min(1).max(100);
const tableSchema = z
  .object({
    name,
    floor: z.number().int().min(1).max(2).default(1),
    capacity: z.number().int().min(1).max(12).default(4),
    shape: z.enum(["square", "round", "rectangle"]).default("square"),
    displayOrder: z.number().int().min(0).max(999).default(0),
  })
  .strict();
const cents = z.number().int().min(0).max(1000000000);
const itemsSchema = z
  .array(
    z
      .object({
        productId: idSchema,
        quantity: z.number().int().min(1).max(100),
        notes: z.string().trim().max(300).default(""),
      })
      .strict(),
  )
  .min(1)
  .max(50)
  .refine(
    (items) => new Set(items.map((i) => i.productId)).size === items.length,
    "Productos repetidos",
  );
const orderSchema = z
  .object({
    tableId: idSchema,
    claimId: idSchema.optional(),
    notes: z.string().trim().max(500).default(""),
    items: itemsSchema,
  })
  .strict();

async function shift(tx: TX, req: Request) {
  const s = (
    await tx.query<Shift>(
      "SELECT * FROM cash_shifts WHERE closed_at IS NULL FOR UPDATE",
    )
  ).rows[0];
  if (!s) return fail(409, "CASH_CLOSED", "Abre la caja antes de continuar");
  if (
    s.user_id !== identity(req).id &&
    !identity(req).permissions.includes("settings.manage")
  )
    fail(403, "FORBIDDEN", "La caja pertenece a otro usuario");
  return s;
}
async function ownedOrder(tx: TX, req: Request, id: string) {
  const o = (
    await tx.query<Order>("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (!o) return fail(404, "NOT_FOUND", "Orden no encontrada");
  if (
    identity(req).permissions.includes("orders.create") &&
    !identity(req).permissions.includes("payments.create") &&
    o.user_id !== identity(req).id
  )
    fail(403, "FORBIDDEN", "No puedes modificar esta orden");
  return o;
}

export function pos(app: Express, db: DB, security: ReturnType<typeof auth>) {
  const p = security.permit;
  app.use("/api", security.requireUser);
  tableClaims(app, db, security);
  app.get("/api/catalog", p("products.read"), async (_req, res) => {
    const [products, categories, tables] = await Promise.all([
      db.query("SELECT * FROM products ORDER BY name"),
      db.query("SELECT * FROM categories ORDER BY name"),
      db.query(
        "SELECT * FROM restaurant_tables WHERE active ORDER BY floor,display_order,name",
      ),
    ]);
    res.json({
      products: products.rows,
      categories: categories.rows,
      tables: tables.rows,
    });
  });
  app.get("/api/settings", async (_req, res) =>
    res.json(
      (
        await db.query(
          "SELECT name,currency,timezone FROM restaurant_settings WHERE id=1",
        )
      ).rows[0],
    ),
  );
  app.get("/api/tables/status", p("orders.read"), async (req, res) => {
    const me = identity(req);
    const result = await db.query(
      `WITH active AS (
      SELECT id,table_id,user_id,status,paid_at,total_cents,created_at FROM orders
      WHERE status IN ('PENDIENTE','EN_PREPARACION','LISTO')
      UNION ALL
      SELECT id,table_id,user_id,status,paid_at,total_cents,created_at FROM orders
      WHERE status='ENTREGADO' AND paid_at IS NULL
    ), claims AS (SELECT c.* FROM table_claims c JOIN sessions s ON s.id=c.session_id
      WHERE c.expires_at>clock_timestamp() AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
    SELECT t.id AS "tableId",
      CASE WHEN count(o.id)=0 THEN CASE WHEN c.table_id IS NOT NULL THEN 'reserved' ELSE 'available' END
        WHEN bool_or(o.status='LISTO') THEN 'ready'
        WHEN bool_or(o.status='ENTREGADO' AND o.paid_at IS NULL) THEN 'payment'
        ELSE 'service' END AS state,
      count(o.id)::int AS "openOrders", min(o.created_at) AS since,
      coalesce(bool_or(o.user_id=$1),false) AS mine,
      (coalesce(bool_or(o.user_id<>$1),false) OR (c.table_id IS NOT NULL AND (c.user_id<>$1 OR c.session_id<>$3))) AS "blocked",
      CASE WHEN c.user_id=$1 AND c.session_id=$3 THEN c.claim_id END AS "claimId",
      c.expires_at AS "claimExpiresAt",
      CASE WHEN $2 THEN coalesce(sum(o.total_cents) FILTER (WHERE o.paid_at IS NULL),0) END AS "pendingCents"
      FROM restaurant_tables t LEFT JOIN active o ON o.table_id=t.id LEFT JOIN claims c ON c.table_id=t.id WHERE t.active
      GROUP BY t.id,c.table_id,c.user_id,c.session_id,c.claim_id,c.expires_at ORDER BY t.floor,t.display_order,t.name`,
      [me.id, me.permissions.includes("payments.create"), me.sessionId],
    );
    res.json(
      result.rows.map(({ pendingCents, ...row }) =>
        me.permissions.includes("payments.create")
          ? { ...row, pendingCents: Number(pendingCents) }
          : row,
      ),
    );
  });
  app.patch("/api/settings", p("settings.manage"), async (req, res) => {
    const input = z.object({ name }).strict().parse(req.body);
    await transaction(db, async (tx) => {
      await tx.query("UPDATE restaurant_settings SET name=$1 WHERE id=1", [
        input.name,
      ]);
      await audit(tx, req, "SETTINGS_CHANGED", "settings", "1");
    });
    res.json({ ok: true });
  });
  for (const kind of ["categories"] as const) {
    const table = "categories";
    app.post(
      `/api/${kind}`,
      p(kind === "categories" ? "products.write" : "settings.manage"),
      async (req, res) => {
        const input = z.object({ name }).strict().parse(req.body);
        const result = await transaction(db, (tx) =>
          idempotent(tx, req, `create-${kind}`, input, async () => {
            // Table identifier comes exclusively from the constant whitelist above.
            const r = (
              await tx.query(
                `INSERT INTO ${table}(name) VALUES ($1) RETURNING *`,
                [input.name],
              )
            ).rows[0] as { id: string };
            await audit(tx, req, "CATALOG_CREATED", kind, r.id);
            await changed(tx);
            return r;
          }),
        );
        res.status(201).json(result);
      },
    );
  }
  app.post("/api/tables", p("settings.manage"), async (req, res) => {
    const input = tableSchema.parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "create-tables", input, async () => {
        const r = (
          await tx.query(
            `INSERT INTO restaurant_tables(name,floor,capacity,shape,display_order)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [
              input.name,
              input.floor,
              input.capacity,
              input.shape,
              input.displayOrder,
            ],
          )
        ).rows[0] as { id: string };
        await audit(
          tx,
          req,
          "TABLE_CREATED",
          "tables",
          r.id,
          "SUCCESS",
          undefined,
          input,
        );
        await changed(tx);
        return r;
      }),
    );
    res.status(201).json(result);
  });
  app.patch("/api/tables/:id", p("settings.manage"), async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = tableSchema
      .extend({ version: z.number().int().positive() })
      .parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "update-table:" + id, input, async () => {
        const r = await tx.query(
          `UPDATE restaurant_tables SET name=$1,floor=$2,capacity=$3,shape=$4,
        display_order=$5,version=version+1 WHERE id=$6 AND version=$7 AND active RETURNING *`,
          [
            input.name,
            input.floor,
            input.capacity,
            input.shape,
            input.displayOrder,
            id,
            input.version,
          ],
        );
        if (!r.rowCount)
          fail(
            409,
            "TABLE_CHANGED",
            "La mesa cambió. Actualiza antes de guardar",
          );
        await audit(
          tx,
          req,
          "TABLE_UPDATED",
          "tables",
          id,
          "SUCCESS",
          undefined,
          input,
        );
        await changed(tx);
        return r.rows[0];
      }),
    );
    res.json(result);
  });
  app.post("/api/products", p("products.write"), async (req, res) => {
    const input = z
      .object({
        name,
        categoryId: idSchema,
        priceCents: cents.min(1).max(10000000),
        stock: z.number().int().min(0).max(1000000),
      })
      .strict()
      .parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "create-product", input, async () => {
        const product = (
          await tx.query<Product>(
            "INSERT INTO products(name,category_id,price_cents,stock) VALUES ($1,$2,$3,$4) RETURNING *",
            [input.name, input.categoryId, input.priceCents, input.stock],
          )
        ).rows[0]!;
        await audit(tx, req, "PRODUCT_CREATED", "products", product.id);
        await changed(tx);
        return product;
      }),
    );
    res.status(201).json(result);
  });
  app.patch("/api/products/:id", p("products.write"), async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = z
      .object({
        name,
        categoryId: idSchema,
        priceCents: cents.min(1).max(10000000),
        stock: z.number().int().min(0).max(1000000),
        active: z.boolean(),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, `product:${id}`, input, async () => {
        const old = (
          await tx.query<Product>(
            "SELECT * FROM products WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!old) return fail(404, "NOT_FOUND", "Producto no encontrado");
        if (old.version !== input.version)
          return fail(
            409,
            "STALE_VERSION",
            "El producto cambió. Actualiza los datos",
          );
        const r = (
          await tx.query(
            "UPDATE products SET name=$1,category_id=$2,price_cents=$3,stock=$4,active=$5,version=version+1,updated_at=now() WHERE id=$6 RETURNING *",
            [
              input.name,
              input.categoryId,
              input.priceCents,
              input.stock,
              input.active,
              id,
            ],
          )
        ).rows[0];
        await audit(
          tx,
          req,
          old.price_cents === input.priceCents
            ? "PRODUCT_UPDATED"
            : "PRODUCT_PRICE_CHANGED",
          "products",
          id,
          "SUCCESS",
          undefined,
          {
            previousPriceCents: old.price_cents,
            priceCents: input.priceCents,
            previousStock: old.stock,
            stock: input.stock,
          },
        );
        await changed(tx);
        return r;
      }),
    );
    res.json(result);
  });
  app.get("/api/orders", p("orders.read"), async (req, res) => {
    const me = identity(req);
    const ownOnly =
      me.permissions.includes("orders.create") &&
      !me.permissions.includes("payments.create");
    const result = await db.query(
      // Each branch is index-backed; a single OR forced a scan of the full history.
      `WITH visible AS (
        SELECT id FROM orders WHERE ($1::uuid IS NULL OR user_id=$1)
          AND status IN ('PENDIENTE','EN_PREPARACION','LISTO')
        UNION
        SELECT id FROM orders WHERE ($1::uuid IS NULL OR user_id=$1)
          AND paid_at IS NULL AND status<>'CANCELADO'
        UNION
        (SELECT id FROM orders WHERE ($1::uuid IS NULL OR user_id=$1)
          AND status IN ('ENTREGADO','CANCELADO') AND created_at>now()-interval '24 hours'
          ORDER BY created_at DESC LIMIT 200))
      SELECT o.*,u.name AS waiter,
      (SELECT json_agg(i ORDER BY i.name) FROM order_items i WHERE i.order_id=o.id) AS items,
      o.paid_at IS NOT NULL AS paid
      FROM visible v JOIN orders o ON o.id=v.id
      JOIN users u ON u.id=o.user_id
      ORDER BY o.created_at`,
      [ownOnly ? me.id : null],
    );
    res.json(result.rows);
  });
  app.post("/api/orders", p("orders.create"), async (req, res) => {
    const input = orderSchema.parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(
        tx,
        req,
        "create-order",
        // Preserve the pre-lease canonical field order for existing retry hashes.
        { tableId: input.tableId, notes: input.notes, items: input.items },
        async () => {
          await lockTables(tx, [input.tableId]);
          await assertTableAccess(tx, req, input.tableId, input.claimId);
          const products = (
            await tx.query<Product>(
              "SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
              [input.items.map((i) => i.productId)],
            )
          ).rows;
          const items = input.items.map((item) => {
            const product = products.find((p) => p.id === item.productId);
            if (!product?.active || product.stock < item.quantity)
              return fail(
                409,
                "PRODUCT_OUT_OF_STOCK",
                "El producto ya no está disponible",
              );
            return {
              ...item,
              name: product.name,
              price_cents: product.price_cents,
            };
          });
          const order = (
            await tx.query<Order>(
              "INSERT INTO orders(table_id,user_id,total_cents,notes) VALUES ($1,$2,$3,$4) RETURNING *",
              [input.tableId, identity(req).id, total(items), input.notes],
            )
          ).rows[0]!;
          for (const item of items) {
            await tx.query(
              "UPDATE products SET stock=stock-$1,version=version+1,updated_at=now() WHERE id=$2",
              [item.quantity, item.productId],
            );
            await tx.query(
              "INSERT INTO order_items(order_id,product_id,name,quantity,price_cents,notes) VALUES ($1,$2,$3,$4,$5,$6)",
              [
                order.id,
                item.productId,
                item.name,
                item.quantity,
                item.price_cents,
                item.notes,
              ],
            );
          }
          await audit(
            tx,
            req,
            "ORDER_CREATED",
            "orders",
            order.id,
            "SUCCESS",
            undefined,
            {
              tableId: input.tableId,
              totalCents: order.total_cents,
              items: items.length,
            },
          );
          await releaseAfterOrder(tx, req, input.tableId, input.claimId);
          await changed(tx);
          return order;
        },
      ),
    );
    res.status(201).json(result);
  });
  app.patch("/api/orders/:id/status", p("orders.read"), async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = z
      .object({
        status: z.enum(["EN_PREPARACION", "LISTO", "ENTREGADO", "CANCELADO"]),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(req.body);
    const me = identity(req);
    const permission =
      input.status === "CANCELADO"
        ? "orders.cancel"
        : input.status === "ENTREGADO"
          ? "orders.update"
          : "kitchen.update";
    if (!me.permissions.includes(permission))
      fail(403, "FORBIDDEN", "No tienes permiso para esta acción");
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, `status:${id}`, input, async () => {
        const o = await ownedOrder(tx, req, id);
        if (o.version !== input.version)
          fail(409, "STALE_VERSION", "La orden cambió. Actualiza los datos");
        if (input.status === "CANCELADO") {
          if (
            !["PENDIENTE", "EN_PREPARACION", "LISTO"].includes(o.status) ||
            (await tx.query("SELECT id FROM payments WHERE order_id=$1", [id]))
              .rowCount
          )
            fail(409, "INVALID_ORDER_STATE", "Esta orden no se puede cancelar");
          // Prepared food is not silently returned to sellable stock.
          if (o.status === "PENDIENTE") {
            const items = (
              await tx.query<{ product_id: string; quantity: number }>(
                "SELECT product_id,quantity FROM order_items WHERE order_id=$1 ORDER BY product_id",
                [id],
              )
            ).rows;
            await tx.query(
              "SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
              [items.map((i) => i.product_id)],
            );
            for (const i of items)
              await tx.query(
                "UPDATE products SET stock=stock+$1,version=version+1 WHERE id=$2",
                [i.quantity, i.product_id],
              );
          }
        } else {
          const transitions: Record<string, string> = {
            PENDIENTE: "EN_PREPARACION",
            EN_PREPARACION: "LISTO",
            LISTO: "ENTREGADO",
          };
          if (transitions[o.status] !== input.status)
            fail(409, "INVALID_ORDER_STATE", "Cambio de estado no permitido");
        }
        const updated = (
          await tx.query(
            "UPDATE orders SET status=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
            [input.status, id],
          )
        ).rows[0];
        await audit(
          tx,
          req,
          input.status === "CANCELADO"
            ? "ORDER_CANCELLED"
            : "ORDER_STATUS_CHANGED",
          "orders",
          id,
          "SUCCESS",
          undefined,
          { from: o.status, to: input.status, totalCents: o.total_cents },
        );
        await changed(tx);
        return updated;
      }),
    );
    res.json(result);
  });
  app.get("/api/cash", p("cash.read"), async (_req, res) => {
    const result = await db.query(`SELECT s.*,
      s.opening_cents+COALESCE((SELECT sum(amount_cents) FROM payments WHERE shift_id=s.id AND method='EFECTIVO'),0)
      +COALESCE((SELECT sum(amount_cents) FROM cash_movements WHERE shift_id=s.id),0) AS current_expected_cents
      FROM cash_shifts s ORDER BY opened_at DESC LIMIT 20`);
    res.json(result.rows);
  });
  app.post("/api/cash/open", p("cash.open"), async (req, res) => {
    const input = z.object({ openingCents: cents }).strict().parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "cash-open", input, async () => {
        const s = (
          await tx.query<Shift>(
            "INSERT INTO cash_shifts(user_id,opening_cents) VALUES ($1,$2) RETURNING *",
            [identity(req).id, input.openingCents],
          )
        ).rows[0]!;
        await audit(
          tx,
          req,
          "CASH_REGISTER_OPENED",
          "cash",
          s.id,
          "SUCCESS",
          undefined,
          { openingCents: input.openingCents },
        );
        await changed(tx);
        return s;
      }),
    );
    res.status(201).json(result);
  });
  app.post("/api/cash/movements", p("cash.move"), async (req, res) => {
    const input = z
      .object({
        amountCents: z
          .number()
          .int()
          .min(-1000000000)
          .max(1000000000)
          .refine((n) => n !== 0),
        reason: z.string().trim().min(3).max(300),
      })
      .strict()
      .parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "cash-movement", input, async () => {
        const s = await shift(tx, req);
        const r = (
          await tx.query<{ id: string }>(
            "INSERT INTO cash_movements(shift_id,user_id,amount_cents,reason) VALUES ($1,$2,$3,$4) RETURNING *",
            [s.id, identity(req).id, input.amountCents, input.reason],
          )
        ).rows[0]!;
        await audit(
          tx,
          req,
          "CASH_MOVEMENT_CREATED",
          "cash_movements",
          r.id,
          "SUCCESS",
          undefined,
          {
            shiftId: s.id,
            amountCents: input.amountCents,
            reason: input.reason,
          },
        );
        await changed(tx);
        return r;
      }),
    );
    res.status(201).json(result);
  });
  app.post("/api/cash/close", p("cash.close"), async (req, res) => {
    const input = z
      .object({ countedCents: cents, shiftId: idSchema })
      .strict()
      .parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "cash-close", input, async () => {
        const s = await shift(tx, req);
        if (s.id !== input.shiftId) fail(409, "STALE_SHIFT", "La caja cambió");
        const sales = (
          await tx.query<{ n: string }>(
            "SELECT COALESCE(sum(amount_cents),0) AS n FROM payments WHERE shift_id=$1 AND method='EFECTIVO'",
            [s.id],
          )
        ).rows[0]!;
        const movements = (
          await tx.query<{ n: string }>(
            "SELECT COALESCE(sum(amount_cents),0) AS n FROM cash_movements WHERE shift_id=$1",
            [s.id],
          )
        ).rows[0]!;
        const expected =
          s.opening_cents + Number(sales.n) + Number(movements.n);
        const r = (
          await tx.query(
            "UPDATE cash_shifts SET closed_at=now(),counted_cents=$1,expected_cents=$2,difference_cents=$3 WHERE id=$4 RETURNING *",
            [input.countedCents, expected, input.countedCents - expected, s.id],
          )
        ).rows[0];
        await audit(
          tx,
          req,
          "CASH_REGISTER_CLOSED",
          "cash",
          s.id,
          "SUCCESS",
          undefined,
          {
            expectedCents: expected,
            countedCents: input.countedCents,
            differenceCents: input.countedCents - expected,
          },
        );
        await changed(tx);
        return r;
      }),
    );
    res.json(result);
  });
  app.post("/api/payments", p("payments.create"), async (req, res) => {
    const input = z
      .object({
        orderId: idSchema,
        method: z.enum(["EFECTIVO", "TARJETA", "TRANSFERENCIA"]),
        tenderedCents: cents,
      })
      .strict()
      .parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "payment", input, async () => {
        const s = await shift(tx, req);
        const o = await ownedOrder(tx, req, input.orderId);
        if (o.status === "CANCELADO")
          fail(
            409,
            "INVALID_ORDER_STATE",
            "No se puede cobrar una orden cancelada",
          );
        if (
          (await tx.query("SELECT id FROM payments WHERE order_id=$1", [o.id]))
            .rowCount
        )
          fail(409, "ALREADY_PAID", "La orden ya fue cobrada");
        if (
          input.tenderedCents < o.total_cents ||
          (input.method !== "EFECTIVO" && input.tenderedCents !== o.total_cents)
        )
          fail(400, "INVALID_AMOUNT", "El importe no corresponde al total");
        const payment = (
          await tx.query<{ id: string }>(
            "INSERT INTO payments(order_id,shift_id,user_id,method,amount_cents,tendered_cents,change_cents) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              o.id,
              s.id,
              identity(req).id,
              input.method,
              o.total_cents,
              input.tenderedCents,
              input.tenderedCents - o.total_cents,
            ],
          )
        ).rows[0]!;
        await audit(
          tx,
          req,
          "PAYMENT_CREATED",
          "payments",
          payment.id,
          "SUCCESS",
          undefined,
          {
            orderId: o.id,
            shiftId: s.id,
            method: input.method,
            amountCents: o.total_cents,
            tenderedCents: input.tenderedCents,
          },
        );
        await changed(tx);
        return payment;
      }),
    );
    res.status(201).json(result);
  });
  app.get("/api/orders/:id/receipt", p("payments.create"), async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const payment = (
      await db.query(
        "SELECT p.*,o.number,o.notes,o.table_name,o.table_floor FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.order_id=$1",
        [id],
      )
    ).rows[0];
    if (!payment) fail(404, "NOT_FOUND", "Comprobante no disponible");
    res.json({
      payment,
      items: (
        await db.query(
          "SELECT name,quantity,price_cents,notes FROM order_items WHERE order_id=$1",
          [id],
        )
      ).rows,
      fiscal: false,
    });
  });
  app.get("/api/reports", p("reports.read"), async (_req, res) => {
    res.json(
      (
        await db.query(
          "SELECT (created_at AT TIME ZONE 'America/Guatemala')::date AS day,method,count(*) AS sales,sum(amount_cents) AS total_cents FROM payments GROUP BY day,method ORDER BY day DESC LIMIT 90",
        )
      ).rows,
    );
  });
  app.get("/api/audit", p("audit.read"), async (_req, res) =>
    res.json(
      (await db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 100"))
        .rows,
    ),
  );
  app.get("/api/users", p("users.manage"), async (_req, res) =>
    res.json(
      (
        await db.query(
          "SELECT id,name,email,role,active,mfa_enabled FROM users ORDER BY name",
        )
      ).rows,
    ),
  );
  app.get("/api/roles", p("users.manage"), async (_req, res) =>
    res.json({
      roles: (await db.query("SELECT * FROM roles ORDER BY name")).rows,
      permissions: (
        await db.query(
          "SELECT * FROM role_permissions ORDER BY role,permission",
        )
      ).rows,
    }),
  );
  app.post("/api/users", p("users.manage"), async (req, res) => {
    const input = z
      .object({
        name,
        email: z
          .email()
          .max(254)
          .transform((v) => v.toLowerCase()),
        password: passwordSchema,
        role: name,
      })
      .strict()
      .parse(req.body);
    const hash = await passwordHash(input.password);
    const result = await transaction(db, async (tx) => {
      const u = (
        await tx.query<{ id: string }>(
          "INSERT INTO users(name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role,active",
          [input.name, input.email, hash, input.role],
        )
      ).rows[0]!;
      await audit(tx, req, "USER_CREATED", "users", u.id);
      return u;
    });
    res.status(201).json(result);
  });
  app.patch("/api/users/:id", p("users.manage"), async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const input = z
      .object({ role: name, active: z.boolean() })
      .strict()
      .parse(req.body);
    if (id === identity(req).id)
      fail(
        400,
        "SELF_CHANGE_FORBIDDEN",
        "Otro administrador debe modificar tu acceso",
      );
    const result = await transaction(db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(1109003)");
      const previous = (
        await tx.query<{ role: string; active: boolean; mfa_enabled: boolean }>(
          "SELECT role,active,mfa_enabled FROM users WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (
        previous?.role === "ADMINISTRADOR" &&
        previous.active &&
        previous.mfa_enabled &&
        (input.role !== "ADMINISTRADOR" || !input.active)
      ) {
        const remaining = await tx.query(
          "SELECT id FROM users WHERE role='ADMINISTRADOR' AND active AND mfa_enabled AND id<>$1 LIMIT 1",
          [id],
        );
        if (!remaining.rowCount)
          fail(
            409,
            "LAST_ADMIN",
            "Debe permanecer un administrador activo con MFA",
          );
      }
      const u = (
        await tx.query(
          "UPDATE users SET role=$1,active=$2 WHERE id=$3 RETURNING id,name,email,role,active",
          [input.role, input.active, id],
        )
      ).rows[0];
      if (!u) fail(404, "NOT_FOUND", "Usuario no encontrado");
      await tx.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
        id,
      ]);
      await tx.query(
        "UPDATE auth_challenges SET used_at=now(),pending_secret=NULL WHERE user_id=$1",
        [id],
      );
      await audit(tx, req, "ROLE_CHANGED", "users", id, "SUCCESS", undefined, {
        previousRole: previous?.role ?? null,
        role: input.role,
        active: input.active,
      });
      return u;
    });
    res.json(result);
  });
}
