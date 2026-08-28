/**
 * Plan verification — the vocabulary and the decision, with no I/O.
 *
 * A district manager verifies a rep's plan, or leaves it pending. That is the whole feature the
 * owner asked for (2026-08-28): "weekly/monthly plans the DM can verify or leave pending", with
 * reject and return-for-edit explicitly dropped. Verifying writes back to the CRM, because the CRM
 * is where the rep and every other manager will look — a verification that only exists in Phoenix
 * would be invisible to the people it is for.
 *
 * ## The status codes are the VENDOR'S, and there are THREE of them
 *
 * From the vendor's own API documentation, recorded in client.ts since the CRM integration was
 * built: `0 = New`, `1 = Supervisor Verified`, `2 = Area Manager Verified`. Their web app's own
 * filter (`VerifyPlan.aspx`) offers only two words — "Pending" and "Verified" — which is why a
 * two-value model looks right until a status 2 arrives. One already has: a single weekly plan from
 * April 2026, 25 entries, belonging to an agent no longer on the roster.
 *
 * So this module never treats the status as a boolean. An unrecognised code is rendered as itself
 * rather than folded into "pending", because silently showing a verified plan as pending would
 * invite a second verification of something already signed off a level higher.
 *
 * ## Why a district manager writes 1 and never 2
 *
 * The rep's supervisor in this business is the district manager — that is the seat that owns the
 * rep's plan. Area-manager verification is a second, higher signature the owner has not asked for,
 * and it is the one status a district manager must never be able to overwrite: a plan already at 2
 * has been signed by someone above them, and moving it back to 1 would erase that. Hence
 * `decidePlanVerification` refuses rather than downgrades.
 */

/** Submitted by the rep, nobody has verified it. The CRM calls this "New"; the UI says "Pending". */
export const PLAN_STATUS_NEW = 0;
/** Verified by the rep's supervisor — the district manager. What this feature writes. */
export const PLAN_STATUS_SUPERVISOR_VERIFIED = 1;
/** Verified by an area manager. Phoenix never writes this; it must still be displayed honestly. */
export const PLAN_STATUS_AREA_MANAGER_VERIFIED = 2;

export type PlanKind = "weekly" | "monthly";

/**
 * The word a human sees. Deliberately NOT a lookup that falls back to "Pending" — an unknown code
 * shows its own number, so a vendor adding a fourth status surfaces as something to ask about
 * instead of quietly reading as unverified work.
 */
export function planStatusLabel(status: number | null | undefined): string {
  if (status === PLAN_STATUS_NEW) return "Pending";
  if (status === PLAN_STATUS_SUPERVISOR_VERIFIED) return "Verified";
  if (status === PLAN_STATUS_AREA_MANAGER_VERIFIED) return "Verified by area manager";
  if (status == null) return "Unknown";
  return `Unknown status ${status}`;
}

/** True for any status the CRM regards as signed off, at either level. */
export function isPlanVerified(status: number | null | undefined): boolean {
  return status === PLAN_STATUS_SUPERVISOR_VERIFIED || status === PLAN_STATUS_AREA_MANAGER_VERIFIED;
}

export type PlanVerificationDecision =
  | { allowed: true; nextStatus: number }
  | { allowed: false; reason: string };

/**
 * Whether this plan may be verified now, and to what.
 *
 * Pure on purpose: the interesting cases are refusals, and a refusal that needs a database and a
 * live vendor to exercise is a refusal nobody tests.
 */
export function decidePlanVerification(input: { currentStatus: number | null }): PlanVerificationDecision {
  const { currentStatus } = input;
  if (currentStatus === PLAN_STATUS_NEW) {
    return { allowed: true, nextStatus: PLAN_STATUS_SUPERVISOR_VERIFIED };
  }
  if (currentStatus === PLAN_STATUS_SUPERVISOR_VERIFIED) {
    return { allowed: false, reason: "This plan is already verified." };
  }
  if (currentStatus === PLAN_STATUS_AREA_MANAGER_VERIFIED) {
    // The one case that must never become a write: a district manager overwriting an area
    // manager's signature would look like a correction and would actually be a downgrade.
    return { allowed: false, reason: "An area manager has already verified this plan." };
  }
  if (currentStatus == null) {
    return { allowed: false, reason: "This plan has no status yet — refresh the plans and try again." };
  }
  return { allowed: false, reason: `This plan carries an unrecognised status (${currentStatus}).` };
}
