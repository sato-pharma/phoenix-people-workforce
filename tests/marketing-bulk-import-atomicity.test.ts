import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(path, "utf8");
}

// Locks the transactional-bulk-import guarantee: executeBulkImport must insert each
// row (request + products + pharmacies + steps) through the atomic RPC, never through
// the old four-insert sequence with a best-effort parent delete that could leave
// partial data behind. Because executeBulkImport talks to live Supabase, its rollback
// behaviour is proven on staging; here we source-lock the shape so it can't regress.
export function runMarketingBulkImportAtomicityTests() {
  const bulkImport = source("src/lib/marketing-requests/bulk-import.ts");

  // Uses the atomic RPC for the per-row insert.
  assert.match(
    bulkImport,
    /supabase\.rpc\("import_marketing_request_atomic"/,
    "executeBulkImport must insert each row via the atomic RPC",
  );
  assert.match(bulkImport, /p_request:/, "RPC call must pass the request payload");
  assert.match(bulkImport, /p_products:/, "RPC call must pass the products payload");
  assert.match(bulkImport, /p_pharmacies:/, "RPC call must pass the pharmacies payload");
  assert.match(bulkImport, /p_steps:/, "RPC call must pass the approval-steps payload");

  // The old best-effort cleanup must be gone — atomicity replaces it.
  assert.doesNotMatch(
    bulkImport,
    /\.from\("marketing_requests"\)\.delete\(\)\.eq\("id", requestId\)/,
    "best-effort parent-delete cleanup must be removed (the RPC is transactional)",
  );
  assert.doesNotMatch(
    bulkImport,
    /let requestId: string \| null = null/,
    "the requestId-for-cleanup bookkeeping must be gone",
  );

  // Generated columns must not be written from JS (the DB derives them). Sending them
  // would raise "cannot insert a non-DEFAULT value" through the raw-SQL RPC.
  assert.doesNotMatch(bulkImport, /required_roi_value:/, "required_roi_value is GENERATED — must not be sent");
  assert.doesNotMatch(bulkImport, /roi_coverage_ratio:/, "roi_coverage_ratio is GENERATED — must not be sent");
  assert.doesNotMatch(bulkImport, /expected_value:/, "product expected_value is GENERATED — must not be sent");

  // The migration that defines the RPC must exist with the right security posture.
  //
  // Resolve the LAST migration that defines it, scanning the pre-baseline archive and then the
  // live migrations directory (archive newest = 2026-07-08, live starts at the 2026-07-11
  // baseline, so each directory's lexical sort concatenated is chronological). This previously
  // hardcoded the archive path and so pinned frozen history: a later migration that recreated
  // import_marketing_request_atomic — dropping SECURITY DEFINER, widening the grant, or adding a
  // generated column to an INSERT list — would not have been checked at all.
  const migrationDirs = ["supabase/_migrations_archive/pre-baseline-2026-07-11", "supabase/migrations"];
  const defining = migrationDirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => `${dir}/${name}`)
      .filter((path) => /create\s+(or\s+replace\s+)?function\s+public\.import_marketing_request_atomic/i.test(source(path))),
  );
  assert.ok(defining.length > 0, "at least one migration must define import_marketing_request_atomic");

  // Isolate the function's OWN definition block. The latest definer is now usually the 2026-07-11
  // baseline, a 44k-line pg_dump — grepping the whole file for "grant ... to service_role" would
  // match some unrelated object and pass vacuously, so every posture assertion below is scoped to
  // either this block or to statements that name this function explicitly.
  const latest = source(defining[defining.length - 1]!);
  const start = /create\s+(?:or\s+replace\s+)?function\s+public\.import_marketing_request_atomic\s*\(/i.exec(latest);
  assert.ok(start, "the resolved migration must contain the function definition");
  const afterStart = latest.slice(start.index);
  const tag = /\bas\s+(\$[a-zA-Z_]*\$)/i.exec(afterStart);
  assert.ok(tag, "function body must be dollar-quoted");
  const bodyEndRel = afterStart.slice(tag.index + tag[0].length).indexOf(tag[1]!);
  assert.ok(bodyEndRel >= 0, "function body must have a matching closing dollar-quote tag");
  const block = afterStart.slice(0, tag.index + tag[0].length + bodyEndRel + tag[1]!.length);

  assert.match(block, /language\s+plpgsql/i, "must be plpgsql (a transactional function body)");
  assert.match(block, /security\s+definer/i, "must be security definer like sibling admin RPCs");

  // Grants: check statements that NAME this function, across every migration, latest wins.
  const grantLines = migrationDirs
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .flatMap((name) => source(`${dir}/${name}`).split("\n")),
    )
    .filter((line) => /import_marketing_request_atomic/i.test(line) && /\b(grant|revoke)\b/i.test(line));
  assert.ok(
    grantLines.some((l) => /grant\s+execute[\s\S]*to\s+[^;]*service_role/i.test(l)),
    "must grant execute to service_role",
  );
  assert.ok(
    grantLines.some((l) => /revoke\s+(all|execute)[\s\S]*from\s+[^;]*public/i.test(l)),
    "must revoke from public (anon/authenticated inherit EXECUTE via PUBLIC)",
  );

  // The function must NOT list the generated columns in its INSERT column lists.
  assert.doesNotMatch(
    block,
    /insert into marketing_requests \([^)]*required_roi_value/i,
    "generated required_roi_value must not be in the request INSERT column list",
  );
  assert.doesNotMatch(
    block,
    /insert into marketing_request_products \([^)]*expected_value/i,
    "generated expected_value must not be in the products INSERT column list",
  );
}
