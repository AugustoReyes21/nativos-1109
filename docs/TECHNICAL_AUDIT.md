# Auditoría técnica — Nativos1109

Fecha: 2026-10-07 (America/Guatemala). Responsable: Codex. Estado inicial verificado mediante Git, GitHub CLI y API GitHub.

## Evidencia inicial

- Carpeta de trabajo vacía, sin `.git` ni archivos de aplicación.
- `AugustoReyes21/nativos-1109`: público, tamaño 0, `isEmpty: true`.
- Sin ramas, commits, PR abiertos ni issues. La API de commits devuelve 409 (repositorio vacío).
- No hay código de Claude que preservar o decisiones previas que modificar.
- No existen package.json, lockfiles, frontend, backend, ORM, migraciones, middleware, endpoints, Dockerfile, configuración Render, pruebas o documentación.
- No se proporcionó URL/identificador de servicio Render ni logs. El despliegue mencionado no puede vincularse todavía con este repositorio.
- Node 24.18.0, npm 11.16.0, Git, GitHub CLI y Docker Desktop están instalados. Docker no estaba iniciado.

Esta auditoría no atribuye vulnerabilidades a código inexistente ni certifica producción. Clasifica brechas del sistema solicitado y separará implementación de verificación.

## Hallazgos y prioridades

| ID | Severidad | Prioridad | Hallazgo / evidencia | Remediación y criterio |
| --- | --- | --- | --- | --- |
| A01 | CRITICAL | P0 | No existe aplicación ni persistencia verificable | Crear base reproducible; impedir uso productivo hasta validar flujo e integridad |
| A02 | CRITICAL | P0 | No hay controles de concurrencia para stock/pagos/caja | PostgreSQL, constraints, bloqueos y pruebas concurrentes con DB real |
| A03 | HIGH | P1 | Autenticación, sesiones, MFA y RBAC ausentes | Argon2id, cookies HttpOnly, rotación/revocación, TOTP y permisos en servidor |
| A04 | HIGH | P1 | Validación, límites y protección web ausentes | Schemas estrictos, CORS/origin, headers, límites persistentes y errores seguros |
| A05 | HIGH | P2 | Flujo POS, KDS y reconexión inexistentes | UI responsive, idempotencia y sincronización con recuperación de estado |
| A06 | HIGH | P3 | No hay pruebas ni gates CI/CD | Unit/integration/E2E, typecheck/lint/build, dependencias, SAST y secretos |
| A07 | HIGH | P3 | Render y datos reales desconocidos | Solicitar identificación; health/readiness, migraciones, backups y runbook |
| A08 | MEDIUM | P3 | Auditoría y observabilidad ausentes | Bitácora transaccional, logs estructurados y request IDs sin secretos |
| A09 | MEDIUM | P4 | Rendimiento y red sin mediciones | Carga de ensayo, Wi-Fi segmentado, indicadores offline y reintentos seguros |
| A10 | LOW | P5 | No hay convenciones ni coordinación registrada | Documentación y ramas por bloque con revisión cruzada |

## Decisiones iniciales propuestas para revisión cruzada

Monolito modular TypeScript: Express, React/Vite y PostgreSQL. Mismo origen para API/UI, cantidades monetarias enteras en centavos, SQL parametrizado y migraciones SQL versionadas. No se introduce ORM: los bloqueos y constraints financieros serán explícitos. Roles/permisos residen en tablas extensibles. SSE con invalidación y recarga de snapshots conserva estado tras desconexiones. No se autoriza venta offline.

El repositorio vacío requiere un commit documental base para poder abrir PR: se crea en `codex/docs/initial-audit`; la referencia `main` podrá apuntar a ese mismo commit sin desarrollar sobre ella. Todo código posterior se desarrolla en `codex/feature/secure-pos-foundation` y se propone mediante PR.

## Cobertura pendiente

Revisar cada componente creado: arquitectura, frontend/accesibilidad/dispositivos, endpoints y permisos, esquema/migraciones/índices, sesiones/MFA/CSRF, errores/logs, dependencias/secrets, almacenamiento, Render, recuperación y rendimiento. No hay hallazgos de secretos históricos porque no existe historial. No se ejecutaron pruebas de aplicación en la auditoría inicial.

## Referencias

- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- https://www.postgresql.org/docs/18/explicit-locking.html
- https://render.com/docs/health-checks
- https://render.com/docs/deploys

## Revalidación del primer bloque — 2026-10-07

Código propuesto en [PR #2](https://github.com/AugustoReyes21/nativos-1109/pull/2). Claude publicó revisión independiente en su rama y [issue #1](https://github.com/AugustoReyes21/nativos-1109/issues/1); integrada mediante merge, conservando su historial y migración 002.

Implementado: monolito TypeScript/React/Express/PostgreSQL, migraciones, sesiones seguras/MFA/RBAC, catálogo/stock/versiones, órdenes idempotentes, KDS SSE, pagos/caja transaccionales, auditoría append-only, errores/logging, headers, CI y Blueprint Render.

Hallazgos resueltos con pruebas: 500 en cierre de caja; omisión de órdenes activas tras 200 registros; desconexión persistente tras recuperar red; NAT bloqueado por logins exitosos; falta de constraints financieros; reintento legítimo de refresh tras respuesta perdida; texto NUL que causaba 500; readiness incompleto. Audit ahora registra importes y estados, diagnóstico de errores conserva SQLSTATE/constraint/stack sin parámetros. Argon2 limitado a dos operaciones concurrentes. Protección para conservar administrador activo.

Resultado local actualizado: 74 pruebas unitarias/API/DB y 3 E2E (escritorio/tablet/móvil) pasan. 0 vulnerabilidades npm; Gitleaks del historial sin hallazgos. ZAP baseline: se corrigieron font-src demasiado abierto y COEP ausente; quedan avisos informativos de aplicación moderna y cache de assets públicos. Alcance ZAP no autenticado.

Estado de hallazgos iniciales: A01–A06/A08/A10 tienen implementación y evidencia local, pero permanecen pendientes de revisión final/despliegue real. A07/A09 requieren acceso Render y mediciones/restauración/red del restaurante. No se declara producción lista.

Pendientes relevantes: SMTP real y eliminar canal temporal en forgot-password (outbox), retención automática, editor de roles/permisos, gestión completa MFA en UI, ampliación de órdenes ya enviadas, comprobantes fiscales/impresoras, roles DB mínimos, backup/restauración, validación de proxy y jornada real. Más detalle en SECURITY.md y matriz de Claude.
# Revalidación de CI y controles HTTP (2026-10-07)

**HIGH / P1 — gate SAST incompleto (corregido en código, revalidación remota requerida):** la primera ejecución verde de Actions no equivalía a ausencia de hallazgos. CodeQL reportaba 22 alertas (21 rate limiting, 1 CSRF); el lector SARIF buscaba exclusivamente reglas en driver y omitía su severidad ubicada en extensions. Se corrige resolución de componentes/defaultConfiguration y comportamiento fail-closed; tres regresiones automatizadas cubren el defecto. No hay suppressions ni dismissals.

**HIGH / P1 — superficie sin tope global pre-DB:** existían límites persistentes de operaciones sensibles, pero lecturas/archivos/health no tenían cap de ráfaga. Se agrega express-rate-limit antes de DB y sin retirar límites especializados. Las alertas sobre login incluían limitadores propios no modelados por CodeQL; no se asumió que todas fueran explotables ni se ignoró la ausencia real en otras rutas.

**MEDIUM / P1 — defensa CSRF reforzada:** Origin exacto + JSON + custom header ya bloqueaban solicitudes cross-site simples, pero se agrega double-submit firmado y ligado a credencial con csrf-csrf. Pruebas rechazan tokens ausentes/forjados, cookie/header iguales sin HMAC válido, intercambio entre navegadores y uso posterior a login; cookie JSON malformada no produce 500. Las aserciones de concurrencia/refresh de Claude se conservan, adaptando solo transporte CSRF.

Validación local del bloque: lint/typecheck/build, 80 pruebas unitarias/API/DB. E2E y CodeQL/ZAP se reejecutan sobre el commit final; consultar PR #2 para evidencia final. Las cifras de carga previas corresponden al protocolo anterior a este refuerzo y no deben presentarse como medida del commit final.
