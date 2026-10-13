import assert from "node:assert/strict";

import { buildIReports360FieldWorkforceMatrix } from "../src/lib/field-workforce-compliance/ireports360-source.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

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

function build(phoenixWorkedKeys?: Set<string>) {
  return buildIReports360FieldWorkforceMatrix({
    employees: [rep],
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
}
