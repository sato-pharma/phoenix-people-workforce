/**
 * An outstation request's stored eligibility reason, as a sentence a person can read.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `service.ts` builds `eligibility_reason` from whatever the route lookup threw, and until
 * 2026-09-28 `googleDirectionsRoute` threw with the first 240 characters of Google's RESPONSE BODY
 * inside the message. So the reason a reviewer read on the card — and that every export copied — was
 * this, verbatim, measured on production that day:
 *
 *   Distance could not be validated against Google Maps. Google Routes API failed with 400: {
 *     "error": {
 *       "code": 400,
 *       "message": "Location coordinates must not be (0, 0).",
 *       "status": "INVALID_ARGUMENT"
 *     }
 *   }
 *   .
 *
 * The source now throws a sentence, but the rows written before it keep the JSON, and a stored
 * verdict is never rewritten. So the reading side has to cope with both, and this is the one place
 * that does it.
 *
 * ── A second problem: a reason can be OVERTAKEN ──────────────────────────────
 *
 * "Distance could not be validated" was true when it was written. It stops being true the moment a
 * distance is measured later — by an admin edit, or by the distance-only backfill (#4666), which
 * deliberately does NOT touch this column because re-deciding eligibility is a human's call. The
 * result is a card that says, in one panel, "Distance: 209.62 KM" and "Distance could not be
 * validated". Both are accurate about their own moment; read together they contradict each other.
 *
 * So this returns the stored reason AND, separately, what has been measured since. It never
 * changes the verdict, never says "eligible", and never implies one: the owner's standing rule is
 * that the system FLAGS an expense and never decides one. The second sentence states a fact — the
 * measured distance, against the minimum — and leaves the call where it was.
 *
 * Pure and client-safe: the panel, the PDF and the emails all read it.
 */

import { describeRoutesFailure, googleErrorMessage } from "@/lib/google-maps/routes-error";

export { describeRoutesFailure };

export type EligibilityReasonView = {
  /** The stored reason as a clean sentence, or null when nothing was stored. Never raw JSON. */
  recorded: string | null;
  /**
   * What has been measured since the reason was written, when that overtakes it. Null when the
   * stored reason still stands on its own.
   */
  since: string | null;
};

/** Collapses whitespace and gives the sentence exactly one closing full stop. */
function tidySentence(value: string): string {
  const flat = value.replace(/\s+/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
  if (!flat) return "";
  return /[.!?]$/.test(flat) ? flat.replace(/\.{2,}$/, ".") : `${flat}.`;
}

const ROUTES_FAILURE = /Google Routes API failed with (\d{3})(?::\s*([\s\S]*?))?\.?\s*$/;
const COULD_NOT_VALIDATE = /distance could not be validated/i;

/** The stored reason, cleaned. Handles the pre-fix JSON shape and anything newer. */
export function cleanEligibilityReason(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const failure = ROUTES_FAILURE.exec(text);
  if (failure) {
    const lead = text.slice(0, failure.index).trim();
    const described = describeRoutesFailure(Number(failure[1]), failure[2] ?? "");
    return tidySentence([lead, described].filter(Boolean).join(" "));
  }

  // Anything else that still carries a JSON envelope loses the envelope, never the sentence.
  const withoutJson = text.replace(/\{[\s\S]*\}/g, (blob) => googleErrorMessage(blob) ?? "");
  return tidySentence(withoutJson) || null;
}

/**
 * The reason a reviewer should read, plus what has been measured since — never a new verdict.
 */
export function viewEligibilityReason(input: {
  distanceKm: number | null | undefined;
  minimumKm: number | null | undefined;
  reason: string | null | undefined;
}): EligibilityReasonView {
  const recorded = cleanEligibilityReason(input.reason);
  const km = input.distanceKm;
  const measured = typeof km === "number" && Number.isFinite(km) && km > 0;

  if (!recorded || !measured || !COULD_NOT_VALIDATE.test(recorded)) {
    return { recorded, since: null };
  }

  const kmText = `${km.toFixed(2)} km`;
  const minimum = input.minimumKm;
  if (typeof minimum !== "number" || !Number.isFinite(minimum) || minimum <= 0) {
    return { recorded, since: `The distance has since been measured at ${kmText}.` };
  }
  const relation = km >= minimum ? "which is above" : "which is below";
  return {
    recorded,
    since:
      `The distance has since been measured at ${kmText}, ${relation} the ${minimum.toFixed(0)} km `
      + "minimum. The eligibility above is as it was recorded and has not been re-decided.",
  };
}
