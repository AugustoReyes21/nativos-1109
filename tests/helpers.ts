import { randomBytes } from "node:crypto";
import { config } from "../server/config.js";
import { database } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { passwordHash } from "../server/security.js";
export const testPassword = "Integration-test-password-2026";
export const origin = "http://localhost:3000";
export const testConfig = () =>
  config({
    NODE_ENV: "test",
    APP_ORIGIN: origin,
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      "postgresql://nativos:local_only@127.0.0.1:55432/nativos_test",
    JWT_SECRET: randomBytes(48).toString("base64url"),
    MFA_KEY: randomBytes(32).toString("hex"),
  });
export async function testDatabase() {
  const c = testConfig();
  if (!new URL(c.DATABASE_URL).pathname.endsWith("_test"))
    throw new Error("Tests require a dedicated *_test database");
  const db = database(c);
  await migrate(db);
  return { db, c };
}
export async function seedUsers(db: ReturnType<typeof database>) {
  const hash = await passwordHash(testPassword);
  for (const role of ["ADMINISTRADOR", "MESERO", "CAJERO", "COCINA"]) {
    await db.query(
      "INSERT INTO users(email,name,password_hash,role) VALUES ($1,$2,$3,$2)",
      [`${role.toLowerCase()}@example.test`, role, hash],
    );
  }
  return hash;
}
