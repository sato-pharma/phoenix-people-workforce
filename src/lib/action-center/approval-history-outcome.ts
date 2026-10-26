import type { HistoricalApprovalItem } from "@/components/action-center/types";
import { describeDirectOrderBasketUnits } from "@/lib/direct-orders/basket-label";
import { formatHistoryMoney, historyDate } from "@/lib/action-center/approval-history-format";

// What the "decisions I made" history says an approval ENDED as.
//
// THE RULE (owner, 2026-10-26, from the National Sales Manager's own screen): a row's outcome is the
// REQUEST'S FINAL STATE, never the viewer's own step. Ahmed Abdallah's leaves of 16, 19 and 24 Aug
// read APPROVED because the viewer approved them, but HR rejected all three further down the chain;
// the request-level `manager_decision` column stays "approved" for ever, so a list that reads it
// cannot tell. Where the request has not ended yet (Mostafa Galal's leave is still with HR) the row
// says what the viewer did and what it is waiting for: "Approved by you · waiting for HR".
//
// Pure on purpose: `getMyApprovalHistory` reads the rows, this decides what they mean.

export type HistoryDecision = HistoricalApprovalItem["decision"];

/** Where the request stands NOW, as opposed to what the viewer did to it. */
export type RequestFinalState = HistoryDecision | "cancelled" | "pending" | "unknown";

export type RequestStanding = {
  state: RequestFinalState;
  /** Only for `pending`: who or what the request waits on, worded to follow "waiting for". */
  waitingFor?: string;
};

export type HistoryOutcome = {
  decision: HistoryDecision;
  /** A line under the badge, or null when the badge already says everything. */
  note: string | null;
};

const YOU_DID: Record<HistoryDecision, string> = {
  approved: "Approved by you",
  rejected: "Rejected by you",
  returned: "Returned by you",
};

const LATER: Record<HistoryDecision, string> = {
  approved: "approved later",
  rejected: "rejected later",
  returned: "returned later",
};

/**
 * The badge and note for one decision the viewer took.
 *
 *   final = what the viewer did          → that decision, no note
 *   final = something else, and it ended → the FINAL decision, note "Approved by you · rejected later"
 *   still pending                        → the viewer's decision, note "Approved by you · waiting for HR"
 *   cancelled / unknown                  → the viewer's decision, noted when it was cancelled
 */
export function resolveHistoryOutcome(viewerDecision: HistoryDecision, standing: RequestStanding): HistoryOutcome {
  const { state } = standing;
  if (state === "approved" || state === "rejected" || state === "returned") {
    return {
      decision: state,
      note: state === viewerDecision ? null : `${YOU_DID[viewerDecision]} · ${LATER[state]}`,
    };
  }
  if (state === "pending") {
    return {
      decision: viewerDecision,
      note: `${YOU_DID[viewerDecision]} · waiting for ${standing.waitingFor || "the next approver"}`,
    };
  }
  if (state === "cancelled") {
    return { decision: viewerDecision, note: `${YOU_DID[viewerDecision]} · cancelled afterwards` };
  }
  return { decision: viewerDecision, note: null };
}

function norm(status: string | null | undefined): string {
  return String(status ?? "").trim().toLowerCase();
}

/** A leave's standing, from `v2_vacation_requests.status`. */
export function leaveStanding(status: string | null | undefined): RequestStanding {
  const s = norm(status);
  if (s === "approved" || s === "rejected" || s === "returned") return { state: s };
  if (s === "cancelled" || s === "canceled") return { state: "cancelled" };
  if (s === "pending_hr") return { state: "pending", waitingFor: "HR" };
  if (s === "pending_manager") return { state: "pending", waitingFor: "the next manager" };
  return { state: "unknown" };
}

/** A direct order's standing, from `direct_order_requests.status`. */
export function directOrderStanding(status: string | null | undefined): RequestStanding {
  const s = norm(status);
  if (s === "approved" || s === "rejected" || s === "returned") return { state: s };
  if (s === "cancelled" || s === "canceled") return { state: "cancelled" };
  if (s === "pending_approval") return { state: "pending", waitingFor: "the next approver" };
  if (s === "held") return { state: "pending", waitingFor: "the hold to be released" };
  return { state: "unknown" };
}

/** A marketing request's standing, from `marketing_requests.status` (`active` is approved and running). */
export function marketingStanding(status: string | null | undefined): RequestStanding {
  const s = norm(status);
  if (s === "active") return { state: "approved" };
  if (s === "rejected" || s === "returned") return { state: s };
  if (s === "cancelled" || s === "canceled") return { state: "cancelled" };
  if (s === "pending_approval") return { state: "pending", waitingFor: "the next approver" };
  if (s === "finance_hold") return { state: "pending", waitingFor: "Finance" };
  return { state: "unknown" };
}

// ── Leave ───────────────────────────────────────────────────────────────────

export type HistoryLeaveRequest = {
  employee_name?: string | null;
  employee_hr_id?: string | null;
  vacation_type?: string | null;
  start_date?: string | null;
  status?: string | null;
};

export type HistoryLeaveRequestRow = HistoryLeaveRequest & {
  id: string;
  manager_decision: string | null;
  manager_decision_at: string | null;
  manager_decision_by_hr_id: string | null;
  hr_decision: string | null;
  hr_decision_at: string | null;
  hr_decision_by_hr_id: string | null;
};

export type HistoryLeaveStepRow = {
  request_id: string | null;
  status: string | null;
  decided_at: string | null;
  /** PostgREST hands a to-one embed back as an object, or as a one-element array. */
  v2_vacation_requests?: HistoryLeaveRequest | HistoryLeaveRequest[] | null;
};

type LeaveHistoryDeps = {
  /** True when a stored decider id is the viewer, under any of their logins. */
  decidedByMe: (value: unknown) => boolean;
  /** The decision text parser (`decodeDecision`), passed in so this file stays free of the service. */
  decode: (raw: string | null | undefined) => HistoryDecision | null;
  personName: (hrId: string, fallback: string) => string;
  hrefFor: (requestId: string) => string;
};

function leaveItem(
  deps: LeaveHistoryDeps,
  requestId: string,
  request: HistoryLeaveRequest,
  viewerDecision: HistoryDecision,
  decidedAt: string | null,
): HistoricalApprovalItem {
  const outcome = resolveHistoryOutcome(viewerDecision, leaveStanding(request.status));
  const hrId = String(request.employee_hr_id ?? "");
  const start = historyDate(request.start_date);
  return {
    id: `history:leave:${requestId}`,
    module: "leave",
    employeeName: deps.personName(hrId, String(request.employee_name ?? "Unknown")),
    employeeHrId: hrId,
    title: `Leave · ${String(request.vacation_type ?? "").replace(/_/g, " ")}${start ? ` · ${start}` : ""}`,
    decision: outcome.decision,
    outcomeNote: outcome.note,
    decidedAt: String(decidedAt ?? ""),
    href: deps.hrefFor(requestId),
  };
}

/**
 * Every leave the viewer decided, with its FINAL outcome.
 *
 * Two feeds, because the request row only records the direct manager and HR: `requests` are the
 * rows whose manager/HR decision columns name the viewer, `steps` are the viewer's own decided rows
 * in the approval-steps table — the ONLY place a manager-of-manager, a level-3 manager, or a direct
 * manager whose id was stored under an alias (Hany Saad's leave carries "AA" in the request column,
 * while the step is A-12's) is recorded. A request in both feeds appears once, from `requests`.
 */
export function buildLeaveHistory(
  feeds: { requests: readonly HistoryLeaveRequestRow[]; steps: readonly HistoryLeaveStepRow[] },
  deps: LeaveHistoryDeps,
): HistoricalApprovalItem[] {
  const items: HistoricalApprovalItem[] = [];
  const seen = new Set<string>();

  for (const row of feeds.requests) {
    const isMgrDecider = deps.decidedByMe(row.manager_decision_by_hr_id);
    const isHrDecider = deps.decidedByMe(row.hr_decision_by_hr_id);
    if (!isMgrDecider && !isHrDecider) continue;
    const decisionRaw = isHrDecider && row.hr_decision ? row.hr_decision : row.manager_decision;
    const decidedAt = isHrDecider && row.hr_decision_at ? row.hr_decision_at : row.manager_decision_at;
    // A return stamps manager_decision_at/_by but cannot touch manager_decision (its check allows only
    // approved/rejected), so it is NULL on a first-stage return. The viewer's own act is then the
    // return itself, which the request's status confirms.
    const viewerDecision =
      deps.decode(decisionRaw) ?? (norm(row.status) === "returned" ? ("returned" as const) : null);
    if (!viewerDecision) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    items.push(leaveItem(deps, row.id, row, viewerDecision, decidedAt));
  }

  for (const row of feeds.steps) {
    const requestId = String(row.request_id ?? "");
    if (!requestId || seen.has(requestId)) continue;
    const embedded = row.v2_vacation_requests;
    const request = Array.isArray(embedded) ? embedded[0] : embedded;
    if (!request) continue;
    const s = norm(row.status);
    const viewerDecision = s === "approved" ? ("approved" as const) : s === "rejected" ? ("rejected" as const) : null;
    if (!viewerDecision) continue;
    seen.add(requestId);
    items.push(leaveItem(deps, requestId, request, viewerDecision, row.decided_at));
  }

  return items;
}

// ── Direct orders ───────────────────────────────────────────────────────────

export type HistoryDirectOrderParent = {
  status?: string | null;
  product_name?: string | null;
  qty?: number | string | null;
  sales_value?: number | string | null;
  requester_hr_id?: string | null;
  direct_order_pharmacies?: { pharmacy_name?: string | null } | { pharmacy_name?: string | null }[] | null;
  direct_order_request_items?:
    | { line_no?: number | null; product_name?: string | null; qty?: number | string | null }[]
    | null;
};

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * `Direct order · Zamzam Pharmacy · Lacto Advanced 1 × 72 + Lacto Advanced 2 × 24 · 25,344 EGP` —
 * the pharmacy, EVERY product with its own units (units of different products are never added),
 * and the order's money with separators. A one-line order reads its own columns, as everywhere.
 */
export function directOrderHistoryTitle(parent: HistoryDirectOrderParent | null | undefined): string {
  const pharmacy = String(firstOf(parent?.direct_order_pharmacies)?.pharmacy_name ?? "").trim();
  const lines = [...(parent?.direct_order_request_items ?? [])]
    .sort((a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0))
    .map((line) => ({ productName: String(line.product_name ?? ""), qty: Number(line.qty ?? 0) }));
  const units = describeDirectOrderBasketUnits(
    { productName: String(parent?.product_name ?? "Direct order"), qty: Number(parent?.qty ?? 0) },
    lines,
  );
  return ["Direct order", pharmacy, units, formatHistoryMoney(parent?.sales_value)]
    .filter((part) => part !== "")
    .join(" · ");
}

/** The badge, note and title for one approve / reject / return event on a direct order. */
export function directOrderHistoryRow(
  viewerDecision: HistoryDecision,
  parent: HistoryDirectOrderParent | null | undefined,
): HistoryOutcome & { title: string } {
  const outcome = resolveHistoryOutcome(viewerDecision, directOrderStanding(parent?.status));
  return { ...outcome, title: directOrderHistoryTitle(parent) };
}
