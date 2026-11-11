/**
 * Doctor Coverage & Frequency — the SFE board answering "which doctors are properly covered,
 * which are slipping, and which have we lost" per rep and company-wide.
 *
 * Scope rules (all deliberate, all surfaced on the card):
 *  - visit_type === 0 (Regular customer visits) ONLY for everything graded — grade/speciality are
 *    NULL on every other type, and contact_crm_id on non-regular types is a shared vendor sentinel,
 *    not a real person. CAMPAIGN work (type -8) is read too, but ONLY as its own per-rep column;
 *    it can never enter the panel, the denominator or the coverage percentage. Owner's ruling
 *    2026-08-27, "count it separately" — the same answer he gave Rep Doctor Lists on 2026-08-21.
 *    What that ruling fixes here is an ABSENCE, not a wrong number: see the campaign fold-in.
 *  - contact_crm_id must be truthy (0 is the vendor's "unspecified contact" sentinel).
 *  - Duplicate submissions are collapsed via the canonical read-door collapse, so counts agree
 *    with DV Analytics / FWC.
 *  - Departed agents are excluded for free by the reads door (scanVisitsForRange).
 *  - Grading history: this note used to say the vendor only began sending contactGrade on
 *    2026-07-24, so months before 2026-07 were "near-empty by construction". That is no longer
 *    true and the board must not imply it — checked against production 2026-08-08, graded type-0
 *    visits run back to 2026-01-01, with 72,721 graded rows dated before 2026-07-24 and every month
 *    March–August 99.9–100% graded. The vendor backfilled. An empty panel now means a genuinely
 *    empty month in scope, not a missing feed, and the board says so.
 *
 * ── THE PANEL IS THE REP'S ASSIGNED LIST (changed 2026-08-27) ────────────────────────────────────
 *
 * The denominator is `ireports360_plan_entries` — the doctors the rep was actually GIVEN for the
 * month — joined to his own visits. It is NOT derived from visit history any more.
 *
 * WHY. The owner states the business rule plainly: every medical rep carries 90 to 120 doctors.
 * The old panel was inferred ("whoever this rep happened to touch in the last three months"), so
 * the denominator was a by-product of the data rather than a fact about the rep. Measured on
 * production for August 2026, under the live config: 95 reps, panel sizes from 1 to 265, median 98
 * — only 45 of 95 landed inside 90-120, 15 sat below 50, and 14 above 120. Two consequences, both
 * of which managers reported as "this board is showing wrong data":
 *
 *   - A doctor never visited did not exist. 1,347 of 9,163 assigned rep-doctor pairs (14.7%) had no
 *     row anywhere, so neglecting a doctor REMOVED him from the denominator instead of scoring him
 *     red. The metric could not see its own subject.
 *   - "Primary rep" reassigned doctors between people. A doctor went to whoever visited most over a
 *     4-month window, so covering for a colleague twice moved that doctor onto your panel and off
 *     his: 1,670 of 7,295 scored pairs (22.9%) were doctors NOT on that rep's list.
 *
 * The score tracked the panel error rather than the rep's work — reps whose inferred panel happened
 * to land in 90-120 averaged 52.6% coverage while every other band averaged 33.9-37.4%, and one rep
 * on an inferred panel of ~24 printed a meaningless 100%.
 *
 * WHAT IS UNCHANGED. The grade norms, the three colours, the call list and its ordering, the pace
 * bar, the mixes, the campaign column and the scope rules all behave exactly as before. Only the
 * denominator moved.
 *
 * Coverage norms (owner-confirmed 2026-08-02, editable since 2026-08-09): A-grade (A+ folds into A)
 * doctors need 2 visits in the month to count covered; B and C need 1. Against an assigned list the
 * three statuses become simple and total: green = met the norm, yellow = visited but short, red =
 * on the list and not visited at all this month. There is no "lapsed vs inactive" distinction any
 * more — that pair only existed to guess whether an inferred doctor still belonged to the rep, and
 * an assigned list answers that directly.
 *
 * VISITS ARE COUNTED PER (REP, DOCTOR) PAIR, not per doctor. If Hana is assigned Dr Samy and a
 * colleague visits him, Hana has still not done her job, so that visit cannot turn her row green.
 * This is the same rule Rep Doctor Lists uses and it is what removes the cross-rep bleed above.
 *
 * WORK OFF THE LIST IS REPORTED, NEVER SCORED, NEVER HIDDEN. A type-0 visit to somebody not on the
 * rep's list is real work that the assigned-list denominator has no room for, so it gets its own
 * count beside coverage — exactly the treatment campaign work gets. Silently dropping it would be
 * its own defect.
 *
 * THE PLAN MIRROR STARTS 2026-01. Verified on production 2026-08-27: January-August 2026, every
 * month present, 78-84 reps, and grade and speciality filled on 100% of rows — so the grade comes
 * off the list itself. A month with no list rows is reported as exactly that (`planMonthMissing`)
 * rather than rendered as an innocent empty board.
 *
 * DATE DISCIPLINE (same test-enforced rule as sfe-field-analytics.ts): CRM date strings are Cairo
 * wall-clock and `visit_date` is a plain YYYY-MM-DD — all month math here is string arithmetic,
 * never Date-object parsing or ISO re-serialization (either would shift the wall-clock).
 */

import { CAMPAIGN_TYPE } from "@/lib/crm/visit-types";
import { collapseDuplicateVisitSubmissions, getEffectiveExcludedAgentCrmIds, queryVisits } from "@/lib/crm/reads";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { scanPlanEntries } from "@/lib/crm/rep-doctor-lists";
import { crmTerritoryFrom } from "@/lib/crm/rep-name";
import { cairoTodayIso } from "@/lib/crm/dates";
import { classifyCrmContactSpeciality, type CrmContactKind } from "@/lib/crm/contact-taxonomy";
import {
  DEFAULT_DOCTOR_COVERAGE_NORMS,
  getDoctorCoverageConfig,
  type DoctorCoverageGradeTier,
  type DoctorCoverageNorms,
} from "@/lib/crm/doctor-coverage-config";
import type { DoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";

/** Editable coverage norms: required type-0 visits per month, by grade tier. A+ folds into A. */
/**
 * The DEFAULT doctor norms. No longer the live rule: since 2026-08-09 the effective norms come from
 * `doctor_coverage_config` and are editable per kind and grade in the admin panel
 * (crm/doctor-coverage-config.ts). Kept as the documented fallback, and because it is what the
 * board falls back to before the config row exists.
 */
export const DOCTOR_COVERAGE_TARGETS: Record<DoctorCoverageGradeTier, number> = DEFAULT_DOCTOR_COVERAGE_NORMS.sp;
/** Selected month plus this many prior months form the board and its trend line — 4 points. Each
 * trend point is scored against THAT month's own assigned list, never the selected month's, because
 * a list changes between months and re-using one would invent history. */
export const DOCTOR_COVERAGE_MONTHS_BACK = 3;
/**
 * Extra months of VISIT history read behind the trend window.
 *
 * This no longer decides panel membership — the assigned list does that. It survives for one job:
 * answering "when was this doctor last seen" on the call list. A doctor on the list who was last
 * visited five months ago and one who has never been visited are different coaching problems, and
 * history that was never scanned reads identically to never-visited.
 */
// Renamed from DOCTOR_COVERAGE_LAPSE_LOOKBACK_MONTHS on 2026-08-27. The number is unchanged; the
// old name described a lapse test that no longer exists, and a constant whose name states a rule
// the code stopped following is how a tired session re-derives the wrong model of the board.
export const DOCTOR_COVERAGE_HISTORY_MONTHS_BACK = 2;
/** Total depth of the visit read: the trend window plus the history above. */
export const DOCTOR_COVERAGE_SCAN_MONTHS_BACK = DOCTOR_COVERAGE_MONTHS_BACK + DOCTOR_COVERAGE_HISTORY_MONTHS_BACK;
/** First month the iReports360 plan mirror holds any assigned list. Verified on production
 * 2026-08-27 — January 2026 is the earliest `plan_date` in the table. A selected month before this
 * has no list to score, which the board reports rather than rendering as an empty panel. */
export const DOCTOR_COVERAGE_PLAN_FIRST_MONTH = "2026-01";
// SPECIALTY_MIX_TOP_N removed 2026-08-08. It capped the mix at 8 named values and folded the rest
// into "Other" — a bucket defined by RANK, not by meaning, so it held different things for every
// viewer and hid ~780 real physicians company-wide. Both mixes are complete now; see `mixFor`.
/** How many doctors the prioritised call list names. The full panel stays available in the table
 * below it; this is the "who do I send someone to next" answer, and a list nobody can act on in a
 * week is not one. `callListTotal` always reports the true count so the cap is never silent. */
export const DOCTOR_COVERAGE_CALL_LIST_SIZE = 50;
/** Coverage % that counts as healthy over a WHOLE month. Pro-rated by elapsed days for the current
 * month — see `resolveCoveragePace`. Below `..._GOOD` but at or above `..._FAIR` reads amber. */
const COVERAGE_TONE_GOOD_PCT = 80;
const COVERAGE_TONE_FAIR_PCT = 50;

export type { DoctorCoverageGradeTier } from "@/lib/crm/doctor-coverage-config";
export type DoctorCoverageStatus = "green" | "yellow" | "red";

export type DoctorCoverageDoctorRow = {
  contactCrmId: number;
  /** Human name, never a raw id (owner rule). Taken from the assigned list, which carries one on
   * every row, and falling back to the latest visit only if the list row somehow has none. */
  contactName: string;
  gradeRaw: string;
  gradeTier: DoctorCoverageGradeTier;
  /**
   * Latest type-0 visit BY THIS REP to this doctor, on or before the month end, YYYY-MM-DD.
   *
   * This rep's own visit, not any rep's. A colleague's visit does not discharge this rep's
   * assignment, so showing a colleague's date here would read as "recently handled" on a row that
   * is in fact untouched — the same cross-rep bleed the assigned-list panel exists to remove.
   * Null means this rep has not visited them within the read window at all.
   */
  lastVisitDate: string | null;
  /** SP (a doctor), HCP (a pharmacy/hospital/contract/insurance account), or unclassified when the
   * vendor sent a value this build has never seen. See crm/contact-taxonomy.ts. */
  kind: CrmContactKind;
  repKey: string;
  repName: string;
  speciality: string | null;
  status: DoctorCoverageStatus;
  targetVisits: number;
  visitsThisMonth: number;
};

export type DoctorCoverageRepRow = {
  aDoctors: number;
  agentHrId: string | null;
  bDoctors: number;
  cDoctors: number;
  /** Campaign calls (visit type -8) logged in the SELECTED month. Counted beside coverage and never
   * inside it: a campaign row proves the rep worked but names no doctor, so there is nothing to
   * grade. Owner's ruling 2026-08-27. */
  campaignCalls: number;
  /** 0-100; 0 when the panel is empty. Check {@link hasPanel} before showing it as a score — a rep
   * with no assigned list is not a 0% performer, and rendering one as 0% is the bug this replaced. */
  coveragePct: number;
  green: number;
  /** False when this rep has NO assigned list for the month and appears only because of visits he
   * made or campaign work he logged. The table must print a marker instead of a percentage for
   * them: with no list there is nothing for a percentage to be OF. Measured on the rendered board
   * for August 2026: 18 rows had no list at all — but 14 of those were MANAGERS, who never have a
   * personal list, and now hold a district row instead. Four reps remain, all campaign-only. */
  hasPanel: boolean;
  /**
   * Type-0 visits this rep made to doctors who are NOT on his assigned list. Real work, reported
   * beside coverage and never inside it — the same treatment campaign work gets, and for the same
   * reason: the assigned-list denominator has no room for it, and dropping it silently would hide
   * activity a manager needs to see. Measured on the rendered board for August 2026: 593 off-list
   * pairs beside an assigned panel of 6,416 — under the old panel 1,670 of 7,295 scored pairs
   * (22.9%) were doctors not on that rep's list, every one of them counted as coverage.
   */
  offListDoctors: number;
  /** Doctors on the assigned list — 90 to 120 for a correctly loaded rep (the owner's rule). */
  panelSize: number;
  red: number;
  repKey: string;
  repName: string;
  yellow: number;
};

/**
 * One row of the org tree, as this board needs it. Supplied by the caller from the employee
 * directory; the pure core never reads a database.
 *
 * The board classifies a manager STRUCTURALLY — "does anyone report to me" — and never by title.
 * That is deliberate: job titles in this directory are free text and are misspelt often enough that
 * a title match already hides 9 of 27 District Managers from search. `title` is carried for DISPLAY
 * only, so a district row can say what kind of manager it belongs to.
 */
export type DoctorCoverageOrgNode = {
  /** Lower-cased hr id of this employee's manager, or null at the top of the tree. Lower-cased
   * because it is compared against the hr id inside a `hr:` repKey, which is built that way. */
  managerHrId: string | null;
  /** Job title exactly as the directory spells it. Display only, and never used to classify
   * MANAGERSHIP — that stays structural (see the walk below) because free text hid 9 of 27 District
   * Sales Managers from a title search before. It IS read once, narrowly, to spot a Product
   * Manager: a staff/brand role that (like a manager) holds no personal doctor list by design, but
   * has no reports to walk, so title is the only signal that exists at all. See
   * `productManagerKeys` below. */
  title: string | null;
};

/**
 * One manager's district — the row the OWNER asked for on 2026-08-27, in his own words:
 *
 *   "the concept of CRM that the district manager doesn't have a list. The list of the district
 *    manager is the list of his teams. For example, I have four in my team and four everyone have
 *    hundred, then I am district manager. My list is for hundred… as she isn't submitting visits
 *    by her hand."
 *
 * So a manager is NOT scored against a personal list, because he does not have one. He is scored
 * against the union of his team's assigned lists, and his coverage is what his team covered. Every
 * number here is a plain sum of the rep rows beneath him, at any depth — there is no second scoring
 * pass, which is what makes a district row reconcile with the reps inside it by construction.
 *
 * WHAT THIS FIXES. Before it, every District Sales Manager and the one acting DM appeared in the
 * rep table with no list and no percentage, indistinguishable from a newly hired rep whose list had
 * not loaded yet. Measured on production for August 2026 by building the same board twice, with the
 * org tree and without it: 86 rep rows became 72, "reps with no list" fell from 18 to 4, and every
 * company tile was identical to the digit — 6,416 assigned, 3,632 covered, 57%, 1,700 campaign
 * calls, 593 off-list. Nothing moved except who the rows belong to.
 */
export type DoctorCoverageManagerRow = {
  aDoctors: number;
  bDoctors: number;
  cDoctors: number;
  /** Campaign calls across the district, including the manager's own. */
  campaignCalls: number;
  /** 0-100 of the team's combined list. Check {@link hasPanel} first — a district whose reps all
   * lack a list is not a 0% district. */
  coveragePct: number;
  green: number;
  /** False when not one rep beneath this manager holds an assigned list this month. */
  hasPanel: boolean;
  /** Lower-cased canonical hr id — the same spelling a `hr:` repKey carries. */
  hrId: string;
  /**
   * True when no OTHER manager row sits beneath this one — i.e. this row's team is reps, not
   * districts. Structural, so it stays correct if the org gains or loses a layer. The National
   * Sales Managers and the Regional Manager come back false and belong in a second, smaller group:
   * their rows are real, but they are regions rather than districts. The CEO is NOT among them —
   * the top of the tree is the company, and it gets no manager row at all (see the walk).
   */
  isDistrict: boolean;
  /** repKey-shaped (`hr:<id>`), so a district can travel in a URL exactly like a rep does. */
  managerKey: string;
  managerName: string;
  offListDoctors: number;
  /** The union of the team's assigned lists — the district's panel. */
  panelSize: number;
  red: number;
  /** How many reps beneath him hold no assigned list this month. Counts the TEAM only: a manager
   * having no list of his own is the normal case here, not a gap. */
  repsWithNoList: number;
  /** The rep rows rolled into this row, managers and the manager himself excluded — what the table
   * expands to. A manager who holds a list of his own also keeps his rep row and is scored on it
   * there; his numbers are still summed into this row, so `teamRepKeys` can be one short of what
   * the sums cover. No District Manager was in that position in August 2026. */
  teamRepKeys: string[];
  /** `teamRepKeys.length`, carried so the UI never has to explain a length as a count. */
  teamSize: number;
  /** Job title from the directory, for display beside the name. */
  title: string | null;
  yellow: number;
};

/** One doctor on the prioritised call list — the module's actual output for a manager or rep. */
export type DoctorCoverageCallListRow = {
  contactCrmId: number;
  contactName: string;
  gradeTier: DoctorCoverageGradeTier;
  /** Latest type-0 visit on or before the month end, YYYY-MM-DD. Null = not seen in the window. */
  lastVisitDate: string | null;
  repKey: string;
  repName: string;
  speciality: string | null;
  /** Visits still owed this month to reach the grade's norm. Always ≥ 1 on this list. */
  visitsNeeded: number;
  visitsThisMonth: number;
};

/**
 * How far through the month we are, and what "good" looks like TODAY rather than at month end.
 *
 * The board used to compare a month-to-date coverage % against the whole-month bar and colour the
 * headline tile rose below 50%. On 2026-08-08 — 8 days into a 31-day month — that rendered a red
 * "13.7%" with 6,965 doctors flagged, which is what a perfectly on-pace team also looks like on
 * day 8. A metric that reads catastrophic for the first three weeks of every month teaches people
 * to ignore it, so the bar is pro-rated by elapsed days. A CLOSED month has elapsedFraction 1 and
 * therefore keeps exactly the original 80/50 thresholds.
 */
export type DoctorCoveragePace = {
  /** Calendar days left in the selected month; 0 once it has closed. */
  daysRemaining: number;
  /** 0–1. Fraction of the selected month elapsed in Cairo wall-clock; 1 for any closed month. */
  elapsedFraction: number;
  /** Coverage % an on-pace team would show by today. 100 for a closed month. */
  expectedCoveragePct: number;
  /** Pace-adjusted tone for the headline coverage tile. Lives here, not in the component, so the
   * admin and portal twins can never disagree about what counts as healthy. */
  tone: "emerald" | "amber" | "rose";
};

/**
 * Board filters. Applied to the CLASSIFIED doctor rows, after scope and after the panel rule, so a
 * filter can only ever narrow what the viewer was already entitled to see — it can never widen it.
 * Carried in the URL so every change re-runs the server-side access gate (same posture as the month
 * picker), rather than filtering an already-delivered payload in the browser.
 */
export type DoctorCoverageFilters = {
  /** Grade tier, e.g. "A". Empty/absent = all. */
  grade?: string;
  /** Contact kind, "sp" | "hcp". Empty/absent = all. */
  kind?: string;
  /** `repKey` of a single rep. Empty/absent = all reps in scope. */
  repKey?: string;
  /**
   * Territory restriction from the Region → Line → Area cascade, as the set of `repKey`s those
   * levels resolve to. Absent = no territory filter; an EMPTY array means the territory resolved to
   * nobody and must therefore keep nobody — never treat empty as "no filter", or narrowing to a
   * vacant patch would silently widen the board back to everything.
   */
  repKeys?: string[];
  /** "green" | "yellow" | "red". Empty/absent = all. */
  status?: string;
  /** Free text over doctor name, specialty and rep name. */
  search?: string;
};

/** Which filters are actually in force — surfaced so the board can say so on screen. */
export type DoctorCoverageAppliedFilters = {
  active: boolean;
  grade: string | null;
  kind: string | null;
  repKey: string | null;
  /** How many reps the territory cascade resolved to, or null when no territory filter is set. */
  repKeyCount: number | null;
  search: string | null;
  status: string | null;
};

export type SfeDoctorCoverageBoard = {
  /** Prioritised "go see these next", A-grade and longest-neglected first. Capped at
   * {@link DOCTOR_COVERAGE_CALL_LIST_SIZE}; `callListTotal` reports the uncapped count. */
  callList: DoctorCoverageCallListRow[];
  callListTotal: number;
  doctors: DoctorCoverageDoctorRow[];
  gradeSplit: Array<{ covered: number; doctors: number; tier: DoctorCoverageGradeTier }>;
  /** True → the selected month is still running (render "month to date"). */
  isCurrentMonth: boolean;
  month: string;
  monthLabel: string;
  /** HCP accounts — pharmacies, hospitals, contracts, insurance — counted separately from doctors.
   * Same shape as `specialtyMix`; both are complete (no rank-based "Other" bucket). */
  accountMix: Array<{ doctors: number; label: string }>;
  /** What the viewer filtered to, echoed back so the UI can show it and offer a clear-all. */
  appliedFilters: DoctorCoverageAppliedFilters;
  /** Every rep in scope, for the rep filter dropdown — NOT narrowed by the current filters, so
   * picking one rep does not remove the others from the picker. */
  repOptions: Array<{ repKey: string; repName: string }>;
  /** Districts and the levels above them — one row per manager with at least one rep beneath.
   * A manager's panel is his team's combined list; see {@link DoctorCoverageManagerRow}. Empty
   * when the caller supplies no org tree, which keeps every existing fixture behaving as before. */
  managers: DoctorCoverageManagerRow[];
  pace: DoctorCoveragePace;
  reps: DoctorCoverageRepRow[];
  /** Human-readable description of whose data this is ("District Manager · own team"). Empty for
   * the pure-core/fixture path, which has no viewer. */
  scopeLabel: string;
  specialtyMix: Array<{ doctors: number; label: string }>;
  totals: {
    activePanel: number;
    coveragePct: number;
    green: number;
    red: number;
    /** Campaign calls across every rep in scope, selected month. Never part of `coveragePct`. */
    campaignCalls: number;
    /** Reps whose ONLY logged field work this month is campaign — they have no assigned list and no
     * visits. Before 2026-08-27 they had no row on this board whatsoever; 15 people in August 2026. */
    repsAllCampaign: number;
    /** Contacts on an assigned list whose grade is absent or unrecognised — outside the panel,
     * surfaced so a vendor grading gap is visible instead of silently shrinking the denominator.
     * Production carries a grade on 100% of plan rows for 2026-01..2026-08, so this should read 0;
     * a non-zero value is a real signal about the feed, not noise. */
    ungradedContacts: number;
    /** Type-0 visits in scope this month to doctors on nobody's assigned list, summed. Reported,
     * never scored. */
    offListDoctors: number;
    /** Reps with activity this month but NO assigned list at all — a loading gap in the plan feed,
     * not a performance result. They are shown with a marker, never as 0%. */
    repsWithNoList: number;
    /** True when the selected month has no assigned list rows whatsoever. The board must say the
     * list is missing rather than render an empty panel, which reads as "nobody was assigned
     * anything" — the exact silent-empty failure this module keeps having to design against.
     * The plan mirror begins {@link DOCTOR_COVERAGE_PLAN_FIRST_MONTH}. */
    planMonthMissing: boolean;
    visitsCounted: number;
    yellow: number;
  };
  trend: Array<{ activePanel: number; coveragePct: number; label: string; month: string }>;
  windowFrom: string;
  windowTo: string;
};

/** Exact row shape the pure core consumes — also the test-fixture shape. Includes the two columns
 * the duplicate collapse keys on even though the aggregation itself ignores them. */
export type DoctorCoverageVisitInput = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  contact_crm_id: number | null;
  contact_name: string | null;
  crm_contact_grade: string | null;
  crm_save_date: string | null;
  crm_visit_id: number | null;
  double_crm_id: number | null;
  speciality: string | null;
  visit_date: string | null;
  visit_type: number | null;
};

/**
 * One row of a rep's ASSIGNED list, from the iReports360 plan mirror — the panel this board scores.
 *
 * Deliberately spelled with the plan table's own column names so this doubles as the fixture shape
 * and a test cannot drift from the real projection. Note `contact_grade`, NOT `crm_contact_grade`:
 * the two mirrors spell the grade column differently, and reading the visits spelling here would
 * yield null on every row — an all-ungraded board, i.e. a silent empty one.
 */
export type DoctorCoveragePlanInput = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  contact_grade: string | null;
  contact_name: string | null;
  plan_date: string | null;
  speciality: string | null;
};

const VISIT_COLUMNS =
  "agent_crm_id, agent_hr_id, agent_name, contact_crm_id, contact_name, crm_contact_grade, crm_save_date, crm_visit_id, double_crm_id, speciality, visit_date, visit_type";

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-07-31" → "2026-07". Callers guarantee a YYYY-MM-DD-shaped string. */
export function monthKeyOfVisitDate(visitDate: string): string {
  return visitDate.slice(0, 7);
}

/** Pure YYYY-MM arithmetic — addMonthsToMonthKey("2026-01", -3) === "2025-10". No Date objects. */
export function addMonthsToMonthKey(monthKey: string, delta: number): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const zeroBased = year * 12 + (month - 1) + delta;
  const outYear = Math.floor(zeroBased / 12);
  const outMonth = (zeroBased % 12) + 1;
  return `${String(outYear).padStart(4, "0")}-${String(outMonth).padStart(2, "0")}`;
}

/** Last day of the month as YYYY-MM-DD — day-count table + Gregorian leap rule, no Date parsing. */
export function lastDayOfMonthKeyIso(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return `${monthKey}-${String(days).padStart(2, "0")}`;
}

/**
 * Elapsed-month pace for the selected month. Pure: `todayIso` is injected so this is testable
 * without freezing the clock, and all arithmetic stays string-based per the module's DATE
 * DISCIPLINE note (no Date parsing, which would shift the Cairo wall-clock).
 *
 * `coveragePct` is the achieved figure; the returned tone compares it against the whole-month bar
 * scaled by how much of the month has actually happened.
 */
export function resolveCoveragePace(input: {
  coveragePct: number;
  selectedMonth: string;
  todayIso: string;
}): DoctorCoveragePace {
  const daysInMonth = Number(lastDayOfMonthKeyIso(input.selectedMonth).slice(8, 10));
  const isCurrentMonth = input.selectedMonth === monthKeyOfVisitDate(input.todayIso);
  // A FUTURE month has no elapsed days at all; a past month is fully elapsed. Clamping to at least
  // one day keeps the tone defined on day 1 instead of dividing the bar down to zero, which would
  // paint every board emerald the moment a month rolls over.
  const daysElapsed = isCurrentMonth
    ? Math.min(daysInMonth, Math.max(1, Number(input.todayIso.slice(8, 10))))
    : input.selectedMonth > monthKeyOfVisitDate(input.todayIso)
      ? 0
      : daysInMonth;
  const elapsedFraction = daysElapsed / daysInMonth;
  const goodBar = COVERAGE_TONE_GOOD_PCT * elapsedFraction;
  const fairBar = COVERAGE_TONE_FAIR_PCT * elapsedFraction;
  // A month that has not started yet has no pace to judge: both bars are 0, and "0% ≥ 0" would
  // paint an empty future board emerald — a false all-clear. Report it as neutral instead.
  const tone: DoctorCoveragePace["tone"] =
    elapsedFraction === 0
      ? "amber"
      : input.coveragePct >= goodBar
        ? "emerald"
        : input.coveragePct >= fairBar
          ? "amber"
          : "rose";
  return {
    daysRemaining: daysInMonth - daysElapsed,
    elapsedFraction,
    expectedCoveragePct: Math.round(COVERAGE_TONE_GOOD_PCT * elapsedFraction),
    tone,
  };
}

/** A valid "YYYY-MM" passes through; anything else falls back to the current Cairo month —
 * same validate-or-default posture as attendance's resolveSummaryMonth. */
export function resolveCoverageMonth(month: string | undefined): string {
  if (month && MONTH_KEY_PATTERN.test(month)) return month;
  return monthKeyOfVisitDate(cairoTodayIso());
}

/** "A+"/"A" → 2, "B"/"C" → 1, anything else (null, blank, unknown code) → null = ungraded. */
export function coverageTargetForGrade(grade: string | null | undefined): number | null {
  const tier = gradeTierOf(grade);
  return tier ? DOCTOR_COVERAGE_TARGETS[tier] : null;
}

function gradeTierOf(grade: string | null | undefined): DoctorCoverageGradeTier | null {
  if (grade === "A+" || grade === "A") return "A";
  if (grade === "B") return "B";
  if (grade === "C") return "C";
  return null;
}

/** "2026-01" -> "January 2026". Exported so the board can label the plan mirror's first month from
 * the constant itself rather than restating it in prose that then drifts. Pure string slicing, no
 * Date parsing — CRM month keys are Cairo wall-clock and Date would shift them. */
export function monthLabelOf(monthKey: string): string {
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  return `${MONTH_NAMES[monthIndex] ?? monthKey} ${monthKey.slice(0, 4)}`;
}

/**
 * Contact-level facts, latest-visit-wins.
 *
 * The assigned list carries name, grade and speciality on 100% of production rows for
 * 2026-01..2026-08, so for a doctor ON a list these are a fallback. They are the only source for an
 * OFF-list doctor, who has no list row by definition.
 */
type ContactAccumulator = {
  contactCrmId: number;
  /** Latest-visit-wins fields, tracked with their visit date (tie → higher crm_visit_id). */
  latestGrade: { date: string; grade: string; visitId: number } | null;
  latestName: { date: string; name: string; visitId: number } | null;
  latestSpeciality: { date: string; speciality: string; visitId: number } | null;
};

/**
 * One (rep, doctor) pair — the unit this board scores.
 *
 * Keyed by pair rather than by doctor because an assignment belongs to ONE rep: a colleague's visit
 * to the same doctor lands in a different pair and therefore cannot turn this rep's row green. That
 * is the whole cross-rep bleed fix; see the PANEL note at the top of the file.
 */
type PairAccumulator = {
  lastVisitDate: string | null;
  /** Whose pair this is. Carried on the row rather than sliced back out of the map key: a key is a
   * lookup token, and reading identity out of one couples every consumer to its exact spelling. */
  repKey: string;
  visitsByMonth: Map<string, number>;
};

/** Stable key for a (rep, doctor) pair. */
function pairKeyOf(repKey: string, contactCrmId: number): string {
  return `${repKey}|${contactCrmId}`;
}

/**
 * The territory the CRM appends to an agent's name, in trailing brackets:
 * `"Aisha.Ehab ( Minia 2 / E )"` -> `"Minia 2 / E"`. Anchored at the END and refusing nested
 * brackets, so a name that legitimately contains parentheses cannot be mistaken for one.
 *
 * The interior is trimmed at its edges only, never rewritten — production carries
 * `"( Mahalla  / A )"` with a double space inside, and that is the vendor's text, not ours to
 * normalise. What is dropped is the vendor's spacing OUTSIDE the brackets.
 */
/**
 * What a rep is CALLED, in one place, for every row this board emits.
 *
 * THE DIRECTORY NAMES THE PERSON; THE CRM NAMES THE TERRITORY (owner's instruction 2026-08-27,
 * "show the real name and keep the territory"). The CRM's `agent_name` is a LOGIN HANDLE with a
 * territory bolted on — `"Aisha.Ehab ( Minia 2 / E )"` — so using it whole broke the standing rule
 * that a human-readable name is always shown, while dropping it whole would have thrown away the
 * territory, which is the part a manager reads to tell two reps apart. So the two halves come from
 * different places: the real name from the employee directory, the bracketed territory from the
 * CRM.
 *
 * Measured on production 2026-08-27 across the four-month read window: of 102 agents with a CRM
 * name, ALL 102 had a directory row — the swap is never blind — and 100 of them changed. Six rows
 * were the pathological case this also fixes: an agent_name that is territory and NOTHING else,
 * `"( Behira 2 / C )"`, which rendered a coverage row belonging to no visible person at all.
 *
 * The waterfall, in order:
 *  1. the employee directory, keyed on hr id, plus the CRM's territory when it carries one;
 *  2. the CRM name unchanged — for a `crm:` agent with no hr id, and for the hr-keyed agent whose
 *     directory row is missing. Production currently has none of the latter, but a name is not the
 *     place to start throwing;
 *  3. the hr id itself, which at least identifies a person, before the last-resort label.
 *
 * "Unmapped agent" is deliberately the end of the line, never a shortcut: the standing rule is that
 * a human-readable name is shown, never a raw code.
 *
 * COST OF THE SWAP, measured the same day: the longest rep label grew from 41 to 70 characters
 * (`"Mohamed Mohamed ElMenshawy Abdelmatty Mohamed Ismail ( Sharkia 3 / C )"`). A label that long
 * used to hold on ONE line inside `PortalDesktopTable`'s `overflow-x-auto`, so the table scrolled
 * sideways rather than wrap — which the fits-the-screen golden rule (AGENTS.md §4) forbids:
 * "wrapping wins" over both an ellipsis and a horizontal scroll. `PortalDesktopTable` is now
 * `table-fixed` with a `<colgroup>`, so a long name simply wraps onto a second line inside its own
 * column and the table never grows wider than `main`.
 */
function repNameFor(
  repKey: string,
  latestRepName: ReadonlyMap<string, { name: string }>,
  repNameByHrId: ReadonlyMap<string, string> | undefined,
  /** A CRM name from outside the graded pass — the campaign fold-in's own, for a rep whose entire
   *  month was campaign work and who therefore appears in `latestRepName` not at all. It supplies
   *  the TERRITORY for such a rep exactly as a graded visit would. */
  crmNameFallback?: string,
): string {
  const fromVisits = latestRepName.get(repKey)?.name?.trim() || crmNameFallback?.trim();
  if (repKey.startsWith("hr:")) {
    const hrId = repKey.slice(3);
    const fromDirectory = repNameByHrId?.get(hrId)?.trim();
    if (fromDirectory) {
      const territory = crmTerritoryFrom(fromVisits);
      return territory ? `${fromDirectory} ( ${territory} )` : fromDirectory;
    }
    if (fromVisits) return fromVisits;
    return hrId.toUpperCase();
  }
  if (fromVisits) return fromVisits;
  return "Unmapped agent";
}

/** One entry of a rep's assigned list for one month, already normalised. */
type AssignedDoctor = {
  contactCrmId: number;
  contactName: string | null;
  gradeRaw: string;
  repKey: string;
  speciality: string | null;
};

function trackLatest<T extends { date: string; visitId: number }>(current: T | null, candidate: T): T {
  if (!current) return candidate;
  if (candidate.date > current.date) return candidate;
  if (candidate.date === current.date && candidate.visitId > current.visitId) return candidate;
  return current;
}

/**
 * Pure aggregation core — no IO, fixture-testable. `visits` must already be duplicate-collapsed;
 * rows that are not regular customer visits (visit_type !== 0), carry the sentinel/absent contact,
 * or have no visit_date are ignored here so fixtures and the IO wrapper share one contract.
 *
 * `options.planRows` is REQUIRED and has no default. An absent list must produce an explicit "no
 * list for this month", never a quiet fall back to inferring one from visit history. This module
 * has already paid for the optional-argument version of this mistake once: `scope` was optional on
 * the IO wrapper below, and that is exactly how every seat ended up reading all 205 agents
 * company-wide. A required argument means a future caller cannot silently reopen the hole.
 */
export function buildDoctorCoverageBoard(
  visits: readonly DoctorCoverageVisitInput[],
  selectedMonth: string,
  options: {
    /** Campaign rows (visit type -8) for the SELECTED month. Deliberately a SEPARATE argument, not
     * mixed into `visits`: the scoring loop below then cannot see them even by accident, so "the
     * coverage number did not move" is true by construction rather than by a `continue`. */
    campaignVisits?: readonly DoctorCoverageVisitInput[];
    filters?: DoctorCoverageFilters;
    norms?: DoctorCoverageNorms;
    /** THE PANEL. Every assigned-list entry whose `plan_date` falls in the trend window. Pass `[]`
     * only to mean "there genuinely is no list", which the board then reports as such. */
    /** Lower-cased hr id -> that employee's place in the org tree. Absent (or empty) means no
     * district rollup at all: every agent stays a rep row, which is exactly how this board behaved
     * before districts existed. Never inferred — an org tree guessed from visit patterns is how a
     * board starts telling people who reports to whom on the strength of a coincidence. */
    orgByHrId?: ReadonlyMap<string, DoctorCoverageOrgNode>;
    planRows: readonly DoctorCoveragePlanInput[];
    /** Canonical hr id (lower-cased, as it appears inside a `hr:` repKey) → the employee's display
     * name. Used only when the CRM itself has never carried a name for that rep — a rep who holds a
     * list but has logged no visit in the whole read window has no CRM name anywhere, and under the
     * old visit-derived panel he could not appear at all, so the gap never arose. */
    repNameByHrId?: ReadonlyMap<string, string>;
    scopeLabel?: string;
    /** The signed-in viewer's own hr id, so the district walk can stop at his seat instead of
     * climbing past it. Absent means "no viewer" — the fixture path, and the company-scoped seats
     * (Super Admin, CEO, SFE Manager, Marketing Manager) who sit outside the sales tree entirely
     * and are meant to see every level of it. */
    viewerHrId?: string | null;
  },
): SfeDoctorCoverageBoard {
  const norms = options.norms ?? DEFAULT_DOCTOR_COVERAGE_NORMS;
  const windowMonths: string[] = [];
  for (let back = DOCTOR_COVERAGE_MONTHS_BACK; back >= 0; back -= 1) {
    windowMonths.push(addMonthsToMonthKey(selectedMonth, -back));
  }
  const historyFrom = addMonthsToMonthKey(selectedMonth, -DOCTOR_COVERAGE_SCAN_MONTHS_BACK);
  const windowFrom = `${windowMonths[0]}-01`;
  const windowTo = lastDayOfMonthKeyIso(selectedMonth);
  const currentCairoMonth = monthKeyOfVisitDate(cairoTodayIso());

  // ── One rep, one key — reconciled across BOTH mirrors before anything is keyed ─────────────────
  //
  // The visits mirror resolves an hr id through the identity waterfall; the plan mirror resolves it
  // crm-id-only and leaves some rows without one — measured on production 2026-08-27, 791 of 18,645
  // August plan rows, covering 8 of 78 agents. Keying each mirror on its own row therefore files the
  // SAME person under `hr:b-124` from his visits and `crm:5512` from his list, so not one of his
  // assignments joins to any of his visits and he reads 0% on a full list.
  //
  // This is not hypothetical. It is the exact artifact that appeared the first time this join was
  // measured in SQL: eleven reps came back with a "real list" of 0 while plainly holding one. Any hr
  // id seen for a crm id, in EITHER mirror, therefore becomes that crm id's canonical key.
  const repKeyByCrmId = new Map<number, string>();
  const learnRepIdentity = (agentHrId: string | null, agentCrmId: number | null) => {
    const hrId = agentHrId?.trim();
    if (!hrId || agentCrmId == null) return;
    const key = `hr:${hrId.toLowerCase()}`;
    const existing = repKeyByCrmId.get(agentCrmId);
    // Two different hr ids on one crm id is a data fault, not a choice. Take the lowest-sorting one
    // so the key is deterministic rather than row-order dependent — a key that moved between renders
    // would present one fault as several.
    if (!existing || key < existing) repKeyByCrmId.set(agentCrmId, key);
  };
  for (const visit of visits) learnRepIdentity(visit.agent_hr_id, visit.agent_crm_id);
  for (const row of options.planRows) learnRepIdentity(row.agent_hr_id, row.agent_crm_id);
  const repKeyFor = (agentHrId: string | null, agentCrmId: number | null): string => {
    if (agentCrmId != null) {
      const canonical = repKeyByCrmId.get(agentCrmId);
      if (canonical) return canonical;
    }
    const hrId = agentHrId?.trim();
    if (hrId) return `hr:${hrId.toLowerCase()}`;
    return `crm:${agentCrmId ?? 0}`;
  };

  const contacts = new Map<number, ContactAccumulator>();
  /** Visits keyed by (rep, doctor) — see {@link PairAccumulator}. */
  const pairs = new Map<string, PairAccumulator>();
  /**
   * The rep's CURRENT display name, keyed by repKey and resolved across the WHOLE window — not per
   * contact.
   *
   * `contact.visitsByRep` tracks a name too, but that one is the name as it stood on *that
   * contact's* last visit, which makes one person appear under two labels on a single board.
   * Observed in production 2026-08-09 on DM B-94: rep B-164 inherited a vacant seat, so the mirror
   * holds `( Nasr City / P )` for their visits up to 17 June and `Essam.Youssef ( Dokki / P )`
   * from 14 June on. The rep table showed the new name while every call-list row for a doctor last
   * seen in early June showed the old one — and that old one carries no person's name at all, only
   * a territory, which breaks the standing rule that a name must always be human-readable.
   */
  const latestRepName = new Map<string, { date: string; name: string; visitId: number }>();
  let visitsCountedSelectedMonth = 0;

  for (const visit of visits) {
    if (visit.visit_type !== 0) continue;
    if (!visit.contact_crm_id) continue; // null and the 0 sentinel
    const visitDate = visit.visit_date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) continue;
    const monthKey = monthKeyOfVisitDate(visitDate);
    if (monthKey < historyFrom || monthKey > selectedMonth) continue;

    const visitId = visit.crm_visit_id ?? 0;

    // Contact-level facts. Months BEFORE the trend window are read for exactly this: they can fill
    // a name, grade or speciality the window itself never supplied, and they carry the "last seen"
    // date that separates a doctor neglected for five months from one never visited at all.
    // trackLatest orders strictly by date then crm_visit_id, so a pre-window visit can only ever
    // fill a value, never outrank an in-window one.
    let contact = contacts.get(visit.contact_crm_id);
    if (!contact) {
      contact = { contactCrmId: visit.contact_crm_id, latestGrade: null, latestName: null, latestSpeciality: null };
      contacts.set(visit.contact_crm_id, contact);
    }
    if (visit.contact_name?.trim()) {
      contact.latestName = trackLatest(contact.latestName, { date: visitDate, name: visit.contact_name.trim(), visitId });
    }
    const normalizedGrade = visit.crm_contact_grade?.trim().toUpperCase() ?? "";
    if (gradeTierOf(normalizedGrade)) {
      contact.latestGrade = trackLatest(contact.latestGrade, { date: visitDate, grade: normalizedGrade, visitId });
    }
    if (visit.speciality?.trim()) {
      contact.latestSpeciality = trackLatest(contact.latestSpeciality, {
        date: visitDate,
        speciality: visit.speciality.trim(),
        visitId,
      });
    }

    const repKey = repKeyFor(visit.agent_hr_id, visit.agent_crm_id);
    const repName = visit.agent_name?.trim() || (visit.agent_hr_id ? visit.agent_hr_id : "Unmapped agent");
    // Board-level latest-wins, ordered exactly like every other latest-wins tracker here (date,
    // then crm_visit_id). This is what the rows actually display.
    const currentName = latestRepName.get(repKey);
    if (
      !currentName ||
      visitDate > currentName.date ||
      (visitDate === currentName.date && visitId > currentName.visitId)
    ) {
      latestRepName.set(repKey, { date: visitDate, name: repName, visitId });
    }

    // The (rep, doctor) tally — this rep's own work on this doctor, and nobody else's.
    const key = pairKeyOf(repKey, visit.contact_crm_id);
    let pair = pairs.get(key);
    if (!pair) {
      pair = { lastVisitDate: null, repKey, visitsByMonth: new Map() };
      pairs.set(key, pair);
    }
    pair.visitsByMonth.set(monthKey, (pair.visitsByMonth.get(monthKey) ?? 0) + 1);
    if (!pair.lastVisitDate || visitDate > pair.lastVisitDate) pair.lastVisitDate = visitDate;
    if (monthKey === selectedMonth) visitsCountedSelectedMonth += 1;
  }

  // ── The assigned lists, one per month ─────────────────────────────────────────────────────────
  //
  // DISTINCT (rep, doctor) pairs, not plan ENTRIES. The vendor's weekly plan repeats a doctor across
  // the weeks of a month — production August 2026 holds 18,645 entries against 9,152 distinct
  // contacts — so counting entries would report each rep's call plan rather than his panel and
  // roughly double every denominator. The owner's rule is about the doctor LIST: 90 to 120 people.
  const listByMonth = new Map<string, Map<string, AssignedDoctor>>();
  for (const month of windowMonths) listByMonth.set(month, new Map());
  for (const row of options.planRows) {
    if (!row.contact_crm_id) continue;
    const planDate = row.plan_date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) continue;
    const list = listByMonth.get(monthKeyOfVisitDate(planDate));
    if (!list) continue;
    const repKey = repKeyFor(row.agent_hr_id, row.agent_crm_id);
    const key = pairKeyOf(repKey, row.contact_crm_id);
    if (list.has(key)) continue; // a repeat plan entry for the same doctor, not a second doctor
    list.set(key, {
      contactCrmId: row.contact_crm_id,
      contactName: row.contact_name?.trim() || null,
      gradeRaw: row.contact_grade?.trim().toUpperCase() ?? "",
      repKey,
      speciality: row.speciality?.trim() || null,
    });
  }

  // ── Score each month's assigned list ──────────────────────────────────────────────────────────
  //
  // WHO owns a doctor is now read off the list, not inferred. There is no primary-rep election any
  // more: the doctor belongs to the rep he was assigned to, and if two reps are both assigned him
  // he is a row on each of their panels — which is the truth, and something the old single-owner
  // election could not express at all.
  //
  // Each trend point is scored against THAT month's own list. Re-using the selected month's list
  // across the window would invent history: lists change every month (production ranges 5,182 to
  // 9,356 distinct contacts a month over Jan-Aug 2026), so a doctor added in August would appear to
  // have been neglected all summer.
  //
  // `let`, not `const`: the filter block below narrows this in place before every rollup reads it.
  let doctors: DoctorCoverageDoctorRow[] = [];
  let ungradedContacts = 0;
  const trendPanel = new Map<string, { green: number; panel: number }>();
  for (const month of windowMonths) trendPanel.set(month, { green: 0, panel: 0 });

  for (const month of windowMonths) {
    const bucket = trendPanel.get(month);
    const list = listByMonth.get(month);
    if (!bucket || !list) continue;
    const isSelected = month === selectedMonth;

    for (const [key, assigned] of list) {
      const contact = contacts.get(assigned.contactCrmId);
      // The list carries a grade on 100% of production rows, so the visit fallback is for a thin
      // list row — never the other way round. The list is what the business assigned; a grade seen
      // on a visit is only evidence about the same doctor.
      const gradeRaw = gradeTierOf(assigned.gradeRaw) ? assigned.gradeRaw : (contact?.latestGrade?.grade ?? "");
      const tier = gradeTierOf(gradeRaw);
      if (!tier) {
        // Ungraded on the list AND on every visit. Outside the panel, and counted so a vendor
        // grading gap is visible instead of silently shrinking the denominator.
        if (isSelected) ungradedContacts += 1;
        continue;
      }

      const kind = classifyCrmContactSpeciality(assigned.speciality ?? contact?.latestSpeciality?.speciality);
      // An `unclassified` contact is scored on the SP norms. Deliberate: a vendor value this build
      // has not seen yet must not silently drop out of the coverage denominator and move the number
      // — it stays scored and is surfaced in the mix list instead, so somebody classifies it.
      const target = norms[kind === "hcp" ? "hcp" : "sp"][tier];
      // 0 = "this population is not held to a frequency" (owner-configurable; production has HCP at
      // 0 since 2026-08-19). It cannot mean "needs zero visits": `visitsThisMonth >= 0` is always
      // true, so that would paint every one of them green and inflate coverage. They leave the
      // panel, the denominator and the call list.
      if (target <= 0) continue;

      // This rep's own visits to this doctor — a colleague's visit lives under a different pair key
      // and cannot discharge this assignment.
      const pair = pairs.get(key);
      const visitsThisMonth = pair?.visitsByMonth.get(month) ?? 0;
      bucket.panel += 1;
      if (visitsThisMonth >= target) bucket.green += 1;
      if (!isSelected) continue;

      doctors.push({
        contactCrmId: assigned.contactCrmId,
        contactName: assigned.contactName ?? contact?.latestName?.name ?? `Contact #${assigned.contactCrmId}`,
        gradeRaw,
        gradeTier: tier,
        lastVisitDate: pair?.lastVisitDate ?? null,
        kind,
        repKey: assigned.repKey,
        repName: repNameFor(assigned.repKey, latestRepName, options.repNameByHrId),
        speciality: assigned.speciality ?? contact?.latestSpeciality?.speciality ?? null,
        // Against an assigned list the three statuses are simple and total: met the norm, visited
        // but short, or not visited at all. Nobody drops out for being "inactive" — being on the
        // list IS the answer to whether this rep still owns them.
        status: visitsThisMonth >= target ? "green" : visitsThisMonth > 0 ? "yellow" : "red",
        targetVisits: target,
        visitsThisMonth,
      });
    }
  }

  // ── Off-list work: REPORTED, never scored ─────────────────────────────────────────────────────
  //
  // A doctor this rep visited this month who is not on this rep's list for this month. Measured on
  // production 2026-08-27: 1,670 of the old panel's 7,295 scored pairs — 22.9% — were exactly
  // this, and the old board silently promoted every one of them into the denominator through its
  // "primary rep" election. That is half the reason a panel could reach 263.
  //
  // It cannot be scored, because there is no target to score it against: the norms are a promise
  // about an ASSIGNED doctor. But it must not be hidden either — it is real field work, and a large
  // number here is a genuine finding (a list that is out of date, or a rep working outside it). So
  // it gets its own column, exactly like campaign work: beside the coverage number, never inside it.
  const offListByRep = new Map<string, number>();
  const selectedList = listByMonth.get(selectedMonth) ?? new Map<string, AssignedDoctor>();
  for (const [key, pair] of pairs) {
    if ((pair.visitsByMonth.get(selectedMonth) ?? 0) <= 0) continue;
    if (selectedList.has(key)) continue;
    offListByRep.set(pair.repKey, (offListByRep.get(pair.repKey) ?? 0) + 1);
  }
  /** Reps holding at least one assigned doctor this month — the answer to "does he have a list?". */
  const repsHoldingAList = new Set<string>();
  for (const assigned of selectedList.values()) repsHoldingAList.add(assigned.repKey);
  // No list rows AT ALL for the selected month. Distinct from "this rep has no list": it means the
  // mirror has not delivered yet (the plan mirror starts 2026-01, and the current month fills as the
  // vendor syncs), and the board must say so rather than report every rep at 0%.
  const planMonthMissing = selectedList.size === 0;

  // ── Filters ───────────────────────────────────────────────────────────────────────────────────
  // Applied here: AFTER scope and AFTER the panel rule, so a filter can only narrow what the viewer
  // was already entitled to see. Everything below — tiles, rep table, mixes, call list — is computed
  // from the filtered set, because a filtered board that still showed company totals would be
  // read as the filter having done nothing.
  //
  // `repOptions` is captured from the UNFILTERED rows first: narrowing the picker to the rep you
  // already picked would make the filter a one-way door with no way back.
  //
  // Built from every rep the board can SHOW, not only from the ones holding a panel: a rep whose
  // whole month was off-list or campaign work is now a visible row, and a picker that could not
  // select him would leave a row on screen that no filter can isolate.
  const repOptionByKey = new Map<string, string>();
  for (const doctor of doctors) repOptionByKey.set(doctor.repKey, doctor.repName);
  for (const repKey of offListByRep.keys()) {
    if (!repOptionByKey.has(repKey)) repOptionByKey.set(repKey, repNameFor(repKey, latestRepName, options.repNameByHrId));
  }
  const repOptions = Array.from(repOptionByKey.entries(), ([repKey, repName]) => ({ repKey, repName })).sort((a, b) =>
    a.repName.localeCompare(b.repName),
  );

  const rawFilters = options.filters ?? {};
  const clean = (value: string | undefined) => value?.trim() || null;
  const gradeFilter = clean(rawFilters.grade)?.toUpperCase() ?? null;
  const kindFilter = clean(rawFilters.kind)?.toLowerCase() ?? null;
  const statusFilter = clean(rawFilters.status)?.toLowerCase() ?? null;
  const repFilter = clean(rawFilters.repKey);
  const searchFilter = clean(rawFilters.search);
  const searchNeedle = searchFilter?.toLowerCase() ?? null;
  // Presence, not size, is what makes this filter active — see the `repKeys` doc comment.
  const territoryKeys = rawFilters.repKeys ? new Set(rawFilters.repKeys) : null;

  const appliedFilters: DoctorCoverageAppliedFilters = {
    active: Boolean(gradeFilter || kindFilter || statusFilter || repFilter || searchFilter || territoryKeys),
    grade: gradeFilter,
    kind: kindFilter,
    repKey: repFilter,
    repKeyCount: territoryKeys ? territoryKeys.size : null,
    search: searchFilter,
    status: statusFilter,
  };

  if (appliedFilters.active) {
    doctors = doctors.filter((doctor) => {
      if (gradeFilter && doctor.gradeTier !== gradeFilter) return false;
      if (kindFilter && doctor.kind !== kindFilter) return false;
      if (statusFilter && doctor.status !== statusFilter) return false;
      if (repFilter && doctor.repKey !== repFilter) return false;
      if (territoryKeys && !territoryKeys.has(doctor.repKey)) return false;
      if (searchNeedle) {
        const haystack = `${doctor.contactName} ${doctor.speciality ?? ""} ${doctor.repName}`.toLowerCase();
        if (!haystack.includes(searchNeedle)) return false;
      }
      return true;
    });
  }

  // ── Rep rollup (sums exactly to the company tiles by construction) ─────────────────────────────
  const repRows = new Map<string, DoctorCoverageRepRow>();
  for (const doctor of doctors) {
    let rep = repRows.get(doctor.repKey);
    if (!rep) {
      rep = {
        aDoctors: 0,
        agentHrId: doctor.repKey.startsWith("hr:") ? doctor.repKey.slice(3) : null,
        bDoctors: 0,
        cDoctors: 0,
        campaignCalls: 0,
        coveragePct: 0,
        green: 0,
        // Reached only from an assigned, graded doctor, so this rep always has at least one.
        hasPanel: true,
        offListDoctors: 0,
        panelSize: 0,
        red: 0,
        repKey: doctor.repKey,
        repName: doctor.repName,
        yellow: 0,
      };
      repRows.set(doctor.repKey, rep);
    }
    rep.panelSize += 1;
    if (doctor.status === "green") rep.green += 1;
    else if (doctor.status === "yellow") rep.yellow += 1;
    else rep.red += 1;
    if (doctor.gradeTier === "A") rep.aDoctors += 1;
    else if (doctor.gradeTier === "B") rep.bDoctors += 1;
    else rep.cDoctors += 1;
  }

  // Off-list work folds in HERE, after the panel rollup, so it can never touch panelSize, green,
  // yellow, red or coveragePct — the four numbers a manager reads as "did he cover his list".
  //
  // The rep and territory filters gate it; grade, kind, status and search deliberately do not. Those
  // four narrow the PANEL, and an off-list doctor is by definition not in the panel — letting a
  // status=red filter also filter a column that has no status would produce a number nobody could
  // reconcile. The identity filters are different in kind: they answer "whose board is this", and a
  // fold-in that re-added a rep the viewer filtered out would defeat the filter entirely.
  for (const [repKey, offList] of offListByRep) {
    if (repFilter && repKey !== repFilter) continue;
    if (territoryKeys && !territoryKeys.has(repKey)) continue;
    const existing = repRows.get(repKey);
    if (existing) {
      existing.offListDoctors = offList;
      continue;
    }
    // Visited doctors this month, holds no assigned list for it. Under the old board this rep read
    // as a healthy panel of exactly the people he happened to visit; the honest answer is that
    // there is nothing to score him against, so `hasPanel` is false and the table prints a marker
    // rather than a percentage.
    repRows.set(repKey, {
      aDoctors: 0,
      agentHrId: repKey.startsWith("hr:") ? repKey.slice(3) : null,
      bDoctors: 0,
      cDoctors: 0,
      campaignCalls: 0,
      coveragePct: 0,
      green: 0,
      hasPanel: false,
      offListDoctors: offList,
      panelSize: 0,
      red: 0,
      repKey,
      repName: repNameFor(repKey, latestRepName, options.repNameByHrId),
      yellow: 0,
    });
  }

  for (const rep of repRows.values()) {
    rep.coveragePct = rep.panelSize > 0 ? Math.round((rep.green / rep.panelSize) * 100) : 0;
  }

  // ── Campaign work: counted BESIDE coverage, never inside it ───────────────────────────────────
  //
  // OWNER'S RULING 2026-08-27, asked in plain words and answered "count it separately". It is the
  // same answer he gave Rep Doctor Lists on 2026-08-21; that board implemented it and this one
  // never did.
  //
  // WHAT IT FIXES HERE IS AN ABSENCE, NOT A WRONG NUMBER — and that is the whole point. `repRows`
  // above is built by walking `doctors`, which exist only where a GRADED type-0 visit does. A rep
  // whose entire month was campaign work therefore had no doctor, so no row, so no presence on
  // this board at all: not a visible 0%, simply missing. Measured on production 2026-08-27 against
  // `ireports360_visits_effective` — people with zero regular visits and non-zero campaign work:
  // 15 in August 2026, 22 in July, 24 in June. The largest single case logged 160 field calls in
  // August and appeared nowhere on this board.
  //
  // A campaign row can never be graded, and that is a property of the DATA, not a policy choice:
  // every campaign row the vendor sends carries contact id 0 with a blank name and blank
  // speciality. It says the rep worked; it never says which doctor they saw. So it cannot enter
  // the panel, the denominator, or `coveragePct` — it gets its own column, and `hasPanel` tells
  // the table to print a marker rather than a percentage for a rep who has no panel to score.
  const campaignByRep = new Map<string, { calls: number; name: string }>();
  for (const visit of options.campaignVisits ?? []) {
    const visitDate = visit.visit_date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) continue;
    // The caller reads only the selected month, but the core must not depend on that: a fixture or
    // a future caller handing over a wider range must not inflate this month's column.
    if (monthKeyOfVisitDate(visitDate) !== selectedMonth) continue;
    const repKey = repKeyFor(visit.agent_hr_id, visit.agent_crm_id);
    const entry = campaignByRep.get(repKey);
    if (entry) {
      entry.calls += 1;
      continue;
    }
    campaignByRep.set(repKey, {
      calls: 1,
      name: visit.agent_name?.trim() || (visit.agent_hr_id ? visit.agent_hr_id : "Unmapped agent"),
    });
  }

  for (const [repKey, entry] of campaignByRep) {
    // Same identity gate as the off-list fold-in above, and for the same reason: a rep the viewer
    // filtered out must not walk back onto the board through a side channel. (This gate was absent
    // before the assigned-list change — with a rep filter active, campaign-only reps still appeared.)
    if (repFilter && repKey !== repFilter) continue;
    if (territoryKeys && !territoryKeys.has(repKey)) continue;
    const existing = repRows.get(repKey);
    if (existing) {
      existing.campaignCalls = entry.calls;
      continue;
    }
    // No graded panel anywhere in the window — this rep exists on the board ONLY because of
    // campaign work. `latestRepName` is preferred when the graded pass happened to see the name,
    // for the same reason it exists there: one person must never appear under two labels.
    //
    // THIS MUST GO THROUGH `repNameFor` LIKE EVERY OTHER ROW. It used to build the name itself —
    // `latestRepName.get(repKey)?.name?.trim() || entry.name` — and that second rule is precisely
    // how three campaign-only reps kept their login handle on 2026-08-27 after every other row had
    // been switched to the real one: Adel.Srour, Ahmed.Sharaf and Omayma.Wael, each with a
    // perfectly good directory row nobody was reading. The suite could not see it, because the
    // fixture reps all had graded visits; the served page could.
    repRows.set(repKey, {
      aDoctors: 0,
      agentHrId: repKey.startsWith("hr:") ? repKey.slice(3) : null,
      bDoctors: 0,
      cDoctors: 0,
      campaignCalls: entry.calls,
      coveragePct: 0,
      green: 0,
      hasPanel: false,
      offListDoctors: 0,
      panelSize: 0,
      red: 0,
      repKey,
      repName: repNameFor(repKey, latestRepName, options.repNameByHrId, entry.name),
      yellow: 0,
    });
  }
  // ── Districts: a manager is scored on his TEAM's list, because he has none of his own ─────────
  //
  // OWNER'S RULING 2026-08-27, in his own words: "the district manager doesn't have a list. The
  // list of the district manager is the list of his teams." Every number on a district row is a
  // plain sum of the rep rows beneath it, so a district always reconciles with the reps inside it.
  //
  // MEMBERSHIP IS STRUCTURAL, NEVER BY TITLE. "Does anyone report to me" is a fact in the employee
  // directory; "District Sales Manager" is free text that is misspelt often enough to hide 9 of 27
  // of them from a title search. It also settles the case that prompted this: the one medical rep
  // ACTING as a district manager gets a district row from her two reports, with no title change and
  // no special case — the owner's instruction was to move the reps, never her title.
  //
  // The walk runs from each REP upwards, so every ancestor collects every rep beneath it at any
  // depth. That gives districts, and above them the regions and the company — all real rows, told
  // apart by `isDistrict` rather than by a hard-coded level.
  const orgByHrId = options.orgByHrId;
  // Lower-cased on the same rule as every other key read out of this map: it is compared against
  // `manager_hr_id` values that were lower-cased when the tree was built, and a single upper-cased
  // character would silently mean "the viewer is nowhere in this tree" — the walk would run to the
  // top again and the CEO row would quietly come back.
  const viewerHrId = options.viewerHrId?.trim().toLowerCase() || null;
  /** manager hr id -> the repKeys rolled into that manager, at any depth. */
  const subtreeByManager = new Map<string, Set<string>>();
  /** manager hr id -> the OTHER managers sitting beneath him. Empty = he is a district.
   *
   * Read from the reporting chain rather than from the bucket above, and that distinction is not
   * academic: a bucket holds rep rows only, so a District Manager who logged nothing himself has no
   * rep row and never appears in his own manager's bucket. Deciding "is this a district" from the
   * bucket therefore promoted a National Sales Manager into the districts table the moment one of
   * his District Managers had a quiet month. It read correct against production only because every
   * real DM happened to log campaign work in August 2026. */
  const managersBeneath = new Map<string, Set<string>>();
  // A cycle in the directory (A reports to B reports to A) is a data fault, not a shape to support.
  // Both guards are cheap and neither can hang the board while somebody fixes the record.
  const MAX_ORG_DEPTH = 12;
  if (orgByHrId && orgByHrId.size > 0) {
    for (const rep of repRows.values()) {
      // A CRM-only agent has no hr id and therefore no place in the tree. He stays a rep row rather
      // than disappearing: 5 such agents were on the August 2026 board, and they look like real
      // reps whose HR record simply lags their CRM account.
      if (!rep.agentHrId) continue;
      /** This rep's managers, closest first — up to the VIEWER, or to the top of the tree. */
      const chain: string[] = [];
      const seen = new Set<string>([rep.agentHrId]);
      let cursor = orgByHrId.get(rep.agentHrId)?.managerHrId ?? null;
      for (let depth = 0; cursor && depth < MAX_ORG_DEPTH; depth += 1) {
        if (seen.has(cursor)) break;
        seen.add(cursor);
        chain.push(cursor);
        // STOP AT THE VIEWER. Everything above him is scoped out of this board already, so a row for
        // his own manager could only ever be the viewer's own numbers under somebody else's name —
        // it says nothing new and it states something false about a person who has more reps than
        // this. A District Manager opening the board was getting exactly that: his eight reps'
        // panel presented as his National Sales Manager's, and again as the CEO's.
        if (viewerHrId && cursor === viewerHrId) break;
        cursor = orgByHrId.get(cursor)?.managerHrId ?? null;
      }
      for (let level = 0; level < chain.length; level += 1) {
        const managerHrId = chain[level]!;
        let bucket = subtreeByManager.get(managerHrId);
        if (!bucket) {
          bucket = new Set<string>();
          subtreeByManager.set(managerHrId, bucket);
        }
        bucket.add(rep.repKey);
        let beneath = managersBeneath.get(managerHrId);
        if (!beneath) {
          beneath = new Set<string>();
          managersBeneath.set(managerHrId, beneath);
        }
        // Everything earlier in the chain is a manager sitting between this one and the rep.
        for (let lower = 0; lower < level; lower += 1) beneath.add(chain[lower]!);
      }
    }

    // A manager whose only directory-recorded report(s) produced no row at all this month never
    // enters the walk above, so he falls through and reads as an ordinary rep with "no list" — even
    // though "does anyone report to me" is still true in the directory. Ahmed Nagy (PD-0006),
    // 2026-08: 56 campaign calls of his own, one direct report (Bahaa Gamal, PD-0007) who resigned
    // and therefore never appears in `repRows`. Owner's ruling 2026-08-27: keep him as a district —
    // of an empty roster right now — rather than flagging him personally as a rep with no list.
    //
    // Recognised only when he is ALREADY on the board through his own activity. A manager with zero
    // activity of his own and no active reports has nothing to show either way, and manufacturing an
    // all-zero row for him would be exactly the noise the `managersBeneath`-not-`bucket` rule above
    // already guards against.
    const hasDirectoryReport = new Set<string>();
    for (const node of orgByHrId.values()) {
      if (node.managerHrId) hasDirectoryReport.add(node.managerHrId);
    }
    for (const rep of repRows.values()) {
      if (!rep.agentHrId || subtreeByManager.has(rep.agentHrId)) continue;
      if (hasDirectoryReport.has(rep.agentHrId)) {
        subtreeByManager.set(rep.agentHrId, new Set());
        if (!managersBeneath.has(rep.agentHrId)) managersBeneath.set(rep.agentHrId, new Set());
      }
    }

    // ── THE COMPANY IS NOT A DISTRICT, AND NOT A REGION EITHER ──────────────────────────────────
    //
    // The walk gives a row to every ancestor, and the last ancestor is always the top of the tree —
    // in production that is the CEO (`AA`), whom all three National Sales Managers report to. That
    // produced a manager row named for a person who has never held an assigned doctor list,
    // carrying whatever the board happened to be scoped to as if it were his panel. Owner,
    // 2026-08-28: "the CEO ... He never assigned to visits." The board already states the company
    // in its totals; naming a person as its manager adds nothing and says something untrue.
    //
    // Recognised STRUCTURALLY, exactly like `isDistrict`, so it stays correct if the org gains or
    // loses a layer — never by job title, which is free text and misspelt often enough to hide 9 of
    // 27 District Managers from a title search. The root is the node with nobody above it AND other
    // managers below it. BOTH halves are load-bearing, and production says why: 19 employees carry
    // a blank `manager_hr_id`, of whom exactly ONE is active — the CEO. The other 18 are departed
    // or placeholder rows, including four District Sales Managers, and a rep still pointing at one
    // of them puts a blank-managered DISTRICT into this walk. He has no managers beneath him, so he
    // keeps his row; only a node that is both rootless and has managers under it is the company.
    for (const managerHrId of [...subtreeByManager.keys()]) {
      const hasManagerAbove = Boolean(orgByHrId.get(managerHrId)?.managerHrId);
      const hasManagersBeneath = (managersBeneath.get(managerHrId)?.size ?? 0) > 0;
      if (hasManagerAbove || !hasManagersBeneath) continue;
      subtreeByManager.delete(managerHrId);
      managersBeneath.delete(managerHrId);
    }
  }
  /** repKeys that are managers — removed from the rep table, because their row is their district. */
  const managerKeys = new Set<string>();
  for (const managerHrId of subtreeByManager.keys()) managerKeys.add(`hr:${managerHrId}`);
  // Product Managers hold no personal doctor list either — same as a District Manager, and for the
  // same reason: he owns a brand, not a territory of reps. The reports-based walk above can never
  // find him (a PM has no reports), so title is the only signal available. Owner's ruling
  // 2026-08-27: exclude him from the "no list" alarm tallies below, but — UNLIKE a manager — never
  // remove his row from `reps`, and never touch his access. His board is already scoped to his own
  // product line (doctor-coverage-roles.ts LINE_ROLES) and built from this same `reps` table, so
  // pulling him out here would take his own view away along with the false alarm. "Group Product
  // Manager" is a different, more senior title and is deliberately NOT included — nobody holding it
  // showed up in this tally in production as of 2026-08-27.
  const productManagerKeys = new Set<string>();
  for (const rep of repRows.values()) {
    if (!rep.agentHrId) continue;
    if (orgByHrId?.get(rep.agentHrId)?.title?.trim().toLowerCase() === "product manager") {
      productManagerKeys.add(rep.repKey);
    }
  }
  // A manager's OWN field work belongs to his district. The upward walk cannot add it (it starts
  // above him), so it is folded in here — for the District Managers on this board that is campaign
  // calls and off-list visits, which is all any of them logged.
  for (const [managerHrId, bucket] of subtreeByManager) {
    if (repRows.has(`hr:${managerHrId}`)) bucket.add(`hr:${managerHrId}`);
  }

  const managerRows: DoctorCoverageManagerRow[] = [];
  for (const [managerHrId, bucket] of subtreeByManager) {
    const managerKey = `hr:${managerHrId}`;
    const row: DoctorCoverageManagerRow = {
      aDoctors: 0,
      bDoctors: 0,
      cDoctors: 0,
      campaignCalls: 0,
      coveragePct: 0,
      green: 0,
      hasPanel: false,
      hrId: managerHrId,
      // A district is a manager with no other manager between him and his reps.
      isDistrict: (managersBeneath.get(managerHrId)?.size ?? 0) === 0,
      managerKey,
      // THE DIRECTORY NAME ALONE — deliberately WITHOUT the territory `repNameFor` now appends.
      // Both take the real name from the directory; what differs is the bracket. A rep's territory
      // identifies him. A manager's own territory would MISLEAD: Nosiba's CRM name says
      // "( Minia 1 / E )", but the district under her spans Minia 1, Minia 2 and Bani Sweif, so
      // stamping one of the three beside a 129-doctor panel would state something untrue about the
      // other two. A district is named for the person, and its territories are the rows inside it.
      managerName: options.repNameByHrId?.get(managerHrId)?.trim() || repNameFor(managerKey, latestRepName, options.repNameByHrId),
      offListDoctors: 0,
      panelSize: 0,
      red: 0,
      repsWithNoList: 0,
      teamRepKeys: [],
      teamSize: 0,
      title: orgByHrId?.get(managerHrId)?.title ?? null,
      yellow: 0,
    };
    const team: DoctorCoverageRepRow[] = [];
    for (const repKey of bucket) {
      const rep = repRows.get(repKey);
      if (!rep) continue;
      row.aDoctors += rep.aDoctors;
      row.bDoctors += rep.bDoctors;
      row.cDoctors += rep.cDoctors;
      row.campaignCalls += rep.campaignCalls;
      row.green += rep.green;
      row.offListDoctors += rep.offListDoctors;
      row.panelSize += rep.panelSize;
      row.red += rep.red;
      row.yellow += rep.yellow;
      if (repKey === managerKey || managerKeys.has(repKey)) continue;
      team.push(rep);
      if (!rep.hasPanel && !productManagerKeys.has(repKey)) row.repsWithNoList += 1;
    }
    row.hasPanel = row.panelSize > 0;
    row.coveragePct = row.panelSize > 0 ? Math.round((row.green / row.panelSize) * 100) : 0;
    row.teamRepKeys = team.sort((a, b) => a.repName.localeCompare(b.repName)).map((rep) => rep.repKey);
    row.teamSize = row.teamRepKeys.length;
    managerRows.push(row);
  }
  managerRows.sort(
    (a, b) =>
      Number(b.isDistrict) - Number(a.isDistrict) ||
      Number(b.hasPanel) - Number(a.hasPanel) ||
      a.coveragePct - b.coveragePct ||
      a.managerName.localeCompare(b.managerName),
  );

  // Both totals still read the FULL map, managers included: a District Manager's campaign call is
  // real work done inside this scope, and a tile that dropped it the day districts arrived would be
  // read as the work having stopped.
  const totalsCampaignCalls = Array.from(repRows.values()).reduce((sum, rep) => sum + rep.campaignCalls, 0);
  const totalsOffList = Array.from(repRows.values()).reduce((sum, rep) => sum + rep.offListDoctors, 0);
  // A rep who is ON this board and holds no assigned list for the selected month. Counted from the
  // rows that survived the filters, so it always reconciles with the table underneath it.
  // Managers are excluded on purpose: a District Manager holding no personal list is the RULE, not
  // a loading gap, and counting him here is what made this tile read 18 in August 2026 when only 4
  // of those people were reps waiting on a list. A Product Manager is the same rule for a different
  // reason (owner's ruling 2026-08-27) — see `productManagerKeys` above.
  const repsWithNoList = Array.from(repRows.values()).filter(
    (rep) => !managerKeys.has(rep.repKey) && !productManagerKeys.has(rep.repKey) && !repsHoldingAList.has(rep.repKey),
  ).length;
  // Campaign-only reps, counted the same manager-aware way and from the ROW's own shape rather than
  // from a counter incremented while the rows were being built. The two are equivalent — a row with
  // no panel and no off-list visit can only have been created by the campaign fold-in — but the
  // counter ran before districts existed, so it still counted every District Manager whose month
  // was campaign work. Measured on August 2026: 14 before, 4 after, so 10 of the 14 were managers —
  // of the remaining 4, one is the Product Manager `productManagerKeys` now also excludes.
  const repsAllCampaign = Array.from(repRows.values()).filter(
    (rep) => !managerKeys.has(rep.repKey) && !productManagerKeys.has(rep.repKey) && !rep.hasPanel && rep.offListDoctors === 0 && rep.campaignCalls > 0,
  ).length;

  const totalsGreen = doctors.filter((doctor) => doctor.status === "green").length;
  const totalsYellow = doctors.filter((doctor) => doctor.status === "yellow").length;
  const totalsRed = doctors.filter((doctor) => doctor.status === "red").length;
  const activePanel = doctors.length;

  // ── Two mixes: doctors (SP) and accounts (HCP) ────────────────────────────────────────────────
  // Owner rule 2026-08-08: "all specialities SP, pharmacy and hospitals contract and insurance HCP".
  // These used to be ONE list, so a pharmacy outranked most real specialties in it.
  //
  // Both lists are now COMPLETE — no top-N cut. The old rank-based "Other" bucket was not a
  // category at all, just "rank 9 and below", so its meaning changed with the viewer's scope: on
  // one District Manager's board it held 32 contacts that were almost all hospitals and contracts,
  // while company-wide the same bucket buried ~780 real physicians (Urology 270, General Surgery
  // 151, Psychiatry 125, Neuro Surgery 88, and the rest). Every value stands on its own now; there
  // are ~18 SP and ~11 HCP values in production, which is a readable list either way.
  const mixFor = (kind: CrmContactKind) => {
    const counts = new Map<string, number>();
    for (const doctor of doctors) {
      if (doctor.kind !== kind) continue;
      const label = doctor.speciality?.trim() || "Unspecified";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([label, count]) => ({ doctors: count, label }));
  };
  const specialtyMix = mixFor("sp");
  const accountMix = mixFor("hcp");
  // A value the vendor invented since this build shipped lands here rather than being guessed into
  // one of the two lists — the exact failure that let "Contract" be scored as a doctor for months.
  const unclassifiedMix = mixFor("unclassified");
  if (unclassifiedMix.length > 0) specialtyMix.push(...unclassifiedMix.map((row) => ({ ...row, label: `${row.label} (unclassified)` })));

  const gradeSplit = (["A", "B", "C"] as const).map((tier) => ({
    covered: doctors.filter((doctor) => doctor.gradeTier === tier && doctor.status === "green").length,
    doctors: doctors.filter((doctor) => doctor.gradeTier === tier).length,
    tier,
  }));

  const trend = windowMonths.map((month) => {
    const bucket = trendPanel.get(month) ?? { green: 0, panel: 0 };
    return {
      activePanel: bucket.panel,
      coveragePct: bucket.panel > 0 ? Math.round((bucket.green / bucket.panel) * 100) : 0,
      label: monthLabelOf(month),
      month,
    };
  });

  // ── Prioritised call list — the module's actual answer to "so what do I do now" ────────────────
  // Every doctor still short of their own grade norm this month, hardest-hitting first. The order
  // is the coaching order a DM would use out loud: A-grade before B/C (an A doctor is worth two
  // visits a month for a reason), then whoever is furthest behind, then whoever has gone longest
  // unseen. A doctor never visited in the whole window sorts to the very top of their tier — an
  // empty `lastVisitDate` is the strongest signal on the board, not a missing value to skip past.
  const callListAll = doctors
    .filter((doctor) => doctor.visitsThisMonth < doctor.targetVisits)
    .map((doctor) => ({
      contactCrmId: doctor.contactCrmId,
      contactName: doctor.contactName,
      gradeTier: doctor.gradeTier,
      lastVisitDate: doctor.lastVisitDate,
      repKey: doctor.repKey,
      repName: doctor.repName,
      speciality: doctor.speciality,
      visitsNeeded: doctor.targetVisits - doctor.visitsThisMonth,
      visitsThisMonth: doctor.visitsThisMonth,
    }))
    .sort((a, b) => {
      const tierRank = (tier: DoctorCoverageGradeTier) => (tier === "A" ? 0 : tier === "B" ? 1 : 2);
      if (tierRank(a.gradeTier) !== tierRank(b.gradeTier)) return tierRank(a.gradeTier) - tierRank(b.gradeTier);
      if (a.visitsNeeded !== b.visitsNeeded) return b.visitsNeeded - a.visitsNeeded;
      // "" sorts before any real date, which puts never-visited doctors first — intended.
      const aSeen = a.lastVisitDate ?? "";
      const bSeen = b.lastVisitDate ?? "";
      if (aSeen !== bSeen) return aSeen < bSeen ? -1 : 1;
      return a.contactName.localeCompare(b.contactName);
    });

  const coveragePct = activePanel > 0 ? Math.round((totalsGreen / activePanel) * 100) : 0;

  return {
    accountMix,
    appliedFilters,
    // Same rule as the table above: a picker offering a name the table can no longer show would be
    // a filter with no way back to anything.
    repOptions: repOptions.filter((option) => !managerKeys.has(option.repKey) || repsHoldingAList.has(option.repKey)),
    callList: callListAll.slice(0, DOCTOR_COVERAGE_CALL_LIST_SIZE),
    callListTotal: callListAll.length,
    doctors: doctors.sort((a, b) => {
      const severity = (status: DoctorCoverageStatus) => (status === "red" ? 0 : status === "yellow" ? 1 : 2);
      return (
        severity(a.status) - severity(b.status) ||
        b.gradeTier.localeCompare(a.gradeTier) * -1 ||
        a.contactName.localeCompare(b.contactName)
      );
    }),
    gradeSplit,
    isCurrentMonth: selectedMonth === currentCairoMonth,
    month: selectedMonth,
    monthLabel: monthLabelOf(selectedMonth),
    pace: resolveCoveragePace({ coveragePct, selectedMonth, todayIso: cairoTodayIso() }),
    // Worst coverage first, but a rep with NO panel is not a 0% performer and must never head that
    // ranking — they sort to the end, the same treatment Rep Doctor Lists gives a rep with no
    // measurable plan.
    managers: managerRows,
    reps: Array.from(repRows.values())
      // A manager belongs to `managers`, where his row is his team's list. He stays in this table
      // only if he holds an assigned list of his own — which no District Manager did in August
      // 2026, and which the owner's rule says should stay unusual.
      .filter((rep) => !managerKeys.has(rep.repKey) || repsHoldingAList.has(rep.repKey))
      .sort(
        (a, b) =>
          Number(b.hasPanel) - Number(a.hasPanel) ||
          a.coveragePct - b.coveragePct ||
          a.repName.localeCompare(b.repName),
      ),
    scopeLabel: options.scopeLabel ?? "",
    specialtyMix,
    totals: {
      activePanel,
      campaignCalls: totalsCampaignCalls,
      coveragePct,
      green: totalsGreen,
      offListDoctors: totalsOffList,
      planMonthMissing,
      red: totalsRed,
      repsAllCampaign,
      repsWithNoList,
      ungradedContacts,
      visitsCounted: visitsCountedSelectedMonth,
      yellow: totalsYellow,
    },
    trend,
    windowFrom,
    windowTo,
  };
}

/**
 * IO wrapper: viewer-SCOPED read + duplicate collapse, then the pure core.
 *
 * `scope` is required and has no default. It was previously absent altogether, which is exactly how
 * every seat that could open this board ended up reading all 205 agents and 12,420 doctors
 * company-wide; a required argument means a future caller cannot silently reopen that hole by
 * forgetting to pass one. Resolve it with `getDoctorCoverageScope(access)`.
 *
 * Both filters below now run in Postgres instead of Node:
 *  - `agentHrIds` is the whole point — a District Manager's ~8 reps instead of all 205. Measured on
 *    production for a real DM seat (B-12, 5 reps): 3,071 rows over 4 keyset pages, against 95,324
 *    rows over 96 pages before, each page a separate Railway-sfo → Supabase-eu-central round trip.
 *  - `visitTypes: [0]` on the graded read is free correctness: the pure core discards every other
 *    type on its first `continue`, and non-regular rows were 29.3% of a measured 6-month window
 *    (27,934 of 95,324 rows) that crossed the Atlantic only to be thrown away.
 *
 * CAMPAIGN IS A SECOND, NARROW READ — deliberately not a widening of the one above. The graded read
 * spans six months because the lapse test needs that history; campaign is only ever reported for
 * the SELECTED month, so widening `visitTypes` there would drag five months of rows across the
 * Atlantic to discard them. Measured on production 2026-08-27 over a six-month window: 25,041
 * campaign rows against 76,554 regular ones, a 32.7% increase for data needed in one month. The
 * narrow read costs roughly a sixth of that. (Rep Doctor Lists reads both types in one call
 * because its window IS one month — same rule, different arithmetic.)
 *
 * The campaign rows are NOT passed through `collapseDuplicateVisitSubmissions`. That is not an
 * oversight and not a shortcut: `duplicateSubmissionGroupKey` returns null for any non-regular
 * row, precisely because their contact id is a shared sentinel — so collapsing campaign rows on it
 * would merge a whole day of genuine calls into one. Running it here would be an exact no-op; not
 * running it says why.
 *
 * ONE CONSEQUENCE A SCOPED VIEWER SHOULD KNOW ABOUT. Because the scope filters VISITS, a doctor
 * seen by two reps in different districts is counted for each viewer only from their own reps'
 * visits — so a shared doctor can read under-visited for one DM while the company covered them.
 * That is the correct reading for "is MY team covering its panel", and it is rare: measured on
 * production 2026-08-08, 310 of 12,422 doctors (2.5%) were touched by more than one rep in a
 * 6-month window, and never by more than three. Company-scoped viewers are unaffected.
 */
export async function getSfeDoctorCoverage(input: {
  filters?: DoctorCoverageFilters;
  month?: string;
  scope: DoctorCoverageScope;
  /** The signed-in viewer's own hr id, from the live AccessContext and never from client input.
   * Used for ONE thing: stopping the district walk at his own seat, so he is not shown his own
   * numbers a second and third time under his manager's and the CEO's names. */
  viewerHrId?: string | null;
}): Promise<SfeDoctorCoverageBoard> {
  if (input.scope.kind === "none") {
    // Defence in depth. Both pages check this first and render an explanation; reaching here means
    // a caller skipped that check, and the safe answer to "no scope" is no data, never all of it.
    throw new Error(input.scope.reason);
  }
  const month = resolveCoverageMonth(input.month);
  const dateFrom = `${addMonthsToMonthKey(month, -DOCTOR_COVERAGE_SCAN_MONTHS_BACK)}-01`;
  const dateTo = lastDayOfMonthKeyIso(month);
  const rows = await queryVisits<DoctorCoverageVisitInput>({
    columns: VISIT_COLUMNS,
    dateFrom,
    dateTo,
    visitTypes: [0],
    // Counts visits: only the rows that count (counts_in_kpi, and a customer validated — sweep of 11 Nov 2026).
    kpiOnly: true,
    ...(input.scope.kind === "agents" ? { agentHrIds: input.scope.agentHrIds } : {}),
  });
  const campaignRows = await queryVisits<DoctorCoverageVisitInput>({
    columns: VISIT_COLUMNS,
    dateFrom: `${month}-01`,
    dateTo,
    visitTypes: [CAMPAIGN_TYPE],
    ...(input.scope.kind === "agents" ? { agentHrIds: input.scope.agentHrIds } : {}),
  });
  const collapsed = collapseDuplicateVisitSubmissions(rows);

  // ── The assigned lists ──────────────────────────────────────────────────────────────────────
  //
  // Read only for the TREND window (4 months), not the 6-month scan window: the extra two months
  // exist so a doctor's last-seen date and grade can be found, and neither needs a list.
  //
  // SCOPING THE PLAN READ. The plan mirror has no usable hr id (see `scanPlanEntries`), so the
  // viewer's scope is translated into CRM ids using the rows just read — which are already scoped,
  // already departed-agent-filtered by the visits door, and therefore cannot widen what this viewer
  // sees. The translation loses a rep only if he holds a list and logged not one visit in four
  // months; measured on production 2026-08-27 that set is EMPTY (all 78 agents holding an August
  // list had visits in the window), and such a rep is a leaver or a vacant seat rather than a
  // coverage failure. A company-scoped viewer passes no filter and sees every list regardless.
  const scopedAgentCrmIds =
    input.scope.kind === "agents"
      ? Array.from(
          new Set(
            [...collapsed, ...campaignRows]
              .map((row) => row.agent_crm_id)
              .filter((id): id is number => typeof id === "number" && id > 0),
          ),
        )
      : undefined;
  // The same translation for a rep hired after the CRM cutover, who has no CRM id: his visits carry
  // a NULL `agent_crm_id`, so he never reached the list above and his plan was never read. Taken only
  // from such rows, so every rep with a CRM id is read exactly as before; scanPlanEntries unions the
  // two lists.
  const scopedAgentHrIds =
    input.scope.kind === "agents"
      ? Array.from(
          new Set(
            [...collapsed, ...campaignRows]
              .filter((row) => !(typeof row.agent_crm_id === "number" && row.agent_crm_id > 0))
              .map((row) => row.agent_hr_id?.trim() ?? "")
              .filter((hrId) => hrId.length > 0),
          ),
        )
      : undefined;
  const [planRows, excludedAgentCrmIds, directory, { norms }] = await Promise.all([
    scanPlanEntries(`${addMonthsToMonthKey(month, -DOCTOR_COVERAGE_MONTHS_BACK)}-01`, dateTo, {
      ...(scopedAgentCrmIds ? { agentCrmIds: scopedAgentCrmIds } : {}),
      ...(scopedAgentHrIds && scopedAgentHrIds.length > 0 ? { agentHrIds: scopedAgentHrIds } : {}),
    }),
    getEffectiveExcludedAgentCrmIds(),
    // A rep who holds a list but has logged no visit has no name anywhere in the CRM mirror; the
    // directory is the only place one exists. Inactive included on purpose — a rep who left
    // mid-month still owns that month's list and must be named, not shown as a code.
    getEmployeeDirectoryRows({ includeInactive: true }),
    // Norms are admin-editable per kind and grade; getDoctorCoverageConfig never throws and falls
    // back to the shipped defaults, so a missing table or a transient read cannot break the board.
    getDoctorCoverageConfig(),
  ]);

  // Departed agents are excluded from the visits read by the door itself. The plan mirror has no
  // such door, so the same exclusion is applied here — in Node rather than as a `not.in` filter,
  // because that list travels in the URL and a long one silently returns nothing at all.
  const excluded = new Set(excludedAgentCrmIds);
  const livePlanRows = excluded.size === 0 ? planRows : planRows.filter((row) => !excluded.has(row.agent_crm_id ?? -1));

  const repNameByHrId = new Map<string, string>();
  // THE ORG TREE, for the district rollup. Built from the same directory read as the names above —
  // no second query — and lower-cased on BOTH sides, because the only thing it is ever compared
  // against is the hr id inside a `hr:` repKey, which is built lower-cased. A single upper-cased
  // `manager_hr_id` would otherwise put a whole district's reps under a manager who does not exist,
  // silently: the walk would simply find nothing and every rep would stay a rep.
  const orgByHrId = new Map<string, DoctorCoverageOrgNode>();
  for (const employee of directory) {
    // Lower-cased: this map is read with the hr id taken out of a `hr:` repKey, which is built
    // lower-cased so one person cannot occupy two keys. Rep Doctor Lists keys the same map
    // UPPER-cased for its own reasons — the two are not interchangeable.
    repNameByHrId.set(employee.hrId.trim().toLowerCase(), employee.displayName || employee.fullName);
    orgByHrId.set(employee.hrId.trim().toLowerCase(), {
      managerHrId: employee.managerHrId?.trim().toLowerCase() || null,
      title: employee.jobTitle?.trim() || null,
    });
  }

  return buildDoctorCoverageBoard(collapsed, month, {
    campaignVisits: campaignRows,
    filters: input.filters,
    norms,
    orgByHrId,
    planRows: livePlanRows,
    repNameByHrId,
    scopeLabel: input.scope.label,
    // Only for a SCOPED viewer. A company-scoped seat (Super Admin, CEO, SFE Manager, Marketing
    // Manager) is meant to see every level of the tree, and passing an hr id that happened to
    // collide with a node in it would silently truncate the ladder for them.
    viewerHrId: input.scope.kind === "agents" ? input.viewerHrId : null,
  });
}
