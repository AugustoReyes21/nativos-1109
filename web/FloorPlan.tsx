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

export function TableDrawing({ table }: { table: DiningTable }) {
  const round = table.shape === "round";
  const wide = table.shape === "rectangle";
  const chairs = Array.from({ length: table.capacity }, (_, i) => {
    const angle = (i / table.capacity) * Math.PI * 2 - Math.PI / 2;
    return (
      <rect
        key={i}
        x={80 + Math.cos(angle) * (wide ? 65 : 54) - 10}
        y={70 + Math.sin(angle) * 53 - 6}
        width="20"
        height="12"
        rx="5"
        transform={`rotate(${(angle * 180) / Math.PI + 90} ${80 + Math.cos(angle) * (wide ? 65 : 54)} ${70 + Math.sin(angle) * 53})`}
        className="table-chair"
      />
    );
  });
  return (
    <svg viewBox="0 0 160 140" className="table-drawing" aria-hidden="true">
      {chairs}
      <rect
        x={wide ? 25 : 39}
        y="29"
        width={wide ? 110 : 82}
        height="82"
        rx={round ? 41 : 15}
        className="table-top"
      />
      <path
        d="M73 59h14m-7-7v14"
        className="table-center"
        fill="none"
        strokeWidth="1.5"
      />
      <circle cx="80" cy="84" r="3" className="table-center-dot" />
    </svg>
  );
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
                aria-label={`Nivel ${n} ${n === 1 ? "Planta baja" : "Segundo nivel"}`}
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
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className={list ? "table-list" : "table-plan"}
          aria-label={`Mesas del nivel ${floor}`}
        >
          {shown.map((table) => {
            const status = statusFor(table.id);
            const state = status?.state;
            const label = state ? tableStateLabels[state] : "Sin sincronizar";
            return (
              <motion.button
                key={table.id}
                className={`table-card ${state ?? "unknown"}`}
                disabled={busy || !connected || !status}
                whileTap={reduced ? undefined : { scale: 0.98 }}
                onClick={() => select(table)}
                aria-label={`${table.name}, nivel ${table.floor}, ${label}, ${status?.openOrders ?? 0} órdenes. ${canCreate ? "Crear orden" : "Ver órdenes"}`}
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
                  {status?.pendingCents
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
            El estado refleja órdenes, no reservas ni ocupación física.
          </span>
        </div>
      </div>
    </section>
  );
}
