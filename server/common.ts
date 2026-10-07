import type { Request } from 'express';
import { z } from 'zod';
import type { DB, TX } from './db.js';
import { digest } from './security.js';
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const fail = (status: number, code: string, message: string): never => { throw new AppError(status, code, message); };
export type Identity = { id: string; name: string; email: string; role: string; sessionId: string; permissions: string[]; mfa_enabled: boolean };
declare module 'express-serve-static-core' { interface Request { identity?: Identity; requestId: string; } }
export const idSchema = z.uuid();
export function identity(req: Request): Identity {
  return req.identity ?? fail(401, 'UNAUTHENTICATED', 'Inicia sesión');
}
export async function audit(db: DB | TX, req: Request, action: string, resource: string, id?: string, result = 'SUCCESS', userId?: string) {
  await db.query('INSERT INTO audit_log(user_id,action,resource,resource_id,result,request_id,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [userId ?? req.identity?.id ?? null, action, resource, id ?? null, result, req.requestId, req.ip, req.get('user-agent')?.slice(0, 256)]);
}
export async function changed(tx: TX) { await tx.query('INSERT INTO events DEFAULT VALUES'); }
export async function idempotent<T>(tx: TX, req: Request, operation: string, input: unknown, action: () => Promise<T>): Promise<T> {
  const key = z.uuid().parse(req.get('Idempotency-Key')); const user = identity(req);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${user.id}:${key}`]);
  const hash = digest(JSON.stringify(input));
  const { rows } = await tx.query<{ operation: string; request_hash: string; response: T }>('SELECT * FROM idempotency WHERE user_id=$1 AND key=$2', [user.id, key]);
  if (rows[0]) {
    if (rows[0].operation !== operation || rows[0].request_hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'Este intento ya fue usado con otros datos');
    return rows[0].response;
  }
  const result = await action();
  await tx.query('INSERT INTO idempotency(user_id,key,operation,request_hash,response) VALUES ($1,$2,$3,$4,$5)', [user.id, key, operation, hash, JSON.stringify(result)]);
  return result;
}
