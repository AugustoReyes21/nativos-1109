import type { Order } from "./types";
export type TableState = "available" | "service" | "payment";
export const tableStateLabels: Record<TableState, string> = {
  available: "Disponible",
  service: "En servicio",
  payment: "Por cobrar",
};
export function tableActivity(tableId: string, orders: Order[]) {
  const current = orders.filter(
    (o) =>
      o.table_id === tableId &&
      o.status !== "CANCELADO" &&
      (o.status !== "ENTREGADO" || !o.paid),
  );
  const state: TableState = !current.length
    ? "available"
    : current.every((o) => o.status === "ENTREGADO")
      ? "payment"
      : "service";
  return {
    state,
    orders: current,
    pendingCents: current
      .filter((o) => !o.paid)
      .reduce((sum, o) => sum + o.total_cents, 0),
  };
}
