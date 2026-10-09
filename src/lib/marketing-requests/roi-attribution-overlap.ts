// ─────────────────────────────────────────────────────────────────────────────
// Shared-sale overlap between marketing requests — pure, client-safe.
//
// Moved out of roi-report-service.ts (which re-exports it) on 2026-10-09 so the Coverage Report's
// per-line / per-region breakdown and its monthly trend dedupe a shared sale the same way the KPI
// band does. Summing per-request actuals into a bucket counts a sale once per campaign that
// claims it: the breakdown, trend and workbook TOTAL read 45,153.88 where the deduped headline
// read 42,433.56 on production.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoiAttributionLine } from "@/lib/marketing-requests/roi-report-types";

const attributionLineKey = (line: RoiAttributionLine): string =>
  `${line.distributorCode}|${line.customerCode}|${line.productCode}|${line.invoicePeriod}|${line.qty}|${line.value}`;

/**
 * How much value would be counted more than once if these claimed lines were simply added up.
 *
 * Attribution matches a campaign to an invoice line on distributor + pharmacy code + product +
 * month and nothing makes that match exclusive, so two campaigns targeting the same pharmacy and
 * product over overlapping ROI windows both legitimately claim the same sale. Per request that is
 * correct; a COMPANY-WIDE total that adds the per-request figures is not (production: 729,884.77
 * added up against 480,155.92 of real sales, +52%).
 *
 * The RPC does not expose the underlying sale's row id, so identical lines are reconciled as a
 * MULTISET: a signature appearing three times within one request is three distinct sales, and the
 * union keeps the most copies any single request claimed. Deduping on the signature alone would
 * collapse those three into one and under-report the company's sales (197 signatures cover 309
 * real lines in production). Two requests matching the same signature always matched the same
 * sales, because the match criteria in the signature are the whole of the match.
 */
export function sharedAttributionOverlap(lines: RoiAttributionLine[]): number {
  const copiesByRequest = new Map<string, Map<string, number>>();
  const valueByLine = new Map<string, number>();
  let claimed = 0;

  for (const line of lines) {
    const key = attributionLineKey(line);
    valueByLine.set(key, line.value);
    let perRequest = copiesByRequest.get(key);
    if (!perRequest) {
      perRequest = new Map<string, number>();
      copiesByRequest.set(key, perRequest);
    }
    perRequest.set(line.requestId, (perRequest.get(line.requestId) ?? 0) + 1);
    claimed += line.value;
  }

  let distinct = 0;
  for (const [key, perRequest] of copiesByRequest) {
    let copies = 0;
    for (const count of perRequest.values()) {
      if (count > copies) copies = count;
    }
    distinct += (valueByLine.get(key) ?? 0) * copies;
  }
  return claimed - distinct;
}
