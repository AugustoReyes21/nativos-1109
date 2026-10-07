# Matriz QA — Nativos1109

Última ejecución: 2026-10-07, PostgreSQL 17 real, código de `codex/feature/secure-pos-foundation` (árbol sin commitear) + `migrations/002_integrity_guards.sql` + arreglo F01 aplicado en copia. Hallazgos `Fxx` en `docs/reviews/2026-10-07-foundation-review.md`.

Fuentes de prueba: **C** = `tests/integration.test.ts` / `tests/unit.test.ts` (Codex) · **A** = `tests/security/api-adversarial.test.ts` · **D** = `tests/db/integrity.test.ts` · **E2E** = Playwright (aún no existe).

Resultado: ✅ pasa · ❌ falla (hallazgo) · ⏳ sin prueba todavía · ⚠️ prueba existe pero no valida lo que dice.

## AUTH

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Credenciales inválidas → 401 genérico con requestId | C *rejects missing CSRF...* | ✅ |
| Usuario inactivo no inicia sesión | C *logs out securely, blocks disabled users* | ✅ |
| Contraseñas con Argon2id | C *hashes with Argon2id* | ✅ |
| JWT expirado rechazado | C *handles expired JWT* | ✅ |
| JWT forjado, `alg:none` o de otro usuario rechazado | A *rejects forged, unsigned and cross-user access tokens* | ✅ |
| Logout invalida el access token de inmediato | A *logout invalidates the access token immediately* | ✅ |
| Rotación de refresh y revocación por reuso tardío | C *rotates refresh tokens*; A *stolen refresh token replayed later* | ✅ |
| Reintento de refresh tras microcorte no desconecta | A *refresh retried after a lost response* | ❌ F03 |
| Cookies HttpOnly + SameSite=Strict (+ Secure/`__Host-` en prod) | C *requires admin MFA...* (dev); prod ⏳ | ✅ / ⏳ |
| CSRF: sin cabecera/origen ajeno → 403 | C *rejects missing CSRF protection, cross-origin* | ✅ |
| Restaurante tras NAT puede iniciar turno (25 logins) | A *a whole restaurant behind one NAT IP* | ❌ F04 |
| Un tercero no puede bloquear la cuenta de un empleado | ⏳ (requiere IPs distintas; ver F04) | ⏳ |
| Recuperación: respuesta genérica, token de un uso, revoca sesiones | C *consumes recovery codes once and returns generic password reset* | ✅ |
| Recuperación sin diferencia de tiempo por existencia de cuenta | ⏳ | ❌ F11 (por lectura) |

## MFA

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Admin sin MFA no obtiene sesión usable (ningún endpoint) | C *requires admin MFA*; A *administrator with only the password* | ✅ |
| Secreto cifrado en BD, mostrado una sola vez | C *requires admin MFA...* | ✅ |
| TOTP no reutilizable | A *a TOTP code cannot be replayed* | ✅ |
| Fuerza bruta sobre un desafío real cortada (y el código correcto también) | A *MFA brute force against a real challenge* | ✅ |
| Fuerza bruta (prueba de Codex) | C *limits MFA brute force* | ⚠️ F12 (sin desafío real) |
| Códigos de recuperación de un solo uso | C *consumes recovery codes once* | ✅ |
| Admin no puede desactivar MFA | ⏳ | ⏳ |
| Recuperación de admin sin autenticador | runbook | ⏳ (no existe) |

## ADMIN

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Crear categorías/mesas/productos; rechazar campos extra | C *enforces server permissions and rejects mass assignment* | ✅ |
| Edición de stock con versión obsoleta → 409 | C *rejects stale administrative stock edits* | ✅ |
| No puede cambiar su propio rol | ⏳ | ⏳ |
| No puede quedar el sistema sin administradores | ⏳ | ❌ F17 (por lectura) |

## MESERO

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Sin acceso a usuarios, productos, pagos, caja, auditoría, reportes, ajustes | A *authorization* (9 casos) | ✅ |
| No ve ni entrega órdenes de otro mesero | A *IDOR* | ✅ |
| No puede cancelar | A *kitchen cannot cancel or deliver; waiter cannot cancel* | ✅ |

## COCINA

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Máquina de estados PENDIENTE→EN_PREPARACION→LISTO | C *validates the kitchen state machine* | ✅ |
| No crea órdenes, no cobra, no ve usuarios | A *authorization* (3 casos) | ✅ |
| No cancela ni entrega | A *kitchen cannot cancel or deliver* | ✅ |
| Ve toda orden nueva aunque haya >200 en 24 h | A *a new order is visible to the kitchen even on a busy day* | ❌ F02 |
| Varias pantallas de cocina reciben la misma orden | ⏳ E2E | ⏳ |

## CAJERO

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| No crea administradores ni cambia roles/precios/auditoría | A *authorization* (5 casos) | ✅ |
| Cobro solo con caja abierta propia | C *closes cash... prevents payments after close* | ✅ |

## INVENTARIO

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Stock nunca negativo | D *rejects negative stock* | ✅ |
| Dos meseros por el último producto: solo uno vende (API) | C *lets exactly one concurrent order consume the last unit* | ✅ |
| Ídem a nivel BD (decremento condicional concurrente) | D *two waiters taking the last unit* | ✅ |
| Cancelar orden PENDIENTE devuelve stock; preparada no | ⏳ | ⏳ |

## ORDEN

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Total y precio calculados en servidor; campos de dinero del cliente → 400 | A *ignores no client-provided money* | ✅ |
| Total ≠ suma de ítems imposible en BD | D *order totals* (2) | ✅ con 002 / ❌ sin 002 (F05) |
| Cantidades límite y malformadas → 400 | A *rejects boundary and malformed quantities* (7 valores) | ✅ |
| Unicode/emoji aceptados; NUL → 4xx, nunca 500 | A *accepts Unicode and emoji...* | ❌ F08 |
| Doble envío con misma clave → una sola orden | C *replays concurrent duplicate orders once* | ✅ |
| Orden cancelada es final; pagada+entregada no se reabre; timestamps inmutables | D *order lifecycle* (4) | ✅ con 002 / ❌ sin 002 |
| Agregar ítems a una orden abierta | — | ⏳ requisito sin confirmar |

## PAGO

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Dos cobros concurrentes distintos → uno solo | C *prevents double payment*; D *two concurrent charges* | ✅ |
| Reintento idéntico devuelve el mismo pago | C *prevents double payment... replays identical attempts* | ✅ |
| Pago insuficiente / tarjeta con importe distinto → 400 | A *cannot cancel after charging...* | ✅ |
| No cancelar tras cobrar; no cobrar cancelada | A *cannot cancel after charging...* | ✅ |
| Importe = total, caja abierta, inmutable (BD) | D *payments* (4) | ✅ con 002 / ❌ sin 002 |
| Ítems no cambian tras el cobro, incluso en carrera | D *item changes racing a payment* | ✅ con 002 / ❌ sin 002 |

## CAJA

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Solo una caja abierta | D *rejects a second open shift* | ✅ |
| Cierre con esperado y diferencia exactos | C *closes cash with exact expected balance* | ❌ F01 (✅ con arreglo) |
| Cerrar dos veces: segunda rechazada, conteo intacto | A *closing the register twice* | ❌ F01 (✅ con arreglo) |
| Caja cerrada inmutable; sin movimientos en caja cerrada | D *cash register* (2) | ✅ con 002 / ❌ sin 002 |

## TIEMPO REAL (SSE — no se usa WebSocket)

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Cliente no autenticado no se conecta | ⏳ | ⏳ (por lectura: `requireUser` + reautenticación cada 2 s) |
| Sesión revocada cierra el stream | ⏳ | ⏳ |
| Reconexión tras expiración del JWT (≤5 min) y tras suspensión de tablet | ⏳ E2E | ⏳ F16 |
| Sin datos de negocio en el canal | revisión manual | ✅ (solo `id` de revisión) |

## RESPONSIVE

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Tablet 768–1024 px, móvil 360 px, escritorio | ⏳ Playwright con viewports | ⏳ (UI en construcción) |
| Estado visual offline y deshabilitar acciones sin conexión | ⏳ | ⏳ (UI muestra `connected`) |

## SECURITY

| Requisito | Prueba | Resultado |
| --- | --- | --- |
| Cabeceras CSP/nosniff/frame-ancestors | C *returns security headers* | ✅ |
| Bitácora sin contraseñas ni tokens | C *returns security headers and never includes password/token* | ✅ |
| Bitácora append-only | D *audit log is append-only* | ✅ con 002 / ❌ sin 002 |
| 500 registran causa sin secretos | ⏳ | ❌ F06 (por lectura) |
| `npm audit --omit=dev` sin HIGH/CRITICAL | manual | ✅ (0) |
| Escaneo de secretos | `npm run scan:secrets` | ❌ F15 (script inexistente) |
| Lint y typecheck limpios | `npm run lint`, `npm run typecheck` | ❌ F18 (trabajo en curso) |
| `trust proxy` correcto en Render | manual en Render | ⏳ T-NET-3 |
