import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// CRM brick-centroid resolution — the cross-request cache.
//
// loadBrickCentroids() (src/lib/crm/brick-geo.ts) reads the ~1,100 brick_centroid rows from
// geo_locations, joins them to bricks/areas/regions, and is called on the hottest CRM/outstation
// paths (check-ins render, outstation claim validation). It USED to hold its result in a
// module-level `let cache`. In the App Router each route segment gets its own module instance, so
// that variable was cold on most of the pages that call this — production profiling after the
// 2026-08-14 stats reset showed it as the single heaviest DB consumer (55.3 s / 3,372 calls in a
// 3.6 h window, ~40x more reads than its 5-minute TTL should have allowed).
//
// The fix moves the cache to the Next.js Data Cache via unstable_cache, which IS shared across every
// route segment, keeping the EXACT same 5-minute staleness window (revalidate: 300) and tagging it
// `sos-reference` so any validated SoS import busts it immediately (invalidateSalesDashboardCache
// already fires that tag, and dashboard/invalidation.ts already lists brick centroids as a consumer).
//
// The harness cannot run Next.js, so this locks the SOURCE SHAPE — the same weaker-but-honest
// instrument the sibling search test uses. The one non-obvious invariant it guards is the try/catch
// placement: it must sit OUTSIDE the cached function, so a transient DB error throws (and is never
// written into the cache) rather than poisoning it with an empty list for 5 minutes.
// ─────────────────────────────────────────────────────────────────────────────

const BRICK_GEO = "../src/lib/crm/brick-geo.ts";

export function runCrmBrickCentroidsCacheTests() {
  const source = readFileSync(new URL(BRICK_GEO, import.meta.url), "utf8");

  // ── The read is cached in the SHARED Data Cache, not a per-segment module variable ──────────
  {
    assert.match(
      source,
      /import\s*\{\s*unstable_cache\s*\}\s*from\s*"next\/cache"/,
      "brick-geo must cache through next/cache — a module-level variable is not shared across App Router route segments, which is exactly what made this the heaviest prod read",
    );
    assert.match(
      source,
      /const\s+loadBrickCentroidsCached\s*=\s*unstable_cache\(/,
      "the centroid read must be wrapped in unstable_cache so every route segment shares one cached result",
    );
    // Match the DECLARATION form (`let cache: {` / `let cache =`), not the phrase in a comment —
    // the docblock deliberately names the old `let cache` to explain why it was replaced.
    assert.doesNotMatch(
      source,
      /\blet\s+cache\s*[:=]/,
      "the old module-level `let cache` declaration must not come back — it was cold per route segment and defeated its own TTL",
    );
  }

  // Bound the cached-function region to EXACTLY the unstable_cache(...) call — from its `const` up to
  // the `);` that closes the options object. Slicing to the public wrapper instead would swallow that
  // wrapper's docblock (which mentions "catch"), giving a false match on the catch-placement check.
  const cacheStart = source.indexOf("const loadBrickCentroidsCached = unstable_cache(");
  const publicStart = source.indexOf("export async function loadBrickCentroids(");
  assert.ok(cacheStart > -1 && publicStart > cacheStart, "both the cached read and its public wrapper must exist, in that order");
  const optionsIdx = source.indexOf('tags: ["sos-reference"]', cacheStart);
  assert.ok(optionsIdx > -1 && optionsIdx < publicStart, "the unstable_cache options (with the sos-reference tag) must sit inside the cached definition");
  const cacheEnd = source.indexOf(");", optionsIdx) + 2;
  const cachedRegion = source.slice(cacheStart, cacheEnd);
  const publicRegion = source.slice(publicStart, source.indexOf("export function resolveBrickForPoint("));

  // ── The staleness window is unchanged: 300 s, exactly the old CACHE_TTL_MS (5 * 60 * 1000) ──
  // A different revalidate would change how stale the Brick/Area/Region overlay can be — the one
  // observable difference a cache swap could introduce. Pinning it keeps behaviour identical.
  {
    assert.match(
      cachedRegion,
      /revalidate:\s*300\b/,
      "revalidate must stay 300 s — that is the old 5-minute module-cache TTL; changing it changes how stale the overlay can be",
    );
    assert.match(
      cachedRegion,
      /tags:\s*\[\s*"sos-reference"\s*\]/,
      "the cache must carry the `sos-reference` tag so a validated SoS import busts it immediately instead of waiting out the TTL",
    );
    assert.match(
      cachedRegion,
      /\[\s*"crm-brick-centroids"\s*\]/,
      "the cache key must be stable and distinct so this entry is addressable and never collides with another cached read",
    );
  }

  // ── The DB read is byte-identical, so the RESULT SET cannot drift ───────────────────────────
  // An index/cache change can never move query output; pinning the exact select + filters proves it
  // stayed a like-for-like move rather than a quiet rewrite of what rows are considered.
  {
    assert.match(
      cachedRegion,
      /\.select\("source_key, latitude, longitude, geocode_status, geocode_provider"\)/,
      "the centroid read must select exactly the pin's key, coordinates and geocode status/provider — the status lets a pinless successor inherit a `success` pin first",
    );
    assert.match(
      cachedRegion,
      /\.eq\("source_type", "brick_centroid"\)/,
      "the read must still filter to brick_centroid rows only",
    );
    assert.match(
      cachedRegion,
      /\.not\("latitude", "is", null\)[\s\S]*\.not\("longitude", "is", null\)/,
      "both null-coordinate filters must survive — a null lat/lon must never reach the distance maths",
    );
    // 2026-10-27: `active` alone kept every MOVED brick — a move never switches a brick off, it dates
    // it out with effective_to and names its successor — so the husks stayed check-in geography.
    assert.match(
      cachedRegion,
      /\.from\("source_of_sales_bricks"\)\s*\.select\("brick_id, brick_name, area_code, region_code"\)\s*\.eq\("active", true\)\s*\.is\("superseded_by_brick_id", null\)\s*\.or\(brickInForceFilter\(today\)\)/,
      "only bricks IN FORCE today may become centroids — active, not superseded, not dated out — a retired or moved brick must never be a check-in's geography",
    );
    assert.match(cachedRegion, /const today = todayInCairo\(\);/, "\"today\" is Cairo's day, never the server's UTC date");
    assert.match(
      cachedRegion,
      /\.select\("brick_id, superseded_by_brick_id"\)\s*\.or\(brickHistoryFilter\(today\)\)/,
      "the history rows are read with the territory module's own filter, so a pinless successor can take its predecessor's pin",
    );
  }

  // ── The catch lives OUTSIDE the cache — a transient error must not be cached as [] ──────────
  // This is the single subtlety. unstable_cache only ever caches a RESOLVED value: if the raw read
  // throws, nothing is written and the next request retries — exactly like the old code. If the
  // try/catch were moved INSIDE the cached function, a one-off DB blip would return [] and that empty
  // list would be cached for the full 5 minutes, blanking the Brick/Area/Region overlay long after
  // the database recovered. So the cached region must NOT swallow errors, and the public wrapper must.
  {
    assert.doesNotMatch(
      cachedRegion,
      /catch/,
      "the cached read must NOT catch — it must throw on failure so a transient error is never written into the cache",
    );
    assert.match(
      cachedRegion,
      /return centroids;\s*\n\s*\},/,
      "the cached read must return the built centroid list directly (no error fallback) as the last statement before its key/options",
    );
    assert.match(
      publicRegion,
      /try\s*\{[\s\S]*return await loadBrickCentroidsShared\(\);[\s\S]*\}\s*catch\s*\{[\s\S]*return \[\];/,
      "the public loadBrickCentroids must wrap the (shared) cached call in try/catch and degrade to [] — best-effort overlay, retried next request, never a cached empty",
    );
  }

  // ── Concurrent callers share ONE lookup — a cache miss must not become one read per row ──────
  // 2026-09-17: `unstable_cache` does not dedupe a miss, and attachOutstationCapturedLocations
  // resolves one lookup per outstation request, all at once, on the Super Admin sidebar's 30-second
  // badge poll. Every expiry therefore read source_of_sales_bricks once PER ROW: 7,178 reads a day
  // in production, 93% of them in bursts of 61+ inside five seconds. The public wrapper must go
  // through the single-flight, and nothing may call the cached read around it. The single-flight's
  // own behaviour (one load per burst, slot cleared on settle and on failure) is exercised for real
  // in tests/sos-reference-read-load.test.ts.
  {
    assert.match(
      source,
      /import\s*\{\s*singleFlight\s*\}\s*from\s*"@\/lib\/utils\/single-flight"/,
      "brick-geo must take the shared single-flight helper, not a hand-rolled copy the behavioural test cannot see",
    );
    const sharedDecl = source.indexOf("const loadBrickCentroidsShared = singleFlight(");
    assert.ok(
      sharedDecl > cacheEnd && sharedDecl < publicStart,
      "the shared lookup must be declared once, at module level, between the cached read and the public wrapper — declared inside the function it would be a new slot per call and share nothing",
    );
    assert.match(
      source,
      /const\s+loadBrickCentroidsShared\s*=\s*singleFlight\(\(\)\s*=>\s*loadBrickCentroidsCached\(\)\);/,
      "the single-flight must wrap exactly the cached read, so every waiter gets the value the Data Cache lookup returned",
    );
    const cachedCalls = source.match(/loadBrickCentroidsCached\(\)/g) ?? [];
    assert.equal(
      cachedCalls.length,
      1,
      "the cached read may be called from ONE place — the single-flight — or a caller bypasses the sharing and a miss is one read per row again",
    );
  }
}
