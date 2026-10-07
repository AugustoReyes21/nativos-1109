# Revisión independiente — base `codex/feature/secure-pos-foundation`

- Fecha: 2026-10-07 · Revisor: Claude (segunda línea: arquitectura, seguridad, QA)
- Objeto: árbol de trabajo de Codex **sin commitear** (instantánea 08:44–08:52), aún sin PR. Los hallazgos se revalidarán sobre el PR.
- Método: lectura completa de `server/`, `migrations/001_initial.sql`, `tests/`, parte de `web/`; ejecución contra PostgreSQL 17 real (contenedor propio en `127.0.0.1:55433`, sin tocar la BD de Codex).

## Resumen

| Severidad | Abiertos | IDs |
| --- | --- | --- |
| BLOCKER | 1 | F01 |
| MAJOR | 6 | F02, F03, F04, F05, F06, F07 |
| MINOR | 10 | F08–F17 |
| NIT | 2 | F18, F19 |

Verificado y correcto (con pruebas pasando, ver final): MFA obligatorio para administrador, no reutilización de TOTP, corte de fuerza bruta MFA sobre un desafío real, rechazo de JWT forjado/`alg:none`/cruzado entre usuarios, revocación inmediata en logout, RBAC directo por API (17 combinaciones rol→endpoint), IDOR entre meseros, rechazo de *mass assignment* y de totales/precios enviados por el cliente, último producto con dos meseros concurrentes, doble cobro concurrente, cancelar tras cobrar, cobrar tras cancelar, pago insuficiente.

## BLOCKER

### F01 — El cierre de caja siempre falla con 500
- Módulo/archivo: Caja · `server/pos.ts:155`
- Evidencia: `UPDATE cash_shifts SET ... counted_cents=$1, ..., difference_cents=$1::bigint-$2::bigint` → PostgreSQL `42P08 inconsistent types deduced for parameter $1` (reproducido aislado y por la propia prueba de Codex `closes cash with exact expected balance...` → 500).
- Impacto: no se puede cerrar caja; el turno queda abierto y bloquea abrir otro (`one_open_register`).
- Corrección (verificada en una copia): `difference_cents=$1::integer-$2::bigint`. Con ella pasan la prueba de Codex y `closing the register twice ...`.

## MAJOR

### F02 — Cocina y caja dejan de ver órdenes nuevas a partir de 200 órdenes en 24 h
- Archivo: `server/pos.ts:76-81` (`ORDER BY o.created_at LIMIT 200`, ascendente).
- Reproducción: `tests/security/api-adversarial.test.ts › a new order is visible to the kitchen even on a busy day` — 210 órdenes entregadas en las últimas horas + 1 nueva → la respuesta trae las 200 **más antiguas**; la nueva no aparece en el KDS.
- Esperado: toda orden activa (`PENDIENTE`, `EN_PREPARACION`, `LISTO`) siempre visible; el historial reciente, paginado y en orden descendente.
- Corrección: dos consultas (activas sin límite práctico, ordenadas asc.; finalizadas recientes `ORDER BY created_at DESC LIMIT n`) o paginación por cursor.

### F03 — Un reintento de `/api/auth/refresh` tras un microcorte desconecta al empleado
- Archivo: `server/auth.ts:148-169`.
- Reproducción: `› a refresh retried after a lost response (Wi-Fi micro-cut) does not log the employee out` → el segundo uso del mismo token devuelve 401 y revoca la sesión completa.
- Contexto: `web/api.ts` ya serializa el refresh entre pestañas con `navigator.locks` (mitiga el caso de dos pestañas), pero si la respuesta se pierde el navegador nunca recibe la cookie nueva y el siguiente intento reusa la vieja. En tablets que cambian de punto de acceso es probable en cada servicio.
- Esperado: reintento benigno dentro de una ventana corta (p. ej. 30 s) emite un nuevo par sin revocar; un reuso fuera de la ventana sigue revocando (`› a stolen refresh token replayed later still revokes the whole session`, ya pasa y debe seguir pasando).
- Riesgo residual de la ventana: un ladrón que reusa el token dentro de 30 s obtiene sesión; mitigado por cookie HttpOnly + SameSite=Strict y revocación por logout/admin.

### F04 — Límites de login que dejan fuera al restaurante y permiten bloquear cuentas ajenas
- Archivo: `server/auth.ts:83-85`.
- Reproducción: `› a whole restaurant behind one NAT IP can still log in at shift change (25 logins)` → los logins 21–25 con credenciales correctas reciben 429 durante 15 min. Todas las tablets comparten la IP pública del restaurante.
- Además (por lectura, mismo mecanismo): `login-account` cuenta cada intento **antes** de verificar la contraseña y se indexa solo por email → 10 intentos de un tercero bloquean al cajero o al administrador 15 min (DoS dirigido en hora punta).
- Corrección: contar solo fallos; límite por cuenta indexado por `(email, ip)` más un umbral global por cuenta mayor con retardo progresivo; no contar logins exitosos en el límite por IP; alertar en audit al superar umbrales.

### F05 — La base de datos no actúa como segunda capa para invariantes financieras
- Archivo: `migrations/001_initial.sql`.
- Reproducción: `tests/db/integrity.test.ts` contra 001 → **15 de 19 fallan** porque PostgreSQL acepta: total de orden ≠ suma de ítems; pago con importe ≠ total; cobrar orden cancelada; pago en caja cerrada; modificar/borrar pagos; cancelar orden pagada; editar ítems de orden pagada (incluida la carrera ítem-vs-cobro); reabrir orden pagada y entregada; reactivar orden cancelada; reescribir `created_at`; recerrar/reabrir caja; movimientos en caja cerrada; modificar/borrar/truncar `audit_log`.
- Propuesta: `migrations/002_integrity_guards.sql` (rama `claude/audit/foundation-review`). Con ella: 19/19 pasan (5 ejecuciones estables) y la suite adversarial de API no muestra regresiones en los flujos de Codex.
- Compatibilidad: `tests/helpers`/`integration.test.ts` hace `TRUNCATE users ... CASCADE`, que arrastra `audit_log` y queda bloqueado por la guarda (es el comportamiento deseado). Cambiar la preparación a una BD nueva por ejecución (como `tests/db/integrity.test.ts`).
- Límite honesto: un rol propietario/superusuario puede deshabilitar triggers. En Render la app usa el usuario propietario; ver THREAT_MODEL (T-DB-2).

### F06 — Los 500 no dejan rastro diagnosticable
- Archivo: `server/app.ts:97` — solo registra `{requestId, code:'INTERNAL_ERROR'}`.
- Impacto: imposible analizar 500/502/503 en Render sin reproducir.
- Corrección: registrar `err.name`, `err.message`, `code`/`constraint`/`routine` de pg y `stack`, nunca cuerpo ni parámetros; añadir `process.on('unhandledRejection'|'uncaughtException')` con log antes de salir.

### F07 — La bitácora no permite reconstruir “¿por qué desapareció la orden 123?”
- Archivos: `server/common.ts:15-18`, `migrations/001_initial.sql:102-107`.
- Evidencia: `audit_log` guarda acción y id, pero no estado anterior/nuevo, importes ni motivo; además era modificable (cubierto por F05).
- Corrección: columna `details jsonb` (p. ej. `{from:'LISTO', to:'CANCELADO', reason}`; montos en pagos/caja), índice `(resource, resource_id)`, endpoint de consulta por recurso.

## MINOR

| ID | Archivo | Hallazgo y evidencia | Corrección |
| --- | --- | --- | --- |
| F08 | `server/pos.ts` (todos los `z.string()`) | `notes: "a\u0000b"` → PostgreSQL `22021` → **500** (prueba `› accepts Unicode and emoji but rejects text PostgreSQL cannot store`). Cualquier usuario genera 500 a voluntad | Rechazar `\u0000` en el esquema común de texto o mapear `22021`/`22P05` a 400 |
| F09 | `server/app.ts:93` | `23514` (check) se mapea a 400 `INVALID_REFERENCE`; con 002 son conflictos de estado | Mapear `23514` a 409 `INVALID_STATE` |
| F10 | `server/security.ts:8` | Argon2id m=64 MiB. Medido: 1 hash → 144 MiB RSS; 20 concurrentes → pico 320 MiB (threadpool 4) y 843 ms de cola; con `UV_THREADPOOL_SIZE=20` → 1 345 MiB. Un flood de logins satura el threadpool que también usa `express.static` | Semáforo de 2 hashes concurrentes; instancia ≥1 GB o perfil OWASP m=19 MiB t=2 |
| F11 | `server/auth.ts:182-188` | `forgot-password` espera al SMTP solo si la cuenta existe → enumeración por tiempo | Responder primero y enviar en segundo plano |
| F12 | `tests/integration.test.ts` (*limits MFA brute force*) | Prueba engañosa: el agente no tiene cookie de desafío; todos los intentos fallan igual y el 429 viene de un bucket compartido `digest('')` | Reemplazada por `› MFA brute force against a real challenge is cut off` |
| F13 | `server/app.ts:54` | Readiness solo comprueba `001_initial.sql` | Comprobar la última migración presente en disco |
| F14 | esquema | Sin retención: `rate_limits` (claves por email arbitrario, crecimiento inducible por atacante), `events`, `idempotency`, `refresh_tokens`, `auth_challenges`, `password_resets` | Tarea periódica de purga por `expires_at`/antigüedad |
| F15 | `package.json` | `scan:secrets` apunta a `scripts/scan-secrets.mjs`, que no existe | Crear el script o usar gitleaks en CI |
| F16 | `server/app.ts:62-80` | El SSE se autentica con la cookie del momento de conexión; se cierra al expirar el JWT (≤5 min). `EventSource` no se recupera de un 401 por sí solo | Verificar que la UI hace refresh y recrea el stream; prueba E2E de 10 min |
| F17 | `server/pos.ts:190-199` | Dos administradores pueden desactivarse mutuamente → ningún administrador activo | Rechazar si deja 0 administradores activos con MFA |

## NIT

- F18 — `server/common.ts:10` incumple `@typescript-eslint/no-namespace` (`npm run lint` falla) y `tests/integration.test.ts:18,20` no compila (`tsc --noEmit`, TS2345). Esperable en trabajo en curso; CI debe bloquearlo.
- F19 — `UNIQUE(order_id, product_id)` y el refinamiento “Productos repetidos” impiden dos hamburguesas con notas distintas en la misma orden. Decidir con negocio.

## Pendientes de requisito / verificación en entorno real

- No existe endpoint para **agregar ítems a una orden abierta** (otra ronda en la misma mesa). Confirmar con negocio; si se requiere, es MAJOR funcional.
- `trust proxy = 1` (`server/app.ts:18`): verificar en Render el número de saltos. Si es incorrecto, todos los clientes comparten un solo bucket de rate limit. Procedimiento en `docs/THREAT_MODEL.md` (T-NET-3).
- Dependencias: `shell-quote` CRITICAL (vía `concurrently`, solo dev, no explotable con los scripts actuales) — **resuelto** por Codex al reemplazar `concurrently` por `scripts/dev.mjs`. `npm audit --omit=dev`: 0 vulnerabilidades.
- Secretos: árbol e historial (1 commit) sin coincidencias; `.env` no existe en el árbol y está en `.gitignore`.

## Pruebas ejecutadas (PostgreSQL 17 real)

| Suite | Contra | Resultado |
| --- | --- | --- |
| `tests/db/integrity.test.ts` | 001 de Codex | 4 pasan / 15 fallan (F05) |
| `tests/db/integrity.test.ts` | 001 + 002 | 19/19 (×5 ejecuciones) |
| `tests/security/api-adversarial.test.ts` | código de Codex + 002 + arreglo F01 | 29 pasan / 4 fallan (F02, F03, F04, F08) |
| `tests/unit.test.ts` + `tests/integration.test.ts` de Codex | código de Codex | 18/19 (falla F01) |
| `tests/integration.test.ts` de Codex | + 002 | no arranca: `TRUNCATE` bloqueado por la guarda de auditoría (ver F05) |
