import http from "k6/http";
import { check, sleep } from "k6";
import crypto from "k6/crypto";
export const options = {
  vus: 5,
  duration: "20s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
    checks: ["rate==1"],
  },
};
const base = __ENV.BASE_URL || "http://host.docker.internal:3001";
function uuid() {
  const b = new Uint8Array(crypto.randomBytes(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20),
  ].join("-");
}
function params(cookies, key) {
  return {
    cookies,
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      "X-CSRF-Protection": "1",
      "Idempotency-Key": key || uuid(),
    },
  };
}
function send(path, data, cookies, key, method = "POST") {
  return http.request(
    method,
    base + "/api" + path,
    JSON.stringify(data),
    params(cookies, key),
  );
}
function login(role) {
  const r = send("/auth/login", {
    email: role + "@example.test",
    password: "Integration-test-password-2026",
  });
  if (r.status !== 200) throw new Error("Fixture login failed");
  return {
    access: r.cookies.access[0].value,
    refresh: r.cookies.refresh[0].value,
  };
}
export function setup() {
  const waiter = login("mesero"),
    kitchen = login("cocina"),
    cashier = login("cajero");
  const catalog = http.get(base + "/api/catalog", params(waiter)).json();
  if (send("/cash/open", { openingCents: 0 }, cashier).status !== 201)
    throw new Error("Cash fixture failed");
  return {
    waiter,
    kitchen,
    cashier,
    productId: catalog.products[0].id,
    tableId: catalog.tables[0].id,
  };
}
export default function (data) {
  const menu = http.get(base + "/api/catalog", params(data.waiter));
  check(menu, { "menu available": (r) => r.status === 200 });
  const key = uuid(),
    body = {
      tableId: data.tableId,
      items: [{ productId: data.productId, quantity: 1 }],
    };
  const order = send("/orders", body, data.waiter, key);
  check(order, { "order created": (r) => r.status === 201 });
  if (order.status !== 201) return;
  const id = order.json("id");
  const replay = send("/orders", body, data.waiter, key);
  check(replay, { "same order on retry": (r) => r.json("id") === id });
  const preparing = send(
    "/orders/" + id + "/status",
    { status: "EN_PREPARACION", version: 1 },
    data.kitchen,
    uuid(),
    "PATCH",
  );
  check(preparing, { "kitchen preparing": (r) => r.status === 200 });
  const ready = send(
    "/orders/" + id + "/status",
    { status: "LISTO", version: 2 },
    data.kitchen,
    uuid(),
    "PATCH",
  );
  check(ready, { "kitchen ready": (r) => r.status === 200 });
  const payKey = uuid(),
    payment = { orderId: id, method: "EFECTIVO", tenderedCents: 1000 };
  const paid = send("/payments", payment, data.cashier, payKey);
  check(paid, { "payment recorded": (r) => r.status === 201 });
  const payReplay = send("/payments", payment, data.cashier, payKey);
  check(payReplay, {
    "same payment on retry": (r) => r.json("id") === paid.json("id"),
  });
  sleep(0.2);
}
