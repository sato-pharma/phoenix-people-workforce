// Which months, and which distributors within a month, actually made it into Source of Sales.
//
// Nothing in the pipeline notices a month that was never uploaded. On 2026-07-31 production held
// batches for 2026-01, 02, 03, 04 and 06 — **2026-05 is simply absent**, and 2026-07 is empty — yet
// every trend line drew straight through the gap and every month-over-month comparison treated the
// jump as a real movement.
//
// Per-distributor coverage varies too, which is the subtler problem: January is missing EP-BK and
// EP-PHS entirely (~3.5M EGP using February as the proxy), February is missing SF, February and
// March are missing RM-T, March is missing EG-HOS, June is missing CP, and January-March are missing
// SF-T. So "January 39.7M vs February 32.2M" is not a like-for-like comparison at all — it partly
// measures which files were uploaded.
//
// This module answers that with data the batch table already carries: no new RPC, no new table.
// Pure functions over a batch list so they are unit-testable; the caller does the one select.
//
// THREE KINDS OF ABSENCE ARE NOT HOLES, and reporting them as holes is what makes a banner easy to
// dismiss — which costs the real gaps their audience. `source-coverage.ts` learned the same lesson
// on the closing screen, where the retired Direct sheet warned every month about a file that will
// never arrive again.
//
//   1. A source that changed VINTAGE. DIRECT became DirectReq in 2026-08, so without the fold this
//      reads "DIRECT is missing from 2026-09" about a channel that landed 880,976.70 EGP that
//      month. The fold already exists in `direct-channel.ts` and this module was the last consumer
//      not using it.
//   2. A source whose file was MERGED into another for a stretch of months. EPDA sent one combined
//      pharmacies file for 2026-07 and 2026-08, so EP-BK has no batch of its own there — and this
//      module valued that silence at roughly 24.16M EGP, the largest single "hole" on the board,
//      while EP-PHS's own value jumped from 998K (June) to 8.16M and 12.02M in exactly those two
//      months. From the September closing the bulk sector uploads on its own again (owner,
//      2026-10-09), so a September absence IS a hole and must still be reported — the window ENDS.
//   3. A source that did not EXIST yet. El Qema was onboarded in September 2026 for its August
//      book — its master row was created 2026-09-06 and it has never had a batch outside 2026-08
//      and 2026-09 — so the seven months before it were priced at roughly 10.54M EGP of "missing"
//      sales that nobody can ever upload. That estimate made it the third-largest hole on the
//      board and inflated the count of distributors said to have gaps.
//
// All three are DECLARED, never inferred from first appearance. "Onboarded in February" and
// "January was never uploaded" are indistinguishable in this table — the whole history was
// backfilled over three days — so inferring would have hidden the real January EP-BK / EP-PHS hole
// (~3.5M EGP) this module exists to surface. A declaration is also outvoted by the data: an upload
// before the declared first month withdraws it entirely.

import { canonicalDistributorKey, DIRECT_CHANNEL_CODE, DIRECT_CHANNEL_LABEL } from "@/lib/sales/direct-channel";
import { isFuturePeriod } from "@/lib/sales/periods";

/** One validated batch, as read from source_of_sales_import_batches. */
export type SosCoverageBatch = {
  period: string;
  distributorCode: string;
  /** The human-entered name on the batch. Standing rule: report names, never raw codes. */
  distributorName?: string | null;
  totalValue: number | null;
};

/**
 * A source whose own file was folded into ANOTHER source's for a bounded stretch of months.
 *
 * Bounded deliberately: an open-ended "EP-BK is merged now" would also hide the September-onward
 * absences that the EPDA-BULK contribution allocation depends on — that rule spreads the bulk
 * sector's Pedia units over the line's areas from the 2026-09 closing, and with no upload there is
 * nothing to spread.
 */
export type MergedSourceWindow = {
  /** The source with no batch of its own. */
  code: string;
  /** The source whose file carried it. */
  into: string;
  /** First period of the merge, inclusive — "YYYY-MM". */
  from: string;
  /** Last period of the merge, inclusive. The month AFTER this one expects its own file again. */
  until: string;
};

/**
 * The merges this repo knows about, as measured on production.
 *
 * EP-BK → EP-PHS for 2026-07 and 2026-08: EPDA switched to one combined pharmacies file in July
 * 2026. The window CLOSES at August because the owner's 2026-10-09 ruling has the bulk sector
 * arriving as its own "ساتو قطاع جملة" upload under EP-BK again from the September closing.
 */
export const MERGED_SOURCE_WINDOWS: readonly MergedSourceWindow[] = [
  { code: "EP-BK", into: "EP-PHS", from: "2026-07", until: "2026-08" },
];

/** The merge window covering this source in this period, or null. Codes are compared folded. */
export function mergedSourceWindowFor(code: string, period: string): MergedSourceWindow | null {
  const key = canonicalDistributorKey(code);
  for (const window of MERGED_SOURCE_WINDOWS) {
    if (canonicalDistributorKey(window.code) !== key) continue;
    if (period >= window.from && period <= window.until) return window;
  }
  return null;
}

/**
 * A source whose first month as a source is KNOWN — it supplied nothing before it, so the earlier
 * months are not gaps and no upload can ever close them.
 */
export type SourceOnboarding = {
  /** The source's code, compared folded. */
  code: string;
  /** Its first month as a source, inclusive — "YYYY-MM". Nothing before this is expected. */
  from: string;
  /** Why, in one line, for the reader of this file. */
  reason: string;
};

/**
 * The onboardings this repo knows about, as measured on production.
 *
 * QM (El Qema) from 2026-08: the distributor master row was created 2026-09-06 and the first batch
 * 2026-09-07, both for the August book, and no El Qema row of any status exists outside 2026-08 and
 * 2026-09. Declared rather than inferred for the reason in the header, and note that El Qema's NAME
 * is masked for every viewer but Super Admin — dropping its phantom gap is not a substitute for
 * `maskSosCoverageReport`, which still guards the day El Qema genuinely misses a month.
 */
export const SOURCE_ONBOARDINGS: readonly SourceOnboarding[] = [
  {
    code: "QM",
    from: "2026-08",
    reason: "El Qema's first month as a source is August 2026 — it supplied nothing before that.",
  },
  {
    code: "EZB",
    from: "2026-10",
    reason: "El Ezaby was added as a distributor on 2026-11-10 for its October 2026 book — nothing before that.",
  },
];

/** The declared onboarding for this source, or null. Codes are compared folded. */
export function sourceOnboardingFor(code: string): SourceOnboarding | null {
  const key = canonicalDistributorKey(code);
  for (const onboarding of SOURCE_ONBOARDINGS) {
    if (canonicalDistributorKey(onboarding.code) === key) return onboarding;
  }
  return null;
}

export type SosDistributorCoverage = {
  /** The FOLDED code — both Direct vintages share one row. */
  distributorCode: string;
  /** Human-readable name (standing rule: names, never raw codes). Falls back to the code. */
  name: string;
  /** Periods (of those loaded) where this distributor has no batch at all. */
  missingPeriods: string[];
  /**
   * Periods where it has no batch of its own because its file was MERGED into another source's —
   * absent on purpose, so they are excluded from `missingPeriods` and from the estimate. Reported
   * rather than silently dropped, so a reader can see WHY the months are quiet.
   */
  mergedPeriods: string[];
  /** The source that carried it through `mergedPeriods`, by name. Null when nothing was merged. */
  mergedInto: string | null;
  /** That source's code — what the El Qema mask recognises it by. Null when nothing was merged. */
  mergedIntoCode: string | null;
  /**
   * Its declared first month as a source, when one is declared AND the data agrees. Null otherwise,
   * including when an upload before that month withdrew the declaration.
   */
  onboardedAt: string | null;
  /**
   * Periods before `onboardedAt`. Absent because the source did not exist yet, so they are excluded
   * from `missingPeriods` and from the estimate — reported rather than silently dropped. Carries no
   * name, so the El Qema mask has nothing to strip here.
   */
  preOnboardingPeriods: string[];
  /**
   * Missing periods that sit BETWEEN two months this distributor did land in. These are
   * unambiguous holes — the distributor demonstrably existed on both sides.
   */
  interiorMissingPeriods: string[];
  /** First loaded period this distributor appears in. Lets the UI say "first seen 2026-02". */
  firstSeen: string;
  /** Mean value across the periods it DID land in — the scale of what a gap is hiding. */
  averageValue: number;
  /** averageValue x missingPeriods.length. An estimate, explicitly not a measurement. */
  estimatedMissingValue: number;
};

/**
 * A distributor named as absent from a month.
 *
 * Both halves travel together because the display rule and the El Qema mask need different ones:
 * the name is what a reader sees (standing rule: names, never codes), and the code is the only
 * thing `maskSosCoverageReport` can recognise a masked source by once the name is a free-text
 * label. A name-only list could not be masked at all.
 */
export type SosMissingDistributor = {
  code: string;
  name: string;
};

export type SosPeriodCoverage = {
  period: string;
  distributorCount: number;
  totalValue: number;
  /** Distributors seen in ANY examined period but absent from this one — a merge is not an absence. */
  missingDistributors: SosMissingDistributor[];
  /**
   * True when this period is missing at least one distributor that other periods have. A trend
   * chart must mark these rather than plotting them as a real decline.
   */
  incomplete: boolean;
};

/** A source that was absent on purpose for a stretch, because another source's file carried it. */
export type SosMergedSource = {
  /** The folded display code of the source with no file of its own. */
  distributorCode: string;
  /** Its name, for the banner. */
  name: string;
  /** The name of the source whose file carried it. */
  into: string;
  /** That source's code — what the El Qema mask recognises it by. */
  intoCode: string;
  /** The periods it was carried through, oldest first. */
  periods: string[];
};

export type SosCoverageReport = {
  /** Every period that has at least one batch, oldest first. */
  loadedPeriods: string[];
  /**
   * Calendar months between the first and last loaded period with NO batches at all — the 2026-05
   * case. Empty when the loaded periods are contiguous.
   */
  missingPeriods: string[];
  periods: SosPeriodCoverage[];
  distributors: SosDistributorCoverage[];
  /**
   * Absences explained by a merge, listed so the quiet months are visible without being counted as
   * holes. Deliberately NOT part of `hasGaps`: nothing here needs anyone to upload anything.
   */
  mergedSources: SosMergedSource[];
  /** True when anything at all is missing — the single flag a dashboard needs to show a warning. */
  hasGaps: boolean;
};

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Every calendar month from `from` to `to` inclusive, both "YYYY-MM". */
export function enumeratePeriods(from: string, to: string): string[] {
  if (!PERIOD_RE.test(from) || !PERIOD_RE.test(to) || from > to) return [];
  const out: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  // Bounded by construction, but keep a hard stop so a malformed input can never spin.
  for (let i = 0; i < 600; i += 1) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    if (year === endYear && month === endMonth) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Build the coverage report. Pure — unit-tested directly.
 *
 * A distributor is only expected in a period once it has appeared at least once anywhere in the
 * examined window; a distributor that was onboarded in March is not reported "missing" from January.
 * That keeps the report actionable rather than noisy.
 *
 * THE FUTURE-MONTH RULE: a month after `today` (Cairo) is not part of the examined window. A Direct
 * order collecting next month legitimately books a Direct-only batch into it, and counting that
 * month made every other distributor "missing" from it — the banner named a month that had not
 * started and the company-wide estimate (average × missing months) was inflated by it.
 */
export function buildSosCoverageReport(batches: SosCoverageBatch[], today?: string): SosCoverageReport {
  const valid = batches.filter(
    (b) => PERIOD_RE.test(b.period ?? "") && !isFuturePeriod(b.period, today) && (b.distributorCode ?? "").trim() !== "",
  );

  const loadedPeriods = [...new Set(valid.map((b) => b.period))].sort();
  if (loadedPeriods.length === 0) {
    return {
      loadedPeriods: [],
      missingPeriods: [],
      periods: [],
      distributors: [],
      mergedSources: [],
      hasGaps: false,
    };
  }

  // Months with no batches at all, inside the loaded range.
  const loadedSet = new Set(loadedPeriods);
  const missingPeriods = enumeratePeriods(loadedPeriods[0], loadedPeriods[loadedPeriods.length - 1]).filter(
    (p) => !loadedSet.has(p),
  );

  // period -> distributor KEY -> summed value (a distributor can have more than one batch in a
  // month, and the two Direct vintages are one distributor).
  const byPeriod = new Map<string, Map<string, number>>();
  // The code and name to SHOW for each key. Taken from the latest batch that carries one, so a
  // distributor renamed mid-year reads under its current name.
  const displayCode = new Map<string, string>();
  const displayName = new Map<string, string>();
  const firstSeen = new Map<string, string>();

  for (const batch of [...valid].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0))) {
    const raw = batch.distributorCode.trim();
    const key = canonicalDistributorKey(raw);
    if (!key) continue;
    const perPeriod = byPeriod.get(batch.period) ?? new Map<string, number>();
    perPeriod.set(key, (perPeriod.get(key) ?? 0) + Number(batch.totalValue ?? 0));
    byPeriod.set(batch.period, perPeriod);

    // Casing is kept as stored for every other distributor — the dashboard marks a row selected by
    // comparing its code against the picker's option, which comes from the master in its own casing.
    displayCode.set(key, key === DIRECT_CHANNEL_CODE ? DIRECT_CHANNEL_CODE : raw);
    const name = String(batch.distributorName ?? "").trim();
    if (key === DIRECT_CHANNEL_CODE) displayName.set(key, DIRECT_CHANNEL_LABEL);
    else if (name) displayName.set(key, name);

    const seen = firstSeen.get(key);
    if (!seen || batch.period < seen) firstSeen.set(key, batch.period);
  }

  const nameOf = (key: string): string => displayName.get(key) ?? displayCode.get(key) ?? key;

  /**
   * Was this source's absence covered by a merge that MONTH, with the absorbing file actually there?
   *
   * The second half is the guard that makes this safe. A window alone would excuse the month on
   * trust: if EPDA sends nothing at all in July, EP-BK and EP-PHS are both missing and the month is
   * a real hole — reading the window would silence the larger of the two.
   */
  const mergedAwayIn = (key: string, period: string): MergedSourceWindow | null => {
    const window = mergedSourceWindowFor(key, period);
    if (!window) return null;
    return byPeriod.get(period)?.has(canonicalDistributorKey(window.into)) ? window : null;
  };

  /**
   * The declared onboarding for this source, or null when the DATA outvotes it.
   *
   * A batch earlier than the declared first month means the declaration is wrong or stale, and the
   * safe reading is the strict one: withdraw it and expect the source in every loaded period, so a
   * genuinely missing month can never hide behind an out-of-date line in this file.
   */
  const onboardingOf = (key: string): SourceOnboarding | null => {
    const declared = sourceOnboardingFor(key);
    if (!declared) return null;
    const earliest = firstSeen.get(key);
    return earliest && earliest < declared.from ? null : declared;
  };

  /** True when this period is before the source existed at all. */
  const beforeOnboarding = (key: string, period: string): boolean => {
    const onboarding = onboardingOf(key);
    return onboarding != null && period < onboarding.from;
  };

  const periods: SosPeriodCoverage[] = loadedPeriods.map((period) => {
    const perPeriod = byPeriod.get(period) ?? new Map<string, number>();
    // Expected in EVERY loaded period, not only from its first appearance onward.
    //
    // The narrower "only after first seen" rule reads well in the abstract and is wrong for this
    // dataset: the whole SoS history was backfilled over three days, so a distributor whose January
    // file was simply never uploaded looks identical to one onboarded in February — and the rule
    // would have hidden exactly the January EP-BK / EP-PHS hole (~3.5M EGP) that this module exists
    // to surface. `firstSeen` is reported alongside so a genuine onboarding is still explainable
    // rather than silently dropped.
    const missingDistributors = [...firstSeen.keys()]
      .filter((key) => !perPeriod.has(key) && !mergedAwayIn(key, period) && !beforeOnboarding(key, period))
      .map((key) => ({ code: displayCode.get(key) ?? key, name: nameOf(key) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      period,
      distributorCount: perPeriod.size,
      totalValue: round2([...perPeriod.values()].reduce((sum, v) => sum + v, 0)),
      missingDistributors,
      incomplete: missingDistributors.length > 0,
    };
  });

  const mergedSources: SosMergedSource[] = [];

  const distributors: SosDistributorCoverage[] = [...firstSeen.keys()]
    .map((key) => {
      const present = loadedPeriods.filter((p) => byPeriod.get(p)?.has(key));
      const absent = loadedPeriods.filter((p) => !byPeriod.get(p)?.has(key));
      // Split the absences BEFORE anything is counted: a merged month is not a hole, so it must
      // leave the missing list, the interior list and the estimate alike.
      const mergedPeriods: string[] = [];
      const preOnboardingPeriods: string[] = [];
      const missing: string[] = [];
      let mergedWindow: MergedSourceWindow | null = null;
      for (const period of absent) {
        const window = mergedAwayIn(key, period);
        if (window) {
          mergedPeriods.push(period);
          mergedWindow = window;
        } else if (beforeOnboarding(key, period)) {
          preOnboardingPeriods.push(period);
        } else {
          missing.push(period);
        }
      }
      const earliest = present[0] ?? "";
      const latest = present[present.length - 1] ?? "";
      // Between two months it demonstrably landed in — no onboarding story can explain these.
      const interiorMissingPeriods = missing.filter((p) => p > earliest && p < latest);
      const values = present.map((p) => byPeriod.get(p)?.get(key) ?? 0);
      const averageValue = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
      const intoKey = mergedWindow ? canonicalDistributorKey(mergedWindow.into) : "";
      const mergedInto = mergedWindow ? nameOf(intoKey) : null;
      const mergedIntoCode = mergedWindow ? displayCode.get(intoKey) ?? mergedWindow.into : null;
      if (mergedWindow && mergedPeriods.length > 0) {
        mergedSources.push({
          distributorCode: displayCode.get(key) ?? key,
          name: nameOf(key),
          into: mergedInto ?? mergedWindow.into,
          intoCode: mergedIntoCode ?? mergedWindow.into,
          periods: mergedPeriods,
        });
      }
      return {
        distributorCode: displayCode.get(key) ?? key,
        name: nameOf(key),
        missingPeriods: missing,
        mergedPeriods,
        mergedInto,
        mergedIntoCode,
        onboardedAt: onboardingOf(key)?.from ?? null,
        preOnboardingPeriods,
        interiorMissingPeriods,
        firstSeen: earliest,
        averageValue: round2(averageValue),
        estimatedMissingValue: round2(averageValue * missing.length),
      };
    })
    .filter((d) => d.missingPeriods.length > 0)
    .sort((a, b) => b.estimatedMissingValue - a.estimatedMissingValue);

  return {
    loadedPeriods,
    missingPeriods,
    periods,
    distributors,
    mergedSources: mergedSources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    hasGaps: missingPeriods.length > 0 || distributors.length > 0,
  };
}

/**
 * One line a non-engineer can act on, or null when nothing is missing.
 * Deliberately states the estimate as an estimate.
 */
export function describeSosCoverageGaps(report: SosCoverageReport): string | null {
  if (!report.hasGaps) return null;
  const parts: string[] = [];
  if (report.missingPeriods.length > 0) {
    parts.push(
      `${report.missingPeriods.join(", ")} ${report.missingPeriods.length === 1 ? "was" : "were"} never uploaded`,
    );
  }
  if (report.distributors.length > 0) {
    const worst = report.distributors[0];
    const others = report.distributors.length - 1;
    parts.push(
      `${worst.name} is missing from ${worst.missingPeriods.join(", ")}` +
        (worst.estimatedMissingValue > 0
          ? ` (roughly ${Math.round(worst.estimatedMissingValue).toLocaleString("en-US")} EGP, estimated from its other months)`
          : "") +
        (others > 0 ? `, and ${others} other distributor${others === 1 ? " has" : "s have"} gaps too` : ""),
    );
  }
  const merged = describeSosMergedSources(report);
  return (
    `${parts.join(". ")}. Month-to-month comparisons that span these gaps are not like-for-like.` +
    (merged ? ` ${merged}` : "")
  );
}

/**
 * The merge note, or null when nothing was merged.
 *
 * Separate from the gap sentence on purpose: a merge is NOT a warning, so it never turns a clean
 * window into a banner — it only explains the quiet months beside the real gaps.
 */
export function describeSosMergedSources(report: SosCoverageReport): string | null {
  if (report.mergedSources.length === 0) return null;
  const parts = report.mergedSources.map(
    (source) => `${source.name} has no file of its own for ${source.periods.join(", ")} because ${source.into} carried it`,
  );
  return `${parts.join("; ")} — those months are complete, not missing.`;
}
