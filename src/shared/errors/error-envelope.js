export class CrewlineError extends Error {
  constructor({ code, layer, recoverable, message, details, cause }) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CrewlineError';
    this.code = code;
    this.layer = layer;
    this.recoverable = recoverable;
    this.details = details ?? {};
  }
}

export function toCrewlineError(input, fallback) {
  if (input instanceof CrewlineError) return input;
  return new CrewlineError({
    ...fallback,
    cause: input,
    message: fallback?.message ?? (input instanceof Error ? input.message : String(input))
  });
}
