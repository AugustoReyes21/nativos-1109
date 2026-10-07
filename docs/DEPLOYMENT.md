# Despliegue y operación

## Estado

Publicado el 2026-10-07 mediante CLI oficial autorizado por el propietario: **https://nativos1109.onrender.com**. Entorno gratuito de ensayo, **no producción comercial**. No se modificaron otros servicios de la cuenta.

- Web `srv-db3740ss728c73biip9g`, Oregon/free, rama `codex/feature/secure-pos-foundation`.
- PostgreSQL 17 `dpg-db36u0rncjis73elmaq0-a`, Oregon/free; **vence el 2026-11-06**. No guardar ventas reales aquí. Cambiar a infraestructura persistente con backups antes de operación comercial.
- Primer deploy `dep-db3741cs728c73biiqg0`, commit `169d9d3`, después de verify/sast/baseline exitosos. CI: runs 37651290538 y 37651290459.
- Verificados remotamente `/`, `/health/live`, `/health/ready`: 200; HTTPS/HSTS presentes. Migraciones se ejecutaron al arrancar. No se modificó el esquema manualmente.
- SMTP Brevo con STARTTLS obligatorio en 2525, autenticación comprobada. MAIL_FROM/SMTP_USER/SMTP_PASSWORD están en variables Render, no en Git. La clave compartida en chat debe rotarse desde Brevo y actualizarse directamente en Render.
- Administrador inicial creado con `server/bootstrap.ts` compilado y contraseña aleatoria solo en memoria; no existe contraseña predeterminada publicada. Se solicitó el correo para elegir contraseña y se comprobó ausencia de RESET_DELIVERY_FAILURE. Aceptación SMTP no prueba entrega en inbox. La persona completa MFA; login previo a enrollment no emitió sesión POS.
- Bootstrap usó acceso PostgreSQL externo temporal restringido a una única IP /32 y TLS verificado. Al terminar se restauró `ipAllowList: []`; no quedan variables BOOTSTRAP ni acceso externo abierto.
- Auto-deploy exige checksPass. Cambios exclusivamente en docs/** no redepliegan. PR #2 permanece borrador; publicación de staging no equivale a aprobación de producción.

## Render

Blueprint: servicio Node 24 y PostgreSQL 17 en la misma región; URL interna de DB, whitelist de IP externa vacía. Build `npm ci --include=dev && npm run build`; arranque ejecuta migraciones compiladas y después servidor. Las migraciones se serializan mediante advisory lock y se verifican por checksum. Si migración falla, el proceso no atiende tráfico.

Se eligió ejecución de migraciones al arrancar por compatibilidad del entorno de ensayo. En un plan con pre-deploy, separar el comando de migración y mantener cambios compatibles con la instancia anterior durante rolling deploy. Nunca editar DB manualmente como sustituto de migración. Dockerfile ejecuta solo servidor: migrar explícitamente antes de iniciarlo.

Configurar APP_ORIGIN como origen HTTPS exacto asignado por Render (sin slash final), JWT_SECRET aleatorio de al menos 43 caracteres, MFA_KEY aleatorio de 64 hex. DATABASE_SSL=false corresponde exclusivamente a conexión interna Render del Blueprint; usar TLS verificado en conexiones externas. No usar rejectUnauthorized=false. Configurar SMTP con TLS y remitente autorizado; sin SMTP no hay recuperación de contraseña operativa.

Crear primer administrador mediante `node dist/server/bootstrap.js` con BOOTSTRAP_EMAIL/BOOTSTRAP_PASSWORD temporales. El comando se niega a actuar si ya hay usuarios. Eliminar esas variables después, iniciar sesión y conservar códigos MFA fuera del servidor. No se incluye usuario/password predeterminado productivo.

La rama inicial del servicio es codex/feature/secure-pos-foundation para ensayo. Promover a main después de revisión cruzada. `autoDeployTrigger: checksPass` espera las verificaciones de CI; configurar protección de rama con checks requeridos y revisión antes de usar producción. No se ha activado auto-merge.

## Health y errores de despliegue

- `/health/live`: proceso HTTP responde.
- `/health/ready` y `/health`: conexión DB y todas las migraciones requeridas presentes; devuelven 503 si no puede operar, sin detalles internos.
- Configuración inválida impide arranque y solo menciona nombres de variables.
- Correlacionar 500 por X-Request-ID y bitácora; nunca copiar secretos o SQL a tickets públicos.
- 502/503: revisar último deploy, proceso escuchando PORT/0.0.0.0, variables, migraciones, conectividad DB y límites de conexiones. La comprobación inicial del servicio desplegado respondió correctamente; esto no prueba disponibilidad sostenida.
- SIGTERM/SIGINT cierran streams y servidor, drenan conexiones y terminan antes de 10 segundos.

## Antes de producción

Elegir plan sin suspensión y PostgreSQL persistente con backups/PITR adecuados. El plan gratuito no es aceptable para disponibilidad de restaurante y puede tener vencimiento/restricciones. Confirmar costos con el propietario antes de contratar planes pagos. Definir RPO/RTO y medir una restauración en DB aislada. Separar credenciales de migración/runtime, limitar privilegios, activar alertas 5xx/readiness/latencia y monitoreo de almacenamiento/conexiones.

Ensayar backup cifrado y restauración de usuarios, MFA, órdenes y pagos; custodiar MFA_KEY fuera de DB para poder descifrar tras restauración. No restaurar datos sobre producción sin plan. Rollback de aplicación solo si esquema conserva compatibilidad; correcciones de schema mediante nueva migración, no modificar checksums anteriores.

Referencias: [Blueprint](https://render.com/docs/blueprint-spec), [Health checks](https://render.com/docs/health-checks), [Deploys y CI](https://render.com/docs/deploys).
