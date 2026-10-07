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

## Plan actual: pruebas en Render free

Decisión del propietario (2026-10-07): usar el plan **free** solo para pruebas y contratar un plan de pago antes del uso real. Consecuencias verificadas en la [documentación de Render](https://render.com/docs/free):

- La base de datos free **se elimina 30 días después de crearse** y **no admite backups**. Todo lo registrado en ella (ventas de prueba, usuarios, MFA) se pierde. Anotar la fecha de creación y no cargar datos reales.
- El servicio web free se suspende tras 15 minutos sin tráfico y tarda alrededor de un minuto en despertar. La primera petición del día puede fallar por tiempo de espera en las tablets.
- Configurar `TRUSTED_LOGIN_IPS` con la IP pública del restaurante (ver `trust proxy` abajo) para que un ataque de contraseñas desde fuera no bloquee al personal.

## Paso a producción (plan de pago)

1. Contratar una instancia web de pago (sin suspensión) y un PostgreSQL de pago con backups y recuperación a un punto en el tiempo; cambiar `plan` en `render.yaml` para el servicio y la base de datos.
2. Crear la base de datos de pago **nueva**: no migrar datos de pruebas. Ejecutar migraciones y `bootstrap` del primer administrador sobre ella.
3. Cambiar `branch` a `main` (protegida, solo recibe código que pasó CI).
4. Verificar `trust proxy`: desplegar, hacer una petición desde la red del restaurante y confirmar en los logs que `req.ip` es la IP pública real (no la del proxy). Esa IP va en `TRUSTED_LOGIN_IPS`.
5. Ensayar una restauración de backup en una base aislada antes de la primera venta real, y documentar RPO/RTO.
6. Configurar alertas de 5xx, readiness y latencia.


Elegir plan sin suspensión y PostgreSQL persistente con backups/PITR adecuados. El plan gratuito no es aceptable para disponibilidad de restaurante: la base de datos vence a los 30 días y no tiene backups. Confirmar costos con el propietario antes de contratar planes pagos. Definir RPO/RTO y medir una restauración en DB aislada. Separar credenciales de migración/runtime, limitar privilegios, activar alertas 5xx/readiness/latencia y monitoreo de almacenamiento/conexiones.

Ensayar backup cifrado y restauración de usuarios, MFA, órdenes y pagos; custodiar MFA_KEY fuera de DB para poder descifrar tras restauración. No restaurar datos sobre producción sin plan. Rollback de aplicación solo si esquema conserva compatibilidad; correcciones de schema mediante nueva migración, no modificar checksums anteriores.

Referencias: [Blueprint](https://render.com/docs/blueprint-spec), [Health checks](https://render.com/docs/health-checks), [Deploys y CI](https://render.com/docs/deploys).
