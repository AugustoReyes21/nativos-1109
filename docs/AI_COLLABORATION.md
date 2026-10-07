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
