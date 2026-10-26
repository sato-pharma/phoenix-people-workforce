// ─────────────────────────────────────────────────────────────────────────────
// THE OVERALL KPI — the four measures consolidated into one percentage.
//
// Owner, 2026-09-17: "consolidate the result of the call rate and the coverage
// and the frequency and the KPIs in general into one percentage or one number
// ... so at the end of the day I can measure the KPIs overall from Phoenix.
// Okay, let them separated as they are and consolidate them based on average and
// mathematical actual calculations, and you must show in a line how it is
// calculated."
//
// Three instructions, and all three are load-bearing:
//
//   1. ONE NUMBER, so the board can be read at a glance.
//   2. THE FOUR STAY SEPARATE. Nothing on the board is replaced or merged — the
//      tiles, the columns, the bands and the podiums are exactly as they were.
//      This is an ADDITION, and `kpis-board.ts` still adds no fifth *measure*:
//      the index measures nothing of its own, it only averages what the four
//      already measured.
//   3. THE ARITHMETIC IS PRINTED, with this board's own numbers in it, so a
//      manager can reconcile the one number against the four beside it by hand.
//      {@link KpiIndex.formula} is that line, and the screen must always show it.
//
// ── HOW IT IS CALCULATED ─────────────────────────────────────────────────────
//
// Every one of the four is already a percentage OF ITS OWN STANDARD, which is
// what makes averaging them arithmetically legitimate rather than a mixing of
// units:
//
//   Coverage    doctors reached / doctors planned          standard: the whole list
//   Frequency   doctors on plan / doctors planned          standard: the whole list
//   AM          verified AM calls / (working days x 2)      standard: 2 a day
//   PM          verified PM calls / (working days x 10)     standard: 10 a day
//
// Overall = the mean of the measures that could be scored, each capped at 100.
//
// ── WHY EACH SCORE IS CAPPED AT 100 ─────────────────────────────────────────
//
// THIS IS THE LINE THAT KEEPS THE OWNER'S 2026-09-04 RULE INTACT, and it is not
// a rounding nicety. Uncapped, a rep who does 20 PM clinics a day and not one
// morning account reads (0 + 200) / 2 = 100% — a perfect overall score for half
// a job that never happened. That is precisely the arithmetic he banned when he
// banned the blended call rate: "this two and this ten. Don't never get average."
//
// Capping says a surplus is never currency. You can finish a measure; you cannot
// bank more than it asked for and spend it on another. The PRINTED four keep
// their real values — a 140% afternoon still reads 140% in its own column, and
// the formula line says out loud that it entered the average as 100.
//
// ── AND AM/PM STILL NEVER MEET ──────────────────────────────────────────────
//
// AM and PM enter as TWO independent components, each against its own target.
// Nothing here computes, stores, returns or prints a combined call rate: there
// is no intermediate "call rate" number in this file, and `components` carries
// the two apart the whole way through. The owner's ban is on merging two
// standards into one CALL RATE figure; this is the overall KPI, which he asked
// for on 2026-09-17, and it reaches that number without ever forming the banned
// one. `tests/kpi-index.test.ts` pins both halves of that.
//
// ── WHAT IS LEFT OUT, AND WHY ───────────────────────────────────────────────
//
// PHARMACIES. There is no pharmacy target yet (PHARMACY_CALL_RATE_TARGET is
// null — a parked question from 2026-09-05), so there is nothing to be a
// percentage of, and inventing a denominator to get a fifth component into the
// average would put a made-up number inside the one figure the owner reads. It
// is named as excluded on the line rather than silently dropped, and the day he
// sets a target it joins as a fifth component with nothing else to change.
//
// A MEASURE NOBODY COULD SCORE. A rep with no planned doctors has no coverage
// and no frequency — he is not a 0% performer, which is the whole reason
// `hasMeasurablePlan` exists — so those two drop OUT of his average and the
// divisor drops with them. A rep who logged nothing loses AM and PM the same
// way. When none of the four can be scored the index is null, never zero.
// ─────────────────────────────────────────────────────────────────────────────

/** The measures the overall percentage is built from, in the order it prints them. */
export const KPI_INDEX_COMPONENT_KEYS = ["coverage", "frequency", "am", "pm"] as const;

export type KpiIndexComponentKey = (typeof KPI_INDEX_COMPONENT_KEYS)[number];

/** The short name each component answers to on the line. Matches the tiles and the columns. */
export const KPI_INDEX_COMPONENT_LABEL: Record<KpiIndexComponentKey, string> = {
  coverage: "Coverage",
  frequency: "Frequency",
  am: "AM",
  pm: "PM",
};

export type KpiIndexComponent = {
  key: KpiIndexComponentKey;
  label: string;
  /** What the board prints for this measure. Null when it could not be scored at all. */
  measuredPct: number | null;
  /** What entered the average: `measuredPct` capped at 100 and floored at 0. Null when excluded. */
  scoredPct: number | null;
  /** True when the cap actually bit, i.e. the measure ran above its own standard. */
  capped: boolean;
  /** Set exactly when `scoredPct` is null — in the owner's words, never a code reason. */
  excludedBecause: string | null;
};

export type KpiIndex = {
  /**
   * The consolidated score, a whole percentage. Null when not one of the four could be scored —
   * which is an absence, never a zero, exactly as `hasMeasurablePlan` is for coverage.
   */
  overallPct: number | null;
  /** All four, scored or excluded, so the UI can show what did and did not count. */
  components: KpiIndexComponent[];
  /** How many components the average divided by. 0 exactly when `overallPct` is null. */
  counted: number;
  /**
   * THE LINE THE OWNER ASKED FOR — the arithmetic with this board's own numbers in it, so the one
   * figure can be reconciled against the four beside it without a calculator. Never a formula in
   * the abstract: the values are the values on screen.
   */
  formula: string;
  /** The rule, said once and independent of the numbers. Sits under {@link formula}. */
  method: string;
};

/** Everything the index needs off a rep row or a team total. A subset of both, on purpose. */
export type KpiIndexInput = {
  coveragePct: number;
  frequencyPct: number;
  /** False when nothing was planned: coverage and frequency then have no denominator. */
  hasMeasurablePlan: boolean;
  amAttainmentPct: number | null;
  pmAttainmentPct: number | null;
  /**
   * False when the CRM holds no row for this rep in the window at all. Team totals pass `true`
   * whenever there are reps — the flag is a per-rep absence, not a team one.
   */
  hasCallRate: boolean;
  /** Ruling A1 (owner, 2026-09-21): calls logged, no GPS feed to prove them — so AM and PM leave the
   * average for THAT reason, never "no working days". */
  noGpsFeed?: boolean;
  /** Hired inside the window with too few working days to judge (`kpiJustStartedOf` in
   * kpis-filters.ts): every measure leaves the average, so the overall is null, never a 0%. Takes the
   * row's own `{ workingDaysIn }` too, so a whole rep row can be passed in as it stands. */
  justStarted?: boolean | { workingDaysIn: number } | null;
};

/** The fixed half of the explanation. Printed under the formula, and identical on every board. */
export const KPI_INDEX_METHOD =
  "Each measure is scored against its own standard, capped at 100%, and the four scores are " +
  "averaged with equal weight. AM is scored against 2 calls a day and PM against 10: they enter " +
  "as two separate measures and are never averaged into a single call rate. A measure nobody " +
  "could score leaves the average and the divisor with it. Pharmacies are left out — no target " +
  "has been set for them yet.";

const clampToStandard = (value: number): number => Math.max(0, Math.min(100, value));

/** Why a rep who DID log calls has no AM or PM attainment. */
const callRateGap = (input: KpiIndexInput): string => (input.noGpsFeed ? "no GPS feed" : "no working days");

/**
 * The overall KPI for one rep, or for a whole team from its totals.
 *
 * Pure arithmetic on numbers the board already computed — it re-derives nothing, so the one figure
 * and the four it came from can never disagree. Give it the team's `totals` and it answers for the
 * team; give it a row and it answers for that rep.
 */
export function kpiIndexOf(input: KpiIndexInput): KpiIndex {
  const raw: Array<{ key: KpiIndexComponentKey; measuredPct: number | null; excludedBecause: string | null }> = [
    {
      key: "coverage",
      measuredPct: input.hasMeasurablePlan ? input.coveragePct : null,
      excludedBecause: input.hasMeasurablePlan ? null : "nothing planned",
    },
    {
      key: "frequency",
      measuredPct: input.hasMeasurablePlan ? input.frequencyPct : null,
      excludedBecause: input.hasMeasurablePlan ? null : "nothing planned",
    },
    {
      key: "am",
      measuredPct: input.hasCallRate ? input.amAttainmentPct : null,
      excludedBecause: input.hasCallRate ? (input.amAttainmentPct == null ? callRateGap(input) : null) : "no calls logged",
    },
    {
      key: "pm",
      measuredPct: input.hasCallRate ? input.pmAttainmentPct : null,
      excludedBecause: input.hasCallRate ? (input.pmAttainmentPct == null ? callRateGap(input) : null) : "no calls logged",
    },
  ];

  const components: KpiIndexComponent[] = raw.map((entry) => {
    const measuredPct = input.justStarted ? null : entry.measuredPct;
    const scoredPct = measuredPct == null ? null : clampToStandard(measuredPct);
    return {
      key: entry.key,
      label: KPI_INDEX_COMPONENT_LABEL[entry.key],
      measuredPct,
      scoredPct,
      capped: measuredPct != null && measuredPct > 100,
      excludedBecause:
        scoredPct == null ? (input.justStarted ? "just started" : (entry.excludedBecause ?? "not measurable")) : null,
    };
  });

  const scored = components.filter((component) => component.scoredPct != null);
  const counted = scored.length;
  // Rounded ONCE, at the end. Every component arrives as a whole percentage (kpis-board.ts rounds
  // each of the four), so the sum and the divisor on the printed line reproduce this exactly by
  // hand — which is the only way a manager can check it.
  const overallPct =
    counted === 0 ? null : Math.round(scored.reduce((total, component) => total + (component.scoredPct ?? 0), 0) / counted);

  return {
    overallPct,
    components,
    counted,
    formula: kpiIndexFormula(components, overallPct, counted),
    method: KPI_INDEX_METHOD,
  };
}

/**
 * The printed arithmetic.
 *
 * Reads as a sum, a divisor and a result — `(97 + 61 + 43 + 94) ÷ 4 = 74%` with each number named —
 * because that is the shape a person checks. Anything the average did not simply add is said out
 * loud after it: a measure that ran over its standard, and a measure that could not be scored.
 */
function kpiIndexFormula(
  components: readonly KpiIndexComponent[],
  overallPct: number | null,
  counted: number,
): string {
  const scored = components.filter((component) => component.scoredPct != null);
  if (counted === 0 || overallPct == null) {
    return "No measure could be scored in this period, so there is no overall percentage — that is an absence, not a zero.";
  }
  const sum = scored.reduce((total, component) => total + (component.scoredPct ?? 0), 0);
  const addends = scored.map((component) => `${component.label} ${component.scoredPct}`).join(" + ");
  const sentences = [`(${addends}) = ${sum}, ÷ ${counted} measure${counted === 1 ? "" : "s"} = ${overallPct}%`];

  const capped = components.filter((component) => component.capped);
  if (capped.length > 0) {
    // NAMED, because the number on the line no longer matches the column beside it. A surplus is
    // never currency here — see the header.
    sentences.push(
      capped
        .map((component) => `${component.label} ran at ${component.measuredPct}% and counted as 100`)
        .join("; ") + " — a measure above its standard cannot pay for one below it",
    );
  }

  const excluded = components.filter((component) => component.scoredPct == null);
  if (excluded.length > 0) {
    sentences.push(
      `left out: ${excluded.map((component) => `${component.label} (${component.excludedBecause})`).join(", ")}`,
    );
  }

  return sentences.join(" · ");
}
