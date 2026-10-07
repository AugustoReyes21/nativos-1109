import { useEffect, useState, type FormEvent } from "react";
import { api, money, toCents } from "./api";
import type { Action, Mutate, User } from "./types";
import { Receipt, type ReceiptData } from "./Receipt";

type Props = { busy: boolean; run: Action; mutate: Mutate };
function useRows<T>(path: string) {
  const [rows, setRows] = useState<T[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    api<T[]>(path)
      .then((value) => {
        if (active) setRows(value);
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : "No se pudo cargar");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return {
    rows,
    setRows,
    error,
    loading,
    retry: async () => {
      setRows(await api<T[]>(path));
      setError("");
    },
  };
}
export function UsersView({
  busy,
  run,
  canManageSuper,
}: Omit<Props, "mutate"> & { canManageSuper: boolean }) {
  const { rows: users, error, loading, retry } = useRows<User>("/users");
  return (
    <>
      <h1>Usuarios</h1>
      <p>
        Cuentas y permisos del personal; la bitácora se consulta en su propio
        módulo.
      </p>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Cargando usuarios…</p>}
      <button disabled={busy} onClick={() => void run(retry)}>
        Actualizar usuarios
      </button>
      <form
        className="panel narrow"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          void run(async () => {
            await api("/users", "POST", {
              name: f.get("name"),
              email: f.get("email"),
              password: f.get("password"),
              role: f.get("role"),
            });
            form.reset();
            await retry();
          });
        }}
      >
        <h2>Crear usuario</h2>
        <label>
          Nombre
          <input name="name" maxLength={100} required />
        </label>
        <label>
          Correo
          <input name="email" type="email" autoComplete="off" required />
        </label>
        <label>
          Contraseña inicial
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </label>
        <label>
          Rol
          <select name="role">
            {[
              "MESERO",
              "CAJERO",
              "COCINA",
              "ADMINISTRADOR",
              ...(canManageSuper ? ["SUPERADMIN"] : []),
            ].map((role) => (
              <option key={role}>{role}</option>
            ))}
          </select>
        </label>
        <button disabled={busy}>Crear usuario</button>
      </form>
      {users.map((u) => (
        <div className="panel row" key={u.id}>
          <span>
            {u.name} · {u.email} · {u.role} ·{" "}
            {u.active ? "Activo" : "Bloqueado"}
          </span>
          <button
            disabled={busy || (u.role === "SUPERADMIN" && !canManageSuper)}
            onClick={() =>
              void run(async () => {
                await api(`/users/${u.id}`, "PATCH", {
                  role: u.role,
                  active: !u.active,
                });
                await retry();
              })
            }
          >
            {u.active ? "Bloquear" : "Activar"}
          </button>
        </div>
      ))}
    </>
  );
}
type AuditEntry = {
  user_name: string | null;
  id: string;
  user_id: string | null;
  action: string;
  resource: string;
  resource_id: string | null;
  created_at: string;
  result: string;
  request_id: string;
};
export function AuditView({ busy, run }: Omit<Props, "mutate">) {
  const { rows, error, loading, retry } = useRows<AuditEntry>("/audit");
  return (
    <>
      <h1>Bitácora</h1>
      <p>
        Últimos 100 eventos. Registro inmutable de operaciones y responsables.
      </p>
      <button disabled={busy} onClick={() => void run(retry)}>
        Actualizar bitácora
      </button>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Cargando bitácora…</p>}
      {rows.map((a) => (
        <article className="panel" key={a.id}>
          <strong>
            {a.action} · {a.result}
          </strong>
          <p>
            {new Date(a.created_at).toLocaleString("es-GT")} · Usuario{" "}
            {a.user_name ?? a.user_id ?? "No autenticado"}
          </p>
          <small>
            {a.resource} · {a.resource_id} · Ref. {a.request_id}
          </small>
        </article>
      ))}
    </>
  );
}
type Courtesy = {
  id: string;
  number: string;
  table_name: string;
  table_floor: number;
  authorized_by: string;
  reason: string;
  amount_cents: number;
  created_at: string;
  items: { name: string; quantity: string }[];
};
export function CourtesiesView({ busy, run }: Omit<Props, "mutate">) {
  const { rows, error, loading, retry } = useRows<Courtesy>("/courtesies");
  return (
    <>
      <h1>Cortesías</h1>
      <p>Últimas 100 autorizaciones; no constituyen ingreso ni efectivo.</p>
      <button disabled={busy} onClick={() => void run(retry)}>
        Actualizar cortesías
      </button>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Cargando cortesías…</p>}
      {rows.map((c) => (
        <article className="panel" key={c.id}>
          <h2>
            Orden #{c.number} · {c.table_name} · Nivel {c.table_floor}
          </h2>
          <p>
            {c.items.map((i) => `${i.quantity} × ${i.name}`).join(" · ")} ·
            Valor {money(c.amount_cents)}
          </p>
          <p>Motivo: {c.reason}</p>
          <small>
            {c.authorized_by} · {new Date(c.created_at).toLocaleString("es-GT")}
          </small>
        </article>
      ))}
    </>
  );
}
type Sale = ReceiptData["payment"] & { id: string; cashier: string };
export function SalesView({ busy, run, mutate }: Props) {
  const [result, setResult] = useState<{ items: Sale[]; next: string | null }>({
    items: [],
    next: null,
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  useEffect(() => {
    let active = true;
    api<typeof result>("/sales")
      .then((r) => {
        if (active) setResult(r);
      })
      .catch((e: unknown) => {
        if (active)
          setError(
            e instanceof Error ? e.message : "No se pudo cargar el historial",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <div className="no-print">
        <h1>Historial de ventas</h1>
        <p>
          Ventas registradas de todos los turnos, ordenadas de más reciente a
          más antigua.
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setResult(await api("/sales"));
              setError("");
            })
          }
        >
          Actualizar historial
        </button>
        {error && <p role="alert">{error}</p>}
        {loading && <p role="status">Cargando ventas…</p>}
        {!loading && !result.items.length && (
          <p className="empty">Todavía no hay ventas registradas.</p>
        )}
        {result.items.map((s) => (
          <article className="panel" key={s.id}>
            <h2>
              Orden #{s.number} · {s.table_name}
            </h2>
            <p>
              {new Date(s.created_at).toLocaleString("es-GT")} · {s.cashier}
            </p>
            <strong>
              {money(s.amount_cents)} · {s.method}
            </strong>
            <p>
              {s.receiver_type}: {s.receiver_id} · {s.receiver_name}
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setReceipt(await api(`/orders/${s.order_id}/receipt`)),
                )
              }
            >
              Ver venta y comprobante
            </button>
          </article>
        ))}
        {result.next && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = await api<typeof result>(
                  `/sales?before=${result.next}`,
                );
                setResult((current) => ({
                  items: [...current.items, ...next.items],
                  next: next.next,
                }));
              })
            }
          >
            Cargar ventas anteriores
          </button>
        )}
      </div>
      {receipt && (
        <Receipt
          data={receipt}
          copy
          close={() => setReceipt(null)}
          run={run}
          mutate={mutate}
          disabled={busy}
        />
      )}
    </>
  );
}
type FinanceSummary = {
  income_cents: string;
  cash_cents: string;
  card_cents: string;
  transfer_cents: string;
  courtesy_cents: string;
  expense_cents: string;
  loss_cents: string;
  recorded_balance_cents: number;
  daily: { day: string; income_cents: string; transactions: string }[];
  entries: {
    id: string;
    kind: string;
    amount_cents: number;
    description: string;
    occurred_on: string;
    author: string;
  }[];
};
export function FinanceView({
  busy,
  run,
  mutate,
  canWrite,
}: Props & { canWrite: boolean }) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const query = async () =>
    setSummary(await api(`/finance/summary?from=${from}&to=${to}`));
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      await mutate("/expenses", {
        kind: f.get("kind"),
        amountCents: toCents(f.get("amount")),
        description: f.get("description"),
        occurredOn: f.get("date"),
      });
      form.reset();
      await query();
    });
  };
  return (
    <>
      <h1>Ingresos, gastos y mermas</h1>
      <p>
        Saldo parcial de lo registrado, no utilidad fiscal. Completa costos e
        impuestos con tu contador. Movimientos de caja no se descuentan
        nuevamente como gastos.
      </p>
      <form
        className="panel filters"
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
        }}
      >
        <label>
          Desde
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
        </label>
        <label>
          Hasta
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          />
        </label>
        <button disabled={busy}>Consultar reporte</button>
      </form>
      {summary && (
        <>
          <div className="finance-metrics">
            {[
              ["Ingresos cobrados", summary.income_cents],
              ["Gastos registrados", summary.expense_cents],
              ["Mermas registradas", summary.loss_cents],
              ["Saldo parcial", summary.recorded_balance_cents],
              ["Cortesías · valor de venta", summary.courtesy_cents],
            ].map(([label, value]) => (
              <div className="panel" key={String(label)}>
                <small>{label}</small>
                <strong className="metric">{money(value!)}</strong>
              </div>
            ))}
          </div>
          <p>
            Efectivo {money(summary.cash_cents)} · Tarjeta{" "}
            {money(summary.card_cents)} · Transferencia{" "}
            {money(summary.transfer_cents)}
          </p>
          <h2>Ingresos diarios</h2>
          {summary.daily.map((d) => (
            <p className="panel" key={d.day}>
              {d.day} · {d.transactions} operaciones · {money(d.income_cents)}
            </p>
          ))}
        </>
      )}
      {canWrite && (
        <form className="panel narrow" onSubmit={save}>
          <h2>Registrar gasto o merma</h2>
          <p>
            Registro financiero definitivo: no mueve efectivo ni descuenta
            inventario. No registres la misma pérdida como gasto y merma.
          </p>
          <label>
            Tipo de registro
            <select name="kind">
              <option value="GASTO">Gasto</option>
              <option value="MERMA">Merma / pérdida</option>
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
            Descripción
            <input name="description" minLength={3} maxLength={300} required />
          </label>
          <label>
            Fecha
            <input name="date" type="date" defaultValue={today} required />
          </label>
          <button disabled={busy}>Guardar registro financiero</button>
        </form>
      )}
      {summary && (
        <>
          <h2>Últimos 100 registros del período</h2>
          {summary.entries.map((e) => (
            <article className="panel" key={e.id}>
              <strong>
                {e.kind} · {money(e.amount_cents)}
              </strong>
              <p>{e.description}</p>
              <small>
                {String(e.occurred_on).slice(0, 10)} · {e.author}
              </small>
            </article>
          ))}
        </>
      )}
    </>
  );
}
