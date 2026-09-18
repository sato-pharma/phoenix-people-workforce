import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getWeeklyProductScopeCodes, resolveWeeklyProductBound } from "../src/lib/sales/weekly/access.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

// Source of Sales audit, finding weekly/access.ts:99, in two halves.
//
// 1. The read of a person's Weekly Sales product list answered a database error with the same empty
//    set as "no list", so one failed query silently changed what a Product Manager could see.
// 2. "No list" itself meant two different things: Weekly Sales, the portal closing and Make It Happen
//    widened a Product Manager to his whole lines, while Source of Sales handed its engine an empty
//    set, which reads as "show nothing". Owner, 2026-09-18: "no product list means his whole lines
//    everywhere". Every screen now asks resolveWeeklyProductBound, which answers null for no list.
//
// Every person here is fake. The suite runs with PRODUCTION credentials, so these reads must only
// ever reach the in-memory fake.

function seededClient(options: { failOn?: Record<string, string> } = {}) {
  return fakeSupabaseClient(
    {
      weekly_sales_product_scope: [
        { hr_id: "test-pm-1", product_code: "ro001", created_by: "B-10" },
        { hr_id: "test-pm-1", product_code: " SA001 ", created_by: "B-10" },
        { hr_id: "test-pm-2", product_code: "GU001", created_by: "B-10" },
      ],
    },
    options,
  );
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export async function runWeeklyProductScopeReadTests() {
  // ── A failed read is an error, never "no list" (headline, half 1) ─────────────────────────────
  await assert.rejects(
    getWeeklyProductScopeCodes("test-pm-1", seededClient({ failOn: { weekly_sales_product_scope: "statement timeout" } }) as never),
    /Could not read the Weekly Sales product list: statement timeout/,
    "a failed read of the weekly product list must fail loudly, never come back as an empty list that widens a Product Manager to his whole line",
  );

  // ── A read that works answers exactly as before ────────────────────────────────────────────────
  assert.deepEqual(
    [...(await getWeeklyProductScopeCodes("test-pm-1", seededClient() as never))].sort(),
    ["RO001", "SA001"],
    "the person's own codes, trimmed and upper-cased",
  );
  assert.equal(
    (await getWeeklyProductScopeCodes("test-nobody", seededClient() as never)).size,
    0,
    "a person with no rows really has no list: that is an answer, not an error",
  );

  // ── No person, no read ─────────────────────────────────────────────────────────────────────────
  const refusesEveryRead = {
    from() {
      throw new Error("no HR_ID must not reach the database");
    },
  };
  assert.equal((await getWeeklyProductScopeCodes(null, refusesEveryRead as never)).size, 0, "no HR_ID has no list");

  // ── No list means his whole lines: no product bound at all (headline, half 2) ──────────────────
  assert.equal(
    await resolveWeeklyProductBound("test-nobody", seededClient() as never),
    null,
    "a Product Manager with no product list gets no product bound (his whole lines), never an empty set that Source of Sales reads as \"show nothing\"",
  );
  assert.deepEqual(
    [...((await resolveWeeklyProductBound("test-pm-1", seededClient() as never)) ?? [])].sort(),
    ["RO001", "SA001"],
    "a Product Manager with a list is bounded to exactly that list",
  );
  assert.equal(await resolveWeeklyProductBound(null, refusesEveryRead as never), null, "no HR_ID has no product bound");
  await assert.rejects(
    resolveWeeklyProductBound("test-pm-1", seededClient({ failOn: { weekly_sales_product_scope: "statement timeout" } }) as never),
    /Could not read the Weekly Sales product list: statement timeout/,
    "a failed read is still an error through the bound, never \"no list\"",
  );

  // ── Every screen asks the same question ────────────────────────────────────────────────────────
  for (const path of [
    "src/lib/sales/portal-sos-dashboard.ts",
    "src/lib/sales/monthly-closing-portal.ts",
    "src/lib/sales/make-it-happen/scope.ts",
  ]) {
    const text = source(path);
    assert.match(text, /resolveWeeklyProductBound\(/, `${path} must decide a Product Manager's products with resolveWeeklyProductBound`);
    assert.doesNotMatch(
      text,
      /getWeeklyProductScopeCodes\(/,
      `${path} must not read the raw list, whose empty set means "nothing" to one screen and "whole lines" to another`,
    );
  }
  assert.match(
    source("src/lib/sales/weekly/access.ts"),
    /const assignedCodes = await resolveWeeklyProductBound\(hrKey\);/,
    "Weekly Sales decides the product tier with the same bound as every other screen",
  );
}
