# Coordinación de agentes

## 2026-10-07 — Inicio

GitHub estaba vacío: sin ramas, commits, PR o issues. Codex ocupa el bloque inicial `codex/feature/secure-pos-foundation`: API, esquema, UI, tests y CI. Claude: revisión de arquitectura, seguridad y QA solicitada al presentar el PR; no se presume que haya revisado todavía.

Antes de editar: `git fetch`, revisar ramas/PR/issues y este archivo. No editar componentes ocupados sin comentar en el PR/issue correspondiente. No hacer force push. La rama base inicial contiene solo diagnóstico documental; el código se revisa mediante PR.

Decisiones a revisar: monolito modular, PostgreSQL con SQL parametrizado y bloqueos explícitos, cookies HttpOnly y JWT breve, MFA administrador obligatorio antes de acceder al POS, SSE sin payload sensible para invalidar snapshots, sin ventas offline.

Pendientes: URL/logs Render, revisión cruzada real, criterios de comprobante fiscal y política de cancelación de comida preparada. El comprobante inicial será interno, no factura tributaria.

Archivos de referencia: `TECHNICAL_AUDIT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `TESTING.md`, `NETWORK_ARCHITECTURE.md`, `DEPLOYMENT.md`.

## 2026-10-07 — Claude (revisión independiente)

Rama: `claude/audit/foundation-review` (clon separado; no se toca el árbol de trabajo ni la BD local de Codex; Postgres propio en `127.0.0.1:55433`).

Revisado: árbol **sin commitear** de `codex/feature/secure-pos-foundation` (server, migración 001, tests; web parcial). Informe: `docs/reviews/2026-10-07-foundation-review.md`. Abiertos: 1 BLOCKER (F01 cierre de caja 500), 6 MAJOR (F02 KDS >200 órdenes, F03 refresh tras microcorte, F04 límites de login/NAT, F05 BD sin invariantes, F06 500 sin causa, F07 bitácora sin contexto).

Aportes en la rama (no modifican archivos de Codex):
- `migrations/002_integrity_guards.sql` — invariantes financieras en PostgreSQL (propuesta; el número final se decide al integrar).
- `tests/db/integrity.test.ts`, `tests/security/api-adversarial.test.ts` — requieren `TEST_DATABASE_URL` (servidor desechable; crean y borran su propia BD) y **fallan, no se omiten**, si falta.
- `docs/THREAT_MODEL.md`, `docs/QA_MATRIX.md` (propiedad de Claude).

Solicitudes a Codex:
1. Publicar la rama/PR para revisar sobre commits; los hallazgos se revalidan allí.
2. Preparación de pruebas sin `TRUNCATE users ... CASCADE` (incompatible con bitácora append-only).
3. Responder en el PR qué hallazgos asume Codex y cuáles corrige Claude. Por defecto: Codex corrige `auth.ts`/`pos.ts`/`app.ts` (en curso); Claude mantiene 002 y las suites adversariales.

Bloqueos: ninguno. Claude no editará `server/` ni `web/` mientras figuren en curso salvo acuerdo en el PR.

## 2026-10-07 — Codex: integración de revisión

PR: https://github.com/AugustoReyes21/nativos-1109/pull/2 (borrador). Issue: https://github.com/AugustoReyes21/nativos-1109/issues/1. Se integró 8b98b71 de Claude con merge; no se sobrescribió su trabajo. Codex conserva propiedad temporal de server/web/CI; Claude revisa cambios y mantiene su threat model/matriz.

F01 corregido con parámetro de diferencia independiente; F02 muestra todas las órdenes activas/no cobradas más 200 finalizadas recientes; F04 limita fallos por cuenta+IP y permite logins correctos detrás de NAT; F05 integra 002 y regenera DBs de fixtures, sin deshabilitar append-only; F06 agrega diagnóstico seguro; F07 agrega details con estados/importes en bitácora. F08/F09/F10/F13/F15/F17/F18 atendidos en implementación; algunos todavía requieren revalidación específica de Claude.

Decisión explícita F03: misma clave idempotente + token anterior permite recuperar durante 30 s la cookie de reemplazo cifrada. Reutilización con clave diferente/ausente o fuera de ventana revoca. Se adaptó la prueba adversarial para exigir misma clave; la prueba de token robado sigue pasando. No se adoptó aceptación indiscriminada de tokens usados dentro de una ventana.

003 es de Codex: caché cifrado de refresh, details/index de auditoría y corrección del lock de movimientos en caja (002 solo bloqueaba filas que ya estaban cerradas). Se conserva 002 intacta. Nueva regresión de movimiento versus cierre concurrente pasa.

74 tests + 3 E2E pasan localmente. Último baseline ZAP no tiene riesgos low/medium/high, solo información de SPA/cache. API de GitHub todavía reporta 0 runs/checks pese a workflows publicados y Actions habilitado; no se presume CI verde. El push falló temporalmente con 500 y luego se recuperó; no hubo force push.

F11/F14/F16 prolongado/F19 y trabajo funcional pendiente están documentados. Se requiere segunda revisión del commit final; no cerrar el issue ni aprobar el PR automáticamente. Render está solicitado pero no conectado todavía.
# Actualización Codex — gate SAST y CSRF

CI remoto ya funciona. La primera ejecución verde omitió severidades de reglas CodeQL en SARIF extensions: corregido con regresiones fail-closed, sin excluir hallazgos. Se agregan capa pre-DB de ráfaga y tokens CSRF firmados ligados a credencial. Coordinación avisada en issue #1 antes de publicar. En la suite adversarial de Claude se adapta solo el helper HTTP y replay de refresh al contrato CSRF; se conservan las aserciones. Revisión final sigue pendiente, PR #2 sigue borrador. 80 tests locales pasan; evidencia remota final se publicará en el PR.
# 2026-10-07 — Render autorizado y revisión R2 integrada

Se integró `claude/review/pr2-round2` mediante merge, sin fusionar main ni cerrar PR #3. R2-01 corregido: límites de IP/cuenta global evaluados antes de Argon2 y antes de emitir sesión; fallos incrementan atómicamente las tres dimensiones. La prueba distribuida ahora exige 401 para los primeros 30 fallos y 429 para los restantes, preservando que la contraseña correcta desde una séptima IP también sea bloqueada. No se añadió excepción de IP confiable sin una política explícita. 85 tests y 3 E2E pasan localmente. CI ejecuta todas las suites con `npm test`, sin listas incompletas; `forbidOnly` aportado por Claude se conserva.

Render conectado por login oficial del CLI. Se creó exclusivamente `nativos1109-db`, PostgreSQL 17 free/Oregon, disponible y con vencimiento 2026-11-06. Staging, no producción; no se alteraron otras aplicaciones. Publicación web en curso, sujeta a checks del commit. Secretos únicamente en variables de Render, nunca en documentos/commits.


## 2026-10-07 — Claude, ronda 2 (correcciones autorizadas por el propietario)

Rama `claude/review/pr2-round2` (PR #3 → rama de Codex). Por instrucción del propietario, Claude corrigió: R2-01 (topes de login antes de Argon2 + tope por cuenta con `TRUSTED_LOGIN_IPS`), R2-04 (integración = todo menos unitarias; gitleaks por digest; `forbidOnly`), R2-05 (migración 004 `paid_at` + índice parcial: 370 ms → 2 ms con 200k órdenes), R2-07 (ventana de refresh de 5 min), R2-08 (subclave HKDF), F07 (detalles de movimientos y creación de orden), F11 (envío SMTP sin esperar), F12 (prueba MFA con desafío real), F14 (retención horaria). R2-03: Render queda en free solo para pruebas; ver “Paso a producción” en DEPLOYMENT.md. `main` protegida por decisión del propietario.

Codex: los archivos anunciados en el PR #2 quedan liberados al fusionar #3. Abiertos: R2-06 (cierre de órdenes entregadas sin pagar, requiere política), F16 (prueba SSE de jornada), F19, E2E faltantes.
