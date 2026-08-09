import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// sos_backfill_import_rows_from_customer_map was a silent no-op since it was first written
// (20260703090000): its WHERE clause gated on `r.brick_id is null`, but the normalizer's real
// "unresolved" sentinel is '' (empty string), never SQL NULL -- resolveBrick itself returns
// brickId: "" on every unresolved path (tests/sos-resolve-brick-precedence.test.ts asserts this
// three times), and CodedRow.brickId is a non-nullable `string`. `r.brick_id is null` can never
// match '', so the "heal historical rows" backfill checkbox in the Mapping Database UI has always
// reported `backfilled: 0` -- read as "nothing needed fixing" rather than "the check never
// matches". Confirmed live on both databases (2026-08-10): 658 production rows and 533 staging
// rows sat with brick_id = '' while an active, matching customer_map entry existed to heal them.
//
// This is the same shape as tests/sos-rollup-sql-truth.test.ts: these are DB functions, so the
// convention here is a source-text assertion over the migration that defines them.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

function migrationSource(nameFragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(nameFragment));
  assert.ok(file, `migration containing "${nameFragment}" must exist`);
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

export function runSosBackfillEmptyBrickSentinelTests() {
  const sql = code(migrationSource("sos_backfill_matches_empty_brick_sentinel"));

  const fn = sql.slice(
    sql.indexOf("function public.sos_backfill_import_rows_from_customer_map"),
    sql.indexOf("grant execute on function public.sos_backfill_import_rows_from_customer_map"),
  );
  assert.ok(fn.length > 0, "sos_backfill_import_rows_from_customer_map must be (re)defined in this migration");

  // ── The fix: '' is recognized as unresolved, not just SQL NULL ──────────────
  {
    assert.match(
      fn,
      /and\s*\(\s*r\.brick_id is null or r\.brick_id = ''\s*\)/,
      "the WHERE clause must treat both NULL and '' as unresolved -- '' is the normalizer's real sentinel",
    );
    // The old bug was this exact bare line, with no OR arm. If this substring reappears (e.g. a
    // future edit "simplifies" the predicate back), the fix has regressed.
    assert.doesNotMatch(
      fn,
      /and r\.brick_id is null\b/,
      "the narrow, NULL-only predicate must not reappear -- it never matched real unresolved rows",
    );
  }

  // ── Unchanged scope: backfill still only fills a gap, it never re-points an existing brick ──
  // Overwriting an already-resolved (possibly wrong) brick is sos_reconcile_import_rows_from_
  // customer_map's job, not this RPC's -- widening what counts as "unresolved" must not blur that
  // boundary into also re-pointing rows that already have a real brick.
  {
    assert.match(
      fn,
      /m\.brick_id is not null/,
      "the source mapping must still be resolved before it can heal anything",
    );
    assert.doesNotMatch(
      fn,
      /r\.brick_id is distinct from/,
      "backfill must not adopt reconcile's 'is distinct from' comparison -- that would re-point resolved rows too",
    );
  }

  // ── Every healed column + the return shape the JS caller depends on are unchanged ───────────
  {
    assert.match(fn, /set\s+brick_id\s*=\s*m\.brick_id,/, "brick_id must still be healed from the mapping");
    assert.match(fn, /area_code\s*=\s*b\.area_code,/, "area_code must still be healed from the brick");
    assert.match(fn, /region_code\s*=\s*b\.region_code,/, "region_code must still be healed from the brick");
    assert.match(
      sql,
      /returns table\(updated_rows integer, affected_batch_ids uuid\[\]\)/,
      "backfillCustomerRows (normalizer/mapping.ts) reads updated_rows + affected_batch_ids by name",
    );
  }

  // ── Grants unchanged: still service_role-only ────────────────────────────────
  {
    assert.match(
      sql,
      /revoke execute on function public\.sos_backfill_import_rows_from_customer_map\(text, text\)\s+from public, anon, authenticated/,
      "EXECUTE must stay revoked from public/anon/authenticated",
    );
    assert.match(
      sql,
      /grant execute on function public\.sos_backfill_import_rows_from_customer_map\(text, text\)\s+to service_role/,
      "EXECUTE must stay granted to service_role only",
    );
  }

  console.log("sos backfill empty-brick-sentinel tests passed");
}
