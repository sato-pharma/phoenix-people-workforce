import type { SupabaseClient } from "@supabase/supabase-js";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Keep the `expense_claims` mirror in step with the legacy outstation tables.
 *
 * WHY THIS EXISTS. Phase 2 of the outstation rebuild put a read mirror (`expense_claims`) in front
 * of the legacy tables and switched reads onto it — `PHOENIX_EXPENSE_CLAIMS_READ=true` on Railway
 * production since 2026-08-12, wired at `expenses.ts` where a list read with no reportId loads
 * `claims-read.ts`. Writes never cut over (phase 3 part 2 was never done), so the legacy tables are
 * still the source of truth and the mirror is only correct for as long as something rebuilds it.
 *
 * Nothing did. `phx_refresh_expense_claims()` is service_role-only and had NO caller anywhere —
 * not a cron job, not a route, not a trigger. It was invoked by hand on 2026-08-19 and then not
 * again. By 2026-08-29 the mirror had drifted for ten days: 31 approved claims (EGP 15,294.74)
 * existed in the legacy tables and were absent from what approvers could see, and 4 more showed
 * `submitted` while the legacy row said `approved`. Nothing surfaced it, because a stale mirror
 * and a correct one look identical from the product — the rows are simply not there.
 *
 * This module is that missing caller. The cron route drives it; the schedule is what makes the
 * guarantee, not this code.
 *
 * THE RESPONSE BODY IS THE POINT. A 200 from this job does not mean the mirror is correct — it
 * means the rebuild ran. `parity` is what says it is correct, read back from
 * `v_expense_claims_parity` after the rebuild commits. Read that, not the status code (AGENTS.md
 * §3 — the outbox drain returned HTTP 200 every five minutes for thirteen days while doing
 * nothing).
 */

/** The slice of the Supabase surface this module uses, so a test can hand it a stub. */
export type SupabaseAdmin = Pick<SupabaseClient, "rpc" | "from">;

export type ExpenseClaimsParity = {
  /** Rows in the parity view — one per legacy claim. */
  total: number;
  /** Rows the view does NOT call OK: MISSING_IN_NEW or STATUS_DRIFT. */
  drifted: number;
  /** Up to 20 drifted claim refs, so a failure names itself in the job history. */
  driftedRefs: string[];
  clean: boolean;
};

export type ExpenseClaimsRefreshResult =
  | {
      status: "refreshed";
      claims: number;
      imports: number;
      flagged: number;
      refreshedAt: string | null;
      /** Null only when the rebuild succeeded but the parity read-back itself failed. */
      parity: ExpenseClaimsParity | null;
    }
  | {
      status: "blocked";
      /** The interlock's own message, verbatim — it names which interlock and how many rows. */
      reason: string;
    };

/**
 * A refusal by one of the function's two interlocks, rather than a fault.
 *
 * Both are raised with `errcode = 'P0001'` (raise_exception). They mean the rebuild is no longer
 * safe — writes have cut over, or payroll linkage now exists that the rebuild would destroy — and
 * both need a human decision, not a retry.
 */
function isInterlockRefusal(error: { code?: string | null } | null): boolean {
  return error?.code === "P0001";
}

/**
 * Turn a PostgREST error into a real `Error` before it leaves this module.
 *
 * Supabase hands back a PLAIN OBJECT — `{ message, details, hint, code }` — not an Error. Throwing
 * it as-is means every recorder downstream falls into its non-Error branch and writes the literal
 * "[object Object]": that is precisely what `job_heartbeats.last_detail` held for
 * phoenix-expense-claims-refresh on every failed run from 2026-09-03 02:51 Cairo, and what the
 * Railway log line said too. The job was red, hourly, and said nothing about why.
 *
 * `code` is carried in the message because it is the part that decides what to do — 23514 (a check
 * constraint refused the rebuilt row) and 57014 (this function's own 60s statement_timeout) are
 * different problems with the same red job, and the message is the only field every recorder keeps.
 * `cause` keeps the original object for anything that wants the structured fields.
 */
function asError(error: unknown, context: string): Error {
  if (error instanceof Error) return error;
  const code = (error as { code?: string | null } | null)?.code;
  const wrapped = new Error(`${context}: ${code ? `[${code}] ` : ""}${describeThrown(error)}`, { cause: error });
  wrapped.name = "ExpenseClaimsRefreshError";
  return wrapped;
}

/**
 * Read parity back without ever selecting the whole view.
 *
 * An unbounded PostgREST `.select()` stops at 1000 rows with no marker (AGENTS.md §2.1), which on
 * a growing table would silently under-report drift — the exact failure this job exists to catch.
 * So: an exact count for the total, and a bounded sample for the drifted rows.
 */
async function readParity(supabase: SupabaseAdmin): Promise<ExpenseClaimsParity> {
  const totalResult = await supabase
    .from("v_expense_claims_parity")
    .select("verdict", { count: "exact", head: true });
  if (totalResult.error) throw asError(totalResult.error, "parity total read failed");

  const driftResult = await supabase
    .from("v_expense_claims_parity")
    .select("claim_ref", { count: "exact" })
    .neq("verdict", "OK")
    .limit(20);
  if (driftResult.error) throw asError(driftResult.error, "parity drift read failed");

  const drifted = driftResult.count ?? 0;
  const driftedRefs = (driftResult.data ?? [])
    .map((row) => (row as { claim_ref?: string | null }).claim_ref)
    .filter((ref): ref is string => typeof ref === "string");

  return {
    total: totalResult.count ?? 0,
    drifted,
    driftedRefs,
    clean: drifted === 0,
  };
}

/**
 * Rebuild the mirror, then read back whether it agrees with the legacy tables.
 *
 * Idempotent — the function truncates and rebuilds from the legacy tables every time, so running
 * it twice in a row is the same as running it once. Safe to schedule as often as is useful.
 */
export async function refreshExpenseClaims(client?: SupabaseAdmin): Promise<ExpenseClaimsRefreshResult> {
  const supabase = client ?? (getSupabaseAdmin() as SupabaseAdmin);

  const { data, error } = await supabase.rpc("phx_refresh_expense_claims");

  if (error) {
    if (isInterlockRefusal(error)) {
      return { status: "blocked", reason: error.message };
    }
    throw asError(error, "phx_refresh_expense_claims() failed");
  }

  const payload = (data ?? {}) as {
    claims?: number;
    imports?: number;
    flagged?: number;
    refreshed_at?: string;
  };

  // The rebuild has already committed by this point. A parity read that fails is worth reporting,
  // but it must not turn a successful rebuild into a failed job — that would send a session
  // hunting a data problem that does not exist.
  let parity: ExpenseClaimsParity | null = null;
  try {
    parity = await readParity(supabase);
  } catch {
    parity = null;
  }

  return {
    status: "refreshed",
    claims: payload.claims ?? 0,
    imports: payload.imports ?? 0,
    flagged: payload.flagged ?? 0,
    refreshedAt: payload.refreshed_at ?? null,
    parity,
  };
}
