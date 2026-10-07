import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createApp } from "../server/app.js";
import { csrfPost, seedUsers, testDatabase, testPassword } from "./helpers.js";
import { totp } from "../server/security.js";
import {
  paymentParts,
  paymentSchema,
  receiverSchema,
} from "../server/checkout.js";

describe("checkout money and receiver validation", () => {
  it("allocates mixed payments with change only from cash", () => {
    const input = paymentSchema.parse({
      orderId: randomUUID(),
      method: "MIXTO",
      tenderedCents: 4500,
      cardCents: 1500,
    });
    expect(paymentParts(4000, input)).toEqual({ mixedCard: 1500, change: 500 });
    for (const cardCents of [0, 4000, 4100])
      expect(() => paymentParts(4000, { ...input, cardCents })).toThrow();
    expect(() =>
      paymentParts(4000, { ...input, tenderedCents: 3999 }),
    ).toThrow();
    expect(() => paymentParts(4000, { ...input, method: "TARJETA" })).toThrow();
  });
  it("validates format, without claiming tax registry verification", () => {
    expect(
      receiverSchema.parse({ type: "NIT", id: "1234567-k", name: "Receptor" })
        .id,
    ).toBe("1234567K");
    expect(
      receiverSchema.parse({ type: "CF", id: "C/F", name: "CONSUMIDOR FINAL" })
        .id,
    ).toBe("CF");
    expect(
      receiverSchema.safeParse({ type: "CUI", id: "123", name: "Receptor" })
        .success,
    ).toBe(false);
    expect(
      receiverSchema.safeParse({ type: "CF", id: "1234", name: "Receptor" })
        .success,
    ).toBe(false);
    expect(
      receiverSchema.safeParse({
        type: "NIT",
        id: "';SELECT",
        name: "Receptor",
      }).success,
    ).toBe(false);
  });
});

describe("cash handoff, financial approvals, sales and audit", () => {
  let ctx: Awaited<ReturnType<typeof testDatabase>>;
  let server: ReturnType<typeof createApp>;
  let admin: ReturnType<typeof request.agent>,
    waiter: ReturnType<typeof request.agent>,
    cashier: ReturnType<typeof request.agent>;
  let productId: string, tableId: string, shiftId: string, paidOrder: string;
  const post = (
    agent: ReturnType<typeof request.agent>,
    path: string,
    body: object,
    key = randomUUID(),
  ) => csrfPost(agent, "post", path, body, key);
  const newOrder = async (send = true) => {
    const created = await post(waiter, "/api/orders", {
      tableId,
      items: [{ productId, quantity: 1 }],
    });
    expect(created.status).toBe(201);
    if (send)
      expect(
        (
          await post(waiter, `/api/orders/${created.body.id}/send-to-cash`, {
            version: created.body.version,
          })
        ).status,
      ).toBe(200);
    return created.body.id as string;
  };
  beforeAll(async () => {
    ctx = await testDatabase();
    await seedUsers(ctx.db);
    server = createApp(ctx.db, ctx.c, async () => undefined);
    admin = request.agent(server.app);
    waiter = request.agent(server.app);
    cashier = request.agent(server.app);
    for (const [agent, role] of [
      [admin, "administrador"],
      [waiter, "mesero"],
      [cashier, "cajero"],
    ] as const)
      expect(
        (
          await post(agent, "/api/auth/login", {
            email: `${role}@example.test`,
            password: testPassword,
          })
        ).status,
      ).toBe(200);
    const setup = await post(admin, "/api/auth/mfa/setup", {});
    expect(
      (
        await post(admin, "/api/auth/mfa/verify", {
          code: totp(setup.body.secret as string).generate(),
        })
      ).status,
    ).toBe(200);
    tableId = (await post(admin, "/api/tables", { name: "Caja pruebas" })).body
      .id as string;
    productId = (
      await ctx.db.query(
        "UPDATE products SET stock=30 WHERE catalog_code='NAT-ES-HAMB' RETURNING id",
      )
    ).rows[0].id as string;
    shiftId = (await post(cashier, "/api/cash/open", { openingCents: 1000 }))
      .body.id as string;
  });
  afterAll(async () => {
    server?.closeStreams();
    await ctx?.db.end();
  });
  it("requires explicit handoff, prevents IDOR and audits a single idempotent send", async () => {
    const id = await newOrder(false);
    expect(
      (
        await post(cashier, "/api/payments", {
          orderId: id,
          method: "EFECTIVO",
          tenderedCents: 4000,
        })
      ).body.error.code,
    ).toBe("ORDER_NOT_SENT_TO_CASH");
    expect(
      (await post(cashier, `/api/orders/${id}/send-to-cash`, { version: 1 }))
        .status,
    ).toBe(403);
    const other = (
      await ctx.db.query(
        "INSERT INTO users(email,name,password_hash,role) VALUES('other@example.test','Other','unused','MESERO') RETURNING id",
      )
    ).rows[0].id as string;
    // No ownership tampering on an existing order: create an independent fixture atomically.
    const { transaction } = await import("../server/db.js");
    const otherOrder = await transaction(ctx.db, async (tx) => {
      const otherTable = (
        await tx.query(
          "INSERT INTO restaurant_tables(name) VALUES('Other checkout table') RETURNING id",
        )
      ).rows[0].id as string;
      const row = (
        await tx.query(
          "INSERT INTO orders(table_id,user_id,total_cents) VALUES($1,$2,4000) RETURNING id",
          [otherTable, other],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO order_items(order_id,product_id,name,quantity,price_cents) VALUES($1,$2,'Test',1,4000)",
        [row.id, productId],
      );
      return row.id as string;
    });
    expect(
      (
        await post(waiter, `/api/orders/${otherOrder}/send-to-cash`, {
          version: 1,
        })
      ).status,
    ).toBe(403);
    const key = randomUUID();
    const first = await post(
      waiter,
      `/api/orders/${id}/send-to-cash`,
      { version: 1 },
      key,
    );
    expect(first.status).toBe(200);
    expect(
      (
        await post(
          waiter,
          `/api/orders/${id}/send-to-cash`,
          { version: 1 },
          key,
        )
      ).body,
    ).toEqual(first.body);
    expect(
      (
        await ctx.db.query(
          "SELECT count(*) FROM audit_log WHERE resource_id=$1 AND action='ORDER_SENT_TO_CASH'",
          [id],
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("mixed charge is atomic, one-time, and contributes only cash to shift", async () => {
    paidOrder = await newOrder();
    const input = {
      orderId: paidOrder,
      method: "MIXTO",
      tenderedCents: 4500,
      cardCents: 1500,
      receiver: {
        type: "NIT",
        id: "1234567K",
        name: "Cliente prueba",
        address: "Guatemala",
      },
    };
    const key = randomUUID();
    const paid = await post(cashier, "/api/payments", input, key);
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({
      cash_cents: 2500,
      card_cents: 1500,
      transfer_cents: 0,
      change_cents: 500,
    });
    expect((await post(cashier, "/api/payments", input, key)).body.id).toBe(
      paid.body.id,
    );
    expect((await post(cashier, "/api/payments", input)).body.error.code).toBe(
      "ALREADY_PAID",
    );
    expect(
      (await cashier.get("/api/cash")).body[0].current_expected_cents,
    ).toBe("3500");
  });
  it("FEL fail-closed does not charge or fabricate an invoice", async () => {
    const id = await newOrder();
    const response = await post(cashier, "/api/payments", {
      orderId: id,
      method: "TARJETA",
      tenderedCents: 4000,
      documentKind: "FACTURA",
    });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("FEL_NOT_CONFIGURED");
    expect(
      (
        await ctx.db.query("SELECT count(*) FROM payments WHERE order_id=$1", [
          id,
        ])
      ).rows[0].count,
    ).toBe("0");
    expect((await cashier.get("/api/fel/status")).body.ready).toBe(false);
    expect(
      (
        await post(cashier, "/api/payments", {
          orderId: id,
          method: "TRANSFERENCIA",
          tenderedCents: 4000,
          receiver: { type: "CUI", id: "1234567890101", name: "Cliente CUI" },
        })
      ).status,
    ).toBe(201);
  });
  it("exposes paged sales only to cash staff, preserves receiver and marks reprints", async () => {
    expect((await waiter.get("/api/sales")).status).toBe(403);
    const page = await cashier.get("/api/sales?limit=1");
    expect(page.body.items).toHaveLength(1);
    expect(page.body.next).toBeTruthy();
    const next = await cashier.get(
      `/api/sales?before=${page.body.next}&limit=1`,
    );
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    expect(
      (await cashier.get(`/api/orders/${paidOrder}/receipt`)).body.payment
        .receiver_id,
    ).toBe("1234567K");
    const key = randomUUID();
    const first = await post(
      cashier,
      `/api/orders/${paidOrder}/print`,
      { copy: false },
      key,
    );
    expect(first.body.reprint).toBe(false);
    expect(
      (
        await post(
          cashier,
          `/api/orders/${paidOrder}/print`,
          { copy: false },
          key,
        )
      ).body.id,
    ).toBe(first.body.id);
    expect(
      (await post(cashier, `/api/orders/${paidOrder}/print`, { copy: false }))
        .body.reprint,
    ).toBe(true);
    expect(
      (await post(waiter, `/api/orders/${paidOrder}/print`, { copy: true }))
        .status,
    ).toBe(403);
  });
  it("freezes cash operations pending approval, rejects unauthorized and changed closes", async () => {
    const id = await newOrder();
    const asked = await post(cashier, "/api/cash/close-request", {
      shiftId,
      countedCents: 3400,
    });
    expect(asked.status).toBe(201);
    expect(
      (await post(cashier, "/api/cash/close", { shiftId, countedCents: 3400 }))
        .status,
    ).toBe(403);
    expect(
      (
        await post(cashier, "/api/payments", {
          orderId: id,
          method: "EFECTIVO",
          tenderedCents: 4000,
        })
      ).body.error.code,
    ).toBe("CLOSURE_PENDING");
    expect(
      (
        await post(cashier, "/api/cash/movements", {
          amountCents: 100,
          reason: "Intento pendiente",
        })
      ).body.error.code,
    ).toBe("CLOSURE_PENDING");
    expect(
      (
        await post(admin, "/api/cash/close", {
          shiftId,
          requestId: asked.body.closure_request_id,
          countedCents: 3500,
        })
      ).body.error.code,
    ).toBe("CLOSURE_AMOUNT_CHANGED");
    expect(
      (
        await post(cashier, "/api/cash/reject-close", {
          shiftId,
          reason: "No autorizado",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(admin, "/api/cash/reject-close", {
          shiftId,
          requestId: asked.body.closure_request_id,
          reason: "Volver a contar",
        })
      ).status,
    ).toBe(200);
    const second = await post(cashier, "/api/cash/close-request", {
      shiftId,
      countedCents: 3500,
    });
    expect(second.status).toBe(201);
    expect(
      (
        await post(admin, "/api/cash/close", {
          shiftId,
          requestId: asked.body.closure_request_id,
          countedCents: 3400,
        })
      ).body.error.code,
    ).toBe("STALE_CLOSE_REQUEST");
    const closed = await post(admin, "/api/cash/close", {
      shiftId,
      requestId: second.body.closure_request_id,
      countedCents: 3500,
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      counted_cents: 3500,
      expected_cents: "3500",
      difference_cents: "0",
    });
    expect(closed.body.closure_approved_by).toBeTruthy();
  });
  it("records expenses and loss separately without pretending complete accounting", async () => {
    const input = {
      kind: "GASTO",
      amountCents: 800,
      description: "Costo registrado",
      occurredOn: "2026-10-07",
    };
    expect((await post(cashier, "/api/expenses", input)).status).toBe(403);
    const key = randomUUID();
    const saved = await post(admin, "/api/expenses", input, key);
    expect(saved.status).toBe(201);
    expect((await post(admin, "/api/expenses", input, key)).body.id).toBe(
      saved.body.id,
    );
    expect(
      (
        await post(admin, "/api/expenses", {
          ...input,
          kind: "MERMA",
          amountCents: 200,
        })
      ).status,
    ).toBe(201);
    const summary = await admin.get(
      "/api/finance/summary?from=2026-10-07&to=2026-10-07",
    );
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      expense_cents: "800",
      loss_cents: "200",
      accountingComplete: false,
    });
    expect(summary.body.recorded_balance_cents).toBe(
      Number(summary.body.income_cents) - 1000,
    );
    expect(
      (await cashier.get("/api/finance/summary?from=2026-10-07&to=2026-10-07"))
        .status,
    ).toBe(403);
    await expect(
      ctx.db.query("DELETE FROM expense_entries WHERE id=$1", [saved.body.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("enforces DB queue/split/approval and serializes payment versus close request", async () => {
    const opened = await post(cashier, "/api/cash/open", { openingCents: 0 });
    expect(opened.status).toBe(201);
    const sid = opened.body.id as string,
      cashierId = opened.body.user_id as string;
    const id = await newOrder(false);
    await expect(
      ctx.db.query(
        "INSERT INTO payments(order_id,shift_id,user_id,method,amount_cents,tendered_cents,change_cents) VALUES($1,$2,$3,'EFECTIVO',4000,4000,0)",
        [id, sid, cashierId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      ctx.db.query(
        "UPDATE cash_shifts SET closed_at=now(),counted_cents=0,closure_approved_by=$2 WHERE id=$1",
        [sid, cashierId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await post(waiter, `/api/orders/${id}/send-to-cash`, { version: 1 }))
        .status,
    ).toBe(200);
    await expect(
      ctx.db.query(
        "INSERT INTO payments(order_id,shift_id,user_id,method,amount_cents,tendered_cents,change_cents,mixed_card_cents) VALUES($1,$2,$3,'MIXTO',4000,4000,0,4000)",
        [id, sid, cashierId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const [payment, closing] = await Promise.all([
      post(cashier, "/api/payments", {
        orderId: id,
        method: "EFECTIVO",
        tenderedCents: 4000,
      }),
      post(cashier, "/api/cash/close-request", {
        shiftId: sid,
        countedCents: 0,
      }),
    ]);
    expect(closing.status).toBe(201);
    expect([201, 409]).toContain(payment.status);
    if (payment.status === 409)
      expect(payment.body.error.code).toBe("CLOSURE_PENDING");
    const approved = await post(admin, "/api/cash/close", {
      shiftId: sid,
      countedCents: 0,
      requestId: closing.body.closure_request_id,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.expected_cents).toBe(
      payment.status === 201 ? "4000" : "0",
    );
    expect(
      (
        await ctx.db.query("SELECT count(*) FROM payments WHERE order_id=$1", [
          id,
        ])
      ).rows[0].count,
    ).toBe(payment.status === 201 ? "1" : "0");
  });
  it("serializes concurrent print requests and never creates a second original", async () => {
    const candidate = (
      await ctx.db.query(
        "SELECT id,order_id FROM payments WHERE receiver_type='CUI' LIMIT 1",
      )
    ).rows[0];
    const results = await Promise.all([
      post(cashier, `/api/orders/${candidate.order_id}/print`, { copy: false }),
      post(cashier, `/api/orders/${candidate.order_id}/print`, { copy: false }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.reprint).sort()).toEqual([false, true]);
    await expect(
      ctx.db.query("DELETE FROM receipt_prints WHERE payment_id=$1", [
        candidate.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("reports Guatemala midnight boundaries, not the database or browser timezone", async () => {
    const { transaction } = await import("../server/db.js");
    const cashierId = (
      await ctx.db.query("SELECT id FROM users WHERE role='CAJERO' LIMIT 1")
    ).rows[0].id as string;
    const historicalShift = (
      await ctx.db.query(
        "INSERT INTO cash_shifts(user_id,opening_cents,opened_at) VALUES($1,0,'2024-01-01T06:00:00Z') RETURNING id",
        [cashierId],
      )
    ).rows[0].id as string;
    for (const when of [
      "2024-01-02T05:59:59Z",
      "2024-01-02T06:00:00Z",
      "2024-01-03T05:59:59Z",
      "2024-01-03T06:00:00Z",
    ]) {
      await transaction(ctx.db, async (tx) => {
        const o = (
          await tx.query(
            "INSERT INTO orders(table_id,user_id,total_cents,created_at,sent_to_cash_at,sent_to_cash_by) VALUES($1,$2,4000,$3,$3,$2) RETURNING id",
            [tableId, cashierId, when],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO order_items(order_id,product_id,name,quantity,price_cents) VALUES($1,$2,'Historical boundary fixture',1,4000)",
          [o.id, productId],
        );
        await tx.query(
          "INSERT INTO payments(order_id,shift_id,user_id,method,amount_cents,tendered_cents,change_cents,created_at) VALUES($1,$2,$3,'TARJETA',4000,4000,0,$4)",
          [o.id, historicalShift, cashierId, when],
        );
      });
    }
    const report = await admin.get(
      "/api/finance/summary?from=2024-01-02&to=2024-01-02",
    );
    expect(report.status).toBe(200);
    expect(report.body.income_cents).toBe("8000");
    expect(report.body.daily).toEqual([
      { day: "2024-01-02", income_cents: "8000", transactions: "2" },
    ]);
    expect(
      (await admin.get("/api/finance/summary?from=2024-01-03&to=2024-01-02"))
        .status,
    ).toBe(400);
    expect(
      (await admin.get("/api/finance/summary?from=2023-01-01&to=2025-01-01"))
        .status,
    ).toBe(400);
  });
  it("upgrades historical immutable payments and closed shifts from 009 without rewriting them", async () => {
    const tx = await ctx.db.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("CREATE SCHEMA checkout_upgrade_fixture");
      await tx.query(
        "SET LOCAL search_path TO checkout_upgrade_fixture, public",
      );
      for (const file of (await readdir("migrations"))
        .filter((name) => name.endsWith(".sql") && name < "010")
        .sort())
        await tx.query(await readFile(`migrations/${file}`, "utf8"));
      const user = (
        await tx.query(
          "INSERT INTO users(email,name,password_hash,role) VALUES('upgrade@example.test','Migration','fixture','ADMINISTRADOR') RETURNING id",
        )
      ).rows[0].id as string;
      const table = (
        await tx.query(
          "INSERT INTO restaurant_tables(name) VALUES('Migration') RETURNING id",
        )
      ).rows[0].id as string;
      const product = (
        await tx.query(
          "SELECT id,name,price_cents FROM products ORDER BY id LIMIT 1",
        )
      ).rows[0] as { id: string; name: string; price_cents: number };
      const shift = (
        await tx.query(
          "INSERT INTO cash_shifts(user_id,opening_cents) VALUES($1,0) RETURNING id",
          [user],
        )
      ).rows[0].id as string;
      for (const method of [
        "EFECTIVO",
        "TARJETA",
        "TRANSFERENCIA",
        "CORTESIA",
      ]) {
        const order = (
          await tx.query(
            "INSERT INTO orders(table_id,user_id,total_cents) VALUES($1,$2,$3) RETURNING id",
            [table, user, product.price_cents],
          )
        ).rows[0].id as string;
        await tx.query(
          "INSERT INTO order_items(order_id,product_id,name,quantity,price_cents) VALUES($1,$2,$3,1,$4)",
          [order, product.id, product.name, product.price_cents],
        );
        if (method === "CORTESIA")
          await tx.query(
            "INSERT INTO order_courtesies(order_id,shift_id,user_id,reason,items,amount_cents) VALUES($1,$2,$3,'Migration fixture',$4,0)",
            [
              order,
              shift,
              user,
              JSON.stringify([{ productId: product.id, quantity: 1 }]),
            ],
          );
        const due = method === "CORTESIA" ? 0 : product.price_cents;
        await tx.query(
          "INSERT INTO payments(order_id,shift_id,user_id,method,amount_cents,tendered_cents,change_cents) VALUES($1,$2,$3,$4,$5,$5,0)",
          [order, shift, user, method, due],
        );
      }
      await tx.query(
        "UPDATE cash_shifts SET closed_at=now(),counted_cents=$1 WHERE id=$2",
        [product.price_cents, shift],
      );
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
      const before = (await tx.query("SELECT * FROM payments ORDER BY id"))
        .rows;
      await tx.query(
        await readFile("migrations/010_checkout_control.sql", "utf8"),
      );
      const after = (await tx.query("SELECT * FROM payments ORDER BY id")).rows;
      expect(after).toHaveLength(4);
      after.forEach((payment, index) => {
        expect(payment).toMatchObject(before[index]);
        expect(payment.cash_cents).toBe(
          payment.method === "EFECTIVO" ? product.price_cents : 0,
        );
        expect(payment.card_cents).toBe(
          payment.method === "TARJETA" ? product.price_cents : 0,
        );
        expect(payment.transfer_cents).toBe(
          payment.method === "TRANSFERENCIA" ? product.price_cents : 0,
        );
        expect(payment.receiver_id).toBe("CF");
      });
      expect(
        (
          await tx.query(
            "SELECT count(*) FROM orders WHERE sent_to_cash_at IS NOT NULL",
          )
        ).rows[0].count,
      ).toBe("0");
      expect(
        (
          await tx.query(
            "SELECT closure_approved_by FROM cash_shifts WHERE id=$1",
            [shift],
          )
        ).rows[0].closure_approved_by,
      ).toBeNull();
      await tx.query("SAVEPOINT immutable_check");
      await expect(
        tx.query("UPDATE payments SET amount_cents=1"),
      ).rejects.toMatchObject({ code: "23514" });
      await tx.query("ROLLBACK TO SAVEPOINT immutable_check");
      for (const statement of [
        "TRUNCATE receipt_prints",
        "TRUNCATE expense_entries",
      ]) {
        await expect(tx.query(statement)).rejects.toMatchObject({
          code: "23514",
        });
        await tx.query("ROLLBACK TO SAVEPOINT immutable_check");
      }
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });
});
