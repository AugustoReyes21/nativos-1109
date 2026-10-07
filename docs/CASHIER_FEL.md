# Caja, trazabilidad y preparación FEL

## Alcance solicitado y decisiones (2026-10-07)

Rama `codex/feature/cashier-fel-workflow`, apilada sobre PR #10. Se avisó a Claude en issue #5 antes de editar; revisión independiente solicitada, no aprobada por anticipado. Caja implementada; FEL **no habilitado**, depende de la integración y homologación descritas abajo.

- Cuenta enviada a caja explícitamente por mesero autorizado sobre su orden (administración puede asistir). El estado de cocina se mantiene independiente. Cobro bloqueado en backend mientras no se envíe; no se altera el total al enviar.
- Efectivo, tarjeta, transferencia y mixto efectivo/tarjeta. Centavos enteros, partes que suman exactamente el saldo neto, vuelto únicamente del efectivo. No almacenar PAN/CVV. Solo la parte en efectivo entra en el arqueo.
- Cajero solicita cierre con importe contado; se suspenden operaciones monetarias de esa caja mientras administración aprueba o rechaza. Autorización por sesión administrativa con MFA/RBAC, no contraseña compartida. Administrador puede autorizar directamente su propio cierre de forma explícita. Registro de solicitante/aprobador, cantidades y bitácora.
- Historial paginado independiente de órdenes activas; detalle de venta y reimpresión auditada con rótulo COMPROBANTE REIMPRESO. La aplicación registra solicitudes de impresión: el navegador no puede garantizar que una impresora física haya terminado.
- Usuarios, bitácora, ventas, cortesías y reportes en apartados propios. Registro inmutable de gastos/mermas; no confundir salidas de efectivo con gastos contables ni descontarlas dos veces. Saldo parcial, no utilidad fiscal: requiere costos, impuestos y revisión contable completos.

## FEL: dependencia externa explícita

SAT requiere habilitación del emisor y certificador acreditado; un comprobante interno o XML sin certificar NO constituye factura FEL. Fuentes oficiales consultadas: [Emisor de DTE](https://en.portal.sat.gob.gt/portal/emisor-de-dte/), [documentación técnica](https://en.portal.sat.gob.gt/portal/documentacion-tecnica-del-regimen-fel/), [certificadores](https://en.portal.sat.gob.gt/portal/certificador-de-dte/). El portal devolvió 403/502 al abrir algunas páginas; no se declara validación de un XSD/libro de reglas vigente a partir de resultados de búsqueda.

Se solicitaron al propietario: certificador, NIT/razón social/régimen fiscal, establecimiento/dirección y habilitación/acreditación. Claves exclusivamente mediante secretos Render, nunca chat/Git. No se selecciona proveedor de pago ni se inventan datos tributarios. Hasta contar con ello, la emisión fiscal debe fallar de forma explícita, sin cobrar una operación que solicitó factura ni generar UUID/serie ficticios.

Integración pendiente: adaptador específico y sandbox del certificador; XSD/libro de reglas vigente (incluido receptor C/F/NIT/CUI, límite CF, IVA/frases según régimen, descuentos/cortesías); certificación y almacenamiento XML/PDF/UUID/serie/número; consulta de estado antes de reintentar respuestas ambiguas; anulaciones/notas de crédito, contingencia autorizada, retención/backup y homologación con contador. Un timeout de certificación nunca debe provocar otro cobro ni otro DTE. No activar ventas fiscales reales en el PostgreSQL gratuito sin backups.

## Contrato y operación

1. Mesero: Órdenes → **Enviar a caja**. Requiere `orders.send_cash`, propiedad y versión vigente. Idempotente, auditado y propagado por SSE; no marca entregado ni cambia cocina. Las órdenes antiguas no se envían automáticamente.
2. Cajero: Caja → Apertura y cierre → abrir; Cobrar cuentas muestra solo cuentas enviadas sin pagar. Métodos e identidad se guardan como instantánea inmutable. NIT/CUI se validan en formato: **no se consulta el registro SAT ni se certifica identidad**.
3. Mixto: importe total Q40, tarjeta Q15, efectivo recibido Q30 → efectivo aplicado Q25 y cambio Q5. `tenderedCents` es la suma tarjeta + efectivo recibido. Columnas generadas de PostgreSQL derivan partes de pagos históricos sin reescribir sus asientos; arqueo usa exclusivamente `cash_cents`.
4. Cajero solicita cierre indicando efectivo contado. Caja queda suspendida para cobros, movimientos y cortesías. Administrador, desde su propia sesión con MFA, aprueba ese importe o rechaza con motivo. `closure_request_id` distingue solicitudes sucesivas: una aprobación atrasada no puede autorizar otra solicitud. Un administrador puede autorizar explícitamente un cierre directo sin solicitarse permiso a sí mismo.
5. Historial de ventas permite consultar cualquier pago mediante paginación estable y abrir su comprobante; desde historial siempre aparece **COMPROBANTE REIMPRESO**. Una segunda solicitud de impresión también se marca como copia en servidor, incluso concurrentemente. Se registra solicitud, no éxito de impresión física; imprimir mediante atajos del navegador fuera del botón no se puede auditar ni controlar.
6. Usuarios, Bitácora, Cortesías y Reportes financieros tienen navegación y permisos propios. Reportes usan días de Guatemala, intervalo inclusivo y snapshot consistente de DB. Gastos/mermas son registros financieros definitivos: no mueven caja ni stock. No duplicar una misma pérdida como gasto y merma. Se muestra ingreso cobrado, gasto registrado, merma, valor regalado y saldo parcial; no es un estado de resultados contable completo.

## Integridad y límites pendientes

Migración `010_checkout_control.sql`; endpoints en `server/checkout.ts` y cobro/cierre en `server/pos.ts`. Los nuevos permisos se asignan a ADMINISTRADOR/SUPERADMIN; MESERO recibe únicamente envío a caja. Roles personalizados deben recibir permisos explícitos según política, no heredan privilegios administrativos.

No hay PAN/CVV, credenciales FEL ni datos tributarios del emisor en Git. El log de impresión registra IDs/actor, no NIT/CUI ni cuerpo del documento. Un pedido API `documentKind: FACTURA` devuelve `FEL_NOT_CONFIGURED` antes de guardar cobro; `/api/fel/status` no declara emisor listo. El comprobante dice **No es factura fiscal**.

Pendientes: conector FEL real y pruebas de certificación/contingencia; reversos controlados de gastos/mermas y devoluciones; costos/impuestos/contabilidad; búsqueda avanzada del historial y retención de PII acordada; validación con impresora física, navegador Safari real, carga actualizada y dictamen independiente. La carga k6 previa no corresponde al nuevo flujo; se actualizó su escenario, no se afirma un resultado nuevo.

## Despliegue

010 se aplica por el migrador versionado al arrancar, preserva pagos anteriores y exige nueva API para cobrar/cerrar. **No revertir al backend anterior después de 010**: carece de envío y aprobador. Una corrección posterior debe ser hacia adelante, con migración nueva si procede. Durante el reemplazo de staging no realizar cobros: la instancia anterior puede rechazar operaciones al aplicarse las nuevas guardas. Publicación se registra en DEPLOYMENT.md solo después de comprobar checks y Render live.
