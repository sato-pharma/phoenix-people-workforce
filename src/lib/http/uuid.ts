/**
 * Is this string a uuid — asked by callers who are about to hand it to a uuid COLUMN.
 *
 * Postgres does not answer "no rows" for a malformed uuid. It raises 22P02
 * (`invalid input syntax for type uuid: "…"`) from the WHERE clause itself, before any row is
 * considered. That reaches a route as a PostgrestError, which toApiError correctly classifies as
 * INFRASTRUCTURE and reports as a 500 — so a caller who followed a stale or mistyped link is told
 * the system is broken rather than that the link is wrong.
 *
 * It is worse on a route that builds its own error response from `error.message` instead of
 * going through toApiError: 5 of the 18 routes guarded against this handed the caller the raw
 * Postgres sentence, naming the column type. That is precisely the leak toApiError's redaction
 * exists to prevent, and it is the strongest reason this guard is worth having.
 *
 * NOT a reason, although it reads like one: this does NOT pollute `app_error_events`. That table
 * is written by the CLIENT error reporter (app/api/errors/client/route.ts) — a server-side API
 * 500 never reaches it. Measured against production on 2026-09-05: four deliberate 500s on this
 * very route wrote no row, while the table was demonstrably live (5 rows in the preceding 48h).
 * Written down because the claim was made, believed, and only then checked; without this note
 * the next reader has to spend that search again to find out it is false.
 *
 * The check therefore belongs at the POINT OF USE, not in toApiError. 22P02 is raised by a
 * malformed integer or date just as readily as by a uuid, and a malformed value in an INSERT is a
 * 400, not a 404 — only the caller knows it is holding an identifier it was asked to look up.
 *
 * Guard sites reuse the not-found error they ALREADY raise for a well-formed id that matches no
 * row, so a malformed id and an absent one are indistinguishable to the caller. That is
 * deliberate: it adds no new way to probe for which ids exist.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID.test(value);
}
