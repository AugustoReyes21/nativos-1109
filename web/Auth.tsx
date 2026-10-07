import { useState, type FormEvent } from "react";
import { api } from "./api";
import type { Action } from "./types";
type AuthResult = {
  mfaRequired?: boolean;
  setupRequired?: boolean;
  recoveryCodes?: string[];
};
export function Auth({
  enter,
  run,
  busy,
  resetToken,
}: {
  enter: () => Promise<void>;
  run: Action;
  busy: boolean;
  resetToken: string;
}) {
  const [stage, setStage] = useState(resetToken ? "reset" : "login");
  const [qr, setQr] = useState<{ qr: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void run(async () => {
      if (stage === "forgot") {
        const r = await api<{ message: string }>(
          "/auth/forgot-password",
          "POST",
          { email: f.get("email") },
        );
        setMessage(r.message);
        return;
      }
      if (stage === "reset") {
        await api("/auth/reset-password", "POST", {
          token: resetToken,
          password: f.get("password"),
        });
        setStage("login");
        setMessage("Contraseña actualizada");
        return;
      }
      const result =
        stage === "login"
          ? await api<AuthResult>("/auth/login", "POST", {
              email: f.get("email"),
              password: f.get("password"),
            })
          : await api<AuthResult>("/auth/mfa/verify", "POST", {
              code: f.get("code"),
            });
      if (result.setupRequired) {
        setQr(await api("/auth/mfa/setup", "POST", {}));
        setStage("setup");
      } else if (result.mfaRequired) setStage("mfa");
      else if (result.recoveryCodes) {
        setCodes(result.recoveryCodes);
        setStage("recovery");
        setQr(null);
      } else await enter();
    });
  };
  return (
    <section className="login-card">
      <div className="brand-mark">N</div>
      <p className="eyebrow">RESTAURANTE · POS</p>
      <h1>Nativos1109</h1>
      <p>Tu servicio, en orden.</p>
      {message && <p role="status">{message}</p>}
      {stage === "recovery" ? (
        <>
          <h2>Guarda tus códigos de recuperación</h2>
          <p>
            Cada código sirve una vez. Guárdalos en un lugar privado; no
            volverán a mostrarse.
          </p>
          <div className="codes">
            {codes.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </div>
          <button onClick={() => void run(enter)}>Ya guardé mis códigos</button>
        </>
      ) : (
        <form onSubmit={submit}>
          {["login", "forgot"].includes(stage) && (
            <label>
              Correo
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </label>
          )}
          {["login", "reset"].includes(stage) && (
            <label>
              {stage === "reset"
                ? "Nueva contraseña (mínimo 12 caracteres)"
                : "Contraseña"}
              <input
                name="password"
                type="password"
                minLength={stage === "reset" ? 12 : 1}
                maxLength={128}
                autoComplete={
                  stage === "reset" ? "new-password" : "current-password"
                }
                required
              />
            </label>
          )}
          {stage === "setup" && qr && (
            <>
              <h2>Protege tu cuenta</h2>
              <p>
                Escanea el QR con tu aplicación de autenticación y confirma el
                código.
              </p>
              <img className="qr" src={qr.qr} alt="QR de configuración MFA" />
              <details>
                <summary>Configurar manualmente</summary>
                <code data-testid="mfa-secret">{qr.secret}</code>
              </details>
            </>
          )}
          {["mfa", "setup"].includes(stage) && (
            <label>
              Código de autenticación o recuperación
              <input
                name="code"
                autoComplete="one-time-code"
                minLength={6}
                maxLength={64}
                required
              />
            </label>
          )}
          <button disabled={busy}>
            {busy
              ? "Verificando…"
              : stage === "forgot"
                ? "Enviar instrucciones"
                : stage === "reset"
                  ? "Cambiar contraseña"
                  : stage === "login"
                    ? "Iniciar sesión"
                    : "Verificar código"}
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setStage(stage === "login" ? "forgot" : "login");
              setQr(null);
            }}
          >
            {stage === "login"
              ? "Olvidé mi contraseña"
              : "Volver al inicio de sesión"}
          </button>
        </form>
      )}
    </section>
  );
}
