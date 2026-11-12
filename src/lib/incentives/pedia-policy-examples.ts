// ─────────────────────────────────────────────────────────────────────────────
// The Pedia incentive policy, written out with worked examples (owner, 2026-11-12: "in Pedia
// incentive write the Pedia incentive policy with examples").
//
// The Pedia Incentive tab already stated the rule in a few lines. This module holds the full policy
// as a person reads it — numbered clauses — and a set of worked examples that cover every branch of
// the rule: both halves paid, one half under its 90% floor, the Sato half withheld by a total under
// 80%, 80% exactly, and the 150% cap.
//
// 🔒 EVERY EXAMPLE FIGURE IS COMPUTED, NEVER TYPED. Each row calls calculatePediaSplitIncentive,
// which calls the owner-locked scheme-2026 curve twice. A hand-typed table would be a second copy of
// the payout arithmetic and would drift the first time the scheme moved; this one cannot.
// `tests/pedia-policy-examples.test.ts` pins the figures a reader sees.
//
// The examples use ONE fixed, round basic salary, not the viewer's own: the tab hides salary by
// default, and an example is there to teach the rule, not to restate the viewer's pay.
// ─────────────────────────────────────────────────────────────────────────────

import {
  PEDIA_SATO_HALF_MIN_TOTAL_PERCENT,
  calculatePediaSplitIncentive,
} from "@/lib/incentives/pedia-split";

/** The basic salary every worked example is priced on — one month of it is one half. */
export const PEDIA_POLICY_EXAMPLE_BASIC_SALARY = 10_000;

/** The policy, clause by clause, in the words a Pedia seat reads. */
export const PEDIA_POLICY_CLAUSES: readonly { title: string; body: string }[] = [
  {
    title: "Who it covers",
    body: "Every Pedia seat — medical representatives, District Managers, Regional Managers and the National Sales Manager — from Semester 2 2026.",
  },
  {
    title: "How often and how much",
    body: "Paid per semester, twice a year. The semester incentive is two months of basic salary. Basic salary is 70% of the base salary.",
  },
  {
    title: "Two halves, scored separately",
    body: "The semester incentive is split into two halves of one month of basic salary each. The Sato half is scored on your Sato achievement (Guamusin and Ivyronc). The Total half is scored on your total achievement (all four Pedia products). The two halves are then added.",
  },
  {
    title: "The payout curve, read once per half",
    body: "Under 90% achievement pays 0% of that half's month. 90% pays 50%. From 90% to 100%, each 1% adds 5%. From 100% to 120%, each 1% adds 1.5%. Above 120%, each 1% adds 3%. Achievement is capped at 150%, which pays 220% of that half's month.",
  },
  {
    title: `The Sato half needs a total of ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}%`,
    body: `The Sato half is paid only when your total achievement is ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}% or more — ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}% exactly counts. Under ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}%, the Sato half pays nothing, however high your Sato achievement is. The Total half keeps its own 90% floor.`,
  },
  {
    title: "Lacto Advanced",
    body: "Lacto Advanced 1 and Lacto Advanced 2 are never scored on their own. They count only through your total achievement.",
  },
  {
    title: "Which figures count",
    body: "A medical representative is scored on their own territory's sales. A District, Regional or National Sales Manager is scored on the published Monthly Closing of the team, region or line they lead.",
  },
];

export type PediaPolicyExample = {
  key: string;
  title: string;
  satoAchievementPercent: number;
  totalAchievementPercent: number;
  /** The curve reading at the Sato achievement — the percentage of one month the Sato half earns
   * before the 80% total rule is applied. */
  satoCurvePercent: number;
  totalCurvePercent: number;
  satoHalfAmount: number;
  satoHalfWithheld: boolean;
  totalHalfAmount: number;
  payoutAmount: number;
  /** One plain sentence: why this row pays what it pays. */
  explanation: string;
};

type ExampleInput = {
  key: string;
  title: string;
  sato: number;
  total: number;
  explain: (row: Omit<PediaPolicyExample, "explanation">) => string;
};

const fmt = (value: number) => Math.round(value).toLocaleString("en-US");
const pct = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)}%`;

const EXAMPLES: readonly ExampleInput[] = [
  {
    key: "both-paid",
    title: "Both halves paid",
    sato: 95,
    total: 91,
    explain: (r) =>
      `Sato ${pct(r.satoAchievementPercent)} reads ${pct(r.satoCurvePercent)} of a month and total ${pct(r.totalAchievementPercent)} reads ${pct(r.totalCurvePercent)}: ${fmt(r.satoHalfAmount)} + ${fmt(r.totalHalfAmount)} = EGP ${fmt(r.payoutAmount)}.`,
  },
  {
    key: "strong-semester",
    title: "A strong semester",
    sato: 120,
    total: 100,
    explain: (r) =>
      `Sato ${pct(r.satoAchievementPercent)} reads ${pct(r.satoCurvePercent)} and total ${pct(r.totalAchievementPercent)} reads ${pct(r.totalCurvePercent)}: ${fmt(r.satoHalfAmount)} + ${fmt(r.totalHalfAmount)} = EGP ${fmt(r.payoutAmount)}.`,
  },
  {
    key: "equal",
    title: "Sato and total equal",
    sato: 110,
    total: 110,
    explain: (r) =>
      `Both read ${pct(r.totalCurvePercent)}, so the two halves pay the same: EGP ${fmt(r.payoutAmount)} — the same as paying two months on one achievement.`,
  },
  {
    key: "sato-only",
    title: "Total between 80% and 90%",
    sato: 150,
    total: 85,
    explain: (r) =>
      `Total ${pct(r.totalAchievementPercent)} is ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}% or more, so the Sato half pays ${pct(r.satoCurvePercent)} (the cap). Total is under 90%, so the Total half pays 0: EGP ${fmt(r.payoutAmount)}.`,
  },
  {
    key: "total-only",
    title: "Sato under 90%",
    sato: 85,
    total: 95,
    explain: (r) =>
      `Sato ${pct(r.satoAchievementPercent)} is under 90%, so the Sato half pays 0. Total ${pct(r.totalAchievementPercent)} reads ${pct(r.totalCurvePercent)}: EGP ${fmt(r.payoutAmount)}.`,
  },
  {
    key: "exactly-80",
    title: `Total exactly ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}%`,
    sato: 100,
    total: 80,
    explain: (r) =>
      `${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}% exactly counts, so the Sato half pays ${pct(r.satoCurvePercent)}. Total is under 90%, so the Total half pays 0: EGP ${fmt(r.payoutAmount)}.`,
  },
  {
    key: "withheld",
    title: `Total under ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}%`,
    sato: 130,
    total: 79,
    explain: (r) =>
      `Sato ${pct(r.satoAchievementPercent)} would read ${pct(r.satoCurvePercent)}, but total ${pct(r.totalAchievementPercent)} is under ${PEDIA_SATO_HALF_MIN_TOTAL_PERCENT}%, so the Sato half is not paid. The Total half is under 90% too: EGP ${fmt(r.payoutAmount)}.`,
  },
  {
    key: "cap",
    title: "Over the 150% cap",
    sato: 160,
    total: 155,
    explain: (r) =>
      `Both achievements are capped at 150%, which reads ${pct(r.satoCurvePercent)} per half: EGP ${fmt(r.payoutAmount)}, the most a semester can pay.`,
  },
];

/** The worked examples, every figure produced by the live rule. */
export function buildPediaPolicyExamples(
  basicSalary: number = PEDIA_POLICY_EXAMPLE_BASIC_SALARY,
): PediaPolicyExample[] {
  return EXAMPLES.map((example) => {
    const split = calculatePediaSplitIncentive({
      basicSalary,
      satoAchievementPercent: example.sato,
      totalAchievementPercent: example.total,
    });
    const row = {
      key: example.key,
      title: example.title,
      satoAchievementPercent: example.sato,
      totalAchievementPercent: example.total,
      satoCurvePercent: split.sato.payoutPercentage,
      totalCurvePercent: split.total.payoutPercentage,
      satoHalfAmount: split.satoHalfAmount,
      satoHalfWithheld: split.satoHalfWithheld,
      totalHalfAmount: split.totalHalfAmount,
      payoutAmount: split.payoutAmount,
    };
    return { ...row, explanation: example.explain(row) };
  });
}
