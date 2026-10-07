# Despliegue y operación

## Estado

El usuario confirmó que se debe publicar en Render. Se encontró integración disponible y se solicitó conectarla. Sin conexión confirmada no se han creado recursos ni existe URL publicada verificable. `render.yaml` describe un entorno inicial de ensayo gratuito, no producción comercial.

## Render

Blueprint: servicio Node 24 y PostgreSQL 17 en la misma región; URL interna de DB, whitelist de IP externa vacía. Build `npm ci --include=dev && npm run build`; arranque ejecuta migraciones compiladas y después servidor. Las migraciones se serializan mediante advisory lock y se verifican por checksum. Si migración falla, el proceso no atiende tráfico.

Se eligió ejecución de migraciones al arrancar por compatibilidad del entorno de ensayo. En un plan con pre-deploy, separar el comando de migración y mantener cambios compatibles con la instancia anterior durante rolling deploy. Nunca editar DB manualmente como sustituto de migración. Dockerfile ejecuta solo servidor: migrar explícitamente antes de iniciarlo.

Configurar APP_ORIGIN como origen HTTPS exacto asignado por Render (sin slash final), JWT_SECRET aleatorio de al menos 43 caracteres, MFA_KEY aleatorio de 64 hex. DATABASE_SSL=false corresponde exclusivamente a conexión interna Render del Blueprint; usar TLS verificado en conexiones externas. No usar rejectUnauthorized=false. Configurar SMTP con TLS y remitente autorizado; sin SMTP no hay recuperación de contraseña operativa.

Crear primer administrador mediante `node dist/server/bootstrap.js` con BOOTSTRAP_EMAIL/BOOTSTRAP_PASSWORD temporales. El comando se niega a actuar si ya hay usuarios. Eliminar esas variables después, iniciar sesión y conservar códigos MFA fuera del servidor. No se incluye usuario/password predeterminado productivo.

La rama inicial del servicio es codex/feature/secure-pos-foundation para ensayo. Promover a main después de revisión cruzada. `autoDeployTrigger: checksPass` espera las verificaciones de CI; configurar protección de rama con checks requeridos y revisión antes de usar producción. No se ha activado auto-merge.

## Health y errores de despliegue

- `/health/live`: proceso HTTP responde.
- `/health/ready` y `/health`: conexión DB y migración base presentes; devuelven 503 si no puede operar, sin detalles internos.
- Configuración inválida impide arranque y solo menciona nombres de variables.
- Correlacionar 500 por X-Request-ID y bitácora; nunca copiar secretos o SQL a tickets públicos.
- 502/503: revisar último deploy, proceso escuchando PORT/0.0.0.0, variables, migraciones, conectividad DB y límites de conexiones. No se ha observado un incidente real Render porque el servicio todavía no está identificado/conectado.
- SIGTERM/SIGINT cierran streams y servidor, drenan conexiones y terminan antes de 10 segundos.

## Antes de producción

Elegir plan sin suspensión y PostgreSQL persistente con backups/PITR adecuados. El plan gratuito no es aceptable para disponibilidad de restaurante y puede tener vencimiento/restricciones. Confirmar costos con el propietario antes de contratar planes pagos. Definir RPO/RTO y medir una restauración en DB aislada. Separar credenciales de migración/runtime, limitar privilegios, activar alertas 5xx/readiness/latencia y monitoreo de almacenamiento/conexiones.

Ensayar backup cifrado y restauración de usuarios, MFA, órdenes y pagos; custodiar MFA_KEY fuera de DB para poder descifrar tras restauración. No restaurar datos sobre producción sin plan. Rollback de aplicación solo si esquema conserva compatibilidad; correcciones de schema mediante nueva migración, no modificar checksums anteriores.

Referencias: [Blueprint](https://render.com/docs/blueprint-spec), [Health checks](https://render.com/docs/health-checks), [Deploys y CI](https://render.com/docs/deploys).
