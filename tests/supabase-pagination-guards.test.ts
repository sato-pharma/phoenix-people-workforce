import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Silent row loss is this module's most expensive recurring defect:
//
//   #1446  an unordered .range() walk lost 1,262 of 49,713 customer mappings, and the symptom
//          looked like a bad source sheet rather than a bad reader.
//   #1462  three more unordered readers of the same table.
//   now    loadActiveCustomerMap stopped at a hard 20,000-row ceiling while production holds
//          49,745 active mappings — 29,745 (59.8%) never loaded, and because the walk is ordered by
//          ascending id the discarded rows were always the NEWEST, i.e. every recent correction.
//
// tests/sos-customer-map-keyset.test.ts guards the first shape, but by its own admission it only
// scans literal `.from("source_of_sales_customer_map")` chains — it is blind to a read routed
// through fetchAllRows(), because the `.range()` lives in paginated.ts. This closes that gap and
// adds the ceiling check, which nothing guarded at all.

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(process.cwd().length + 1).replace(/\\/g, "/");

/**
 * Strip comments before asserting on CODE shape. Several of these files deliberately name the
 * removed defect in a doc comment so the next reader knows why the guard exists — without this, the
 * explanation itself would trip the guard.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function runSupabasePaginationGuardsTests() {
  const files = sourceFiles(SRC);

  // ── 1. The shared pagers must make a stable order impossible to omit ────────
  {
    const paginated = readFileSync(join(SRC, "lib/supabase/paginated.ts"), "utf8");

    assert.match(
      paginated,
      /\n\s*tiebreakColumn: string,/,
      "fetchAllRows must take a tiebreak column",
    );
    assert.ok(
      !/tiebreakColumn\?: string/.test(paginated),
      "the tiebreak column must be REQUIRED — an optional one is an optional correctness bug",
    );
    assert.match(
      paginated,
      /\.order\(tiebreakColumn, \{ ascending: true \}\)\s*\n?\s*\.range\(/,
      "fetchAllRows must apply the tiebreak itself rather than trusting each caller",
    );
    assert.match(
      paginated,
      /if \(error\) throw error;/,
      "a page error must throw, never be treated as end-of-data",
    );
    assert.match(paginated, /export async function fetchAllRowsKeyset/, "a keyset pager must be available");
    assert.ok(
      !/pageSize\s*=\s*\d+,\s*max/i.test(paginated),
      "the shared pagers must not take a maximum-rows ceiling",
    );
  }

  // ── 2. No caller of fetchAllRows may omit the tiebreak ──────────────────────
  // (A bare single-argument call cannot compile any more, but this catches a future overload or an
  // `as never` cast that would smuggle one back in.)
  {
    const offenders: string[] = [];
    for (const file of files) {
      // Strip comments before scanning. Prose that NAMES the old one-argument form — the history
      // note in paginated.ts explaining why `fetchAllRowsOrdered` was collapsed into this — is
      // documentation, not a call, and a guard that cannot tell the two apart punishes writing the
      // explanation down.
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      // fetchAllRows( ... ) where the top-level call has no second argument.
      const singleArg = /fetchAllRows(?:<[^>]*>)?\(\s*(?:\(\)\s*=>\s*)?[A-Za-z_$][\w$]*\s*\)/g;
      if (singleArg.test(src)) offenders.push(rel(file));
    }
    assert.deepEqual(offenders, [], "every fetchAllRows() call must pass a tiebreak column");
  }

  // ── 3. No hard row ceiling may bound a paginated read ───────────────────────
  // The 20,000 cap read as a performance guard and behaved as silent data loss.
  {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(SRC, "lib/sales"))) {
      const src = readFileSync(file, "utf8");
      // `for (let x = 0; x < SOME_MAX; x += PAGE)` — an offset walk bounded by a constant.
      const capped = /for \(\s*let \w+ = 0;\s*\w+ < [A-Z_][A-Z0-9_]*(?:MAX|LIMIT|CAP)[A-Z0-9_]*;/;
      if (capped.test(src)) offenders.push(rel(file));
      if (/MAX_ROWS\s*=\s*\d+/.test(src) && /\.range\(/.test(src)) {
        offenders.push(`${rel(file)} (MAX_ROWS constant alongside .range())`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a paginated read must not stop at a fixed row ceiling — it truncates real data, newest-first",
    );
  }

  // ── 4. The customer map specifically must load in full, via keyset ──────────
  {
    const suggest = code(readFileSync(join(SRC, "lib/sales/normalizer/customer-suggest.ts"), "utf8"));
    // A declaration, not a mention: the doc comment above loadActiveCustomerMap deliberately names
    // the removed constant so the next reader knows why the ceiling is gone.
    assert.ok(
      !/const CUSTOMER_MAP_MAX_ROWS\s*=/.test(suggest),
      "the 20,000-row customer-map ceiling must stay gone — it hid 59.8% of production mappings",
    );
    assert.match(
      suggest,
      /fetchAllRowsKeyset<CustomerMapDbRow>/,
      "the customer map is written while being read, so it must use the keyset pager",
    );
    assert.ok(
      !/if \(error \|\| !data/.test(suggest),
      "an error must not be conflated with end-of-data",
    );
  }

  // ── 5. Concurrent offset pages must be ordered, and a failed page must throw ─
  {
    const workbook = code(readFileSync(join(SRC, "lib/sales/master-workbook.ts"), "utf8"));
    assert.ok(
      !/if \(order\) query = query\.order\(/.test(workbook),
      "master-workbook fetches six offset pages CONCURRENTLY — ordering cannot be optional there",
    );
    assert.match(
      workbook,
      /if \(result\.error\) throw result\.error;/,
      "a failed page must not silently become an empty page in an export that reports success",
    );
    assert.match(workbook, /order: string,/, "selectAll/selectAllOneBatch must require an order column");
  }

  // ── 6. The request-size cap must refuse, not truncate ───────────────────────
  {
    const route = code(
      readFileSync(join(process.cwd(), "app/api/sales/monthly-import/accept-mappings/route.ts"), "utf8"),
    );
    assert.ok(
      !/body\.mappings\.slice\(0, MAX_BATCH\)/.test(route),
      "silently slicing the submitted mappings discards the operator's work while reporting success",
    );
    assert.match(
      route,
      /mappings\.length > MAX_BATCH/,
      "an over-size submission must be refused with an explicit error",
    );
  }
}
