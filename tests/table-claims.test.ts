import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { digest } from "../server/security.js";
import { csrfPost, seedUsers, testDatabase, testPassword } from "./helpers.js";

describe("exclusive table selection before order creation", () => {
  let context: Awaited<ReturnType<typeof testDatabase>>;
  let server: ReturnType<typeof createApp>;
  let a: ReturnType<typeof request.agent>,
    b: ReturnType<typeof request.agent>,
    cashier: ReturnType<typeof request.agent>;
  let table: string, second: string, product: string;
  const post = (
    agent: ReturnType<typeof request.agent>,
    path: string,
    body: object,
    key = randomUUID(),
  ) => csrfPost(agent, "post", path, body, key);
  const claim = (
    agent: ReturnType<typeof request.agent>,
    id = table,
    claimId = randomUUID(),
  ) => post(agent, `/api/tables/${id}/claim`, { claimId });
  const status = async (agent: ReturnType<typeof request.agent>, id = table) =>
    (
      (await agent.get("/api/tables/status")).body as {
        tableId: string;
        state: string;
        blocked: boolean;
        claimId: string | null;
      }[]
    ).find((t) => t.tableId === id)!;
  const expire = () =>
    context.db.query(
      "UPDATE table_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE table_id=$1",
      [table],
    );
  const payload = () => ({
    tableId: table,
    items: [{ productId: product, quantity: 1 }],
  });
  beforeAll(async () => {
    context = await testDatabase();
    const hash = await seedUsers(context.db);
    await context.db.query(
      "INSERT INTO users(name,email,password_hash,role) VALUES('Second waiter','second@example.test',$1,'MESERO')",
      [hash],
    );
    const category = (
      await context.db.query(
        "INSERT INTO categories(name) VALUES('Lease fixture') RETURNING id",
      )
    ).rows[0].id as string;
    product = (
      await context.db.query(
        "INSERT INTO products(name,category_id,price_cents,stock) VALUES('Lease fixture',$1,100,100) RETURNING id",
        [category],
      )
    ).rows[0].id as string;
    server = createApp(context.db, context.c, async () => undefined);
  });
  beforeEach(async () => {
    a = request.agent(server.app);
    b = request.agent(server.app);
    cashier = request.agent(server.app);
    for (const [agent, email] of [
      [a, "mesero@example.test"],
      [b, "second@example.test"],
      [cashier, "cajero@example.test"],
    ] as const)
      expect(
        (
          await post(agent, "/api/auth/login", {
            email,
            password: testPassword,
          })
        ).status,
      ).toBe(200);
    table = (
      await context.db.query(
        "INSERT INTO restaurant_tables(name) VALUES($1) RETURNING id",
        [randomUUID()],
      )
    ).rows[0].id as string;
    second = (
      await context.db.query(
        "INSERT INTO restaurant_tables(name,floor) VALUES($1,2) RETURNING id",
        [randomUUID()],
      )
    ).rows[0].id as string;
  });
  afterAll(async () => {
    server?.closeStreams();
    await context?.db.end();
  });
  it("two simultaneous clicks produce one owner, with no empty order", async () => {
    const [one, two] = await Promise.all([claim(a), claim(b)]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const winner = one.status === 200 ? a : b,
      loser = one.status === 200 ? b : a;
    expect(await status(winner)).toMatchObject({
      state: "reserved",
      blocked: false,
    });
    expect(await status(loser)).toMatchObject({
      state: "reserved",
      blocked: true,
      claimId: null,
    });
    expect(
      (
        await context.db.query(
          "SELECT count(*) FROM orders WHERE table_id=$1",
          [table],
        )
      ).rows[0].count,
    ).toBe("0");
    expect((await post(loser, "/api/orders", payload())).body.error.code).toBe(
      "TABLE_IN_USE",
    );
  });
  it("enforces authentication, RBAC, CSRF, and strict inputs", async () => {
    expect((await claim(request.agent(server.app))).status).toBe(401);
    expect((await claim(cashier)).status).toBe(403);
    expect(
      (
        await a
          .post(`/api/tables/${table}/claim`)
          .send({ claimId: randomUUID() })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(a, `/api/tables/${table}/claim`, {
          claimId: randomUUID(),
          user_id: randomUUID(),
        })
      ).status,
    ).toBe(400);
  });
  it("replays acquisition without duplicate rows and protects renew/release from another user", async () => {
    const id = randomUUID();
    expect((await claim(a, table, id)).status).toBe(200);
    expect((await claim(a, table, id)).status).toBe(200);
    expect(
      (await post(b, `/api/tables/${table}/claim/renew`, { claimId: id }))
        .status,
    ).toBe(409);
    expect(
      (await post(b, `/api/tables/${table}/claim/release`, { claimId: id }))
        .status,
    ).toBe(200);
    expect(await status(b)).toMatchObject({ blocked: true });
    expect(
      (
        await context.db.query(
          "SELECT count(*) FROM table_claims WHERE table_id=$1",
          [table],
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("expires abandoned selections and fences delayed renewal, release, and submission", async () => {
    const old = randomUUID();
    await claim(a, table, old);
    await expire();
    expect(await status(b)).toMatchObject({
      state: "available",
      blocked: false,
    });
    const fresh = randomUUID();
    expect((await claim(b, table, fresh)).status).toBe(200);
    expect(
      (await post(a, `/api/tables/${table}/claim/renew`, { claimId: old }))
        .status,
    ).toBe(409);
    await post(a, `/api/tables/${table}/claim/release`, { claimId: old });
    expect(
      (await post(a, "/api/orders", { ...payload(), claimId: old })).status,
    ).toBe(409);
    expect(await status(b)).toMatchObject({ claimId: fresh, blocked: false });
  });
  it("does not renew an expired generation even before another waiter claims it", async () => {
    const old = randomUUID();
    await claim(a, table, old);
    await expire();
    expect((await claim(a, table, old)).body.error.code).toBe(
      "TABLE_CLAIM_EXPIRED",
    );
    expect(
      (await post(a, `/api/tables/${table}/claim/renew`, { claimId: old })).body
        .error.code,
    ).toBe("TABLE_CLAIM_EXPIRED");
    expect(
      (await post(a, "/api/orders", { ...payload(), claimId: old })).body.error
        .code,
    ).toBe("TABLE_CLAIM_EXPIRED");
  });
  it("switches atomically and retains the old table if the destination is taken", async () => {
    const old = randomUUID();
    await claim(a, table, old);
    const other = randomUUID();
    await claim(b, second, other);
    expect(
      (
        await post(a, `/api/tables/${second}/claim`, {
          claimId: randomUUID(),
          previous: { tableId: table, claimId: old },
        })
      ).status,
    ).toBe(409);
    expect(await status(a)).toMatchObject({ claimId: old });
    await post(b, `/api/tables/${second}/claim/release`, { claimId: other });
    expect(
      (
        await post(a, `/api/tables/${second}/claim`, {
          claimId: randomUUID(),
          previous: { tableId: table, claimId: old },
        })
      ).status,
    ).toBe(200);
    expect(await status(b)).toMatchObject({
      state: "available",
      blocked: false,
    });
  });
  it("releases explicit discard and logout without waiting for lease expiry", async () => {
    const id = randomUUID();
    await claim(a, table, id);
    await post(a, `/api/tables/${table}/claim/release`, { claimId: id });
    expect((await claim(b)).status).toBe(200);
    await post(b, "/api/auth/logout", {});
    expect((await claim(a)).status).toBe(200);
  });
  it("keeps other waiters out after confirmation and preserves idempotency across lease generations", async () => {
    const first = randomUUID();
    await claim(a, table, first);
    const key = randomUUID();
    const result = await post(
      a,
      "/api/orders",
      { ...payload(), claimId: first },
      key,
    );
    expect(result.status).toBe(201);
    expect(
      (
        await context.db.query(
          "SELECT request_hash FROM idempotency WHERE key=$1",
          [key],
        )
      ).rows[0].request_hash,
    ).toBe(
      digest(
        JSON.stringify({
          tableId: table,
          notes: "",
          items: [{ productId: product, quantity: 1, notes: "" }],
        }),
      ),
    );
    expect((await claim(b)).status).toBe(409);
    expect(await status(b)).toMatchObject({ blocked: true, state: "service" });
    const next = randomUUID();
    expect((await claim(a, table, next)).status).toBe(200);
    const retry = await post(
      a,
      "/api/orders",
      { ...payload(), claimId: next },
      key,
    );
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(result.body.id);
    expect(
      (
        await context.db.query(
          "SELECT count(*) FROM orders WHERE table_id=$1",
          [table],
        )
      ).rows[0].count,
    ).toBe("1");
    expect((await post(b, "/api/orders", payload())).status).toBe(409);
  });
  it("serializes direct order creation against another waiter selecting the table", async () => {
    const [selected, ordered] = await Promise.all([
      claim(a),
      post(b, "/api/orders", payload()),
    ]);
    expect([selected.status, ordered.status].sort()).toEqual(
      selected.status === 200 ? [200, 409] : [201, 409],
    );
    expect((await status(a)).blocked !== (await status(b)).blocked).toBe(true);
  });
});
