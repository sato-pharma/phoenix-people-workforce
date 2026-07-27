// Re-runnable sync: copy the Sales pharmacy-code map (source_of_sales_customer_map) into
// the Marketing reference database (marketing_pharmacy_code_references) so the Customer
// Validation "is this code already in our database?" flag and the on-submit reference
// matching reflect live sales data. As Sales imports more distributors, re-run this.
//
// Requires migration 20260606120000_marketing_pharmacy_code_sales_link.sql to be applied
// to the target database first (it creates the function this script calls).
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
  const [result] = await sql`select * from public.phx_sync_sales_pharmacy_codes_into_marketing()`;
  console.log("Sync complete:");
  console.log(`  marketing distributors created: ${result?.distributors_created ?? 0}`);
  console.log(`  pharmacy code references synced: ${result?.references_synced ?? 0}`);

  const [verify] = await sql`
    select count(*)::int as sales_sourced_refs
    from public.marketing_pharmacy_code_references
    where source_file = 'source_of_sales_customer_map'`;
  console.log(`  sales-sourced references now in marketing DB: ${verify?.sales_sourced_refs ?? 0}`);
} catch (error) {
  console.log("ERROR:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await sql.end();
}
