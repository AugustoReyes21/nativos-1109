import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";

// A visual navigation transition, not an artificial network request or progress bar.
export function ModuleStage({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const [finished, setFinished] = useState(false);
  const body = useRef<HTMLFieldSetElement>(null);
  const active = !reduced && !finished;
  useEffect(() => {
    // A long previous module must not leave the new content/brand reveal off screen.
    body.current
      ?.closest("main")
      ?.scrollIntoView({ block: "start", behavior: "instant" });
  }, []);
  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => setFinished(true), 900);
    return () => window.clearTimeout(timer);
  }, [reduced]);
  useEffect(() => {
    if (!active) body.current?.focus({ preventScroll: true });
  }, [active]);
  return (
    <div
      className={`module-stage${active ? " is-transitioning" : ""}`}
      data-module={name}
    >
      {active && (
        <div
          className="module-curtain"
          role="status"
          data-testid="module-transition"
        >
          <div className="transition-signature" aria-hidden="true">
            <span className="signature-orbit" />
            <span className="signature-orbit second" />
            <span className="signature-n">N</span>
            <span className="signature-rule" />
            <span className="signature-wordmark">NATIVOS / 1109</span>
          </div>
          <span className="transition-caption">Abriendo {name}</span>
        </div>
      )}
      <fieldset
        className="module-body"
        ref={body}
        tabIndex={-1}
        disabled={active}
        aria-label={`Módulo ${name}`}
        inert={active}
        aria-hidden={active || undefined}
      >
        {children}
      </fieldset>
    </div>
  );
}
