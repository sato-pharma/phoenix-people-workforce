import assert from "node:assert/strict";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  buildEmployee360Scope,
  canViewEmployee360Subject,
  resolveEmployee360VisibleRows,
} from "../src/lib/employee-360/access.ts";

// Locks the owner-confirmed Employee 360 viewer scope (2026-07-18):
//   CEO / SFE Manager / Super Admin → whole company
//   Training Manager               → all Medical Reps + self
//   Regional Manager               → full hierarchy + self
//   NSM / PM / GPM                 → their line + self
//   District Manager / Manager     → direct team + self
//   Medical Rep / everyone else    → self only
// Subjects are field-force only (non-field people are never listed).

function row(
  hrId: string,
  jobTitle: string,
  managerHrId: string | null,
  lineId: number | null,
  departmentId: number | null,
): EmployeeDirectoryRow {
  return {
    hrId,
    jobTitle,
    positionTitle: jobTitle,
    managerHrId,
    pendingManagerReplacementForHrId: null,
    lineId,
    lineName: lineId ? `line-${lineId}` : null,
    departmentId,
    departmentName: departmentId ? `dept-${departmentId}` : null,
  } as EmployeeDirectoryRow;
}

// Org: Sales dept (1). Anti line (1): NSM-A → RM-A → {DM-A → R1,R2 ; DM-A2 → R3}. PM-A on line 1.
// Pedia line (2): NSM-P → DM-P → RP1. Plus company roles + a non-field Finance person.
const rows: EmployeeDirectoryRow[] = [
  row("C-1", "Chief Executive Officer", null, null, null),
  row("SA-1", "System Administrator", null, null, null),
  row("SFE-1", "SFE Manager", null, null, null),
  row("TM-1", "Training Manager", null, null, null),
  row("NSM-A", "National Sales Manager", null, 1, 1),
  row("RM-A", "Regional Manager", "NSM-A", 1, 1),
  row("DM-A", "District Manager", "RM-A", 1, 1),
  row("R1", "Medical Representative", "DM-A", 1, 1),
  row("R2", "Medical Representative", "DM-A", 1, 1),
  row("DM-A2", "District Manager", "RM-A", 1, 1),
  row("R3", "Medical Representative", "DM-A2", 1, 1),
  row("PM-A", "Product Manager", null, 1, 1),
  row("NSM-P", "National Sales Manager", null, 2, 1),
  row("DM-P", "District Manager", "NSM-P", 2, 1),
  row("RP1", "Medical Representative", "DM-P", 2, 1),
  row("F-1", "Finance Manager", null, null, null),
];

function ctx(role: PhoenixRole, hrId: string, scope: AccessContext["scope"]): AccessContext {
  return { hrId, role, scope, source: "session" } as AccessContext;
}

async function visible(context: AccessContext): Promise<Set<string>> {
  return new Set((await resolveEmployee360VisibleRows(rows, context)).map((r) => r.hrId));
}

// Every field-force subject (used for company-wide assertions). F-1 is NOT field-force.
const ALL_FIELD = new Set(
  ["TM-1", "NSM-A", "RM-A", "DM-A", "R1", "R2", "DM-A2", "R3", "PM-A", "NSM-P", "DM-P", "RP1"],
);
const ALL_REPS = new Set(["R1", "R2", "R3", "RP1"]);

export async function runEmployee360AccessTests() {
  // ── Company-wide roles ──
  for (const [role, hr] of [["CEO", "C-1"], ["Super Admin", "SA-1"], ["SFE Manager", "SFE-1"]] as const) {
    const v = await visible(ctx(role, hr, "company"));
    assert.deepEqual(v, ALL_FIELD, `${role} sees every field-force subject`);
    assert.ok(!v.has("F-1"), `${role} never sees the non-field Finance person as a subject`);
  }

  // ── Training Manager: all Medical Reps + self, nobody else ──
  const tm = await visible(ctx("Training Manager", "TM-1", "company"));
  assert.deepEqual(tm, new Set(["TM-1", ...ALL_REPS]), "TM sees all Medical Reps + self only");
  assert.ok(!tm.has("DM-A") && !tm.has("NSM-A") && !tm.has("PM-A"), "TM does NOT see managers/PMs");

  // ── NSM (line 1): their whole line, department-safe; not the other line ──
  const nsmA = await visible(ctx("National Sales Manager", "NSM-A", "line"));
  assert.deepEqual(
    nsmA,
    new Set(["NSM-A", "RM-A", "DM-A", "R1", "R2", "DM-A2", "R3", "PM-A"]),
    "NSM-A sees all line-1 field-force + self",
  );
  assert.ok(!nsmA.has("NSM-P") && !nsmA.has("RP1"), "NSM-A does NOT see line-2 people");

  // ── Regional Manager: full multi-level hierarchy + self (not people above them) ──
  const rmA = await visible(ctx("Regional Manager", "RM-A", "hierarchy"));
  assert.deepEqual(
    rmA,
    new Set(["RM-A", "DM-A", "R1", "R2", "DM-A2", "R3"]),
    "RM-A sees their whole downstream hierarchy + self",
  );
  assert.ok(!rmA.has("NSM-A"), "RM-A does NOT see the NSM above them");
  assert.ok(!rmA.has("PM-A"), "RM-A does NOT see an off-chain PM on the same line");

  // ── District Manager: direct team + self only (not the sibling DM's reps) ──
  const dmA = await visible(ctx("District Manager", "DM-A", "team"));
  assert.deepEqual(dmA, new Set(["DM-A", "R1", "R2"]), "DM-A sees only their direct reports + self");
  assert.ok(!dmA.has("R3"), "DM-A does NOT see the sibling DM's rep");
  assert.ok(!dmA.has("RM-A"), "DM-A does NOT see the RM above them");

  // ── Product Manager (line 1): their line + self ──
  const pmA = await visible(ctx("Product Manager", "PM-A", "line"));
  assert.ok(pmA.has("PM-A") && pmA.has("R1") && pmA.has("DM-A"), "PM-A sees line-1 field-force + self");
  assert.ok(!pmA.has("NSM-P") && !pmA.has("RP1"), "PM-A does NOT see line-2 people");

  // ── Medical Rep: self only ──
  const rep = await visible(ctx("Medical Rep", "R1", "self"));
  assert.deepEqual(rep, new Set(["R1"]), "a Medical Rep sees only themselves");

  // ── Non-field viewer (Finance): no subjects (self is not field-force) ──
  const fin = await visible(ctx("Finance Manager", "F-1", "self"));
  assert.deepEqual(fin, new Set<string>(), "a non-field viewer has no field-force subjects");

  // ── Direct-subject predicate spot checks (used by the detail page) ──
  const scopeDmA = await buildEmployee360Scope(rows, ctx("District Manager", "DM-A", "team"));
  const dmSubject = ctx("District Manager", "DM-A", "team");
  assert.equal(
    canViewEmployee360Subject(dmSubject, rows.find((r) => r.hrId === "R1")!, scopeDmA),
    true,
    "DM-A may open a direct report",
  );
  assert.equal(
    canViewEmployee360Subject(dmSubject, rows.find((r) => r.hrId === "R3")!, scopeDmA),
    false,
    "DM-A may NOT open the sibling DM's rep",
  );
}
