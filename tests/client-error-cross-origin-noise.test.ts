import assert from "node:assert/strict";

import {
  CROSS_ORIGIN_MASKED_DISPLAY,
  isCrossOriginMaskedErrorEvent,
  isCrossOriginMaskedMessage,
} from "../src/lib/error-monitor/cross-origin-masked.ts";
import { decodeErrorMessage } from "../src/lib/error-monitor/message-decode.ts";
import { cairoDateTime } from "../src/lib/format/cairo-datetime.ts";
import { DATE_ONLY_FORMAT_OPTIONS, dateOnly } from "../src/lib/format/date-only.ts";

/**
 * Production wrote 1,972 rows reading only "Script error." — 65% of every client error ever
 * recorded, all with no stack — while the app's own errors carry `/_next/` chunk frames. One
 * 20-minute Firefox iOS session produced 24 of them and read as a page crashing in a loop.
 * It was not crashing. These pin both halves: the noise is recognised and capped, and a
 * diagnosable error is never mistaken for it.
 */
export function runClientErrorCrossOriginNoiseTests() {
  // ── The browser's sanitized fingerprint, exactly as it arrives ──────────────
  const masked = { colno: 0, error: null, filename: "", lineno: 0, message: "Script error." };
  assert.equal(isCrossOriginMaskedErrorEvent(masked), true);

  // Extensions that re-wrap the message before it reaches window.onerror.
  assert.equal(isCrossOriginMaskedMessage("~#!#~0~#!#~Script error.~#!#~"), true);
  assert.equal(isCrossOriginMaskedErrorEvent({ ...masked, message: "~#!#~2~#!#~Script error.~#!#~" }), true);

  // ── A diagnosable error must NEVER be swallowed ─────────────────────────────
  // Each of these breaks exactly one part of the fingerprint. Every one must report in full,
  // because suppressing a real error costs far more than keeping one undiagnosable row.
  assert.equal(isCrossOriginMaskedErrorEvent({ ...masked, error: new Error("real") }), false);
  assert.equal(
    isCrossOriginMaskedErrorEvent({ ...masked, filename: "https://phoenix-hr.satopharma.com/_next/static/chunks/a.js" }),
    false,
  );
  assert.equal(isCrossOriginMaskedErrorEvent({ ...masked, lineno: 1 }), false);
  assert.equal(isCrossOriginMaskedErrorEvent({ ...masked, colno: 46280 }), false);
  assert.equal(isCrossOriginMaskedErrorEvent({ ...masked, message: "Cannot read properties of null" }), false);

  // ── The 1,972 rows already stored read as English, with no migration ────────
  const decoded = decodeErrorMessage("Script error.");
  assert.equal(decoded.display, CROSS_ORIGIN_MASKED_DISPLAY);
  assert.match(decoded.display, /not app code/i);
  assert.equal(decoded.raw, "Script error."); // the raw string is never rewritten
  assert.equal(decodeErrorMessage("~#!#~0~#!#~Script error.~#!#~").display, CROSS_ORIGIN_MASKED_DISPLAY);

  // A real message must still decode as itself, not as the browser-noise label.
  assert.notEqual(decodeErrorMessage("Load failed").display, CROSS_ORIGIN_MASKED_DISPLAY);

  // ── Hydration safety: every formatter on the candidate card pins its zone ───
  // An unpinned formatter renders in the server's zone (UTC on Railway) and again in the phone's
  // (Africa/Cairo), which React reports as #418 and repairs by discarding the server's markup.

  // A `date` column is date-only: it parses as UTC midnight and must render in UTC, or it moves
  // to the previous day for every negative offset.
  assert.equal(DATE_ONLY_FORMAT_OPTIONS.timeZone, "UTC");
  // en-US, byte-identical to the formatter this replaced — the fix pins the zone, it does not restyle.
  assert.equal(dateOnly("2026-09-02"), "Sep 2, 2026");
  assert.equal(dateOnly(null), "");
  assert.equal(dateOnly("not a date"), "not a date");

  // A timestamptz is an instant we stamped: it belongs in Cairo. 22:30 UTC is already the next
  // day in Cairo (+3) — the exact case that renders two different days on server and device.
  const instant = cairoDateTime("2026-09-03T22:30:00Z");
  assert.match(instant, /04 Sept 2026/);
  assert.match(instant, /01:30/);
}
