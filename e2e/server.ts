import { createApp } from "../server/app.js";
import { testDatabase } from "../tests/helpers.js";
process.env.TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://nativos:local_only@127.0.0.1:55432/nativos_e2e_test";
const { db, c } = await testDatabase();
c.APP_ORIGIN = "http://127.0.0.1:3000";
const { app, closeStreams } = createApp(db, c, async () => {
  throw new Error("Test mail disabled");
});
const server = app.listen(3000, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    closeStreams();
    server.close(() => {
      void db.end().then(() => process.exit(0));
    });
  });
