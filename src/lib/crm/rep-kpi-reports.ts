// ─────────────────────────────────────────────────────────────────────────────
// TWO KPI REPORTS PER REP
//
// The owner's requirement, 2026-09-05, verbatim:
//
//   "in phx we want to have 2 separate kpis report / rep the first is call rate
//    frequency and covergae am/pm and the 2nd for pharmacies"
//
// So: two reports per rep, each carrying all three numbers.
//   REPORT 1 — AM/PM        (call rate, frequency, coverage)
//   REPORT 2 — Pharmacies   (call rate, frequency, coverage)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE VOCABULARY — fix this first, it is the source of the confusion
//
// These are THREE DIFFERENT NUMBERS. The owner separated them himself
// (2026-09-05): "whole panel visisted one is the coverage te graded norm is
// called frequency".
//
//   COVERAGE  — distinct contacts on the panel visited AT LEAST ONCE in the
//               month, over the panel size. A yes/no per contact.
//   FREQUENCY — achievement against the per-GRADE required visit count (the
//               graded norm). An A-grade contact needing 2 visits and getting 1
//               is 100% covered and 0% frequent.
//   CALL RATE — visits per working day. Nothing to do with the panel at all.
//
// Do not let any of them be called "coverage" generically. THE EXISTING
// `buildDoctorCoverageBoard` SCORES `visitsThisMonth >= target` AND LABELS IT
// COVERAGE — that is this module's FREQUENCY, not its coverage, and it is the
// specific mislabel this file exists to end. A reader who assumes the old board
// and this one should agree will conclude one of them is broken; they measure
// two different things and both numbers are produced here, side by side.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SPLIT IS `list_type`, NEVER `speciality`
//
// `public.ireports360_contacts.list_type` holds exactly `AM` | `PM` |
// `Pharmacy`, synced from the CRM's own `ContactsList.aspx` grid (the `t=`
// parameter — `t=Pharmacy`, not `t=PH`; a wrong `t` returns an EMPTY grid, not
// an error). That is the CRM's list ASSIGNMENT and it is what the owner's
// ruling is about. Measured on production 2026-09-05:
//
//     PM        6,946 contacts, 69 reps
//     Pharmacy  1,872 contacts, 44 reps
//     AM          887 contacts, 68 reps
//
// A SECOND, DIFFERENT CUT EXISTS AND THEY CROSS. `classifyCrmContactSpeciality`
// sorts a contact into SP (all specialities) or HCP (pharmacy, hospitals,
// contract, insurance) — owner's rule 2026-08-08. That cut is what the LIVE
// `doctor_coverage_config` norms key off. Measured on production 2026-09-05:
//
//     AM (887)   = 643 hospitals + 205 insurance/contract + 34 doctors  → 96% HCP
//     PM (6,945) = 6,928 doctors + 16 blank + 1 hospital                → 99.8% SP
//     Pharmacy   = 1,872, all pharmacies                                → 100% HCP
//
// So "AM" is the ACCOUNTS list — hospitals, contracts, insurers — not a morning
// doctors list. That is why the owner says "2 am accounts" where PM gets 8-12.
// Deriving the split from `speciality` would put a hospital and a pharmacy in
// one bucket and split the AM list itself in two: 34 of its contacts classify
// SP. `list_type` is the only field that answers the question actually asked.
//
// SAFE TO SPLIT, MEASURED: every (agent, contact) pair on production carries
// exactly ONE `list_type` (checked 2026-09-05 across all 9,705 pairs), so a
// visit can never land in two reports and the two panels can never overlap.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY NOT SCORED YET
//
// Four numbers do not exist anywhere — not in the database, not in this
// codebase, not in anything the owner has said. They are PARKED QUESTIONS, and
// this module must not invent any of them:
//
//   1. Pharmacy call-rate target per working day.  (AM = 2, PM = band 8-12.)
//   2. Pharmacy frequency norm per grade.          (Pharmacies grade A and B.)
//   3. Pharmacy coverage floor.                    (AM/PM floor is 95%.)
//   4. Whether AM ACCOUNTS carry a frequency norm at all.
//
// Every one of them is `null` here, and null renders as "Not scored" — NEVER as
// zero. A zero would read as "nothing expected" and paint the whole population
// green; that is exactly the trap `doctor_coverage_config` documents, where a 0
// norm removes a population from the panel entirely. Production has HCP at
// {A:0,B:0,C:0} since 2026-08-19, which is why frequency today effectively
// scores PM doctors ONLY — AM accounts and pharmacies are both unscored.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULES THIS FILE ENFORCES STRUCTURALLY
//
// NEVER AVERAGE AM AND PM. Owner, 2026-09-04: "this two and this ten. Don't
// never get average." There is deliberately NO combined figure in any type
// below — not a field, not a total, not a band. Every way of merging the two
// lets a good morning pay for an afternoon that never happened: 2 of 2 AM with
// nothing after lunch reads 50% averaged and 17% over one denominator, when the
// true answer is 100% AM and 0% PM. The absence is load-bearing; adding a
// `combined` field is the bug, and `runTwoKpiReportsPerRepTests` fails if one
// appears.
//
// NEVER PRINT THE PAIR WITH A SLASH. He read "1.63 / 6.57" as "1.63 out of
// 6.57". The separator is " AM · " / " PM" — see {@link formatAmPmPair}.
//
// A PHARMACY IS NOT A CONTACT. Pharmacies stay out of the denominator the
// 90-120 rule judges and get their own report. Never put `rows.length` beside
// the word "contacts", and never name a row bag `contacts` when it holds
// pharmacies. Row label "Pharmacist", count "Pharmacies".
//
// A REP WITH NO PHARMACY LIST IS NORMAL — 25 of 69 have none. Report 2 renders
// "not applicable", never a zero, a gap or a warning. A rep with NO AM/PM list
// IS worth flagging: that is the universal half.
//
// ─────────────────────────────────────────────────────────────────────────────

import { CATCH_ALL_CONTACT_CRM_ID, isCallRateWorkingDay, type CallRateHolidays } from "@/lib/crm/call-rate";
import { LIST_TYPES, type CrmListType } from "@/lib/crm/list-types";
import type { DoctorCoverageGradeTier } from "@/lib/crm/doctor-coverage-config";
import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * The CRM's catch-all contact. NOT a doctor, a pharmacy or an account — reps log against it when
 * they have nobody real to log against, so it poisons every per-contact figure it reaches. Excluded
 * from both panels and from every visit count here. Declared in crm/call-rate.ts, whose rate now
 * excludes it too; re-exported so this module's importers keep their path.
 */
export { CATCH_ALL_CONTACT_CRM_ID };

/** The two reports, by name. Report 1 spans two lists; report 2 spans one. */
export const AM_PM_LIST_TYPES = ["AM", "PM"] as const satisfies readonly CrmListType[];
export const PHARMACY_LIST_TYPE = "Pharmacy" as const satisfies CrmListType;

// ─────────────────────────────────────────────────────────────────────────────
// The standard — every number configurable, null until the owner supplies it
// ─────────────────────────────────────────────────────────────────────────────

/** An inclusive acceptable range, e.g. PM's 8-12 calls a day. */
export type KpiBand = { readonly min: number; readonly max: number };

/**
 * One list's standard. Every field is nullable and null means "the owner has not set this yet",
 * which renders as "Not scored". It NEVER means zero — see the header.
 */
export type KpiListStandard = {
  /** Visits per working day expected on this list. */
  readonly callRatePerDay: number | null;
  /**
   * The acceptable range around `callRatePerDay`, when the owner stated one. PM is "8-12 pm only",
   * so a rep at 8.0 MEETS the PM standard even though the headline target is 10. Null means the
   * target alone decides (met at >= target).
   */
  readonly callRateBand: KpiBand | null;
  /** Percent of the panel that must be visited at least once in the month. */
  readonly coverageFloorPct: number | null;
  /** Visits per month per grade. Null = that grade is not held to a frequency at all. */
  readonly frequencyNorms: Readonly<Record<DoctorCoverageGradeTier, number | null>>;
};

export type RepKpiStandards = Readonly<Record<CrmListType, KpiListStandard>>;

const NO_NORMS: Readonly<Record<DoctorCoverageGradeTier, number | null>> = { A: null, B: null, C: null };

/**
 * The standard as it actually stands today — nothing invented.
 *
 * AM = 2 and PM = 8-12 around 10 are the owner's own words ("8-12 pm only and 2 am accounts").
 * The 95% coverage floor is the stated AM/PM standard. PM's frequency norms mirror the LIVE
 * production `doctor_coverage_config.norms.sp` values, which is what scores PM doctors today —
 * kept in step by hand, since that table has no code dependency on this file or vice versa.
 *
 * ANSWERED BY THE OWNER 2026-09-06 (xlsx/kpi-standards-decisions-2026-09-06.xlsx):
 *   - AM frequency norm A = 1      → a grade A account is visited once a month. 787 of the
 *     887 AM accounts are grade A, and this norm had sat at 0 (= unscored) since 2026-08-19.
 *   - Pharmacy coverage floor = 50 → deliberately NOT the AM/PM 95%. Pharmacy coverage ran
 *     at 40.6% in August (760 of 1,872), so a 95% floor would put every rep in the red on
 *     day one. Do NOT 'align' it with the AM/PM number.
 *   - PM frequency norms A:3 B:2 C:1 (up from 2:1:1) → left as a note on rows 9-10 rather than
 *     the dropdown ("frequency measured in pm list onoly and a should be 3 and b 2 and c 1"),
 *     confirmed directly in chat 2026-09-06 as a change to the existing PM/sp norms, not a new
 *     AM answer. `doctor_coverage_config.norms.sp` was updated live in production the same day
 *     (audit_logs entity_type=doctor_coverage_config, 2026-09-06 20:41:56 UTC) so the OLD board's
 *     own Frequency tab and this report agree — the two disagreeing on one number is exactly the
 *     shape #3341 retracted the visits/day band over.
 *
 * Still null on purpose, still questions waiting on the owner:
 *   - pharmacy call rate per day and pharmacy frequency norms → parked questions 1, 2 and 3
 *   - AM grade B and C norms → he left those blank, which means 'keep it as it is today'
 */
export const DEFAULT_REP_KPI_STANDARDS: RepKpiStandards = {
  AM: { callRatePerDay: 2, callRateBand: null, coverageFloorPct: 95, frequencyNorms: { A: 1, B: null, C: null } },
  PM: {
    callRatePerDay: 10,
    // SETTLED 2026-09-06 — the 8-12 band is PM ALONE, and this module is now its ONLY home.
    //
    // TWO READINGS OF "8-12" WERE LIVE ON `main` AT ONCE, merged 22 minutes apart on 2026-09-05.
    // Recorded rather than deleted, because "why is the band only on PM?" is a question the next
    // session would otherwise answer by re-deriving the combined model from the owner's earlier,
    // more general wording — which is exactly how it was arrived at the first time:
    //
    //   THIS ONE — "8-12 pm only and 2 am accounts": the band is PM's, AM is a flat 2. CORRECT.
    //   call-rate.ts (PR #3319) — "call rate in month should be 10 to achieve this should make
    //     visits / day av 8-12": banded an AM + PM SUM. Said before AM and PM had been separated
    //     in the conversation at all, which is why it read as the whole day.
    //
    // They agreed on most reps and disagreed on 30 of 76 (August 2026, production, Sat-Wed, 23
    // working days): 7 PM + 2 AM is 9 a day — IN-BAND summed, BELOW band on PM alone — so one rep
    // read Met on the AM · PM tab and Below on the call-rate board, with nothing on screen saying
    // why. PR #3331 flagged that without guessing at it; asked directly, the owner answered "8-12
    // pm only and 2 am accounts" and, to a second session, "10 PM - 2 AM".
    //
    // PR #3341 then RETRACTED the combined band rather than repointing it: two implementations of
    // one rule is what let them drift apart, so the call-rate.ts copy is gone and this is the
    // single authority. Do NOT reintroduce a band on AM, and do NOT add a combined AM+PM band
    // anywhere — a band on both lists invites summing them, which is the shape that was retired.
    // Pinned by tests/pm-call-rate-band.test.ts, whose separating case is 7 PM + 2 AM.
    callRateBand: { min: 8, max: 12 },
    coverageFloorPct: 95,
    // Raised from {A:2,B:1,C:1} — owner, 2026-09-06 — see the header note above.
    frequencyNorms: { A: 3, B: 2, C: 1 },
  },
  Pharmacy: { callRatePerDay: null, callRateBand: null, coverageFloorPct: 50, frequencyNorms: NO_NORMS },
};

/**
 * A stored standard, as an admin would edit it — every field optional, so a partial edit changes
 * only what it names and everything else keeps the shipped default.
 */
export type StoredKpiListStandard = {
  readonly callRatePerDay?: number | null;
  readonly callRateBand?: KpiBand | null;
  readonly coverageFloorPct?: number | null;
  readonly frequencyNorms?: Partial<Record<DoctorCoverageGradeTier, number | null>>;
};

export type StoredRepKpiStandards = Partial<Record<CrmListType, StoredKpiListStandard>>;

/**
 * Merge an admin-edited standard over the shipped defaults.
 *
 * WHY THIS CANNOT REUSE `doctor_coverage_config.norms` DIRECTLY, though it deliberately mirrors its
 * shape and its "editable policy over a TS-const fallback" pattern: those norms are keyed by the
 * SP/HCP cut, and these reports split on `list_type`. The two cross. AM accounts and pharmacies are
 * BOTH `hcp`, so one HCP number would answer parked questions 2 and 4 with a single value — and
 * they are two different questions about two different populations the owner must price separately.
 * A pharmacy norm and a hospital-account norm are not the same number, and storing them in one slot
 * makes it impossible for them ever to differ.
 *
 * Persisting these therefore needs one new `list_standards` jsonb column on `doctor_coverage_config`
 * — deliberately NOT in this change, so the reports can ship and be read while the four parked
 * questions are still open. Until that column exists this resolves to
 * {@link DEFAULT_REP_KPI_STANDARDS}, which is today's real standard with every unanswered number
 * null.
 *
 * A stored `null` is meaningful and is KEPT: it is how an admin says "this population is not held
 * to this standard". Only an ABSENT key falls back to the default.
 */
export function resolveRepKpiStandards(stored?: StoredRepKpiStandards | null): RepKpiStandards {
  if (!stored) return DEFAULT_REP_KPI_STANDARDS;
  const out = {} as Record<CrmListType, KpiListStandard>;
  for (const listType of LIST_TYPES) {
    const base = DEFAULT_REP_KPI_STANDARDS[listType];
    const edit = stored[listType];
    if (!edit) {
      out[listType] = base;
      continue;
    }
    out[listType] = {
      callRatePerDay: "callRatePerDay" in edit ? (edit.callRatePerDay ?? null) : base.callRatePerDay,
      callRateBand: "callRateBand" in edit ? (edit.callRateBand ?? null) : base.callRateBand,
      coverageFloorPct: "coverageFloorPct" in edit ? (edit.coverageFloorPct ?? null) : base.coverageFloorPct,
      frequencyNorms: {
        A: resolveNorm(edit.frequencyNorms, "A", base),
        B: resolveNorm(edit.frequencyNorms, "B", base),
        C: resolveNorm(edit.frequencyNorms, "C", base),
      },
    };
  }
  return out;
}

function resolveNorm(
  edited: Partial<Record<DoctorCoverageGradeTier, number | null>> | undefined,
  grade: DoctorCoverageGradeTier,
  base: KpiListStandard,
): number | null {
  if (!edited || !(grade in edited)) return base.frequencyNorms[grade];
  return edited[grade] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a number carries no verdict. These are NOT interchangeable and must never be collapsed into
 * one "n/a" on screen — they say opposite things to a manager:
 *
 *   not-applicable  — this rep has no such list. Nothing is wrong. (25 of 69 reps have no
 *                     pharmacy list.) Render "Not applicable".
 *   no-standard-set — the owner has not supplied this number yet. The rep's own figure is still
 *                     measured and shown; only the verdict is missing. Render "Not scored".
 *   empty-panel     — the list exists but holds nothing to measure against.
 *   no-working-days — the period contains no Sat-Wed day, so a per-day rate cannot be formed.
 */
export type KpiUnscoredReason = "not-applicable" | "no-standard-set" | "empty-panel" | "no-working-days";

export type KpiScore =
  | {
      readonly scored: true;
      readonly target: number;
      readonly band: KpiBand | null;
      /** The rep's figure as a percentage of target. */
      readonly attainmentPct: number;
      readonly meets: boolean;
    }
  | { readonly scored: false; readonly reason: KpiUnscoredReason };

function unscored(reason: KpiUnscoredReason): KpiScore {
  return { scored: false, reason };
}

/**
 * Score a measured value against a target, and a band when one exists.
 *
 * `meets` reads the BAND when there is one: PM's standard is "8-12 pm only", so 8.0 meets it and
 * 13.0 does not, even though 13.0 is above the headline 10. Without a band, met means >= target.
 * A band is never invented — only PM has one, from the owner's own words.
 */
function score(value: number | null, target: number | null, band: KpiBand | null): KpiScore {
  if (target == null) return unscored("no-standard-set");
  if (value == null) return unscored("no-working-days");
  const attainmentPct = target > 0 ? (value / target) * 100 : 0;
  const meets = band ? value >= band.min && value <= band.max : value >= target;
  return { scored: true, target, band, attainmentPct, meets };
}

// ─────────────────────────────────────────────────────────────────────────────
// The three numbers
// ─────────────────────────────────────────────────────────────────────────────

export type CallRateKpi = {
  /** Regular Sat-Wed visits this rep made to contacts on THIS list. */
  readonly visits: number;
  readonly workingDays: number;
  /** visits / workingDays. Null when the period holds no working day. */
  readonly perWorkingDay: number | null;
  readonly score: KpiScore;
};

export type CoverageKpi = {
  /** Contacts on this rep's list of this type. */
  readonly panel: number;
  /** Of those, how many were visited at least ONCE. */
  readonly visited: number;
  /** visited / panel, as a percentage. Null when the panel is empty. */
  readonly pct: number | null;
  readonly score: KpiScore;
};

export type FrequencyGradeRow = {
  readonly grade: DoctorCoverageGradeTier;
  /** Visits per month this grade must receive. Null = this grade is not held to a frequency. */
  readonly norm: number | null;
  readonly panel: number;
  readonly met: number;
};

export type FrequencyKpi = {
  /** Contacts whose grade carries a real norm — the denominator. Unscored grades are excluded. */
  readonly scoredPanel: number;
  /** Of those, how many received at least their grade's norm. */
  readonly met: number;
  readonly pct: number | null;
  readonly byGrade: readonly FrequencyGradeRow[];
  /**
   * Contacts carrying no grade this build recognises. Counted and surfaced rather than dropped, so
   * a vendor grading gap is visible instead of silently shrinking the denominator.
   */
  readonly ungraded: number;
  readonly score: KpiScore;
};

/** One list's three numbers. */
export type ListKpiBlock = {
  readonly listType: CrmListType;
  /** False when this rep has no list of this type at all. */
  readonly applicable: boolean;
  readonly callRate: CallRateKpi;
  readonly coverage: CoverageKpi;
  readonly frequency: FrequencyKpi;
};

/**
 * REPORT 1 — AM/PM.
 *
 * Note there is no combined figure and no `total`: AM and PM are reported APART, always. See the
 * header. `applicable` is false only when the rep has NEITHER list, which IS worth flagging —
 * unlike report 2, every rep is expected to carry AM/PM.
 */
export type AmPmKpiReport = {
  readonly kind: "ampm";
  readonly applicable: boolean;
  readonly am: ListKpiBlock;
  readonly pm: ListKpiBlock;
};

/**
 * REPORT 2 — Pharmacies.
 *
 * `applicable` false is NORMAL and must render as "Not applicable" — never a zero, a gap, a
 * warning or a red cell. Measured on production: 25 of 69 reps carry no pharmacy list at all.
 */
export type PharmacyKpiReport = {
  readonly kind: "pharmacy";
  readonly applicable: boolean;
  readonly pharmacies: ListKpiBlock;
};

export type RepKpiReports = {
  /**
   * Canonical (case-folded) hr id — HR ids are mixed case in this database, and a raw `.eq` on one
   * silently under-returns.
   *
   * NULL when the row carries no hr id at all, which the vendor feed does allow. Deliberately not
   * coerced to `""`: an empty string is a perfectly good Map key, so every unidentified rep would
   * silently collapse into ONE row carrying the sum of their panels and visits — a single plausible
   * row that no manager could tell was wrong. Null forces the caller to decide what to do with a
   * rep it cannot name.
   */
  readonly repKey: string | null;
  readonly repName: string;
  /** "YYYY-MM". */
  readonly month: string;
  readonly workingDays: number;
  readonly ampm: AmPmKpiReport;
  readonly pharmacies: PharmacyKpiReport;
  /**
   * Regular Sat-Wed visits to a contact that is NOT on any of this rep's lists, so no `list_type`
   * can attribute them to either report.
   *
   * Measured on production for August 2026: 867 of 14,076 such visits, 6.2%. They are reported
   * here rather than dropped (which understates call rate) or folded into PM (which inflates it) —
   * "an export must MATCH the screen; label it, never drop it silently".
   */
  readonly offListVisits: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

export type KpiPanelContact = {
  readonly contactCrmId: number;
  readonly listType: CrmListType;
  /** The vendor's grade as stored: "A", "A+", "B", "C", or blank. */
  readonly grade: string | null;
};

export type KpiVisitInput = {
  readonly contactCrmId: number | null;
  /** Visit date as "YYYY-MM-DD" (Cairo wall-clock, as the CRM records it). */
  readonly visitDateIso: string;
};

/**
 * "A+"/"A" → A, "B" → B, "C" → C, anything else → null (ungraded).
 *
 * A+ folds into A: one PM contact on production carries it and it is A's norm that applies. This
 * deliberately mirrors the private `gradeTierOf` behind the exported `coverageTargetForGrade` in
 * sfe-doctor-coverage.ts; `runTwoKpiReportsPerRepTests` pins the two against each other so they
 * cannot drift apart.
 */
export function kpiGradeTierOf(grade: string | null | undefined): DoctorCoverageGradeTier | null {
  const trimmed = (grade ?? "").trim();
  if (trimmed === "A+" || trimmed === "A") return "A";
  if (trimmed === "B") return "B";
  if (trimmed === "C") return "C";
  return null;
}

const GRADES: readonly DoctorCoverageGradeTier[] = ["A", "B", "C"];

/**
 * A norm that is null OR zero means "not held to a frequency".
 *
 * Zero has to be folded in with null here because production stores the unscored state as a
 * literal 0 ({"hcp":{"A":0,"B":0,"C":0}} since 2026-08-19). Treating that 0 as a real target would
 * make `visits >= 0` true for every contact and paint the whole population green.
 */
function normOf(standard: KpiListStandard, grade: DoctorCoverageGradeTier): number | null {
  const raw = standard.frequencyNorms[grade];
  return raw != null && raw > 0 ? raw : null;
}

/**
 * THE SMALLEST LIST WORTH SCORING, per list type.
 *
 * Owner rule, 2026-09-06: "exclude reps with less than 5 pharmacies from scoring".
 *
 * WHY A FLOOR EXISTS AT ALL. Coverage is a percentage, so a tiny panel cannot express one. A rep
 * carrying ONE pharmacy scores 0% or 100% and nothing in between: he misses it once and reads as a
 * total failure beside a colleague who missed 20 of 50. Measured on production for August 2026,
 * FIVE of the 44 reps with a pharmacy list carried fewer than five, 10 pharmacies between them —
 * and four of those five read as zero coverage purely because of the denominator.
 *
 * WHAT IT COSTS. Almost nothing: the 39 reps still scored carry 1,862 of the 1,872 pharmacies,
 * 99.5% of the population. The excluded rep is NOT hidden — his real figures still render, exactly
 * as they do for the 25 reps who carry no pharmacy list at all. Only the verdict is withheld.
 *
 * AM AND PM ARE DELIBERATELY 1, NOT 5. That half is universal — every rep is expected to carry an
 * AM/PM list, so a rep with none IS worth flagging and must keep reading as `applicable: false`
 * for the reason it already does. Raising this floor for AM or PM would silently stop flagging a
 * rep whose list was never set up, which is the opposite of what it is for.
 */
export const MIN_SCORED_PANEL: Readonly<Record<CrmListType, number>> = {
  AM: 1,
  PM: 1,
  Pharmacy: 5,
};

function emptyBlock(listType: CrmListType, workingDays: number): ListKpiBlock {
  return {
    listType,
    applicable: false,
    callRate: { visits: 0, workingDays, perWorkingDay: null, score: unscored("not-applicable") },
    coverage: { panel: 0, visited: 0, pct: null, score: unscored("not-applicable") },
    frequency: {
      scoredPanel: 0,
      met: 0,
      pct: null,
      byGrade: [],
      ungraded: 0,
      score: unscored("not-applicable"),
    },
  };
}

function buildBlock(
  listType: CrmListType,
  panel: readonly KpiPanelContact[],
  visitsByContact: ReadonlyMap<number, number>,
  /** The visits the call rate counts — `visitsByContact` stopped at yesterday in a running window. */
  callVisitsByContact: ReadonlyMap<number, number>,
  workingDays: number,
  standard: KpiListStandard,
): ListKpiBlock {
  if (panel.length < MIN_SCORED_PANEL[listType]) return emptyBlock(listType, workingDays);

  // CALL RATE — every regular Sat-Wed visit this rep made to a contact on this list, over the
  // calendar count of working days. Not the days he happened to work: twenty visits done across
  // Sunday and Monday is 20/workingDays, never 20/2.
  let visits = 0;
  // COVERAGE — a contact counts once, however many times it was seen.
  let visited = 0;
  // FREQUENCY — per grade, against that grade's own norm.
  const gradeRows = new Map<DoctorCoverageGradeTier, { panel: number; met: number }>();
  let ungraded = 0;

  for (const contact of panel) {
    const seen = visitsByContact.get(contact.contactCrmId) ?? 0;
    visits += callVisitsByContact.get(contact.contactCrmId) ?? 0;
    if (seen > 0) visited += 1;

    const tier = kpiGradeTierOf(contact.grade);
    if (!tier) {
      ungraded += 1;
      continue;
    }
    const bucket = gradeRows.get(tier) ?? { panel: 0, met: 0 };
    bucket.panel += 1;
    const norm = normOf(standard, tier);
    if (norm != null && seen >= norm) bucket.met += 1;
    gradeRows.set(tier, bucket);
  }

  const perWorkingDay = workingDays > 0 ? visits / workingDays : null;
  const coveragePct = (visited / panel.length) * 100;

  const byGrade: FrequencyGradeRow[] = GRADES.filter((grade) => gradeRows.has(grade)).map((grade) => {
    const bucket = gradeRows.get(grade)!;
    return { grade, norm: normOf(standard, grade), panel: bucket.panel, met: bucket.met };
  });

  // Only grades that actually carry a norm are in the frequency denominator. A grade the owner has
  // not set a norm for leaves the panel rather than scoring free green — the same rule
  // doctor_coverage_config states for a zero.
  const scoredRows = byGrade.filter((row) => row.norm != null);
  const scoredPanel = scoredRows.reduce((sum, row) => sum + row.panel, 0);
  const met = scoredRows.reduce((sum, row) => sum + row.met, 0);
  const frequencyPct = scoredPanel > 0 ? (met / scoredPanel) * 100 : null;

  return {
    listType,
    applicable: true,
    callRate: {
      visits,
      workingDays,
      perWorkingDay,
      score: score(perWorkingDay, standard.callRatePerDay, standard.callRateBand),
    },
    coverage: {
      panel: panel.length,
      visited,
      pct: coveragePct,
      score: score(coveragePct, standard.coverageFloorPct, null),
    },
    frequency: {
      scoredPanel,
      met,
      pct: frequencyPct,
      byGrade,
      ungraded,
      // Frequency is scored only when at least one grade on this list carries a real norm. With
      // none — today's AM and Pharmacy — the rep's own figure is still shown and the verdict reads
      // "Not scored", which is the honest answer to a standard nobody has set.
      score: scoredPanel > 0 ? score(frequencyPct, 100, null) : unscored("no-standard-set"),
    },
  };
}

/**
 * Build both reports for one rep.
 *
 * `visits` must already be narrowed to that rep's own REGULAR field visits (`effective_visit_type =
 * 0`); everything else — the Sat-Wed gate, the catch-all contact, and attribution by `list_type` —
 * is applied here so the rules live in one place rather than in each caller's SQL.
 */
export function buildRepKpiReports(input: {
  readonly repHrId: string | null | undefined;
  readonly repName: string;
  readonly month: string;
  readonly workingDays: number;
  /**
   * The last day a visit counts toward the CALL RATE — yesterday in a running window (owner ruling
   * C1, 2026-09-21), matching `workingDays`. Coverage and frequency still count every visit given.
   * Left out, every visit counts toward all three, as it always did.
   */
  readonly callRateTo?: string;
  readonly panel: readonly KpiPanelContact[];
  readonly visits: readonly KpiVisitInput[];
  readonly standards?: RepKpiStandards;
  readonly holidays?: CallRateHolidays;
}): RepKpiReports {
  const standards = input.standards ?? DEFAULT_REP_KPI_STANDARDS;

  const panelByList = new Map<CrmListType, KpiPanelContact[]>();
  const listOfContact = new Map<number, CrmListType>();
  for (const contact of input.panel) {
    if (contact.contactCrmId === CATCH_ALL_CONTACT_CRM_ID) continue;
    const bucket = panelByList.get(contact.listType) ?? [];
    bucket.push(contact);
    panelByList.set(contact.listType, bucket);
    listOfContact.set(contact.contactCrmId, contact.listType);
  }

  const visitsByContact = new Map<number, number>();
  /** The same visits, stopped at `callRateTo` — the call rate's numerator. */
  const callVisitsByContact = new Map<number, number>();
  let offListVisits = 0;
  for (const visit of input.visits) {
    // THE SAT-WED GATE. Thursday is not a working day (owner, 2026-09-05: "donot count thursday as
    // working day" / "visists to be counted from sat to wednesday only regular visits"), Friday is
    // the weekend, and a national holiday comes out too. A visit outside that set must not inflate
    // a rate whose denominator excludes the day it happened on.
    if (!isCallRateWorkingDay(visit.visitDateIso, input.holidays)) continue;
    const contactCrmId = visit.contactCrmId;
    if (contactCrmId == null || contactCrmId === CATCH_ALL_CONTACT_CRM_ID) continue;
    if (!listOfContact.has(contactCrmId)) {
      offListVisits += 1;
      continue;
    }
    visitsByContact.set(contactCrmId, (visitsByContact.get(contactCrmId) ?? 0) + 1);
    if (input.callRateTo == null || visit.visitDateIso <= input.callRateTo) {
      callVisitsByContact.set(contactCrmId, (callVisitsByContact.get(contactCrmId) ?? 0) + 1);
    }
  }

  const blockFor = (listType: CrmListType): ListKpiBlock =>
    buildBlock(
      listType,
      panelByList.get(listType) ?? [],
      visitsByContact,
      callVisitsByContact,
      input.workingDays,
      standards[listType],
    );

  const am = blockFor("AM");
  const pm = blockFor("PM");
  const pharmacies = blockFor(PHARMACY_LIST_TYPE);

  return {
    // NOT `?? ""`. That fallback is right where this codebase already uses it — the `hk` helper in
    // double-visit-analytics-workspace.tsx feeds a DISPLAY lookup, where a miss simply renders
    // nothing. Here `repKey` is a GROUPING key: callers put it in a Map or a Set (see
    // rep-kpi-reports-data.ts and getKpisBoard's visibleRepKeys), and "" is a perfectly good key,
    // so every rep the vendor sent without an hr id would silently merge into ONE row carrying the
    // sum of their panels and visits. That row looks completely ordinary — which is why the type is
    // nullable and the caller is made to decide. Pinned by runTwoKpiReportsSampleRepTests.
    repKey: canonicalHrIdKey(input.repHrId),
    repName: input.repName,
    month: input.month,
    workingDays: input.workingDays,
    ampm: {
      kind: "ampm",
      // Every rep is expected to carry AM/PM — neither list present is worth flagging, unlike a
      // missing pharmacy list.
      applicable: am.applicable || pm.applicable,
      am,
      pm,
    },
    pharmacies: {
      kind: "pharmacy",
      // NORMAL when false. 25 of 69 reps carry no pharmacy list. Render "Not applicable".
      applicable: pharmacies.applicable,
      pharmacies,
    },
    offListVisits,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation helpers — the separator rule lives here so no screen restates it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render an AM figure and a PM figure as ONE string, apart, never averaged and never with a slash.
 *
 * The owner read "1.63 / 6.57" as "1.63 out of 6.57" — a slash between two independent rates reads
 * as a fraction. The separator is " AM · " / " PM", so the pair reads as two labelled numbers.
 */
export function formatAmPmPair(am: string, pm: string): string {
  return `${am} AM · ${pm} PM`;
}

/** The word a screen shows when a KPI carries no verdict. Never "0", never "-". */
export function unscoredLabel(reason: KpiUnscoredReason): string {
  switch (reason) {
    case "not-applicable":
      return "Not applicable";
    case "no-standard-set":
      return "Not scored";
    case "empty-panel":
      return "No panel";
    case "no-working-days":
      return "No working days";
  }
}

/**
 * The two reports' display names.
 *
 * "Pharmacies" counts pharmacies; a pharmacy is NOT a contact and its row label is "Pharmacist",
 * never "Doctor" and never "Contact".
 */
export const KPI_REPORT_TITLES = {
  ampm: "Call rate, frequency and coverage — AM · PM",
  pharmacy: "Call rate, frequency and coverage — Pharmacies",
} as const;

/** Every list type this module reports on, in report order. Kept in step with LIST_TYPES. */
export const KPI_REPORTED_LIST_TYPES: readonly CrmListType[] = [...AM_PM_LIST_TYPES, PHARMACY_LIST_TYPE];

/** True when `LIST_TYPES` still holds exactly what these two reports cover. Pinned by the tests. */
export function kpiReportsCoverEveryListType(): boolean {
  return (
    LIST_TYPES.length === KPI_REPORTED_LIST_TYPES.length &&
    LIST_TYPES.every((listType) => KPI_REPORTED_LIST_TYPES.includes(listType))
  );
}
