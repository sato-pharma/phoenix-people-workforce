import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * THE CLOSING STORE-SPLIT CACHE KEYS ON THE GEOGRAPHY VERSION STAMP.
 *
 * Measured 2026-10-10: after four re-uploads and a reconcile, every database surface read Sohag 1 CNS
 * September at 173.4% while the Monthly Closing screen still read ~290% from an hour-old cached
 * Office spread. A geography re-stamp is a direct SQL UPDATE on source_of_sales_import_rows, which has
 * no updated_at and no trigger, so no invalidate call could cover it.
 *
 * 20261010160000_sos_geography_version.sql adds a sequence bumped by a statement-level trigger on
 * every table the split reads. closing-store-split-net.ts passes the sequence's value as an ARGUMENT
 * of its unstable_cache function, so a write from any path changes the key.
 *
 * These are source pins: the cache itself needs the Next runtime. Comments are stripped first with
 * the shared stripper, because the header above the call explains it in the same words and would
 * satisfy a match on its own.
 */
const repoFile = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

export function runClosingStoreSplitGeographyStampTests(): void {
  const code = stripComments(repoFile("src/lib/sales/closing-store-split-net.ts"));

  assert.match(
    code,
    /\.rpc\("phx_sos_geography_version"\)/,
    "the loader must read the geography stamp, or a direct SQL geography re-stamp leaves the Monthly "
      + "Closing screen serving an hour-old Office spread",
  );

  const cachedCalls = code.match(/loadClosingStoreSplitCached\(trimmedLine[^\n]*/g) ?? [];
  // 2 = the live path and the frozen month's live Office slice. Counted so a third call site that
  // forgets the stamp, or a removed one, is noticed rather than silently uncovered.
  assert.equal(cachedCalls.length, 2, `expected two cached-split call sites, found ${cachedCalls.length}`);
  for (const call of cachedCalls) {
    assert.match(
      call,
      /^loadClosingStoreSplitCached\(trimmedLine,\s*trimmedPeriod,\s*(await readGeographyStamp\(\)|stamp)\)/,
      `every cached-split call must pass the stamp as its third argument: ${call}`,
    );
  }

  assert.match(
    code,
    /_geographyStamp:\s*string/,
    "the cached function must take the stamp as an argument — unstable_cache folds arguments into the "
      + "key, which is the only reason a new stamp reads a new entry",
  );

  assert.match(
    code,
    /Math\.floor\(Date\.now\(\)\s*\/\s*3_600_000\)/,
    "a failed or missing stamp must fall back to an hour bucket (the old 1h TTL), never throw and never "
      + "return a constant that would pin a stale entry forever",
  );

  const migration = repoFile("supabase/migrations/20261010160000_sos_geography_version.sql");
  for (const table of [
    "source_of_sales_import_rows",
    "source_of_sales_import_batches",
    "source_of_sales_customer_map",
    "source_of_sales_bricks",
    "source_of_sales_areas",
    "source_of_sales_regions",
  ]) {
    assert.ok(
      migration.includes(`'${table}'`),
      `the stamp must be bumped by writes to ${table}, or a change there leaves the cache stale`,
    );
  }
  assert.match(migration, /after truncate on/, "TRUNCATE needs its own trigger: the row-write trigger does not fire on it");
  assert.match(
    migration,
    /grant execute on function public\.phx_sos_geography_version\(\) to service_role/,
    "the app calls as service_role, so the reader must be granted to it",
  );
}
