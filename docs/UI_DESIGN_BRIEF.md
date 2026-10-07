# Sala Nativos — diseño operativo y coordinación

Solicitud del propietario: interfaz contemporánea y profesional, transiciones personalizadas, mesas visuales y restaurante de dos niveles.

## Reparto propuesto a Claude

Codex implementa en `codex/feature/two-level-floorplan`: `web/`, migración **005** (004 reservada al PR #4 de Claude), únicamente endpoints de catálogo/mesas en `server/pos.ts`, nuevas pruebas aisladas y E2E. No toca auth, mantenimiento, consulta KDS ni migración 004 de Claude. La rama se basa en la implementación publicada y es un PR apilado sobre #2. PR #4 se integra por separado tras su revisión: no bloquear ni sobrescribir sus mejoras.

Claude: revisar dirección visual, flujos, accesibilidad, contraste, claridad de estados, permisos y casos límite. Proponer observaciones en el issue/PR; puede aportar `docs/reviews/ui-floorplan-review.md` y pruebas en un archivo propio. No editar los mismos archivos de frontend mientras Codex implementa. Se solicita respuesta explícita: no se presume aprobación ni conversación en tiempo real.

## Experiencia

- Identidad: verde bosque, fondos marfil, acento ámbar; jerarquía editorial, navegación lateral desktop y compacta móvil, superficies limpias y estados inequívocos.
- Entrada del mesero: **Salón y mesas**. Selector Nivel 1 / Nivel 2, representación de mesas con sillas y capacidad, búsqueda y estados derivados de órdenes reales. No simular reservas ni ocupación física que el sistema todavía no conoce.
- Tocar una mesa abre un compositor con esa mesa preseleccionada; no crea órdenes vacías. Mantener explícita la confirmación a cocina y la idempotencia.
- Estado operativo: disponible = sin órdenes activas/no cobradas; en servicio = orden activa; por cobrar = todas entregadas y saldo pendiente. Una orden pagada pero no entregada sigue en servicio. No confundir stock con ocupación.
- El administrador configura nombre, nivel, capacidad, forma y orden visual. Las mesas existentes se conservan en nivel 1; no crear mesas inventadas en Render. Esperar croquis/cantidades reales para reproducir distribución física.
- Motion para React: transiciones breves de entrada/cambio de nivel, respuesta táctil, indicadores de selección. Respeto de reduced-motion; sin animaciones infinitas que distraigan, sin bloquear clics durante una coreografía.
- UX segura: borrador conservado al navegar, aviso antes de cambiar mesa con productos, no enviar offline, estados con texto y color, teclado y foco visible.

## Verificación

Pruebas de validación/DB/permisos/idempotencia de mesas; pruebas de estado derivado; E2E en desktop/tablet/mobile: crear mesa nivel 2, seleccionarla visualmente, generar orden correctamente asociada, ver actualización de estado, teclado/reduced-motion. Reejecutar el recorrido POS existente y revisar capturas reales. No presentar mockups como implementación ni staging como producción.
