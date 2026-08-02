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
  assert.match(serviceSource, /scanVisitsForRange/, "multi-month reads must use the keyset scanner");
  assert.match(serviceSource, /collapseDuplicateVisitSubmissions/, "counts must agree with DV/FWC via the canonical collapse");
  assert.match(serviceSource, /visit\.visit_type !== 0/, "the board is regular-customer-visits-only by contract");
  assert.doesNotMatch(
    serviceSource,
    /new Date\([^)]*visit|toISOString\(\)/,
    "CRM date strings are Cairo wall-clock — Date parsing would shift them (same rule as sfe-field-analytics)",
  );

  // ── Page gates: admin twin carries SFE+Super Admin (never NSM — portal-mode roles cannot reach
  // (admin)); the portal twin is NSM's, fail-closed inside the portal shell ─────────────────────
  const adminPage = readFileSync("app/(admin)/admin/doctor-coverage/page.tsx", "utf8");
  assert.match(adminPage, /"SFE Manager"/);
  assert.match(adminPage, /"Super Admin"/);
  assert.match(adminPage, /redirect\(/, "the admin page must fail closed with a redirect");
  assert.doesNotMatch(adminPage, /"National Sales Manager"/, "NSM on the admin page would be dead code — the (admin) layout redirects portal-mode roles first");
  const portalPage = readFileSync("app/employee-portals/doctor-coverage/page.tsx", "utf8");
  assert.match(portalPage, /"National Sales Manager"/);
  assert.match(portalPage, /EmployeePortalPageShell/, "the NSM twin must render inside the portal shell");
}
