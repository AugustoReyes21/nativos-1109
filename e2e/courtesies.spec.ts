import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { passwordHash, totp } from "../server/security.js";
import { testPassword } from "../tests/helpers.js";

test("superadmin configures PDF stock and records partial and full courtesies", async ({
  page,
}, info) => {
  const connectionString =
    process.env.E2E_DATABASE_URL ??
    "postgresql://nativos:local_only@127.0.0.1:55432/nativos_e2e_test";
  const target = new URL(connectionString);
  if (
    !/^\/nativos_[a-z0-9_]*test$/.test(target.pathname) ||
    !["localhost", "127.0.0.1"].includes(target.hostname)
  )
    throw new Error("Dedicated local test DB required");
  const db = new pg.Pool({ connectionString });
  const tag = `${info.project.name}-${randomUUID().slice(0, 6)}`;
  const email = `owner-${tag}@example.test`;
  const code = {
    desktop: "NAT-ES-HAMB",
    tablet: "NAT-CR-MIXTA",
    mobile: "NAT-ES-PAN",
  }[info.project.name];
  try {
    await db.query(
      "INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'SUPERADMIN')",
      [tag, email, await passwordHash(testPassword)],
    );
    await db.query("DELETE FROM rate_limits");
    const product = (
      await db.query<{
        id: string;
        name: string;
        price_cents: number;
        stock: number;
      }>(
        "SELECT id,name,price_cents,stock FROM products WHERE catalog_code=$1",
        [code],
      )
    ).rows[0]!;
    expect(product.stock).toBe(0);
    await page.goto("/");
    await page.getByLabel("Correo", { exact: true }).fill(email);
    await page.getByLabel("Contraseña", { exact: true }).fill(testPassword);
    await page
      .getByRole("button", { name: "Iniciar sesión", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Protege tu cuenta" }),
    ).toBeVisible();
    await page.getByText("Configurar manualmente", { exact: true }).click();
    await page
      .getByLabel("Código de autenticación o recuperación")
      .fill(totp(await page.getByTestId("mfa-secret").innerText()).generate());
    await page.getByRole("button", { name: "Verificar código" }).click();
    await page.getByRole("button", { name: "Ya guardé mis códigos" }).click();
    for (const name of [
      "Salón y mesas",
      "Nueva orden",
      "Órdenes",
      "Caja",
      "Productos y mesas",
      "Administración",
    ])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await page
      .getByRole("button", { name: "Productos y mesas", exact: true })
      .click();
    await page.getByLabel("Nueva mesa").fill(`Cortesía-${tag}`);
    await page.getByRole("button", { name: "Crear mesa", exact: true }).click();
    await expect(page.getByLabel("Nueva mesa")).toHaveValue("");
    await page
      .getByLabel(`Stock de ${product.name}`, { exact: true })
      .fill("3");
    await page
      .getByRole("button", { name: `Guardar ${product.name}`, exact: true })
      .click();
    await page.getByRole("button", { name: "Caja", exact: true }).click();
    await page.getByLabel("Fondo inicial (Q)").fill("0");
    await page.getByRole("button", { name: "Abrir caja", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Caja abierta", exact: true }),
    ).toBeVisible();
    page.on("dialog", (dialog) => dialog.accept());

    for (const quantity of [2, 1]) {
      await page
        .getByRole("button", { name: "Nueva orden", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "Mesa", exact: true })
        .selectOption({ label: `Cortesía-${tag} · Nivel 1` });
      await expect(
        page.getByText("Mesa reservada para ti mientras preparas el pedido.", {
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByLabel("Buscar producto", { exact: true })
        .fill(product.name);
      await page
        .getByRole("button", { name: new RegExp(`^${product.name}`) })
        .click();
      await page.getByLabel("Cantidad", { exact: true }).fill(String(quantity));
      await page
        .getByRole("button", {
          name: "Confirmar y enviar a cocina",
          exact: true,
        })
        .click();
      const ticket = page
        .locator("article.order")
        .filter({ hasText: `Cortesía-${tag}` })
        .filter({ has: page.getByText("Por cobrar", { exact: true }) });
      await ticket.getByText("Autorizar cortesía", { exact: true }).click();
      await ticket
        .getByLabel(new RegExp(`Cortesía de ${product.name}`))
        .fill("1");
      await ticket
        .getByLabel("Motivo de cortesía", { exact: true })
        .fill(`Atención de la casa ${quantity}`);
      await ticket
        .getByRole("button", { name: "Registrar cortesía", exact: true })
        .click();
      if (quantity === 2) {
        await expect(ticket).toContainText("1 de cortesía");
        await ticket.locator("summary").filter({ hasText: "Cobrar" }).click();
        await expect(ticket.getByLabel("Importe recibido (Q)")).toHaveValue(
          (product.price_cents / 100).toFixed(2),
        );
        await ticket
          .getByRole("button", { name: "Confirmar cobro", exact: true })
          .click();
        await expect(page.getByRole("dialog")).toContainText("Cortesías");
        await expect(page.getByRole("dialog")).toContainText("1 de cortesía");
        await page.emulateMedia({ media: "print" });
        await expect(page.locator(".receipt")).toBeVisible();
        await expect(page.locator(".order-grid")).not.toBeVisible();
        await expect(page.locator(".section-heading")).not.toBeVisible();
        await page.emulateMedia({ media: "screen" });
        await page.getByRole("button", { name: "Cerrar", exact: true }).click();
      } else {
        await expect(
          page
            .locator("article.order")
            .filter({ hasText: `Cortesía-${tag}` })
            .filter({ hasText: "Liquidada por cortesía" }),
        ).toBeVisible();
      }
    }
    expect(
      (await db.query("SELECT stock FROM products WHERE id=$1", [product.id]))
        .rows[0].stock,
    ).toBe(0);
    const payments = await db.query(
      "SELECT p.method,p.amount_cents FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.table_name=$1 ORDER BY p.amount_cents",
      [`Cortesía-${tag}`],
    );
    expect(payments.rows).toEqual([
      { method: "CORTESIA", amount_cents: 0 },
      { method: "EFECTIVO", amount_cents: product.price_cents },
    ]);
    await page
      .getByRole("button", { name: "Administración", exact: true })
      .click();
    await expect(
      page
        .getByRole("combobox", { name: "Rol", exact: true })
        .locator("option")
        .filter({ hasText: "SUPERADMIN" }),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "Consultar usuarios, ventas y bitácora" })
      .click();
    await expect(
      page.locator("article").filter({ hasText: `Cortesía-${tag}` }),
    ).toHaveCount(2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/courtesies-${info.project.name}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Caja", exact: true }).click();
    await page
      .getByLabel("Efectivo contado (Q)")
      .fill((product.price_cents / 100).toFixed(2));
    await page
      .getByRole("button", { name: "Cerrar caja", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Abrir caja", exact: true }),
    ).toBeVisible();
  } finally {
    await db.end();
  }
});
