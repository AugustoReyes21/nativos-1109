import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { createApp } from "../server/app.js";
import { migrate } from "../server/migrate.js";
import { digest, totp } from "../server/security.js";
import {
  seedUsers,
  testDatabase,
  testPassword,
  csrfPost,
  replayRefresh,
} from "./helpers.js";

describe("PostgreSQL-backed API", () => {
  let context: Awaited<ReturnType<typeof testDatabase>>;
  let server: ReturnType<typeof createApp>;
  let admin: ReturnType<typeof request.agent>;
  let waiter: ReturnType<typeof request.agent>;
  let cashier: ReturnType<typeof request.agent>;
  let kitchen: ReturnType<typeof request.agent>;
  let categoryId: string;
  let tableId: string;
  let productId: string;
  let orderId: string;
  let shiftId: string;
  let adminCodes: string[] = [];
  let resetToken = "";
  const post = (
    agent: ReturnType<typeof request.agent>,
    url: string,
    data: object,
    key: string = randomUUID(),
  ) => csrfPost(agent, "post", url, data, key);
  const patch = (
    agent: ReturnType<typeof request.agent>,
    url: string,
    data: object,
  ) => csrfPost(agent, "patch", url, data, randomUUID());
  beforeAll(async () => {
    context = await testDatabase();
    await seedUsers(context.db);
    server = createApp(context.db, context.c, async (_email, token) => {
      resetToken = token;
    });
    admin = request.agent(server.app);
    waiter = request.agent(server.app);
    cashier = request.agent(server.app);
    kitchen = request.agent(server.app);
    for (const [agent, role] of [
      [waiter, "mesero"],
      [cashier, "cajero"],
      [kitchen, "cocina"],
    ] as const) {
      expect(
        (
          await post(agent, "/api/auth/login", {
            email: `${role}@example.test`,
            password: testPassword,
          })
        ).status,
      ).toBe(200);
    }
  });
  afterAll(async () => {
    server?.closeStreams();
    await context?.db.end();
  });
  it("runs migrations reproducibly and exposes readiness without database details", async () => {
    await migrate(context.db);
    expect((await request(server.app).get("/health/ready")).body).toEqual({
      status: "ready",
    });
  });
  it("rejects missing CSRF protection, cross-origin and incorrect credentials", async () => {
    expect(
      (await request(server.app).post("/api/auth/login").send({})).status,
    ).toBe(403);
    expect(
      (
        await request(server.app)
          .get("/api/auth/me")
          .set("Origin", "https://attacker.test")
      ).status,
    ).toBe(403);
    const result = await post(admin, "/api/auth/login", {
      email: "admin@example.test",
      password: "wrong",
    });
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(result.body.error.requestId).toBeTruthy();
  });
  it("requires admin MFA before issuing a usable session; encrypts secret and issues one-time recovery codes", async () => {
    expect(
      (
        await post(admin, "/api/auth/login", {
          email: "administrador@example.test",
          password: testPassword,
        })
      ).body.setupRequired,
    ).toBe(true);
    expect((await admin.get("/api/users")).status).toBe(401);
    const setup = await post(admin, "/api/auth/mfa/setup", {});
    expect(setup.status).toBe(200);
    expect((await post(admin, "/api/auth/mfa/setup", {})).status).toBe(409);
    expect(
      (await post(admin, "/api/auth/mfa/verify", { code: "invalid" })).status,
    ).toBe(400);
    const done = await post(admin, "/api/auth/mfa/verify", {
      code: totp(setup.body.secret as string).generate(),
    });
    expect(done.status).toBe(200);
    adminCodes = done.body.recoveryCodes as string[];
    expect(adminCodes).toHaveLength(8);
    expect((await admin.get("/api/auth/me")).body.role).toBe("ADMINISTRADOR");
    const u = (
      await context.db.query("SELECT mfa_secret FROM users WHERE role=$1", [
        "ADMINISTRADOR",
      ])
    ).rows[0] as { mfa_secret: string };
    expect(u.mfa_secret).not.toBe(setup.body.secret);
    expect(
      (done.headers["set-cookie"] as unknown as string[]).some(
        (v) => v.includes("HttpOnly") && v.includes("SameSite=Strict"),
      ),
    ).toBe(true);
  });
  it("enforces server permissions and rejects mass assignment", async () => {
    expect((await waiter.get("/api/users")).status).toBe(403);
    expect((await cashier.get("/api/reports")).status).toBe(403);
    expect((await post(waiter, "/api/products", {})).status).toBe(403);
    expect(
      (await post(admin, "/api/categories", { name: "Platos", isAdmin: true }))
        .status,
    ).toBe(400);
    categoryId = (await post(admin, "/api/categories", { name: "Platos" })).body
      .id as string;
    tableId = (await post(admin, "/api/tables", { name: "Mesa 1" })).body
      .id as string;
    const product = await post(admin, "/api/products", {
      name: "Último almuerzo",
      categoryId,
      priceCents: 4500,
      stock: 1,
    });
    expect(product.status).toBe(201);
    productId = product.body.id as string;
  });
  it("lets exactly one concurrent order consume the last unit and rolls back the loser", async () => {
    const payload = { tableId, items: [{ productId, quantity: 1 }] };
    const results = await Promise.all([
      post(waiter, "/api/orders", payload),
      post(waiter, "/api/orders", payload),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    orderId = results.find((r) => r.status === 201)!.body.id as string;
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
      "PRODUCT_OUT_OF_STOCK",
    );
    expect(
      (
        await context.db.query("SELECT stock FROM products WHERE id=$1", [
          productId,
        ])
      ).rows[0].stock,
    ).toBe(0);
    expect(
      (await context.db.query("SELECT count(*) FROM orders")).rows[0].count,
    ).toBe("1");
  });
  it("rejects stale administrative stock edits after an order changes inventory", async () => {
    const result = await patch(admin, `/api/products/${productId}`, {
      name: "Último almuerzo",
      categoryId,
      priceCents: 4500,
      stock: 20,
      active: true,
      version: 1,
    });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("STALE_VERSION");
  });
  it("replays concurrent duplicate orders once; rejects changed payload with same key", async () => {
    const p = await post(admin, "/api/products", {
      name: "Bebida",
      categoryId,
      priceCents: 1200,
      stock: 10,
    });
    const input = {
      tableId,
      items: [{ productId: p.body.id as string, quantity: 2 }],
    };
    const key = randomUUID();
    const [a, b] = await Promise.all([
      post(waiter, "/api/orders", input, key),
      post(waiter, "/api/orders", input, key),
    ]);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(
      (
        await context.db.query("SELECT stock FROM products WHERE id=$1", [
          p.body.id,
        ])
      ).rows[0].stock,
    ).toBe(8);
    expect(
      (await post(waiter, "/api/orders", { ...input, notes: "changed" }, key))
        .status,
    ).toBe(409);
  });
  it("validates the kitchen state machine and ownership", async () => {
    expect(
      (
        await patch(waiter, `/api/orders/${orderId}/status`, {
          status: "LISTO",
          version: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await patch(kitchen, `/api/orders/${orderId}/status`, {
          status: "LISTO",
          version: 1,
        })
      ).status,
    ).toBe(409);
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
    expect(
      (
        await patch(waiter, `/api/orders/${orderId}/status`, {
          status: "ENTREGADO",
          version: 3,
        })
      ).status,
    ).toBe(200);
  });
  it("prevents double payment across distinct concurrent attempts and replays identical attempts", async () => {
    const opened = await post(cashier, "/api/cash/open", {
      openingCents: 10000,
    });
    expect(opened.status).toBe(201);
    shiftId = opened.body.id as string;
    expect(
      (
        await post(waiter, `/api/orders/${orderId}/send-to-cash`, {
          version: 4,
        })
      ).status,
    ).toBe(200);
    const input = { orderId, method: "EFECTIVO", tenderedCents: 5000 };
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      keys.map((k) => post(cashier, "/api/payments", input, k)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const index = results.findIndex((r) => r.status === 201);
    const payment = results[index]!.body;
    expect(payment.change_cents).toBe(500);
    expect(
      (await post(cashier, "/api/payments", input, keys[index])).body.id,
    ).toBe(payment.id);
    expect(
      (
        await context.db.query(
          "SELECT count(*) FROM payments WHERE order_id=$1",
          [orderId],
        )
      ).rows[0].count,
    ).toBe("1");
    expect(
      (await cashier.get(`/api/orders/${orderId}/receipt`)).body.fiscal,
    ).toBe(false);
  });
  it("closes cash with exact expected balance, records difference and prevents payments after close", async () => {
    expect(
      (
        await post(cashier, "/api/cash/movements", {
          amountCents: -500,
          reason: "Compra de hielo",
        })
      ).status,
    ).toBe(201);
    const requested = await post(cashier, "/api/cash/close-request", {
      shiftId,
      countedCents: 13900,
    });
    expect(requested.status).toBe(201);
    const closed = await post(admin, "/api/cash/close", {
      shiftId,
      requestId: requested.body.closure_request_id,
      countedCents: 13900,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.expected_cents).toBe("14000");
    expect(closed.body.difference_cents).toBe("-100");
    expect(
      (
        await post(cashier, "/api/payments", {
          orderId,
          method: "EFECTIVO",
          tenderedCents: 5000,
        })
      ).body.error.code,
    ).toBe("CASH_CLOSED");
  });
  it("handles expired JWT, rotates refresh tokens, detects reuse and revokes the entire session", async () => {
    const agent = request.agent(server.app);
    const login = await post(agent, "/api/auth/login", {
      email: "mesero@example.test",
      password: testPassword,
    });
    const cookies = login.headers["set-cookie"] as unknown as string[];
    const refresh = cookies
      .find((c) => c.startsWith("refresh="))!
      .split(";")[0]!;
    const session = (
      await context.db.query(
        "SELECT id,user_id FROM sessions ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0] as { id: string; user_id: string };
    const expired = await new SignJWT({ sid: session.id })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(session.user_id)
      .setIssuer("nativos1109")
      .setAudience("pos")
      .setExpirationTime("0s")
      .sign(new TextEncoder().encode(context.c.JWT_SECRET));
    expect(
      (
        await request(server.app)
          .get("/api/auth/me")
          .set("Cookie", `access=${expired}`)
      ).status,
    ).toBe(401);
    expect((await post(agent, "/api/auth/refresh", {})).status).toBe(200);
    expect(
      (await replayRefresh(server.app, refresh, randomUUID())).status,
    ).toBe(401);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
  it("consumes recovery codes once and returns generic password reset responses", async () => {
    const a = request.agent(server.app);
    await post(a, "/api/auth/login", {
      email: "administrador@example.test",
      password: testPassword,
    });
    expect(
      (await post(a, "/api/auth/mfa/verify", { code: adminCodes[0] })).status,
    ).toBe(200);
    await post(a, "/api/auth/logout", {});
    await post(a, "/api/auth/login", {
      email: "administrador@example.test",
      password: testPassword,
    });
    expect(
      (await post(a, "/api/auth/mfa/verify", { code: adminCodes[0] })).status,
    ).toBe(401);
    const known = await post(a, "/api/auth/forgot-password", {
      email: "mesero@example.test",
    });
    const unknown = await post(a, "/api/auth/forgot-password", {
      email: "nobody@example.test",
    });
    expect(known.body).toEqual(unknown.body);
    expect(
      (
        await context.db.query(
          "SELECT hash FROM password_resets WHERE hash=$1",
          [digest(resetToken)],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await post(a, "/api/auth/reset-password", {
          token: resetToken,
          password: "changed-password-for-test",
        })
      ).status,
    ).toBe(200);
    expect((await waiter.get("/api/auth/me")).status).toBe(401);
    expect(
      (
        await post(a, "/api/auth/reset-password", {
          token: resetToken,
          password: "changed-again-password",
        })
      ).status,
    ).toBe(400);
  });
  it("logs out securely, blocks disabled users and limits MFA brute force", async () => {
    expect((await post(cashier, "/api/auth/logout", {})).status).toBe(200);
    expect((await cashier.get("/api/auth/me")).status).toBe(401);
    await context.db.query("UPDATE users SET active=false WHERE role='CAJERO'");
    expect(
      (
        await post(cashier, "/api/auth/login", {
          email: "cajero@example.test",
          password: testPassword,
        })
      ).status,
    ).toBe(401);
    // Attack a real MFA challenge: without one, every attempt fails anyway and
    // a 429 would only prove a shared anonymous bucket exists.
    const attacker = request.agent(server.app);
    expect(
      (
        await post(attacker, "/api/auth/login", {
          email: "administrador@example.test",
          password: testPassword,
        })
      ).body.mfaRequired,
    ).toBe(true);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push(
        (await post(attacker, "/api/auth/mfa/verify", { code: "000000" }))
          .status,
      );
    expect(codes.slice(0, 5).every((code) => code === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });
  it("returns security headers and never includes password/token/MFA secrets in audit records", async () => {
    const result = await request(server.app).get("/health");
    expect(result.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    const log = JSON.stringify(
      (await context.db.query("SELECT * FROM audit_log")).rows,
    );
    expect(log).toContain("PAYMENT_CREATED");
    expect(log).toContain("MFA_FAILURE");
    expect(log).not.toContain(testPassword);
    expect(log).not.toContain(resetToken);
  });
});
