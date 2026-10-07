// Independent adversarial review of exclusive table selection (owner requirement:
// a table selected by one waiter cannot be selected by another, even before any
// order exists). Real PostgreSQL, concurrent requests, never mocks.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { Secret } from 'otpauth';
import { createApp } from '../../server/app.js';
import { config, type Config } from '../../server/config.js';
import { database, type DB } from '../../server/db.js';
import { migrate } from '../../server/migrate.js';
import { encrypt, passwordHash, totp } from '../../server/security.js';
import { csrfPost } from '../helpers.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for table claim review tests');
const password = 'Claims-review-password-2026';
const mfaSecret = new Secret({ size: 20 }).base32;
const dbName = `nativos_claims_review_${process.pid}`;

type Agent = ReturnType<typeof request.agent>;
type Status = { tableId: string; blocked: boolean; claimId?: string | null; reserved?: boolean; state: string };
let admin: pg.Client; let db: DB; let c: Config; let server: ReturnType<typeof createApp>;
let soda: string; const tables: string[] = []; const users: Record<string, string> = {};
const agents: Record<string, Agent> = {};

const post = (a: Agent, path: string, body: object) => csrfPost(a, 'post', path, body, randomUUID());
const patch = (a: Agent, path: string, body: object) => csrfPost(a, 'patch', path, body, randomUUID());
const claim = (who: string, table: string, claimId = randomUUID()) => post(agents[who]!, `/api/tables/${table}/claim`, { claimId });
const order = (who: string, table: string, claimId?: string) =>
  post(agents[who]!, '/api/orders', { tableId: table, ...(claimId ? { claimId } : {}), items: [{ productId: soda, quantity: 1 }] });
const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]!;
const count = async (sql: string, params: unknown[] = []) => (await one<{ n: number }>(sql, params)).n;
async function login(key: string) {
  const a = request.agent(server.app);
  expect((await post(a, '/api/auth/login', { email: `${key.toLowerCase()}@example.test`, password })).status).toBe(200);
  if (key === 'admin') expect((await post(a, '/api/auth/mfa/verify', { code: totp(mfaSecret).generate() })).status).toBe(200);
  agents[key] = a;
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.query(`CREATE DATABASE ${dbName}`);
  const target = new URL(url); target.pathname = `/${dbName}`;
  c = config({ NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:3000', DATABASE_URL: target.toString(),
    JWT_SECRET: randomBytes(48).toString('base64url'), MFA_KEY: randomBytes(32).toString('hex') });
  db = database(c); await migrate(db);
  const hash = await passwordHash(password);
  for (const [key, role] of [['admin', 'ADMINISTRADOR'], ['waiterA', 'MESERO'], ['waiterB', 'MESERO'], ['cashier', 'CAJERO'], ['kitchen', 'COCINA']] as const) {
    users[key] = (await one<{ id: string }>('INSERT INTO users(email,name,password_hash,role,mfa_secret,mfa_enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [`${key.toLowerCase()}@example.test`, key, hash, role, role === 'ADMINISTRADOR' ? encrypt(mfaSecret, c.MFA_KEY) : null, role === 'ADMINISTRADOR'])).id;
  }
  const category = (await one<{ id: string }>(`INSERT INTO categories(name) VALUES ('Bebidas') RETURNING id`)).id;
  soda = (await one<{ id: string }>(`INSERT INTO products(category_id,name,price_cents,stock) VALUES ($1,'Refresco',1500,1000) RETURNING id`, [category])).id;
  for (let i = 1; i <= 12; i++) tables.push((await one<{ id: string }>('INSERT INTO restaurant_tables(name,floor) VALUES ($1,$2) RETURNING id', [`Mesa ${i}`, i <= 6 ? 1 : 2])).id);
  server = createApp(db, c, async () => undefined);
  for (const key of ['admin', 'waiterA', 'waiterB', 'cashier', 'kitchen']) await login(key);
});
afterAll(async () => {
  server?.closeStreams(); await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
});
// Every test starts from a free dining room: no live claims, no open orders.
beforeEach(async () => {
  await db.query('DELETE FROM rate_limits');
  await db.query('UPDATE table_claims SET expires_at=now()-interval \'1 second\'');
  await db.query(`UPDATE orders SET status='CANCELADO' WHERE status IN ('PENDIENTE','EN_PREPARACION','LISTO')`);
});

describe('exclusive selection under concurrency', () => {
  it('two waiters selecting the same free table at the same instant: exactly one wins', async () => {
    const t = tables[0]!;
    // Even indexes are waiter A, odd indexes waiter B.
    const results = await Promise.all([...Array(5)].flatMap(() => [claim('waiterA', t), claim('waiterB', t)]));
    expect(results.every(r => [200, 409].includes(r.status))).toBe(true);
    const winnersA = results.filter((r, i) => i % 2 === 0 && r.status === 200).length;
    const winnersB = results.filter((r, i) => i % 2 === 1 && r.status === 200).length;
    expect(winnersA === 0 || winnersB === 0).toBe(true);
    expect(winnersA + winnersB).toBeGreaterThan(0);
    const owner = await one<{ user_id: string }>('SELECT user_id FROM table_claims WHERE table_id=$1 AND expires_at>now()', [t]);
    expect(owner.user_id).toBe(winnersA ? users.waiterA : users.waiterB);
    expect((await claim(winnersA ? 'waiterB' : 'waiterA', t)).status).toBe(409);
  });

  it('two waiters ordering directly (no prior selection) on the same free table: only one order exists', async () => {
    const t = tables[1]!;
    const results = await Promise.all([order('waiterA', t), order('waiterB', t)]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await count(`SELECT count(DISTINCT user_id)::int n FROM orders WHERE table_id=$1 AND status<>'CANCELADO'`, [t])).toBe(1);
  });

  it('a selection racing a direct order by another waiter never lets both through', async () => {
    const t = tables[2]!;
    const [selected, ordered] = await Promise.all([claim('waiterA', t), order('waiterB', t)]);
    const won = [selected.status === 200, ordered.status === 201];
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(won[0] ? ordered.status : selected.status).toBe(409);
  });

  it('the loser cannot order on the selected table, before or after the winner orders', async () => {
    const t = tables[3]!; const id = randomUUID();
    expect((await claim('waiterA', t, id)).status).toBe(200);
    const before = await count('SELECT stock AS n FROM products WHERE id=$1', [soda]);
    expect((await order('waiterB', t)).status).toBe(409);
    expect(await count('SELECT stock AS n FROM products WHERE id=$1', [soda])).toBe(before);
    expect((await order('waiterA', t, id)).status).toBe(201);
    expect((await order('waiterB', t)).status).toBe(409);
    expect((await claim('waiterB', t)).status).toBe(409);
  });
});

describe('lease lifecycle', () => {
  it('an expired selection frees the table; stale renew/release/order from the old owner cannot disturb the new one', async () => {
    const t = tables[4]!; const old = randomUUID();
    expect((await claim('waiterA', t, old)).status).toBe(200);
    await db.query('UPDATE table_claims SET expires_at=now()-interval \'1 second\' WHERE table_id=$1', [t]);
    const fresh = randomUUID();
    expect((await claim('waiterB', t, fresh)).status).toBe(200);
    expect((await post(agents.waiterA!, `/api/tables/${t}/claim/renew`, { claimId: old })).status).toBe(409);
    expect((await post(agents.waiterA!, `/api/tables/${t}/claim/release`, { claimId: old })).status).toBe(200);
    expect((await order('waiterA', t, old)).status).toBe(409);
    expect(await one('SELECT claim_id, user_id FROM table_claims WHERE table_id=$1 AND expires_at>now()', [t])).toEqual({ claim_id: fresh, user_id: users.waiterB });
  });

  it('an order sent with an expired selection is refused and nothing is written', async () => {
    const t = tables[5]!; const id = randomUUID();
    expect((await claim('waiterA', t, id)).status).toBe(200);
    await db.query('UPDATE table_claims SET expires_at=now()-interval \'1 second\' WHERE table_id=$1', [t]);
    const orders = await count('SELECT count(*)::int n FROM orders WHERE table_id=$1', [t]);
    expect((await order('waiterA', t, id)).body.error?.code).toBe('TABLE_CLAIM_EXPIRED');
    expect(await count('SELECT count(*)::int n FROM orders WHERE table_id=$1', [t])).toBe(orders);
  });

  it('logout and administrative deactivation free the table immediately', async () => {
    const t = tables[6]!;
    expect((await claim('waiterA', t)).status).toBe(200);
    expect((await post(agents.waiterA!, '/api/auth/logout', {})).status).toBe(200);
    expect((await claim('waiterB', t)).status).toBe(200);
    await login('waiterA');
    const u = tables[7]!;
    expect((await claim('waiterB', u)).status).toBe(200);
    expect((await patch(agents.admin!, `/api/users/${users.waiterB}`, { role: 'MESERO', active: false })).status).toBe(200);
    expect((await claim('waiterA', u)).status).toBe(200);
    expect((await patch(agents.admin!, `/api/users/${users.waiterB}`, { role: 'MESERO', active: true })).status).toBe(200);
    await login('waiterB');
  });
});

describe('abuse and privacy', () => {
  it('one waiter cannot hoard every table and lock colleagues out of the dining room', async () => {
    const results = await Promise.all(tables.map(t => claim('waiterA', t)));
    const held = results.filter(r => r.status === 200).length;
    // A compromised or careless account must not be able to block the whole service.
    expect(held).toBeLessThan(tables.length);
    const free = tables.find((_t, i) => results[i]!.status !== 200)!;
    expect((await claim('waiterB', free)).status).toBe(200);
  });

  it('kitchen and cashier cannot select tables; unknown or inactive tables are rejected', async () => {
    for (const who of ['kitchen', 'cashier']) expect((await claim(who, tables[8]!)).status).toBe(403);
    expect((await claim('waiterA', randomUUID())).status).toBe(400);
    const inactive = (await one<{ id: string }>(`INSERT INTO restaurant_tables(name,floor,active) VALUES ('Retirada',1,false) RETURNING id`)).id;
    expect((await claim('waiterA', inactive)).status).toBe(400);
  });

  it('another waiter never learns the owner, the claim id or the order contents', async () => {
    const t = tables[9]!; const id = randomUUID();
    expect((await claim('waiterA', t, id)).status).toBe(200);
    const body = JSON.stringify((await agents.waiterB!.get('/api/tables/status')).body);
    const mine = ((await agents.waiterB!.get('/api/tables/status')).body as Status[]).find(s => s.tableId === t)!;
    expect(mine.blocked).toBe(true);
    expect(body).not.toContain(id); expect(body).not.toContain(users.waiterA!); expect(body).not.toContain('waiterA');
  });
});
