# Coordinación de agentes

## 2026-10-07 — Mesas isométricas y transición de marca

Codex: `codex/feature/immersive-floor-motion`, apilada sobre PR #9. Coordinación previa real en [issue #5](https://github.com/AugustoReyes21/nativos-1109/issues/5#issuecomment-6044370783). Implementación `b4ece7d`: `web/TableScene.tsx`, `table-geometry.ts`, `ModuleStage.tsx`, `immersive.css`, integración en FloorPlan/main; regresiones en tests/table-geometry y e2e/immersive-ui/courtesies. Sin cambios backend, esquema ni datos desplegados.

Decisiones: geometría SVG con volumen/sombra, no motor WebGL; cortina N de 900 ms solicitada explícitamente por el propietario, navegación disponible, contenido protegido durante transición y preferencia de movimiento reducido respetada. Se atiende UI-03 y el fondo lateral continuo de UI-04 mediante CSS responsive, sin editar el dictamen de Claude. Resultados locales: 134 tests, 12 E2E; lint/typecheck/build/secret scan/dependency audit aprobados. Primera regresión de ingreso durante transición resuelta, comprobantes revalidados.

Claude: revisión UX/accesibilidad y de este diff solicitada; no se presume aceptación. UI-05, CL-02/03 y revisión financiera de #9 siguen pendientes. Codex conserva estos componentes hasta terminar la publicación autorizada de staging con CI verde; no fusionar main ni contratar planes de pago. Configurar mesas reales sigue pendiente del propietario. Evidencia de despliegue se registra en DEPLOYMENT.md cuando Render confirme `live`.

Publicación final: [PR #10](https://github.com/AugustoReyes21/nativos-1109/pull/10), `7537857`, Render `dep-db39aqt9fdbs73ad9pu0` live. CI 37669645780/37669652240/37669652138 aprobado, bundles remotos verificados por SHA256 y login desktop/mobile sin errores. Codex libera los componentes para revisión coordinada; no se supone aprobación de Claude ni se cierra #5. Siguiente prioridad: revisión independiente UX y configuración de mesas reales; pendientes financieros/CL-02/03 conservan su prioridad técnica.

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
# Publicación de staging verificada — 2026-10-07

Render: https://nativos1109.onrender.com, commit 169d9d3, después de CI verde. 85 tests + 3 E2E, CodeQL y ZAP pasan. SMTP STARTTLS/2525 y autenticación comprobados; bootstrap ejecutado con contraseña aleatoria no expuesta y enlace de recuperación solicitado para el propietario. Login administrador exige MFA y no emite sesión antes del enrollment. Acceso externo de DB vuelve a estar cerrado. Recursos, IDs, procedimientos y vencimiento 2026-11-06 en DEPLOYMENT.md. Staging no equivale a aprobación de main ni producción. R2-02 (protección de rama), R2-03 (plan productivo), F11 (outbox/tiempo de respuesta) y demás pendientes permanecen abiertos.

## 2026-10-07 — Sala Nativos: Codex + Claude

Nuevo requisito del propietario: selección exclusiva aun sin orden. Codex implementa `server/table-claims.ts`, 007, integración de órdenes/estado y UI; Claude recibe contrato en issue #5 y revisión adversarial propuesta en `tests/security/table-claims-review.test.ts`, sin solapar archivos. Política/contratos/limitaciones en `docs/TABLE_CLAIMS.md`. Reserva de 5 minutos renovable en actividad, locks PostgreSQL, generación contra renew/release atrasados, idempotencia estable al volver a reservar. Revisión final y despliegue siguen pendientes; no declarar acuerdo de Claude donde solo existe solicitud enviada.

Actualización final del bloque: PR #7 publicado en `codex/feature/two-level-floorplan`. 94/94 pruebas y 3/3 E2E en 5110761; CI de ese commit verde (Quality and security: 37656147398; ZAP: 37656147350). Último ajuste menor: filtro móvil sin texto recortado y capturas esperando opacidad final; lint/typecheck/build y 3/3 E2E reejecutados. Revisión final de Claude solicitada en PR #7, aún sin dictamen: no se fusiona ni despliega en Render por anticipado. Staging continúa con versión anterior. Croquis/cantidades pendientes del propietario.

Coordinación real en issue #5: Claude aceptó revisar UX, accesibilidad y permisos sin editar frontend de Codex. Codex implementa `web/`, `server/pos.ts` (mesas y snapshot), 005/006, `tests/table-snapshot.test.ts` y `e2e/pos.spec.ts`. Claude mantiene `tests/security/floors.test.ts` y `docs/reviews/ui-floorplan-review.md` en su rama. #4 integrado localmente con merge limpio; no force push ni cambios directos a main.

Decisiones D1/D2/D4/D5 de Claude adoptadas: estado global calculado en backend sin importes ajenos, Para servir, nivel en KDS/recibo y snapshot histórico inmutable. D3/D6 aplazados explícitamente: posiciones libres/desactivar mesas requieren siguiente entrega. Plano actual es cuadrícula operativa configurable; no se inventan datos reales. D7: Motion/reduced-motion, SVG nativo, fuentes del sistema, JS inicial120KB gzip y lista alternativa.

93 tests + 3 E2E pasan localmente; lint/typecheck/build/audit también. Revisión visual de capturas reales desktop/mobile. Pendiente revisión independiente final, CI remoto y publicación del rediseño; no declarar desplegado antes de verificar Render. Brief: `docs/UI_DESIGN_BRIEF.md`. El administrador sigue necesitando configurar mesas por nivel; no se completó su MFA por él.



## 2026-10-07 — Claude, ronda 2 (correcciones autorizadas por el propietario)

Rama `claude/review/pr2-round2` (PR #3 → rama de Codex). Por instrucción del propietario, Claude corrigió: R2-01 (topes de login antes de Argon2 + tope por cuenta con `TRUSTED_LOGIN_IPS`), R2-04 (integración = todo menos unitarias; gitleaks por digest; `forbidOnly`), R2-05 (migración 004 `paid_at` + índice parcial: 370 ms → 2 ms con 200k órdenes), R2-07 (ventana de refresh de 5 min), R2-08 (subclave HKDF), F07 (detalles de movimientos y creación de orden), F11 (envío SMTP sin esperar), F12 (prueba MFA con desafío real), F14 (retención horaria). R2-03: Render queda en free solo para pruebas; ver “Paso a producción” en DEPLOYMENT.md. `main` protegida por decisión del propietario.

Codex: los archivos anunciados en el PR #2 quedan liberados al fusionar #3. Abiertos: R2-06 (cierre de órdenes entregadas sin pagar, requiere política), F16 (prueba SSE de jornada), F19, E2E faltantes.
# 2026-10-07 — Menú, superadmin y cortesías

Codex reserva `codex/feature/menu-superadmin-courtesies`, migraciones 008/009, auth/roles/pos/promote-owner, Orders/Management y pruebas propias. Base f5e4a88 del PR #7; se revisaron ramas, PR, commits e issue #5. Claude mantiene PR #8 y sus pruebas/review sin sobrescritura. Contrato financiero comunicado en issue #5 antes de implementar; revisión final solicitada, no se presume aprobación.

Propietario confirmó `reyessamayoa8@gmail.com` y stock 0. PDF inspeccionado: 20 productos; archivo original preservado fuera de Git. Decisiones: conservar bruto y stock, autorizar por unidades/motivo con caja abierta, liquidación total por 0 sin efectivo; asiento inmutable y sin cancelación posterior. SUPERADMIN con MFA obligatorio y permiso exclusivo para gestionar su rol. Promoción mediante comando auditado posterior al despliegue compatible, no durante la migración. Contrato en MENU_AND_COURTESIES.md.

Pendientes: revisión independiente de este bloque y exclusión de mesas; atender UI02/UI03 de PR #8 en su bloque, publicar versión validada en Render, ejecutar promoción del propietario y configurar existencias reales. No se fusionó main ni se reemplazó el despliegue anterior por anticipado.
# 2026-10-07 — Publicación autorizada del PR #9

El propietario pidió explícitamente actualizar Render con todos los cambios. Se publica únicamente staging free, sin fusionar main ni declarar producción terminada. Integrado PR #8 de Claude (6b2102e) con merge, conservando sus pruebas y dictamen. CL-01 corregido con máximo dos borradores reservados por sesión y lock transaccional; UI-02 se corrige eliminando nombres ARIA que ocultaban texto visible y reforzando contraste/tamaño. Se añaden checks axe a E2E; no se excluyen elementos para pasar.

PR: https://github.com/AugustoReyes21/nativos-1109/pull/9. Comunicación en issue #5. Pendientes independientes: revisión financiera del PR #9, UI-03/04/05, recuperación de mesa entre sesiones y traslados administrativos (CL-02/03). El despliegue solicitado no cierra estas tareas. Estado remoto definitivo se registra en DEPLOYMENT.md después de comprobarlo.

Resultado: `b43bf89` publicado `live` en `dep-db38sm4s728c73bnk5lg`, checks remotos verdes, 129 pruebas + 9 E2E aprobados; CL-01 y las dos reglas axe de UI-02 pasan. API health y login remoto desktop/mobile verificados. Menú20/stock0 y migraciones001–009 verificados por DB/checksum. Propietario SUPERADMIN con MFA habilitado y sesiones previas revocadas. Sin órdenes/pagos sintéticos ni mesas inventadas; acceso DB temporal retirado. No se fusionó main ni se cerraron los dictámenes pendientes.
