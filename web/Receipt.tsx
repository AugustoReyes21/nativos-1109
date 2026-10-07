import { useState } from "react";
import { flushSync } from "react-dom";
import { money } from "./api";
import type { Item, Action, Mutate } from "./types";

export type ReceiptData = {
  payment: {
    order_id: string;
    number: string;
    amount_cents: number;
    gross_cents: number;
    courtesy_cents: number;
    method: string;
    change_cents: number;
    cash_cents: number;
    card_cents: number;
    transfer_cents: number;
    table_name: string;
    table_floor: number;
    created_at: string;
    receiver_type: string;
    receiver_id: string;
    receiver_name: string;
    receiver_address: string;
  };
  items: Item[];
  fiscal: false;
};
export function Receipt({
  data,
  copy = false,
  close,
  run,
  mutate,
  disabled,
}: {
  data: ReceiptData;
  copy?: boolean;
  close: () => void;
  run: Action;
  mutate: Mutate;
  disabled: boolean;
}) {
  const [reprinted, setReprinted] = useState(copy);
  const [printing, setPrinting] = useState(false);
  const p = data.payment;
  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Comprobante"
    >
      <section className="panel receipt">
        <h2>Nativos1109</h2>
        <h3>{reprinted ? "COMPROBANTE REIMPRESO" : "COMPROBANTE INTERNO"}</h3>
        <p>No es factura fiscal</p>
        <h3>Orden #{p.number}</h3>
        <p>
          {p.table_name} · Nivel {p.table_floor}
        </p>
        <p>
          {new Date(p.created_at).toLocaleString("es-GT")} · {p.receiver_type}:{" "}
          {p.receiver_id}
        </p>
        <p>{p.receiver_name}</p>
        {p.receiver_address && <p>{p.receiver_address}</p>}
        {data.items.map((i) => (
          <p key={i.product_id}>
            {i.quantity} × {i.name} · {money(i.quantity * i.price_cents)}
            {i.courtesy_quantity > 0 && ` · ${i.courtesy_quantity} de cortesía`}
          </p>
        ))}
        <p>
          Consumo {money(p.gross_cents)} · Cortesías {money(p.courtesy_cents)}
        </p>
        <strong>Total cobrado {money(p.amount_cents)}</strong>
        <p>
          {p.method} · Cambio {money(p.change_cents)}
        </p>
        <p>
          Efectivo aplicado {money(p.cash_cents)} · Tarjeta{" "}
          {money(p.card_cents)} · Transferencia {money(p.transfer_cents)}
        </p>
        <div className="actions no-print">
          <button
            disabled={disabled || printing}
            onClick={() => {
              setPrinting(true);
              void run(async () => {
                const record = await mutate<{ reprint: boolean }>(
                  `/orders/${p.order_id}/print`,
                  { copy: reprinted },
                );
                flushSync(() => setReprinted(record.reprint));
                window.print();
              }).finally(() => setPrinting(false));
            }}
          >
            {copy ? "Reimprimir comprobante" : "Imprimir"}
          </button>
          <button className="secondary" autoFocus onClick={close}>
            Cerrar
          </button>
        </div>
      </section>
    </div>
  );
}
