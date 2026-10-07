import { afterAll, beforeAll, expect, it } from "vitest";
import {
  testDatabase,
  seedUsers,
  origin,
  csrfPost,
  testPassword,
} from "./helpers.js";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { diagnostic } from "../server/diagnostics.js";
import request from "supertest";
let context: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  context = await testDatabase();
  await seedUsers(context.db);
});
afterAll(async () => {
  await context.db.end();
});
it("signed CSRF rejects missing tokens and matching forged cookie/header strings", async () => {
  const { app } = createApp(context.db, context.c, async () => undefined);
  for (const token of ["", "attacker-controlled.signature"]) {
    const response = await request(app)
      .post("/api/auth/login")
      .set("Origin", origin)
      .set("X-CSRF-Protection", "1")
      .set("X-CSRF-Token", token)
      .set("Cookie", ["csrf=" + token, "csrf-binding=attacker-binding"])
      .send({});
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("CSRF_REJECTED");
  }
  const malformed = await request(app)
    .get("/api/auth/csrf")
    .set("Cookie", "csrf=j%3A%7B%7D");
  expect(malformed.status).toBe(200);
});
it("CSRF tokens cannot cross browser bindings or survive login elevation", async () => {
  const { app } = createApp(context.db, context.c, async () => undefined);
  const a = request.agent(app);
  const anonymous = await a.get("/api/auth/csrf");
  const token = anonymous.body.token as string;
  const forgedBinding = await request(app)
    .post("/api/auth/login")
    .set("Origin", origin)
    .set("X-CSRF-Protection", "1")
    .set("X-CSRF-Token", token)
    .set("Cookie", ["csrf=" + token, "csrf-binding=different-browser"])
    .send({});
  expect(forgedBinding.status).toBe(403);
  expect(
    (
      await csrfPost(
        a,
        "post",
        "/api/auth/login",
        { email: "mesero@example.test", password: testPassword },
        randomUUID(),
      )
    ).status,
  ).toBe(200);
  const stale = await a
    .post("/api/auth/logout")
    .set("Origin", origin)
    .set("X-CSRF-Protection", "1")
    .set("X-CSRF-Token", token)
    .send({});
  expect(stale.status).toBe(403);
  expect(
    (await csrfPost(a, "post", "/api/auth/logout", {}, randomUUID())).status,
  ).toBe(200);
});
it("overload limiting rejects a burst without needing database access", async () => {
  const { app } = createApp(context.db, context.c, async () => undefined);
  for (let batch = 0; batch < 30; batch++) {
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => request(app).get("/health/live")),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
  }
  const limited = await request(app).get("/health/live");
  expect(limited.status).toBe(429);
  expect(limited.body.error.code).toBe("RATE_LIMITED");
  expect(limited.headers["retry-after"]).toBeDefined();
});
it("diagnostics retain database cause and stack frames without messages, values or SQL", () => {
  const error = Object.assign(new Error("secret-password-in-a-query"), {
    code: "23505",
    constraint: "users_email_key",
    detail: "another-secret",
    query: "private-query",
  });
  const output = JSON.stringify(diagnostic(error));
  expect(output).toContain("23505");
  expect(output).toContain("users_email_key");
  expect(output).not.toContain("secret-password");
  expect(output).not.toContain("another-secret");
  expect(output).not.toContain("private-query");
});
it("readiness fails if any required migration is absent", async () => {
  const { app } = createApp(context.db, context.c, async () => undefined);
  expect((await request(app).get("/health/ready")).status).toBe(200);
  await context.db.query(
    "DELETE FROM schema_migrations WHERE name='003_session_retry_audit.sql'",
  );
  expect((await request(app).get("/health/ready")).status).toBe(503);
});
it("a movement waiting on a concurrent cash close cannot enter the closed register", async () => {
  const db = context.db;
  const u = (
    await db.query(
      "INSERT INTO users(name,email,password_hash,role) VALUES ('Fixture','fixture@example.test','unused','ADMINISTRADOR') RETURNING id",
    )
  ).rows[0] as { id: string };
  const s = (
    await db.query(
      "INSERT INTO cash_shifts(user_id,opening_cents) VALUES ($1,0) RETURNING id",
      [u.id],
    )
  ).rows[0] as { id: string };
  const closing = await db.connect();
  const moving = await db.connect();
  try {
    await closing.query("BEGIN");
    await closing.query("SELECT id FROM cash_shifts WHERE id=$1 FOR UPDATE", [
      s.id,
    ]);
    const move = moving.query(
      "INSERT INTO cash_movements(shift_id,user_id,amount_cents,reason) VALUES ($1,$2,500,'fixture')",
      [s.id, u.id],
    );
    const rejected = expect(move).rejects.toMatchObject({ code: "23514" });
    await closing.query(
      "UPDATE cash_shifts SET closed_at=now(),counted_cents=0,expected_cents=0,difference_cents=0,closure_approved_by=$2 WHERE id=$1",
      [s.id, u.id],
    );
    await closing.query("COMMIT");
    await rejected;
    expect(
      (
        await db.query(
          "SELECT count(*) FROM cash_movements WHERE shift_id=$1",
          [s.id],
        )
      ).rows[0].count,
    ).toBe("0");
  } finally {
    closing.release();
    moving.release();
  }
});
