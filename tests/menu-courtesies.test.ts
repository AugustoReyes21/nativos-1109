import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { csrfPost, seedUsers, testDatabase, testPassword } from "./helpers.js";
import { totp } from "../server/security.js";
import { migrate } from "../server/migrate.js";
import { promoteOwner } from "../server/promote-owner.js";

describe("PDF menu, privileged owner and courtesy ledger", () => {
  let ctx: Awaited<ReturnType<typeof testDatabase>>;
  let server: ReturnType<typeof createApp>;
  let admin: ReturnType<typeof request.agent>;
  let owner: ReturnType<typeof request.agent>;
  let waiter: ReturnType<typeof request.agent>;
  let cashier: ReturnType<typeof request.agent>;
  let productId: string;
  let tableId: string;
  let shiftId: string;
  const post = (
    agent: ReturnType<typeof request.agent>,
    path: string,
    body: object,
    key = randomUUID(),
  ) => csrfPost(agent, "post", path, body, key);
  const patch = (
    agent: ReturnType<typeof request.agent>,
    path: string,
    body: object,
  ) => csrfPost(agent, "patch", path, body, randomUUID());
  const order = async (quantity = 2) => {
    const result = await post(waiter, "/api/orders", {
      tableId,
      items: [{ productId, quantity }],
    });
    expect(result.status).toBe(201);
    return result.body as { id: string; version: number };
  };
  const gift = (o: { id: string; version: number }, quantity = 1) => ({
    orderId: o.id,
    version: o.version,
    reason: "Atención de la casa",
    items: [{ productId, quantity }],
  });
  beforeAll(async () => {
    ctx = await testDatabase();
    const hash = await seedUsers(ctx.db);
    await ctx.db.query(
      "INSERT INTO users(name,email,password_hash,role) VALUES('Owner','owner@example.test',$1,'MESERO')",
      [hash],
    );
    server = createApp(ctx.db, ctx.c, async () => undefined);
    admin = request.agent(server.app);
    owner = request.agent(server.app);
    waiter = request.agent(server.app);
    cashier = request.agent(server.app);
    for (const [agent, email] of [
      [admin, "administrador@example.test"],
      [waiter, "mesero@example.test"],
      [cashier, "cajero@example.test"],
      [owner, "owner@example.test"],
    ] as const) {
      expect(
        (
          await post(agent, "/api/auth/login", {
            email,
            password: testPassword,
          })
        ).status,
      ).toBe(200);
    }
    const setup = await post(admin, "/api/auth/mfa/setup", {});
    expect(
      (
        await post(admin, "/api/auth/mfa/verify", {
          code: totp(setup.body.secret as string).generate(),
        })
      ).status,
    ).toBe(200);
    tableId = (
      await post(admin, "/api/tables", { name: "Menu test", floor: 2 })
    ).body.id as string;
    productId = (
      await ctx.db.query(
        "SELECT id FROM products WHERE catalog_code='NAT-ES-HAMB'",
      )
    ).rows[0].id as string;
  });
  afterAll(async () => {
    server?.closeStreams();
    await ctx?.db.end();
  });

  it("imports all 20 PDF prices, five categories, descriptions and zero initial stock", async () => {
    const menu = await ctx.db.query(
      "SELECT catalog_code,price_cents,stock FROM products WHERE catalog_code IS NOT NULL ORDER BY catalog_code",
    );
    expect(menu.rows).toHaveLength(20);
    expect(menu.rows.every((p) => p.stock === 0)).toBe(true);
    expect(
      Object.fromEntries(menu.rows.map((p) => [p.catalog_code, p.price_cents])),
    ).toEqual({
      "NAT-FR-MOKA": 2500,
      "NAT-FR-OREO": 3000,
      "NAT-FR-CHOCO": 2500,
      "NAT-FR-MANIA": 3000,
      "NAT-SL-FRESA": 3000,
      "NAT-SL-MORA": 3000,
      "NAT-SE-FRESA": 3500,
      "NAT-SE-PEPINO": 3500,
      "NAT-SE-PINA": 3500,
      "NAT-SE-SANDIA": 3500,
      "NAT-ES-TOSTADA": 3500,
      "NAT-ES-PAN": 3500,
      "NAT-ES-TACOS": 4000,
      "NAT-ES-HAMB": 4000,
      "NAT-ES-QUESAB": 4000,
      "NAT-ES-QUESAD": 4000,
      "NAT-CR-BANANO": 3000,
      "NAT-CR-MIXTA": 3500,
      "NAT-CR-MELOC": 3500,
      "NAT-CR-FRESA": 4000,
    });
    const catalog = await waiter.get("/api/catalog");
    expect(catalog.body.categories).toHaveLength(5);
    expect(
      catalog.body.products.find((p: { id: string }) => p.id === productId)
        .description,
    ).toContain("papas fritas");
    expect(
      (
        await post(waiter, "/api/orders", {
          tableId,
          items: [{ productId, quantity: 1 }],
        })
      ).status,
    ).toBe(409);
    const product = catalog.body.products.find(
      (p: { id: string }) => p.id === productId,
    );
    expect(
      (
        await patch(admin, `/api/products/${productId}`, {
          name: product.name,
          categoryId: product.category_id,
          priceCents: 4000,
          stock: 100,
          active: true,
          version: product.version,
        })
      ).status,
    ).toBe(200);
    await migrate(ctx.db);
    expect(
      (
        await ctx.db.query("SELECT stock FROM products WHERE id=$1", [
          productId,
        ])
      ).rows[0].stock,
    ).toBe(100);
  });

  it("promotes only an existing active account, revokes sessions and enforces SUPERADMIN MFA", async () => {
    await expect(promoteOwner(ctx.db, "absent@example.test")).rejects.toThrow(
      "Active existing",
    );
    expect(await promoteOwner(ctx.db, "owner@example.test")).toEqual({
      changed: true,
    });
    expect(await promoteOwner(ctx.db, "owner@example.test")).toEqual({
      changed: false,
    });
    expect((await owner.get("/api/catalog")).status).toBe(401);
    expect(
      (
        await post(owner, "/api/auth/login", {
          email: "owner@example.test",
          password: testPassword,
        })
      ).status,
    ).toBe(200);
    expect((await owner.get("/api/catalog")).status).toBe(401);
    const setup = await post(owner, "/api/auth/mfa/setup", {});
    expect(setup.status).toBe(200);
    const verified = await post(owner, "/api/auth/mfa/verify", {
      code: totp(setup.body.secret as string).generate(),
    });
    expect(verified.status).toBe(200);
    const disabled = await post(owner, "/api/auth/mfa/disable", {
      password: testPassword,
      code: verified.body.recoveryCodes[0],
    });
    expect(disabled.status).toBe(403);
    expect(disabled.body.error.code).toBe("MFA_REQUIRED");
    for (const path of [
      "/api/catalog",
      "/api/orders",
      "/api/cash",
      "/api/users",
      "/api/reports",
      "/api/audit",
    ])
      expect((await owner.get(path)).status).toBe(200);
    const missing = await ctx.db.query(
      "SELECT name FROM permissions EXCEPT SELECT permission FROM role_permissions WHERE role='SUPERADMIN'",
    );
    expect(missing.rows).toEqual([]);
    expect(
      (
        await ctx.db.query(
          "SELECT count(*) FROM audit_log WHERE action='ROLE_CHANGED' AND details->>'source'='operator:promote-owner'",
        )
      ).rows[0].count,
    ).toBe("1");
  });

  it("prevents administrator escalation or changing the superadmin account", async () => {
    expect(
      (
        await post(admin, "/api/users", {
          name: "Bad",
          email: "bad@example.test",
          password: testPassword,
          role: "SUPERADMIN",
        })
      ).status,
    ).toBe(403);
    const id = (
      await ctx.db.query(
        "SELECT id FROM users WHERE email='owner@example.test'",
      )
    ).rows[0].id as string;
    expect(
      (await patch(admin, `/api/users/${id}`, { role: "MESERO", active: true }))
        .status,
    ).toBe(403);
    expect(
      (
        await patch(admin, `/api/users/${id}`, {
          role: "SUPERADMIN",
          active: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (await admin.get("/api/roles")).body.roles.some(
        (r: { name: string }) => r.name === "SUPERADMIN",
      ),
    ).toBe(false);
    expect(
      (await owner.get("/api/roles")).body.roles.some(
        (r: { name: string }) => r.name === "SUPERADMIN",
      ),
    ).toBe(true);
  });

  it("requires authorization, an open register and a reason; rejects client-supplied prices", async () => {
    const o = await order();
    expect((await post(waiter, "/api/courtesies", gift(o))).status).toBe(403);
    expect((await post(cashier, "/api/courtesies", gift(o))).status).toBe(403);
    expect(
      (await post(owner, "/api/courtesies", gift(o))).body.error.code,
    ).toBe("CASH_CLOSED");
    const opened = await post(cashier, "/api/cash/open", {
      openingCents: 10000,
    });
    expect(opened.status).toBe(201);
    shiftId = opened.body.id as string;
    expect(
      (await post(owner, "/api/courtesies", { ...gift(o), reason: " " }))
        .status,
    ).toBe(400);
    expect(
      (await post(owner, "/api/courtesies", { ...gift(o), amountCents: 1 }))
        .status,
    ).toBe(400);
    expect((await post(owner, "/api/courtesies", gift(o, 3))).status).toBe(409);
    expect(
      (
        await ctx.db.query("SELECT courtesy_cents FROM orders WHERE id=$1", [
          o.id,
        ])
      ).rows[0].courtesy_cents,
    ).toBe(0);
  });

  it("records partial gifts once, preserves gross/stock, charges net and audits the authorization", async () => {
    const o = await order();
    const stock = (
      await ctx.db.query("SELECT stock FROM products WHERE id=$1", [productId])
    ).rows[0].stock;
    const key = randomUUID();
    const data = gift(o);
    const first = await post(owner, "/api/courtesies", data, key);
    expect(first.status).toBe(201);
    expect(first.body.amount_cents).toBe(4000);
    expect((await post(owner, "/api/courtesies", data, key)).body).toEqual(
      first.body,
    );
    const current = (await owner.get("/api/orders")).body.find(
      (r: { id: string }) => r.id === o.id,
    );
    expect(current).toMatchObject({
      total_cents: 8000,
      courtesy_cents: 4000,
      paid: false,
      version: 2,
    });
    expect(current.items[0].courtesy_quantity).toBe(1);
    expect(
      (
        await patch(owner, `/api/orders/${o.id}/status`, {
          version: 2,
          status: "CANCELADO",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(cashier, "/api/payments", {
          orderId: o.id,
          method: "TARJETA",
          tenderedCents: 8000,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(waiter, `/api/orders/${o.id}/send-to-cash`, {
          version: current.version,
        })
      ).status,
    ).toBe(200);
    const payment = await post(cashier, "/api/payments", {
      orderId: o.id,
      method: "EFECTIVO",
      tenderedCents: 5000,
    });
    expect(payment.status).toBe(201);
    expect(payment.body).toMatchObject({
      amount_cents: 4000,
      change_cents: 1000,
    });
    const receipt = await cashier.get(`/api/orders/${o.id}/receipt`);
    expect(receipt.body.payment).toMatchObject({
      gross_cents: 8000,
      courtesy_cents: 4000,
      amount_cents: 4000,
    });
    expect(
      (
        await ctx.db.query("SELECT stock FROM products WHERE id=$1", [
          productId,
        ])
      ).rows[0].stock,
    ).toBe(stock);
    expect(
      (
        await ctx.db.query(
          "SELECT count(*) FROM audit_log WHERE action='COURTESY_AUTHORIZED' AND resource_id=$1",
          [first.body.id],
        )
      ).rows[0].count,
    ).toBe("1");
    expect(
      (await post(owner, "/api/courtesies", gift({ ...o, version: 2 }))).status,
    ).toBe(409);
  });

  it("settles a full gift at zero without fabricated cash and blocks duplicate charging", async () => {
    const o = await order();
    const before = (await cashier.get("/api/cash")).body[0]
      .current_expected_cents;
    expect((await post(owner, "/api/courtesies", gift(o, 2))).status).toBe(201);
    expect(
      (await cashier.get(`/api/orders/${o.id}/receipt`)).body.payment,
    ).toMatchObject({
      method: "CORTESIA",
      amount_cents: 0,
      change_cents: 0,
      gross_cents: 8000,
      courtesy_cents: 8000,
    });
    expect(
      (await cashier.get("/api/cash")).body[0].current_expected_cents,
    ).toBe(before);
    expect(
      (
        await post(cashier, "/api/payments", {
          orderId: o.id,
          method: "EFECTIVO",
          tenderedCents: 8000,
        })
      ).status,
    ).toBe(409);
    const report = (await owner.get("/api/courtesies")).body;
    expect(
      report.some(
        (r: { reason: string; amount_cents: number }) =>
          r.reason === "Atención de la casa" && r.amount_cents === 8000,
      ),
    ).toBe(true);
  });

  it("serializes competing authorizations and charge-versus-gift races", async () => {
    const o = await order(1);
    const results = await Promise.all([
      post(owner, "/api/courtesies", gift(o)),
      post(owner, "/api/courtesies", gift(o)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const next = await order(1);
    const submitted = await post(
      waiter,
      `/api/orders/${next.id}/send-to-cash`,
      { version: next.version },
    );
    expect(submitted.status).toBe(200);
    next.version = submitted.body.version as number;
    const raced = await Promise.all([
      post(owner, "/api/courtesies", gift(next)),
      post(cashier, "/api/payments", {
        orderId: next.id,
        method: "EFECTIVO",
        tenderedCents: 4000,
      }),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      (
        await ctx.db.query("SELECT count(*) FROM payments WHERE order_id=$1", [
          next.id,
        ])
      ).rows[0].count,
    ).toBe("1");
  });

  it("enforces immutable allocations, historical pricing, net payment and author permissions in PostgreSQL", async () => {
    const o = await order();
    const userId = (
      await ctx.db.query(
        "SELECT id FROM users WHERE email='owner@example.test'",
      )
    ).rows[0].id as string;
    const row = await ctx.db.query(
      "INSERT INTO order_courtesies(order_id,shift_id,user_id,reason,items,amount_cents) VALUES($1,$2,$3,'Direct guard test',$4,1) RETURNING id,amount_cents",
      [o.id, shiftId, userId, JSON.stringify(gift(o).items)],
    );
    expect(row.rows[0].amount_cents).toBe(4000);
    for (const sql of [
      "UPDATE order_courtesies SET reason='changed' WHERE order_id=$1",
      "DELETE FROM order_courtesies WHERE order_id=$1",
      "UPDATE order_items SET quantity=3 WHERE order_id=$1",
    ])
      await expect(ctx.db.query(sql, [o.id])).rejects.toMatchObject({
        code: "23514",
      });
    for (const sql of [
      "UPDATE orders SET courtesy_cents=0 WHERE id=$1",
      "UPDATE orders SET status='CANCELADO' WHERE id=$1",
    ])
      await expect(ctx.db.query(sql, [o.id])).rejects.toMatchObject({
        code: "23514",
      });
    await expect(
      ctx.db.query(
        "INSERT INTO payments(order_id,shift_id,user_id,method,amount_cents,tendered_cents,change_cents) VALUES($1,$2,$3,'EFECTIVO',8000,8000,0)",
        [o.id, shiftId, userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const waiterId = (
      await ctx.db.query("SELECT id FROM users WHERE role='MESERO' LIMIT 1")
    ).rows[0].id as string;
    await expect(
      ctx.db.query(
        "INSERT INTO order_courtesies(order_id,shift_id,user_id,reason,items,amount_cents) VALUES($1,$2,$3,'Unauthorized',$4,1)",
        [o.id, shiftId, waiterId, JSON.stringify(gift(o).items)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
