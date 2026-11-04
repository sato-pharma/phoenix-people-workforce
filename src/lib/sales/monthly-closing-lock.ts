import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { logError } from "@/lib/observability/log";
import { describeAlreadyLocked, isActiveLockConflict } from "@/lib/sales/monthly-closing-lock-conflict";
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
 * Every frozen period for one line, in one read.
 *
 * The direct-order booking rule walks FORWARD from a frozen month to the first open one, so it
 * cannot know in advance which periods it will need to ask about. Asking per candidate would be a
 * round trip per month; a line has a handful of locks in total, so fetching the set once is both
 * cheaper and what lets the rule itself stay a pure, synchronous function.
 *
 * Fails SAFE the same way the rest of this module does — an unreadable lock table yields an EMPTY
 * set, so a failed read can never present an open month as frozen and silently shift someone's
 * booking into the wrong month. The database triggers remain the thing that actually says no.
 */
export async function listLockedPeriodsForLine(
  line: string | null | undefined,
): Promise<Set<string>> {
  const normalizedLine = normalizeClosingLine(line);
  if (!normalizedLine) return new Set();

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("monthly_closing_locks")
      .select("period")
      .eq("normalized_line", normalizedLine)
      .is("unlocked_at", null);
    if (error || !data) return new Set();
    return new Set(
      data
        .map((row) => String((row as { period?: unknown }).period ?? "").trim())
        .filter((period) => period !== ""),
    );
  } catch {
    return new Set();
  }
}

export type LockClosingResult =
  | { alreadyLocked: false; lock: ClosingLock }
  | { alreadyLocked: true; lock: ClosingLock; message: string };

async function alreadyLocked(lock: ClosingLock): Promise<LockClosingResult> {
  // Best-effort: a name that cannot be read is left out of the sentence, never replaced by the id.
  let lockedByName: string | null = null;
  try {
    lockedByName = lock.lockedBy ? (await namesByHrId([lock.lockedBy])).get(lock.lockedBy) : null;
  } catch {
    lockedByName = null;
  }
  return {
    alreadyLocked: true,
    lock,
    message: describeAlreadyLocked({ line: lock.line, lockedAt: lock.lockedAt, lockedByName, period: lock.period }),
  };
}

/**
 * Freeze (line, period). The RPC records the month's units and per-area breakdown in the same
 * statement that writes the lock, so the snapshot is provably the state that got frozen rather than
 * whatever the tables held by the time someone next looked.
 *
 * A month that is ALREADY locked — by an earlier press, another tab, or by publishing it, whose
 * trigger takes the lock itself — is answered as `alreadyLocked`, not as a failure: the month is in
 * exactly the state the caller asked for. It is checked before the RPC (which would otherwise
 * compute a whole snapshot only to lose to the unique index) and again on the RPC's 23505, which is
 * the race between two requests that both read "open". Nothing is logged for it, because nothing
 * went wrong (monthly-closing-lock-conflict.ts). The existing lock is never touched.
 */
export async function lockClosing(input: {
  actorHrId?: string | null;
  line: string;
  period: string;
}): Promise<LockClosingResult> {
  const line = String(input.line ?? "").trim();
  const period = String(input.period ?? "").trim();
  if (!line || !period) throw new Error("A line and a period are required to lock a closing.");

  const existing = await getClosingLock(line, period);
  if (existing) return alreadyLocked(existing);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_lock_monthly_closing", {
    p_actor: input.actorHrId ?? null,
    p_line: line,
    p_period: period,
  });
  if (error && isActiveLockConflict(error)) {
    // The unique index has just said the month holds an active lock, so it is locked even if the
    // read of who and when fails — the sentence then simply carries neither.
    const winner = await getClosingLock(line, period);
    return alreadyLocked(
      winner ?? { line, lockedAt: "", lockedBy: null, period, snapshotCells: null, snapshotUnits: null },
    );
  }
  if (error) {
    logError("Failed to lock a monthly closing", { context: { line, period }, error });
    throw new Error(error.message || "Failed to lock the closing.");
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    alreadyLocked: false,
    lock: {
      line: String(row?.line ?? line),
      lockedAt: String(row?.locked_at ?? ""),
      lockedBy: row?.locked_by ? String(row.locked_by) : null,
      period: String(row?.period ?? period),
      snapshotCells: row?.snapshot_cells === null || row?.snapshot_cells === undefined ? null : Number(row.snapshot_cells),
      snapshotUnits: row?.snapshot_units === null || row?.snapshot_units === undefined ? null : Number(row.snapshot_units),
    },
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
