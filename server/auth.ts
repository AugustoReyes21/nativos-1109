import type { Express, Request, Response, NextFunction } from "express";
import { hkdfSync } from "node:crypto";
import { requiresMfa } from "./roles.js";
import { SignJWT, jwtVerify } from "jose";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { z } from "zod";
import type { Config } from "./config.js";
import { transaction, type DB, type TX } from "./db.js";
import { AppError, audit, fail, identity, type Identity } from "./common.js";
import {
  decrypt,
  digest,
  encrypt,
  passwordHash,
  passwordSchema,
  passwordVerify,
  randomToken,
  totp,
  totpStep,
} from "./security.js";

type User = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  active: boolean;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  mfa_last_step: string;
};
export type Mailer = (email: string, token: string) => Promise<void>;
const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const tokenInput = z
  .object({ code: z.string().regex(/^(\d{6}|[A-Za-z0-9_-]{32,64})$/) })
  .strict();

export function auth(db: DB, c: Config, mail: Mailer) {
  const key = new TextEncoder().encode(c.JWT_SECRET);
  // Dedicated subkey: cached refresh replacements never share a key with MFA secrets.
  const replacementKey = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(c.MFA_KEY, "hex"),
      Buffer.alloc(0),
      "nativos1109/refresh-replacement/v1",
      32,
    ),
  ).toString("hex");
  const cookie = {
    httpOnly: true,
    secure: c.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
  };
  const names = {
    access: c.NODE_ENV === "production" ? "__Host-access" : "access",
    refresh: c.NODE_ENV === "production" ? "__Host-refresh" : "refresh",
    challenge: c.NODE_ENV === "production" ? "__Host-challenge" : "challenge",
  };
  const readCookie = (req: Request, name: string): string =>
    typeof req.cookies?.[name] === "string"
      ? (req.cookies[name] as string)
      : "";
  let dummyHash: Promise<string> | undefined;

  const limitKey = (label: string, subject: string) =>
    `${label}:${digest(subject)}`;
  async function bump(label: string, subject: string, seconds: number) {
    const { rows } = await db.query<{ hits: number }>(
      `INSERT INTO rate_limits(key,hits,expires_at) VALUES ($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.hits+1 END,
      expires_at=CASE WHEN rate_limits.expires_at<now() THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END RETURNING hits`,
      [limitKey(label, subject), seconds],
    );
    return rows[0]?.hits;
  }
  async function limit(
    req: Request,
    label: string,
    max: number,
    seconds: number,
    subject = req.ip ?? "unknown",
  ) {
    if (((await bump(label, subject, seconds)) ?? max + 1) > max)
      fail(429, "RATE_LIMITED", "Demasiados intentos. Intenta más tarde");
  }
  async function accessToken(userId: string, sessionId: string) {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer("nativos1109")
      .setAudience("pos")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  }
  async function newSession(tx: TX, userId: string) {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO sessions(user_id,expires_at) VALUES ($1,now()+interval '12 hours') RETURNING id",
      [userId],
    );
    const id = rows[0]!.id;
    const refresh = randomToken();
    await tx.query(
      "INSERT INTO refresh_tokens(hash,session_id) VALUES ($1,$2)",
      [digest(refresh), id],
    );
    return { access: await accessToken(userId, id), refresh };
  }
  function setSession(
    res: Response,
    session: { access: string; refresh: string },
  ) {
    res.cookie(names.access, session.access, { ...cookie, maxAge: 300000 });
    res.cookie(names.refresh, session.refresh, {
      ...cookie,
      maxAge: 12 * 3600000,
    });
    res.clearCookie(names.challenge, cookie);
  }
  function clear(res: Response) {
    for (const name of Object.values(names)) res.clearCookie(name, cookie);
  }
  async function authenticate(req: Request): Promise<Identity> {
    let payload;
    try {
      payload = (
        await jwtVerify(readCookie(req, names.access), key, {
          algorithms: ["HS256"],
          issuer: "nativos1109",
          audience: "pos",
        })
      ).payload;
    } catch {
      return fail(401, "UNAUTHENTICATED", "Tu sesión necesita renovarse");
    }
    if (typeof payload.sid !== "string" || typeof payload.sub !== "string")
      return fail(401, "UNAUTHENTICATED", "Inicia sesión");
    const { rows } = await db.query<Identity>(
      `SELECT u.id,u.name,u.email,u.role,u.mfa_enabled,s.id AS "sessionId",
      ARRAY(SELECT permission FROM role_permissions WHERE role=u.role) AS permissions
      FROM users u JOIN roles r ON r.name=u.role JOIN sessions s ON s.user_id=u.id WHERE s.id=$1 AND u.id=$2 AND u.active
      AND s.revoked_at IS NULL AND s.expires_at>now() AND (NOT r.requires_mfa OR u.mfa_enabled)`,
      [payload.sid, payload.sub],
    );
    return rows[0] ?? fail(401, "UNAUTHENTICATED", "Inicia sesión");
  }
  const requireUser = async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    req.identity = await authenticate(req);
    next();
  };
  const permit =
    (permission: string) =>
    async (req: Request, _res: Response, next: NextFunction) => {
      if (!identity(req).permissions.includes(permission))
        fail(403, "FORBIDDEN", "No tienes permiso para esta acción");
      if (
        ["users.manage", "settings.manage", "products.write"].includes(
          permission,
        )
      )
        await limit(req, "admin", 120, 60);
      next();
    };
  async function factor(tx: TX, user: User, code: string): Promise<boolean> {
    if (/^\d{6}$/.test(code) && user.mfa_secret) {
      const step = totpStep(decrypt(user.mfa_secret, c.MFA_KEY), code);
      if (step !== null && step > Number(user.mfa_last_step)) {
        await tx.query("UPDATE users SET mfa_last_step=$1 WHERE id=$2", [
          step,
          user.id,
        ]);
        return true;
      }
    } else {
      const result = await tx.query(
        "DELETE FROM recovery_codes WHERE user_id=$1 AND hash=$2 RETURNING hash",
        [user.id, digest(code)],
      );
      return result.rowCount === 1;
    }
    return false;
  }
  async function recovery(tx: TX, userId: string) {
    await tx.query("DELETE FROM recovery_codes WHERE user_id=$1", [userId]);
    const codes = Array.from({ length: 8 }, randomToken);
    for (const code of codes)
      await tx.query("INSERT INTO recovery_codes VALUES ($1,$2)", [
        userId,
        digest(code),
      ]);
    return codes;
  }
  function routes(app: Express) {
    app.post("/api/auth/login", async (req, res) => {
      // Burst cap protects Argon2 without locking a whole NAT for a shift.
      await limit(req, "login-burst", 120, 60);
      const input = z
        .object({ email, password: z.string().min(1).max(128) })
        .strict()
        .parse(req.body);
      // Every failure cap is checked BEFORE Argon2 (and again after it, for
      // concurrent attempts), so a correct guess past a cap is refused too.
      // The account-wide cap spans all IPs except the restaurant's configured
      // TRUSTED_LOGIN_IPS, so an outsider cannot lock staff out during service.
      const ip = req.ip ?? "unknown";
      const trusted = c.TRUSTED_LOGIN_IPS.includes(ip);
      const failureKey = "login-failure:" + digest(input.email + ":" + ip);
      const failureKeys = [
        failureKey,
        "login-failed-ip:" + digest(ip),
        "login-failed-account:" + digest(input.email),
      ];
      const checkFailures = async () => {
        const failures = await db.query<{ blocked: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM rate_limits WHERE expires_at>now() AND
          ((key=$1 AND hits>=10) OR (key=$2 AND hits>=100) OR (key=$3 AND hits>=30 AND NOT $4))) AS blocked`,
          [...failureKeys, trusted],
        );
        if (failures.rows[0]?.blocked) {
          // One audit row per account per 15 min: the log is append-only and
          // must not become a flooding target.
          if ((await bump("login-throttle-audit", input.email, 900)) === 1)
            await audit(
              db,
              req,
              "LOGIN_THROTTLED",
              "auth",
              undefined,
              "FAILURE",
              undefined,
              { accountHash: digest(input.email) },
            );
          fail(429, "RATE_LIMITED", "Demasiados intentos. Intenta más tarde");
        }
      };
      await checkFailures();
      const { rows } = await db.query<User>(
        "SELECT * FROM users WHERE email=$1",
        [input.email],
      );
      const u = rows[0];
      dummyHash ??= passwordHash(randomToken());
      const valid = await passwordVerify(
        u?.password_hash ?? (await dummyHash),
        input.password,
      );
      if (!valid || !u?.active) {
        // Record every dimension atomically: hitting one cap cannot skip the others.
        await db.query(
          `INSERT INTO rate_limits(key,hits,expires_at)
          SELECT key,1,now()+seconds*interval '1 second' FROM unnest($1::text[],$2::int[]) AS v(key,seconds)
          ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.hits+1 END,
          expires_at=CASE WHEN rate_limits.expires_at<now() THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END`,
          [failureKeys, [900, 900, 3600]],
        );
        // A pseudonymous account tag shows operators which account is targeted.
        await audit(
          db,
          req,
          "LOGIN_FAILURE",
          "auth",
          undefined,
          "FAILURE",
          undefined,
          {
            accountHash: digest(input.email),
          },
        );
        return fail(401, "INVALID_CREDENTIALS", "Credenciales inválidas");
      }
      // Another concurrent request may have exhausted a budget during Argon2.
      await checkFailures();
      await db.query("DELETE FROM rate_limits WHERE key=$1", [failureKey]);
      if (u.mfa_enabled || (await requiresMfa(db, u.role))) {
        const token = randomToken();
        await db.query(
          "INSERT INTO auth_challenges(hash,user_id,purpose,expires_at) VALUES ($1,$2,$3,now()+interval '5 minutes')",
          [digest(token), u.id, u.mfa_enabled ? "LOGIN" : "SETUP"],
        );
        res.cookie(names.challenge, token, { ...cookie, maxAge: 300000 });
        return res.json({
          mfaRequired: u.mfa_enabled,
          setupRequired: !u.mfa_enabled,
        });
      }
      const session = await transaction(db, async (tx) => {
        // Serialize session issuance with administrative revocation/password changes.
        const locked = await tx.query<User>(
          "SELECT * FROM users WHERE id=$1 FOR UPDATE",
          [u.id],
        );
        if (
          !locked.rows[0]?.active ||
          locked.rows[0].password_hash !== u.password_hash ||
          locked.rows[0].mfa_enabled ||
          (await requiresMfa(tx, locked.rows[0].role))
        )
          fail(401, "LOGIN_RETRY", "Inicia sesión nuevamente");
        await audit(tx, req, "LOGIN_SUCCESS", "auth", u.id, "SUCCESS", u.id);
        return newSession(tx, u.id);
      });
      setSession(res, session);
      res.json({ authenticated: true });
    });
    app.post("/api/auth/mfa/setup", async (req, res) => {
      await limit(req, "mfa-setup", 5, 300);
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      const result = await transaction(db, async (tx) => {
        const { rows } = await tx.query<{
          user_id: string;
          pending_secret: string | null;
        }>(
          "SELECT * FROM auth_challenges WHERE hash=$1 AND purpose='SETUP' AND used_at IS NULL AND expires_at>now() FOR UPDATE",
          [digest(readCookie(req, names.challenge))],
        );
        if (!rows[0])
          return fail(401, "CHALLENGE_EXPIRED", "Inicia sesión nuevamente");
        const u = await tx.query<User>(
          "SELECT * FROM users WHERE id=$1 FOR UPDATE",
          [rows[0].user_id],
        );
        if (!u.rows[0]?.active || u.rows[0].mfa_enabled)
          return fail(409, "MFA_ALREADY_ENABLED", "MFA ya fue configurado");
        // The setup secret is disclosed once per challenge. Start login again if lost.
        if (rows[0].pending_secret)
          return fail(
            409,
            "SETUP_ALREADY_SHOWN",
            "Inicia sesión nuevamente para configurar MFA",
          );
        await tx.query(
          "UPDATE auth_challenges SET pending_secret=$1 WHERE hash=$2",
          [
            encrypt(secret, c.MFA_KEY),
            digest(readCookie(req, names.challenge)),
          ],
        );
        return totp(secret, u.rows[0].email).toString();
      });
      res.json({ secret, qr: await QRCode.toDataURL(result) });
    });
    app.post("/api/auth/mfa/verify", async (req, res) => {
      await limit(req, "mfa-ip", 15, 300);
      const hash = digest(readCookie(req, names.challenge));
      await limit(req, "mfa-challenge", 5, 300, hash);
      const { code } = tokenInput.parse(req.body);
      const result = await transaction(db, async (tx) => {
        const { rows } = await tx.query<{
          user_id: string;
          purpose: string;
          pending_secret: string | null;
        }>(
          "SELECT * FROM auth_challenges WHERE hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
          [hash],
        );
        const challenge = rows[0];
        if (!challenge) return { failure: true as const };
        const u = (
          await tx.query<User>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
            challenge.user_id,
          ])
        ).rows[0]!;
        if (!u.active) return { failure: true as const };
        let codes: string[] | undefined;
        if (challenge.purpose === "SETUP") {
          if (u.mfa_enabled || !challenge.pending_secret)
            return { failure: true as const };
          const step = totpStep(
            decrypt(challenge.pending_secret, c.MFA_KEY),
            code,
          );
          if (step === null) {
            await audit(tx, req, "MFA_FAILURE", "auth", u.id, "FAILURE", u.id);
            return { failure: true as const };
          }
          await tx.query(
            "UPDATE users SET mfa_secret=$1,mfa_enabled=true,mfa_last_step=$2 WHERE id=$3",
            [challenge.pending_secret, step, u.id],
          );
          await tx.query(
            "UPDATE sessions SET revoked_at=now() WHERE user_id=$1",
            [u.id],
          );
          codes = await recovery(tx, u.id);
          await audit(tx, req, "MFA_ENABLED", "users", u.id, "SUCCESS", u.id);
        } else if (!u.mfa_enabled || !(await factor(tx, u, code))) {
          await audit(tx, req, "MFA_FAILURE", "auth", u.id, "FAILURE", u.id);
          return { failure: true as const };
        }
        await tx.query(
          "UPDATE auth_challenges SET used_at=now(),pending_secret=NULL WHERE hash=$1",
          [hash],
        );
        await audit(tx, req, "LOGIN_SUCCESS", "auth", u.id, "SUCCESS", u.id);
        return {
          failure: false as const,
          session: await newSession(tx, u.id),
          recoveryCodes: codes,
        };
      });
      if (result.failure)
        return fail(401, "INVALID_MFA", "Código inválido o desafío expirado");
      setSession(res, result.session);
      res.json({ authenticated: true, recoveryCodes: result.recoveryCodes });
    });
    app.post("/api/auth/refresh", async (req, res) => {
      await limit(req, "refresh", 60, 300);
      const hash = digest(readCookie(req, names.refresh));
      const retryKey = req.get("Idempotency-Key");
      const retryHash =
        retryKey && z.uuid().safeParse(retryKey).success
          ? digest(retryKey)
          : null;
      const result = await transaction(db, async (tx) => {
        const token = (
          await tx.query<{ session_id: string }>(
            "SELECT session_id FROM refresh_tokens WHERE hash=$1",
            [hash],
          )
        ).rows[0];
        if (!token) return null;
        const s = (
          await tx.query<{
            id: string;
            user_id: string;
            revoked_at: Date | null;
            valid: boolean;
          }>(
            "SELECT *,expires_at>now() AS valid FROM sessions WHERE id=$1 FOR UPDATE",
            [token.session_id],
          )
        ).rows[0]!;
        const t = (
          await tx.query<{
            used_at: Date | null;
            retry_key_hash: string | null;
            replacement_encrypted: string | null;
            retry_valid: boolean;
          }>(
            "SELECT *,used_at>now()-interval '5 minutes' AS retry_valid FROM refresh_tokens WHERE hash=$1",
            [hash],
          )
        ).rows[0]!;
        if (t.used_at) {
          if (
            !s.revoked_at &&
            s.valid &&
            retryHash &&
            retryHash === t.retry_key_hash &&
            t.retry_valid &&
            t.replacement_encrypted
          ) {
            let refresh: string | null = null;
            try {
              refresh = decrypt(t.replacement_encrypted, replacementKey);
            } catch {
              // Unreadable cache (e.g. key rotation): fall through to revocation.
            }
            const successor =
              refresh === null
                ? undefined
                : (
                    await tx.query<{ used_at: Date | null }>(
                      "SELECT used_at FROM refresh_tokens WHERE hash=$1",
                      [digest(refresh)],
                    )
                  ).rows[0];
            if (refresh !== null && successor && !successor.used_at)
              return { refresh, access: await accessToken(s.user_id, s.id) };
          }
          await tx.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
            s.id,
          ]);
          await audit(
            tx,
            req,
            "REFRESH_REUSE",
            "sessions",
            s.id,
            "FAILURE",
            s.user_id,
          );
          return null;
        }
        const user = (
          await tx.query<User>("SELECT * FROM users WHERE id=$1", [s.user_id])
        ).rows[0]!;
        if (
          s.revoked_at ||
          !s.valid ||
          !user.active ||
          ((await requiresMfa(tx, user.role)) && !user.mfa_enabled)
        )
          return null;
        const refresh = randomToken();
        await tx.query(
          "UPDATE refresh_tokens SET used_at=now(),retry_key_hash=$2,replacement_encrypted=$3 WHERE hash=$1",
          [
            hash,
            retryHash,
            retryHash ? encrypt(refresh, replacementKey) : null,
          ],
        );
        await tx.query(
          "INSERT INTO refresh_tokens(hash,session_id) VALUES ($1,$2)",
          [digest(refresh), s.id],
        );
        return { refresh, access: await accessToken(s.user_id, s.id) };
      });
      if (!result) {
        clear(res);
        return fail(401, "SESSION_EXPIRED", "Inicia sesión nuevamente");
      }
      setSession(res, result);
      res.json({ authenticated: true });
    });
    app.post("/api/auth/logout", async (req, res) => {
      await db.query(
        "UPDATE sessions SET revoked_at=now() WHERE id IN (SELECT session_id FROM refresh_tokens WHERE hash=$1)",
        [digest(readCookie(req, names.refresh))],
      );
      clear(res);
      res.json({ ok: true });
    });
    app.get("/api/auth/me", requireUser, (req, res) => res.json(identity(req)));
    app.post("/api/auth/logout-all", requireUser, async (req, res) => {
      await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
        identity(req).id,
      ]);
      clear(res);
      res.json({ ok: true });
    });
    app.post("/api/auth/forgot-password", async (req, res) => {
      await limit(req, "forgot-ip", 5, 900);
      const input = z.object({ email }).strict().parse(req.body);
      await limit(req, "forgot-account", 3, 3600, input.email);
      const u = (
        await db.query<User>("SELECT * FROM users WHERE email=$1 AND active", [
          input.email,
        ])
      ).rows[0];
      if (u) {
        const token = randomToken();
        await db.query(
          "INSERT INTO password_resets(hash,user_id,expires_at) VALUES ($1,$2,now()+interval '15 minutes')",
          [digest(token), u.id],
        );
        // Delivery starts now but is not awaited: SMTP latency must not reveal
        // whether the account exists. Failures are audited; the mailer logs them.
        void mail(u.email, token).catch(() =>
          audit(
            db,
            req,
            "RESET_DELIVERY_FAILURE",
            "auth",
            undefined,
            "FAILURE",
          ).catch(() => undefined),
        );
      }
      res.json({
        message:
          "Si la cuenta existe, recibirás instrucciones para recuperar tu contraseña",
      });
    });
    app.post("/api/auth/reset-password", async (req, res) => {
      await limit(req, "reset", 10, 900);
      const input = z
        .object({
          token: z.string().min(32).max(128),
          password: passwordSchema,
        })
        .strict()
        .parse(req.body);
      const hash = await passwordHash(input.password);
      const ok = await transaction(db, async (tx) => {
        const r = (
          await tx.query<{ user_id: string }>(
            "SELECT user_id FROM password_resets WHERE hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
            [digest(input.token)],
          )
        ).rows[0];
        if (!r) return false;
        await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
          hash,
          r.user_id,
        ]);
        await tx.query(
          "UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
          [r.user_id],
        );
        await tx.query(
          "UPDATE auth_challenges SET used_at=now(),pending_secret=NULL WHERE user_id=$1",
          [r.user_id],
        );
        await tx.query(
          "UPDATE sessions SET revoked_at=now() WHERE user_id=$1",
          [r.user_id],
        );
        await audit(
          tx,
          req,
          "PASSWORD_CHANGED",
          "users",
          r.user_id,
          "SUCCESS",
          r.user_id,
        );
        return true;
      });
      if (!ok) return fail(400, "INVALID_RESET", "Enlace inválido o expirado");
      clear(res);
      res.json({ ok: true });
    });
    app.post("/api/auth/mfa/enroll", requireUser, async (req, res) => {
      const me = identity(req);
      await limit(req, "mfa-enroll", 5, 300, me.id);
      const { password } = z
        .object({ password: z.string().max(128) })
        .strict()
        .parse(req.body);
      const u = (
        await db.query<User>("SELECT * FROM users WHERE id=$1", [me.id])
      ).rows[0]!;
      if (!(await passwordVerify(u.password_hash, password)))
        fail(401, "INVALID_CREDENTIALS", "Credenciales inválidas");
      if (u.mfa_enabled)
        fail(409, "MFA_ALREADY_ENABLED", "MFA ya está habilitado");
      const token = randomToken();
      await db.query(
        "INSERT INTO auth_challenges(hash,user_id,purpose,expires_at) VALUES ($1,$2,'SETUP',now()+interval '5 minutes')",
        [digest(token), me.id],
      );
      res.cookie(names.challenge, token, { ...cookie, maxAge: 300000 });
      res.json({ setupRequired: true });
    });
    for (const action of ["disable", "recovery"] as const) {
      app.post(`/api/auth/mfa/${action}`, requireUser, async (req, res) => {
        const me = identity(req);
        await limit(req, "mfa-manage", 5, 300, me.id);
        const input = z
          .object({
            password: z.string().max(128),
            code: z.string().min(6).max(64),
          })
          .strict()
          .parse(req.body);
        const result = await transaction(db, async (tx) => {
          const u = (
            await tx.query<User>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
              me.id,
            ])
          ).rows[0]!;
          if (
            !u.mfa_enabled ||
            !(await passwordVerify(u.password_hash, input.password)) ||
            !(await factor(tx, u, input.code))
          )
            return null;
          if (action === "disable" && (await requiresMfa(tx, u.role)))
            throw new AppError(
              403,
              "MFA_REQUIRED",
              "El administrador debe conservar MFA",
            );
          const codes = action === "recovery" ? await recovery(tx, me.id) : [];
          if (action === "disable") {
            await tx.query(
              "UPDATE users SET mfa_enabled=false,mfa_secret=NULL,mfa_last_step=-1 WHERE id=$1",
              [me.id],
            );
            await tx.query("DELETE FROM recovery_codes WHERE user_id=$1", [
              me.id,
            ]);
          }
          await tx.query(
            "UPDATE sessions SET revoked_at=now() WHERE user_id=$1",
            [me.id],
          );
          await audit(
            tx,
            req,
            action === "disable" ? "MFA_DISABLED" : "RECOVERY_REGENERATED",
            "users",
            me.id,
          );
          return codes;
        });
        if (!result)
          fail(401, "INVALID_MFA", "Credenciales o código inválidos");
        clear(res);
        res.json({ recoveryCodes: result });
      });
    }
  }
  return { routes, requireUser, permit, authenticate, limit };
}
