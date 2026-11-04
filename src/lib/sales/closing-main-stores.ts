import {
  isSplitEligibleLine,
  isStoreCitySplitActive,
  splitStoreSalesAcrossCityAreas,
  type SplitRegions,
  type StoreSplitRow,
} from "@/lib/sales/store-sales-city-split";
import { closingAreaOf } from "@/lib/sales/closing-row-area";
import { isBulkAllocatedRow, isEpdaContributionActive } from "@/lib/sales/bulk-allocation-channel";
import { buildBulkAllocation, type BulkAllocationRow } from "@/lib/sales/closing-bulk-allocation";
import { MASKED_SOURCE_DISTRIBUTORS } from "@/lib/sales/closing-source-mask";

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔒 MAIN STORES — WHAT A READER SEES WHERE EL QEMA'S ROWS USED TO BE.
 *
 * Owner, 2026-09-10, after being shown a sample and approving it:
 *
 *   "the details sheet, the total in it must be matching the total of the rep seeing the closing …
 *    you will show each one his share in the QM, but you will call it Main Stores … for example a
 *    rep has 400 units, you will show him only 400 units in Lacto Advanced 1, Main Store only."
 *
 * THE PROBLEM THIS SOLVES, in his own case. El Qema invoices its own warehouses, and those
 * warehouses stand in Benha. As invoiced, Qalubeya therefore carried 1,797,120 EGP of El Qema's own
 * rows — money that area never earned — while its real customers came to 39,501 EGP and the closing
 * paid it 124,699. Every number on the page disagreed with every other one.
 *
 * Simply REMOVING El Qema's rows (2026-09-10, the change before this one) fixed the identity leak
 * and left the arithmetic worse: the sheet then showed 39,501 against a closing of 124,699. So the
 * rows come back as the thing the closing actually credits — this area's SHARE of the warehouses,
 * under a name that is nobody's company.
 *
 * WHAT IS ON THE ROW, AND WHAT IS DELIBERATELY NOT:
 *
 *   · the customer is the words "Main Stores", and there is no client code and no address, because
 *     a share of a warehouse has no single buyer to name
 *   · the DISTRIBUTOR IS BLANK, which is not cosmetic: `buildFilterOptions` builds the detail tab's
 *     distributor dropdown from whatever these rows carry, and leaving "QM" here would put El Qema
 *     back in the filter with nothing in the rows to show for it
 *   · there is NO EX-FACTORY PRICE. The units are rounded and the value is not, so a printed price
 *     would not multiply out — a reader would find about 111 EGP that is not there. A warehouse
 *     share is not a priced transaction, so the column is empty rather than wrong.
 *
 * 🔴 THIS IS NOT A RELABELLING OF EL QEMA. He was offered that twice and refused it twice: writing
 * another distributor's name onto these rows puts false records into the auditor's file. "Main
 * Stores" names no company, and the money on the row is not El Qema's invoice — it is this area's
 * own credited share, which is a different number.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export const MAIN_STORES_LABEL = "Main Stores" as const;

/** The minimum a row must carry for a share to be built from it. Structural, so the caller keeps its own type. */
type ShareableRow = {
  areaCode?: string | null;
  areaMismatch?: boolean;
  areaName?: string | null;
  blockCode?: string | null;
  bonusQty?: number | null;
  brickId?: string;
  brickName?: string | null;
  brickUnmapped?: boolean;
  clientAddress?: string | null;
  clientCode?: string | null;
  clientName?: string | null;
  discount?: number | null;
  distributorCode?: string | null;
  effectiveUnits?: number | null;
  factoryPrice?: number | null;
  invoiceDate?: string | null;
  isDirect?: boolean;
  missingClientCode?: boolean;
  officialLine?: string | null;
  productCode?: string | null;
  qty?: number | null;
  regionCode?: string | null;
  regionName?: string | null;
  rowNumber?: number | null;
  salesValue?: number | null;
  sheetAreaCode?: string | null;
  sheetAreaName?: string | null;
  sheetValue?: number | null;
};

const isMasked = (row: ShareableRow): boolean =>
  MASKED_SOURCE_DISTRIBUTORS.has(String(row.distributorCode ?? "").trim().toUpperCase());

/**
 * True for a row `buildMainStoresRows` made: no distributor, no client code, and the label for a name.
 *
 * All three, not the label alone. A real distributor's line with no client code could in principle
 * carry the words "Main Stores" as its buyer, and treating that as a warehouse share would take the
 * distributor's name off real money.
 */
export function isMainStoresRow(row: Pick<ShareableRow, "clientCode" | "clientName" | "distributorCode">): boolean {
  return !String(row.distributorCode ?? "").trim()
    && !String(row.clientCode ?? "").trim()
    && String(row.clientName ?? "").trim() === MAIN_STORES_LABEL;
}

/**
 * Whole units that add back to the total, by LARGEST REMAINDER.
 *
 * 🔴 ROUNDING EACH AREA ON ITS OWN INVENTS UNITS. Owner, 2026-09-10: "make the fraction to the
 * nearest full unit … 234.59 is 235". Taken literally, area by area, thirty-eight areas each
 * rounding a half unit upward manufactures about nineteen units of Lacto Advanced 1 that El Qema
 * never sold, and the detail sheet stops agreeing with the invoice it was built from.
 *
 * So every area is FLOORED first, and the spare units — always fewer than the number of areas — go
 * to the areas with the largest fractions. The parts then sum to exactly what was invoiced, which
 * is the invariant the whole rule rests on, and each area is still within one unit of its true
 * share. Measured on August 2026 Pedia: 6,692 and 2,076 units, exact across 38 areas.
 *
 * Ties go to whichever area the sort happens to reach first. That is acceptable here and would not
 * be if the tie decided money: the VALUE is never rounded, only the unit count printed beside it.
 */
export function wholeUnitShares<T>(shares: readonly { row: T; units: number }[]): { row: T; units: number }[] {
  const total = Math.round(shares.reduce((sum, share) => sum + share.units, 0));
  const floored = shares.map((share) => ({
    row: share.row,
    units: Math.floor(share.units),
    fraction: share.units - Math.floor(share.units),
  }));
  let spare = total - floored.reduce((sum, share) => sum + share.units, 0);
  for (const share of [...floored].sort((left, right) => right.fraction - left.fraction)) {
    if (spare <= 0) break;
    share.units += 1;
    spare -= 1;
  }
  return floored.map((share) => ({ row: share.row, units: share.units }));
}

/** An area's own label, for a row the split has just moved into it. */
export type AreaLabel = { areaName: string; regionCode: string; regionName: string };

/**
 * 🔒 THE CREDITED VIEW — every wholesaler's rows where the CLOSING books them.
 *
 * Owner, 2026-09-10, having seen Main Stores work on El Qema and asked for the rest: "yes do the
 * same for the rest."
 *
 * WHAT IT FIXES. This sheet listed rows AS INVOICED while the closing pays on where the goods were
 * earned, so the two disagreed for every area a wholesaler's city split touched. Measured on August
 * Pedia before this: 17 of 46 areas tied to their own closing, and of the 29 that did not, 29 had
 * other wholesalers' store movement and NONE carried Office money. So the city split was the whole
 * of the remaining difference.
 *
 * WHAT MOVES AND WHAT DOES NOT. Only rows the split actually relocates. Everything else — every
 * pharmacy, every direct order, every wholesaler whose city has one area — passes through
 * byte-for-byte. A moved row keeps its CUSTOMER: the split never changes who bought, only which
 * area is credited, so naming the same wholesaler on each share is the closing's own belief rather
 * than an invention. El Qema is the one exception, and it becomes Main Stores.
 *
 * 🔴 A MOVED ROW MUST BE RELABELLED, AND THE SPLIT DOES NOT DO IT. `splitStoreSalesAcrossCityAreas`
 * rewrites area CODES and leaves `areaName`/`regionName` on the ORIGIN's, so a share that landed in
 * Qalubeya still called itself Sohag 1 — measured, and invisible from the codes alone. Which rows
 * moved is worked out by tagging each input row with the area it came from and comparing after,
 * rather than by re-deriving the split's own eligibility rule, which would then have two copies.
 *
 * ⚠ UNITS ON A MOVED ROW STAY FRACTIONAL, and that is deliberate. Its quantity and its value
 * are scaled by the SAME fraction, so value divided by units still equals the ex-factory price on
 * the row — round the units alone and the row stops multiplying out. Main Stores can be rounded
 * precisely because it carries no price (see `buildMainStoresRows`).
 */
export function applyCreditedAreaView<T extends ShareableRow & StoreSplitRow>(
  rows: readonly T[],
  input: {
    areaLabelOf: (areaCode: string) => AreaLabel | null;
    line: string | null | undefined;
    period: string | null | undefined;
    regions?: SplitRegions;
  },
): T[] {
  const period = String(input.period ?? "").trim();
  const line = String(input.line ?? "").trim();
  if (!isStoreCitySplitActive(period) || !isSplitEligibleLine(line)) return [...rows];

  const ORIGIN = "__creditedViewOriginArea" as const;
  const tagged = rows.map((row) => ({
    ...row,
    [ORIGIN]: String(closingAreaOf(row) ?? "").trim().toUpperCase(),
  })) as (T & Record<typeof ORIGIN, string>)[];

  const out: T[] = [];
  for (const row of splitStoreSalesAcrossCityAreas(tagged, period, input.regions).rows) {
    const origin = row[ORIGIN];
    const landed = String(closingAreaOf(row) ?? "").trim().toUpperCase();
    const { [ORIGIN]: _dropped, ...bare } = row;
    const clean = bare as unknown as T;
    if (!landed || landed === origin) {
      out.push(clean);
      continue;
    }
    const place = input.areaLabelOf(landed);
    out.push({
      ...clean,
      areaName: place?.areaName ?? landed,
      sheetAreaName: place?.areaName ?? landed,
      regionCode: place?.regionCode ?? clean.regionCode ?? "",
      regionName: place?.regionName ?? clean.regionName ?? "",
    });
  }
  // The weights are the rows after the city split (`out`), exactly as the closing's (rule 2).
  return creditEpdaSpread(out, out, { areaLabelOf: input.areaLabelOf, line, period });
}

/**
 * 🔴 THE EPDA SPREAD, CREDITED ROW BY ROW — owner's EPDA rule 2, from the October 2026 closing.
 *
 * The matrix moves EPDA-BULK's and EPDA-Pharmacies' Ivyronc, Royafloxacin and Saginko onto the areas
 * that earned them (closing-bulk-allocation.ts), and the city split above leaves those rows alone, so
 * without this a viewer's rows kept them on the invoiced area. A District Manager's file is rebuilt
 * from these rows (buildPortalClosingWorkbook), so his Matrix tab would have disagreed with his own
 * screen by his whole share of the EPDA book, and listed none of it when the invoiced area is outside
 * his scope.
 *
 * Each moved row becomes one share per receiving area, scaled by that area's part of the product's
 * spread (its IN leg over all the IN legs). Every row of a product moves by the same fractions, so the
 * shares of an area add back to exactly the units the matrix gave it, and value and units scale
 * together so each share still multiplies out at the row's own price. Units stay fractional for that
 * reason, as on a city-split share. The spread is computed from `allRows`, the whole month, exactly
 * as the closing computes it; the caller scopes afterwards.
 */
function creditEpdaSpread<T extends ShareableRow & StoreSplitRow>(
  rows: T[],
  allRows: readonly T[],
  input: { areaLabelOf: (areaCode: string) => AreaLabel | null; line: string; period: string },
): T[] {
  if (!isEpdaContributionActive(input.period)) return rows;
  const bulk = buildBulkAllocation(allRows as unknown as BulkAllocationRow[], input.period, input.line);
  const legsByProduct = new Map<string, { areaCode: string; inQty: number }[]>();
  for (const leg of bulk.movements) {
    if (!(leg.inQty > 0)) continue;
    const product = String(leg.productCode ?? "").trim().toUpperCase();
    const legs = legsByProduct.get(product) ?? [];
    legs.push({ areaCode: String(leg.areaCode ?? "").trim().toUpperCase(), inQty: leg.inQty });
    legsByProduct.set(product, legs);
  }
  if (legsByProduct.size === 0) return rows;

  const out: T[] = [];
  for (const row of rows) {
    const record = row as unknown as BulkAllocationRow;
    const product = String(row.productCode ?? "").trim().toUpperCase();
    const legs = legsByProduct.get(product);
    const moves = legs !== undefined
      && isBulkAllocatedRow(record, input.period)
      && record.includedInClosing
      && !record.isDirect
      && record.isConfidential !== true;
    if (!moves) {
      out.push(row);
      continue;
    }
    const total = legs.reduce((sum, leg) => sum + leg.inQty, 0);
    for (const leg of legs) {
      const fraction = leg.inQty / total;
      const place = input.areaLabelOf(leg.areaCode);
      const effective = Number(row.effectiveUnits);
      out.push({
        ...row,
        areaCode: leg.areaCode,
        sheetAreaCode: leg.areaCode,
        qty: (Number(row.qty) || 0) * fraction,
        salesValue: (Number(row.salesValue) || 0) * fraction,
        ...(Number.isFinite(effective) ? { effectiveUnits: effective * fraction } : {}),
        areaName: place?.areaName ?? leg.areaCode,
        sheetAreaName: place?.areaName ?? leg.areaCode,
        regionCode: place?.regionCode ?? row.regionCode ?? "",
        regionName: place?.regionName ?? row.regionName ?? "",
      });
    }
  }
  return out;
}

/**
 * One Main Stores row per area and product, standing in for the masked distributor's warehouses.
 *
 * 🔴 IT TAKES THE WHOLE MONTH'S ROWS, NEVER A VIEWER'S OWN SLICE. A share is a fraction of a
 * national pool: computed over one region's rows it would divide the same warehouse among the four
 * areas that happen to be on screen and hand each of them nine times what the closing credits. The
 * caller must pass the rows as loaded, BEFORE any access scope is applied, and let the scope drop
 * the areas this viewer may not see afterwards.
 *
 * Returns [] when the split does not reach this month or this line, so a caller can concatenate it
 * unconditionally.
 */
export function buildMainStoresRows<T extends ShareableRow & StoreSplitRow>(
  rows: readonly T[],
  input: {
    areaNameOf: (areaCode: string) => { areaName: string; regionCode: string; regionName: string } | null;
    line: string | null | undefined;
    period: string | null | undefined;
    regions?: SplitRegions;
  },
): T[] {
  const period = String(input.period ?? "").trim();
  const line = String(input.line ?? "").trim();
  if (!isStoreCitySplitActive(period) || !isSplitEligibleLine(line)) return [];
  if (!rows.some(isMasked)) return [];

  // The split is run over EVERY row, not just the masked ones. It is one arithmetic: a warehouse's
  // pool, who is eligible to receive from it, and the lead ladder that sits on top. Handing it a
  // filtered population would change the answer, and the answer has to be the same one the Closing
  // Matrix was built from or the sheet will not tie to it.
  const landed = splitStoreSalesAcrossCityAreas(rows, period, input.regions).rows.filter(isMasked);
  if (landed.length === 0) return [];

  type Bucket = { area: string; template: T; units: number; value: number };
  const buckets = new Map<string, Map<string, Bucket>>();
  for (const row of landed) {
    const area = String(closingAreaOf(row) ?? "").trim().toUpperCase();
    const product = String(row.productCode ?? "").trim().toUpperCase();
    if (!area || !product) continue;
    const perArea = buckets.get(product) ?? new Map<string, Bucket>();
    const bucket = perArea.get(area) ?? { area, template: row, units: 0, value: 0 };
    bucket.units += Number(row.qty) || 0;
    bucket.value += Number(row.salesValue) || 0;
    perArea.set(area, bucket);
    buckets.set(product, perArea);
  }

  const out: T[] = [];
  for (const perArea of buckets.values()) {
    // Per PRODUCT, across every area at once — see `wholeUnitShares`.
    const rounded = wholeUnitShares(
      [...perArea.values()].map((bucket) => ({ row: bucket, units: bucket.units })),
    );
    for (const { row: bucket, units } of rounded) {
      // A share worth nothing is not a row. An area can land on zero after rounding when its true
      // share was under half a unit, and printing a zero row for it says "you sold none of this",
      // which is a different and worse claim than saying nothing at all.
      if (units <= 0 && Math.round(bucket.value) === 0) continue;
      const place = input.areaNameOf(bucket.area);
      out.push({
        ...bucket.template,
        areaCode: bucket.area,
        sheetAreaCode: bucket.area,
        // BOTH names move with the code. The split rewrites area CODES and leaves the labels on the
        // origin's, so a share that landed in Qalubeya still called itself Sohag 1 — measured, and
        // invisible from the codes alone.
        areaName: place?.areaName ?? bucket.area,
        sheetAreaName: place?.areaName ?? bucket.area,
        regionCode: place?.regionCode ?? bucket.template.regionCode ?? "",
        regionName: place?.regionName ?? bucket.template.regionName ?? "",
        distributorCode: "",
        clientCode: "",
        clientName: MAIN_STORES_LABEL,
        clientAddress: "",
        // 🔴 NOR ANYTHING COPIED OFF ONE OF EL QEMA'S OWN INVOICE LINES. The row above is spread from
        // `bucket.template`, the first warehouse share that happened to land in this area, so without
        // these it printed that warehouse's brick, block, invoice date, sheet row and discount. On
        // Pedia 2026-08 El Qema's rows sit in 14 warehouse bricks, Benha's among them with 6,656 units,
        // so a Kafr El-Sheikh 1 row could name a brick in Benha: the Details tab shows the brick on
        // every row, and the scoped workbook prints every one of these columns. It was not even true:
        // a share is pooled from all of El Qema's warehouses, so there is no one brick or invoice
        // behind it, just as there is no one buyer. The two flags go with the brick they describe.
        brickId: "",
        brickName: "",
        blockCode: "",
        invoiceDate: null,
        rowNumber: null,
        discount: 0,
        areaMismatch: false,
        brickUnmapped: false,
        factoryPrice: null,
        qty: units,
        bonusQty: 0,
        effectiveUnits: units,
        salesValue: Number(bucket.value.toFixed(6)),
        sheetValue: Number(bucket.value.toFixed(6)),
        isDirect: false,
        // The row has no client code BY DESIGN, so it must not be counted as a row that LOST one.
        // `missingClientCode` feeds the detail tab's "no traceable outlet" banner, which would then
        // size the Main Stores money and point a reader straight back at what this rule hides.
        missingClientCode: false,
      });
    }
  }
  return out;
}
