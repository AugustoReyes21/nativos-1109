# Arquitectura

Estado: primera implementación; revisión cruzada pendiente.

## Componentes

Sala de dos niveles (PR #7): `restaurant_tables` guarda nivel, capacidad, forma y orden visual; versión optimista evita sobrescribir cambios administrativos concurrentes. `GET /api/tables/status` expone estado operativo global mínimo con autorización `orders.read`, separado de detalles de órdenes restringidos al mesero. Solo `payments.create` obtiene pendientes monetarios. SSE dispara recarga del catálogo/estado. `FloorPlan.tsx` renderiza SVG nativo y Motion; no depende de imágenes remotas ni fuentes externas. El borrador vive en App, no en web storage.

006 fija `orders.table_name/table_floor` al insertar, bajo lock compartido de mesa; trigger impide modificación posterior, incluso por SQL directo. KDS/recibo usan snapshot y no nombre actual. Backfill de historial previo con valores actuales, documentado; ninguna migración aplicada se reescribe.

React/Vite sirve una SPA desde Express en el mismo origen HTTPS. Express valida inputs con Zod, autentica cookies y consulta permisos vigentes en PostgreSQL antes de las operaciones. PostgreSQL es la autoridad para inventario, estados, pagos y caja. No hay almacenamiento de tokens en localStorage/sessionStorage, uploads ni acceso a URLs suministradas por usuarios.

Módulos: `config.ts` valida configuración; `auth.ts` maneja sesiones/MFA; `pos.ts` maneja catálogo/órdenes/caja; `db.ts` delimita transacciones; `common.ts` centraliza errores, auditoría e idempotencia; `app.ts` aplica protección web y SSE. React se divide por flujo funcional. El diseño aún admite separar servicios cuando crezca; evitar capas sin beneficio verificable.

## Invariantes

- Dinero entero en centavos de quetzal. No hay cálculos monetarios con decimales en DB/API. El cliente no determina el total de venta.
- Stock no negativo, límites de cantidades, FK, UNIQUE y CHECK en DB.
- Crear/confirmar orden es una única transacción: bloquea productos ordenados por UUID, valida disponibilidad, reserva stock, copia nombre/precio, registra orden/items/auditoría/evento.
- El carrito permite editar cantidades/notas antes de confirmar. Una orden confirmada no permite cambios arbitrarios de precio/items. Ampliaciones posteriores deben ser otra orden; edición de órdenes enviadas pendiente.
- Idempotency-Key UUID + usuario + operación + hash del input validado. Bloqueo advisory transaccional serializa reintentos; un payload diferente devuelve 409. Se conserva la respuesta original.
- Ajustar disponibilidad requiere versión vigente; un cambio de stock concurrente invalida una edición administrativa vieja.
- Cobro: bloquear caja abierta, después orden; UNIQUE(order_id), insertar pago, auditoría y evento atómicamente. Cierre usa el mismo bloqueo de caja, suma solo efectivo y movimientos, registra diferencia.
- Una sola caja física abierta. El propietario o administrador pueden operar; no representa múltiples sucursales/cajas.
- Estados: PENDIENTE → EN_PREPARACION → LISTO → ENTREGADO. Cancelar requiere permiso y orden no pagada. Solo cancelación PENDIENTE reintegra inventario; comida preparada no se vuelve vendible automáticamente.

## Tiempo real y red

SSE autenticado publica únicamente una revisión sin datos sensibles. Cada conexión consulta cada 2 segundos la revisión persistente, y revalida su sesión. React recarga snapshots autorizados al conectar o cambiar revisión. Reconexión exponencial (1–30 s + jitter); el JWT vencido se renueva mediante cookies. Se serializa refresh entre pestañas con Web Locks. No existe venta offline; el estado desconectado bloquea acciones principales.

Coste actual: dos consultas por conexión cada 2 segundos. Adecuado para un primer piloto pequeño, sujeto a carga medida; sustituir por LISTEN/NOTIFY y outbox cuando el número de dispositivos lo justifique. Snapshot incluye todas las órdenes activas/no cobradas, más las 200 finalizadas más recientes de las últimas 24 horas; paginación de historial completo pendiente. Las activas nunca se truncan detrás del historial.

## Evolución

Roles y permisos están en tablas, sin enum cerrado en autenticación. Los endpoints comprueban permisos centralizados. MFA obligatorio está asociado actualmente al rol ADMINISTRADOR; antes de añadir roles privilegiados equivalentes, convertir esa política a `roles.mfa_required`. La interfaz ofrece cuatro roles iniciales; editor de roles/permisos pendiente de revisión de elevación de privilegios.
# Extensión: menú y cortesías (2026-10-07)

Extensión de caja posterior: `server/checkout.ts` concentra envío a caja, solicitudes de autorización, historial paginado, impresión auditada y finanzas parciales; `pos.ts` conserva transacciones de cobro/cierre. Migración010 agrega instantánea del receptor y partes de pago generadas, sin mutar asientos históricos. `web/Cashier.tsx`, `CheckoutForm.tsx`, `Receipt.tsx` y `Backoffice.tsx` separan responsabilidades de UI y navegación. La cola de caja es independiente del estado de cocina. Contratos, decisiones y FEL bloqueado en [CASHIER_FEL.md](CASHIER_FEL.md).

Migraciones 008/009: catálogo importado con códigos únicos y stock inicial 0; política `roles.requires_mfa` para ADMINISTRADOR/SUPERADMIN; ledger append-only por unidades de producto. El bruto histórico no cambia; pagos y caja trabajan con el neto. Locks caja → orden serializan cobro, cortesía y cierre. Liquidación total `CORTESIA` de importe 0 no agrega efectivo. Contrato y límites en [MENU_AND_COURTESIES.md](MENU_AND_COURTESIES.md).
