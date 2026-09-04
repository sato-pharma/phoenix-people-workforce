import assert from "node:assert/strict";

import {
  DOCTOR_COVERAGE_PORTAL_ROLES,
  LINE_ROLES,
  canSeeDoctorCoverage,
  doctorCoverageScopeBasisForRole,
} from "../src/lib/crm/doctor-coverage-roles.ts";
import {
  resolveDoctorCoverageScope,
  type DoctorCoverageScopeEmployee,
} from "../src/lib/crm/doctor-coverage-scope.ts";
import { resolveCoveragePace } from "../src/lib/crm/sfe-doctor-coverage.ts";
import { employeePortalNavigationSections } from "../src/config/system-navigation.ts";

/**
 * A two-level sales tree, which is the whole point: RM-1 → {DM-1, DM-2} → reps. A one-level
 * manager check would give RM-1 the two DMs and NONE of the reps beneath them — the exact silent
 * under-scope that made an S1 region roll up to "0.0%" and EGP 0 in PR #1486.
 */
function row(
  hrId: string,
  managerHrId: string | null,
  lineName: string | null,
  lineId: number | null,
  jobTitle: string,
  employmentStatus = "active",
): DoctorCoverageScopeEmployee {
  return {
    employmentStatus,
    hrId,
    jobTitle,
    lineId,
    lineName,
    managerHrId,
    pendingManagerReplacementForHrId: null,
  };
}

function tree(): DoctorCoverageScopeEmployee[] {
  return [
    row("NSM-1", null, "Pedia", 1, "National Sales Manager"),
    row("RM-1", "NSM-1", "Pedia", 1, "Regional Manager"),
    row("DM-1", "RM-1", "Pedia", 1, "District Manager"),
    row("REP-1", "DM-1", "Pedia", 1, "Medical Representative"),
    row("REP-2", "DM-1", "Pedia", 1, "Medical Representative"),
    row("DM-2", "RM-1", "Pedia", 1, "District Manager"),
    row("REP-3", "DM-2", "Pedia", 1, "Medical Representative"),
    // A different region on the same line, and a different line entirely.
    row("RM-9", "NSM-1", "Pedia", 1, "Regional Manager"),
    row("DM-9", "RM-9", "Pedia", 1, "District Manager"),
    row("REP-9", "DM-9", "Pedia", 1, "Medical Representative"),
    row("CNS-REP", "NSM-2", "CNS", 2, "Medical Representative"),
    row("NSM-2", null, "CNS", 2, "National Sales Manager"),
  ];
}

/**
 * The production shape the owner's downward rule was given for, 2026-09-04: Product Manager B-155
 * reports to A-8, a Group Product Manager who carries the SAME line id he does — so plain line
 * MEMBERSHIP puts his own manager inside his scope, and A-9 above her is the second rung.
 *
 * Every rank on the ladder is represented once, because the cut is RELATIVE: the same fixture has
 * to produce three different answers for a PM, a GPM and an NSM viewer. OFFICE-P is the seat the
 * ladder does not know — in production 12 head-office seats carry a line_id, so an unranked title
 * is not a hypothetical.
 */
function staffTree(): DoctorCoverageScopeEmployee[] {
  return [
    row("A-9", null, "Pedia", 2, "Marketing Manager"),
    row("A-8", "A-9", "Pedia", 2, "Group Product Manager"),
    row("B-155", "A-8", "Pedia", 2, "Product Manager"),
    row("PM-PEER", "A-8", "Pedia", 2, "Product Manager"),
    row("NSM-P", null, "Pedia", 2, "National Sales Manager"),
    row("RSM-P", "NSM-P", "Pedia", 2, "Regional Sales Manager"),
    row("DSM-P", "RSM-P", "Pedia", 2, "District Sales Manager"),
    row("REP-P", "DSM-P", "Pedia", 2, "Medical Representative"),
    row("OFFICE-P", "A-9", "Pedia", 2, "HR Business Partner"),
  ];
}

function agentsFor(role: string, viewerHrId: string | null, employees = tree()): string[] {
  const scope = resolveDoctorCoverageScope({ role, viewerHrId, employees });
  return scope.kind === "agents" ? [...scope.agentHrIds].sort() : [];
}

export function runDoctorCoverageScopeTests() {
  // ── role → basis ──────────────────────────────────────────────────────────────────────────────
  assert.equal(doctorCoverageScopeBasisForRole("Super Admin"), "company");
  assert.equal(doctorCoverageScopeBasisForRole("Marketing Manager"), "company");
  // Training Manager joined 2026-09-03 with the owner's instruction to show the rep list, the plans
  // and the KPIs to the marketing and field-support seats. COMPANY, not line: he owns no line and
  // supervises no rep, so a `line` basis would find no line on his employee row, resolve him to
  // `none`, and render an empty board — which reads as "these reps did nothing", not as a fault.
  assert.equal(doctorCoverageScopeBasisForRole("Training Manager"), "company");
  assert.equal(doctorCoverageScopeBasisForRole("National Sales Manager"), "line");
  assert.equal(doctorCoverageScopeBasisForRole("Product Manager"), "line");
  assert.equal(doctorCoverageScopeBasisForRole("Regional Manager"), "team");
  assert.equal(doctorCoverageScopeBasisForRole("District Manager"), "team");
  assert.equal(doctorCoverageScopeBasisForRole("Medical Rep"), "self");
  assert.equal(
    doctorCoverageScopeBasisForRole("HR Advisory"),
    null,
    "an unlisted role resolves to no basis — the default must be no access, never company-wide",
  );
  assert.equal(canSeeDoctorCoverage("Employee"), false);

  // ── company scope ─────────────────────────────────────────────────────────────────────────────
  const company = resolveDoctorCoverageScope({ role: "SFE Manager", viewerHrId: "X-1", employees: tree() });
  assert.equal(company.kind, "company", "SFE Manager keeps the whole-company analyst view");

  // ── team scope: the FULL subtree, not one level ───────────────────────────────────────────────
  assert.deepEqual(
    agentsFor("Regional Manager", "RM-1"),
    ["DM-1", "DM-2", "REP-1", "REP-2", "REP-3"],
    "an RM reaches every rep TWO levels down; stopping at direct reports would return only the DMs",
  );
  assert.deepEqual(
    agentsFor("District Manager", "DM-1"),
    ["REP-1", "REP-2"],
    "a DM sees exactly their own reps",
  );
  assert.ok(!agentsFor("District Manager", "DM-1").includes("REP-3"), "a DM never sees a sibling DM's rep");
  assert.ok(!agentsFor("Regional Manager", "RM-1").includes("REP-9"), "an RM never sees another region's reps");

  // ── the chain must stay walkable THROUGH a departed manager ───────────────────────────────────
  // DM-1 has resigned. The reps beneath still report to DM-1, so if the walker could not climb
  // through an inactive node the RM above would silently lose REP-1 and REP-2 — a wrong, quiet
  // under-count of exactly the team that just lost its manager and needs watching most.
  const withDepartedDm = tree().map((employee) =>
    employee.hrId === "DM-1" ? { ...employee, employmentStatus: "resigned" } : employee,
  );
  const rmThroughDepartedDm = agentsFor("Regional Manager", "RM-1", withDepartedDm);
  assert.ok(
    rmThroughDepartedDm.includes("REP-1") && rmThroughDepartedDm.includes("REP-2"),
    "the hierarchy climbs THROUGH a departed manager — the reps beneath a resigned DM stay visible to the RM",
  );
  assert.ok(
    !rmThroughDepartedDm.includes("DM-1"),
    "the departed manager is still filtered out of the emitted agent list",
  );

  // ── line scope ────────────────────────────────────────────────────────────────────────────────
  const nsmAgents = agentsFor("National Sales Manager", "NSM-1");
  assert.ok(nsmAgents.includes("REP-9"), "a line scope spans every region on that line");
  assert.ok(
    !nsmAgents.includes("CNS-REP"),
    "an NSM never sees another LINE's reps — the company-wide leak this module was built to close",
  );
  // PM, GPM and NSM all resolve to the same LINE. What differs is how far DOWN that line each may
  // look, which is the seat ladder — tested in full under THE DOWNWARD RULE below. Note the viewer
  // is ranked by his ROLE, not his job title: NSM-1 carries the title "National Sales Manager"
  // here but is asked for as a Product Manager, and gets a Product Manager's reach.
  const pmOnTheSameLine = agentsFor("Product Manager", "NSM-1");
  assert.ok(
    pmOnTheSameLine.includes("REP-9") && !pmOnTheSameLine.includes("CNS-REP"),
    "a PM resolves to the same LINE as the NSM — every region on it, and no other line",
  );
  assert.ok(
    nsmAgents.includes("DM-1") && !pmOnTheSameLine.includes("DM-1"),
    "but not to the same DEPTH: a District Manager is downward from the NSM and upward from the PM",
  );

  // ── THE DOWNWARD RULE ─────────────────────────────────────────────────────────────────────────
  // Owner, 2026-09-04: "Never an employee sees his direct manager. You see yourself and your scope
  // down — downgrading, not upgrading." Measured in production that day, B-155's line scope held 57
  // people including A-8, his own manager, who has 57 CRM visits of her own. Nothing rendered her,
  // but only because Reps Plans carries a medical-reps-only filter and the KPIs board had no plan
  // row to build for her — two accidents, not a rule. Asked how far the cut should reach, he
  // answered: "remove dsms rsm and peer pms too."
  const pmScope = agentsFor("Product Manager", "B-155", staffTree());
  assert.ok(
    !pmScope.includes("A-8"),
    "a viewer NEVER sees his own direct manager, even when she carries the same line id he does",
  );
  assert.ok(
    !pmScope.includes("A-9"),
    "the chain cut climbs the WHOLE way — the manager's manager is above him too, not just the first rung",
  );
  assert.ok(
    !pmScope.includes("NSM-P") && !pmScope.includes("RSM-P") && !pmScope.includes("DSM-P"),
    "every line manager above a PM's rank is out: NSM, RSM and DSM alike (owner, 2026-09-04)",
  );
  assert.ok(
    !pmScope.includes("PM-PEER"),
    "a PEER Product Manager is out too — the rule is strictly BELOW the viewer, not below-or-equal",
  );
  assert.ok(
    !pmScope.includes("OFFICE-P"),
    "a seat the ladder cannot rank is excluded, never waved through — 12 head-office seats carry a line_id in production",
  );
  assert.ok(
    pmScope.includes("B-155"),
    "you always see YOURSELF — the rule removes what is not below you, never you",
  );
  assert.deepEqual(
    pmScope,
    ["B-155", "REP-P"],
    "a Product Manager's line scope is himself and the medical reps — 57 people became 42 in production",
  );

  // A Group Product Manager sits one rung higher, so the SAME rule leaves her more: she keeps the
  // Product Managers beneath her and the field force, and still loses everyone at or above her own
  // rank. This is precisely what a flat blocklist of DSM/RSM/peer-PM titles could not express.
  const gpmScope = agentsFor("Group Product Manager", "A-8", staffTree());
  assert.deepEqual(
    gpmScope,
    ["A-8", "B-155", "DSM-P", "PM-PEER", "REP-P"],
    "a GPM keeps her own PMs and the field force, and loses her manager, the NSM and the RSM",
  );

  // The viewer-is-never-excluded guard is load-bearing, not tidy: a National Sales Manager is not
  // strictly below himself, so without it the ladder would delete him from his own board and hand
  // him finalizeAgents' empty state — which reads as "nobody on your line" rather than as a bug.
  const nsmOwnBoard = agentsFor("National Sales Manager", "NSM-P", staffTree());
  assert.deepEqual(
    nsmOwnBoard,
    ["A-8", "B-155", "DSM-P", "NSM-P", "PM-PEER", "REP-P", "RSM-P"],
    "an NSM keeps his whole line beneath him — the cut is relative to the VIEWER, not a fixed title list",
  );
  assert.ok(
    !nsmOwnBoard.includes("OFFICE-P") && !nsmOwnBoard.includes("A-9"),
    "even the top of the line does not collect head-office seats that merely share its line id",
  );

  // EVERY line role must be ranked on the ladder. An unranked one does not error: `viewerRank` falls
  // to null, the rank cut passes everyone through, and that viewer silently gets the wide
  // pre-2026-09-04 board back. An exhaustive Record would not catch it either — ignoreBuildErrors
  // lets a missing key compile, build and deploy — so this has to be a runtime assertion.
  // LR-VIEW's own title is deliberately OFF the ladder, so the job-title fallback cannot mask an
  // unranked role and quietly make this pass.
  for (const role of LINE_ROLES) {
    const scope = agentsFor(role, "LR-VIEW", [
      ...staffTree(),
      row("LR-VIEW", null, "Pedia", 2, "Brand Lead"),
      row("NSM-X", null, "Pedia", 2, "National Sales Manager"),
    ]);
    assert.ok(
      !scope.includes("NSM-X"),
      `${role} must be ranked on the seat ladder — an unranked line role silently restores the wide board`,
    );
  }

  // A pending seat replacement counts as an ancestor too — the conservative direction, because
  // being wrong here hides one row rather than exposing a manager to his own report. Proven on the
  // CHAIN cut specifically: A-8 outranks B-155, so the ladder would hide her anyway, and a fixture
  // that let the ladder answer would certify the chain walk without ever exercising it.
  const withPendingManager = staffTree().map((employee) =>
    employee.hrId === "B-155"
      ? { ...employee, managerHrId: null, pendingManagerReplacementForHrId: "REP-P" }
      : employee,
  );
  assert.ok(
    !agentsFor("Product Manager", "B-155", withPendingManager).includes("REP-P"),
    "a manager attached only as a PENDING replacement is still above the viewer, even when he outranks her",
  );

  // A cycle in the directory must not hang the climb. This has a real precedent: the downward walk
  // already carries a `visited` guard for exactly this shape.
  const cyclic = staffTree().map((employee) =>
    employee.hrId === "A-9" ? { ...employee, managerHrId: "B-155" } : employee,
  );
  const cyclicScope = agentsFor("Product Manager", "B-155", cyclic);
  assert.ok(cyclicScope.includes("B-155"), "a manager cycle resolves instead of hanging the render");
  assert.ok(!cyclicScope.includes("A-8"), "and the rule still holds through the cycle");

  // ── self scope ────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(agentsFor("Medical Rep", "REP-1"), ["REP-1"], "a Medical Rep sees only their own panel");

  // ── multi-line override ───────────────────────────────────────────────────────────────────────
  // Owner 2026-08-09: Ahmed Sharaf (B-155) is recorded on Pedia but covers Anti Infective too.
  // In the fixture, NSM-1 sits on line 1 and CNS-REP on line 2.
  const scopeWithOverride = (lineOverrides: Record<string, number[]>, role = "Product Manager", hrId = "NSM-1") =>
    resolveDoctorCoverageScope({ role, viewerHrId: hrId, employees: tree(), lineOverrides });

  const twoLines = scopeWithOverride({ nsm1: [1, 2] });
  assert.equal(twoLines.kind, "agents");
  if (twoLines.kind === "agents") {
    assert.ok(
      twoLines.agentHrIds.includes("CNS-REP"),
      "an override to lines 1+2 pulls in the OTHER line's reps — that is the whole point of it",
    );
    assert.ok(twoLines.label.includes("+"), `the label must NAME both lines, got "${twoLines.label}"`);
  }
  assert.ok(
    !agentsFor("Product Manager", "NSM-1").includes("CNS-REP"),
    "without the override the same viewer stays on their own line — the override is the only thing widening them",
  );

  // An override must never rescue a role with no access, nor widen a team-scoped viewer.
  assert.equal(
    scopeWithOverride({ nsm1: [1, 2, 3] }, "HR Advisory").kind,
    "none",
    "a line override cannot grant access to a role that has none — the role check runs first",
  );
  const dmWithOverride = scopeWithOverride({ dm1: [1, 2, 3] }, "District Manager", "DM-1");
  assert.deepEqual(
    dmWithOverride.kind === "agents" ? [...dmWithOverride.agentHrIds].sort() : [],
    ["REP-1", "REP-2"],
    "a line override must not widen a TEAM-scoped viewer — a DM still sees exactly their own reps",
  );

  // ── fail closed, never wider ──────────────────────────────────────────────────────────────────
  assert.equal(
    resolveDoctorCoverageScope({ role: "District Manager", viewerHrId: null, employees: tree() }).kind,
    "none",
    "a session with no HR ID gets no data, never the company board",
  );
  assert.equal(
    resolveDoctorCoverageScope({ role: "District Manager", viewerHrId: "GHOST-1", employees: tree() }).kind,
    "none",
    "an HR ID absent from the directory fails closed",
  );
  assert.equal(
    resolveDoctorCoverageScope({ role: "District Manager", viewerHrId: "REP-1", employees: tree() }).kind,
    "none",
    "a manager with no reports resolves to none — never an empty agent list, which the query would read as 'no rows'",
  );
  const noLine = tree().map((employee) =>
    employee.hrId === "NSM-1" ? { ...employee, lineId: null, lineName: null } : employee,
  );
  assert.equal(
    resolveDoctorCoverageScope({ role: "National Sales Manager", viewerHrId: "NSM-1", employees: noLine }).kind,
    "none",
    "a line role with no line on their record gets nothing rather than everything",
  );

  // ── elapsed-month pace ────────────────────────────────────────────────────────────────────────
  // The defect this replaced: on 2026-08-08 the board showed a rose 13.7% because it compared a
  // month-to-date figure against the whole-month 80/50 bar. 8 of 31 days elapsed scales the bars to
  // 20.6/12.9, so 13.7% is behind pace but not alarming — amber.
  const dayEight = resolveCoveragePace({ coveragePct: 13.7, selectedMonth: "2026-08", todayIso: "2026-08-08" });
  assert.equal(dayEight.tone, "amber", "13.7% on day 8 of 31 is amber, not rose — an on-pace team must not read as a crisis");
  assert.equal(dayEight.daysRemaining, 23, "23 days left in August after the 8th");
  assert.equal(dayEight.expectedCoveragePct, 21, "the on-pace bar is 80% scaled by 8/31");

  assert.equal(
    resolveCoveragePace({ coveragePct: 13.7, selectedMonth: "2026-07", todayIso: "2026-08-08" }).tone,
    "rose",
    "a CLOSED month keeps the original whole-month 80/50 thresholds — 13.7% there really is rose",
  );
  assert.equal(
    resolveCoveragePace({ coveragePct: 85, selectedMonth: "2026-07", todayIso: "2026-08-08" }).tone,
    "emerald",
    "a closed month at 85% is still emerald — the pace change must not move historical readings",
  );
  assert.equal(
    resolveCoveragePace({ coveragePct: 0, selectedMonth: "2026-12", todayIso: "2026-08-08" }).tone,
    "amber",
    "a month that has not started has no pace to judge — 0% must not read as an emerald all-clear",
  );
  assert.equal(
    resolveCoveragePace({ coveragePct: 3, selectedMonth: "2026-08", todayIso: "2026-08-01" }).tone,
    "emerald",
    "day 1 clamps to one elapsed day rather than dividing the bar to zero",
  );

  // ── THE DRIFT CHECK, BACK WITH THE REPLACEMENT (2026-09-02) ──────────────────────────────────
  // This block held the sidebar's role list identical to DOCTOR_COVERAGE_PORTAL_ROLES. Both were
  // maintained by hand before 2026-08-08 and disagreed with the page gates, which is how "everyone
  // sees everyone" survived: nothing forced the two to match. The owner retired the board on
  // 2026-08-28, so for four days the assertion was inverted and pinned the retirement instead —
  // with the note that "when the replacement ships it gets its own entry, and the drift check comes
  // back with it". KPIs is that replacement, so both halves are asserted here now.
  const portalItems = employeePortalNavigationSections.flatMap((section) => section.items);

  // Half one: the retirement is still in force. The rebuild replaces Doctor Coverage, it does not
  // reinstate it — a session restoring the old entry alongside the new one would put two boards
  // back in front of the owner answering one question with different measures, which is the exact
  // fault he retired it for.
  assert.equal(
    portalItems.find((item) => item.href === "/employee-portals/doctor-coverage"),
    undefined,
    "the portal sidebar must NOT offer Doctor Coverage — the owner retired that board on 2026-08-28 and KPIs replaces it",
  );

  // Half two: the replacement's entry exists and its role list has not drifted from the module.
  const kpisItem = portalItems.find((item) => item.href === "/employee-portals/kpis");
  assert.ok(kpisItem, "the portal sidebar must offer KPIs — it is the 2026-08-28 rebuild's own entry");
  assert.deepEqual(
    [...(kpisItem.roles ?? [])].sort(),
    [...DOCTOR_COVERAGE_PORTAL_ROLES].sort(),
    "the KPIs sidebar entry must name exactly DOCTOR_COVERAGE_PORTAL_ROLES — a hand-maintained second copy of that list is what let the two disagree before 2026-08-08",
  );

  // And every role in it must still resolve to a real scope: one that resolves to nothing is the
  // silent-empty-board failure this whole module exists to prevent.
  for (const role of DOCTOR_COVERAGE_PORTAL_ROLES) {
    assert.ok(
      canSeeDoctorCoverage(role),
      `${role} is offered the sidebar link, so it must resolve to a real scope rather than an empty board`,
    );
  }
}
