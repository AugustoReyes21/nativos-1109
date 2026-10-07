# Seguridad

## Controles implementados

Argon2id (64 MiB, 3 iteraciones, paralelismo 1), contraseñas 12–128 caracteres. JWT HS256 de 5 minutos, issuer/audience/algoritmo explícitos, secreto independiente del cifrado MFA. Sesión absoluta de 12 horas verificada en DB por cada solicitud. Cookies HttpOnly, SameSite=Strict, Secure y prefijo __Host- en producción.

Refresh aleatorio de 256 bits, lookup por SHA-256 (hash de token de alta entropía, no hash de contraseña). Rotación en transacción con bloqueo de sesión, tokens usados retenidos para detectar reutilización y revocar la familia completa. Se conserva reemplazo cifrado para recuperar una respuesta perdida durante 5 minutos (roaming Wi-Fi o tablet suspendida) solo con la misma clave idempotente y token previo; cualquier otro replay revoca. El reemplazo se cifra con una subclave HKDF propia, no con la clave de los secretos MFA. El UUID de intento de refresh puede persistirse entre pestañas, nunca los tokens. Logout, logout-all, reset de contraseña y cambios administrativos revocan sesiones. JWT viejo pierde acceso tras revocación.

MFA TOTP de 6 dígitos/30 s, ventana ±1 paso, protección contra replay, secreto AES-256-GCM con nonce aleatorio. Administrador sin MFA recibe solo desafío de configuración de 5 minutos y no puede entrar al POS. Secreto se muestra una vez por desafío; al habilitarse nunca se vuelve a entregar. Ocho códigos aleatorios de recuperación, almacenados por hash y consumidos una sola vez. API de enrolamiento, regeneración y desactivación requiere contraseña; administrador no puede desactivar MFA.

CSRF: todas las mutaciones exigen Origin idéntico al configurado, Content-Type JSON, header X-CSRF-Protection y token firmado double-submit en X-CSRF-Token. `csrf-csrf` vincula el HMAC al refresh token, desafío MFA o binding anónimo aleatorio; autenticar/rotar cambia el binding. `GET /api/auth/csrf` entrega el token (no-store) y cookies HttpOnly/Secure/Strict con prefijo __Host- en producción. El cliente lo mantiene solo durante la petición y serializa mutaciones entre pestañas con Web Locks. CORS no usa wildcard. Helmet, CSP sin scripts inline, frame-ancestors none, HSTS en producción, nosniff, Referrer-Policy y Permissions-Policy. No se usa HTML sin escapar para contenido de usuario.

La protección de ráfaga previa a DB (`express-rate-limit`, 3000 solicitudes/10 s/IP/proceso) es una capa adicional, no sustituye los límites persistentes específicos de login/MFA/refresh/reset/admin. Reiniciar un proceso reinicia solo esta capa; las restricciones sensibles siguen en PostgreSQL. Se necesita protección perimetral para DDoS distribuido. Referencias de implementación: [csrf-csrf](https://github.com/Psifi-Solutions/csrf-csrf), [express-rate-limit](https://express-rate-limit.mintlify.app/reference/configuration).

El gate SARIF comprueba tanto `tool.driver.rules` como `tool.extensions[].rules` y falla ante warnings/errors o security-severity >= 4; metadatos ausentes no implican aprobación. No se añadieron exclusiones de reglas ni dismissals. Una primera ejecución verde era incorrecta: se documenta en TECHNICAL_AUDIT.md.

RBAC en backend; meseros solo consultan/modifican sus órdenes. Schemas strict rechazan campos adicionales. SQL parametrizado; los únicos identificadores dinámicos proceden de whitelist constante interna. No hay ejecución de comandos, uploads, NoSQL o fetch a URLs del usuario.

Límites persistentes en PostgreSQL: login con tres topes de fallos evaluados **antes** de Argon2 (10 por cuenta+IP/15 min, 100 por IP/15 min y 30 por cuenta/hora desde cualquier IP salvo `TRUSTED_LOGIN_IPS`, la IP del restaurante), de modo que un acierto tras alcanzar un tope también se rechaza; MFA por IP y desafío, setup/enrolamiento, refresh, recuperación por IP/cuenta, reset y endpoints administrativos. Considerar la IP compartida del restaurante al ajustar límites tras carga real. Trust proxy=1 solo para la topología Render documentada; no copiarlo a otra red sin verificar cadena de proxies.

Auditoría transaccional sin cuerpos de solicitud, contraseña, secretos, tokens o datos bancarios. Logs estructurados con ID generado en servidor, ruta sin query, método, duración y código. Cliente recibe error seguro + requestId, nunca stack/SQL. Correlación a servicio/DB se realiza por la bitácora de la transacción; no hay tracing distribuido todavía.

## Riesgos que no se consideran resueltos por compilar

- Revisión humana/Claude pendiente. CodeQL/Gitleaks/dependency audit son complementos, no certificación OWASP.
- SMTP requiere configuración y ensayo de entrega. La respuesta de forgot-password es genérica, pero entrega síncrona puede producir diferencias temporales: implementar outbox cifrado y worker antes de uso público amplio.
- Retención horaria (`server/maintenance.ts`): rate_limits vencidos, desafíos y resets vencidos hace más de 1 día, refresh tokens de sesiones vencidas hace más de 1 día, sesiones vencidas hace más de 30 días, idempotencia de más de 7 días y eventos de más de 1 día (se conserva el último). Nunca toca órdenes, pagos, caja ni bitácora.
- Eventos e idempotencia necesitan pruebas prolongadas. Se guarda únicamente hash del payload + UUID de intento en sessionStorage (ningún token/credencial/contenido del pedido); al recargar la misma pestaña se conserva el intento pendiente. Si se cierra la pestaña tras timeout, consultar órdenes antes de repetir. No prometer garantía exactly-once entre intentos con UUID distinto.
- Acceso DB de runtime y migrador comparten credenciales en la base inicial; antes de producción separar roles mínimos, hacer bitácora append-only y probar restauración.
- Seguridad de correo, DNS, proxy y backups depende del entorno aún no conectado.
- UI de gestión completa MFA/roles, cambio de contraseña autenticado y políticas de permisos más granulares pendientes.

## Secretos y respuesta a incidentes

`.env` está ignorado. GitHub CI escanea archivos y el historial con Gitleaks; acciones fijadas por SHA. Nunca publicar credenciales. Si aparece un secreto en GitHub, revocar/rotar en el proveedor y revisar usos; borrar el archivo no revoca el secreto. Rotación JWT invalida accesos; revocar sesiones fuerza nuevos logins. Rotación MFA exige estrategia de recifrado: no reemplazar clave sin conservar acceso seguro a la anterior durante migración.

Referencias: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).
# R2-01: límites de login antes de Argon2

Se comprueban fallos por cuenta+IP (10/15 min), IP (100/15 min) y cuenta global (30/h) antes de Argon2 y nuevamente antes de emitir sesión. Cada contraseña inválida incrementa las tres dimensiones en un único INSERT/UPSERT. Una contraseña correcta no evita un bloqueo ya vigente. No hay excepción de IP confiable: por defecto falla cerrado. Un ataque dirigido puede bloquear temporalmente una cuenta; permitir excepciones para red del restaurante requiere política y validación explícitas del proxy/IP, no un bypass automático. Se registra LOGIN_THROTTLED con hash de cuenta, nunca la contraseña.
# Falso positivo histórico de Gitleaks, revisión R2

El commit de revisión `ec491bac8c1f64c97df73b1c7886df7e0a615d64` agregó un secreto TOTP literal para la prueba de dos administradores en `tests/security/api-adversarial.test.ts:301`. Solo se usa para usuarios temporales en una DB local desechable; no es una credencial real y nunca se provisionó en Render. Se reemplazó por `new Secret({ size: 20 })` aleatorio. Como el historial de Claude se conserva sin force push, `.gitleaksignore` contiene únicamente el fingerprint exacto de aquella línea/commit/regla. No se excluyen archivos, patrones ni reglas; el resto del historial sigue escaneándose. Esta excepción revisada no cubre ninguna contraseña SMTP, API key ni secreto productivo. Imagen Gitleaks fijada por digest.
# Extensión SUPERADMIN y cortesías (2026-10-07)

Nuevo bloque caja010: `cash.close.approve` exclusivo de roles administrativos iniciales, comprobado en API y guarda de aprobación DB. Cajero solicita, administrador autoriza desde sesión propia MFA; no se comparten contraseñas. Un UUID evita aprobar solicitudes ya rechazadas/reemplazadas. Locks caja→orden y guardas de inserción impiden nuevos movimientos durante cierre pendiente. Historial/receptor requieren `payments.create`; finanzas `reports.read`/`finance.write`; usuarios y bitácora mantienen sus permisos. Los datos del receptor no van a logs de auditoría. NIT/CUI tienen validación de formato solamente; falta validación fiscal con el certificador. FEL falla cerrado antes de cobrar. Reimpresiones son append-only con exclusión concurrente; no se controla el diálogo/atajo nativo de la impresora.

MFA obligatorio basado en metadatos del rol en login, autenticación, refresh y desactivación. `roles.superadmin.manage` protege creación/modificación de SUPERADMIN también en backend; no basta ocultar opciones. Promoción operativa explícita posterior al despliegue compatible revoca sesiones/desafíos y queda auditada. El comando no genera ni muestra contraseñas. Cortesías requieren permiso propio, CSRF, motivo, idempotencia, versión y caja abierta; SQL impide exceder cantidades, alterar asientos o cobrar el bruto después de un regalo. No se permite cancelar después de autorizar cortesías; reversos contables pendientes. Detalles en MENU_AND_COURTESIES.md.
