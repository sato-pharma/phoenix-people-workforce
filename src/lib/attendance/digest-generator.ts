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

export type DigestLineStatus = "late" | "short_hours" | "early_leave" | "missing_punch";

export type BuiltDigestLine = {
  workDate: string;
  status: DigestLineStatus;
  lateMinutes: number;
  shortMinutes: number;
  workedMinutes: number;
  deductionDays: number;
  deductionValue: number;
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
  totalDeductionValue: number;
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
    deductionValue: finiteNumber(row.deductionValue),
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
      totalDeductionValue: 0,
    };
    digest.lines.push(buildDigestLine(row));
    byEmployee.set(key, digest);
  }

  for (const digest of byEmployee.values()) {
    digest.lines.sort((left, right) => left.workDate.localeCompare(right.workDate));
    digest.totalDeductionDays = round3(digest.lines.reduce((sum, line) => sum + line.deductionDays, 0));
    digest.totalDeductionValue = round2(digest.lines.reduce((sum, line) => sum + line.deductionValue, 0));
  }

  return [...byEmployee.values()].sort((left, right) => left.employeeHrId.localeCompare(right.employeeHrId));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
