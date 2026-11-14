import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { exclusionRefusal } from "../src/lib/automated-payroll/exclusion-guard.ts";
import { filterExcludedMembers, type PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * Guards the run-scoped exclusion filter (excludeEmployeeFromRun /
 * loadRunContext in run-service.ts). Real case (owner-reported 2026-08-08):
 * AI-0004, a same-day hire/termination whose master record carried only
 * allowances (no base salary), derived a Gross Salary of 0.00 and hard-blocked
 * Part 2 confirmation for the entire run via preflightValidate — with no
 * acknowledge-and-proceed option. filterExcludedMembers is what lets HR drop
 * that one employee from just this run instead.
 *
 * And, since audit finding 39, what stops that escape hatch being used on
 * somebody whose first instalment Part 1 has already frozen for payment.
 */

const RUN_SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url)),
  "utf8",
);

function member(hrId: string, fullName: string): PopulationMember {
  return {
    employee: { hrId, fullName } as unknown as EmployeeDirectoryRow,
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

export function runAutomatedPayrollExcludedMembersTests() {
  const members = [member("AI-0001", "Stays In"), member("AI-0004", "Abdelrahman Alaa"), member("AI-0007", "Also Stays")];

  // ---- empty exclusion set is a true no-op, not just an equal-content copy --
  const untouched = filterExcludedMembers(members, new Set());
  assert.equal(untouched, members, "an empty exclusion set must return the exact same array reference, no new allocation");

  // ---- one excluded member is dropped, the rest keep their original order ---
  const withOneExcluded = filterExcludedMembers(members, new Set(["ai0004"]));
  assert.deepEqual(
    withOneExcluded.map((m) => m.employee.hrId),
    ["AI-0001", "AI-0007"],
    "the excluded compact key must drop exactly that employee and preserve the order of everyone else",
  );

  // ---- excluding a compact key nobody has leaves the population unchanged ---
  const noMatch = filterExcludedMembers(members, new Set(["zz9999"]));
  assert.deepEqual(
    noMatch.map((m) => m.employee.hrId),
    ["AI-0001", "AI-0004", "AI-0007"],
    "an exclusion set that matches nobody in this run must not drop anyone",
  );

  // ---- finding 39: no exclusion once Part 1 has frozen money for the person --
  const confirmedAt = "2026-09-20T10:00:00.000Z";
  assert.equal(
    exclusionRefusal({ part1ConfirmedAt: null, firstPartFrozen: 5000 }),
    null,
    "before Part 1 is confirmed nothing has been paid, so exclusion stays open",
  );

  const refused = exclusionRefusal({ part1ConfirmedAt: confirmedAt, firstPartFrozen: 5000 });
  assert.ok(refused, "after Part 1 froze 5,000 for someone, excluding them must be refused: that money is already being paid");
  assert.match(refused!, /^Validation:/, "the refusal must reach HR as a 400 with its message, not as a 500");
  assert.ok(refused!.includes("EGP 5,000.00"), "the refusal must say how much is already frozen for them");
  assert.ok(/hold/i.test(refused!), "the refusal must point to the way that keeps them on the record: a hold");

  assert.equal(
    exclusionRefusal({ part1ConfirmedAt: confirmedAt, firstPartFrozen: 0 }),
    null,
    "a zero first instalment stays excludable: that is the no-salary row this escape hatch exists for, and nothing was paid",
  );
  assert.equal(
    exclusionRefusal({ part1ConfirmedAt: confirmedAt, firstPartFrozen: null }),
    null,
    "no frozen value means they were not in the population when Part 1 froze, so nothing was paid to them",
  );
  assert.ok(
    exclusionRefusal({ part1ConfirmedAt: confirmedAt, firstPartFrozen: Number.NaN }),
    "a frozen value that is not a number cannot show that nothing was paid, so it must refuse",
  );

  // ---- and the one writer actually asks, before it writes -------------------
  const start = RUN_SERVICE_SOURCE.indexOf("export async function excludeEmployeeFromRun(");
  const end = RUN_SERVICE_SOURCE.indexOf("export async function includeEmployeeInRun(");
  assert.ok(start > 0 && end > start && end - start < 4000, "the slice must be excludeEmployeeFromRun alone");
  const body = RUN_SERVICE_SOURCE.slice(start, end);

  const guardAt = body.indexOf("exclusionRefusal(");
  const writeAt = body.indexOf("upsertDraftRows(");
  assert.ok(guardAt > 0, "excludeEmployeeFromRun must consult exclusionRefusal: the rule protects nothing if the only writer never asks it");
  assert.ok(writeAt > guardAt, "the refusal must be checked BEFORE the exclusion is written");
  assert.ok(body.includes("throw new Error(refusal)"), "a refusal must stop the exclusion, not merely be computed");
  // Read through loadRunContext since 2026-11-14 (finding 8), which also proves the person is on this
  // month's payroll; its draftRows are this run's own.
  assert.ok(
    /listDraftRows\(runId\)|loadRunContext\(\{ month: run\.month, year: run\.year \}, runId\)/.test(body),
    "the frozen amount must be read from this run's own draft rows",
  );
}
