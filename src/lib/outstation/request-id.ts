/**
 * The one parser for an outstation request id, from a route's `[id]` segment or a trip id's suffix.
 *
 * Only a positive safe integer written as plain digits counts. Until 2026-09-19 every outstation
 * `[id]` route checked `Number.isFinite(Number(rawId))`, which accepts `1.5`, `1e2`, `0x10`, `-3` and
 * even `""` (Number("") is 0) — so a malformed id reached the database and answered 404 or 500
 * instead of the route's own 400 (audit F-29). `outstationRequestIdFromTripId` already demanded a
 * positive integer; this is that rule, shared.
 *
 * Imports nothing, so client code can use it too.
 */
export function parseOutstationRequestId(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw);
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
