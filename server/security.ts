import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import argon2 from "argon2";
import * as OTPAuth from "otpauth";
import { z } from "zod";
export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((v) => !/^\s|\s$/.test(v), "Sin espacios al inicio o al final");
export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export const passwordHash = (v: string) =>
  argon2.hash(v, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
export const passwordVerify = (hash: string, v: string) =>
  argon2.verify(hash, v);
export function encrypt(secret: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
export function decrypt(value: string, key: string) {
  const b = Buffer.from(value, "base64url");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    b.subarray(0, 12),
  );
  cipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([
    cipher.update(b.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
export function totp(secret: string, label = "Nativos1109") {
  return new OTPAuth.TOTP({
    issuer: "Nativos1109",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
}
export function totpStep(
  secret: string,
  token: string,
  timestamp = Date.now(),
): number | null {
  const delta = totp(secret).validate({ token, window: 1, timestamp });
  return delta === null ? null : Math.floor(timestamp / 30000) + delta;
}
export function total(items: { quantity: number; price_cents: number }[]) {
  const amount = items.reduce((s, i) => s + i.quantity * i.price_cents, 0);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000)
    throw new Error("Invalid amount");
  return amount;
}
