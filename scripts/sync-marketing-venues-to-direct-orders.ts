/**
 * Carry every customer ALREADY validated in Marketing into Direct Orders — the one-time catch-up for
 * the automatic hand-over that ships with it (owner, 2026-10-21: "make every one validates a customer
 * for marketing requests is automatic validated in his direct orders and is appearing in his venues
 * validated").
 *
 * The same function a marketing validation save calls (src/lib/marketing-requests/direct-order-venue-sync.ts),
 * so the catch-up cannot file a venue differently from a live validation. Idempotent on
 * `marketing_pharmacy_direct_order_venues`: a re-run writes nothing for a pharmacy already across.
 *
 * Plans by default and writes NOTHING; `--apply` writes. It hits whichever Supabase project the env
 * names — with .env.local that is PRODUCTION — and prints the host first so the output is never
 * ambiguous about which database it read.
 *
 * Usage, from the folder holding the change:
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/sync-marketing-venues-to-direct-orders.ts [--apply]
 */
import {
  isRetryableMarketingVenueSkip,
  MARKETING_VALIDATED_CUSTOMER_STATUSES,
  MARKETING_VENUE_SKIP_TEXT,
  syncMarketingCustomersToDirectOrders,
} from "@/lib/marketing-requests/direct-order-venue-sync";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

refuseUnknownFlags({
  name: "sync-marketing-venues-to-direct-orders",
  entry: import.meta.url,
  known: ["--apply"],
});

const apply = process.argv.includes("--apply");

async function main() {
  const host = (() => {
    try {
      return new URL(String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")).host;
    } catch {
      return "(no NEXT_PUBLIC_SUPABASE_URL)";
    }
  })();
  console.log(`sync-marketing-venues: ${apply ? "APPLY" : "PLAN ONLY"} against ${host}`);

  const supabase = getSupabaseAdmin();
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("marketing_customers")
      .select("id")
      .in("validation_status", [...MARKETING_VALIDATED_CUSTOMER_STATUSES])
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    ids.push(...((data ?? []) as Array<{ id: string }>).map((row) => row.id));
    if (!data || data.length < 1000) break;
  }
  console.log(`validated marketing customers: ${ids.length}`);

  const result = await syncMarketingCustomersToDirectOrders({ customerIds: ids, trigger: "backfill", dryRun: !apply });
  console.log(`${apply ? "created" : "would create"}: ${result.created.length}`);
  console.log(`${apply ? "reused" : "would reuse"}: ${result.reused.length}`);
  console.log(`already linked: ${result.alreadyLinked}`);
  console.log(`not carried across: ${result.skipped.length}`);
  for (const row of result.skipped) {
    console.log(`  - ${row.pharmacyName}: ${MARKETING_VENUE_SKIP_TEXT[row.reason]}`);
  }
  const failed = result.skipped.filter((row) => isRetryableMarketingVenueSkip(row.reason));
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("sync-marketing-venues: FAILED", error);
  process.exit(2);
});
