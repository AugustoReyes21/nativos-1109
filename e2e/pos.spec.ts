import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { passwordHash, totp } from "../server/security.js";
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
}
test("administrator → waiter → live kitchen → cashier with reconnect and responsive layout", async ({
  browser,
  page,
}, info) => {
  const tag = info.project.name + "-" + randomUUID().slice(0, 6);
  if (!new URL(connectionString).pathname.endsWith("_test"))
    throw new Error("Dedicated test DB required");
  const db = new pg.Pool({ connectionString });
  const emails = Object.fromEntries(
    ["ADMINISTRADOR", "MESERO", "CAJERO", "COCINA"].map((role) => [
      role,
      role.toLowerCase() + "-" + tag + "@example.test",
    ]),
  );
  try {
    const hash = await passwordHash(testPassword);
    for (const role of ["ADMINISTRADOR", "MESERO", "CAJERO", "COCINA"])
      await db.query(
        "INSERT INTO users(name,email,password_hash,role) VALUES ($1,$2,$3,$4)",
        [role + "-" + tag, emails[role], hash, role],
      );
    await db.query("DELETE FROM rate_limits");
    await login(page, emails.ADMINISTRADOR!);
    await expect(
      page.getByRole("heading", { name: "Protege tu cuenta" }),
    ).toBeVisible();
    await page.getByText("Configurar manualmente", { exact: true }).click();
    const secret = await page.getByTestId("mfa-secret").innerText();
    await page
      .getByLabel("Código de autenticación o recuperación")
      .fill(totp(secret).generate());
    await page.getByRole("button", { name: "Verificar código" }).click();
    await page.getByRole("button", { name: "Ya guardé mis códigos" }).click();
    await expect(page.getByText("● En línea", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Productos y mesas", exact: true })
      .click();
    await page.getByLabel("Nueva categoría").fill("Platos-" + tag);
    await page.getByRole("button", { name: "Crear categoría" }).click();
    await expect(page.getByLabel("Nueva categoría")).toHaveValue("");
    await page.getByLabel("Nueva mesa").fill("Mesa-" + tag);
    const tableForm = page
      .locator("form")
      .filter({ has: page.getByLabel("Nueva mesa") });
    await tableForm
      .getByRole("combobox", { name: "Nivel de mesa", exact: true })
      .selectOption("2");
    await tableForm.getByLabel("Capacidad", { exact: true }).fill("6");
    await tableForm
      .getByRole("combobox", { name: "Forma", exact: true })
      .selectOption("round");
    await page.getByRole("button", { name: "Crear mesa" }).click();
    await expect(page.getByLabel("Nueva mesa")).toHaveValue("");
    await page.getByLabel("Nombre del producto").fill("Almuerzo-" + tag);
    await page
      .getByRole("combobox", { name: "Categoría", exact: true })
      .selectOption({ label: "Platos-" + tag });
    await page.getByLabel("Precio (Q)", { exact: true }).fill("45");
    await page.getByLabel("Disponibilidad", { exact: true }).fill("2");
    await page
      .getByRole("button", { name: "Crear producto", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Almuerzo-" + tag, exact: true }),
    ).toBeVisible();
    const cookContext = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      baseURL: "http://127.0.0.1:3000",
    });
    const cook = await cookContext.newPage();
    await login(cook, emails.COCINA!);
    await expect(
      cook.getByRole("heading", { name: "Cocina", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Salir", exact: true }).click();
    await expect(page.getByLabel("Correo", { exact: true })).toBeVisible();
    await login(page, emails.MESERO!);
    await expect(
      page.getByRole("heading", { name: "El salón, a tu ritmo." }),
    ).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page
      .getByRole("button", { name: "Nivel 2 Segundo nivel", exact: true })
      .click();
    const visualTable = page.getByRole("button", {
      name: new RegExp(`Mesa-${tag}, nivel 2, Disponible`),
    });
    await expect(visualTable).toContainText("6 personas");
    await expect(visualTable).toBeEnabled();
    await expect(page.locator(".table-plan")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: "test-results/floor-" + info.project.name + ".png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await visualTable.focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("button", { name: new RegExp("Almuerzo-" + tag) })
      .click();
    await expect(
      page
        .getByRole("combobox", { name: "Mesa", exact: true })
        .locator("option:checked"),
    ).toHaveText(`Mesa-${tag} · Nivel 2`);
    await page
      .getByRole("button", { name: "Salón y mesas", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Nueva orden", exact: true })
      .click();
    await expect(page.getByLabel("Cantidad", { exact: true })).toHaveValue("1");
    await page.getByLabel("Observaciones", { exact: true }).fill("Sin cebolla");
    let responseLost = false;
    await page.route("**/api/orders", async (route) => {
      if (route.request().method() === "POST" && !responseLost) {
        responseLost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page
      .getByRole("button", { name: "Confirmar y enviar a cocina" })
      .click();
    await expect(page.getByRole("alert")).toContainText("No se pudo confirmar");
    await page
      .getByRole("button", { name: "Confirmar y enviar a cocina" })
      .click();
    await page.unroute("**/api/orders");
    const ticket = cook
      .locator("article")
      .filter({ hasText: "Almuerzo-" + tag });
    await expect(ticket).toContainText("Sin cebolla");
    await expect(ticket).toContainText("Nivel 2");
    await ticket.getByRole("button", { name: "Preparar", exact: true }).click();
    await expect(ticket).toContainText("EN PREPARACION");
    await ticket.getByRole("button", { name: "Marcar listo" }).click();
    const waiterTicket = page
      .locator("article")
      .filter({ hasText: "Almuerzo-" + tag });
    await expect(waiterTicket).toContainText("LISTO");
    await page
      .getByRole("button", { name: "Salón y mesas", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`Mesa-${tag}, nivel 2, Para servir`),
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Lista", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    await page.context().setOffline(true);
    await expect(
      page.getByText("● Reconectando · espera para operar"),
    ).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.getByText("● En línea", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await waiterTicket.getByRole("button", { name: "Entregar" }).click();
    await expect(waiterTicket).toContainText("ENTREGADO");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/" + tag + ".png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Salir", exact: true }).click();
    await expect(page.getByLabel("Correo", { exact: true })).toBeVisible();
    await login(page, emails.CAJERO!);
    await page.getByRole("button", { name: "Caja", exact: true }).click();
    await page.getByLabel("Fondo inicial (Q)").fill("100");
    await page.getByRole("button", { name: "Abrir caja", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Caja abierta" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    const cashierTicket = page
      .locator("article")
      .filter({ hasText: "Almuerzo-" + tag });
    await cashierTicket.locator("summary").click();
    await cashierTicket.getByLabel("Importe recibido (Q)").fill("50");
    await cashierTicket
      .getByRole("button", { name: "Confirmar cobro" })
      .click();
    await expect(page.getByRole("dialog")).toContainText("Cambio Q");
    await expect(page.getByRole("dialog")).toContainText(
      `Mesa-${tag} · Nivel 2`,
    );
    await page.getByRole("button", { name: "Cerrar", exact: true }).click();
    await expect(cashierTicket).toContainText("Pagada");
    await page.getByRole("button", { name: "Caja", exact: true }).click();
    await page.getByLabel("Efectivo contado (Q)").fill("145");
    await page
      .getByRole("button", { name: "Cerrar caja", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Abrir caja" }),
    ).toBeVisible();
    const sales = await db.query(
      "SELECT p.amount_cents FROM payments p JOIN orders o ON o.id=p.order_id JOIN restaurant_tables t ON t.id=o.table_id WHERE t.name=$1",
      ["Mesa-" + tag],
    );
    expect(sales.rows).toHaveLength(1);
    expect(sales.rows[0].amount_cents).toBe(4500);
    const created = await db.query(
      "SELECT count(*) FROM orders o JOIN restaurant_tables t ON t.id=o.table_id WHERE t.name=$1",
      ["Mesa-" + tag],
    );
    expect(created.rows[0].count).toBe("1");
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    await cookContext.close();
  } finally {
    await db.end();
  }
});
