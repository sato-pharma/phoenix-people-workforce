export class ApiError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function validationError(message: string, code = "invalid_request") {
  return new ApiError(400, code, message);
}

export function unauthorizedError(message = "Authentication is required.") {
  return new ApiError(401, "unauthenticated", message);
}

export function forbiddenError(message = "Forbidden.") {
  return new ApiError(403, "forbidden", message);
}

export function notFoundError(message: string, code = "not_found") {
  return new ApiError(404, code, message);
}

export function conflictError(message: string, code = "conflict") {
  return new ApiError(409, code, message);
}

/** Extract a human/loggable message from any thrown value — Error OR a plain
 *  PostgREST error object (`{ message, code, details, hint }`, which is NOT an Error). */
export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}

/**
 * True when a thrown value is a Postgres `statement_timeout` cancellation (SQLSTATE 57014).
 * Supabase/PostgREST surfaces this as a PLAIN object `{ code: "57014", message: "canceling
 * statement due to statement timeout" }` (not an Error), so match on both the code and the
 * message text. A timeout is a transient, user-actionable condition (narrow the query), NOT an
 * unexpected internal fault — callers should map it to 503, never an opaque 500.
 */
export function isStatementTimeoutError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "57014") return true;
  const message = errorMessageOf(error).toLowerCase();
  return message.includes("statement timeout") || message.includes("canceling statement");
}

/** Shared, client-friendly response for a database statement-timeout (see `isStatementTimeoutError`). */
export const STATEMENT_TIMEOUT_API_ERROR = {
  code: "statement_timeout",
  status: 503,
  message:
    "The report took too long and was canceled by the database. Apply at least one filter " +
    "(date range, line, region, requester…) to narrow the result set, then try again.",
} as const;

/** Compact, structured one-liner for server logs: surfaces the PostgREST code/details/hint that a
 *  bare `error.message` drops, so a production 500 can be diagnosed from the log alone. */
export function describeUnexpectedError(error: unknown): string {
  const e = error as { code?: unknown; details?: unknown; hint?: unknown } | null;
  return JSON.stringify({
    message: errorMessageOf(error),
    code: e?.code != null ? String(e.code) : undefined,
    details: e?.details != null ? String(e.details) : undefined,
    hint: e?.hint != null ? String(e.hint) : undefined,
  });
}

export function toApiError(error: unknown, fallbackMessage: string) {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof SyntaxError) {
    return validationError("Request body must be valid JSON.");
  }

  if (error instanceof Error) {
    const message = error.message || fallbackMessage;
    const normalized = message.toLowerCase();

    if (normalized.startsWith("forbidden:")) {
      return forbiddenError(message);
    }
    if (normalized.includes("was not found") || normalized.includes("does not exist")) {
      return notFoundError(message);
    }
    if (
      normalized.includes("cannot remove or deactivate the last active super admin") ||
      normalized.includes("cannot deactivate your own active account") ||
      normalized.includes("cannot downgrade your own role") ||
      normalized.includes("cannot elevate your own role") ||
      normalized.includes("cannot assign peer or higher-privilege roles") ||
      normalized.includes("cannot modify peer or higher-privilege accounts") ||
      normalized.includes("only super admin")
    ) {
      return conflictError(message, "governance_conflict");
    }
    if (
      normalized.includes("unexpected end of json input") ||
      normalized.includes("is not valid json") ||
      normalized.includes("invalid ") ||
      normalized.includes(" is required") ||
      normalized.includes("must be ") ||
      normalized.includes("unsupported")
    ) {
      return validationError(message);
    }
    if (normalized.includes("critical audit log could not be persisted")) {
      return new ApiError(500, "audit_persistence_failed", message);
    }

    return new ApiError(500, "internal_error", message);
  }

  return new ApiError(500, "internal_error", fallbackMessage);
}
