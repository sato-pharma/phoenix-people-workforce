// Turns one settlement week of the fingerprint report into per-employee digests.
//
// The detection is NOT re-derived here. getFingerprintAttendanceReport is the single
// engine that decides whether a day is chargeable and what it is worth, and since
// 2026-09-08 it is also the thing that cancels a day covered by an approved
// exception, an approved excuse, a full-day approved leave, a CRM-recorded leave or
// a real CRM field visit (PR #3483). A day it has cancelled arrives here with
// deductionDays "0" and never becomes a digest line, so the digest inherits that fix
// rather than needing its own copy of the rule — which is precisely how the 2026-07
// module and the report came to disagree in the first place.
//
// This file is pure: report rows in, digest structures out. The database half lives
// in digest-service.ts so the shaping can be tested without one.

import type { FingerprintReportRow } from "@/lib/attendance/fingerprint-report.ts";
import { canonicalHrIdKey } from "@/lib/hr-id.ts";

export type DigestLineStatus = "late" | "short_hours" | "early_leave" | "missing_punch";

export type BuiltDigestLine = {
  workDate: string;
  status: DigestLineStatus;
  lateMinutes: number;
  shortMinutes: number;
  workedMinutes: number;
  deductionDays: number;
  /**
   * NULL means the day is chargeable but could not be PRICED — never that it is free.
   *
   * The report returns the literal string "Base salary missing" when the employee has
   * no salary on file, and coercing that to 0 tells someone two flagged days cost them
   * nothing, while the same days go on to become real month-end candidates marked
   * requires_review. Caught in the 2026-09-08 dry run: B-185 would have been shown
   * "2 days, 0.00 EGP". Zero and unknown are different answers and must stay different
   * values.
   */
  deductionValue: number | null;
  reason: string;
  /** The four columns that could contradict this charge, carried for the reviewer. */
  evidence: {
    approvedLeave: string;
    approvedExcuse: string;
    crmActivity: string;
    weeklyPlan: string;
    firstPunch: string;
    lastPunch: string;
  };
};

export type BuiltDigest = {
  employeeHrId: string;
  employeeName: string;
  lines: BuiltDigestLine[];
  totalDeductionDays: number;
  /**
   * NULL when ANY day in the week could not be priced.
   *
   * A partial total presented as the total is the same lie in a quieter voice, so
   * there is deliberately no "sum of the days we happen to know". The per-day figures
   * still show everything that IS known.
   */
  totalDeductionValue: number | null;
  hasUnpricedDay: boolean;
};

/** "06:03" -> 363. Blank or malformed -> 0. */
export function durationTextToMinutes(text: string | null | undefined): number {
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(String(text ?? "").trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function statusFor(row: FingerprintReportRow): DigestLineStatus {
  const status = String(row.status ?? "").toLowerCase();
  if (status.includes("single punch")) return "missing_punch";
  if (status.includes("early leave")) return "early_leave";
  if (status.includes("short")) return "short_hours";
  return "late";
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Distinguishes "zero" from "could not be priced". Blank and "Base salary missing" both give null. */
export function priceOrNull(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether one report row becomes a digest line.
 *
 * Only a day that would actually cost the employee money. A cancelled day arrives
 * with deductionDays "0"; a single-punch day carries no charge and is routed to the
 * missing-punch verification chain rather than being something to confirm or
 * dispute; and `deductionValue` is the literal string "Base salary missing" when
 * there is no salary on file, which must NOT be silently treated as zero — such a
 * day is still chargeable, so it becomes a line with a zero VALUE and its real days.
 */
export function isDigestibleRow(row: FingerprintReportRow): boolean {
  if (row.hasException) return false;
  const days = Number(row.deductionDays);
  return Number.isFinite(days) && days > 0;
}

export function buildDigestLine(row: FingerprintReportRow): BuiltDigestLine {
  return {
    workDate: row.dateIso,
    status: statusFor(row),
    lateMinutes: finiteNumber(row.lateMinutes),
    shortMinutes: finiteNumber(row.earlyLeaveMinutes),
    workedMinutes: durationTextToMinutes(row.timeLong),
    deductionDays: finiteNumber(row.deductionDays),
    deductionValue: priceOrNull(row.deductionValue),
    reason: String(row.recommendedAction ?? "").trim(),
    evidence: {
      approvedLeave: String(row.approvedLeave ?? "").trim(),
      approvedExcuse: String(row.approvedExcuse ?? "").trim(),
      crmActivity: String(row.crmActivity ?? "").trim(),
      weeklyPlan: String(row.weeklyPlan ?? "").trim(),
      firstPunch: String(row.actualFirstPunch ?? "").trim(),
      lastPunch: String(row.actualLastPunch ?? "").trim(),
    },
  };
}

/**
 * Group one week's report rows into one digest per employee who has at least one
 * chargeable day. An employee with a clean week gets NO digest at all — the 2026-07
 * module sent "nothing to report" notices and they were the first thing switched off.
 */
export function buildWeekDigests(rows: readonly FingerprintReportRow[]): BuiltDigest[] {
  const byEmployee = new Map<string, BuiltDigest>();

  for (const row of rows) {
    if (!isDigestibleRow(row)) continue;
    const key = row.employeeHrId;
    const digest = byEmployee.get(key) ?? {
      employeeHrId: key,
      employeeName: row.employeeName || key,
      lines: [],
      totalDeductionDays: 0,
      totalDeductionValue: 0 as number | null,
      hasUnpricedDay: false,
    };
    digest.lines.push(buildDigestLine(row));
    byEmployee.set(key, digest);
  }

  for (const digest of byEmployee.values()) {
    digest.lines.sort((left, right) => left.workDate.localeCompare(right.workDate));
    digest.totalDeductionDays = round3(digest.lines.reduce((sum, line) => sum + line.deductionDays, 0));
    digest.hasUnpricedDay = digest.lines.some((line) => line.deductionValue === null);
    // One unpriced day makes the WEEK's total unknown. Summing only the days that
    // happen to have a price would produce a number that looks complete and is not.
    digest.totalDeductionValue = digest.hasUnpricedDay
      ? null
      : round2(digest.lines.reduce((sum, line) => sum + (line.deductionValue ?? 0), 0));
  }

  return [...byEmployee.values()].sort((left, right) => left.employeeHrId.localeCompare(right.employeeHrId));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type WeekSyncPlanEntry = {
  employeeHrId: string;
  /** The employee's flagged days in the window, one per date, in date order. */
  lines: BuiltDigestLine[];
  /** Days in the window the report now returns with nothing to deduct: 0 days, or an approved exception. */
  clearedDates: string[];
};

/**
 * What bringing one week up to date asks of each employee, from the report over the week's days so far
 * (owner, 2026-09-17 — "Show live, release any time").
 *
 * A flagged day is added, or its figures refreshed while it waits for release. A day the report now
 * clears — an excuse, a leave or a punch that arrived after the day was flagged — is named so a day still
 * waiting for release can be taken off again. A day the report does not return at all is NEITHER: a
 * missing row is not proof the day is clean, so it is left as it is.
 *
 * Keyed by canonicalHrIdKey, so two spellings of one HR id are one employee. When the report returns one
 * employee-day twice the larger charge is kept, and a date flagged once is never also cleared: the
 * database function refuses a week that names a day both ways, which would fail the whole employee.
 */
export function planWeekSync(
  rows: readonly FingerprintReportRow[],
  window: { startIso: string; throughIso: string },
): Map<string, WeekSyncPlanEntry> {
  const flagged = new Map<string, { hrId: string; byDate: Map<string, BuiltDigestLine> }>();
  const cleared = new Map<string, { hrId: string; dates: Set<string> }>();

  for (const row of rows) {
    if (row.dateIso < window.startIso || row.dateIso > window.throughIso) continue;
    const key = canonicalHrIdKey(row.employeeHrId);
    if (!key) continue;
    if (isDigestibleRow(row)) {
      const entry = flagged.get(key) ?? { hrId: row.employeeHrId, byDate: new Map<string, BuiltDigestLine>() };
      const line = buildDigestLine(row);
      const existing = entry.byDate.get(line.workDate);
      if (!existing || line.deductionDays > existing.deductionDays) entry.byDate.set(line.workDate, line);
      flagged.set(key, entry);
    } else {
      const entry = cleared.get(key) ?? { hrId: row.employeeHrId, dates: new Set<string>() };
      entry.dates.add(row.dateIso);
      cleared.set(key, entry);
    }
  }

  const plan = new Map<string, WeekSyncPlanEntry>();
  for (const key of new Set([...flagged.keys(), ...cleared.keys()])) {
    const flaggedEntry = flagged.get(key);
    const clearedEntry = cleared.get(key);
    const lines = flaggedEntry ? [...flaggedEntry.byDate.values()].sort((left, right) => left.workDate.localeCompare(right.workDate)) : [];
    const clearedDates = clearedEntry ? [...clearedEntry.dates].filter((date) => !flaggedEntry?.byDate.has(date)).sort() : [];
    if (!lines.length && !clearedDates.length) continue;
    plan.set(key, { employeeHrId: flaggedEntry?.hrId ?? clearedEntry!.hrId, lines, clearedDates });
  }
  return plan;
}
