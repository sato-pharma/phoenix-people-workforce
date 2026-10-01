// The Closing Matrix, with the store split already applied — so the on-screen numbers match the
// downloaded workbook (which has always applied it, via prepareClosingStoreSplit at export time).
//
// Kept as its own module rather than folded into loadMonthlyClosingParts itself: store-split-matrix.ts
// already imports MonthlyClosingMatrix/cell helpers FROM monthly-distributor-import.ts, so having
// monthly-distributor-import.ts import back from store-split-matrix.ts would create an import cycle.
// This module sits above both instead.
//
// Applied to `combined` and `retail` independently (not derived from one another) — exactly how the
// export route applies it to its own `workbookMatrix` and `channels.retail` separately — because
// addition commutes: (retail + splitDelta) + direct = (retail + direct) + splitDelta, so applying
// the same net to both grids independently keeps "Retail + Direct = master" true cell by cell without
// needing to re-run direct injection here.

import {
  loadMonthlyClosingParts,
  type MonthlyClosingMatrix,
  type MonthlyClosingParts,
} from "@/lib/sales/monthly-distributor-import";
import { loadClosingStoreSplitNet } from "@/lib/sales/closing-store-split-net";
import { applyStoreSplitToMatrix } from "@/lib/sales/store-split-matrix";

/** The pair a store split is read for, trimmed exactly as loadClosingStoreSplit trims its arguments. */
function storeSplitPairKey(line: string | null | undefined, period: string | null | undefined): string {
  return `${String(line ?? "").trim()}|${String(period ?? "").trim()}`;
}

export async function loadMonthlyClosingPartsWithStoreSplit(input?: {
  line?: string | null;
  period?: string | null;
}): Promise<MonthlyClosingParts> {
  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): when the caller names
  // both the line and the month, the store split is read for that pair beside the closing parts
  // instead of after them. The parts can still land on another pair — a line or month that is not
  // available falls back to the first one that is — so the early read is used ONLY when the parts'
  // own line and month are the pair it was read for; otherwise the split is read for the parts'
  // pair, exactly as before. The guard keeps an early read nobody uses from surfacing unhandled.
  const requestedLine = input?.line;
  const requestedPeriod = input?.period;
  const earlyNet = requestedLine && requestedPeriod ? loadClosingStoreSplitNet(requestedLine, requestedPeriod) : null;
  earlyNet?.catch(() => {});
  const parts = await loadMonthlyClosingParts(input);
  const earlyNetFits =
    storeSplitPairKey(requestedLine, requestedPeriod) === storeSplitPairKey(parts.combined.line, parts.combined.period);
  const net = earlyNet && earlyNetFits
    ? await earlyNet
    : await loadClosingStoreSplitNet(parts.combined.line, parts.combined.period);
  if (net.size === 0) return parts;
  return {
    combined: applyStoreSplitToMatrix(parts.combined, net).matrix,
    retail: applyStoreSplitToMatrix(parts.retail, net).matrix,
    directCells: parts.directCells,
    // `office` is deliberately NOT split. The split moves WHOLESALER customers between the areas of
    // one city; Office rows carry no customer at all (clientCode is null by construction), so none
    // of them is ever a store row and none of them ever moves. Passing it through applyStoreSplitToMatrix
    // would push another channel's net onto the Office grid and make "of which Office" exceed the
    // area's own Office units.
    office: parts.office,
  };
}

export async function loadMonthlyClosingWithStoreSplit(input?: {
  line?: string | null;
  period?: string | null;
}): Promise<MonthlyClosingMatrix> {
  return (await loadMonthlyClosingPartsWithStoreSplit(input)).combined;
}
