import { strict as assert } from "node:assert";

import { buildHrRows, classifyAvDate, dedupeHrVacationRequestsById, type HrVacationRequestRow } from "../src/lib/vacation/company-vacation-report.ts";

function hrRequest(overrides: Partial<HrVacationRequestRow> & { id: string }): HrVacationRequestRow {
  return {
    balance_after_days: null,
    balance_before_days: null,
    duration_days: 1,
    employee_hr_id: "A-7",
    employee_name: "Test Employee",
    end_date: "2026-01-10",
    line_name: null,
    start_date: "2026-01-08",
    status: "approved",
    vacation_type: "annual",
    ...overrides,
  };
}

export function runCompanyVacationReportTests() {
  // A request spanning the historical/current split boundary satisfies BOTH sub-queries'
  // date-range-overlap filter and would otherwise be fetched twice — dedupe by id must collapse
  // it back to one row, keeping distinct requests (even ones sharing a date) separate.
  const boundarySpanning = hrRequest({ id: "req-1", start_date: "2026-06-28", end_date: "2026-07-05" });
  const deduped = dedupeHrVacationRequestsById([boundarySpanning, boundarySpanning]);
  assert.equal(deduped.length, 1, "the same request fetched from both the historical and current sub-query collapses to one row");
  assert.equal(deduped[0].id, "req-1");

  const distinctSameDate = dedupeHrVacationRequestsById([
    hrRequest({ id: "req-2", employee_hr_id: "A-1", start_date: "2026-02-01", end_date: "2026-02-01" }),
    hrRequest({ id: "req-3", employee_hr_id: "A-2", start_date: "2026-02-01", end_date: "2026-02-01" }),
  ]);
  assert.equal(distinctSameDate.length, 2, "two distinct real requests sharing a date must never be collapsed into one");

  // Public holiday -> never a report row, regardless of anything else.
  assert.equal(classifyAvDate({
    comments: ["Annual Leave"],
    isDeviceMapped: false,
    isHoliday: true,
    workedMinutes: null,
  }), null, "a public holiday is dropped entirely, even with a real vacation comment");

  // Every AV row that day is excuse-labeled -> dropped entirely.
  assert.equal(classifyAvDate({
    comments: ["Afternoon Excuse", "MORNING EXCUSE"],
    isDeviceMapped: false,
    isHoliday: false,
    workedMinutes: null,
  }), null, "an all-excuse day is dropped entirely");

  // One non-excuse comment survives alongside an excuse one -> the date still counts, using
  // the surviving non-excuse comment.
  const mixed = classifyAvDate({
    comments: ["Afternoon Excuse", "Annual Leave"],
    isDeviceMapped: false,
    isHoliday: false,
    workedMinutes: null,
  });
  assert.ok(mixed, "a day with at least one non-excuse AV row still counts");
  assert.equal(mixed.detail, "Annual Leave");
  assert.equal(mixed.workingDays, 1);
  assert.equal(mixed.source, "CRM Signal — Vacation");
  assert.equal(mixed.dayPart, "full_day", "a full working-day result always carries dayPart full_day");

  // Owner-confirmed (2026-07): no visit-count heuristic for a non-device-mapped employee — the
  // CRM AV marking alone is trusted as a full day, regardless of any regular/campaign activity
  // elsewhere that day (that data isn't even passed into this function anymore).
  const noFingerprint = classifyAvDate({
    comments: ["Annual Leave"],
    isDeviceMapped: false,
    isHoliday: false,
    workedMinutes: null,
  });
  assert.ok(noFingerprint);
  assert.equal(noFingerprint.workingDays, 1, "no fingerprint proof -> full day, never downgraded by a visit-count guess");
  assert.equal(noFingerprint.source, "CRM Signal — Vacation");

  // Device-mapped, but no punch data that day (workedMinutes null) -> same as no fingerprint
  // proof at all -> full day, not downgraded.
  const deviceMappedNoPunch = classifyAvDate({
    comments: ["Annual Leave"],
    isDeviceMapped: true,
    isHoliday: false,
    workedMinutes: null,
  });
  assert.ok(deviceMappedNoPunch);
  assert.equal(deviceMappedNoPunch.workingDays, 1, "device-mapped with no punch that day is genuinely on leave -> full day");

  // Device-mapped, punched, under 5h worked -> half-day, never a 0.
  const partial = classifyAvDate({
    comments: ["Annual Leave"],
    isDeviceMapped: true,
    isHoliday: false,
    workedMinutes: 119,
  });
  assert.ok(partial);
  assert.equal(partial.workingDays, 0.5);
  assert.equal(partial.source, "CRM Signal — Half-Day (Attendance Partial)");
  // No ampm data at all was passed in (CRM claimed a full day; the downgrade to half is purely
  // fingerprint-driven) -> the resolver has no AM/PM signal to read, so it falls back to the
  // documented pm_only default rather than fabricating a direction.
  assert.equal(partial.dayPart, "pm_only", "a fingerprint-only downgrade with no CRM ampm marking falls back to pm_only");

  // Device-mapped, punched, >=5h worked -> proven fully worked -> dropped entirely, NEVER
  // returned as a 0-day row (owner-confirmed: a vacation report never shows a 0-day row).
  assert.equal(classifyAvDate({
    comments: ["Annual Leave"],
    isDeviceMapped: true,
    isHoliday: false,
    workedMinutes: 300,
  }), null, "5h+ proven worked is dropped entirely, not returned as a 0-day row");
  assert.equal(classifyAvDate({
    comments: ["Annual Leave"],
    isDeviceMapped: true,
    isHoliday: false,
    workedMinutes: 480,
  }), null, "well over the threshold is also dropped entirely");

  // ── ampm half-day (2026-07-18): the report now honors the CRM's OWN AM/PM half-day marking —
  //    the same reading the CRM master Vacations tab uses, NOT a visit-count heuristic. ──
  const amHalf = classifyAvDate({
    comments: ["Annual Leave"],
    ampms: ["AM"],
    isDeviceMapped: false,
    isHoliday: false,
    workedMinutes: null,
  });
  assert.ok(amHalf);
  assert.equal(amHalf.workingDays, 0.5, "a CRM AV row marked AM is a half-day (0.5)");
  assert.equal(amHalf.source, "CRM Signal — Vacation");
  // Bug fix (approve route previously always recorded pm_only regardless of the CRM's own AM/PM
  // marking): dayPart must reflect the actual half the CRM recorded, and the detail text must
  // name it rather than the old generic "(half-day — CRM AM/PM)" wording.
  assert.equal(amHalf.dayPart, "am_only", "an AM-marked CRM row resolves dayPart to am_only, not the old hardcoded pm_only");
  assert.equal(amHalf.detail, "Annual Leave (half-day — CRM AM)");

  const pmHalf = classifyAvDate({ comments: ["Annual Leave"], ampms: ["PM"], isDeviceMapped: false, isHoliday: false, workedMinutes: null });
  assert.equal(pmHalf?.workingDays, 0.5, "a CRM AV row marked PM is a half-day (0.5)");
  assert.equal(pmHalf?.dayPart, "pm_only");
  assert.equal(pmHalf?.detail, "Annual Leave (half-day — CRM PM)");

  // AM + PM on the same date = a full day (0.5 + 0.5), capped at 1.0.
  const amPlusPm = classifyAvDate({
    comments: ["Annual Leave", "Annual Leave"],
    ampms: ["AM", "PM"],
    isDeviceMapped: false,
    isHoliday: false,
    workedMinutes: null,
  });
  assert.equal(amPlusPm?.workingDays, 1, "AM + PM halves on the same day sum to a full day");

  // An unmarked (no ampm) AV row is still a full day — unchanged face-value behavior.
  const noAmpm = classifyAvDate({ comments: ["Annual Leave"], ampms: [null], isDeviceMapped: false, isHoliday: false, workedMinutes: null });
  assert.equal(noAmpm?.workingDays, 1, "an AV row with no ampm marking stays a full day");

  // ampm stays index-aligned with comments through excuse filtering: dropping the PM "Morning
  // Excuse" row leaves the surviving AM "Annual Leave" row, which is a half-day.
  const excusePlusAmHalf = classifyAvDate({
    comments: ["Morning Excuse", "Annual Leave"],
    ampms: ["PM", "AM"],
    isDeviceMapped: false,
    isHoliday: false,
    workedMinutes: null,
  });
  assert.equal(excusePlusAmHalf?.workingDays, 0.5, "after dropping the excuse row, the surviving AM row drives 0.5");
  assert.equal(excusePlusAmHalf?.dayPart, "am_only", "dayPart resolution also uses only the surviving (non-excuse) row's ampm");

  // Device fingerprint proving <5h still forces 0.5 even if the CRM marked a full day.
  const fingerprintOverridesFullDay = classifyAvDate({
    comments: ["Annual Leave"],
    ampms: [null],
    isDeviceMapped: true,
    isHoliday: false,
    workedMinutes: 119,
  });
  assert.equal(fingerprintOverridesFullDay?.workingDays, 0.5, "a <5h fingerprint still downgrades a CRM full day to a half-day");
  assert.equal(fingerprintOverridesFullDay?.dayPart, "pm_only", "no CRM ampm marking on the downgraded row -> falls back to pm_only");

  // ── buildHrRows: Has Balance / Balance After must only reflect an ACTUAL deduction ──
  // (2026-07-22 fix: the stored balance snapshot was previously surfaced for every HR status and
  // every vacation_type, which misread a Pending/Rejected/Cancelled request's submission-time
  // snapshot as a real balance change, and misread a compensatory day's balance-exempt 0/0 as
  // "ran out of leave".)
  const employeeByKey = new Map();

  const [approvedAnnual] = buildHrRows([hrRequest({
    id: "req-approved",
    balance_before_days: 10,
    balance_after_days: 8,
    duration_days: 2,
    status: "approved",
    vacation_type: "annual",
  })], employeeByKey);
  assert.equal(approvedAnnual.hasBalance, true, "an approved annual request with balance surfaces Has Balance: Yes");
  assert.equal(approvedAnnual.balanceAfterDays, 8);

  const [approvedCompensatory] = buildHrRows([hrRequest({
    id: "req-comp",
    balance_before_days: 0,
    balance_after_days: 0,
    duration_days: 1,
    status: "approved",
    vacation_type: "compensatory",
  })], employeeByKey);
  assert.equal(approvedCompensatory.hasBalance, null, "compensatory is balance-exempt (always paid outside the leave pool) -> N/A, not a misleading No");
  assert.equal(approvedCompensatory.balanceAfterDays, null);

  for (const status of ["pending", "rejected", "cancelled"]) {
    const [row] = buildHrRows([hrRequest({
      id: `req-${status}`,
      balance_before_days: 10,
      balance_after_days: 8,
      duration_days: 2,
      status,
      vacation_type: "annual",
    })], employeeByKey);
    assert.equal(row.hasBalance, null, `a ${status} request never actually deducted balance -> Has Balance must be N/A, not the submission-time snapshot`);
    assert.equal(row.balanceAfterDays, null, `a ${status} request's stored balance_after_days must not be surfaced as if it happened`);
  }
}
