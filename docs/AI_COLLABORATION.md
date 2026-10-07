# Coordinación de agentes

## 2026-10-07 — Inicio

GitHub estaba vacío: sin ramas, commits, PR o issues. Codex ocupa el bloque inicial `codex/feature/secure-pos-foundation`: API, esquema, UI, tests y CI. Claude: revisión de arquitectura, seguridad y QA solicitada al presentar el PR; no se presume que haya revisado todavía.

Antes de editar: `git fetch`, revisar ramas/PR/issues y este archivo. No editar componentes ocupados sin comentar en el PR/issue correspondiente. No hacer force push. La rama base inicial contiene solo diagnóstico documental; el código se revisa mediante PR.

Decisiones a revisar: monolito modular, PostgreSQL con SQL parametrizado y bloqueos explícitos, cookies HttpOnly y JWT breve, MFA administrador obligatorio antes de acceder al POS, SSE sin payload sensible para invalidar snapshots, sin ventas offline.

Pendientes: URL/logs Render, revisión cruzada real, criterios de comprobante fiscal y política de cancelación de comida preparada. El comprobante inicial será interno, no factura tributaria.

Archivos de referencia: `TECHNICAL_AUDIT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `TESTING.md`, `NETWORK_ARCHITECTURE.md`, `DEPLOYMENT.md`.
