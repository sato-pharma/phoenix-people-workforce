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
import { loadClosingStoreSplit } from "@/lib/sales/closing-store-split-net";
import { applyStoreSplitToMatrix } from "@/lib/sales/store-split-matrix";
import { closingLoadConcurrency, createClosingLoadGate } from "@/lib/sales/closing-load-gate";

/** The pair a store split is read for, trimmed exactly as loadClosingStoreSplit trims its arguments. */
function storeSplitPairKey(line: string | null | undefined, period: string | null | undefined): string {
  return `${String(line ?? "").trim()}|${String(period ?? "").trim()}`;
}

async function readMonthlyClosingPartsWithStoreSplit(input?: {
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
  const earlySplit = requestedLine && requestedPeriod ? loadClosingStoreSplit(requestedLine, requestedPeriod) : null;
  earlySplit?.catch(() => {});
  const parts = await loadMonthlyClosingParts(input);
  const earlySplitFits =
    storeSplitPairKey(requestedLine, requestedPeriod) === storeSplitPairKey(parts.combined.line, parts.combined.period);
  const split = earlySplit && earlySplitFits
    ? await earlySplit
    : await loadClosingStoreSplit(parts.combined.line, parts.combined.period);
  const { net, officeNet } = split;
  if (net.size === 0) return parts;
  const combined = applyStoreSplitToMatrix(parts.combined, net);
  // 🔴 THE ONE PLACE THE "GRAND TOTAL CANNOT CHANGE" INVARIANT IS ACTUALLY ASKED.
  //
  // `applied` is the sum of the deltas that DID land — which is the same thing as the shift in the
  // grand total. A whole month's net is zero-sum by construction (every unit one area loses another
  // area gains), so on an unfiltered read the landed deltas must cancel to zero. A filtered export
  // is the case where they legitimately do not, and the workbook says so out loud; this loader is
  // never filtered — it is the whole line for the whole month — so anything but zero here means one
  // leg landed and its counterpart found no row, and that difference left the closing's national
  // total with nothing receiving it. That is precisely how Pedia 2026-08 came to print 45,559.99 EGP
  // less than its own inputs for nine weeks: the Fayoum/Beni Suef fold left Beni Suef's leg with no
  // row to land on, and `applied` was computed, returned and read by nobody on this path.
  //
  // Logged, never thrown: a closing that refuses to render is worse than one that is short, and the
  // number is useless to the reader on screen. The line and month are named so the log says which
  // closing to go and look at. `tests/closing-merged-area-split-fold.test.ts` asserts the zero.
  if (combined.applied.qty !== 0 || combined.applied.value !== 0) {
    console.warn("Monthly Closing: the store split did not fully land on an unfiltered matrix.", {
      line: parts.combined.line,
      period: parts.combined.period,
      unlandedUnits: combined.applied.qty,
      unlandedValue: combined.applied.value,
    });
  }
  return {
    combined: combined.matrix,
    retail: applyStoreSplitToMatrix(parts.retail, net).matrix,
    directCells: parts.directCells,
    // 🔴 THE OFFICE GRID TAKES THE OFFICE RESPREAD'S NET, AND NOTHING ELSE OF `net`.
    //
    // The city split and the EPDA-BULK allocation never move an Office row — Office rows carry no
    // customer at all (clientCode is null by construction), so none of them is ever a store row —
    // and pushing either net onto this grid would make "of which Office" exceed the area's own
    // Office units. That is why this grid was passed straight through until 2026-10-09.
    //
    // The Office channel's own read-time respread (owner, 2026-10-09; CNS, from the September closing)
    // moves exactly these rows, so leaving the grid untouched is now the error: "of wh. Office"
    // would still describe the areas the UPLOAD stamped on them while the matrix beside it describes
    // today's, and the Closing Matrix (No Office) tab — literally `matrix − office`, cell by cell —
    // would stop describing distributor sell-out and could print a negative. `officeNet` is that
    // slice on its own (closing-store-split-net.ts), empty on every line but CNS and every month
    // before 2026-09, so every other closing keeps the grid it had.
    office: parts.office && officeNet.size > 0
      ? applyStoreSplitToMatrix(parts.office, officeNet).matrix
      : parts.office,
  };
}

// Every closing read in the app comes through this gate: a few at a time, and one shared read per
// line and month while it is loading (closing-load-gate.ts). `reuseMs` is for the read-only screens.
const closingLoadGate = createClosingLoadGate<MonthlyClosingParts>({
  load: readMonthlyClosingPartsWithStoreSplit,
  maxConcurrent: closingLoadConcurrency(),
});

export function loadMonthlyClosingPartsWithStoreSplit(
  input?: { line?: string | null; period?: string | null },
  options?: { reuseMs?: number },
): Promise<MonthlyClosingParts> {
  return closingLoadGate.load(input, options);
}

export async function loadMonthlyClosingWithStoreSplit(input?: {
  line?: string | null;
  period?: string | null;
}): Promise<MonthlyClosingMatrix> {
  return (await loadMonthlyClosingPartsWithStoreSplit(input)).combined;
}
