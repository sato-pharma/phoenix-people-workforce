import { invalidateCrmDailyForecastCache } from "@/lib/dashboard/invalidation";
import { lineName, resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { isClosingLocked } from "@/lib/sales/monthly-closing-lock";
import { isClosingPublished } from "@/lib/sales/monthly-closing-publication";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// DROP ONE LINE'S TARGETS FOR ONE MONTH — Super Admin only (owner, 2026-10-04).
//
// `au.monthly_targets` keeps no history, so an overwritten or deleted target cannot be recovered.
// The RPC therefore copies the rows into `au.monthly_targets_dropped` and deletes them in one
// transaction. A dropped month can be put back by hand from that archive.
//
// A line whose closing for that month is PUBLISHED or LOCKED is refused: the Monthly Closing is the
// one source of truth for every target figure, and a published month is never corrected.
// ─────────────────────────────────────────────────────────────────────────────

export class DropTargetsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DropTargetsRefusedError";
  }
}

const PERIOD_RE = /^\d{4}-\d{2}$/;

export async function dropMonthlyTargets(input: {
  period: string;
  line: string;
  actorHrId: string | null;
}): Promise<{ dropped: number; lineLabel: string }> {
  if (!PERIOD_RE.test(input.period)) throw new DropTargetsRefusedError("Invalid month.");
  const lineCode = resolveTargetLineCode(input.line);
  if (!lineCode) throw new DropTargetsRefusedError("Unknown line.");
  const lineLabel = lineName(lineCode);

  if ((await isClosingPublished(lineLabel, input.period)) || (await isClosingLocked(lineLabel, input.period))) {
    throw new DropTargetsRefusedError(
      `${lineLabel} ${input.period} has a published or locked monthly closing — its targets cannot be dropped.`,
    );
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_drop_monthly_targets", {
    p_period: input.period,
    p_line_code: lineCode,
    p_actor: input.actorHrId,
  });
  if (error) throw error;
  invalidateCrmDailyForecastCache(`monthly targets dropped — ${lineLabel}/${input.period}`);
  const dropped = Number(data ?? 0);
  return { dropped: Number.isFinite(dropped) ? dropped : 0, lineLabel };
}
