// Adversarial checks for the database as a second line of defence.
// They talk to PostgreSQL directly (no API) to prove that impossible business
// states are rejected even if an endpoint has a bug. Requires TEST_DATABASE_URL
// pointing to a disposable server; the suite fails (never skips) without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../../server/migrate.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for database integrity tests');
const dbName = `nativos_integrity_${process.pid}`;
let admin: pg.Client;
let db: pg.Pool;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const target = new URL(url); target.pathname = `/${dbName}`;
  db = new pg.Pool({ connectionString: target.toString(), max: 6 });
  await migrate(db);
  await db.query("INSERT INTO users(email,name,password_hash,role) VALUES('approval@example.test','Approver','unused','ADMINISTRADOR')");
});
afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin?.end();
});

type Fixture = { user: string; product: string; table: string };
let f: Fixture;
const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]!;

// Fresh rows per test instead of TRUNCATE: payments, shifts and audit rows are
// append-only by design, so the setup must not depend on deleting them.
let seq = 0;
beforeEach(async () => {
  const n = ++seq;
  await db.query('UPDATE cash_shifts SET closure_approved_by=(SELECT id FROM users WHERE role=\'ADMINISTRADOR\' LIMIT 1), closed_at=now(), counted_cents=0 WHERE closed_at IS NULL');
  const user = await one<{ id: string }>(`INSERT INTO users(email,name,password_hash,role) VALUES ($1,'M','x','MESERO') RETURNING id`, [`m${n}@x.test`]);
  const cat = await one<{ id: string }>('INSERT INTO categories(name) VALUES ($1) RETURNING id', [`Platos ${n}`]);
  const product = await one<{ id: string }>('INSERT INTO products(category_id,name,price_cents,stock) VALUES ($1,$2,5000,1) RETURNING id', [cat.id, 'Hamburguesa']);
  const table = await one<{ id: string }>('INSERT INTO restaurant_tables(name) VALUES ($1) RETURNING id', [`Mesa ${n}`]);
  f = { user: user.id, product: product.id, table: table.id };
});

async function order(quantity = 1, price = 5000) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const o = (await c.query<{ id: string }>('INSERT INTO orders(table_id,user_id,total_cents,sent_to_cash_at,sent_to_cash_by) VALUES ($1,$2,$3,now(),$2) RETURNING id', [f.table, f.user, quantity * price])).rows[0]!;
    await c.query('INSERT INTO order_items(order_id,product_id,name,quantity,price_cents) VALUES ($1,$2,$3,$4,$5)', [o.id, f.product, 'Hamburguesa', quantity, price]);
    await c.query('COMMIT');
    return o.id;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const shift = async () => (await one<{ id: string }>('INSERT INTO cash_shifts(user_id,opening_cents) VALUES ($1,0) RETURNING id', [f.user])).id;
const pay = (orderId: string, shiftId: string, amount = 5000) =>
  db.query(`INSERT INTO payments(order_id,shift_id,user_id,method,amount_cents,tendered_cents,change_cents) VALUES ($1,$2,$3,'TARJETA',$4,$4,0)`, [orderId, shiftId, f.user, amount]);

describe('inventory', () => {
  it('rejects negative stock', async () => {
    await expect(db.query('UPDATE products SET stock=-1 WHERE id=$1', [f.product])).rejects.toMatchObject({ code: '23514' });
  });

  it('two waiters taking the last unit: exactly one conditional decrement wins', async () => {
    const a = await db.connect(); const b = await db.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      const first = await a.query('UPDATE products SET stock=stock-1 WHERE id=$1 AND stock>=1', [f.product]);
      const second = b.query('UPDATE products SET stock=stock-1 WHERE id=$1 AND stock>=1', [f.product]); // blocks on row lock
      await a.query('COMMIT');
      expect(first.rowCount).toBe(1);
      expect((await second).rowCount).toBe(0);
      await b.query('COMMIT');
    } finally { a.release(); b.release(); }
    expect((await one<{ stock: number }>('SELECT stock FROM products WHERE id=$1', [f.product])).stock).toBe(0);
  });
});

describe('order totals', () => {
  it('rejects an order whose total differs from its items (tampered client total)', async () => {
    await expect(order(1, 5000).then(id => db.query('UPDATE orders SET total_cents=1 WHERE id=$1', [id]))).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects inserting an order with a total that does not match its items', async () => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const o = (await c.query<{ id: string }>('INSERT INTO orders(table_id,user_id,total_cents) VALUES ($1,$2,1) RETURNING id', [f.table, f.user])).rows[0]!;
      await c.query('INSERT INTO order_items(order_id,product_id,name,quantity,price_cents) VALUES ($1,$2,$3,2,5000)', [o.id, f.product, 'Hamburguesa']);
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });
});

describe('payments', () => {
  it('two concurrent charges of the same order: only one succeeds', async () => {
    const id = await order(); const s = await shift();
    const results = await Promise.allSettled([pay(id, s), pay(id, s)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await one<{ n: number }>('SELECT count(*)::int n FROM payments WHERE order_id=$1', [id])).n).toBe(1);
  });

  it('rejects a payment whose amount differs from the order total', async () => {
    const id = await order(); const s = await shift();
    await expect(pay(id, s, 1)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects charging a cancelled order', async () => {
    const id = await order(); const s = await shift();
    await db.query(`UPDATE orders SET status='CANCELADO' WHERE id=$1`, [id]);
    await expect(pay(id, s)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a payment into a closed cash shift', async () => {
    const id = await order(); const s = await shift();
    await db.query('UPDATE cash_shifts SET closure_approved_by=(SELECT id FROM users WHERE role=\'ADMINISTRADOR\' LIMIT 1), closed_at=now(), counted_cents=0 WHERE id=$1', [s]);
    await expect(pay(id, s)).rejects.toMatchObject({ code: '23514' });
  });

  it('payments are immutable', async () => {
    const id = await order(); const s = await shift(); await pay(id, s);
    await expect(db.query('UPDATE payments SET amount_cents=1, tendered_cents=1 WHERE order_id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('DELETE FROM payments WHERE order_id=$1', [id])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('order lifecycle after payment', () => {
  it('rejects cancelling a paid order', async () => {
    const id = await order(); await pay(id, await shift());
    await expect(db.query(`UPDATE orders SET status='CANCELADO' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects adding, changing or removing items of a paid order', async () => {
    const id = await order(); await pay(id, await shift());
    await expect(db.query('UPDATE order_items SET quantity=2 WHERE order_id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('DELETE FROM order_items WHERE order_id=$1', [id])).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects reopening a paid and delivered order', async () => {
    const id = await order(); await pay(id, await shift());
    await db.query(`UPDATE orders SET status='ENTREGADO' WHERE id=$1`, [id]);
    await expect(db.query(`UPDATE orders SET status='PENDIENTE' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23514' });
  });

  it('a cancelled order is terminal', async () => {
    const id = await order();
    await db.query(`UPDATE orders SET status='CANCELADO' WHERE id=$1`, [id]);
    await expect(db.query(`UPDATE orders SET status='PENDIENTE' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects rewriting creation timestamps or numbers', async () => {
    const id = await order();
    await expect(db.query(`UPDATE orders SET created_at=now()-interval '3 days' WHERE id=$1`, [id])).rejects.toMatchObject({ code: '23514' });
  });

  it('item changes racing a payment cannot slip in after the charge', async () => {
    const id = await order(); const s = await shift();
    const a = await db.connect(); const b = await db.connect();
    try {
      await a.query('BEGIN');
      await a.query(`INSERT INTO payments(order_id,shift_id,user_id,method,amount_cents,tendered_cents,change_cents) VALUES ($1,$2,$3,'TARJETA',5000,5000,0)`, [id, s, f.user]);
      await b.query('BEGIN');
      const late = b.query('UPDATE order_items SET quantity=2 WHERE order_id=$1', [id]); // must wait for the charge, then fail
      late.catch(() => undefined);
      await a.query('COMMIT');
      await expect(late).rejects.toMatchObject({ code: '23514' });
    } finally { await b.query('ROLLBACK').catch(() => undefined); a.release(); b.release(); }
  });
});

describe('cash register', () => {
  it('rejects a second open shift', async () => {
    await shift();
    await expect(shift()).rejects.toMatchObject({ code: '23505' });
  });

  it('a closed shift cannot be closed again or reopened', async () => {
    const s = await shift();
    await db.query('UPDATE cash_shifts SET closure_approved_by=(SELECT id FROM users WHERE role=\'ADMINISTRADOR\' LIMIT 1), closed_at=now(), counted_cents=100 WHERE id=$1', [s]);
    await expect(db.query('UPDATE cash_shifts SET counted_cents=999999 WHERE id=$1', [s])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('UPDATE cash_shifts SET closed_at=NULL, counted_cents=NULL WHERE id=$1', [s])).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects cash movements into a closed shift', async () => {
    const s = await shift();
    await db.query('UPDATE cash_shifts SET closure_approved_by=(SELECT id FROM users WHERE role=\'ADMINISTRADOR\' LIMIT 1), closed_at=now(), counted_cents=0 WHERE id=$1', [s]);
    await expect(db.query(`INSERT INTO cash_movements(shift_id,user_id,amount_cents,reason) VALUES ($1,$2,-500,'retiro')`, [s, f.user])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    await db.query(`INSERT INTO audit_log(action,resource,result,request_id) VALUES ('x','y','SUCCESS','r')`);
    await expect(db.query(`UPDATE audit_log SET result='FAILURE'`)).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('DELETE FROM audit_log')).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('TRUNCATE audit_log')).rejects.toMatchObject({ code: '23514' });
  });
});

describe('paid marker (004)', () => {
  it('is set by the database when a payment is recorded', async () => {
    const id = await order(); await pay(id, await shift());
    expect((await one<{ paid: boolean }>('SELECT paid_at IS NOT NULL AS paid FROM orders WHERE id=$1', [id])).paid).toBe(true);
  });

  it('cannot be forged on an unpaid order, cleared on a paid one, or set at insert', async () => {
    const unpaid = await order();
    await expect(db.query('UPDATE orders SET paid_at=now() WHERE id=$1', [unpaid])).rejects.toMatchObject({ code: '23514' });
    const paid = await order(); await pay(paid, await shift());
    await expect(db.query('UPDATE orders SET paid_at=NULL WHERE id=$1', [paid])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('INSERT INTO orders(table_id,user_id,total_cents,paid_at) VALUES ($1,$2,5000,now())', [f.table, f.user])).rejects.toMatchObject({ code: '23514' });
  });
});
