import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { RESTRICTED_PRODUCT_CODES } from "../src/lib/sales/access-scope.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// phx_closing_channel_totals used to re-derive its whole "folded" input on every call: a retail scan
// of source_of_sales_fact_rollup, its "today's name" join to the customer directory rollup, the
// factory-price join, and a per-customer aggregate — ~2.3 s of the 3.7 s heaviest call. Migration
// 20260814130000 precomputes exactly that vocabulary-INDEPENDENT work into
// source_of_sales_channel_customer_rollup and rewrites the function to read it, leaving the
// classifier and the distinct-customer count live so the owner's invariant (editing
// customer-channel.ts reclassifies all history instantly) is preserved.
//
// The to-the-piastre equivalence was PROVEN empirically on staging (Phoenix-HR-Staging,
// cifwmndunmlxjhyjugxa): the rewritten function vs the pre-rewrite body, EXCEPT-diffed both
// directions over every (line, period) × both report variants = zero rows different, units/value to
// the piastre, customers exact — including the Head Office restricted-only presence edge (46,897 →
// 158 customers, matched exactly). A live-DB diff cannot run in CI, so this test is the in-repo
// backstop: it pins the handful of SQL properties that MAKE that equivalence hold, so a later edit
// cannot quietly break one and move the money. Each assertion below maps to one way the numbers
// could drift.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const MIGRATION_NAME = "20260814130000_closing_channel_customer_rollup.sql";
const MIGRATION = path.join(process.cwd(), "supabase/migrations", MIGRATION_NAME);

// Strip line comments before matching: this migration's header QUOTES column names, the fallback it
// preserves, and the exclude codes it guards, so a raw text search would match the prose.
function strip(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

// The body of one `create or replace function public.<name>` … `$function$;` block.
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `${name} is (re)created in the migration`);
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start, `${name} has a terminated body`);
  return sql.slice(start, end + "$function$;".length);
}

export function runClosingChannelRollupEquivalenceTests() {
  const raw = readFileSync(MIGRATION, "utf8");
  const sql = strip(raw).toLowerCase();

  // The migration must actually be registered under its timestamped name, or none of the below runs
  // in production (and this guard silently protects nothing).
  const files = readdirSync(path.join(process.cwd(), "supabase/migrations"));
  assert.ok(files.includes(MIGRATION_NAME), `${MIGRATION_NAME} is present in supabase/migrations`);

  const totals = functionBody(sql, "phx_closing_channel_totals");
  const refresh = functionBody(sql, "phx_refresh_sos_channel_rollup");

  // ── A. The read hits the precomputed rollup and NOTHING it replaced ─────────────────────────────
  // The entire point is that the ~2.3 s retail scan + name join + factory-price join + aggregate no
  // longer runs per call. If any of them reappears inside the read, the latency win is gone and the
  // two code paths can disagree.
  assert.ok(
    totals.includes("source_of_sales_channel_customer_rollup"),
    "the rewritten phx_closing_channel_totals must read the precomputed rollup table",
  );
  for (const banned of ["source_of_sales_fact_rollup", "source_of_sales_import_rows", "factory_price"]) {
    assert.ok(
      !totals.includes(banned),
      `phx_closing_channel_totals must not re-scan ${banned} — that work moved into the per-batch `
      + "refresh. Its return inside the read both loses the speedup and risks the read and the "
      + "refresh drifting apart",
    );
  }

  // ── B. Both report variants are served by ARITHMETIC over two buckets, never a second scan ──────
  // Non-restricted = *_all − *_restricted; includeRestricted = *_all. A wrong sign or a missing
  // subtraction here is money moving on the Channel Comparison sheet.
  assert.ok(/v_include_all/.test(totals), "the variant is chosen once, into v_include_all");
  for (const col of ["units", "value", "rows"]) {
    assert.ok(
      new RegExp(`r\\.${col}_all\\s*-\\s*r\\.${col}_restricted`).test(totals),
      `the non-restricted variant must be ${col}_all − ${col}_restricted (served from the two buckets, `
      + "not a re-scan)",
    );
    assert.ok(
      new RegExp(`when v_include_all then r\\.${col}_all`).test(totals),
      `the includeRestricted variant must be ${col}_all`,
    );
  }

  // ── C. Presence is decided on ROW COUNT, not money — the one subtlety the diff would catch ──────
  // The live function applies the exclude filter BEFORE grouping, so a customer whose entire purchase
  // is restricted product produces NO row in the non-restricted view — which changes
  // count(distinct customer), not just the money. And value is coalesce(factory_price,0), so a
  // present customer can legitimately sum to 0. Presence must therefore ride rows_kept, never value.
  assert.ok(
    /where\s+b\.rows_kept\s*>\s*0/.test(totals),
    "a customer is present in a variant iff its kept ROW COUNT is > 0 (rows_kept > 0). Filtering on "
    + "value instead would drop present-but-zero customers and miscount distinct customers — this is "
    + "the Head Office 46,897 → 158 edge the staging diff pinned",
  );
  assert.ok(
    /when v_include_all then r\.rows_all\s+else r\.rows_all\s*-\s*r\.rows_restricted\s+end as rows_kept/.test(totals),
    "rows_kept is the per-variant KEPT row count (rows_all, or rows_all − rows_restricted), not a "
    + "money figure",
  );

  // ── D. The classifier's CASE keeps the unattributed branches BEFORE `else 'pharmacy'` ───────────
  // Byte-for-byte the live ordering: the three "this is not a channel" answers must be tested before
  // the classifier whose own fallback is pharmacy. Below it, an unnamed direct order or code-less
  // money becomes a confident pharmacy customer again (Anti Infective July's old 450,035.45).
  const unnamedAt = totals.indexOf("'direct_unnamed'");
  const noCodeAt = totals.indexOf("'unidentified_no_code'");
  const noNameAt = totals.indexOf("'unidentified_no_name'");
  const fallbackAt = totals.indexOf("else 'pharmacy'");
  assert.ok(
    unnamedAt > 0 && noCodeAt > 0 && noNameAt > 0 && fallbackAt > 0,
    "phx_closing_channel_totals carries all three unattributed branches and the pharmacy fallback",
  );
  for (const [label, at] of [
    ["direct_unnamed", unnamedAt],
    ["unidentified_no_code", noCodeAt],
    ["unidentified_no_name", noNameAt],
  ] as const) {
    assert.ok(
      at < fallbackAt,
      `the ${label} branch must come BEFORE \`else 'pharmacy'\` — a fallback must never catch money `
      + "whose customer is unknown",
    );
  }
  // DISTINCT customer, never a row count: a pharmacy buying from three distributors is one customer.
  assert.ok(
    /count\(distinct t\.client_key\)/.test(totals),
    "customers are counted DISTINCT by client_key, matching the live aggregate",
  );

  // ── E. The two-bucket shortcut refuses any exclude set it cannot serve ──────────────────────────
  // The rollup carries exactly two buckets; the one caller passes exactly [] or {LA003,LA004,SS001}.
  // Anything else cannot be produced by subtraction, so it must RAISE, never silently return wrong
  // money. The accepted set is pinned to RESTRICTED_PRODUCT_CODES so the SQL and TS cannot drift.
  assert.ok(
    /raise exception/.test(totals) && /p_exclude_codes/.test(totals),
    "an unexpected exclude set must raise, not silently mis-bucket",
  );
  const restrictedInSql = [...RESTRICTED_PRODUCT_CODES]
    .map((c) => c.toLowerCase())
    .sort()
    .join(",");
  const acceptedSet = totals.match(/array\[([^\]]*?)\]::text\[\]/g) ?? [];
  const acceptsRestricted = acceptedSet.some((arr) => {
    const codes = [...arr.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]).sort().join(",");
    return codes === restrictedInSql;
  });
  assert.ok(
    acceptsRestricted,
    `the accepted non-empty exclude set must be exactly RESTRICTED_PRODUCT_CODES `
    + `(${[...RESTRICTED_PRODUCT_CODES].join(", ")}) — a code added to one list and not the SQL guard `
    + "would be silently mis-bucketed or rejected",
  );

  // ── F. The baked money uses the SAME formulas the live function used ────────────────────────────
  // Retail value = effective_units × coalesce(factory_price,0); direct value IS the published
  // direct_value (import_rows.value), not a re-derivation. A different formula here is a different
  // number on every sheet.
  assert.ok(
    /effective_units\s*\*\s*coalesce\(p\.factory_price,\s*0\)/.test(refresh),
    "retail value in the rollup must be effective_units × coalesce(factory_price,0), the live formula",
  );
  assert.ok(
    /sum\(r\.value\)\s+as units_all/.test(refresh) || /sum\(r\.value\)/.test(refresh),
    "direct value in the rollup must be import_rows.value (the published direct_value), not re-derived",
  );
  // Both halves split the restricted bucket on the same three codes, upper/trimmed.
  const refreshRestricted = [...refresh.matchAll(/array\[([^\]]*?)\]/g)]
    .some((m) => {
      const codes = [...m[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]).sort().join(",");
      return codes === restrictedInSql;
    });
  assert.ok(
    refreshRestricted,
    "the *_restricted buckets must filter on exactly the RESTRICTED_PRODUCT_CODES set",
  );

  // ── G. The baked NAME is resolved within-period, newest-wins, per batch — never across periods ──
  // Cross-period name drift is staleness vector (b) in the plan. The name must be resolved with the
  // identical within-period rule the live function used: distinct on (line, period, distributor,
  // client_code) newest first, scoped to this batch. If period leaves the key, a customer's July name
  // could overwrite its June name and both months move.
  assert.ok(
    /distinct on \(lower\(btrim\(d\.official_line\)\), d\.period, d\.distributor_code, d\.client_code\)/.test(refresh),
    "the baked name's newest-wins key MUST include the period — resolving names across periods would "
    + "let one month's name rewrite another's money",
  );
  assert.ok(
    /order by[\s\S]*d\.latest_row_created_at desc/.test(refresh),
    "newest row wins the name, matching the live directory resolution",
  );
  assert.ok(
    /where d\.batch_id = p_batch_id/.test(refresh),
    "the name resolution is scoped to the batch being refreshed",
  );

  // ── H. Per-batch keying: the batch owns its rows and the cascade cleans superseded batches ──────
  assert.ok(
    /references public\.source_of_sales_import_batches\(id\) on delete cascade/.test(sql),
    "the rollup is keyed to its batch with ON DELETE CASCADE, so a superseded batch self-cleans "
    + "(exactly like source_of_sales_fact_rollup) and there is no cross-batch write race",
  );
  assert.ok(
    /delete from public\.source_of_sales_channel_customer_rollup where batch_id = p_batch_id/.test(refresh),
    "the refresh is delete-by-batch then reinsert — the batch owns exactly its own rows",
  );

  // ── I. The refresh is wired into EVERY server-side refresh path, always AFTER fact+directory ────
  // Staleness vector (a): a path that refreshes fact/directory but not the channel rollup leaves the
  // sheet stale. And the channel refresh reads the directory rollup, so it must run after it or it
  // bakes a name the directory has not yet updated.
  for (const fn of ["phx_finalize_sos_batch", "phx_sync_sos_run", "phx_backfill_sos_fact_rollup"]) {
    const body = functionBody(sql, fn);
    assert.ok(
      body.includes("phx_refresh_sos_channel_rollup"),
      `${fn} must also refresh the channel rollup, or its slices go stale`,
    );
  }
  const finalize = functionBody(sql, "phx_finalize_sos_batch");
  const sync = functionBody(sql, "phx_sync_sos_run");
  assert.ok(
    finalize.indexOf("phx_refresh_sos_customer_directory_rollup") < finalize.indexOf("phx_refresh_sos_channel_rollup"),
    "in finalize, the channel refresh must run AFTER the directory refresh it reads from",
  );
  assert.ok(
    sync.indexOf("phx_refresh_sos_customer_directory_rollup") < sync.indexOf("phx_refresh_sos_channel_rollup"),
    "in the territory sync, the channel refresh must run AFTER the directory refresh it reads from",
  );

  // ── J. The initial backfill runs BEFORE the lock guard is attached ──────────────────────────────
  // A slice that is already closing-locked must still get its rollup built once, from the same frozen
  // sources the live function reads. If the guard attached first, the backfill INSERT into a locked
  // slice would be rejected and that slice would silently have no rollup.
  const backfillAt = sql.indexOf("$backfill$");
  const firstTriggerAt = sql.indexOf("create trigger trg_lock_guard_ins");
  assert.ok(backfillAt > 0 && firstTriggerAt > 0, "the backfill block and the lock-guard triggers both exist");
  assert.ok(
    backfillAt < firstTriggerAt,
    "the one-time backfill must run before the lock-guard triggers attach, or a locked slice never "
    + "gets its initial rollup",
  );

  // ── K. The closing lock guards the new table too, on the same (period, official_line) key ───────
  const lockTriggers = (sql.match(/phx_reject_write_to_locked_closing\('period', 'official_line'\)/g) ?? []).length;
  assert.equal(
    lockTriggers,
    3,
    "insert/update/delete on the rollup must all be guarded by the monthly-closing lock, keyed on "
    + "(period, official_line) — a refresh of a locked slice is correctly rejected",
  );

  // ── L. The four server-side trio call-sites each add the channel refresh, AFTER the trio ────────
  // The RPC refreshes are fire-and-forget-ordered in TypeScript; the channel call must follow the
  // trio (it reads the fact + directory rollups the trio produces).
  const TS_SITES = [
    // normalizer/mapping.ts no longer hand-copies the chain: since the 23 Oct audit (P4-05) its
    // backfill runs `refreshBatchRollups` from customer-map.ts, pinned by
    // tests/sales-imports-audit-fixes.test.ts. customer-map.ts is checked here and carries the chain.
    "src/lib/sales/normalizer/customer-map.ts",
    "src/lib/sales/normalizer/service.ts",
    "src/lib/sales/monthly-distributor-import.ts",
  ];
  for (const rel of TS_SITES) {
    const body = readFileSync(path.join(process.cwd(), rel), "utf8");
    const channelAt = body.indexOf('phx_refresh_sos_channel_rollup');
    const roiAt = body.indexOf('phx_refresh_marketing_roi_facts');
    assert.ok(
      channelAt > 0,
      `${rel} must call phx_refresh_sos_channel_rollup after its refresh trio, or imports through this `
      + "path leave the channel sheet stale",
    );
    assert.ok(
      roiAt > 0 && roiAt < channelAt,
      `${rel} must call the channel refresh AFTER the trio (the marketing-roi refresh is the last of `
      + "it), because the channel rollup reads what the trio just wrote",
    );
  }
}
