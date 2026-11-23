import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PLAN_READ_CONCURRENCY, REVIEW_ITEM_COLUMNS, REVIEW_ITEM_PLANS_PER_CALL } from "../src/lib/phoenix-crm/server/plans.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Field CRM board's plan reviews in one request (owner, 23 Nov 2026: "fix the slow Field CRM board").
 *
 * The admin board opens on Team, which asks for the week's and the month's plan reviews. Their items came
 * through `loadPlanItemRows`: 50 plans a chunk, each chunk 1,000 rows a page, one page after another, so
 * the Super Admin's week waited 4 waves and his month 6, each paying the edge's ~450 ms (2.8-3.1 s each on
 * production). `phoenix_crm_plan_review_items` answers the same rows as one jsonb value.
 *
 *   1. The function: read-only, SECURITY DEFINER on `public`, executable by the service role alone, every
 *      item of the given plans, in id order, a missing customer or place as null (PostgREST's embed).
 *   2. Its keys are exactly `REVIEW_ITEM_COLUMNS`' — the fallback and the function cannot drift apart.
 *   3. `loadReviewItemRows` asks it a bounded group of plans at a time, all in flight together, and only
 *      a database without it (PGRST202) falls back to the old read with the same columns.
 *   4. Both review loaders read through it.
 */

const MIGRATION = "supabase/migrations/20261123204236_phoenix_crm_plan_review_items.sql";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = (path: string) => stripComments(read(path)).replace(/\r\n/g, "\n");

/** The source from the function's declaration — exported or not — to the next exported symbol. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

/** `a, b, x:table!fk(c, d)` → { a: true, b: true, x: ["c", "d"] }, the shape PostgREST answers. */
function selectShape(columns: string): Record<string, true | string[]> {
  const shape: Record<string, true | string[]> = {};
  for (const match of columns.matchAll(/(\w+)(?::[\w!]+\(([^)]*)\))?/g)) {
    const [, key, inner] = match;
    shape[key] = inner === undefined ? true : inner.split(",").map((part) => part.trim()).filter(Boolean);
  }
  return shape;
}

/** The keys `jsonb_build_object` writes at the top level, and those of each nested object. */
function functionShape(block: string): Record<string, true | string[]> {
  const shape: Record<string, true | string[]> = {};
  for (const match of block.matchAll(/'(\w+)', (case when \w+\.id is null then null else jsonb_build_object\(([^)]*)\) end|\w+\.\w+)/g)) {
    const [, key, , nested] = match;
    shape[key] = nested === undefined ? true : [...nested.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  }
  return shape;
}

export function runPhoenixCrmPlanReviewItemsTests(): void {
  const sql = code(MIGRATION);
  const start = sql.indexOf("create or replace function public.phoenix_crm_plan_review_items(p_plan_ids uuid[])");
  assert.ok(start >= 0, "the function is created with one uuid[] argument");
  const block = sql.slice(start, sql.indexOf("$$;", start) + 3);

  // ── 1. The function ─────────────────────────────────────────────────────────────────────────────
  {
    assert.match(block, /returns jsonb\s+language sql\s+stable\s+security definer\s+set search_path to 'public'/, "one jsonb value, read-only, definer on public");
    assert.doesNotMatch(block, /\b(insert|update|delete|truncate)\b/i, "it writes nothing");
    assert.match(block, /order by i\.id/, "id order — the keyset walk's order inside each plan");
    assert.match(block, /coalesce\(\s*jsonb_agg\([\s\S]*'\[\]'::jsonb\s*\)/, "no plans, an empty array, never null");
    assert.match(block, /left join public\.phoenix_crm_customers c on c\.id = i\.customer_id/, "a customer is joined, never required");
    assert.match(block, /left join public\.phoenix_crm_places p on p\.id = i\.place_id/, "a place is joined, never required");
    assert.match(block, /where i\.plan_id = any\(p_plan_ids\)/, "every item of the plans asked, and only those");
    assert.match(block, /case when p\.id is null then null else/, "an item with no place carries place null, as the embed did");
    assert.match(
      sql,
      /revoke execute on function public\.phoenix_crm_plan_review_items\(uuid\[\]\) from public, anon, authenticated;\s*grant execute on function public\.phoenix_crm_plan_review_items\(uuid\[\]\) to service_role;/,
      "the browser roles cannot call it; the service role can",
    );
  }

  // ── 2. The same shape as the read it replaces ───────────────────────────────────────────────────
  {
    assert.deepEqual(functionShape(block), selectShape(REVIEW_ITEM_COLUMNS), "the function answers exactly REVIEW_ITEM_COLUMNS' keys");
    assert.deepEqual(selectShape(REVIEW_ITEM_COLUMNS).place, ["lat", "lon", "status"], "the parse reads the nested columns");
  }

  // ── 3. The loader ───────────────────────────────────────────────────────────────────────────────
  {
    const plans = code("src/lib/phoenix-crm/server/plans.ts");
    const loader = functionBody(plans, "loadReviewItemRows");
    assert.match(
      loader,
      /mapWithConcurrency\(chunk\(ids, REVIEW_ITEM_PLANS_PER_CALL\), PLAN_READ_CONCURRENCY,/,
      "a bounded group of plans per call, the groups in flight together",
    );
    assert.match(loader, /\.rpc\("phoenix_crm_plan_review_items", \{ p_plan_ids: part \}\)/, "one call per group");
    assert.match(loader, /if \(!isMissingCrmRpcError\(error\)\) throwIfError\(error\);/, "any other failure is thrown, never read as no items");
    assert.match(loader, /if \(missing\) return loadPlanItemRows\(ids, REVIEW_ITEM_COLUMNS\);/, "only a missing function falls back, to the same columns");
    assert.match(loader, /if \(ids\.length === 0\) return \[\];/, "no plans, no request");
    assert.ok(REVIEW_ITEM_PLANS_PER_CALL >= 100 && REVIEW_ITEM_PLANS_PER_CALL <= 200, "a week's plans in one call, a call never unbounded");
    assert.ok(REVIEW_ITEM_PLANS_PER_CALL * PLAN_READ_CONCURRENCY >= 480, "a month of the whole field in one wave");
  }

  // ── 4. Both review loaders read through it ──────────────────────────────────────────────────────
  {
    const plans = code("src/lib/phoenix-crm/server/plans.ts");
    const weekly = functionBody(plans, "loadPlanReviews");
    assert.match(weekly, /loadReviewItemRows\(weekPlans\.map\(\(row\) => String\(row\.id\)\)\)/, "the week's reviews");
    assert.doesNotMatch(weekly, /loadPlanItemRows\(/, "and never the paged read");

    const month = code("src/lib/phoenix-crm/server/monthly-plans.ts");
    const monthly = functionBody(month, "loadMonthlyPlanReviews");
    assert.match(monthly, /loadReviewItemRows\(planRows\.map\(\(row\) => String\(row\.id\)\)\)/, "the month's reviews");
    assert.doesNotMatch(monthly, /loadPlanItemRows\(/, "and never the paged read");
  }
}
