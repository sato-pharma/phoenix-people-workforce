import { roundCurrency } from "@/lib/payroll/money";
import type { SalaryValidationRow } from "@/lib/payroll/salary-import";

import { calendarDaysInMonth } from "./proration.ts";
import type { CopilotFlag, CopilotPeriod, PriorRecordSnapshot, ProposedAction } from "./types.ts";

/**
 * The recommendation engine — the "AI" the CEO actually feels.
 *
 * For every flagged employee it produces ONE recommended resolution: the exact
 * action the CEO would apply with a single click, a plain-English reason, and a
 * confidence. Crucially this is DETERMINISTIC, not an LLM guess — each flag
 * already encodes the situation and the numbers are already computed, so the
 * recommendation is correct by construction (the LLM's job is only to parse
 * free-form edits and answer "why?" questions, where language actually matters).
 *
 * Confidence drives the UI's "Accept all":
 *   - "high"       → safe to bulk-accept (no pay impact, or a standard auto-computed settlement).
 *   - "review"     → real money moved; the CEO should glance before accepting.
 *   - "needs_input"→ no auto-action possible; a human must enter/fix data first.
 */

export type RecommendationConfidence = "high" | "review" | "needs_input";

export type CopilotRecommendation = {
  /** One-click action that resolves this row, or null when manual data entry is required. */
  action: ProposedAction | null;
  /** Short button label, e.g. "Accept settlement", "Prorate", "Confirm", "Enter figures". */
  actionLabel: string;
  /** Plain-English: what's flagged, what we recommend, and the resulting figure. */
  why: string;
  confidence: RecommendationConfidence;
};

const CHANGE_TOLERANCE = 1;

function changed(a: number, b: number): boolean {
  return Math.abs(roundCurrency(a) - roundCurrency(b)) > CHANGE_TOLERANCE;
}

function egp(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

export function recommendResolution(input: {
  hrId: string;
  openFlags: CopilotFlag[];
  row: SalaryValidationRow;
  monthSalary: number;
  unpaidLeaveDays: number;
  prior: PriorRecordSnapshot | null;
  period: CopilotPeriod;
}): CopilotRecommendation | null {
  const { hrId, openFlags, row, monthSalary, unpaidLeaveDays, prior, period } = input;
  if (openFlags.length === 0) return null; // green — nothing to recommend

  const has = (rule: string) => openFlags.some((flag) => flag.rule === rule);
  const flagOf = (rule: string) => openFlags.find((flag) => flag.rule === rule);

  // 1) missing_data — genuinely needs a human to enter figures; no safe auto-action.
  if (has("missing_data")) {
    return {
      action: null,
      actionLabel: "Enter figures",
      why: "No base/gross/net salary on file — the Copilot can't pay from empty compensation. Enter the figures in the employee master, then re-run.",
      confidence: "needs_input",
    };
  }

  // 2) joiner_leaver with an UNPARSEABLE date (block) — the date itself must be fixed.
  const jl = flagOf("joiner_leaver");
  if (jl && jl.severity === "block") {
    return {
      action: null,
      actionLabel: "Fix date",
      why: "Joiner/leaver whose hire or last-working date couldn't be read — fix the date on the employee record before including them.",
      confidence: "needs_input",
    };
  }

  // 3) unpaid_leave (block) — recommend prorating to the worked days.
  if (has("unpaid_leave") && unpaidLeaveDays > 0) {
    const calendarDays = calendarDaysInMonth(period);
    const workedDays = Math.max(0, calendarDays - unpaidLeaveDays);
    return {
      action: {
        kind: "prorate",
        hrId,
        workedDays,
        reason: `${unpaidLeaveDays} unpaid leave day(s) — prorate to ${workedDays} worked days`,
      },
      actionLabel: "Prorate",
      why: `${unpaidLeaveDays} unpaid leave day(s) this month. Recommended: prorate to ${workedDays} of ${calendarDays} days (Base-only day rate). Accept to apply.`,
      confidence: "high",
    };
  }

  // 4) joiner_leaver (warn, computable) — settlement is already auto-calculated; recommend accept.
  if (jl) {
    return {
      action: { kind: "confirm", hrId, reason: "joiner/leaver settlement accepted as auto-computed" },
      actionLabel: "Accept settlement",
      why: `Partial month — settlement auto-calculated to ${egp(monthSalary)} using the standard day-rate rules. Accept, or edit if there's a special arrangement.`,
      confidence: "high",
    };
  }

  // 5) salary_role_change (warn) — split by what actually changed:
  //    • base salary moved   → real money; recommend accept but mark "review".
  //    • only line/role moved → org churn (e.g. a reorg), no pay impact; safe to bulk-accept.
  if (has("salary_role_change")) {
    const baseMoved = prior != null && changed(prior.baseSalary, row.baseSalary);
    if (baseMoved) {
      return {
        action: { kind: "confirm", hrId, reason: "base-salary change confirmed as correct" },
        actionLabel: "Confirm new base",
        why: `Base salary changed ${egp(prior!.baseSalary)} → ${egp(row.baseSalary)} vs last month. Verify this raise/cut is intended, then accept.`,
        confidence: "review",
      };
    }
    return {
      action: { kind: "confirm", hrId, reason: "line/role change (no pay impact) confirmed" },
      actionLabel: "Confirm",
      why: "Only line/role changed since last month (an org update) — no pay impact. Safe to accept.",
      confidence: "high",
    };
  }

  // 6) big_change (warn) — net swung sharply; real money, worth a glance.
  const big = flagOf("big_change");
  if (big) {
    return {
      action: { kind: "confirm", hrId, reason: "net-change confirmed as correct" },
      actionLabel: "Confirm",
      why: `${big.question} Recommended: accept if this reflects a real change (bonus, deduction, part-month).`,
      confidence: "review",
    };
  }

  // 7) attendance_conflict (warn) — a governance deduction is still pending; the safe
  //    default is to let that flow apply it (never double-count here).
  if (has("attendance_conflict")) {
    return {
      action: { kind: "confirm", hrId, reason: "attendance deduction left to the governance flow this run" },
      actionLabel: "Leave as-is",
      why: "An attendance deduction is awaiting governance approval — it will be applied through that flow, not double-counted here. Recommended: accept as-is this run.",
      confidence: "high",
    };
  }

  // Fallback: any other open warn — recommend confirm, echo the question.
  return {
    action: { kind: "confirm", hrId, reason: "confirmed as correct" },
    actionLabel: "Confirm",
    why: openFlags[0].question,
    confidence: "review",
  };
}
