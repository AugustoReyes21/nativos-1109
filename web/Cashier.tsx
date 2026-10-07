import { useState } from "react";
import { CashView } from "./Management";
import { Orders } from "./Orders";
import type { Action, Mutate, Order, Shift } from "./types";
export function Cashier({
  cash,
  orders,
  can,
  busy,
  connected,
  run,
  mutate,
  reload,
}: {
  cash: Shift[];
  orders: Order[];
  can: (permission: string) => boolean;
  busy: boolean;
  connected: boolean;
  run: Action;
  mutate: Mutate;
  reload: () => Promise<void>;
}) {
  const [section, setSection] = useState<"checkout" | "shift">("checkout");
  const open = cash.find((s) => !s.closed_at);
  const queue = orders
    .filter((o) => o.sent_to_cash_at && !o.paid && o.status !== "CANCELADO")
    .sort((a, b) => a.sent_to_cash_at!.localeCompare(b.sent_to_cash_at!));
  return (
    <>
      <div
        className="actions no-print"
        role="group"
        aria-label="Apartados de caja"
      >
        <button
          aria-pressed={section === "checkout"}
          onClick={() => setSection("checkout")}
        >
          Cobrar cuentas ({queue.length})
        </button>
        <button
          aria-pressed={section === "shift"}
          onClick={() => setSection("shift")}
        >
          Apertura y cierre
        </button>
      </div>
      {section === "shift" ? (
        <CashView
          cash={cash}
          busy={busy || !connected}
          run={run}
          mutate={mutate}
          reload={reload}
          canApprove={can("cash.close.approve")}
        />
      ) : (
        <>
          {!open && (
            <p className="panel no-print">
              Abre caja en «Apertura y cierre» antes de cobrar.
            </p>
          )}
          {open?.closure_requested_at && (
            <p className="panel no-print" role="status">
              Cierre pendiente de autorización del administrador. Cobros
              suspendidos.
            </p>
          )}
          <Orders
            orders={queue}
            can={can}
            busy={busy}
            connected={connected}
            run={run}
            mutate={mutate}
            reload={reload}
            cashOpen={!!open && !open.closure_requested_at}
            checkoutMode
          />
        </>
      )}
    </>
  );
}
