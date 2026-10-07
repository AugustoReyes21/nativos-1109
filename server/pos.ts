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
  app.get("/api/catalog", p("products.read"), async (_req, res) => {
    const [products, categories, tables] = await Promise.all([
      db.query("SELECT * FROM products ORDER BY name"),
      db.query("SELECT * FROM categories ORDER BY name"),
      db.query("SELECT * FROM restaurant_tables WHERE active ORDER BY name"),
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
  for (const kind of ["categories", "tables"] as const) {
    const table = kind === "categories" ? "categories" : "restaurant_tables";
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
      `SELECT o.*,t.name AS table_name,u.name AS waiter,
      (SELECT json_agg(i ORDER BY i.name) FROM order_items i WHERE i.order_id=o.id) AS items,
      EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id) AS paid
      FROM orders o JOIN restaurant_tables t ON t.id=o.table_id JOIN users u ON u.id=o.user_id
      WHERE ($1::uuid IS NULL OR o.user_id=$1) AND (o.created_at>now()-interval '24 hours' OR o.status IN ('PENDIENTE','EN_PREPARACION','LISTO'))
      ORDER BY o.created_at LIMIT 200`,
      [ownOnly ? me.id : null],
    );
    res.json(result.rows);
  });
  app.post("/api/orders", p("orders.create"), async (req, res) => {
    const input = orderSchema.parse(req.body);
    const result = await transaction(db, (tx) =>
      idempotent(tx, req, "create-order", input, async () => {
        if (
          !(
            await tx.query(
              "SELECT id FROM restaurant_tables WHERE id=$1 AND active FOR SHARE",
              [input.tableId],
            )
          ).rowCount
        )
          fail(400, "INVALID_TABLE", "Mesa no disponible");
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
        await audit(tx, req, "ORDER_CREATED", "orders", order.id);
        await changed(tx);
        return order;
      }),
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
        await audit(tx, req, "CASH_REGISTER_OPENED", "cash", s.id);
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
        await audit(tx, req, "CASH_MOVEMENT_CREATED", "cash_movements", r.id);
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
        await audit(tx, req, "CASH_REGISTER_CLOSED", "cash", s.id);
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
        await audit(tx, req, "PAYMENT_CREATED", "payments", payment.id);
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
        "SELECT p.*,o.number,o.notes,t.name AS table_name FROM payments p JOIN orders o ON o.id=p.order_id JOIN restaurant_tables t ON t.id=o.table_id WHERE p.order_id=$1",
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
      await audit(tx, req, "ROLE_CHANGED", "users", id);
      return u;
    });
    res.json(result);
  });
}
