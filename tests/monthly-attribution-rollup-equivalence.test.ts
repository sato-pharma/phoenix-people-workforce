import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// au.f_monthly_achievement is the per-month core of the sales-vs-target engine
// (phx_sales_vs_target_range -> au.f_sales_vs_target_range loops it). Almost all its cost is inside
// au.f_monthly_attribution: the golden-rule Office/direct-region money attribution over the fact
// rollup. That money does NOT depend on who occupies a seat today or on this month's targets, so
// migration 20260814160000 precomputes exactly it into au.monthly_attribution_rollup and rewrites
// f_monthly_achievement to read the table — while keeping the seat resolution and the targets join
// LIVE, so no correctness is traded for the ~12x speedup (2,159 ms -> ~150-179 ms end to end).
//
// The to-the-piastre equivalence was PROVEN empirically on staging (Phoenix-HR-Staging,
// cifwmndunmlxjhyjugxa) with an EXCEPT diff, both directions, zero rows, over every covered period.
// A live-DB diff cannot run in CI, so this test is the in-repo backstop: it pins the handful of SQL
// (and wiring) properties that MAKE that equivalence hold — and, above all, the two ways the rollup
// could silently serve WRONG money: (1) the covered path diverging from the live path, and (2) a
// stale rollup the gate fails to catch. Each assertion below maps to one such failure.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const MIGRATION_NAME = "20260814160000_monthly_attribution_rollup.sql";
const MIGRATION = path.join(process.cwd(), "supabase/migrations", MIGRATION_NAME);

// Strip line comments before matching: this migration's header and section prose quote table and
// column names, the fallback it preserves, and the gate condition, so a raw text search would match
// the commentary rather than the code.
function strip(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

// The body of one `create or replace function <header…>` … `$function$;` block. `header` includes the
// schema and the opening paren so `au.f_monthly_achievement(` cannot match `au.f_monthly_achievement_live(`.
function functionBody(sql: string, header: string): string {
  const start = sql.indexOf(header);
  assert.ok(start >= 0, `${header}…) is (re)created in the migration`);
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start, `${header}…) has a terminated body`);
  return sql.slice(start, end + "$function$;".length);
}

// Collapse whitespace so an indentation-only difference is not read as a logic difference.
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Everything from the `actuals` CTE to the end of the body — the achievement math the two readers
// MUST share verbatim. Only the upstream `attribution` CTE (rollup vs live) is allowed to differ.
function downstream(body: string): string {
  const at = body.indexOf("actuals as (");
  assert.ok(at > 0, "the body has an `actuals` CTE");
  return normalize(body.slice(at));
}

export function runMonthlyAttributionRollupEquivalenceTests() {
  const raw = readFileSync(MIGRATION, "utf8");
  const sql = strip(raw).toLowerCase();

  // The migration must actually be registered under its timestamped name, or none of the below runs
  // in production and this guard silently protects nothing.
  const files = readdirSync(path.join(process.cwd(), "supabase/migrations"));
  assert.ok(files.includes(MIGRATION_NAME), `${MIGRATION_NAME} is present in supabase/migrations`);

  const gated = functionBody(sql, "create or replace function au.f_monthly_achievement(");
  const live = functionBody(sql, "create or replace function au.f_monthly_achievement_live(");
  const refresh = functionBody(sql, "create or replace function au.f_refresh_monthly_attribution(");
  const fingerprint = functionBody(sql, "create or replace function au.f_attribution_config_fingerprint(");

  // ── A. The covered path reads the ROLLUP and never re-derives the attribution ───────────────────
  // The whole point is that the expensive au.f_monthly_attribution pass no longer runs on a covered
  // read. If it reappears in the gated function, the speedup is gone AND the covered path can diverge
  // from what was baked. (The gated function may still name f_monthly_achievement_live for the
  // fallback — that substring is f_monthly_achievement, not f_monthly_attribution.)
  assert.ok(
    gated.includes("au.monthly_attribution_rollup"),
    "the gated f_monthly_achievement must read the precomputed au.monthly_attribution_rollup",
  );
  assert.ok(
    !gated.includes("f_monthly_attribution("),
    "the gated f_monthly_achievement must NOT call au.f_monthly_attribution — that recompute only "
    + "belongs to the live fallback; its presence here loses the speedup and risks divergence",
  );

  // ── B. The covered path and the live path share the achievement math BYTE-FOR-BYTE ──────────────
  // This is the core equivalence: materialise f_monthly_attribution into a table, read it back, run
  // the SAME downstream. If an edit changes the join_key build, the targets join or the seat/region
  // resolution in one body but not the other, covered months and fallback months would disagree.
  assert.equal(
    downstream(gated),
    downstream(live),
    "the achievement math from `actuals` onward must be identical in the rollup-backed reader and the "
    + "live fallback — only the upstream `attribution` CTE may differ (rollup vs live recompute)",
  );
  // And the one allowed difference is exactly the attribution source.
  assert.ok(
    /from au\.monthly_attribution_rollup a\s+where a\.period = p_period/.test(gated),
    "the gated reader's attribution CTE reads the rollup filtered to the period",
  );
  assert.ok(
    /from au\.f_monthly_attribution\(p_period\) a/.test(live),
    "the live fallback's attribution CTE calls au.f_monthly_attribution directly",
  );
  // Both project the identical six money columns the downstream consumes.
  const attrProjection = "select a.line_code, a.area_code, a.region_code, a.product_code, a.sales_units, a.sales_value";
  assert.ok(gated.includes(attrProjection) && live.includes(attrProjection),
    "both readers project the same six attribution columns");

  // ── C. The gate never serves stale attribution — fall back unless covered AND config unchanged ──
  // Staleness has two vectors. Config drift is caught HERE: if the period has no meta row, or the
  // stored fingerprint no longer equals the live one, the function returns the live computation
  // instead of the rollup. Weakening either half of this condition would let edited config serve old
  // money into targets and incentives.
  assert.ok(
    /select config_fp into v_meta_fp from au\.monthly_attribution_rollup_meta where period = p_period/.test(gated),
    "the gate reads the period's stored config fingerprint from the meta table",
  );
  assert.ok(
    /if v_meta_fp is null or v_meta_fp <> au\.f_attribution_config_fingerprint\(\) then\s+return query select \* from au\.f_monthly_achievement_live\(p_period\);\s+return;\s+end if;/.test(gated),
    "on no coverage (fp is null) OR config drift (fp mismatch) the gated function MUST fall back to "
    + "au.f_monthly_achievement_live and return — never read a possibly-stale rollup",
  );

  // ── D. The config fingerprint covers exactly the five tables that shape attribution money ───────
  // The fingerprint is the ONLY thing that catches config drift, so a table that shapes the money but
  // is missing here would let a stale rollup pass the gate. It must include all five inputs to
  // au.f_monthly_attribution's money — and must NOT hash fact data (refresh-driven, not fingerprinted)
  // or targets (read live), which would be either wrong or needlessly slow.
  for (const t of [
    "au.line_area_map",
    "au.sos_area_crosswalk",
    "au.sos_official_line_map",
    "public.source_of_sales_products",
    "au.direct_region_allocation",
  ]) {
    assert.ok(
      fingerprint.includes(t),
      `the config fingerprint must hash ${t} — a config table left out means edits to it would not `
      + "bump the fingerprint and the gate would serve stale money",
    );
  }
  for (const t of ["source_of_sales_fact_rollup", "monthly_targets"]) {
    assert.ok(
      !fingerprint.includes(t),
      `the config fingerprint must NOT hash ${t}: fact freshness is handled by the explicit per-batch `
      + "refresh, and targets are read live — hashing them would be wrong or pointlessly expensive",
    );
  }

  // ── E. The refresh bakes EXACTLY the reader's projection and stamps the fingerprint ─────────────
  // The rollup content must be the live au.f_monthly_attribution output, nothing else, or "read the
  // table back" is no longer an identity. And every refresh must stamp the current config fingerprint,
  // or the gate can never mark the period fresh.
  assert.ok(
    /insert into au\.monthly_attribution_rollup\s*\(period, line_code, area_code, region_code, product_code, sales_units, sales_value\)/.test(refresh),
    "the refresh inserts exactly the seven rollup columns",
  );
  assert.ok(
    /from au\.f_monthly_attribution\(p_period\) a/.test(refresh),
    "the rollup is populated from the live au.f_monthly_attribution — same source the fallback reads",
  );
  assert.ok(
    /delete from au\.monthly_attribution_rollup where period = p_period/.test(refresh),
    "the refresh is delete-by-period then reinsert — the period owns exactly its own rows",
  );
  assert.ok(
    /au\.f_attribution_config_fingerprint\(\)/.test(refresh) && /monthly_attribution_rollup_meta/.test(refresh),
    "the refresh stamps the current config fingerprint into the meta table",
  );

  // ── F. The per-batch refresh is wired into EVERY server-side fact-refresh path, AFTER the fact ──
  // The second staleness vector: a path that rebuilds source_of_sales_fact_rollup but not the
  // attribution rollup leaves stale money that the config gate CANNOT detect (fact data is not in the
  // fingerprint). Every such DB path must call phx_refresh_monthly_attribution, and after the fact
  // refresh it reads.
  for (const fn of ["phx_finalize_sos_batch", "phx_sync_sos_run", "phx_backfill_sos_fact_rollup"]) {
    const body = functionBody(sql, `create or replace function public.${fn}(`);
    assert.ok(
      body.includes("phx_refresh_monthly_attribution"),
      `${fn} must also refresh the attribution rollup, or its periods serve stale money undetected`,
    );
    assert.ok(
      body.indexOf("phx_refresh_sos_fact_rollup") < body.indexOf("phx_refresh_monthly_attribution"),
      `in ${fn}, the attribution refresh must run AFTER the fact-rollup refresh it reads from`,
    );
  }

  // ── G. New public SECURITY DEFINER functions are locked to service_role ─────────────────────────
  // A public SECURITY DEFINER function inherits EXECUTE for PUBLIC (anon/authenticated are members),
  // so both new entry points must revoke it and re-grant to service_role only.
  for (const sig of ["phx_refresh_monthly_attribution(uuid)", "phx_rebuild_monthly_attribution_all()"]) {
    assert.ok(
      new RegExp(`revoke execute on function public\\.${sig.replace(/[()]/g, "\\$&")} from [^;]*public`).test(sql),
      `${sig} must REVOKE EXECUTE FROM PUBLIC (anon/authenticated inherit it)`,
    );
    assert.ok(
      new RegExp(`grant execute on function public\\.${sig.replace(/[()]/g, "\\$&")} to service_role`).test(sql),
      `${sig} must be re-granted to service_role`,
    );
  }

  // ── H. Both readers stay STABLE PARALLEL SAFE SECURITY DEFINER ───────────────────────────────────
  // f_sales_vs_target_range fans these out; losing PARALLEL SAFE would silently serialise the range.
  for (const [label, body] of [["gated", gated], ["live", live]] as const) {
    assert.ok(
      /stable parallel safe security definer/.test(body),
      `the ${label} f_monthly_achievement must remain STABLE PARALLEL SAFE SECURITY DEFINER`,
    );
  }

  // ── I. The four server-side trio call-sites each add the attribution refresh, AFTER the channel ──
  // The TS fallback paths (period-unknown) refresh each rollup individually; the attribution call must
  // follow the channel rollup, which itself follows the fact/directory trio the attribution reads.
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
    const channelAt = body.indexOf("phx_refresh_sos_channel_rollup");
    const attributionAt = body.indexOf("phx_refresh_monthly_attribution");
    assert.ok(
      attributionAt > 0,
      `${rel} must call phx_refresh_monthly_attribution, or imports through this path serve stale money`,
    );
    assert.ok(
      channelAt > 0 && channelAt < attributionAt,
      `${rel} must call the attribution refresh AFTER the channel refresh (both ride the same trio that `
      + "produces the fact rollup the attribution reads)",
    );
  }
}
