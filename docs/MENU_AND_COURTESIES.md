# Menú, superadmin y cortesías — 2026-10-07

## Fuente e inventario

Fuente local: `MENU NATIVOS.pdf`, 2 páginas, SHA-256 `ea1de3015cf78525d41d6a773958ed483958df4b2aefe347d9ec86aa8337ee71`. Se inspeccionó visualmente la primera página; la segunda contiene identidad/redes. El PDF original pertenece al usuario y no se incorpora al repositorio. No se infieren ingredientes del nombre «Frappé mania».

La migración 008 carga 20 productos en cinco categorías, precios GTQ en centavos y descripciones legibles. El propietario confirmó **stock inicial 0**. Administración → Productos y mesas → Disponibilidad diaria permite registrar cantidades reales; stock 0 aparece agotado y la API impide venderlo. La importación no cambia stock ni precio de coincidencias existentes por nombre/categoría, y rechaza coincidencias ambiguas. Los códigos `NAT-*` son únicos. Reejecutar migraciones no reinicializa existencias.

| Categoría | Productos y precios Q |
| --- | --- |
| Frappés | Moka 25; Oreo 30; chocolate 25; mania 30 |
| Smoothies con leche | Fresa 30; mora 30 |
| Smoothies enchamolados | Fresa, pepino, piña y sandía: 35 cada uno |
| Especiales | Tostada de tinga de pollo 35; pan con carne 35; tacos de birria, hamburguesa, quesabirria y quesadilla de carne asada: 40 cada uno |
| Crepas | Banano 30; mixta 35; melocotón 35; fresa 40 |

## Acceso del propietario

Correo confirmado: `reyessamayoa8@gmail.com` (no `gamil.com`). `SUPERADMIN` tiene todos los permisos actuales, incluyendo operación de mesero, caja, cocina y administración; `roles.superadmin.manage` impide que un administrador ordinario cree, degrade o bloquee cuentas superadmin. Nuevas migraciones de permisos deben asignarlos explícitamente al rol. La política MFA reside en `roles.requires_mfa`, no depende de comparar un solo nombre de rol.

La migración no cambia automáticamente cuentas: hacerlo mientras una instancia antigua solo exige MFA a ADMINISTRADOR introduciría una brecha. Tras revisión y despliegue compatible, ejecutar en el entorno objetivo:

```sh
npm run db:promote-owner -- reyessamayoa8@gmail.com --apply
# Imagen compilada: node dist/server/promote-owner.js reyessamayoa8@gmail.com --apply
```

El comando exige cuenta existente activa, valida rol con MFA, bloquea concurrentemente con la administración de usuarios, registra `ROLE_CHANGED`, revoca sesiones/desafíos y no cambia contraseña ni crea usuarios. Repetirlo es no-op. El propietario debe volver a iniciar sesión y completar MFA. No bajar a una versión anterior sin soporte SUPERADMIN/MFA; cualquier reversión requiere un procedimiento explícito de roles y sesiones, no un rollback ciego.

## Cortesía parcial o total

En Órdenes → Autorizar cortesía, administrador/superadmin elige cantidades y escribe un motivo (3–300 caracteres). Se requiere caja abierta y conexión. Mesero/cajero ordinarios no autorizan regalos. Confirmación final explícita antes de enviar.

- `orders.total_cents` conserva el consumo bruto histórico. `courtesy_cents` deriva del registro inmutable `order_courtesies`; no se aceptan precios ni importes del cliente.
- Cada autorización registra productos/cantidades, motivo, usuario, fecha y caja. Bitácora transaccional `COURTESY_AUTHORIZED` incluye request ID/contexto de la solicitud.
- SQL bloquea caja → orden, verifica permiso, cantidades acumuladas y estado. No se regala dos veces la misma unidad, no se autoriza después de pago/cancelación; versión e idempotencia protegen reintentos/concurrencia.
- El saldo se cobra por efectivo/tarjeta/transferencia. Si se regala todo, en la misma transacción se registra liquidación `CORTESIA`, importe 0, sin entrada de efectivo. No puede cobrarse otra vez.
- El stock consumido **no se devuelve**. Cocina continúa su flujo y la mesa permanece ocupada hasta entregar; regalar no implica preparar ni entregar automáticamente.
- Las autorizaciones son definitivas: no se borran ni se modifica/cancela una orden con cortesía. UI lo avisa antes de confirmar. Una futura reversión exigirá un asiento compensatorio y política separada; no existe todavía.
- Recibo interno muestra consumo, cortesías y cobro neto. Administración muestra las últimas 100 autorizaciones con motivo/autor; ventas agrupa ingresos netos, distinguiendo liquidaciones por cortesía. No es un sistema fiscal ni un reporte contable ilimitado.

## Verificación y límites

`tests/menu-courtesies.test.ts`: precios/stock, MFA y permisos, promoción idempotente, caja/motivo, neto/recibo, concurrencia, invariantes SQL y auditoría. `e2e/courtesies.spec.ts`: configuración desde administración y cortesía parcial/total en escritorio/tablet/móvil, sin inventar dinero ni reponer stock. Consultar TESTING.md para resultado de la ejecución final.

Estado: publicado en Render el 2026-10-07, commit `b43bf89`, por autorización del propietario. Menú verificado: 20 productos a stock 0; correo confirmado promovido a SUPERADMIN con MFA conservado y sesiones revocadas. No hay mesas reales configuradas todavía. Evidencia y límites en DEPLOYMENT.md. La revisión independiente financiera y las mejoras adicionales de UX permanecen abiertas.
