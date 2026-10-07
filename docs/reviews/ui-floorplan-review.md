# Revisión independiente — PR #7 “Sala Nativos: mesas visuales y dos niveles”

- Fecha: 2026-10-07 · Revisor: Claude · Commit revisado: `c2444a9` · Rama: `claude/review/floorplan`
- Método: lectura de `server/pos.ts`, migraciones 005/006, `web/FloorPlan.tsx`, `web/NewOrder.tsx`, `web/main.tsx` y `web/experience.css`; ejecución contra PostgreSQL 17 propio; app compilada en local con 12 mesas en dos niveles y órdenes de dos meseros; capturas con Playwright en 1440×900, 1180×820 y 390×844; axe-core 4 en cada pantalla.

## Veredicto

**Base sólida, todavía no lista para fusionar.** El servidor está bien resuelto y verificado. Antes de fusionar faltan: el requisito nuevo del propietario (una mesa tomada por un mesero no la puede seleccionar otro), las violaciones serias de accesibilidad, y llevar las animaciones al nivel que pidió el propietario.

## Verificado y correcto

| Área | Evidencia |
| --- | --- |
| Lint, typecheck, `npm audit`, build | limpios; JS inicial 120 KB gzip (presupuesto 200 KB) |
| Suite del PR | 94/94 en PostgreSQL real |
| Estado de mesa en servidor (D1) | `tests/security/floors.test.ts`: el mesero B ve la mesa de A como “en servicio”, sin `pendingCents`, sin el id ni el detalle de la orden; A la ve como `mine`; el cajero ve el importe pendiente |
| Ciclo de estados y prioridad (D2) | disponible → en servicio → para servir → por cobrar → disponible, comprobado de punta a punta con cocina, mesero y cajero |
| Nivel en cocina y comprobantes (D4) | `table_floor` en `/api/orders` y en el comprobante; prueba |
| Historial inmutable (D5) | renombrar o mover una mesa no reescribe órdenes enviadas; `UPDATE` directo del snapshot → 23514 |
| Administración de mesas | mesero, cajero y cocina → 403 en crear y editar; 8 entradas inválidas → 400 (nivel 3, capacidad 0/13, forma desconocida, `active`/`version` extra, vacío, NUL); versión vieja → 409; auditoría con detalles |
| Rendimiento | `GET /api/tables/status` 0,2–0,4 ms con 200 000 órdenes históricas; la migración 006 rellena 200 000 órdenes en ~3 s |
| CSP | intactas: la inyección de scripts inline (axe) quedó bloqueada por `script-src 'self'` hasta usar `bypassCSP` en el contexto de prueba |

## Hallazgos

### UI-01 MAJOR — Requisito del propietario: bloqueo de mesa por mesero
Pedido del propietario: “si un mesero la seleccionó, que otro no la pueda seleccionar aunque no hayan hecho una orden”. En las capturas, a Ana se le ofrece “Abrir pedido” en la Mesa 3 y la Mesa 8, que atiende Luis. `NewOrder.tsx` solo avisa y crea una orden adicional, y el selector “Mesa” del compositor permite cambiar a cualquier mesa. Contrato propuesto en #5 (asignación con reserva que expira, claim atómico, `POST /api/orders` → 409, transferencia por administrador). Se aplica en el servidor; la UI solo lo refleja.

### UI-02 MAJOR — Accesibilidad (axe, impacto *serious*)
- `label-content-name-mismatch` (8 por pantalla): el `aria-label` de las mesas y de los botones de nivel no contiene el texto visible (“Abrir pedido”, “Nivel 1 Planta baja”). El control por voz no los activa. Corrección: incluir el texto visible en el nombre accesible o usar `aria-describedby` para el estado.
- `color-contrast` (hasta 7 por pantalla, ratios 3,84–4,48 < 4,5): `.nav-caption` #777f6e, `.nav-signature span` #8e7958, `.nav-signature small` #7a847b, `.eyebrow` #7b725a, `.page-description` #68756e, `.floor-footnote` #717969. Además miden 9,6–12,8 px: en una tablet a la distancia de servicio conviene un mínimo de 12–13 px.

### UI-03 MAJOR (alcance pedido) — Animaciones por debajo de lo solicitado
El propietario pidió una interfaz “innovadora, con transiciones personalizadas y animaciones”. Hoy hay un fundido de 180 ms al cambiar de nivel y un `scale(0.98)` al tocar. Propuestas que respetan tus reglas (sin bucles infinitos, sin bloquear clics, `reduced-motion`):
- Cambio de nivel con dirección (`AnimatePresence` + `custom`: de 1→2 desliza a la izquierda y de 2→1 a la derecha), y swipe horizontal en tablet.
- Mesa → compositor como elemento compartido (`layoutId` en el dibujo de la mesa).
- Cambio de estado animado: cruce de color y un pulso finito (2 ciclos) al pasar a “Para servir”, que es lo que el mesero debe notar.
- Entrada escalonada de tarjetas (30–40 ms), cifras del resumen que ruedan al cambiar, check animado al confirmar envío a cocina y al cobrar.

### UI-04 MINOR — Fondo de la barra lateral cortado
En escritorio y tablet, el fondo de la barra lateral termina a mitad de página (~830–900 px) al hacer scroll. Sugerencia: `position: sticky; height: 100dvh` o fondo en el contenedor de la grilla.

### UI-05 MINOR — Sin tema oscuro ni fuente propia
No hay `prefers-color-scheme` ni `@font-face`: la tipografía depende del sistema de cada tablet (aspecto distinto entre Android, iPad y Windows). Autoalojar la fuente (`@fontsource-variable/*`; COEP/CSP exigen mismo origen). El modo oscuro es especialmente útil en cocina.

### UI-06 — Segunda entrega acordada (no bloquea)
D3 (posiciones x/y y modo “Editar plano”) y D6 (desactivar o reactivar mesas) quedan para la siguiente entrega; hoy el plano es una distribución automática, como indica el pie. Requiere el croquis real del propietario.

## Pruebas aportadas
- `tests/security/floors.test.ts` (7 pruebas, todas pasan sobre `c2444a9`).
- Las capturas y el script de axe se ejecutaron localmente (no se versionan). Se recomienda incorporar `@axe-core/playwright` al E2E como criterio permanente.
