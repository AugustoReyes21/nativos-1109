import { isIP } from "node:net";
import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_ORIGIN: z
      .url()
      .refine(
        (v) => new URL(v).origin === v,
        "Use an origin without a trailing slash",
      ),
    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: z.enum(["true", "false"]).default("false"),
    JWT_SECRET: z.string().min(43),
    MFA_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    // Public IPs of the restaurant (comma-separated). Logins from them are exempt
    // from the per-account cap, so an external attacker cannot lock staff out.
    TRUSTED_LOGIN_IPS: z
      .string()
      .default("")
      .transform((v) => v.split(",").map((ip) => ip.trim()).filter(Boolean))
      .refine((ips) => ips.every((ip) => isIP(ip) !== 0), "Invalid IP address"),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === "production" && !v.APP_ORIGIN.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        message: "Production requires HTTPS",
        path: ["APP_ORIGIN"],
      });
    }
  });
export type Config = z.infer<typeof schema>;
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  return result.data;
}
