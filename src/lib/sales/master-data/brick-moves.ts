import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { logWarning } from "@/lib/observability/log";
import { refreshBatchRollups } from "@/lib/sales/normalizer/customer-map";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// A brick move (sos_relocate_brick) moves the sales rows of unlocked months inside the database, and record each file they re-stamped in
// source_of_sales_brick_move_files. The totals those files feed are rebuilt here, one file per claim:
// rebuilding them all is too slow for the request that made the move.

// How many moved files still wait for their totals to be rebuilt.
export async function countBrickMoveFilesPending(): Promise<number> {
  const { count, error } = await getSupabaseAdmin()
    .from("source_of_sales_brick_move_files")
    .select("batch_id", { count: "exact", head: true })
    .is("refreshed_at", null);
  if (error) throw error;
  return count ?? 0;
}

export type BrickMoveRefreshResult = {
  /** Files whose totals this call rebuilt. */
  refreshed: number;
  /** Files still waiting, including any that failed here. */
  remaining: number;
  /** Why a file could not be rebuilt, in words fit for the screen (the log keeps the database's). */
  failure: string | null;
  /**
   * The batches whose totals this call rebuilt, de-duplicated. The screen ignores them; the cron
   * clock settles their periods' split net afterwards — see brick-move-net-settle.ts.
   */
  rebuiltBatchIds: string[];
};

type FileClaim = { oldBrickId: string; batchId: string; movedAt: string };

function parseClaim(data: unknown): FileClaim | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const oldBrickId = String(row.oldBrickId ?? "").trim();
  const batchId = String(row.batchId ?? "").trim();
  const movedAt = String(row.movedAt ?? "").trim();
  return oldBrickId && batchId && movedAt ? { batchId, movedAt, oldBrickId } : null;
}

// Rebuilds moved files' totals until `budgetMs` has passed or none is left. Each file is claimed first
// (a five-minute claim, so two open tabs never rebuild one file at once) and counts as rebuilt only
// when every total rebuilt and no later move re-stamped the file meanwhile. A file that fails keeps its
// claim, so the files behind it still get their turn, and it is tried again once the claim runs out.
//
// `onFileRebuilt` fires the moment a file's totals COMMIT, before the next one is claimed. The screen
// does not need it; the cron clock does — a four-minute budget is long enough for a routine deploy to
// replace the container mid-drain, and liveness reported at the END of the run would then be lost for a
// run that was doing its job. See app/api/cron/brick-move-drain/route.ts.
export async function refreshMovedBrickFiles(options: {
  budgetMs: number;
  onFileRebuilt?: () => Promise<void> | void;
}): Promise<BrickMoveRefreshResult> {
  const supabase = getSupabaseAdmin();
  const deadline = Date.now() + Math.max(0, options.budgetMs);
  const rebuiltBatchIds = new Set<string>();
  let refreshed = 0;
  let failure: string | null = null;

  while (Date.now() < deadline) {
    const claimed = await supabase.rpc("sos_claim_brick_move_file", { p_old_brick: null });
    if (claimed.error) {
      failure = "The next moved file could not be picked up.";
      logWarning("Could not claim a moved brick's sales file to rebuild.", { error: claimed.error });
      break;
    }
    const claim = parseClaim(claimed.data);
    if (!claim) break;

    try {
      await refreshBatchRollups(supabase, claim.batchId, (step, message) => new Error(`${step}: ${message}`));
    } catch (error) {
      failure = "A moved file's totals could not be rebuilt.";
      logWarning("A moved brick's sales file could not have its totals rebuilt; it is retried once its claim runs out.", {
        context: { batchId: claim.batchId, oldBrickId: claim.oldBrickId },
        error,
      });
      continue;
    }

    const finished = await supabase.rpc("sos_finish_brick_move_file", {
      p_batch_id: claim.batchId,
      p_moved_at: claim.movedAt,
      p_old_brick: claim.oldBrickId,
      p_refreshed: true,
    });
    if (finished.error) {
      failure = "A rebuilt file could not be marked as done.";
      logWarning("Could not mark a moved brick's sales file as rebuilt.", {
        context: { batchId: claim.batchId, oldBrickId: claim.oldBrickId },
        error: finished.error,
      });
      break;
    }
    refreshed += 1;
    rebuiltBatchIds.add(claim.batchId);
    // Wrapped: a broken reporter must never turn a rebuild that has landed into a failed drain.
    try {
      await options.onFileRebuilt?.();
    } catch (error) {
      logWarning("A moved brick's sales file was rebuilt but the run could not be reported.", { error });
    }
  }

  if (refreshed > 0) invalidateSalesDashboardCache(`brick move: ${refreshed} sales file(s) rebuilt`);
  return {
    failure,
    rebuiltBatchIds: [...rebuiltBatchIds],
    refreshed,
    remaining: await countBrickMoveFilesPending(),
  };
}
