export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
async function raw(path: string, method = "GET", data?: unknown, key?: string) {
  return fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(method !== "GET"
        ? { "Content-Type": "application/json", "X-CSRF-Protection": "1" }
        : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
}
let renewing: Promise<boolean> | null = null;
async function renew() {
  const run = async () => {
    if ((await raw("/auth/me")).ok) return true;
    return (await raw("/auth/refresh", "POST", {})).ok;
  };
  renewing ??= (
    navigator.locks
      ? navigator.locks.request("nativos-session-refresh", run)
      : run()
  ).finally(() => {
    renewing = null;
  });
  return renewing;
}
export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
  key?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await raw(path, method, data, key);
    if (
      response.status === 401 &&
      (!path.startsWith("/auth/") || path === "/auth/me") &&
      (await renew())
    )
      response = await raw(path, method, data, key);
  } catch {
    throw new ApiError(
      "No se pudo confirmar la operación. Conserva esta pantalla y reintenta al recuperar conexión.",
      "NETWORK_ERROR",
    );
  }
  const json = (await response.json()) as T & {
    error?: { message: string; code: string; requestId: string };
  };
  if (!response.ok)
    throw new ApiError(
      json.error?.message ?? "Error del servidor",
      json.error?.code ?? "UNKNOWN",
      json.error?.requestId,
    );
  return json;
}
export const money = (cents: number | string) =>
  new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ" }).format(
    Number(cents) / 100,
  );
export function toCents(value: FormDataEntryValue | null): number {
  const text = String(value ?? "");
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw new Error("Introduce un importe válido con hasta dos decimales");
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
