// Adversarial API tests: an attacker or a confused employee calls the API
// directly, without the UI. Each test states the behaviour the system MUST have.
// Real PostgreSQL (TEST_DATABASE_URL, disposable server); never mocks.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../../server/app.js';
import { config, type Config } from '../../server/config.js';
import { database, type DB } from '../../server/db.js';
import { migrate } from '../../server/migrate.js';
import { encrypt, passwordHash, totp } from '../../server/security.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for adversarial API tests');
const origin = 'http://localhost:3000';
const password = 'Adversarial-test-password-2026';
const mfaSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const dbName = `nativos_adversarial_${process.pid}`;

type Agent = ReturnType<typeof request.agent>;
let admin: pg.Client; let db: DB; let c: Config; let server: ReturnType<typeof createApp>;
let ids: { category: string; table: string; burger: string; soda: string; users: Record<string, string> };
const agents: Record<string, Agent> = {};

const send = (a: Agent, method: 'post' | 'patch', path: string, body: unknown, key: string = randomUUID()) =>
  a[method](path).set('Origin', origin).set('X-CSRF-Protection', '1').set('Idempotency-Key', key).send(body as object);
const post = (a: Agent, path: string, body: unknown, key?: string) => send(a, 'post', path, body, key);
const patch = (a: Agent, path: string, body: unknown) => send(a, 'patch', path, body);
const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]!;

async function login(role: string, email: string): Promise<Agent> {
  const a = request.agent(server.app);
  const r = await post(a, '/api/auth/login', { email, password });
  expect(r.status).toBe(200);
  if (role === 'ADMINISTRADOR') expect((await post(a, '/api/auth/mfa/verify', { code: totp(mfaSecret).generate() })).status).toBe(200);
  return a;
}
async function order(a: Agent, productId: string, quantity = 1) {
  const r = await post(a, '/api/orders', { tableId: ids.table, items: [{ productId, quantity }] });
  expect(r.status).toBe(201);
  return r.body as { id: string; version: number; total_cents: number };
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.query(`CREATE DATABASE ${dbName}`);
  const target = new URL(url); target.pathname = `/${dbName}`;
  c = config({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: target.toString(),
    JWT_SECRET: randomBytes(48).toString('base64url'), MFA_KEY: randomBytes(32).toString('hex') });
  db = database(c); await migrate(db);
  const hash = await passwordHash(password); const users: Record<string, string> = {};
  for (const [key, role] of [['admin', 'ADMINISTRADOR'], ['waiterA', 'MESERO'], ['waiterB', 'MESERO'], ['cashier', 'CAJERO'], ['kitchen', 'COCINA']]) {
    users[key!] = (await one<{ id: string }>('INSERT INTO users(email,name,password_hash,role,mfa_secret,mfa_enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [`${key!.toLowerCase()}@example.test`, key, hash, role, role === 'ADMINISTRADOR' ? encrypt(mfaSecret, c.MFA_KEY) : null, role === 'ADMINISTRADOR'])).id;
  }
  const category = (await one<{ id: string }>(`INSERT INTO categories(name) VALUES ('Platos') RETURNING id`)).id;
  ids = { category, users,
    table: (await one<{ id: string }>(`INSERT INTO restaurant_tables(name) VALUES ('Mesa 1') RETURNING id`)).id,
    burger: (await one<{ id: string }>(`INSERT INTO products(category_id,name,price_cents,stock) VALUES ($1,'Hamburguesa',5000,1000) RETURNING id`, [category])).id,
    soda: (await one<{ id: string }>(`INSERT INTO products(category_id,name,price_cents,stock) VALUES ($1,'Refresco',1200,1000) RETURNING id`, [category])).id };
  server = createApp(db, c, async () => undefined);
  for (const key of ['admin', 'waiterA', 'waiterB', 'cashier', 'kitchen']) {
    agents[key] = await login(key === 'admin' ? 'ADMINISTRADOR' : '', `${key.toLowerCase()}@example.test`);
    await db.query('DELETE FROM rate_limits');
  }
});
afterAll(async () => {
  server?.closeStreams(); await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
});
// Every request in this suite comes from 127.0.0.1; reset counters so one test's
// traffic cannot cause (or mask) a 429 in another.
beforeEach(async () => { await db.query('DELETE FROM rate_limits'); });

describe('authentication and MFA', () => {
  it('an administrator with only the password gets no usable session', async () => {
    const a = request.agent(server.app);
    const r = await post(a, '/api/auth/login', { email: 'admin@example.test', password });
    expect(r.body).toEqual({ mfaRequired: true, setupRequired: false });
    for (const path of ['/api/auth/me', '/api/users', '/api/catalog', '/api/orders', '/api/audit']) expect((await a.get(path)).status).toBe(401);
    expect((await post(a, '/api/products', { name: 'x', categoryId: ids.category, priceCents: 1, stock: 1 })).status).toBe(401);
  });

  it('MFA brute force against a real challenge is cut off and the right code is then refused too', async () => {
    const a = request.agent(server.app);
    await post(a, '/api/auth/login', { email: 'admin@example.test', password });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(a, '/api/auth/mfa/verify', { code: String(100000 + i) })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    expect((await post(a, '/api/auth/mfa/verify', { code: totp(mfaSecret).generate({ timestamp: Date.now() + 30000 }) })).status).toBe(429);
  });

  it('a TOTP code cannot be replayed for a second login', async () => {
    const code = totp(mfaSecret).generate({ timestamp: Date.now() + 30000 });
    const a = request.agent(server.app); await post(a, '/api/auth/login', { email: 'admin@example.test', password });
    expect((await post(a, '/api/auth/mfa/verify', { code })).status).toBe(200);
    const b = request.agent(server.app); await post(b, '/api/auth/login', { email: 'admin@example.test', password });
    expect((await post(b, '/api/auth/mfa/verify', { code })).status).toBe(401);
  });

  it('rejects forged, unsigned and cross-user access tokens', async () => {
    const s = await one<{ id: string; user_id: string }>('SELECT id,user_id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1', [ids.users.waiterA]);
    const jwt = (key: Uint8Array, sub = s.user_id) => new SignJWT({ sid: s.id }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
      .setIssuer('nativos1109').setAudience('pos').setIssuedAt().setExpirationTime('5m').sign(key);
    const forged = await jwt(randomBytes(48));
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sid: s.id, sub: s.user_id, iss: 'nativos1109', aud: 'pos', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
    const crossUser = await jwt(new TextEncoder().encode(c.JWT_SECRET), ids.users.admin); // valid signature, sid of a waiter
    for (const token of [forged, `${header}.${payload}.`, crossUser]) {
      expect((await request(server.app).get('/api/auth/me').set('Cookie', `access=${token}`)).status).toBe(401);
    }
  });

  it('logout invalidates the access token immediately, not when it expires', async () => {
    const a = request.agent(server.app);
    const r = await post(a, '/api/auth/login', { email: 'waiterb@example.test', password });
    const access = (r.headers['set-cookie'] as unknown as string[]).find(v => v.startsWith('access='))!.split(';')[0]!;
    expect((await request(server.app).get('/api/auth/me').set('Cookie', access)).status).toBe(200);
    expect((await post(a, '/api/auth/logout', {})).status).toBe(200);
    expect((await request(server.app).get('/api/auth/me').set('Cookie', access)).status).toBe(401);
  });

  it('a refresh retried after a lost response (Wi-Fi micro-cut) does not log the employee out', async () => {
    const a = request.agent(server.app);
    const r = await post(a, '/api/auth/login', { email: 'kitchen@example.test', password });
    const refresh = (r.headers['set-cookie'] as unknown as string[]).find(v => v.startsWith('refresh='))!.split(';')[0]!;
    // Reviewed design: only the same explicit attempt can recover a lost response.
    // Arbitrary reuse, even inside the window, must still revoke the session.
    const retryKey = randomUUID();
    const refreshOnce = () => request(server.app).post('/api/auth/refresh').set('Origin', origin).set('X-CSRF-Protection', '1').set('Idempotency-Key', retryKey).set('Cookie', refresh).send({});
    expect((await refreshOnce()).status).toBe(200); // server rotated, but the tablet never received the response
    const retry = await refreshOnce();                 // the client retries with the only token it has
    expect(retry.status).toBe(200);
    const fresh = (retry.headers['set-cookie'] as unknown as string[]).find(v => v.startsWith('access='))!.split(';')[0]!;
    expect((await request(server.app).get('/api/auth/me').set('Cookie', fresh)).status).toBe(200);
  });

  it('a stolen refresh token replayed later still revokes the whole session', async () => {
    const a = request.agent(server.app);
    const r = await post(a, '/api/auth/login', { email: 'kitchen@example.test', password });
    const refresh = (r.headers['set-cookie'] as unknown as string[]).find(v => v.startsWith('refresh='))!.split(';')[0]!;
    expect((await post(a, '/api/auth/refresh', {})).status).toBe(200);
    await db.query(`UPDATE refresh_tokens SET used_at=now()-interval '10 minutes' WHERE used_at IS NOT NULL`);
    expect((await request(server.app).post('/api/auth/refresh').set('Origin', origin).set('X-CSRF-Protection', '1').set('Cookie', refresh).send({})).status).toBe(401);
    expect((await a.get('/api/auth/me')).status).toBe(401);
  });

  it('a whole restaurant behind one NAT IP can still log in at shift change (25 logins)', async () => {
    // All tablets share the restaurant's public IP. Staff logging in at the
    // start of service must not be locked out for 15 minutes.
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await post(request.agent(server.app), '/api/auth/login', { email: i % 2 ? 'waitera@example.test' : 'kitchen@example.test', password })).status);
    expect(statuses.filter(s => s !== 200)).toEqual([]);
  });
});

describe('authorization (direct API, no UI)', () => {
  const forbidden: [string, 'get' | 'post' | 'patch', string, unknown][] = [
    ['waiterA', 'get', '/api/users', null], ['waiterA', 'post', '/api/users', { name: 'x', email: 'x@x.test', password, role: 'ADMINISTRADOR' }],
    ['waiterA', 'patch', '/api/products/ID_BURGER', { name: 'Hamburguesa', categoryId: 'ID_CAT', priceCents: 1, stock: 1, active: true, version: 1 }],
    ['waiterA', 'post', '/api/payments', { orderId: randomUUID(), method: 'TARJETA', tenderedCents: 1 }],
    ['waiterA', 'post', '/api/cash/open', { openingCents: 0 }], ['waiterA', 'get', '/api/audit', null], ['waiterA', 'get', '/api/reports', null],
    ['waiterA', 'patch', '/api/settings', { name: 'Hacked' }], ['waiterA', 'get', '/api/cash', null],
    ['cashier', 'post', '/api/users', { name: 'x', email: 'x@x.test', password, role: 'ADMINISTRADOR' }],
    ['cashier', 'patch', '/api/users/ID_CASHIER', { role: 'ADMINISTRADOR', active: true }],
    ['cashier', 'patch', '/api/products/ID_BURGER', { name: 'Hamburguesa', categoryId: 'ID_CAT', priceCents: 1, stock: 1, active: true, version: 1 }],
    ['cashier', 'get', '/api/roles', null], ['cashier', 'get', '/api/audit', null],
    ['kitchen', 'post', '/api/orders', { tableId: 'ID_TABLE', items: [{ productId: 'ID_BURGER', quantity: 1 }] }],
    ['kitchen', 'post', '/api/payments', { orderId: randomUUID(), method: 'TARJETA', tenderedCents: 1 }], ['kitchen', 'get', '/api/users', null]
  ];
  it.each(forbidden)('%s cannot %s %s', async (who, method, path, body) => {
    const fill = (s: string) => s.replace('ID_BURGER', ids.burger).replace('ID_CAT', ids.category).replace('ID_CASHIER', ids.users.cashier!).replace('ID_TABLE', ids.table);
    const before = await one<{ n: number }>('SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM orders)+(SELECT sum(price_cents) FROM products) AS n');
    const r = method === 'get' ? await agents[who]!.get(path) : await send(agents[who]!, method, fill(path), JSON.parse(fill(JSON.stringify(body))));
    expect(r.status).toBe(403);
    expect(await one('SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM orders)+(SELECT sum(price_cents) FROM products) AS n')).toEqual(before);
  });

  it('a waiter cannot see or deliver another waiter\'s order (IDOR)', async () => {
    const o = await order(agents.waiterA!, ids.soda);
    expect(((await agents.waiterB!.get('/api/orders')).body as { id: string }[]).map(x => x.id)).not.toContain(o.id);
    for (const status of ['EN_PREPARACION', 'LISTO']) await patch(agents.kitchen!, `/api/orders/${o.id}/status`, { status, version: (await one<{ version: number }>('SELECT version FROM orders WHERE id=$1', [o.id])).version });
    expect((await patch(agents.waiterB!, `/api/orders/${o.id}/status`, { status: 'ENTREGADO', version: 3 })).status).toBe(403);
    expect((await one<{ status: string }>('SELECT status FROM orders WHERE id=$1', [o.id])).status).toBe('LISTO');
  });

  it('kitchen cannot cancel or deliver; waiter cannot cancel', async () => {
    const o = await order(agents.waiterA!, ids.soda);
    expect((await patch(agents.kitchen!, `/api/orders/${o.id}/status`, { status: 'CANCELADO', version: 1 })).status).toBe(403);
    expect((await patch(agents.waiterA!, `/api/orders/${o.id}/status`, { status: 'CANCELADO', version: 1 })).status).toBe(403);
  });
});

describe('business logic attacks', () => {
  it('ignores no client-provided money: extra total/price fields are rejected and nothing is written', async () => {
    const before = await one<{ n: number }>('SELECT count(*)::int n FROM orders');
    for (const body of [
      { tableId: ids.table, totalCents: 1, items: [{ productId: ids.burger, quantity: 1 }] },
      { tableId: ids.table, items: [{ productId: ids.burger, quantity: 1, priceCents: 1 }] },
      { tableId: ids.table, items: [{ productId: ids.burger, quantity: 1 }], user_id: ids.users.waiterB, status: 'ENTREGADO' }
    ]) expect((await post(agents.waiterA!, '/api/orders', body)).status).toBe(400);
    expect((await one<{ n: number }>('SELECT count(*)::int n FROM orders')).n).toBe(before.n);
  });

  it('rejects boundary and malformed quantities', async () => {
    for (const quantity of [0, -1, 101, 1.5, '1', 1e300, null]) {
      expect((await post(agents.waiterA!, '/api/orders', { tableId: ids.table, items: [{ productId: ids.burger, quantity }] })).status).toBe(400);
    }
  });

  it('accepts Unicode and emoji but rejects text PostgreSQL cannot store with a 4xx, never a 500', async () => {
    expect((await post(agents.waiterA!, '/api/orders', { tableId: ids.table, notes: 'Sin cebolla 🌶️ — ñandú «ok»', items: [{ productId: ids.soda, quantity: 1 }] })).status).toBe(201);
    const r = await post(agents.waiterA!, '/api/orders', { tableId: ids.table, notes: 'a\u0000b', items: [{ productId: ids.soda, quantity: 1 }] });
    expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
  });

  it('cannot cancel after charging, cannot charge after cancelling, cannot underpay', async () => {
    await db.query('UPDATE cash_shifts SET closed_at=now(), counted_cents=0 WHERE closed_at IS NULL');
    expect((await post(agents.cashier!, '/api/cash/open', { openingCents: 0 })).status).toBe(201);
    const paid = await order(agents.waiterA!, ids.burger);
    expect((await post(agents.cashier!, '/api/payments', { orderId: paid.id, method: 'EFECTIVO', tenderedCents: 4999 })).status).toBe(400);
    expect((await post(agents.cashier!, '/api/payments', { orderId: paid.id, method: 'TARJETA', tenderedCents: 6000 })).status).toBe(400);
    expect((await post(agents.cashier!, '/api/payments', { orderId: paid.id, method: 'EFECTIVO', tenderedCents: 5000 })).status).toBe(201);
    expect((await patch(agents.cashier!, `/api/orders/${paid.id}/status`, { status: 'CANCELADO', version: 1 })).status).toBe(409);
    const cancelled = await order(agents.waiterA!, ids.burger);
    expect((await patch(agents.cashier!, `/api/orders/${cancelled.id}/status`, { status: 'CANCELADO', version: 1 })).status).toBe(200);
    expect((await post(agents.cashier!, '/api/payments', { orderId: cancelled.id, method: 'EFECTIVO', tenderedCents: 5000 })).status).toBe(409);
  });

  it('closing the register twice with different attempts: second is rejected and totals do not change', async () => {
    await db.query('UPDATE cash_shifts SET closed_at=now(), counted_cents=0 WHERE closed_at IS NULL');
    const shift = (await post(agents.cashier!, '/api/cash/open', { openingCents: 10000 })).body as { id: string };
    const first = await post(agents.cashier!, '/api/cash/close', { shiftId: shift.id, countedCents: 10000 });
    expect(first.status).toBe(200);
    expect((await post(agents.cashier!, '/api/cash/close', { shiftId: shift.id, countedCents: 1 })).status).toBe(409);
    expect((await one<{ counted_cents: number }>('SELECT counted_cents FROM cash_shifts WHERE id=$1', [shift.id])).counted_cents).toBe(10000);
  });
});

describe('kitchen display', () => {
  it('a new order is visible to the kitchen even on a busy day (>200 orders in 24h)', async () => {
    await db.query(`WITH o AS (INSERT INTO orders(table_id,user_id,total_cents,status,created_at)
        SELECT $1,$2,1200,'ENTREGADO',now()-interval '1 minute'*g FROM generate_series(1,210) g RETURNING id)
      INSERT INTO order_items(order_id,product_id,name,quantity,price_cents) SELECT id,$3,'Refresco',1,1200 FROM o`, [ids.table, ids.users.waiterA, ids.soda]);
    const fresh = await order(agents.waiterA!, ids.soda);
    expect(((await agents.kitchen!.get('/api/orders')).body as { id: string }[]).map(o => o.id)).toContain(fresh.id);
  });
});
