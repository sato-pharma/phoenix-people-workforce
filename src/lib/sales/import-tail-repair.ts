import { logError, logWarning } from "@/lib/observability/log";

/**
 * THE IMPORT TAIL'S REPAIR NOTE — written before the tail, crossed off after it (audit P4-03).
 *
 * A validated upload ends in a tail that runs in this process, outside the finalize transaction:
 * the store-split net, the second attribution refresh, the import summaries and the cache bust.
 * Finalize commits the new batch first. So a deploy, a dropped connection or a timeout between that
 * commit and the end of the tail left a LIVE batch whose attribution was built against the previous
 * import's split net, with nothing anywhere that would ever rebuild it.
 *
 * The note is a row in the brick-move queue (`source_of_sales_brick_move_files`), the table the
 * 20-minute `phoenix-brick-move-drain` already empties with the same full rebuild
 * (`refreshBatchRollups`: every rollup, the split net, attribution, the summaries) followed by the
 * split-net settle for the months it touched. Nothing new runs the repair.
 *
 * THE NORMAL PATH DOES THE WORK ONCE. The row is written already claimed: `refresh_started_at` is
 * set ahead to now + IMPORT_TAIL_HOLD_MS, and the drain only claims a row whose claim is older than
 * five minutes, so it leaves the file alone while the live tail runs. When the tail finishes,
 * `releaseImportTailRepair` calls `sos_finish_brick_move_file` with the same `moved_at`, which marks
 * the row rebuilt and clears the claim, so the drain never touches it. If the process dies first,
 * the claim runs out and the next drain fire rebuilds the file: 30 to 50 minutes after the stamp,
 * inside the one-hour stuck-file alert.
 *
 * A file the hold could not be written for still gets its tail: the hold failing is logged as an
 * error and the import carries on exactly as it did before this note existed. It never throws.
 */

/** How far ahead the live import sets its claim. The drain may take the file 5 minutes after this. */
export const IMPORT_TAIL_HOLD_MS = 25 * 60 * 1000;

/** At most this many of the batch's bricks are offered to the brick master as the row's key. */
const KEY_CANDIDATES = 100;

const QUEUE_TABLE = "source_of_sales_brick_move_files";

type QueryResult = { data: unknown; error: unknown };

type BrickMasterQuery = {
  in: (column: string, values: string[]) => PromiseLike<QueryResult>;
  limit: (count: number) => PromiseLike<QueryResult>;
};

type RepairQueueTable = {
  upsert: (rows: Record<string, unknown>[], options: { onConflict: string }) => PromiseLike<{ error: unknown }>;
};

/** The slice of the Supabase client the note uses — structural, so a test can hand it a fake. */
export type ImportTailRepairClient = {
  from: (table: string) => unknown;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<QueryResult>;
};

/** What the release needs to cross the note off: the queue row's key and the stamp it was written with. */
export type ImportTailHold = {
  batchId: string;
  brickId: string;
  movedAt: string;
};

/** The batch's bricks, most rows first, trimmed and de-duplicated. */
function brickCandidates(rowBrickIds: Iterable<unknown>): string[] {
  const counts = new Map<string, number>();
  for (const value of rowBrickIds) {
    const brick = String(value ?? "").trim();
    if (!brick) continue;
    counts.set(brick, (counts.get(brick) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, KEY_CANDIDATES)
    .map(([brick]) => brick);
}

function brickIdsOf(data: unknown): Set<string> {
  const rows = Array.isArray(data) ? (data as Array<{ brick_id?: unknown }>) : [];
  return new Set(rows.map((row) => String(row?.brick_id ?? "").trim()).filter(Boolean));
}

/**
 * The queue row's key must be a brick that EXISTS — `old_brick_id` references the brick master, and
 * an import row's brick has no such constraint. The batch's own most common brick when the master
 * knows it, otherwise any brick the master holds: the drain claims by file, never by brick.
 */
async function pickKeyBrick(supabase: ImportTailRepairClient, rowBrickIds: Iterable<unknown>): Promise<string | null> {
  const candidates = brickCandidates(rowBrickIds);
  const master = () => (supabase.from("source_of_sales_bricks") as { select: (columns: string) => BrickMasterQuery }).select("brick_id");
  if (candidates.length > 0) {
    const known = await master().in("brick_id", candidates);
    if (known.error) throw known.error;
    const found = brickIdsOf(known.data);
    const own = candidates.find((brick) => found.has(brick));
    if (own) return own;
  }
  const any = await master().limit(1);
  if (any.error) throw any.error;
  return [...brickIdsOf(any.data)][0] ?? null;
}

/**
 * Writes the repair note for a batch about to be finalized. Call it once the batch's rows are
 * stored and BEFORE finalize, so a finalize that commits after this process died is covered too.
 * Returns the note to release after the tail, or null when none could be written (logged).
 */
export async function holdImportTailRepair(
  supabase: ImportTailRepairClient,
  batchId: string,
  rowBrickIds: Iterable<unknown>,
  now: Date = new Date(),
): Promise<ImportTailHold | null> {
  try {
    const brickId = await pickKeyBrick(supabase, rowBrickIds);
    if (!brickId) throw new Error("the brick master returned no brick to key the repair note on");
    const movedAt = now.toISOString();
    const table = supabase.from(QUEUE_TABLE) as RepairQueueTable;
    const { error } = await table.upsert(
      [
        {
          batch_id: batchId,
          moved_at: movedAt,
          // An import moves no rows; the column is informational and the drain never reads it.
          moved_rows: 0,
          old_brick_id: brickId,
          refresh_started_at: new Date(now.getTime() + IMPORT_TAIL_HOLD_MS).toISOString(),
          refreshed_at: null,
        },
      ],
      { onConflict: "old_brick_id,batch_id" },
    );
    if (error) throw error;
    return { batchId, brickId, movedAt };
  } catch (error) {
    logError("A sales import could not write its repair note; its tail runs without one.", {
      context: { batchId },
      error,
      labels: { batchId, event: "sos_import_tail_repair_hold_failed" },
    });
    return null;
  }
}

/**
 * Crosses the note off once the tail has finished: the row is marked rebuilt only if no brick move
 * re-stamped the file since the hold (same `moved_at`), so a move that landed meanwhile still gets
 * its rebuild from the drain. A failed release only costs one extra rebuild once the claim runs out.
 */
export async function releaseImportTailRepair(
  supabase: ImportTailRepairClient,
  hold: ImportTailHold | null,
): Promise<boolean> {
  if (!hold) return false;
  try {
    const { data, error } = await supabase.rpc("sos_finish_brick_move_file", {
      p_batch_id: hold.batchId,
      p_moved_at: hold.movedAt,
      p_old_brick: hold.brickId,
      p_refreshed: true,
    });
    if (error) throw error;
    return data === true;
  } catch (error) {
    logWarning("A sales import finished its tail but could not cross off its repair note; the drain rebuilds the file once more.", {
      context: { batchId: hold.batchId, oldBrickId: hold.brickId },
      error,
    });
    return false;
  }
}
