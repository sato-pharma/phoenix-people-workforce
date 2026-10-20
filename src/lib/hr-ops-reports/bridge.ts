// Carries the Super Admin's decisions in the HR Daily & Weekly Reports into the weekly attendance
// review, and from there into payroll — the way a fingerprint day already travels.
//
// Owner, 2026-10-20: the HR Operations Specialist reviews each day "in days only" and "she will never
// take desicion"; the Super Admin decides. A decision means nothing until it reaches the employee and
// payroll, and the one road there already exists: the weekly attendance review (digest-service.ts).
// The employee chooses salary or annual balance, may dispute, and digest-bridge.ts applies the answer
// to the month-end deduction through recordDecision. This module puts each decided day on that road.
//
// WHAT ONE DECIDED DAY BECOMES
//   • OFFICE. The review owns an office day: the daily job adds it from the fingerprint report, and the
//     month-end Fingerprint connector stays its ONLY deduction writer (time-off module rule). So the
//     bridge only ever SETS the review's own day to the decided days, through the existing tick path
//     (phx_attendance_mark_digest_line), ticked, stamped with who decided it and when — it never adds an
//     office day and never writes a deduction for one. A day the review does not hold yet stays
//     `waiting` and is retried until the daily job adds it; once its week is closed, or has gone out to
//     the employee with nothing of it still waiting, it is `week_released` with nothing written.
//   • FIELD. Added as a `field_review` day ("Field day (reviewed by HR)"), ticked, at the decided days,
//     with one Pending deduction in the `field_review` category — paid through the CRM column, answered
//     and disputed like a fingerprint day. The CRM connector leaves out any day such a deduction claims
//     (connectors/crm.ts, loadFieldReviewClaimedDays), so the day is never charged twice.
//
// WHAT IT NEVER DOES
//   • It never releases a week, never tells anybody anything, and never decides a deduction. The day
//     waits for the Super Admin's own release, like every other day.
//   • It never writes into a released week. A day whose week is out (or that is already answered) is
//     `week_released`, with nothing written; changing it is a person's job on the review page.
//   • It never throws out of the loop. One day that fails is `failed` with its reason, and every other
//     day is still carried. A failed or waiting day is retried by retryWaitingBridges.
//
// IDEMPOTENT. The review day carries the report line's id (unique), so a second run finds its own day;
// the deduction's candidate key is deterministic, so a second insert is skipped. And the daily job never
// refreshes, overwrites or removes a day the bridge wrote or set
// (20261020072217_hr_ops_bridge_field_review.sql), so a decision is never undone by the next refresh.

import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrIdForStorage } from "@/lib/hr-id.ts";
import { HR_OPS_REPORT_SOURCE_SYSTEM } from "@/lib/attendance/digest-rules.ts";
import { getDigestSettings } from "@/lib/attendance/digest-service.ts";
import { refreshableReviewWeek, tileReviewMonth, type SettlementWeek } from "@/lib/attendance/digest-weeks.ts";
import { cairoTodayIso } from "@/lib/attendance/working-days.ts";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { isDeductionExemptEmployee } from "@/lib/deductions/exempt-employees.ts";
import { insertCandidateDrafts } from "@/lib/deductions/service.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";

const BRIDGE_ACTOR = "system:hr-ops-report-bridge";
const PAGE = 1000;

export type HrOpsBridgeCounts = { bridged: number; waiting: number; weekReleased: number; failed: number };

/** One decided report line, as the bridge reads it. */
export type HrOpsBridgeLine = {
  id: string;
  section: "office" | "field";
  workDate: string;
  hrId: string;
  hrKey: string;
  employeeName: string;
  flags: string[];
  reviewReason: string | null;
  decision: string | null;
  decidedDays: number | null;
  decidedByHrId: string | null;
  decidedAt: string | null;
};

export type BridgeDayRequest = {
  hrOpsLineId: string;
  section: "office" | "field";
  employeeHrId: string;
  workDate: string;
  cycleKey: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  days: number;
  /** The priced estimate for a field day the bridge adds; null for an office day, which is never added. */
  value: number | null;
  reason: string;
  evidence: Record<string, string>;
  decidedByHrId: string;
  decidedAt: string | null;
  /** True only for a field day in a week the review still takes days for. Never true for an office day. */
  allowInsert: boolean;
};

/** What phx_hr_ops_bridge_digest_day answered. */
export type BridgeDayOutcome =
  | {
      outcome: "bridged";
      lineId: number;
      digestEmployeeHrId: string;
      lineStatus: string;
      created: boolean;
      alreadyBridged: boolean;
    }
  | { outcome: "waiting" }
  | { outcome: "week_released"; lineId: number | null; lineAction: string | null }
  | { outcome: "conflict"; lineId: number | null; message: string };

export type SavedBridgeOutcome = {
  status: "bridged" | "waiting" | "week_released" | "failed" | "not_needed";
  /** The weekly-review day's id, when there is one. */
  ref: string | null;
  message: string;
  /** When the day reached the weekly review; null for every other outcome. */
  at: string | null;
};

/** Everything the bridge reads and writes, so the whole walk can be tested without a database. */
export type HrOpsBridgeDeps = {
  todayIso: () => string;
  nowIso: () => string;
  /** Whether the weekly review is live. Null `why` when it is. */
  reviewLive: () => Promise<{ live: boolean; why: string | null }>;
  /** Base salary by compact HR id. Throws, or comes back empty, when it cannot be read. */
  baseSalaries: () => Promise<ReadonlyMap<string, number>>;
  bridgeDay: (request: BridgeDayRequest) => Promise<BridgeDayOutcome>;
  /** Writes a field day's one deduction (idempotent) and returns its id. */
  ensureCandidate: (draft: DeductionsCandidateDraft) => Promise<{ candidateId: string | null; warnings: string[] }>;
  saveOutcome: (lineId: string, outcome: SavedBridgeOutcome) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-20" -> "20 October 2026". Date-only, read off the string. */
function dayLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ""} ${match[1]}`;
}

function daysText(days: number): string {
  const rounded = Math.round(days * 1000) / 1000;
  if (rounded === 0.5) return "half a day";
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

/** The Cairo calendar day of a timestamp. */
function cairoDateOf(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(date);
}

const FLAG_LABELS: Record<string, string> = {
  early_leave: "Left early",
  late: "Late",
  no_field_activity: "No field activity",
  no_punch: "No punch",
  single_punch: "Single punch",
};

function flagLabel(flag: string): string {
  const known = FLAG_LABELS[flag];
  if (known) return known;
  const spaced = flag.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

/** The review week a day falls in, or null when the weekly review has no week for it. */
export function reviewWeekForDay(workDate: string): (SettlementWeek & { monthKey: string }) | null {
  const monthKey = workDate.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return null;
  const week = tileReviewMonth(monthKey).find((candidate) => candidate.startIso <= workDate && workDate <= candidate.endIso);
  return week ? { ...week, monthKey } : null;
}

/** What the weekly-review day says about where it came from — words only, never an HR code. */
export function reviewedDayEvidence(line: HrOpsBridgeLine): Record<string, string> {
  const evidence: Record<string, string> = {
    reviewed_as: line.section === "field" ? "Field day" : "Office day",
    decided_in: "HR operations report",
  };
  const issues = line.flags.map(flagLabel).filter(Boolean);
  if (issues.length) evidence.issues_found = issues.join(", ");
  const note = String(line.reviewReason ?? "").trim();
  if (note) evidence.hr_operations_note = note;
  const decidedOn = cairoDateOf(line.decidedAt);
  if (decidedOn) evidence.decided_on = dayLabel(decidedOn);
  return evidence;
}

/** The sentence a field day the bridge adds carries as its reason. */
export function reviewedDayReason(line: HrOpsBridgeLine, days: number): string {
  const kind = line.section === "field" ? "Field day" : "Office day";
  return `${kind} reviewed in the HR operations report and decided at ${daysText(days)}.`;
}

/**
 * A reviewed field day's one deduction. `employeeHrId` is the WEEKLY REVIEW's own spelling of the
 * person, so the source record id is exactly `${hrId}:${date}` as every reader of a review day builds it.
 */
export function buildReviewedDayDraft(input: {
  line: HrOpsBridgeLine;
  employeeHrId: string;
  days: number;
  amount: number;
}): DeductionsCandidateDraft {
  const [year, month] = input.line.workDate.split("-").map(Number);
  const decidedOn = cairoDateOf(input.line.decidedAt);
  const evidence: Record<string, unknown> = {
    section: "Field day",
    decidedDays: input.days,
  };
  const issues = input.line.flags.map(flagLabel).filter(Boolean);
  if (issues.length) evidence.issuesFound = issues;
  const note = String(input.line.reviewReason ?? "").trim();
  if (note) evidence.reviewNote = note;
  if (decidedOn) evidence.decidedOn = decidedOn;
  return {
    category: "field_review",
    sourceSystem: HR_OPS_REPORT_SOURCE_SYSTEM,
    sourceRecordId: `${input.employeeHrId}:${input.line.workDate}`,
    employeeHrId: input.employeeHrId,
    employeeName: input.line.employeeName || null,
    monthKey: input.line.workDate.slice(0, 7),
    month: month!,
    year: year!,
    unit: "days",
    rawValue: input.days,
    estimatedAmount: input.amount,
    calculationStatus: "calculated",
    reason: reviewedDayReason(input.line, input.days),
    evidence,
    dates: [input.line.workDate],
  };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

type RunContext = {
  today: string;
  live: { live: boolean; why: string | null } | null;
  liveError: string | null;
  salaries: ReadonlyMap<string, number> | null;
  salaryError: string | null;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function bridgeOne(line: HrOpsBridgeLine, context: RunContext, deps: HrOpsBridgeDeps): Promise<SavedBridgeOutcome> {
  const days = line.decidedDays;
  if (line.decision !== "approved" || days === null || !Number.isFinite(days) || days <= 0) {
    return { status: "not_needed", ref: null, message: "Nothing to carry: the decision deducts no days.", at: null };
  }
  // Written to the review day as who decided it, so in the form an HR id is STORED in (hr-id.ts).
  const decidedBy = String(hrIdForStorage(String(line.decidedByHrId ?? "").trim() || null) ?? "").trim();
  if (!decidedBy) {
    return { status: "failed", ref: null, message: "The decision does not say who took it, so it was not carried.", at: null };
  }
  // The owner took these people out of every automated deduction (exempt-employees.ts).
  if (isDeductionExemptEmployee(line.hrId)) {
    return { status: "not_needed", ref: null, message: "This person is exempt from every deduction, so nothing was carried.", at: null };
  }
  const week = reviewWeekForDay(line.workDate);
  if (!week) {
    return { status: "failed", ref: null, message: `The weekly attendance review has no week for ${dayLabel(line.workDate)}.`, at: null };
  }
  if (context.liveError) {
    return { status: "failed", ref: null, message: `The weekly attendance review's settings could not be read: ${context.liveError}`, at: null };
  }
  if (!context.live?.live) {
    return { status: "waiting", ref: null, message: context.live?.why ?? "The weekly attendance review is not live yet.", at: null };
  }
  // The review holds a day from the morning after it was worked.
  if (line.workDate >= context.today) {
    return { status: "waiting", ref: null, message: "The weekly attendance review takes a day the morning after it is worked; this one is carried on the next run.", at: null };
  }

  // Only a week of this review month or the month before takes days — the same window the daily job and
  // the Refresh button keep up to date. An older week is closed: its days are in month-end payroll.
  const open = refreshableReviewWeek(week.monthKey, week.index, context.today) !== null;
  const isField = line.section === "field";
  // Only a FIELD day is ever added by the bridge. An office day is the daily job's to add, and its one
  // deduction is the month-end Fingerprint connector's to write.
  const allowInsert = isField && open;

  // A field day the bridge adds is priced the way a deduction is: base salary ÷ the month's calendar days.
  let amount: number | null = null;
  let unpricedWhy = "";
  if (isField) {
    const compact = compactDeductionsHrId(line.hrId);
    const salary = compact && context.salaries ? (context.salaries.get(compact) ?? null) : null;
    const [year, month] = line.workDate.split("-").map(Number);
    amount =
      salary === null ? null : calculateDeductionAmountFromBaseSalary({ baseSalary: salary, deductionDays: days, month: month!, year: year! });
    unpricedWhy = context.salaryError
      ? `the salary list could not be read (${context.salaryError})`
      : "no base salary is recorded for this person, so the day cannot be priced and a deduction with no amount would hold up the month's payroll";
    if (allowInsert && amount === null) {
      return { status: "failed", ref: null, message: `Nothing was written: ${unpricedWhy}.`, at: null };
    }
  }

  const outcome = await deps.bridgeDay({
    hrOpsLineId: line.id,
    section: line.section,
    employeeHrId: hrIdForStorage(line.hrId) ?? line.hrId,
    workDate: line.workDate,
    cycleKey: week.monthKey,
    weekIndex: week.index,
    weekStart: week.startIso,
    weekEnd: week.endIso,
    days,
    value: amount,
    reason: reviewedDayReason(line, days),
    evidence: reviewedDayEvidence(line),
    decidedByHrId: decidedBy,
    decidedAt: line.decidedAt,
    allowInsert,
  });

  switch (outcome.outcome) {
    case "waiting":
      if (!open) {
        return {
          status: "week_released",
          ref: null,
          message: `The week holding ${dayLabel(line.workDate)} is closed in the weekly attendance review and the day was never in it, so nothing was written.`,
          at: null,
        };
      }
      return {
        status: "waiting",
        ref: null,
        message: `The weekly attendance review does not hold ${dayLabel(line.workDate)} yet. The decided days are set on it once the review's daily refresh adds the day from the fingerprint report.`,
        at: null,
      };
    case "week_released":
      return {
        status: "week_released",
        ref: outcome.lineId === null ? null : String(outcome.lineId),
        message:
          outcome.lineId === null
            ? `The week holding ${dayLabel(line.workDate)} was already released in the weekly attendance review without this day, so nothing was written.`
            : outcome.lineAction && outcome.lineAction !== "pending"
              ? `${dayLabel(line.workDate)} was already released and answered in the weekly attendance review, so nothing was written. Change it there if it must change.`
              : `The week holding ${dayLabel(line.workDate)} was already released in the weekly attendance review, so nothing was written. Change it there if it must change.`,
        at: null,
      };
    case "conflict":
      return { status: "failed", ref: outcome.lineId === null ? null : String(outcome.lineId), message: outcome.message, at: null };
    case "bridged":
      break;
  }

  const ref = String(outcome.lineId);
  const warnings: string[] = [];
  // A field day the bridge holds needs its one deduction; an office (fingerprint) day has the connector's.
  if (outcome.lineStatus === "field_review") {
    if (amount === null) {
      return {
        status: "failed",
        ref,
        message: `The day is in the weekly attendance review, but its deduction was not written: ${unpricedWhy || "it could not be priced"}. It is retried.`,
        at: null,
      };
    }
    const written = await deps.ensureCandidate(buildReviewedDayDraft({ line, employeeHrId: outcome.digestEmployeeHrId, days, amount }));
    if (!written.candidateId) {
      return {
        status: "failed",
        ref,
        message: `The day is in the weekly attendance review, but its deduction was not written${written.warnings.length ? `: ${written.warnings.join(" ")}` : ""}. It is retried.`,
        at: null,
      };
    }
    warnings.push(...written.warnings);
  }

  const said = outcome.alreadyBridged
    ? `Already in the weekly attendance review at ${daysText(days)}.`
    : outcome.created
      ? `Added to the weekly attendance review, ticked at ${daysText(days)}. It waits for the week's release.`
      : `Set to ${daysText(days)} on the weekly attendance review's own day, ticked. It waits for the week's release.`;
  return { status: "bridged", ref, message: warnings.length ? `${said} ${warnings.join(" ")}` : said, at: deps.nowIso() };
}

/** Carries every line given; never throws for one line. */
export async function runHrOpsBridge(lines: readonly HrOpsBridgeLine[], deps: HrOpsBridgeDeps): Promise<HrOpsBridgeCounts> {
  const counts: HrOpsBridgeCounts = { bridged: 0, waiting: 0, weekReleased: 0, failed: 0 };
  if (!lines.length) return counts;

  // The shared reads, once per run. Each failure fails only the days that need it.
  const context: RunContext = {
    today: deps.todayIso(),
    live: null,
    liveError: null,
    salaries: null,
    salaryError: null,
  };
  try {
    context.live = await deps.reviewLive();
  } catch (error) {
    context.liveError = messageOf(error);
  }
  // Only a field day is priced, so the salary list is read only when there is one to price.
  if (lines.some((line) => line.section === "field" && line.decision === "approved")) {
    try {
      const salaries = await deps.baseSalaries();
      // The salary feeder swallows a failed query and returns an empty map, so empty means unread.
      if (salaries.size === 0) context.salaryError = "it came back empty";
      else context.salaries = salaries;
    } catch (error) {
      context.salaryError = messageOf(error);
    }
  }

  for (const line of lines) {
    let saved: SavedBridgeOutcome;
    try {
      saved = await bridgeOne(line, context, deps);
    } catch (error) {
      saved = { status: "failed", ref: null, message: `Could not be carried into the weekly attendance review: ${messageOf(error)}`, at: null };
    }
    try {
      await deps.saveOutcome(line.id, saved);
    } catch {
      // The line keeps its old status and is retried; the day itself is idempotent.
      counts.failed += 1;
      continue;
    }
    if (saved.status === "bridged") counts.bridged += 1;
    else if (saved.status === "waiting") counts.waiting += 1;
    else if (saved.status === "week_released") counts.weekReleased += 1;
    else if (saved.status === "failed") counts.failed += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

const LINE_SELECT = "id,section,work_date,hr_id,hr_key,employee_name,flags,review_reason,decision,decided_days,decided_by_hr_id,decided_at";

function toBridgeLine(row: Record<string, unknown>): HrOpsBridgeLine {
  const days = row.decided_days === null || row.decided_days === undefined ? null : Number(row.decided_days);
  return {
    id: String(row.id),
    section: row.section === "field" ? "field" : "office",
    workDate: String(row.work_date ?? "").slice(0, 10),
    hrId: String(row.hr_id ?? ""),
    hrKey: String(row.hr_key ?? ""),
    employeeName: String(row.employee_name ?? ""),
    flags: Array.isArray(row.flags) ? (row.flags as unknown[]).map(String) : [],
    reviewReason: typeof row.review_reason === "string" ? row.review_reason : null,
    decision: typeof row.decision === "string" ? row.decision : null,
    decidedDays: days === null || !Number.isFinite(days) ? null : days,
    decidedByHrId: typeof row.decided_by_hr_id === "string" ? row.decided_by_hr_id : null,
    decidedAt: typeof row.decided_at === "string" ? row.decided_at : null,
  };
}

async function readLines(filter: { reportId?: string; statuses: readonly string[] }): Promise<HrOpsBridgeLine[]> {
  const lines: HrOpsBridgeLine[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = getSupabaseAdmin().from("hr_ops_report_lines").select(LINE_SELECT).in("bridge_status", [...filter.statuses]);
    if (filter.reportId) query = query.eq("report_id", filter.reportId);
    const { data, error } = await query
      .order("work_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`The decided report lines could not be read: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    lines.push(...rows.map(toBridgeLine));
    if (rows.length < PAGE) break;
  }
  return lines;
}

function parseOutcome(data: unknown): BridgeDayOutcome {
  const row = (data ?? {}) as Record<string, unknown>;
  const lineId = row.lineId === null || row.lineId === undefined ? null : Number(row.lineId);
  switch (row.outcome) {
    case "bridged":
      return {
        outcome: "bridged",
        lineId: Number(row.lineId),
        digestEmployeeHrId: String(row.digestEmployeeHrId ?? ""),
        lineStatus: String(row.lineStatus ?? ""),
        created: row.created === true,
        alreadyBridged: row.alreadyBridged === true,
      };
    case "waiting":
      return { outcome: "waiting" };
    case "week_released":
      return { outcome: "week_released", lineId, lineAction: typeof row.lineAction === "string" ? row.lineAction : null };
    case "conflict":
      return { outcome: "conflict", lineId, message: String(row.message ?? "The weekly attendance review holds this day differently.") };
    default:
      throw new Error(`The weekly attendance review answered "${String(row.outcome)}", which the bridge does not know.`);
  }
}

export function liveBridgeDeps(): HrOpsBridgeDeps {
  return {
    todayIso: () => cairoTodayIso(),
    nowIso: () => new Date().toISOString(),
    reviewLive: async () => {
      const settings = await getDigestSettings();
      if (!settings.enabled) return { live: false, why: "The weekly attendance review is switched off, so the decision waits until it is on." };
      if (settings.dryRun) {
        return { live: false, why: "The weekly attendance review is running as a trial, which is never released, so the decision waits until it is live." };
      }
      return { live: true, why: null };
    },
    baseSalaries: () => getBaseSalaryMap(),
    bridgeDay: async (request) => {
      const { data, error } = await getSupabaseAdmin().rpc("phx_hr_ops_bridge_digest_day", {
        p_hr_ops_line_id: request.hrOpsLineId,
        p_section: request.section,
        p_employee_hr_id: request.employeeHrId,
        p_work_date: request.workDate,
        p_cycle_key: request.cycleKey,
        p_week_index: request.weekIndex,
        p_week_start: request.weekStart,
        p_week_end: request.weekEnd,
        p_days: request.days,
        p_value: request.value,
        p_reason: request.reason,
        p_evidence: request.evidence,
        p_decided_by_hr_id: request.decidedByHrId,
        p_decided_at: request.decidedAt,
        p_allow_insert: request.allowInsert,
      });
      if (error) throw new Error(error.message || "The weekly attendance review refused the day.");
      return parseOutcome(data);
    },
    ensureCandidate: async (draft) => {
      const inserted = await insertCandidateDrafts({ createdBy: BRIDGE_ACTOR, drafts: [draft], sourceLabel: "HR operations report" });
      const { data, error } = await getSupabaseAdmin()
        .from("deductions_candidates")
        .select("id")
        .eq("category", draft.category)
        .eq("source_system", draft.sourceSystem)
        .eq("source_record_id", draft.sourceRecordId)
        .eq("month_key", draft.monthKey)
        .is("superseded_at", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) return { candidateId: null, warnings: [...inserted.warnings, `The deduction could not be read back: ${error.message}`] };
      const id = ((data ?? []) as Array<{ id?: unknown }>)[0]?.id;
      return { candidateId: id ? String(id) : null, warnings: inserted.warnings };
    },
    saveOutcome: async (lineId, outcome) => {
      const { error } = await getSupabaseAdmin()
        .from("hr_ops_report_lines")
        .update({
          bridge_status: outcome.status,
          bridge_ref: outcome.ref,
          bridge_message: outcome.message,
          bridged_at: outcome.at,
          updated_at: new Date().toISOString(),
        })
        .eq("id", lineId)
        // Only a line still on its way: a decision undone in between keeps what it now says.
        .in("bridge_status", ["waiting", "failed"]);
      if (error) throw new Error(error.message);
    },
  };
}

async function auditRun(summary: string, entityId: string, counts: HrOpsBridgeCounts): Promise<void> {
  await writeAuditLog({
    actorLoginId: BRIDGE_ACTOR,
    entityId,
    entityType: "hr_ops_report_bridge_run",
    newValues: counts as unknown as Record<string, unknown>,
    summary,
  });
}

/**
 * Carry one report's decided days into the weekly attendance review: every line of the report still
 * `waiting`. Called once the Super Admin has decided the report.
 */
export async function bridgeDecidedLines(input: { reportId: string }): Promise<HrOpsBridgeCounts> {
  const reportId = String(input.reportId ?? "").trim();
  if (!reportId) throw new Error("Validation: say which report to carry.");
  const lines = await readLines({ reportId, statuses: ["waiting"] });
  const counts = await runHrOpsBridge(lines, liveBridgeDeps());
  if (lines.length) {
    await auditRun(
      `HR operations report decisions carried into the weekly attendance review: ${counts.bridged} carried, ${counts.waiting} waiting, ${counts.weekReleased} in a released week, ${counts.failed} failed`,
      reportId,
      counts,
    );
  }
  return counts;
}

/** Try again every decided day still waiting for its review day, and every one that failed. */
export async function retryWaitingBridges(): Promise<HrOpsBridgeCounts> {
  const lines = await readLines({ statuses: ["waiting", "failed"] });
  const counts = await runHrOpsBridge(lines, liveBridgeDeps());
  if (lines.length) {
    await auditRun(
      `HR operations report decisions retried into the weekly attendance review: ${counts.bridged} carried, ${counts.waiting} waiting, ${counts.weekReleased} in a released week, ${counts.failed} failed`,
      "retry",
      counts,
    );
  }
  return counts;
}
