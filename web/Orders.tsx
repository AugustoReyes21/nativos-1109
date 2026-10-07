import { useState, type FormEvent } from "react";
import { api, money } from "./api";
import { CheckoutForm } from "./CheckoutForm";
import { Receipt, type ReceiptData } from "./Receipt";
import { human, type Action, type Mutate, type Order } from "./types";
export function Orders({
  orders,
  can,
  busy,
  connected,
  run,
  mutate,
  reload,
  cashOpen,
  checkoutMode = false,
}: {
  orders: Order[];
  can: (p: string) => boolean;
  busy: boolean;
  connected: boolean;
  run: Action;
  mutate: Mutate;
  reload: () => Promise<void>;
  cashOpen: boolean;
  checkoutMode?: boolean;
}) {
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [copy, setCopy] = useState(false);
  const status = (o: Order, next: string) =>
    void run(async () => {
      await mutate(
        `/orders/${o.id}/status`,
        { status: next, version: o.version },
        "PATCH",
      );
      await reload();
    });
  const pay = (data: object, o: Order) => {
    void run(async () => {
      await mutate("/payments", data);
      await reload();
      setCopy(false);
      setReceipt(await api(`/orders/${o.id}/receipt`));
    });
  };
  const kitchen = can("kitchen.update") && !can("products.write");
  const courtesy = (e: FormEvent<HTMLFormElement>, o: Order) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const items = o.items
      .map((i) => ({
        productId: i.product_id,
        quantity: Number(data.get(i.product_id) ?? 0),
      }))
      .filter((i) => i.quantity > 0);
    if (!items.length) {
      form
        .querySelector<HTMLInputElement>('input[type="number"]')
        ?.setCustomValidity("Selecciona al menos una unidad de cortesía.");
      form.reportValidity();
      return;
    }
    if (
      !window.confirm(
        "¿Autorizar esta cortesía? Quedará registrada y no se puede borrar ni cancelar la orden después.",
      )
    )
      return;
    void run(async () => {
      await mutate("/courtesies", {
        orderId: o.id,
        version: o.version,
        reason: data.get("reason"),
        items,
      });
      await reload();
    });
  };
  return (
    <>
      <div className="section-heading">
        <div>
          <p className="eyebrow">SERVICIO EN TIEMPO REAL</p>
          <h1>
            {checkoutMode
              ? "Cuentas enviadas a caja"
              : kitchen
                ? "Cocina"
                : "Órdenes del servicio"}
          </h1>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void run(reload)}
        >
          Actualizar
        </button>
      </div>
      <div className="order-grid">
        {orders
          .filter(
            (o) =>
              !kitchen ||
              ["PENDIENTE", "EN_PREPARACION", "LISTO"].includes(o.status),
          )
          .map((o) => (
            <article className="order" key={o.id}>
              <div className="row">
                <h2>
                  #{o.number} · {o.table_name}
                </h2>
                <span className={`badge ${o.status.toLowerCase()}`}>
                  {human(o.status)}
                </span>
              </div>
              <p className="muted">
                Nivel {o.table_floor} · {o.waiter} ·{" "}
                {new Date(o.created_at).toLocaleTimeString("es-GT", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
              <ul className="items">
                {o.items.map((i) => (
                  <li key={i.product_id}>
                    <strong>
                      {i.quantity} × {i.name}
                    </strong>
                    {i.notes && <small>{i.notes}</small>}
                    {i.courtesy_quantity > 0 && (
                      <small>{i.courtesy_quantity} de cortesía</small>
                    )}
                    <span>{money(i.quantity * i.price_cents)}</span>
                  </li>
                ))}
              </ul>
              {o.notes && <p className="order-note">{o.notes}</p>}
              <div className="row">
                <strong>
                  Total neto {money(o.total_cents - o.courtesy_cents)}
                </strong>
                <span>
                  {o.paid
                    ? o.courtesy_cents === o.total_cents
                      ? "Liquidada por cortesía"
                      : "Pagada"
                    : "Por cobrar"}
                </span>
              </div>
              {o.courtesy_cents > 0 && (
                <p>
                  Consumo {money(o.total_cents)} · Cortesías{" "}
                  {money(o.courtesy_cents)}
                </p>
              )}
              <div className="actions">
                {!o.paid && o.status !== "CANCELADO" && (
                  <>
                    {o.sent_to_cash_at ? (
                      <span className="badge">Enviada a caja</span>
                    ) : (
                      can("orders.send_cash") && (
                        <button
                          disabled={busy || !connected}
                          onClick={() =>
                            void run(async () => {
                              await mutate(`/orders/${o.id}/send-to-cash`, {
                                version: o.version,
                              });
                              await reload();
                            })
                          }
                        >
                          Enviar a caja
                        </button>
                      )
                    )}
                  </>
                )}
                {can("kitchen.update") &&
                  ["PENDIENTE", "EN_PREPARACION"].includes(o.status) && (
                    <button
                      disabled={busy || !connected}
                      onClick={() =>
                        status(
                          o,
                          o.status === "PENDIENTE" ? "EN_PREPARACION" : "LISTO",
                        )
                      }
                    >
                      {o.status === "PENDIENTE" ? "Preparar" : "Marcar listo"}
                    </button>
                  )}
                {can("orders.update") && o.status === "LISTO" && (
                  <button
                    disabled={busy || !connected}
                    onClick={() => status(o, "ENTREGADO")}
                  >
                    Entregar
                  </button>
                )}
                {can("orders.cancel") &&
                  !o.paid &&
                  o.courtesy_cents === 0 &&
                  ["PENDIENTE", "EN_PREPARACION", "LISTO"].includes(
                    o.status,
                  ) && (
                    <button
                      className="danger"
                      disabled={busy || !connected}
                      onClick={() => {
                        if (
                          window.confirm(
                            "¿Cancelar esta orden? Si ya se preparó, su stock no se devuelve.",
                          )
                        )
                          status(o, "CANCELADO");
                      }}
                    >
                      Cancelar
                    </button>
                  )}
              </div>
              {can("courtesies.create") &&
                !o.paid &&
                o.status !== "CANCELADO" && (
                  <details key={`courtesy:${o.courtesy_cents}`}>
                    <summary>Autorizar cortesía</summary>
                    <form onSubmit={(e) => courtesy(e, o)}>
                      <p>
                        Selecciona cantidades a regalar. El stock consumido se
                        conserva y solo se cobrará el saldo restante.
                      </p>
                      {o.items
                        .filter((i) => i.quantity > i.courtesy_quantity)
                        .map((i) => (
                          <label key={i.product_id}>
                            Cortesía de {i.name} (máximo{" "}
                            {i.quantity - i.courtesy_quantity})
                            <input
                              name={i.product_id}
                              type="number"
                              min="0"
                              max={i.quantity - i.courtesy_quantity}
                              step="1"
                              defaultValue="0"
                              onInput={(e) =>
                                e.currentTarget.form
                                  ?.querySelector<HTMLInputElement>(
                                    'input[type="number"]',
                                  )
                                  ?.setCustomValidity("")
                              }
                              required
                            />
                          </label>
                        ))}
                      <label>
                        Motivo de cortesía
                        <input
                          name="reason"
                          minLength={3}
                          maxLength={300}
                          required
                        />
                      </label>
                      <small>
                        Indica al menos una unidad. Esta autorización es
                        definitiva; revisa la orden antes de confirmar.
                      </small>
                      <button disabled={busy || !connected || !cashOpen}>
                        Registrar cortesía
                      </button>
                      {!cashOpen && (
                        <p>Abre la caja para registrar la cortesía.</p>
                      )}
                    </form>
                  </details>
                )}
              {checkoutMode &&
                can("payments.create") &&
                o.sent_to_cash_at &&
                !o.paid &&
                o.status !== "CANCELADO" && (
                  <details>
                    <summary>
                      Cobrar {money(o.total_cents - o.courtesy_cents)}
                    </summary>
                    <CheckoutForm
                      order={o}
                      disabled={busy || !connected || !cashOpen}
                      submit={(data) => pay(data, o)}
                    />
                    {!cashOpen && (
                      <p>
                        Abre la caja o espera autorización del cierre para
                        cobrar.
                      </p>
                    )}
                  </details>
                )}
              {can("payments.create") && o.paid && (
                <button
                  className="secondary"
                  onClick={() =>
                    void run(async () => {
                      setCopy(true);
                      setReceipt(await api(`/orders/${o.id}/receipt`));
                    })
                  }
                >
                  Ver comprobante
                </button>
              )}
            </article>
          ))}
      </div>
      {!orders.length && (
        <p className="empty">
          Aún no hay órdenes. Las nuevas órdenes aparecerán aquí
          automáticamente.
        </p>
      )}
      {receipt && (
        <Receipt
          data={receipt}
          copy={copy}
          close={() => setReceipt(null)}
          run={run}
          mutate={mutate}
          disabled={busy || !connected}
        />
      )}
    </>
  );
}
