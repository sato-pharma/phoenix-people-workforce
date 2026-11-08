// ─────────────────────────────────────────────────────────────────────────────
// The Pedia split incentive — one semester incentive paid as TWO independent halves.
//
// OWNER RULE, settled 2026-09-23 after a long clarification: on the Pedia line only, the semester
// incentive (two months of basic salary) stops being one figure scored on one achievement. It
// splits into two halves that are scored, and paid, SEPARATELY:
//
//     Sato half   = one month of basic  x  the 2026 curve applied to the SATO achievement
//     Total half  = one month of basic  x  the 2026 curve applied to the TOTAL achievement
//     payout      = Sato half + Total half
//
// Pedia carries four products in two groups (confirmed against au.monthly_targets in production on
// 2026-09-23 — exactly these four codes carry a 2026 Pedia target, 108 rows each):
//
//     SATO       GU001 Guamusin, IV001 Ivyronc
//     OUTSOURCE  LA001 Lacto Advanced 1, LA002 Lacto Advanced 2
//
// ⚠ OUTSOURCE ACHIEVEMENT IS NEVER SCORED ON ITS OWN, and that was the hard-won correction. The
// rule was first modelled here as a 2x2 GATE — both groups over 90% pays in full, one of them pays
// half — and the owner rejected it in his own words: "i dont care about outsource achievemnt ...
// if ex sat ach is 95% and tot is 91% then incentive should be 75% of month for sato and 55% of
// month for tot". That is not a gate, it is a sum of two curve readings. Outsource moves the payout
// only through its contribution to TOTAL. Two rows separate the two models and both were checked
// against him: 95/91 pays 13,650 under this rule and 5,775 under the gate, and a rep over 90% on
// Sato with the line under 90% pays 5,250 rather than the gate's full amount.
//
// 🔴 THE SATO HALF NEEDS THE TOTAL AT 80% OR MORE (owner, 2026-11-08, on Dr Anwar's instruction,
// Semester 2 2026 onward, Pedia only — "others as they are"). The Sato targets are small (12.7% of
// Pedia's target value, Jul–Sep 2026) and the half they unlock is a whole month of basic, so teams
// were steered to hit Guamusin and Ivyronc and leave Lacto Advanced. From this rule on: total under
// 80% and the Sato half pays NOTHING, however high Sato is. The total half is unchanged (its own 90%
// floor on the curve). 80% exactly passes — his words were "less than 80%" gets nothing. This is a
// condition on the Sato half alone, not the 2x2 gate above that he refused: it never pays the total
// half off Sato, and it never touches the curve. On the July–September closing it withheld the Sato
// half from two reps (Sato 224.4% / total 79.5%, Sato 126.6% / total 65.2%) and one District Manager
// (Sato 90.2% / total 49.4%). `satoHalfWithheld` tells the tab to say why the half reads zero.
//
// 🔒 THE OWNER-LOCKED CURVE IS NOT TOUCHED. src/lib/incentives/scheme-2026.ts stays byte-identical:
// this module CALLS it twice and halves each answer. That is deliberate and it must stay that way —
// the curve, the 90% floor, the 150% achievement cap and the 220% payout ceiling are all still the
// single implementation, so a future change to the scheme reaches Pedia for free and no second copy
// of the payout arithmetic can drift from it.
//
// IT REDUCES EXACTLY TO TODAY'S RULE. (The 80% condition cannot break this: equal achievements
// only pay at 90% or more, which is already over 80%.) When the two achievements are equal — which is every rep on
// every other line, and every Pedia rep whose groups happen to track — half + half is the identical
// figure the single calculation produced. So this is not a new scheme sitting beside the old one;
// it is the old one with the numerator split in two. `tests/pedia-split-incentive.test.ts` pins that
// identity across the whole curve.
//
// Pure: no clock, no database, no access context. The achievements are measured elsewhere
// (src/lib/incentives/pedia-achievement.ts) and passed in.
// ─────────────────────────────────────────────────────────────────────────────

import { calculateIncentive2026, type IncentiveCalculation } from "@/lib/incentives/scheme-2026";
import type { SemesterKey } from "@/lib/incentives/semester";

/**
 * The two Sato products. CODES, never display names.
 *
 * Product names are editable and have already split once on this line — "Lacto Advanced" and
 * "Lacto Basic" were one name until the families were renamed, while their family_code stayed
 * shared. A name match here would silently move money the day somebody tidies a label; the code is
 * the stable key the closing engine itself joins on.
 */
export const PEDIA_SATO_PRODUCT_CODES = ["GU001", "IV001"] as const;

/**
 * The two outsource products, listed for completeness and for the UI's own labelling.
 *
 * NOT used as a scoring input: no half is ever computed from outsource achievement. It is here so a
 * reader can see what "Total minus Sato" consists of, and so the tab can name the products.
 */
export const PEDIA_OUTSOURCE_PRODUCT_CODES = ["LA001", "LA002"] as const;

/**
 * The first semester the split applies to (owner: "all pedia seats, from H2 2026", 2026-09-23 —
 * spelled Semester 2 everywhere a person reads it, per the same instruction).
 *
 * Semester 1 2026 is CLOSED and is never restated, so the gate is a floor rather than a window: the
 * split applies from here forward, and everything before it keeps the single-figure rule it was
 * actually paid on. Lexical comparison is chronological for this key shape (`2026-S1` < `2026-S2` <
 * `2027-S1`), which is why the key is formatted the way it is.
 */
export const PEDIA_SPLIT_FIRST_SEMESTER: SemesterKey = "2026-S2";

/**
 * The total achievement the Sato half needs before it can pay anything (owner, 2026-11-08, on
 * Dr Anwar's instruction). Under it, the Sato half is withheld whatever the Sato achievement.
 *
 * It starts in the same semester the split does (Semester 2 2026, his choice), so it rides on
 * `pediaSplitApplies` and needs no date of its own: every call of `calculatePediaSplitIncentive`
 * is already a Pedia seat in a split semester. Other lines never reach this module's payout.
 */
export const PEDIA_SATO_HALF_MIN_TOTAL_PERCENT = 80;

/** True when the total achievement lets the Sato half pay — 80% exactly passes. */
export function pediaSatoHalfUnlocked(totalAchievementPercent: number): boolean {
  return Number.isFinite(totalAchievementPercent) && totalAchievementPercent >= PEDIA_SATO_HALF_MIN_TOTAL_PERCENT;
}

const satoCodeSet = new Set<string>(PEDIA_SATO_PRODUCT_CODES);

/** True for one of the two Sato product codes. Case- and whitespace-insensitive. */
export function isPediaSatoProductCode(productCode: string | null | undefined): boolean {
  return satoCodeSet.has(String(productCode ?? "").trim().toUpperCase());
}

/**
 * True for the Pedia line, given whatever form the caller holds — the official name ("Pedia",
 * "Pediatrics"), the achievement row's line code ("pedia"), or a casing variant of either.
 *
 * Deliberately narrow: anything it does not recognise is NOT Pedia, so an unrecognised line falls
 * back to the single-figure rule rather than being paid on a split nobody agreed to.
 */
export function isPediaLine(line: string | null | undefined): boolean {
  const normalized = String(line ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "pedia" || normalized === "pediatrics";
}

/** True once `semester` is at or after the first semester the split covers. */
export function isPediaSplitSemester(semester: SemesterKey | null | undefined): boolean {
  if (!semester) return false;
  return String(semester) >= PEDIA_SPLIT_FIRST_SEMESTER;
}

/**
 * Does this seat get the split? Line AND semester, both.
 *
 * ALL PEDIA SEATS (owner, 2026-09-23) — reps, District Managers, Regional and National Sales
 * Managers alike. There is deliberately no role test here: a manager is measured on the same two
 * achievements his line is, so scoring him on one figure while his reps are scored on two would put
 * two different rules on one line.
 */
export function pediaSplitApplies(input: {
  line: string | null | undefined;
  semester: SemesterKey | null | undefined;
}): boolean {
  return isPediaLine(input.line) && isPediaSplitSemester(input.semester);
}

/** Everything `calculateIncentive2026` takes except the achievement — the salary basis alone. */
export type IncentiveSalaryBasis = {
  basicSalary?: number;
  baseSalary?: number;
  employmentIncomeTax?: number;
  extraCostOfLiving?: number;
  fuelAllowance?: number;
  grossSalary?: number;
  netSalary?: number;
  socialInsurance?: number;
  taxes?: number;
};

export type PediaSplitIncentive = {
  /** The full-semester calculation scored on SATO achievement. Its `payoutAmount` is the WHOLE
   * incentive at that achievement; the half actually paid is `satoHalfAmount`. */
  sato: IncentiveCalculation;
  /** The same, scored on TOTAL achievement. */
  total: IncentiveCalculation;
  /** One month of basic x the curve at Sato achievement — half of `sato.payoutAmount` — or 0 when
   * the total is under `PEDIA_SATO_HALF_MIN_TOTAL_PERCENT`. */
  satoHalfAmount: number;
  /** True when the Sato curve would have paid but the total under 80% withheld it — the one case
   * the tab must explain, because the Sato percentage on screen looks like it earned money. */
  satoHalfWithheld: boolean;
  /** One month of basic x the curve at Total achievement. Half of `total.payoutAmount`. */
  totalHalfAmount: number;
  /** What the rep is paid: the two halves added. */
  payoutAmount: number;
  /** That payout as a percentage of the semester incentive, for the same presentation the
   * single-figure rule uses. */
  payoutPercentage: number;
  /** Two months of basic salary — unchanged by the split, and the ceiling both halves share. */
  semesterTargetIncentive: number;
  basicSalary: number;
  netSalary: number;
};

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * The Pedia payout: the curve read twice, each reading worth one month of basic salary.
 *
 * ROUNDING: each half is rounded before they are added, and the total is the sum of the two rounded
 * halves. Rounding the sum instead would leave the two figures on screen failing to add up to the
 * one underneath them by a piastre — and this tab exists to be read by the person being paid from
 * it. The difference is at most one cent and it always favours what a reader can verify.
 *
 * `payoutPercentage` is DERIVED from the money rather than averaged from the two curve percentages,
 * so it can never disagree with the amount beside it.
 */
export function calculatePediaSplitIncentive(
  params: IncentiveSalaryBasis & {
    satoAchievementPercent: number;
    totalAchievementPercent: number;
  },
): PediaSplitIncentive {
  const { satoAchievementPercent, totalAchievementPercent, ...salaryBasis } = params;

  const sato = calculateIncentive2026({ ...salaryBasis, achievementPercent: satoAchievementPercent });
  const total = calculateIncentive2026({ ...salaryBasis, achievementPercent: totalAchievementPercent });

  // The Sato half pays only with the total at 80% or more (owner, 2026-11-08). The curve is still
  // read as it is, so `sato` keeps what the Sato achievement alone would earn.
  const satoUnlocked = pediaSatoHalfUnlocked(totalAchievementPercent);
  const satoHalfAmount = satoUnlocked ? roundMoney(sato.payoutAmount / 2) : 0;
  const satoHalfWithheld = !satoUnlocked && sato.payoutAmount > 0;
  const totalHalfAmount = roundMoney(total.payoutAmount / 2);
  const payoutAmount = roundMoney(satoHalfAmount + totalHalfAmount);

  // Both calls share one salary basis, so the two semester incentives are the same number; taking
  // it from `total` rather than averaging keeps it exact.
  const semesterTargetIncentive = total.semesterTargetIncentive;

  return {
    basicSalary: total.basicSalary,
    netSalary: total.netSalary,
    payoutAmount,
    payoutPercentage:
      semesterTargetIncentive > 0 ? roundMoney((payoutAmount / semesterTargetIncentive) * 100) : 0,
    sato,
    satoHalfAmount,
    satoHalfWithheld,
    semesterTargetIncentive,
    total,
    totalHalfAmount,
  };
}
