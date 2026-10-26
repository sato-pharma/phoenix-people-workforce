import { utcDate } from "@/lib/format/cairo-datetime";
import { planKindLabel, planSlotLabel } from "@/lib/weekly-planning/calendar";
import { weekStartDateFromWeekKey } from "@/lib/weekly-planning/week";

// Plain wording for the Weekly / Monthly Plan screens, notifications and emails.
//
// One home for the phrases that used to be assembled by hand in a dozen places and so drifted:
// `weekly 2026-W41` (a lowercase kind and a week CODE), `by B-10 (Manager)` (an HR id), a bare
// `2 approved, 1 failed.` Every function here is pure so a test can hold it, and none reaches the
// database or the browser.
//
// DATES. A plan period is two DATE-ONLY values (`period_start_date`, `period_end_date`), which
// `utcDate` renders in UTC on purpose: UTC is what stops the calendar day shifting. Nothing here is
// an instant, so nothing here belongs in Cairo.

function dateOrEmpty(value: string | null | undefined): string {
  const label = utcDate(value);
  return label === "—" ? "" : label;
}

/** `12 Oct 2026 to 18 Oct 2026`. One date when the period is a single day; "" when neither parses. */
export function planPeriodLabel(startDate: string | null | undefined, endDate: string | null | undefined): string {
  const start = dateOrEmpty(startDate);
  const end = dateOrEmpty(endDate);
  if (start && end) return start === end ? start : `${start} to ${end}`;
  return start || end;
}

/**
 * `Week of 18 Oct` — a week named by the day it starts on, never by its code ("2026-W42") or a bare
 * ISO date ("Week: 2026-10-24"). Takes the week's start date, or a week key it turns into one;
 * "" when neither parses.
 */
export function weekOfLabel(weekStartOrKey: string | null | undefined): string {
  const raw = String(weekStartOrKey ?? "").trim();
  const start = weekStartDateFromWeekKey(raw) ?? raw;
  const label = dateOrEmpty(start);
  return label ? `Week of ${label.replace(/ \d{4}$/, "").replace(/^0/, "")}` : "";
}

/**
 * The period a plan covers, in words: `Week of 18 Oct` for a weekly plan, `Aug 2026` for a monthly
 * one. Falls back to the stored key only when nothing parses, so a code is the last resort.
 */
export function planPeriodShortLabel(plan: { periodKey: string; periodStartDate?: string | null; planKind: string }): string {
  if (plan.planKind === "weekly") return weekOfLabel(plan.periodStartDate || plan.periodKey) || plan.periodKey;
  const month = /^\d{4}-\d{2}$/.test(plan.periodKey) ? dateOrEmpty(`${plan.periodKey}-01`).replace(/^\d{1,2} /, "") : "";
  return month || planPeriodLabel(plan.periodStartDate, null) || plan.periodKey;
}

/** `Weekly plan` / `Monthly plan`; a kind it does not know is left as "Plan" rather than guessed. */
export function planNounLabel(kind: string | null | undefined): string {
  const label = planKindLabel(kind);
  // `planKindLabel` hands an unknown kind back as typed, so only the two real kinds are worded here.
  return label === "Weekly" || label === "Monthly" ? `${label} plan` : "Plan";
}

/** `Weekly plan · 12 Oct 2026 to 18 Oct 2026` — the heading a plan card wears. */
export function planHeadingLabel(
  kind: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string {
  const range = planPeriodLabel(startDate, endDate);
  return range ? `${planNounLabel(kind)} · ${range}` : planNounLabel(kind);
}

/**
 * `weekly plan for 12 Oct 2026 to 18 Oct 2026` — the same plan, written to sit inside a sentence
 * ("Ahmed submitted a weekly plan for 12 Oct 2026 to 18 Oct 2026."), so its first letter is lower
 * case. A heading or the start of a sentence uses `planNounLabel` / `planHeadingLabel` instead.
 */
export function planSentenceLabel(
  kind: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string {
  const noun = planNounLabel(kind).toLowerCase();
  const range = planPeriodLabel(startDate, endDate);
  return range ? `${noun} for ${range}` : noun;
}

/**
 * The three facts the plan emails put in their details block: who, which kind of plan, which dates.
 * The employee is named, never numbered ("Ahmed Hassan (B-52)" put a code in front of the reader),
 * and the period is the dates themselves ("12 Oct 2026 to 18 Oct 2026"), not the week code
 * ("2026-W42") and not two ISO dates.
 */
export function planEmailMetrics(plan: {
  employee_name: string;
  period_end_date: string;
  period_key: string;
  period_start_date: string;
  plan_kind: string;
}): Array<{ label: string; value: string }> {
  return [
    { label: "Employee", value: plan.employee_name },
    { label: "Plan", value: planNounLabel(plan.plan_kind) },
    { label: "Period", value: planPeriodLabel(plan.period_start_date, plan.period_end_date) || plan.period_key },
  ];
}

/**
 * The half of the day a plan row covers — AM, PM, Full day, or its two clock times — worded by the
 * one helper the planning calendar, the planner and the approval email already share, so a day
 * split into a morning and an afternoon row can be told apart wherever its rows are listed.
 */
export function planRowPartLabel(row: { endTime: string | null; startTime: string | null }): string {
  return planSlotLabel(row.startTime, row.endTime);
}

/**
 * Who took a decision, for the decision history: the person's name, else the role they acted in,
 * else nothing. NEVER the HR id — an id is a code, and a reader who needs the person has the name.
 */
export function decisionActorLabel(decision: {
  actorName?: string | null;
  actorRole?: string | null;
}): string {
  return String(decision.actorName ?? "").trim() || String(decision.actorRole ?? "").trim();
}

export type BulkApproveRow = { message?: string; ok: boolean; planId: string };

export type BulkApprovePlanRef = {
  employeeDisplayName?: string | null;
  employeeName: string;
  id: string;
  periodEndDate: string;
  periodStartDate: string;
  planKind: string;
};

export type BulkApproveSummary = {
  /** Plans the server approved — the only ones whose selection tick may be cleared. */
  approvedIds: string[];
  /** Plans that stayed where they were, including any the server never answered for. */
  failedIds: string[];
  message: string;
  tone: "error" | "info";
};

/**
 * What a bulk approve tells the manager.
 *
 * The server answers one row per plan and the call itself still succeeds when some rows fail, so
 * the whole outcome has to be read from the rows. A plan the server did not answer for is counted
 * as NOT approved: reporting a success nobody confirmed is the worse mistake of the two. The failed
 * plans are named — employee and period — so the manager can see which ones to look at, and they
 * stay selected (the caller clears only `approvedIds`) so one more click retries exactly them.
 */
export function summarizeBulkApprove(
  requestedIds: readonly string[],
  rows: readonly BulkApproveRow[],
  plans: readonly BulkApprovePlanRef[],
): BulkApproveSummary {
  const okIds = new Set(rows.filter((row) => row.ok).map((row) => row.planId));
  const approvedIds = requestedIds.filter((id) => okIds.has(id));
  const failedIds = requestedIds.filter((id) => !okIds.has(id));
  const approvedCount = approvedIds.length;

  if (failedIds.length === 0) {
    return {
      approvedIds,
      failedIds,
      message: `${approvedCount} ${approvedCount === 1 ? "plan" : "plans"} approved.`,
      tone: "info",
    };
  }

  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const names = failedIds.map((id) => {
    const plan = planById.get(id);
    if (!plan) return "A plan that is no longer in your list";
    const owner = String(plan.employeeDisplayName || plan.employeeName || "").trim() || "Unnamed employee";
    return `${owner} (${planHeadingLabel(plan.planKind, plan.periodStartDate, plan.periodEndDate)})`;
  });
  const failedCount = failedIds.length;
  const lead = approvedCount === 0
    ? "No plan was approved."
    : `${approvedCount} ${approvedCount === 1 ? "plan" : "plans"} approved.`;
  const stays = failedCount === 1 ? "It stays selected" : "They stay selected";
  return {
    approvedIds,
    failedIds,
    message: `${lead} ${failedCount} could not be approved: ${names.join("; ")}. ${stays} so you can try again.`,
    tone: "error",
  };
}
