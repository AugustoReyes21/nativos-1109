import { type FormEvent } from "react";
import { money, toCents } from "./api";
import type { Action, Catalog, DiningTable, Mutate, Shift } from "./types";
import { TableDrawing } from "./FloorPlan";
function TableFields({ table }: { table?: DiningTable }) {
  return (
    <div className="table-form-fields">
      <label>
        Nivel de mesa
        <select name="floor" defaultValue={table?.floor ?? 1}>
          <option value="1">Nivel 1 · Planta baja</option>
          <option value="2">Nivel 2 · Segundo nivel</option>
        </select>
      </label>
      <label>
        Capacidad
        <input
          name="capacity"
          type="number"
          min="1"
          max="12"
          defaultValue={table?.capacity ?? 4}
          required
        />
      </label>
      <label>
        Forma
        <select name="shape" defaultValue={table?.shape ?? "square"}>
          <option value="square">Cuadrada</option>
          <option value="round">Redonda</option>
          <option value="rectangle">Rectangular</option>
        </select>
      </label>
      <label>
        Orden visual
        <input
          name="displayOrder"
          type="number"
          min="0"
          max="999"
          defaultValue={table?.display_order ?? 0}
          required
        />
      </label>
    </div>
  );
}
const tableInput = (f: FormData) => ({
  name: f.get("name"),
  floor: Number(f.get("floor")),
  capacity: Number(f.get("capacity")),
  shape: f.get("shape"),
  displayOrder: Number(f.get("displayOrder")),
});
type Props = {
  catalog: Catalog;
  busy: boolean;
  run: Action;
  mutate: Mutate;
  reload: () => Promise<void>;
};
function formAction(
  e: FormEvent<HTMLFormElement>,
  run: Action,
  reload: () => Promise<void>,
  fn: (f: FormData) => Promise<void>,
) {
  e.preventDefault();
  const form = e.currentTarget;
  const data = new FormData(form);
  void run(async () => {
    await fn(data);
    form.reset();
    await reload();
  });
}
export function CatalogView({ catalog, busy, run, mutate, reload }: Props) {
  return (
    <>
      <h1>Productos y mesas</h1>
      <div className="admin-grid">
        <section className="panel">
          <h2>Nuevo producto</h2>
          <form
            onSubmit={(e) =>
              formAction(e, run, reload, async (f) => {
                await mutate("/products", {
                  name: f.get("name"),
                  categoryId: f.get("category"),
                  priceCents: toCents(f.get("price")),
                  stock: Number(f.get("stock")),
                });
              })
            }
          >
            <label>
              Nombre del producto
              <input name="name" maxLength={100} required />
            </label>
            <label>
              Categoría
              <select name="category" required>
                <option value="">Selecciona</option>
                {catalog.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Precio (Q)
              <input
                name="price"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </label>
            <label>
              Disponibilidad
              <input
                name="stock"
                type="number"
                min="0"
                max="1000000"
                required
              />
            </label>
            <button disabled={busy}>Crear producto</button>
          </form>
        </section>
        <section className="panel">
          <h2>Organizar el servicio</h2>
          <form
            onSubmit={(e) =>
              formAction(e, run, reload, async (f) => {
                await mutate("/categories", { name: f.get("name") });
              })
            }
          >
            <label>
              Nueva categoría
              <input name="name" maxLength={100} required />
            </label>
            <button disabled={busy}>Crear categoría</button>
          </form>
          <hr />
          <form
            onSubmit={(e) =>
              formAction(e, run, reload, async (f) => {
                await mutate("/tables", tableInput(f));
              })
            }
          >
            <label>
              Nueva mesa
              <input name="name" maxLength={100} required />
            </label>
            <TableFields />
            <small>Usa un nombre único entre ambos niveles.</small>
            <button disabled={busy}>Crear mesa</button>
          </form>
          <p>
            {catalog.tables.map((t) => t.name).join(" · ") ||
              "Sin mesas configuradas"}
          </p>
        </section>
      </div>
      <h2>Las mesas de tu restaurante</h2>
      <p className="page-description">
        Configura ambos niveles. El orden visual organiza cada salón de menor a
        mayor.
      </p>
      <div className="table-settings-grid">
        {catalog.tables.map((t) => (
          <details
            className="panel table-settings"
            key={`${t.id}:${t.version}`}
          >
            <summary>
              <TableDrawing table={t} />
              <span>
                {t.name}
                <small>
                  Nivel {t.floor} · {t.capacity} personas
                </small>
              </span>
              <span className="edit-hint">Editar</span>
            </summary>
            <form
              onSubmit={(e) =>
                formAction(e, run, reload, async (f) => {
                  await mutate(
                    `/tables/${t.id}`,
                    { ...tableInput(f), version: t.version },
                    "PATCH",
                  );
                })
              }
            >
              <label>
                Nombre de mesa
                <input
                  name="name"
                  maxLength={100}
                  defaultValue={t.name}
                  required
                />
              </label>
              <TableFields table={t} />
              <small>
                Los pedidos ya creados conservan su nombre y nivel originales.
              </small>
              <button disabled={busy}>Guardar mesa</button>
            </form>
          </details>
        ))}
      </div>
      <h2>Disponibilidad diaria y precios</h2>
      <p>
        Los productos importados del menú comienzan con stock 0. Registra las
        cantidades reales de la jornada para habilitar pedidos.
      </p>
      <div className="product-grid">
        {catalog.products.map((p) => (
          <section className="panel" key={`${p.id}:${p.version}`}>
            <h3>{p.name}</h3>
            <form
              onSubmit={(e) =>
                formAction(e, run, reload, async (f) => {
                  await mutate(
                    `/products/${p.id}`,
                    {
                      name: p.name,
                      categoryId: p.category_id,
                      priceCents: toCents(f.get("price")),
                      stock: Number(f.get("stock")),
                      active: f.get("active") === "on",
                      version: p.version,
                    },
                    "PATCH",
                  );
                })
              }
            >
              <label>
                Precio de {p.name}
                <input
                  name="price"
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={p.price_cents / 100}
                  required
                />
              </label>
              <label>
                Stock de {p.name}
                <input
                  name="stock"
                  type="number"
                  min="0"
                  max="1000000"
                  defaultValue={p.stock}
                  required
                />
              </label>
              <label className="checkbox">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={p.active}
                />
                Disponible en menú
              </label>
              <button disabled={busy}>Guardar {p.name}</button>
            </form>
          </section>
        ))}
      </div>
    </>
  );
}
export function CashView({
  cash,
  busy,
  run,
  mutate,
  reload,
  canApprove,
}: Omit<Props, "catalog"> & { cash: Shift[]; canApprove: boolean }) {
  const open = cash.find((s) => !s.closed_at);
  return (
    <>
      <h1>Caja del restaurante</h1>
      <div className="admin-grid">
        <section className="panel">
          <h2>{open ? "Caja abierta" : "Abrir caja"}</h2>
          {!open ? (
            <form
              onSubmit={(e) =>
                formAction(e, run, reload, async (f) => {
                  await mutate("/cash/open", {
                    openingCents: toCents(f.get("amount")),
                  });
                })
              }
            >
              <label>
                Fondo inicial (Q)
                <input
                  name="amount"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                />
              </label>
              <button disabled={busy}>Abrir caja</button>
            </form>
          ) : (
            <>
              <p className="metric">{money(open.current_expected_cents)}</p>
              <p>Efectivo esperado</p>
              <form
                onSubmit={(e) =>
                  formAction(e, run, reload, async (f) => {
                    await mutate(
                      canApprove ? "/cash/close" : "/cash/close-request",
                      {
                        shiftId: open.id,
                        ...(canApprove && open.closure_request_id
                          ? { requestId: open.closure_request_id }
                          : {}),
                        countedCents: toCents(f.get("amount")),
                      },
                    );
                  })
                }
              >
                <label>
                  Efectivo contado (Q)
                  <input
                    key={open.closure_request_id ?? open.id}
                    name="amount"
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    readOnly={!!open.closure_requested_at}
                    defaultValue={
                      open.closure_counted_cents === null
                        ? ""
                        : (open.closure_counted_cents / 100).toFixed(2)
                    }
                  />
                </label>
                <button
                  disabled={
                    busy || (!!open.closure_requested_at && !canApprove)
                  }
                >
                  {canApprove
                    ? "Autorizar y cerrar caja"
                    : "Solicitar autorización de cierre"}
                </button>
              </form>
              {open.closure_requested_at && (
                <div role="status">
                  <p>
                    Cierre pendiente de autorización administrativa. Los cobros
                    y movimientos están suspendidos.
                  </p>
                  {canApprove && (
                    <form
                      onSubmit={(e) =>
                        formAction(e, run, reload, async (f) => {
                          await mutate("/cash/reject-close", {
                            shiftId: open.id,
                            requestId: open.closure_request_id,
                            reason: f.get("reason"),
                          });
                        })
                      }
                    >
                      <label>
                        Motivo de rechazo
                        <input
                          name="reason"
                          minLength={3}
                          maxLength={300}
                          required
                        />
                      </label>
                      <button disabled={busy}>
                        Rechazar cierre y reabrir operaciones
                      </button>
                    </form>
                  )}
                </div>
              )}
            </>
          )}
        </section>
        {open && !open.closure_requested_at && (
          <section className="panel">
            <h2>Movimiento de efectivo</h2>
            <form
              onSubmit={(e) =>
                formAction(e, run, reload, async (f) => {
                  const amount = toCents(f.get("amount"));
                  await mutate("/cash/movements", {
                    amountCents: f.get("type") === "salida" ? -amount : amount,
                    reason: f.get("reason"),
                  });
                })
              }
            >
              <label>
                Tipo
                <select name="type">
                  <option value="salida">Salida</option>
                  <option value="entrada">Entrada</option>
                </select>
              </label>
              <label>
                Importe (Q)
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                />
              </label>
              <label>
                Motivo
                <input name="reason" minLength={3} maxLength={300} required />
              </label>
              <button disabled={busy}>Registrar movimiento</button>
            </form>
          </section>
        )}
      </div>
      <h2>Cierres recientes</h2>
      {cash
        .filter((s) => s.closed_at)
        .map((s) => (
          <p className="panel" key={s.id}>
            {new Date(s.closed_at!).toLocaleString("es-GT")} · Diferencia:{" "}
            {money(s.difference_cents ?? 0)}
          </p>
        ))}
    </>
  );
}
