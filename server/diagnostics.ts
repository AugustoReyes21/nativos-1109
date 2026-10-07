// Do not serialize raw errors: pg messages/details may contain submitted values.
export function diagnostic(error: unknown) {
  const obj =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const identifier = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_]{1,100}$/.test(value)
      ? value
      : undefined;
  return {
    errorType: error instanceof Error ? identifier(error.name) : "UnknownError",
    dbCode: identifier(obj.code),
    constraint: identifier(obj.constraint),
    routine: identifier(obj.routine),
    stack:
      error instanceof Error
        ? error.stack
            ?.split("\n")
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 12)
            .join("\n")
        : undefined,
  };
}
