import type { ReconciliationOutcome } from "@/lib/reconciliation/types";

/**
 * Re-runs a check once when it disagrees, and reports the SECOND answer.
 *
 * Some comparisons read their two sides with separate queries, so a collection run or an upload
 * landing between them looks exactly like a defect. A disagreement caused by that race does not
 * survive a fresh read; a real defect does. This is the cheapest way to buy that certainty —
 * nothing is paid on the healthy path, and a false alarm here would cost far more than one extra
 * read, because an invariant that cries wolf gets ignored along with the ones telling the truth.
 *
 * Only wrap checks whose sides genuinely cannot be read atomically. A check reading one immutable
 * batch has no race to absorb and must not pay for one.
 */
export function retryOnceIfBreached(
  run: () => Promise<ReconciliationOutcome>,
): () => Promise<ReconciliationOutcome> {
  return async () => {
    const first = await run();
    if (first.holds) return first;
    return run();
  };
}
