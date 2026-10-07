import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { passwordHash } from "../server/security.js";
import { testPassword } from "../tests/helpers.js";

test("isometric tables and N transitions preserve navigation, claims and reduced motion", async ({
  page,
}, info) => {
  const connectionString =
    process.env.E2E_DATABASE_URL ??
    "postgresql://nativos:local_only@127.0.0.1:55432/nativos_e2e_test";
  const target = new URL(connectionString);
  if (
    !/^\/nativos_[a-z0-9_]*test$/.test(target.pathname) ||
    !["127.0.0.1", "localhost"].includes(target.hostname)
  )
    throw new Error("Dedicated local test DB required");
  const db = new pg.Pool({ connectionString });
  const tag = randomUUID().slice(0, 6);
  const email = `visual-${tag}@example.test`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await db.query(
      "INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'MESERO')",
      ["Mesero visual", email, await passwordHash(testPassword)],
    );
    await db.query("DELETE FROM rate_limits");
    for (const [shape, seats] of [
      ["square", 4],
      ["round", 6],
      ["rectangle", 8],
    ] as const)
      await db.query(
        "INSERT INTO restaurant_tables(name,floor,shape,capacity) VALUES($1,1,$2,$3)",
        [`${shape}-${tag}`, shape, seats],
      );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await page.getByLabel("Correo", { exact: true }).fill(email);
    await page.getByLabel("Contraseña", { exact: true }).fill(testPassword);
    await page
      .getByRole("button", { name: "Iniciar sesión", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "El salón, a tu ritmo." }),
    ).toBeVisible();
    await page.getByLabel("Buscar mesa").fill(tag);
    for (const [shape, seats] of [
      ["square", 4],
      ["round", 6],
      ["rectangle", 8],
    ] as const) {
      const table = page.getByRole("button", {
        name: new RegExp(`${shape}-${tag}`),
      });
      await expect(table.locator(`svg[data-shape="${shape}"]`)).toHaveCount(1);
      await expect(table.locator("[data-chair]")).toHaveCount(seats);
    }
    const ids = await page
      .locator(".table-scene [id]")
      .evaluateAll((elements) => elements.map((el) => el.id));
    expect(new Set(ids).size).toBe(ids.length);
    await expect(page.locator(".table-card").first()).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: `test-results/isometric-${info.project.name}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Lista", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Plano", exact: true }).click();

    const nav = page.getByRole("navigation", { name: "Navegación principal" });
    await nav
      .getByRole("button", { name: "Mi seguridad", exact: true })
      .click();
    const curtain = page.getByTestId("module-transition");
    await expect(curtain).toContainText("Abriendo Mi seguridad");
    await expect(page.locator(".module-body")).toHaveAttribute("inert", "");
    await expect(curtain).toHaveCSS("animation-duration", "0.9s");
    await page.screenshot({
      path: `test-results/transition-${info.project.name}.png`,
    });
    // Navigation stays usable; an old transition cannot restore the previous module.
    await nav.getByRole("button", { name: "Nueva orden", exact: true }).click();
    await expect(curtain).toContainText("Abriendo Nueva orden");
    await expect(curtain).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator(".module-stage")).toHaveAttribute(
      "data-module",
      "Nueva orden",
    );
    await expect(page.locator(".module-body")).not.toHaveAttribute("inert", "");
    await expect(page.locator(".module-body")).toBeFocused();
    await nav.getByRole("button", { name: "Nueva orden", exact: true }).click();
    await expect(curtain).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await nav
      .getByRole("button", { name: "Salón y mesas", exact: true })
      .click();
    await expect(curtain).toHaveCount(0);
    await page.getByLabel("Buscar mesa").fill(tag);
    const table = page.getByRole("button", {
      name: new RegExp(`square-${tag}`),
    });
    await table.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Mesa reservada para ti mientras preparas el pedido."),
    ).toBeVisible();
    await expect(curtain).toHaveCount(0);
    await nav
      .getByRole("button", { name: "Mi seguridad", exact: true })
      .click();
    await nav.getByRole("button", { name: "Nueva orden", exact: true }).click();
    await expect(
      page
        .getByRole("combobox", { name: "Mesa", exact: true })
        .locator("option:checked"),
    ).toHaveText(`square-${tag} · Nivel 1`);
    await page
      .getByRole("button", {
        name: "Descartar borrador y liberar mesa",
        exact: true,
      })
      .click();
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await db.end();
  }
});
