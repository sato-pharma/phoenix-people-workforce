// ─────────────────────────────────────────────────────────────────────────────
// Which zeroes on the Manager Scorecard are a MISSING DISTRIBUTOR FILE rather than a failed
// campaign.
//
// Owner instruction, 2026-10-09: "show on the Scorecard which zeroes are missing distributor
// files". It came out of a real reading of production the same afternoon: one District Manager's
// three September campaigns all read EGP 0, and two of the three were unmeasurable rather than
// unsuccessful — Ibn Sina, where those two pharmacies buy, had filed nothing for September, while
// Ibn Sina-Sato had. A bare 0 next to EGP 5,007 of committed spend reads as a verdict. It was not
// one.
//
// 🔴 THIS NEVER CHANGES A FIGURE, AND IT NEVER BLOCKS ANYBODY. It adds a caption beside the money
// and nothing else: no filtering, no re-weighting, no verdict, no refusal (owner, same day: "don't
// put the rule … never block anyone").
//
// Three decisions that keep the caption truthful, each one load-bearing:
//
//  1. ONLY THE MONTHS THAT ARE OVER. A window running to July 2027 is not missing ten files; it is
//     the future. And the CURRENT month is not missing either — a distributor files a month after
//     it ends, so captioning October in October accuses everybody of being late every single day.
//     The cut is the last CLOSED month.
//  2. THE CAMPAIGN'S OWN TRADING CODE, NOT ITS WHOLE FAMILY. A pharmacy maps to a parent
//     distributor (`IS`), and that parent is also the main code it files under; the siblings are its
//     branches and tenders (`IS-T`, `IS-S`, `PS-T`). Only the parent is judged, and this is what
//     makes the caption worth having rather than noise: measured on production 9 Oct 2026, Ibn Sina
//     had not filed September while Ibn Sina-Sato had — so counting the family as filed would hide
//     the real case, and counting every sibling would caption almost every row, because Overseas
//     Tender lags every month while Overseas files on time. A sale that arrives only on a branch or
//     tender code is therefore NOT captioned; that is the deliberate edge, and the figure itself is
//     never wrong — attribution still counts the sibling's rows when they land.
//  3. ONLY A DISTRIBUTOR THAT NORMALLY FILES. "Not every distributor uploads every month" is an
//     owner rule, and a headcount of absent distributors is explicitly never a finding here. So a
//     month counts as missing only for a distributor that filed at least 2 of the 3 months before
//     it — one that has been filing and skipped this one. A code that files twice a year never
//     produces a caption.
// ─────────────────────────────────────────────────────────────────────────────

/** One distributor, and the already-elapsed window months it has not filed. */
export type DistributorFileGap = {
  /** The Source-of-Sales display name. Never a code: names, never ids. */
  distributorName: string;
  /** YYYY-MM, ascending. */
  periods: string[];
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** YYYY-MM plus n months. Local to this module so it carries no import cycle into the engine. */
export function monthAdd(period: string, months: number): string {
  const [yearPart, monthPart] = period.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  if (!year || !month) return period;
  const zeroBased = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}

/**
 * The ROI window's months, cut at `lastClosedPeriod` (inclusive).
 *
 * A campaign paid in October with a three-month window has NO closed month at all, not three.
 * Returning them would caption the row with files nobody could possibly have filed yet.
 */
export function elapsedWindowMonths(input: {
  /** The last month a distributor could already have filed — NOT the current month. */
  lastClosedPeriod: string;
  payMonth: string | null;
  roiDurationMonths: number;
}): string[] {
  const { lastClosedPeriod: upToPeriod, payMonth, roiDurationMonths } = input;
  if (!payMonth || !MONTH.test(payMonth) || !MONTH.test(upToPeriod)) return [];
  const months = Math.max(1, Math.floor(roiDurationMonths) || 1);
  const periods: string[] = [];
  for (let index = 0; index < months; index += 1) {
    const period = monthAdd(payMonth, index);
    if (period > upToPeriod) break;
    periods.push(period);
  }
  return periods;
}

/**
 * Has this distributor been filing? At least 2 of the 3 months immediately before `period`.
 *
 * The bar is deliberately a RECENT HABIT rather than a total: a distributor that stopped filing in
 * July is exactly the case worth captioning in September, and one that files twice a year is
 * exactly the case that must never produce a caption.
 */
export function distributorNormallyFiles(filedPeriods: ReadonlySet<string>, period: string): boolean {
  if (!MONTH.test(period)) return false;
  let present = 0;
  for (let back = 1; back <= 3; back += 1) {
    if (filedPeriods.has(monthAdd(period, -back))) present += 1;
  }
  return present >= 2;
}

export type FileGapInput = {
  /** Approved campaigns only — the money the caption sits next to. */
  requests: Array<{
    requestId: string;
    payMonth: string | null;
    roiDurationMonths: number;
  /** The parent Source-of-Sales codes this campaign's pharmacies map to — never family codes. */
    distributorCodes: string[];
  }>;
  /** Validated batches: SoS distributor code → the periods it has filed. */
  filedPeriodsByDistributor: ReadonlyMap<string, ReadonlySet<string>>;
  /** SoS distributor code → display name. A code with no name is left out rather than shown raw. */
  distributorNameByCode: ReadonlyMap<string, string>;
  /**
   * The last CLOSED Cairo month: nothing later than this can be missing, because a distributor
   * files a month only after it has ended.
   */
  lastClosedPeriod: string;
};

/** request id → the distributors whose elapsed-window files are missing. Empty entries are omitted. */
export function missingDistributorFiles(input: FileGapInput): Map<string, DistributorFileGap[]> {
  const { distributorNameByCode, filedPeriodsByDistributor, lastClosedPeriod, requests } = input;
  const byRequest = new Map<string, DistributorFileGap[]>();

  for (const request of requests) {
    const periods = elapsedWindowMonths({
      lastClosedPeriod,
      payMonth: request.payMonth,
      roiDurationMonths: request.roiDurationMonths,
    });
    if (periods.length === 0) continue;

    const gapsByName = new Map<string, Set<string>>();
    for (const rawCode of request.distributorCodes) {
      const code = rawCode.trim();
      if (!code) continue;
      const name = distributorNameByCode.get(code);
      if (!name) continue;
      const filed = filedPeriodsByDistributor.get(code) ?? new Set<string>();
      for (const period of periods) {
        if (filed.has(period)) continue;
        if (!distributorNormallyFiles(filed, period)) continue;
        const held = gapsByName.get(name) ?? new Set<string>();
        held.add(period);
        gapsByName.set(name, held);
      }
    }
    if (gapsByName.size === 0) continue;

    byRequest.set(
      request.requestId,
      [...gapsByName.entries()]
        .map(([distributorName, held]) => ({ distributorName, periods: [...held].sort() }))
        .sort((left, right) => left.distributorName.localeCompare(right.distributorName)),
    );
  }

  return byRequest;
}

/** Merge several campaigns' gaps into one manager's, one entry per distributor. */
export function mergeFileGaps(gapLists: ReadonlyArray<ReadonlyArray<DistributorFileGap>>): DistributorFileGap[] {
  const byName = new Map<string, Set<string>>();
  for (const gaps of gapLists) {
    for (const gap of gaps) {
      const held = byName.get(gap.distributorName) ?? new Set<string>();
      for (const period of gap.periods) held.add(period);
      byName.set(gap.distributorName, held);
    }
  }
  return [...byName.entries()]
    .map(([distributorName, held]) => ({ distributorName, periods: [...held].sort() }))
    .sort((left, right) => left.distributorName.localeCompare(right.distributorName));
}
