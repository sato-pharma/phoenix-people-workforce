import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";
import { lastDefinerPath, lastDefinerSql } from "./support/sql-definer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// au.f_monthly_attribution GROUPS THE FACT ROWS BEFORE IT CLEANS THEIR KEYS (2026-10-16).
//
// Sales vs Target, Targets and the Business Review read July, August and September 2026 live
// through this function on every request: those months are published, so their attribution
// rollup is frozen, and once the configuration moved on after publishing, au.f_monthly_achievement
// stops trusting the rollup and recomputes them. Measured on production: 338 ms of a month's
// 378 ms was this function, and 255 ms of that was upper/lower(btrim(...)) run on each of ~32,000
// fact rows. Those rows fall into ~1,080 distinct raw key combinations, so the function now sums
// per raw key first (`fact_raw`) and cleans the keys of the groups — 318 ms to 110 ms a month,
// every figure identical (8,029 rows on all eleven months compared as text on production).
//
// What keeps the figures identical is a property of the WHOLE body, not of the new step: every
// later use of these rows must be a SUM. A count, avg, min, max or distinct would see ~1,080 rows
// where it used to see ~32,000 and change a number with no error anywhere. That is the assertion
// most worth having, and the one a later "small tidy-up" is most likely to break.
// ─────────────────────────────────────────────────────────────────────────────

const HEADER = "create or replace function au.f_monthly_attribution(";
const DEFINER = /create or replace function au\.f_monthly_attribution\(/;
const PREVIOUS_DEFINER = "supabase/migrations/20260929191509_price_cte_qualify_product_code.sql";

/** The function's own text, header to terminator, from comment-stripped SQL. */
function functionBody(sql: string): string {
  const start = sql.lastIndexOf(HEADER);
  assert.ok(start >= 0, "the migration must define au.f_monthly_attribution");
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start, "au.f_monthly_attribution must be closed with $function$;");
  return sql.slice(start, end).replace(/\r\n/g, "\n");
}

/** The text of one CTE, `name as (` to its matching close paren. */
function cte(body: string, name: string): string | null {
  const opener = new RegExp(`\\b${name}\\s+as\\s*(?:materialized\\s*)?\\(`, "i").exec(body);
  if (!opener) return null;
  let depth = 0;
  for (let i = opener.index + opener[0].length - 1; i < body.length; i += 1) {
    if (body[i] === "(") depth += 1;
    else if (body[i] === ")") {
      depth -= 1;
      if (depth === 0) return body.slice(opener.index, i + 1);
    }
  }
  return null;
}

/**
 * Every way a body breaks the grouped-first shape. Empty means it holds. Pure, so the previous
 * definition and a deliberately broken body can be run through it as negative controls.
 */
export function groupedFirstViolations(body: string): string[] {
  const violations: string[] = [];
  const lower = body.toLowerCase();

  const reads = lower.match(/public\.source_of_sales_fact_rollup\b/g) ?? [];
  if (reads.length !== 1) violations.push(`the fact rollup must be read exactly once, read ${reads.length} times`);

  const raw = cte(lower, "fact_raw");
  if (!raw) {
    violations.push("no fact_raw step: the fact rows are cleaned one by one before they are grouped");
  } else {
    if (!raw.includes("public.source_of_sales_fact_rollup")) violations.push("fact_raw must be the step that reads the fact rollup");
    if (!/group\s+by\s+f\.official_line,\s*f\.region_code,\s*f\.area_code,\s*f\.product_code,\s*f\.is_direct\s*$/.test(raw.slice(0, -1).trim())) {
      violations.push("fact_raw must group on exactly the five raw keys (official_line, region_code, area_code, product_code, is_direct)");
    }
    for (const amount of ["total_qty", "effective_units", "direct_value"]) {
      if (!new RegExp(`sum\\(f\\.${amount}\\)\\s+as\\s+${amount}\\b`).test(raw)) violations.push(`fact_raw must sum ${amount} under its own name`);
    }
    if (/\b(?:upper|lower|btrim|nullif|coalesce)\s*\(/.test(raw)) {
      violations.push("fact_raw must apply no function to the keys — cleaning per row is the cost this step removes");
    }
  }

  const fact = cte(lower, "fact");
  if (!fact || !/\bfrom\s+fact_raw\b/.test(fact)) violations.push("fact must read fact_raw, not the fact rows");
  if (!fact || !/not\s+in\s*\(\s*'la003'\s*,\s*'la004'\s*,\s*'ss001'\s*\)/.test(fact)) {
    violations.push("fact must keep the LA003 / LA004 / SS001 exclusion");
  }

  // The property that makes the regroup exact: only sums ever see these rows.
  for (const [label, pattern] of [
    ["count(", /\bcount\s*\(/],
    ["avg(", /\bavg\s*\(/],
    ["min(", /\bmin\s*\(/],
    ["max(", /\bmax\s*\(/],
    ["an _agg( aggregate", /\w+_agg\s*\(/],
    ["bool_and( / bool_or(", /\bbool_(?:and|or)\s*\(/],
    ["select distinct", /\bselect\s+distinct\b/],
  ] as const) {
    if (pattern.test(lower)) violations.push(`${label} over grouped rows would count groups, not sales — every use must be a sum`);
  }

  return violations;
}

export function runMonthlyAttributionGroupsFactRowsFirstTests() {
  // ── The definition the database runs ───────────────────────────────────────
  const livePath = lastDefinerPath(DEFINER, "au.f_monthly_attribution");
  const live = functionBody(lastDefinerSql(DEFINER, "au.f_monthly_attribution"));
  assert.deepEqual(
    groupedFirstViolations(live),
    [],
    `RED ${livePath} must sum the fact rows per raw key before cleaning the keys, and use nothing but sums downstream — otherwise July to September go back to ~378 ms each on every Sales vs Target read, or a figure changes`,
  );

  // Everything the earlier guards demand of this function is still there.
  for (const needed of ["au.f_seat_occupant_asof", "au.f_line_area_map_asof", "au.monthly_store_split_net", "au.direct_region_allocation", "source_of_sales_product_price_history"]) {
    assert.ok(live.includes(needed), `the function must still read ${needed}`);
  }
  assert.match(live, /\bsecurity definer\b/, "SECURITY DEFINER must be re-declared by CREATE OR REPLACE");
  assert.match(live, /set search_path to 'au', 'public'/, "search_path must be re-declared verbatim");

  // ── Negative controls: the check must be able to fail ──────────────────────
  const previous = functionBody(stripSqlComments(readFileSync(PREVIOUS_DEFINER, "utf8")));
  assert.ok(
    groupedFirstViolations(previous).some((v) => v.startsWith("no fact_raw step")),
    "the previous definition cleaned every fact row and must be refused — or this test proves nothing",
  );
  const counted = live.replace("sum(pr.total_qty) as q, sum(pr.effective_units) as eu", "sum(pr.total_qty) as q, count(*) as eu");
  assert.notEqual(counted, live, "fixture precondition: the ind_base sums are where the mutation lands");
  assert.ok(
    groupedFirstViolations(counted).some((v) => v.startsWith("count(")),
    "a count over grouped rows must be refused — it would count ~1,080 groups where it used to count ~32,000 rows",
  );
  const cleanedPerRow = live.replace(
    "group by f.official_line, f.region_code, f.area_code, f.product_code, f.is_direct",
    "group by f.official_line, f.region_code, f.area_code, upper(btrim(f.product_code)), f.is_direct",
  );
  assert.notEqual(cleanedPerRow, live, "fixture precondition: the fact_raw grouping is where the mutation lands");
  assert.ok(groupedFirstViolations(cleanedPerRow).length > 0, "cleaning a key inside fact_raw must be refused");
}
