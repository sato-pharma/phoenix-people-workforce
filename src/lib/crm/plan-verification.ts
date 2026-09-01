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
 * has been signed by someone above them, and moving it back to 1 would erase that.
 *
 * ## Unverify — added 2026-09-01, and deliberately NOT the mirror image of verify
 *
 * The owner: "I want to be able to verify and unverify from Phoenix." So a verification can now be
 * taken back, which until that day this module could not express at all. It is not symmetric,
 * because the two refusals it inherits are about different things:
 *
 *   - 1 -> 0 is ALLOWED. That is a manager undoing his OWN signature, which is the whole request.
 *     A plan misread and signed at 4am previously had no way back except asking the vendor.
 *   - 2 -> 0 is REFUSED, exactly as 2 -> 1 always was. Phoenix never writes 2, so it is never
 *     Phoenix's signature to take back; clearing it would erase a decision made a level above the
 *     person clicking, with nothing on any screen afterwards to say it had happened.
 *   - 0 is refused in its own words rather than "already verified" — "nothing to take back" and
 *     "somebody already signed this" are different facts, and the manager should be told which.
 *
 * The VENDOR enforces none of this: its status endpoint accepts a lowering write, proven live
 * against a phantom plan id. Every rule above is Phoenix's own, which is exactly why it is written
 * down here, pure, beside the codes it applies to, rather than left to what the CRM happens to
 * reject.
 */

/** Submitted by the rep, nobody has verified it. The CRM calls this "New"; the UI says "Pending". */
export const PLAN_STATUS_NEW = 0;
/** Verified by the rep's supervisor — the district manager. What this feature writes. */
export const PLAN_STATUS_SUPERVISOR_VERIFIED = 1;
/** Verified by an area manager. Phoenix never writes this; it must still be displayed honestly. */
export const PLAN_STATUS_AREA_MANAGER_VERIFIED = 2;

/**
 * The DOM id of the section holding the selected plan's doctors.
 *
 * Shared rather than written out in both places because the two halves of this page cannot see each
 * other: the server component renders the anchor and the client table looks it up to scroll to it. A
 * literal in each file would be two independent strings that only a manual click would prove equal.
 */
export const PLAN_DOCTORS_ANCHOR_ID = "plan-doctors";

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

/**
 * The colour a status is printed in. Amber = waiting on a human, emerald = signed by the
 * supervisor, sky = signed a level higher.
 *
 * It lives HERE, in the module with no directive, for the same reason planPeriodText does: both
 * tabs print a status and one of them renders on the SERVER. Defined inside a "use client" file
 * it would reach that server as a client reference rather than a function, and every plan would
 * fail to render.
 */
export function planStatusClass(status: number | null | undefined): string {
  if (status === PLAN_STATUS_NEW) return "text-amber-700";
  if (status === PLAN_STATUS_AREA_MANAGER_VERIFIED) return "text-sky-700";
  return "text-emerald-700";
}
/** True for any status the CRM regards as signed off, at either level. */
export function isPlanVerified(status: number | null | undefined): boolean {
  return status === PLAN_STATUS_SUPERVISOR_VERIFIED || status === PLAN_STATUS_AREA_MANAGER_VERIFIED;
}

/**
 * The period a plan covers, written out. Weekly plans have a span; monthly plans have a month.
 *
 * It lives HERE, in the module with no I/O, rather than beside the table that renders it, and that
 * placement is the whole point. It was first written inside plan-verification-tables.tsx, which
 * begins with "use client" — so when plan-verification-board.tsx (a SERVER component) imported it
 * for the selected plan's title, Next handed the server a client reference rather than the
 * function, and every plan a manager clicked returned "Admin workspace unavailable":
 * `Attempted to call planPeriodText() from the server but planPeriodText is on the client`.
 * A module with no directive can be called from either side, so neither half has to know where the
 * other runs.
 *
 * The parameter is the SHAPE it needs rather than PlanSummary, deliberately: PlanSummary lives in
 * plan-board.ts, which talks to Supabase, and naming it here would put a data module on the import
 * path of a formatter the browser also loads. PlanSummary satisfies this structurally.
 */
export function planPeriodText(plan: {
  firstDate: string | null;
  kind: PlanKind;
  lastDate: string | null;
  month: number | null;
  year: number | null;
}): string {
  if (plan.kind === "monthly") {
    if (plan.month && plan.year) {
      return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC", year: "numeric" }).format(
        new Date(Date.UTC(plan.year, plan.month - 1, 1)),
      );
    }
    return "No month recorded";
  }
  if (plan.firstDate && plan.lastDate && plan.firstDate !== plan.lastDate) {
    return `${plan.firstDate} to ${plan.lastDate}`;
  }
  return plan.firstDate ?? plan.lastDate ?? "No dates recorded";
}

export type PlanVerificationDecision =
  | { allowed: true; nextStatus: number }
  | { allowed: false; reason: string };

/** The two directions a manager can move a plan. */
export type PlanVerificationAction = "unverify" | "verify";

/**
 * Whether a value off a request body names an action.
 *
 * The route validates through this rather than falling back to "verify" on anything unrecognised.
 * A typo'd action must be refused, not quietly promoted into the one direction that writes a
 * signature into the customer's CRM.
 */
export function isPlanVerificationAction(value: unknown): value is PlanVerificationAction {
  return value === "verify" || value === "unverify";
}

/** What happened, past tense — for the audit line and the sentence the rep reads. */
export function planActionPastTense(action: PlanVerificationAction): string {
  return action === "unverify" ? "unverified" : "verified";
}

/**
 * Whether this plan may be verified — or unverified — now, and to what.
 *
 * Pure on purpose: the interesting cases are refusals, and a refusal that needs a database and a
 * live vendor to exercise is a refusal nobody tests. Six of the eight branches here are refusals.
 *
 * `action` DEFAULTS TO "verify" so every caller written before unverify existed keeps its exact
 * meaning, and so an action lost in transit can never lower a status by accident.
 */
export function decidePlanVerification(input: {
  action?: PlanVerificationAction;
  currentStatus: number | null;
}): PlanVerificationDecision {
  const { currentStatus } = input;
  const action = input.action ?? "verify";

  // Asked once, for both directions: a plan with no status is not a plan to act on either way.
  if (currentStatus == null) {
    return { allowed: false, reason: "This plan has no status yet — refresh the plans and try again." };
  }

  if (action === "unverify") {
    if (currentStatus === PLAN_STATUS_SUPERVISOR_VERIFIED) {
      // The manager taking back his own signature — the whole of what unverify is for.
      return { allowed: true, nextStatus: PLAN_STATUS_NEW };
    }
    if (currentStatus === PLAN_STATUS_NEW) {
      return { allowed: false, reason: "This plan is already pending — there is nothing to take back." };
    }
    if (currentStatus === PLAN_STATUS_AREA_MANAGER_VERIFIED) {
      // Phoenix never wrote this signature, so it is not Phoenix's to clear. Same rule as the
      // verify side and for the same reason — see the header.
      return {
        allowed: false,
        reason: "An area manager verified this plan, so it cannot be unverified from Phoenix.",
      };
    }
    return { allowed: false, reason: `This plan carries an unrecognised status (${currentStatus}).` };
  }

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
  return { allowed: false, reason: `This plan carries an unrecognised status (${currentStatus}).` };
}
