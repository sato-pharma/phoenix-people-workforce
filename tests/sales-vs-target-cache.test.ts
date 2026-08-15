import assert from "node:assert/strict";

import { achievementRangeCacheKeyParts } from "../src/lib/sales/vs-target.ts";

/**
 * loadAchievementRange (the field force's #1 production query by DB time) is now served from a
 * cross-request unstable_cache. Its output carries the AS-OF seat occupant (rep_hr_id / dm_hr_id)
 * and the target figures, so a stale cache entry would mis-attribute achievement to the wrong
 * person or divide by the wrong target — a money defect, not a cosmetic one.
 *
 * The whole safety of the design rests on ONE thing: a freshness token
 * (phx_sales_vs_target_cache_token — a hash of the attribution config fingerprint + occupancy
 * history + monthly targets + attribution-rollup refresh state + today's Cairo date) is folded
 * into the cache key, so any change to those inputs lands on a DIFFERENT entry and the cache can
 * never hand back a value computed against yesterday's targets or last week's seat wiring. There
 * is no tag/revalidate write-path to hunt down — the token IS the invalidation.
 *
 * This database-free test pins that contract on achievementRangeCacheKeyParts, the exact array
 * handed to unstable_cache. If a refactor ever drops the token (or the range bounds) from the key,
 * the "different inputs must not collide" assertions below fire.
 */
export function runSalesVsTargetCacheTests() {
  const PREFIX = "sales-vs-target-achievement-range";

  // 1. Shape: a stable prefix, the two range bounds, then the freshness token — in that order.
  //    unstable_cache keys on this array, so both its CONTENTS and its ORDER are load-bearing.
  assert.deepEqual(
    achievementRangeCacheKeyParts("2026-01", "2026-08", "tok-abc"),
    [PREFIX, "2026-01", "2026-08", "tok-abc"],
    "key parts must be [prefix, from, to, token] in order",
  );

  const serialize = (parts: string[]) => JSON.stringify(parts);

  // 2. THE INVALIDATION CONTRACT. Same range, DIFFERENT token (a seat move, a target edit, an
  //    actuals refresh, or simply Cairo midnight) MUST produce a different key. This is the single
  //    assertion that a token-dropping refactor breaks — verified by hand: remove `token` from
  //    achievementRangeCacheKeyParts and these two serialize identically, failing here.
  const before = serialize(achievementRangeCacheKeyParts("2026-01", "2026-08", "token-before-change"));
  const after = serialize(achievementRangeCacheKeyParts("2026-01", "2026-08", "token-after-change"));
  assert.notEqual(before, after, "a changed freshness token MUST change the cache key");

  // 3. Determinism: identical inputs (same range, same token) must reuse the SAME entry, or the
  //    cache would never hit and the optimization would be inert.
  const a = serialize(achievementRangeCacheKeyParts("2026-07", "2026-07", "tok-1"));
  const b = serialize(achievementRangeCacheKeyParts("2026-07", "2026-07", "tok-1"));
  assert.equal(a, b, "identical inputs must yield an identical cache key");

  // 4. The range bounds also discriminate: two different windows under the SAME token must not
  //    collide (a dashboard 8-month range and an employee-360 single month share a token epoch).
  const wide = serialize(achievementRangeCacheKeyParts("2026-01", "2026-08", "tok-x"));
  const narrow = serialize(achievementRangeCacheKeyParts("2026-07", "2026-07", "tok-x"));
  assert.notEqual(wide, narrow, "different ranges under one token must not share an entry");

  // 5. The prefix namespaces this cache away from every other unstable_cache in the app.
  for (const part of achievementRangeCacheKeyParts("2026-03", "2026-05", "tok")) {
    assert.equal(typeof part, "string", "every key part must be a plain string for unstable_cache");
  }
  assert.equal(
    achievementRangeCacheKeyParts("2026-03", "2026-05", "tok")[0],
    PREFIX,
    "the first key part must be the stable namespace prefix",
  );
}
