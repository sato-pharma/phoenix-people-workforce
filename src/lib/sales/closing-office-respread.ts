// THE OFFICE CHANNEL'S READ-TIME RESPREAD — owner, 2026-10-09: "fix the Office allocation to
// read-time shares." From the October 2026 closing, CNS only.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔒 THE GOLDEN RULE IS NOT TOUCHED — ONLY THE MOMENT IT IS EVALUATED
//
// Office is the company's own stock, and the owner's LOCKED golden rule spreads its units across the
// line's areas by each area's share of the line's non-Office sales VALUE
// (`src/lib/sales/office-allocation.ts`, the `GOLDEN RULE · LOCKED` region, password-protected and
// pinned by tests/office-golden-rule-lock.test.ts). That formula is the rule here too, unchanged and
// unread-from: nothing in this module alters a threshold, a weight or a reconciliation.
//
// What this module changes is WHEN the weights are computed. They were computed once, at UPLOAD, and
// stamped onto the stored rows. So any distributor batch that landed, was re-mapped or was corrected
// AFTER the Office file left the Office units on a geography the data no longer supports — measured
// on the live CNS August 2026 rows on 9 October 2026, 6,834 of the 109,719 Office packs (6.23%,
// 548,777 EGP, and Office is 61.5% of that month) are credited to a different area from the one the
// current data gives them, with the Office file's last batch at 10 September 20:15 Cairo and the
// month published 10 September 23:22. Nothing reported it, and the only repair was to re-upload the
// Office file by hand.
//
// So the spread is recomputed on EVERY READ — and, exactly like the city split and the EPDA-BULK
// allocation, as a NET MOVEMENT rather than a rewrite of the stored rows:
//
//     net = (today's spread of the Office totals)  −  (the areas the upload stamped on them)
//
// The OUT legs come from the stored Office rows themselves, so the net cancels the stale spread
// precisely, whatever it was; the IN legs are today's. When nothing has moved since the upload the
// net is zero to the last decimal place — the invariant that says this is a CORRECTION and not a
// second allocation, pinned by tests/closing-office-respread.test.ts (its case 2, behind the case
// that pins the shares themselves against the locked rule). The arithmetic is the shared engine
// (`contribution-respread.ts`) that the bulk rule drives too — they are one rule applied to different
// rows, and a second copy of a largest-remainder spread agrees on the test data and disagrees on a
// return.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY NOT RE-RUN THE UPLOAD-TIME ALLOCATION INSTEAD
//
// The obvious alternative was to re-run `computeOfficeAllocation` whenever a CNS batch is re-mapped
// — the re-map already triggers the attribution refresh. It was rejected: that path REWRITES the
// stored Office rows, and rewriting them restates the Closing tab of a month that may already be
// published and announced. A net is additive and gated by period, so July, August and September keep
// the numbers they were published with and no earlier closing can move. 🔴 Those earlier months are
// NOT a backlog to go and fix — the 6.23% is the evidence for the rule, never a repair order.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE `office` GRID TAKES THIS NET TOO — AND ONLY THIS ONE
//
// "of wh. Office" and the Closing Matrix (No Office) tab are built from `MonthlyClosingParts.office`,
// a grid on the same area × product axes as the matrix. The no-Office tab is literally
// `matrix − office`, cell by cell (closing-matrix-without-office.ts). So if the matrix's Office units
// move area and the Office grid's do not, that subtraction stops describing distributor sell-out and
// can print NEGATIVE sales — which is why `mergeOfficeRespreadIntoSplit` carries the Office-only net
// out separately beside the combined one. The Office grid must never take the city split's or the
// bulk rule's net (neither touches an Office row), and the matrix must take all three.

import {
  isOfficeAllocationLine,
  isOfficeDistributorCode,
  isOfficeRespreadActive,
} from "@/lib/sales/office-distributor";
import {
  buildContributionRespread,
  emptyContributionRespread,
  mergeRespreadIntoSplit,
  type ContributionRespread,
  type RespreadMergeableSplit,
  type RespreadRow,
} from "@/lib/sales/contribution-respread";
import { applyOfficeOwnerException, officeOwnerExceptionFor } from "@/lib/sales/office-owner-exception";

/** A closing detail row, narrowed to what this rule reads. See RespreadRow. */
export type OfficeRespreadRow = RespreadRow;

/** Per area × product, what the respread moved. `net` is keyed by `areaProductKey`. */
export type OfficeRespread = ContributionRespread;

/**
 * The Office respread for ONE line and period, computed over the WHOLE month's rows.
 *
 * `rows` must be the whole month, never a filtered or access-scoped slice: a share is a fraction of
 * the line's national sales, so a regional manager's four areas would otherwise divide the Office
 * stock among themselves and each take several times what the closing credits. Same rule, and the
 * same reason, as the Main Stores view in monthly-closing-details.ts.
 *
 * Returns an EMPTY respread — not a throw — whenever the rule does not apply or cannot be computed:
 * a period before October 2026, a line with no Office channel, a month with no Office rows, or (the
 * one that matters) a month whose non-Office distributors have no sales value to weight on at all.
 * In that last case the Office rows keep the areas the upload gave them, which is the state the
 * closing was in before this rule and the only honest answer when there is no contribution to copy.
 *
 * PURE: no database, no clock, no cache. Every caller hands it the rows it already has.
 */
export function buildOfficeRespread(
  rows: readonly OfficeRespreadRow[],
  period: string | null | undefined,
  line?: string | null,
): OfficeRespread {
  if (!isOfficeRespreadActive(period)) return emptyContributionRespread();
  // A caller that names the line gets an early exit; one that does not is answered per row below,
  // so a cross-line row set still only moves the Office channel of a line that carries one.
  if (line !== undefined && line !== null && !isOfficeAllocationLine(line)) {
    return emptyContributionRespread();
  }

  const base: OfficeRespreadRow[] = [];
  const moved: OfficeRespreadRow[] = [];
  for (const row of rows) {
    // The population is the DISTRIBUTOR half of the closing, exactly as the matrix defines it, and
    // exactly the population the locked golden rule weights on: direct orders carry no area at all,
    // and an excluded row is not in the number being shared.
    if (row.isDirect) continue;
    if (!row.includedInClosing) continue;
    if (row.isConfidential === true) continue;
    if (!isOfficeAllocationLine(row.officialLine)) continue;
    if (isOfficeDistributorCode(row.distributorCode)) moved.push(row);
    else base.push(row);
  }

  // THE OWNER'S NAMED-MONTH EXCEPTION, if this line and month carry one — applied to the rule's
  // shares AFTER the rule, never instead of it. See office-owner-exception.ts for his words and the
  // approved table. Every other line and month passes straight through.
  const exception = officeOwnerExceptionFor(line ?? moved[0]?.officialLine, period);
  return buildContributionRespread({
    base,
    line: String(line ?? ""),
    moved,
    ...(exception
      ? {
          adjustShares: (ruleShare: ReadonlyMap<string, number>, officeValue: number) => {
            const result = applyOfficeOwnerException(ruleShare, exception, officeValue);
            if (!result.applied && result.reason) {
              console.warn("Office owner exception NOT applied — the rule's own shares are used.", {
                line: exception.line,
                period: exception.period,
                reason: result.reason,
              });
            }
            return result.areaShare;
          },
        }
      : {}),
  });
}

/**
 * A city-split result that also carries the OFFICE-ONLY net — see the header. `officeNet` is a
 * SUBSET of `net` (the same cells are already added into it), reported separately because the
 * `office` grid must take that part and nothing else.
 */
export type OfficeMergeableSplit = RespreadMergeableSplit & {
  officeNet: Map<string, { qty: number; value: number }>;
};

/**
 * Fold an Office respread into a split result, keeping its own net reachable.
 *
 * The nets are ADDED into `net`, never replaced — an area can legitimately take a share of a
 * wholesaler's city, a share of the bulk book AND a share of the Office channel, and each is
 * zero-sum per product, so the sum is too. `officeNet` is then the one slice the Office grid applies.
 *
 * An incoming `officeNet` is preserved and added to, so this composes: a caller may fold the city
 * split, then the bulk allocation, then this, in any order.
 */
export function mergeOfficeRespreadIntoSplit(
  split: RespreadMergeableSplit & { officeNet?: Map<string, { qty: number; value: number }> },
  office: OfficeRespread,
): OfficeMergeableSplit {
  const officeNet = new Map(split.officeNet ?? []);
  for (const [key, cell] of office.net) {
    const existing = officeNet.get(key);
    if (existing) officeNet.set(key, { qty: existing.qty + cell.qty, value: existing.value + cell.value });
    else officeNet.set(key, { ...cell });
  }
  return { ...mergeRespreadIntoSplit(split, office), officeNet };
}
