# Red del restaurante

## Topología propuesta

Internet → router/firewall → switch administrable → AP Wi-Fi y dispositivos cableados.
Router, switch, punto de acceso principal, caja y ONT/módem deben tener UPS dimensionado según consumo y autonomía probada.

| Segmento | Dispositivos | Acceso permitido |
| --- | --- | --- |
| POS | Tablets/meseros/caja | HTTPS hacia Render, DNS/NTP autorizados, impresora asignada |
| Cocina | KDS | HTTPS hacia Render, DNS/NTP; sin acceso a administración de equipos |
| Administración | Equipo gerencial | HTTPS POS; administración de red solo desde dispositivos autorizados |
| Invitados | Clientes | Solo internet, aislamiento entre clientes, sin acceso a LAN |
| Infraestructura | Router/AP/switch/impresoras | Administración restringida; impresoras sin acceso público |

Usar VLANs si el equipo las admite, reglas deny-by-default entre segmentos y firewall sin puertos entrantes al POS. Render sirve HTTPS público autenticado; no publicar PostgreSQL ni paneles de impresoras. Aplicar actualizaciones a router/AP, desactivar WPS y credenciales predeterminadas.

## Wi-Fi y direccionamiento

Preferir cable para caja y KDS. Wi-Fi 5 GHz/6 GHz según cobertura de dispositivos, WPA2-AES o WPA3, SSID exclusivo del personal. Medir cobertura/roaming en salón y cocina con equipos encendidos; interferencias y paredes afectan más que velocidad nominal. Separar capacidad de invitados y garantizar ancho de banda al POS.

DHCP central con reservas para impresoras y equipo fijo, subredes distintas por VLAN, no IP manual duplicada. DNS confiable con resolución redundante; permitir únicamente resolutores elegidos. NTP correcto es importante para dispositivos TOTP; el servidor valida con su hora, no con la hora del navegador.

## Pérdidas de conexión

El POS indica pérdida de conexión y bloquea confirmación/cobro. SSE reconecta con backoff exponencial y jitter, renueva sesión si hace falta, y recarga datos desde PostgreSQL. Prueba obligatoria: desconectar/reconectar tablet mientras cocina cambia un pedido. Una respuesta perdida puede corresponder a una operación confirmada: reintentar con la misma clave, consultar orden/pago y nunca asumir que falló solo por timeout.

No hay cola de ventas offline ni reconciliación de múltiples servidores locales. Considerar segunda conexión LTE/5G con failover y practicar un procedimiento manual de contingencia. Reingresar tickets manuales requiere control humano contra duplicados.

## Impresión y operación

Comprobante inicial usa impresión del navegador. No hay integración ESC/POS, cajón de efectivo ni impresión automática KDS. Reservar IP de impresora, restringir acceso a caja y verificar controlador/papel/tamaño en hardware real antes del piloto.

Prueba mensual de UPS, failover, recuperación DNS y restauración de conectividad. Objetivo inicial de operación: detectar pérdida en segundos, no aceptar confirmaciones ambiguas como ventas nuevas. Los tiempos reales de Internet/Render deben medirse en el local.
