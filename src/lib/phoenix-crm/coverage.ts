/**
 * Phoenix CRM — coverage, frequency and list readiness, with no I/O.
 *
 * Owner answers, 2026-09-16:
 *   - Coverage = the share of the list visited this month.
 *   - Frequency = visits against the grade's monthly visits.
 *   - "Uncovered" for the planner = both: customers not visited this month first, then customers
 *     behind their grade's visits.
 *   - The list is "ready" when every reference customer is done: validated, or dropped with a reason
 *     once the district manager approves the drop. Owner, 2026-09-22: this is PROGRESS, shown to the
 *     manager on the Team tab — it has never held a plan back since that day. A customer not
 *     validated yet is planned and visited freely; he simply counts on NEITHER side of coverage or
 *     frequency until he is validated, and then his visits already saved start counting.
 *
 * Standing rule carried over (owner 2026-08-21, reaffirmed 2026-09-04): over-visiting is a deviation
 * too, never a bonus, so frequency counts customers EXACTLY on their grade's number and reports under
 * and over beside it. And a running month is not a closed one: "under" can still be caught up.
 */

import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";

/** 0 = not visited this month · 1 = behind its grade · 2 = on or over its grade. Lower plans first. */
export type CoverageTier = 0 | 1 | 2;

export function gradeTarget(settings: Pick<PhoenixCrmSettings, "gradeTargets">, listType: PhoenixCrmListType, grade: PhoenixCrmGrade | null): number | null {
  if (!grade) return null;
  return settings.gradeTargets[listType]?.[grade] ?? null;
}

export function coverageTier(visitsThisMonth: number, target: number | null): CoverageTier {
  if (visitsThisMonth <= 0) return 0;
  if (target !== null && visitsThisMonth < target) return 1;
  return 2;
}

export const COVERAGE_TIER_LABEL: Record<CoverageTier, string> = {
  0: "Not visited this month",
  1: "Behind its grade",
  2: "On its grade",
};

export type CoverageCustomer = {
  listType: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  visits: number;
};

export type CoverageSummary = {
  customers: number;
  covered: number;
  /** Covered ÷ customers, 0–100, one decimal. Null with an empty list. */
  coveragePct: number | null;
  /** Customers with a grade, so with a monthly number to meet. */
  withTarget: number;
  onTarget: number;
  under: number;
  over: number;
  /** On target ÷ customers with a target, 0–100, one decimal. */
  frequencyPct: number | null;
  visits: number;
};

/** Part ÷ whole as 0–100 with one decimal; null when there is nothing to divide by. */
export function sharePercent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** One list type at a time — AM and PM are never added together (owner rule: never averaged). */
export function summarizeCoverage(
  customers: ReadonlyArray<CoverageCustomer>,
  listType: PhoenixCrmListType,
  settings: Pick<PhoenixCrmSettings, "gradeTargets">,
): CoverageSummary {
  let count = 0;
  let covered = 0;
  let withTarget = 0;
  let onTarget = 0;
  let under = 0;
  let over = 0;
  let visits = 0;
  for (const customer of customers) {
    if (customer.listType !== listType) continue;
    count += 1;
    visits += customer.visits;
    if (customer.visits > 0) covered += 1;
    const target = gradeTarget(settings, listType, customer.grade);
    if (target === null) continue;
    withTarget += 1;
    if (customer.visits === target) onTarget += 1;
    else if (customer.visits < target) under += 1;
    else over += 1;
  }
  return {
    customers: count,
    covered,
    coveragePct: sharePercent(covered, count),
    withTarget,
    onTarget,
    under,
    over,
    frequencyPct: sharePercent(onTarget, withTarget),
    visits,
  };
}

// ── List readiness ──────────────────────────────────────────────────────────────────────────────

export type ReferenceState = "open" | "validated" | "drop_pending" | "dropped";

export type ReadinessSummary = {
  total: number;
  validated: number;
  dropped: number;
  dropPending: number;
  open: number;
  /** Every reference customer validated or dropped. A territory with no reference list is ready. */
  ready: boolean;
};

export function summarizeReadiness(states: ReadonlyArray<ReferenceState>): ReadinessSummary {
  let validated = 0;
  let dropped = 0;
  let dropPending = 0;
  let open = 0;
  for (const state of states) {
    if (state === "validated") validated += 1;
    else if (state === "dropped") dropped += 1;
    else if (state === "drop_pending") dropPending += 1;
    else open += 1;
  }
  return { total: states.length, validated, dropped, dropPending, open, ready: open === 0 && dropPending === 0 };
}
