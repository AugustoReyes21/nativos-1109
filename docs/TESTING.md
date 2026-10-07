# Verificación

## Selección exclusiva antes de crear órdenes — 2026-10-07

`tests/table-claims.test.ts` añade nueve casos con PostgreSQL real: clics simultáneos, bloqueo sin orden, API directa, RBAC/CSRF, UUID/replay, expiración, renovación/liberación atrasadas, cambio atómico, logout, orden activa y conservación del intento idempotente entre generaciones. Suite completa: **103/103** pasan.

`e2e/table-claims.spec.ts` usa dos sesiones de mesero reales: el segundo ve la mesa reservada/deshabilitada, la DB confirma cero órdenes, la API rechaza seleccionar con 409, y descartar permite al siguiente mesero tomarla. Junto al recorrido POS existente: **6/6 E2E** en escritorio/tablet/móvil en la primera ejecución completa. Se reejecutan tras ajustes finales; resultado final en PR #7. No mocks ni eliminación de aserciones anteriores. Contrato y límites: `TABLE_CLAIMS.md`.

## Sala Nativos — 2026-10-07, PR #7

`tests/table-snapshot.test.ts`: creación idempotente, ediciones concurrentes con versión (200/409), snapshot de nombre/nivel en orden y recibo, integridad del snapshot en DB, estado de mesa pagada pero no entregada, y upgrade de historial existente pagado/cancelado con guards restaurados. Cuatro pruebas pasan; suite completa: **94/94** en 5110761, seguida de **3/3 E2E**. Lint/typecheck/build pasan; npm audit informa 0 vulnerabilidades. Bundle inicial 120.41 KB gzip (CSS 5.71 KB). CI y revisión independiente se consultan en PR #7, no se presumen a partir de este resultado local.

`e2e/pos.spec.ts`: recorrido real con mesa redonda de seis plazas en nivel 2, selección por teclado, borrador conservado al navegar, señal Para servir por SSE, nivel en KDS/recibo, vista lista, movimiento reducido, ausencia de overflow, reintento idempotente después de pérdida de respuesta, reconexión y cobro. 3/3 pasan después del ajuste móvil compacto; capturas en `test-results/floor-{desktop,tablet,mobile}.png` (ignoradas por Git). No se probaron dispositivos físicos del restaurante. Revisión axe independiente asignada a Claude, no declarada aprobada.

Fecha: 2026-10-07. Entorno local: Windows, Node 24.18.0, PostgreSQL 17 en Docker. No son mediciones del restaurante o Render.

## Ejecutar

Crear DBs aisladas con sufijo `_test`: `nativos_test`, `nativos_e2e_test`, `nativos_load_test`. Las suites se niegan a usar DB sin ese sufijo. Se truncan tablas exclusivamente en esas DB de ensayo. No apuntar jamás a producción aunque el nombre tenga ese sufijo.

`npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
`npx playwright install chromium`, `npm run test:e2e`.
CI ejecuta la misma cadena con PostgreSQL real. E2E usa bundle de producción y API real; no mocks de ventas/auth.

## Resultado inicial

- 5 unitarias: Argon2id, cifrado MFA y manipulación, TOTP, dinero, configuración segura.
- 14 integraciones: migraciones repetibles, readiness, CSRF/origen, credenciales, MFA admin/QR/códigos, RBAC/mass assignment, último stock concurrente, versión de inventario, reintentos simultáneos, transición de cocina, doble pago concurrente, caja/cierre, JWT expirado/refresh/reutilización, recuperación/logout/bloqueo/brute force, headers/bitácora. Algunos escenarios relacionados comparten un caso.
- 3 E2E: recorrido completo en Chromium escritorio, tablet y móvil. Admin configura categoría/mesa/producto/stock y MFA; mesero confirma; cocina recibe sin recarga y cambia estado; se corta/restaura conexión; mesero entrega; cajero abre/cobra/cierra; DB confirma venta única. La revisión final añade pérdida deliberada de respuesta y reintento del mismo pedido.
- Se inspeccionó visualmente captura móvil y se comprueba ausencia de overflow horizontal.
- `npm audit`: 0 vulnerabilidades tras retirar concurrently y su dependencia shell-quote vulnerable. No se agregaron excepciones.
- Gitleaks detectó un placeholder de ejemplo como posible clave; se dejó vacío antes de publicar el commit de código. El historial de código fue reescaneado sin hallazgos; no se trataba de una credencial real.

## Bugs descubiertos y regresiones

1. Cierre de caja mezclaba parámetros integer/bigint: devolvía 500. Se corrigieron parámetros tipados y se valida esperado 14000/diferencia -100.
2. Navegador podía conservar estado de desconexión tras recuperar red: se fuerza reapertura SSE en evento online y se valida offline/online con Playwright.
3. Selector E2E de categoría incluía opciones en el label: se usa rol accesible combobox, sin relajar la verificación funcional.

## Carga k6

Ejecutar `npx tsx load/server.ts` (DB de ensayo aislada y fixtures desechables). Después ejecutar contenedor grafana/k6:1.0.0 montando load/ y corriendo pos.js. No ejecutar contra producción: crea ventas y reserva stock. El origen por defecto es http://host.docker.internal:3001.

Resultado: 5 usuarios virtuales, 20 segundos, 395 recorridos, 2770 peticiones, 2765 checks correctos, 0 errores HTTP. Latencia media 7.76 ms, p95 13.92 ms, máxima 156.08 ms, 134.38 peticiones/s. Cada recorrido consulta menú, crea pedido, repite idempotentemente, actualiza preparación/listo, cobra y repite pago. Se cumple p95<500 ms/error<1%. Una caja serializa cobros correctamente en esta carga.

Alcance limitado: no prueba SSE a gran escala, múltiples instancias, duración de jornada, Internet real, failover DB, hardware de impresión, Firefox/Safari ni concurrencia extrema. No extrapolar estos resultados al plan gratuito de Render.

## Seguridad automatizada

CI: lint/typecheck/unit/integration/build/dependency audit, Gitleaks historial, CodeQL security-extended y Playwright. ZAP baseline local contra entorno de ensayo se documentará al concluir; no sustituye escaneo autenticado de roles. Mantener logs/reportes libres de secretos reales. Los artefactos de tests solo contienen credenciales efímeras de fixtures; retención limitada.

Pendientes: pruebas de restauración, balance de caja frente a cierre simultáneo con cobro, mayor matriz IDOR/custom roles/MFA de otros usuarios, pruebas de accesibilidad automatizada y navegación por teclado, revisión cruzada y verificación Render.

## Revisión cruzada integrada

Las 52 pruebas adicionales de Claude (19 DB + 33 API adversarial) se integraron con su migración 002. Se sumaron 3 regresiones de diagnóstico/readiness/cierre-versus-movimiento: **74 pruebas en cinco archivos, todas pasan**. Los 3 E2E volvieron a pasar sobre el bundle actualizado incluyendo pérdida de respuesta. Fixtures recrean exclusivamente DB locales conocidas nativos_*test; nunca desactivan triggers append-only.

ZAP final: 6 URLs no autenticadas, 65 reglas PASS, 0 FAIL y dos grupos WARN informativos (SPA y contenido público cacheable); el JSON incluye información adicional de caché. No quedan riesgos low/medium/high tras cerrar font-src y habilitar COEP. El gate lee severidad real del JSON y falla con cualquier riesgo >= low, sin ignorar reglas. No certifica endpoints autenticados ni configuración TLS Render.

CI/SAST están definidos y publicados, pero GitHub reporta 0 runs/checks a esta revisión; ejecución remota no verificada. La carga registrada arriba precede a los triggers de Claude; debe repetirse para medir el efecto del endurecimiento.

Repetición final con migraciones 001+002+003: 396 recorridos, 2777 requests, 2772 checks correctos, 0 errores; p95 13.32 ms, media 7.61 ms, máximo 162.89 ms. Misma carga 5 VU/20 s. Docker build en Linux completado con instalación limpia, compilación y eliminación de dependencias de desarrollo.

Smoke del contenedor Linux en NODE_ENV=production: readiness 200, UI estática 200, HSTS presente y hash/verificación Argon2id nativo correctos. No equivale a despliegue Render.

Primer DAST remoto detectó que NODE_ENV=test del workflow afectaba el bundle React y emitía avisos de comentarios/timestamps de dependencias de desarrollo. El build web ahora fija NODE_ENV=production dentro de su proceso, independientemente del entorno de tests. No se silenciaron alertas. Se corrigió también la subida de reportes ZAP desde el directorio oculto de artefactos.

# Revalidación de seguridad HTTP y CI

La suite ahora incluye 80 pruebas: 3 nuevas de lectura SARIF (extensiones/defaults/fail-closed) y 3 de CSRF/rate limiting además de las 74 existentes. Los clientes de prueba obtienen `GET /api/auth/csrf` antes de mutar; los replays de refresh siguen enviando la credencial anterior y la clave original, no se debilitan las aserciones de robo/reutilización.

CodeQL se verifica por alertas individuales y por gate local del SARIF. Un job verde anterior omitía metadatos en extensions; no usar esa ejecución como evidencia de ausencia de alertas. Resultados finales por commit: PR #2. La carga previa al token firmado no describe el rendimiento de la nueva versión: se requiere reejecutar `load/pos.js` actualizado.

# Validación de publicación — 2026-10-07

Commit 169d9d3: 85 pruebas únicas (`npm test` descubre todas las suites) y 3 E2E desktop/tablet/mobile pasan. CI remoto 37651290538, ZAP 37651290459 exitosos. Gitleaks conserva escaneo completo con una única excepción histórica revisada de fixture TOTP, documentada en SECURITY.md; ninguna credencial real fue incluida. Render publicó ese commit tras gates verdes. Smoke remoto: HTTPS, `/`, `/health/live`, `/health/ready` 200; administrador no recibe sesión antes de enrollment MFA; correo de configuración aceptado por SMTP, recepción en inbox no verificada. No se ejecutó carga ni se crearon ventas ficticias en la base desplegada.
# Menú, superadmin y cortesías — 2026-10-07

Validación local del bloque: **111/111 pruebas** en 10 suites y **9/9 E2E** (Chromium, escritorio/tablet/móvil). Incluye 8 nuevas pruebas API/DB de catálogo, stock 0, promoción y permisos/MFA, cortesías netas, idempotencia/concurrencia e invariantes directas PostgreSQL; tres nuevas ejecuciones E2E del recorrido superadmin → stock real → orden → cortesía parcial/total → comprobante/registro/caja. Se conservan los seis recorridos POS/reconexión/exclusión de mesas anteriores.

La primera ejecución E2E detectó un selector incorrecto: `getByLabel` incluía el texto de opciones del rol. Se corrigió a `getByRole('combobox')`; la aserción de SUPERADMIN se conserva. Se repitió la suite completa con resultado 9/9. Lint, typecheck y build pasan. Resultados remotos de CI y revisión independiente se registrarán en el PR; esto no prueba despliegue en Render, Safari real, fiscalidad ni impresión física.
