import { useState, type FormEvent } from "react";
import { toCents, money } from "./api";
import type { Order } from "./types";

export function CheckoutForm({
  order,
  disabled,
  submit,
}: {
  order: Order;
  disabled: boolean;
  submit: (data: object) => void;
}) {
  const due = order.total_cents - order.courtesy_cents;
  const [method, setMethod] = useState("EFECTIVO");
  const [receiverType, setReceiverType] = useState("CF");
  const [card, setCard] = useState("0.00");
  const [error, setError] = useState("");
  const cardCents =
    method === "MIXTO" && /^\d+(\.\d{1,2})?$/.test(card) ? toCents(card) : 0;
  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      setError("");
      submit({
        orderId: order.id,
        method,
        cardCents,
        tenderedCents: toCents(f.get("amount")) + cardCents,
        documentKind: "COMPROBANTE",
        receiver: {
          type: receiverType,
          id: receiverType === "CF" ? "CF" : f.get("receiverId"),
          name:
            receiverType === "CF" ? "CONSUMIDOR FINAL" : f.get("receiverName"),
          address: String(f.get("address") ?? ""),
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revisa los importes");
    }
  };
  return (
    <form onSubmit={send}>
      {error && <p role="alert">{error}</p>}
      <label>
        Método
        <select
          name="method"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          <option value="EFECTIVO">Efectivo</option>
          <option value="TARJETA">Tarjeta</option>
          <option value="MIXTO">Mixto · efectivo y tarjeta</option>
          <option value="TRANSFERENCIA">Transferencia</option>
        </select>
      </label>
      {method === "MIXTO" && (
        <label>
          Parte con tarjeta (Q)
          <input
            type="number"
            min="0.01"
            max={(due - 1) / 100}
            step="0.01"
            value={card}
            onChange={(e) => setCard(e.target.value)}
            required
          />
        </label>
      )}
      <label>
        {method === "MIXTO" ? "Efectivo recibido (Q)" : "Importe recibido (Q)"}
        <input
          name="amount"
          key={`${method}:${cardCents}:${due}`}
          type="number"
          min={Math.max(0, due - cardCents) / 100}
          step="0.01"
          defaultValue={(Math.max(0, due - cardCents) / 100).toFixed(2)}
          required
        />
      </label>
      {method === "MIXTO" && (
        <p>
          Aplicar en efectivo: {money(due - cardCents)}. El cambio se calcula
          solo sobre el efectivo recibido.
        </p>
      )}
      <label>
        Identificación del receptor
        <select
          value={receiverType}
          onChange={(e) => setReceiverType(e.target.value)}
        >
          <option value="CF">C/F · Consumidor final</option>
          <option value="NIT">NIT</option>
          <option value="CUI">CUI</option>
        </select>
      </label>
      {receiverType !== "CF" && (
        <>
          <label>
            {receiverType}
            <input
              name="receiverId"
              maxLength={20}
              inputMode={receiverType === "CUI" ? "numeric" : "text"}
              pattern={receiverType === "CUI" ? "[0-9]{13}" : "[0-9Kk -]{2,20}"}
              required
            />
          </label>
          <label>
            Nombre o razón social
            <input name="receiverName" maxLength={200} required />
          </label>
          <label>
            Dirección del receptor
            <input name="address" maxLength={300} />
          </label>
        </>
      )}
      <label>
        Documento
        <select name="document" defaultValue="COMPROBANTE">
          <option value="COMPROBANTE">Comprobante interno · no fiscal</option>
          <option disabled value="FACTURA">
            Factura FEL · pendiente de habilitación
          </option>
        </select>
      </label>
      <p className="muted">
        La factura FEL necesita configurar el certificador y los datos fiscales
        del restaurante. Este cobro no emite una factura fiscal.
      </p>
      <button disabled={disabled}>Confirmar cobro</button>
    </form>
  );
}
