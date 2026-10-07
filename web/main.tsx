import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError } from "./api";
import { Auth } from "./Auth";
import { NewOrder, emptyDraft } from "./NewOrder";
import { FloorPlan } from "./FloorPlan";
import { Icon, type IconName } from "./Icon";
import type { TableStatus } from "./table-state";
import { MotionConfig } from "motion/react";
import { Orders } from "./Orders";
import { AdminView, CashView, CatalogView } from "./Management";
import {
  human,
  type Catalog,
  type Order,
  type Shift,
  type User,
} from "./types";
import "./style.css";
import "./experience.css";

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const contentRef = useRef<HTMLElement>(null);
  const lastInteraction = useRef(Date.now());
  useEffect(() => {
    const active = () => {
      lastInteraction.current = Date.now();
    };
    window.addEventListener("pointerdown", active);
    window.addEventListener("keydown", active);
    return () => {
      window.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
    };
  }, []);
  const attempts = useRef(new Map<string, string>());
  const [connected, setConnected] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>({
    products: [],
    categories: [],
    tables: [],
  });
  const [orders, setOrders] = useState<Order[]>([]);
  const [tableStatuses, setTableStatuses] = useState<TableStatus[]>([]);
  const [floor, setFloor] = useState<1 | 2>(1);
  const [draft, setDraft] = useState(emptyDraft);
  const [orderTable, setOrderTable] = useState<string | null>(null);
  const [cash, setCash] = useState<Shift[]>([]);
  const [view, setView] = useState("ordenes");
  useEffect(() => {
    if (user) contentRef.current?.focus({ preventScroll: true });
  }, [view, user]);
  const [resetToken] = useState(() =>
    location.hash.startsWith("#reset=") ? location.hash.slice(7) : "",
  );
  const can = (p: string) => user?.permissions.includes(p) ?? false;
  const showError = (e: unknown) =>
    setError(
      e instanceof Error
        ? e.message +
            (e instanceof ApiError && e.requestId
              ? " · Ref. " + e.requestId
              : "")
        : "No se pudo completar la operación",
    );
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      showError(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const mutate = async <T,>(
    path: string,
    data: unknown,
    method = "POST",
  ): Promise<T> => {
    // A renewed selection lease is authorization context, not a new order.
    const businessData =
      path === "/orders" && data !== null && typeof data === "object"
        ? Object.fromEntries(
            Object.entries(data).filter(([key]) => key !== "claimId"),
          )
        : data;
    const signature = method + ":" + path + ":" + JSON.stringify(businessData);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(user?.id + signature),
    );
    const storageKey =
      "nativos:attempt:" +
      Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    // Persist only a payload hash and UUID, never credentials, tokens, or order contents.
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(storageKey);
    } catch {
      /* Restricted storage: in-memory fallback remains available. */
    }
    const key = saved ?? attempts.current.get(signature) ?? crypto.randomUUID();
    attempts.current.set(signature, key);
    try {
      sessionStorage.setItem(storageKey, key);
    } catch {
      /* Same-tab retry still preserves the key in memory. */
    }
    const forget = () => {
      attempts.current.delete(signature);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* No storage access. */
      }
    };
    try {
      const result = await api<T>(path, method, data, key);
      forget();
      return result;
    } catch (e) {
      if (
        e instanceof ApiError &&
        !["NETWORK_ERROR", "INTERNAL_ERROR", "RETRY_REQUIRED"].includes(e.code)
      )
        forget();
      throw e;
    }
  };
  const load = useCallback(async (u: User) => {
    const tasks: Promise<void>[] = [
      api<Order[]>("/orders").then(setOrders),
      api<TableStatus[]>("/tables/status").then(setTableStatuses),
    ];
    if (u.permissions.includes("products.read"))
      tasks.push(api<Catalog>("/catalog").then(setCatalog));
    if (u.permissions.includes("cash.read"))
      tasks.push(api<Shift[]>("/cash").then(setCash));
    await Promise.all(tasks);
  }, []);
  const enter = async () => {
    const me = await api<User>("/auth/me");
    setUser(me);
    setView(me.permissions.includes("orders.create") ? "salon" : "ordenes");
    setDraft(emptyDraft());
    setOrderTable(null);
    await load(me);
  };
  const reload = async () => {
    if (user) await load(user);
  };
  useEffect(() => {
    if (resetToken) {
      history.replaceState(null, "", "/");
      setBooting(false);
      return;
    }
    void api<User>("/auth/me")
      .then(async (u) => {
        setUser(u);
        setView(u.permissions.includes("orders.create") ? "salon" : "ordenes");
        await load(u);
      })
      .catch((e) => {
        if (!(
          e instanceof ApiError &&
          ["UNAUTHENTICATED", "SESSION_EXPIRED"].includes(e.code)
        ))
          showError(e);
      })
      .finally(() => setBooting(false));
  }, [load, resetToken]);
  useEffect(() => {
    if (!user) return;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let stop = false;
    let delay = 1000;
    const connect = () => {
      if (stop) return;
      source = new EventSource("/api/events");
      source.onopen = () => {
        setConnected(true);
        delay = 1000;
      };
      source.addEventListener("sync", () => {
        void load(user).catch(showError);
      });
      source.onerror = () => {
        source?.close();
        setConnected(false);
        timer = setTimeout(
          () => {
            void api<User>("/auth/me")
              .then(() => {
                if (!stop) connect();
              })
              .catch((e) => {
                if (
                  e instanceof ApiError &&
                  ["UNAUTHENTICATED", "SESSION_EXPIRED"].includes(e.code)
                )
                  setUser(null);
                else if (!stop) {
                  delay = Math.min(delay * 2, 30000);
                  timer = setTimeout(connect, delay);
                }
              });
          },
          delay + Math.random() * 500,
        );
        delay = Math.min(delay * 2, 30000);
      };
    };
    const offline = () => {
      setConnected(false);
      source?.close();
      clearTimeout(timer);
    };
    const online = () => {
      source?.close();
      clearTimeout(timer);
      delay = 1000;
      connect();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    connect();
    return () => {
      stop = true;
      source?.close();
      clearTimeout(timer);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [user, load]);
  useEffect(() => {
    if (!user) return;
    // Lease expiry and logout need no background scheduler/SSE event to be seen.
    let pending = false,
      stopped = false;
    const timer = setInterval(() => {
      if (!navigator.onLine || pending) return;
      pending = true;
      void api<TableStatus[]>("/tables/status")
        .then((statuses) => {
          if (!stopped) setTableStatuses(statuses);
        })
        .catch((e: unknown) => {
          if (!stopped) showError(e);
        })
        .finally(() => {
          pending = false;
        });
    }, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [user]);
  useEffect(() => {
    if (!user || !draft.tableId || !draft.claimId || !connected) return;
    const tableId = draft.tableId,
      claimId = draft.claimId;
    let stopped = false,
      pending = false;
    const renew = () => {
      if (
        pending ||
        lock.current ||
        !navigator.onLine ||
        document.visibilityState !== "visible" ||
        Date.now() - lastInteraction.current > 240000
      )
        return;
      pending = true;
      void api<{ expiresAt: string }>(
        `/tables/${tableId}/claim/renew`,
        "POST",
        { claimId },
      )
        .then((result) => {
          if (!stopped)
            setDraft((old) =>
              old.claimId === claimId
                ? { ...old, claimExpiresAt: result.expiresAt }
                : old,
            );
        })
        .catch((e: unknown) => {
          if (stopped) return;
          if (
            e instanceof ApiError &&
            [
              "TABLE_CLAIM_EXPIRED",
              "TABLE_IN_USE",
              "UNAUTHENTICATED",
              "SESSION_EXPIRED",
            ].includes(e.code)
          ) {
            setDraft((old) =>
              old.claimId === claimId
                ? { ...old, claimId: null, claimExpiresAt: null }
                : old,
            );
          }
          showError(e);
        })
        .finally(() => {
          pending = false;
        });
    };
    // Renew on reconnect as well as while navigating with an unfinished draft.
    renew();
    const timer = setInterval(renew, 60000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [user, draft.tableId, draft.claimId, connected]);
  useEffect(() => {
    if (!draft.items.length) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.items.length]);
  const changeTable = async (id: string, open = false) => {
    if (
      id !== draft.tableId &&
      draft.items.length &&
      !window.confirm(
        "Hay productos en el borrador. ¿Mover este pedido a la mesa seleccionada?",
      )
    )
      return;
    await run(async () => {
      if (!id) {
        if (draft.tableId && draft.claimId)
          await api(`/tables/${draft.tableId}/claim/release`, "POST", {
            claimId: draft.claimId,
          });
        setDraft((old) => ({
          ...old,
          tableId: "",
          claimId: null,
          claimExpiresAt: null,
        }));
      } else {
        const status = tableStatuses.find((s) => s.tableId === id);
        const claimId =
          status?.claimId &&
          status.claimExpiresAt &&
          new Date(status.claimExpiresAt).getTime() > Date.now()
            ? status.claimId
            : crypto.randomUUID();
        const claim = await api<{ claimId: string; expiresAt: string }>(
          `/tables/${id}/claim`,
          "POST",
          {
            claimId,
            ...(draft.tableId && draft.claimId
              ? { previous: { tableId: draft.tableId, claimId: draft.claimId } }
              : {}),
          },
        );
        setDraft((old) => ({
          ...old,
          tableId: id,
          claimId: claim.claimId,
          claimExpiresAt: claim.expiresAt,
        }));
        if (open) setView("nueva");
      }
      await reload();
    });
  };
  const discard = () => {
    if (
      draft.items.length &&
      !window.confirm("¿Descartar estos productos y liberar la mesa?")
    )
      return;
    void run(async () => {
      if (draft.tableId && draft.claimId)
        await api(`/tables/${draft.tableId}/claim/release`, "POST", {
          claimId: draft.claimId,
        });
      setDraft(emptyDraft());
      setView("salon");
      await reload();
    });
  };
  const feedback = error && (
    <div role="alert" className="alert">
      {error}
    </div>
  );
  if (booting)
    return (
      <main className="login">
        <p role="status">Conectando con Nativos1109…</p>
      </main>
    );
  if (!user)
    return (
      <main className="login">
        <div>
          {feedback}
          <Auth enter={enter} run={run} busy={busy} resetToken={resetToken} />
        </div>
      </main>
    );
  const tab = (id: IconName, label: string, visible = true) =>
    visible && (
      <button
        className={view === id ? "selected" : ""}
        aria-current={view === id ? "page" : undefined}
        onClick={() => {
          setView(id);
          if (id === "ordenes") setOrderTable(null);
          setError("");
        }}
      >
        <Icon name={id} />
        <span>{label}</span>
        {id === "nueva" && !!draft.items.length && (
          <span
            className="draft-dot"
            aria-hidden="true"
            title="Borrador pendiente"
          />
        )}
      </button>
    );
  return (
    <div className="shell">
      <header className="app-header">
        <div className="logo">
          <span className="brand-mark small">N</span>
          <div>
            <strong>Nativos1109</strong>
            <small>
              {human(user.role)} · {user.name}
            </small>
          </div>
        </div>
        <div
          className={connected ? "connection online" : "connection"}
          role="status"
        >
          {connected ? "● En línea" : "● Reconectando · espera para operar"}
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api("/auth/logout", "POST", {});
              setUser(null);
              setDraft(emptyDraft());
              attempts.current.clear();
            })
          }
        >
          Salir
        </button>
      </header>
      <nav aria-label="Navegación principal">
        <p className="nav-caption">TU RESTAURANTE</p>
        {tab("salon", "Salón y mesas", can("products.read"))}
        {tab(
          "ordenes",
          can("kitchen.update") && !can("products.write")
            ? "Cocina"
            : "Órdenes",
        )}
        {tab("nueva", "Nueva orden", can("orders.create"))}
        {tab("catalogo", "Productos y mesas", can("products.write"))}
        {tab("caja", "Caja", can("cash.read"))}
        {tab("admin", "Administración", can("users.manage"))}
        {tab("seguridad", "Mi seguridad")}
        <div className="nav-signature">
          <span>N / 1109</span>
          <small>
            Buena mesa.
            <br />
            Gran experiencia.
          </small>
        </div>
      </nav>
      <main className="content" ref={contentRef} tabIndex={-1}>
        {feedback}
        {view === "salon" && (
          <FloorPlan
            tables={catalog.tables}
            statuses={tableStatuses}
            floor={floor}
            setFloor={setFloor}
            canCreate={can("orders.create")}
            busy={busy}
            connected={connected}
            configure={
              can("settings.manage") ? () => setView("catalogo") : undefined
            }
            select={(table) => {
              if (can("orders.create")) {
                void changeTable(table.id, true);
              } else {
                setOrderTable(table.id);
                setView("ordenes");
              }
            }}
          />
        )}
        {view === "ordenes" && orderTable && (
          <div className="table-context">
            <span>
              Órdenes visibles de{" "}
              {catalog.tables.find((t) => t.id === orderTable)?.name}
            </span>
            <button className="secondary" onClick={() => setOrderTable(null)}>
              Ver todas las órdenes
            </button>
          </div>
        )}
        {view === "ordenes" && (
          <Orders
            orders={
              orderTable
                ? orders.filter((o) => o.table_id === orderTable)
                : orders
            }
            can={can}
            busy={busy}
            connected={connected}
            run={run}
            mutate={mutate}
            reload={reload}
            cashOpen={cash.some((s) => !s.closed_at)}
          />
        )}
        {view === "nueva" && (
          <NewOrder
            catalog={catalog}
            draft={draft}
            setDraft={setDraft}
            statuses={tableStatuses}
            discard={discard}
            changeTable={changeTable}
            status={tableStatuses.find((s) => s.tableId === draft.tableId)}
            back={() => setView("salon")}
            viewOrders={() => {
              setOrderTable(draft.tableId);
              setView("ordenes");
            }}
            busy={busy}
            connected={connected}
            run={run}
            mutate={mutate}
            done={async () => {
              setView("ordenes");
              setOrderTable(null);
              await reload();
            }}
          />
        )}
        {view === "catalogo" && (
          <CatalogView
            catalog={catalog}
            busy={busy || !connected}
            run={run}
            mutate={mutate}
            reload={reload}
          />
        )}
        {view === "caja" && (
          <CashView
            cash={cash}
            busy={busy || !connected}
            run={run}
            mutate={mutate}
            reload={reload}
          />
        )}
        {view === "admin" && (
          <AdminView busy={busy || !connected} run={run} reload={reload} />
        )}
        {view === "seguridad" && (
          <section className="panel narrow">
            <h1>Mi seguridad</h1>
            <p>MFA: {user.mfa_enabled ? "Activo" : "Sin activar"}</p>
            <p>
              Las sesiones expiran a las 12 horas. Cierra todas tus sesiones si
              pierdes un dispositivo.
            </p>
            <button
              className="danger"
              onClick={() =>
                void run(async () => {
                  await api("/auth/logout-all", "POST", {});
                  setUser(null);
                  setDraft(emptyDraft());
                })
              }
            >
              Cerrar todas mis sesiones
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <MotionConfig reducedMotion="user">
    <App />
  </MotionConfig>,
);
