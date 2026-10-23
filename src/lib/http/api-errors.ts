import { logError } from "@/lib/observability/log";

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
 * Sentences only Postgres, PostgREST, Supabase or the network write — never our own prose.
 *
 * Each pattern is a phrase a hand-written domain message has no reason to use: they name the
 * schema (relations, columns, constraints, policies, types) or the transport. Matched anywhere in
 * the message, because a wrapper often prefixes its own words (`Save failed: duplicate key value…`).
 */
const INFRASTRUCTURE_TEXT_PATTERNS: readonly RegExp[] = [
  // Postgres always QUALIFIES or QUOTES the object (`relation "public.x"`, `column employees.y`,
  // `function public.f(uuid)`), which is what keeps our own "the column mapping does not exist" out.
  /\b(relation|column|function|table|schema|type|operator|constraint|sequence|view|index|role|extension)\s+("[^"]+"|[\w$]+\.[\w.$]+(\([^)]*\))?|[\w$]+\([^)]*\))\s+does not exist\b/i,
  /\bduplicate key value violates\b/i,
  /\bviolates (foreign key|unique|check|not-null|exclusion) constraint\b/i,
  /\bnull value in column\b/i,
  /\binvalid input (syntax|value) for (type|enum)\b/i,
  /\bpermission denied for (table|schema|relation|function|sequence|database|view)\b/i,
  /\bsyntax error at or near\b/i,
  /\bin the schema cache\b/i,
  /\bcould not find a relationship between\b/i,
  /\bJSON object requested, multiple \(or no\) rows returned\b/i,
  /\bcannot coerce the result to a single JSON object\b/i,
  /\bviolates row-level security policy\b/i,
  /\bvalue too long for type\b/i,
  /\bout of range for type\b/i,
  /\binfinite recursion detected in policy\b/i,
  /\bthere is no unique or exclusion constraint matching\b/i,
  /\bmore than one row returned by a subquery\b/i,
  /\bfailed to parse (select|filter|order|logic tree)\b/i,
  /\bcolumn reference "[^"]+" is ambiguous\b/i,
  /\bstructure of query does not match function result type\b/i,
  /\bcanceling statement due to\b/i,
  /\bPGRST\d{3}\b/,
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/,
  // undici's own words, alone or after a wrapper's colon — not our "Google Drive metadata fetch failed."
  /(^|:\s*)fetch failed\b/i,
  /\bupstream connect error\b/i,
  /\bremaining connection slots are reserved\b/i,
];

/** True when a message reads as database or transport text rather than a sentence we wrote. */
export function looksLikeInfrastructureText(message: string): boolean {
  if (!message) return false;
  return INFRASTRUCTURE_TEXT_PATTERNS.some((pattern) => pattern.test(message));
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

  const candidate = error as { code?: unknown; details?: unknown; hint?: unknown; message?: unknown; name?: unknown };

  // 🔴 A RE-WRAPPED database error has lost its fields but not its words. About 270 domain sites
  // do `throw new Error(error.message)`, which strips code/details/hint and used to sail past every
  // check below with Postgres's own sentence intact (technical audit 23 Oct 2026, F-19). Postgres
  // and PostgREST write in a recognisable voice, so the message is checked too.
  if (typeof candidate.message === "string" && looksLikeInfrastructureText(candidate.message)) return true;

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
 *
 * 🔴 **IT LOGS AS A SIDE EFFECT, so a caller that only wants to CLASSIFY an error must pass
 * `{ report: false }`** (2026-10-23). Redacting writes an `api_error_redacted` ERROR line and an
 * `app_error_events` row, which is right when the error is about to be returned to someone and
 * wrong when the caller is about to recover from it. `app/api/auth/login/route.ts` called this to
 * decide whether to repair the Supabase bridge, then repaired it and logged the person in — so a
 * SUCCESSFUL login left a `Failed to create Supabase auth session` row behind. Seven of them on
 * 23 Oct alone, six real people, every login succeeding 68–242 ms later; three cost an
 * investigation apiece, in the one table used to judge whether production is healthy.
 *
 * `report: false` changes nothing about the returned string — the redaction is identical. It
 * suppresses only the log, and the caller then reports on the path where recovery actually failed.
 */
export function clientSafeErrorMessage(
  error: unknown,
  fallbackMessage: string,
  options?: { report?: boolean },
): string {
  if (isInfrastructureError(error)) {
    if (options?.report !== false) reportRedactedError(error, fallbackMessage);
    return fallbackMessage;
  }
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

/**
 * 🔴 A HIDDEN ERROR STILL REACHES THE LOG. Redacting the caller's copy used to be the only thing that
 * happened to it, so a page or route that never logged turned a real database failure into the
 * fallback sentence and nothing else — no line, no app_error_events row (risk review of #6295,
 * 2026-10-23). A route that already logs will now log twice; one extra line is the cheap side.
 */
function reportRedactedError(error: unknown, fallbackMessage: string) {
  logError(`API error hidden from the caller: ${fallbackMessage}`, {
    labels: { event: "api_error_redacted" },
    error,
    context: { detail: describeUnexpectedError(error) },
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
    reportRedactedError(error, fallbackMessage);
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
