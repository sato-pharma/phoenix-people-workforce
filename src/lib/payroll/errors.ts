export class PayrollConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "PayrollConflictError";
  }
}

export function isPayrollConflictError(error: unknown) {
  return (
    error instanceof PayrollConflictError ||
    (
      typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "PayrollConflictError" &&
      (error as { status?: unknown }).status === 409
    )
  );
}
