import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { passwordHash, totp } from "../server/security.js";
import { testPassword } from "../tests/helpers.js";

async function login(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(testPassword);
  await page
    .getByRole("button", { name: "Iniciar sesión", exact: true })
    .click();
}
test("mixed/CUI checkout, audited reprint, separate modules and admin closure approval", async ({
  page,
  browser,
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
  const staffContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3000",
    viewport: info.project.use.viewport,
  });
  const staff = await staffContext.newPage();
  const tag = randomUUID().slice(0, 6);
  try {
    const hash = await passwordHash(testPassword);
    const adminId = (
      await db.query(
        "INSERT INTO users(name,email,password_hash,role) VALUES('Aprobador',$1,$2,'ADMINISTRADOR') RETURNING id",
        [`admin-${tag}@example.test`, hash],
      )
    ).rows[0].id as string;
    await db.query(
      "INSERT INTO users(name,email,password_hash,role) VALUES('Cajero',$1,$2,'CAJERO')",
      [`cash-${tag}@example.test`, hash],
    );
    await db.query("DELETE FROM rate_limits");
    const product = (
      await db.query("SELECT id FROM products WHERE catalog_code='NAT-ES-HAMB'")
    ).rows[0].id as string;
    const ids: string[] = [];
    for (const name of ["Mixto", "Transferencia"]) {
      const table = (
        await db.query(
          "INSERT INTO restaurant_tables(name) VALUES($1) RETURNING id",
          [`${name}-${tag}`],
        )
      ).rows[0].id as string;
      const tx = await db.connect();
      try {
        await tx.query("BEGIN");
        const order = (
          await tx.query(
            "INSERT INTO orders(table_id,user_id,total_cents) VALUES($1,$2,4000) RETURNING id",
            [table, adminId],
          )
        ).rows[0].id as string;
        await tx.query(
          "INSERT INTO order_items(order_id,product_id,name,quantity,price_cents) VALUES($1,$2,'Hamburguesa de prueba',1,4000)",
          [order, product],
        );
        await tx.query("COMMIT");
        ids.push(order);
      } catch (e) {
        await tx.query("ROLLBACK");
        throw e;
      } finally {
        tx.release();
      }
    }
    await login(page, `admin-${tag}@example.test`);
    await page.getByText("Configurar manualmente", { exact: true }).click();
    await page
      .getByLabel("Código de autenticación o recuperación")
      .fill(totp(await page.getByTestId("mfa-secret").innerText()).generate());
    await page.getByRole("button", { name: "Verificar código" }).click();
    await page.getByRole("button", { name: "Ya guardé mis códigos" }).click();
    await page.getByRole("button", { name: "Órdenes", exact: true }).click();
    for (const name of ["Mixto", "Transferencia"]) {
      const ticket = page
        .locator("article.order")
        .filter({ hasText: `${name}-${tag}` });
      await ticket
        .getByRole("button", { name: "Enviar a caja", exact: true })
        .click();
      await expect(ticket).toContainText("Enviada a caja");
    }
    await login(staff, `cash-${tag}@example.test`);
    await staff.getByRole("button", { name: "Caja", exact: true }).click();
    await staff
      .getByRole("button", { name: "Apertura y cierre", exact: true })
      .click();
    await staff.getByLabel("Fondo inicial (Q)").fill("10");
    await staff
      .getByRole("button", { name: "Abrir caja", exact: true })
      .click();
    await expect(
      staff.getByRole("heading", { name: "Caja abierta", exact: true }),
    ).toBeVisible();
    await staff.getByRole("button", { name: /^Cobrar cuentas/ }).click();
    const mixed = staff
      .locator("article.order")
      .filter({ hasText: `Mixto-${tag}` });
    await mixed.locator("summary").filter({ hasText: "Cobrar" }).click();
    await mixed
      .getByRole("combobox", { name: "Método", exact: true })
      .selectOption("MIXTO");
    await mixed.getByLabel("Parte con tarjeta (Q)").fill("");
    await mixed.getByLabel("Parte con tarjeta (Q)").fill("15");
    await mixed.getByLabel("Efectivo recibido (Q)").fill("30");
    await mixed.getByLabel("Identificación del receptor").selectOption("NIT");
    await mixed.getByLabel("NIT", { exact: true }).fill("1234567K");
    await mixed.getByLabel("Nombre o razón social").fill(`Cliente ${tag}`);
    await expect(
      mixed
        .getByRole("combobox", { name: "Documento", exact: true })
        .locator('option[value="FACTURA"]'),
    ).toHaveJSProperty("disabled", true);
    await mixed
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(staff.getByRole("dialog")).toContainText("Cambio Q");
    await expect(staff.getByRole("dialog")).toContainText("1234567K");
    await staff.evaluate(() => {
      window.print = () => undefined;
    });
    await staff.getByRole("button", { name: "Imprimir", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT count(*) FROM receipt_prints rp JOIN payments p ON p.id=rp.payment_id WHERE p.order_id=$1",
              [ids[0]],
            )
          ).rows[0].count,
      )
      .toBe("1");
    await staff.getByRole("button", { name: "Cerrar", exact: true }).click();
    const transfer = staff
      .locator("article.order")
      .filter({ hasText: `Transferencia-${tag}` });
    await transfer.locator("summary").filter({ hasText: "Cobrar" }).click();
    await transfer
      .getByRole("combobox", { name: "Método", exact: true })
      .selectOption("TRANSFERENCIA");
    await transfer
      .getByLabel("Identificación del receptor")
      .selectOption("CUI");
    await transfer.getByLabel("CUI", { exact: true }).fill("1234567890101");
    await transfer
      .getByLabel("Nombre o razón social")
      .fill("Receptor CUI prueba");
    await transfer
      .getByRole("button", { name: "Confirmar cobro", exact: true })
      .click();
    await expect(staff.getByRole("dialog")).toContainText("1234567890101");
    await staff.getByRole("button", { name: "Cerrar", exact: true }).click();
    await staff
      .getByRole("button", { name: "Historial de ventas", exact: true })
      .click();
    await staff
      .locator("article")
      .filter({ hasText: `Mixto-${tag}` })
      .getByRole("button", { name: "Ver venta y comprobante" })
      .click();
    await expect(staff.getByRole("dialog")).toContainText(
      "COMPROBANTE REIMPRESO",
    );
    await staff
      .getByRole("button", { name: "Reimprimir comprobante", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT count(*) FROM receipt_prints rp JOIN payments p ON p.id=rp.payment_id WHERE p.order_id=$1 AND rp.reprint",
              [ids[0]],
            )
          ).rows[0].count,
      )
      .toBe("1");
    await staff.emulateMedia({ media: "print" });
    await expect(staff.locator(".receipt")).toBeVisible();
    await expect(
      staff.getByRole("heading", { name: "Historial de ventas", exact: true }),
    ).not.toBeVisible();
    await staff.emulateMedia({ media: "screen" });
    await staff.screenshot({
      path: `test-results/reprint-${info.project.name}.png`,
    });
    await staff.getByRole("button", { name: "Cerrar", exact: true }).click();
    await staff.getByRole("button", { name: "Caja", exact: true }).click();
    await staff
      .getByRole("button", { name: "Apertura y cierre", exact: true })
      .click();
    await staff.getByLabel("Efectivo contado (Q)").fill("35");
    await staff
      .getByRole("button", {
        name: "Solicitar autorización de cierre",
        exact: true,
      })
      .click();
    await expect(
      staff.getByText(/Cierre pendiente de autorización administrativa/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Caja", exact: true }).click();
    await page
      .getByRole("button", { name: "Apertura y cierre", exact: true })
      .click();
    await expect(page.getByLabel("Efectivo contado (Q)")).toHaveValue("35.00");
    await page
      .getByRole("button", { name: "Autorizar y cerrar caja", exact: true })
      .click();
    await expect(
      staff.getByRole("heading", { name: "Abrir caja", exact: true }),
    ).toBeVisible();
    for (const module of [
      "Usuarios",
      "Bitácora",
      "Reportes financieros",
      "Cortesías",
    ])
      await expect(
        page
          .getByRole("navigation")
          .getByRole("button", { name: module, exact: true }),
      ).toBeVisible();
    await page.getByRole("button", { name: "Usuarios", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Crear usuario", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Bitácora", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Reportes financieros", exact: true })
      .click();
    await page.getByLabel("Tipo de registro").selectOption("MERMA");
    await page.getByLabel("Importe (Q)", { exact: true }).fill("5");
    await page
      .getByLabel("Descripción", { exact: true })
      .fill(`Merma de prueba ${tag}`);
    await page
      .getByRole("button", { name: "Guardar registro financiero", exact: true })
      .click();
    await expect(
      page.getByText(`Merma de prueba ${tag}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Saldo parcial", { exact: true }),
    ).toBeVisible();
    const expectedIncome = (
      await db.query(
        "SELECT coalesce(sum(amount_cents),0) AS amount FROM payments WHERE created_at >= date_trunc('month',now() AT TIME ZONE 'America/Guatemala') AT TIME ZONE 'America/Guatemala' AND created_at < ((now() AT TIME ZONE 'America/Guatemala')::date+1)::timestamp AT TIME ZONE 'America/Guatemala'",
      )
    ).rows[0].amount as string;
    const incomeCard = page
      .locator(".finance-metrics .panel")
      .filter({ hasText: "Ingresos cobrados" });
    const actualIncome = await incomeCard.locator("strong").innerText();
    expect(Number(actualIncome.replace(/[^\d.-]/g, ""))).toBe(
      Number(expectedIncome) / 100,
    );
    expect(
      await page
        .locator(".finance-metrics .metric")
        .evaluateAll((nodes) =>
          nodes.every(
            (node) =>
              getComputedStyle(node).whiteSpace === "nowrap" &&
              node.scrollWidth <= node.clientWidth,
          ),
        ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/finance-${info.project.name}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Bitácora", exact: true }).click();
    await expect(
      page
        .getByText("RECEIPT_REPRINT_REQUESTED · SUCCESS", { exact: true })
        .first(),
    ).toBeVisible();
    const payment = (
      await db.query(
        "SELECT cash_cents,card_cents,change_cents FROM payments WHERE order_id=$1",
        [ids[0]],
      )
    ).rows[0];
    expect(payment).toEqual({
      cash_cents: 2500,
      card_cents: 1500,
      change_cents: 500,
    });
  } finally {
    await staffContext.close();
    await db.end();
  }
});
