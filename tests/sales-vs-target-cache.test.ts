import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  ACHIEVEMENT_CACHE_MAX_BYTES,
  achievementMonthCacheKeyParts,
  achievementPeriodsInRange,
  packAchievementRows,
  unpackAchievementRows,
} from "../src/lib/sales/vs-target.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

/**
 * loadAchievementRange (the field force's #1 production query by DB time) is served from a
 * cross-request unstable_cache. Its output carries the AS-OF seat occupant (rep_hr_id / dm_hr_id)
 * and the target figures, so a stale cache entry would mis-attribute achievement to the wrong
 * person or divide by the wrong target — a money defect, not a cosmetic one.
 *
 * The safety of the design rests on ONE thing: a freshness token (phx_sales_vs_target_cache_token
 * — a hash of the attribution config fingerprint + occupancy history + monthly targets +
 * attribution-rollup refresh state + today's Cairo date) is folded into the cache key, so any
 * change to those inputs lands on a DIFFERENT entry and the cache can never hand back a value
 * computed against yesterday's targets or last week's seat wiring. There is no tag/revalidate
 * write-path to hunt down — the token IS the invalidation.
 *
 * Since 2026-09-04 the key is PER MONTH rather than per range, because per-range keying was what
 * made this statement cost 7,973 seconds of production database time across 3,436 calls: no two
 * callers ever shared an entry, and a nine-month range costs 13x a single month (541 ms vs 42 ms,
 * measured live) while eight of its nine months are closed and cannot change. The tests below pin
 * both halves: the invalidation contract that was already load-bearing, and the sharing property
 * that is the entire reason for the change.
 */
export async function runSalesVsTargetCacheTests() {
  const PREFIX = "sales-vs-target-achievement-month";

  // 1. Shape: a stable prefix, the PERIOD, then the freshness token — in that order.
  //    unstable_cache keys on this array, so both its CONTENTS and its ORDER are load-bearing.
  assert.deepEqual(
    achievementMonthCacheKeyParts("2026-07", "tok-abc"),
    [PREFIX, "2026-07", "tok-abc"],
    "key parts must be [prefix, period, token] in order",
  );

  const serialize = (parts: string[]) => JSON.stringify(parts);

  // 2. THE INVALIDATION CONTRACT. Same month, DIFFERENT token (a seat move, a target edit, an
  //    actuals refresh, or simply Cairo midnight) MUST produce a different key. This is the single
  //    assertion that a token-dropping refactor breaks — verified by hand: remove `token` from
  //    achievementMonthCacheKeyParts and these two serialize identically, failing here.
  const before = serialize(achievementMonthCacheKeyParts("2026-07", "token-before-change"));
  const after = serialize(achievementMonthCacheKeyParts("2026-07", "token-after-change"));
  assert.notEqual(before, after, "a changed freshness token MUST change the cache key");

  // 3. Determinism: identical inputs must reuse the SAME entry, or the cache would never hit and
  //    the optimization would be inert.
  assert.equal(
    serialize(achievementMonthCacheKeyParts("2026-07", "tok-1")),
    serialize(achievementMonthCacheKeyParts("2026-07", "tok-1")),
    "identical inputs must yield an identical cache key",
  );

  // 4. Different MONTHS under one token must not collide, or July would be served August's rows.
  assert.notEqual(
    serialize(achievementMonthCacheKeyParts("2026-07", "tok-x")),
    serialize(achievementMonthCacheKeyParts("2026-08", "tok-x")),
    "different periods under one token must not share an entry",
  );

  // 5. The prefix namespaces this cache away from every other unstable_cache in the app, and every
  //    part must be a plain string — unstable_cache keys on the array exactly as given.
  for (const part of achievementMonthCacheKeyParts("2026-03", "tok")) {
    assert.equal(typeof part, "string", "every key part must be a plain string for unstable_cache");
  }
  assert.equal(
    achievementMonthCacheKeyParts("2026-03", "tok")[0],
    PREFIX,
    "the first key part must be the stable namespace prefix",
  );

  // 6. THE SHARING PROPERTY — the whole reason the key moved from range to month.
  //
  //    The dashboard reads 2026-01..2026-09, employee-360 reads 2026-07..2026-09 and Sales Truth
  //    reads one month, all within the same token epoch. Under per-RANGE keying those three shared
  //    nothing and each paid for its own full recompute. Under per-MONTH keying every month they
  //    have in common is literally the SAME entry. If a refactor ever puts the requested range
  //    back into the key, this fires.
  const token = "tok-epoch";
  const keysFor = (from: string, to: string) =>
    achievementPeriodsInRange(from, to).map((period) =>
      serialize(achievementMonthCacheKeyParts(period, token)),
    );
  const dashboard = keysFor("2026-01", "2026-09");
  const employee360 = keysFor("2026-07", "2026-09");
  const salesTruth = keysFor("2026-09", "2026-09");
  assert.deepEqual(
    dashboard.filter((key) => employee360.includes(key)),
    employee360,
    "every month of a narrower window must reuse the wider window's entries, not merely overlap them",
  );
  assert.equal(employee360.length, 3, "2026-07..2026-09 is three months");
  assert.ok(
    dashboard.includes(salesTruth[0]),
    "a single-month read must land on the entry the wide range already populated",
  );

  // ── Range expansion ─────────────────────────────────────────────────────────
  //
  // The expansion IS the clamp now. au.f_sales_vs_target_range used to bound a malformed or
  // hostile range server-side for free, because the whole window was one call. Expanding it in
  // TypeScript moves that responsibility here, so these mirror the SQL exactly.

  // 7. Ascending, inclusive of both bounds, no gaps. Concatenating months in this order is what
  //    makes the assembled range byte-identical to the old single wide call.
  assert.deepEqual(
    achievementPeriodsInRange("2026-06", "2026-09"),
    ["2026-06", "2026-07", "2026-08", "2026-09"],
    "the range must expand ascending and include both bounds",
  );
  assert.deepEqual(
    achievementPeriodsInRange("2026-07", "2026-07"),
    ["2026-07"],
    "a single-month range must expand to exactly that month",
  );

  // 8. Year rollover — December to January is the one boundary naive string arithmetic gets wrong.
  assert.deepEqual(
    achievementPeriodsInRange("2026-11", "2027-02"),
    ["2026-11", "2026-12", "2027-01", "2027-02"],
    "the expansion must cross a year boundary correctly",
  );

  // 9. The engine's data floor. SALES_HISTORY_FLOOR is 2026-01 and the SQL floors there too, so an
  //    earlier `from` must not manufacture months the database would refuse to serve.
  assert.deepEqual(
    achievementPeriodsInRange("2025-09", "2026-02"),
    ["2026-01", "2026-02"],
    "a pre-floor `from` must be clamped to SALES_HISTORY_FLOOR, not expanded below it",
  );

  // 10. THE FAN-OUT BOUND. au.f_sales_vs_target_range caps at 24 months; the old code got that
  //     clamp for free because the range was one call. Without the cap here a malformed `to` would
  //     become tens of thousands of RPCs instead of one clamped query — the one failure mode this
  //     change could plausibly introduce.
  const hostile = achievementPeriodsInRange("2026-01", "9999-12");
  assert.equal(hostile.length, 24, "the expansion must cap at 24 months, exactly as the SQL does");
  assert.equal(hostile[0], "2026-01", "the capped window must start at the floored `from`");
  assert.equal(hostile[23], "2027-12", "24 months from 2026-01 ends at 2027-12");

  // 11. Malformed and inverted inputs expand to nothing, so no RPC is ever issued for them.
  for (const [from, to, why] of [
    ["2026-09", "2026-07", "an inverted range"],
    ["not-a-period", "2026-09", "a malformed `from`"],
    ["2026-01", "2026-13-01", "a malformed `to`"],
    ["", "", "empty bounds"],
  ] as const) {
    assert.deepEqual(achievementPeriodsInRange(from, to), [], `${why} must expand to no months`);
  }

  // ── The 2MB ceiling ────────────────────────────────────────────────────────
  //
  // Next REFUSES any data-cache entry over 2MB. In dev it throws, and the throw lands on a
  // promise Next never awaits and never catches (pendingRevalidates in unstable-cache.js), so it
  // arrives as an unhandledRejection and Node kills the whole dev server. Nothing in our code can
  // catch it. The rows are therefore stored gzipped, and packAchievementRows returns null rather
  // than ever handing over an entry that would not fit. Per-month entries are ~890 rows and land
  // far inside the ceiling, but the guard is what protects a future growth month, so it stays
  // pinned here.

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

  // 12. The ceiling must stay strictly under Next's hard limit, with real margin. Raising it to
  //     2MB "because that is the documented limit" would put us back on the crash boundary — the
  //     payload Next measures is the JSON envelope around ours, not ours alone.
  assert.ok(
    ACHIEVEMENT_CACHE_MAX_BYTES < 2 * 1024 * 1024,
    "the pack ceiling must stay under Next's hard 2MB data-cache limit",
  );

  // 13. ROUND-TRIP FIDELITY. The cache must hand back exactly what the RPC produced — a lossy
  //     encoding here would mean the cached render and the live render quote different money.
  //     Nulls, negatives, floats and empty strings are all represented in the real range.
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

  // 14. A REAL MONTH. 889 rows is 2026-08 measured live on 2026-09-04 — the actual size of one
  //     cache entry now. It must pack with room to spare and survive the round trip unchanged.
  const oneMonth: AchievementRow[] = Array.from({ length: 889 }, (_, i) =>
    makeRow({
      period: "2026-08",
      areaCode: `A-${String(i % 51).padStart(3, "0")}`,
      productCode: `P-${String(i % 140).padStart(3, "0")}`,
      repHrId: `HR-${1000 + (i % 210)}`,
      dmHrId: `HR-${2000 + (i % 40)}`,
      actualValue: 1000 + (i % 9973) / 7,
    }),
  );
  const packedMonth = await packAchievementRows(oneMonth);
  assert.ok(packedMonth !== null, "one production-sized month must pack");
  assert.ok(
    packedMonth.length < ACHIEVEMENT_CACHE_MAX_BYTES / 4,
    "one month must land well inside the ceiling, not near it",
  );
  assert.deepEqual(await unpackAchievementRows(packedMonth), oneMonth, "889 rows must round-trip unchanged");

  // 15. THE OLD REGRESSION, still pinned. A production-shaped WIDE payload (6,950 rows for
  //     2026-01..2026-08, measured live 2026-08-22) serialized to 2,799,322 bytes raw — 133% of
  //     the limit, which is what killed the dev server on every /admin load. Nothing builds an
  //     entry that wide any more, but packAchievementRows is still the only thing standing between
  //     a growth month and that crash, so its behaviour on a large payload stays pinned.
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
    packedProduction !== null && packedProduction.length < ACHIEVEMENT_CACHE_MAX_BYTES,
    "a production-sized range must fit the data cache once compressed",
  );
  assert.deepEqual(
    await unpackAchievementRows(packedProduction),
    productionShaped,
    "6,950 rows must survive the round trip unchanged",
  );

  // 16. THE BYPASS. Compression is not a guarantee — a payload that will not fit even gzipped
  //     must come back null so the caller reads live instead. Random content is incompressible by
  //     construction, which is the only honest way to force that branch.
  const incompressible: AchievementRow[] = Array.from({ length: 3000 }, () =>
    makeRow({ productCode: randomBytes(525).toString("base64") }),
  );
  assert.equal(
    await packAchievementRows(incompressible),
    null,
    "a payload over the ceiling must return null and never reach the data cache",
  );
}
