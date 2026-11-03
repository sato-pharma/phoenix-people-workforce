// Unified Deductions module: Fingerprint category connector.
//
// Reuses the existing, mature detection engine (getFingerprintAttendanceReport)
// rather than re-deriving attendance/punch logic — it already resolves the
// correct policy per employee/day (flexible-hours engine where migrated, the
// older grace-period formula otherwise), already excludes days covered by an
// approved leave/excuse/exception, and already computes both the deduction
// days and its EGP value. This connector's only job is turning each flagged
// day into a deductions_candidates draft.
//
// Deliberately does NOT import from src/lib/attendance/fingerprint-report.tsx
// (the component) or metrics.ts/attendance-calendar-source.test.ts — only the
// stable getFingerprintAttendanceReport export, which this module treats as a
// read-only dependency, never edited here.

import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import type { DeductionsCandidateDraft } from "../types.ts";

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export async function collectFingerprintCandidates(input: {
  month: number;
  year: number;
  // Optional allow-list for a scoped re-scan (e.g. one employee). Omitted = company-wide.
  employeeHrIds?: string[];
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const dateFrom = `${monthKey}-01`;
  const dateTo = `${monthKey}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;

  const report = await getFingerprintAttendanceReport({
    dateFrom,
    dateTo,
    employeeHrIds: input.employeeHrIds,
  });

  const drafts: DeductionsCandidateDraft[] = [];
  for (const row of report.rows) {
    // Approved exceptions already force deductionDays to "0" in the report itself
    // (see fingerprint-report.ts's hasApprovedException branch) — this check is
    // belt-and-suspenders against relying on that string coercion alone.
    if (row.hasException) continue;
    const days = Number(row.deductionDays);
    if (!Number.isFinite(days) || days <= 0) continue;

    // deductionValue is the literal string "Base salary missing" when the
    // employee has no base salary on file — Number(...) correctly yields NaN
    // for that case, which the isFinite guard below routes to requires_review.
    const amount = Number(row.deductionValue);
    const hasAmount = Number.isFinite(amount);

    drafts.push({
      category: "fingerprint",
      sourceSystem: "fingerprint_report",
      sourceRecordId: `${row.employeeHrId}:${row.dateIso}`,
      employeeHrId: row.employeeHrId,
      employeeName: row.employeeFullName || row.employeeName || null,
      monthKey,
      month: input.month,
      year: input.year,
      unit: "days",
      rawValue: days,
      estimatedAmount: hasAmount ? amount : null,
      calculationStatus: hasAmount ? "calculated" : "requires_review",
      reason: row.recommendedAction || null,
      evidence: {
        status: row.status,
        deviceUserId: row.deviceUserId,
        actualFirstPunch: row.actualFirstPunch,
        actualLastPunch: row.actualLastPunch,
        lateMinutes: row.lateMinutes,
        earlyLeaveMinutes: row.earlyLeaveMinutes,
        jobTitle: row.jobTitle,
        department: row.department,
        // The four columns that can CONTRADICT this charge. The report carries
        // them (owner request 2026-07-24, so a day can be re-verified by hand)
        // and this connector used to drop them here — leaving the reviewer a
        // screen that said "late 207 min, 419.35 EGP" with nothing to show the
        // man had logged a CRM Traveling entry returning from Minya that day.
        // Whoever approves the money should see the same evidence the report does.
        approvedLeave: row.approvedLeave,
        approvedExcuse: row.approvedExcuse,
        crmActivity: row.crmActivity,
        weeklyPlan: row.weeklyPlan,
      },
      dates: [row.dateIso],
    });
  }
  return drafts;
}
