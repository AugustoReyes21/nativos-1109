import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

function gate(run: object) {
  const directory = mkdtempSync(join(tmpdir(), "nativos-sarif-test-"));
  try {
    writeFileSync(
      join(directory, "scan.sarif"),
      JSON.stringify({ runs: [run] }),
    );
    return spawnSync(process.execPath, [
      "scripts/check-security-reports.mjs",
      "sarif",
      directory,
    ]).status;
  } finally {
    rmSync(directory, { recursive: true });
  }
}
it("rejects security rules in SARIF extension components, even with note severity", () => {
  expect(
    gate({
      tool: {
        driver: { rules: [] },
        extensions: [
          {
            rules: [
              {
                id: "extension/security",
                properties: { "security-severity": "8.8" },
              },
            ],
          },
        ],
      },
      results: [
        {
          ruleId: "extension/security",
          rule: { index: 0, toolComponent: { index: 0 } },
          level: "note",
        },
      ],
    }),
  ).toBe(1);
});
it("fails closed for findings without metadata or an explicit result level", () => {
  expect(gate({ tool: { driver: {} }, results: [{ ruleId: "unknown" }] })).toBe(
    1,
  );
});
it("uses default rule levels and accepts an empty scan", () => {
  expect(
    gate({
      tool: {
        driver: {
          rules: [{ id: "error", defaultConfiguration: { level: "error" } }],
        },
      },
      results: [{ ruleId: "error" }],
    }),
  ).toBe(1);
  expect(gate({ tool: { driver: {} }, results: [] })).toBe(0);
});
