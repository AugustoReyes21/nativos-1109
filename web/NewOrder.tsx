import { useState, type Dispatch, type SetStateAction } from "react";
import { money } from "./api";
import type { Action, Catalog, Mutate } from "./types";
import type { TableStatus } from "./table-state";
import { tableStateLabels } from "./table-state";
export type OrderDraft = {
  tableId: string;
  items: { productId: string; quantity: number; notes: string }[];
  notes: string;
};
export const emptyDraft = (): OrderDraft => ({
  tableId: "",
  items: [],
  notes: "",
});
export function NewOrder({
  catalog,
  busy,
  connected,
  run,
  mutate,
  done,
  draft,
  setDraft,
  changeTable,
  status,
  back,
  viewOrders,
}: {
  catalog: Catalog;
  busy: boolean;
  connected: boolean;
  run: Action;
  mutate: Mutate;
  done: () => Promise<void>;
  draft: OrderDraft;
  setDraft: Dispatch<SetStateAction<OrderDraft>>;
  changeTable: (id: string) => void;
  status?: TableStatus;
  back: () => void;
  viewOrders: () => void;
}) {
  const { tableId, items, notes } = draft;
  const setItems = (update: SetStateAction<OrderDraft["items"]>) =>
    setDraft((old) => ({
      ...old,
      items: typeof update === "function" ? update(old.items) : update,
    }));
  const setNotes = (notes: string) => setDraft((old) => ({ ...old, notes }));
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const table = catalog.tables.find((t) => t.id === tableId);
  const visibleProducts = catalog.products.filter(
    (p) =>
      p.active &&
      (!category || p.category_id === category) &&
      p.name.toLowerCase().includes(search.toLowerCase()),
  );
  const invalidQuantity = items.some(
    (i) =>
      !Number.isInteger(i.quantity) ||
      i.quantity < 1 ||
      i.quantity >
        Math.min(
          100,
          catalog.products.find((p) => p.id === i.productId)?.stock ?? 0,
        ),
  );
  const total = items.reduce(
    (s, i) =>
      s +
      (catalog.products.find((p) => p.id === i.productId)?.price_cents ?? 0) *
        i.quantity,
    0,
  );
  return (
    <>
      <div className="page-heading order-heading">
        <div>
          <button className="back-link" onClick={back}>
            ← Salón y mesas
          </button>
          <h1>
            {table ? table.name : "Nueva orden"}
            <span className="title-dot">.</span>
          </h1>
          <p className="page-description">
            {table
              ? `Nivel ${table.floor} · ${table.capacity} personas · Nuevo pedido`
              : "Selecciona una mesa y arma el pedido."}
          </p>
        </div>
        <a className="cart-shortcut" href="#current-order">
          Ver pedido · {items.reduce((sum, i) => sum + i.quantity, 0)} productos
          · {money(total)}
        </a>
      </div>
      {!!status?.openOrders && (
        <div className="table-context">
          <div>
            <strong>
              {tableStateLabels[status.state]} · {status.openOrders}{" "}
              {status.openOrders === 1 ? "orden abierta" : "órdenes abiertas"}
            </strong>
            <small>
              Este pedido se creará como una orden adicional.
              {!status.mine &&
                " La mesa ya está siendo atendida por otro usuario."}
            </small>
          </div>
          <button className="secondary" onClick={viewOrders}>
            Ver órdenes disponibles
          </button>
        </div>
      )}
      <div className="pos-grid">
        <section>
          <div className="filters">
            <label>
              Buscar producto
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Nombre del producto"
              />
            </label>
            <label>
              Categoría
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Todas</option>
                {catalog.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="product-grid">
            {visibleProducts.map((p) => (
              <button
                className="product"
                key={p.id}
                disabled={
                  busy ||
                  !connected ||
                  p.stock <=
                    (items.find((i) => i.productId === p.id)?.quantity ?? 0)
                }
                onClick={() =>
                  setItems((old) =>
                    old.some((i) => i.productId === p.id)
                      ? old.map((i) =>
                          i.productId === p.id
                            ? { ...i, quantity: i.quantity + 1 }
                            : i,
                        )
                      : [...old, { productId: p.id, quantity: 1, notes: "" }],
                  )
                }
              >
                <strong>{p.name}</strong>
                <span>{money(p.price_cents)}</span>
                <small>{p.stock ? `${p.stock} disponibles` : "Agotado"}</small>
              </button>
            ))}
          </div>
          {!visibleProducts.length && (
            <p className="empty">
              {catalog.products.length
                ? "No hay productos que coincidan con tu búsqueda."
                : "El administrador debe configurar productos y disponibilidad."}
            </p>
          )}
        </section>
        <section className="cart" id="current-order" aria-label="Pedido actual">
          <p className="eyebrow">A COCINA, CON PRECISIÓN</p>
          <h2>Pedido actual</h2>
          <label>
            Mesa
            <select
              value={tableId}
              disabled={busy}
              onChange={(e) => changeTable(e.target.value)}
            >
              <option value="">Selecciona una mesa</option>
              {catalog.tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · Nivel {t.floor}
                </option>
              ))}
            </select>
          </label>
          {!items.length && (
            <p className="cart-empty">
              Tu pedido empieza aquí.
              <br />
              <small>Toca un producto para agregarlo.</small>
            </p>
          )}
          {items.map((i) => {
            const p = catalog.products.find((p) => p.id === i.productId);
            return (
              <div className="cart-item" key={i.productId}>
                <strong>{p?.name}</strong>
                <div className="row">
                  <label>
                    Cantidad
                    <input
                      type="number"
                      min={1}
                      max={Math.min(100, p?.stock ?? 0)}
                      disabled={busy}
                      value={i.quantity}
                      onChange={(e) =>
                        setItems((old) =>
                          old.map((x) =>
                            x.productId === i.productId
                              ? { ...x, quantity: Number(e.target.value) }
                              : x,
                          ),
                        )
                      }
                    />
                  </label>
                  <span>{money(i.quantity * (p?.price_cents ?? 0))}</span>
                  <button
                    className="secondary"
                    disabled={busy}
                    aria-label={`Quitar ${p?.name}`}
                    onClick={() =>
                      setItems((old) =>
                        old.filter((x) => x.productId !== i.productId),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
                <label>
                  Observaciones
                  <input
                    maxLength={300}
                    disabled={busy}
                    value={i.notes}
                    onChange={(e) =>
                      setItems((old) =>
                        old.map((x) =>
                          x.productId === i.productId
                            ? { ...x, notes: e.target.value }
                            : x,
                        ),
                      )
                    }
                  />
                </label>
              </div>
            );
          })}
          <label>
            Nota del pedido
            <textarea
              maxLength={500}
              disabled={busy}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <div className="row total">
            <strong>Total</strong>
            <strong>{money(total)}</strong>
          </div>
          <button
            disabled={
              busy || !connected || !tableId || !items.length || invalidQuantity
            }
            onClick={() =>
              void run(async () => {
                await mutate("/orders", { tableId, items, notes });
                setDraft(emptyDraft());
                await done();
              })
            }
          >
            {busy ? "Enviando…" : "Confirmar y enviar a cocina"}
          </button>
          {invalidQuantity && (
            <p role="status" className="quantity-warning">
              Revisa las cantidades: deben ser positivas y no superar la
              disponibilidad actual.
            </p>
          )}
          <small>
            El stock y el precio se validan al confirmar. No se envían pedidos
            sin conexión.
          </small>
        </section>
      </div>
    </>
  );
}
