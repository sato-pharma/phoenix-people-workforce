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

/**
 * True when a thrown value came from INFRASTRUCTURE (PostgREST/Postgres, Supabase Auth/Storage/
 * Functions, Node socket errors) rather than from our own domain code.
 *
 * This exists because message text alone cannot tell the two apart, and getting it wrong leaks
 * the schema to the caller. A PostgrestError reading `relation "public.salary_records" does not
 * exist` matches toApiError's "does not exist" branch and would be handed back as a 404 naming a
 * real table; `invalid input syntax for type uuid: "abc"` matches the "invalid " branch and
 * becomes a 400 naming a real column type. `instanceof Error` is not a filter either —
 * supabase-js >= 2 makes PostgrestError a genuine Error subclass (verified against 2.110.8).
 *
 * Hand-authored domain errors (`throw new Error("Vacation request was not found.")`) carry no
 * machine `code`/`details`/`hint`, so they are NOT infrastructure and keep their message. That is
 * the whole point: the user still gets the sentence we wrote for them, and never the one Postgres
 * wrote for us.
 */
export function isInfrastructureError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  // Our own ApiError is deliberate, already-sanitized output — never treat it as infrastructure.
  if (error instanceof ApiError) return false;

  const candidate = error as { code?: unknown; details?: unknown; hint?: unknown; name?: unknown };

  // PostgREST's signature fields. Nothing we throw by hand sets these.
  if (candidate.details != null || candidate.hint != null) return true;

  // Supabase error classes: PostgrestError, AuthError/AuthApiError, StorageApiError, Functions*Error.
  const name = typeof candidate.name === "string" ? candidate.name : "";
  if (/^(Postgrest|Auth|Storage|Functions)[A-Za-z]*Error$/.test(name)) return true;

  // SQLSTATE ("42P01", "23505"), PostgREST codes ("PGRST202") and Node errnos ("ECONNREFUSED").
  // Our own codes are lower_snake_case ("internal_error"), so they never match.
  const code = candidate.code;
  if (typeof code === "string" && /^(PGRST\d+|[0-9A-Z]{5}|E[A-Z]{3,})$/.test(code)) return true;

  return false;
}

/**
 * The message that may safely be shown to an API caller.
 *
 * Drop-in replacement for the `error instanceof Error ? error.message : fallback` idiom. Behaviour
 * is identical for every hand-authored error; it differs ONLY when the error came from
 * infrastructure, which is exactly the case that must not be echoed. The real text is still
 * available to the server log via describeUnexpectedError.
 */
export function clientSafeErrorMessage(error: unknown, fallbackMessage: string): string {
  if (isInfrastructureError(error)) return fallbackMessage;
  if (error instanceof Error) return error.message || fallbackMessage;
  return fallbackMessage;
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

  // Infrastructure errors are classified BEFORE the keyword branches below, never after.
  // Those branches match on message text, and a Postgres message reading `relation "public.x"
  // does not exist` or `invalid input syntax for type uuid` matches them — which is how raw
  // schema detail used to leave as a 404 or a 400. The caller's own fallbackMessage is what the
  // client sees; describeUnexpectedError(error) still carries the real code/details/hint to logs.
  if (isInfrastructureError(error)) {
    if (isStatementTimeoutError(error)) {
      return new ApiError(
        STATEMENT_TIMEOUT_API_ERROR.status,
        STATEMENT_TIMEOUT_API_ERROR.code,
        STATEMENT_TIMEOUT_API_ERROR.message,
      );
    }
    return new ApiError(500, "internal_error", fallbackMessage);
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
