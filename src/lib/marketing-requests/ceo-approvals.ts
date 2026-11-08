import type { PhoenixRole } from "@/lib/auth/permissions";
import { cairoOffsetMinutes } from "@/lib/format/cairo-zone";
import { canonicalHrIdKey } from "@/lib/hr-id";
// The same `humanize` the live sheet feed runs over `status`, so column N and this page cannot differ.
import { humanize } from "@/lib/marketing-requests/request-report-columns";
import { EXECUTION_STEP_CODE } from "@/lib/marketing-requests/request-status-label";

// ─────────────────────────────────────────────────────────────────────────────
// CEO Approvals — the pure half (owner, 2026-11-08): every marketing request the CEO approved
// between two Cairo dates, with where its money stands now. Reads nothing, so every rule here is
// pinned by tests/marketing-ceo-approvals.test.ts without a database.
//
// "Approved by the CEO" is the `ceo_approval` rung reaching `approved` — the rung, not the person,
// so an approval the Super Admin recorded on that rung is listed too and says who pressed it.
//
// The period is HIS week's email, not a filter on the approval date alone (owner, 2026-11-08): Hossam
// Reda's "Approved requests 8th Nov to 15th Nov" listed 12 requests, and only 3 were approved in those
// dates — the other 9 were approved earlier and still waiting for Finance's transfer. So a period lists
// what the CEO approved in it PLUS every earlier approval Finance has not paid yet ("carried over"), and
// the "Listed as" column says which, so the two are never confused again.
//
// The status column repeats the Key Data tab's column N word for word (`humanize(status)`), so the
// page and the live sheet can never name the same request two ways.
// ─────────────────────────────────────────────────────────────────────────────

export const CEO_APPROVAL_STEP_CODE = "ceo_approval";

export const MARKETING_CEO_APPROVALS_PORTAL_PATH = "/employee-portals/marketing-requests/ceo-approvals";
export const MARKETING_CEO_APPROVALS_ADMIN_PATH = "/admin/marketing-requests/ceo-approvals";

/** The owner asked for it on the Marketing Manager's account; the CEO and Super Admin read it too. */
const ceoApprovalsReaderRoles = new Set<PhoenixRole>(["Marketing Manager", "CEO", "Super Admin"]);

export function canViewMarketingCeoApprovals(role: string | null | undefined): boolean {
  return Boolean(role) && ceoApprovalsReaderRoles.has(role as PhoenixRole);
}

// ── The date range ──────────────────────────────────────────────────────────

export type CeoApprovalsRange = { from: string; to: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function firstParam(value: string | string[] | null | undefined): string {
  return String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
}

/**
 * The two dates from the address bar. A missing or unreadable date falls back to the first of the
 * current Cairo month (from) and today in Cairo (to); dates typed the wrong way round are swapped
 * rather than answered with an empty table.
 */
export function resolveCeoApprovalsRange(
  params: { from?: string | string[] | null; to?: string | string[] | null },
  todayCairo: string,
): CeoApprovalsRange {
  const rawFrom = firstParam(params.from);
  const rawTo = firstParam(params.to);
  const from = isRealDate(rawFrom) ? rawFrom : `${todayCairo.slice(0, 7)}-01`;
  const to = isRealDate(rawTo) ? rawTo : todayCairo;
  return from <= to ? { from, to } : { from: to, to: from };
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Cairo midnight of a YYYY-MM-DD as a UTC instant, from the shipped offset table (UTC+2 / UTC+3). */
export function cairoDayStartIso(day: string): string {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  let instant = utcMidnight - cairoOffsetMinutes(new Date(utcMidnight - 2 * 3_600_000)) * 60_000;
  instant = utcMidnight - cairoOffsetMinutes(new Date(instant)) * 60_000;
  return new Date(instant).toISOString();
}

/** The half-open UTC window [from 00:00 Cairo, the day after `to` 00:00 Cairo). */
export function ceoApprovalsWindow(range: CeoApprovalsRange): { endIso: string; startIso: string } {
  return { endIso: cairoDayStartIso(nextDay(range.to)), startIso: cairoDayStartIso(range.from) };
}

// ── The rows ────────────────────────────────────────────────────────────────

export type CeoApprovalFinanceState = "executed" | "waiting_finance" | "waiting_other" | "held" | "closed_out";

export type CeoApprovalStepInput = {
  decisionAt: string | null;
  decisionByHrId: string | null;
  executedAt: string | null;
  isCc: boolean;
  requestId: string;
  sequence: number;
  status: string;
  stepCode: string;
  stepName: string | null;
};

export type CeoApprovalRequestInput = {
  customerId: string | null;
  customerName: string;
  estimatedCost: number;
  href: string;
  id: string;
  lineName: string;
  payDate: string | null;
  requestCode: string;
  requesterHrId: string | null;
  requesterName: string;
  requestType: string;
  status: string;
};

/**
 * Why a row is in the period: the CEO approved it inside the dates, or approved it before them and
 * Finance has still not paid it (waiting for Finance, or on Finance hold).
 */
export type CeoApprovalListedAs = "approved_in_period" | "carried_over";

export const CEO_APPROVAL_LISTED_AS_LABEL: Record<CeoApprovalListedAs, string> = {
  approved_in_period: "Approved in this period",
  carried_over: "Carried over, not paid yet",
};

/** The finance states a carried-over row may have: money the CEO approved that Finance still owes. */
const CARRY_OVER_STATES = new Set<CeoApprovalFinanceState>(["waiting_finance", "held"]);

export type MarketingCeoApprovalRow = {
  approvedAtIso: string;
  /** Set only when someone other than the CEO pressed approve on the CEO's rung. */
  approvedOnBehalfBy: string | null;
  customerId: string | null;
  customerName: string;
  estimatedCost: number;
  executedAtIso: string | null;
  executedByName: string | null;
  financeLabel: string;
  financeState: CeoApprovalFinanceState;
  href: string;
  lineName: string;
  listedAs: CeoApprovalListedAs;
  payDate: string | null;
  /** The pay date has passed (Cairo) and Finance has not executed the request. */
  payDateOverdue: boolean;
  requestCode: string;
  requestId: string;
  /** Who the "Approved requests" email copies; never shown on screen. */
  requesterHrId: string | null;
  requesterName: string;
  requestType: string;
  /** The Key Data tab's column N, word for word. */
  statusLabel: string;
};

/** A request that has left the chain without being paid owes nothing, so its pay date is never late. */
const CLOSED_OUT_STATUSES = new Set(["rejected", "cancelled", "archived", "draft", "returned"]);

function financeStateOf(
  request: CeoApprovalRequestInput,
  financeStep: CeoApprovalStepInput | undefined,
  openStep: CeoApprovalStepInput | undefined,
): { label: string; state: CeoApprovalFinanceState } {
  if (request.status === "finance_hold") return { label: "Finance hold", state: "held" };
  if (financeStep && (financeStep.status === "approved" || financeStep.executedAt)) {
    return { label: "Executed", state: "executed" };
  }
  if (CLOSED_OUT_STATUSES.has(request.status)) {
    return { label: humanize(request.status) ?? request.status, state: "closed_out" };
  }
  if (openStep?.stepCode === EXECUTION_STEP_CODE) return { label: "Waiting for Finance", state: "waiting_finance" };
  if (openStep) return { label: `Waiting for ${openStep.stepName || humanize(openStep.stepCode) || "the next step"}`, state: "waiting_other" };
  return { label: humanize(request.status) ?? request.status, state: "waiting_other" };
}

/**
 * One row per request, its newest CEO approval wins (a resubmitted request can be approved twice),
 * ordered by that approval, oldest first.
 *
 * With `period`, an approval at or after `endIso` is ignored; a newest approval at or after
 * `startIso` is "approved in this period"; one before it is listed only while Finance still owes the
 * money (waiting for Finance, or Finance hold) and reads "carried over". Without `period` every row is
 * "approved in this period" — the caller already read only the window.
 */
export function buildCeoApprovalRows(input: {
  ceoApprovals: readonly CeoApprovalStepInput[];
  /** Keyed by `canonicalHrIdKey`; `isCeo` false marks someone pressing on the CEO's behalf. */
  deciders: ReadonlyMap<string, { isCeo: boolean; name: string }>;
  requestsById: ReadonlyMap<string, CeoApprovalRequestInput>;
  /** The period's half-open UTC window; see the function's comment. */
  period?: { endIso: string; startIso: string };
  steps: readonly CeoApprovalStepInput[];
  todayCairo: string;
}): MarketingCeoApprovalRow[] {
  const period = input.period;
  const latestApproval = new Map<string, CeoApprovalStepInput>();
  for (const step of input.ceoApprovals) {
    if (step.isCc || step.stepCode !== CEO_APPROVAL_STEP_CODE || step.status !== "approved" || !step.decisionAt) continue;
    if (period && Date.parse(step.decisionAt) >= Date.parse(period.endIso)) continue;
    const previous = latestApproval.get(step.requestId);
    if (!previous || String(previous.decisionAt) < step.decisionAt) latestApproval.set(step.requestId, step);
  }

  const stepsByRequest = new Map<string, CeoApprovalStepInput[]>();
  for (const step of input.steps) {
    if (step.isCc) continue;
    const list = stepsByRequest.get(step.requestId) ?? [];
    list.push(step);
    stepsByRequest.set(step.requestId, list);
  }

  const rows: MarketingCeoApprovalRow[] = [];
  for (const [requestId, approval] of latestApproval) {
    const request = input.requestsById.get(requestId);
    if (!request) continue;
    const steps = (stepsByRequest.get(requestId) ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    const financeStep = steps.filter((step) => step.stepCode === EXECUTION_STEP_CODE).at(-1);
    const openStep = steps.find((step) => step.status === "current");
    const finance = financeStateOf(request, financeStep, openStep);
    const listedAs: CeoApprovalListedAs =
      period && Date.parse(approval.decisionAt as string) < Date.parse(period.startIso) ? "carried_over" : "approved_in_period";
    if (listedAs === "carried_over" && !CARRY_OVER_STATES.has(finance.state)) continue;
    const executed = finance.state === "executed";
    const decider = input.deciders.get(canonicalHrIdKey(approval.decisionByHrId) ?? "");
    const executor = executed ? input.deciders.get(canonicalHrIdKey(financeStep?.decisionByHrId) ?? "") : undefined;

    rows.push({
      approvedAtIso: approval.decisionAt as string,
      approvedOnBehalfBy: decider && !decider.isCeo ? decider.name : null,
      customerId: request.customerId,
      customerName: request.customerName,
      estimatedCost: request.estimatedCost,
      executedAtIso: executed ? financeStep?.executedAt ?? financeStep?.decisionAt ?? null : null,
      executedByName: executor?.name ?? null,
      financeLabel: finance.label,
      financeState: finance.state,
      href: request.href,
      lineName: request.lineName,
      listedAs,
      payDate: request.payDate,
      payDateOverdue:
        !executed && finance.state !== "closed_out" && Boolean(request.payDate) && String(request.payDate).slice(0, 10) < input.todayCairo,
      requestCode: request.requestCode,
      requestId,
      requesterHrId: request.requesterHrId,
      requesterName: request.requesterName,
      requestType: request.requestType,
      statusLabel: humanize(request.status) ?? request.status,
    });
  }

  return rows.sort((a, b) => a.approvedAtIso.localeCompare(b.approvedAtIso) || a.requestCode.localeCompare(b.requestCode));
}

// ── The totals of what is ticked ────────────────────────────────────────────

export type CeoApprovalsTotals = {
  carriedOverCount: number;
  count: number;
  executedCount: number;
  executedValue: number;
  overdueCount: number;
  totalValue: number;
  waitingCount: number;
  waitingValue: number;
};

/** Totals over the ticked rows only — the page's tiles and footer both read this one function. */
export function summarizeCeoApprovals(
  rows: readonly MarketingCeoApprovalRow[],
  selected?: ReadonlySet<string>,
): CeoApprovalsTotals {
  const totals: CeoApprovalsTotals = {
    carriedOverCount: 0,
    count: 0,
    executedCount: 0,
    executedValue: 0,
    overdueCount: 0,
    totalValue: 0,
    waitingCount: 0,
    waitingValue: 0,
  };
  for (const row of rows) {
    if (selected && !selected.has(row.requestId)) continue;
    totals.count += 1;
    if (row.listedAs === "carried_over") totals.carriedOverCount += 1;
    totals.totalValue += row.estimatedCost;
    if (row.financeState === "executed") {
      totals.executedCount += 1;
      totals.executedValue += row.estimatedCost;
    } else if (row.financeState !== "closed_out") {
      totals.waitingCount += 1;
      totals.waitingValue += row.estimatedCost;
    }
    if (row.payDateOverdue) totals.overdueCount += 1;
  }
  return totals;
}

export type MarketingCeoApprovals = {
  generatedAtIso: string;
  range: CeoApprovalsRange;
  rows: MarketingCeoApprovalRow[];
};
