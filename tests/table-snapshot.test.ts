import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApp } from "../server/app.js";
import { csrfPost, seedUsers, testDatabase, testPassword } from "./helpers.js";
import { totp } from "../server/security.js";

describe("table metadata and historical snapshots", () => {
  let context: Awaited<ReturnType<typeof testDatabase>>;
  let server: ReturnType<typeof createApp>;
  let admin: ReturnType<typeof request.agent>;
  let waiter: ReturnType<typeof request.agent>;
  let cashier: ReturnType<typeof request.agent>;
  let kitchen: ReturnType<typeof request.agent>;
  let tableId: string;
  let orderId: string;
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
    key = randomUUID(),
  ) => csrfPost(agent, "patch", path, body, key);
  beforeAll(async () => {
    context = await testDatabase();
    await seedUsers(context.db);
    server = createApp(context.db, context.c, async () => undefined);
    admin = request.agent(server.app);
    waiter = request.agent(server.app);
    cashier = request.agent(server.app);
    kitchen = request.agent(server.app);
    for (const [agent, role] of [
      [admin, "administrador"],
      [waiter, "mesero"],
      [cashier, "cajero"],
      [kitchen, "cocina"],
    ] as const) {
      const result = await post(agent, "/api/auth/login", {
        email: `${role}@example.test`,
        password: testPassword,
      });
      expect(result.status).toBe(200);
    }
    const setup = await post(admin, "/api/auth/mfa/setup", {});
    expect(setup.status).toBe(200);
    const verified = await post(admin, "/api/auth/mfa/verify", {
      code: totp(setup.body.secret as string).generate(),
    });
    expect(verified.status).toBe(200);
  });
  afterAll(async () => {
    server?.closeStreams();
    await context?.db.end();
  });
  it("creates a configured table exactly once and rejects concurrent stale edits", async () => {
    const data = {
      name: "Terraza 12",
      floor: 2,
      capacity: 6,
      shape: "round",
      displayOrder: 10,
    };
    const key = randomUUID();
    const first = await post(admin, "/api/tables", data, key);
    expect(first.status).toBe(201);
    tableId = first.body.id as string;
    expect((await post(admin, "/api/tables", data, key)).body).toEqual(
      first.body,
    );
    const [a, b] = await Promise.all([
      patch(admin, `/api/tables/${tableId}`, {
        ...data,
        capacity: 8,
        version: 1,
      }),
      patch(admin, `/api/tables/${tableId}`, {
        ...data,
        capacity: 10,
        version: 1,
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
  it("keeps table name and floor immutable on orders and receipts after the table is renamed", async () => {
    const cat = await post(admin, "/api/categories", { name: "Platos" });
    const product = await post(admin, "/api/products", {
      name: "Almuerzo",
      categoryId: cat.body.id,
      priceCents: 4500,
      stock: 10,
    });
    const order = await post(waiter, "/api/orders", {
      tableId,
      items: [{ productId: product.body.id, quantity: 1 }],
    });
    expect(order.status).toBe(201);
    orderId = order.body.id as string;
    expect(order.body).toMatchObject({
      table_name: "Terraza 12",
      table_floor: 2,
    });
    const update = await patch(admin, `/api/tables/${tableId}`, {
      name: "Patio 12",
      floor: 1,
      capacity: 4,
      shape: "square",
      displayOrder: 1,
      version: 2,
    });
    expect(update.status).toBe(200);
    expect(
      (await waiter.get("/api/orders")).body.find(
        (o: { id: string }) => o.id === orderId,
      ),
    ).toMatchObject({ table_name: "Terraza 12", table_floor: 2 });
    await expect(
      context.db.query("UPDATE orders SET table_floor=1 WHERE id=$1", [
        orderId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await post(cashier, "/api/cash/open", { openingCents: 0 })).status,
    ).toBe(201);
    expect(
      (
        await post(cashier, "/api/payments", {
          orderId,
          method: "EFECTIVO",
          tenderedCents: 5000,
        })
      ).status,
    ).toBe(201);
    expect(
      (await cashier.get(`/api/orders/${orderId}/receipt`)).body.payment,
    ).toMatchObject({ table_name: "Terraza 12", table_floor: 2 });
  });
  it("a paid order still occupies its table until served, then becomes available", async () => {
    const state = async () =>
      (await waiter.get("/api/tables/status")).body.find(
        (t: { tableId: string }) => t.tableId === tableId,
      );
    expect(await state()).toMatchObject({
      state: "service",
      openOrders: 1,
      mine: true,
    });
    expect(
      (
        await patch(kitchen, `/api/orders/${orderId}/status`, {
          status: "EN_PREPARACION",
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await patch(kitchen, `/api/orders/${orderId}/status`, {
          status: "LISTO",
          version: 2,
        })
      ).status,
    ).toBe(200);
    expect(await state()).toMatchObject({ state: "ready" });
    expect(
      (
        await patch(waiter, `/api/orders/${orderId}/status`, {
          status: "ENTREGADO",
          version: 3,
        })
      ).status,
    ).toBe(200);
    expect(await state()).toMatchObject({ state: "available", openOrders: 0 });
  });
  it("upgrades existing paid and cancelled history transactionally and restores integrity guards", async () => {
    const tx = await context.db.connect();
    try {
      await tx.query("BEGIN");
      // Fully isolated disposable schema; rollback removes only this fixture.
      await tx.query("CREATE SCHEMA snapshot_upgrade_fixture");
      await tx.query(
        "SET LOCAL search_path TO snapshot_upgrade_fixture, public",
      );
      for (const file of [
        "001_initial.sql",
        "002_integrity_guards.sql",
        "003_session_retry_audit.sql",
        "004_order_paid_marker.sql",
        "005_dining_floors.sql",
      ]) {
        await tx.query(await readFile(`migrations/${file}`, "utf8"));
      }
      const user = (
        await tx.query(
          "INSERT INTO users(email,name,password_hash,role) VALUES('migration@example.test','Migration','fixture','ADMINISTRADOR') RETURNING id",
        )
      ).rows[0].id as string;
      const table = (
        await tx.query(
          "INSERT INTO restaurant_tables(name,floor) VALUES('Histórica',2) RETURNING id",
        )
      ).rows[0].id as string;
      const cat = (
        await tx.query(
          "INSERT INTO categories(name) VALUES('Migration') RETURNING id",
        )
      ).rows[0].id as string;
      const product = (
        await tx.query(
          "INSERT INTO products(name,category_id,price_cents,stock) VALUES('Fixture',$1,100,1) RETURNING id",
          [cat],
        )
      ).rows[0].id as string;
      const shift = (
        await tx.query(
          "INSERT INTO cash_shifts(user_id,opening_cents) VALUES($1,0) RETURNING id",
          [user],
        )
      ).rows[0].id as string;
      for (const paid of [false, true]) {
        const order = (
          await tx.query(
            "INSERT INTO orders(table_id,user_id,total_cents) VALUES($1,$2,100) RETURNING id",
            [table, user],
          )
        ).rows[0].id as string;
        await tx.query(
          "INSERT INTO order_items(order_id,product_id,name,price_cents,quantity) VALUES($1,$2,'Fixture',100,1)",
          [order, product],
        );
        if (paid)
          await tx.query(
            "INSERT INTO payments(order_id,shift_id,user_id,method,amount_cents,tendered_cents,change_cents) VALUES($1,$2,$3,'EFECTIVO',100,100,0)",
            [order, shift, user],
          );
        else
          await tx.query("UPDATE orders SET status='CANCELADO' WHERE id=$1", [
            order,
          ]);
      }
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
      await tx.query(
        await readFile("migrations/006_order_table_snapshot.sql", "utf8"),
      );
      const history = await tx.query(
        "SELECT table_name,table_floor FROM orders",
      );
      expect(history.rows).toEqual([
        { table_name: "Histórica", table_floor: 2 },
        { table_name: "Histórica", table_floor: 2 },
      ]);
      await expect(
        tx.query(
          "UPDATE orders SET status='PENDIENTE' WHERE status='CANCELADO'",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });
});
