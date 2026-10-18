/**
 * WHITELIST · WATCH · BLACKLIST — the owner's rule for a validated doctor or account, as a pure function.
 *
 * His words (2026-10-18):
 *
 *   WHITELIST — "when money come back, even if it is grow month by month, not a must to reach the 10
 *   times, but sales is growing even a little bit after the marketing request. Same situation if he was
 *   no sales, and after the marketing request, it shows sales, then whitelist." And from his first
 *   message: pharmacies named with his visits that start selling our products.
 *
 *   BLACKLIST — "ROI missed, pharmacies flat": the request's ROI window has CLOSED under 10× its cost
 *   AND the linked pharmacies sold no more than in the 3 months before it.
 *
 * So growth outranks a missed 10× (the ROI is still shown beside it), and a request whose window is
 * still open — `awaiting_data` in the Marketing ROI engine — can never make a Blacklist.
 *
 * 🔴 ADVISORY ONLY. Nothing anywhere reads this verdict to block, hold or refuse a marketing request
 * (`.claude/rules/marketing-roi.md`); `tests/customer-360-wiring.test.ts` (section 4) pins that.
 *
 * MONTHS. Only CLOSED months count — the months published for all three lines, plus the Monthly
 * Closing's own figures for the months before publishing began (`verdictMonths` in `report.ts`). A
 * month published for one line only is not judged, and the running month never is. "After" starts the month
 * AFTER the pay month ("after the marketing request"); "before" is up to the three closed months
 * before the pay month.
 */

export type Verdict = "whitelist" | "watch" | "blacklist" | "not_enough_data";

export const VERDICT_LABELS: Record<Verdict, string> = {
  blacklist: "Blacklist",
  not_enough_data: "Not enough data",
  watch: "Watch",
  whitelist: "Whitelist",
};

/** The Marketing ROI engine's own result words (`resolveRoiResultStatus`). */
export type RoiResult = "on_track" | "awaiting_data" | "behind" | "no_data";

export type RequestEvidence = {
  requestId: string;
  requestCode: string;
  /** `YYYY-MM` of the pay date. */
  payMonth: string;
  cost: number;
  requiredRoi: number;
  actualRoi: number;
  roiResult: RoiResult;
  /** True when every month of the ROI window has closed (the engine's `salesDataComplete`). */
  windowClosed: boolean;
  /** The request's money is committed (approved). A pending request shows, but decides nothing. */
  committed: boolean;
  /** Its target pharmacies' closing value by closed month. */
  salesByMonth: ReadonlyMap<string, number>;
};

export type VisitEvidence = {
  /** The linked pharmacies' closing value, lines that visit the customer only, by closed month. */
  salesByMonth: ReadonlyMap<string, number>;
  /** Months the customer was visited in. */
  visitedMonths: ReadonlySet<string>;
};

export type RequestSignal = {
  requestId: string;
  requestCode: string;
  before: number | null;
  after: number | null;
  afterMonths: number;
  grew: boolean | null;
  roiMet: boolean;
  windowClosed: boolean;
  committed: boolean;
};

export type VisitSignal = {
  recent: number;
  prior: number;
  recentMonths: string[];
  priorMonths: string[];
  visitedRecently: boolean;
  grew: boolean | null;
};

export type VerdictResult = {
  verdict: Verdict;
  /** Whitelisted on a single month after a request — said, never hidden. */
  early: boolean;
  reasons: string[];
  requests: RequestSignal[];
  visits: VisitSignal | null;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09" → "September 2026". */
export function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  const index = Number(month) - 1;
  return MONTH_NAMES[index] ? `${MONTH_NAMES[index]} ${year}` : period;
}

export function egp(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} EGP`;
}

function average(months: readonly string[], byMonth: ReadonlyMap<string, number>): number {
  if (months.length === 0) return 0;
  return months.reduce((sum, month) => sum + (byMonth.get(month) ?? 0), 0) / months.length;
}

/** Sales grew: higher after than before, or nothing before and something after. */
export function grewOver(before: number, after: number): boolean {
  if (before <= 0) return after > 0;
  return after > before;
}

export function requestSignal(request: RequestEvidence, closedMonths: readonly string[]): RequestSignal {
  const sorted = [...closedMonths].sort();
  const beforeMonths = sorted.filter((month) => month < request.payMonth).slice(-3);
  const afterMonths = sorted.filter((month) => month > request.payMonth);
  const roiMet = request.roiResult === "on_track";
  if (afterMonths.length === 0) {
    return {
      after: null,
      afterMonths: 0,
      before: beforeMonths.length > 0 ? average(beforeMonths, request.salesByMonth) : null,
      committed: request.committed,
      grew: null,
      requestCode: request.requestCode,
      requestId: request.requestId,
      roiMet,
      windowClosed: request.windowClosed,
    };
  }
  const before = average(beforeMonths, request.salesByMonth);
  const after = average(afterMonths, request.salesByMonth);
  return {
    after,
    afterMonths: afterMonths.length,
    before,
    committed: request.committed,
    grew: grewOver(before, after),
    requestCode: request.requestCode,
    requestId: request.requestId,
    roiMet,
    windowClosed: request.windowClosed,
  };
}

export function visitSignal(evidence: VisitEvidence, closedMonths: readonly string[]): VisitSignal | null {
  const sorted = [...closedMonths].sort();
  const recentMonths = sorted.slice(-3);
  const priorMonths = sorted.slice(-6, -3);
  if (recentMonths.length === 0) return null;
  const recent = average(recentMonths, evidence.salesByMonth);
  const prior = average(priorMonths, evidence.salesByMonth);
  const visitedRecently = recentMonths.some((month) => evidence.visitedMonths.has(month));
  // Nothing sold on either side is no movement to judge, not a flat line: it says nothing yet.
  const nothingEitherSide = prior <= 0 && recent <= 0;
  return {
    grew: visitedRecently && priorMonths.length > 0 && !nothingEitherSide ? grewOver(prior, recent) : null,
    prior,
    priorMonths,
    recent,
    recentMonths,
    visitedRecently,
  };
}

/**
 * The verdict. `hasSalesCode` is whether ANY pharmacy tied to him carries a distributor code the
 * closing can find — without one there is nothing to measure, whatever was spent.
 */
export function decideVerdict(input: {
  hasSalesCode: boolean;
  requests: readonly RequestEvidence[];
  visits: VisitEvidence | null;
  closedMonths: readonly string[];
}): VerdictResult {
  const requests = input.requests.map((request) => requestSignal(request, input.closedMonths));
  const visits = input.visits ? visitSignal(input.visits, input.closedMonths) : null;
  const byId = new Map(input.requests.map((request) => [request.requestId, request]));

  if (!input.hasSalesCode) {
    return {
      early: false,
      reasons: ["No pharmacy tied to this customer carries a distributor code the Monthly Closing can find, so there are no sales to measure."],
      requests,
      verdict: "not_enough_data",
      visits,
    };
  }

  const committed = requests.filter((signal) => signal.committed);
  const reasons: string[] = [];

  // WHITELIST — any committed request grew or met its 10×, or the visited pharmacies started selling.
  const grown = committed.filter((signal) => signal.grew === true);
  const met = committed.filter((signal) => signal.roiMet);
  const visitGrew = visits?.grew === true;
  if (grown.length > 0 || met.length > 0 || visitGrew) {
    for (const signal of grown) {
      const request = byId.get(signal.requestId);
      const pay = request ? monthLabel(request.payMonth) : "";
      reasons.push(
        (signal.before ?? 0) <= 0
          ? `Request ${signal.requestCode} (paid ${pay}): its pharmacies had no sales before and sold ${egp(signal.after ?? 0)} a month after.`
          : `Request ${signal.requestCode} (paid ${pay}): its pharmacies' sales rose from ${egp(signal.before ?? 0)} to ${egp(signal.after ?? 0)} a month.`,
      );
    }
    for (const signal of met) {
      const request = byId.get(signal.requestId);
      if (request) reasons.push(`Request ${signal.requestCode} has returned ${egp(request.actualRoi)} against the 10× target of ${egp(request.requiredRoi)}.`);
    }
    if (visitGrew && visits) {
      reasons.push(
        visits.prior <= 0
          ? `The pharmacies tied through visits had no sales in ${visits.priorMonths.map(monthLabel).join(", ")} and sold ${egp(visits.recent)} a month in ${visits.recentMonths.map(monthLabel).join(", ")}.`
          : `The pharmacies tied through visits rose from ${egp(visits.prior)} to ${egp(visits.recent)} a month (${visits.recentMonths.map(monthLabel).join(", ")}).`,
      );
    }
    const early = grown.length > 0 && met.length === 0 && !visitGrew && grown.every((signal) => signal.afterMonths === 1);
    if (early) reasons.push("Early: only one closed month after the request so far.");
    return { early, reasons, requests, verdict: "whitelist", visits };
  }

  // BLACKLIST — a committed request's window CLOSED under 10× and its pharmacies did not grow.
  const missed = committed.filter((signal) => signal.windowClosed && !signal.roiMet && signal.grew === false);
  if (missed.length > 0) {
    for (const signal of missed) {
      const request = byId.get(signal.requestId);
      if (!request) continue;
      reasons.push(
        `Request ${signal.requestCode} (paid ${monthLabel(request.payMonth)}): the ROI window has closed at ${egp(request.actualRoi)} against the 10× target of ${egp(request.requiredRoi)}, and its pharmacies sold ${egp(signal.after ?? 0)} a month after against ${egp(signal.before ?? 0)} before.`,
      );
    }
    return { early: false, reasons, requests, verdict: "blacklist", visits };
  }

  // WATCH — money spent and the window still open with no rise yet, or visited and flat.
  const open = committed.filter((signal) => !signal.windowClosed);
  const visitedFlat = visits?.grew === false;
  if (open.length > 0 || visitedFlat || committed.length > 0) {
    for (const signal of open) {
      const request = byId.get(signal.requestId);
      if (!request) continue;
      reasons.push(
        signal.afterMonths === 0
          ? `Request ${signal.requestCode} (paid ${monthLabel(request.payMonth)}): no closed month after it yet.`
          : `Request ${signal.requestCode} (paid ${monthLabel(request.payMonth)}): its ROI window is still open and sales have not risen yet.`,
      );
    }
    for (const signal of committed.filter((one) => one.windowClosed && one.grew === null)) {
      reasons.push(`Request ${signal.requestCode}: no closed month after it to compare.`);
    }
    if (visitedFlat && visits) {
      reasons.push(`The pharmacies tied through visits sold ${egp(visits.recent)} a month in ${visits.recentMonths.map(monthLabel).join(", ")}, against ${egp(visits.prior)} before.`);
    }
    return { early: false, reasons, requests, verdict: "watch", visits };
  }

  reasons.push("No committed marketing request and no change in the tied pharmacies' sales to judge yet.");
  return { early: false, reasons, requests, verdict: "not_enough_data", visits };
}
