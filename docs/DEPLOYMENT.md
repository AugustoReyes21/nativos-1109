# Despliegue y operación

## Estado

Publicado el 2026-10-07 mediante CLI oficial autorizado por el propietario: **https://nativos1109.onrender.com**. Entorno gratuito de ensayo, **no producción comercial**. No se modificaron otros servicios de la cuenta.

- Web `srv-db3740ss728c73biip9g`, Oregon/free, rama actual `codex/feature/immersive-floor-motion`.
- PostgreSQL 17 `dpg-db36u0rncjis73elmaq0-a`, Oregon/free; **vence el 2026-11-06**. No guardar ventas reales aquí. Cambiar a infraestructura persistente con backups antes de operación comercial.
- Primer deploy `dep-db3741cs728c73biiqg0`, commit `169d9d3`, después de verify/sast/baseline exitosos. CI: runs 37651290538 y 37651290459.
- Actualización anterior (menú/cortesías): `dep-db38sm4s728c73bnk5lg`, commit `b43bf89b8361d78dcdaf81047ed4f104c66259f0`. CI aprobado: Quality/security 37666025025 y 37666034735; ZAP 37666034730. Incluye interfaz de dos niveles, reservas exclusivas, menú y cortesías.
- Actualización visual publicada: `dep-db39aqt9fdbs73ad9pu0`, commit `75378577609ff3b4ded9ffce184c281db832ad5a`, estado Render `live`. Quality/security 37669645780 y 37669652240, ZAP 37669652138 aprobados antes del despliegue. PR #10 pendiente de revisión independiente, sin merge a main.
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
# Menú, propietario y cortesías publicados — 2026-10-07

El propietario autorizó explícitamente actualizar staging con el PR #9. Se desplegó el commit exacto indicado arriba después de CI verde, sin fusionar main. Todas las migraciones 001–009 fueron verificadas por nombre/checksum contra los archivos versionados. El HTML remoto referencia el mismo bundle verificado localmente (`index-CeaelnVW.js`). `/health`, `/health/live`, `/health/ready` responden 200 con HSTS. Navegador real remoto: login visible, sin errores JavaScript/recursos ni desbordamiento horizontal en escritorio y móvil. Las pantallas autenticadas se validaron con nueve E2E en una DB aislada; no se suplantó al propietario para probarlas en staging.

Cuenta `reyessamayoa8@gmail.com` promovida con `promoteOwner`, después de confirmar despliegue compatible. Verificado: SUPERADMIN activo, 18 permisos, MFA habilitado y obligatorio, cero sesiones anteriores activas. Contraseña y configuración MFA conservadas. El usuario debe iniciar sesión nuevamente. Acceso PostgreSQL externo temporal limitado a IP /32 y TLS verificado; al finalizar se restauró y comprobó `ipAllowList: []`. No se publicaron credenciales ni se cambió SMTP.

Datos antes/después: una cuenta conservada; cero órdenes y pagos; catálogo pasa de 0 a 20 productos, todos con stock 0. Hay **cero mesas configuradas**: el propietario debe crear las reales para los niveles 1/2 en Productos y mesas y establecer las cantidades de jornada. No se inventaron mesas, existencias ni ventas.

La publicación solicitada no equivale a cierre de la revisión independiente financiera ni a producción comercial. UI-03/04/05 y CL-02/03 seguían pendientes al publicar #9; el bloque visual siguiente atiende implementación de UI-03/04 sin dar por cerrado el dictamen de Claude. No volver al auth antiguo después de promover SUPERADMIN. Contrato/operación en [MENU_AND_COURTESIES.md](MENU_AND_COURTESIES.md).

## Mesas isométricas y transición N publicadas — 2026-10-07

PR #10, commit/despliegue actual arriba. Render confirmó `live`; `/health`, `/health/live`, `/health/ready` responden 200 y HSTS. El HTML remoto referencia `index-CREcfA-d.js` y `index-XQJuKWYA.css`, ambos con SHA256 idéntico a la compilación validada localmente. Navegador remoto escritorio/móvil: login visible, 0 errores JavaScript/recursos y sin overflow. Los módulos autenticados fueron probados mediante 12 E2E en DB aislada, no mediante suplantación del propietario.

No se modificaron cuentas, stock, ventas, variables secretas, esquema ni acceso externo de DB. Se conservó el plan free y checksPass; sin costos nuevos. Las mesas de ambos niveles deben configurarse con sus datos reales en Productos y mesas, no se sembraron fixtures en el servicio. Review UX/accesibilidad de Claude solicitada en issue #5 y PR #10, todavía pendiente. Es staging, no certificación de producción ni impresión física.
