import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const issues = [];
for (const file of files) {
  if (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith(".env.example"))
    issues.push(file + ": environment file tracked");
  if (/(^|\/)(id_rsa|id_ed25519)$|\.(p12|pfx)$/.test(file))
    issues.push(file + ": private key file");
  if (file === "package-lock.json") continue;
  const value = readFileSync(file, "utf8");
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:ghp|github_pat|sk_live)_[A-Za-z0-9_]{20,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(value)))
    issues.push(file + ": potential secret (value redacted)");
}
if (issues.length) {
  console.error(issues.join("\n"));
  process.exit(1);
}
console.log(
  "Tracked-file secret checks passed. CI also scans Git history with Gitleaks.",
);
