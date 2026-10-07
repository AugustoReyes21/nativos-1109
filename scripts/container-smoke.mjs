import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../dist/server/app.js';
import { config } from '../dist/server/config.js';
import { database } from '../dist/server/db.js';
import { passwordHash, passwordVerify } from '../dist/server/security.js';
process.env.JWT_SECRET = randomBytes(48).toString('base64url');
process.env.MFA_KEY = randomBytes(32).toString('hex');
const c = config(); const db = database(c);
const { app, closeStreams } = createApp(db, c, async () => { throw new Error('No delivery in smoke test'); });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
try {
  const address = server.address();
  const origin = 'http://127.0.0.1:' + address.port;
  const health = await fetch(origin + '/health/ready'); assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(health.headers.get('strict-transport-security'));
  assert.equal((await fetch(origin)).status, 200);
  const password = randomBytes(24).toString('hex');
  assert.equal(await passwordVerify(await passwordHash(password), password), true);
  console.log('Linux production-mode smoke passed: readiness, static UI, HSTS and native Argon2id.');
} finally { closeStreams(); await new Promise(resolve => server.close(resolve)); await db.end(); }
