import { showsAwaitingFinanceMonth, type DirectOrderStatus } from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// The user-facing vocabulary for a direct order's state.
//
// WHY THIS EXISTS: every list in the module rendered the DATABASE value with its
// underscores swapped for spaces (`String(status).replace(/_/g, " ")` in
// direct-order-status-pill.tsx). That produced "pending approval", "held" and
// "expired" on screen — words that describe the row, not the person's situation.
// A District Manager reading "held" has to already know that held means "the
// pharmacy you typed is not in the master database, and nobody is looking at
// your order until it is confirmed". That is internal architecture, and the
// owner's rule is that the screen never asks the reader to know it.
//
// The DATABASE VALUES DO NOT CHANGE. `direct_order_requests_status_check` still
// permits the same 9 statuses, the workflow registry still declares them, and
// every service guard still compares against them. This module is a projection
// on top, and nothing here may ever be fed back into a query or a transition.
//
// The stage list is taken from the real chain in approval-flow.ts
// (SFE Manager → the requester's management line → CEO) plus the two states that
// sit OUTSIDE it: `held` before the chain, and the Finance sales-month booking
// after it. Nothing here was invented — see directOrderExpectedRoleChain and the
// GOLDEN RULE in showsAwaitingFinanceMonth.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five places an order can be in the journey, plus the dead ends.
 *
 * Deliberately COARSER than `DirectOrderStatus`: a reader wants to know "where is
 * my order", and `pending_approval` covers four different rungs while `approved`
 * covers both "the money is counted" and "the money is counted by nobody yet".
 */
export type DirectOrderStage =
  | "draft"
  | "customer_check"
  | "approval"
  | "finance"
  | "completed"
  | "stopped";

/** The ordered progression shown as a stepper on the order page. `stopped` is not a stage — it replaces one. */
export const DIRECT_ORDER_STAGE_SEQUENCE: readonly DirectOrderStage[] = [
  "draft",
  "customer_check",
  "approval",
  "finance",
  "completed",
] as const;

export const DIRECT_ORDER_STAGE_LABEL: Record<DirectOrderStage, string> = {
  draft: "Draft",
  customer_check: "Customer Verification",
  approval: "Approvals",
  finance: "Finance",
  completed: "Completed",
  stopped: "Stopped",
};

export type DirectOrderStatusTone = "neutral" | "waiting" | "attention" | "good" | "bad";

export type DirectOrderStatusPresentation = {
  /** What the pill says. Short enough for a table cell — the owner's rule forbids wrapping. */
  label: string;
  /** The full sentence, for a tooltip or the order page. Never a restatement of the label. */
  explanation: string;
  stage: DirectOrderStage;
  tone: DirectOrderStatusTone;
  /** True when somebody must do something. Drives the Needs Action inbox and the summary cards. */
  actionable: boolean;
};

/**
 * `held` is the one status whose database name is actively misleading rather than
 * merely technical. It reads as "an approver paused this", which is the opposite
 * of the truth: no approver has seen it, because it is not in anybody's queue.
 */
const HELD_EXPLANATION =
  "The pharmacy on this order is not in the master database yet, so the order is not in anyone's approval queue. It moves forward as soon as the pharmacy is verified.";

/**
 * Resolve everything the UI needs to say about an order's state.
 *
 * `salesMonth` is REQUIRED, not optional, for the same reason it is required on
 * DirectOrderStatusPill: an omitted month would silently render the plain
 * "Approved" that the GOLDEN RULE exists to prevent — CEO approval never injects
 * sales, only the Finance booking does. An optional parameter would make that
 * omission look like a decision.
 */
export function describeDirectOrderStatus(
  status: DirectOrderStatus | string,
  salesMonth: string | null,
  /**
   * Who is reading. `returned` is a question put to ONE person — the one who raised the order — so
   * "Needs Your Correction" is true for them and false for everyone else (a National Sales Manager
   * was told it on orders two other people raised, 26 Oct 2026). Omitted means "not known to be the
   * raiser": the neutral wording is the safe default, because the personal one is a claim.
   */
  viewer: { isRequester?: boolean } = {},
): DirectOrderStatusPresentation {
  const key = String(status ?? "").trim().toLowerCase();

  // Checked BEFORE the `approved` case below, because both read `approved` in the
  // database and they are opposite facts to the person reading the screen.
  if (showsAwaitingFinanceMonth(key, salesMonth)) {
    return {
      label: "Waiting for Finance",
      explanation:
        "Fully approved. Finance still has to book it into a sales month — until then the value is not in any month's numbers.",
      stage: "finance",
      tone: "waiting",
      actionable: true,
    };
  }

  switch (key) {
    case "draft":
      return {
        label: "Draft",
        explanation: "Not submitted yet. Only you can see it.",
        stage: "draft",
        tone: "neutral",
        actionable: true,
      };
    case "held":
      return {
        label: "Customer Verification Required",
        explanation: HELD_EXPLANATION,
        stage: "customer_check",
        tone: "attention",
        actionable: true,
      };
    case "pending_approval":
      return {
        label: "In Approval",
        explanation: "Working its way up the approval chain. The order page shows who has it now.",
        stage: "approval",
        tone: "waiting",
        actionable: true,
      };
    case "returned":
      return viewer.isRequester
        ? {
            label: "Needs Your Correction",
            explanation: "An approver sent this back for a change. Fix it and resubmit — it is not rejected.",
            stage: "approval",
            tone: "attention",
            actionable: true,
          }
        : {
            label: "Returned for correction",
            explanation:
              "An approver sent this back to the person who raised it for a change. It is not rejected — it moves on again once they correct and resubmit it.",
            stage: "approval",
            tone: "attention",
            actionable: true,
          };
    case "approved":
      // Only reachable with a sales month set — the null case was handled above.
      return {
        label: "Completed",
        explanation: "Approved and booked into a sales month. The value counts in that month's numbers.",
        stage: "completed",
        tone: "good",
        actionable: false,
      };
    case "rejected":
      return {
        label: "Rejected",
        explanation: "An approver turned this down. It cannot be resubmitted — raise a new order if it is still needed.",
        stage: "stopped",
        tone: "bad",
        actionable: false,
      };
    case "expired":
      return {
        label: "Expired",
        explanation:
          "The pharmacy was never verified, so the order timed out after 14 days without ever reaching an approver.",
        stage: "stopped",
        tone: "bad",
        actionable: false,
      };
    case "cancelled":
      return {
        label: "Withdrawn",
        explanation: "The person who raised this withdrew it. It was never turned down by an approver.",
        stage: "stopped",
        tone: "neutral",
        actionable: false,
      };
    case "reversed":
      return {
        label: "Reversed",
        explanation: "This order was approved and later reversed, which retired its booked sales.",
        stage: "stopped",
        tone: "bad",
        actionable: false,
      };
    default:
      // An unrecognised value is a reason for a human to look, never a reason to
      // invent a friendly word for it — same principle as
      // normalizePharmacyVerificationStatus resolving the unknown to pending_review.
      return {
        label: String(status ?? "Unknown"),
        explanation: "This order is in a state Phoenix does not recognise. Please report it.",
        stage: "stopped",
        tone: "neutral",
        actionable: false,
      };
  }
}

/**
 * "Who is this sitting with right now", in one short phrase.
 *
 * `activeStepLabel` is the rung's own label as the service already resolved it
 * (a job title, or a person's role) — it is passed through rather than
 * re-derived, because approval-flow.ts is the only thing entitled to say what a
 * rung is called, and a second copy of that rule is how the module got its
 * duplicate-page problem in the first place.
 */
export function describeDirectOrderOwner(input: {
  status: DirectOrderStatus | string;
  salesMonth: string | null;
  activeStepLabel: string | null;
  requesterName: string;
}): string {
  const { stage } = describeDirectOrderStatus(input.status, input.salesMonth);
  const key = String(input.status ?? "").trim().toLowerCase();

  if (stage === "completed" || stage === "stopped") return "—";
  if (key === "draft" || key === "returned") return input.requesterName || "The person who raised it";
  if (stage === "customer_check") return "Pharmacy verification";
  if (stage === "finance") return "Finance";
  return (input.activeStepLabel ?? "").trim() || "An approver";
}

/**
 * What a RETURNED order's open rung says, everywhere that rung is named: the order window's
 * progress bar and the orders report's "Awaiting" column.
 *
 * A return leaves the returning rung `pending` on purpose, so a resubmission resumes exactly there
 * (reviseDirectOrder). Read on its own, that rung told every surface the order was waiting on the
 * SFE Manager — who then found no Approve button, because a returned order has none (owner,
 * 2026-09-14). The order is waiting on the person who raised it, so it says so.
 *
 * First two words of the name only: it sits under one segment of a four-rung bar.
 */
export function describeReturnedDirectOrderWait(requesterName: string | null | undefined): string {
  const words = String(requesterName ?? "").trim().split(/\s+/).filter(Boolean);
  const who = words.length > 0 ? words.slice(0, 2).join(" ") : "the person who raised it";
  return `Returned — waiting for ${who}`;
}

/**
 * The stage a `stopped` order got as far as, for the stepper.
 *
 * Without this the progression on a rejected order would show every stage grey
 * and say nothing about where it died — and "rejected at the CEO" and "expired
 * before anyone saw it" are very different stories about the same order.
 */
export function resolveDirectOrderReachedStage(input: {
  status: DirectOrderStatus | string;
  salesMonth: string | null;
}): DirectOrderStage {
  const key = String(input.status ?? "").trim().toLowerCase();
  if (key === "expired") return "customer_check";
  if (key === "cancelled") return "customer_check";
  if (key === "rejected") return "approval";
  if (key === "reversed") return "completed";
  return describeDirectOrderStatus(key, input.salesMonth).stage;
}
