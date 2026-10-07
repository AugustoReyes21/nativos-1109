import { createApp } from "../server/app.js";
import { seedUsers, testDatabase } from "../tests/helpers.js";
process.env.TEST_DATABASE_URL =
  process.env.LOAD_DATABASE_URL ??
  "postgresql://nativos:local_only@127.0.0.1:55432/nativos_load_test";
const { db, c } = await testDatabase();
await db.query(
  "TRUNCATE users,rate_limits,categories,restaurant_tables,events RESTART IDENTITY CASCADE",
);
await seedUsers(db);
const category = (
  await db.query("INSERT INTO categories(name) VALUES ('Carga') RETURNING id")
).rows[0] as { id: string };
await db.query(
  "INSERT INTO products(name,category_id,price_cents,stock) VALUES ('Producto de prueba',$1,1000,100000)",
  [category.id],
);
await db.query("INSERT INTO restaurant_tables(name) VALUES ('Mesa carga')");
c.APP_ORIGIN = process.env.LOAD_ORIGIN ?? "http://host.docker.internal:3001";
const { app, closeStreams } = createApp(db, c, async () => {
  throw new Error("Mail disabled");
});
const server = app.listen(3001, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    closeStreams();
    server.close(() => {
      void db.end().then(() => process.exit(0));
    });
  });
