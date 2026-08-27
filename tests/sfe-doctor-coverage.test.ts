import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addMonthsToMonthKey,
  buildDoctorCoverageBoard,
  coverageTargetForGrade,
  DOCTOR_COVERAGE_TARGETS,
  lastDayOfMonthKeyIso,
  monthKeyOfVisitDate,
  resolveCoverageMonth,
  type DoctorCoveragePlanInput,
  type DoctorCoverageVisitInput,
} from "../src/lib/crm/sfe-doctor-coverage.ts";
import { cairoTodayIso } from "../src/lib/crm/dates.ts";
import { CAMPAIGN_TYPE } from "../src/lib/crm/visit-types.ts";

let nextVisitId = 1;

function visit(overrides: Partial<DoctorCoverageVisitInput> = {}): DoctorCoverageVisitInput {
  return {
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    agent_name: "Rep One",
    contact_crm_id: 500,
    contact_name: "Dr. Test",
    crm_contact_grade: "A",
    crm_save_date: null,
    crm_visit_id: nextVisitId++,
    double_crm_id: null,
    speciality: "Pediatrics",
    visit_date: "2026-08-05",
    visit_type: 0,
    ...overrides,
  };
}

/** One entry of a rep's assigned list. The panel is built from THESE, not from visit history. */
function plan(overrides: Partial<DoctorCoveragePlanInput> = {}): DoctorCoveragePlanInput {
  return {
    agent_crm_id: 100,
    agent_hr_id: "M-1",
    contact_crm_id: 500,
    contact_grade: "A",
    contact_name: "Dr. Test",
    plan_date: "2026-08-04",
    speciality: "Pediatrics",
    ...overrides,
  };
}

const MONTH = "2026-08";

export function runSfeDoctorCoverageTests() {
  // ── Month helpers: pure string math, leap-aware, no Date objects ─────────────────────────────
  assert.equal(monthKeyOfVisitDate("2026-07-31"), "2026-07");
  assert.equal(addMonthsToMonthKey("2026-01", -3), "2025-10", "month arithmetic must cross year boundaries");
  assert.equal(addMonthsToMonthKey("2025-12", 1), "2026-01");
  assert.equal(lastDayOfMonthKeyIso("2024-02"), "2024-02-29", "leap February must have 29 days");
  assert.equal(lastDayOfMonthKeyIso("2026-02"), "2026-02-28");
  assert.equal(lastDayOfMonthKeyIso("2026-08"), "2026-08-31");
  assert.equal(resolveCoverageMonth("2026-05"), "2026-05", "a valid YYYY-MM passes through");
  const fallback = resolveCoverageMonth("2026-13");
  assert.equal(fallback, monthKeyOfVisitDate(cairoTodayIso()), "garbage month falls back to the current Cairo month");
  assert.equal(resolveCoverageMonth(undefined), monthKeyOfVisitDate(cairoTodayIso()));

  // ── Coverage targets: A+ folds into A; unknown grades are ungraded, not defaulted ────────────
  assert.equal(coverageTargetForGrade("A+"), DOCTOR_COVERAGE_TARGETS.A, "A+ must inherit the A-tier target");
  assert.equal(coverageTargetForGrade("A"), 2);
  assert.equal(coverageTargetForGrade("B"), 1);
  assert.equal(coverageTargetForGrade("C"), 1);
  assert.equal(coverageTargetForGrade("Z"), null, "an unknown grade is ungraded — never silently target 1");
  assert.equal(coverageTargetForGrade(null), null);

  // ── Status classification, against the ASSIGNED LIST ───────────────────────
  // The panel is the list the rep was GIVEN, joined to his own visits. It is not inferred from who
  // he happened to touch, which is what made a panel of 4 and a panel of 263 both possible against
  // a business rule of 90 to 120 doctors.
  const board = buildDoctorCoverageBoard(
    [
      // Doctor 1 (A), assigned: exactly 2 visits in August -> green.
      visit({ contact_crm_id: 1, contact_name: "Dr. Green", visit_date: "2026-08-03" }),
      visit({ contact_crm_id: 1, contact_name: "Dr. Green", visit_date: "2026-08-20" }),
      // Doctor 2 (A), assigned: 1 of 2 -> yellow.
      visit({ contact_crm_id: 2, contact_name: "Dr. Yellow", visit_date: "2026-08-10" }),
      // Doctor 3 (A), assigned: 0 in August, last seen in July -> red. Under the old board that
      // July visit is what KEPT him in the panel; now the assignment does, and the July date only
      // tells the call list how long he has gone unseen.
      visit({ contact_crm_id: 3, contact_name: "Dr. RedJuly", visit_date: "2026-07-15" }),
      // Doctor 5 (A): visited in May, never assigned -> no panel row, and no off-list count either,
      // because off-list counts work done THIS month.
      visit({ contact_crm_id: 5, contact_name: "Dr. Ancient", visit_date: "2026-05-09" }),
      // Doctor 6 (B), assigned: 1 visit -> green at the B target.
      visit({ contact_crm_id: 6, contact_name: "Dr. BGreen", crm_contact_grade: "B", visit_date: "2026-08-14" }),
      // Doctor 10 (A): visited in August, NOT on this rep's list -> off-list. This is the case the
      // old board promoted into the panel through its "primary rep" election: 1,670 of the old
      // panel's 7,295 scored pairs on production, 22.9%.
      visit({ contact_crm_id: 10, contact_name: "Dr. OffList", visit_date: "2026-08-12" }),
      // Sentinel and null contacts, and a campaign row - all ignored.
      visit({ contact_crm_id: 0, visit_date: "2026-08-04" }),
      visit({ contact_crm_id: null, visit_date: "2026-08-04" }),
      visit({ contact_crm_id: 8, visit_date: "2026-08-04", visit_type: -8 }),
      // Null visit_date row - skipped, never crashes bucketing.
      visit({ contact_crm_id: 9, visit_date: null }),
    ],
    MONTH,
    {
      planRows: [
        plan({ contact_crm_id: 1, contact_name: "Dr. Green" }),
        plan({ contact_crm_id: 2, contact_name: "Dr. Yellow" }),
        plan({ contact_crm_id: 3, contact_name: "Dr. RedJuly" }),
        // Doctor 4 (B): ASSIGNED and never visited, in this month or any other. The headline case.
        // He appears in no visit row at all, so under the old board he did not exist; production
        // had 1,347 of 9,163 assigned pairs in exactly this state - 14.7% invisible.
        plan({ contact_crm_id: 4, contact_grade: "B", contact_name: "Dr. NeverSeen" }),
        plan({ contact_crm_id: 6, contact_grade: "B", contact_name: "Dr. BGreen" }),
        // Assigned but carrying no grade anywhere - no norm to hold him to, so out of the panel and
        // surfaced instead of silently shrinking the denominator.
        plan({ contact_crm_id: 7, contact_grade: null, contact_name: "Dr. NoGrade" }),
        // A repeat weekly plan entry for a doctor already listed. Production sends 18,645 August
        // entries for 9,163 distinct pairs - counting entries would roughly double every panel.
        plan({ contact_crm_id: 1, contact_name: "Dr. Green", plan_date: "2026-08-18" }),
        // A plan row in a DIFFERENT month must not join this month's panel.
        plan({ contact_crm_id: 99, contact_name: "Dr. NextMonth", plan_date: "2026-07-06" }),
        // A junk date and a missing contact id are skipped, never crash.
        plan({ contact_crm_id: 98, plan_date: "not-a-date" }),
        plan({ contact_crm_id: null }),
      ],
    },
  );

  const byId = new Map(board.doctors.map((doctor) => [doctor.contactCrmId, doctor]));
  assert.equal(byId.get(1)?.status, "green", "an assigned A-doctor with exactly target visits is green");
  assert.equal(byId.get(2)?.status, "yellow", "one visit short is yellow, not red");
  assert.equal(byId.get(3)?.status, "red", "assigned and not visited this month is red - the July visit is history, not membership");
  assert.equal(
    byId.get(4)?.status,
    "red",
    "an assigned doctor with NO visit in the whole window must still be a red panel row - he was invisible before, which is how neglecting a doctor improved a rep's score",
  );
  assert.equal(byId.get(4)?.lastVisitDate, null, "never visited means no last-visit date, not a missing row");
  assert.equal(byId.has(5), false, "a doctor never assigned is not this rep's panel, however recently he was seen");
  assert.equal(byId.get(6)?.status, "green", "B-doctor meets the B target with 1 visit");
  assert.equal(byId.has(7), false, "an ungraded assignment has no norm to score - out of the panel");
  assert.equal(board.totals.ungradedContacts, 1, "... and is surfaced rather than silently dropped");
  assert.equal(byId.has(8), false, "campaign rows (visit_type -8) never feed coverage");
  assert.equal(byId.has(10), false, "an off-list visit is never a panel row - there is no target to score it against");
  assert.equal(byId.has(99), false, "a plan row from another month must not join this month's panel");

  assert.equal(board.totals.activePanel, 5, "panel = the graded assigned doctors: 1, 2, 3, 4, 6");
  assert.equal(board.totals.green, 2);
  assert.equal(board.totals.yellow, 1);
  assert.equal(board.totals.red, 2);
  assert.equal(board.totals.offListDoctors, 1, "doctor 10 - reported beside coverage, never inside it");
  assert.equal(board.totals.coveragePct, Math.round((2 / 5) * 100), "coverage % = green / assigned panel");
  assert.equal(board.totals.planMonthMissing, false);
  assert.equal(board.totals.repsWithNoList, 0);
  const repTotals = board.reps.reduce(
    (sum, rep) => ({ green: sum.green + rep.green, panel: sum.panel + rep.panelSize }),
    { green: 0, panel: 0 },
  );
  assert.equal(repTotals.panel, board.totals.activePanel, "rep rows must sum exactly to the company panel");
  assert.equal(repTotals.green, board.totals.green, "rep green counts must sum exactly to the company green");

  // A month the mirror has not delivered says so, instead of reporting everyone at 0%.
  const noList = buildDoctorCoverageBoard([visit({ contact_crm_id: 1, visit_date: "2026-08-03" })], MONTH, {
    planRows: [],
  });
  assert.equal(noList.totals.planMonthMissing, true, "no plan rows at all is a missing feed, and the board must be able to say so");
  assert.equal(noList.totals.activePanel, 0, "... and must NOT quietly fall back to inferring a panel from the visits");
  assert.equal(noList.totals.offListDoctors, 1, "the work still happened and is still reported");

  // ── Month-boundary bucketing: 07-31 vs 08-01 are different months ─────────────────
  const boundary = buildDoctorCoverageBoard(
    [
      visit({ contact_crm_id: 11, contact_name: "Dr. Boundary", visit_date: "2026-07-31" }),
      visit({ contact_crm_id: 12, contact_name: "Dr. August", visit_date: "2026-08-01" }),
    ],
    MONTH,
    { planRows: [plan({ contact_crm_id: 11 }), plan({ contact_crm_id: 12 })] },
  );
  const boundaryById = new Map(boundary.doctors.map((doctor) => [doctor.contactCrmId, doctor]));
  assert.equal(boundaryById.get(11)?.status, "red", "a July 31 visit does not cover an August assignment");
  assert.equal(boundaryById.get(11)?.visitsThisMonth, 0);
  assert.equal(boundaryById.get(11)?.lastVisitDate, "2026-07-31", "... but it is still the date the call list ranks on");
  assert.equal(boundaryById.get(12)?.visitsThisMonth, 1, "an August 1 visit buckets into August");

  // ── Grade: the LIST is the authority, the visits are the fallback ───────────────
  // The list carries a grade on 100% of production rows for 2026-01..2026-08, so a disagreement
  // means the visit mirror is stale, not that the assignment is wrong.
  const regraded = buildDoctorCoverageBoard(
    [
      visit({ contact_crm_id: 21, contact_name: "Dr. Upgraded", crm_contact_grade: "B", visit_date: "2026-07-02" }),
      visit({ contact_crm_id: 21, contact_name: "Dr. Upgraded", crm_contact_grade: "B", visit_date: "2026-08-06" }),
    ],
    MONTH,
    { planRows: [plan({ contact_crm_id: 21, contact_grade: "A", contact_name: "Dr. Upgraded" })] },
  );
  assert.equal(regraded.doctors[0]?.gradeTier, "A", "the grade on the assignment wins over the grade on a visit");
  assert.equal(regraded.doctors[0]?.targetVisits, 2, "target follows the assigned grade");
  assert.equal(regraded.doctors[0]?.status, "yellow", "1 of 2 at the assigned target");

  // A thin list row falls back to the visit mirror rather than dropping out of the panel.
  const thinList = buildDoctorCoverageBoard(
    [visit({ contact_crm_id: 23, contact_name: "Dr. Thin", crm_contact_grade: "B", visit_date: "2026-08-06" })],
    MONTH,
    { planRows: [plan({ contact_crm_id: 23, contact_grade: null, contact_name: null, speciality: null })] },
  );
  assert.equal(thinList.doctors[0]?.gradeTier, "B", "an ungraded assignment takes the latest grade seen on a visit");
  assert.equal(thinList.doctors[0]?.contactName, "Dr. Thin", "... and the name too, rather than printing a raw id");

  // A+ folds into tier A on the board too.
  const plusBoard = buildDoctorCoverageBoard(
    [visit({ contact_crm_id: 22, contact_name: "Dr. Plus", visit_date: "2026-08-02" })],
    MONTH,
    { planRows: [plan({ contact_crm_id: 22, contact_grade: "A+", contact_name: "Dr. Plus" })] },
  );
  assert.equal(plusBoard.doctors[0]?.gradeTier, "A");
  assert.equal(plusBoard.doctors[0]?.gradeRaw, "A+", "raw grade is preserved for display");

  // ── An assignment belongs to ONE rep - there is no primary-rep election any more ──────
  // The old board elected a single owner per doctor (most visits wins) and pooled everyone's visits
  // into that one row, so two reps sharing a doctor covered for each other: the doctor went green
  // on the winner's panel and vanished from the loser's. Each assignment is now scored on its own
  // rep's own work.
  const shared = buildDoctorCoverageBoard(
    [
      visit({ agent_crm_id: 100, agent_hr_id: "M-1", agent_name: "Rep One", contact_crm_id: 31, visit_date: "2026-08-03" }),
      visit({ agent_crm_id: 100, agent_hr_id: "M-1", agent_name: "Rep One", contact_crm_id: 31, visit_date: "2026-08-15" }),
      visit({ agent_crm_id: 200, agent_hr_id: "M-2", agent_name: "Rep Two", contact_crm_id: 31, visit_date: "2026-08-20" }),
    ],
    MONTH,
    {
      planRows: [
        plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 31 }),
        plan({ agent_crm_id: 200, agent_hr_id: "M-2", contact_crm_id: 31 }),
      ],
    },
  );
  assert.equal(shared.doctors.length, 2, "a doctor assigned to two reps is a row on EACH panel - both were given him");
  const sharedByRep = new Map(shared.doctors.map((doctor) => [doctor.repKey, doctor]));
  assert.equal(sharedByRep.get("hr:m-1")?.visitsThisMonth, 2, "each rep is scored on his OWN visits");
  assert.equal(sharedByRep.get("hr:m-1")?.status, "green");
  assert.equal(
    sharedByRep.get("hr:m-2")?.visitsThisMonth,
    1,
    "a colleague's two visits must not discharge this rep's assignment - that pooling is the cross-rep bleed",
  );
  assert.equal(sharedByRep.get("hr:m-2")?.status, "yellow");

  // A visit to somebody else's assignment is off-list for the visitor and does nothing for the owner.
  const crossed = buildDoctorCoverageBoard(
    [visit({ agent_crm_id: 200, agent_hr_id: "M-2", agent_name: "Rep Two", contact_crm_id: 32, visit_date: "2026-08-19" })],
    MONTH,
    { planRows: [plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 32 })] },
  );
  const crossedOwner = crossed.reps.find((rep) => rep.repKey === "hr:m-1");
  const crossedVisitor = crossed.reps.find((rep) => rep.repKey === "hr:m-2");
  assert.equal(crossedOwner?.red, 1, "the assigned rep did not visit him, so his own row stays red");
  assert.equal(crossedOwner?.offListDoctors, 0);
  assert.equal(crossedVisitor?.offListDoctors, 1, "the visiting rep gets an off-list count");
  assert.equal(crossedVisitor?.panelSize, 0, "... and no panel, because he was assigned nobody");
  assert.equal(crossedVisitor?.hasPanel, false, "... so the table prints a marker, never a 0% that reads as a real score");
  assert.equal(crossed.totals.repsWithNoList, 1, "one rep on this board holds no assigned list");

  // ── One rep, one key - reconciled across BOTH mirrors ───────────────────────
  // The plan mirror leaves agent_hr_id null on a large and VARYING share of rows - 791 of 18,645 in
  // August 2026 but 5,795 of 20,778 in May, and 26 of 98 agents carry it on no plan row at all.
  // Keyed per row, the same person is filed under hr: from his visits and crm: from his list, so
  // not one assignment joins to a visit and he reads 0% on a full list. That artifact appeared for
  // real the first time this join was measured in SQL: eleven reps came back holding a list of zero.
  const splitIdentity = buildDoctorCoverageBoard(
    [visit({ agent_crm_id: 100, agent_hr_id: "M-1", agent_name: "Rep One", contact_crm_id: 41, visit_date: "2026-08-03" })],
    MONTH,
    { planRows: [plan({ agent_crm_id: 100, agent_hr_id: null, contact_crm_id: 41 })] },
  );
  assert.equal(splitIdentity.doctors.length, 1, "a plan row with no hr id must resolve through its crm id, not become a second rep");
  assert.equal(splitIdentity.doctors[0]?.repKey, "hr:m-1");
  assert.equal(
    splitIdentity.doctors[0]?.visitsThisMonth,
    1,
    "the visit must join the assignment - a split key silently scores a full list at 0%",
  );
  assert.equal(splitIdentity.reps.length, 1, "one person, one row");

  const unmapped = buildDoctorCoverageBoard(
    [visit({ agent_crm_id: 777, agent_hr_id: null, agent_name: null, contact_crm_id: 33, visit_date: "2026-08-03" })],
    MONTH,
    { planRows: [plan({ agent_crm_id: 777, agent_hr_id: null, contact_crm_id: 33 })] },
  );
  assert.equal(unmapped.doctors[0]?.repKey, "crm:777", "an unmapped agent keys by crm id");
  assert.equal(unmapped.doctors[0]?.repName, "Unmapped agent");
  assert.equal(unmapped.reps[0]?.agentHrId, null);

  // A rep who holds a list but logged no visit has no CRM name anywhere - the employee directory is
  // the only place one exists, and under the old visit-derived panel he could not appear at all.
  const named = buildDoctorCoverageBoard([], MONTH, {
    planRows: [plan({ agent_crm_id: 300, agent_hr_id: "M-7", contact_crm_id: 51 })],
    repNameByHrId: new Map([["m-7", "Hanan Safwat"]]),
  });
  assert.equal(named.reps[0]?.repName, "Hanan Safwat", "a rep with a list and no visits must still be named, never shown as a code");
  assert.equal(named.reps[0]?.panelSize, 1);
  assert.equal(named.reps[0]?.coveragePct, 0, "... and scored 0% on a real list, which is the whole point of the change");

  // ── Trend: 4 points, oldest first, ending at the selected month ──────────────────────────────
  assert.equal(board.trend.length, 4);
  assert.deepEqual(
    board.trend.map((point) => point.month),
    ["2026-05", "2026-06", "2026-07", "2026-08"],
    "trend spans the scan window oldest→selected",
  );

  // ── Source contracts: the IO wrapper stays inside the single-source door + date discipline ───
  const serviceSource = readFileSync("src/lib/crm/sfe-doctor-coverage.ts", "utf8");
  assert.match(serviceSource, /from "@\/lib\/crm\/reads"/, "reads must go through the CRM single-source door");
  assert.match(
    serviceSource,
    /queryVisits/,
    "multi-month reads must use a keyset scanner from the door — queryVisits replaced scanVisitsForRange on 2026-08-08 because it can push the viewer scope and visit_type into Postgres",
  );
  assert.match(serviceSource, /collapseDuplicateVisitSubmissions/, "counts must agree with DV/FWC via the canonical collapse");
  assert.match(serviceSource, /visit\.visit_type !== 0/, "the board is regular-customer-visits-only by contract");
  assert.match(
    serviceSource,
    /visitTypes:\s*\[0\]/,
    "the type-0 filter must run in Postgres, not only in the JS loop — it was 29.3% of a measured 6-month window fetched purely to be discarded",
  );
  assert.doesNotMatch(
    serviceSource,
    /new Date\([^)]*visit|toISOString\(\)/,
    "CRM date strings are Cairo wall-clock — Date parsing would shift them (same rule as sfe-field-analytics)",
  );

  // ── Page gates. Both twins delegate to doctor-coverage-scope.ts and keep NO role list of their
  // own. Before 2026-08-08 each page carried its own hardcoded set and NEITHER scoped the data, so
  // every seat that got in read all 205 agents company-wide. Pinning "no local role list" is what
  // stops that returning — a page that re-adds one has re-created the drift. ───────────────────
  // A "the code must not do X" assertion has to read CODE. Both pages explain the old hardcoded
  // gate in their header comment — quoting the defect is how the next reader knows not to redo it —
  // and an unstripped regex matches that prose and fails on the explanation itself.
  const codeOnly = (source: string) =>
    source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

  const adminPage = readFileSync("app/(admin)/admin/doctor-coverage/page.tsx", "utf8");
  assert.match(adminPage, /getDoctorCoverageScope/, "the admin twin must resolve its viewer scope from the shared resolver");
  assert.match(adminPage, /scope\.kind === "none"/, "the admin twin must gate on the resolved scope");
  assert.match(adminPage, /redirect\(/, "the admin page must fail closed with a redirect");
  assert.doesNotMatch(
    codeOnly(adminPage),
    /ALLOWED_ROLES|new Set\(\[/,
    "the admin page must not reintroduce a local role list — doctor-coverage-roles.ts is the single source",
  );
  assert.doesNotMatch(
    codeOnly(adminPage),
    /"National Sales Manager"/,
    "NSM on the admin page would be dead code — the (admin) layout redirects portal-mode roles first",
  );

  const portalPage = readFileSync("app/employee-portals/doctor-coverage/page.tsx", "utf8");
  assert.match(portalPage, /getDoctorCoverageScope/, "the portal twin must resolve its viewer scope from the shared resolver");
  assert.match(portalPage, /EmployeePortalPageShell/, "the portal twin must render inside the portal shell");
  assert.doesNotMatch(
    codeOnly(portalPage),
    /access\.role !==/,
    "the portal page must not hardcode a role comparison — that check is what limited this board to the NSM while scoping nothing",
  );
  // The board is only reachable with a scope, so no caller can fall back to company-wide data.
  assert.match(
    serviceSource,
    /scope:\s*DoctorCoverageScope/,
    "getSfeDoctorCoverage must take a REQUIRED scope — an optional one is how the company-wide read survived",
  );

  // ── Campaign work is counted SEPARATELY — owner ruling 2026-08-27 ────────────────────────────
  // He was asked whether a campaign call (visit type -8) satisfies a planned doctor call and
  // answered "count it separately". So campaign never enters coveragePct, and a rep whose only
  // logged work is campaign gets a row of their own instead of vanishing.
  //
  // The ABSENCE is the defect being fixed, not a wrong number. repRows is built by walking the
  // graded doctors, and a campaign row carries contact id 0 with a blank name and a null grade —
  // so it can never produce a doctor, and before this change a campaign-only rep had NO ROW AT
  // ALL on this board. Not a visible 0%: nothing. Measured on production 2026-08-27, that was 15
  // people in August 2026, 22 in July and 24 in June; the busiest of them logged 160 campaign
  // calls in a month and read as absent from the field.
  {
    const graded = [
      // Rep One: one grade-A doctor, target 2, seen twice → green, 100%.
      visit({ agent_hr_id: "M-1", agent_name: "Rep One", contact_crm_id: 500, visit_date: "2026-08-03" }),
      visit({ agent_hr_id: "M-1", agent_name: "Rep One", contact_crm_id: 500, visit_date: "2026-08-17" }),
      // Rep Two: one grade-A doctor seen once → short of target, 0%. The worst graded rep, so a
      // worst-first ranking must open with them and not with a rep who has nothing to score.
      visit({ agent_crm_id: 101, agent_hr_id: "M-2", agent_name: "Rep Two", contact_crm_id: 600, visit_date: "2026-08-04" }),
    ];
    const gradedPlan = [
      plan({ agent_crm_id: 100, agent_hr_id: "M-1", contact_crm_id: 500 }),
      plan({ agent_crm_id: 101, agent_hr_id: "M-2", contact_crm_id: 600 }),
    ];
    const before = buildDoctorCoverageBoard(graded, MONTH, { planRows: gradedPlan });

    const campaignRow = (overrides: Partial<DoctorCoverageVisitInput>) =>
      visit({
        contact_crm_id: 0,
        contact_name: "",
        crm_contact_grade: null,
        speciality: null,
        visit_type: CAMPAIGN_TYPE,
        ...overrides,
      });
    const campaign = [
      // A rep who has BOTH: the campaign count lands on their existing row, never a second one.
      campaignRow({ agent_hr_id: "M-1", agent_name: "Rep One", visit_date: "2026-08-04" }),
      // A rep with no graded panel at all — the row that did not exist before the ruling. Two of
      // these share a date and a contact id; campaign rows are deliberately NOT run through the
      // duplicate collapse, so a real day of campaign calls stays a real day of campaign calls.
      campaignRow({ agent_crm_id: 200, agent_hr_id: "M-9", agent_name: "Campaign Only", visit_date: "2026-08-06" }),
      campaignRow({ agent_crm_id: 200, agent_hr_id: "M-9", agent_name: "Campaign Only", visit_date: "2026-08-06" }),
      campaignRow({ agent_crm_id: 200, agent_hr_id: "M-9", agent_name: "Campaign Only", visit_date: "2026-08-07" }),
      // An agent the HR map never matched still gets counted, under their CRM id.
      campaignRow({ agent_crm_id: 777, agent_hr_id: null, agent_name: "Unmapped Rep", visit_date: "2026-08-09" }),
      // Outside the selected month — must not inflate a single counter.
      campaignRow({ agent_crm_id: 200, agent_hr_id: "M-9", agent_name: "Campaign Only", visit_date: "2026-07-30" }),
      // Not a date at all. Real CRM exports carry these; they must be skipped, not crash.
      campaignRow({ agent_crm_id: 200, agent_hr_id: "M-9", agent_name: "Campaign Only", visit_date: "" }),
    ];
    const after = buildDoctorCoverageBoard(graded, MONTH, { campaignVisits: campaign, planRows: gradedPlan });

    // HEADLINE: the row exists at all.
    const campaignOnly = after.reps.find((rep) => rep.repKey === "hr:m-9");
    assert.ok(
      campaignOnly,
      "a rep whose ONLY field work is campaign must get a row — before 2026-08-27 they had none at all, so 15 working people read as absent",
    );
    assert.equal(campaignOnly.campaignCalls, 3, "three campaign calls inside the month; the July row and the blank date are ignored");
    assert.equal(campaignOnly.hasPanel, false, "no graded panel — the board must say so rather than print a 0% that reads as a real score");
    assert.equal(campaignOnly.panelSize, 0, "campaign builds no panel: contact id 0, blank name, null grade");
    assert.equal(campaignOnly.repName, "Campaign Only", "a human-readable name, never the HR id");
    assert.equal(campaignOnly.agentHrId, "m-9", "the HR id survives on the row so the drill-through link still resolves");

    const unmapped = after.reps.find((rep) => rep.repKey === "crm:777");
    assert.ok(unmapped, "an agent with no HR mapping is still a working rep — key them by CRM id, do not drop them");
    assert.equal(unmapped.agentHrId, null, "nothing to link to, and the board must not invent an id");
    assert.equal(unmapped.campaignCalls, 1);

    // Coverage did not move. This is the whole meaning of "separately".
    const panelledBefore = before.reps.find((rep) => rep.repKey === "hr:m-1");
    const panelled = after.reps.find((rep) => rep.repKey === "hr:m-1");
    assert.ok(panelledBefore && panelled, "the graded rep must survive the campaign fold-in");
    assert.equal(panelled.coveragePct, panelledBefore.coveragePct, "campaign must not move a graded rep's coverage by one point");
    assert.equal(panelled.panelSize, panelledBefore.panelSize, "campaign adds no doctor to a panel");
    assert.deepEqual(
      [panelled.green, panelled.yellow, panelled.red],
      [panelledBefore.green, panelledBefore.yellow, panelledBefore.red],
      "campaign changes no traffic light",
    );
    assert.equal(panelled.campaignCalls, 1, "a rep who did both carries one row, not two");
    assert.equal(panelled.hasPanel, true);
    assert.equal(after.totals.coveragePct, before.totals.coveragePct, "the headline percentage is untouched");
    assert.equal(after.totals.activePanel, before.totals.activePanel, "the panel is untouched");
    assert.equal(after.totals.visitsCounted, before.totals.visitsCounted, "a campaign call is not a counted visit");
    assert.equal(after.totals.ungradedContacts, before.totals.ungradedContacts, "contact 0 is a sentinel, not an ungraded doctor to chase");

    assert.equal(after.totals.campaignCalls, 5, "1 + 3 + 1 across the three reps, selected month only");
    assert.equal(after.totals.repsAllCampaign, 2, "two of the four reps have no graded panel");
    assert.equal(before.totals.campaignCalls, 0, "no campaign argument means an empty column, not a crash");
    assert.equal(before.totals.repsAllCampaign, 0);

    // Ranking. Worst-first is the point of this board, and 0% means "bad" only when there was
    // something to score — so a rep with no panel sorts BELOW even a rep at 100%.
    assert.deepEqual(
      after.reps.map((rep) => rep.repKey),
      ["hr:m-2", "hr:m-1", "hr:m-9", "crm:777"],
      "graded reps worst-first, then the panel-less ones by name — a 0% with no panel must never head the list",
    );
  }

  // ── Source contracts for the campaign leg ────────────────────────────────────────────────────
  assert.match(
    serviceSource,
    /visitTypes:\s*\[CAMPAIGN_TYPE\]/,
    "campaign must be a SECOND narrow read, not a widening of the first — [0, CAMPAIGN_TYPE] would drag campaign rows across the whole six-month scan window (25,041 extra rows against 76,554, measured on production 2026-08-27) purely to discard them in the graded loop",
  );
  assert.match(
    serviceSource,
    /dateFrom: `\$\{month\}-01`/,
    "the campaign read covers the SELECTED month only — the graded read starts six months earlier because coverage needs a lapse window, and campaign has no such window",
  );

  const tablesSource = readFileSync("src/components/crm/doctor-coverage-tables.tsx", "utf8");
  assert.match(
    tablesSource,
    /row\.hasPanel \?/,
    "the table must branch on hasPanel — a rep with no graded panel gets a marker, never a 0% meter that reads as a real score",
  );
  assert.match(tablesSource, /campaignCalls/, "campaign needs its own column, sortable, beside coverage and never inside it");

  const boardSource = readFileSync("src/components/crm/doctor-coverage-board.tsx", "utf8");
  assert.match(boardSource, /label="Campaign calls"/, "the summary strip must carry campaign as its own tile");
  assert.match(boardSource, /repsAllCampaign/, "the tile must name how many reps are campaign-only — that count is the thing the board used to hide");

  // ── Source contracts for the assigned-list denominator ───────────────────────────────────────
  assert.match(
    serviceSource,
    /CRM_PLAN_ENTRIES_TABLE|scanPlanEntries/,
    "the denominator must come from the plan mirror — inferring it from visit history is the defect this board was rebuilt to remove",
  );
  assert.match(
    serviceSource,
    /planRows: readonly DoctorCoveragePlanInput\[\]/,
    "planRows must be REQUIRED and have no default: an absent list has to produce an explicit 'no list', never a quiet fall back to inferring one (the same optional-argument mistake that left `scope` company-wide)",
  );
  assert.doesNotMatch(
    serviceSource,
    /primary\?\.repKey/,
    "the primary-rep election must be gone — it is what let one rep's visits turn a colleague's doctor green, 24.5% of scored pairs on production",
  );
  assert.match(
    serviceSource,
    /agent_crm_id/,
    "the plan read must be scoped on the CRM id: agent_hr_id is null on up to 27.9% of a month's plan rows, so filtering on it silently drops a quarter of the lists",
  );
  assert.match(
    boardSource,
    /label="Assigned panel"/,
    "the panel tile must say ASSIGNED — 'Active panel' described the old inferred number and is what made a panel of 2 look like a real one",
  );
  assert.match(boardSource, /offListDoctors/, "off-list work must be reported beside coverage, never folded into it and never hidden");
  assert.match(boardSource, /planMonthMissing/, "a month with no lists at all must say so rather than print every rep at 0%");
}
