export type TableState =
  "available" | "reserved" | "service" | "ready" | "payment";
export const tableStateLabels: Record<TableState, string> = {
  available: "Disponible",
  reserved: "Reservada",
  service: "En servicio",
  ready: "Para servir",
  payment: "Por cobrar",
};
// Server-wide aggregate: never infer availability from filtered orders.
export type TableStatus = {
  tableId: string;
  state: TableState;
  openOrders: number;
  since: string | null;
  mine: boolean;
  pendingCents?: number;
  blocked: boolean;
  claimId: string | null;
  claimExpiresAt: string | null;
};
