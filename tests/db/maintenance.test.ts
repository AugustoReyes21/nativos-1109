// Retention must remove only expired auxiliary rows and never business data,
// the audit log, or anything still needed for refresh-token reuse detection.
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../server/migrate.js';
import { purge } from '../../server/maintenance.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for maintenance tests');
const dbName = `nativos_maintenance_${process.pid}`;
let admin: pg.Client; let db: pg.Pool;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.query(`CREATE DATABASE ${dbName}`);
  const target = new URL(url); target.pathname = `/${dbName}`;
  db = new pg.Pool({ connectionString: target.toString() }); await migrate(db);
});
afterAll(async () => { await db?.end(); await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin?.end(); });

it('purges expired auxiliary rows and keeps live ones, business data and the audit log', async () => {
  const user = (await db.query<{ id: string }>(`INSERT INTO users(email,name,password_hash,role) VALUES ('p@x.test','P','x','MESERO') RETURNING id`)).rows[0]!.id;
  const session = async (expires: string) => (await db.query<{ id: string }>(`INSERT INTO sessions(user_id,expires_at) VALUES ($1,${expires}) RETURNING id`, [user])).rows[0]!.id;
  const old = await session(`now()-interval '40 days'`); const live = await session(`now()+interval '1 hour'`);
  await db.query(`INSERT INTO refresh_tokens(hash,session_id,used_at) VALUES ('old',$1,now()-interval '40 days'),('live-used',$2,now()-interval '1 hour')`, [old, live]);
  await db.query(`INSERT INTO rate_limits VALUES ('expired',1,now()-interval '1 second'),('active',1,now()+interval '1 hour')`);
  await db.query(`INSERT INTO auth_challenges(hash,user_id,purpose,expires_at) VALUES ('c-old',$1,'LOGIN',now()-interval '2 days'),('c-new',$1,'LOGIN',now()+interval '5 minutes')`, [user]);
  await db.query(`INSERT INTO password_resets(hash,user_id,expires_at) VALUES ('r-old',$1,now()-interval '2 days'),('r-new',$1,now()+interval '5 minutes')`, [user]);
  await db.query(`INSERT INTO idempotency(user_id,key,operation,request_hash,response,created_at) VALUES ($1,$2,'x','h','{}',now()-interval '8 days'),($1,$3,'x','h','{}',now())`, [user, randomUUID(), randomUUID()]);
  await db.query(`INSERT INTO events(created_at) VALUES (now()-interval '3 days'),(now()-interval '2 days')`);
  await db.query(`INSERT INTO audit_log(action,resource,result,request_id,created_at) VALUES ('OLD','x','SUCCESS','r',now()-interval '400 days')`);
  const latest = (await db.query<{ id: string }>('SELECT max(id)::text AS id FROM events')).rows[0]!.id;

  const removed = await purge(db);
  expect(removed).toMatchObject({ rate_limits: 1, auth_challenges: 1, password_resets: 1, refresh_tokens: 1, sessions: 1, idempotency: 1, events: 1 });
  const keys = async (sql: string) => (await db.query<{ k: string }>(sql)).rows.map(r => r.k).sort();
  expect(await keys('SELECT key AS k FROM rate_limits')).toEqual(['active']);
  expect(await keys('SELECT hash AS k FROM refresh_tokens')).toEqual(['live-used']);
  expect(await keys('SELECT hash AS k FROM auth_challenges')).toEqual(['c-new']);
  expect(await keys('SELECT hash AS k FROM password_resets')).toEqual(['r-new']);
  expect((await db.query('SELECT 1 FROM sessions WHERE id=$1', [live])).rowCount).toBe(1);
  expect((await db.query<{ id: string }>('SELECT max(id)::text AS id FROM events')).rows[0]!.id).toBe(latest);
  expect((await db.query(`SELECT 1 FROM audit_log WHERE action='OLD'`)).rowCount).toBe(1);
  expect((await db.query('SELECT 1 FROM users WHERE id=$1', [user])).rowCount).toBe(1);
});
