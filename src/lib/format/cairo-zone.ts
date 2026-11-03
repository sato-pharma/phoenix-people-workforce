// Africa/Cairo's UTC offset, answered from a table that ships with the code rather than from the
// reader's browser.
//
// THE BUG THIS EXISTS TO STOP. `Intl.DateTimeFormat` with `timeZone: "Africa/Cairo"` asks the
// engine what Egypt's offset was at that instant, and the engine answers from whatever timezone
// data it was built with. Egypt abolished daylight saving in 2014 and REINTRODUCED IT IN 2023, so
// a browser built between those dates renders every Cairo timestamp an hour early for roughly half
// of each year. Half this app's Cairo timestamps live inside `"use client"` components, which means
// Node renders the text and the browser renders it again on hydrate — and one digit apart is React
// hydration error #418, which throws the server's HTML away.
//
// Measured in production 2026-09-11: one District Sales Manager on Samsung Internet 20 (Chrome 106,
// built September 2022) accounted for EVERY remaining #418 on the platform. Her engine puts Cairo
// at UTC+2 in September; the server knows it is UTC+3. Same instant, `14:47` on the server and
// `13:47` on her phone — so she was also being shown times that were simply wrong, which is the
// half of this that survives even if nobody cares about the error.
//
// Exactly the same move as CAIRO_MONTHS in cairo-datetime.ts, one axis over. That fix made the
// LOCALE data ship with the code after CLDR renamed en-GB's September. This one does it for the
// ZONE data. Both come down to the same rule: anything the two sides must agree on cannot be asked
// of the engine.
//
// The table is generated from a current Node's tzdata by
// scripts/generate-cairo-zone-transitions.mjs, and tests/cairo-zone-offset.test.ts fails when the
// running engine disagrees with it — which is how you find out Egypt has changed the rule again.

import { CAIRO_ZONE_TABLE_RANGE, CAIRO_ZONE_TRANSITIONS } from "@/lib/format/cairo-zone-transitions";

/**
 * Minutes Africa/Cairo is ahead of UTC at this instant.
 *
 * Outside the generated window the nearest known offset is used rather than falling back to the
 * engine. A fallback that consults `Intl` would reintroduce the exact disagreement this module
 * exists to remove, and would do it only for the rows far enough from today that nobody would
 * think to look.
 */
export function cairoOffsetMinutes(value: Date): number {
  const at = value.getTime();
  if (!Number.isFinite(at)) return CAIRO_ZONE_TRANSITIONS[0][1];

  let offset = CAIRO_ZONE_TRANSITIONS[0][1];
  for (const [from, minutes] of CAIRO_ZONE_TRANSITIONS) {
    if (at < from) break;
    offset = minutes;
  }
  return offset;
}

/**
 * The same instant, moved so that reading its UTC fields gives Cairo's wall clock.
 *
 * The returned Date is a CARRIER FOR THE DIGITS, not a real instant — format it with
 * `timeZone: "UTC"` and nothing else. UTC is the one zone every engine agrees on, because it has
 * no rules to disagree about.
 */
export function cairoWallClock(value: Date): Date {
  return new Date(value.getTime() + cairoOffsetMinutes(value) * 60000);
}

/**
 * A wall-clock string, tagged UTC so that `new Date` keeps its digits.
 *
 * 🔴 THE HALF OF "RENDER IT AS WRITTEN" THAT `timeZone: "UTC"` DOES NOT COVER. A wall clock is
 * printed unshifted by formatting it with `timeZone: "UTC"` — but only if `new Date` also READ it
 * as UTC, and a date-time string carrying NO offset is parsed as the engine's LOCAL time instead
 * (ECMA-262 date-time forms). So on a Cairo browser `new Date("2026-09-01T10:08:38")` is the
 * instant `07:08:38Z`, and formatting that in UTC prints 07:08 — three hours early, with the two
 * halves of the convention cancelling in the wrong direction and nothing throwing.
 *
 * That is the defect the owner reported on `/admin/field-activity` on 2026-10-06: the route map
 * builds its clock by hand as `${dateIso}T${clock}`, with no `+00`, while the same card's "GPS
 * window" fact slices the string and was right. Measured on production the same day — all ten of
 * B-148's stops on 1 September 2026 were off by exactly −3:00, to the second.
 *
 * A value that already carries `Z` or an offset is returned untouched, so this is safe to apply to
 * anything PostgREST hands back; a value that is not a date-time at all is returned untouched too.
 */
export function utcTaggedWallClock(value: string): string {
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) return text;
  if (/(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(text)) return text;
  return `${text.replace(" ", "T")}Z`;
}

/** True when these options ask for Cairo, and so must be served from the table instead. */
export function isCairoZone(timeZone: string | undefined): boolean {
  return timeZone === "Africa/Cairo";
}

export { CAIRO_ZONE_TABLE_RANGE };

/**
 * The form sends the stop's time as a Cairo wall clock ("2026-11-02T14:30", a datetime-local value).
 * Read it as Cairo time: the offset is Cairo's own at that instant, from the shipped table.
 */
export function cairoWallClockToIso(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return "";
  const asUtc = Date.parse(`${text}:00Z`);
  if (!Number.isFinite(asUtc)) return "";
  // Twice: the first guess reads the offset at the wrong instant (hours early), which matters only
  // in the hours around a daylight-saving change; the second reads it at the real one.
  const first = cairoOffsetMinutes(new Date(asUtc));
  const offset = cairoOffsetMinutes(new Date(asUtc - first * 60_000));
  return new Date(asUtc - offset * 60_000).toISOString();
}
