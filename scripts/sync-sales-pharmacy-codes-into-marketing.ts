// Re-runnable sync: copy the Sales pharmacy-code map (source_of_sales_customer_map) into
// the Marketing reference database (marketing_pharmacy_code_references) so the Customer
// Validation "is this code already in our database?" flag and the on-submit reference
// matching reflect live sales data.
//
// RE-RUNNING IS SAFE — but only since migration 20260819210000. Until then this header said
// "As Sales imports more distributors, re-run this", and on 2026-08-19 someone did: the function
// blind-inserted one reference row per map row, duplicating codes the two spreadsheet imports had
// already loaded under the same distributor, and 44,244 codes flipped from 'matched' to
// 'ambiguous' in one statement (POS 27,590, Ibn sina 12,913, EGD 1,807, ramco 1,045, sofico 692,
// mec 141, epda 56). They were deleted by hand.
//
// What a re-run does NOW: it adds only (distributor, code) pairs that no reference row carries
// yet, whatever source_file owns them; it retires only its own rows the live map no longer
// justifies AND that no customer code points at; it touches nothing else. Re-running with no new
// Sales data is a no-op, and `references_synced: 0` printed below is what that looks like.
//
// Requires migrations 20260606120000_marketing_pharmacy_code_sales_link.sql (creates the function)
// and 20260819210000_marketing_sales_code_sync_is_additive.sql (makes re-running safe) to be
// applied to the target database first. Against a database missing the second one, DO NOT RUN —
// the old function is still there and still blind-inserts.
//
// Staging (recommended):
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     --env-file=.env.staging.rls.local scripts/sync-sales-pharmacy-codes-into-marketing.ts
//
// The target DB URL is read from PHOENIX_SYNC_DATABASE_URL, then PHOENIX_STAGING_DATABASE_URL,
// then the legacy PHOENIX_NEW_STAGING_DATABASE_URL, then DATABASE_URL. Production
// (ozucdzovmcqvepbozvqf) is refused unless PHOENIX_CONFIRM_PRODUCTION_SYNC=true is set explicitly.
import postgres from "postgres";

const url =
  process.env.PHOENIX_SYNC_DATABASE_URL ??
  process.env.PHOENIX_STAGING_DATABASE_URL ??
  // Historical name from the 2026-07-11 staging migration. It still points at the archived
  // project in some local .env.staging.rls.local files, so it is consulted last.
  process.env.PHOENIX_NEW_STAGING_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "";

if (!url) {
  console.log("ABORT: no database URL set (PHOENIX_SYNC_DATABASE_URL / PHOENIX_STAGING_DATABASE_URL / PHOENIX_NEW_STAGING_DATABASE_URL / DATABASE_URL).");
  process.exit(1);
}

const isProduction = url.includes("ozucdzovmcqvepbozvqf");
if (isProduction && process.env.PHOENIX_CONFIRM_PRODUCTION_SYNC !== "true") {
  console.log("ABORT: target is PRODUCTION (ozucdzovmcqvepbozvqf). Set PHOENIX_CONFIRM_PRODUCTION_SYNC=true to allow.");
  process.exit(1);
}
console.log(isProduction ? "Target: PRODUCTION (explicitly confirmed)\n" : "Target: non-production\n");

const sql = postgres(url, { max: 1, onnotice: () => {}, ssl: "require" });
try {
  // PRE-FLIGHT. Which function is actually in the target database, asked BEFORE calling it — the
  // old one does its damage in a single statement, so noticing afterwards is worth nothing.
  const [signature] = await sql`
    select pg_get_function_result(p.oid) as result_type
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'phx_sync_sales_pharmacy_codes_into_marketing'`;
  if (!signature) {
    console.log("ABORT: public.phx_sync_sales_pharmacy_codes_into_marketing() does not exist here.");
    process.exitCode = 1;
  } else if (!String(signature.result_type).includes("references_skipped_existing")) {
    console.log("ABORT: this database still has the pre-20260819210000 function. It blind-inserts one");
    console.log("       reference row per map row and duplicates codes the spreadsheet imports already");
    console.log("       loaded — that is what turned 44,244 codes ambiguous on 2026-08-19. Apply");
    console.log("       supabase/migrations/20260819210000_marketing_sales_code_sync_is_additive.sql first.");
    process.exitCode = 1;
  } else {
    const [result] = await sql`select * from public.phx_sync_sales_pharmacy_codes_into_marketing()`;
    console.log("Sync complete:");
    console.log(`  marketing distributors created: ${result?.distributors_created ?? 0}`);
    console.log(`  pharmacy code references synced: ${result?.references_synced ?? 0}`);
    // 0 synced with a large skipped count is the healthy shape of a repeat run, not a failure.
    console.log(`  already present, left alone: ${result?.references_skipped_existing ?? 0}`);
    console.log(`  retired (map no longer has them): ${result?.references_retired ?? 0}`);
    console.log(`  stale but kept (a customer code points at them): ${result?.references_retained_linked ?? 0}`);
    // Codes the live map has but that sit under a vendor the owner hid. Deliberately NOT created:
    // a hidden vendor is unreachable from the Vendor picker, and two of them were merged into their
    // parents on 2026-08-19 — recreating their rows would undo that merge.
    console.log(`  held back (vendor is hidden): ${result?.references_held_hidden_vendor ?? 0}`);

    const [verify] = await sql`
      select
        (select count(*)::int from public.marketing_pharmacy_code_references
          where source_file = 'source_of_sales_customer_map') as sales_sourced_refs,
        (select count(*)::int from (
           select 1 from public.marketing_pharmacy_code_references
           group by distributor_id, normalized_pharmacy_code having count(*) > 1
         ) t) as ambiguous_pairs`;
    console.log(`  sales-sourced references now in marketing DB: ${verify?.sales_sourced_refs ?? 0}`);
    // The one number that says whether the reference database is healthy. Anything but 0 means
    // some pharmacy code now resolves to two rows and Customer Validation reports 'ambiguous'.
    console.log(`  ambiguous (distributor, code) pairs: ${verify?.ambiguous_pairs ?? 0}`);
    if ((verify?.ambiguous_pairs ?? 0) > 0) process.exitCode = 1;
  }
} catch (error) {
  console.log("ERROR:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await sql.end();
}
