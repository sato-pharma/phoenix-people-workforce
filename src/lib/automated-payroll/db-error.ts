import { logError } from "@/lib/observability/log";

/**
 * A DATABASE FAILURE BEHIND A REFUSAL IS LOGGED IN FULL AND NAMED ON SCREEN BY ITS CODE ONLY (payroll audit
 * 2026-11-14, findings 7 and 15). Refusals here used to end in the database's own text — "(duplicate key
 * value violates unique constraint …)", a relation name, a column list — which tells HR nothing and shows
 * them the table layout. The full error goes to the log, where whoever fixes it reads it; the screen gets
 * "database error 23505", enough to quote when reporting it.
 *
 * `error` may be a PostgREST error object (postgrest-js returns those as plain objects, not Errors), a
 * thrown Error, or a refusal this module already wrote — whose own "database error <code>" is carried
 * through rather than lost.
 */
export function databaseFailureNote(error: unknown, event: string): string {
  logError("Automated payroll: a database failure stopped an action", { labels: { event }, error });
  const code = databaseErrorCode(error);
  return code ? `database error ${code}` : "database error";
}

/** The SQLSTATE or PostgREST code of a database failure, or null when it carries none. */
export function databaseErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$|^PGRST\d+$/.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  // PGRST first: five capitals would otherwise match "PGRST" and drop the number.
  return /database error (PGRST\d+|[0-9A-Z]{5})/.exec(message)?.[1] ?? null;
}

/**
 * A PostgREST error that reached a route as it was thrown: a plain `{ code, message }` object, not an
 * Error. Exported for http.ts, which used to read it as "[object Object]".
 */
export function isPlainDatabaseError(error: unknown): error is { code: string; message?: string } {
  return (
    !(error instanceof Error) &&
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    databaseErrorCode(error) !== null
  );
}
