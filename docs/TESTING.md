# Verificación

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
