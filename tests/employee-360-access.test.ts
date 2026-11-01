import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  buildEmployee360Scope,
  canViewEmployee360Subject,
  isCompany360Viewer,
  isEmployee360ExcludedSubject,
  resolveEmployee360VisibleRows,
  type Employee360Scope,
} from "../src/lib/employee-360/access.ts";
import { planEmployee360Sections, type Employee360SectionSignals } from "../src/lib/employee-360/report-sections.ts";
import { resolveEmployee360RoleCategory } from "../src/lib/employee-360/roles.ts";
import { stripComments } from "./support/comment-strip.ts";

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
  row("HRBP-1", "HR Business Partner", null, null, null),
  row("HROPS-1", "HR Operations Coordinator", null, null, null),
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
  // SFE Manager and both HR bundles have a generic scopeForRole of "self" (they're
  // not in permissions.ts's scopeForRole company/team/hierarchy/line branches) —
  // asserting with scope:"self" here proves the grant is pure role-set membership,
  // independent of the generic AccessScope value.
  assert.equal(isCompany360Viewer({ role: "SFE Manager", scope: "self" }), true);
  // HR Advisory read it until the owner retired the HR Business Partner seat on 2026-10-08.
  assert.equal(isCompany360Viewer({ role: "HR Advisory", scope: "self" }), false);
  assert.equal(isCompany360Viewer({ role: "HR Operations", scope: "self" }), true);
  assert.equal(isCompany360Viewer({ role: "Medical Rep", scope: "self" }), false);
  assert.equal(isCompany360Viewer({ role: "District Manager", scope: "team" }), false);
  assert.equal(isCompany360Viewer({ role: "Finance Manager", scope: "self" }), false);
  assert.equal(isCompany360Viewer({ role: "Employee", scope: "system" }), true, "the system service-account sentinel is always a company-wide viewer");

  // ── Training Manager: all Medical Reps + self, nobody else ──
  const tm = await visible(ctx("Training Manager", "TM-1", "company"));
  assert.deepEqual(tm, new Set(["TM-1", ...ALL_REPS]), "TM sees all Medical Reps + self only");
  assert.ok(!tm.has("DM-A") && !tm.has("NSM-A") && !tm.has("PM-A"), "TM does NOT see managers/PMs");

  // ── The two HR bundles (owner-requested 2026-07-26 on the seat they replace,
  // narrowing the prior 2026-07-25 whole-company grant): all Medical Reps, nobody
  // else — same shape as Training Manager, not the CEO/SFE/SA whole-company set.
  // Their own rows are excluded here (as TM-1's would be too) because
  // resolveEmployee360VisibleRows only ever lists field-force subjects, and neither
  // "HR Business Partner" nor "HR Operations Coordinator" is one of the six covered
  // job titles; own-record access is still granted separately by the hrIdsMatch
  // self-check in canViewEmployee360Subject.
  //
  // Both are asserted rather than one, because the grant is role-set membership: a
  // successor added to the matrix but not to the 360 viewer set would show an empty
  // Employee 360 with no error, which is the shape that is hard to notice. ──
  for (const [role, hrId, jobTitle] of [
    ["HR Operations", "HROPS-1", "HR Operations Coordinator"],
  ] as const) {
    const seen = await visible(ctx(role, hrId, "self"));
    assert.deepEqual(seen, ALL_REPS, `${role} sees all Medical Reps, nobody else`);
    assert.ok(
      !seen.has("DM-A") && !seen.has("NSM-A") && !seen.has("PM-A"),
      `${role} does NOT see managers/PMs`,
    );
    assert.equal(
      canViewEmployee360Subject(
        ctx(role, hrId, "self"),
        row(hrId, jobTitle, null, null, null),
        await buildEmployee360Scope(rows, ctx(role, hrId, "self")),
      ),
      true,
      `${role} can still open her own (non-field-force) record`,
    );
  }

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
  // one, they see their own-department PM on that line AND (owner, 2026-10-20) the
  // Sales field force of that line — but never a non-field Sales person on it. ──
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
  // Owner, 2026-10-20 ("when you filter by manager you find no manager … every single role that
  // is applicable to appear in a module — find it and show it"): the field force a Marketing-
  // department line viewer oversees is in SALES, so the department-safe rule left these viewers
  // with nobody to open. A field-force subject on the overridden line is admitted across
  // departments; a NON-field Sales person on that line is still refused.
  assert.equal(
    canViewEmployee360Subject(mktMgrCtx, rows.find((r) => r.hrId === "RP1")!, mktMgrOverrideScope),
    true,
    "Marketing Manager with a line override sees the Sales Medical Rep on that line — the field force is in Sales, never in Marketing",
  );
  assert.equal(
    canViewEmployee360Subject(mktMgrCtx, rows.find((r) => r.hrId === "DM-P")!, mktMgrOverrideScope),
    true,
    "…and the Sales District Manager on that line",
  );
  // …but only BELOW him (risk review, 2026-10-20; the owner's downward rule of 2026-09-04): the
  // line's National Sales Manager, whose report carries his expense claims, is not his to open.
  assert.equal(
    canViewEmployee360Subject(mktMgrCtx, rows.find((r) => r.hrId === "NSM-P")!, mktMgrOverrideScope),
    false,
    "the Marketing Manager's cross-department reach stops below the National Sales Manager",
  );
  assert.equal(
    canViewEmployee360Subject(mktMgrCtx, row("SF-2", "Finance Manager", null, 2, 1), mktMgrOverrideScope),
    false,
    "Marketing Manager's override must NOT cross into a NON-field Sales person who merely shares the overridden line",
  );
  assert.equal(
    canViewEmployee360Subject(mktMgrCtx, rows.find((r) => r.hrId === "R1")!, mktMgrOverrideScope),
    false,
    "the override still bounds the line: a line-1 rep is not on a line-2 override",
  );

  // ── Product Manager in the MARKETING department, no override (owner, 2026-10-20). The real
  // shape: every Product and Group Product Manager is in Marketing, the field force of his line
  // is in Sales. Before the fix PM-MK1 saw only himself — not one medical rep, district manager
  // or regional manager of the line he markets. ──
  const pmMarketing = row("PM-MK1", "Product Manager", "MKM-1", 1, 2); // line 1, Marketing dept
  const salesOfficeLine1 = row("SO-1", "Finance Manager", null, 1, 1); // non-field, Sales dept, line 1
  const rowsWithMarketingPm = [...rows, mktMgr, pmMarketing, salesOfficeLine1];
  const pmMk = new Set(
    (await resolveEmployee360VisibleRows(rowsWithMarketingPm, ctx("Product Manager", "PM-MK1", "line"))).map((r) => r.hrId),
  );
  assert.deepEqual(
    pmMk,
    new Set(["PM-MK1", "R1", "R2", "R3"]),
    "a Marketing-department Product Manager sees his own line's Sales medical reps + himself — the rung below his",
  );
  // Risk review, 2026-10-20: the waiver once admitted the line's whole field force, so a Product
  // Manager could open the National and Regional Sales Managers' reports, expense claims included.
  // Downward only (owner, 2026-09-04): a District Manager is his own rung, the managers above it
  // are above him, and a peer Product Manager in Sales is neither below him nor in his department.
  for (const notBelow of ["NSM-A", "RM-A", "DM-A", "DM-A2", "PM-A"]) {
    assert.ok(!pmMk.has(notBelow), `a Product Manager's cross-department reach stops below his rung: ${notBelow} is out`);
  }
  assert.ok(!pmMk.has("RP1") && !pmMk.has("DM-P") && !pmMk.has("NSM-P"), "…and nobody on another line");
  const pmMkScope = await buildEmployee360Scope(rowsWithMarketingPm, ctx("Product Manager", "PM-MK1", "line"));
  assert.equal(
    canViewEmployee360Subject(ctx("Product Manager", "PM-MK1", "line"), salesOfficeLine1, pmMkScope),
    false,
    "the department waiver is for the field force only — a non-field Sales person on his line stays out",
  );

  // Group Product Manager: the same rule, through the role gate rather than the override.
  const gpmMarketing = row("GPM-MK1", "Group Product Manager", "MKM-1", 2, 2); // line 2, Marketing dept
  const gpmMk = new Set(
    (await resolveEmployee360VisibleRows([...rows, gpmMarketing], ctx("Group Product Manager", "GPM-MK1", "line"))).map((r) => r.hrId),
  );
  assert.deepEqual(
    gpmMk,
    new Set(["GPM-MK1", "DM-P", "RP1"]),
    "a Marketing-department Group Product Manager sees her line's Sales reps and District Managers + herself",
  );
  assert.ok(!gpmMk.has("NSM-P"), "…never the National Sales Manager above her rung");

  // The National Sales Manager is NOT one of the three: his line rule stays department-safe, so a
  // Marketing-department Product Manager on his line is not his to open.
  const nsmWithMarketingPm = new Set(
    (await resolveEmployee360VisibleRows(rowsWithMarketingPm, ctx("National Sales Manager", "NSM-A", "line"))).map((r) => r.hrId),
  );
  assert.ok(!nsmWithMarketingPm.has("PM-MK1"), "the NSM's line scope stays department-safe");
  assert.ok(nsmWithMarketingPm.has("R1"), "…and still holds his own line's Sales field force");

  await runEmployee360RegionalManagerReportTests();
}

// The Regional Sales Manager is back in Employee 360, with a report tailored to him (owner,
// 2026-10-20: "bring him back but do not show empty data, tailor the report on him").
async function runEmployee360RegionalManagerReportTests() {
  // ── The per-person exclusion is gone: he is a subject for every viewer that reaches him ──
  assert.equal(isEmployee360ExcludedSubject("PD-0001"), false, "the Regional Sales Manager is no longer excluded");
  assert.equal(isEmployee360ExcludedSubject("PD0001"), false, "…in either spelling of his HR id");
  const accessCode = stripComments(readFileSync("src/lib/employee-360/access.ts", "utf8"));
  assert.ok(!accessCode.includes('"PD-0001"'), "no code in the 360 access file names him any more");

  assert.equal(resolveEmployee360RoleCategory("Regional Sales Manager"), "regional-manager");
  const rsm = row("PD-0001", "Regional Sales Manager", "NSM-P", 2, 1);
  const rsmDm = row("DM-P2", "District Manager", "PD-0001", 2, 1);
  const rsmRep = row("RP2", "Medical Representative", "DM-P2", 2, 1);
  const withRsm = [...rows, rsm, rsmDm, rsmRep];
  const seenBy = async (context: AccessContext) =>
    new Set((await resolveEmployee360VisibleRows(withRsm, context)).map((r) => r.hrId));
  assert.ok((await seenBy(ctx("CEO", "C-1", "company"))).has("PD-0001"), "the CEO opens the Regional Sales Manager's 360");
  assert.ok((await seenBy(ctx("Super Admin", "SA-1", "company"))).has("PD-0001"), "so does the Super Admin");
  assert.ok((await seenBy(ctx("National Sales Manager", "NSM-P", "line"))).has("PD-0001"), "his line's NSM opens it");
  const own = await seenBy(ctx("Regional Manager", "PD-0001", "hierarchy"));
  assert.deepEqual(own, new Set(["PD-0001", "DM-P2", "RP2"]), "he opens his own report and his whole region");

  // ── The tailored report: manager sections when they carry data, never a rep-only or empty one ──
  const empty: Employee360SectionSignals = {
    productiveVisits: 0,
    doublesReceived: 0,
    leadershipHasData: false,
    salesHasData: false,
    expensesHaveData: false,
  };
  const full: Employee360SectionSignals = {
    productiveVisits: 14,
    doublesReceived: 0,
    leadershipHasData: true,
    salesHasData: true,
    expensesHaveData: true,
  };
  const repOnly = ["showComparison", "showCampaign", "showCheckin", "showReceivedSide", "showOwnSales", "showBricks"] as const;

  const rmFull = planEmployee360Sections("regional-manager", full, true);
  assert.equal(rmFull.isLeader, true);
  assert.equal(rmFull.hidesEmptySections, true);
  assert.equal(rmFull.showLeadership, true, "his double-visits and coaching delivered render");
  assert.equal(rmFull.showTeamSales, true, "his region's sales roll-up renders");
  assert.equal(rmFull.showOwnVisits, true, "his own field visits render");
  assert.equal(rmFull.showExpenses, true, "his expenses render when the page allows them");
  assert.equal(rmFull.showDoublesReceived, false, "no 'Doubles received' tile when nobody accompanied him");
  for (const key of repOnly) assert.equal(rmFull[key], false, `a Regional Manager never gets the rep-only ${key}`);

  const rmEmpty = planEmployee360Sections("regional-manager", empty, true);
  for (const key of ["showLeadership", "showTeamSales", "showOwnVisits", "showDoublesReceived", "showExpenses"] as const) {
    assert.equal(rmEmpty[key], false, `an empty ${key} section is not drawn on his report`);
  }
  for (const key of repOnly) assert.equal(rmEmpty[key], false, `…and still no rep-only ${key}`);
  assert.equal(planEmployee360Sections("regional-manager", full, false).showExpenses, false, "the page's expense gate still decides first");
  assert.equal(
    planEmployee360Sections("regional-manager", { ...empty, doublesReceived: 2 }, true).showDoublesReceived,
    true,
    "a manager who was accompanied keeps the tile",
  );

  // Every other family keeps the composition it had before — only the Regional Manager is tailored.
  const dm = planEmployee360Sections("district-manager", empty, true);
  assert.equal(dm.hidesEmptySections, false);
  for (const key of ["showLeadership", "showTeamSales", "showOwnVisits", "showDoublesReceived", "showExpenses"] as const) {
    assert.equal(dm[key], true, `a District Manager keeps ${key} as before`);
  }
  const nsm = planEmployee360Sections("national-sales-manager", empty, true);
  assert.equal(nsm.showOwnVisits && nsm.showTeamSales && nsm.showLeadership, true, "the NSM keeps every section as before");
  const rep = planEmployee360Sections("medical-rep", empty, false);
  for (const key of repOnly) assert.equal(rep[key], true, `a Medical Rep keeps ${key}`);
  assert.equal(rep.showLeadership || rep.showTeamSales, false, "a Medical Rep has no leadership or team-sales section");
  assert.equal(planEmployee360Sections("training-manager", full, true).showTeamSales, false, "a Training Manager has no team sales");
  assert.equal(planEmployee360Sections("product-manager", empty, true).showCampaign, true, "a Product Manager keeps the campaign mix");

  // ── The page renders the plan, not a parallel inline rule ──
  const view = stripComments(readFileSync("src/components/employee-360/employee-360-view.tsx", "utf8"));
  assert.match(view, /const plan = planEmployee360Sections\(/, "the 360 view takes its sections from the domain plan");
  for (const flag of [
    "plan.showComparison && comparison",
    "plan.showLeadership && summary.leadership",
    "plan.showTeamSales ? <SalesSection",
    "plan.showOwnVisits ? (",
    "plan.showDoublesReceived ? (",
    "plan.showOwnSales ? <SalesSection",
    "plan.showBricks && summary.bricks",
    "plan.showExpenses ? (",
  ]) {
    assert.ok(view.includes(flag), `the view gates a section on ${flag}`);
  }
  assert.ok(!view.includes('const showCheckin = category === "medical-rep"'), "no inline section rule survives beside the plan");

  // The detail pages still load his team development and compliance (both gates name his family).
  for (const page of [
    "app/(admin)/employee-360/[hrId]/page.tsx",
    "app/employee-portals/employee-360/[hrId]/page.tsx",
    "app/employee-portals/employee-360/page.tsx",
  ]) {
    const source = stripComments(readFileSync(page, "utf8"));
    const gates = source.split('roleCategory === "regional-manager"').length - 1;
    // The portal detail page starts both reads together (2026-10-31, portal speed), so ONE shared
    // field-manager gate names his family and both reads stand behind it.
    const sharedGate =
      /const isFieldManager =[^;]*roleCategory === "regional-manager"/.test(source) &&
      // …or, since 1 Nov 2026 (the speed root cause), the portal page's five sections settle in ONE
      // wave and each manager section is `settled(isFieldManager ? getEmployee360…(` — same gate.
      /isFieldManager\s*\?\s*(?:startSection\(\(\) =>\s*)?getEmployee360TeamLifecycle\(/.test(source) &&
      /isFieldManager\s*\?\s*(?:startSection\(\(\) =>\s*)?getEmployee360TeamHealth\(/.test(source);
    assert.ok(gates === 2 || (gates === 1 && sharedGate), `${page} loads Team Health and Team Compliance for a Regional Manager`);
  }
}
