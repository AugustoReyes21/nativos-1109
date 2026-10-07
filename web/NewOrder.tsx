import { useState } from "react";
import { money } from "./api";
import type { Action, Catalog, Mutate } from "./types";
export function NewOrder({
  catalog,
  busy,
  connected,
  run,
  mutate,
  done,
}: {
  catalog: Catalog;
  busy: boolean;
  connected: boolean;
  run: Action;
  mutate: Mutate;
  done: () => Promise<void>;
}) {
  const [tableId, setTable] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<
    { productId: string; quantity: number; notes: string }[]
  >([]);
  const [notes, setNotes] = useState("");
  const total = items.reduce(
    (s, i) =>
      s +
      (catalog.products.find((p) => p.id === i.productId)?.price_cents ?? 0) *
        i.quantity,
    0,
  );
  return (
    <>
      <h1>Nueva orden</h1>
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
            {catalog.products
              .filter(
                (p) =>
                  p.active &&
                  (!category || p.category_id === category) &&
                  p.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((p) => (
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
                  <small>
                    {p.stock ? `${p.stock} disponibles` : "Agotado"}
                  </small>
                </button>
              ))}
          </div>
          {!catalog.products.length && (
            <p className="empty">
              El administrador debe configurar productos y disponibilidad.
            </p>
          )}
        </section>
        <section className="cart">
          <h2>Pedido actual</h2>
          <label>
            Mesa
            <select value={tableId} onChange={(e) => setTable(e.target.value)}>
              <option value="">Selecciona una mesa</option>
              {catalog.tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
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
                      max={100}
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
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <div className="row total">
            <strong>Total</strong>
            <strong>{money(total)}</strong>
          </div>
          <button
            disabled={busy || !connected || !tableId || !items.length}
            onClick={() =>
              void run(async () => {
                await mutate("/orders", { tableId, items, notes });
                setItems([]);
                setNotes("");
                await done();
              })
            }
          >
            {busy ? "Enviando…" : "Confirmar y enviar a cocina"}
          </button>
          <small>
            El stock y el precio se validan al confirmar. No se envían pedidos
            sin conexión.
          </small>
        </section>
      </div>
    </>
  );
}
