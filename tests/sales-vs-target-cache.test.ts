import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  ACHIEVEMENT_RANGE_CACHE_MAX_BYTES,
  achievementRangeCacheKeyParts,
  packAchievementRows,
  unpackAchievementRows,
} from "../src/lib/sales/vs-target.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

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
export async function runSalesVsTargetCacheTests() {
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

  // ── The 2MB ceiling ────────────────────────────────────────────────────────
  //
  // Next REFUSES any data-cache entry over 2MB. In dev it throws, and the throw lands on a
  // promise Next never awaits and never catches (pendingRevalidates in unstable-cache.js), so it
  // arrives as an unhandledRejection and Node kills the whole dev server. Nothing in our code can
  // catch it. The rows are therefore stored gzipped, and packAchievementRows returns null rather
  // than ever handing over an entry that would not fit. These assertions pin both halves.

  const makeRow = (overrides: Partial<AchievementRow> = {}): AchievementRow => ({
    period: "2026-07",
    lineCode: "CNS",
    regionCode: "R1",
    areaCode: "A-CAI-01",
    areaState: "active",
    isOther: false,
    repSeatId: "seat-0001",
    repHrId: "HR-1001",
    dmSeatId: "seat-dm-01",
    dmHrId: "HR-2001",
    productCode: "P-001",
    actualUnits: 12,
    actualValue: 3456.78,
    targetUnits: 20,
    targetValue: 5000,
    achievementValue: 0.6913,
    achievementUnits: 0.6,
    hasTarget: true,
    hasActual: true,
    ...overrides,
  });

  // 6. The ceiling must stay strictly under Next's hard limit, with real margin. Raising it to
  //    2MB "because that is the documented limit" would put us back on the crash boundary — the
  //    payload Next measures is the JSON envelope around ours, not ours alone.
  assert.ok(
    ACHIEVEMENT_RANGE_CACHE_MAX_BYTES < 2 * 1024 * 1024,
    "the pack ceiling must stay under Next's hard 2MB data-cache limit",
  );

  // 7. ROUND-TRIP FIDELITY. The cache must hand back exactly what the RPC produced — a lossy
  //    encoding here would mean the cached render and the live render quote different money.
  //    Nulls, negatives, floats and empty strings are all represented in the real range.
  const sample: AchievementRow[] = [
    makeRow(),
    makeRow({ lineCode: null, regionCode: null, areaCode: null, areaState: null, isOther: true }),
    makeRow({ repSeatId: null, repHrId: null, dmSeatId: null, dmHrId: null }),
    makeRow({ targetUnits: null, targetValue: null, achievementValue: null, achievementUnits: null, hasTarget: false }),
    makeRow({ actualUnits: -3, actualValue: -1234.56, productCode: "", hasActual: false }),
  ];
  const packedSample = await packAchievementRows(sample);
  assert.ok(packedSample !== null, "a five-row payload must pack, not bypass the cache");
  assert.deepEqual(await unpackAchievementRows(packedSample), sample, "pack -> unpack must be lossless");

  // 8. THE REGRESSION. A production-shaped range (6,950 rows for 2026-01..2026-08, measured live
  //    2026-08-22) serialized to 2,799,322 bytes raw — 133% of the limit, which is what killed the
  //    dev server on every /admin load. Compressed it must land well inside the ceiling.
  const periods = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
  const productionShaped: AchievementRow[] = Array.from({ length: 6950 }, (_, i) =>
    makeRow({
      period: periods[i % periods.length],
      areaCode: `A-${String(i % 51).padStart(3, "0")}`,
      productCode: `P-${String(i % 140).padStart(3, "0")}`,
      repHrId: `HR-${1000 + (i % 210)}`,
      dmHrId: `HR-${2000 + (i % 40)}`,
      actualValue: 1000 + (i % 9973) / 7,
    }),
  );
  assert.ok(
    JSON.stringify(productionShaped).length > 2 * 1024 * 1024,
    "the fixture must actually exceed 2MB raw, or it is not reproducing the crash",
  );
  const packedProduction = await packAchievementRows(productionShaped);
  assert.ok(
    packedProduction !== null && packedProduction.length < ACHIEVEMENT_RANGE_CACHE_MAX_BYTES,
    "a production-sized range must fit the data cache once compressed",
  );
  assert.deepEqual(
    await unpackAchievementRows(packedProduction),
    productionShaped,
    "6,950 rows must survive the round trip unchanged",
  );

  // 9. THE BYPASS. Compression is not a guarantee — a payload that will not fit even gzipped
  //    must come back null so the caller reads live instead. Random content is incompressible by
  //    construction, which is the only honest way to force that branch.
  const incompressible: AchievementRow[] = Array.from({ length: 3000 }, () =>
    makeRow({ productCode: randomBytes(525).toString("base64") }),
  );
  assert.equal(
    await packAchievementRows(incompressible),
    null,
    "a payload over the ceiling must return null and never reach the data cache",
  );
}
