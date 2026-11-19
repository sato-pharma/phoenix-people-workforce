import assert from "node:assert/strict";

import {
  COMPANY_VACATION_REPORT_CACHE_TAG,
  FINANCE_DASHBOARD_CACHE_TAG,
  SALES_DASHBOARD_CACHE_TAGS,
  VACATION_REPORT_ROWS_CACHE_TAG,
  invalidateExecutiveDashboardCache,
  invalidatePriceDependentSalesCaches,
} from "../src/lib/dashboard/invalidation.ts";
import { watchNextCacheForTests, type NextCacheCall } from "./stubs/next-cache.ts";

// REC-079 (phase 2): src/lib/dashboard — the cache-busting hub every write calls — run, not read.
//
// invalidateExecutiveDashboardCache(reason, modules) decides which cached screens a write refreshes,
// and HOW: expired at once ({ expire: 0 }: the very next read waits for fresh rows) or stale-while-
// revalidate ("max": the next read is still served the old copy). The test stub of next/cache now
// records every call (tests/stubs/next-cache.ts), so this asserts the tags a write really busts:
//
//   1. A leave write expires the Company Vacation Report and the vacation report base rows AT ONCE —
//      "max" there is what showed HR their old dates after three saves (2026-10-20) — and the Finance
//      Command Center with them; nothing sales-shaped is touched.
//   2. A hire, a seat edit or an exit expires the organogram's cached tree ("sos-reference") at once.
//   3. A sales write refreshes the sales dashboards with "max", and when it lands with a seat change
//      the tree's { expire: 0 } comes LAST — a later "max" on the same tag would undo it.
//   4. Busting is best-effort: outside a request scope revalidateTag throws, and the write that called
//      it must never fail for that; a price edit still tries every one of its tags.

function tagCalls(calls: NextCacheCall[], tag: string) {
  return calls.filter((call): call is Extract<NextCacheCall, { kind: "tag" }> => call.kind === "tag" && call.target === tag);
}

const expiredAtOnce = (call: { profile?: unknown } | undefined) =>
  Boolean(call && typeof call.profile === "object" && call.profile !== null && (call.profile as { expire?: unknown }).expire === 0);

function busted(modules: Parameters<typeof invalidateExecutiveDashboardCache>[1]): NextCacheCall[] {
  const watch = watchNextCacheForTests();
  try {
    invalidateExecutiveDashboardCache("behaviour test", modules);
    return [...watch.calls];
  } finally {
    watch.stop();
  }
}

export function runDashboardInvalidationBehaviourTests(): void {
  // ── 1. A leave write ───────────────────────────────────────────────────────────────────────────
  const leave = busted(["leave"]);
  for (const tag of [COMPANY_VACATION_REPORT_CACHE_TAG, VACATION_REPORT_ROWS_CACHE_TAG, FINANCE_DASHBOARD_CACHE_TAG]) {
    const calls = tagCalls(leave, tag);
    assert.equal(calls.length, 1, `a leave write busts ${tag} once`);
    assert.ok(expiredAtOnce(calls[0]), `HEADLINE: a leave write EXPIRES ${tag} at once — "max" serves the next read the old rows`);
  }
  for (const tag of SALES_DASHBOARD_CACHE_TAGS) {
    assert.equal(tagCalls(leave, tag).length, 0, `a leave write leaves the sales cache ${tag} to its own TTL`);
  }
  assert.deepEqual(
    leave.filter((call) => call.kind === "path").map((call) => call.target),
    ["/admin"],
    "the admin landing is revalidated; /overview only redirects and holds nothing",
  );
  assert.deepEqual(busted(["leave", "leave"]), leave, "a module named twice busts the same as once");

  // ── 2. A hire, a seat edit or an exit refreshes the organogram tree ─────────────────────────────
  for (const seatModule of ["employees", "vacancies", "resignations"] as const) {
    const calls = busted([seatModule]);
    const tree = tagCalls(calls, "sos-reference");
    assert.equal(tree.length, 1, `${seatModule}: the cached org tree is busted`);
    assert.ok(expiredAtOnce(tree[0]), `HEADLINE: ${seatModule} EXPIRES the org tree at once, so the screen that saved the hire re-reads the new tree`);
    assert.equal(tagCalls(calls, FINANCE_DASHBOARD_CACHE_TAG).length, 0, `${seatModule} moves no finance figure`);
  }
  assert.equal(tagCalls(busted(["probation"]), "sos-reference").length, 0, "a module that moves no seat leaves the tree alone");

  // ── 3. Sales, and sales together with a seat change ─────────────────────────────────────────────
  const sales = busted(["sales"]);
  for (const tag of SALES_DASHBOARD_CACHE_TAGS) {
    const calls = tagCalls(sales, tag);
    assert.equal(calls.length, 1, `a sales write busts ${tag}`);
    assert.equal(calls[0].profile, "max", `${tag} is refreshed behind a served copy`);
  }
  const both = tagCalls(busted(["sales", "employees"]), "sos-reference");
  assert.equal(both.length, 2, "a sales write that also moves a seat busts the shared tag twice");
  assert.ok(expiredAtOnce(both[both.length - 1]), "and the { expire: 0 } comes last — a later \"max\" on the same tag would undo it");

  // ── 4. Best-effort: a bust that throws never fails the write ───────────────────────────────────
  const throwing = watchNextCacheForTests({ throwing: true });
  try {
    assert.doesNotThrow(
      () => invalidateExecutiveDashboardCache("behaviour test, outside a request", ["leave", "employees", "sales"]),
      "HEADLINE: outside a request scope revalidation throws, and the write that called it still succeeds",
    );
    const before = throwing.calls.length;
    assert.doesNotThrow(() => invalidatePriceDependentSalesCaches("behaviour test, outside a request"));
    assert.equal(throwing.calls.length - before, 3, "a price edit still tries all three of its tags when each one throws");
  } finally {
    throwing.stop();
  }
}
