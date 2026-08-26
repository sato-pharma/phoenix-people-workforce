/**
 * The one marketing request whose approval note is shown in red.
 *
 * MKT-REQ-20260825-09BB51CA was returned at SFE Validation on 2026-08-25: the shop-front photos did
 * not carry a readable pharmacy, hospital or clinic name, so the rung could not be satisfied from
 * the evidence Phoenix held. The pharmacy was then validated and confirmed by the system admin in
 * person, OUTSIDE Phoenix, and the rung was approved on that authority on 2026-08-26.
 *
 * That makes this note different in kind from every other approval comment in the system. An
 * ordinary note explains a judgement made ON the evidence; this one records that the gate was
 * satisfied somewhere the system cannot see and cannot re-check. Marketing Review, the CEO and
 * Finance each read this rung before committing EGP 7,500, and each of them should be able to tell
 * at a glance that the SFE evidence gate was cleared out-of-band rather than passed. Hence red.
 *
 * OWNER RULE, 2026-08-26 — this is a ONE-TIME exception, for this ONE request:
 *
 *   - Do NOT add a second request code here.
 *   - Do NOT widen this into a stored flag, a note prefix, a "validated outside the system" status,
 *     or any other reusable mechanism. The value of the exception is that it stays exceptional; a
 *     mechanism anyone can reach for is how an out-of-band validation becomes routine, and routine
 *     is precisely what the SFE evidence gate exists to prevent.
 *   - When this request is closed and paid, this module and its call sites can simply be deleted.
 *
 * `tests/marketing-admin-override-note.test.ts` fails if a second request code is ever introduced,
 * so "one time" is enforced rather than merely requested.
 */
export const MARKETING_ADMIN_OVERRIDE_REQUEST_CODE = "MKT-REQ-20260825-09BB51CA";

/**
 * The rung the exception was taken on.
 *
 * Matched as well as the request code so the red treatment stays on the SFE Validation note alone.
 * Marketing Review, CEO Approval and Finance Execution each leave their own notes on this same
 * request, and those are ordinary decisions that must keep reading as ordinary.
 */
export const MARKETING_ADMIN_OVERRIDE_STEP_NAME = "SFE Validation";

/**
 * True only for the single note described above.
 *
 * Both halves are compared trimmed and case-insensitively — a step name reaches the UI from
 * `marketing_workflow_steps` and a request code from a URL, and neither is worth a false negative
 * over casing. Anything missing returns false: a caller that cannot say which request it is
 * rendering gets the ordinary treatment, never the exception.
 */
export function isMarketingAdminOverrideNote(input: {
  requestCode?: string | null;
  stepName?: string | null;
}): boolean {
  const requestCode = typeof input.requestCode === "string" ? input.requestCode.trim() : "";
  const stepName = typeof input.stepName === "string" ? input.stepName.trim() : "";
  if (!requestCode || !stepName) return false;
  return (
    requestCode.toUpperCase() === MARKETING_ADMIN_OVERRIDE_REQUEST_CODE
    && stepName.toLowerCase() === MARKETING_ADMIN_OVERRIDE_STEP_NAME.toLowerCase()
  );
}

/**
 * The red treatment, in one place so the three surfaces that render this note cannot drift apart.
 *
 * A left rule plus a tinted panel, not just red text: the note sits among other notes in a list, and
 * colour alone at 11-12px is easy to read straight past.
 */
export const MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES =
  "border-l-2 border-red-500 bg-red-50 px-2 py-1 font-semibold text-red-700";
