import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { money } from "./api";
import type { DiningTable } from "./types";
import {
  tableStateLabels,
  type TableState,
  type TableStatus,
} from "./table-state";
import { Icon } from "./Icon";
import { TableScene } from "./TableScene";

export function TableDrawing({ table }: { table: DiningTable }) {
  return <TableScene table={table} />;
}

export function FloorPlan({
  tables,
  statuses,
  floor,
  setFloor,
  select,
  canCreate,
  busy,
  connected,
  configure,
}: {
  tables: DiningTable[];
  statuses: TableStatus[];
  floor: 1 | 2;
  setFloor: (floor: 1 | 2) => void;
  select: (table: DiningTable) => void;
  canCreate: boolean;
  busy: boolean;
  connected: boolean;
  configure?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TableState | "">("");
  const [list, setList] = useState(false);
  const reduced = useReducedMotion();
  const onFloor = tables.filter((t) => t.floor === floor);
  const statusFor = (id: string) => statuses.find((s) => s.tableId === id);
  const shown = onFloor.filter(
    (t) =>
      t.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
      (!filter || statusFor(t.id)?.state === filter),
  );
  return (
    <section className="floor-view" aria-labelledby="floor-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">NATIVOS / EXPERIENCIA DE SERVICIO</p>
          <h1 id="floor-title">
            El salón, a tu ritmo<span className="title-dot">.</span>
          </h1>
          <p className="page-description">
            Cada mesa, cada momento. Todo en un mismo lugar.
          </p>
        </div>
        <div className="service-tag">
          <span className={connected ? "live-dot" : "offline-dot"} />
          {connected ? "Servicio sincronizado" : "Datos sin actualizar"}
        </div>
      </div>
      <div className="floor-summary" aria-label={`Resumen nivel ${floor}`}>
        <div>
          <small>MESAS DEL NIVEL</small>
          <strong>{onFloor.length.toString().padStart(2, "0")}</strong>
          <span>Nivel {floor}</span>
        </div>
        {(["available", "ready", "payment"] as const).map((state) => (
          <div key={state} className={`summary-${state}`}>
            <small>{tableStateLabels[state].toLocaleUpperCase()}</small>
            <strong>
              {onFloor
                .filter((t) => statusFor(t.id)?.state === state)
                .length.toString()
                .padStart(2, "0")}
            </strong>
            <span>
              {state === "available"
                ? "Sin órdenes abiertas"
                : state === "ready"
                  ? "La cocina te espera"
                  : "Entregadas sin cobrar"}
            </span>
          </div>
        ))}
      </div>
      <div className="floor-workspace">
        <div className="floor-toolbar">
          <div
            className="floor-switch"
            role="group"
            aria-label="Nivel del restaurante"
          >
            {([1, 2] as const).map((n) => (
              <button
                key={n}
                aria-pressed={floor === n}
                onClick={() => {
                  setFloor(n);
                  setSearch("");
                }}
                className={floor === n ? "active" : ""}
              >
                <span className="level-number">0{n}</span>
                <span>
                  Nivel {n}
                  <small>{n === 1 ? "Planta baja" : "Segundo nivel"}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="view-switch" role="group" aria-label="Vista de mesas">
            <button aria-pressed={!list} onClick={() => setList(false)}>
              Plano
            </button>
            <button aria-pressed={list} onClick={() => setList(true)}>
              Lista
            </button>
          </div>
        </div>
        <div className="floor-filters">
          <label className="table-search">
            <span className="sr-only">Buscar mesa</span>
            <Icon name="search" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar mesa…"
            />
          </label>
          <label className="state-filter">
            <span className="sr-only">Estado de mesa</span>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as TableState | "")}
            >
              <option value="">Todos los estados</option>
              {Object.entries(tableStateLabels).map(([state, label]) => (
                <option key={state} value={state}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <motion.div
          key={`${floor}:${list}`}
          initial={reduced ? false : { opacity: 0, x: floor === 2 ? 28 : -28 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
          className={list ? "table-list" : "table-plan"}
          aria-label={`Mesas del nivel ${floor}`}
        >
          {shown.map((table, index) => {
            const status = statusFor(table.id);
            const state = status?.state;
            const label = state ? tableStateLabels[state] : "Sin sincronizar";
            return (
              <motion.button
                key={table.id}
                className={`table-card ${state ?? "unknown"}`}
                disabled={
                  busy || !connected || !status || (canCreate && status.blocked)
                }
                whileTap={reduced ? undefined : { scale: 0.98 }}
                initial={reduced ? false : { opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.32,
                  delay: reduced ? 0 : Math.min(index, 7) * 0.035,
                }}
                onClick={() => select(table)}
              >
                <span className={`table-state ${state ?? ""}`}>
                  <span />
                  {label}
                </span>
                <TableDrawing table={table} />
                <span className="table-card-name">{table.name}</span>
                <span className="table-capacity">
                  {table.capacity} personas
                  {status?.openOrders
                    ? ` · ${status.openOrders} ${status.openOrders === 1 ? "orden" : "órdenes"}`
                    : ""}
                </span>
                <span className="table-card-footer">
                  {canCreate && status?.blocked
                    ? "Otro mesero atiende aquí"
                    : status?.claimId
                      ? "Reservada para ti"
                      : status?.pendingCents
                        ? money(status.pendingCents)
                        : status?.mine
                          ? "Tienes una orden aquí"
                          : canCreate
                            ? "Abrir pedido"
                            : "Ver servicio"}
                  <Icon name="arrow" />
                </span>
              </motion.button>
            );
          })}
        </motion.div>
        {!shown.length && (
          <div className="floor-empty">
            <Icon name="salon" />
            <h2>
              {onFloor.length
                ? "No encontramos esa mesa"
                : `Dale vida al nivel ${floor}`}
            </h2>
            <p>
              {onFloor.length
                ? "Prueba otro nombre o estado."
                : "Configura las mesas reales de este nivel para comenzar el servicio."}
            </p>
            {configure && !onFloor.length && (
              <button onClick={configure}>Configurar mesas</button>
            )}
          </div>
        )}
        <div className="floor-footnote">
          <span>Mapa operativo · Distribución automática</span>
          <span>
            Selección exclusiva por mesero · No representa reservas de
            comensales.
          </span>
        </div>
      </div>
    </section>
  );
}
