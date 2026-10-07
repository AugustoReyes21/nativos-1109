# Sala Nativos — diseño operativo y coordinación

Solicitud del propietario: interfaz contemporánea y profesional, transiciones personalizadas, mesas visuales y restaurante de dos niveles.

## Reparto propuesto a Claude

Codex implementa en `codex/feature/two-level-floorplan`: `web/`, migraciones **005/006**, catálogo/mesas y snapshot de nivel en KDS/recibo en `server/pos.ts`, pruebas aisladas y E2E. PR #4 de Claude se integró mediante merge limpio en esta rama; no se reescribieron sus commits. Rama apilada sobre #2. Claude aceptó el reparto en [issue #5](https://github.com/AugustoReyes21/nativos-1109/issues/5), con revisión y pruebas de seguridad/accesibilidad en archivos propios.

Claude: revisar dirección visual, flujos, accesibilidad, contraste, claridad de estados, permisos y casos límite. Proponer observaciones en el issue/PR; puede aportar `docs/reviews/ui-floorplan-review.md` y pruebas en un archivo propio. No editar los mismos archivos de frontend mientras Codex implementa. Se solicita respuesta explícita: no se presume aprobación ni conversación en tiempo real.

## Experiencia

Actualización explícita del propietario: **selección exclusiva desde el primer clic**, aunque no exista orden. Se incorpora estado Reservada y lease backend antes de abrir el compositor; otro mesero no puede seleccionar ni crear por API directa mientras esté reservada/atendida. Reglas de vencimiento, liberación y revisión independiente en `TABLE_CLAIMS.md`. Esta actualización amplía el alcance original, que solo mostraba estado de órdenes.

- Identidad: verde bosque, fondos marfil, acento ámbar; jerarquía editorial, navegación lateral desktop y compacta móvil, superficies limpias y estados inequívocos.
- Entrada del mesero: **Salón y mesas**. Selector Nivel 1 / Nivel 2, representación de mesas con sillas y capacidad, búsqueda y estados derivados de órdenes reales. No simular reservas ni ocupación física que el sistema todavía no conoce.
- Tocar una mesa abre un compositor con esa mesa preseleccionada; no crea órdenes vacías. Mantener explícita la confirmación a cocina y la idempotencia.
- Estado operativo calculado por el servidor para todas las mesas, independiente del filtro de órdenes del mesero: disponible = sin órdenes activas/no cobradas; para servir = alguna LISTO; por cobrar = alguna entregada sin pago; en servicio = otras activas. Prioridad para servir > por cobrar > en servicio. Una orden pagada pero no entregada sigue en servicio. No confundir stock con ocupación. Mesero no recibe importes ni detalles ajenos.
- El administrador configura nombre, nivel, capacidad, forma y orden visual. Las mesas existentes se conservan en nivel 1; no crear mesas inventadas en Render. Esperar croquis/cantidades reales para reproducir distribución física.
- Motion para React: transiciones breves de entrada/cambio de nivel, respuesta táctil, indicadores de selección. Respeto de reduced-motion; sin animaciones infinitas que distraigan, sin bloquear clics durante una coreografía.
- UX segura: borrador conservado al navegar, aviso antes de cambiar mesa con productos, no enviar offline, estados con texto y color, teclado y foco visible.

## Verificación

Pruebas de validación/DB/permisos/idempotencia de mesas; pruebas de estado derivado; E2E en desktop/tablet/mobile: crear mesa nivel 2, seleccionarla visualmente, generar orden correctamente asociada, ver actualización de estado, teclado/reduced-motion. Reejecutar el recorrido POS existente y revisar capturas reales. No presentar mockups como implementación ni staging como producción.

## Primera entrega y límites

94 pruebas unitarias/API/DB pasan; 3 E2E pasan con flujo completo POS en desktop/tablet/mobile. Lint, typecheck, build y npm audit pasan (0 vulnerabilidades reportadas). JS inicial 120.41 KB gzip, CSS 5.71 KB gzip. Revisión independiente final aún pendiente. Implementación publicada en [PR #7](https://github.com/AugustoReyes21/nativos-1109/pull/7), todavía no desplegada en Render.

005 conserva mesas existentes en nivel 1, capacidad 4 y forma cuadrada por compatibilidad; administrador debe verificar datos reales. 006 conserva nombre/nivel al crear órdenes y los protege con trigger: renombrar una mesa no cambia un comprobante histórico. Backfill de órdenes anteriores usa metadatos actuales, pues el sistema no tenía historial de nombres/niveles. Migraciones transaccionales; no edición manual en Render.

No incluido: plano a escala/arrastrar posiciones, reservas, ocupación física, desactivar mesas o mover pedidos entre mesas. Se requiere croquis para reproducir distribución física. Borrador solo en memoria durante navegación; se avisa al cerrar/recargar con productos y no se guardan datos de pedidos ni credenciales en almacenamiento web. Al cambiar mesa con productos se pide confirmación. Cambiar de dispositivo no recupera borrador.
