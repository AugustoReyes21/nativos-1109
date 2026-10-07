import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError } from "./api";
import { Auth } from "./Auth";
import { NewOrder } from "./NewOrder";
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

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const attempts = useRef(new Map<string, string>());
  const [connected, setConnected] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>({
    products: [],
    categories: [],
    tables: [],
  });
  const [orders, setOrders] = useState<Order[]>([]);
  const [cash, setCash] = useState<Shift[]>([]);
  const [view, setView] = useState("ordenes");
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
    const signature = method + ":" + path + ":" + JSON.stringify(data);
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
    const tasks: Promise<void>[] = [api<Order[]>("/orders").then(setOrders)];
    if (u.permissions.includes("products.read"))
      tasks.push(api<Catalog>("/catalog").then(setCatalog));
    if (u.permissions.includes("cash.read"))
      tasks.push(api<Shift[]>("/cash").then(setCash));
    await Promise.all(tasks);
  }, []);
  const enter = async () => {
    const me = await api<User>("/auth/me");
    setUser(me);
    setView("ordenes");
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
  const tab = (id: string, label: string, visible = true) =>
    visible && (
      <button
        className={view === id ? "selected" : ""}
        onClick={() => {
          setView(id);
          setError("");
        }}
      >
        {label}
      </button>
    );
  return (
    <div className="shell">
      <header>
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
              attempts.current.clear();
            })
          }
        >
          Salir
        </button>
      </header>
      <nav aria-label="Navegación principal">
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
      </nav>
      <main className="content">
        {feedback}
        {view === "ordenes" && (
          <Orders
            orders={orders}
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
            busy={busy}
            connected={connected}
            run={run}
            mutate={mutate}
            done={async () => {
              setView("ordenes");
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
createRoot(document.getElementById("root")!).render(<App />);
