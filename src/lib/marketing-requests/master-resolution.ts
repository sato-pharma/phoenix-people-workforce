import type { SupabaseClient } from "@supabase/supabase-js";

import { logWarning } from "@/lib/observability/log";

// ─────────────────────────────────────────────────────────────────────────────
// Resolve freshly-written marketing pharmacy codes against the Source-of-Sales customer master.
//
// WHY THIS EXISTS. `phx_resolve_marketing_pharmacy_codes` shipped on 2026-08-09
// (20260809014712_marketing_pharmacy_master_resolution.sql) as a deliberately data-only migration:
// the function was created, run once by hand over the 289 codes that existed that day, and then
// nothing ever called it again. Every code validated afterwards accumulated with
// `master_match_kind IS NULL` — silently, with no error and no surface anywhere showing the gap.
// Measured on production 2026-08-19: 28 codes, ten days of field work, none of it connected to the
// mapping database. That backlog was cleared by hand a second time; this module is what stops a
// third time from being necessary.
//
// WHY IT NEVER THROWS — READ THIS BEFORE CHANGING ANYTHING HERE.
// The only caller is `createMarketingValidationRecord`, and it calls this from INSIDE the try block
// whose catch DELETES every customer and pharmacy the submission just wrote. A throw escaping this
// module would therefore not merely skip resolution: a transient database blip would destroy a
// rep's completed field visit — GPS fix, live shop-front photo and all — and report it as a failed
// save. Resolution is an enrichment of a row that is already correct and already committed without
// it. It must never be able to take that row down with it. Every failure path here logs and
// returns false.
//
// WHY THE ID LIST IS ALWAYS EXPLICIT. The RPC treats a null `p_code_ids` as "resolve EVERY active
// code" — all 317 of them today, and growing. Passing null from a write path would re-run the whole
// table on every single validation, and would silently re-verdict rows that a human may have looked
// at since. This module refuses to send null: no ids means no call at all.
//
// NULL vs 'unresolved' IS LOAD-BEARING and belongs to the migration, not to us:
//   master_match_kind IS NULL        -> the resolver has never run for this row. No claim is made.
//   master_match_kind = 'unresolved' -> it DID run and found no candidate in the master.
// Calling this promotes NULL to a real verdict, which is the entire point. Never backfill the
// column any other way.
// ─────────────────────────────────────────────────────────────────────────────

/** The Source-of-Sales master resolver. `service_role` only — this always runs on the admin client. */
export const MARKETING_MASTER_RESOLVER_RPC = "phx_resolve_marketing_pharmacy_codes";

/**
 * The one method this needs from a Supabase client.
 *
 * Taken as a `Pick` of the real client rather than a hand-written structural shape so the admin
 * client is assignable without a cast at the call site, while the type still documents that
 * resolution is a single RPC with no reads and no table access of its own.
 */
export type MarketingMasterResolverClient = Pick<SupabaseClient, "rpc">;

/**
 * Resolve the given distributor-code rows against the customer master. Best effort, never throws.
 *
 * Returns true only when the RPC actually ran and reported no error — false when there was nothing
 * to resolve, or when the call failed. Callers use the return value for logging and tests; none of
 * them may branch on it in a way that changes what was written.
 */
export async function resolveMarketingPharmacyCodes(
  supabase: MarketingMasterResolverClient,
  codeIds: readonly string[],
): Promise<boolean> {
  // Deduped because one pharmacy can carry the same code row through several links in a
  // multi-customer submission, and blank-filtered so a malformed id can never widen the call.
  const ids = Array.from(new Set(codeIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) return false;

  try {
    const { error } = await supabase.rpc(MARKETING_MASTER_RESOLVER_RPC, { p_code_ids: ids });
    if (error) {
      // WARNING, not ERROR: the codes are written and usable, and re-running the resolver later
      // recovers the identity in full — it is idempotent. Paging on this would be paging on a
      // column nothing reads yet.
      logWarning("Marketing pharmacy master resolution failed (non-fatal — codes are saved and can be re-resolved)", {
        labels: {
          codeCount: String(ids.length),
          event: "marketing_master_resolution_failed",
          reason: String(error.message ?? "unknown"),
        },
      });
      return false;
    }
    return true;
  } catch (error) {
    logWarning("Marketing pharmacy master resolution threw (non-fatal — codes are saved and can be re-resolved)", {
      labels: {
        codeCount: String(ids.length),
        event: "marketing_master_resolution_threw",
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  }
}
