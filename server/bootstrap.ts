import { z } from 'zod';
import { loadEnv } from './env.js';
import { config } from './config.js';
import { database, transaction } from './db.js';
import { passwordHash, passwordSchema } from './security.js';
loadEnv(); const db = database(config());
try {
  const email = z.email().parse(process.env.BOOTSTRAP_EMAIL).toLowerCase();
  const password = passwordSchema.parse(process.env.BOOTSTRAP_PASSWORD); const hash = await passwordHash(password);
  await transaction(db, async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(1109002)');
    if ((await tx.query('SELECT id FROM users LIMIT 1')).rowCount) throw new Error('Bootstrap refused: users already exist');
    await tx.query("INSERT INTO users(name,email,password_hash,role) VALUES ('Administrador',$1,$2,'ADMINISTRADOR')", [email, hash]);
  });
  process.stdout.write('Administrador creado. Debe configurar MFA al iniciar sesión. Elimina las variables BOOTSTRAP.\n');
} finally { await db.end(); }
