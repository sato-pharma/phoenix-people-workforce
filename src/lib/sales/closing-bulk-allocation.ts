// The EPDA-BULK contribution allocation — the owner's rule of 2026-10-09, from the September 2026
// closing on.
//
// The bulk sector (`EP-BK`, "ساتو قطاع الجملة") invoices wholesalers who supply the whole country,
// so the area on its invoice says where the warehouse is and nothing about where the medicine was
// sold. From September its Pedia units are therefore spread across the line's areas by each area's
// share of the OTHER distributors' sales value — his words: "the total sales contribution of the
// other distributors over the total sales … and based on this distribute the same contribution from
// EPDA bulk", and "distributed and calculated exactly as office".
//
// 🔴 THE ARITHMETIC IS NOT HERE. It is the shared contribution-respread engine
// (`contribution-respread.ts`), which this module and the Office channel's read-time respread
// (`closing-office-respread.ts`) both drive — because they ARE one rule applied to different rows,
// and a second hand-written copy of a largest-remainder spread agrees on the test data and disagrees
// on a return. This module owns only the two things that are the bulk rule's own: which rows move
// (the bulk sector's, on an allocated line, carrying an allocated product, in a covered month) and
// which rows the weights come from (every other distributor row of the closing).
//
// 🔴 AND ONLY IVYRONC MOVES. He narrowed his own rule the same evening — "IN EPDA BULK ONLY IVYRONC
// WILL BE CONTRIBUTION ANY OTHER PRODUCT NORMAL MAPPING" — so the bulk book is read per PRODUCT:
// `IV001` is spread by contribution, and every other product of the same book keeps the area its
// invoice names and takes the ordinary rules, the city split included. The gate is
// `isBulkAllocatedProduct` (bulk-allocation-channel.ts), asked both here and by the city rule's
// carve-out, so the allocation and the carve-out are the same width by construction rather than by
// two lists agreeing.
//
// The alternative — re-stamping the rows' area at upload, the way the Office channel is BORN
// allocated — was rejected deliberately. Office is uploaded last by convention, so its weights see
// the finished month; the bulk file is one distributor sheet among nineteen and lands whenever it
// lands. An upload-time spread would freeze whatever happened to be in the period that hour and
// nothing downstream would ever report it. Measured on CNS August 2026, the Office channel's own
// upload-time shares were already stale: its last batch landed 10 September 20:15 Cairo, and 6,834 of
// its 109,719 units (6.23%, 548,777 EGP, measured on the live rows 9 October 2026) sit in a different
// area from the one the current data would give them. That measurement is what the owner acted on the same day, and
// the Office channel now takes its own read-time respread for exactly this reason. A net recomputed
// on every read cannot go stale that way.

import {
  isBulkAllocatedProduct,
  isBulkAllocationActive,
  isBulkAllocationLine,
  isBulkDistributorCode,
} from "@/lib/sales/bulk-allocation-channel";
import {
  buildContributionRespread,
  emptyContributionRespread,
  mergeRespreadIntoSplit,
  type ContributionRespread,
  type RespreadMergeableSplit,
  type RespreadRow,
} from "@/lib/sales/contribution-respread";
import { isEpdaBonusDeductionActive } from "@/lib/sales/import-epda-bonus-deduction";

/**
 * A closing detail row, narrowed to what this rule reads.
 *
 * `effectiveUnits` and `isConfidential` are optional so the arithmetic can be exercised with
 * hand-built rows: absent, the row's own `qty` is its effective units and the row is not
 * confidential, which is what every ordinary row is.
 */
export type BulkAllocationRow = RespreadRow;

/** Per area × product, what the allocation moved. `net` is keyed by `areaProductKey`. */
export type BulkAllocation = ContributionRespread;

/**
 * The city split's own result shape, spelled structurally rather than imported — see
 * RespreadMergeableSplit.
 */
export type BulkMergeableSplit = RespreadMergeableSplit;

/**
 * The allocation for ONE line and period, computed over the WHOLE month's rows.
 *
 * `rows` must be the whole month, never a filtered or access-scoped slice: a share is a fraction of
 * the line's national sales, so a regional manager's four areas would otherwise divide the bulk book
 * among themselves and each take several times what the closing credits.
 *
 * Returns an EMPTY allocation — not a throw — whenever the rule does not apply or cannot be
 * computed: a period before September 2026, a line that is not Pedia, a month with no bulk rows, a
 * month whose bulk rows carry no Ivyronc (which is every month uploaded so far), or (the one that
 * matters) a month whose other distributors have no sales value to weight on at all. In that last case the bulk rows keep their invoiced area, which is the state the closing was
 * in before this rule and the only honest answer when there is no contribution to copy.
 *
 * PURE: no database, no clock, no cache. Every caller hands it the rows it already has.
 */
export function buildBulkAllocation(
  rows: readonly BulkAllocationRow[],
  period: string | null | undefined,
  line?: string | null,
): BulkAllocation {
  if (!isBulkAllocationActive(period)) return emptyContributionRespread();
  // A caller that names the line gets an early exit; one that does not is answered per row below,
  // so a cross-line row set (the export's, before narrowing) still only moves Pedia's bulk.
  if (line !== undefined && line !== null && !isBulkAllocationLine(line)) {
    return emptyContributionRespread();
  }

  const base: BulkAllocationRow[] = [];
  const moved: BulkAllocationRow[] = [];
  for (const row of rows) {
    // The population is the DISTRIBUTOR half of the closing, exactly as the matrix defines it:
    // direct orders carry no area at all, and an excluded row is not in the number being shared.
    if (row.isDirect) continue;
    if (!row.includedInClosing) continue;
    if (row.isConfidential === true) continue;
    if (!isBulkAllocationLine(row.officialLine)) continue;
    if (isBulkDistributorCode(row.distributorCode)) {
      // 🔴 IVYRONC ONLY (owner, 2026-10-09: "IN EPDA BULK ONLY IVYRONC WILL BE CONTRIBUTION ANY
      // OTHER PRODUCT NORMAL MAPPING"). Any other product of the bulk book keeps its invoiced area —
      // and it joins NEITHER list, which is the part worth saying out loud: it is not a weight
      // either. The shares are "the other distributors'" contribution in his words, and the bulk
      // sector is not one of them whichever product its row carries. Putting an unallocated bulk row
      // into `base` would let the book help decide where its own Ivyronc goes.
      if (isBulkAllocatedProduct(row.productCode)) moved.push(row);
      continue;
    }
    base.push(row);
  }

  // From October the book's units are whole numbers and every area's share stays one (owner,
  // 2026-11-04: "never to put a decimal in units"). Earlier months keep what they published.
  return buildContributionRespread({ base, line: String(line ?? ""), moved, wholeUnits: isEpdaBonusDeductionActive(period) });
}

/**
 * Fold a bulk allocation into a city-split result — see `mergeRespreadIntoSplit`, which this is.
 *
 * Kept as its own name because three call sites and four tests read it, and because the Office
 * respread has a merge of its own that additionally reports the Office-only net.
 */
export function mergeBulkAllocationIntoSplit(
  split: BulkMergeableSplit,
  bulk: BulkAllocation,
): BulkMergeableSplit {
  return mergeRespreadIntoSplit(split, bulk);
}
