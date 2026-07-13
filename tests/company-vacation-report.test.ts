import { strict as assert } from "node:assert";

import { classifyAvDate, dedupeHrVacationRequestsById, type HrVacationRequestRow } from "../src/lib/vacation/company-vacation-report.ts";

function hrRequest(overrides: Partial<HrVacationRequestRow> & { id: string }): HrVacationRequestRow {
  return {
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
}
