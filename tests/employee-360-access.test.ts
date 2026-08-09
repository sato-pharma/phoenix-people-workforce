import assert from "node:assert/strict";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  buildEmployee360Scope,
  canViewEmployee360Subject,
  isCompany360Viewer,
  resolveEmployee360VisibleRows,
  type Employee360Scope,
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
  row("TA-1", "Talent Acquisition", null, null, null),
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
  // ── Company-wide roles (whole company, every field-force family) ──
  for (const [role, hr] of [
    ["CEO", "C-1"],
    ["Super Admin", "SA-1"],
    ["SFE Manager", "SFE-1"],
  ] as const) {
    const v = await visible(ctx(role, hr, "company"));
    assert.deepEqual(v, ALL_FIELD, `${role} sees every field-force subject`);
    assert.ok(!v.has("F-1"), `${role} never sees the non-field Finance person as a subject`);
  }

  // ── isCompany360Viewer: the standalone predicate the portal index page uses to
  // decide whether a non-field-force self-record falls back to a browse-all list ──
  assert.equal(isCompany360Viewer({ role: "CEO", scope: "company" }), true);
  assert.equal(isCompany360Viewer({ role: "Super Admin", scope: "company" }), true);
  // SFE Manager and Talent Acquisition's generic scopeForRole is "self" (they're
  // not in permissions.ts's scopeForRole company/team/hierarchy/line branches) —
  // asserting with scope:"self" here proves the grant is pure role-set membership,
  // independent of the generic AccessScope value.
  assert.equal(isCompany360Viewer({ role: "SFE Manager", scope: "self" }), true);
  assert.equal(isCompany360Viewer({ role: "Talent Acquisition", scope: "self" }), true);
  assert.equal(isCompany360Viewer({ role: "Medical Rep", scope: "self" }), false);
  assert.equal(isCompany360Viewer({ role: "District Manager", scope: "team" }), false);
  assert.equal(isCompany360Viewer({ role: "Finance Manager", scope: "self" }), false);
  assert.equal(isCompany360Viewer({ role: "Employee", scope: "system" }), true, "the system service-account sentinel is always a company-wide viewer");

  // ── Training Manager: all Medical Reps + self, nobody else ──
  const tm = await visible(ctx("Training Manager", "TM-1", "company"));
  assert.deepEqual(tm, new Set(["TM-1", ...ALL_REPS]), "TM sees all Medical Reps + self only");
  assert.ok(!tm.has("DM-A") && !tm.has("NSM-A") && !tm.has("PM-A"), "TM does NOT see managers/PMs");

  // ── Talent Acquisition (owner-requested 2026-07-26, narrowing the prior
  // 2026-07-25 whole-company grant): all Medical Reps, nobody else — same shape as
  // Training Manager, not the CEO/SFE/SA whole-company set. TA-1's own row is
  // excluded here (as TM-1's would be too) because resolveEmployee360VisibleRows
  // only ever lists field-force subjects, and "Talent Acquisition" isn't one of
  // the six covered job titles; her own-record access is still granted separately
  // by the hrIdsMatch self-check in canViewEmployee360Subject. ──
  const ta = await visible(ctx("Talent Acquisition", "TA-1", "self"));
  assert.deepEqual(ta, ALL_REPS, "TA sees all Medical Reps, nobody else");
  assert.ok(!ta.has("DM-A") && !ta.has("NSM-A") && !ta.has("PM-A"), "TA does NOT see managers/PMs");
  assert.equal(
    canViewEmployee360Subject(ctx("Talent Acquisition", "TA-1", "self"), row("TA-1", "Talent Acquisition", null, null, null), await buildEmployee360Scope(rows, ctx("Talent Acquisition", "TA-1", "self"))),
    true,
    "TA can still open her own (non-field-force) record",
  );

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

  // ── Marketing Manager: their line(s) + self, via an optional line_scope_override
  // (mirrors NSM/PM/GPM — added 2026-08-09). Real case: a Marketing Manager sits on
  // the Head Office line (4) while the Product/Group Product Managers they oversee
  // sit on the real business lines, so without an override they match nobody; with
  // one, they must see their own-department PM on that line but never a Sales
  // employee who merely happens to share the same overridden line number. ──
  const mktMgr = row("MKM-1", "Marketing Manager", null, 4, 2); // Head-Office line, Marketing dept
  const mktPm = row("PM-M1", "Product Manager", "MKM-1", 2, 2); // Marketing PM, line-2 (collides with NSM-P's Sales line-2)
  const rowsWithMarketing = [...rows, mktMgr, mktPm];

  // No override configured (ctx() carries no loginId, so resolveViewerAllowedLines
  // short-circuits to null under the test runner — see scope-visibility.ts) — falls
  // back to the viewer's own single Head-Office line, which matches nobody.
  const mktMgrDefault = new Set(
    (await resolveEmployee360VisibleRows(rowsWithMarketing, ctx("Marketing Manager", "MKM-1", "line"))).map((r) => r.hrId),
  );
  assert.deepEqual(
    mktMgrDefault,
    new Set<string>(),
    "Marketing Manager without an override falls back to their own Head-Office line, which matches nobody",
  );

  // With an override: hand-build the Employee360Scope directly (bypassing
  // buildEmployee360Scope, which is DB-backed for the override fetch) to exercise
  // the override branch without a live Supabase call.
  const mktMgrOverrideScope: Employee360Scope = {
    viewer: mktMgr,
    byCanonicalHrId: new Map(),
    allowedLineKeys: new Set(["line-2"]),
  };
  const mktMgrCtx = ctx("Marketing Manager", "MKM-1", "line");
  assert.equal(
    canViewEmployee360Subject(mktMgrCtx, mktPm, mktMgrOverrideScope),
    true,
    "Marketing Manager with a line override sees their own Marketing PM on that line",
  );
  assert.equal(
    canViewEmployee360Subject(mktMgrCtx, rows.find((r) => r.hrId === "RP1")!, mktMgrOverrideScope),
    false,
    "Marketing Manager's override must NOT cross into a Sales employee who merely shares the overridden line",
  );
}
