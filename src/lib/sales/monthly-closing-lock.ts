import { logError } from "@/lib/observability/log";
import { normalizeClosingLine } from "@/lib/sales/monthly-closing-publication";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Closing — LOCK state (per line, per period).
//
// A lock freezes a month so its numbers cannot move again: not from the UI, not
// from a re-import, not from a migration, not from ad-hoc SQL. That last group
// is the reason this exists. The enforcement is NOT here — it is database
// triggers on source_of_sales_import_rows, source_of_sales_fact_rollup and
// source_of_sales_customer_directory_rollup (migration
// 20260810140000_monthly_closing_lock). This module is only the switch and the
// read; deleting it would not weaken the lock by one row.
//
// Lock and unlock are both a single click by the owner's decision — no reason
// to type, no second confirmation. A switch that is annoying to use does not
// get used, and an unused lock protects nothing. Who did it and when is
// recorded automatically because that costs the operator nothing.
//
// Reads fail SAFE — but note which way "safe" points here. For publication,
// safe means "assume unpublished" so a draft never leaks. For a lock, safe
// means the same: assume NOT locked, so a failed read can never present an
// unlocked month as protected. The database is the thing that actually says no.
// ─────────────────────────────────────────────────────────────────────────────

export type ClosingLock = {
  line: string;
  lockedAt: string;
  lockedBy: string | null;
  period: string;
  snapshotCells: number | null;
  snapshotUnits: number | null;
};

/** The active lock for (line, period), or null when the month is open. */
export async function getClosingLock(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<ClosingLock | null> {
  const normalizedLine = normalizeClosingLine(line);
  const trimmedPeriod = String(period ?? "").trim();
  if (!normalizedLine || !trimmedPeriod) return null;

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("monthly_closing_locks")
      .select("line,period,locked_at,locked_by,snapshot_units,snapshot_cells")
      .eq("normalized_line", normalizedLine)
      .eq("period", trimmedPeriod)
      .is("unlocked_at", null)
      .maybeSingle();
    if (error || !data) return null;
    return {
      line: String(data.line ?? ""),
      lockedAt: String(data.locked_at ?? ""),
      lockedBy: data.locked_by ? String(data.locked_by) : null,
      period: String(data.period ?? ""),
      snapshotCells: data.snapshot_cells === null ? null : Number(data.snapshot_cells),
      snapshotUnits: data.snapshot_units === null ? null : Number(data.snapshot_units),
    };
  } catch {
    return null;
  }
}

/** True when (line, period) is frozen. */
export async function isClosingLocked(
  line: string | null | undefined,
  period: string | null | undefined,
): Promise<boolean> {
  return (await getClosingLock(line, period)) !== null;
}

/**
 * Freeze (line, period). The RPC records the month's units and per-area breakdown in the same
 * statement that writes the lock, so the snapshot is provably the state that got frozen rather than
 * whatever the tables held by the time someone next looked.
 */
export async function lockClosing(input: {
  actorHrId?: string | null;
  line: string;
  period: string;
}): Promise<ClosingLock> {
  const line = String(input.line ?? "").trim();
  const period = String(input.period ?? "").trim();
  if (!line || !period) throw new Error("A line and a period are required to lock a closing.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_lock_monthly_closing", {
    p_actor: input.actorHrId ?? null,
    p_line: line,
    p_period: period,
  });
  if (error) {
    logError("Failed to lock a monthly closing", { context: { line, period }, error });
    throw new Error(error.message || "Failed to lock the closing.");
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    line: String(row?.line ?? line),
    lockedAt: String(row?.locked_at ?? ""),
    lockedBy: row?.locked_by ? String(row.locked_by) : null,
    period: String(row?.period ?? period),
    snapshotCells: row?.snapshot_cells === null || row?.snapshot_cells === undefined ? null : Number(row.snapshot_cells),
    snapshotUnits: row?.snapshot_units === null || row?.snapshot_units === undefined ? null : Number(row.snapshot_units),
  };
}

/** Release the lock. The lock row is kept and stamped, never deleted. */
export async function unlockClosing(input: {
  actorHrId?: string | null;
  line: string;
  period: string;
  reason?: string | null;
}): Promise<void> {
  const line = String(input.line ?? "").trim();
  const period = String(input.period ?? "").trim();
  if (!line || !period) throw new Error("A line and a period are required to unlock a closing.");

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("phx_unlock_monthly_closing", {
    p_actor: input.actorHrId ?? null,
    p_line: line,
    p_period: period,
    p_reason: input.reason ?? null,
  });
  if (error) {
    logError("Failed to unlock a monthly closing", { context: { line, period }, error });
    throw new Error(error.message || "Failed to unlock the closing.");
  }
}
