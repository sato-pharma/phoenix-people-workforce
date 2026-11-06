// Recruitment / ATS — batching for PostgREST `.in()` filters.
//
// PostgREST folds every `.in()` value into the request URL, and undici caps request headers at
// roughly 16KB. A UUID costs ~38 characters once encoded, so an unbatched list tips over at a few
// hundred ids and fails as `TypeError: fetch failed` / HeadersOverflowError — an error that names
// neither the query nor the size, and only appears once the table has grown enough in production.
//
// This module exists so that knowledge lives in ONE place. Before it, the batching loop and the
// comment explaining it sat in listApplications alone, while three sibling queries built the same
// unbounded filter with nothing to warn the next reader.
//
// Batch at 100: ~3.8KB of ids per request, comfortably inside the limit with room for the rest of
// the URL, and few enough round trips to matter (each one crosses to eu-central-1).

export const IN_FILTER_BATCH_SIZE = 100;

export function chunkIds(ids: readonly string[], size: number = IN_FILTER_BATCH_SIZE): string[][] {
  if (size < 1) throw new Error("chunkIds: size must be at least 1");
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    batches.push(ids.slice(index, index + size));
  }
  return batches;
}

/**
 * Run `fetchBatch` over `ids` in safe-sized batches and return every row, in batch order.
 *
 * Throws on the first batch that errors — callers that must degrade gracefully instead (a
 * best-effort enrichment, say) should use chunkIds directly and decide per batch.
 */
export async function fetchRowsInBatches<TRow>(
  ids: readonly string[],
  fetchBatch: (batch: string[]) => PromiseLike<{ data: TRow[] | null; error: { message?: string } | null }>,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (const batch of chunkIds(ids)) {
    rows.push(...(await fetchBatchWhole(batch, fetchBatch)));
  }
  return rows;
}

/**
 * A response this long may have been cut by PostgREST's response cap (Supabase's default is 1,000
 * rows, answered with no error and no marker). A batch of ids that fills one is read again in two
 * halves, and each half the same way, so a one-to-many read (an extraction per re-read, a view per
 * viewer) can never lose rows to the cap. Production's cap is unset today and a full response then
 * costs one extra pair of reads; the day the cap is switched on, nothing here silently shortens.
 */
const RESPONSE_SATURATION = 1000;

async function fetchBatchWhole<TRow>(
  batch: string[],
  fetchBatch: (batch: string[]) => PromiseLike<{ data: TRow[] | null; error: { message?: string } | null }>,
): Promise<TRow[]> {
  const { data, error } = await fetchBatch(batch);
  if (error) throw error;
  const rows = data ?? [];
  // One id left: its own rows are all there is to read, so there is nothing smaller to split into.
  if (rows.length < RESPONSE_SATURATION || batch.length < 2) return rows;
  const middle = Math.ceil(batch.length / 2);
  const first = await fetchBatchWhole(batch.slice(0, middle), fetchBatch);
  const second = await fetchBatchWhole(batch.slice(middle), fetchBatch);
  return [...first, ...second];
}
