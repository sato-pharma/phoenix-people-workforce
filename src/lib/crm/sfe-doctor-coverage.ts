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
 * Coverage norms (owner-confirmed 2026-08-02): A-grade (A+ folds into A) doctors need 2 visits in
 * the month to count covered; B and C need 1. A doctor with zero visits this month who WAS seen in
 * the prior two months is "lapsed" (red). A doctor last seen 3+ months ago is inactive — out of the
 * panel and out of the denominator entirely.
 *
 * DATE DISCIPLINE (same test-enforced rule as sfe-field-analytics.ts): CRM date strings are Cairo
 * wall-clock and `visit_date` is a plain YYYY-MM-DD — all month math here is string arithmetic,
 * never Date-object parsing or ISO re-serialization (either would shift the wall-clock).
 */

import { CAMPAIGN_TYPE } from "@/lib/crm/visit-types";
import { collapseDuplicateVisitSubmissions, queryVisits } from "@/lib/crm/reads";
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
/** Selected month plus this many prior months form the board and its trend line — 4 points. */
export const DOCTOR_COVERAGE_MONTHS_BACK = 3;
/** A doctor with zero visits in the selected month counts as lapsed only if seen within this many
 * prior months; older than that they are inactive and leave the panel. */
export const DOCTOR_COVERAGE_LAPSE_LOOKBACK_MONTHS = 2;
/** How far back the READ actually goes: every trend month — the oldest included — needs its own
 * prior-two-months lapse history, and history that was never scanned reads as "never visited".
 * Scanning only the trend window dropped every lapsed doctor out of the oldest month's denominator,
 * and since a lapsed doctor is never green, that month's bar was the only one biased upward. */
export const DOCTOR_COVERAGE_SCAN_MONTHS_BACK = DOCTOR_COVERAGE_MONTHS_BACK + DOCTOR_COVERAGE_LAPSE_LOOKBACK_MONTHS;
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
  /** Latest contact_name seen in the window — human names, never raw ids (owner rule). */
  contactName: string;
  gradeRaw: string;
  gradeTier: DoctorCoverageGradeTier;
  /** Latest type-0 visit date ≤ the selected month's end, YYYY-MM-DD. */
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
   * with no graded panel is not a 0% performer, and rendering one as 0% is the bug this replaced. */
  coveragePct: number;
  green: number;
  /** False when this rep has no graded doctor at all this window and appears only because of
   * campaign work. The table must print a marker instead of a percentage for them. */
  hasPanel: boolean;
  panelSize: number;
  red: number;
  repKey: string;
  repName: string;
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
    /** Reps whose ONLY logged field work this month is campaign — they have no graded panel at all.
     * Before 2026-08-27 they had no row on this board whatsoever; 15 people in August 2026. */
    repsAllCampaign: number;
    /** Contacts seen in the selected month whose grade is absent/unknown across the whole window —
     * outside the panel, surfaced so a vendor grading gap is visible instead of silent. */
    ungradedContacts: number;
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

function monthLabelOf(monthKey: string): string {
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  return `${MONTH_NAMES[monthIndex] ?? monthKey} ${monthKey.slice(0, 4)}`;
}

/** Same agent-key convention as sfe-field-analytics.ts — hr id when mapped, crm id otherwise. */
function repKeyOf(visit: DoctorCoverageVisitInput): string {
  if (visit.agent_hr_id) return `hr:${visit.agent_hr_id.toLowerCase()}`;
  return `crm:${visit.agent_crm_id ?? 0}`;
}

type ContactAccumulator = {
  contactCrmId: number;
  /** Latest-visit-wins fields, tracked with their visit date (tie → higher crm_visit_id). */
  latestGrade: { date: string; grade: string; visitId: number } | null;
  latestName: { date: string; name: string; visitId: number } | null;
  latestSpeciality: { date: string; speciality: string; visitId: number } | null;
  lastVisitDate: string | null;
  /** Visit count per month key. Spans the trend window PLUS the lapse history before it, so the
   * oldest trend month can be tested for lapse the same way every later month is. */
  visitsByMonth: Map<string, number>;
  /** Type-0 visit count per repKey in the whole window — drives the primary-rep assignment. */
  visitsByRep: Map<string, { count: number; latestDate: string; latestVisitId: number; repName: string }>;
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
 */
export function buildDoctorCoverageBoard(
  visits: readonly DoctorCoverageVisitInput[],
  selectedMonth: string,
  /** Optional so the existing fixture tests keep their two-argument calls. `norms` defaults to the
   * shipped doctor norms, so a fixture that does not care about config behaves exactly as before. */
  options: {
    /** Campaign rows (visit type -8) for the SELECTED month. Deliberately a SEPARATE argument, not
     * mixed into `visits`: the graded loop below then cannot see them even by accident, so "the
     * coverage number did not move" is true by construction rather than by a `continue`. */
    campaignVisits?: readonly DoctorCoverageVisitInput[];
    filters?: DoctorCoverageFilters;
    norms?: DoctorCoverageNorms;
    scopeLabel?: string;
  } = {},
): SfeDoctorCoverageBoard {
  const norms = options.norms ?? DEFAULT_DOCTOR_COVERAGE_NORMS;
  const windowMonths: string[] = [];
  for (let back = DOCTOR_COVERAGE_MONTHS_BACK; back >= 0; back -= 1) {
    windowMonths.push(addMonthsToMonthKey(selectedMonth, -back));
  }
  const lapseMonths = new Set(
    Array.from({ length: DOCTOR_COVERAGE_LAPSE_LOOKBACK_MONTHS }, (_, index) =>
      addMonthsToMonthKey(selectedMonth, -(index + 1)),
    ),
  );
  const lapseHistoryFrom = addMonthsToMonthKey(selectedMonth, -DOCTOR_COVERAGE_SCAN_MONTHS_BACK);
  const windowFrom = `${windowMonths[0]}-01`;
  const windowTo = lastDayOfMonthKeyIso(selectedMonth);
  const currentCairoMonth = monthKeyOfVisitDate(cairoTodayIso());

  const contacts = new Map<number, ContactAccumulator>();
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
    if (monthKey < lapseHistoryFrom || monthKey > selectedMonth) continue;

    let contact = contacts.get(visit.contact_crm_id);
    if (!contact) {
      contact = {
        contactCrmId: visit.contact_crm_id,
        lastVisitDate: null,
        latestGrade: null,
        latestName: null,
        latestSpeciality: null,
        visitsByMonth: new Map(),
        visitsByRep: new Map(),
      };
      contacts.set(visit.contact_crm_id, contact);
    }

    contact.visitsByMonth.set(monthKey, (contact.visitsByMonth.get(monthKey) ?? 0) + 1);

    const visitId = visit.crm_visit_id ?? 0;
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
    if (!contact.lastVisitDate || visitDate > contact.lastVisitDate) contact.lastVisitDate = visitDate;

    // Months before the trend window exist to answer "was this doctor seen before the chart
    // starts". The latest-wins trackers above are safe to feed from them: trackLatest orders
    // strictly by date then crm_visit_id, so a pre-window visit can never outrank an in-window one
    // — it can only FILL a value the window itself never supplied. That fill is load-bearing. A
    // doctor last seen in the two months BEFORE the chart has no in-window visit at all, so
    // leaving him ungraded meant `if (!tier) continue` below threw him straight back out of the
    // oldest month's panel — exactly the lapsed doctors the widened scan was added to recover.
    // Measured in production for selected month 2026-08: 1,317 of the 1,848 missing lapsed doctors
    // (71%) were still being dropped that way, and every one of them carries a grade on the
    // pre-window visit already in the scan. He cannot leak onto the selected-month board either:
    // reaching doctors.push needs a visit this month or in the prior two, all inside the window.
    //
    // The primary-rep tally below is the one thing that must NOT see them — it is a COUNT, so a
    // pre-window visit could flip which rep owns a doctor on the strength of a visit the board
    // never displays.
    if (monthKey < windowMonths[0]) continue;

    const repKey = repKeyOf(visit);
    const repEntry = contact.visitsByRep.get(repKey);
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
    if (!repEntry) {
      contact.visitsByRep.set(repKey, { count: 1, latestDate: visitDate, latestVisitId: visitId, repName });
    } else {
      repEntry.count += 1;
      if (visitDate > repEntry.latestDate || (visitDate === repEntry.latestDate && visitId > repEntry.latestVisitId)) {
        repEntry.latestDate = visitDate;
        repEntry.latestVisitId = visitId;
        repEntry.repName = repName;
      }
    }
    if (monthKey === selectedMonth) visitsCountedSelectedMonth += 1;
  }

  // ── Classify every contact for the selected month ──────────────────────────────────────────────
  // `let`, not `const`: the filter block below narrows this in place before every rollup reads it.
  let doctors: DoctorCoverageDoctorRow[] = [];
  let ungradedContacts = 0;
  // Per-month green/panel counts for the trend, computed with the SAME latest-grade-in-window rule.
  const trendPanel = new Map<string, { green: number; panel: number }>();
  for (const month of windowMonths) trendPanel.set(month, { green: 0, panel: 0 });

  for (const contact of contacts.values()) {
    const gradeRaw = contact.latestGrade?.grade ?? null;
    const tier = gradeTierOf(gradeRaw);
    const visitsThisMonth = contact.visitsByMonth.get(selectedMonth) ?? 0;

    if (!tier) {
      if (visitsThisMonth > 0) ungradedContacts += 1;
      continue;
    }

    const kind = classifyCrmContactSpeciality(contact.latestSpeciality?.speciality);
    // An `unclassified` contact is scored on the SP norms, which is exactly what happened to every
    // contact before this split existed. Deliberate: a vendor value this build has not seen yet
    // must not silently drop out of the coverage denominator and move the number — it stays scored
    // as before and is surfaced in the mix list instead, so somebody classifies it.
    const scoringKind = kind === "hcp" ? "hcp" : "sp";
    const target = norms[scoringKind][tier];
    // 0 = "this population is not held to a frequency" (owner-configurable). It cannot mean
    // "needs zero visits": `visitsThisMonth >= 0` is always true, so that would paint every one of
    // them green and inflate coverage. They leave the panel, the denominator, and the call list.
    if (target <= 0) continue;

    // Trend: every window month gets the same green-vs-target math (panel = visited that month
    // OR lapsed relative to that month's own prior-2 window, which the widened scan supplies even
    // for the oldest point).
    for (const month of windowMonths) {
      const monthVisits = contact.visitsByMonth.get(month) ?? 0;
      let inPanel = monthVisits > 0;
      if (!inPanel) {
        for (let back = 1; back <= DOCTOR_COVERAGE_LAPSE_LOOKBACK_MONTHS; back += 1) {
          const prior = addMonthsToMonthKey(month, -back);
          if (prior < lapseHistoryFrom) break;
          if ((contact.visitsByMonth.get(prior) ?? 0) > 0) {
            inPanel = true;
            break;
          }
        }
      }
      if (!inPanel) continue;
      const bucket = trendPanel.get(month);
      if (!bucket) continue;
      bucket.panel += 1;
      if (monthVisits >= target) bucket.green += 1;
    }

    let status: DoctorCoverageStatus;
    if (visitsThisMonth >= target) status = "green";
    else if (visitsThisMonth > 0) status = "yellow";
    else {
      const seenRecently = Array.from(lapseMonths).some((month) => (contact.visitsByMonth.get(month) ?? 0) > 0);
      if (!seenRecently) continue; // inactive — out of panel and denominator
      status = "red";
    }

    // Primary rep: most window visits; tie → latest visit, then higher crm_visit_id.
    let primary: { count: number; latestDate: string; latestVisitId: number; repKey: string; repName: string } | null =
      null;
    for (const [repKey, entry] of contact.visitsByRep) {
      if (
        !primary ||
        entry.count > primary.count ||
        (entry.count === primary.count &&
          (entry.latestDate > primary.latestDate ||
            (entry.latestDate === primary.latestDate && entry.latestVisitId > primary.latestVisitId)))
      ) {
        primary = { ...entry, repKey };
      }
    }

    doctors.push({
      contactCrmId: contact.contactCrmId,
      contactName: contact.latestName?.name ?? `Contact #${contact.contactCrmId}`,
      gradeRaw: gradeRaw as string,
      gradeTier: tier,
      lastVisitDate: contact.lastVisitDate,
      kind,
      repKey: primary?.repKey ?? "crm:0",
      // WHICH rep owns this doctor is decided per contact (above); what that rep is CALLED is a
      // board-level fact, so it comes from latestRepName. Using the per-contact name here is what
      // made one rep appear under two labels — see the note on latestRepName. Falls back to the
      // per-contact name only if the key is somehow absent, which cannot happen for a rep that
      // reached visitsByRep.
      repName: (primary ? latestRepName.get(primary.repKey)?.name : null) ?? primary?.repName ?? "Unmapped agent",
      speciality: contact.latestSpeciality?.speciality ?? null,
      status,
      targetVisits: target,
      visitsThisMonth,
    });
  }

  // ── Filters ───────────────────────────────────────────────────────────────────────────────────
  // Applied here: AFTER scope and AFTER the panel rule, so a filter can only narrow what the viewer
  // was already entitled to see. Everything below — tiles, rep table, mixes, call list — is computed
  // from the filtered set, because a filtered board that still showed company totals would be
  // read as the filter having done nothing.
  //
  // `repOptions` is captured from the UNFILTERED rows first: narrowing the picker to the rep you
  // already picked would make the filter a one-way door with no way back.
  const repOptions = Array.from(
    new Map(doctors.map((doctor) => [doctor.repKey, doctor.repName])).entries(),
    ([repKey, repName]) => ({ repKey, repName }),
  ).sort((a, b) => a.repName.localeCompare(b.repName));

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
        // Reached only from a graded doctor, so this rep always has at least one.
        hasPanel: true,
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
    const repKey = repKeyOf(visit);
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

  let repsAllCampaign = 0;
  for (const [repKey, entry] of campaignByRep) {
    const existing = repRows.get(repKey);
    if (existing) {
      existing.campaignCalls = entry.calls;
      continue;
    }
    // No graded panel anywhere in the window — this rep exists on the board ONLY because of
    // campaign work. `latestRepName` is preferred when the graded pass happened to see the name,
    // for the same reason it exists there: one person must never appear under two labels.
    repsAllCampaign += 1;
    repRows.set(repKey, {
      aDoctors: 0,
      agentHrId: repKey.startsWith("hr:") ? repKey.slice(3) : null,
      bDoctors: 0,
      cDoctors: 0,
      campaignCalls: entry.calls,
      coveragePct: 0,
      green: 0,
      hasPanel: false,
      panelSize: 0,
      red: 0,
      repKey,
      repName: latestRepName.get(repKey)?.name ?? entry.name,
      yellow: 0,
    });
  }
  const totalsCampaignCalls = Array.from(repRows.values()).reduce((sum, rep) => sum + rep.campaignCalls, 0);

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
    repOptions,
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
    reps: Array.from(repRows.values()).sort(
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
      red: totalsRed,
      repsAllCampaign,
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
  // Norms are admin-editable per kind and grade; getDoctorCoverageConfig never throws and falls
  // back to the shipped defaults, so a missing table or a transient read cannot break the board.
  const { norms } = await getDoctorCoverageConfig();
  return buildDoctorCoverageBoard(collapsed, month, {
    campaignVisits: campaignRows,
    filters: input.filters,
    norms,
    scopeLabel: input.scope.label,
  });
}
