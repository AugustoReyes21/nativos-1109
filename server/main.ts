import nodemailer from "nodemailer";
import { loadEnv } from "./env.js";
import { config } from "./config.js";
import { database } from "./db.js";
import { createApp, logger } from "./app.js";
loadEnv();
const c = config();
const db = database(c);
db.on("error", () =>
  logger.error({ code: "DATABASE_POOL_ERROR" }, "database_error"),
);
const transport = c.SMTP_HOST
  ? nodemailer.createTransport({
      host: c.SMTP_HOST,
      port: c.SMTP_PORT,
      secure: c.SMTP_PORT === 465,
      requireTLS: true,
      auth: c.SMTP_USER
        ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD }
        : undefined,
    })
  : null;
const { app, closeStreams } = createApp(db, c, async (email, token) => {
  if (!transport || !c.MAIL_FROM) {
    logger.error(
      { code: "SMTP_NOT_CONFIGURED" },
      "password_reset_delivery_failed",
    );
    throw new Error("SMTP not configured");
  }
  try {
    await transport.sendMail({
      from: c.MAIL_FROM,
      to: email,
      subject: "Recuperación de Nativos1109",
      text: `Abre este enlace en los próximos 15 minutos: ${c.APP_ORIGIN}/#reset=${token}\nSi no solicitaste el cambio, ignora este correo.`,
    });
  } catch {
    logger.error(
      { code: "SMTP_DELIVERY_FAILED" },
      "password_reset_delivery_failed",
    );
    throw new Error("Delivery failed");
  }
});
const server = app.listen(c.PORT, "0.0.0.0", () =>
  logger.info({ port: c.PORT }, "server_started"),
);
server.requestTimeout = 15000;
server.headersTimeout = 20000;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  closeStreams();
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  server.close(() => {
    void db.end().then(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  });
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
