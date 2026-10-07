# Seguridad

## Controles implementados

Argon2id (64 MiB, 3 iteraciones, paralelismo 1), contraseñas 12–128 caracteres. JWT HS256 de 5 minutos, issuer/audience/algoritmo explícitos, secreto independiente del cifrado MFA. Sesión absoluta de 12 horas verificada en DB por cada solicitud. Cookies HttpOnly, SameSite=Strict, Secure y prefijo __Host- en producción.

Refresh aleatorio de 256 bits, solo SHA-256 almacenado (hash de token de alta entropía, no hash de contraseña). Rotación en transacción con bloqueo de sesión, tokens usados retenidos para detectar reutilización y revocar la familia completa. Logout, logout-all, reset de contraseña y cambios administrativos revocan sesiones. JWT viejo pierde acceso tras revocación.

MFA TOTP de 6 dígitos/30 s, ventana ±1 paso, protección contra replay, secreto AES-256-GCM con nonce aleatorio. Administrador sin MFA recibe solo desafío de configuración de 5 minutos y no puede entrar al POS. Secreto se muestra una vez por desafío; al habilitarse nunca se vuelve a entregar. Ocho códigos aleatorios de recuperación, almacenados por hash y consumidos una sola vez. API de enrolamiento, regeneración y desactivación requiere contraseña; administrador no puede desactivar MFA.

CSRF: todas las mutaciones exigen Origin idéntico al configurado, Content-Type JSON y header X-CSRF-Protection. CORS no usa wildcard. Helmet, CSP sin scripts inline, frame-ancestors none, HSTS en producción, nosniff, Referrer-Policy y Permissions-Policy. No se usa HTML sin escapar para contenido de usuario.

RBAC en backend; meseros solo consultan/modifican sus órdenes. Schemas strict rechazan campos adicionales. SQL parametrizado; los únicos identificadores dinámicos proceden de whitelist constante interna. No hay ejecución de comandos, uploads, NoSQL o fetch a URLs del usuario.

Límites persistentes en PostgreSQL: login por IP y cuenta, MFA por IP y desafío, setup/enrolamiento, refresh, recuperación por IP/cuenta, reset y endpoints administrativos. Considerar la IP compartida del restaurante al ajustar límites tras carga real. Trust proxy=1 solo para la topología Render documentada; no copiarlo a otra red sin verificar cadena de proxies.

Auditoría transaccional sin cuerpos de solicitud, contraseña, secretos, tokens o datos bancarios. Logs estructurados con ID generado en servidor, ruta sin query, método, duración y código. Cliente recibe error seguro + requestId, nunca stack/SQL. Correlación a servicio/DB se realiza por la bitácora de la transacción; no hay tracing distribuido todavía.

## Riesgos que no se consideran resueltos por compilar

- Revisión humana/Claude pendiente. CodeQL/Gitleaks/dependency audit son complementos, no certificación OWASP.
- SMTP requiere configuración y ensayo de entrega. La respuesta de forgot-password es genérica, pero entrega síncrona puede producir diferencias temporales: implementar outbox cifrado y worker antes de uso público amplio.
- Sin política de retención/limpieza automática de desafíos, rate_limits, eventos y tokens. No eliminar tokens usados antes de expirar su sesión; rompería detección de reutilización.
- Eventos e idempotencia necesitan pruebas prolongadas. Se guarda únicamente hash del payload + UUID de intento en sessionStorage (ningún token/credencial/contenido del pedido); al recargar la misma pestaña se conserva el intento pendiente. Si se cierra la pestaña tras timeout, consultar órdenes antes de repetir. No prometer garantía exactly-once entre intentos con UUID distinto.
- Acceso DB de runtime y migrador comparten credenciales en la base inicial; antes de producción separar roles mínimos, hacer bitácora append-only y probar restauración.
- Seguridad de correo, DNS, proxy y backups depende del entorno aún no conectado.
- UI de gestión completa MFA/roles, cambio de contraseña autenticado y políticas de permisos más granulares pendientes.

## Secretos y respuesta a incidentes

`.env` está ignorado. GitHub CI escanea archivos y el historial con Gitleaks; acciones fijadas por SHA. Nunca publicar credenciales. Si aparece un secreto en GitHub, revocar/rotar en el proveedor y revisar usos; borrar el archivo no revoca el secreto. Rotación JWT invalida accesos; revocar sesiones fuerza nuevos logins. Rotación MFA exige estrategia de recifrado: no reemplazar clave sin conservar acceso seguro a la anterior durante migración.

Referencias: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).
