import type { NavigationMode } from "@/lib/auth/permissions";
import type {
  MarketingCaseFileDecisionAction,
  MarketingCaseFileViewerDecision,
} from "@/lib/marketing-requests/case-file-types";
import { resolveMarketingRequestDestination } from "@/lib/marketing-requests/notification-link";

// ─────────────────────────────────────────────────────────────────────────────
// The Case File's decision bar — the pure half of case-file-service.ts.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Every marketing notification ever sent stores `/marketing-requests/<id>` as its actionUrl
// (marketingActionUrl, called once per event and shared by every recipient). Until #2079 that URL
// was a bare redirect into the approval inbox, where the Approve / Return / Reject buttons live.
// #2079 gave the URL a page — the Case File — which reads the request far better and offers no way
// to answer it. The change that finally made the link land ON the request removed the recipient's
// only one-click route to ACT on it, and did so for every historical link at once.
//
// Found live on 2026-08-19. MKT-REQ-20260818-8C628BF4 (EGP 3,000, Nahed Hattab) cleared Marketing
// Review at 15:53 Cairo and opened `ceo_approval`. The CEO was notified within the second on
// in-app, email and push — all three `sent`, all three carrying that same URL — and every one of
// them opened a page with no decision control on it. His rung was even tagged "You" on the chain.
// Telegram is the ONLY channel that carries one-tap buttons (marketingTelegramButtons), and his
// delivery row reads `skipped · "Telegram is not connected."`, so he had no route at all. Three
// logins since, and `audit_logs` holds no marketing decision page open for him, ever.
//
// The capability was never the problem: `viewer.can.decide` has been computed correctly on this
// payload since the Case File shipped. Nothing rendered it.
//
// ── WHAT THIS MODULE MAY AND MAY NOT DO ──────────────────────────────────────
//
// It builds an AFFORDANCE and nothing else. Every href points at the decision page, which re-runs
// the whole gate (assertMarketingStepAssignedToActor, assertNotDecidingOwnRequest, the
// pending_approval check), and the decision API re-runs it again before it writes. A control
// rendered here can never become an authorisation.
//
// It lives apart from case-file-service.ts for the reason admin-page-access.ts and
// admin-shell-employee-roles.ts do: that module reaches Supabase on import, so a test cannot
// execute this rule there and would be left asserting over source text.
// ─────────────────────────────────────────────────────────────────────────────

/** The rung, reduced to what the bar needs. Kept structural so a test needs no full step row. */
export type DecisionBarStep = {
  allowReject: boolean;
  allowReturn: boolean;
  decisionLabels: { approve: string; reject: string; return: string } | null;
  stepName: string;
};

/**
 * The decision bar for one viewer, or null when there is nothing for them to answer.
 *
 * `canDecide` is passed in rather than re-derived: buildViewer already computes it from the same
 * rule decideMarketingRequestWorkflow enforces (holder of the CURRENT gating rung, request still
 * `pending_approval`), and a second copy of that rule here is a second place for it to drift.
 */
export function buildCaseFileDecisionBar(params: {
  canDecide: boolean;
  navigationMode: NavigationMode;
  requestId: string;
  step: DecisionBarStep | null;
}): MarketingCaseFileViewerDecision | null {
  if (!params.canDecide || !params.step) return null;

  const { step } = params;
  const href = (decision: "approve" | "return" | "reject") =>
    resolveMarketingRequestDestination({
      decision,
      navigationMode: params.navigationMode,
      requestId: params.requestId,
    });

  // Approve always exists — a rung that cannot be advanced is not a rung. Return and reject are
  // per-step powers, and the step row is the only thing that knows which it has.
  const actions: MarketingCaseFileDecisionAction[] = [
    { decision: "approve", href: href("approve"), label: step.decisionLabels?.approve || "Approve" },
  ];
  if (step.allowReturn) {
    actions.push({ decision: "return", href: href("return"), label: step.decisionLabels?.return || "Return" });
  }
  if (step.allowReject) {
    actions.push({ decision: "reject", href: href("reject"), label: step.decisionLabels?.reject || "Reject" });
  }

  return { actions, stepName: step.stepName };
}
