import assert from "node:assert/strict";

import { buildIReports360FieldWorkforceMatrix } from "../src/lib/field-workforce-compliance/ireports360-source.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { fieldLeaveFromHrStartsOn, fieldLeaveFromHrWindow } from "../src/lib/crm/hr-leave-days.ts";
import { readFileSync } from "node:fs";

const rep = {
  crmId: "1",
  crmUsername: "Rep.One",
  displayName: "Rep One",
  employmentStatus: "active",
  fullName: "Rep One",
  hireDate: "2024-01-01",
  hrId: "A-1",
  jobTitle: "Medical Representative",
  positionTitle: null,
};

const DAY_6 = 5 + 5;
const DAY_7 = 5 + 6;

function build(phoenixWorkedKeys?: Set<string>, hrLeaveKeys?: Set<string>) {
  return buildIReports360FieldWorkforceMatrix({
    employees: [rep],
    hrLeaveKeys,
    month: 10,
    phoenixWorkedKeys,
    todayIso: "2026-10-12",
    visits: [],
    year: 2026,
  }).matrix[1];
}

export function runFwcPhoenixWorkEvidenceTests() {
  const key = canonicalHrIdKey("A-1");
  assert.equal(build()[DAY_6], "N", "no mirror visit and no Phoenix work is a no-activity candidate");
  assert.equal(
    build(new Set([`${key}|2026-10-06`]))[DAY_6],
    "CP",
    "a day Phoenix proves worked is a worked day, not a no-activity candidate",
  );
  assert.equal(
    build(new Set([`${key}|2026-10-06`]))[DAY_7],
    "N",
    "only the proven day changes; the next day stays no-activity",
  );

  // APPROVED HR LEAVE IS THE LEAVE RECORD from the day iReports360 was retired (6 Nov 2026): nothing writes
  // the -4 code any more, so without it every leave day read as a no-activity candidate.
  assert.equal(build(undefined, new Set([`${key}|2026-10-06`]))[DAY_6], "AV", "an approved HR leave day is a leave day, never N");
  assert.equal(build(undefined, new Set([`${key}|2026-10-06`]))[DAY_7], "N", "only the leave day changes");
  assert.equal(
    build(new Set([`${key}|2026-10-06`]), new Set([`${key}|2026-10-06`]))[DAY_6],
    "CP",
    "worked proof still wins a leave day",
  );

  // The boundary: the retirement's date, and only the part of a window on or after it.
  assert.equal(fieldLeaveFromHrStartsOn({ vendorSyncRetiredAt: "2026-11-06T01:16:00+00:00" }), "2026-11-06");
  assert.equal(fieldLeaveFromHrStartsOn({ vendorSyncRetiredAt: null }), null, "no retirement, no HR-leave days");
  assert.deepEqual(fieldLeaveFromHrWindow({ end: "2026-11-30", start: "2026-11-01", startsOn: "2026-11-06" }), { end: "2026-11-30", start: "2026-11-06" });
  assert.equal(fieldLeaveFromHrWindow({ end: "2026-10-31", start: "2026-10-01", startsOn: "2026-11-06" }), null, "a month before the retirement keeps its archive alone");
  assert.equal(fieldLeaveFromHrWindow({ end: "2026-11-30", start: "2026-11-01", startsOn: null }), null);

  // The month preview feeds both: HR leave, and a manager's own single visits as worked days.
  const source = readFileSync("src/lib/field-workforce-compliance/ireports360-source.ts", "utf8");
  assert.ok(source.includes("const { days } = await loadFieldLeaveDaysFromHr({"), "the preview reads approved HR leave");
  assert.ok(source.replace(/\s+/g, " ").includes("employees: directory, hrLeaveKeys, month, phoenixWorkedKeys,"), "and hands it to the matrix");
  assert.ok(source.includes("for (const day of await loadManagerOwnVisitDays({ end: endDate, start: startDate })) {"), "a manager's own visits are read");
  assert.ok(source.includes("if (hrKey) phoenixWorkedKeys.add(`${hrKey}|${day.date}`);"), "into the worked days");
}
