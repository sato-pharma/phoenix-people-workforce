// ─────────────────────────────────────────────────────────────────────────────
// Marketing Manager Scorecard — one row per PERSON who raised marketing requests.
//
// Owner instruction, 2026-10-09: "this report will list all the managers who did marketing
// requests, approved marketing requests, and show the total … the total value of the total
// request, the total approved request they did … also you will calculate the sum of the total ROI
// and you will calculate the sum of the actual that gained until now."
//
// Pure: it re-reads the authoritative engine's own output (`getMarketingRoiReport`) and groups it,
// exactly the way `roi-live-stages.ts` does — never a second opinion about attribution, scope or
// status. Everything it needs is already on the row.
//
// 🔴 THE DEDUPE IS NOT OPTIONAL. Attribution matches a campaign to an invoice line on distributor +
// pharmacy code + product + month, and nothing makes that match exclusive, so two campaigns on the
// same pharmacy and product over overlapping windows both legitimately claim the same sale. Per
// request that is right; ADDED UP it is not (production: 729,884.77 summed against 480,155.92 real,
// +52%). So every actual figure here — per manager AND in the footer — goes through
// `sharedAttributionOverlap`, and the footer is deduped over the WHOLE set rather than being a sum
// of the already-deduped per-manager figures: two managers can each claim the same sale too.
// `.claude/rules/marketing.md`, "ANY ROLL-UP OF ACTUAL SALES ACROSS REQUESTS DEDUPES THROUGH THE
// ATTRIBUTION LEDGER".
// ─────────────────────────────────────────────────────────────────────────────

import { roundMarketingMoney, roundMarketingRatio } from "@/lib/marketing-requests/roi";
import { sharedAttributionOverlap } from "@/lib/marketing-requests/roi-attribution-overlap";
import { roiValueBucket } from "@/lib/marketing-requests/roi-report-service";
import type {
  MarketingRoiReportRow,
  RoiAttributionLine,
} from "@/lib/marketing-requests/roi-report-types";

export type MarketingManagerScorecardRow = {
  /** normalized HR id — the grouping key. Never rendered: the rule is names, never ids. */
  managerHrId: string;
  managerName: string;
  lineName: string | null;
  regionName: string | null;

  /** Every request this person raised in the viewer's scope, whatever its status. */
  totalRequests: number;
  /** Of those, the ones whose money is committed (approved → closed). */
  approvedRequests: number;
  /** Still waiting on a decision — validation, approval, returned, finance hold. */
  awaitingRequests: number;
  /** Refused, called off or archived: money that was never committed. */
  refusedRequests: number;

  /** Requested EGP across EVERY request, decided or not — "the total value of the requests". */
  totalRequestedValue: number;
  /** Requested EGP across the APPROVED ones — "the total approved request they did". */
  approvedValue: number;
  /** Forecast ROI promised on the approved money — "the sum of the total ROI". */
  expectedRoiValue: number;
  /** The return those approved campaigns must produce to pay for themselves. */
  requiredRoiValue: number;
  /** Attributed sales on the approved money, deduped — "the actual that gained until now". */
  actualValue: number;

  /** actual / required — did the approved campaigns return what they had to? */
  roiCoverageRatio: number;
  /** actual / approved spend — how much of the money came back. */
  recoveryRatio: number;

};

export type MarketingManagerScorecardTotals = Pick<
  MarketingManagerScorecardRow,
  | "actualValue"
  | "approvedRequests"
  | "approvedValue"
  | "awaitingRequests"
  | "expectedRoiValue"
  | "recoveryRatio"
  | "refusedRequests"
  | "requiredRoiValue"
  | "roiCoverageRatio"
  | "totalRequestedValue"
  | "totalRequests"
> & { managerCount: number };

export type MarketingManagerScorecard = {
  rows: MarketingManagerScorecardRow[];
  totals: MarketingManagerScorecardTotals;
  /** Latest validated Source-of-Sales invoice period behind every actual figure here. */
  salesDataAsOf: string | null;
  generatedAtIso: string;
};

type Bucket = {
  lines: RoiAttributionLine[];
  row: MarketingManagerScorecardRow;
};

const emptyRow = (managerHrId: string): MarketingManagerScorecardRow => ({
  actualValue: 0,
  approvedRequests: 0,
  approvedValue: 0,
  awaitingRequests: 0,
  expectedRoiValue: 0,
  lineName: null,
  managerHrId,
  managerName: managerHrId,
  recoveryRatio: 0,
  refusedRequests: 0,
  regionName: null,
  requiredRoiValue: 0,
  roiCoverageRatio: 0,
  totalRequestedValue: 0,
  totalRequests: 0,
});

/** Deduped total: the plain sum less only what the ledger PROVES was claimed twice. */
const dedupe = (summed: number, lines: RoiAttributionLine[]): number =>
  roundMarketingMoney(Math.max(summed - sharedAttributionOverlap(lines), 0));

/**
 * Group one ROI report into a per-requester scorecard.
 *
 * `rows` and `attributionLines` must come from the SAME report call — the ledger is narrowed by
 * request id, so a mismatched pair would deduct value no row ever added.
 *
 */
export function buildMarketingManagerScorecard(input: {
  attributionLines: RoiAttributionLine[];
  generatedAtIso: string;
  rows: MarketingRoiReportRow[];
  salesDataAsOf: string | null;
}): MarketingManagerScorecard {
  const { attributionLines, generatedAtIso, rows, salesDataAsOf } = input;

  const buckets = new Map<string, Bucket>();
  // Which money bucket each request fell in, so the ledger can be split the same way the figures
  // were.
  const approvedRequestIds = new Set<string>();

  for (const row of rows) {
    const key = (row.requesterHrId ?? "").trim().toLowerCase();
    if (!key) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { lines: [], row: emptyRow(key) };
      buckets.set(key, bucket);
    }
    const target = bucket.row;
    // First non-empty wins for the display fields: one person has one name, and a request whose
    // line or region never resolved must not blank a label the previous row already carried.
    if (row.requesterName && target.managerName === target.managerHrId) target.managerName = row.requesterName;
    if (!target.lineName && row.line) target.lineName = row.line;
    if (!target.regionName && row.region) target.regionName = row.region;

    target.totalRequests += 1;
    target.totalRequestedValue += row.estimatedCost;

    const money = roiValueBucket(row.status);
    if (money === "approved") {
      approvedRequestIds.add(row.requestId);
      target.approvedRequests += 1;
      target.approvedValue += row.estimatedCost;
      target.expectedRoiValue += row.expectedRoiValue;
      target.requiredRoiValue += row.requiredRoiValue;
      target.actualValue += row.actualSalesValue;
    } else if (money === "pending") {
      target.awaitingRequests += 1;
    } else {
      target.refusedRequests += 1;
    }
  }

  // Ledger per manager, keyed by the request ids his own rows contributed.
  const ownerByRequestId = new Map<string, string>();
  for (const row of rows) {
    const key = (row.requesterHrId ?? "").trim().toLowerCase();
    if (key) ownerByRequestId.set(row.requestId, key);
  }
  for (const line of attributionLines) {
    const owner = ownerByRequestId.get(line.requestId);
    if (!owner) continue;
    const bucket = buckets.get(owner);
    if (!bucket) continue;
    if (approvedRequestIds.has(line.requestId)) bucket.lines.push(line);
  }

  const scorecardRows = [...buckets.values()].map(({ lines, row }) => {
    const actualValue = dedupe(row.actualValue, lines);
    const approvedValue = roundMarketingMoney(row.approvedValue);
    const requiredRoiValue = roundMarketingMoney(row.requiredRoiValue);
    return {
      ...row,
      actualValue,
      approvedValue,
      expectedRoiValue: roundMarketingMoney(row.expectedRoiValue),
      recoveryRatio: approvedValue > 0 ? roundMarketingRatio(actualValue / approvedValue) : 0,
      requiredRoiValue,
      roiCoverageRatio: requiredRoiValue > 0 ? roundMarketingRatio(actualValue / requiredRoiValue) : 0,
      totalRequestedValue: roundMarketingMoney(row.totalRequestedValue),
    };
  });

  // Spend first — this is a money report, and the biggest spender is the row an executive opens it
  // for. Name breaks the tie so the order is stable between two runs.
  scorecardRows.sort(
    (left, right) =>
      right.approvedValue - left.approvedValue ||
      right.totalRequestedValue - left.totalRequestedValue ||
      left.managerName.localeCompare(right.managerName),
  );

  const summed = scorecardRows.reduce(
    (acc, row) => ({
      approvedRequests: acc.approvedRequests + row.approvedRequests,
      approvedValue: acc.approvedValue + row.approvedValue,
      awaitingRequests: acc.awaitingRequests + row.awaitingRequests,
      expectedRoiValue: acc.expectedRoiValue + row.expectedRoiValue,
      refusedRequests: acc.refusedRequests + row.refusedRequests,
      requiredRoiValue: acc.requiredRoiValue + row.requiredRoiValue,
      totalRequestedValue: acc.totalRequestedValue + row.totalRequestedValue,
      totalRequests: acc.totalRequests + row.totalRequests,
    }),
    {
      approvedRequests: 0,
      approvedValue: 0,
      awaitingRequests: 0,
      expectedRoiValue: 0,
      refusedRequests: 0,
      requiredRoiValue: 0,
      totalRequestedValue: 0,
      totalRequests: 0,
    },
  );

  // The footer's own dedupe, over every claimed line at once. Summing the per-manager figures would
  // double-count a sale two DIFFERENT managers each claim — which is the same defect one manager's
  // two campaigns cause, one level up.
  const companyLines = attributionLines.filter((line) => approvedRequestIds.has(line.requestId));
  // 🔴 FROM THE RAW SUMS, NEVER FROM THE ROWS ABOVE. Each row's figure has already had its own
  // overlap deducted, so deducting the company overlap from the sum of those would subtract the
  // same shared sale twice — one sale claimed by two campaigns of one manager came out as ZERO.
  const rawBuckets = [...buckets.values()];
  const summedActual = rawBuckets.reduce((total, bucket) => total + bucket.row.actualValue, 0);
  const totalActualValue = dedupe(summedActual, companyLines);

  return {
    generatedAtIso,
    rows: scorecardRows,
    salesDataAsOf,
    totals: {
      ...summed,
      actualValue: totalActualValue,
      approvedValue: roundMarketingMoney(summed.approvedValue),
      expectedRoiValue: roundMarketingMoney(summed.expectedRoiValue),
      managerCount: scorecardRows.length,
      recoveryRatio:
        summed.approvedValue > 0 ? roundMarketingRatio(totalActualValue / summed.approvedValue) : 0,
      requiredRoiValue: roundMarketingMoney(summed.requiredRoiValue),
      roiCoverageRatio:
        summed.requiredRoiValue > 0 ? roundMarketingRatio(totalActualValue / summed.requiredRoiValue) : 0,
      totalRequestedValue: roundMarketingMoney(summed.totalRequestedValue),
    },
  };
}
