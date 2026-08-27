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

  // ── Status classification ────────────────────────────────────────────────────────────────────
  const board = buildDoctorCoverageBoard(
    [
      // Doctor 1 (A): exactly 2 visits in August → green.
      visit({ contact_crm_id: 1, contact_name: "Dr. Green", visit_date: "2026-08-03" }),
      visit({ contact_crm_id: 1, contact_name: "Dr. Green", visit_date: "2026-08-20" }),
      // Doctor 2 (A): 1 of 2 → yellow.
      visit({ contact_crm_id: 2, contact_name: "Dr. Yellow", visit_date: "2026-08-10" }),
      // Doctor 3 (A): 0 this month, seen in July → red (lapsed).
      visit({ contact_crm_id: 3, contact_name: "Dr. RedJuly", visit_date: "2026-07-15" }),
      // Doctor 4 (B): 0 this month, seen in June (2 months back) → red.
      visit({ contact_crm_id: 4, contact_name: "Dr. RedJune", crm_contact_grade: "B", visit_date: "2026-06-12" }),
      // Doctor 5 (A): seen ONLY in May (3 months back) → inactive, absent from panel entirely.
      visit({ contact_crm_id: 5, contact_name: "Dr. Ancient", visit_date: "2026-05-09" }),
      // Doctor 6 (B): 1 visit → green at B target.
      visit({ contact_crm_id: 6, contact_name: "Dr. BGreen", crm_contact_grade: "B", visit_date: "2026-08-14" }),
      // Ungraded contact visited this month → excluded from panel, counted separately.
      visit({ contact_crm_id: 7, contact_name: "Dr. NoGrade", crm_contact_grade: null, visit_date: "2026-08-11" }),
      // Sentinel and null contacts, and a campaign row with a grade — all ignored.
      visit({ contact_crm_id: 0, visit_date: "2026-08-04" }),
      visit({ contact_crm_id: null, visit_date: "2026-08-04" }),
      visit({ contact_crm_id: 8, visit_date: "2026-08-04", visit_type: -8 }),
      // Null visit_date row — skipped, never crashes bucketing.
      visit({ contact_crm_id: 9, visit_date: null }),
    ],
    MONTH,
  );

  const byId = new Map(board.doctors.map((doctor) => [doctor.contactCrmId, doctor]));
  assert.equal(byId.get(1)?.status, "green", "A-doctor with exactly target visits is green");
  assert.equal(byId.get(2)?.status, "yellow", "A-doctor one visit short is yellow, not red");
  assert.equal(byId.get(3)?.status, "red", "zero visits this month but seen last month = lapsed red");
  assert.equal(byId.get(4)?.status, "red", "seen two months back still counts as lapsed");
  assert.equal(byId.has(5), false, "a doctor last seen 3 months back is inactive — out of panel AND denominator");
  assert.equal(byId.get(6)?.status, "green", "B-doctor meets the B target with 1 visit");
  assert.equal(byId.has(7), false, "ungraded contacts never enter the graded panel");
  assert.equal(board.totals.ungradedContacts, 1, "ungraded-but-visited contacts are surfaced, not silently dropped");
  assert.equal(byId.has(8), false, "campaign rows (visit_type -8) never feed coverage even when graded");

  assert.equal(board.totals.activePanel, 5, "panel = green+yellow+red doctors only");
  assert.equal(board.totals.green, 2);
  assert.equal(board.totals.yellow, 1);
  assert.equal(board.totals.red, 2);
  assert.equal(board.totals.coveragePct, Math.round((2 / 5) * 100), "coverage % = green / active panel");
  const repTotals = board.reps.reduce(
    (sum, rep) => ({ green: sum.green + rep.green, panel: sum.panel + rep.panelSize }),
    { green: 0, panel: 0 },
  );
  assert.equal(repTotals.panel, board.totals.activePanel, "rep rows must sum exactly to the company panel");
  assert.equal(repTotals.green, board.totals.green, "rep green counts must sum exactly to the company green");

  // ── Month-boundary bucketing: 07-31 vs 08-01 are different months ────────────────────────────
  const boundary = buildDoctorCoverageBoard(
    [
      visit({ contact_crm_id: 11, contact_name: "Dr. Boundary", visit_date: "2026-07-31" }),
      visit({ contact_crm_id: 12, contact_name: "Dr. August", visit_date: "2026-08-01" }),
    ],
    MONTH,
  );
  const boundaryById = new Map(boundary.doctors.map((doctor) => [doctor.contactCrmId, doctor]));
  assert.equal(boundaryById.get(11)?.status, "red", "a July 31 visit is prior-month evidence when August is selected");
  assert.equal(boundaryById.get(11)?.visitsThisMonth, 0);
  assert.equal(boundaryById.get(12)?.visitsThisMonth, 1, "an August 1 visit buckets into August");

  // ── Latest grade wins across the window ──────────────────────────────────────────────────────
  const regraded = buildDoctorCoverageBoard(
    [
      visit({ contact_crm_id: 21, contact_name: "Dr. Upgraded", crm_contact_grade: "B", visit_date: "2026-07-02" }),
      visit({ contact_crm_id: 21, contact_name: "Dr. Upgraded", crm_contact_grade: "A", visit_date: "2026-08-06" }),
    ],
    MONTH,
  );
  assert.equal(regraded.doctors[0]?.gradeTier, "A", "the latest non-null grade in the window wins");
  assert.equal(regraded.doctors[0]?.targetVisits, 2, "target follows the latest grade");
  assert.equal(regraded.doctors[0]?.status, "yellow", "1 of 2 at the upgraded target");

  // A+ folds into tier A on the board too.
  const plusBoard = buildDoctorCoverageBoard(
    [visit({ contact_crm_id: 22, contact_name: "Dr. Plus", crm_contact_grade: "A+", visit_date: "2026-08-02" })],
    MONTH,
  );
  assert.equal(plusBoard.doctors[0]?.gradeTier, "A");
  assert.equal(plusBoard.doctors[0]?.gradeRaw, "A+", "raw grade is preserved for display");

  // ── Primary-rep assignment: most visits wins; doubles never double-count a doctor ────────────
  const shared = buildDoctorCoverageBoard(
    [
      visit({ agent_crm_id: 100, agent_hr_id: "M-1", agent_name: "Rep One", contact_crm_id: 31, visit_date: "2026-08-03" }),
      visit({ agent_crm_id: 100, agent_hr_id: "M-1", agent_name: "Rep One", contact_crm_id: 31, visit_date: "2026-08-15" }),
      visit({ agent_crm_id: 200, agent_hr_id: "M-2", agent_name: "Rep Two", contact_crm_id: 31, visit_date: "2026-08-20" }),
    ],
    MONTH,
  );
  assert.equal(shared.doctors.length, 1, "one doctor visited by two reps is one panel row, never two");
  assert.equal(shared.doctors[0]?.repKey, "hr:m-1", "the rep with the most window visits is primary");
  assert.equal(shared.doctors[0]?.visitsThisMonth, 3, "all reps' visits count toward the doctor's frequency");
  assert.equal(shared.doctors[0]?.status, "green");

  const tied = buildDoctorCoverageBoard(
    [
      visit({ agent_crm_id: 100, agent_hr_id: "M-1", agent_name: "Rep One", contact_crm_id: 32, visit_date: "2026-08-03" }),
      visit({ agent_crm_id: 200, agent_hr_id: "M-2", agent_name: "Rep Two", contact_crm_id: 32, visit_date: "2026-08-19" }),
    ],
    MONTH,
  );
  assert.equal(tied.doctors[0]?.repKey, "hr:m-2", "a visit-count tie breaks to the latest visit");

  const unmapped = buildDoctorCoverageBoard(
    [visit({ agent_crm_id: 777, agent_hr_id: null, agent_name: null, contact_crm_id: 33, visit_date: "2026-08-03" })],
    MONTH,
  );
  assert.equal(unmapped.doctors[0]?.repKey, "crm:777", "an unmapped agent keys by crm id");
  assert.equal(unmapped.doctors[0]?.repName, "Unmapped agent");
  assert.equal(unmapped.reps[0]?.agentHrId, null);

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
    const before = buildDoctorCoverageBoard(graded, MONTH);

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
    const after = buildDoctorCoverageBoard(graded, MONTH, { campaignVisits: campaign });

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
}
