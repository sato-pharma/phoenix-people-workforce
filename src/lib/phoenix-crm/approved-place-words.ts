/**
 * Phoenix CRM — Place checks: an approved building and an approved seated customer READ as approved.
 *
 * Owner, 21 Nov 2026, on Rowaida's polyclinic in Delta (2): "I approved validation of polyclinic … it kept
 * the bottom keep styled and it kept not approved." The database held both approvals (the customer's at
 * 16:09, the building's at 16:14 Cairo) and the screen still drew the old picture:
 *
 *  - a building that was never held had its Approve button worded "Keep it" and, once pressed, "Kept";
 *  - an approved building's pill read only "In use", and its main button stayed a live primary button;
 *  - an approved customer's timetable pill still read the refusal the system had held him on ("No timetable
 *    in the photo"), because `refusal_reason` stays on a review row after it is approved or taken back.
 *
 * Pure words and tones, so a test can pin them without a browser.
 */

export type ApprovedTone = "good" | "warn" | "neutral" | "bad" | "info";

/** What the building's approve button says — always "Approve", never "Keep it". */
export const BUILDING_APPROVE_LABEL = "Approve";

/** What the building's approve button says while it is being saved. */
export const BUILDING_APPROVING_LABEL = "Approving…";

/**
 * The approve button's look. Pressed once, the building is decided (`decidedAtText` is set) and a second
 * press changes nothing, so the button drops to the plain secondary look; before that it is the primary action.
 */
export function buildingApproveVariant(decidedAtText: string | null): "primary" | "secondary" {
  return decidedAtText ? "secondary" : "primary";
}

/** The building's status pill: an approved building says Approved, not only "In use". Company board only. */
export function buildingStatusPill(row: { status: "active" | "held" | "retired"; decidedAtText: string | null }, mode: "company" | "team"): { text: string; tone: ApprovedTone } {
  if (row.status === "active" && mode !== "team" && row.decidedAtText) return { text: "Approved", tone: "good" };
  return { text: "In use", tone: "good" };
}

/** The verdicts a timetable reading can carry (mirrors `SeatedTimetable["verdict"]`). */
type Verdict = "match" | "other_name" | "no_schedule" | "unjudged";

/**
 * The pill beside a seated customer's timetable. A customer who is in use and whose review is approved is
 * APPROVED: the system's earlier reading of the timetable is kept as information in a neutral tone, never as
 * a warning over a decision somebody has already taken.
 */
export function seatedTimetablePill(
  customer: { state: "waiting" | "in_use" | "rejected" | "sent_back"; reviewStatus: "pending" | "approved" | "rejected" | null },
  verdict: Verdict,
  words: Record<Verdict, string>,
): { text: string; tone: ApprovedTone } {
  const plain = words[verdict];
  if (customer.state === "in_use" && customer.reviewStatus === "approved" && (verdict === "other_name" || verdict === "no_schedule")) {
    return { text: `Approved. The system read: ${plain.charAt(0).toLowerCase()}${plain.slice(1)}`, tone: "neutral" };
  }
  return { text: plain, tone: verdict === "match" ? "good" : verdict === "unjudged" ? "neutral" : "warn" };
}
