# Selección exclusiva de mesas

Requisito explícito del propietario, 2026-10-07: seleccionar una mesa debe impedir que otro mesero la seleccione, incluso antes de existir una orden. Coordinación enviada a Claude en issue #5; implementación en PR #7. No sustituye reservas de comensales ni registro de ocupación física.

## Comportamiento

- Seleccionar en plano, lista o selector adquiere una reserva en PostgreSQL **antes** de abrir/cambiar el compositor. No crea orden vacía ni descuenta inventario.
- Un único propietario por mesa, identificado por usuario y sesión. Otro mesero —u otra sesión de la misma cuenta— recibe `409 TABLE_IN_USE`. No existe bypass automático de administrador.
- Arrendamiento de 5 minutos desde adquisición/última renovación; cliente renueva cada 60 segundos si está conectado, visible y recibió interacción en los últimos 4 minutos. Una pestaña abierta pero abandonada deja de renovar; tras la última renovación se conserva un margen de 5 minutos. Pestañas ocultas/cerradas y dispositivos sin red no renuevan. No equivale a liberar exactamente 5 minutos después del último clic.
- Navegar a órdenes/salón conserva borrador y reserva mientras se continúa trabajando. **Descartar borrador y liberar mesa** libera explícitamente. Cambiar mesa adquiere destino/libera origen en una sola transacción; si destino está ocupado conserva origen y productos.
- Logout/revocación/expiración de sesión invalida la reserva sin esperar su plazo. Cerrar una pestaña sin logout depende del vencimiento; no se confía en `beforeunload`/`sendBeacon` para mutaciones críticas.
- Confirmar libera la reserva temporal en la transacción de la orden. Las órdenes abiertas mantienen exclusión por usuario hasta quedar entregadas y pagadas, o canceladas. Pedidos pagados pendientes de servir y pedidos entregados sin cobrar siguen bloqueando a otros meseros.
- Si vence antes de confirmar, se conserva el borrador pero se exige reservar nuevamente. No se envía sin conexión ni se promete conservación del borrador tras recargar.

## API e integridad

Migración 007: `table_claims`, PK por `table_id`, FK a mesa/usuario/sesión, UUID de generación y vencimiento en reloj de DB. Todas las operaciones toman primero locks de mesa, ordenados por UUID cuando hay cambio de mesa, y luego evalúan propietario/órdenes. `POST /orders` usa el mismo lock: la carrera orden directa vs selección tampoco permite apropiación simultánea.

- `POST /api/tables/:id/claim`: `{claimId, previous?: {tableId, claimId}}`.
- `POST /api/tables/:id/claim/renew` y `/release`: `{claimId}`. Permiso `orders.create`, autenticación, CSRF y Zod estrictos en todos.
- Renew exige propietario/sesión/generación vigente. Release de otra generación/usuario es no-op, nunca libera al nuevo propietario. Repetir adquisición vigente con mismo UUID es seguro; no se reutiliza una generación vencida que siga siendo la registrada.
- `GET /api/tables/status`: agrega `reserved`, `blocked`, `claimId` (solo propietario de la sesión), `claimExpiresAt`. No expone nombre/ID de otro mesero ni contenido de sus órdenes. SSE comunica adquisición/liberación; consulta de estado cada 15 segundos recoge expiraciones/revocaciones, sin scheduler adicional. DB decide aunque una pantalla esté desactualizada.
- UI envía `claimId` al crear orden, comprobando vigencia/generación. Clientes anteriores que crean directamente no necesitan selección previa, pero se les exige el mismo chequeo de reservas ajenas y órdenes abiertas. No hay ruta alternativa para evadir exclusión.
- El identificador de reserva **no** cambia la clave/huella idempotente del pedido. Se conserva orden canónico anterior de campos: reintentar con nueva reserva después de perder respuesta devuelve la orden previa, no otra venta.
- Auditoría: `TABLE_CLAIMED`/`TABLE_RELEASED` con identidad, recurso y request ID; renovaciones no generan spam de bitácora. Tabla de reservas acotada a una fila por mesa.

## Verificación y pendientes

`tests/table-claims.test.ts`: carrera de selecciones, RBAC/CSRF, peticiones directas, replay, renovación/liberación ajena, expiración, generación vieja, cambio atómico, logout, persistencia de exclusión tras confirmar, idempotencia entre generaciones y selección vs creación directa.

`e2e/table-claims.spec.ts`: dos sesiones reales de mesero, cero órdenes existentes, bloqueo visual/backend, liberación y siguiente propietario, en desktop/tablet/mobile. Se reejecuta además el recorrido completo POS de `e2e/pos.spec.ts`.

Pendiente independiente: revisión de Claude y su archivo propio `tests/security/table-claims-review.test.ts`; no afirmar aprobación ni despliegue anticipadamente. Traslado administrativo de órdenes/meseros, política de cambio de turno y desbloqueo administrativo auditado no incluidos en este bloque. Historial previo con órdenes abiertas de varios meseros requiere conciliación: todos los propietarios verán bloqueo para nuevos pedidos hasta cerrar el servicio existente; no se reasigna silenciosamente.
