/**
 * Is this string a uuid — asked by callers who are about to hand it to a uuid COLUMN.
 *
 * Postgres does not answer "no rows" for a malformed uuid. It raises 22P02
 * (`invalid input syntax for type uuid: "…"`) from the WHERE clause itself, before any row is
 * considered. That reaches a route as a PostgrestError, which toApiError correctly classifies as
 * INFRASTRUCTURE and reports as a 500 — so a caller who followed a stale or mistyped link is told
 * the system is broken rather than that the link is wrong, and the fault lands in
 * `app_error_events` as a real one, raising the noise floor on the signal that is supposed to mean
 * something.
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
