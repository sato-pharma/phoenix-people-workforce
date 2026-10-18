/**
 * Customer 360 v2 — the per-viewer step: sales onto each pharmacy, ROI onto each request, a verdict
 * onto each hub. Pure.
 *
 * The assembly (`hub.ts`) is the same for every viewer and is cached; this runs per request on top of
 * it because two things differ by viewer — El Qema's rows and codes leave every detail for everyone
 * but the Super Admin, and the marketing money is shown only to a role that reads marketing.
 *
 * 🔴 THE VERDICT IS DECIDED ONCE, ON THE REAL ROWS, AND IS THE SAME FOR EVERY VIEWER. It is a
 * conclusion like an achievement, and El Qema counts in achievements (`closing-source-mask.ts`: mask
 * AFTER every computation that needs the real rows). What a viewer who may not see El Qema loses is the
 * detail: its codes, any shop known only by them, and — on a customer whose verdict rests partly on its
 * rows — the amounts in the reasons, which would otherwise size the money missing from the rows shown.
 *
 * SALES ARE THE MONTHLY CLOSING'S OWN ROWS (`phx_closing_customers` through its pair wrapper) — never
 * a fourth source, never units added across products: VALUE only.
 */

import { HUB_LINES, normalisePair, pairCanBeRead, type HubLineCode, type Hub, type HubAssembly, type HubRequest, type MatchItem, type SalesPair } from "./hub";
import { decideVerdict, type RequestEvidence, type RoiResult, type VerdictResult } from "./verdict";

export type ClosingSalesRow = {
  period: string;
  line: HubLineCode;
  distributorCode: string;
  clientCode: string;
  clientName: string;
  brickId: string | null;
  value: number;
};

/**
 * The months that count. `published` per line are the Monthly Closing's published months; `history`
 * are the months before publishing began, from the closing's own uploaded figures (owner, 2026-10-18:
 * "Add Jan-Jun as history"). The running month is in neither.
 */
export type ClosedMonths = {
  published: Record<HubLineCode, string[]>;
  history: string[];
  /** Every closed month, any line, ascending. */
  all: string[];
};

export function closedMonthsFor(line: HubLineCode, months: ClosedMonths): Set<string> {
  return new Set([...months.history, ...(months.published[line] ?? [])]);
}

/**
 * The months a verdict compares: the history months and the months published for ALL THREE lines. A
 * month published for one line and not yet for another holds only part of a customer's sales, so
 * judging it would read a closing still in progress as a fall.
 */
export function verdictMonths(months: ClosedMonths): string[] {
  const everyLine = HUB_LINES.map((line) => new Set(months.published[line.code] ?? []));
  const published = [...everyLine[0]].filter((month) => everyLine.every((set) => set.has(month)));
  return [...new Set([...months.history, ...published])].sort();
}

/** What the ROI engine needs that only the server knows. */
export type RoiContext = {
  /** The latest month whose distributor files have all landed (`loadLatestValidatedPeriod`). */
  salesDataAsOf: string | null;
  /** The engine's own helpers, passed in so this file stays pure and never copies them. */
  roiWindow: (payDate: string | null, months: number) => { label: string | null; endPeriod: string | null };
  roiResult: (input: { salesRows: number; actualValue: number; requiredRoiValue: number; salesDataComplete: boolean }) => RoiResult;
  isCommitted: (status: string) => boolean;
};

export type PharmacySales = {
  byMonth: Record<string, number>;
  byLine: Partial<Record<HubLineCode, Record<string, number>>>;
  total: number;
};

export type HubRequestView = HubRequest & {
  roiResult: RoiResult;
  windowLabel: string | null;
  windowClosed: boolean;
  committed: boolean;
};

/** A hub's direct orders as a viewer reads them: closed months, three lines. */
export type HubDirectOrderSummary = {
  venues: number;
  orders: number;
  value: number;
  byMonth: Record<string, number>;
};

export type HubView = Omit<Hub, "requests" | "directOrders"> & {
  requests: HubRequestView[];
  directOrders: HubDirectOrderSummary;
  pharmacySales: Record<string, PharmacySales>;
  /** Distinct pairs only — a shop tied through two sources is counted once. */
  salesByMonth: Record<string, number>;
  salesTotal: number;
  hasSalesCode: boolean;
  verdict: VerdictResult;
  moneyVisible: boolean;
};

export type MatchItemView = MatchItem & {
  /** Each candidate's (and each tied pair's) closing value over the last three closed months. */
  candidateSales: Record<string, number>;
  lastMonths: string[];
};

const pairKey = (distributorCode: string, customerCode: string): string => `${distributorCode.trim().toUpperCase()}|${customerCode.trim()}`;

/** Index the closing rows by pair, so a pharmacy finds its rows without scanning. */
export function indexSales(rows: readonly ClosingSalesRow[]): Map<string, ClosingSalesRow[]> {
  const index = new Map<string, ClosingSalesRow[]>();
  for (const row of rows) {
    const key = pairKey(row.distributorCode, row.clientCode);
    const list = index.get(key) ?? [];
    list.push(row);
    index.set(key, list);
  }
  return index;
}

function rowsForPair(index: Map<string, ClosingSalesRow[]>, pair: SalesPair): ClosingSalesRow[] {
  if (!pairCanBeRead(pair)) return [];
  const rows = index.get(pairKey(pair.distributorCode, pair.customerCode)) ?? [];
  return pair.brickId ? rows.filter((row) => row.brickId === pair.brickId) : rows;
}

/** Approved orders counted in the closed months of their own line; an order with no month is not counted. */
export function summarizeDirectOrders(directOrders: Hub["directOrders"], months: ClosedMonths): HubDirectOrderSummary {
  const out: HubDirectOrderSummary = { byMonth: {}, orders: 0, value: 0, venues: directOrders.venues };
  const closed = new Map<HubLineCode, Set<string>>();
  for (const entry of directOrders.entries) {
    if (!entry.month) continue;
    let open = closed.get(entry.line);
    if (!open) {
      open = closedMonthsFor(entry.line, months);
      closed.set(entry.line, open);
    }
    if (!open.has(entry.month)) continue;
    out.orders += 1;
    out.value += entry.value;
    out.byMonth[entry.month] = (out.byMonth[entry.month] ?? 0) + entry.value;
  }
  return out;
}

/**
 * The assembly as a viewer who may not see a masked distributor reads it: those codes leave every
 * pharmacy, and a pharmacy known ONLY by such codes leaves the hub — its sales entry goes with it, since
 * it is built from this list. A pharmacy that never had a code (a marketing link still unmapped) stays.
 */
export function withoutMaskedPharmacies(assembly: HubAssembly, isVisibleCode: (distributorCode: string) => boolean): HubAssembly {
  return {
    ...assembly,
    hubs: assembly.hubs.map((hub) => ({
      ...hub,
      pharmacies: hub.pharmacies.flatMap((pharmacy) => {
        const pairs = pharmacy.pairs.filter((pair) => isVisibleCode(pair.distributorCode));
        if (pharmacy.pairs.length > 0 && pairs.length === 0) return [];
        return [{ ...pharmacy, pairs }];
      }),
    })),
  };
}

/** Hubs whose pharmacies carry a code this viewer may not see — their verdict amounts stay out of view. */
export function hubsWithMaskedCodes(assembly: HubAssembly, isVisibleCode: (distributorCode: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const hub of assembly.hubs) {
    if (hub.pharmacies.some((pharmacy) => pharmacy.pairs.some((pair) => !isVisibleCode(pair.distributorCode)))) out.add(hub.id);
  }
  return out;
}

function sumPairs(
  pairs: readonly SalesPair[],
  index: Map<string, ClosingSalesRow[]>,
  months: ClosedMonths,
  lines?: ReadonlySet<HubLineCode>,
): PharmacySales {
  const out: PharmacySales = { byLine: {}, byMonth: {}, total: 0 };
  const seen = new Set<string>();
  const closed = new Map<HubLineCode, Set<string>>();
  for (const pair of pairs) {
    const key = `${pairKey(pair.distributorCode, pair.customerCode)}|${pair.brickId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const row of rowsForPair(index, pair)) {
      if (lines && !lines.has(row.line)) continue;
      let open = closed.get(row.line);
      if (!open) {
        open = closedMonthsFor(row.line, months);
        closed.set(row.line, open);
      }
      if (!open.has(row.period)) continue;
      out.byMonth[row.period] = (out.byMonth[row.period] ?? 0) + row.value;
      const line = (out.byLine[row.line] ??= {});
      line[row.period] = (line[row.period] ?? 0) + row.value;
      out.total += row.value;
    }
  }
  return out;
}

function toMap(byMonth: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(byMonth));
}

/** The per-viewer view of every hub. `salesRows` must already be masked for this viewer. */
export function buildHubViews(input: {
  assembly: HubAssembly;
  salesRows: readonly ClosingSalesRow[];
  months: ClosedMonths;
  roi: RoiContext;
  moneyVisible: boolean;
  /** Verdicts already decided on the real rows, by hub id — used as given, never re-decided. */
  verdicts?: ReadonlyMap<string, VerdictResult>;
  /** Hubs whose verdict rests partly on rows this viewer may not see: no amount reaches their reasons. */
  hideVerdictAmounts?: ReadonlySet<string>;
}): HubView[] {
  const index = indexSales(input.salesRows);
  const judgedMonths = verdictMonths(input.months);
  return input.assembly.hubs.map((hub) => {
    const pharmacySales: Record<string, PharmacySales> = {};
    for (const pharmacy of hub.pharmacies) pharmacySales[pharmacy.key] = sumPairs(pharmacy.pairs, index, input.months);
    const allPairs = hub.pharmacies.flatMap((pharmacy) => pharmacy.pairs);
    const hubSales = sumPairs(allPairs, index, input.months);
    const hasSalesCode = allPairs.length > 0;

    const requests: HubRequestView[] = hub.requests.map((request) => {
      const { label, endPeriod } = input.roi.roiWindow(request.payDate, request.roiDurationMonths);
      const windowClosed = Boolean(input.roi.salesDataAsOf && endPeriod && endPeriod <= input.roi.salesDataAsOf);
      return {
        ...request,
        committed: input.roi.isCommitted(request.status),
        roiResult: input.roi.roiResult({
          actualValue: request.actualRoi,
          requiredRoiValue: request.requiredRoi,
          salesDataComplete: windowClosed,
          salesRows: request.salesRows,
        }),
        windowClosed,
        windowLabel: label,
      };
    });

    const marketingPairs = hub.pharmacies
      .filter((pharmacy) => pharmacy.sources.includes("marketing_link") || pharmacy.sources.includes("request_target"))
      .flatMap((pharmacy) => pharmacy.pairs);
    const evidence: RequestEvidence[] = requests
      .filter((request) => request.payDate && /^\d{4}-\d{2}/.test(request.payDate))
      .map((request) => {
        const targetPairs = hub.pharmacies.filter((pharmacy) => request.targetKeys.includes(pharmacy.key)).flatMap((pharmacy) => pharmacy.pairs);
        const sales = sumPairs(targetPairs.length > 0 ? targetPairs : marketingPairs, index, input.months);
        return {
          actualRoi: request.actualRoi,
          committed: request.committed,
          cost: request.cost,
          payMonth: String(request.payDate).slice(0, 7),
          requestCode: request.code,
          requestId: request.id,
          requiredRoi: request.requiredRoi,
          roiResult: request.roiResult,
          salesByMonth: toMap(sales.byMonth),
          windowClosed: request.windowClosed,
        };
      });

    const visitingLines = new Set(hub.linesVisiting);
    const namedPairs = hub.pharmacies.filter((pharmacy) => pharmacy.sources.includes("named_on_visit")).flatMap((pharmacy) => pharmacy.pairs);
    const visitEvidence =
      namedPairs.length > 0 && visitingLines.size > 0
        ? {
            salesByMonth: toMap(sumPairs(namedPairs, index, input.months, visitingLines).byMonth),
            visitedMonths: new Set(hub.visits.map((visit) => visit.month)),
          }
        : null;

    let verdict = input.verdicts?.get(hub.id) ?? decideVerdict({ closedMonths: judgedMonths, hasSalesCode, requests: evidence, visits: visitEvidence });
    if (input.hideVerdictAmounts?.has(hub.id)) verdict = { ...verdict, reasons: verdict.reasons.filter((reason) => !/EGP/.test(reason)) };

    const view: HubView = {
      ...hub,
      directOrders: summarizeDirectOrders(hub.directOrders, input.months),
      hasSalesCode,
      moneyVisible: input.moneyVisible,
      pharmacySales,
      requests,
      salesByMonth: hubSales.byMonth,
      salesTotal: hubSales.total,
      verdict,
    };
    return input.moneyVisible ? view : withoutMoney(view);
  });
}

/** A role that does not read marketing sees the verdict and the sales, never the campaign money. */
export function withoutMoney(view: HubView): HubView {
  return {
    ...view,
    requests: view.requests.map((request) => ({ ...request, actualRoi: 0, cost: 0, requiredRoi: 0 })),
    verdict: {
      ...view.verdict,
      reasons: view.verdict.reasons.filter((reason) => !/EGP/.test(reason)).concat(
        view.verdict.reasons.some((reason) => /EGP/.test(reason)) ? ["The marketing figures behind this verdict are shown to marketing readers only."] : [],
      ),
    },
  };
}

/** The confirm tab's items, each candidate carrying its last three closed months' value. */
export function buildMatchItemViews(input: {
  items: readonly MatchItem[];
  salesRows: readonly ClosingSalesRow[];
  months: ClosedMonths;
}): MatchItemView[] {
  const index = indexSales(input.salesRows);
  const lastMonths = input.months.all.slice(-3);
  const recent = new Set(lastMonths);
  return input.items.map((item) => {
    const candidateSales: Record<string, number> = {};
    for (const pair of [...item.result.candidates, ...item.result.pairs]) {
      const key = pairKey(pair.distributorCode, pair.customerCode);
      if (key in candidateSales) continue;
      // Each shop on its own brick: an EP-PHS code is shared across shops, so it is read with its brick
      // or not at all.
      const normal = normalisePair({ brickId: pair.brickId, customerCode: pair.customerCode, distributorCode: pair.distributorCode });
      if (!pairCanBeRead(normal)) continue;
      candidateSales[key] = rowsForPair(index, normal)
        .filter((row) => recent.has(row.period))
        .reduce((sum, row) => sum + row.value, 0);
    }
    return { ...item, candidateSales, lastMonths };
  });
}

export function candidateSalesKey(distributorCode: string, customerCode: string): string {
  return pairKey(distributorCode, customerCode);
}
