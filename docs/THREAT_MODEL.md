# Modelo de amenazas — Nativos1109

Versión 0.2 · 2026-10-07 (ronda 2, PR #2 `ca12e07`) · Responsable: Claude. Basado en el código real de `codex/feature/secure-pos-foundation` (sin PR aún), no en la documentación prevista. Se actualiza en cada PR que cambie límites de confianza, autenticación o dinero.

Estado de cada control: **Verificado** (prueba automatizada pasando), **Implementado** (en código, sin prueba propia), **Propuesto**, **Brecha**.

## 1. Sistema observado

- Monolito Node 24 + Express 5 (`server/`), UI React/Vite servida por el mismo origen (`web/` → `dist/web`).
- PostgreSQL con SQL parametrizado (`pg`), migraciones SQL versionadas con checksum (`server/migrate.ts`).
- Sesión: tabla `sessions` + JWT HS256 de 5 min en cookie `__Host-access` y refresh rotatorio de 12 h en `__Host-refresh` (HttpOnly, Secure, SameSite=Strict). Cada petición revalida sesión, usuario activo y MFA en BD.
- Tiempo real: **SSE** (`GET /api/events`), sin WebSocket ni Socket.IO. El stream solo emite “sync” con el número de revisión; el cliente vuelve a pedir el estado autorizado por API.
- Despliegue previsto: Render (TLS terminado en su proxy), correo SMTP para recuperación.

## 2. Activos

| Activo | Por qué importa | Dónde vive |
| --- | --- | --- |
| Credenciales y hashes Argon2id | Toma de cuentas | `users.password_hash` |
| Secretos TOTP | Saltar MFA del administrador | `users.mfa_secret` (AES-256-GCM, `MFA_KEY`) |
| Códigos de recuperación | Equivalen a un segundo factor | `recovery_codes` (SHA-256 de 256 bits aleatorios) |
| Sesiones y refresh tokens | Suplantación | `sessions`, `refresh_tokens` (solo hash), cookies |
| `JWT_SECRET`, `MFA_KEY`, `DATABASE_URL`, SMTP | Compromiso total | Variables de entorno de Render |
| Caja (turnos, movimientos, conteo) | Fraude / descuadre | `cash_shifts`, `cash_movements` |
| Ventas y pagos | Ingresos, fiscalidad interna | `payments`, `orders`, `order_items` |
| Precios, productos, stock | Venta por debajo de precio, sobreventa | `products` |
| Órdenes en curso | Operación de cocina | `orders` + SSE |
| Roles y permisos | Escalada de privilegios | `roles`, `role_permissions`, `users.role` |
| Bitácora de auditoría | Investigación y no repudio | `audit_log` |
| Logs de aplicación | Diagnóstico; pueden filtrar secretos | stdout → Render |
| Disponibilidad del servicio | Un POS caído detiene el restaurante | Render + PostgreSQL |

## 3. Actores

| Actor | Capacidades legítimas | Motivación adversaria |
| --- | --- | --- |
| Administrador | Todo, con MFA obligatorio | Cuenta comprometida = compromiso total |
| Cajero | Cobrar, abrir/cerrar caja, movimientos, cancelar no cobradas | Desviar efectivo, anular ventas cobradas, cerrar con descuadre oculto |
| Mesero | Crear órdenes propias, marcarlas entregadas | Ver/alterar órdenes ajenas, abaratar precios, cobrarse |
| Cocina | Cambiar estado de preparación | Cancelar u ocultar órdenes |
| Interno malicioso | Credenciales propias, acceso físico a tablets | Escalada horizontal/vertical, borrar rastro |
| Cuenta comprometida | Sesión robada de cualquier rol | Persistir tras logout, rotar a admin |
| Externo | Internet, sin credenciales | Fuerza bruta, enumeración, DoS, XSS/CSRF |
| Vecino de red | Misma Wi-Fi del restaurante | Sniffing (mitigado por TLS), ARP spoofing, portal cautivo |

## 4. Límites de confianza

```
[Tablet/navegador] --TLS--> [Proxy Render] --HTTP--> [Express] --TLS?--> [PostgreSQL]
       ^  Wi-Fi local / NAT                               |
       |                                                  +--SMTP/TLS--> [Proveedor correo]
       +---------- SSE (mismo origen, cookie) ------------+
```

| ID | Límite | Qué cruza | Supuesto que debe verificarse |
| --- | --- | --- | --- |
| B1 | Navegador → API | JSON, cookies, cabeceras | Nada del cliente es confiable: totales, precios, ids, roles, timestamps |
| B2 | Proxy Render → Express | `X-Forwarded-For/Proto` | Número de saltos = `trust proxy` (T-NET-3) |
| B3 | Express → PostgreSQL | SQL parametrizado | BD como segunda capa (constraints/triggers); credencial de app con mínimo privilegio |
| B4 | Express → SMTP | Token de recuperación | Solo el enlace; nunca en logs |
| B5 | SSE | Revisión numérica | Sin datos de negocio; autorización por API en cada recarga |
| B6 | Red local / NAT | Todas las tablets comparten IP pública | Los límites por IP afectan a todo el restaurante |
| B7 | Dispositivo físico | Tablets compartidas | Sesión de otro empleado abierta; robo de tablet |

## 5. Amenazas (STRIDE) y controles

### Autenticación y sesión

| ID | STRIDE | Amenaza | Control actual | Estado |
| --- | --- | --- | --- | --- |
| T-AUTH-1 | S | Fuerza bruta de contraseña | Argon2id + límite por IP y por cuenta | NAT y bloqueo dirigido resueltos (F04). **Brecha** R2-01: sin tope por cuenta entre IPs y tope por IP evaluado tras Argon2 (reproducido) |
| T-AUTH-2 | I | Enumeración de usuarios en login | Hash ficticio para emails inexistentes, mensaje único | Implementado |
| T-AUTH-3 | I | Enumeración por recuperación | Respuesta idéntica | **Brecha** F11 (tiempo SMTP) |
| T-AUTH-4 | S | JWT fabricado / `alg:none` / de otro usuario | HS256 fijo, iss/aud/exp, sesión + sub en BD | **Verificado** |
| T-AUTH-5 | S | JWT expirado | `jose` valida `exp` | **Verificado** (prueba de Codex) |
| T-AUTH-6 | S | Reutilizar refresh robado | Rotación + detección de reuso → revoca sesión | **Verificado**, incluido reintento con misma clave y revocación con otra clave/sin clave (003) |
| T-AUTH-7 | E | Sesión tras logout / desactivación / cambio de rol | Revocación en BD revisada en cada petición y en cada tick SSE | **Verificado** (logout), Implementado (rol) |
| T-AUTH-8 | S | Fijación de sesión | Sesión y cookies nuevas tras login/MFA | Implementado |
| T-AUTH-9 | I | Robo de token por XSS | Cookies HttpOnly; CSP `script-src 'self'` | Implementado; revisar UI completa |
| T-AUTH-10 | T | CSRF | SameSite=Strict + `Origin` exacto + cabecera `X-CSRF-Protection` en métodos no-GET | **Verificado** (prueba de Codex) |
| T-AUTH-11 | S | Toma de cuenta por recuperación | Token 256 bits, 15 min, un uso, revoca sesiones; MFA sigue exigido | Implementado |

### MFA

| ID | STRIDE | Amenaza | Control actual | Estado |
| --- | --- | --- | --- | --- |
| T-MFA-1 | E | Saltar MFA llamando endpoints posteriores | `authenticate()` exige `mfa_enabled` para ADMINISTRADOR; el login solo da cookie de desafío | **Verificado** |
| T-MFA-2 | S | Fuerza bruta TOTP | 5 intentos por desafío / 15 por IP en 5 min; desafío 5 min | **Verificado**. Residual: ~4 800 intentos/día por cuenta si se conoce la contraseña (≈1,4 %/día). Propuesto: bloqueo y alerta por fallos MFA acumulados por usuario |
| T-MFA-3 | S | Replay de TOTP | `mfa_last_step` monotónico | **Verificado** |
| T-MFA-4 | I | Robo del secreto | AES-256-GCM, secreto mostrado una vez por desafío | Implementado; sin AAD ligado al usuario (intercambio de cifrados requiere escritura en BD) |
| T-MFA-5 | S | Primer enrolamiento por un atacante con la contraseña inicial (TOFU) | Bootstrap de un solo uso | Riesgo aceptado: enrolar MFA inmediatamente tras bootstrap y borrar `BOOTSTRAP_*` |
| T-MFA-6 | D | Admin pierde autenticador y códigos | Ninguno en app | **Brecha**: runbook de recuperación con segundo admin o acceso a BD auditado |
| T-MFA-7 | E | Desactivar MFA del admin | Prohibido para ADMINISTRADOR; requiere contraseña + factor | Implementado |

### Autorización y lógica de negocio

| ID | STRIDE | Amenaza | Control actual | Estado |
| --- | --- | --- | --- | --- |
| T-AZ-1 | E | Mesero/cajero/cocina a endpoints administrativos | `permit()` por permiso en servidor | **Verificado** (17 casos) |
| T-AZ-2 | E | IDOR entre meseros | Filtro por `user_id` en lista y `ownedOrder` | **Verificado** |
| T-AZ-3 | E | Mass assignment (`role`, `total`, `status`) | Zod `.strict()` | **Verificado** |
| T-AZ-4 | E | Dejar el sistema sin administradores | Advisory lock + comprobación | **Verificado** (carrera entre dos admins) |
| T-BIZ-1 | T | Total/precio desde el cliente | Precio y total calculados en servidor | **Verificado**; BD **Propuesto** (002) |
| T-BIZ-2 | T | Sobreventa del último producto | `FOR UPDATE` ordenado + `CHECK stock>=0` | **Verificado** (API y BD) |
| T-BIZ-3 | T | Doble cobro | Bloqueo de orden + `UNIQUE(order_id)` + idempotencia | **Verificado** |
| T-BIZ-4 | T | Cancelar tras cobrar / cobrar cancelada / reabrir | Comprobación en API | **Verificado** (API); BD **Propuesto** (002) |
| T-BIZ-5 | R | Alterar o borrar pagos, cierres, bitácora | Triggers 002/003 | **Verificado** (19 pruebas BD) |
| T-BIZ-6 | T | Alterar timestamps | `now()` del servidor | Implementado; BD **Propuesto** (002) |
| T-BIZ-7 | T | Doble clic crea dos órdenes | `Idempotency-Key` por intento | Implementado; verificar que la UI reutiliza la clave en reintentos |

### Disponibilidad y red

| ID | STRIDE | Amenaza | Control actual | Estado |
| --- | --- | --- | --- | --- |
| T-NET-1 | D | Agotar memoria/threadpool con logins | Límite por IP | **Brecha** menor F10 (320 MiB pico medido) |
| T-NET-2 | D | Cola de conexiones BD agotada | Pool 15, `statement_timeout` 10 s, `lock_timeout` 5 s | Implementado; sin prueba de carga |
| T-NET-3 | S/D | `X-Forwarded-For` falsificado o saltos mal contados | `trust proxy = 1` | **Por verificar en Render**: desplegar, registrar temporalmente `req.ips` de una petición conocida y confirmar que `req.ip` es la IP pública real. Si no, todos comparten bucket (DoS) o un atacante elige su IP (bypass) |
| T-NET-4 | D | Microcortes / cambio de AP | Idempotencia, SSE con reconexión, mensaje “sin conexión” | Implementado; F03 resuelto; **Brecha** F16 (sin prueba de jornada) |
| T-NET-5 | D | Crecimiento ilimitado de tablas auxiliares | Ninguno | **Brecha** F14 |
| T-NET-6 | D | Pérdida de visibilidad en cocina | Activas siempre visibles | **Verificado**; rendimiento R2-05 |

### Datos, logs y secretos

| ID | STRIDE | Amenaza | Control actual | Estado |
| --- | --- | --- | --- | --- |
| T-DB-1 | T | SQL injection | Consultas parametrizadas; único identificador interpolado proviene de lista fija | Implementado (revisión manual) |
| T-DB-2 | T/R | Rol de app con privilegios de propietario puede desactivar triggers | Ninguno (Render usa el propietario) | Riesgo aceptado temporalmente; Propuesto: rol de migración separado del rol de app |
| T-LOG-1 | I | Secretos en logs | `pino` con `redact`; se registra `path` sin query; token de reset en fragmento `#` | Implementado; prueba de bitácora sin contraseñas (Codex) |
| T-LOG-2 | R | 500 sin causa registrada | `diagnostic()` sin mensajes ni parámetros | Implementado |
| T-LOG-3 | R | Bitácora sin contexto | `audit_log.details` + índice por recurso | Implementado (NIT: movimientos de caja y creación de orden sin detalle) |
| T-SEC-1 | I | Secretos en repositorio | `.gitignore`, `.env.example` sin valores reales | Verificado manualmente (árbol + historial) |
| T-SUP-1 | T | Dependencia vulnerable | `npm audit` | Producción: 0 vulnerabilidades. Gate en CI pendiente |

## 6. Riesgos aceptados (requieren confirmación del propietario)

1. TOFU en el primer enrolamiento MFA del administrador (T-MFA-5).
2. MFA no obligatorio para cajeros (manejan dinero). Recomendación: hacerlo obligatorio o al menos para abrir/cerrar caja.
3. Sin ventas offline (decisión de diseño): con Internet caído el restaurante no puede registrar ventas en el sistema; requiere procedimiento manual de contingencia.
4. Rol de base de datos propietario (T-DB-2) hasta que Render permita/añadamos un rol separado.

## 7. Cambios de la ronda 2

- Nuevo límite de confianza B8: **GitHub → Render**. `autoDeployTrigger: checksPass`, pero `main` no está protegida (R2-02): el CI no impide fusionar código con pruebas rojas.
- Disponibilidad de datos: `render.yaml` con Postgres gratuito, que expira a los 30 días y no admite backups (R2-03). Riesgo de pérdida total; inaceptable en producción.
- CSRF reforzado con token de doble envío firmado y ligado a refresh/desafío/binding anónimo (Codex, cubierto por `tests/review-regressions.test.ts`).
