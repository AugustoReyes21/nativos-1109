import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { passwordHash } from "../server/security.js";
import { testPassword } from "../tests/helpers.js";
const connectionString =
  process.env.E2E_DATABASE_URL ??
  "postgresql://nativos:local_only@127.0.0.1:55432/nativos_e2e_test";
async function login(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(testPassword);
  await page
    .getByRole("button", { name: "Iniciar sesión", exact: true })
    .click();
  await expect(page.getByText("● En línea", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: /Nivel 2 Segundo nivel$/ })
    .click();
}
test("a selected table is unavailable to another waiter before an order exists", async ({
  page,
  browser,
}, info) => {
  const target = new URL(connectionString);
  if (
    !target.pathname.endsWith("_test") ||
    !["127.0.0.1", "localhost"].includes(target.hostname)
  )
    throw new Error("Dedicated local test DB required");
  const db = new pg.Pool({ connectionString });
  const otherContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3000",
    viewport: info.project.use.viewport,
  });
  const other = await otherContext.newPage();
  const tag = randomUUID().slice(0, 8);
  const name = `Exclusiva ${tag}`;
  try {
    const hash = await passwordHash(testPassword);
    for (const who of ["a", "b"])
      await db.query(
        "INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'MESERO')",
        [who, `${who}-${tag}@example.test`, hash],
      );
    const id = (
      await db.query(
        "INSERT INTO restaurant_tables(name,floor) VALUES($1,2) RETURNING id",
        [name],
      )
    ).rows[0].id as string;
    await login(page, `a-${tag}@example.test`);
    await login(other, `b-${tag}@example.test`);
    const tableA = page.getByRole("button", {
      name: new RegExp(name),
    });
    const tableB = other.getByRole("button", {
      name: new RegExp(name),
    });
    await tableA.click();
    await expect(
      page.getByText("Mesa reservada para ti mientras preparas el pedido."),
    ).toBeVisible();
    await expect(tableB).toBeDisabled();
    await expect(tableB).toContainText("Reservada");
    expect(
      (await db.query("SELECT count(*) FROM orders WHERE table_id=$1", [id]))
        .rows[0].count,
    ).toBe("0");
    const denied = await other.evaluate(async (tableId) => {
      const csrf = (await (await fetch("/api/auth/csrf")).json()) as {
        token: string;
      };
      const response = await fetch(`/api/tables/${tableId}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Protection": "1",
          "X-CSRF-Token": csrf.token,
        },
        body: JSON.stringify({ claimId: crypto.randomUUID() }),
      });
      return {
        status: response.status,
        body: (await response.json()) as { error: { code: string } },
      };
    }, id);
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe("TABLE_IN_USE");
    await page
      .getByRole("button", {
        name: "Descartar borrador y liberar mesa",
        exact: true,
      })
      .click();
    await expect(tableB).toBeEnabled();
    await tableB.click();
    await expect(
      other.getByText("Mesa reservada para ti mientras preparas el pedido."),
    ).toBeVisible();
    await expect(tableA).toBeDisabled();
    await other
      .getByRole("button", {
        name: "Descartar borrador y liberar mesa",
        exact: true,
      })
      .click();
    await expect(tableA).toBeEnabled();
    await expect(tableB).toBeEnabled();
  } finally {
    await otherContext.close();
    await db.end();
  }
});
