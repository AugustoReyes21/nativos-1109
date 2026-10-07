import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { doubleCsrf } from "csrf-csrf";
import helmet from "helmet";
import { pino } from "pino";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readdirSync } from "node:fs";
import { ZodError } from "zod";
import { auth, type Mailer } from "./auth.js";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { AppError, fail } from "./common.js";
import { pos } from "./pos.js";
import { diagnostic } from "./diagnostics.js";
import { digest, randomToken } from "./security.js";

export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : "info",
  redact: ["password", "token", "secret", "authorization", "cookie"],
});
export function createApp(db: DB, c: Config, mail: Mailer) {
  const migrations = readdirSync("migrations").filter((name) =>
    name.endsWith(".sql"),
  );
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
          fontSrc: ["'self'"],
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
      crossOriginEmbedderPolicy: { policy: "require-corp" },
    }),
  );
  // Per-process overload protection precedes DB work. Persistent, stricter
  // login/MFA/reset/refresh/admin limits below remain authoritative across replicas.
  app.use(
    rateLimit({
      windowMs: 10000,
      limit: 3000,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, _res, next) =>
        next(
          new AppError(
            429,
            "RATE_LIMITED",
            "Demasiadas solicitudes. Intenta más tarde",
          ),
        ),
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
        "Content-Type,Idempotency-Key,X-CSRF-Protection,X-CSRF-Token",
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
  const prefix = c.NODE_ENV === "production" ? "__Host-" : "";
  const cookieOptions = {
    httpOnly: true,
    secure: c.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
  };
  const csrf = doubleCsrf({
    getSecret: () => digest("nativos-csrf-v1:" + c.JWT_SECRET),
    getSessionIdentifier: (req) => {
      // Bind to the refresh credential, then the pre-login challenge, then a
      // random anonymous browser binding. Authentication changes invalidate tokens.
      for (const name of ["refresh", "challenge", "csrf-binding"]) {
        const value: unknown = req.cookies[prefix + name];
        if (typeof value === "string" && value) return name + ":" + value;
      }
      return fail(403, "CSRF_REJECTED", "Solicitud no permitida");
    },
    cookieName: prefix + "csrf",
    cookieOptions,
    getCsrfTokenFromRequest: (req) => req.get("X-CSRF-Token"),
  });
  app.get("/api/auth/csrf", (req, res) => {
    // cookie-parser can decode JSON-prefixed cookies; malformed client values
    // must not reach the library's string parser or become a server error.
    if (typeof req.cookies[prefix + "csrf"] !== "string")
      delete req.cookies[prefix + "csrf"];
    if (typeof req.cookies[prefix + "csrf-binding"] !== "string") {
      const binding = randomToken();
      req.cookies[prefix + "csrf-binding"] = binding;
      res.cookie(prefix + "csrf-binding", binding, cookieOptions);
    }
    res.json({ token: csrf.generateCsrfToken(req, res) });
  });
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      // Explicit cookie/header comparison plus signed, session-bound HMAC
      // validation: matching attacker-controlled strings alone never suffice.
      const token: unknown =
        c.NODE_ENV === "production"
          ? req.cookies["__Host-csrf"]
          : req.cookies.csrf;
      if (typeof token !== "string" || token !== req.get("X-CSRF-Token"))
        return next(
          new AppError(403, "CSRF_REJECTED", "Solicitud no permitida"),
        );
    }
    csrf.doubleCsrfProtection(req, res, next);
  });
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get(["/health", "/health/ready"], async (_req, res) => {
    try {
      const result = await db.query(
        "SELECT name FROM schema_migrations WHERE name=ANY($1::text[])",
        [migrations],
      );
      if (result.rowCount !== migrations.length)
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
    res.status(200).set({
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
    } else if (error === csrf.invalidCsrfTokenError) {
      status = 403;
      code = "CSRF_REJECTED";
      message = "Solicitud no permitida";
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
      if (error.code === "23503") {
        status = 400;
        code = "INVALID_REFERENCE";
        message = "Los datos no son válidos";
      }
      if (error.code === "23514") {
        status = 409;
        code = "INVALID_STATE";
        message = "La operación viola el estado del recurso";
      }
      if (["22021", "22P05"].includes(String(error.code))) {
        status = 400;
        code = "INVALID_TEXT";
        message = "El texto contiene caracteres no permitidos";
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
      logger.error(
        { requestId: req.requestId, code, ...diagnostic(error) },
        "request_failed",
      );
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
