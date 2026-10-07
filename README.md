# Nativos1109

POS de restaurante en construcción: TypeScript, React, Express y PostgreSQL.
El primer bloque requiere revisión cruzada y validación de despliegue antes de operar ventas reales.

## Inicio local

Node 24 y Docker. Ejecuta `npm ci` y `docker compose up -d`.
Copia `.env.example` a `.env` y configura secretos aleatorios independientes:
`JWT_SECRET` (al menos 43 caracteres aleatorios), `MFA_KEY` (32 bytes codificados en 64 caracteres hex).
No reutilices secretos de pruebas ni los publiques.

Ejecuta `npm run db:migrate`, configura temporalmente `BOOTSTRAP_EMAIL` y
`BOOTSTRAP_PASSWORD` (12–128 caracteres), ejecuta `npm run db:bootstrap` y elimina esas dos variables.
Después `npm run dev`. Abre http://localhost:5173.
El administrador debe configurar MFA antes de acceder al POS.

Para servir el bundle local: `npm run build`, ajusta `APP_ORIGIN=http://localhost:3000` y ejecuta `npm start`.

## Documentación

- [Auditoría y brechas](docs/TECHNICAL_AUDIT.md)
- [Arquitectura](docs/ARCHITECTURE.md)
- [Seguridad](docs/SECURITY.md)
- [Pruebas](docs/TESTING.md)
- [Despliegue](docs/DEPLOYMENT.md)
- [Red del restaurante](docs/NETWORK_ARCHITECTURE.md)
- [Coordinación Codex / Claude](docs/AI_COLLABORATION.md)

No se almacenan datos de tarjeta. TARJETA/TRANSFERENCIA registran pagos confirmados mediante medios externos; no procesan pagos electrónicos.
Los comprobantes son internos, no documentos fiscales.
