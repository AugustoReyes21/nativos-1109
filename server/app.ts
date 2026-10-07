import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { pino } from "pino";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { auth, type Mailer } from "./auth.js";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { AppError, fail } from "./common.js";
import { pos } from "./pos.js";

export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : "info",
  redact: ["password", "token", "secret", "authorization", "cookie"],
});
export function createApp(db: DB, c: Config, mail: Mailer) {
  const app = express();
  app.disable("x-powered-by");
  // Render terminates TLS at its proxy; direct deployment must preserve this topology.
  app.set("trust proxy", c.NODE_ENV === "production" ? 1 : false);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-ID", req.requestId);
    const start = performance.now();
    res.on("finish", () =>
      logger.info(
        {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - start),
        },
        "request",
      ),
    );
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: c.NODE_ENV === "production" ? [] : null,
        },
      },
      strictTransportSecurity:
        c.NODE_ENV === "production"
          ? { maxAge: 31536000, includeSubDomains: true }
          : false,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use((req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    if (req.path.startsWith("/api") || req.path.startsWith("/health"))
      res.setHeader("Cache-Control", "no-store");
    const origin = req.get("Origin");
    if (origin && origin !== c.APP_ORIGIN)
      return next(new AppError(403, "ORIGIN_FORBIDDEN", "Origen no permitido"));
    if (origin === c.APP_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", c.APP_ORIGIN);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.vary("Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Idempotency-Key,X-CSRF-Protection",
      );
      return res.sendStatus(204);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (origin !== c.APP_ORIGIN || req.get("X-CSRF-Protection") !== "1")
        return next(
          new AppError(403, "CSRF_REJECTED", "Solicitud no permitida"),
        );
      if (!req.is("application/json"))
        return next(new AppError(415, "JSON_REQUIRED", "Se requiere JSON"));
    }
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get(["/health", "/health/ready"], async (_req, res) => {
    try {
      const result = await db.query(
        "SELECT name FROM schema_migrations WHERE name='001_initial.sql'",
      );
      if (result.rowCount !== 1)
        return res.status(503).json({ status: "unavailable" });
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  const security = auth(db, c, mail);
  security.routes(app);
  // Short-lived streams are re-authenticated each tick and invalidated by durable DB revisions.
  const streams = new Set<() => void>();
  app.get("/api/events", security.requireUser, async (req, res) => {
    await security.limit(req, "events", 60, 60);
    res
      .status(200)
      .set({
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
    res.flushHeaders();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let previous = "";
    const close = () => {
      active = false;
      clearTimeout(timer);
      streams.delete(close);
      res.end();
    };
    streams.add(close);
    req.on("close", close);
    async function tick() {
      if (!active) return;
      try {
        await security.authenticate(req);
        const revision = (
          await db.query<{ id: string }>(
            "SELECT COALESCE(max(id),0)::text AS id FROM events",
          )
        ).rows[0]!.id;
        if (!active) return;
        if (revision !== previous) {
          if (!res.write(`id: ${revision}\nevent: sync\ndata: {}\n\n`))
            return close();
          previous = revision;
        } else if (!res.write(": heartbeat\n\n")) return close();
      } catch {
        return close();
      }
      timer = setTimeout(() => {
        void tick();
      }, 2000);
      timer.unref();
    }
    void tick();
  });
  pos(app, db, security);
  app.use("/api", () => fail(404, "NOT_FOUND", "Recurso no encontrado"));
  app.use(express.static(resolve("dist/web"), { index: false, maxAge: "1h" }));
  app.get("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(resolve("dist/web/index.html"));
  });
  const errors: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "No se pudo completar la operación";
    if (error instanceof AppError) {
      status = error.status;
      code = error.code;
      message = error.message;
    } else if (error instanceof ZodError) {
      status = 400;
      code = "VALIDATION_ERROR";
      message = "Verifica los campos de la solicitud";
    } else if (error instanceof SyntaxError) {
      status = 400;
      code = "INVALID_JSON";
      message = "JSON inválido";
    } else if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "23505") {
        status = 409;
        code = "CONFLICT";
        message = "El registro ya existe o la operación ya fue realizada";
      }
      if (error.code === "23503" || error.code === "23514") {
        status = 400;
        code = "INVALID_REFERENCE";
        message = "Los datos no son válidos";
      }
      if (["40P01", "55P03", "40001", "57014"].includes(String(error.code))) {
        status = 503;
        code = "RETRY_REQUIRED";
        message =
          "Operación temporalmente ocupada. Reintenta con el mismo intento";
      }
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      status = 413;
      code = "PAYLOAD_TOO_LARGE";
      message = "Solicitud demasiado grande";
    }
    if (status >= 500)
      logger.error({ requestId: req.requestId, code }, "request_failed");
    if (status === 429) res.setHeader("Retry-After", "300");
    res
      .status(status)
      .json({ error: { code, message, requestId: req.requestId } });
  };
  app.use(errors);
  return {
    app,
    closeStreams: () => {
      for (const close of streams) close();
    },
  };
}
