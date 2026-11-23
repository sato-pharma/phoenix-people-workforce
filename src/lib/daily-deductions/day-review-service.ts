// Daily Deductions: DEDUCT A DAY BY HAND — the server half. The rules are in day-review.ts (pure); this
// file reads the person, the day's record and the deductions already on it, and writes the one candidate.
//
// Super Admin only, both the read and the write: the read carries the person's day rate, and the write is
// a deduction. The other Daily Deductions readers (CEO, HR Operations, Finance Manager) never see the panel.

import type { AccessContext } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { dayChargeTarget, ledgerClaimMonthKeys, OFFICE_CYCLE_FIRST_MONTH_KEY } from "@/lib/deductions/cycle.ts";
import { loadOnePartEmployeeCompacts } from "@/lib/deductions/cycle-population.ts";
import { insertCandidateDrafts, listCandidatesForMonth } from "@/lib/deductions/service.ts";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { privateCalendarHrIdKey, privateCalendarSourceLabels } from "@/lib/private-calendar/logic";
import { getPrivateCalendarDayEvidence } from "@/lib/private-calendar/service";
import type { PrivateCalendarSource } from "@/lib/private-calendar/logic";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertDailyDeductionsPublishActor } from "./permissions.ts";
import { cairoTodayIso } from "./range.ts";
import { getActiveDailyPublication } from "./service.ts";
import { dailyDeductionConnectorLabels, isDailyDeductionConnector } from "./types.ts";
import {
  buildDayReviewDraft,
  chargesOnDay,
  dayReviewRefusal,
  isDayReviewFraction,
  priceDayReview,
  tidyDayReviewComment,
  type DayChargeOnRecord,
  type DayReviewEmployee,
  type DayReviewFraction,
} from "./day-review.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One thing Phoenix holds for the day, as the panel lists it. */
export type DayReviewRecordItem = {
  source: PrivateCalendarSource;
  sourceLabel: string;
  title: string;
  time: string | null;
  /** Every detail line the item carries — the visits, the punches, the leave — in full. */
  details: string[];
  severity: "danger" | "info" | "success" | "warning";
  status: string | null;
  /** An approved plan: what was INTENDED, never a record of the day (owner, 2026-10-12). */
  isPlan: boolean;
};

export type DayReviewRecord = {
  employee: {
    hrId: string;
    name: string;
    jobTitle: string | null;
    hasLeft: boolean;
    lastWorkingDate: string | null;
  };
  date: string;
  items: DayReviewRecordItem[];
  /** The day's record could not be read in full: an empty list is then "unknown", never "nothing happened". */
  recordIncomplete: boolean;
  /** The sources that could not be read, by NAME ("Attendance", "Vacation"...). */
  unreadableSources: string[];
  /** The live deductions already charging this person on this day. */
  existingCharges: DayChargeOnRecord[];
  /** The day as already RELEASED on this page (the "Released to employees" list). */
  releasedOnDay: DayReleasedLine[];
  /** The released list could not be read, so the push stays off rather than guess. */
  releasedUnreadable: boolean;
  /** What a full day and half a day cost, from Base ÷ that month's calendar days. Null: no base salary on record. */
  price: { fullDay: number | null; halfDay: number | null };
  /** The payroll month the day would be charged to. */
  payrollMonthKey: string;
  /** Why this day cannot be deducted, or null. */
  refusal: string | null;
};

/** A line of the active Daily Deductions snapshot that already holds the chosen day. */
export type DayReleasedLine = { lineId: string; label: string; amount: number; daysCount: number };

type EmployeeRow = {
  hr_id: string;
  full_name: string | null;
  nickname: string | null;
  job_title: string | null;
  base_salary: number | null;
  hire_date: string | null;
  last_working_date: string | null;
  employment_status: string | null;
};

async function loadEmployee(employeeHrId: string): Promise<EmployeeRow> {
  const hrId = employeeHrId.trim();
  if (!hrId) throw new Error("Validation: choose an employee.");
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, full_name, nickname, job_title, base_salary, hire_date, last_working_date, employment_status")
    .eq("hr_id", hrId)
    .maybeSingle();
  if (error) throw new Error(`Employee lookup failed: ${error.message}`);
  if (!data) throw new Error("Not found: no employee matches that record.");
  return data as EmployeeRow;
}

function toDayReviewEmployee(row: EmployeeRow): DayReviewEmployee {
  return {
    hrId: row.hr_id,
    fullName: row.full_name?.trim() || null,
    baseSalary: row.base_salary == null ? null : Number(row.base_salary),
    hireDate: row.hire_date ?? null,
    lastWorkingDate: row.last_working_date ?? null,
    hasLeft: isTerminalEmploymentStatus(row.employment_status),
  };
}

function displayNameOf(row: EmployeeRow): string {
  const full = row.full_name?.trim();
  return full ? resolveEmployeeDisplayName(full, row.nickname, row.hr_id) : "Name unavailable";
}

/**
 * The payroll month the day is charged to — the SAME month a collection run keys it to, so the day can
 * never sit on two rows of two months. An unreadable directory refuses, exactly as the Employee Day
 * Report does: guessing the cycle would put the day on the wrong payslip.
 */
async function chargeTargetFor(hrId: string, date: string) {
  const compact = compactDeductionsHrId(hrId);
  const isOnePart =
    date.slice(0, 7) >= OFFICE_CYCLE_FIRST_MONTH_KEY && compact ? (await loadOnePartEmployeeCompacts()).has(compact) : false;
  return dayChargeTarget(date, isOnePart);
}

/** Every live candidate of the person that could hold `date`: its calendar month and the next payroll month. */
async function loadChargesOnDay(hrId: string, date: string): Promise<DayChargeOnRecord[]> {
  const compact = compactDeductionsHrId(hrId);
  if (!compact) return [];
  const rows = (
    await Promise.all(
      ledgerClaimMonthKeys(date.slice(0, 7)).map((monthKey) => listCandidatesForMonth({ monthKey, employeeHrIdCompact: compact })),
    )
  ).flat();
  return chargesOnDay(
    rows.map((row) => ({
      id: row.id,
      category: row.category,
      sourceSystem: row.sourceSystem,
      monthKey: row.monthKey,
      dates: row.dates,
      estimatedAmount: row.estimatedAmount,
      supersededAt: row.supersededAt,
      decision: row.decision
        ? { decisionStatus: row.decision.decisionStatus, appliedDates: row.decision.appliedDates, appliedAmount: row.decision.appliedAmount }
        : null,
    })),
    date,
  );
}

/**
 * The day as already RELEASED on this page — the active snapshot's lines for this person that carry
 * the day. They are a separate store from the month module (released here, emailed, shown on the
 * portal), and the month collection later charges the same day on the Deductions screen; pushing a
 * hand-made day on top would put it there twice. A failed read THROWS: the caller decides.
 */
async function loadReleasedOnDay(hrId: string, date: string): Promise<DayReleasedLine[]> {
  const compact = compactDeductionsHrId(hrId);
  if (!compact) return [];
  const publication = await getActiveDailyPublication();
  if (!publication) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("daily_deductions_lines")
    .select("id, category, amount, days_count")
    .eq("publication_id", publication.id)
    .eq("employee_hr_id_compact", compact)
    .filter("dates", "cs", JSON.stringify([date]));
  if (error) throw new Error(`Released daily deductions could not be read: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    lineId: String(row.id),
    label: isDailyDeductionConnector(row.category) ? dailyDeductionConnectorLabels[row.category] : "Daily deduction",
    amount: Number(row.amount ?? 0),
    daysCount: Number(row.days_count ?? 0),
  }));
}

/** Choose a person and a day: everything Phoenix holds for it, the deductions already on it, and its price. */
export async function loadDayReviewRecord(input: {
  access: AccessContext;
  employeeHrId: string;
  date: string;
}): Promise<DayReviewRecord> {
  assertDailyDeductionsPublishActor(input.access);
  if (!ISO_DATE.test(input.date)) throw new Error("Validation: choose a day (YYYY-MM-DD).");
  const row = await loadEmployee(input.employeeHrId);
  const employee = toDayReviewEmployee(row);
  const todayIso = cairoTodayIso();

  const [evidence, existingCharges, target, released] = await Promise.all([
    getPrivateCalendarDayEvidence([{ date: input.date, employeeHrId: row.hr_id }]).catch(() => null),
    loadChargesOnDay(row.hr_id, input.date),
    chargeTargetFor(row.hr_id, input.date),
    loadReleasedOnDay(row.hr_id, input.date).catch(() => null),
  ]);
  const day = evidence?.get(`${privateCalendarHrIdKey(row.hr_id)}|${input.date}`) ?? null;

  const items: DayReviewRecordItem[] = (day?.items ?? []).map((item) => ({
    source: item.source,
    sourceLabel: item.sourceLabel,
    title: item.title,
    time: item.time,
    details: item.detailLines.length > 0 ? item.detailLines : item.description ? [item.description] : [],
    severity: item.severity,
    status: item.status,
    isPlan: item.source === "plan",
  }));

  return {
    employee: {
      hrId: row.hr_id,
      name: displayNameOf(row),
      jobTitle: row.job_title ?? null,
      hasLeft: employee.hasLeft,
      lastWorkingDate: employee.lastWorkingDate,
    },
    date: input.date,
    items,
    recordIncomplete: day === null || day.unreadableSources.length > 0,
    unreadableSources: (day?.unreadableSources ?? []).map((source) => privateCalendarSourceLabels[source] ?? source),
    existingCharges,
    releasedOnDay: released ?? [],
    releasedUnreadable: released === null,
    price: {
      fullDay: priceDayReview({ baseSalary: employee.baseSalary, date: input.date, fraction: 1 }),
      halfDay: priceDayReview({ baseSalary: employee.baseSalary, date: input.date, fraction: 0.5 }),
    },
    payrollMonthKey: target.monthKey,
    refusal: dayReviewRefusal({ employee, date: input.date, todayIso }),
  };
}

export type DayReviewPushResult = {
  candidateId: string | null;
  employeeName: string;
  date: string;
  fraction: DayReviewFraction;
  amount: number | null;
  payrollMonthKey: string;
};

/**
 * Push one day's deduction. It is written "Pending": the employee sees it, with the comment, on his own
 * Deductions page as under review, and payroll charges it only once it is "Approved for Payroll" on the
 * Deductions screen. Refused, with nothing written, when the day cannot be deducted for this person or
 * another live deduction already charges that day.
 */
export async function pushDayReviewDeduction(input: {
  access: AccessContext;
  employeeHrId: string;
  date: string;
  fraction: unknown;
  comment: unknown;
}): Promise<DayReviewPushResult> {
  assertDailyDeductionsPublishActor(input.access);
  if (!ISO_DATE.test(input.date)) throw new Error("Validation: choose a day (YYYY-MM-DD).");
  if (!isDayReviewFraction(input.fraction)) throw new Error("Validation: a day is deducted as 1 day or half a day.");
  const comment = tidyDayReviewComment(input.comment);

  const row = await loadEmployee(input.employeeHrId);
  const employee = toDayReviewEmployee(row);
  const refusal = dayReviewRefusal({ employee, date: input.date, todayIso: cairoTodayIso() });
  if (refusal) throw new Error(`Validation: ${refusal}`);

  const [existing, target, released] = await Promise.all([
    loadChargesOnDay(row.hr_id, input.date),
    chargeTargetFor(row.hr_id, input.date),
    loadReleasedOnDay(row.hr_id, input.date),
  ]);
  if (existing.some((charge) => charge.isDayReview)) {
    throw new Error("Conflict: this day was already pushed for this employee. Change or clear it on the Deductions screen.");
  }
  if (released.length > 0) {
    throw new Error(
      "Conflict: this day is already released for this employee on Daily Deductions. One day is charged once — withdraw that release first if this push should replace it.",
    );
  }
  if (existing.length > 0) {
    throw new Error(
      "Conflict: another deduction already charges this employee on this day. One day is charged once — clear or change that one on the Deductions screen first.",
    );
  }

  const enteredBy = input.access.hrId ?? input.access.loginId ?? "unknown";
  const draft = buildDayReviewDraft({
    employee,
    date: input.date,
    fraction: input.fraction,
    comment,
    enteredBy,
    charge: target,
  });

  const result = await insertCandidateDrafts({
    createdBy: enteredBy,
    drafts: [draft],
    sourceLabel: "Daily Deductions day review",
  });
  if (result.created === 0) {
    if (result.skippedExisting > 0) {
      throw new Error("Conflict: this day was already pushed for this employee. Change or clear it on the Deductions screen.");
    }
    throw new Error(`Nothing was written: ${result.warnings.join(" ") || "the deduction could not be saved."}`);
  }

  // Read the row back so the screen names the row that exists, never the one it meant to write.
  const compact = compactDeductionsHrId(row.hr_id) ?? undefined;
  const written = (await listCandidatesForMonth({ monthKey: target.monthKey, category: "other", employeeHrIdCompact: compact })).find(
    (candidate) => candidate.sourceSystem === draft.sourceSystem && candidate.sourceRecordId === draft.sourceRecordId,
  );

  return {
    candidateId: written?.id ?? null,
    employeeName: displayNameOf(row),
    date: input.date,
    fraction: input.fraction,
    amount: written?.estimatedAmount ?? draft.estimatedAmount ?? null,
    payrollMonthKey: target.monthKey,
  };
}
