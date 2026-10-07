// Two-level dining room: table status must be computed by the server for every
// table without leaking other waiters' orders, and table metadata must be
// administered only by authorised roles. Real PostgreSQL, never mocks.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../../server/app.js';
import { config, type Config } from '../../server/config.js';
import { database, type DB } from '../../server/db.js';
import { migrate } from '../../server/migrate.js';
import { encrypt, passwordHash, totp } from '../../server/security.js';
import { Secret } from 'otpauth';
import { csrfPost } from '../helpers.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for floor plan tests');
const origin = 'http://localhost:3000';
const password = 'Floorplan-test-password-2026';
const mfaSecret = new Secret({ size: 20 }).base32;
const dbName = `nativos_floors_${process.pid}`;

type Agent = ReturnType<typeof request.agent>;
type Status = { tableId: string; state: string; openOrders: number; mine: boolean; pendingCents?: number };
let admin: pg.Client; let db: DB; let c: Config; let server: ReturnType<typeof createApp>;
const agents: Record<string, Agent> = {};
let upstairs: string; let downstairs: string; let soda: string;

const post = (a: Agent, path: string, body: object, key = randomUUID()) => csrfPost(a, 'post', path, body, key);
const patch = (a: Agent, path: string, body: object) => csrfPost(a, 'patch', path, body, randomUUID());
const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]!;
const statusOf = async (who: string, tableId: string) =>
  ((await agents[who]!.get('/api/tables/status')).body as Status[]).find(s => s.tableId === tableId)!;
const advance = async (orderId: string, who: string, status: string) => {
  const { version } = await one<{ version: number }>('SELECT version FROM orders WHERE id=$1', [orderId]);
  expect((await patch(agents[who]!, `/api/orders/${orderId}/status`, { status, version })).status).toBe(200);
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.query(`CREATE DATABASE ${dbName}`);
  const target = new URL(url); target.pathname = `/${dbName}`;
  c = config({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: target.toString(),
    JWT_SECRET: randomBytes(48).toString('base64url'), MFA_KEY: randomBytes(32).toString('hex') });
  db = database(c); await migrate(db);
  const hash = await passwordHash(password);
  for (const [key, role] of [['admin', 'ADMINISTRADOR'], ['waiterA', 'MESERO'], ['waiterB', 'MESERO'], ['cashier', 'CAJERO'], ['kitchen', 'COCINA']] as const) {
    await db.query('INSERT INTO users(email,name,password_hash,role,mfa_secret,mfa_enabled) VALUES ($1,$2,$3,$4,$5,$6)',
      [`${key.toLowerCase()}@example.test`, key, hash, role, role === 'ADMINISTRADOR' ? encrypt(mfaSecret, c.MFA_KEY) : null, role === 'ADMINISTRADOR']);
  }
  const category = (await one<{ id: string }>(`INSERT INTO categories(name) VALUES ('Bebidas') RETURNING id`)).id;
  soda = (await one<{ id: string }>(`INSERT INTO products(category_id,name,price_cents,stock) VALUES ($1,'Refresco',1500,500) RETURNING id`, [category])).id;
  downstairs = (await one<{ id: string }>(`INSERT INTO restaurant_tables(name,floor) VALUES ('Mesa 1',1) RETURNING id`)).id;
  upstairs = (await one<{ id: string }>(`INSERT INTO restaurant_tables(name,floor,capacity,shape) VALUES ('Terraza 4',2,6,'round') RETURNING id`)).id;
  server = createApp(db, c, async () => undefined);
  for (const key of ['admin', 'waiterA', 'waiterB', 'cashier', 'kitchen']) {
    const a = request.agent(server.app);
    expect((await post(a, '/api/auth/login', { email: `${key.toLowerCase()}@example.test`, password })).status).toBe(200);
    if (key === 'admin') expect((await post(a, '/api/auth/mfa/verify', { code: totp(mfaSecret).generate() })).status).toBe(200);
    agents[key] = a;
  }
});
afterAll(async () => {
  server?.closeStreams(); await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end();
});
beforeEach(async () => { await db.query('DELETE FROM rate_limits'); });

describe('table status (server-side, every role)', () => {
  it('another waiter sees the table as busy, but never its amount or order details', async () => {
    const order = await post(agents.waiterA!, '/api/orders', { tableId: upstairs, items: [{ productId: soda, quantity: 2 }] });
    expect(order.status).toBe(201);
    const forB = await statusOf('waiterB', upstairs);
    expect(forB).toMatchObject({ state: 'service', openOrders: 1, mine: false });
    expect(forB).not.toHaveProperty('pendingCents');
    expect(JSON.stringify((await agents.waiterB!.get('/api/tables/status')).body)).not.toContain(order.body.id as string);
    expect(((await agents.waiterB!.get('/api/orders')).body as { id: string }[]).map(o => o.id)).not.toContain(order.body.id);
    expect(await statusOf('waiterA', upstairs)).toMatchObject({ mine: true });
    expect(await statusOf('cashier', upstairs)).toMatchObject({ pendingCents: 3000 });
  });

  it('follows the full service cycle: service → ready → payment → available', async () => {
    await db.query('UPDATE cash_shifts SET closure_approved_by=(SELECT id FROM users WHERE role=\'ADMINISTRADOR\' LIMIT 1), closed_at=now(), counted_cents=0 WHERE closed_at IS NULL');
    expect((await post(agents.cashier!, '/api/cash/open', { openingCents: 0 })).status).toBe(201);
    const id = (await post(agents.waiterA!, '/api/orders', { tableId: downstairs, items: [{ productId: soda, quantity: 1 }] })).body.id as string;
    expect((await statusOf('waiterB', downstairs)).state).toBe('service');
    await advance(id, 'kitchen', 'EN_PREPARACION'); await advance(id, 'kitchen', 'LISTO');
    expect((await statusOf('waiterB', downstairs)).state).toBe('ready');
    await advance(id, 'waiterA', 'ENTREGADO');
    expect((await statusOf('waiterB', downstairs)).state).toBe('payment');
    expect((await post(agents.waiterA!, `/api/orders/${id}/send-to-cash`, { version: 4 })).status).toBe(200);
    expect((await post(agents.cashier!, '/api/payments', { orderId: id, method: 'TARJETA', tenderedCents: 1500 })).status).toBe(201);
    expect((await statusOf('waiterB', downstairs)).state).toBe('available');
  });

  it('kitchen tickets carry the floor so runners go to the right level', async () => {
    const orders = (await agents.kitchen!.get('/api/orders')).body as { table_id: string; table_floor: number; table_name: string }[];
    expect(orders.find(o => o.table_id === upstairs)).toMatchObject({ table_floor: 2, table_name: 'Terraza 4' });
  });
});

describe('table administration', () => {
  it('waiters, cashiers and kitchen cannot create or edit tables', async () => {
    for (const who of ['waiterA', 'cashier', 'kitchen']) {
      expect((await post(agents[who]!, '/api/tables', { name: `X ${who}`, floor: 2 })).status).toBe(403);
      expect((await patch(agents[who]!, `/api/tables/${upstairs}`, { name: 'Hacked', floor: 1, capacity: 1, shape: 'square', displayOrder: 0, version: 1 })).status).toBe(403);
    }
    expect((await one<{ name: string }>('SELECT name FROM restaurant_tables WHERE id=$1', [upstairs])).name).toBe('Terraza 4');
  });

  it('rejects out-of-range and unexpected fields', async () => {
    for (const body of [{ name: 'Z', floor: 3 }, { name: 'Z', capacity: 0 }, { name: 'Z', capacity: 13 }, { name: 'Z', shape: 'hexagon' },
      { name: 'Z', active: false }, { name: 'Z', version: 1 }, { name: '' }, { name: 'a\u0000b' }]) {
      expect((await post(agents.admin!, '/api/tables', body)).status).toBe(400);
    }
  });

  it('a stale edit gets 409 and changes are audited with details', async () => {
    const { version } = await one<{ version: number }>('SELECT version FROM restaurant_tables WHERE id=$1', [downstairs]);
    const body = { name: 'Mesa 1', floor: 1, capacity: 8, shape: 'rectangle', displayOrder: 1 };
    expect((await patch(agents.admin!, `/api/tables/${downstairs}`, { ...body, version })).status).toBe(200);
    expect((await patch(agents.admin!, `/api/tables/${downstairs}`, { ...body, capacity: 2, version })).status).toBe(409);
    expect((await one<{ capacity: number }>('SELECT capacity FROM restaurant_tables WHERE id=$1', [downstairs])).capacity).toBe(8);
    const audit = await one<{ details: { capacity: number } }>(`SELECT details FROM audit_log WHERE action='TABLE_UPDATED' AND resource_id=$1 ORDER BY id DESC LIMIT 1`, [downstairs]);
    expect(audit.details.capacity).toBe(8);
  });

  it('renaming or moving a table never rewrites the label of orders already sent', async () => {
    const id = (await post(agents.waiterA!, '/api/orders', { tableId: upstairs, items: [{ productId: soda, quantity: 1 }] })).body.id as string;
    const { version } = await one<{ version: number }>('SELECT version FROM restaurant_tables WHERE id=$1', [upstairs]);
    expect((await patch(agents.admin!, `/api/tables/${upstairs}`, { name: 'Mesa 9', floor: 1, capacity: 6, shape: 'round', displayOrder: 0, version })).status).toBe(200);
    expect(await one('SELECT table_name, table_floor FROM orders WHERE id=$1', [id])).toEqual({ table_name: 'Terraza 4', table_floor: 2 });
    await expect(db.query(`UPDATE orders SET table_name='Otra' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23514' });
  });
});
