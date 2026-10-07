import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decrypt,
  digest,
  encrypt,
  passwordHash,
  passwordSchema,
  passwordVerify,
  total,
  totp,
  totpStep,
} from "../server/security.js";
import { config } from "../server/config.js";

describe("security and money", () => {
  it("uses authenticated encryption; rejects wrong keys and tampering", () => {
    const key = randomBytes(32).toString("hex");
    const encrypted = encrypt("mfa-secret", key);
    expect(decrypt(encrypted, key)).toBe("mfa-secret");
    expect(encrypted).not.toContain("mfa-secret");
    expect(() => decrypt(encrypted, randomBytes(32).toString("hex"))).toThrow();
    const bytes = Buffer.from(encrypted, "base64url");
    bytes[30] = bytes[30]! ^ 1;
    expect(() => decrypt(bytes.toString("base64url"), key)).toThrow();
  });
  it("hashes with Argon2id and rejects wrong passwords", async () => {
    const hash = await passwordHash("long-enough-password");
    expect(hash).toContain("$argon2id$");
    expect(await passwordVerify(hash, "long-enough-password")).toBe(true);
    expect(await passwordVerify(hash, "wrong")).toBe(false);
    expect(passwordSchema.safeParse("short").success).toBe(false);
  });
  it("keeps financial arithmetic in integers and rejects overflow", () => {
    expect(
      total([
        { quantity: 3, price_cents: 1050 },
        { quantity: 2, price_cents: 25 },
      ]),
    ).toBe(3200);
    expect(() => total([{ quantity: 100, price_cents: 1000000000 }])).toThrow();
  });
  it("validates TOTP windows without accepting arbitrary codes", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const timestamp = 1800000000000;
    const code = totp(secret).generate({ timestamp });
    expect(totpStep(secret, code, timestamp)).toBe(timestamp / 30000);
    expect(totpStep(secret, code, timestamp + 120000)).toBeNull();
  });
  it("fails closed on invalid production config without printing secret values", () => {
    expect(() => config({ JWT_SECRET: "do-not-print-me" })).toThrow(
      "Invalid configuration",
    );
    try {
      config({ JWT_SECRET: "do-not-print-me" });
    } catch (e) {
      expect(String(e)).not.toContain("do-not-print-me");
    }
    expect(digest("token")).toHaveLength(64);
  });
});
